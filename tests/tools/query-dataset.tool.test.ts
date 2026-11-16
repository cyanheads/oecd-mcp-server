/**
 * @fileoverview Tests for oecd_query_dataset — attribute columns and unit
 * scaling, content[]/structuredContent parity, the inline preview bound, the
 * typed error contract, and the DataCanvas staging path.
 * @module tests/tools/query-dataset.tool.test
 */

import type { ColumnSchema, RegisterTableOptions } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { oecdQueryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { initDataService } from '@/services/oecd-data/oecd-data-service.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { type BodyStub, type StubAnswer, startBodyStub } from '../helpers/body-stub.js';
import { declaredRecovery, toolWireError, toolWireFailure } from '../helpers/error-contract.js';
import { noResultsFound } from '../helpers/oecd-response.js';
import {
  installScriptedFetch,
  observe,
  PROXY_PAGE,
  runUntil,
  type ScriptedAnswer,
  type ScriptedFetch,
  STALL,
} from '../helpers/scripted-fetch.js';

const FAKE_BASE = 'https://fake.oecd.test';
const FLOW_REF = 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I';
const DATA_URL = new RegExp(`^${FAKE_BASE}/data/`);

/**
 * Declared components mirror the live `DSD_NAAG@DF_NAAG_I` shape: `MATURITY`
 * is declared but never populated, `REF_YEAR_PRICE` is uncoded and sparse, and
 * `UNIT_MULT` differs between the two observations.
 */
const STRUCTURE = {
  dimensions: {
    observation: [
      { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
      { id: 'REF_AREA', values: [{ id: 'USA', name: 'United States' }] },
      {
        id: 'TIME_PERIOD',
        values: Array.from({ length: 40 }, (_, i) => ({
          id: String(1983 + i),
          name: String(1983 + i),
        })),
      },
    ],
  },
  attributes: {
    observation: [
      { id: 'OBS_STATUS', values: [{ id: 'A', name: 'Normal value' }] },
      { id: 'MATURITY', values: [] },
      { id: 'REF_YEAR_PRICE', values: [{ value: '2020' }] },
      {
        id: 'UNIT_MULT',
        values: [
          { id: '0', name: 'Units' },
          { id: '9', name: 'Billions' },
        ],
      },
    ],
  },
};

/** Two observations: a GDP figure in billions and a per-capita figure in units. */
const DATA_RESPONSE = {
  data: {
    dataSets: [
      {
        observations: {
          '0:0:39': [26054.614, 0, null, null, 1],
          '0:0:38': [77926.1671900703, 0, null, 0, 0],
        },
      },
    ],
    structures: [STRUCTURE],
  },
};

/**
 * `count` observations, one per period, all unscaled. `REF_YEAR_PRICE`
 * resolves on the last row only — a header taken from the first row would
 * decide the column does not exist.
 */
function seriesResponse(count: number): unknown {
  const observations: Record<string, Array<unknown>> = {};
  for (let i = 0; i < count; i++) {
    observations[`0:0:${i}`] = [1000 + i, 0, null, i === count - 1 ? 0 : null, 0];
  }
  const periods = Array.from({ length: count }, (_, i) => ({
    id: String(1983 + i),
    name: String(1983 + i),
  }));
  const [freq, refArea] = STRUCTURE.dimensions.observation;
  const structure = {
    ...STRUCTURE,
    dimensions: { observation: [freq, refArea, { id: 'TIME_PERIOD', values: periods }] },
  };
  return { data: { dataSets: [{ observations }], structures: [structure] } };
}

/**
 * Rows in a {@link seriesResponse} large enough to cross the preview budget.
 * Every component but `TIME_PERIOD` and the last row's `REF_YEAR_PRICE` is
 * constant, so a row comes back as about 50 characters and roughly 1,950 of
 * them fit.
 */
const SPILL_ROWS = 4000;

const EMPTY_DATA_RESPONSE = {
  data: { dataSets: [{ observations: {} }], structures: [STRUCTURE] },
};

const http = createFetchMock();

function respond(body: unknown, init?: ResponseInit): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  http.route({ match: DATA_URL, respond: () => new Response(payload, init) });
}

function textOf(blocks: unknown): string {
  return (blocks as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
}

/** Header of the rendered constants table, which sits above the observation table. */
const CONSTANTS_HEADER = '| component | code | label |';

/** Each rendered markdown table, as the cells of its lines — header first, divider dropped. */
function renderedTables(text: string): string[][][] {
  const tables: string[][][] = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) {
      open = false;
      continue;
    }
    if (!open) tables.push([]);
    open = true;
    if (!line.startsWith('| ---')) tables.at(-1)?.push(line.slice(2, -2).split(' | '));
  }
  return tables;
}

/** The rendered observation table — the one below the constants table — as header and cell rows. */
function observationTable(text: string): { cells: string[][]; header: string[] } {
  const table = renderedTables(text).find((t) => `| ${t[0]?.join(' | ')} |` !== CONSTANTS_HEADER);
  const [header = [], ...cells] = table ?? [];
  return { cells, header };
}

/** Data rows in the rendered observation table — the constants table, header, and divider excluded. */
function tableRowCount(text: string): number {
  return observationTable(text).cells.length;
}

/** A canvas that records what it staged and reports the row count back. */
function recordingCanvas(canvasId: string): {
  acquire: () => Promise<unknown>;
} {
  const instance = {
    canvasId,
    registerTable: async (
      name: string,
      rows: AsyncIterable<unknown> | Iterable<unknown>,
      options?: RegisterTableOptions,
    ) => {
      let rowCount = 0;
      for await (const _row of rows) rowCount += 1;
      return { tableName: name, rowCount, columns: (options?.schema ?? []).map((c) => c.name) };
    },
    drop: async () => true,
  };
  return { acquire: async () => instance };
}

