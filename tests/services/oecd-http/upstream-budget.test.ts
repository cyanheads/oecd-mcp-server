/**
 * @fileoverview Tests for the per-call upstream budget — one deadline over every
 * OECD request, backoff, and honored `Retry-After` a call makes, driven under
 * fake timers through the real `fetchOecd` boundary and the real retry ladder,
 * with a fetch fake that holds a request open until its signal aborts.
 * @module tests/services/oecd-http/upstream-budget.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { fetchOecd, type RequestWindow, upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import { isBudgetExpiry, UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  installScriptedFetch,
  observe,
  rejectionOf,
  type ScriptedAnswer,
  type ScriptedFetch,
  STALL,
} from '../../helpers/scripted-fetch.js';

const URL_UNDER_TEST = 'https://fake.oecd.test/dataflow';

const THROTTLE_BODY =
  'You have exceeded the number of requests currently permitted in the OECD Data API.';

/** One request through the boundary, inside the window the budget handed it. */
function request(window: RequestWindow): Promise<Response> {
  return fetchOecd(
    URL_UNDER_TEST,
    { accept: 'application/json', expectedStatuses: [], operation: 'test' },
    window,
  );
}

function throttled(afterMs?: number, retryAfter?: string): ScriptedAnswer {
  return {
    body: THROTTLE_BODY,
    kind: 'answer',
    status: 429,
    ...(afterMs === undefined ? {} : { afterMs }),
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
  };
}

