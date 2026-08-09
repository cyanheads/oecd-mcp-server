/**
 * @fileoverview Shared HTTP boundary for the OECD SDMX endpoints — one fetch
 * path for the structure and data services, carrying the retry-classification
 * corrections both of them need.
 * @module services/oecd-http/oecd-http
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/**
 * OECD's HTTP/2 endpoint requires Accept-Language to avoid HTTP 500 responses
 * when a structured Accept header is sent. Node.js fetch defaults to HTTP/2 and
 * omits Accept-Language; adding it explicitly fixes the server-side routing bug.
 */
const ACCEPT_LANGUAGE = 'en';

/** Request options for {@link fetchOecd}. */
export interface OecdFetchOptions {
  /** SDMX media type for the endpoint being called. */
  accept: string;
  /** Statuses the caller handles itself — logged at debug rather than error. */
  expectedStatuses: number[];
  /** Operation label for correlated logging. */
  operation: string;
  /** Caller cancellation, composed with the configured timeout. */
  signal?: AbortSignal;
}

/**
 * Reconcile an upstream HTTP failure with what `withRetry` treats as transient.
 *
 * Two of OECD's responses are otherwise taken at face value and shouldn't be:
 * a throttled request comes back `429 Retry-After: 0`, and the honored hint
 * collapses the backoff so all three attempts fire inside a few milliseconds
 * and every one is refused; and HTTP 500 maps to `InternalError`, which is
 * terminal, so a server-side fault fails without a single retry. Dropping the
 * empty hint and restating a 5xx as `ServiceUnavailable` puts both back on the
 * exponential backoff, which is what clears OECD's seconds-long throttle window.
 */
export function retryableUpstreamFailure(err: unknown): unknown {
  if (!(err instanceof McpError)) return err;
  const { retryAfter, ...withoutHint } = err.data ?? {};
  const emptyHint = typeof retryAfter === 'string' && /^0+$/.test(retryAfter.trim());
  const status = err.data?.status;
  const code =
    err.code === JsonRpcErrorCode.InternalError && typeof status === 'number' && status >= 500
      ? JsonRpcErrorCode.ServiceUnavailable
      : err.code;
  if (!emptyHint && code === err.code) return err;
  return new McpError(code, err.message, emptyHint ? withoutHint : err.data, { cause: err });
}

/**
 * Call one OECD endpoint.
 *
 * `fetchWithTimeout` maps the HTTP status onto the error code and captures the
 * upstream body on `error.data.body`, so a plain-text OECD rejection survives
 * to the caller instead of being lost to a JSON parse. Only
 * `ServiceUnavailable`, `Timeout`, and `RateLimited` are transient — a 404 or a
 * 422 becomes terminal and never enters the retry loop, while 408, 429, and 5xx
 * still get their attempts. A caller signal that is already aborted short-
 * circuits before any request is issued.
 */
export function fetchOecd(url: string, options: OecdFetchOptions): Promise<Response> {
  const config = getServerConfig();
  return fetchWithTimeout(
    url,
    config.timeoutMs,
    requestContextService.createRequestContext({ operation: options.operation }),
    {
      headers: { Accept: options.accept, 'Accept-Language': ACCEPT_LANGUAGE },
      expectedStatuses: options.expectedStatuses,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  ).catch((err: unknown) => {
    throw retryableUpstreamFailure(err);
  });
}

/**
 * Read the HTTP status and verbatim upstream text off a classified fetch
 * failure. Returns undefined when the error did not come from a non-2xx
 * response — a timeout, an abort, or a network fault carries no status.
 */
export function upstreamStatus(err: unknown): { body: string; status: number } | undefined {
  if (!(err instanceof McpError)) return;
  const status = err.data?.status;
  if (typeof status !== 'number') return;
  const body = err.data?.body;
  return { body: typeof body === 'string' ? body : '', status };
}