describe('oecdQueryDataset', () => {
  beforeEach(() => {
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initDataService();
    initStructureService();
    setCanvas(undefined);
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
    setCanvas(undefined);
  });

  // ── Rows, attributes, scaling ───────────────────────────────────────────────

  it('returns inline rows when result fits and no canvas is configured', async () => {
    respond(DATA_RESPONSE);

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({
      flow_ref: FLOW_REF,
      key: 'A.USA..',
      start_period: '2021',
      end_period: '2022',
    });
    const result = await oecdQueryDataset.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
    expect(result.canvas_id).toBeUndefined();
    expect(result.query_flow_ref).toBe(FLOW_REF);
    expect(result.query_key).toBe('A.USA..');
    expect(result.query_start_period).toBe('2021');
    expect(result.query_end_period).toBe('2022');
    // FREQ holds one value on every row, so it is stated once rather than per row.
    expect(result.rows[0]).not.toHaveProperty('FREQ');
    expect(result.constant_columns.FREQ).toEqual({ code: 'A', label: 'Annual' });
  });

  it('scales an observation carrying UNIT_MULT = Billions and keeps the multiplier visible', async () => {
    respond(DATA_RESPONSE);

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.USA..' });
    const result = await oecdQueryDataset.handler(input, ctx);
    const gdp = result.rows.find((r) => r.UNIT_MULT === 'Billions');

    expect(gdp?.value).toBe(26_054_614_000_000);
    expect(gdp?.value_scale).toBe(1_000_000_000);
    expect(result.rows.find((r) => r.UNIT_MULT === 'Units')?.value).toBe(77926.1671900703);
  });

  it('carries observation attributes onto every surface', async () => {
    respond(DATA_RESPONSE);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);

    expect(output.isError).toBeFalsy();
    expect(text).toContain('UNIT_MULT');
    expect(text).toContain('Billions');
    expect(text).toContain('OBS_STATUS');
    expect(text).toContain('26054614000000');
    expect(text).toContain('divide `value` by `value_scale`');
  });

  it('renders a sparse attribute column that only some rows carry', async () => {
    respond(seriesResponse(3));

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);

    expect(text).toContain('REF_YEAR_PRICE');
    expect(text).toContain('2020');
  });

  // ── content[] / structuredContent parity ────────────────────────────────────

  it('carries every dimension and attribute key into structuredContent', async () => {
    respond(DATA_RESPONSE);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const structured = output.structuredContent as {
      constant_columns: Record<string, unknown>;
      rows: Record<string, unknown>[];
    };

    // Dimension keys are per-dataflow and cannot be declared, so the row schema
    // is deliberately open. Output validation runs against it before
    // structuredContent is built: a closed row object would strip every one of
    // these and leave the caller with `value` alone.
    expect(structured.rows.find((r) => r.TIME_PERIOD === '2022')).toEqual({
      TIME_PERIOD: '2022',
      UNIT_MULT: 'Billions',
      UNIT_MULT_code: '9',
      value: 26_054_614_000_000,
      value_scale: 1_000_000_000,
    });
    // The record schema keeps every component that holds one value across the result.
    expect(structured.constant_columns).toEqual({
      FREQ: { code: 'A', label: 'Annual' },
      REF_AREA: { code: 'USA', label: 'United States' },
      OBS_STATUS: { code: 'A', label: 'Normal value' },
    });
    // The same keys reach the other surface, as table columns and constant rows.
    const text = textOf(output.content);
    for (const key of [
      'FREQ',
      'OBS_STATUS',
      'REF_AREA',
      'TIME_PERIOD',
      'UNIT_MULT',
      'UNIT_MULT_code',
    ]) {
      expect(text).toContain(key);
    }
  });

  it('accepts a dimension name the schema has never seen', () => {
    const parsed = oecdQueryDataset.output.parse({
      rows: [
        {
          ACTIVITY: 'Manufacturing',
          ACTIVITY_code: 'C',
          SOME_FUTURE_DIM: 'x',
          value: 1,
          value_scale: 1,
        },
      ],
      row_count: 1,
      constant_columns: { SOME_FUTURE_ATTR: { code: 'Y', label: 'y' } },
      query_flow_ref: FLOW_REF,
      query_key: 'A.USA..',
      source: 'OECD',
    });

    expect(Object.keys(parsed.rows[0] ?? {})).toEqual([
      'ACTIVITY',
      'ACTIVITY_code',
      'SOME_FUTURE_DIM',
      'value',
      'value_scale',
    ]);
    expect(parsed.constant_columns).toEqual({ SOME_FUTURE_ATTR: { code: 'Y', label: 'y' } });
  });

  it('renders every inline row in content[], not a 10-row sample', async () => {
    respond(seriesResponse(40));

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);
    const structured = output.structuredContent as { rows: unknown[] };

    expect(structured.rows).toHaveLength(40);
    for (let i = 0; i < 40; i++) {
      expect(text).toContain(String(1000 + i));
    }
    expect(text).toContain('Not truncated — all 40 rows');
    expect(text).not.toContain('inline preview rows');
  });

  // ── Inline preview bound (no canvas) ────────────────────────────────────────

  it('bounds the rendered table on a large result with no canvas, keeping every row structured', async () => {
    respond(seriesResponse(SPILL_ROWS));

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);
    const structured = output.structuredContent as {
      canvas_id?: string;
      content_table_capped?: boolean;
      content_table_rows?: number;
      row_count: number;
      rows: unknown[];
      truncated?: boolean;
    };
    const rendered = tableRowCount(text);

    // Every row survives in structuredContent — nothing was dropped from the result.
    expect(structured.row_count).toBe(SPILL_ROWS);
    expect(structured.rows).toHaveLength(SPILL_ROWS);
    // The rendered table stops short of it.
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(SPILL_ROWS);
    expect(text.length).toBeLessThan(JSON.stringify(structured.rows).length);

    // Disclosed as a display cap, not as a canvas spill.
    expect(structured.content_table_capped).toBe(true);
    expect(structured.content_table_rows).toBe(rendered);
    expect(structured.truncated).toBeUndefined();
    expect(structured.canvas_id).toBeUndefined();
  });

  it('names a reachable retrieval path in the capped-table note', async () => {
    respond(seriesResponse(SPILL_ROWS));

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);

    expect(text).toContain('Truncated for display');
    expect(text).toContain(`of ${SPILL_ROWS} rows`);
    // Where the omitted rows already are.
    expect(text).toContain('structuredContent.rows');
    // How to make the result itself smaller.
    expect(text).toContain('start_period');
    expect(text).toContain('end_period');
    // How to reach the whole set as a queryable table instead.
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(text).toContain('oecd_dataframe_query');
  });

  it('leaves the rendered table whole when the result fits the preview budget', async () => {
    respond(seriesResponse(40));

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.USA..' });
    await oecdQueryDataset.handler(input, ctx);

    expect(getEnrichment(ctx)).toEqual({});
  });

  it('spills instead of capping when a canvas is configured, and says so differently', async () => {
    respond(seriesResponse(SPILL_ROWS));
    setCanvas(recordingCanvas('canvas-003') as never);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);
    const structured = output.structuredContent as {
      canvas_id?: string;
      content_table_capped?: boolean;
      row_count: number;
      rows: unknown[];
      truncated?: boolean;
    };

    expect(structured.truncated).toBe(true);
    expect(structured.canvas_id).toBe('canvas-003');
    expect(structured.rows.length).toBeLessThan(SPILL_ROWS);
    // The canvas holds the remainder, so the display cap never engages.
    expect(structured.content_table_capped).toBeUndefined();
    expect(text).toContain('The rest is on DataCanvas');
    expect(text).not.toContain('Truncated for display');
  });

  it('previews the same number of rows with a canvas and without one', async () => {
    respond(seriesResponse(SPILL_ROWS));
    const withoutCanvas = await runToolContract(oecdQueryDataset, {
      flow_ref: FLOW_REF,
      key: 'A.USA..',
    });

    http.reset();
    respond(seriesResponse(SPILL_ROWS));
    setCanvas(recordingCanvas('canvas-004') as never);
    const withCanvas = await runToolContract(oecdQueryDataset, {
      flow_ref: FLOW_REF,
      key: 'A.USA..',
    });

    const spilled = (withCanvas.structuredContent as { rows: unknown[] }).rows.length;
    expect(
      (withoutCanvas.structuredContent as { content_table_rows?: number }).content_table_rows,
    ).toBe(spilled);
    expect(tableRowCount(textOf(withoutCanvas.content))).toBe(
      tableRowCount(textOf(withCanvas.content)),
    );
  });

  // ── Constant columns ────────────────────────────────────────────────────────

  /**
   * Shaped like the G7 quarterly growth query: two countries over two quarters,
   * in upstream order, with `REF_AREA` declaring a value no observation uses
   * and `OBS_STATUS` turning provisional on the latest quarter.
   */
  const QUARTERLY_RESPONSE = {
    data: {
      dataSets: [
        {
          observations: {
            '0:0:2:1': [0.4, 0, 0, 1],
            '0:0:1:0': [0.1, 0, 0, 0],
            '0:0:2:0': [0.3, 0, 0, 0],
            '0:0:1:1': [0.2, 0, 0, 1],
          },
        },
      ],
      structures: [
        {
          dimensions: {
            observation: [
              { id: 'FREQ', values: [{ id: 'Q', name: 'Quarterly' }] },
              { id: 'ADJUSTMENT', values: [{ id: 'Y', name: 'Calendar and seasonally adjusted' }] },
              {
                id: 'REF_AREA',
                values: [
                  { id: 'USA', name: 'United States' },
                  { id: 'CAN', name: 'Canada' },
                  { id: 'DEU', name: 'Germany' },
                ],
              },
              {
                id: 'TIME_PERIOD',
                values: [
                  { id: '2025-Q1', name: '2025-Q1' },
                  { id: '2025-Q2', name: '2025-Q2' },
                ],
              },
            ],
          },
          attributes: {
            observation: [
              { id: 'DECIMALS', values: [{ id: '1', name: 'One' }] },
              { id: 'UNIT_MULT', values: [{ id: '0', name: 'Units' }] },
              {
                id: 'OBS_STATUS',
                values: [
                  { id: 'A', name: 'Normal value' },
                  { id: 'P', name: 'Provisional value' },
                ],
              },
            ],
          },
        },
      ],
    },
  };

  it('hoists what every row shares and keeps what varies, with codes, in sorted order', async () => {
    respond(QUARTERLY_RESPONSE);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'Q.Y..' });
    const structured = output.structuredContent as {
      constant_columns: Record<string, { code: string; label: string }>;
      rows: Record<string, unknown>[];
      source: string;
    };

    expect(structured.constant_columns).toEqual({
      FREQ: { code: 'Q', label: 'Quarterly' },
      ADJUSTMENT: { code: 'Y', label: 'Calendar and seasonally adjusted' },
      DECIMALS: { code: '1', label: 'One' },
      UNIT_MULT: { code: '0', label: 'Units' },
    });
    // Structure order: dimensions in key order, then attributes.
    expect(Object.keys(structured.constant_columns)).toEqual([
      'FREQ',
      'ADJUSTMENT',
      'DECIMALS',
      'UNIT_MULT',
    ]);
    const provisional = { OBS_STATUS: 'Provisional value', OBS_STATUS_code: 'P' };
    const normal = { OBS_STATUS: 'Normal value', OBS_STATUS_code: 'A' };
    const canada = { REF_AREA: 'Canada', REF_AREA_code: 'CAN' };
    const germany = { REF_AREA: 'Germany', REF_AREA_code: 'DEU' };
    expect(structured.rows).toEqual([
      { ...canada, ...normal, TIME_PERIOD: '2025-Q1', value: 0.1, value_scale: 1 },
      { ...canada, ...provisional, TIME_PERIOD: '2025-Q2', value: 0.2, value_scale: 1 },
      { ...germany, ...normal, TIME_PERIOD: '2025-Q1', value: 0.3, value_scale: 1 },
      { ...germany, ...provisional, TIME_PERIOD: '2025-Q2', value: 0.4, value_scale: 1 },
    ]);
    expect(structured.source).toBe('OECD');
  });

  it('renders every constant and every cell of every structured row in content[]', async () => {
    respond(QUARTERLY_RESPONSE);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'Q.Y..' });
    const structured = output.structuredContent as {
      constant_columns: Record<string, { code: string; label: string }>;
      rows: Record<string, unknown>[];
    };
    const text = textOf(output.content);
    const [constants] = renderedTables(text);
    const { cells, header } = observationTable(text);

    expect(constants).toEqual([
      ['component', 'code', 'label'],
      ...Object.entries(structured.constant_columns).map(([id, c]) => [id, c.code, c.label]),
    ]);
    expect(cells).toEqual(
      structured.rows.map((row) => header.map((key) => String(row[key] ?? ''))),
    );
    expect(header.sort()).toEqual(
      [...new Set(structured.rows.flatMap((row) => Object.keys(row)))].sort(),
    );
  });

  it('hoists every component of a one-row result, leaving value and value_scale', async () => {
    respond({
      data: {
        dataSets: [{ observations: { '0:0:38': [77926.1671900703, 0, null, 0, 0] } }],
        structures: [STRUCTURE],
      },
    });

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const structured = output.structuredContent as {
      constant_columns: Record<string, unknown>;
      rows: Record<string, unknown>[];
    };

    expect(structured.rows).toEqual([{ value: 77926.1671900703, value_scale: 1 }]);
    // TIME_PERIOD and the uncoded REF_YEAR_PRICE are their own code.
    expect(structured.constant_columns).toEqual({
      FREQ: { code: 'A', label: 'Annual' },
      REF_AREA: { code: 'USA', label: 'United States' },
      TIME_PERIOD: { code: '2021', label: '2021' },
      OBS_STATUS: { code: 'A', label: 'Normal value' },
      REF_YEAR_PRICE: { code: '2020', label: '2020' },
      UNIT_MULT: { code: '0', label: 'Units' },
    });
    expect(tableRowCount(textOf(output.content))).toBe(1);
  });

  it('keeps on the rows a component carrying one label under two codes', async () => {
    respond({
      data: {
        dataSets: [{ observations: { '0:0:0': [1], '0:1:0': [2] } }],
        structures: [
          {
            dimensions: {
              observation: [
                { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
                {
                  id: 'REF_AREA',
                  values: [
                    { id: 'BRA_AM', name: 'Amazonas' },
                    { id: 'PER_AMA', name: 'Amazonas' },
                  ],
                },
                { id: 'TIME_PERIOD', values: [{ id: '2020', name: '2020' }] },
              ],
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A..' });
    const result = await oecdQueryDataset.handler(input, ctx);

    expect(result.constant_columns).not.toHaveProperty('REF_AREA');
    expect(result.rows.map((r) => r.REF_AREA_code)).toEqual(['BRA_AM', 'PER_AMA']);
    expect(result.rows.map((r) => r.REF_AREA)).toEqual(['Amazonas', 'Amazonas']);
  });

  it('keeps on the rows a component that some rows lack', async () => {
    respond(seriesResponse(3));

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.USA..' });
    const result = await oecdQueryDataset.handler(input, ctx);

    expect(result.constant_columns).not.toHaveProperty('REF_YEAR_PRICE');
    expect(result.rows.map((r) => r.REF_YEAR_PRICE)).toEqual([undefined, undefined, '2020']);
  });

  it('keeps a column on the preview rows when it varies only past the preview', async () => {
    const response = structuredClone(seriesResponse(SPILL_ROWS)) as {
      data: {
        dataSets: Array<{ observations: Record<string, unknown[]> }>;
        structures: Array<{
          attributes: { observation: Array<{ values: Array<Record<string, string>> }> };
        }>;
      };
    };
    const [structure] = response.data.structures;
    structure?.attributes.observation[0]?.values.push({ id: 'P', name: 'Provisional value' });
    // The latest period, which sorts last: far past the preview.
    const latest = response.data.dataSets[0]?.observations[`0:0:${SPILL_ROWS - 1}`];
    if (latest) latest[1] = 1;
    respond(response);
    setCanvas(recordingCanvas('canvas-005') as never);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const structured = output.structuredContent as {
      constant_columns: Record<string, unknown>;
      rows: Record<string, unknown>[];
      truncated?: boolean;
    };

    expect(structured.truncated).toBe(true);
    expect(structured.rows.length).toBeGreaterThan(0);
    expect(structured.rows.length).toBeLessThan(SPILL_ROWS - 1);
    // Every preview row says Normal value, yet the result as a whole does not.
    expect(structured.constant_columns).not.toHaveProperty('OBS_STATUS');
    for (const row of structured.rows) {
      expect(row).toMatchObject({ OBS_STATUS: 'Normal value', OBS_STATUS_code: 'A' });
    }
  });

  it('charges the constants to the preview budget when there is no canvas', async () => {
    respond({
      data: {
        dataSets: [{ observations: { '0:0:0': [7], '0:0:1': [8], '0:0:2': [9] } }],
        structures: [
          {
            dimensions: {
              observation: [
                { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
                { id: 'REF_AREA', values: [{ id: 'USA', name: 'x'.repeat(110_000) }] },
                {
                  id: 'TIME_PERIOD',
                  values: [{ id: '2020' }, { id: '2021' }, { id: '2022' }],
                },
              ],
            },
          },
        ],
      },
    });

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const structured = output.structuredContent as {
      constant_columns: Record<string, { label: string }>;
      content_table_capped?: boolean;
      content_table_rows?: number;
      rows: unknown[];
    };

    // The constants alone outrun the budget: no row fits beside them.
    expect(structured.rows).toHaveLength(3);
    expect(structured.content_table_capped).toBe(true);
    expect(structured.content_table_rows).toBe(0);
    expect(structured.constant_columns.REF_AREA?.label).toHaveLength(110_000);
    const text = textOf(output.content);
    expect(tableRowCount(text)).toBe(0);
    expect(text).toContain('x'.repeat(110_000));
  });

  // ── Error contract ──────────────────────────────────────────────────────────

  it.each([
    [
      'Not enough key values in query, expecting 5 got 3',
      'invalid_key',
      'oecd_get_dataset_info',
      'expecting 5 got 3',
    ],
    [
      'Semantic Error - Invalid Date Format `last year`',
      'invalid_period',
      'ISO code',
      'Invalid Date Format \\`last year\\`',
    ],
  ])(
    'dispatches a recognized HTTP 403 rejection to %s',
    async (body, reason, recovery, visibleDetail) => {
      respond(body, { status: 403 });
      const output = await runToolContract(oecdQueryDataset, {
        flow_ref: FLOW_REF,
        key: 'A.USA..',
      });
      expect(output.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: expect.stringContaining(recovery) } },
        },
      });
      const text = textOf(output.content);
      expect(text).toContain(visibleDetail);
      expect(text).toContain(recovery);
      expect(text).toContain(`reason ${reason}`);
      expect(http.calls).toHaveLength(1);
    },
  );

  it('throws ctx.fail(invalid_flow_ref) for malformed flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: 'BAD', key: '.' });
    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_flow_ref' },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when API returns 404 dataflow error', async () => {
    respond('Could not find Dataflow and/or DSD related with this data request', { status: 404 });

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_MISSING@DF_MISSING',
      key: '.',
    });
    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(no_results) when observations are empty', async () => {
    respond(EMPTY_DATA_RESPONSE);
    // The diagnosis finds no datastructure to read availability against (tabled below).
    http.route({ match: new RegExp(`^${FAKE_BASE}/dataflow/`), respond: () => noResultsFound() });

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.ZZZ..' });
    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
      message: `No observations found for key "A.ZZZ.." in ${FLOW_REF}`,
    });
  });

  it('maps a 422 key-arity rejection to invalid_key and repeats what OECD said', async () => {
    respond('Not enough key values in query, expecting 13 got 12', { status: 422 });

    const output = await runToolContract(oecdQueryDataset, {
      flow_ref: FLOW_REF,
      key: 'A.USA..',
    });
    const error = (
      output.structuredContent as { error: { code: number; data?: { reason?: string } } }
    ).error;

    expect(output.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_key');
    expect(textOf(output.content)).toContain('expecting 13 got 12');
    expect(textOf(output.content)).toContain('oecd_get_dataset_info');
    expect(textOf(output.content)).toContain(
      'OECD rejected the dimension key "A.USA..": Not enough key values in query, expecting 13 got 12',
    );
  });

  it.each(['A/../etc', 'A USA', 'A.USA?x=1', 'A.USA#'])(
    'rejects the key %j as invalid_key before any request, without saying OECD answered',
    async (key) => {
      const error = await toolWireError(oecdQueryDataset, { flow_ref: FLOW_REF, key });

      expect(http.calls).toHaveLength(0);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_key',
          recovery: { hint: declaredRecovery(oecdQueryDataset, 'invalid_key') },
        },
        message: `Key "${key}" holds a character outside the SDMX key set — letters, digits, ".", "+", "_", "-", and "%"`,
      });
    },
  );

  it('maps a 422 period rejection to invalid_period', async () => {
    respond('Semantic Error - Invalid Date Format `not-a-date`', { status: 422 });

    const output = await runToolContract(oecdQueryDataset, {
      flow_ref: FLOW_REF,
      key: 'A.USA..',
      start_period: 'not-a-date',
    });
    const error = (
      output.structuredContent as { error: { code: number; data?: { reason?: string } } }
    ).error;

    expect(error.data?.reason).toBe('invalid_period');
    expect(textOf(output.content)).toContain('Invalid Date Format');
  });

  // ── Transient upstream failures ─────────────────────────────────────────────

  /** Reason and recovery hint a caller sees on a failed call. */
  function failureOf(output: Awaited<ReturnType<typeof runToolContract>>): {
    code: number;
    hint: string;
    reason: string;
  } {
    const error = (
      output.structuredContent as {
        error: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
      }
    ).error;
    return {
      code: error.code,
      hint: error.data?.recovery?.hint ?? '',
      reason: error.data?.reason ?? '',
    };
  }

  it('maps an exhausted request-rate throttle to rate_limited with a wait-it-out recovery', async () => {
    respond('You have exceeded the number of requests currently permitted in the OECD Data API.', {
      status: 429,
    });

    const output = await runToolContract(oecdQueryDataset, {
      flow_ref: FLOW_REF,
      key: 'A.USA..',
    });
    const failure = failureOf(output);

    expect(output.isError).toBe(true);
    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.reason).toBe('rate_limited');
    expect(failure.hint).toContain('Wait several seconds');
    expect(textOf(output.content)).toContain('exceeded the number of requests');
  }, 15_000);

  it('maps a download-size throttle to download_limit with a shrink-the-query recovery', async () => {
    respond(
      'You have exceeded the number of requests for data downloads or very large data ranges permitted in the OECD Data API.',
      // A wait longer than the retry budget fails fast rather than burning attempts.
      { headers: { 'Retry-After': '120' }, status: 429 },
    );

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: '' });
    const failure = failureOf(output);

    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.reason).toBe('download_limit');
    expect(failure.hint).toContain('fewer values per key segment');
    // Waiting is the wrong advice for this one.
    expect(failure.hint).not.toContain('Wait several seconds');
  });

  /**
   * Two throttles share the `RateLimited` code and differ only in whether
   * waiting clears them. `structuredContent` has carried `retryable` all along;
   * the text surface carries it too, so a client reading only `content[]` can
   * tell them apart without parsing the recovery prose.
   */
  it('renders reason and retryability into content[], not just structuredContent', async () => {
    respond(
      'You have exceeded the number of requests for data downloads or very large data ranges permitted in the OECD Data API.',
      { headers: { 'Retry-After': '120' }, status: 429 },
    );

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: '' });
    const structured = output.structuredContent as {
      error: { data?: { reason?: string; retryable?: boolean } };
    };

    expect(structured.error.data).toMatchObject({ reason: 'download_limit', retryable: false });
    expect(textOf(output.content)).toContain('(reason download_limit · not retryable)');
  });

  it('marks a wait-it-out throttle retryable on the same surface', async () => {
    respond('You have exceeded the number of requests currently permitted in the OECD Data API.', {
      status: 429,
    });

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });

    expect(textOf(output.content)).toContain('(reason rate_limited · retryable)');
  }, 15_000);

  it('maps an upstream timeout to upstream_timeout naming both ways out', async () => {
    respond('Gateway Timeout', { status: 504 });

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const failure = failureOf(output);

    expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
    expect(failure.reason).toBe('upstream_timeout');
    expect(failure.hint).toContain('smaller key or period slices');
    expect(failure.hint).toContain('OECD_TIMEOUT_MS');
  }, 15_000);

  it('maps an exhausted 503 to upstream_unavailable', async () => {
    respond('Service Unavailable', { status: 503 });

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const failure = failureOf(output);

    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.reason).toBe('upstream_unavailable');
    expect(failure.hint).toContain('Retry after a short pause');
  }, 15_000);

  /**
   * A body that starts arriving and then fails, over a real loopback socket, so
   * the failure arrives in the shape Bun's or Node's own network stack gives it.
   * The classification itself is tabled at the service; these prove the tool
   * carries it to the declared reason.
   */
  describe('a response body that does not arrive whole', () => {
    let answer: StubAnswer;
    let stub: BodyStub;
    let configured: { baseUrl: string; timeoutMs: number };

    beforeEach(async () => {
      http.restore();
      stub = await startBodyStub(() => answer);
      const config = getServerConfig();
      configured = { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
      Object.assign(config, { baseUrl: stub.origin, timeoutMs: 300 });
      initDataService();
    });

    afterEach(async () => {
      Object.assign(getServerConfig(), configured);
      await stub.close();
    });

    it('maps a body that outlasts the deadline to upstream_timeout after one request', async () => {
      answer = { kind: 'stalled-body' };

      const output = await runToolContract(oecdQueryDataset, {
        flow_ref: FLOW_REF,
        key: 'A.USA..',
      });
      const hint = declaredRecovery(oecdQueryDataset, 'upstream_timeout');

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.bodyStarted).toBe(true);
      expect(output.isError).toBe(true);
      expect((output.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', recovery: { hint }, retryable: true },
      });
      expect(textOf(output.content)).toContain(hint);
      expect(textOf(output.content)).toContain('(reason upstream_timeout · retryable)');
    });

    it('maps a connection dropped mid-body to upstream_unavailable once the retries run out', async () => {
      answer = { kind: 'dropped-body' };

      const output = await runToolContract(oecdQueryDataset, {
        flow_ref: FLOW_REF,
        key: 'A.USA..',
      });
      const hint = declaredRecovery(oecdQueryDataset, 'upstream_unavailable');

      expect(stub.requests).toHaveLength(3);
      expect((output.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', recovery: { hint } },
      });
      expect(textOf(output.content)).toContain(hint);
    }, 15_000);
  });

  it('names a status it does not model upstream_error rather than passing the code bare', async () => {
    respond('Forbidden', { status: 403 });

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const failure = failureOf(output);

    // Not upstream_redirect: that reason is a refused 3xx, and blaming
    // OECD_BASE_URL for handing the request onward would be the wrong advice.
    expect(failure.reason).toBe('upstream_error');
    expect(failure.hint).toBe(declaredRecovery(oecdQueryDataset, 'upstream_error'));
    // The status and OECD's text, which that hint asks the caller to report.
    expect(textOf(output.content)).toContain('OECD answered HTTP 403: Forbidden');
  });

  it('reports a redirect from the configured host as a misconfiguration, not an outage', async () => {
    respond('', { status: 302, headers: { Location: 'https://elsewhere.test/pwned' } });

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.USA..' });

    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'upstream_redirect', retryable: false },
    });
    // The sentence the fetch boundary wrote survives the service's relabel.
    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toThrow(/OECD_BASE_URL/);
  });

  // ── Canvas staging path ─────────────────────────────────────────────────────

  it('declares sparse attribute columns on the spilled canvas table', async () => {
    respond(seriesResponse(SPILL_ROWS));

    let registered: RegisterTableOptions | undefined;
    const staged: Record<string, unknown>[] = [];
    const instance = {
      canvasId: 'canvas-001',
      registerTable: async (
        name: string,
        rows: AsyncIterable<unknown> | Iterable<unknown>,
        options?: RegisterTableOptions,
      ) => {
        registered = options;
        for await (const row of rows) staged.push(row as Record<string, unknown>);
        return {
          tableName: name,
          rowCount: staged.length,
          columns: (options?.schema ?? []).map((c) => c.name),
        };
      },
      drop: async () => true,
    };
    setCanvas({ acquire: async () => instance } as never);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const structured = output.structuredContent as {
      canvas_id?: string;
      constant_columns: Record<string, unknown>;
      row_count: number;
      rows: Record<string, unknown>[];
      table_name?: string;
      truncated?: boolean;
    };

    expect(structured.truncated).toBe(true);
    expect(structured.canvas_id).toBe('canvas-001');
    expect(structured.table_name).toMatch(/^spilled_[0-9a-f]{8}$/);
    expect(structured.row_count).toBe(SPILL_ROWS);
    expect(structured.rows.length).toBeLessThan(SPILL_ROWS);

    const columns = (registered?.schema ?? []).map((c: ColumnSchema) => c.name);
    expect(columns).toContain('REF_YEAR_PRICE');
    expect(columns).toContain('UNIT_MULT');
    expect(columns).toContain('value_scale');
    expect(registered?.schema?.find((c) => c.name === 'value')?.type).toBe('DOUBLE');
    // The table keeps every column the rows shed: source, the constants, and every code.
    expect(columns).toEqual(
      expect.arrayContaining(['source', 'FREQ', 'FREQ_code', 'REF_AREA_code', 'UNIT_MULT_code']),
    );
    expect(staged).toHaveLength(SPILL_ROWS);
    expect(staged[0]).toEqual({
      FREQ: 'Annual',
      FREQ_code: 'A',
      OBS_STATUS: 'Normal value',
      OBS_STATUS_code: 'A',
      REF_AREA: 'United States',
      REF_AREA_code: 'USA',
      TIME_PERIOD: '1983',
      UNIT_MULT: 'Units',
      UNIT_MULT_code: '0',
      source: 'OECD',
      value: 1000,
      value_scale: 1,
    });
    // The preview returned beside it is the hoisted shape.
    expect(structured.rows[0]).toEqual({ TIME_PERIOD: '1983', value: 1000, value_scale: 1 });
    expect(Object.keys(structured.constant_columns)).toEqual([
      'FREQ',
      'REF_AREA',
      'OBS_STATUS',
      'UNIT_MULT',
    ]);

    const text = textOf(output.content);
    expect(text).toContain('Truncated —');
    expect(text).toContain('canvas-001');
    expect(text).toContain('oecd_dataframe_query');
  });

  it('keeps the result inline when a canvas is configured but the result fits', async () => {
    respond(DATA_RESPONSE);

    setCanvas({
      acquire: async () => ({
        canvasId: 'canvas-002',
        registerTable: async () => {
          throw new Error('should not register a result that fits inline');
        },
        drop: async () => true,
      }),
    } as never);

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.USA..' });
    const result = await oecdQueryDataset.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.canvas_id).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });

  // ── format() ────────────────────────────────────────────────────────────────

  it('formats an inline result with the observation table and query echo', () => {
    const output = {
      rows: [
        { TIME_PERIOD: '2020', value: 26054.614, value_scale: 1 },
        { TIME_PERIOD: '2021', value: 27000.5, value_scale: 1 },
      ],
      row_count: 2,
      constant_columns: {
        FREQ: { code: 'A', label: 'Annual' },
        REF_AREA: { code: 'USA', label: 'United States' },
      },
      query_flow_ref: FLOW_REF,
      query_key: 'A.USA..',
      query_start_period: '2020',
      query_end_period: '2022',
      source: 'OECD' as const,
    };
    const text = textOf(oecdQueryDataset.format?.(output) ?? []);

    expect(text).toContain('OECD Dataset Query');
    expect(text).toContain('2 observations');
    expect(text).toContain(FLOW_REF);
    expect(text).toContain('A.USA..');
    expect(text).toContain('Not truncated — all 2 rows');
    expect(text).toContain('Source: OECD');
    // The constants render once, as their own table above the rows.
    expect(text).toContain(
      `${CONSTANTS_HEADER}\n| --- | --- | --- |\n| FREQ | A | Annual |\n| REF_AREA | USA | United States |`,
    );
    expect(text.indexOf(CONSTANTS_HEADER)).toBeLessThan(text.indexOf('| TIME_PERIOD |'));
    expect(text).toContain('| TIME_PERIOD | value | value_scale |');
    expect(tableRowCount(text)).toBe(2);
  });

  it('renders no constants table when every component varies', () => {
    const text = textOf(
      oecdQueryDataset.format?.({
        rows: [
          { REF_AREA: 'Canada', REF_AREA_code: 'CAN', value: 1, value_scale: 1 },
          { REF_AREA: 'Germany', REF_AREA_code: 'DEU', value: 2, value_scale: 1 },
        ],
        row_count: 2,
        constant_columns: {},
        query_flow_ref: FLOW_REF,
        query_key: 'A.USA..',
        source: 'OECD',
      }) ?? [],
    );

    expect(text).not.toContain(CONSTANTS_HEADER);
    expect(text).not.toContain('Constant on every row');
    expect(tableRowCount(text)).toBe(2);
  });

  it('formats a spilled result with the handle and truncation disclosure; enrichment carries the route', () => {
    const output = {
      rows: [{ value: 26054.614, value_scale: 1 }],
      row_count: 500,
      constant_columns: { FREQ: { code: 'A', label: 'Annual' } },
      query_flow_ref: FLOW_REF,
      query_key: 'A.USA..',
      canvas_id: 'canvas-001',
      table_name: 'spilled_abc',
      truncated: true as const,
      source: 'OECD' as const,
    };
    const text = textOf(oecdQueryDataset.format?.(output) ?? []);

    expect(text).toContain('canvas-001');
    expect(text).toContain('spilled_abc');
    expect(text).not.toContain('oecd_dataframe_query');
    expect(text).toContain('500 observations');
    expect(text).toContain('Truncated — showing the first 1 of 500 rows');
  });
});

