/**
 * @fileoverview Tests for oecd_dataframe_drop — the drop path against a real
 * DuckDB canvas, its declared error contract on the wire, and the
 * OECD_DATAFRAME_DROP_ENABLED gate that registers it as disabled by default.
 * @module tests/tools/dataframe-drop.tool.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { declaredRecovery, toolWireError } from '../helpers/error-contract.js';

const TOOL_NAME = 'oecd_dataframe_drop';
const ENABLE_HINT = 'OECD_DATAFRAME_DROP_ENABLED=true';

type DropModule = typeof import('@/mcp-server/tools/definitions/dataframe-drop.tool.js');
type AccessorModule = typeof import('@/services/canvas-accessor/canvas-accessor.js');

/**
 * Imports the definition and the canvas accessor fresh under the given flag
 * value. The gate is evaluated when the definition module loads, and the
 * server config is cached per module instance, so each flag value needs its
 * own module graph.
 */
async function loadUnderFlag(
  value: string | undefined,
): Promise<{ accessor: AccessorModule; drop: DropModule['oecdDataframeDrop'] }> {
  vi.resetModules();
  vi.stubEnv('OECD_DATAFRAME_DROP_ENABLED', value);
  const [{ oecdDataframeDrop }, accessor] = await Promise.all([
    import('@/mcp-server/tools/definitions/dataframe-drop.tool.js'),
    import('@/services/canvas-accessor/canvas-accessor.js'),
  ]);
  return { accessor, drop: oecdDataframeDrop };
}

/** Text of every `content[]` block, joined. */
function textOf(content: unknown): string {
  return (content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
}

/** Lists the tools a client sees, through the framework's own registration path. */
async function listedToolNames(
  tools: NonNullable<NonNullable<Parameters<typeof createWorkerHandler>[0]>['tools']>,
): Promise<string[]> {
  const handler = createWorkerHandler({ name: 'oecd-mcp-server', tools });
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'oecd-tests', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {} as never,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
  );
  const text = await response.text();
  const frame = text.startsWith('{') ? text : (text.match(/^data: (.*)$/m)?.[1] ?? text);
  const body = JSON.parse(frame) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name);
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('oecdDataframeDrop gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is off by default: defined, but never registered for clients to call', async () => {
    const { drop } = await loadUnderFlag(undefined);

    expect(drop.name).toBe(TOOL_NAME);
    expect(await listedToolNames([drop])).not.toContain(TOOL_NAME);
  });

  it('names the env var that turns it on wherever the disabled tool is shown', async () => {
    const { drop } = await loadUnderFlag(undefined);
    const handler = createWorkerHandler({ name: 'oecd-mcp-server', tools: [drop] });

    const landing = await handler.fetch(
      new Request('http://localhost/', { headers: { accept: 'text/html' } }),
      {} as never,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
    );
    const html = await landing.text();

    expect(html).toContain(TOOL_NAME);
    expect(html).toContain(ENABLE_HINT);
  });

  it('stays off when the flag is set to false', async () => {
    const { drop } = await loadUnderFlag('false');

    expect(await listedToolNames([drop])).not.toContain(TOOL_NAME);
  });

  it('registers for clients when OECD_DATAFRAME_DROP_ENABLED=true', async () => {
    const { drop } = await loadUnderFlag('true');

    expect(await listedToolNames([drop])).toContain(TOOL_NAME);
  });

  it('refuses a value that is not a boolean rather than guessing', async () => {
    await expect(loadUnderFlag('sometimes')).rejects.toThrow(/OECD_DATAFRAME_DROP_ENABLED/);
  });
});

// ── The drop path, against a real DuckDB canvas ─────────────────────────────

