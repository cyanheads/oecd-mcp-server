/**
 * @fileoverview Tests for ResponseCache's bound — the 64 MiB ceiling, the
 * 4-bytes-per-character charge, least-recently-used eviction, and the entry
 * too large to keep — for `peek`, for a caller that aborts while its own load
 * is starting, for one that arrives with its signal aborted or its budget
 * spent, and for a caller that joins a load in progress and outlives it,
 * driven through synthetic loaders, so each case controls its load exactly.
 * Sharing a load, freshness, and failures are tested at the service seam,
 * through the real fetch path.
 * @module tests/services/oecd-structure/response-cache.test
 */

import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBudgetExpiry, UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import type { LoadedResponse } from '@/services/oecd-structure/response-cache.js';
import { ResponseCache } from '@/services/oecd-structure/response-cache.js';
import { observe, rejectionOf } from '../../helpers/scripted-fetch.js';

/** Characters charged 16 MiB at 4 bytes each, a quarter of the 64 MiB bound. */
const QUARTER_CHARS = 4 * 1024 * 1024;
/** Characters charged exactly the 64 MiB bound. */
const BOUND_CHARS = 4 * QUARTER_CHARS;

/** A cache, and the loads it has asked its loaders for, in order. */
function harness() {
  const cache = new ResponseCache();
  const loads: string[] = [];

  /** Read `key`, which a miss loads as a response of `bodyChars` characters, reusable for `freshForMs` or not at all. */
  const read = (key: string, bodyChars: number, freshForMs: number | 'not-reusable' = 3_600_000) =>
    cache.get(key, new UpstreamBudget(), (): Promise<LoadedResponse<string>> => {
      loads.push(key);
      return Promise.resolve({
        bodyChars,
        freshForMs: freshForMs === 'not-reusable' ? undefined : freshForMs,
        value: `value of ${key}`,
      });
    });

  /**
   * Whether `key` is stored, by reading it with a loader whose response may
   * not be reused — a miss stores nothing and evicts nothing. A hit counts as a
   * use, so probe last.
   */
  const isStored = async (key: string): Promise<boolean> => {
    let loaded = false;
    await cache.get(key, new UpstreamBudget(), () => {
      loaded = true;
      return Promise.resolve({ bodyChars: 1, freshForMs: undefined, value: 'probe' });
    });
    return !loaded;
  };

  /** Which of `keys` are stored, probed together. */
  const stored = async (keys: string[]): Promise<string[]> => {
    const flags = await Promise.all(keys.map(isStored));
    return keys.filter((_key, i) => flags[i]);
  };

  return { cache, loads, read, stored };
}

