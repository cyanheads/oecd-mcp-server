/**
 * @fileoverview Tests for oecd_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DUCKDB_ERROR_REASONS,
  DuckdbProvider,
  type QueryOptions,
} from '@cyanheads/mcp-ts-core/canvas';
import { resetConfig } from '@cyanheads/mcp-ts-core/config';
import {
  databaseError,
  JsonRpcErrorCode,
  notFound,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { ErrorHandler, escapeMarkdownInline, logger } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { declaredRecovery, toolWireError } from '../helpers/error-contract.js';

type Row = Record<string, unknown>;
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const CANVAS_ID = 'canvas-001';
const SQL = 'SELECT * FROM spilled_abc';
const BUDGET_BYTES = 1_048_576;

function buildMockInstance(canvasId: string, queryResult: unknown) {
  return {
    canvasId,
    query: vi.fn().mockResolvedValue(queryResult),
    describe: vi.fn(),
    registerTable: vi.fn(),
    export: vi.fn(),
    registerView: vi.fn(),
    importFrom: vi.fn(),
    drop: vi.fn(),
  };
}

/** Installs a canvas whose one instance answers `query()` with `answer`. */
function canvasAnswering(answer: (sql: string, options: QueryOptions) => Promise<unknown>) {
  const instance = buildMockInstance(CANVAS_ID, null);
  instance.query = vi.fn(answer);
  setCanvas({ acquire: vi.fn().mockResolvedValue(instance) } as never);
  return instance;
}

/** The result the canvas reports for `rows`, with its own truncation flag when it set one. */
function canvasResult(rows: Row[], truncated?: true) {
  return {
    rows,
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}),
    ...(truncated && { truncated }),
  };
}

/** Rejects the way the canvas does once its signal fires, and never settles before that. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const cancel = () => reject(timeout('Canvas query was cancelled.', { reason: 'cancelled' }));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

function structuredOf(result: ToolResult) {
  return result.structuredContent as {
    rows: Row[];
    row_count: number;
    column_names: string[];
    truncated?: boolean;
    notice?: string;
    error?: { code: number; message: string; data: Record<string, unknown> };
  };
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** The data lines of the rendered Markdown table — header and delimiter dropped. */
function tableRowsOf(result: ToolResult): string[] {
  return textOf(result)
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2);
}

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

