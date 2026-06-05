/**
 * @fileoverview oecd_search_datasets — search OECD dataflows by keyword or theme.
 * @module mcp-server/tools/definitions/search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataflow } from '@/services/oecd-structure/types.js';

export const oecdSearchDatasets = tool('oecd_search_datasets', {
  description:
    'Search OECD dataflows by keyword or theme. ' +
    'Returns flow_ref identifiers, names, and agency IDs for use with oecd_get_dataset_info. ' +
    'The first call fetches the full catalog of 1,500+ dataflows from the OECD API — subsequent calls are fast.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    query: z
      .string()
      .describe(
        'Keyword or phrase to search for in dataflow names — e.g. "GDP", "employment", "education".',
      ),
    agency_id: z
      .string()
      .optional()
      .describe(
        'Optional agency identifier to restrict the search scope — e.g. "OECD.SDD.NAD". ' +
          'Obtain valid agency IDs from oecd_list_agencies.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum number of results to return (1–100, default 20).'),
  }),
  output: z.object({
    dataflows: z
      .array(
        z
          .object({
            flow_ref: z
              .string()
              .describe(
                'Full flow reference in the form {agencyID},{dsd_id}@{df_id} — pass to oecd_get_dataset_info or oecd_query_dataset.',
              ),
            agency_id: z.string().describe('Publishing agency identifier.'),
            name: z.string().describe('Human-readable dataflow name.'),
            non_production: z
              .boolean()
              .describe('True if flagged as experimental or deprecated by OECD.'),
          })
          .describe('A matching OECD dataflow entry.'),
      )
      .describe('Matching dataflows, up to the requested limit.'),
    result_count: z
      .number()
      .describe('Number of results returned (may be less than total_matches).'),
    total_matches: z.number().describe('Total dataflows matching the query before applying limit.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No dataflows matched the search query.',
      recovery:
        'Try broader search terms or use oecd_list_agencies to discover agency IDs, ' +
        'then search within a specific agency.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The OECD structure API fetch failed after retries.',
      recovery: 'The OECD API may be temporarily unavailable. Retry in a few minutes.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Searching OECD dataflows', {
      query: input.query,
      agencyId: input.agency_id,
      limit: input.limit,
    });

    let dataflows: OecdDataflow[];
    try {
      dataflows = await getStructureService().fetchDataflows(
        input.agency_id || undefined,
        ctx.signal,
      );
    } catch (err) {
      throw ctx.fail(
        'upstream_error',
        'Failed to fetch OECD dataflows',
        { ...ctx.recoveryFor('upstream_error') },
        { cause: err as Error },
      );
    }

    // Filter by query tokens (case-insensitive, all tokens must match)
    const tokens = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const matches = dataflows.filter((df) => {
      const hay = df.name.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });

    if (matches.length === 0) {
      throw ctx.fail(
        'no_match',
        `No dataflows matched "${input.query}"${input.agency_id ? ` in agency ${input.agency_id}` : ''}`,
        { ...ctx.recoveryFor('no_match') },
      );
    }

    const limited = matches.slice(0, input.limit);
    ctx.log.info('Dataflow search complete', {
      totalMatches: matches.length,
      returned: limited.length,
    });

    return {
      dataflows: limited.map((df) => ({
        flow_ref: df.flowRef,
        agency_id: df.agencyId,
        name: df.name,
        non_production: df.nonProduction,
      })),
      result_count: limited.length,
      total_matches: matches.length,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const lines = [
      `**OECD Dataflow Search** — ${result.result_count} results` +
        (result.total_matches > result.result_count
          ? ` (${result.total_matches} total matches, showing first ${result.result_count})`
          : ''),
      '',
      ...result.dataflows.map(
        (df) =>
          `- **${df.flow_ref}** (non_production: ${df.non_production})\n  ${df.name}\n  Agency: ${df.agency_id}`,
      ),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
