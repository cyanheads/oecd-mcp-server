/**
 * @fileoverview Tests for the shared OECD fetch boundary — the rule that holds
 * every request to the host it was addressed to, the retry classification that
 * rule sits alongside, each request's share of the call's budget, the body
 * reader and decoder guard both services share, and the reader that decides
 * which failures are OECD's to answer for and how they are worded.
 * @module tests/services/oecd-http/oecd-http.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serializationError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import {
  decodeUpstream,
  fetchOecd,
  parseJsonBody,
  readJsonBody,
  retryableUpstreamFailure,
  upstreamRefusal,
} from '@/services/oecd-http/oecd-http.js';
import { type BodyStub, onResponseHeaders, startBodyStub } from '../../helpers/body-stub.js';
import {
  installScriptedFetch,
  observe,
  rejectionOf,
  type ScriptedFetch,
  STALL,
} from '../../helpers/scripted-fetch.js';

const STRUCTURE_OPTIONS = {
  accept: 'application/vnd.sdmx.structure+json;version=1.0',
  expectedStatuses: [404],
  operation: 'test',
};

/** A listening server plus the paths it was asked for, in order. */
interface Probe {
  origin: string;
  paths: string[];
  server: Server;
}

const running: Server[] = [];

/** Start a server on a loopback port and record every path it is asked for. */
async function probe(
  handler: (path: string) => { body?: string; headers?: Record<string, string>; status: number },
): Promise<Probe> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    const { body, headers, status } = handler(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push(server);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, paths, server };
}

/**
 * Call the boundary the way the structure service does, with no budget to cut
 * the request short — the request gets `OECD_TIMEOUT_MS` whole.
 */
function call(url: string, signal?: AbortSignal): Promise<Response> {
  return fetchOecd(url, STRUCTURE_OPTIONS, { remainingMs: Number.POSITIVE_INFINITY, signal });
}