// ── Upstream failure wiring ───────────────────────────────────────────────────

/**
 * How each upstream failure reaches this tool's caller across the probe, the
 * catalog lookup, and the follow-up. The mechanisms — the reason mapping and
 * the call's budget — are tabled at the HTTP boundary; these prove the tool is
 * wired to them, one case per side of each branch.
 */
describe('oecdQueryDataset upstream failure wiring', () => {
  const input = { flow_ref: FLOW_REF, key: 'A.USA..' };
  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  /** Answer the data endpoint and the catalog lookup each from its own script. */
  function serve(data: ScriptedAnswer, lookup: ScriptedAnswer = STALL): ScriptedFetch {
    fake = installScriptedFetch((url) => (url.includes('/data/') ? data : lookup));
    return fake;
  }

  beforeEach(() => {
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    const config = getServerConfig();
    configured = { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
    // The default OECD_TIMEOUT_MS: a stalled ladder runs into the budget, not out of attempts.
    config.timeoutMs = 30_000;
    initDataService();
    setCanvas(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(getServerConfig(), configured);
    initDataService();
    const installed = fake;
    fake = undefined;
    installed?.restore();
  });

  it('names a data body that is not JSON upstream_unreadable, after one request', async () => {
    const upstream = serve(PROXY_PAGE);
    const hint = declaredRecovery(oecdQueryDataset, 'upstream_unreadable');

    const { error, text } = await toolWireFailure(oecdQueryDataset, input);

    expect(upstream.requests).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable', recovery: { hint }, retryable: false },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
    expect(text).toContain(hint);
    expect(text).toContain('(reason upstream_unreadable · not retryable)');
  });

  it('names a 501 upstream_error after one request, carrying the status and OECD’s text', async () => {
    const upstream = serve({ body: 'Not Implemented', kind: 'answer', status: 501 });

    const error = await toolWireError(oecdQueryDataset, input);

    // The framework marks a 501 non-retryable, so it is not the retryable upstream_unavailable.
    expect(upstream.requests).toHaveLength(1);
    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: declaredRecovery(oecdQueryDataset, 'upstream_error') },
    });
    expect(error.message).toContain('OECD answered HTTP 501: Not Implemented');
  });

  it('ends a stalled data request as upstream_timeout when the call’s budget runs out', async () => {
    vi.useFakeTimers({ now: 0 });
    const upstream = serve(STALL);

    const call = observe(toolWireError(oecdQueryDataset, input));
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(upstream.requests).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          recovery: { hint: declaredRecovery(oecdQueryDataset, 'upstream_timeout') },
        },
      },
    });
  });

  it('ends as upstream_timeout, not dataflow_not_found, when the budget runs out mid-lookup', async () => {
    vi.useFakeTimers({ now: 0 });
    const upstream = serve(
      {
        afterMs: 25_000,
        body: 'Could not find Dataflow and/or DSD related with this data request',
        kind: 'answer',
        status: 404,
      },
      STALL,
    );

    const call = observe(toolWireError(oecdQueryDataset, input));
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(upstream.requests.map((r) => [r.atMs, new URL(r.url).pathname])).toEqual([
      [0, '/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/A.USA..'],
      [25_000, '/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I'],
    ]);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: { code: JsonRpcErrorCode.Timeout, data: { reason: 'upstream_timeout' } },
    });
  });

  it('lets a failure with no OECD answer behind it through as itself, not as invalid_key', async () => {
    getServerConfig().baseUrl = 'ftp://fake.oecd.test';
    initDataService();
    const upstream = serve(STALL);

    const error = await toolWireError(oecdQueryDataset, input);

    expect(upstream.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_url' },
    });
  });

  it('lets the caller’s own abort through as RequestCancelled, with no upstream reason', async () => {
    const caller = new AbortController();
    fake = installScriptedFetch(() => {
      queueMicrotask(() => caller.abort());
      return STALL;
    });

    const output = await runToolContract(oecdQueryDataset, input, {
      context: { errors: oecdQueryDataset.errors, signal: caller.signal },
    });
    const error = (
      output.structuredContent as { error: { code: number; data?: { reason?: string } } }
    ).error;

    expect(fake.requests).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      data: { errorSource: 'FetchAborted' },
    });
    expect(error.data?.reason).toBeUndefined();
  });
});

