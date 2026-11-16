/**
 * @fileoverview oecd_get_dimension_values — fetch a filtered, paged set of valid
 * codes for one dimension of a dataflow.
 * @module mcp-server/tools/definitions/get-dimension-values.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { SDMX_KEY_SAFE } from '@/services/oecd-data/oecd-data-service.js';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  type AvailabilityOutcome,
  availabilityKey,
  describeFindings,
  diagnoseKey,
  type OecdAvailability,
  readAvailability,
} from '@/services/oecd-structure/availability.js';
import {
  getStructureService,
  isDataflowNotFound,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdCode, OecdDataStructure } from '@/services/oecd-structure/types.js';
import { applyCountLimit, type CountLimit, countLimitSchema } from '@/utils/count-limit.js';
import { formatTable } from '@/utils/format-table.js';

/**
 * A page of codes: 50 by default, at most 10,000 — about 1 MB per surface at
 * the 54–69 bytes a code with a 25–40-character label takes, with room for
 * longer labels. The largest codelist on record holds 1,164.
 */
const LIMIT: CountLimit = { cap: 10_000, defaultValue: 50, tool: 'oecd_get_dimension_values' };

/**
 * The codelist narrowed to the codes with data, in codelist order, followed by
 * any code with data the codelist does not list, labelled by its own id.
 */
function codesWithData(codelist: readonly OecdCode[], withData: readonly string[]): OecdCode[] {
  const wanted = new Set(withData);
  const listed = new Set(codelist.map((c) => c.id));
  return [
    ...codelist.filter((c) => wanted.has(c.id)),
    ...withData.filter((id) => !listed.has(id)).map((id) => ({ id, name: id })),
  ];
}

/** What the availability record says about the key, as notice sentences. */
function keyNotes(
  availability: OecdAvailability,
  dsd: OecdDataStructure,
  key: string | undefined,
): string[] {
  const clauses = describeFindings(diagnoseKey(availability, dsd.dimensions, key ?? 'all'));
  if (availability.observationCount === 0) {
    if (availabilityKey(key) === 'all') return ['OECD records no observations for this dataflow.'];
    return [
      `The key matches no series: ${clauses.length > 0 ? clauses.join('; ') : 'its pinned segments match no series together'}.`,
    ];
  }
  return clauses.length > 0 ? [`In the key, ${clauses.join('; ')}.`] : [];
}

