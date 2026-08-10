/**
 * @fileoverview Tests for the shared OECD fetch boundary — the rule that holds
 * every request to the host it was addressed to, and the retry classification
 * that rule sits alongside.
 * @module tests/services/oecd-http/oecd-http.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchOecd } from '@/services/oecd-http/oecd-http.js';

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
function call(url: string): Promise<Response> {
  return fetchOecd(url, {
    accept: STRUCTURE_ACCEPT,
    expectedStatuses: [404],
    operation: 'test',
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