// ── The no_results diagnosis ──────────────────────────────────────────────────

/** A `200` SDMX-JSON answer under the `cache-control` OECD sends with it. */
function cacheable(value: unknown, maxAgeS = 86_400): ScriptedAnswer {
  return {
    body: JSON.stringify(value),
    headers: { 'cache-control': `public,max-age=${maxAgeS}`, 'content-type': 'application/json' },
    kind: 'answer',
  };
}

/** What the data endpoint answers for a valid query that matches nothing. */
const NO_MATCH: ScriptedAnswer = {
  body: 'NoResultsFound',
  headers: { 'content-type': 'text/plain' },
  kind: 'answer',
  status: 404,
};

/** An `availableconstraint` answer in OECD's shape: codes per dimension, `obs_count`, and the `TIME_PERIOD` range. */
function availabilityRecord(
  codes: Record<string, string[]>,
  observations: number,
  [start, end]: readonly [string, string],
): ScriptedAnswer {
  const keyValues = [
    ...Object.entries(codes).map(([id, values]) => ({ id, values })),
    {
      id: 'TIME_PERIOD',
      timeRange: {
        endPeriod: { isInclusive: true, period: `${end}T23:59:59` },
        startPeriod: { isInclusive: true, period: `${start}T00:00:00` },
      },
    },
  ];
  return cacheable(
    {
      data: {
        contentConstraints: [
          {
            annotations: [{ id: 'obs_count', title: String(observations), type: 'sdmx_metrics' }],
            cubeRegions: [{ isIncluded: true, keyValues }],
            id: 'CC',
            type: 'Actual',
          },
        ],
      },
    },
    7200,
  );
}

