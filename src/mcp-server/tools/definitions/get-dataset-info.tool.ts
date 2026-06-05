/**
 * @fileoverview oecd_get_dataset_info — fetch dimensions and key construction info for a dataflow.
 * @module mcp-server/tools/definitions/get-dataset-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getStructureService,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataStructure } from '@/services/oecd-structure/types.js';

export const oecdGetDatasetInfo = tool('oecd_get_dataset_info', {
  description:
    "Fetch a dataflow's dimensions, their order, and how to construct a query key. " +
    'Returns per-dimension names, codelist references, and position in the dot-delimited key. ' +
    'Required before calling oecd_query_dataset to understand key structure.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    flow_ref: z
      .string()
      .describe(
        'Full flow reference in the form {agencyID},{dsd_id}@{df_id} — ' +
          'e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I". Obtain from oecd_search_datasets.',
      ),
  }),
  output: z.object({
    flow_ref: z.string().describe('The resolved flow reference.'),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension identifier — e.g. REF_AREA.'),
            name: z.string().describe('Human-readable dimension name.'),
            position: z
              .number()
              .describe(
                '1-based position in the dot-delimited key. Segment at this position corresponds to this dimension.',
              ),
            codelist_ref: z
              .string()
              .optional()
              .describe(
                'Codelist reference in the form {agencyID},{codelistID} — use with oecd_get_dimension_values.',
              ),
          })
          .describe('A dataflow dimension with its key position and codelist reference.'),
      )
      .describe('Dimensions in ascending position order.'),
    time_dimension: z
      .object({
        id: z.string().describe('Time dimension identifier — typically TIME_PERIOD.'),
        name: z.string().describe('Human-readable time dimension name.'),
        position: z.number().describe('Position after all regular dimensions.'),
      })
      .optional()
      .describe('Time dimension — used for startPeriod/endPeriod filtering in oecd_query_dataset.'),
    key_example: z
      .string()
      .describe(
        'Example dot-delimited key with wildcards — each dot corresponds to one dimension in position order. ' +
          'Empty segments are wildcards. Replace with actual codes from oecd_get_dimension_values.',
      ),
    non_production: z
      .boolean()
      .describe('True if OECD flagged this dataflow as experimental or deprecated.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  errors: [
    {
      reason: 'invalid_flow_ref',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The flow_ref parameter does not match the expected {agencyID},{dsd_id}@{df_id} format.',
      recovery:
        'Obtain valid flow_ref values from oecd_search_datasets. ' +
        'The format is {agencyID},{dsd_id}@{df_id}, e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I".',
    },
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No datastructure was found for the provided flow_ref.',
      recovery:
        'Verify the flow_ref with oecd_search_datasets. ' +
        'The dataflow may have been renamed or removed.',
    },
  ],

  async handler(input, ctx) {
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_ref "${input.flow_ref}" is not in the expected {agencyID},{dsd_id}@{df_id} format`,
        { ...ctx.recoveryFor('invalid_flow_ref') },
      );
    }

    ctx.log.info('Fetching OECD datastructure', { flowRef: input.flow_ref });

    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(input.flow_ref, ctx.signal);
    } catch (err) {
      const e = err as Error;
      // Check top-level message and cause chain for 404 / not-found signals
      const isNotFound = (e: Error): boolean => {
        const msg = e.message ?? '';
        if (msg.includes('DataStructure not found') || msg.includes('HTTP 404')) return true;
        const cause = (e as NodeJS.ErrnoException).cause;
        return cause instanceof Error ? isNotFound(cause) : false;
      };
      if (isNotFound(e)) {
        throw ctx.fail('dataflow_not_found', `Dataflow not found: ${input.flow_ref}`, {
          ...ctx.recoveryFor('dataflow_not_found'),
        });
      }
      throw err;
    }

    if (!dsd.dimensions.length) {
      throw ctx.fail('dataflow_not_found', `Dataflow ${input.flow_ref} returned no dimensions`, {
        ...ctx.recoveryFor('dataflow_not_found'),
      });
    }

    // Build a wildcard key example
    const keyExample = dsd.dimensions.map(() => '').join('.');

    ctx.log.info('Datastructure fetched', {
      flowRef: input.flow_ref,
      dimensionCount: dsd.dimensions.length,
    });

    return {
      flow_ref: input.flow_ref,
      dimensions: dsd.dimensions.map((d) => ({
        id: d.id,
        name: d.name,
        position: d.position,
        codelist_ref: d.codelistRef,
      })),
      time_dimension: dsd.timeDimension
        ? {
            id: dsd.timeDimension.id,
            name: dsd.timeDimension.name,
            position: dsd.timeDimension.position,
          }
        : undefined,
      key_example: keyExample,
      non_production: dsd.nonProduction,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const dimTable = [
      '| Pos | Dimension ID | Name | Codelist |',
      '|-----|-------------|------|----------|',
      ...result.dimensions.map(
        (d) => `| ${d.position} | ${d.id} | ${d.name} | ${d.codelist_ref ?? '—'} |`,
      ),
    ];
    if (result.time_dimension) {
      dimTable.push(
        `| ${result.time_dimension.position} | ${result.time_dimension.id} _(time)_ | ${result.time_dimension.name} | — |`,
      );
    }

    const lines = [
      `**Dataflow: ${result.flow_ref}**`,
      `non_production: ${result.non_production}`,
      '',
      dimTable.join('\n'),
      '',
      `**Key example (all wildcards):** \`${result.key_example || '.'}\``,
      'Replace empty segments with codes from oecd_get_dimension_values.',
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
