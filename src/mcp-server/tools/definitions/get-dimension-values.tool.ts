/**
 * @fileoverview oecd_get_dimension_values — fetch valid codes for one dimension of a dataflow.
 * @module mcp-server/tools/definitions/get-dimension-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getStructureService,
  isDataflowNotFound,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdCode, OecdDataStructure } from '@/services/oecd-structure/types.js';

export const oecdGetDimensionValues = tool('oecd_get_dimension_values', {
  description:
    'Fetch the valid codes and labels for one dimension of a dataflow. ' +
    'Use to resolve human-readable names (countries, measures) to SDMX codes before querying with oecd_query_dataset. ' +
    'Returns all valid codes — substring matching on the returned list narrows down the right code.',
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
    dimension_id: z
      .string()
      .describe(
        'Dimension identifier to fetch codes for — e.g. "REF_AREA" or "MEASURE". ' +
          'Obtain valid dimension IDs from oecd_get_dataset_info.',
      ),
  }),
  output: z.object({
    flow_ref: z.string().describe('The flow reference this dimension belongs to.'),
    dimension_id: z.string().describe('The dimension whose codes are listed.'),
    codes: z
      .array(
        z
          .object({
            id: z.string().describe('SDMX code — use in the dimension key for oecd_query_dataset.'),
            name: z.string().describe('Human-readable label for the code.'),
          })
          .describe('A valid SDMX code and its human-readable label.'),
      )
      .describe('All valid codes for this dimension.'),
    code_count: z.number().describe('Total number of valid codes.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  errors: [
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The flow_ref does not correspond to a known dataflow.',
      recovery: 'Verify the flow_ref using oecd_search_datasets before calling this tool.',
    },
    {
      reason: 'dimension_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: "The dimension_id is not present in this dataflow's structure.",
      recovery:
        'Inspect available dimensions first with oecd_get_dataset_info, ' +
        'then use one of the returned dimension IDs.',
    },
  ],

  async handler(input, ctx) {
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'dataflow_not_found',
        `flow_ref "${input.flow_ref}" is not in the expected format`,
        { ...ctx.recoveryFor('dataflow_not_found') },
      );
    }

    ctx.log.info('Fetching dimension values', {
      flowRef: input.flow_ref,
      dimensionId: input.dimension_id,
    });

    // Fetch the datastructure to find the codelist ref for this dimension
    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(input.flow_ref, ctx.signal);
    } catch (err) {
      if (isDataflowNotFound(err as Error)) {
        throw ctx.fail('dataflow_not_found', `Dataflow not found: ${input.flow_ref}`, {
          ...ctx.recoveryFor('dataflow_not_found'),
        });
      }
      throw err;
    }

    const dim = dsd.dimensions.find((d) => d.id === input.dimension_id);
    if (!dim) {
      throw ctx.fail(
        'dimension_not_found',
        `Dimension "${input.dimension_id}" not found in dataflow ${input.flow_ref}`,
        { ...ctx.recoveryFor('dimension_not_found') },
      );
    }

    if (!dim.codelistRef) {
      // Dimension has no codelist — return empty
      ctx.log.info('Dimension has no codelist reference', {
        flowRef: input.flow_ref,
        dimensionId: input.dimension_id,
      });
      return {
        flow_ref: input.flow_ref,
        dimension_id: input.dimension_id,
        codes: [],
        code_count: 0,
        source: 'OECD' as const,
      };
    }

    // Parse codelist ref: "{agencyID},{codelistID}"
    const clCommaIdx = dim.codelistRef.indexOf(',');
    const clAgencyId = clCommaIdx >= 0 ? dim.codelistRef.slice(0, clCommaIdx) : parts.agencyId;
    const codelistId = clCommaIdx >= 0 ? dim.codelistRef.slice(clCommaIdx + 1) : dim.codelistRef;

    const codes: OecdCode[] = await getStructureService().fetchCodelist(
      clAgencyId,
      codelistId,
      ctx.signal,
    );

    ctx.log.info('Dimension values fetched', {
      flowRef: input.flow_ref,
      dimensionId: input.dimension_id,
      codeCount: codes.length,
    });

    return {
      flow_ref: input.flow_ref,
      dimension_id: input.dimension_id,
      codes: codes.map((c) => ({ id: c.id, name: c.name })),
      code_count: codes.length,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const rows = result.codes.slice(0, 50).map((c) => `| ${c.id} | ${c.name} |`);
    const truncated =
      result.code_count > 50 ? `\n_(Showing first 50 of ${result.code_count} codes)_` : '';

    const lines = [
      `**Dimension: ${result.dimension_id}** (flow: ${result.flow_ref})`,
      `${result.code_count} valid codes`,
      '',
      '| Code | Name |',
      '|------|------|',
      ...rows,
      truncated,
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
