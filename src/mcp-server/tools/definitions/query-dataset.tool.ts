/**
 * @fileoverview oecd_query_dataset — fetch observations from an OECD dataflow with DataCanvas spillover.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import { getDataService } from '@/services/oecd-data/oecd-data-service.js';
import type { OecdDataResult } from '@/services/oecd-data/types.js';
import { parseFlowRef } from '@/services/oecd-structure/oecd-structure-service.js';

// Passthrough schema — dimension keys are dynamic per-dataflow and cannot be
// enumerated at schema definition time. z.object({}).passthrough() forwards all
// fields to structuredContent without linter false-positives for undefined keys.
const DecodedRowSchema = z
  .object({})
  .passthrough()
  .describe(
    'Decoded observation row — dimension IDs as keys with human-readable labels, ' +
      'plus "value" (numeric observation) and "source" ("OECD").',
  );

export const oecdQueryDataset = tool('oecd_query_dataset', {
  description:
    'Fetch observations from an OECD dataflow filtered by a dimension key and optional time range. ' +
    'Returns decoded rows (one per observation) with dimension labels. ' +
    'Large multi-country time-series spill to a DataCanvas table — follow up with oecd_dataframe_query. ' +
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
        'Full flow reference — e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I". Obtain from oecd_search_datasets.',
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
        'Optional canvas ID from a prior oecd_query_dataset call. ' +
          'Omit to start a fresh canvas — the response will include a new canvas_id.',
      ),
  }),
  output: z.object({
    rows: z
      .array(DecodedRowSchema)
      .describe(
        'Inline preview rows. When truncated is true, this is a subset — use oecd_dataframe_query for the full result.',
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
        'Canvas ID — present when the result spilled to DataCanvas. ' +
          'Pass to oecd_dataframe_query or oecd_dataframe_describe.',
      ),
    table_name: z
      .string()
      .optional()
      .describe('Canvas table name holding the full result — present when canvas_id is set.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the result exceeded the inline preview and was staged on DataCanvas. ' +
          'Use oecd_dataframe_query with the canvas_id for analytics over the full set.',
      ),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  errors: [
    {
      reason: 'invalid_flow_ref',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The flow_ref is not in the expected format.',
      recovery:
        'Obtain valid flow_ref values from oecd_search_datasets. ' +
        'Format: {agencyID},{dsd_id}@{df_id}.',
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
      when: 'The dimension key is malformed or contains an unsupported format.',
      recovery:
        'Use oecd_get_dataset_info to check dimension order and count, ' +
        'then rebuild the dot-delimited key matching that order.',
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
      if (
        e.message?.includes('not found') ||
        e.message?.toLowerCase().includes('dataflow not found')
      ) {
        throw ctx.fail(
          'dataflow_not_found',
          `Dataflow not found: ${input.flow_ref}`,
          { ...ctx.recoveryFor('dataflow_not_found') },
          { cause: e },
        );
      }
      if (
        e.message?.includes('Invalid key') ||
        e.message?.includes('malformed') ||
        e.message?.includes('Invalid structure')
      ) {
        throw ctx.fail(
          'invalid_key',
          `Invalid dimension key "${input.key}": ${e.message}`,
          { ...ctx.recoveryFor('invalid_key') },
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
      const result = await spillover({
        canvas: instance,
        source: dataResult.rows,
        previewChars: 100_000,
        signal: ctx.signal,
      });

      if (result.spilled) {
        return {
          rows: result.previewRows as Array<Record<string, string | number | null>>,
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

    // No canvas or fits inline
    return {
      rows: dataResult.rows as Array<Record<string, string | number | null>>,
      row_count: dataResult.rows.length,
      query_flow_ref: input.flow_ref,
      query_key: input.key,
      query_start_period: input.start_period,
      query_end_period: input.end_period,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const previewRows = result.rows.slice(0, 10);
    const firstRow = previewRows[0];
    const allKeys = firstRow !== undefined ? Object.keys(firstRow) : ['value', 'source'];
    const header = `| ${allKeys.join(' | ')} |`;
    const divider = `| ${allKeys.map(() => '---').join(' | ')} |`;
    const rows = previewRows.map(
      (r) => `| ${allKeys.map((k) => String(r[k] ?? '')).join(' | ')} |`,
    );

    const periodRange =
      result.query_start_period || result.query_end_period
        ? ` | Period: ${result.query_start_period ?? '…'} – ${result.query_end_period ?? '…'}`
        : '';

    const lines = [
      `**OECD Dataset Query** — ${result.row_count} observations`,
      `Query: \`${result.query_flow_ref}\` key=\`${result.query_key}\`${periodRange}`,
      result.truncated && result.canvas_id
        ? `\n> Result truncated — full data on DataCanvas (canvas_id: \`${result.canvas_id}\`, table: \`${result.table_name}\`). ` +
          'Use **oecd_dataframe_query** for analytics over the full set.\n'
        : '',
      '',
      previewRows.length > 0 ? header : '_(no rows)_',
      previewRows.length > 0 ? divider : '',
      ...rows,
      result.rows.length > 10
        ? `\n_(Showing 10 of ${result.rows.length} inline preview rows)_`
        : '',
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.filter((l) => l !== undefined).join('\n') }];
  },
});