describe('oecdDataframeQuery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  it('throws ctx.fail(canvas_disabled) when canvas is not configured', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'SELECT * FROM spilled_abc',
    });
    await expect(oecdDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('returns query rows, count, and column names', async () => {
    const mockRows = [
      { REF_AREA: 'United States', TIME_PERIOD: '2022', value: 26054.614 },
      { REF_AREA: 'Germany', TIME_PERIOD: '2022', value: 18000.0 },
    ];
    const mockQueryResult = {
      rows: mockRows,
      rowCount: 2,
      columns: ['REF_AREA', 'TIME_PERIOD', 'value'],
    };
    const mockInstance = buildMockInstance('canvas-001', mockQueryResult);
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'SELECT REF_AREA, TIME_PERIOD, value FROM spilled_abc ORDER BY value DESC',
    });
    const result = await oecdDataframeQuery.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.column_names).toEqual(['REF_AREA', 'TIME_PERIOD', 'value']);
  });

  it('runs the SQL through the canvas gate with system catalogs denied', async () => {
    const instance = canvasAnswering(async () => canvasResult([{ n: 1 }]));

    await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    expect(instance.query).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({ denySystemCatalogs: true, signal: expect.any(AbortSignal) }),
    );
  });

  it('throws ctx.fail(canvas_not_found) when acquire throws', async () => {
    const mockCanvas = {
      acquire: vi.fn().mockRejectedValue(new Error('canvas not found')),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    // Well-formed but unknown — the only way to reach the registry at all now
    // that an impossible id is rejected at argument validation.
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'expired001',
      sql: 'SELECT 1',
    });
    await expect(oecdDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('throws ctx.fail(invalid_sql) when the canvas rejects a SQL parse error', async () => {
    // The canvas classifies a parser failure before it reaches the tool, so the
    // handler sees a ValidationError rather than a bare DuckDB Error.
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi.fn().mockRejectedValue(
      validationError('Canvas SQL rejected: Parser Error: syntax error at or near "INVALID"', {
        reason: 'sql_parse_error',
      }),
    );
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'INVALID SQL',
    });
    await expect(oecdDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  it('throws ctx.fail(invalid_sql) when the canvas rejects a non-SELECT statement', async () => {
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi
      .fn()
      .mockRejectedValue(
        validationError(
          'Canvas query must be SELECT; got DROP_TABLE. Mutations must use registerTable, drop, or clear.',
          { reason: 'non_select_statement', statementType: 'DROP_TABLE' },
        ),
      );
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'DROP TABLE spilled_abc',
    });
    await expect(oecdDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  /**
   * A gated SELECT that prepared cleanly and then failed on the staged data —
   * a cast the observation values cannot take. The statement is a valid,
   * read-only SELECT, so `invalid_sql`'s "only SELECT is allowed, DDL and DML
   * are rejected" is the wrong thing to tell a caller whose next move is
   * TRY_CAST.
   */
  it('separates a DuckDB execution error from a rejected statement', async () => {
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi.fn().mockRejectedValue(
      validationError("Conversion Error: Could not convert string 'n/a' to DOUBLE", {
        reason: DUCKDB_ERROR_REASONS.sqlExecutionError,
        recovery: {
          hint: 'Wrap the cast in TRY_CAST, or filter out the rows the message names before converting them.',
        },
      }),
    );
    setCanvas({ acquire: vi.fn().mockResolvedValue(mockInstance) } as never);

    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'SELECT CAST(value AS DOUBLE) FROM spilled_abc',
    });
    const err = await toolWireError(oecdDataframeQuery, input);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'sql_execution_error' },
    });
    expect(err.message).toContain("Could not convert string 'n/a'");
    // The advice has to name the data fix, never the statement-shape one.
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).toContain('TRY_CAST');
    expect(hint).not.toContain('DDL');
  });

  it('maps a missing canvas table to table_not_found with a recovery naming this server', async () => {
    // Byte-for-byte what the canvas throws for a table that is not staged.
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi.fn().mockRejectedValue(
      notFound(
        'Canvas table "nonexistent_tbl" does not exist. The table may have expired or been dropped — re-stage it or call describe() to inspect the canvas.',
        {
          reason: 'missing_table',
          tableName: 'nonexistent_tbl',
          recovery: {
            hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
          },
        },
      ),
    );
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'SELECT * FROM nonexistent_tbl',
    });
    const err = await toolWireError(oecdDataframeQuery, input);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'table_not_found' },
    });
    expect(err.message).toContain('nonexistent_tbl');
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    expect(hint).toContain('oecd_dataframe_describe');
    expect(hint).toContain('oecd_query_dataset');
    // The framework methods the caller cannot reach are gone from the wire.
    expect(hint).not.toContain('registerTable');
    expect(hint).not.toContain('describe()');
  });

  it('leaves a DuckDB engine fault alone rather than calling it invalid SQL', async () => {
    // The other side of the engine/data split: an IO, INTERNAL, or out-of-memory
    // fault is the engine's, not the caller's, and arrives as a DatabaseError
    // with no reason to dispatch on. Its message can still carry words like
    // "Invalid", which is not the caller's cue.
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi
      .fn()
      .mockRejectedValue(databaseError('IO Error: Invalid file handle for spilled_abc'));
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'SELECT CAST(REF_AREA AS BIGINT) FROM spilled_abc',
    });
    await expect(oecdDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
    });
  });

  it('returns empty column_names when rows array is empty', async () => {
    const mockInstance = buildMockInstance('canvas-001', {
      rows: [],
      rowCount: 0,
      columns: [],
    });
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeQuery.errors });
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'canvas-001',
      sql: 'SELECT * FROM spilled_abc WHERE value > 9999999',
    });
    const result = await oecdDataframeQuery.handler(input, ctx);
    expect(result.row_count).toBe(0);
    expect(result.column_names).toHaveLength(0);
  });

  it('formats zero-row result', () => {
    const output = { rows: [], row_count: 0, column_names: [] };
    const blocks = oecdDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
  });

  it('formats non-empty result with header and rows', () => {
    const output = {
      rows: [{ REF_AREA: 'USA', value: 26000 }],
      row_count: 1,
      column_names: ['REF_AREA', 'value'],
    };
    const blocks = oecdDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('REF_AREA');
    expect(text).toContain('USA');
    expect(text).toContain('1 rows');
  });

  it('renders a nested value as JSON in the table rather than as an object tag', async () => {
    canvasAnswering(async () => canvasResult([{ codes: ['USA', 'DEU'], meta: { unit: 'USD' } }]));

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    expect(tableRowsOf(result)).toEqual(['| \\["USA","DEU"\\] | {"unit":"USD"} |']);
    expect(textOf(result)).not.toContain('[object Object]');
  });

  it('names the columns of a zero-row result on both surfaces', async () => {
    canvasAnswering(async () => ({ rows: [], rowCount: 0, columns: ['country', 'value'] }));

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    expect(result.isError).toBeUndefined();
    expect(structuredOf(result)).toMatchObject({
      row_count: 0,
      column_names: ['country', 'value'],
    });
    expect(textOf(result)).toContain('0 rows');
    expect(textOf(result)).toContain('Columns: country, value');
  });
});

