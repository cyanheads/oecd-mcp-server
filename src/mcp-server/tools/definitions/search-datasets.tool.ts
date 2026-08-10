/**
 * @fileoverview oecd_search_datasets — search OECD dataflows by keyword or theme.
 * @module mcp-server/tools/definitions/search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import {
  getStructureService,
  isDataflowNotFound,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataflow } from '@/services/oecd-structure/types.js';

/**
 * Character budget for a returned description. OECD abstracts run to a median of
 * ~840 characters, so nearly every one is cut; 240 completes the opening summary
 * sentence for ~84% of the abstracts published while holding a full 100-result
 * response to roughly 2.4x its description-free size.
 */
const DESCRIPTION_MAX_CHARS = 240;

/** Cut to the budget on a word boundary when one is close enough to the end. */
function truncateDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > DESCRIPTION_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

export const oecdSearchDatasets = tool('oecd_search_datasets', {
  description:
    'Search OECD dataflows by keyword or theme, matching against dataflow names and descriptions. ' +
    'Returns flow_ref identifiers, names, and agency IDs for use with oecd_get_dataset_info.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    query: z
      .string()
      .describe(
        'Keyword or phrase to search for in dataflow names and descriptions — e.g. "GDP", "employment", "education". ' +
          'Every whitespace-separated token must appear somewhere in the name or description.',
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first match to return, applied before limit. ' +
          'Page through results past the limit by advancing it; an offset at or past total_matches returns an empty list.',
      ),
  }),
  output: z.object({
    dataflows: z
      .array(
        z
          .object({
            flow_ref: z
              .string()
              .describe(
                'Full flow reference — {agencyID},{dsd_id}@{df_id}, or {agencyID},{df_id} for the ' +
                  'few dataflows OECD publishes without a datastructure prefix. Pass through ' +
                  'unchanged to oecd_get_dataset_info or oecd_query_dataset.',
              ),
            agency_id: z.string().describe('Publishing agency identifier.'),
            name: z.string().describe('Human-readable dataflow name.'),
            description: z
              .string()
              .optional()
              .describe(
                `Plain-text abstract of what the dataset covers, truncated to ${DESCRIPTION_MAX_CHARS} characters. ` +
                  'Matching runs against the full abstract, so a term reported in matched_in may sit past the cut. ' +
                  'Absent when OECD publishes no description for the dataflow.',
              ),
            matched_in: z
              .enum(['name', 'description', 'both'])
              .describe(
                'Which field carried every query token — "name" or "description" when only that one did, ' +
                  '"both" when each did on its own or the tokens were split across the two.',
              ),
            non_production: z
              .boolean()
              .describe('True if flagged as experimental or deprecated by OECD.'),
          })
          .describe('A matching OECD dataflow entry.'),
      )
      .describe('Matching dataflows for the requested page, up to the requested limit.'),
    result_count: z
      .number()
      .describe('Number of results returned (may be less than total_matches).'),
    total_matches: z
      .number()
      .describe('Total dataflows matching the query before applying offset and limit.'),
    offset: z
      .number()
      .describe('Zero-based index of the first returned result within the full match list.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total dataflows matching the query, disclosed when matches remain beyond the returned page.',
      ),
  },
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
      reason: 'agency_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied agency_id does not exist in the OECD SDMX catalog.',
      recovery:
        'Call oecd_list_agencies for the valid agency IDs and retry with one of them, ' +
        'or omit agency_id to search the whole catalog.',
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
        'Retry once — the whole-catalog response runs to megabytes and is occasionally slow — ' +
        'and raise OECD_TIMEOUT_MS if it keeps timing out, or set agency_id to fetch one ' +
        "agency's dataflows instead.",
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
    ctx.log.info('Searching OECD dataflows', {
      query: input.query,
      agencyId: input.agency_id,
      limit: input.limit,
      offset: input.offset,
    });

    let dataflows: OecdDataflow[];
    try {
      dataflows = await getStructureService().fetchDataflows(
        input.agency_id || undefined,
        ctx.signal,
      );
    } catch (err) {
      if (input.agency_id && isDataflowNotFound(err as Error)) {
        throw ctx.fail(
          'agency_not_found',
          `No OECD agency is published under the identifier "${input.agency_id}"`,
          { ...ctx.recoveryFor('agency_not_found') },
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

    // Filter by query tokens (case-insensitive, all tokens must match name or description)
    const tokens = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const matches: Array<{ df: OecdDataflow; matchedIn: 'name' | 'description' | 'both' }> = [];
    for (const df of dataflows) {
      const name = df.name.toLowerCase();
      const description = df.description?.toLowerCase() ?? '';
      if (!tokens.every((t) => name.includes(t) || description.includes(t))) continue;
      const inName = tokens.every((t) => name.includes(t));
      const inDescription = tokens.every((t) => description.includes(t));
      // 'both' covers two shapes: each field carries every token on its own, and
      // neither does because the tokens are split across them.
      const matchedIn =
        inName && !inDescription ? 'name' : inDescription && !inName ? 'description' : 'both';
      matches.push({ df, matchedIn });
    }

    // Keyed to the raw match count, before offset — an offset past the end is an
    // empty page, not an absent dataset.
    if (matches.length === 0) {
      throw ctx.fail(
        'no_match',
        `No dataflows matched "${input.query}"${input.agency_id ? ` in agency ${input.agency_id}` : ''}`,
        { ...ctx.recoveryFor('no_match') },
      );
    }

    const page = matches.slice(input.offset, input.offset + input.limit);
    ctx.log.info('Dataflow search complete', {
      totalMatches: matches.length,
      returned: page.length,
      offset: input.offset,
    });

    // Disclose the full match count when matches remain beyond the returned page.
    if (input.offset + page.length < matches.length) {
      ctx.enrich.total(matches.length);
    }

    return {
      dataflows: page.map(({ df, matchedIn }) => ({
        flow_ref: df.flowRef,
        agency_id: df.agencyId,
        name: df.name,
        ...(df.description ? { description: truncateDescription(df.description) } : {}),
        matched_in: matchedIn,
        non_production: df.nonProduction,
      })),
      result_count: page.length,
      total_matches: matches.length,
      offset: input.offset,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const lines = [
      `**OECD Dataflow Search** — ${result.result_count} of ${result.total_matches} matches, ` +
        `starting at offset ${result.offset}`,
      '',
      ...result.dataflows.map((df) => {
        const entry = [
          `- **${df.flow_ref}** (non_production: ${df.non_production}, matched_in: ${df.matched_in})`,
          `  ${df.name}`,
          `  Agency: ${df.agency_id}`,
        ];
        if (df.description) entry.push(`  ${df.description}`);
        return entry.join('\n');
      }),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
