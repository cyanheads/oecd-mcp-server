/**
 * @fileoverview Tests for oecd_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { DUCKDB_ERROR_REASONS } from '@cyanheads/mcp-ts-core/canvas';
import {
  databaseError,
  JsonRpcErrorCode,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { toolWireError } from '../helpers/error-contract.js';

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
});
