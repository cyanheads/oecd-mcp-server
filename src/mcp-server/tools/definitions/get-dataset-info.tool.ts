/**
 * @fileoverview oecd_get_dataset_info — fetch dimensions and key construction info for a dataflow.
 * @module mcp-server/tools/definitions/get-dataset-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import {
  getStructureService,
  isDataflowNotFound,
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
        'Full flow reference, either {agencyID},{dsd_id}@{df_id} — e.g. ' +
          '"OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I" — or the bare {agencyID},{df_id} form OECD uses for ' +
          'the few dataflows published without a datastructure prefix. Obtain from oecd_search_datasets.',
      ),
  }),
  output: z.object({
    flow_ref: z.string().describe('The resolved flow reference.'),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension identifier — e.g. REF_AREA.'),
            name: z
              .string()
              .describe(
                'Concept name for the dimension — e.g. "Reference area" for REF_AREA. ' +
                  'Repeats the id when OECD publishes no concept for it.',
              ),
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
        name: z
          .string()
          .describe(
            'Concept name for the time dimension, repeating the id when none is published.',
          ),
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
      code: JsonRpcErrorCode.ValidationError,
      when: 'The flow_ref parameter matches neither the {agencyID},{dsd_id}@{df_id} nor the {agencyID},{df_id} format.',
      recovery:
        'Obtain valid flow_ref values from oecd_search_datasets and pass one unchanged, ' +
        'e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I".',
    },
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No datastructure was found for the provided flow_ref.',
      recovery:
        'Verify the flow_ref with oecd_search_datasets. ' +
        'The dataflow may have been renamed or removed.',
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
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      when: 'OECD did not finish responding before OECD_TIMEOUT_MS elapsed.',
      recovery:
        'Retry once — a structure response runs to megabytes and is occasionally slow — ' +
        'and raise OECD_TIMEOUT_MS if it keeps timing out.',
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
    {
      reason: 'upstream_redirect',
      code: JsonRpcErrorCode.Forbidden,
      retryable: false,
      when: 'The configured OECD host answered with a redirect, which this server never follows.',
      recovery:
        'Stop retrying and report the server configuration — OECD_BASE_URL must name the https ' +
        'origin that answers directly, and no wait clears a redirect.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OECD refused the request with a status this server does not model — an authorization challenge, a rejection from something sitting in front of the API, or a request read as malformed.',
      recovery:
        'Retry once; a repeat is not transient, so report the OECD response and check that ' +
        'OECD_BASE_URL names the public SDMX API rather than a proxy in front of it.',
    },
  ],

  async handler(input, ctx) {
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_ref "${input.flow_ref}" is not in the expected {agencyID},{dsd_id}@{df_id} or {agencyID},{df_id} format`,
        { ...ctx.recoveryFor('invalid_flow_ref') },
      );
    }

    ctx.log.info('Fetching OECD datastructure', { flowRef: input.flow_ref });

    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(input.flow_ref, ctx.signal);
    } catch (err) {
      if (isDataflowNotFound(err as Error)) {
        throw ctx.fail('dataflow_not_found', `Dataflow not found: ${input.flow_ref}`, {
          ...ctx.recoveryFor('dataflow_not_found'),
        });
      }
      const refusal = upstreamRefusal(err);
      if (refusal) {
        throw ctx.fail(
          refusal.reason,
          refusal.message,
          { ...ctx.recoveryFor(refusal.reason) },
          { cause: err as Error },
        );
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
