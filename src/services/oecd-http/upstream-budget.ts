/**
 * @fileoverview The upstream budget of one tool or resource call — a single
 * wall-clock deadline over every OECD request the call makes, every retry
 * backoff, and every honored `Retry-After`, so the call settles inside the
 * request timeout an MCP client waits out.
 * @module services/oecd-http/upstream-budget
 */

import {
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type RequestWindow, upstreamStatus } from './oecd-http.js';

/**
 * The shortest budget a call gets. MCP SDK clients stop waiting on a request
 * after 60 s by default, and a call that answers after that reaches nobody;
 * 50 s leaves the classified failure room to arrive first.
 */
const BUDGET_FLOOR_MS = 50_000;

/** The expiries {@link UpstreamBudget.once} raised, so a best-effort caller can tell one from an ordinary failure. */
const expiries = new WeakSet<McpError>();

/**
 * Whether a failure is the budget running out during a lone request — the one
 * failure a best-effort lookup must not absorb, since everything it would fall
 * back to has to wait on the same exhausted clock.
 */
export function isBudgetExpiry(err: unknown): boolean {
  return err instanceof McpError && expiries.has(err);
}

/**
 * One call's budget for upstream work: `max(50 s, OECD_TIMEOUT_MS)` from the
 * moment the handler creates it, plus the caller's cancellation signal. The
 * handler creates one and passes it into every service method it calls, which
 * spend it through {@link retry} for a retried request and {@link once} for a
 * lone one. {@link within} carves a shorter share out of it for a best-effort
 * lookup.
 *
 * `OECD_TIMEOUT_MS` stays the per-request timeout — each request gets it, or
 * the time left when that is less — and a value raised past the floor buys one
 * longer attempt rather than a longer ladder of them.
 */
export class UpstreamBudget {
  /** The caller's cancellation, which outranks the deadline wherever both fire. */
  readonly signal: AbortSignal | undefined;
  /** The whole budget, in milliseconds. */
  readonly totalMs: number;
  readonly #endsAt: number;

  /** `totalMs` is the call's own budget unless {@link within} names a shorter one. */
  constructor(
    signal?: AbortSignal,
    totalMs = Math.max(BUDGET_FLOOR_MS, getServerConfig().timeoutMs),
  ) {
    this.signal = signal;
    this.totalMs = totalMs;
    this.#endsAt = Date.now() + totalMs;
  }

  /** Milliseconds left, never negative. */
  remainingMs(): number {
    return Math.max(0, this.#endsAt - Date.now());
  }

  /**
   * A budget of at most `capMs` from now, never outlasting this one, under the
   * same caller signal: for a lookup that must not spend the rest of the call.
   * It runs out the way this one does — a lone request it cuts short is an
   * expiry {@link isBudgetExpiry} reports, a ladder's deadline is a `Timeout`,
   * and a `Retry-After` past its end rejects at once — while this budget's own
   * clock runs on untouched.
   */
  within(capMs: number): UpstreamBudget {
    return new UpstreamBudget(this.signal, Math.min(capMs, this.remainingMs()));
  }

  /**
   * Run one retry ladder inside what is left of the budget. `withRetry`'s
   * `deadlineMs` is the time left, so every attempt, backoff, and honored
   * `Retry-After` ends with the budget; pass each attempt's window to
   * `fetchOecd`. An expiry rejects as `Timeout`, and a `Retry-After` that would
   * outlast the budget rejects at once with the throttle it answered.
   *
   * An expiry after a throttle rejects with the throttle. `withRetry`'s expiry
   * names the attempt it cut off, so a ladder of slow 429s whose last attempt
   * the deadline interrupted would read as a timeout, when the 429 is what the
   * caller can act on. Only the latest attempt that ran its course counts: one
   * the deadline aborted leaves the 429 standing, and any other outcome — a
   * request that ran out its own timeout included — replaces it.
   *
   * A caller abort keeps precedence. One that lands while the ladder waits to
   * retry reaches here as the signal's raw reason, and leaves as
   * `RequestCancelled` rather than as something a relabel would read as an
   * outage.
   */
  async retry<T>(attempt: (window: RequestWindow) => Promise<T>, maxRetries: number): Promise<T> {
    let throttle: McpError | undefined;
    try {
      return await withRetry(
        async (window) => {
          try {
            return await attempt(window);
          } catch (err) {
            if (!window.signal.aborted) throttle = isThrottle(err) ? err : undefined;
            throw err;
          }
        },
        {
          deadlineMs: this.remainingMs(),
          maxRetries,
          operation: 'OECD request',
          ...(this.signal ? { signal: this.signal } : {}),
        },
      );
    } catch (err) {
      if (this.signal?.aborted && !(err instanceof McpError)) {
        throw requestCancelled(
          'The caller cancelled the call before its OECD request finished',
          {},
          { cause: err },
        );
      }
      if (throttle && isLadderExpiry(err)) throw throttle;
      throw err;
    }
  }

  /**
   * Run one unretried request inside what is left of the budget.
   *
   * A request whose timeout was the budget's remainder, and that timed out,
   * spent the budget: it rejects as a `Timeout` {@link isBudgetExpiry} reports,
   * with the request's own failure as the cause. Every other failure rejects
   * unchanged.
   */
  async once<T>(attempt: (window: RequestWindow) => Promise<T>): Promise<T> {
    const remainingMs = this.remainingMs();
    try {
      return await attempt({ remainingMs, signal: this.signal });
    } catch (err) {
      const cutByBudget = remainingMs < getServerConfig().timeoutMs;
      if (cutByBudget && !this.signal?.aborted && isOwnTimeout(err)) throw this.#expiry(err);
      throw err;
    }
  }

  #expiry(cause: unknown): McpError {
    const expiry = timeout(
      `The OECD requests of this call ran past its ${this.totalMs} ms upstream budget`,
      {},
      { cause },
    );
    expiries.add(expiry);
    return expiry;
  }
}

/** A 429 OECD answered with. */
function isThrottle(err: unknown): err is McpError {
  return err instanceof McpError && err.code === JsonRpcErrorCode.RateLimited;
}

/** The expiry `withRetry` raises when a ladder's deadline runs out. */
function isLadderExpiry(err: unknown): boolean {
  return (
    err instanceof McpError &&
    err.code === JsonRpcErrorCode.Timeout &&
    err.data?.reason === 'retry_deadline_exceeded'
  );
}

/** A timeout this server's own clock raised, rather than a 408 or 504 OECD answered with. */
export function isOwnTimeout(err: unknown): boolean {
  return (
    err instanceof McpError &&
    err.code === JsonRpcErrorCode.Timeout &&
    upstreamStatus(err) === undefined
  );
}