describe('oecdDataframeQuery limit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  it('passes a row limit of 100 to the canvas when limit is omitted', async () => {
    const instance = canvasAnswering(async () => canvasResult([{ n: 1 }]));

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    expect(result.isError).toBeUndefined();
    expect(instance.query).toHaveBeenCalledWith(SQL, expect.objectContaining({ rowLimit: 100 }));
  });

  it.each([1, 250, 1000])('serves limit %i as asked', async (limit) => {
    const instance = canvasAnswering(async () => canvasResult([{ n: 1 }]));

    const result = await runToolContract(oecdDataframeQuery, {
      canvas_id: CANVAS_ID,
      sql: SQL,
      limit,
    });

    expect(result.isError).toBeUndefined();
    expect(instance.query).toHaveBeenCalledWith(SQL, expect.objectContaining({ rowLimit: limit }));
    expect(structuredOf(result).notice).toBeUndefined();
  });

  it.each([1001, 5000, 10_000])(
    'serves limit %i at 1000 and names both values on both surfaces',
    async (limit) => {
      const instance = canvasAnswering(async () => canvasResult([{ n: 1 }]));

      const result = await runToolContract(oecdDataframeQuery, {
        canvas_id: CANVAS_ID,
        sql: SQL,
        limit,
      });

      expect(result.isError).toBeUndefined();
      expect(instance.query).toHaveBeenCalledWith(SQL, expect.objectContaining({ rowLimit: 1000 }));
      const notice = structuredOf(result).notice;
      expect(notice).toContain(`\`limit\` ${limit}`);
      expect(notice).toContain('served 1000');
      expect(textOf(result)).toContain(`${limit} is above`);
    },
  );

  it.each([
    [0, /too small/i],
    [10_001, /too big/i],
    [1.5, /int/i],
  ])('rejects limit %s at argument validation', async (limit, issue) => {
    const instance = canvasAnswering(async () => canvasResult([{ n: 1 }]));

    const result = await runToolContract(oecdDataframeQuery, {
      canvas_id: CANVAS_ID,
      sql: SQL,
      limit,
    });

    const error = structuredOf(result).error;
    expect(result.isError).toBe(true);
    expect(error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error?.message).toMatch(issue);
    expect(instance.query).not.toHaveBeenCalled();
  });

  it('advertises the 1–10,000 bounds and the default in the input schema', () => {
    const schema = z.toJSONSchema(oecdDataframeQuery.input, { io: 'input' });

    expect(schema.properties?.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 10_000,
      default: 100,
    });
    expect(schema.required ?? []).not.toContain('limit');
  });
});

