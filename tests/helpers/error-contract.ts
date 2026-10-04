/**
 * @fileoverview Reads a definition's declared error contract back, so a test can
 * assert what reaches the client against the contract itself rather than against
 * a second copy of its wording. A hint asserted as a string literal drifts the
 * moment the contract is reworded; one read off `errors[]` cannot.
 * @module tests/helpers/error-contract
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

/** A declared contract entry, read structurally so tools and resources both fit. */
export interface DeclaredError {
  code: number;
  reason: string;
  recovery: string;
  retryable?: boolean | undefined;
  when: string;
}

/**
 * Any definition carrying a declared error contract. `errors` is optional on the
 * framework's definition types, so it is optional here too — a definition that
 * declares none still fits, and {@link declaredError} is what turns an absent
 * contract into a failed assertion rather than a silent undefined.
 */
export interface WithErrors {
  errors?: readonly DeclaredError[] | undefined;
}

/** The contract a definition declares, or an empty list when it declares none. */
export function declaredErrors(def: WithErrors): readonly DeclaredError[] {
  return def.errors ?? [];
}

/**
 * The entry a definition declares for a reason.
 *
 * Throws on a missing entry rather than returning undefined: a comparison
 * against undefined passes whenever the other side is also undefined, which is
 * exactly the false green this helper exists to prevent.
 */
export function declaredError(def: WithErrors, reason: string): DeclaredError {
  const entries = declaredErrors(def);
  const entry = entries.find((e) => e.reason === reason);
  if (!entry) {
    throw new Error(
      `No "${reason}" contract entry — declared: ${entries.map((e) => e.reason).join(', ')}`,
    );
  }
  return entry;
}

/** The recovery hint a definition declares for a reason. */
export function declaredRecovery(def: WithErrors, reason: string): string {
  return declaredError(def, reason).recovery;
}

/** The `{ code, message, data }` an error carries on the wire. */
export interface WireError {
  code: number;
  data: Record<string, unknown>;
  message: string;
}

/** The protocol revision the resource wire helper speaks. */
const PROTOCOL_VERSION = '2026-07-28';

type ToolDefinition = Parameters<typeof runToolContract>[0];
type ResourceDefinition = NonNullable<
  NonNullable<Parameters<typeof createWorkerHandler>[0]>['resources']
>[number];

/**
 * Calls a tool the way the production handler factory does and returns the
 * error envelope a client reads from `structuredContent.error`. A declared
 * `recovery` reaches the wire through the factory's fill, never through the
 * handler's own throw, so a hint is asserted here rather than on
 * `definition.handler(...)`.
 */
export async function toolWireError<T extends ToolDefinition>(
  def: T,
  input: z.input<T['input']>,
): Promise<WireError> {
  const result = await runToolContract(def, input);
  const error = (result.structuredContent as { error?: WireError } | undefined)?.error;
  if (!result.isError || !error) {
    throw new Error(`${def.name} returned a success result, not an error envelope`);
  }
  return error;
}

/**
 * Reads a resource URI through the framework's resource handler factory, served
 * by `createWorkerHandler` over a modern `resources/read` request, and returns
 * the JSON-RPC error. Resources have no contract runner; this is the path on
 * which the declared `recovery` is filled in.
 */
export async function resourceWireError(def: ResourceDefinition, uri: string): Promise<WireError> {
  const handler = createWorkerHandler({ name: 'oecd-mcp-server', resources: [def] });
  const meta = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'oecd-mcp-server-tests', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'resources/read',
        'Mcp-Name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri, _meta: meta },
      }),
    }),
    {} as never,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
  );
  const text = await response.text();
  const frame = text.startsWith('{') ? text : (text.match(/^data: (.*)$/m)?.[1] ?? text);
  const body = JSON.parse(frame) as { error?: WireError };
  if (!body.error) throw new Error(`resources/read of ${uri} did not fail: ${text}`);
  return body.error;
}