afterEach(async () => {
  await Promise.all(
    running
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('fetchOecd redirect handling', () => {
  it('refuses a cross-origin redirect without requesting the other host', async () => {
    const elsewhere = await probe(() => ({ body: '{"stolen":true}', status: 200 }));
    const oecd = await probe(() => ({
      headers: { Location: `${elsewhere.origin}/pwned` },
      status: 302,
    }));

    const error = await call(`${oecd.origin}/dataflow/OECD.STI.PIE`).catch((e: Error) => e);

    expect(elsewhere.paths).toEqual([]);
    expect(oecd.paths).toEqual(['/dataflow/OECD.STI.PIE']);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden });
    expect((error as Error).message).toContain('302');
  });

  it('refuses a same-origin redirect, so no chain of hops can form', async () => {
    const oecd = await probe((path) =>
      path === '/final'
        ? { body: '{"ok":true}', status: 200 }
        : { headers: { Location: '/final' }, status: 301 },
    );

    const error = await call(`${oecd.origin}/dataflow`).catch((e: Error) => e);

    expect(oecd.paths).toEqual(['/dataflow']);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });

  it('does not retry a refused redirect', async () => {
    const oecd = await probe(() => ({ headers: { Location: '/elsewhere' }, status: 307 }));

    await withRetry(() => call(`${oecd.origin}/codelist/OECD/CL_AREA`), { maxRetries: 2 }).catch(
      () => undefined,
    );

    expect(oecd.paths).toEqual(['/codelist/OECD/CL_AREA']);
  });

  it('returns the body of a response that does not redirect', async () => {
    const oecd = await probe(() => ({ body: '{"data":{"dataflows":[]}}', status: 200 }));

    const response = await call(`${oecd.origin}/dataflow`);

    expect(await response.json()).toEqual({ data: { dataflows: [] } });
  });

  it('leaves a 5xx on the transient classification that earns it a retry', async () => {
    const oecd = await probe(() => ({ body: 'upstream fault', status: 500 }));

    const error = await withRetry(() => call(`${oecd.origin}/dataflow`), {
      baseDelayMs: 1,
      maxRetries: 1,
    }).catch((e: Error) => e);

    expect(oecd.paths).toHaveLength(2);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });
});

/**
 * The response body over a real loopback socket, so each failure reaches the
 * reader in the shape the runtime's own network stack gives it — a deadline
 * cutting a stalled read, a caller abort mid-body, a connection dropped partway
 * through. That proves the classification against what Bun's and Node's
 * `fetch` actually throw, where a fake would prove only what it was written to
 * throw.
 */
describe('readJsonBody', () => {
  const config = getServerConfig();
  const configuredTimeoutMs = config.timeoutMs;
  const stubs: BodyStub[] = [];

  /** Fetch from a fresh stub and read the body the way both services do. */
  async function readFrom(
    answer: Parameters<typeof startBodyStub>[0],
    signal?: AbortSignal,
  ): Promise<{ outcome: unknown; stub: BodyStub }> {
    const stub = await startBodyStub(answer);
    stubs.push(stub);
    const outcome = await call(`${stub.origin}/dataflow`, signal)
      .then(readJsonBody)
      .catch((e: unknown) => e);
    return { outcome, stub };
  }

  afterEach(async () => {
    config.timeoutMs = configuredTimeoutMs;
    await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  });

  it('decodes a complete JSON body', async () => {
    const { outcome } = await readFrom(() => ({
      body: '{"data":{"dataflows":[]}}',
      kind: 'complete',
    }));

    expect(outcome).toEqual({ data: { dataflows: [] } });
  });

  it('reports a complete body that is not JSON as a SerializationError', async () => {
    const { outcome } = await readFrom(() => ({
      body: '<html>Service notice</html>',
      kind: 'complete',
    }));

    expect(outcome).toBeInstanceOf(McpError);
    expect(outcome).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message:
        'OECD answered with a body that is not JSON (declared content type: application/json)',
    });
    expect((outcome as McpError).cause).toBeInstanceOf(SyntaxError);
    expect(upstreamRefusal(outcome)?.reason).toBe('upstream_unreadable');
  });

  it.each([
    [
      'the content type a proxy page declared',
      'text/html; charset=utf-8',
      'text/html; charset=utf-8',
    ],
    ['none, when the response declared none', undefined, 'none'],
  ])('names %s', async (_label, contentType, named) => {
    const body = new TextEncoder().encode('<html><title>Bad Gateway</title></html>');
    const response = new Response(
      body,
      contentType ? { headers: { 'content-type': contentType } } : {},
    );

    const outcome = await readJsonBody(response).catch((e: unknown) => e);

    expect(outcome).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: `OECD answered with a body that is not JSON (declared content type: ${named})`,
    });
  });

  it('keeps the deadline’s Timeout when the body stalls past it', async () => {
    config.timeoutMs = 300;

    const { outcome, stub } = await readFrom(() => ({ kind: 'stalled-body' }));

    expect(outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchTimeout' },
    });
    // The headers and the opening of the body were sent before the deadline,
    // and the client tore the stalled stream down rather than leaving it open.
    expect(stub.requests[0]?.bodyStarted).toBe(true);
    await stub.requests[0]?.closed;
  });

  it('keeps the caller’s RequestCancelled when the abort lands mid-body', async () => {
    const caller = new AbortController();
    const restoreFetch = onResponseHeaders(() => caller.abort());

    try {
      const { outcome, stub } = await readFrom(() => ({ kind: 'stalled-body' }), caller.signal);

      expect(outcome).toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        data: { errorSource: 'FetchAborted' },
      });
      expect((outcome as Error).message).toMatch(/was aborted\.$/);
      expect(stub.requests).toHaveLength(1);
    } finally {
      restoreFetch();
    }
  });

  it('reports a connection dropped mid-body as ServiceUnavailable, not SerializationError', async () => {
    const { outcome, stub } = await readFrom(() => ({ kind: 'dropped-body' }));

    expect(stub.requests[0]?.bodyStarted).toBe(true);
    // The retry path an outage takes, rather than the SerializationError path
    // no retry repeats; the runtime's own error stays on the cause.
    expect(outcome).toBeInstanceOf(McpError);
    expect(outcome).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { errorSource: 'FetchNetworkErrorWrapper' },
    });
    expect((outcome as McpError).cause).toBeInstanceOf(Error);
    expect((outcome as McpError).cause).not.toBeInstanceOf(McpError);
    expect(upstreamRefusal(outcome)?.reason).toBe('upstream_unavailable');
  });
});

