/**
 * @fileoverview oecd_search_datasets — search OECD dataflows by keyword or theme, or list the catalog or an agency's dataflows.
 * @module mcp-server/tools/definitions/search-datasets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  getStructureService,
  isDataflowNotFound,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataflow } from '@/services/oecd-structure/types.js';
import { applyCountLimit, type CountLimit, countLimitSchema } from '@/utils/count-limit.js';
import { WordStartText } from '@/utils/word-start-text.js';

/**
 * The catalog is searched locally with no upstream page maximum, so the cap holds
 * a page near 1 MB per surface: a result serializes to at most ~444 bytes.
 */
const LIMIT: CountLimit = { cap: 2_000, defaultValue: 20, tool: 'oecd_search_datasets' };

/**
 * Character budget for a returned description. OECD abstracts run to a median of
 * ~840 characters, so nearly every one is cut; 240 completes the opening summary
 * sentence for ~84% of the abstracts published while holding a page of results
 * to roughly 2.4x its description-free size.
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

interface SearchMatch {
  df: OecdDataflow;
  matchedIn?: 'name' | 'description' | 'both';
}

/**
 * Which fields carry every token at a word start, or undefined when some token
 * starts a word in neither.
 */
function locateTokens(
  df: OecdDataflow,
  tokens: readonly string[],
): { inName: boolean; inDescription: boolean } | undefined {
  const name = new WordStartText(df.name);
  const description = df.description ? new WordStartText(df.description) : undefined;
  let inName = true;
  let inDescription = true;
  for (const token of tokens) {
    const nameHit = name.matches(token);
    const descriptionHit = description?.matches(token) ?? false;
    if (!nameHit && !descriptionHit) return;
    inName &&= nameHit;
    inDescription &&= descriptionHit;
  }
  return { inName, inDescription };
}