describe('oecdDataframeDrop', () => {
  let scratch: string;
  let canvas: DataCanvas;
  let drop: DropModule['oecdDataframeDrop'];
  let accessor: AccessorModule;

  beforeAll(async () => {
    ({ drop, accessor } = await loadUnderFlag('true'));
    scratch = mkdtempSync(join(tmpdir(), 'oecd-drop-test-'));
    const provider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: scratch,
      tempRootPath: scratch,
      defaultRowLimit: 1000,
      schemaSniffRows: 100,
    });
    const registry = new CanvasRegistry(provider, {
      ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
      sweeperIntervalMs: 0,
    });
    canvas = new DataCanvas(provider, registry);
  });

  afterAll(async () => {
    await canvas.shutdown(createMockContext());
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(() => {
    accessor.setCanvas(canvas);
  });

  /** Stages two observation tables and a view over one of them on a fresh canvas. */
  async function stagedCanvas(): Promise<string> {
    const instance = await canvas.acquire(undefined, createMockContext());
    await instance.registerTable('spilled_gdp', [
      { REF_AREA: 'USA', TIME_PERIOD: '2022', value: 1 },
      { REF_AREA: 'DEU', TIME_PERIOD: '2022', value: 2 },
    ]);
    await instance.registerTable('spilled_cpi', [
      { REF_AREA: 'USA', TIME_PERIOD: '2022', value: 3 },
    ]);
    await instance.registerView('usa_gdp', "SELECT * FROM spilled_gdp WHERE REF_AREA = 'USA'");
    return instance.canvasId;
  }

  async function tableNames(canvasId: string): Promise<string[]> {
    const instance = await canvas.acquire(canvasId, createMockContext());
    return (await instance.describe()).map((t) => t.name).sort();
  }

  it('drops one table and reports what remains, on both surfaces', async () => {
    const canvasId = await stagedCanvas();

    const result = await runToolContract(drop, { canvas_id: canvasId, table_name: 'spilled_cpi' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      canvas_id: canvasId,
      table_name: 'spilled_cpi',
      kind: 'table',
      remaining_tables: ['spilled_gdp', 'usa_gdp'],
    });
    const text = textOf(result.content);
    expect(text).toContain('spilled_cpi');
    expect(text).toContain(canvasId);
    expect(text).toContain('table');
    expect(text).toContain('spilled_gdp');
    expect(text).toContain('usa_gdp');

    expect(await tableNames(canvasId)).toEqual(['spilled_gdp', 'usa_gdp']);
  });

  it('drops a view without touching the table it reads', async () => {
    const canvasId = await stagedCanvas();

    const result = await runToolContract(drop, { canvas_id: canvasId, table_name: 'usa_gdp' });

    expect(result.structuredContent).toMatchObject({ table_name: 'usa_gdp', kind: 'view' });
    expect(textOf(result.content)).toContain('view');
    expect(await tableNames(canvasId)).toEqual(['spilled_cpi', 'spilled_gdp']);
  });

  it('leaves the canvas itself alive, so the remaining tables still answer SQL', async () => {
    const canvasId = await stagedCanvas();

    await runToolContract(drop, { canvas_id: canvasId, table_name: 'spilled_cpi' });

    const instance = await canvas.acquire(canvasId, createMockContext());
    const rows = await instance.query('SELECT COUNT(*) AS n FROM spilled_gdp');
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });

  it('reports the last table dropped with nothing left on the canvas', async () => {
    const instance = await canvas.acquire(undefined, createMockContext());
    await instance.registerTable('spilled_only', [{ value: 1 }]);

    const result = await runToolContract(drop, {
      canvas_id: instance.canvasId,
      table_name: 'spilled_only',
    });

    expect(result.structuredContent).toMatchObject({ remaining_tables: [] });
    expect(textOf(result.content)).toContain('No tables remain');
  });

  it('answers a second drop of the same table table_not_found', async () => {
    const canvasId = await stagedCanvas();
    await runToolContract(drop, { canvas_id: canvasId, table_name: 'spilled_cpi' });

    const err = await toolWireError(drop, { canvas_id: canvasId, table_name: 'spilled_cpi' });

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'table_not_found',
        recovery: { hint: declaredRecovery(drop, 'table_not_found') },
      },
    });
    expect(err.message).toContain('spilled_cpi');
  });

  it('answers a name that is not a staged table table_not_found, naming describe', async () => {
    const canvasId = await stagedCanvas();

    const err = await toolWireError(drop, { canvas_id: canvasId, table_name: 'no such; table' });

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found' },
    });
    expect(declaredRecovery(drop, 'table_not_found')).toContain('oecd_dataframe_describe');
    expect(await tableNames(canvasId)).toEqual(['spilled_cpi', 'spilled_gdp', 'usa_gdp']);
  });

  it('answers a well-formed canvas id this server never issued canvas_not_found', async () => {
    const err = await toolWireError(drop, { canvas_id: 'AAAAAAAAAA', table_name: 'spilled_gdp' });

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: declaredRecovery(drop, 'canvas_not_found') },
      },
    });
  });

  it('rejects a canvas_id that cannot be one before the handler runs', async () => {
    const result = await runToolContract(drop, { canvas_id: 'df_abc', table_name: 'spilled_gdp' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });

  it('answers canvas_disabled when no canvas is configured', async () => {
    accessor.setCanvas(undefined);

    const err = await toolWireError(drop, { canvas_id: 'AAAAAAAAAA', table_name: 'spilled_gdp' });

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'canvas_disabled',
        recovery: { hint: declaredRecovery(drop, 'canvas_disabled') },
      },
    });
  });
});
