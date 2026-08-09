/**
 * @fileoverview oecd_query_dataset — fetch observations from an OECD dataflow with DataCanvas spillover.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { type ColumnSchema, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import {
  getDataService,
  invalidQueryText,
  throttleText,
} from '@/services/oecd-data/oecd-data-service.js';
import type { OecdDataResult } from '@/services/oecd-data/types.js';
import {
  isDataflowNotFound,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';

/** A decoded observation row as it leaves the handler. */
type OutputRow = Record<string, string | number | null>;

/**
 * Character budget for the inline preview, counted the way `spillover()`
 * counts it — the accumulated `JSON.stringify` length of the rows drained so
 * far. One constant drives both paths, so the preview is the same size whether
 * or not a canvas is configured; only the fate of the remainder differs.
 */
const PREVIEW_CHARS = 100_000;

/**
 * Number of leading rows whose serialized length fits {@link PREVIEW_CHARS}.
 * The first row that crosses the budget is excluded, matching `spillover()`,
 * so a spilled preview and an inline one cut at the same row. Applied to a
 * preview that already came back from `spillover()` it is a no-op.
 */
function previewRowCount(rows: readonly OutputRow[]): number {
  let chars = 0;
  for (const [index, row] of rows.entries()) {
    chars += JSON.stringify(row).length;
    if (chars > PREVIEW_CHARS) return index;
  }
  return rows.length;
}

// Passthrough schema — dimension keys are dynamic per-dataflow and cannot be
// enumerated at schema definition time. z.object({}).passthrough() forwards all
// fields to structuredContent without linter false-positives for undefined keys.
const DecodedRowSchema = z
  .object({})
  .passthrough()
  .describe(
    'Decoded observation row. One key per dataflow dimension (e.g. REF_AREA, TIME_PERIOD) and ' +
      'per observation attribute (e.g. UNIT_MULT, OBS_STATUS, PRICE_BASE), each holding a ' +
      'human-readable label; attributes absent from this slice are omitted. Plus "value" — the ' +
      'observation already multiplied by "value_scale", the power of ten from UNIT_MULT (1 when ' +
      'the dataflow declares no multiplier; divide value by it for the figure as OECD published ' +
      'it) — and "source" ("OECD").',
  );

/** Words that only appear in OECD's period-format rejections, never its key-arity ones. */
const PERIOD_REJECTION = /\b(date|period)\b/i;

/**
 * Words that appear in OECD's response-size throttle and not in its
 * request-rate one. The two arrive as the same 429 and need opposite advice:
 * the rate limit clears on its own, the size limit only clears if the query
 * shrinks. An unrecognized throttle body falls back to the rate-limit reason,
 * whose recovery is the safe answer for either.
 */
const DOWNLOAD_THROTTLE = /\b(downloads?|data ranges?)\b/i;

/** Contract reasons for a query OECD parsed but declined to answer. */
type UpstreamReason =
  | 'download_limit'
  | 'rate_limited'
  | 'upstream_timeout'
  | 'upstream_unavailable';

/**
 * Reason for an upstream refusal the caller cannot fix by correcting the key
 * or the period. `throttle` is OECD's own throttle wording when it sent any;
 * otherwise the classification `fetchOecd` produced is what distinguishes a
 * timed-out request from an unreachable service.
 */
function upstreamReason(err: Error, throttle: string | undefined): UpstreamReason | undefined {
  if (throttle !== undefined) {
    return DOWNLOAD_THROTTLE.test(throttle) ? 'download_limit' : 'rate_limited';
  }
  if (!(err instanceof McpError)) return;
  if (err.code === JsonRpcErrorCode.Timeout) return 'upstream_timeout';
  if (err.code === JsonRpcErrorCode.ServiceUnavailable) return 'upstream_unavailable';
  return;
}