/** The range OECD reports for a key no series matches — start after end. */
const NO_SERIES = ['9999-01-01', '0001-12-31'] as const;

/** The `REF_AREA` codes OECD lists for `DF_QNA_EXPENDITURE_GROWTH_OECD`. */
const QNA_AREAS =
  'ARG AUS AUT BEL BRA CAN CHE CHL CHN COL CRI CZE DEU DNK EA ESP EST EU FIN FRA G20 G7 GBR GRC HUN IDN IND IRL ISL ISR ITA JPN KOR LTU LUX LVA MEX NLD NOR NZL OECD OECDE POL PRT RUS SAU SVK SVN SWE TUR USA USMCA ZAF'.split(
    ' ',
  );

/** OECD's record for `Q..US...B1GQ......G1.`: only REF_AREA has codes given the other segments. */
const US_RECORD = availabilityRecord({ REF_AREA: QNA_AREAS }, 0, NO_SERIES);

/**
 * OECD's record for `Q..usa...B1GQ......G1.`, which reads `usa` as `USA` — 318
 * quarterly observations. The record for `Q..USA...B1GQ......G1.` is the same.
 */
const USA_RECORD = availabilityRecord(
  {
    FREQ: ['A', 'Q'],
    ADJUSTMENT: ['Y'],
    REF_AREA: QNA_AREAS,
    SECTOR: ['S1'],
    COUNTERPART_SECTOR: ['S1'],
    TRANSACTION: ['B1GQ', 'P3', 'P51G', 'P6', 'P7'],
    INSTR_ASSET: ['_Z'],
    ACTIVITY: ['_Z'],
    EXPENDITURE: ['_Z'],
    UNIT_MEASURE: ['PC'],
    PRICE_BASE: ['L'],
    TRANSFORMATION: ['G1', 'GCM', 'GY'],
    TABLE_IDENTIFIER: ['T0102'],
  },
  318,
  ['1947-04-01', '2026-09-30'],
);

