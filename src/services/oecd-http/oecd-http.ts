/**
 * @fileoverview Shared HTTP boundary for the OECD SDMX endpoints — one fetch
 * path, one body reader, and one decoder guard for the structure and data
 * services, carrying the retry-classification corrections both of them need,
 * the rule that holds every request to the configured host, the per-request
 * share of the call's upstream budget, and the readers that turn a terminal
 * failure into the upstream reason every definition declares for it.
 * @module services/oecd-http/oecd-http
 */

import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
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
}

/**
 * The share of a call's upstream budget one request may spend. A retry ladder
 * hands each attempt its `RetryAttempt`, which has this shape; a lone request
 * gets the budget's own remainder and the caller's signal.
 */
export interface RequestWindow {
  /** Milliseconds left of the call's budget as the request starts. */
  readonly remainingMs: number;
  /** Caller cancellation — composed, inside a ladder, with the ladder's deadline. */
  readonly signal?: AbortSignal | undefined;
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
 * The innermost link of a failure's cause chain that `matches` accepts, or
 * undefined when none does.
 *
 * Both services restate an upstream failure with a message of their own before
 * a handler sees it — "Failed to fetch OECD dataflows" — which keeps the code
 * and the data but drops the sentence the failure was raised with. A relabel
 * copies the code and the data forward, so every link from the original up
 * matches; only the innermost still carries that sentence.
 */
function originalFailure(err: unknown, matches: (e: McpError) => boolean): McpError | undefined {
  let found: McpError | undefined;
  for (let cur: unknown = err; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
    if (cur instanceof McpError && matches(cur)) found = cur;
  }
  return found;
}

/**
 * The refusal {@link refusedRedirect} wrote, read back off a failure that has
 * since been relabelled, so a host that redirects is reported as the
 * configuration it is rather than as the outage it is not. Returns undefined
 * for every other failure.
 */
function refusedRedirectText(err: unknown): string | undefined {
  return originalFailure(
    err,
    (e) => e.code === JsonRpcErrorCode.Forbidden && redirectStatus(e) !== undefined,
  )?.message;
}

/**
 * The text OECD answered a refusal with, as a caller should read it.
 *
 * OECD words a refusal in plain text or JSON, and that wording stays. A body of
 * markup came from something in front of the API — a proxy's or a CDN's error
 * page — where only the `<title>` says anything and the rest is layout; a page
 * with no title contributes nothing, and the status speaks for itself. The body
 * is the bounded capture `fetchWithTimeout` keeps, never the whole response.
 */
function refusalText(body: string): string {
  const text = body.trim();
  if (!text.startsWith('<')) return text;
  const lower = text.toLowerCase();
  const open = lower.indexOf('<title');
  const start = open < 0 ? -1 : lower.indexOf('>', open);
  const end = start < 0 ? -1 : lower.indexOf('</title', start);
  return end < 0
    ? ''
    : text
        .slice(start + 1, end)
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Explanatory text from a request OECD throttled. OECD names which limit was hit
 * — request rate, or the separate cap on downloads and very large data ranges
 * — and only that wording tells the two apart, so a caller that can shrink its
 * request reads it to pick between "wait" and "ask for less". Returns undefined
 * for any failure that is not a throttle.
 *
 * The throttle is charged against the client across every OECD endpoint, so a
 * refused `/datastructure`, `/codelist`, or `/conceptscheme` call is as ordinary
 * as a refused `/data` one. This reader lives at the shared boundary for that
 * reason rather than beside either service.
 */
export function throttleText(err: unknown): string | undefined {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.RateLimited) return;
  const body = err.data?.body;
  return typeof body === 'string' && body.trim() !== '' ? body.trim() : err.message;
}

/**
 * Reasons every definition that reaches OECD declares, so the same upstream
 * failure carries the same reason whichever surface received the call.
 */
export type UpstreamReason =
  | 'rate_limited'
  | 'upstream_error'
  | 'upstream_redirect'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'upstream_unreadable';

/**
 * The declared reason an upstream failure carries, with the text to report, or
 * undefined when the failure is not OECD's to answer for.
 *
 * Handlers call this last, after the branches that recognise a failure their own
 * caller can fix — a missing dataflow, a rejected key. What is left is OECD's
 * answer, and every surface names it the same way: a refused redirect, a
 * throttle, a timeout, an outage, a body this server cannot read, or a status it
 * does not model.
 *
 * A failure is OECD's answer when it carries an upstream HTTP status, whatever
 * code that status mapped to — a structure endpoint's 422 is `ValidationError`
 * and still OECD's refusal — or when it is a `SerializationError`, which here is
 * only ever raised over a body OECD sent: one that is not JSON, JSON whose fields
 * have the wrong type, or an identifier outside the SDMX character set.
 *
 * Three failures bubble as themselves. `RequestCancelled` is the caller's own
 * abort, where OECD may never have been asked anything; `InternalError` is this
 * server failing at something that is not a request; and a `ValidationError`
 * with no status was raised before any request left, as for an `OECD_BASE_URL`
 * that is not http or https.
 *
 * The unmodelled bucket is `upstream_error` rather than a bare code because a
 * `Forbidden`, an `Unauthorized`, or an `InvalidParams` on a keyless public API
 * says nothing about what to do next; the reason and its hint do, and the
 * message carries the status and OECD's own text for the report the hint asks
 * for. A `ServiceUnavailable` the framework marked `retryable: false` — a 501,
 * a method OECD does not implement — lands there too rather than under the
 * retryable `upstream_unavailable`.
 */
export function upstreamRefusal(
  err: unknown,
): { message: string; reason: UpstreamReason } | undefined {
  const redirect = refusedRedirectText(err);
  if (redirect !== undefined) return { message: redirect, reason: 'upstream_redirect' };
  const throttle = throttleText(err);
  if (throttle !== undefined) return { message: throttle, reason: 'rate_limited' };
  if (!(err instanceof McpError)) return;
  if (err.code === JsonRpcErrorCode.SerializationError) {
    const original = originalFailure(err, (e) => e.code === JsonRpcErrorCode.SerializationError);
    const message =
      original === undefined || original === err
        ? err.message
        : `${err.message}: ${original.message}`;
    return { message, reason: 'upstream_unreadable' };
  }
  if (
    err.code === JsonRpcErrorCode.RequestCancelled ||
    err.code === JsonRpcErrorCode.InternalError
  ) {
    return;
  }
  const upstream = upstreamStatus(err);
  if (err.code === JsonRpcErrorCode.ValidationError && upstream === undefined) return;
  if (err.code === JsonRpcErrorCode.Timeout)
    return { message: err.message, reason: 'upstream_timeout' };
  if (err.code === JsonRpcErrorCode.ServiceUnavailable && err.data?.retryable !== false)
    return { message: err.message, reason: 'upstream_unavailable' };
  if (upstream === undefined) return { message: err.message, reason: 'upstream_error' };
  const text = refusalText(upstream.body);
  return {
    message: `${err.message} — OECD answered HTTP ${upstream.status}${text ? `: ${text}` : ''}`,
    reason: 'upstream_error',
  };
}

/**
 * Reconcile an upstream HTTP failure with what `withRetry` treats as transient.
 *
 * One of OECD's responses is otherwise taken at face value and shouldn't be: a
 * throttled request comes back `429 Retry-After: 0`, and the honored hint
 * collapses the backoff so all three attempts fire inside a few milliseconds
 * and every one is refused. Moving it outside the scheduler's `retryAfter`
 * field restores exponential backoff while retaining the received header.
 */
export function retryableUpstreamFailure(err: unknown): unknown {
  if (!(err instanceof McpError)) return err;
  const { retryAfter, ...withoutHint } = err.data ?? {};
  if (typeof retryAfter !== 'string' || !/^0+$/.test(retryAfter.trim())) return err;
  return new McpError(
    err.code,
    err.message,
    { ...withoutHint, receivedRetryAfter: retryAfter },
    {
      cause: err,
    },
  );
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
 * The request gets `OECD_TIMEOUT_MS`, or what is left of the call's upstream
 * budget when that is less, so no request outlives the call it belongs to. One
 * that would start with nothing left is never sent: it fails as `Timeout` at
 * once, unless the caller has already aborted, which `fetchWithTimeout` reports.
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
export function fetchOecd(
  url: string,
  options: OecdFetchOptions,
  window: RequestWindow,
): Promise<Response> {
  if (window.remainingMs <= 0 && !window.signal?.aborted) {
    return Promise.reject(
      timeout('No time was left in the upstream budget of this call to send the OECD request'),
    );
  }
  return fetchWithTimeout(
    url,
    Math.min(getServerConfig().timeoutMs, window.remainingMs),
    requestContextService.createRequestContext({ operation: options.operation }),
    {
      headers: { Accept: options.accept, 'Accept-Language': ACCEPT_LANGUAGE },
      expectedStatuses: options.expectedStatuses,
      redirect: 'manual',
      ...(window.signal ? { signal: window.signal } : {}),
    },
  ).catch((err: unknown) => {
    throw refusedRedirect(err, url) ?? retryableUpstreamFailure(err);
  });
}

/**
 * Read a response body to the end, then decode it as JSON.
 *
 * Two steps because they fail for different reasons. {@link fetchOecd}'s
 * deadline covers the body as well as the headers, so the read rejects with the
 * classification `fetchWithTimeout` gave the failure — `Timeout` when the
 * deadline fires mid-body, `RequestCancelled` when the caller aborts,
 * `ServiceUnavailable` when the connection drops — and it keeps that
 * classification here, so the retry loop and the tool boundary treat it as they
 * would the same failure before the headers. Only a body that arrived whole and
 * is not JSON fails in {@link parseJsonBody}.
 */
export async function readJsonBody(res: Response): Promise<unknown> {
  return parseJsonBody(await res.text(), res.headers);
}

/**
 * Decode a body that arrived whole as JSON, for a reader that needs the text
 * as well as what it parses to.
 *
 * A body that is not JSON becomes `SerializationError`: a retry would fetch the
 * same bytes, and the fault is in what OECD sent, not in whether it was
 * reachable. The message names the content type the response declared, which
 * is what tells a truncated SDMX-JSON document from an HTML page some proxy
 * answered in OECD's place.
 */
export function parseJsonBody(text: string, headers: Headers): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw serializationError(
      `OECD answered with a body that is not JSON (declared content type: ${headers.get('content-type') ?? 'none'})`,
      {},
      { cause: err },
    );
  }
}

/**
 * Run a decoder over a JSON body OECD sent, restating a mistyped field as the
 * unreadable answer it is.
 *
 * The decoders raise a `TypeError` when the body lacks a required collection
 * or puts a field in the wrong shape. Treat it like a body that is not JSON:
 * `SerializationError`, after
 * the one request, which {@link upstreamRefusal} names `upstream_unreadable`.
 * Every other throw — a decoder's deliberate not-found included — passes
 * through as it was.
 */
export function decodeUpstream<T>(decode: () => T): T {
  try {
    return decode();
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw serializationError(
      'OECD answered with JSON whose fields do not have the SDMX shape',
      {},
      { cause: err },
    );
  }
}

/** Require a JSON object at the SDMX decode boundary. */
export function sdmxRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected SDMX object at ${field}`);
  }
  return value as Record<string, unknown>;
}

/** Require an SDMX collection of objects, allowing an explicitly empty collection. */
export function sdmxRecords(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError(`Expected SDMX array at ${field}`);
  return value.map((entry) => sdmxRecord(entry, field));
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
