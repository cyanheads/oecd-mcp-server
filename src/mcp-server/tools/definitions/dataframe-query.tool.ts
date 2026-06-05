/**
 * @fileoverview oecd_dataframe_query — run read-only SQL against DataCanvas tables from oecd_query_dataset.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';

export const oecdDataframeQuery = tool('oecd_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against OECD observation tables staged on a DataCanvas by oecd_query_dataset. ' +
    'Call oecd_dataframe_describe first to discover exact table and column names, then use this tool for aggregation, filtering, GROUP BY, JOIN, and window functions. ' +
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
          'Identifies the DataCanvas session holding the observation tables.',
      ),
    sql: z
      .string()
      .describe(
        'Read-only SELECT statement. Reference tables by the names returned by oecd_dataframe_describe. ' +
          'Only SELECT statements are allowed — DDL, DML, and file-reading functions are rejected.',
      ),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Result rows from the SQL query (capped at the canvas row limit).'),
    row_count: z.number().describe('Full result count before any row cap.'),
    column_names: z.array(z.string()).describe('Column names in the result, in order.'),
  }),
  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id has expired or was never created.',
      recovery:
        'Re-run oecd_query_dataset to create a fresh canvas, then pass the returned canvas_id here.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The SQL is not a valid SELECT statement or contains disallowed operations.',
      recovery:
        'Provide a read-only SELECT statement. Only SELECT is allowed — ' +
        'DDL (CREATE, DROP), DML (INSERT, UPDATE, DELETE), ' +
        'and file-reading functions (read_csv, read_parquet) are rejected.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw serviceUnavailable(
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use oecd_dataframe_query.',
      );
    }

    ctx.log.info('Running DataCanvas SQL', {
      canvasId: input.canvas_id,
      sqlLength: input.sql.length,
    });

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

    let queryResult: QueryResult;
    try {
      queryResult = await instance.query(input.sql, { signal: ctx.signal });
    } catch (err) {
      const e = err as Error;
      // Canvas enforces read-only — classification is a ValidationError from the 4-layer gate
      if (
        e.message?.toLowerCase().includes('select') ||
        e.message?.toLowerCase().includes('not allowed') ||
        e.message?.toLowerCase().includes('ddl') ||
        e.message?.toLowerCase().includes('invalid') ||
        e.message?.toLowerCase().includes('parse') ||
        (e as { code?: number }).code === JsonRpcErrorCode.ValidationError
      ) {
        throw ctx.fail(
          'invalid_sql',
          `SQL rejected: ${e.message}`,
          { ...ctx.recoveryFor('invalid_sql') },
          { cause: e },
        );
      }
      throw err;
    }

    const firstRow = queryResult.rows[0];
    const columnNames = firstRow !== undefined ? Object.keys(firstRow) : [];

    ctx.log.info('DataCanvas query complete', {
      rowCount: queryResult.rowCount,
      columnCount: columnNames.length,
    });

    return {
      rows: queryResult.rows,
      row_count: queryResult.rowCount,
      column_names: columnNames,
    };
  },

  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: 'SQL query returned 0 rows.' }];
    }

    const cols = result.column_names;
    const header = `| ${cols.join(' | ')} |`;
    const divider = `| ${cols.map(() => '---').join(' | ')} |`;
    const rows = result.rows
      .slice(0, 50)
      .map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);

    const lines = [
      `**Query Result** — ${result.row_count} rows`,
      '',
      header,
      divider,
      ...rows,
      result.row_count > 50 ? `\n_(Showing 50 of ${result.row_count} rows)_` : '',
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
