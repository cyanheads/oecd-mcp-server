/**
 * @fileoverview Fetch fakes that honour each request's abort signal — the
 * shape a deadline test needs — and the fake clock such a test runs on. A
 * request is answered at once, answered after a delay, or held with no response
 * until its signal aborts, whether by the scripted `fetch`
 * {@link installScriptedFetch} installs or by the {@link stall} and
 * {@link answerAfter} responders a `createFetchMock` route takes. Every delay
 * runs on whatever timers are installed, so a test under {@link onPinnedClock}
 * drives the whole exchange (per-request timeout, retry backoff, and the call's
 * budget) without a wall clock.
 * @module tests/helpers/scripted-fetch
 */

import { afterEach, beforeEach, vi } from 'vitest';

/** How the fake answers one request. */
export type ScriptedAnswer =
  /** No response at all: the request stays open until its signal aborts. */
  | { kind: 'stall' }
  /** A response, sent once `afterMs` has passed — at once when omitted. */
  | {
      afterMs?: number;
      body?: string;
      headers?: Record<string, string>;
      kind: 'answer';
      status?: number;
    };

/** A request held open with no response. */
export const STALL: ScriptedAnswer = { kind: 'stall' };

/** A `200` HTML page — what a proxy or CDN in front of the API answers in OECD's place. */
export const PROXY_PAGE: ScriptedAnswer = {
  body: '<html><head><title>Maintenance</title></head><body>Back soon.</body></html>',
  headers: { 'content-type': 'text/html' },
  kind: 'answer',
};

/** A `200` SDMX-JSON answer carrying `value`. */
export function json(value: unknown, afterMs?: number): ScriptedAnswer {
  return {
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json' },
    kind: 'answer',
    ...(afterMs === undefined ? {} : { afterMs }),
  };
}

/** One request the fake received, stamped with the clock in force when it was sent. */
export interface ScriptedRequest {
  atMs: number;
  url: string;
}

/** An installed fake. */
export interface ScriptedFetch {
  requests: ScriptedRequest[];
  /** The requests whose URL contains `fragment`. */
  requestsTo(fragment: string): ScriptedRequest[];
  /**
   * Put the previous `fetch` back, then rethrow the first error the script
   * raised — a throw inside a fetch fake otherwise surfaces only as the network
   * failure the boundary turns it into.
   */
  restore(): void;
}

/**
 * Install the fake as `globalThis.fetch`. `answer` picks the reply for each
 * request from its URL and the zero-based count of requests before it.
 */
export function installScriptedFetch(
  answer: (url: string, index: number) => ScriptedAnswer,
): ScriptedFetch {
  const previous = globalThis.fetch;
  const requests: ScriptedRequest[] = [];
  const scriptErrors: unknown[] = [];

  const scripted = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const index = requests.length;
    requests.push({ atMs: Date.now(), url });
    const signal = init?.signal ?? undefined;

    let reply: ScriptedAnswer;
    try {
      reply = answer(url, index);
    } catch (err) {
      scriptErrors.push(err);
      return Promise.reject(err);
    }

    if (reply.kind === 'stall') return heldOn(signal);
    const { afterMs = 0, body = '', headers, status = 200 } = reply;
    return heldOn(signal, {
      afterMs,
      make: () => new Response(body, { status, ...(headers ? { headers } : {}) }),
    });
  };
  globalThis.fetch = Object.assign(scripted, previous);

  return {
    requests,
    requestsTo: (fragment) => requests.filter((r) => r.url.includes(fragment)),
    restore: () => {
      globalThis.fetch = previous;
      if (scriptErrors.length > 0) throw scriptErrors[0];
    },
  };
}

/** When a held request is answered, and with what. */
interface Delivery {
  afterMs: number;
  make: () => Response;
}

/**
 * A response held on `signal`: rejected with the signal's reason the moment it
 * aborts, at once when it already has. Otherwise it resolves with the
 * delivery's response once `afterMs` has passed (at once for 0), or never when
 * no delivery is given.
 */
function heldOn(signal: AbortSignal | undefined, delivery?: Delivery): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
    if (!delivery) return;
    const send = () => resolve(delivery.make());
    if (delivery.afterMs) timer = setTimeout(send, delivery.afterMs);
    else send();
  });
}

/** A `createFetchMock` responder that never answers, as a stalled socket does: it settles only when the request is aborted. */
export function stall(request: Request): Promise<Response> {
  return heldOn(request.signal);
}

/** A `createFetchMock` responder that answers with `make()` once `delayMs` has passed, unless the request is aborted first. */
export function answerAfter(
  delayMs: number,
  request: Request,
  make: () => Response,
): Promise<Response> {
  return heldOn(request.signal, { afterMs: delayMs, make });
}

/** A promise's outcome, plus the clock reading when it settled. */
export interface Observed<T> {
  outcome: Promise<PromiseSettledResult<T>>;
  /** `Date.now()` when the promise settled, or undefined while it is pending. */
  settledAtMs: number | undefined;
}

/**
 * Track a promise without awaiting it, so a fake-time test can advance the
 * clock and assert both that the promise is still pending and when it settled.
 */
export function observe<T>(promise: Promise<T>): Observed<T> {
  const observed: Observed<T> = {
    outcome: promise.then(
      (value) => {
        observed.settledAtMs = Date.now();
        return { status: 'fulfilled', value } as const;
      },
      (reason: unknown) => {
        observed.settledAtMs = Date.now();
        return { reason, status: 'rejected' } as const;
      },
    ),
    settledAtMs: undefined,
  };
  return observed;
}

/**
 * Advance fake time to `atMs`, noting whether `observed` was still pending a
 * millisecond before it, then wait for its outcome — read `settledAtMs` for
 * when it arrived.
 */
export async function runUntil<T>(
  observed: Observed<T>,
  atMs: number,
): Promise<{ outcome: PromiseSettledResult<T>; pendingBefore: boolean }> {
  await vi.advanceTimersByTimeAsync(atMs - 1 - Date.now());
  const pendingBefore = observed.settledAtMs === undefined;
  await vi.advanceTimersByTimeAsync(1);
  return { outcome: await observed.outcome, pendingBefore };
}

/** The rejection an observed promise settled with; fails the test when it fulfilled instead. */
export async function rejectionOf(observed: Observed<unknown>): Promise<unknown> {
  const outcome = await observed.outcome;
  if (outcome.status === 'fulfilled') throw new Error('Expected a rejection, got a fulfilment');
  return outcome.reason;
}

/**
 * Run the enclosing suite's cases on fake time with the backoff jitter pinned,
 * so a retry ladder's timing is exact — at `Math.random() = 0.5` the
 * framework's backoffs are exactly 1 s and then 2 s.
 */
export function onPinnedClock(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}

/** How a call run on fake time settled, and the fake milliseconds it took. */
export interface Settled<T> {
  elapsedMs: number;
  error?: unknown;
  value?: T;
}

/**
 * Run a call to completion on fake time. The clock runs far past the 50 s
 * budget, so a call that ignores its budget still settles — late, where the
 * assertions can see it — rather than hanging the test.
 */
export async function onFakeTime<T>(call: () => Promise<T>): Promise<Settled<T>> {
  const startedAt = Date.now();
  const settled = call().then(
    (value): Settled<T> => ({ elapsedMs: Date.now() - startedAt, value }),
    (error: unknown): Settled<T> => ({ elapsedMs: Date.now() - startedAt, error }),
  );
  await vi.advanceTimersByTimeAsync(300_000);
  return settled;
}
