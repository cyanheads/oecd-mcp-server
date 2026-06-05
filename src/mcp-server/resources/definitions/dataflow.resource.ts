/**
 * @fileoverview oecd://dataflow/{agency_id}/{flow_id} resource — dimension metadata for a single dataflow.
 * @module mcp-server/resources/definitions/dataflow.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  getStructureService,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataStructure } from '@/services/oecd-structure/types.js';

export const oecdDataflowResource = resource('oecd://dataflow/{agency_id}/{flow_id}', {
  name: 'oecd-dataflow',
  description:
    'Dimension metadata for a single OECD dataflow — same content as oecd_get_dataset_info. ' +
    '{flow_id} is the combined {dsd_id}@{df_id} string with @ percent-encoded as %40 in the URI. ' +
    'Example: oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I',
  mimeType: 'application/json',
  params: z.object({
    agency_id: z.string().describe('Agency identifier — e.g. OECD.SDD.NAD.'),
    flow_id: z
      .string()
      .describe(
        'Combined dsd_id@df_id URL-encoded — e.g. DSD_NAAG%40DF_NAAG_I. ' +
          'The @ is percent-encoded as %40 in the URI.',
      ),
  }),
  output: z.object({
    flow_ref: z.string().describe('Canonical flow reference reconstructed from URI params.'),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension identifier.'),
            name: z.string().describe('Human-readable dimension name.'),
            position: z.number().describe('1-based position in the dot-delimited key.'),
            codelist_ref: z.string().optional().describe('Codelist reference, if any.'),
          })
          .describe('A dataflow dimension with its key position and codelist reference.'),
      )
      .describe('Dimensions in ascending position order.'),
    time_dimension: z
      .object({
        id: z.string().describe('Time dimension identifier — typically TIME_PERIOD.'),
        name: z.string().describe('Human-readable time dimension name.'),
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

  async handler(params, ctx) {
    // Decode %40 → @ to reconstruct the canonical flow_id
    const decodedFlowId = decodeURIComponent(params.flow_id);
    const flowRef = `${params.agency_id},${decodedFlowId}`;

    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw notFound(`Invalid flow_ref reconstructed from URI: ${flowRef}`, {
        agencyId: params.agency_id,
        flowId: params.flow_id,
      });
    }

    ctx.log.info('Fetching dataflow resource', { flowRef });

    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(flowRef, ctx.signal);
    } catch (err) {
      // Check top-level message and cause chain for 404 / not-found signals
      const isNotFound = (e: Error): boolean => {
        const msg = e.message ?? '';
        if (msg.includes('DataStructure not found') || msg.includes('HTTP 404')) return true;
        const cause = (e as NodeJS.ErrnoException).cause;
        return cause instanceof Error ? isNotFound(cause) : false;
      };
      if (isNotFound(err as Error)) {
        throw notFound(`Dataflow not found: ${flowRef}`, { flowRef }, { cause: err as Error });
      }
      throw err;
    }

    if (!dsd.dimensions.length) {
      throw notFound(`Dataflow ${flowRef} returned no dimensions`, { flowRef });
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