describe('oecdDataframeQuery truncation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  it('forwards the canvas truncated flag with a notice naming every way to the rest', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ n: i }));
    canvasAnswering(async () => canvasResult(rows, true));

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    const structured = structuredOf(result);
    expect(structured.truncated).toBe(true);
    expect(structured.row_count).toBe(100);
    expect(structured.rows).toEqual(rows);
    expect(structured.notice).toContain('aggregate');
    expect(structured.notice).toContain('`ORDER BY … LIMIT … OFFSET`');
    expect(structured.notice).toContain('raise `limit`');
    const text = textOf(result);
    expect(text).toContain('Result truncated');
    expect(text).toContain('100 rows');
    expect(text).toContain('raise `limit`');
  });

  it('drops the raise-limit lever once the served limit is the per-call maximum', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    canvasAnswering(async () => canvasResult(rows, true));

    const result = await runToolContract(oecdDataframeQuery, {
      canvas_id: CANVAS_ID,
      sql: SQL,
      limit: 1000,
    });

    const structured = structuredOf(result);
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toContain('`ORDER BY … LIMIT … OFFSET`');
    expect(structured.notice).not.toContain('raise');
  });

  it('omits truncated and the notice on a complete result', async () => {
    canvasAnswering(async () => canvasResult([{ n: 1 }, { n: 2 }]));

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    const structured = structuredOf(result);
    expect(structured).not.toHaveProperty('truncated');
    expect(structured).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('truncated');
  });

  it('renders every returned row in content[], in order, past 50 rows', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ n: i, label: `row ${i}` }));
    canvasAnswering(async () => canvasResult(rows));

    const result = await runToolContract(oecdDataframeQuery, {
      canvas_id: CANVAS_ID,
      sql: SQL,
      limit: 500,
    });

    const lines = tableRowsOf(result);
    expect(structuredOf(result).rows).toHaveLength(120);
    expect(lines).toHaveLength(120);
    expect(lines[0]).toBe('| 0 | row 0 |');
    expect(lines[50]).toBe('| 50 | row 50 |');
    expect(lines.at(-1)).toBe('| 119 | row 119 |');
    expect(textOf(result)).not.toContain('Showing 50');
  });
});

describe('oecdDataframeQuery response budget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  it('stops adding rows before the one that would pass 1 MiB of row data', async () => {
    // 1 MiB holds 20 of these rows and not 21, whichever surface is counted.
    const rows = Array.from({ length: 40 }, () => ({ label: 'x'.repeat(50_000) }));
    canvasAnswering(async () => canvasResult(rows));

    const result = await runToolContract(oecdDataframeQuery, {
      canvas_id: CANVAS_ID,
      sql: SQL,
      limit: 1000,
    });

    const structured = structuredOf(result);
    expect(structured.rows).toHaveLength(20);
    expect(structured.row_count).toBe(20);
    expect(structured.truncated).toBe(true);
    expect(utf8(JSON.stringify(structured.rows))).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(tableRowsOf(result)).toHaveLength(20);
    expect(structured.notice).toContain('1 MiB');
    expect(structured.notice).toContain('fewer or narrower columns');
    // A larger limit cannot reach rows the byte budget cut.
    expect(structured.notice).not.toContain('raise');
    expect(textOf(result)).toContain('Result truncated');
  });

  it('counts a row against the rendered table when that is the larger surface', async () => {
    // The escaped table line is the larger surface for these rows, so it decides where they stop.
    const rows = Array.from({ length: 40 }, () => ({ label: '*'.repeat(50_000) }));
    canvasAnswering(async () => canvasResult(rows));

    const result = await runToolContract(oecdDataframeQuery, {
      canvas_id: CANVAS_ID,
      sql: SQL,
      limit: 1000,
    });

    const structured = structuredOf(result);
    expect(structured.rows).toHaveLength(10);
    expect(structured.truncated).toBe(true);
    expect(utf8(tableRowsOf(result).join('\n'))).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it('returns no rows, never a clipped value, when the first row alone passes the budget', async () => {
    canvasAnswering(async () => canvasResult([{ label: 'x'.repeat(1_100_000) }, { label: 'y' }]));

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    const structured = structuredOf(result);
    expect(structured.rows).toEqual([]);
    expect(structured.row_count).toBe(0);
    expect(structured.truncated).toBe(true);
    expect(structured.column_names).toEqual(['label']);
    expect(structured.notice).toContain('fewer or narrower columns');
    const text = textOf(result);
    expect(text).toContain('Result truncated');
    expect(text).toContain('label');
    expect(text).not.toContain('returned 0 rows');
    expect(utf8(text)).toBeLessThan(4096);
  });
});

describe('oecdDataframeQuery deadline', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  // The deadline spies hold aborted signals; no later suite may inherit one.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops a query still running at 30 seconds with query_timeout', async () => {
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let inFlight!: () => void;
    const started = new Promise<void>((resolve) => {
      inFlight = resolve;
    });
    canvasAnswering((_sql, options) => {
      inFlight();
      return untilAborted(options.signal);
    });

    const pending = runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });
    await started;
    expect(timer).toHaveBeenCalledWith(30_000);
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    const result = await pending;

    const error = structuredOf(result).error;
    expect(result.isError).toBe(true);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'query_timeout',
        recovery: { hint: declaredRecovery(oecdDataframeQuery, 'query_timeout') },
      },
    });
    expect(error?.message).toContain('30 seconds');
    expect(textOf(result)).toContain(declaredRecovery(oecdDataframeQuery, 'query_timeout'));
  });

  it('leaves a caller abort as RequestCancelled even when the deadline fired with it', async () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    canvasAnswering((_sql, options) => {
      caller.abort();
      deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      return untilAborted(options.signal);
    });

    const result = await runToolContract(
      oecdDataframeQuery,
      { canvas_id: CANVAS_ID, sql: SQL },
      { context: { signal: caller.signal } },
    );

    const error = structuredOf(result).error;
    expect(result.isError).toBe(true);
    expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error?.message).toContain('Canvas query was cancelled');
    expect(error?.message).not.toContain('30 seconds');
    expect(textOf(result)).toContain('Canvas query was cancelled');
    expect(textOf(result)).not.toContain('query_timeout');
  });
});

