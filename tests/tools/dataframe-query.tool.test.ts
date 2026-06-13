/**
 * @fileoverview Tests for oecd_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';

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
    const input = oecdDataframeQuery.input.parse({
      canvas_id: 'expired-001',
      sql: 'SELECT 1',
    });
    await expect(oecdDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('throws ctx.fail(invalid_sql) when query throws a SQL parse error', async () => {
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi
      .fn()
      .mockRejectedValue(new Error('Parser Error: syntax error at or near "INVALID"'));
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

  it('throws ctx.fail(invalid_sql) when query throws a "not allowed" error', async () => {
    const mockInstance = buildMockInstance('canvas-001', null);
    mockInstance.query = vi
      .fn()
      .mockRejectedValue(new Error('DDL operations not allowed — only SELECT is permitted'));
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
