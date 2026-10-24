/**
 * @fileoverview Real capacity-two canvas lifecycle and spill response contracts.
 * @module tests/tools/query-dataset-canvas.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { oecdDataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { oecdQueryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { initDataService } from '@/services/oecd-data/oecd-data-service.js';

const input = { flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I', key: 'A.USA..' };
const ctx = createMockContext({ tenantId: 'default', errors: oecdQueryDataset.errors });
const http = createFetchMock();
const markdown = new MarkdownIt({ html: true });
let canvas: DataCanvas;
let provider: DuckdbProvider;
let scratch: string;
let now: number;

/** Three observations; only the dimension label changes to force overflow. */
function respond(large = false): void {
  const payload = {
    data: {
      dataSets: [{ observations: { '0:0': [7], '0:1': [8], '0:2': [9] } }],
      structures: [
        {
          dimensions: {
            observation: [
              {
                id: 'REF_AREA',
                values: [{ id: 'USA', name: large ? 'x'.repeat(110_000) : 'United States' }],
              },
              { id: 'TIME_PERIOD', values: [{ id: '2020' }, { id: '2021' }, { id: '2022' }] },
            ],
          },
        },
      ],
    },
  };
  http.reset();
  http.route({ match: /^https:\/\/fake.oecd.test\/data\//, respond: () => Response.json(payload) });
}

function textOf(output: Awaited<ReturnType<typeof runToolContract>>): string {
  const source = output.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  return markdown
    .parse(source, {})
    .flatMap((token) => token.children ?? [token])
    .map((token) => {
      if (token.type === 'hardbreak' || token.type === 'softbreak') return '\n';
      return token.type === 'text' || token.type === 'code_inline' ? token.content : '';
    })
    .join('');
}

beforeEach(async () => {
  process.env.OECD_BASE_URL = 'https://fake.oecd.test';
  initDataService();
  scratch = await mkdtemp(join(tmpdir(), 'oecd-canvas-test-'));
  provider = new DuckdbProvider({
    memoryLimitMb: 128,
    exportRootPath: scratch,
    tempRootPath: scratch,
    defaultRowLimit: 1000,
    schemaSniffRows: 100,
  });
  now = Date.now();
  const registry = new CanvasRegistry(
    provider,
    { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, maxCanvasesPerTenant: 2, sweeperIntervalMs: 0 },
    () => now,
  );
  canvas = new DataCanvas(provider, registry);
  setCanvas(canvas);
  http.install();
  respond();
});

afterEach(async () => {
  vi.restoreAllMocks();
  http.restore();
  setCanvas(undefined);
  await canvas.shutdown(ctx);
  await rm(scratch, { recursive: true });
});

describe('query dataset real canvas lifecycle', () => {
  it('preserves caller tables when an explicit canvas holds an inline result', async () => {
    const existing = await canvas.acquire(undefined, ctx);
    await existing.registerTable('keep', [{ value: 17 }], {
      schema: [{ name: 'value', type: 'DOUBLE' }],
    });
    const output = await runToolContract(oecdQueryDataset, {
      ...input,
      canvas_id: existing.canvasId,
    });
    expect(output.isError).toBeUndefined();
    expect(output.structuredContent).toMatchObject({ row_count: 3 });
    expect(output.structuredContent).not.toHaveProperty('canvas_id');
    expect(output.structuredContent).not.toHaveProperty('notice');
    expect((await existing.query('SELECT value FROM keep')).rows).toEqual([{ value: 17 }]);
    expect(canvas.countForTenant(ctx)).toBe(1);
  });

  it('uses no slots for repeated inline calls, even with the pool full', async () => {
    for (let call = 0; call < 3; call++) {
      const output = await runToolContract(oecdQueryDataset, input);
      expect(output.isError).toBeUndefined();
      expect(output.structuredContent).toMatchObject({ row_count: 3 });
      expect(output.structuredContent).not.toHaveProperty('canvas_id');
      expect(output.structuredContent).not.toHaveProperty('notice');
      expect(canvas.countForTenant(ctx)).toBe(0);
    }
    await canvas.acquire(undefined, ctx);
    await canvas.acquire(undefined, ctx);
    const output = await runToolContract(oecdQueryDataset, input);
    expect(output.isError).toBeUndefined();
    expect(canvas.countForTenant(ctx)).toBe(2);
  });

  it('still rejects malformed, unknown and expired explicit IDs for inline rows', async () => {
    const malformed = await runToolContract(oecdQueryDataset, { ...input, canvas_id: 'x' });
    expect(malformed.isError).toBe(true);
    expect(textOf(malformed)).toContain('canvas_id');
    const unknown = await runToolContract(oecdQueryDataset, { ...input, canvas_id: 'unknown001' });
    expect(unknown.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_not_found' } },
    });
    const existing = await canvas.acquire(undefined, ctx);
    now += DEFAULT_CANVAS_REGISTRY_OPTIONS.ttlMs + 1;
    const expired = await runToolContract(oecdQueryDataset, {
      ...input,
      canvas_id: existing.canvasId,
    });
    expect(expired.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_not_found' } },
    });
  });

  it.each([
    [99_922, false],
    [99_923, true],
  ] as const)(
    'applies the exact preview boundary to a label of %i characters',
    async (labelChars, spills) => {
      http.reset();
      http.route({
        match: /^https:\/\/fake.oecd.test\/data\//,
        respond: () =>
          Response.json({
            data: {
              dataSets: [{ observations: { '0:0': [7] } }],
              structures: [
                {
                  dimensions: {
                    observation: [
                      { id: 'REF_AREA', values: [{ id: 'USA', name: 'x'.repeat(labelChars) }] },
                      { id: 'TIME_PERIOD', values: [{ id: '2020' }] },
                    ],
                  },
                },
              ],
            },
          }),
      });
      const output = await runToolContract(oecdQueryDataset, input);
      expect(output.isError).toBeUndefined();
      expect(output.structuredContent).toMatchObject({
        row_count: 1,
        rows: spills ? [] : [expect.objectContaining({ value: 7 })],
      });
      if (spills) expect(output.structuredContent).toHaveProperty('truncated', true);
      else expect(output.structuredContent).not.toHaveProperty('truncated');
      expect(canvas.countForTenant(ctx)).toBe(spills ? 1 : 0);
    },
  );

  it('retains a successful spill and gives one describe-before-query notice on both surfaces', async () => {
    respond(true);
    const output = await runToolContract(oecdQueryDataset, input);
    expect(output.isError).toBeUndefined();
    const result = output.structuredContent as {
      canvas_id: string;
      table_name: string;
      notice: string;
      rows: unknown[];
    };
    expect(result.rows).toEqual([]);
    expect(canvas.countForTenant(ctx)).toBe(1);
    expect(result.notice).toBe(
      `The full result is in table "${result.table_name}" on canvas "${result.canvas_id}". Call oecd_dataframe_describe with this canvas_id to inspect columns, then oecd_dataframe_query with this canvas_id and SQL to query the full table.`,
    );
    const text = textOf(output);
    expect(text.split(result.notice), text).toHaveLength(2);
    expect(text.match(/oecd_dataframe_describe/g)).toHaveLength(1);
    expect(text.match(/oecd_dataframe_query/g)).toHaveLength(1);
    expect(text).toContain('Truncated — showing the first 0 of 3 rows');
    const described = await runToolContract(oecdDataframeDescribe, { canvas_id: result.canvas_id });
    expect(described.structuredContent).toMatchObject({
      table_count: 1,
      tables: [{ name: result.table_name, row_count: 3 }],
    });
    expect(textOf(described)).toContain('TIME_PERIOD');
    const queried = await runToolContract(oecdDataframeQuery, {
      canvas_id: result.canvas_id,
      sql: `SELECT value FROM "${result.table_name}" ORDER BY value`,
    });
    expect(queried.structuredContent).toMatchObject({
      rows: [{ value: 7 }, { value: 8 }, { value: 9 }],
      row_count: 3,
    });
    expect(textOf(queried)).toContain('3 rows');
    const page = await runToolContract(oecdDataframeQuery, {
      canvas_id: result.canvas_id,
      sql: `SELECT value FROM "${result.table_name}" ORDER BY value LIMIT 2 OFFSET 1`,
    });
    expect(page.structuredContent).toMatchObject({
      rows: [{ value: 8 }, { value: 9 }],
      row_count: 2,
    });
    const pastEnd = await runToolContract(oecdDataframeQuery, {
      canvas_id: result.canvas_id,
      sql: `SELECT value FROM "${result.table_name}" LIMIT 2 OFFSET 3`,
    });
    expect(pastEnd.structuredContent).toMatchObject({ rows: [], row_count: 0 });
  });

  it.each([false, true])('cleans failed staging with caller ownership %s', async (owned) => {
    const existing = owned ? await canvas.acquire(undefined, ctx) : undefined;
    if (existing)
      await existing.registerTable('keep', [{ value: 17 }], {
        schema: [{ name: 'value', type: 'DOUBLE' }],
      });
    const original = provider.registerTable.bind(provider);
    const failure = new Error('Deliberate failure after registration');
    vi.spyOn(provider, 'registerTable').mockImplementation(async (...args) => {
      await original(...args);
      throw failure;
    });
    respond(true);
    await expect(
      oecdQueryDataset.handler({ ...input, canvas_id: existing?.canvasId }, ctx),
    ).rejects.toBe(failure);
    expect(canvas.countForTenant(ctx)).toBe(owned ? 1 : 0);
    if (existing) {
      expect((await existing.query('SELECT value FROM keep')).rows).toEqual([{ value: 17 }]);
      expect((await existing.describe()).map((table) => table.name)).toEqual(['keep']);
    }
  });

  it('preserves the staging error if releasing the newly minted canvas fails', async () => {
    const failure = new Error('Deliberate staging failure');
    vi.spyOn(provider, 'registerTable').mockRejectedValue(failure);
    vi.spyOn(canvas, 'drop').mockRejectedValue(new Error('Deliberate cleanup failure'));
    respond(true);
    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toBe(failure);
  });
});
