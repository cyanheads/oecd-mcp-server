/**
 * @fileoverview oecd://dataflow/{agency_id}/{flow_id} resource — dimension metadata for a single dataflow.
 * @module mcp-server/resources/definitions/dataflow.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import {
  getStructureService,
  isDataflowNotFound,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataStructure } from '@/services/oecd-structure/types.js';

export const oecdDataflowResource = resource('oecd://dataflow/{agency_id}/{flow_id}', {
  name: 'oecd-dataflow',
  description:
    'Dimension metadata for a single OECD dataflow — same content as oecd_get_dataset_info. ' +
    '{flow_id} is the combined {dsd_id}@{df_id} string with @ percent-encoded as %40 in the URI, ' +
    'or the bare {df_id} for the few dataflows OECD publishes without a datastructure prefix. ' +
    'Example: oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I',
  mimeType: 'application/json',
  params: z.object({
    agency_id: z.string().describe('Agency identifier — e.g. OECD.SDD.NAD.'),
    flow_id: z
      .string()
      .describe(
        'Combined dsd_id@df_id URL-encoded — e.g. DSD_NAAG%40DF_NAAG_I, where @ is percent-encoded ' +
          'as %40 — or a bare df_id such as DF_AEI2024_DASHBOARD.',
      ),
  }),
  output: z.object({
    flow_ref: z.string().describe('Canonical flow reference reconstructed from URI params.'),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension identifier.'),
            name: z
              .string()
              .describe(
                'Concept name for the dimension — e.g. "Reference area" for REF_AREA. ' +
                  'Repeats the id when OECD publishes no concept for it.',
              ),
            position: z.number().describe('1-based position in the dot-delimited key.'),
            codelist_ref: z.string().optional().describe('Codelist reference, if any.'),
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
        position: z.number().describe('Position in the key after all regular dimensions.'),
      })
      .optional()
      .describe(
        'Time dimension, if present — used for startPeriod/endPeriod filtering in oecd_query_dataset.',
      ),
    key_example: z
      .string()
      .describe(
        'Dot-delimited key with all segments empty (wildcards). Replace segments with codes from oecd_get_dimension_values.',
      ),
    non_production: z
      .boolean()
      .describe('True if OECD flagged this dataflow as experimental or deprecated.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  /**
   * The same failures oecd_get_dataset_info declares, under the same reasons and
   * codes — the two surfaces resolve the same identifier against the same
   * endpoints, so a client must not have to learn which one it called to read
   * the failure. Only the `invalid_flow_ref` recovery differs: the tool takes
   * one `flow_ref` string, this takes it split across two URI segments, so the
   * hint has to say how to perform that split.
   */
  errors: [
    {
      reason: 'invalid_flow_ref',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The agency_id and flow_id segments do not combine into a flow reference in the {agencyID},{dsd_id}@{df_id} or {agencyID},{df_id} format, or flow_id carries a malformed percent-escape.',
      recovery:
        'Take a flow_ref from oecd_search_datasets and split it on its comma — the part before ' +
        'is the agency_id segment, the part after is the flow_id segment with @ percent-encoded ' +
        'as %40, e.g. oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I.',
    },
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No datastructure was found for the flow reference the URI segments name.',
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

  async handler(params, ctx) {
    // Decode %40 → @ to reconstruct the canonical flow_id. A malformed escape
    // (`%ZZ`, a trailing `%`) reaches here as a URIError, which is the same
    // caller mistake as an unparseable ref and is reported the same way rather
    // than as an unexplained internal fault.
    let decodedFlowId: string;
    try {
      decodedFlowId = decodeURIComponent(params.flow_id);
    } catch {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_id segment "${params.flow_id}" carries a malformed percent-escape`,
        { ...ctx.recoveryFor('invalid_flow_ref') },
      );
    }
    const flowRef = `${params.agency_id},${decodedFlowId}`;

    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `URI segments "${params.agency_id}" and "${params.flow_id}" do not combine into a flow ` +
          'reference in the expected {agencyID},{dsd_id}@{df_id} or {agencyID},{df_id} format',
        { ...ctx.recoveryFor('invalid_flow_ref') },
      );
    }

    ctx.log.info('Fetching dataflow resource', { flowRef });

    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(flowRef, ctx.signal);
    } catch (err) {
      if (isDataflowNotFound(err as Error)) {
        throw ctx.fail(
          'dataflow_not_found',
          `Dataflow not found: ${flowRef}`,
          { ...ctx.recoveryFor('dataflow_not_found') },
          { cause: err as Error },
        );
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
      throw ctx.fail('dataflow_not_found', `Dataflow ${flowRef} returned no dimensions`, {
        ...ctx.recoveryFor('dataflow_not_found'),
      });
    }

    const keyExample = dsd.dimensions.map(() => '').join('.');

    return {
      flow_ref: flowRef,
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
});
