/**
 * @fileoverview Tests for the shared OECD fetch boundary — the rule that holds
 * every request to the host it was addressed to, the retry classification that
 * rule sits alongside, the body reader both services share, and the reader that
 * decides which failures are OECD's to answer for.
 * @module tests/services/oecd-http/oecd-http.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import {
  fetchOecd,
  readJsonBody,
  retryableUpstreamFailure,
  upstreamRefusal,
} from '@/services/oecd-http/oecd-http.js';
import { type BodyStub, onResponseHeaders, startBodyStub } from '../../helpers/body-stub.js';

const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';

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

/** Call the boundary the way the structure service does. */
function call(url: string, signal?: AbortSignal): Promise<Response> {
  return fetchOecd(url, {
    accept: STRUCTURE_ACCEPT,
    expectedStatuses: [404],
    operation: 'test',
    ...(signal ? { signal } : {}),
  });
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
 * The response body over a real socket — a fetch fake hands back a finished
 * `Response`, so the deadline over the body would never run.
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
      message: 'OECD answered with a body that is not JSON',
    });
    expect((outcome as McpError).cause).toBeInstanceOf(SyntaxError);
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

  it('lets a connection dropped mid-body through as the runtime’s own error', async () => {
    const { outcome, stub } = await readFrom(() => ({ kind: 'dropped-body' }));

    expect(stub.requests[0]?.bodyStarted).toBe(true);
    // Unclassified — which is what puts it on the retry path an outage takes,
    // rather than on the SerializationError path no retry repeats.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(McpError);
  });
});

/**
 * `fetchWithTimeout` reports an `AbortError` that neither its deadline nor the
 * caller raised as `RequestCancelled` (cyanheads/mcp-ts-core#799). The header
 * phase is the only place it does, and a fetch fake reaches it.
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
  ])('maps %s to %s', (code, reason) => {
    expect(upstreamRefusal(new McpError(code, 'upstream said no'))).toEqual({
      message: 'upstream said no',
      reason,
    });
  });

  it.each([
    ['InternalError', JsonRpcErrorCode.InternalError],
    ['SerializationError', JsonRpcErrorCode.SerializationError],
    ['ValidationError', JsonRpcErrorCode.ValidationError],
    ['RequestCancelled', JsonRpcErrorCode.RequestCancelled],
  ])('declines %s — naming OECD for it would blame the wrong party', (_label, code) => {
    expect(upstreamRefusal(new McpError(code, 'not OECD'))).toBeUndefined();
  });

  it('declines a plain Error, which carries no classification to read', () => {
    expect(upstreamRefusal(new Error('boom'))).toBeUndefined();
  });
});
