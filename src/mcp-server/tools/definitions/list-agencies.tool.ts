/**
 * @fileoverview oecd_list_agencies — list OECD SDMX agencies and their dataflow counts.
 * @module mcp-server/tools/definitions/list-agencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataflow } from '@/services/oecd-structure/types.js';

export const oecdListAgencies = tool('oecd_list_agencies', {
  description:
    'List OECD SDMX agencies and the number of dataflows each publishes. ' +
    'Use to discover agency IDs before filtering oecd_search_datasets by department.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({}),
  output: z.object({
    agencies: z
      .array(
        z
          .object({
            agency_id: z.string().describe('Agency identifier — e.g. OECD.SDD.NAD.'),
            dataflow_count: z.number().describe('Number of dataflows published by this agency.'),
          })
          .describe('An agency and its dataflow count.'),
      )
      .describe('Agencies and their dataflow counts, sorted descending by count.'),
    total_agencies: z.number().describe('Total number of distinct agencies.'),
    total_dataflows: z.number().describe('Total number of dataflows across all agencies.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The OECD structure API fetch failed after retries.',
      recovery: 'The OECD API may be temporarily unavailable. Retry in a few minutes.',
      retryable: true,
    },
  ],

  async handler(_input, ctx) {
    ctx.log.info('Fetching all OECD dataflows to tally agencies');
    let dataflows: OecdDataflow[];
    try {
      dataflows = await getStructureService().fetchDataflows(undefined, ctx.signal);
    } catch (err) {
      throw ctx.fail(
        'upstream_error',
        'Failed to fetch OECD dataflows',
        { ...ctx.recoveryFor('upstream_error') },
        { cause: err as Error },
      );
    }

    // Aggregate by agency
    const counts = new Map<string, number>();
    for (const df of dataflows) {
      counts.set(df.agencyId, (counts.get(df.agencyId) ?? 0) + 1);
    }

    const agencies = [...counts.entries()]
      .map(([agency_id, dataflow_count]) => ({ agency_id, dataflow_count }))
      .sort((a, b) => b.dataflow_count - a.dataflow_count);

    ctx.log.info('Agency list built', {
      agencyCount: agencies.length,
      totalDataflows: dataflows.length,
    });

    return {
      agencies,
      total_agencies: agencies.length,
      total_dataflows: dataflows.length,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const lines = [
      `**OECD Agencies** (${result.total_agencies} agencies, ${result.total_dataflows} total dataflows)`,
      '',
      '| Agency | Dataflows |',
      '|--------|-----------|',
      ...result.agencies.map((a) => `| ${a.agency_id} | ${a.dataflow_count} |`),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
