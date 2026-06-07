/**
 * @fileoverview oecd_dataframe_describe — list DataCanvas tables and columns from a prior oecd_query_dataset spill.
 * @module mcp-server/tools/definitions/dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';

export const oecdDataframeDescribe = tool('oecd_dataframe_describe', {
  description:
    'List tables and columns staged on a DataCanvas by a prior oecd_query_dataset spill. ' +
    'Call this before oecd_dataframe_query to discover exact table and column names for SQL. ' +
    'Only available when CANVAS_PROVIDER_TYPE=duckdb is set.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by oecd_query_dataset. ' +
          'Identifies the DataCanvas session holding the staged observation tables.',
      ),
  }),
  output: z.object({
    canvas_id: z.string().describe('The canvas ID whose tables are listed.'),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name — use in SQL FROM clauses.'),
            kind: z.string().describe('Object kind: "table" or "view".'),
            row_count: z.number().describe('Number of rows in the table.'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('DuckDB column type — e.g. VARCHAR, DOUBLE, BIGINT.'),
                  })
                  .describe('A column in the table with its DuckDB type.'),
              )
              .describe('Columns in the table.'),
          })
          .describe('A canvas table or view with row count and column schema.'),
      )
      .describe('Tables and views staged on this canvas.'),
    table_count: z.number().describe('Total number of tables and views.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured — CANVAS_PROVIDER_TYPE is unset.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb to enable DataCanvas, then retry.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id has expired or was never created.',
      recovery:
        'Re-run oecd_query_dataset to create a fresh canvas, then pass the returned canvas_id here.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use oecd_dataframe_describe.',
        { ...ctx.recoveryFor('canvas_disabled') },
      );
    }

    ctx.log.info('Describing DataCanvas', { canvasId: input.canvas_id });

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      throw ctx.fail(
        'canvas_not_found',
        `Canvas "${input.canvas_id}" not found or expired`,
        { ...ctx.recoveryFor('canvas_not_found') },
        { cause: err as Error },
      );
    }

    const tableInfos = await instance.describe();

    return {
      canvas_id: instance.canvasId,
      tables: tableInfos.map((t) => ({
        name: t.name,
        kind: t.kind,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
      table_count: tableInfos.length,
    };
  },

  format: (result) => {
    const sections = result.tables.map((t) => {
      const colList = t.columns.map((c) => `  - ${c.name}: ${c.type}`).join('\n');
      return `**${t.name}** (${t.kind}, ${t.row_count} rows)\n${colList}`;
    });

    const lines = [
      `**DataCanvas ${result.canvas_id}** — ${result.table_count} table(s)`,
      '',
      ...(sections.length > 0 ? sections : ['_(no tables staged)_']),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
