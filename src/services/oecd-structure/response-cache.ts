/**
 * @fileoverview The in-process cache in front of the OECD structure reads —
 * decoded responses kept for the lifetime OECD grants them, bounded in bytes,
 * and one shared load per URL in flight, which each caller waits on under its
 * own cancellation and its own upstream budget.
 * @module services/oecd-structure/response-cache
 */

import { requestCancelled, timeout } from '@cyanheads/mcp-ts-core/errors';
import type { RequestWindow } from '@/services/oecd-http/oecd-http.js';
import { isOwnTimeout, type UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';

/** The most the stored entries are charged together, in bytes. */
const LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Bytes an entry is charged per character of its response body. Four covers
 * the most a decoded value can keep, the whole parsed body: for the
 * 5.97 M-character dataflow catalog that is 19.6 MB on Bun (3.3 bytes a
 * character) and 9.0 MB on Node. The catalog entry itself, its dataflows
 * projected, retains 6.95 MB on Bun and 2.94 MB on Node against a 23.9 MB
 * charge. Parsed strings do not pin the body text, so a decoded value never
 * costs more than its parse.
 */
const CHARGE_BYTES_PER_CHAR = 4;

/** What one load produced, as the cache needs to see it. */
export interface LoadedResponse<T> {
  /** Characters in the response body; the entry is charged per character. */
  readonly bodyChars: number;
  /** How long OECD lets the response be reused, in milliseconds; undefined when it may not be. */
  readonly freshForMs: number | undefined;
  /** The decoded value every caller of the load receives. */
  readonly value: T;
}

/** Runs one load under the signal the cache aborts once no caller waits on it. */
type Loader<T> = (signal: AbortSignal) => Promise<LoadedResponse<T>>;

interface Entry {
  chargeBytes: number;
  expiresAtMs: number;
  value: unknown;
}

interface Flight {
  readonly controller: AbortController;
  readonly result: Promise<LoadedResponse<unknown>>;
  settled: boolean;
  waiters: number;
}

/**
 * Decoded structure responses keyed by request, for the lifetime OECD grants
 * each one.
 *
 * **Stored:** only what a load returned — a response read to the end and
 * decoded, so a failure never is — and only while its `freshForMs` lasts. An
 * entry charged above the whole bound is handed to its callers and not kept;
 * otherwise the least recently used entries make room. Values are shared by
 * every caller that reads them, so callers project them and never mutate them.
 *
 * **In flight:** callers that miss on one key share one load. The load runs
 * under the cache's own signal rather than any caller's, so one caller giving up
 * cannot fail the others; each caller waits only as long as its own signal and
 * the time left in its own budget allow, and leaves alone. When the last waiter
 * leaves, the load is aborted and forgotten, and the next caller starts afresh.
 * A load spends a budget that starts with it, so one a caller joined in progress
 * can run out while that caller still has time; that caller then starts afresh
 * too, rather than take an expiry that was the load's and not its own.
 *
 * One cache serves every caller of the process. Structure requests carry no
 * credentials, so a key answers every tenant alike.
 */
export class ResponseCache {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Flight>();
  #chargedBytes = 0;

  /**
   * The value stored under `key`, or what `load` produces for it.
   *
   * A miss waits inside {@link UpstreamBudget.once}, so a wait the budget cut
   * short is the budget's expiry, exactly as a lone request cut short would be.
   * A caller whose signal has already aborted, or whose budget is spent, starts
   * and joins nothing.
   *
   * A key names one request decoded one way, so what is stored under it is the
   * `T` its loader returns.
   */
  get<T>(key: string, budget: UpstreamBudget, load: Loader<T>): Promise<T> {
    const entry = this.#fresh(key);
    if (entry) return Promise.resolve(entry.value as T);
    return budget.once((window) => this.#join(key, load, window)) as Promise<T>;
  }

  /** The value stored under `key` while it is fresh; a miss loads nothing and joins nothing. */
  peek<T>(key: string): T | undefined {
    return this.#fresh(key)?.value as T | undefined;
  }

  /** The fresh entry under `key`, moved to the back of the recency order; an expired one is dropped. */
  #fresh(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (entry.expiresAtMs <= Date.now()) {
      this.#drop(key, entry);
      return;
    }
    // Map order is recency order: a hit moves the entry to the back.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  async #join(key: string, load: Loader<unknown>, window: RequestWindow): Promise<unknown> {
    if (window.signal?.aborted) {
      throw requestCancelled(
        'The caller cancelled the call before its OECD request was sent',
        {},
        { cause: window.signal.reason },
      );
    }
    if (window.remainingMs <= 0) {
      throw timeout(
        'No time was left in the upstream budget of this call to send the OECD request',
      );
    }

    const endsAtMs = Date.now() + window.remainingMs;
    const joined = this.#flights.get(key);
    const flight = joined ?? this.#start(key, load);
    flight.waiters += 1;
    try {
      return (await waitWithin(flight.result, window)).value;
    } catch (err) {
      // A joined load whose own budget ran out first: this caller's clock has not.
      if (joined && flight.settled && isOwnTimeout(err) && Date.now() < endsAtMs) {
        return this.#join(key, load, { remainingMs: endsAtMs - Date.now(), signal: window.signal });
      }
      throw err;
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        this.#forget(key, flight);
        flight.controller.abort();
      }
    }
  }

  #start(key: string, load: Loader<unknown>): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      result: load(controller.signal),
      settled: false,
      waiters: 0,
    };
    this.#flights.set(key, flight);
    // Attached before any waiter's handler, so a value is stored by the time
    // its first caller receives it. A failed load has nothing to store.
    flight.result.then(
      (response) => {
        this.#land(key, flight);
        this.#store(key, response);
      },
      () => this.#land(key, flight),
    );
    return flight;
  }

  #land(key: string, flight: Flight): void {
    flight.settled = true;
    this.#forget(key, flight);
  }

  /** Stop routing callers to `flight`; a newer load of the same key is left alone. */
  #forget(key: string, flight: Flight): void {
    if (this.#flights.get(key) === flight) this.#flights.delete(key);
  }

  #store(key: string, response: LoadedResponse<unknown>): void {
    if (response.freshForMs === undefined) return;
    const chargeBytes = response.bodyChars * CHARGE_BYTES_PER_CHAR;
    if (chargeBytes > LIMIT_BYTES) return;

    const previous = this.#entries.get(key);
    if (previous) this.#drop(key, previous);
    for (const [oldest, entry] of this.#entries) {
      if (this.#chargedBytes + chargeBytes <= LIMIT_BYTES) break;
      this.#drop(oldest, entry);
    }
    this.#entries.set(key, {
      chargeBytes,
      expiresAtMs: Date.now() + response.freshForMs,
      value: response.value,
    });
    this.#chargedBytes += chargeBytes;
  }

  #drop(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#chargedBytes -= entry.chargeBytes;
  }
}

/**
 * Settle with the shared load, or alone when the caller's own signal aborts or
 * the time left in its budget runs out first. Either way the listener and the
 * timer go with it.
 *
 * A signal that is already aborted leaves at once: starting a load runs its
 * loader synchronously, after {@link ResponseCache.get}'s own check, so the
 * caller's abort can have fired before there was a listener to hear it.
 */
function waitWithin<T>(shared: Promise<T>, window: RequestWindow): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal } = window;
    const onAbort = (): void => {
      release();
      reject(
        requestCancelled(
          'The caller cancelled the call while its OECD request was in flight',
          {},
          { cause: signal?.reason },
        ),
      );
    };
    const timer = setTimeout(() => {
      release();
      reject(
        timeout(
          `No OECD response arrived in the ${window.remainingMs} ms left of this call's upstream budget`,
        ),
      );
    }, window.remainingMs);
    const release = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (value) => {
        release();
        resolve(value);
      },
      (err: unknown) => {
        release();
        reject(err);
      },
    );
  });
}
