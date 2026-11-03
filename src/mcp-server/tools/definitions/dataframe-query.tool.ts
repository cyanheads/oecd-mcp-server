/**
 * @fileoverview oecd_dataframe_query — run read-only SQL against DataCanvas tables from oecd_query_dataset.
 * @module mcp-server/tools/definitions/dataframe-query.tool
 */

import { Buffer } from 'node:buffer';
import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type CanvasInstance,
  DUCKDB_ERROR_REASONS,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { formatTable } from '@/utils/format-table.js';

type Row = Record<string, unknown>;

/** Rows one call returns when the caller sets no `limit`. */
const DEFAULT_LIMIT = 100;

/** Most rows one call returns; a larger `limit` is served at this. */
const MAX_ROWS_PER_CALL = 1000;

/** Largest `limit` accepted at all — the ceiling against absurd input. */
const LIMIT_CEILING = 10_000;

/**
 * UTF-8 bytes of row data each surface may carry in one response: the size
 * bound beside `limit`'s count bound, so a response stays bounded whatever the
 * result holds.
 */
const ROW_BUDGET_BYTES = 1_048_576;

/** How long a query may run before it is stopped — inside a 60 s client request timeout. */
const QUERY_DEADLINE_MS = 30_000;

/** The SQL paging clause, as every notice prints it. */
const PAGING = '`ORDER BY … LIMIT … OFFSET`';

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** A cell as the table shows it: nested values as JSON, null as empty. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Bytes `row` adds to the larger of the two surfaces: its JSON in
 * `structuredContent.rows` with its separator, or its line in the rendered
 * table — a Markdown table row, or, when a multi-line cell turns the table into
 * a JSON block, a pretty-printed array (its compact JSON plus 7 bytes of
 * indentation per cell and 11 per row). The rendered side is only measured
 * when the JSON side still fits `remaining`, since the row is out either way.
 */
function rowBytes(row: Row, columns: readonly string[], remaining: number): number {
  const json = utf8Bytes(JSON.stringify(row)) + 1;
  if (json > remaining) return json;
  const cells = columns.map((column) => cellText(row[column]));
  const markdown = utf8Bytes(`| ${cells.map(escapeMarkdownInline).join(' | ')} |`) + 1;
  const jsonBlock = utf8Bytes(JSON.stringify(cells)) + 7 * cells.length + 11;
  return Math.max(json, markdown, jsonBlock);
}

/** Number of leading rows whose bytes fit {@link ROW_BUDGET_BYTES} on both surfaces. */
function rowsWithinBudget(rows: readonly Row[], columns: readonly string[]): number {
  // The enclosing brackets of `rows`, less the separator the last row does not carry.
  let spent = 1;
  for (const [index, row] of rows.entries()) {
    spent += rowBytes(row, columns, ROW_BUDGET_BYTES - spent);
    if (spent > ROW_BUDGET_BYTES) return index;
  }
  return rows.length;
}