/** The decode step on its own, for a reader that holds the body text — the structure service's. */
describe('parseJsonBody', () => {
  it('decodes JSON text', () => {
    expect(parseJsonBody('{"data":{"dataflows":[]}}', new Headers())).toEqual({
      data: { dataflows: [] },
    });
  });

  it.each([
    ['the content type the response declared', { 'content-type': 'text/html' }, 'text/html'],
    ['none, when the response declared none', {}, 'none'],
  ])(
    'reports text that is not JSON as a SerializationError naming %s',
    (_label, headers, named) => {
      let outcome: unknown;
      try {
        parseJsonBody('<html><title>Bad Gateway</title></html>', new Headers(headers));
      } catch (err) {
        outcome = err;
      }

      expect(outcome).toBeInstanceOf(McpError);
      expect(outcome).toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message: `OECD answered with a body that is not JSON (declared content type: ${named})`,
      });
      expect((outcome as McpError).cause).toBeInstanceOf(SyntaxError);
      expect(upstreamRefusal(outcome)?.reason).toBe('upstream_unreadable');
    },
  );
});

/**
 * An `AbortError` that neither the deadline nor the caller raised is the
 * runtime dropping the request, so it takes the retry path a reset connection
 * takes; only the caller's own abort is `RequestCancelled`. A fetch fake reaches
 * the header phase, where the rejection lands.
 */
describe('fetchOecd cancellation', () => {
  const URL_UNDER_TEST = 'https://fake.oecd.test/dataflow';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['a live caller signal', () => new AbortController().signal],
    ['no caller signal', () => undefined],
  ])('retries an abort nobody requested, with %s, as an outage', async (_label, signalOf) => {
    const fetchFake = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    vi.stubGlobal('fetch', fetchFake);

    const error = await withRetry(() => call(URL_UNDER_TEST, signalOf()), {
      baseDelayMs: 1,
      maxRetries: 2,
    }).catch((e: unknown) => e);

    expect(fetchFake).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(upstreamRefusal(error)?.reason).toBe('upstream_unavailable');
  });

  it('keeps the caller’s own abort as RequestCancelled, with no retry', async () => {
    const caller = new AbortController();
    const fetchFake = vi.fn().mockImplementation(() => {
      caller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    vi.stubGlobal('fetch', fetchFake);

    const error = await withRetry(() => call(URL_UNDER_TEST, caller.signal), {
      baseDelayMs: 1,
      maxRetries: 2,
      signal: caller.signal,
    }).catch((e: unknown) => e);

    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      data: { errorSource: 'FetchAborted' },
    });
    expect((error as Error).message).toMatch(/was aborted\.$/);
    expect(upstreamRefusal(error)).toBeUndefined();
  });
});

