/**
 * @fileoverview Shared HTTP boundary for the OECD SDMX endpoints — one fetch
 * path for the structure and data services, carrying the retry-classification
 * corrections both of them need and the rule that holds every request to the
 * configured host.
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
 * The 3xx a classified fetch failure carries, which is the shape only a refused
 * redirect has — `fetchWithTimeout` reports every other failure with a 4xx, a
 * 5xx, or no status at all.
 */
function redirectStatus(err: McpError): number | undefined {
  const status = err.data?.status;
  return typeof status === 'number' && status >= 300 && status < 400 ? status : undefined;
}

/**
 * Restate a refused redirect as the terminal failure it is, or return undefined
 * when the failure was something else.
 *
 * `Forbidden` rather than a transient code: a 3xx is a fixed property of the
 * endpoint, so retrying it only repeats the same refusal, and the three codes
 * `withRetry` treats as transient are the ones that clear on their own. It is
 * also a code no other classification in this server claims — a redirect must
 * not arrive at a tool handler wearing `ValidationError`, which means "OECD
 * rejected your query", or `NotFound`, which means "no such dataflow". An OECD
 * 403 maps to `Forbidden` too, so the status left on `data` is the other half
 * of what {@link refusedRedirectText} matches on.
 */
function refusedRedirect(err: unknown, url: string): McpError | undefined {
  if (!(err instanceof McpError)) return;
  const status = redirectStatus(err);
  if (status === undefined) return;
  return new McpError(
    JsonRpcErrorCode.Forbidden,
    `OECD answered a request to ${new URL(url).origin} with HTTP ${status}. A redirect is not followed — the configured host is the only one this server will reach. Set OECD_BASE_URL to the https origin that answers directly.`,
    err.data,
    { cause: err },
  );
}

/**
 * The refusal {@link refusedRedirect} wrote, read back off a failure that has
 * since been relabelled. Returns undefined for every other failure.
 *
 * Both services restate an upstream failure with a message of their own before
 * a handler sees it — "Failed to fetch OECD dataflows" — which keeps the code
 * and the data but drops the sentence naming `OECD_BASE_URL`. Tool handlers
 * read it back from the cause chain so a host that redirects is reported as the
 * configuration it is, rather than as the outage it is not.
 */
export function refusedRedirectText(err: unknown): string | undefined {
  let text: string | undefined;
  for (let cur: unknown = err; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
    if (!(cur instanceof McpError) || cur.code !== JsonRpcErrorCode.Forbidden) continue;
    // Deepest match wins: a relabel copies the code and the data forward, so
    // every link from here up matches — only the innermost still carries the
    // sentence.
    if (redirectStatus(cur) !== undefined) text = cur.message;
  }
  return text;
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
 *
 * `redirect: 'manual'` is what holds every request to the host it was addressed
 * to. `externalServiceRoot()` pins a delegated root to the configured base URL's
 * origin, but an origin checked before a request is only ever the first hop:
 * under the platform default `redirect: 'follow'` a 3xx from that host carries
 * the request wherever its `Location` points, cross-origin included, and whoever
 * can shape an upstream response can shape a `Location`. Stopping at the 3xx
 * makes the configured host the only host reached — on every hop, and on every
 * request, not just the delegated ones.
 *
 * No hop is followed at all, rather than same-origin hops up to some bound.
 * OECD does not redirect: `/dataflow`, `/datastructure`, `/codelist`,
 * `/conceptscheme`, `/agencyscheme`, and `/data` each answer directly on all
 * four service roots. And a validated hop could not be re-issued from here
 * without rebuilding this boundary — `fetchWithTimeout` reports a 3xx as a
 * status-mapped failure and does not carry the `Location` onto it, so following
 * one would mean reimplementing the timeout, abort, classification, and metrics
 * this function exists to share. Following nothing also leaves no chain to
 * bound.
 *
 * The one behaviour this changes in practice is a base URL configured over
 * plaintext: `http://sdmx.oecd.org/…` is answered with a 301 to https, which is
 * a different origin, so it now fails with an actionable error instead of being
 * upgraded in silence.
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
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    },
  ).catch((err: unknown) => {
    throw refusedRedirect(err, url) ?? retryableUpstreamFailure(err);
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