export const oecdGetDimensionValues = tool('oecd_get_dimension_values', {
  description:
    'Fetch the valid codes and labels for one dimension of a dataflow. ' +
    'Use to resolve human-readable names (countries, measures) to SDMX codes before querying with oecd_query_dataset. ' +
    'Pass query to match a code or label by substring — codelists run to a thousand-plus entries, ' +
    'and the response is a page of at most limit codes either way. ' +
    'A codelist is shared across dataflows and can list codes this one holds no data for: pass ' +
    'available_only to list only the codes with data, or key to list the codes with data given ' +
    "the key's other segments — a structure read, never a data download.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    flow_ref: z
      .string()
      .describe(
        'Full flow reference — e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I", or the bare ' +
          '"OECD.TAD.ARP,DF_AEI2024_DASHBOARD" form for a dataflow published without a ' +
          'datastructure prefix. Obtain from oecd_search_datasets.',
      ),
    dimension_id: z
      .string()
      .describe(
        'Dimension identifier to fetch codes for — e.g. "REF_AREA" or "MEASURE". ' +
          'Obtain valid dimension IDs from oecd_get_dataset_info.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring matched against both the code and its label, so "PA" and ' +
          '"percent" each reach the code "PA" / "Percent per annum". Omit to page the whole codelist.',
      ),
    available_only: z
      .boolean()
      .default(false)
      .describe(
        "List only the codes of this dimension that have data in this dataflow, from OECD's " +
          'availability record, with the time_range and observation_count they cover. ' +
          'Applied before query, offset, and limit. Default false: the whole codelist.',
      ),
    key: z
      .string()
      .optional()
      .describe(
        'Dot-delimited key in the oecd_query_dataset form, one segment per dimension in the ' +
          'order oecd_get_dataset_info gives — empty for a wildcard, "+" between codes, or "all". ' +
          "Lists the codes of this dimension that have data given the key's other segments, so " +
          'pass the key you plan to query. Implies available_only.',
      ),
    limit: countLimitSchema(LIMIT, 'Maximum codes to return.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first code to return within the matching list, applied before ' +
          'limit. Advance it to page; an offset past the last match returns an empty page.',
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
            name: z
              .string()
              .describe(
                'Human-readable label for the code — the code itself for a code with data that the codelist does not list.',
              ),
          })
          .describe('A valid SDMX code and its human-readable label.'),
      )
      .describe(
        'The requested page of codes, after available_only, query, offset, and limit are applied.',
      ),
    code_count: z
      .number()
      .describe("Number of codes in this page — not the size of the dimension's codelist."),
    available_only: z
      .boolean()
      .describe(
        'True when codes holds only the codes with data, as OECD records them. False for the whole codelist, including when availability was asked for and could not be read — the notice then says why.',
      ),
    time_range: z
      .object({
        start: z.string().describe('First day the observations cover, YYYY-MM-DD, inclusive.'),
        end: z.string().describe('Last day the observations cover, YYYY-MM-DD, inclusive.'),
      })
      .optional()
      .describe(
        'Span of the observations under key (the whole dataflow without one). Present when available_only applied and some series matches.',
      ),
    observation_count: z
      .number()
      .optional()
      .describe(
        'Observations under key (the whole dataflow without one), as OECD counts them. Present when available_only applied and OECD reported a count.',
      ),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the page needs explaining — a limit above the per-call maximum, availability ' +
          'that could not be read, a key that matches no series or pins a code that matches only by ' +
          'letter case, a dimension with no codelist, a query that matched nothing, or codes ' +
          'beyond the page. One string when several apply; states how to reach the rest.',
      ),
    effectiveQuery: z
      .string()
      .optional()
      .describe('The substring filter as applied. Absent when the whole codelist was paged.'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Codes matching before offset and limit, disclosed when the page does not cover them all.',
      ),
  },
  enrichmentTrailer: {
    // The notice is stored as written — it carries the caller's query and key and
    // OECD's codes — and escaped only where content[] renders it as Markdown.
    notice: { render: (notice) => `> ${escapeMarkdownInline(notice ?? '')}` },
  },
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
      when: 'The flow_ref does not correspond to a known dataflow.',
      recovery: 'Verify the flow_ref using oecd_search_datasets before calling this tool.',
    },
    {
      reason: 'dimension_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: "The dimension_id names no dimension of this dataflow's key — its time dimension included, which has no codelist.",
      recovery:
        'Inspect available dimensions first with oecd_get_dataset_info, ' +
        'then use one of the returned dimension IDs.',
    },
    {
      reason: 'invalid_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The key holds a character outside the SDMX key set, or fewer dot-delimited segments than the dataflow has dimensions.',
      recovery:
        'Use oecd_get_dataset_info to check dimension order and count, then rebuild the key with ' +
        'one segment per dimension — empty for a wildcard, "+" between codes — or pass "all".',
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
        'Retry once — a codelist response runs to megabytes and is occasionally slow — and raise OECD_TIMEOUT_MS if it keeps timing out; a value past 50 seconds also needs a client that waits that long for a tool result.',
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
      when: 'OECD answered with a body this server could not read — not JSON, or JSON whose fields do not have the shape SDMX gives them — or a datastructure naming a codelist outside the SDMX character set.',
      recovery:
        'Report the response this error describes and check that OECD_BASE_URL names the public SDMX API rather than a proxy in front of it; the same request returns the same body, so a retry will not help.',
    },
  ],

  async handler(input, ctx) {
    /**
     * A ref that does not parse is a syntax failure — no request is issued, so
     * nothing has been looked up and "not found" would assert something this
     * server never checked. The same string reaches oecd_get_dataset_info,
     * oecd_query_dataset, and the dataflow resource as `invalid_flow_ref`.
     */
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_ref "${input.flow_ref}" is not in the expected {agencyID},{dsd_id}@{df_id} or {agencyID},{df_id} format`,
      );
    }

    /**
     * A form-based client sends "" for a field left blank, which names no key.
     * A key outside the SDMX character set can never reach a URL, so it fails
     * here, before any request.
     */
    const key = input.key === '' ? undefined : input.key;
    if (key !== undefined && !SDMX_KEY_SAFE.test(key)) {
      throw ctx.fail(
        'invalid_key',
        `Key "${key}" holds a character outside the SDMX key set — letters, digits, ".", "+", "_", "-", and "%"`,
      );
    }
    const availableOnly = input.available_only || key !== undefined;
    const limit = applyCountLimit(input.limit, LIMIT, ctx);

    // One budget for every upstream read: a slow datastructure leaves the
    // codelist and the availability record only what is left of it.
    const budget = new UpstreamBudget(ctx.signal);

    /**
     * Every upstream read reports an OECD refusal the same way. The codelist and
     * availability reads sit outside the datastructure's catch and need the same
     * ladder — a throttle is charged across every endpoint, so it lands on
     * whichever of the three happens to be in flight.
     */
    const asUpstreamFailure = (err: unknown): unknown => {
      const refusal = upstreamRefusal(err);
      return refusal
        ? ctx.fail(refusal.reason, refusal.message, undefined, { cause: err as Error })
        : err;
    };

    ctx.log.info('Fetching dimension values', {
      flowRef: input.flow_ref,
      dimensionId: input.dimension_id,
      query: input.query,
      availableOnly,
      key,
      limit: limit.applied,
      offset: input.offset,
    });

    // Fetch the datastructure to find the codelist ref for this dimension
    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(budget, input.flow_ref);
    } catch (err) {
      if (isDataflowNotFound(err as Error)) {
        throw ctx.fail('dataflow_not_found', `Dataflow not found: ${input.flow_ref}`);
      }
      throw asUpstreamFailure(err);
    }

    const dim = dsd.dimensions.find((d) => d.id === input.dimension_id);
    if (!dim) {
      throw ctx.fail(
        'dimension_not_found',
        dsd.timeDimension?.id === input.dimension_id
          ? `${input.dimension_id} is the time dimension of ${input.flow_ref} and has no codelist; pass available_only: true with any other dimension for its time_range`
          : `Dimension "${input.dimension_id}" not found in dataflow ${input.flow_ref}`,
      );
    }

    // Only the segment count needs the datastructure; an every-series key has none to count.
    if (key !== undefined && availabilityKey(key) !== 'all') {
      const segments = key.split('.').length;
      if (segments < dsd.dimensions.length) {
        throw ctx.fail(
          'invalid_key',
          `Key "${key}" has ${segments} ${segments === 1 ? 'segment' : 'segments'}, but ${input.flow_ref} has ${dsd.dimensions.length} dimensions — one segment each, empty for a wildcard`,
        );
      }
    }

    /**
     * Read the codelist at the root and the version the datastructure names.
     * Both matter, and for the same reason: a codelist read from the wrong root
     * or at the wrong revision carries codes this dimension does not accept.
     */
    let codelistRead: Promise<OecdCode[]> | undefined;
    if (dim.codelistRef) {
      // Codelist ref: "{agencyID},{codelistID}"
      const clCommaIdx = dim.codelistRef.indexOf(',');
      const clAgencyId = clCommaIdx >= 0 ? dim.codelistRef.slice(0, clCommaIdx) : parts.agencyId;
      const codelistId = clCommaIdx >= 0 ? dim.codelistRef.slice(clCommaIdx + 1) : dim.codelistRef;
      codelistRead = getStructureService()
        .fetchCodelist(budget, clAgencyId, codelistId, dsd.serviceRoot, dim.codelistVersion)
        .catch((err: unknown) => {
          throw asUpstreamFailure(err);
        });
    }

    /**
     * The codelist and the availability record are independent reads of one
     * budget, so they go out together. Availability is best-effort: a read that
     * fails leaves the whole codelist standing, and only the caller's
     * cancellation or the budget running out ends the call from there — the
     * expiry reported through the same ladder as the codelist's.
     */
    const [codelist, read]: [OecdCode[] | undefined, AvailabilityOutcome | undefined] =
      await Promise.all([
        codelistRead,
        availableOnly
          ? readAvailability(budget, dsd, key).catch((err: unknown) => {
              throw asUpstreamFailure(err);
            })
          : undefined,
      ]);
    const availability = read?.kind === 'read' ? read.availability : undefined;

    /** One notice — the framework keeps only the last one written. */
    const notes: string[] = [];
    if (limit.notice) notes.push(limit.notice);
    if (read?.kind === 'failed') {
      notes.push(
        codelist
          ? `Availability could not be read (${read.failure}), so this lists the whole codelist, which can hold codes this dataflow has no data for.`
          : `Availability could not be read (${read.failure}), and this dimension has no codelist to list instead.`,
      );
    }
    if (availability) notes.push(...keyNotes(availability, dsd, key));
    if (!codelist && !read) {
      notes.push(
        'This dimension has no fixed codelist — it accepts dynamic or free-form values. ' +
          'Pass available_only: true to list the values that have data in this dataflow.',
      );
    }

    const codes = availability
      ? codesWithData(codelist ?? [], availability.codes.get(dim.id) ?? [])
      : (codelist ?? []);

    /**
     * Narrow the result set, not the rendering. Both client surfaces read the
     * same bounded page, so a 1,164-code dimension no longer ships 66 KB of
     * pairs to `structuredContent` while `content[]` shows an unreachable first
     * fifty.
     */
    const filter = input.query?.trim() ?? '';
    const term = filter.toLowerCase();
    const matched = term
      ? codes.filter(
          (c) => c.id.toLowerCase().includes(term) || c.name.toLowerCase().includes(term),
        )
      : codes;
    const page = matched.slice(input.offset, input.offset + limit.applied);

    if (filter) ctx.enrich.echo(filter);

    if (filter && codes.length > 0 && matched.length === 0) {
      notes.push(
        `No code in ${input.dimension_id} matches "${filter}". ` +
          `Try a shorter term, or omit query to page the full ${codes.length}-code list.`,
      );
    } else if (page.length < matched.length) {
      const shown = input.offset + page.length;
      const more = shown < matched.length;
      ctx.enrich.total(matched.length);
      notes.push(
        page.length === 0
          ? `Offset ${input.offset} is past the ${matched.length} matching codes — lower offset to page back into the list.`
          : `Showing codes ${input.offset + 1}–${shown} of ${matched.length}. ` +
              (more
                ? `Advance offset to ${shown} for the next page${filter ? '' : ', or pass query to narrow by code or label'}.`
                : 'This is the last page.'),
      );
    }
    if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

    ctx.log.info('Dimension values fetched', {
      flowRef: input.flow_ref,
      dimensionId: input.dimension_id,
      codelistSize: codelist?.length,
      availability: read?.kind,
      matchCount: matched.length,
      returned: page.length,
    });

    return {
      flow_ref: input.flow_ref,
      dimension_id: input.dimension_id,
      codes: page.map((c) => ({ id: c.id, name: c.name })),
      code_count: page.length,
      available_only: availability !== undefined,
      ...(availability?.timeRange && {
        time_range: { start: availability.timeRange.start, end: availability.timeRange.end },
      }),
      ...(availability?.observationCount !== undefined && {
        observation_count: availability.observationCount,
      }),
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const lines = [
      `**Dimension: ${escapeMarkdownInline(result.dimension_id)}** (flow: ${escapeMarkdownInline(result.flow_ref)})`,
      `${result.code_count} ${result.code_count === 1 ? 'code' : 'codes'} in this page, ${
        result.available_only
          ? 'only codes with data in this dataflow (available_only: true)'
          : 'from the whole codelist (available_only: false)'
      }`,
      ...(result.time_range
        ? [`Time range: ${result.time_range.start} to ${result.time_range.end}`]
        : []),
      ...(result.observation_count !== undefined
        ? [`Observations: ${result.observation_count}`]
        : []),
      formatTable(
        ['Code', 'Name'],
        result.codes.map((c) => [c.id, c.name]),
      ),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