describe('retryableUpstreamFailure', () => {
  it('drops a Retry-After of 0, which would collapse the backoff to nothing', () => {
    const throttled = new McpError(JsonRpcErrorCode.RateLimited, 'Too many requests', {
      retryAfter: '0',
      status: 429,
    });

    const restated = retryableUpstreamFailure(throttled) as McpError;

    expect(restated).not.toBe(throttled);
    expect(restated.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(restated.data?.retryAfter).toBeUndefined();
    expect(restated.data?.receivedRetryAfter).toBe('0');
    expect(restated.data?.status).toBe(429);
    expect(restated.cause).toBe(throttled);
  });

  it('keeps a Retry-After the caller can actually wait out', () => {
    const throttled = new McpError(JsonRpcErrorCode.RateLimited, 'Too many requests', {
      retryAfter: '120',
      status: 429,
    });

    expect(retryableUpstreamFailure(throttled)).toBe(throttled);
  });

  it('passes a non-McpError through untouched', () => {
    const network = new Error('socket hang up');

    expect(retryableUpstreamFailure(network)).toBe(network);
  });
});

describe('upstreamRefusal', () => {
  /**
   * The failure a refused redirect leaves once a service has relabelled it —
   * the boundary's sentence survives on the innermost link of the cause chain,
   * which is the only place the OECD_BASE_URL advice still exists.
   */
  function relabelledRedirect(): McpError {
    const refused = new McpError(
      JsonRpcErrorCode.Forbidden,
      'OECD answered a request to https://sdmx.oecd.test with HTTP 302. Set OECD_BASE_URL to the https origin that answers directly.',
      { status: 302 },
    );
    return new McpError(
      JsonRpcErrorCode.Forbidden,
      'Failed to fetch OECD dataflows',
      refused.data,
      {
        cause: refused,
      },
    );
  }

  it('reads a relabelled redirect back as upstream_redirect with the boundary sentence', () => {
    expect(upstreamRefusal(relabelledRedirect())).toEqual({
      message: expect.stringContaining('OECD_BASE_URL'),
      reason: 'upstream_redirect',
    });
  });

  it('reports a throttle as rate_limited, carrying the OECD body verbatim', () => {
    const throttled = new McpError(JsonRpcErrorCode.RateLimited, 'Too many requests', {
      body: 'You have exceeded the number of requests currently permitted.',
      status: 429,
    });

    expect(upstreamRefusal(throttled)).toEqual({
      message: 'You have exceeded the number of requests currently permitted.',
      reason: 'rate_limited',
    });
  });

  it.each([
    [JsonRpcErrorCode.Timeout, 'upstream_timeout'],
    [JsonRpcErrorCode.ServiceUnavailable, 'upstream_unavailable'],
    [JsonRpcErrorCode.Forbidden, 'upstream_error'],
    [JsonRpcErrorCode.Unauthorized, 'upstream_error'],
    [JsonRpcErrorCode.InvalidParams, 'upstream_error'],
    [JsonRpcErrorCode.InvalidRequest, 'upstream_error'],
    [JsonRpcErrorCode.SerializationError, 'upstream_unreadable'],
  ])('maps a status-less %s to %s with its message as written', (code, reason) => {
    expect(upstreamRefusal(new McpError(code, 'upstream said no'))).toEqual({
      message: 'upstream said no',
      reason,
    });
  });

  /** A refusal the boundary classified, as a service relabels it. */
  function refused(code: JsonRpcErrorCode, status: number, body: string, extra = {}): McpError {
    return new McpError(code, 'Failed to fetch OECD dataflows', { body, status, ...extra });
  }

  it.each([
    ['plain text as written', 'Forbidden by policy', ': Forbidden by policy'],
    ['JSON as written', '{"error":"no key"}', ': {"error":"no key"}'],
    [
      'an HTML page by its title',
      '<html><head><TITLE lang="en">\n  Access\n Denied </TITLE>',
      ': Access Denied',
    ],
    ['an HTML page with no title as nothing', '<html><body><h1>Denied</h1></body></html>', ''],
    ['an unterminated title as nothing', '  <html><title>Denied', ''],
    ['an empty body as nothing', '', ''],
    ['a blank body as nothing', ' \n\t ', ''],
  ])('carries the status on an upstream_error, and OECD’s text: %s', (_label, body, suffix) => {
    expect(upstreamRefusal(refused(JsonRpcErrorCode.Forbidden, 403, body))).toEqual({
      message: `Failed to fetch OECD dataflows — OECD answered HTTP 403${suffix}`,
      reason: 'upstream_error',
    });
  });

  it('reads a structure 422 as OECD’s refusal rather than this server’s', () => {
    const unprocessable = refused(JsonRpcErrorCode.ValidationError, 422, 'Unprocessable entity');

    expect(upstreamRefusal(unprocessable)).toEqual({
      message: 'Failed to fetch OECD dataflows — OECD answered HTTP 422: Unprocessable entity',
      reason: 'upstream_error',
    });
  });

  it('lands a 501 the framework marked non-retryable under upstream_error, not upstream_unavailable', () => {
    const notImplemented = refused(JsonRpcErrorCode.ServiceUnavailable, 501, 'Not Implemented', {
      retryable: false,
    });

    expect(upstreamRefusal(notImplemented)).toEqual({
      message: 'Failed to fetch OECD dataflows — OECD answered HTTP 501: Not Implemented',
      reason: 'upstream_error',
    });
  });

  it('lands a status-less ServiceUnavailable marked non-retryable under upstream_error as written', () => {
    const settled = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream said no', {
      retryable: false,
    });

    expect(upstreamRefusal(settled)).toEqual({
      message: 'upstream said no',
      reason: 'upstream_error',
    });
  });

  it.each([
    [JsonRpcErrorCode.ServiceUnavailable, 503, 'upstream_unavailable'],
    [JsonRpcErrorCode.Timeout, 504, 'upstream_timeout'],
  ])('keeps the message of a %s carrying HTTP %i under %s', (code, status, reason) => {
    expect(upstreamRefusal(refused(code, status, 'upstream fault'))).toEqual({
      message: 'Failed to fetch OECD dataflows',
      reason,
    });
  });

  it('names an unreadable body with the sentence the decoder raised under the relabel', () => {
    const decoded = serializationError(
      'OECD answered with a body that is not JSON (declared content type: text/html)',
    );
    const service = new McpError(
      JsonRpcErrorCode.SerializationError,
      'Failed to fetch OECD datastructure for OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      decoded.data,
      { cause: decoded },
    );
    const relabelledTwice = new McpError(
      JsonRpcErrorCode.SerializationError,
      'Failed to fetch OECD data for OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      service.data,
      { cause: service },
    );

    expect(upstreamRefusal(service)).toEqual({
      message:
        'Failed to fetch OECD datastructure for OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I: OECD answered with a body that is not JSON (declared content type: text/html)',
      reason: 'upstream_unreadable',
    });
    // The innermost sentence, however many relabels sit over it.
    expect(upstreamRefusal(relabelledTwice)?.message).toBe(
      'Failed to fetch OECD data for OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I: OECD answered with a body that is not JSON (declared content type: text/html)',
    );
  });

  it.each([
    ['InternalError', new McpError(JsonRpcErrorCode.InternalError, 'not OECD')],
    ['RequestCancelled', new McpError(JsonRpcErrorCode.RequestCancelled, 'not OECD')],
    [
      'a ValidationError raised before any request left',
      validationError('Only HTTP and HTTPS URLs are allowed.', { reason: 'invalid_url' }),
    ],
    ['a plain Error, which carries no classification to read', new Error('boom')],
  ])('declines %s — naming OECD for it would blame the wrong party', (_label, error) => {
    expect(upstreamRefusal(error)).toBeUndefined();
  });
});