export const oecdSearchDatasets = tool('oecd_search_datasets', {
  description:
    'Search OECD dataflows by keyword or theme, or omit query to list every dataflow in catalog order (optionally scoped to one agency_id). When query is supplied, each whitespace-separated token must match at the start of a word in dataflow names or descriptions, with name matches ranked first. Returns flow_ref identifiers, names, and agency IDs for use with oecd_get_dataset_info.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Optional keyword or phrase to search for in dataflow names and descriptions — e.g. "GDP", "house prices", "TiVA". Omit or leave blank to list every dataflow in catalog order (all agencies, or only agency_id when set). Every whitespace-separated token must start a word in the name or description, ignoring case: "price" matches "Prices" and "tiva" matches "(TiVA)", but "tiva" does not match "activation". A word starts after any character that is not a letter or digit, or at a lowercase-to-uppercase step ("markers" matches "RioMarkers"). A token that opens on such a character, like "&" or "-oecd", matches anywhere it occurs: "&" finds "R&D".',
      ),
    agency_id: z
      .string()
      .optional()
      .describe(
        'Optional agency identifier to restrict the search or listing scope — e.g. "OECD.SDD.NAD". Omit query with agency_id to list every dataflow published by that agency. Obtain valid agency IDs from oecd_list_agencies.',
      ),
    limit: countLimitSchema(LIMIT, 'Maximum number of results to return.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first dataflow to return within the ranked match list (or catalog order when query is omitted or blank), applied before limit. Page through results past the limit by advancing it; an offset at or past total_matches returns an empty list.',
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
              .optional()
              .describe(
                'Which field carried every query token at a word start — "name" or "description" when only that one did, "both" when each did on its own or the tokens were split across the two. Absent when query was omitted or blank.',
              ),
          })
          .describe('A matching or listed OECD dataflow entry.'),
      )
      .describe(
        'Dataflows for the requested page, up to the requested limit. When query has search tokens, ranked in three tiers: the name carries every token; the tokens are split across name and description; the description alone carries every token (catalog order within each tier). When query is omitted or blank, returned in catalog order.',
      ),
    result_count: z
      .number()
      .describe('Number of results returned (may be less than total_matches).'),
    total_matches: z
      .number()
      .describe(
        'Total dataflows matching the query — or total dataflows in the catalog or agency when query is omitted or blank — before applying offset and limit.',
      ),
    offset: z
      .number()
      .describe(
        'Zero-based index of the first returned result within the ranked match list (or catalog order when query is omitted or blank).',
      ),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when a requested limit was above the per-call maximum, naming the limit requested and the one served.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total dataflows available for the search or listing, disclosed when results remain beyond the returned page.',
      ),
  },
  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No dataflows matched the search query, or the catalog or requested agency published no dataflows.',
      recovery:
        'Search whole words or the start of a word — a term matches where it starts a word in a name or description, so a fragment from the middle of a word matches nothing — omit query to list all dataflows in an agency, or use oecd_list_agencies to discover agencies with published dataflows.',
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
      when: "OECD throttled the request rate and was still refusing after the retries, or asked for a wait longer than the call's upstream budget had left.",
      recovery:
        'Wait several seconds before calling again, and space out consecutive queries ' +
        'rather than issuing them back to back.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      when: "An OECD request ran past OECD_TIMEOUT_MS, or the call's requests and retries together ran past its upstream budget — 50 seconds, or OECD_TIMEOUT_MS when that is longer.",
      recovery:
        "Retry once — the whole-catalog response runs to megabytes and is occasionally slow — and set agency_id to fetch one agency's dataflows if it keeps timing out; raising OECD_TIMEOUT_MS past 50 seconds also needs a client that waits that long for a tool result.",
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
      when: 'OECD refused the request with a status this server does not model — an authorization challenge, a rejection from something sitting in front of the API, a request read as malformed or unprocessable (HTTP 400 or 422), or a method it does not implement (HTTP 501).',
      recovery:
        'Retry once; a repeat is not transient, so report the HTTP status and OECD text this error carries and check that OECD_BASE_URL names the public SDMX API rather than a proxy in front of it.',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      when: 'OECD answered with a body this server could not read — not JSON, or JSON whose fields do not have the shape SDMX gives them.',
      recovery:
        'Report the response this error describes and check that OECD_BASE_URL names the public SDMX API rather than a proxy in front of it; the same request returns the same body, so a retry will not help.',
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
        new UpstreamBudget(ctx.signal),
        input.agency_id || undefined,
      );
    } catch (err) {
      if (input.agency_id && isDataflowNotFound(err as Error)) {
        throw ctx.fail(
          'agency_not_found',
          `No OECD agency is published under the identifier "${input.agency_id}"`,
          undefined,
          { cause: err as Error },
        );
      }
      const refusal = upstreamRefusal(err);
      if (refusal) {
        throw ctx.fail(refusal.reason, refusal.message, undefined, { cause: err as Error });
      }
      throw err;
    }

    const tokens = (input.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    let matches: SearchMatch[];
    if (tokens.length === 0) {
      matches = dataflows.map((df) => ({ df }));
    } else {
      /**
       * Ranked in three tiers, each in catalog order: the name carries every token;
       * the tokens are split so neither field carries them all; the description
       * alone carries every token. 'both' therefore names two shapes — each field
       * carrying every token on its own (first tier) and the split (second tier).
       */
      const byName: SearchMatch[] = [];
      const split: SearchMatch[] = [];
      const byDescription: SearchMatch[] = [];
      for (const df of dataflows) {
        const found = locateTokens(df, tokens);
        if (!found) continue;
        if (found.inName) byName.push({ df, matchedIn: found.inDescription ? 'both' : 'name' });
        else if (found.inDescription) byDescription.push({ df, matchedIn: 'description' });
        else split.push({ df, matchedIn: 'both' });
      }
      matches = [...byName, ...split, ...byDescription];
    }

    // Keyed to the raw match count, before offset — an offset past the end is an
    // empty page, not an absent dataset.
    if (matches.length === 0) {
      const message =
        tokens.length === 0
          ? input.agency_id
            ? `No dataflows found in agency ${input.agency_id}`
            : 'No dataflows found in the OECD catalog'
          : `No dataflows matched "${input.query}"${input.agency_id ? ` in agency ${input.agency_id}` : ''}`;
      throw ctx.fail('no_match', message);
    }

    const limit = applyCountLimit(input.limit, LIMIT, ctx);
    const page = matches.slice(input.offset, input.offset + limit.applied);
    ctx.log.info('Dataflow search complete', {
      totalMatches: matches.length,
      returned: page.length,
      offset: input.offset,
    });

    // The clamp is the only notice this tool writes, so it needs no joining.
    if (limit.notice) ctx.enrich.notice(limit.notice);
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
        ...(matchedIn ? { matched_in: matchedIn } : {}),
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
        const matchSuffix = df.matched_in ? ` (matched_in: ${df.matched_in})` : '';
        const entry = [
          `- **${escapeMarkdownInline(df.flow_ref)}**${matchSuffix}`,
          `  ${escapeMarkdownInline(df.name)}`,
          `  Agency: ${escapeMarkdownInline(df.agency_id)}`,
        ];
        if (df.description) entry.push(`  ${escapeMarkdownInline(df.description)}`);
        return entry.join('\n');
      }),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