describe('ResponseCache — the bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps entries charged up to exactly 64 MiB together', async () => {
    const { read, stored } = harness();
    for (const key of ['a', 'b', 'c', 'd']) await read(key, QUARTER_CHARS);

    expect(await stored(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('evicts the least recently used entry to make room, counting a read as a use', async () => {
    const { loads, read, stored } = harness();
    for (const key of ['a', 'b', 'c', 'd']) await read(key, QUARTER_CHARS);
    // A hit, so `b` is now the least recently used.
    await expect(read('a', QUARTER_CHARS)).resolves.toBe('value of a');
    expect(loads).toEqual(['a', 'b', 'c', 'd']);

    // One character more than the bound has room for: 4 bytes.
    await read('e', 1);

    expect(await stored(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'c', 'd', 'e']);
  });

  it('evicts as many entries as the new one needs, oldest first', async () => {
    const { read, stored } = harness();
    for (const key of ['a', 'b', 'c', 'd']) await read(key, QUARTER_CHARS);

    await read('e', 2 * QUARTER_CHARS);

    expect(await stored(['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'd', 'e']);
  });

  it('stores a single entry charged exactly the bound', async () => {
    const { read, stored } = harness();

    await read('whole', BOUND_CHARS);

    expect(await stored(['whole'])).toEqual(['whole']);
  });

  it('hands an entry charged above the bound to its caller, stores it not, and evicts nothing for it', async () => {
    const { loads, read, stored } = harness();
    for (const key of ['a', 'b', 'c', 'd']) await read(key, QUARTER_CHARS);

    await expect(read('huge', BOUND_CHARS + 1)).resolves.toBe('value of huge');
    await expect(read('huge', BOUND_CHARS + 1)).resolves.toBe('value of huge');

    expect(loads.filter((key) => key === 'huge')).toHaveLength(2);
    expect(await stored(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('frees an expired entry’s charge before storing what replaces it', async () => {
    vi.useFakeTimers();
    const { loads, read, stored } = harness();
    await read('a', QUARTER_CHARS, 1_000);
    for (const key of ['b', 'c', 'd']) await read(key, QUARTER_CHARS);

    vi.setSystemTime(Date.now() + 1_000);
    await read('a', QUARTER_CHARS, 1_000);

    expect(loads).toEqual(['a', 'b', 'c', 'd', 'a']);
    // The reloaded entry took the room its expired copy held, not anyone else's.
    expect(await stored(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('stores nothing a load marks not reusable, and evicts nothing for it', async () => {
    const { loads, read, stored } = harness();
    for (const key of ['a', 'b', 'c', 'd']) await read(key, QUARTER_CHARS);

    await read('private', QUARTER_CHARS, 'not-reusable');
    await read('private', QUARTER_CHARS, 'not-reusable');

    expect(loads.filter((key) => key === 'private')).toHaveLength(2);
    expect(await stored(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('ResponseCache — peek', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a fresh entry, and on a miss loads and stores nothing', async () => {
    const { cache, read, stored } = harness();
    await read('stored', 1, 60_000);

    expect(cache.peek('stored')).toBe('value of stored');
    expect(cache.peek('absent')).toBeUndefined();
    // The miss left nothing behind for the next read to find.
    expect(await stored(['absent'])).toEqual([]);
  });

  it('returns nothing once the entry’s lifetime is over', async () => {
    vi.useFakeTimers();
    const { cache, read } = harness();
    await read('key', 1, 1_000);

    vi.setSystemTime(Date.now() + 999);
    expect(cache.peek('key')).toBe('value of key');
    vi.setSystemTime(Date.now() + 1);
    expect(cache.peek('key')).toBeUndefined();
  });

  it('counts a hit as a use, so the entry outlives older ones under eviction', async () => {
    const { cache, read, stored } = harness();
    for (const key of ['a', 'b', 'c', 'd']) await read(key, QUARTER_CHARS);

    expect(cache.peek('a')).toBe('value of a');
    // A fifth quarter needs one entry's room; `b` is now the least recently used.
    await read('e', QUARTER_CHARS);

    expect(await stored(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'c', 'd', 'e']);
  });
});

describe('ResponseCache — a caller that aborts while its load starts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves at once as RequestCancelled, and aborts the load it started', async () => {
    vi.useFakeTimers({ now: 0 });
    const cache = new ResponseCache();
    const caller = new AbortController();
    let loadSignal: AbortSignal | undefined;

    const read = observe(
      cache.get('key', new UpstreamBudget(caller.signal), (signal) => {
        loadSignal = signal;
        // Synchronously, inside the load's start — after the cache checked the
        // caller's signal and before it waits on the load.
        caller.abort();
        return new Promise<LoadedResponse<string>>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(read.settledAtMs).toBe(0);
    expect(loadSignal?.aborted).toBe(true);
    expect(await rejectionOf(read)).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });
});

describe('ResponseCache — a caller that arrives with nothing to wait with', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A loader that counts its starts and holds each load open until the cache aborts it. */
  const countingLoader = () => {
    const started = { count: 0 };
    const load = (signal: AbortSignal): Promise<LoadedResponse<string>> => {
      started.count += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    return { load, started };
  };

  it('starts no load for a caller whose signal has already aborted', async () => {
    vi.useFakeTimers({ now: 0 });
    const cache = new ResponseCache();
    const caller = new AbortController();
    caller.abort();
    const { load, started } = countingLoader();

    const read = observe(cache.get('key', new UpstreamBudget(caller.signal), load));
    await vi.advanceTimersByTimeAsync(0);

    expect(await rejectionOf(read)).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'The caller cancelled the call before its OECD request was sent',
    });
    expect(started.count).toBe(0);
  });

  it('starts no load for a caller whose budget is spent, and fails as that budget’s expiry', async () => {
    vi.useFakeTimers({ now: 0 });
    const cache = new ResponseCache();
    const budget = new UpstreamBudget();
    vi.setSystemTime(budget.totalMs);
    const { load, started } = countingLoader();

    const read = observe(cache.get('key', budget, load));
    await vi.advanceTimersByTimeAsync(0);

    const failure = await rejectionOf(read);
    expect(isBudgetExpiry(failure)).toBe(true);
    expect(failure).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(started.count).toBe(0);
  });
});

describe('ResponseCache — a caller that joins a load in progress', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A load that fails with `failure` 50 s after it starts — the whole budget it was given. */
  const failsAtItsDeadline = (failure: () => Error): Promise<LoadedResponse<string>> =>
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(failure()), 50_000);
    });

  it('starts afresh when the load it joined runs out its own budget while it still has time', async () => {
    vi.useFakeTimers({ now: 0 });
    const cache = new ResponseCache();
    const loadsAtMs: number[] = [];
    const load = (): Promise<LoadedResponse<string>> => {
      loadsAtMs.push(Date.now());
      return loadsAtMs.length === 1
        ? failsAtItsDeadline(() => timeout('The OECD requests ran past the upstream budget'))
        : Promise.resolve({ bodyChars: 1, freshForMs: 3_600_000, value: 'fresh' });
    };

    const first = observe(cache.get('key', new UpstreamBudget(), load));
    await vi.advanceTimersByTimeAsync(44_000);
    // 50 s of its own left; the load it joins has 6 s.
    const joiner = observe(cache.get('key', new UpstreamBudget(), load));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(await rejectionOf(first)).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(await joiner.outcome).toEqual({ status: 'fulfilled', value: 'fresh' });
    expect(joiner.settledAtMs).toBe(50_000);
    expect(loadsAtMs).toEqual([0, 50_000]);
  });

  it('shares a timeout OECD answered with rather than loading again', async () => {
    vi.useFakeTimers({ now: 0 });
    const cache = new ResponseCache();
    let loads = 0;
    const load = (): Promise<LoadedResponse<string>> => {
      loads += 1;
      return failsAtItsDeadline(
        () =>
          new McpError(JsonRpcErrorCode.Timeout, 'OECD answered 504', { status: 504, body: '' }),
      );
    };

    const first = observe(cache.get('key', new UpstreamBudget(), load));
    await vi.advanceTimersByTimeAsync(44_000);
    const joiner = observe(cache.get('key', new UpstreamBudget(), load));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(await rejectionOf(first)).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(await rejectionOf(joiner)).toMatchObject({ data: { status: 504 } });
    expect(loads).toBe(1);
  });
});
