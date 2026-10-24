/**
 * @fileoverview Exercise environment loading through the built stdio entry point.
 * @module tests/startup.test
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const Frame = z.object({ id: z.number(), result: z.unknown() });
const ToolList = z.object({ tools: z.array(z.object({ name: z.string() })) });
const ToolError = z.object({
  isError: z.literal(true),
  structuredContent: z.object({ error: z.object({ data: z.object({ reason: z.string() }) }) }),
});

it.each([
  {
    name: 'loads the drop opt-in and canvas opt-out from .env',
    envFile: 'OECD_DATAFRAME_DROP_ENABLED=true\nCANVAS_PROVIDER_TYPE=none\n',
    overrides: {},
    drop: true,
    reason: 'canvas_disabled',
  },
  {
    name: 'gives exported values precedence over .env',
    envFile: 'OECD_DATAFRAME_DROP_ENABLED=true\nCANVAS_PROVIDER_TYPE=none\n',
    overrides: { OECD_DATAFRAME_DROP_ENABLED: 'false', CANVAS_PROVIDER_TYPE: 'duckdb' },
    drop: false,
    reason: 'canvas_not_found',
  },
  {
    name: 'enables DataCanvas by default',
    envFile: '',
    overrides: {},
    drop: false,
    reason: 'canvas_not_found',
  },
  ...['   ', `\${CANVAS_PROVIDER_TYPE}`].map((value) => ({
    name: `uses the DataCanvas default for an unset-equivalent value: ${value}`,
    envFile: '',
    overrides: { CANVAS_PROVIDER_TYPE: value },
    drop: false,
    reason: 'canvas_not_found',
  })),
])('$name', async ({ envFile, overrides, drop, reason }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'oecd-startup-test-'));
  await writeFile(join(cwd, '.env'), envFile);
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_AUTH_MODE: 'none',
      MCP_LOG_LEVEL: 'error',
      OTEL_ENABLED: 'false',
      STORAGE_PROVIDER_TYPE: 'in-memory',
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(5_000),
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => {
      for (const request of pending.values())
        request.reject(new Error(`Server exited before responding: ${stderr}`));
      pending.clear();
      resolve();
    });
  });
  child.on('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  lines.on('line', (line) => {
    const frame = Frame.safeParse(JSON.parse(line));
    if (!frame.success) return;
    pending.get(frame.data.id)?.resolve(frame.data.result);
    pending.delete(frame.data.id);
  });
  function request(id: number, method: string, params: object): Promise<unknown> {
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return result;
  }
  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'startup-test', version: '1.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listed = ToolList.parse(await request(2, 'tools/list', {}));
    expect(listed.tools.some((tool) => tool.name === 'oecd_dataframe_drop')).toBe(drop);
    const result = ToolError.parse(
      await request(3, 'tools/call', {
        name: 'oecd_dataframe_describe',
        arguments: { canvas_id: 'absent0000' },
      }),
    );
    expect(result.structuredContent.error.data.reason).toBe(reason);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
    lines.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
