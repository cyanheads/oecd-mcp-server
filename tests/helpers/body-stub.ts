/**
 * @fileoverview A loopback HTTP server for exercising the body half of an OECD
 * exchange. A fetch fake hands back a finished `Response`, so the deadline
 * `fetchWithTimeout` keeps over the body never runs against it; this server
 * answers over a real socket and can withhold the headers, send them and then
 * stall the body, drop the connection partway through the body, or send a whole
 * body that is not JSON.
 * @module tests/helpers/body-stub
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** How the stub answers one request. */
export type StubAnswer =
  /** A complete body, sent as given — JSON or not. */
  | { body: string; kind: 'complete'; status?: number }
  /** Nothing at all: the request is held open with no status line. */
  | { kind: 'no-headers' }
  /** `200` headers and an opening fragment of JSON, then nothing until the client leaves. */
  | { kind: 'stalled-body' }
  /** `200` headers and an opening fragment of JSON, then the socket is closed. */
  | { kind: 'dropped-body' };

/** One request the stub received. */
export interface StubRequest {
  /** Whether the `200` headers and the opening fragment reached the socket. */
  bodyStarted: boolean;
  /** Settles once the connection carrying this request has closed. */
  closed: Promise<void>;
  path: string;
}

/** A running stub. */
export interface BodyStub {
  close(): Promise<void>;
  /** `http://127.0.0.1:<port>` — the stub's own origin, to use as a base URL. */
  origin: string;
  requests: StubRequest[];
}

/** The start of an SDMX-JSON document, which a stalled or dropped body never finishes. */
const OPENING_FRAGMENT = '{"data":{';

/**
 * Start a stub on a free loopback port. `answer` picks the behaviour for each
 * request from its path and the zero-based count of requests before it.
 */
export async function startBodyStub(
  answer: (path: string, index: number) => StubAnswer,
): Promise<BodyStub> {
  const requests: StubRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    const reply = answer(path, requests.length);
    const entry: StubRequest = {
      bodyStarted: false,
      closed: new Promise((resolve) => req.socket.once('close', () => resolve())),
      path,
    };
    requests.push(entry);

    switch (reply.kind) {
      case 'complete':
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(reply.body);
        return;
      case 'no-headers':
        return;
      case 'stalled-body':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(OPENING_FRAGMENT, () => {
          entry.bodyStarted = true;
        });
        return;
      case 'dropped-body':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // The fragment is on the wire before the socket closes, so the client
        // has its headers and is reading the body when the connection goes.
        res.write(OPENING_FRAGMENT, () => {
          entry.bodyStarted = true;
          req.socket.destroy();
        });
        return;
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      // A held request keeps its socket open, and `close()` waits for every one.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Install a `fetch` that defers to the one in place and runs `onHeaders` as each
 * response's headers arrive — the moment a caller abort lands mid-body rather
 * than before the request was answered. Returns the function that puts the
 * previous `fetch` back.
 */
export function onResponseHeaders(onHeaders: (response: Response) => void): () => void {
  const previous = globalThis.fetch;
  const passthrough = async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const response = await previous(...args);
    onHeaders(response);
    return response;
  };
  globalThis.fetch = Object.assign(passthrough, previous);
  return () => {
    globalThis.fetch = previous;
  };
}