describe('oecdDataframeQuery engine error messages', () => {
  /** The most characters of an engine error's message one reply or log record carries. */
  const ENGINE_MESSAGE_CAP = 2000;
  const CUT_MARKER = '… [cut at 2000 characters]';
  /** Closes every engine message below, so a message relayed whole carries it and a cut one does not. */
  const TAIL = 'END-OF-ENGINE-MESSAGE';

  /** An engine message exactly `length` characters long, ending in {@link TAIL}. */
  const engineMessage = (length: number) =>
    `Engine Error: ${'v'.repeat(length - 'Engine Error: '.length - TAIL.length)}${TAIL}`;

  /** Each path an engine message leaves the handler by: the error the canvas throws, and how the reply carries it. */
  const PATHS = [
    {
      path: 'sql_execution_error',
      engineError: (message: string) =>
        validationError(
          message,
          { reason: DUCKDB_ERROR_REASONS.sqlExecutionError },
          { cause: new Error(message) },
        ),
      code: JsonRpcErrorCode.ValidationError,
      prefix: '',
      data: { reason: 'sql_execution_error' },
    },
    {
      path: 'invalid_sql',
      engineError: (message: string) =>
        validationError(
          message,
          { reason: 'invalid_sql', binderMessage: message },
          { cause: new Error(message) },
        ),
      code: JsonRpcErrorCode.ValidationError,
      prefix: 'SQL rejected: ',
      data: { reason: 'invalid_sql' },
    },
    {
      path: 'an engine fault',
      engineError: (message: string) =>
        databaseError(message, { engine: 'duckdb' }, { cause: new Error(message) }),
      code: JsonRpcErrorCode.DatabaseError,
      prefix: '',
      data: { engine: 'duckdb' },
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PATHS)(
    'relays at most 2,000 characters of an engine error as $path, on both surfaces',
    async ({ engineError, code, prefix, data }) => {
      const message = engineMessage(ENGINE_MESSAGE_CAP + 1000);
      canvasAnswering(() => Promise.reject(engineError(message)));

      const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

      const relayed = `${prefix}${message.slice(0, ENGINE_MESSAGE_CAP)}${CUT_MARKER}`;
      const error = structuredOf(result).error;
      expect(result.isError).toBe(true);
      expect(error?.code).toBe(code);
      expect(error?.message).toBe(relayed);
      expect(error?.data).toMatchObject(data);
      expect(textOf(result)).toContain(escapeMarkdownInline(relayed));
      expect(JSON.stringify(result)).not.toContain(TAIL);
    },
  );

  it.each(PATHS)(
    'relays an engine error of exactly 2,000 characters as $path unchanged',
    async ({ engineError, code, prefix }) => {
      const message = engineMessage(ENGINE_MESSAGE_CAP);
      canvasAnswering(() => Promise.reject(engineError(message)));

      const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

      const error = structuredOf(result).error;
      expect(error?.code).toBe(code);
      expect(error?.message).toBe(`${prefix}${message}`);
      expect(textOf(result)).toContain(escapeMarkdownInline(`${prefix}${message}`));
    },
  );

  it('relays at most 2,000 characters of an engine error without splitting a surrogate pair', async () => {
    // The pair straddles the cap: its high half is character 2,000.
    const message = `${'v'.repeat(ENGINE_MESSAGE_CAP - 1)}😀${'v'.repeat(100)}`;
    canvasAnswering(() =>
      Promise.reject(validationError(message, { reason: DUCKDB_ERROR_REASONS.sqlExecutionError })),
    );

    const result = await runToolContract(oecdDataframeQuery, { canvas_id: CANVAS_ID, sql: SQL });

    expect(structuredOf(result).error?.message).toBe(
      `${'v'.repeat(ENGINE_MESSAGE_CAP - 1)}${CUT_MARKER}`,
    );
  });

  it.each(PATHS)(
    'logs at most 2,000 characters of an engine error as $path',
    async ({ engineError }) => {
      const message = engineMessage(ENGINE_MESSAGE_CAP + 1000);
      canvasAnswering(() => Promise.reject(engineError(message)));
      let failure: unknown;
      try {
        await oecdDataframeQuery.handler(
          oecdDataframeQuery.input.parse({ canvas_id: CANVAS_ID, sql: SQL }),
          createMockContext({ errors: oecdDataframeQuery.errors }),
        );
      } catch (err) {
        failure = err;
      }
      const record = vi.spyOn(logger, 'error').mockImplementation(() => {});

      // The record the tool boundary writes for a failed call.
      ErrorHandler.handleError(failure, { operation: 'tool:oecd_dataframe_query' });

      expect(record).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(record.mock.calls);
      expect(logged).toContain(message.slice(0, ENGINE_MESSAGE_CAP));
      expect(logged).not.toContain(TAIL);
    },
  );
});

/** A real DuckDB canvas, so `truncated` is the provider's own flag rather than a fixture's. */
describe('oecdDataframeQuery against a real canvas', () => {
  const ctx = createMockContext({ tenantId: 'default' });
  let scratch: string;

  /** A canvas whose provider caps a query at `rowLimit`, holding table `t` of `rows` rows. */
  async function stage(rowLimit: number, rows: number) {
    const provider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: scratch,
      tempRootPath: scratch,
      defaultRowLimit: rowLimit,
      schemaSniffRows: 100,
    });
    const registry = new CanvasRegistry(provider, {
      ...DEFAULT_CANVAS_REGISTRY_OPTIONS,
      sweeperIntervalMs: 0,
    });
    const canvas = new DataCanvas(provider, registry);
    const instance = await canvas.acquire(undefined, ctx);
    await instance.registerTable(
      't',
      Array.from({ length: rows }, (_, n) => ({ n })),
      { schema: [{ name: 'n', type: 'INTEGER' }] },
    );
    setCanvas(canvas);
    return { canvas, canvasId: instance.canvasId };
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'oecd-query-test-'));
    // Pays the native binding load once, outside any test's timeout.
    const { canvas } = await stage(10_000, 1);
    await canvas.shutdown(ctx);
  }, 60_000);

  afterEach(() => {
    setCanvas(undefined);
    resetConfig();
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('forwards truncated from the canvas, and omits it at and under the limit', async () => {
    const { canvas, canvasId } = await stage(10_000, 150);
    try {
      const capped = await runToolContract(oecdDataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT n FROM t ORDER BY n',
      });
      expect(structuredOf(capped)).toMatchObject({ row_count: 100, truncated: true });
      expect(structuredOf(capped).rows.at(-1)).toEqual({ n: 99 });
      expect(tableRowsOf(capped)).toHaveLength(100);

      const exact = await runToolContract(oecdDataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT n FROM t ORDER BY n LIMIT 100',
      });
      expect(structuredOf(exact).row_count).toBe(100);
      expect(structuredOf(exact)).not.toHaveProperty('truncated');

      const whole = await runToolContract(oecdDataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT n FROM t ORDER BY n',
        limit: 150,
      });
      expect(structuredOf(whole).row_count).toBe(150);
      expect(structuredOf(whole)).not.toHaveProperty('truncated');
    } finally {
      await canvas.shutdown(ctx);
    }
  });

  it('serves no more than a canvas row limit set below 1000', async () => {
    resetConfig({ CANVAS_DEFAULT_ROW_LIMIT: '500' });
    const { canvas, canvasId } = await stage(500, 700);
    try {
      const result = await runToolContract(oecdDataframeQuery, {
        canvas_id: canvasId,
        sql: 'SELECT n FROM t ORDER BY n',
        limit: 800,
      });

      const structured = structuredOf(result);
      expect(result.isError).toBeUndefined();
      expect(structured.row_count).toBe(500);
      expect(structured.truncated).toBe(true);
      expect(structured.notice).toContain('`limit` 800');
      expect(structured.notice).toContain('served 500');
      expect(structured.notice).not.toContain('raise');
    } finally {
      await canvas.shutdown(ctx);
    }
  });
});