describe('decodeUpstream', () => {
  it('returns what the decoder returns', () => {
    expect(decodeUpstream(() => ['DF_NAAG_I'])).toEqual(['DF_NAAG_I']);
  });

  it('restates a mistyped field as an unreadable answer, keeping the TypeError as the cause', () => {
    const mistyped: unknown = { data: { dataflows: {} } };

    const error = (() => {
      try {
        return decodeUpstream(() =>
          (mistyped as { data: { dataflows: string[] } }).data.dataflows.map((id) => id),
        );
      } catch (e) {
        return e;
      }
    })();

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'OECD answered with JSON whose fields do not have the SDMX shape',
    });
    expect((error as McpError).cause).toBeInstanceOf(TypeError);
    expect(upstreamRefusal(error)).toEqual({
      message: 'OECD answered with JSON whose fields do not have the SDMX shape',
      reason: 'upstream_unreadable',
    });
  });

  it('passes a decoder’s deliberate not-found through as it was thrown', () => {
    const missing = notFound('Dataflow not found: OECD.SDD.NAD,DF_NONE');

    expect(() =>
      decodeUpstream(() => {
        throw missing;
      }),
    ).toThrow(missing);
  });
});

/**
 * Each request's share of the call's budget, under fake timers with a fetch
 * fake that holds every request open until its signal aborts.
 */
describe('fetchOecd request window', () => {
  const config = getServerConfig();
  const configuredTimeoutMs = config.timeoutMs;
  const URL_UNDER_TEST = 'https://fake.oecd.test/dataflow';
  let http: ScriptedFetch;

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    config.timeoutMs = 30_000;
    http = installScriptedFetch(() => STALL);
  });

  afterEach(() => {
    vi.useRealTimers();
    config.timeoutMs = configuredTimeoutMs;
    http.restore();
  });

  it.each([
    ['the time left, when that is less than OECD_TIMEOUT_MS', 10_000, 10_000],
    ['OECD_TIMEOUT_MS, when the budget has more left', 45_000, 30_000],
  ])('times a request out at %s', async (_label, remainingMs, timeoutMs) => {
    const sent = observe(fetchOecd(URL_UNDER_TEST, STRUCTURE_OPTIONS, { remainingMs }));
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);

    expect(sent.settledAtMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const error = await rejectionOf(sent);

    expect(sent.settledAtMs).toBe(timeoutMs);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchTimeout' },
    });
    expect(http.requests).toHaveLength(1);
  });

  it('sends nothing when the budget has no time left, and fails as Timeout at once', async () => {
    const error = await fetchOecd(URL_UNDER_TEST, STRUCTURE_OPTIONS, { remainingMs: 0 }).catch(
      (e: unknown) => e,
    );

    expect(http.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'No time was left in the upstream budget of this call to send the OECD request',
    });
    expect(upstreamRefusal(error)?.reason).toBe('upstream_timeout');
  });

  it('reports a caller who already left as RequestCancelled, even with no time left', async () => {
    const caller = new AbortController();
    caller.abort();

    const error = await fetchOecd(URL_UNDER_TEST, STRUCTURE_OPTIONS, {
      remainingMs: 0,
      signal: caller.signal,
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(upstreamRefusal(error)).toBeUndefined();
  });
});
