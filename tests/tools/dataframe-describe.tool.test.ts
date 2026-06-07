/**
 * @fileoverview Tests for oecd_dataframe_describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { setCanvas } from '@/services/canvas-accessor/canvas-accessor.js';

function buildMockInstance(canvasId: string, tables: unknown[]) {
  return {
    canvasId,
    describe: vi.fn().mockResolvedValue(tables),
    query: vi.fn(),
    registerTable: vi.fn(),
    export: vi.fn(),
    registerView: vi.fn(),
    importFrom: vi.fn(),
    drop: vi.fn(),
  };
}

describe('oecdDataframeDescribe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCanvas(undefined);
  });

  it('throws ctx.fail(canvas_disabled) when canvas is not configured', async () => {
    setCanvas(undefined);
    const ctx = createMockContext({ errors: oecdDataframeDescribe.errors });
    const input = oecdDataframeDescribe.input.parse({ canvas_id: 'canvas-001' });
    await expect(oecdDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('returns table list for a valid canvas_id', async () => {
    const mockTableInfos = [
      {
        name: 'spilled_abc123',
        kind: 'table',
        rowCount: 380,
        columns: [
          { name: 'FREQ', type: 'VARCHAR' },
          { name: 'REF_AREA', type: 'VARCHAR' },
          { name: 'value', type: 'DOUBLE' },
        ],
      },
    ];
    const mockInstance = buildMockInstance('canvas-001', mockTableInfos);
    const mockCanvas = {
      acquire: vi.fn().mockResolvedValue(mockInstance),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeDescribe.errors });
    const input = oecdDataframeDescribe.input.parse({ canvas_id: 'canvas-001' });
    const result = await oecdDataframeDescribe.handler(input, ctx);

    expect(result.canvas_id).toBe('canvas-001');
    expect(result.table_count).toBe(1);
    expect(result.tables[0]).toMatchObject({
      name: 'spilled_abc123',
      kind: 'table',
      row_count: 380,
    });
    expect(result.tables[0]?.columns).toHaveLength(3);
    expect(result.tables[0]?.columns[0]).toEqual({ name: 'FREQ', type: 'VARCHAR' });
  });

  it('throws ctx.fail(canvas_not_found) when acquire throws', async () => {
    const mockCanvas = {
      acquire: vi.fn().mockRejectedValue(new Error('canvas expired or not found')),
    };
    setCanvas(mockCanvas as never);

    const ctx = createMockContext({ errors: oecdDataframeDescribe.errors });
    const input = oecdDataframeDescribe.input.parse({ canvas_id: 'expired-001' });
    await expect(oecdDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('formats output listing tables and columns', () => {
    const output = {
      canvas_id: 'canvas-001',
      tables: [
        {
          name: 'spilled_abc',
          kind: 'table',
          row_count: 380,
          columns: [
            { name: 'FREQ', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE' },
          ],
        },
      ],
      table_count: 1,
    };
    const blocks = oecdDataframeDescribe.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('canvas-001');
    expect(text).toContain('spilled_abc');
    expect(text).toContain('FREQ');
    expect(text).toContain('value');
    expect(text).toContain('380');
  });

  it('formats output with no-tables message when empty', () => {
    const output = {
      canvas_id: 'canvas-empty',
      tables: [],
      table_count: 0,
    };
    const blocks = oecdDataframeDescribe.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('no tables staged');
  });
});