export const oecdQueryDataset = tool('oecd_query_dataset', {
  description:
    'Fetch observations from an OECD dataflow filtered by a dimension key and optional time range. ' +
    'Returns decoded rows (one per observation) with dimension and attribute labels, and values ' +
    'already scaled by the observation unit multiplier. ' +
    'Large multi-country time-series spill to a DataCanvas table — follow up with oecd_dataframe_query; ' +
    'without DataCanvas every row still comes back, but the rendered table stops at a preview slice. ' +
    'Call oecd_get_dataset_info first to learn the dimension order for constructing the key.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    flow_ref: z
      .string()
      .describe(
        'Full flow reference — e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I", or the bare ' +
          '"OECD.TAD.ARP,DF_AEI2024_DASHBOARD" form for a dataflow published without a ' +
          'datastructure prefix. Obtain from oecd_search_datasets and pass it through unchanged.',
      ),
    key: z
      .string()
      .describe(
        'Dot-delimited dimension key matching the dimension order from oecd_get_dataset_info. ' +
          'Empty segments are wildcards; "+" separates multiple values per segment. ' +
          'Example: "A.USA+DEU.B1GQ.." — Annual, USA or Germany, GDP, all remaining dimensions.',
      ),
    start_period: z
      .string()
      .optional()
      .describe(
        'Start of the time range — ISO period code such as "2010", "2010-Q1", or "2010-01". ' +
          'Omit to include all history (may produce very large results).',
      ),
    end_period: z
      .string()
      .optional()
      .describe(
        'End of the time range — ISO period code such as "2023" or "2023-Q4". ' +
          'Omit to include up to the latest available period.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID from a prior oecd_query_dataset call, to stage this result alongside that one. ' +
          'Omit to let the server mint a canvas if this result needs one — a canvas_id comes back ' +
          'only when the result was large enough to spill, never on a result that fits inline.',
      ),
  }),
  output: z.object({
    rows: z
      .array(DecodedRowSchema)
      .describe(
        'Observation rows. Every row of the result when truncated is absent; the leading preview ' +
          'slice when truncated is true — query the canvas table for the rest.',
      ),
    row_count: z.number().describe('Total rows in the result (or on the canvas when truncated).'),
    query_flow_ref: z.string().describe('Flow reference used in this query.'),
    query_key: z.string().describe('Dimension key used in this query.'),
    query_start_period: z
      .string()
      .optional()
      .describe('Start period filter applied in this query, if any.'),
    query_end_period: z
      .string()
      .optional()
      .describe('End period filter applied in this query, if any.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas handle for the staged result. Present only when DataCanvas is configured and the ' +
          'result exceeded the inline budget; absent when DataCanvas is off, and absent when it is ' +
          'on but the result fit inline. Pass to oecd_dataframe_query or oecd_dataframe_describe.',
      ),
    table_name: z
      .string()
      .optional()
      .describe('Canvas table name holding the full result — present when canvas_id is set.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows is a preview slice and the full result was staged on DataCanvas; omitted ' +
          'entirely (never false) when rows holds the complete result. Use oecd_dataframe_query ' +
          'with the canvas_id for analytics over the full set. A complete rows never means a ' +
          'complete rendered table — content_table_capped reports that separately.',
      ),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    content_table_capped: z
      .boolean()
      .optional()
      .describe(
        'True when the rendered table shows only the leading rows of the result. Distinct from ' +
          'truncated: nothing was staged anywhere, and structuredContent.rows still holds every ' +
          'row. To shrink the result itself, name fewer values per key segment or set a narrower ' +
          'start_period / end_period; to reach the full set as a queryable table instead, run ' +
          'with CANVAS_PROVIDER_TYPE=duckdb and follow up with oecd_dataframe_query.',
      ),
    content_table_rows: z
      .number()
      .optional()
      .describe('Rows the rendered table shows when content_table_capped is true.'),
  },
  errors: [
    {
      reason: 'invalid_flow_ref',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The flow_ref matches neither the {agencyID},{dsd_id}@{df_id} nor the {agencyID},{df_id} format.',
      recovery:
        'Obtain valid flow_ref values from oecd_search_datasets and pass one through unchanged.',
    },
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The flow_ref does not correspond to a known OECD dataflow.',
      recovery: 'Verify the flow_ref using oecd_search_datasets before querying.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataflow exists but no observations matched the key and time range.',
      recovery:
        'Broaden the key (use empty segments as wildcards), extend the time range, ' +
        'or verify codes with oecd_get_dimension_values.',
    },
    {
      reason: 'invalid_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OECD rejected the dimension key — wrong number of segments, or an unsupported format.',
      recovery:
        'Use oecd_get_dataset_info to check dimension order and count, ' +
        'then rebuild the dot-delimited key matching that order.',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'OECD could not parse start_period or end_period.',
      recovery:
        'Reformat the period as an ISO code matching the dataflow frequency — ' +
        '"2022" for annual, "2022-Q1" for quarterly, "2022-01" for monthly.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: 'OECD throttled the request rate and was still refusing after the retries.',
      recovery:
        'Wait several seconds before calling again, and space out consecutive queries ' +
        'rather than issuing them back to back.',
    },
    {
      reason: 'download_limit',
      code: JsonRpcErrorCode.RateLimited,
      retryable: false,
      when: 'OECD refused the query for exceeding its data-download or data-range limit.',
      recovery:
        'Shrink the query itself — name fewer values per key segment, or set a shorter ' +
        'start_period / end_period span — because waiting will not clear this limit.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      when: 'OECD did not finish responding before OECD_TIMEOUT_MS elapsed.',
      recovery:
        'Split the query into smaller key or period slices so each answer arrives sooner, ' +
        'or raise OECD_TIMEOUT_MS when the whole range must come back in one call.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'OECD returned a server fault or was unreachable once the retries ran out.',
      recovery:
        'Retry after a short pause; if it keeps failing, check OECD API availability ' +
        'before issuing further queries.',
    },
  ],

  async handler(input, ctx) {
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_ref "${input.flow_ref}" is not in the expected format`,
        { ...ctx.recoveryFor('invalid_flow_ref') },
      );
    }

    ctx.log.info('Querying OECD dataset', {
      flowRef: input.flow_ref,
      key: input.key,
      startPeriod: input.start_period,
      endPeriod: input.end_period,
    });

    let dataResult: OecdDataResult;
    try {
      dataResult = await getDataService().fetchData(
        input.flow_ref,
        input.key,
        input.start_period,
        input.end_period,
        ctx.signal,
      );
    } catch (err) {
      const e = err as Error;
      if (isDataflowNotFound(e)) {
        throw ctx.fail(
          'dataflow_not_found',
          `Dataflow not found: ${input.flow_ref}`,
          { ...ctx.recoveryFor('dataflow_not_found') },
          { cause: e },
        );
      }
      const rejection = invalidQueryText(e);
      if (rejection !== undefined) {
        // OECD's own wording names the mistake; the two cases need different fixes.
        if (PERIOD_REJECTION.test(rejection)) {
          throw ctx.fail(
            'invalid_period',
            `OECD rejected the time range for ${input.flow_ref}: ${rejection}`,
            { ...ctx.recoveryFor('invalid_period') },
            { cause: e },
          );
        }
        throw ctx.fail(
          'invalid_key',
          `OECD rejected the dimension key "${input.key}": ${rejection}`,
          { ...ctx.recoveryFor('invalid_key') },
          { cause: e },
        );
      }
      const throttle = throttleText(e);
      const upstream = upstreamReason(e, throttle);
      if (upstream) {
        throw ctx.fail(
          upstream,
          throttle === undefined
            ? e.message
            : `OECD throttled the query for ${input.flow_ref}: ${throttle}`,
          { ...ctx.recoveryFor(upstream) },
          { cause: e },
        );
      }
      throw err;
    }

    if (dataResult.rows.length === 0) {
      throw ctx.fail(
        'no_results',
        `No observations found for key "${input.key}" in ${input.flow_ref}`,
        { ...ctx.recoveryFor('no_results') },
      );
    }

    ctx.log.info('OECD data fetched', { rowCount: dataResult.rows.length });

    // Try to spill to canvas if available and result is large
    const canvas = getCanvas();
    if (canvas) {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      /**
       * Declare the schema rather than letting the provider sniff it. Attribute
       * columns are sparse — one that resolves on no row inside the sniff window
       * would be missing from the registered table entirely, so a later SQL
       * query against it fails instead of returning nulls.
       */
      const schema: ColumnSchema[] = dataResult.columns.map((column) => ({
        name: column.name,
        type: column.type === 'number' ? 'DOUBLE' : 'VARCHAR',
      }));
      const result = await spillover({
        canvas: instance,
        source: dataResult.rows,
        previewChars: PREVIEW_CHARS,
        schema,
        signal: ctx.signal,
      });

      if (result.spilled) {
        return {
          rows: result.previewRows as OutputRow[],
          row_count: result.handle.rowCount,
          query_flow_ref: input.flow_ref,
          query_key: input.key,
          query_start_period: input.start_period,
          query_end_period: input.end_period,
          canvas_id: instance.canvasId,
          table_name: result.handle.tableName,
          truncated: true,
          source: 'OECD' as const,
        };
      }
    }

    /**
     * No canvas, or a result that fits inline. Every row rides in
     * structuredContent either way; the rendered table stops at the preview
     * budget, so a caller with nowhere to spill still gets a bounded
     * `content[]` instead of the whole result twice.
     */
    const inlineRows = dataResult.rows as OutputRow[];
    const shown = previewRowCount(inlineRows);
    if (shown < inlineRows.length) {
      ctx.enrich({ content_table_capped: true, content_table_rows: shown });
    }

    return {
      rows: inlineRows,
      row_count: inlineRows.length,
      query_flow_ref: input.flow_ref,
      query_key: input.key,
      query_start_period: input.start_period,
      query_end_period: input.end_period,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    /**
     * Union the keys across every row, not just the first. Observation
     * attributes are sparse, so a column that only appears further down the
     * result would otherwise be dropped from the table.
     */
    const allKeys = [...new Set(result.rows.flatMap((r) => Object.keys(r)))];
    const shown = previewRowCount(result.rows as OutputRow[]);
    const visible = result.rows.slice(0, shown);
    const header = `| ${allKeys.join(' | ')} |`;
    const divider = `| ${allKeys.map(() => '---').join(' | ')} |`;
    const rows = visible.map((r) => `| ${allKeys.map((k) => String(r[k] ?? '')).join(' | ')} |`);

    const periodRange =
      result.query_start_period || result.query_end_period
        ? ` | Period: ${result.query_start_period ?? '…'} – ${result.query_end_period ?? '…'}`
        : '';

    const scaled = result.rows.some(
      (r) => typeof r.value_scale === 'number' && r.value_scale !== 1,
    );

    /**
     * Three outcomes, three different next moves: the rest is on a canvas, the
     * rest is in structuredContent, or there is no rest. Each says where the
     * missing rows are and how to reach them.
     */
    const note =
      result.truncated && result.canvas_id
        ? `\n> Truncated — showing the first ${shown} of ${result.row_count} rows. The rest is on DataCanvas ` +
          `(canvas_id: \`${result.canvas_id}\`, table: \`${result.table_name}\`). ` +
          'Use **oecd_dataframe_query** to reach it.\n'
        : shown < result.rows.length
          ? `\n> Truncated for display — this table shows the first ${shown} of ${result.row_count} rows, ` +
            'but `structuredContent.rows` carries every one of them. To make the result itself ' +
            'smaller, name fewer values per `key` segment or narrow `start_period` / `end_period`. ' +
            'To reach the full set as a queryable table, run with `CANVAS_PROVIDER_TYPE=duckdb` ' +
            'and follow up with **oecd_dataframe_query**.\n'
          : `\n> Not truncated — all ${shown} rows of the result are shown below.\n`;

    const lines = [
      `**OECD Dataset Query** — ${result.row_count} observations`,
      `Query: \`${result.query_flow_ref}\` key=\`${result.query_key}\`${periodRange}`,
      note,
      scaled
        ? '> Values are scaled by the observation unit multiplier — divide `value` by `value_scale` for the figure as OECD published it.\n'
        : '',
      '',
      visible.length > 0 ? header : '_(no rows)_',
      visible.length > 0 ? divider : '',
      ...rows,
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