/** A datastructure response naming `dimensions` in key order, each concept in `scheme` when given. */
function datastructure(id: string, dimensions: readonly string[], scheme?: string): unknown {
  const concept = (dimension: string) =>
    scheme
      ? {
          conceptIdentity: `urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=${scheme}.${dimension}`,
        }
      : {};
  return {
    data: {
      dataStructures: [
        {
          id,
          dataStructureComponents: {
            dimensionList: {
              dimensions: dimensions.map((dimension, position) => ({
                id: dimension,
                position,
                ...concept(dimension),
              })),
              timeDimensions: [{ id: 'TIME_PERIOD', ...concept('TIME_PERIOD') }],
            },
          },
        },
      ],
    },
  };
}

/**
 * On an empty result the tool reads OECD's availability record for the key and
 * says what in the key the record shows matched nothing. Reading the record and
 * comparing a key against it are tabled at the availability seam; these prove
 * the wiring — what each path requests, one case per branch of the message, and
 * the plain message whenever the diagnosis cannot be had.
 */
describe('oecdQueryDataset no_results diagnosis', () => {
  const FLOW = 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD';
  const US_KEY = 'Q..US...B1GQ......G1.';
  const LOWER_USA_KEY = 'Q..usa...B1GQ......G1.';
  const USA_KEY = 'Q..USA...B1GQ......G1.';
  const DATAFLOW_URL = `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD?references=datastructure`;
  const SCHEME_URL = `${FAKE_BASE}/conceptscheme/OECD.SDD.NAD/CS_NA/1.0`;
  const NAMAIN_DSD = datastructure(
    'DSD_NAMAIN1',
    [
      'FREQ',
      'ADJUSTMENT',
      'REF_AREA',
      'SECTOR',
      'COUNTERPART_SECTOR',
      'TRANSACTION',
      'INSTR_ASSET',
      'ACTIVITY',
      'EXPENDITURE',
      'UNIT_MEASURE',
      'PRICE_BASE',
      'TRANSFORMATION',
      'TABLE_IDENTIFIER',
    ],
    'OECD.SDD.NAD:CS_NA(1.0)',
  );
  const SCHEME = {
    data: {
      conceptSchemes: [{ concepts: [{ id: 'REF_AREA', name: 'Reference area' }], id: 'CS_NA' }],
    },
  };

  const dataUrl = (key: string, period = '') =>
    `${FAKE_BASE}/data/OECD.SDD.NAD,DSD_NAMAIN1%40DF_QNA_EXPENDITURE_GROWTH_OECD/${key}?dimensionAtObservation=AllDimensions${period}`;
  const availabilityUrl = (key: string) =>
    `${FAKE_BASE}/availableconstraint/OECD.SDD.NAD,DSD_NAMAIN1%40DF_QNA_EXPENDITURE_GROWTH_OECD/${key}/all/all?mode=available`;
  const plainMessage = (key: string) => `No observations found for key "${key}" in ${FLOW}`;

  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  /**
   * Answer each URL from `answers`, empty data from every `/data/` request it
   * does not name. A request to any other URL fails the test at restore.
   */
  function serve(answers: Record<string, ScriptedAnswer>): ScriptedFetch {
    const routes = new Map(Object.entries(answers));
    fake = installScriptedFetch((url) => {
      const answer =
        routes.get(url) ?? (new URL(url).pathname.startsWith('/data/') ? NO_MATCH : undefined);
      if (!answer) throw new Error(`Unexpected request: ${url}`);
      return answer;
    });
    return fake;
  }

  /** The datastructure, cold, plus the availability `record` for `key`. */
  function serveDiagnosis(key: string, record: ScriptedAnswer): ScriptedFetch {
    return serve({
      [DATAFLOW_URL]: cacheable(NAMAIN_DSD),
      [SCHEME_URL]: cacheable(SCHEME),
      [availabilityUrl(key)]: record,
    });
  }

  beforeEach(() => {
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    const config = getServerConfig();
    configured = { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
    Object.assign(config, { baseUrl: FAKE_BASE, timeoutMs: 5000 });
    initDataService();
    initStructureService();
    setCanvas(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(getServerConfig(), configured);
    initDataService();
    initStructureService();
    const installed = fake;
    fake = undefined;
    installed?.restore();
  });

  it('names the segment whose code has no data given the rest of the key, on both surfaces', async () => {
    const upstream = serveDiagnosis(US_KEY, US_RECORD);
    const message = `${plainMessage(US_KEY)}: REF_AREA "US" has no data given the other segments.`;

    const { error, text } = await toolWireFailure(oecdQueryDataset, {
      flow_ref: FLOW,
      key: US_KEY,
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_results',
        recovery: { hint: declaredRecovery(oecdQueryDataset, 'no_results') },
      },
      message,
    });
    expect(text).toContain(message);
    expect(text).toContain(declaredRecovery(oecdQueryDataset, 'no_results'));
    // Cold: the query, the datastructure and its concept scheme, then one availability read.
    expect(upstream.requests.map((r) => r.url)).toEqual([
      dataUrl(US_KEY),
      DATAFLOW_URL,
      SCHEME_URL,
      availabilityUrl(US_KEY),
    ]);
  });

  it('names a pinned code that matches only by letter case', async () => {
    serveDiagnosis(LOWER_USA_KEY, USA_RECORD);

    const { error, text } = await toolWireFailure(oecdQueryDataset, {
      flow_ref: FLOW,
      key: LOWER_USA_KEY,
    });
    const message = `${plainMessage(LOWER_USA_KEY)}: REF_AREA "usa" matches "USA" only by case, and codes are case-sensitive.`;

    expect(error).toMatchObject({ data: { reason: 'no_results' }, message });
    expect(text).toContain(message);
  });

  it('says so when OECD lists no code for any pinned segment given the others', async () => {
    serveDiagnosis(USA_KEY, availabilityRecord({}, 0, NO_SERIES));

    const { error, text } = await toolWireFailure(oecdQueryDataset, {
      flow_ref: FLOW,
      key: USA_KEY,
    });
    const message = `${plainMessage(USA_KEY)}: the key's pinned segments match no series together.`;

    expect(error).toMatchObject({ data: { reason: 'no_results' }, message });
    expect(text).toContain(message);
  });

  it('names the range when the requested period lies wholly outside it', async () => {
    const upstream = serveDiagnosis(USA_KEY, USA_RECORD);

    const { error, text } = await toolWireFailure(oecdQueryDataset, {
      flow_ref: FLOW,
      key: USA_KEY,
      start_period: '2030',
    });
    const message = `${plainMessage(USA_KEY)}: the requested period lies outside 1947-04-01 to 2026-09-30, the range OECD records for this key.`;

    expect(error).toMatchObject({ data: { reason: 'no_results' }, message });
    expect(text).toContain(message);
    // The availability read carries the key alone, never the period.
    expect(upstream.requests.map((r) => r.url)).toEqual([
      dataUrl(USA_KEY, '&startPeriod=2030'),
      DATAFLOW_URL,
      SCHEME_URL,
      availabilityUrl(USA_KEY),
    ]);
  });

  it.each([
    [
      'a period inside the range the record covers',
      { flow_ref: FLOW, key: USA_KEY, start_period: '2019', end_period: '2019' },
      USA_KEY,
      USA_RECORD,
    ],
    [
      'an every-series key on a record with no observations',
      { flow_ref: FLOW, key: 'all' },
      'all',
      availabilityRecord({}, 0, NO_SERIES),
    ],
  ])('keeps the plain message for %s', async (_case, input, key, record) => {
    const upstream = serveDiagnosis(key, record);

    const { error } = await toolWireFailure(oecdQueryDataset, input);

    expect(error).toMatchObject({ data: { reason: 'no_results' }, message: plainMessage(key) });
    expect(upstream.requestsTo('/availableconstraint/')).toHaveLength(1);
  });

  it.each<[string, Record<string, ScriptedAnswer>, number]>([
    [
      'an availability read OECD answers with HTTP 500',
      { [availabilityUrl(US_KEY)]: { body: 'Internal server error', kind: 'answer', status: 500 } },
      1,
    ],
    [
      'an availability read OECD throttles',
      {
        [availabilityUrl(US_KEY)]: {
          body: 'You have exceeded the number of requests currently permitted in the OECD Data API.',
          kind: 'answer',
          status: 429,
        },
      },
      1,
    ],
    ['an availability body that is not JSON', { [availabilityUrl(US_KEY)]: PROXY_PAGE }, 1],
    [
      'a datastructure OECD does not find',
      {
        [DATAFLOW_URL]: {
          body: 'No Results Found',
          headers: { 'cache-control': 'no-cache,no-store', 'content-type': 'text/plain' },
          kind: 'answer',
          status: 404,
        },
      },
      0,
    ],
  ])('keeps the plain message after %s, unretried', async (_case, answers, availabilityReads) => {
    const upstream = serve({
      [DATAFLOW_URL]: cacheable(NAMAIN_DSD),
      [SCHEME_URL]: cacheable(SCHEME),
      ...answers,
    });

    const { error, text } = await toolWireFailure(oecdQueryDataset, {
      flow_ref: FLOW,
      key: US_KEY,
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
      message: plainMessage(US_KEY),
    });
    expect(text).toContain(plainMessage(US_KEY));
    expect(upstream.requestsTo('/availableconstraint/')).toHaveLength(availabilityReads);
  });

  it('keeps the plain message when the availability read runs out OECD_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ now: 0 });
    serve({
      [DATAFLOW_URL]: cacheable(NAMAIN_DSD),
      [SCHEME_URL]: cacheable(SCHEME),
      [availabilityUrl(US_KEY)]: STALL,
    });

    const call = observe(toolWireError(oecdQueryDataset, { flow_ref: FLOW, key: US_KEY }));
    const { outcome, pendingBefore } = await runUntil(call, 5_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(5_000);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: { data: { reason: 'no_results' }, message: plainMessage(US_KEY) },
    });
  });

  /**
   * The diagnosis gets 10 s of what the call has left. Each case answers the
   * query after `queryMs` and stalls one diagnosis read; the call settles when
   * the diagnosis's share runs out, with the plain message.
   */
  it.each<[string, Record<string, ScriptedAnswer>, number, number]>([
    ['the availability read stalls', { [availabilityUrl(US_KEY)]: STALL }, 25_000, 35_000],
    ['the datastructure read stalls', { [DATAFLOW_URL]: STALL }, 25_000, 35_000],
    [
      'the call has under 10 s left when the availability read stalls',
      { [availabilityUrl(US_KEY)]: STALL },
      45_000,
      50_000,
    ],
  ])(
    'answers the plain message when %s, once the diagnosis’s share of the budget runs out',
    async (_case, answers, queryMs, settledAtMs) => {
      vi.useFakeTimers({ now: 0 });
      getServerConfig().timeoutMs = 50_000;
      const upstream = serve({
        [dataUrl(US_KEY)]: { ...NO_MATCH, afterMs: queryMs },
        [DATAFLOW_URL]: cacheable(NAMAIN_DSD),
        [SCHEME_URL]: cacheable(SCHEME),
        [availabilityUrl(US_KEY)]: US_RECORD,
        ...answers,
      });

      const call = observe(toolWireError(oecdQueryDataset, { flow_ref: FLOW, key: US_KEY }));
      await vi.advanceTimersByTimeAsync(settledAtMs - 1);
      expect(call.settledAtMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await call.outcome;

      expect(call.settledAtMs).toBe(settledAtMs);
      expect(upstream.requests[1]?.atMs).toBe(queryMs);
      // The diagnosis running out is not the answer: the empty result already is.
      expect(outcome).toMatchObject({
        status: 'fulfilled',
        value: {
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'no_results' },
          message: plainMessage(US_KEY),
        },
      });
    },
  );

  it('keeps the plain message at the diagnosis’s 10 s share when OECD throttles it for longer, sending nothing more', async () => {
    vi.useFakeTimers({ now: 0 });
    getServerConfig().timeoutMs = 30_000;
    const upstream = serve({
      [DATAFLOW_URL]: {
        body: 'You have exceeded the number of requests currently permitted in the OECD Data API.',
        headers: { 'retry-after': '20' },
        kind: 'answer',
        status: 429,
      },
    });

    const call = observe(toolWireError(oecdQueryDataset, { flow_ref: FLOW, key: US_KEY }));
    // Well past the Retry-After, so a throttled read waited out would show here.
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await call.outcome;

    expect(call.settledAtMs).toBe(10_000);
    expect(upstream.requests.map((r) => r.url)).toEqual([dataUrl(US_KEY), DATAFLOW_URL]);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: { data: { reason: 'no_results' }, message: plainMessage(US_KEY) },
    });
  });

  it.each([
    ['/dataflow/', 'datastructure'],
    ['/availableconstraint/', 'availability'],
  ])(
    'lets the caller’s abort during the %s read through as RequestCancelled',
    async (path, read) => {
      const caller = new AbortController();
      const routes = new Map<string, ScriptedAnswer>([
        [DATAFLOW_URL, cacheable(NAMAIN_DSD)],
        [SCHEME_URL, cacheable(SCHEME)],
      ]);
      fake = installScriptedFetch((url) => {
        if (new URL(url).pathname.startsWith(path)) {
          queueMicrotask(() => caller.abort());
          return STALL;
        }
        return routes.get(url) ?? NO_MATCH;
      });

      const output = await runToolContract(
        oecdQueryDataset,
        { flow_ref: FLOW, key: US_KEY },
        { context: { errors: oecdQueryDataset.errors, signal: caller.signal } },
      );
      const error = (
        output.structuredContent as {
          error: { code: number; data?: { reason?: string }; message: string };
        }
      ).error;

      expect(fake.requestsTo(path)).toHaveLength(1);
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.data?.reason).toBeUndefined();
      // Any failure under an aborted signal reaches the wire as RequestCancelled,
      // so only the message tells the abort itself from a diagnosis that absorbed it.
      expect(error.message).toBe(`Failed to fetch OECD ${read} for ${FLOW}`);
    },
  );

  it('costs one request past the query once the datastructure is cached, and none for a key already read', async () => {
    const upstream = serve({
      [DATAFLOW_URL]: cacheable(NAMAIN_DSD),
      [SCHEME_URL]: cacheable(SCHEME),
      [availabilityUrl(US_KEY)]: US_RECORD,
      [availabilityUrl(LOWER_USA_KEY)]: USA_RECORD,
    });

    await toolWireError(oecdQueryDataset, { flow_ref: FLOW, key: US_KEY });
    const cold = upstream.requests.length;
    const other = await toolWireError(oecdQueryDataset, { flow_ref: FLOW, key: LOWER_USA_KEY });
    const warm = upstream.requests.slice(cold).map((r) => r.url);
    const repeat = await toolWireError(oecdQueryDataset, { flow_ref: FLOW, key: US_KEY });

    expect(cold).toBe(4);
    expect(warm).toEqual([dataUrl(LOWER_USA_KEY), availabilityUrl(LOWER_USA_KEY)]);
    expect(upstream.requests.slice(cold + warm.length).map((r) => r.url)).toEqual([
      dataUrl(US_KEY),
    ]);
    expect(other.message).toContain('"usa" matches "USA"');
    expect(repeat.message).toContain('REF_AREA "US" has no data');
  });

  it('sends nothing past the query when it returns rows', async () => {
    const upstream = serve({ [dataUrl(USA_KEY)]: cacheable(DATA_RESPONSE) });

    const result = await runToolContract(oecdQueryDataset, { flow_ref: FLOW, key: USA_KEY });

    expect(result.isError).toBeFalsy();
    expect(upstream.requests.map((r) => r.url)).toEqual([dataUrl(USA_KEY)]);
  });

  /**
   * A dataflow the configured root catalogues as a pointer: its data and its
   * datastructure live on the root the catalog entry names, and so does its
   * availability record — the configured root answers that read with a 500.
   */
  it('reads the availability of a delegated dataflow from the root that serves its data', async () => {
    const DELEGATED = `${FAKE_BASE}/sti-public/rest`;
    const MAINLV = 'OECD.STI.PIE,DSD_TIVA_MAINLV@DF_MAINLV';
    const KEY = 'PROD.US...USD.A';
    const DATAFLOW = '/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV';
    const DATA = `/data/OECD.STI.PIE,DSD_TIVA_MAINLV%40DF_MAINLV/${KEY}?dimensionAtObservation=AllDimensions`;
    const AVAILABILITY = `/availableconstraint/OECD.STI.PIE,DSD_TIVA_MAINLV%40DF_MAINLV/${KEY}/all/all?mode=available`;
    const pointer = cacheable({
      data: {
        dataStructures: [],
        dataflows: [
          {
            agencyID: 'OECD.STI.PIE',
            id: 'DSD_TIVA_MAINLV@DF_MAINLV',
            isExternalReference: true,
            links: [{ href: `${DELEGATED}${DATAFLOW}/1.2`, rel: 'external' }],
          },
        ],
      },
    });
    const mainlv = datastructure('DSD_TIVA_MAINLV', [
      'MEASURE',
      'REF_AREA',
      'ACTIVITY',
      'COUNTERPART_AREA',
      'UNIT_MEASURE',
      'FREQ',
    ]);
    const upstream = serve({
      // The query: the configured root answers 500, its catalog entry points on.
      [`${FAKE_BASE}${DATA}`]: { body: 'Object reference not set', kind: 'answer', status: 500 },
      [`${FAKE_BASE}${DATAFLOW}`]: pointer,
      [`${DELEGATED}${DATA}`]: NO_MATCH,
      // The datastructure, which the configured root holds only as the same pointer.
      [`${FAKE_BASE}${DATAFLOW}?references=datastructure`]: pointer,
      [`${FAKE_BASE}/datastructure/OECD.STI.PIE/DSD_TIVA_MAINLV`]: {
        body: 'Could not find requested structures',
        kind: 'answer',
        status: 404,
      },
      [`${DELEGATED}${DATAFLOW}?references=datastructure`]: cacheable(mainlv),
      [`${DELEGATED}${AVAILABILITY}`]: availabilityRecord(
        { REF_AREA: ['CAN', 'USA'] },
        0,
        NO_SERIES,
      ),
    });

    const { error } = await toolWireFailure(oecdQueryDataset, { flow_ref: MAINLV, key: KEY });

    expect(error).toMatchObject({
      data: { reason: 'no_results' },
      message: `No observations found for key "${KEY}" in ${MAINLV}: REF_AREA "US" has no data given the other segments.`,
    });
    expect(upstream.requestsTo('/availableconstraint/').map((r) => r.url)).toEqual([
      `${DELEGATED}${AVAILABILITY}`,
    ]);
  });

  /**
   * A delegated dataflow whose datastructure the configured root holds as well,
   * as ten of them do: the datastructure resolves on the configured root, but the
   * data — and so the availability record — come from the root the catalog entry
   * names, and the configured root answers the availability read with a 500.
   */
  it('reads the availability from the root that served the data when the configured root holds the datastructure', async () => {
    const DELEGATED = `${FAKE_BASE}/sti-public/rest`;
    const ITIC = 'OECD.SDD.TPS,DSD_ITIC@DF_ITIC';
    const KEY = 'A.US..';
    const DATAFLOW = '/dataflow/OECD.SDD.TPS/DSD_ITIC@DF_ITIC';
    const DATA = `/data/OECD.SDD.TPS,DSD_ITIC%40DF_ITIC/${KEY}?dimensionAtObservation=AllDimensions`;
    const AVAILABILITY = `/availableconstraint/OECD.SDD.TPS,DSD_ITIC%40DF_ITIC/${KEY}/all/all?mode=available`;
    const INTERNAL_ERROR: ScriptedAnswer = {
      body: 'Internal server error',
      kind: 'answer',
      status: 500,
    };
    const pointer = cacheable({
      data: {
        dataStructures: [],
        dataflows: [
          {
            agencyID: 'OECD.SDD.TPS',
            id: 'DSD_ITIC@DF_ITIC',
            isExternalReference: true,
            links: [{ href: `${DELEGATED}${DATAFLOW}/1.0`, rel: 'external' }],
          },
        ],
      },
    });
    const upstream = serve({
      // The query: the configured root answers 500, its catalog entry points on.
      [`${FAKE_BASE}${DATA}`]: { body: 'Object reference not set', kind: 'answer', status: 500 },
      [`${FAKE_BASE}${DATAFLOW}`]: pointer,
      [`${DELEGATED}${DATA}`]: NO_MATCH,
      // The datastructure: the same pointer, then the configured root's own copy.
      [`${FAKE_BASE}${DATAFLOW}?references=datastructure`]: pointer,
      [`${FAKE_BASE}/datastructure/OECD.SDD.TPS/DSD_ITIC`]: cacheable(
        datastructure('DSD_ITIC', ['FREQ', 'REF_AREA', 'MEASURE', 'COUNTERPART_AREA']),
      ),
      [`${FAKE_BASE}${AVAILABILITY}`]: INTERNAL_ERROR,
      [`${DELEGATED}${AVAILABILITY}`]: availabilityRecord(
        { REF_AREA: ['CAN', 'USA'] },
        0,
        NO_SERIES,
      ),
    });

    const { error } = await toolWireFailure(oecdQueryDataset, { flow_ref: ITIC, key: KEY });

    expect(error).toMatchObject({
      data: { reason: 'no_results' },
      message: `No observations found for key "${KEY}" in ${ITIC}: REF_AREA "US" has no data given the other segments.`,
    });
    expect(upstream.requests.map((r) => r.url)).toEqual([
      `${FAKE_BASE}${DATA}`,
      `${FAKE_BASE}${DATAFLOW}`,
      `${DELEGATED}${DATA}`,
      `${FAKE_BASE}${DATAFLOW}?references=datastructure`,
      `${FAKE_BASE}/datastructure/OECD.SDD.TPS/DSD_ITIC`,
      `${DELEGATED}${AVAILABILITY}`,
    ]);
  });
});