describe('UpstreamBudget', () => {
  const config = getServerConfig();
  const configuredTimeoutMs = config.timeoutMs;
  let http: ScriptedFetch | undefined;

  /** Answer the nth request with the nth answer, and every later one with the last. */
  function script(...answers: ScriptedAnswer[]): ScriptedFetch {
    const fake = installScriptedFetch(
      (_url, index) => answers[Math.min(index, answers.length - 1)] ?? STALL,
    );
    http = fake;
    return fake;
  }

  /** Hold every request open, and abort the caller once the first is in flight. */
  function abortOnFirstRequest(caller: AbortController): ScriptedFetch {
    const fake = installScriptedFetch(() => {
      queueMicrotask(() => caller.abort());
      return STALL;
    });
    http = fake;
    return fake;
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    config.timeoutMs = 30_000;
  });

  afterEach(() => {
    vi.useRealTimers();
    config.timeoutMs = configuredTimeoutMs;
    const installed = http;
    http = undefined;
    installed?.restore();
  });

  describe('size', () => {
    it.each([
      [5_000, 50_000],
      [30_000, 50_000],
      [50_000, 50_000],
      [60_000, 60_000],
    ])('gives OECD_TIMEOUT_MS %i a budget of %i ms', (timeoutMs, totalMs) => {
      config.timeoutMs = timeoutMs;

      expect(new UpstreamBudget().totalMs).toBe(totalMs);
    });

    it('counts down from the moment it is created and never goes below zero', async () => {
      const budget = new UpstreamBudget();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(budget.remainingMs()).toBe(30_000);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(budget.remainingMs()).toBe(0);
    });
  });

  describe('retry', () => {
    it('ends a ladder of stalled requests at the budget, after two requests', async () => {
      const fake = script(STALL);
      const budget = new UpstreamBudget();

      const ladder = observe(budget.retry(request, 2));
      await vi.advanceTimersByTimeAsync(49_999);

      expect(ladder.settledAtMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      const error = await rejectionOf(ladder);

      expect(ladder.settledAtMs).toBe(50_000);
      expect(fake.requests).toHaveLength(2);
      // The first request had the whole OECD_TIMEOUT_MS; the second, what was left.
      expect(fake.requests[1]?.atMs).toBeGreaterThan(30_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', retryAttempts: 2 },
      });
      expect(upstreamRefusal(error)?.reason).toBe('upstream_timeout');
    });

    it('returns a throttle whose Retry-After outlasts the time left without sleeping on it', async () => {
      const fake = script(throttled(undefined, '30'));
      const budget = new UpstreamBudget();

      const ladder = observe(budget.retry(request, 2));
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await rejectionOf(ladder);

      // The first Retry-After fits the budget and is waited out; the second does not.
      expect(fake.requests.map((r) => r.atMs)).toEqual([0, 30_000]);
      expect(ladder.settledAtMs).toBe(30_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { retryAfter: '30', status: 429 },
      });
      expect(upstreamRefusal(error)).toEqual({ message: THROTTLE_BODY, reason: 'rate_limited' });
    });

    it.each([50_000, 60_000])(
      'gives OECD_TIMEOUT_MS %i one attempt of its full length',
      async (timeoutMs) => {
        config.timeoutMs = timeoutMs;
        const fake = script(STALL);

        const ladder = observe(new UpstreamBudget().retry(request, 2));
        await vi.advanceTimersByTimeAsync(timeoutMs);
        const error = await rejectionOf(ladder);

        expect(fake.requests).toHaveLength(1);
        expect(ladder.settledAtMs).toBe(timeoutMs);
        expect(upstreamRefusal(error)?.reason).toBe('upstream_timeout');
      },
    );

    it('ends as RequestCancelled with no further request when the caller aborts mid-backoff', async () => {
      const fake = script({ body: 'Service Unavailable', kind: 'answer', status: 503 });
      const caller = new AbortController();

      const ladder = observe(new UpstreamBudget(caller.signal).retry(request, 2));
      await vi.advanceTimersByTimeAsync(100);
      // The 503 is in and the ladder is waiting out its first backoff.
      expect(fake.requests).toHaveLength(1);
      expect(ladder.settledAtMs).toBeUndefined();

      caller.abort();
      const error = await rejectionOf(ladder);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        message: 'The caller cancelled the call before its OECD request finished',
      });
      expect(upstreamRefusal(error)).toBeUndefined();
      expect(fake.requests).toHaveLength(1);
    });

    it('ends as RequestCancelled when the caller aborts mid-request', async () => {
      const caller = new AbortController();
      const fake = abortOnFirstRequest(caller);

      const ladder = observe(new UpstreamBudget(caller.signal).retry(request, 2));
      const error = await rejectionOf(ladder);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        data: { errorSource: 'FetchAborted' },
      });
      expect(fake.requests).toHaveLength(1);
    });

    /**
     * `withRetry`'s expiry names the attempt it cut off as its cause. When that
     * attempt came after a throttle, the throttle is what the caller can act on —
     * wait, then call again — and the cut-off request says nothing about why the
     * ladder needed it.
     */
    describe('a throttle followed by an expiry', () => {
      it('reports the 429 when the deadline cuts off the attempt after a slow throttle', async () => {
        const fake = script(throttled(25_000), STALL);

        const ladder = observe(new UpstreamBudget().retry(request, 2));
        await vi.advanceTimersByTimeAsync(50_000);
        const error = await rejectionOf(ladder);

        expect(fake.requests).toHaveLength(2);
        expect(ladder.settledAtMs).toBe(50_000);
        expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited, data: { status: 429 } });
        expect(upstreamRefusal(error)).toEqual({ message: THROTTLE_BODY, reason: 'rate_limited' });
      });

      it('reports the 429 when the backoff after it would outlast the budget', async () => {
        // The second throttle lands with under a second left; the backoff after
        // it is longer than that, so the ladder ends on the spot.
        const fake = script(throttled(20_000), throttled(28_500));

        const ladder = observe(new UpstreamBudget().retry(request, 2));
        await vi.advanceTimersByTimeAsync(50_000);
        const error = await rejectionOf(ladder);

        expect(fake.requests).toHaveLength(2);
        expect(ladder.settledAtMs).toBeLessThan(50_000);
        expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
        expect(upstreamRefusal(error)?.reason).toBe('rate_limited');
      });

      it('reports the timeout when an attempt that ran its own course came after the 429', async () => {
        // The second request runs out its own OECD_TIMEOUT_MS — an outcome, not
        // a cut-off — so the throttle before it is no longer the latest answer.
        const fake = script(throttled(), STALL);

        const ladder = observe(new UpstreamBudget().retry(request, 2));
        await vi.advanceTimersByTimeAsync(50_000);
        const error = await rejectionOf(ladder);

        expect(fake.requests).toHaveLength(3);
        expect(ladder.settledAtMs).toBe(50_000);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'retry_deadline_exceeded' },
        });
        expect(upstreamRefusal(error)?.reason).toBe('upstream_timeout');
      });
    });
  });

  describe('once', () => {
    it('reports a lone request the budget cut short as the budget running out', async () => {
      const fake = script(STALL);
      const budget = new UpstreamBudget();
      await vi.advanceTimersByTimeAsync(40_000);

      const lone = observe(budget.once(request));
      await vi.advanceTimersByTimeAsync(9_999);

      expect(lone.settledAtMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      const error = await rejectionOf(lone);

      expect(lone.settledAtMs).toBe(50_000);
      expect(fake.requests).toHaveLength(1);
      expect(isBudgetExpiry(error)).toBe(true);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'The OECD requests of this call ran past its 50000 ms upstream budget',
      });
      expect((error as McpError).cause).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { errorSource: 'FetchTimeout' },
      });
      expect(upstreamRefusal(error)?.reason).toBe('upstream_timeout');
    });

    it('leaves a request that ran out its own timeout an ordinary failure', async () => {
      script(STALL);

      const lone = observe(new UpstreamBudget().once(request));
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await rejectionOf(lone);

      expect(lone.settledAtMs).toBe(30_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { errorSource: 'FetchTimeout' },
      });
      expect(isBudgetExpiry(error)).toBe(false);
    });

    it('never reads a 504 OECD answered with as the budget running out', async () => {
      script({ body: 'Gateway Timeout', kind: 'answer', status: 504 });
      const budget = new UpstreamBudget();
      await vi.advanceTimersByTimeAsync(40_000);

      const error = await budget.once(request).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout, data: { status: 504 } });
      expect(isBudgetExpiry(error)).toBe(false);
    });

    it('sends nothing once the budget is spent, and reports that as the budget running out', async () => {
      const fake = script(STALL);
      const budget = new UpstreamBudget();
      await vi.advanceTimersByTimeAsync(50_000);

      const error = await budget.once(request).catch((e: unknown) => e);

      expect(fake.requests).toHaveLength(0);
      expect(isBudgetExpiry(error)).toBe(true);
    });

    it('keeps the caller’s abort a cancellation, even with the budget nearly spent', async () => {
      const caller = new AbortController();
      const budget = new UpstreamBudget(caller.signal);
      await vi.advanceTimersByTimeAsync(40_000);
      abortOnFirstRequest(caller);

      const error = await budget.once(request).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(isBudgetExpiry(error)).toBe(false);
    });
  });

  describe('within', () => {
    it('ends a lone request at the cap, as an expiry, and leaves the call’s own clock running', async () => {
      const fake = script(STALL);
      const budget = new UpstreamBudget();
      const capped = budget.within(10_000);

      const lone = observe(capped.once(request));
      await vi.advanceTimersByTimeAsync(9_999);

      expect(lone.settledAtMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      const error = await rejectionOf(lone);

      expect(capped.totalMs).toBe(10_000);
      expect(lone.settledAtMs).toBe(10_000);
      expect(fake.requests).toHaveLength(1);
      expect(isBudgetExpiry(error)).toBe(true);
      expect(budget.remainingMs()).toBe(40_000);
    });

    it('takes what the call has left when that is shorter than the cap', async () => {
      script(STALL);
      const budget = new UpstreamBudget();
      await vi.advanceTimersByTimeAsync(45_000);
      const capped = budget.within(10_000);

      const lone = observe(capped.once(request));
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await rejectionOf(lone);

      expect(capped.totalMs).toBe(5_000);
      expect(lone.settledAtMs).toBe(50_000);
      expect(isBudgetExpiry(error)).toBe(true);
    });

    it('ends a retry ladder at the cap', async () => {
      const fake = script(STALL);

      const ladder = observe(new UpstreamBudget().within(10_000).retry(request, 2));
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await rejectionOf(ladder);

      expect(ladder.settledAtMs).toBe(10_000);
      expect(fake.requests).toHaveLength(1);
      expect(upstreamRefusal(error)?.reason).toBe('upstream_timeout');
    });

    it('returns a throttle whose Retry-After outlasts the cap, with no further request', async () => {
      const fake = script(throttled(undefined, '20'));

      const ladder = observe(new UpstreamBudget().within(10_000).retry(request, 2));
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await rejectionOf(ladder);

      expect(ladder.settledAtMs).toBe(0);
      expect(fake.requests).toHaveLength(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { retryAfter: '20' },
      });
    });

    it('keeps the caller’s signal, so an abort is still a cancellation', async () => {
      const caller = new AbortController();
      const capped = new UpstreamBudget(caller.signal).within(10_000);
      abortOnFirstRequest(caller);

      const error = await capped.once(request).catch((e: unknown) => e);

      expect(capped.signal).toBe(caller.signal);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(isBudgetExpiry(error)).toBe(false);
    });
  });
});