export const oecdDataframeQuery = tool('oecd_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against OECD observation tables staged on a DataCanvas by oecd_query_dataset. Call oecd_dataframe_describe first to discover exact table and column names, then use this tool for aggregation, filtering, GROUP BY, JOIN, and window functions. Returns up to `limit` rows (default 100, at most 1,000 per call) and at most 1 MiB of row data; truncated: true marks a result with more rows than came back, and its notice says how to reach the rest. A query still running after 30 seconds is stopped. Unavailable when the server runs with DataCanvas disabled.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by oecd_query_dataset — exactly 10 characters of letters, digits, ' +
        'hyphens, and underscores. Identifies the DataCanvas session holding the observation tables.',
    ),
    sql: z
      .string()
      .describe(
        'Read-only SELECT statement. Reference tables by the names returned by oecd_dataframe_describe. ' +
          'Only SELECT statements are allowed — DDL, DML, and file-reading functions are rejected.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .default(DEFAULT_LIMIT)
      .describe(
        'Most rows to return. Default 100; served up to 1,000 per call, so a value from 1,001 to 10,000 returns at most 1,000 rows and a notice saying so. Fewer come back when the rows would pass 1 MiB of row data. For more rows than one call returns, aggregate in SQL or page with ORDER BY … LIMIT … OFFSET.',
      ),
  }),
  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows in query order: at most limit rows (1,000 per call) and at most 1 MiB of row data. When truncated is true the result has more rows than these.',
      ),
    row_count: z
      .number()
      .describe('Number of rows returned — the length of rows, never the size of the full result.'),
    column_names: z.array(z.string()).describe('Column names in the result, in order.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the result has more rows than this call returned — cut at limit or at the 1 MiB row-data budget; the notice says how to reach the rest. Omitted (never false) when rows is the complete result.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a requested limit was above the per-call maximum (naming the limit requested and the one served), or when truncated is true (naming the ways to reach the rows not returned).',
      ),
  },
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured — CANVAS_PROVIDER_TYPE=none.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb to enable DataCanvas, then retry.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id has expired or was never created.',
      recovery:
        'The canvas and its tables are gone. Re-run the oecd_query_dataset calls that staged them — a result that spills comes back with a fresh canvas_id — then pass that canvas_id here.',
    },
    {
      reason: 'table_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL names a table this canvas does not hold — it expired, was dropped, or the name is wrong.',
      recovery:
        'Call oecd_dataframe_describe with this canvas_id for the tables it currently holds, ' +
        'then retry with one of those names — or re-run oecd_query_dataset to stage a fresh canvas.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not a valid SELECT statement or contains disallowed operations.',
      recovery:
        'Provide a read-only SELECT statement. Only SELECT is allowed — ' +
        'DDL (CREATE, DROP), DML (INSERT, UPDATE, DELETE), ' +
        'and file-reading functions (read_csv, read_parquet) are rejected.',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL parsed and ran, then failed on the staged observation data — a conversion, an invalid input, or a value out of range.',
      recovery:
        'Read the message for the offending value, then wrap the conversion in TRY_CAST or ' +
        'filter those rows out before converting. Observation columns are staged as VARCHAR ' +
        'unless they are numeric, and an attribute column is null on the rows that omit it.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: false,
      when: 'The query was still running after 30 seconds and was stopped.',
      recovery:
        'Narrow the query — filter rows, select fewer columns, or aggregate — so it completes within 30 seconds.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use oecd_dataframe_query.',
      );
    }

    /**
     * The canvas rejects a rowLimit above its own configured cap as a
     * ValidationError, which the catch below would report as invalid_sql — so
     * the most this call serves is the smaller of the two.
     */
    const maxRows = Math.min(MAX_ROWS_PER_CALL, config.canvas.defaultRowLimit);
    const rowLimit = Math.min(input.limit, maxRows);

    ctx.log.info('Running DataCanvas SQL', {
      canvasId: input.canvas_id,
      sqlLength: input.sql.length,
      rowLimit,
    });

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      throw ctx.fail(
        'canvas_not_found',
        `Canvas "${input.canvas_id}" not found or expired`,
        undefined,
        { cause: err as Error },
      );
    }

    const deadline = AbortSignal.timeout(QUERY_DEADLINE_MS);
    let queryResult: QueryResult;
    try {
      queryResult = await instance.query(input.sql, {
        signal: AbortSignal.any([ctx.signal, deadline]),
        rowLimit,
        denySystemCatalogs: true,
      });
    } catch (err) {
      // A caller abort is never absorbed: it falls through to the framework as RequestCancelled.
      if (deadline.aborted && !ctx.signal.aborted) {
        throw ctx.fail(
          'query_timeout',
          `Query on canvas "${input.canvas_id}" was stopped after 30 seconds.`,
          undefined,
          { cause: err },
        );
      }
      /**
       * Canvas rejections are structured, so dispatch on the reason and the code
       * rather than on message text. A missing table is a NotFound carrying
       * `reason: 'missing_table'`; every other gate rejection is a
       * ValidationError. Anything else — a DuckDB engine fault, a cancelled
       * query — is not the caller's SQL and is left to the framework.
       */
      if (err instanceof McpError) {
        if (err.data?.reason === 'missing_table') {
          const table = err.data.tableName;
          throw ctx.fail(
            'table_not_found',
            `Canvas "${input.canvas_id}" holds no table` +
              (typeof table === 'string' ? ` named "${table}"` : ' matching the query'),
            undefined,
            { cause: err },
          );
        }
        /**
         * A statement that prepared and then failed on the data is not a
         * rejected statement. Both arrive as ValidationError, so they are told
         * apart by the engine reason — and they need opposite advice:
         * `invalid_sql` says "send a read-only SELECT", which this caller
         * already did.
         */
        if (err.data?.reason === DUCKDB_ERROR_REASONS.sqlExecutionError) {
          throw ctx.fail('sql_execution_error', err.message, undefined, { cause: err });
        }
        if (err.code === JsonRpcErrorCode.ValidationError) {
          throw ctx.fail('invalid_sql', `SQL rejected: ${err.message}`, undefined, { cause: err });
        }
      }
      throw err;
    }

    const firstRow = queryResult.rows[0];
    const columnNames = firstRow !== undefined ? Object.keys(firstRow) : queryResult.columns;
    const fit = rowsWithinBudget(queryResult.rows, columnNames);
    const rows = queryResult.rows.slice(0, fit);
    const budgetCut = fit < queryResult.rows.length;
    const truncated = budgetCut || queryResult.truncated === true;

    /** One notice — the framework keeps only the last one written. */
    const notes: string[] = [];
    if (input.limit > maxRows) {
      notes.push(
        `\`limit\` ${input.limit} is above the per-call maximum of ${maxRows}; served ${maxRows}.`,
      );
    }
    if (budgetCut && fit === 0) {
      notes.push(
        'No rows returned: the first row alone is larger than the 1 MiB row-data budget. Select fewer or narrower columns, or aggregate.',
      );
    } else if (budgetCut) {
      notes.push(
        `Stopped at ${fit} rows, the most that fit the 1 MiB row-data budget. To reach the rest, select fewer or narrower columns, aggregate, or page ${fit} rows at a time with ${PAGING}.`,
      );
    } else if (truncated) {
      notes.push(
        rowLimit < maxRows
          ? `More rows match than the ${rows.length} returned. To reach the rest, aggregate, page with ${PAGING}, or raise \`limit\` (up to ${maxRows}).`
          : `More rows match than the ${rows.length} returned. To reach the rest, aggregate or page with ${PAGING}.`,
      );
    }
    if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

    ctx.log.info('DataCanvas query complete', {
      rowCount: rows.length,
      columnCount: columnNames.length,
      truncated,
    });

    return {
      rows,
      row_count: rows.length,
      column_names: columnNames,
      ...(truncated && { truncated: true }),
    };
  },

  format: (result) => {
    const cols = result.column_names;
    if (result.rows.length === 0 && !result.truncated) {
      const text =
        cols.length > 0
          ? `SQL query returned 0 rows.\n\nColumns: ${cols.map(escapeMarkdownInline).join(', ')}`
          : 'SQL query returned 0 rows.';
      return [{ type: 'text', text }];
    }

    const lines = [`**Query Result** — ${result.row_count} rows`];
    if (result.truncated) {
      lines.push('', `> Result truncated — ${result.row_count} rows shown; the result has more.`);
    }
    lines.push(
      '',
      result.rows.length > 0
        ? formatTable(
            cols,
            result.rows.map((r) => cols.map((c) => cellText(r[c]))),
          )
        : `Columns: ${cols.map(escapeMarkdownInline).join(', ')}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
