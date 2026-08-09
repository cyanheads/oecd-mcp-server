/**
 * @fileoverview Tests for oecd_query_dataset — attribute columns and unit
 * scaling, content[]/structuredContent parity, the inline preview bound, the
 * typed error contract, and the DataCanvas spillover path.
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oecdQueryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { initDataService } from '@/services/oecd-data/oecd-data-service.js';

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
  return { data: { dataSets: [{ observations }], structures: [STRUCTURE] } };
}

const EMPTY_DATA_RESPONSE = {
  data: { dataSets: [{ observations: {} }], structures: [STRUCTURE] },
};

const http = createFetchMock();

function respond(body: BodyInit | unknown, init?: ResponseInit): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  http.route({ match: DATA_URL, respond: () => new Response(payload, init) });
}

function textOf(blocks: unknown): string {
  return (blocks as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
}

/** Data rows in the rendered markdown table — header and divider excluded. */
function tableRowCount(text: string): number {
  return text.split('\n').filter((line) => line.startsWith('| ')).length - 2;
}

/** A canvas that records what it staged and reports the row count back. */
function recordingCanvas(canvasId: string): {
  acquire: () => Promise<unknown>;
} {
  const instance = {
    canvasId,
    registerTable: async (
      name: string,
      rows: Iterable<unknown>,
      options?: RegisterTableOptions,
    ) => {
      let rowCount = 0;
      for await (const _row of rows as AsyncIterable<unknown>) rowCount += 1;
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
    expect(result.rows[0]).toHaveProperty('FREQ');
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
    respond(seriesResponse(1500));

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
    expect(structured.row_count).toBe(1500);
    expect(structured.rows).toHaveLength(1500);
    // The rendered table stops short of it.
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(1500);
    expect(text.length).toBeLessThan(JSON.stringify(structured.rows).length);

    // Disclosed as a display cap, not as a canvas spill.
    expect(structured.content_table_capped).toBe(true);
    expect(structured.content_table_rows).toBe(rendered);
    expect(structured.truncated).toBeUndefined();
    expect(structured.canvas_id).toBeUndefined();
  });

  it('names a reachable retrieval path in the capped-table note', async () => {
    respond(seriesResponse(1500));

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const text = textOf(output.content);

    expect(text).toContain('Truncated for display');
    expect(text).toContain('of 1500 rows');
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
    respond(seriesResponse(1500));
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
    expect(structured.rows.length).toBeLessThan(1500);
    // The canvas holds the remainder, so the display cap never engages.
    expect(structured.content_table_capped).toBeUndefined();
    expect(text).toContain('The rest is on DataCanvas');
    expect(text).not.toContain('Truncated for display');
  });

  it('previews the same number of rows with a canvas and without one', async () => {
    respond(seriesResponse(1500));
    const withoutCanvas = await runToolContract(oecdQueryDataset, {
      flow_ref: FLOW_REF,
      key: 'A.USA..',
    });

    http.reset();
    respond(seriesResponse(1500));
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

  // ── Error contract ──────────────────────────────────────────────────────────

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

    const ctx = createMockContext({ errors: oecdQueryDataset.errors });
    const input = oecdQueryDataset.input.parse({ flow_ref: FLOW_REF, key: 'A.ZZZ..' });
    await expect(oecdQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
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
  });

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

  // ── Canvas spillover path ───────────────────────────────────────────────────

  it('declares sparse attribute columns on the spilled canvas table', async () => {
    respond(seriesResponse(1500));

    let registered: RegisterTableOptions | undefined;
    const instance = {
      canvasId: 'canvas-001',
      registerTable: async (
        name: string,
        rows: Iterable<unknown>,
        options?: RegisterTableOptions,
      ) => {
        registered = options;
        let rowCount = 0;
        for await (const _row of rows as AsyncIterable<unknown>) rowCount += 1;
        return { tableName: name, rowCount, columns: (options?.schema ?? []).map((c) => c.name) };
      },
      drop: async () => true,
    };
    setCanvas({ acquire: async () => instance } as never);

    const output = await runToolContract(oecdQueryDataset, { flow_ref: FLOW_REF, key: 'A.USA..' });
    const structured = output.structuredContent as {
      canvas_id?: string;
      row_count: number;
      rows: unknown[];
      table_name?: string;
      truncated?: boolean;
    };

    expect(structured.truncated).toBe(true);
    expect(structured.canvas_id).toBe('canvas-001');
    expect(structured.table_name).toBeDefined();
    expect(structured.row_count).toBe(1500);
    expect(structured.rows.length).toBeLessThan(1500);

    const columns = (registered?.schema ?? []).map((c: ColumnSchema) => c.name);
    expect(columns).toContain('REF_YEAR_PRICE');
    expect(columns).toContain('UNIT_MULT');
    expect(columns).toContain('value_scale');
    expect(registered?.schema?.find((c) => c.name === 'value')?.type).toBe('DOUBLE');

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
        {
          FREQ: 'Annual',
          REF_AREA: 'United States',
          UNIT_MULT: 'Units',
          value: 26054.614,
          value_scale: 1,
          source: 'OECD',
        },
      ],
      row_count: 1,
      query_flow_ref: FLOW_REF,
      query_key: 'A.USA..',
      query_start_period: '2020',
      query_end_period: '2022',
      source: 'OECD' as const,
    };
    const text = textOf(oecdQueryDataset.format?.(output) ?? []);

    expect(text).toContain('OECD Dataset Query');
    expect(text).toContain('1 observations');
    expect(text).toContain(FLOW_REF);
    expect(text).toContain('A.USA..');
    expect(text).toContain('FREQ');
    expect(text).toContain('Not truncated — all 1 rows');
    expect(text).toContain('Source: OECD');
  });

  it('formats a spilled result with the canvas handle and the retrieval path', () => {
    const output = {
      rows: [{ FREQ: 'Annual', value: 26054.614, value_scale: 1, source: 'OECD' }],
      row_count: 500,
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
    expect(text).toContain('oecd_dataframe_query');
    expect(text).toContain('500 observations');
    expect(text).toContain('Truncated — showing the first 1 of 500 rows');
  });
});
