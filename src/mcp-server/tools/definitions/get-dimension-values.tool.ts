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
  dotOnlyKeyNotice,
  normalizeDimensionKey,
  type OecdAvailability,
  readAvailability,
  validatePeriodBounds,
} from '@/services/oecd-structure/availability.js';
import { dataflowVersionInput } from '@/services/oecd-structure/dataflow-version.js';
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
  hasPeriod: boolean,
): string[] {
  const clauses = describeFindings(diagnoseKey(availability, dsd.dimensions, key ?? 'all'));
  if (availability.observationCount === 0) {
    if (hasPeriod) {
      return [
        availabilityKey(key) === 'all'
          ? 'OECD records no observations for this dataflow in the requested period.'
          : 'OECD records no observations for the requested period under this key.',
      ];
    }
    if (availabilityKey(key) === 'all') return ['OECD records no observations for this dataflow.'];
    return [
      `The key matches no series: ${clauses.length > 0 ? clauses.join('; ') : 'its pinned segments match no series together'}.`,
    ];
  }
  return clauses.length > 0 ? [`In the key, ${clauses.join('; ')}.`] : [];
}

export const oecdGetDimensionValues = tool('oecd_get_dimension_values', {
  description:
    "Fetch the valid codes and labels for one dimension of a dataflow, including each code's parent ID in hierarchical codelists. Use to resolve human-readable names (countries, measures) to SDMX codes before querying with oecd_query_dataset. Pass parent to list direct children of one parent code, or query to match a code or label by substring — codelists run to a thousand-plus entries, and the response is a page of at most limit codes either way. A codelist is shared across dataflows and can list codes this one holds no data for: pass available_only to list only the codes with data, or key to list the codes with data given the key's other segments — a structure read, never a data download.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    flow_ref: z
      .string()
      .describe(
        'Full flow reference — e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I", or the bare "OECD.TAD.ARP,DF_AEI2024_DASHBOARD" form for a dataflow published without a datastructure prefix. Obtain from oecd_search_datasets.',
      ),
    version: dataflowVersionInput,
    dimension_id: z
      .string()
      .describe(
        'Dimension identifier to fetch codes for — e.g. "REF_AREA" or "MEASURE". Obtain valid dimension IDs from oecd_get_dataset_info.',
      ),
    parent: z
      .string()
      .optional()
      .describe(
        'Filter to codes whose parent code equals this value (exact case-sensitive code match, e.g. "FRA" for France\'s TL2 regions). Applied after available_only and key, and before query, offset, and limit. Omit to include codes at all hierarchy levels.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring matched against both the code and its label, so "PA" and "percent" each reach the code "PA" / "Percent per annum". Applied after available_only, key, and parent. Omit to page the full matching list.',
      ),
    available_only: z
      .boolean()
      .default(false)
      .describe(
        "List only the codes of this dimension that have data in this dataflow, from OECD's availability record, with the time_range and observation_count they cover. Applied before parent, query, offset, and limit. Default false: the whole codelist.",
      ),
    key: z
      .string()
      .optional()
      .describe(
        'Dot-delimited key in the oecd_query_dataset form, one segment per dimension in the order oecd_get_dataset_info gives — empty for a wildcard, "+" between codes, or "all". Lists the codes of this dimension that have data given the key\'s other segments, so pass the key you plan to query. Implies available_only.',
      ),
    start_period: z
      .string()
      .optional()
      .describe(
        'Inclusive lower SDMX period bound, e.g. "2024" or "2024-Q1". A nonblank value implies available_only.',
      ),
    end_period: z
      .string()
      .optional()
      .describe(
        'Inclusive upper SDMX period bound, e.g. "2024" or "2024-Q4". A nonblank value implies available_only.',
      ),
    limit: countLimitSchema(LIMIT, 'Maximum codes to return.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first code to return within the matching list, applied before limit. Advance it to page; an offset past the last match returns an empty page.',
      ),
  }),
  output: z.object({
    flow_ref: z.string().describe('The flow reference this dimension belongs to.'),
    version: z.string().optional().describe('Resolved dataflow edition.'),
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
            parent: z
              .string()
              .optional()
              .describe('Parent code ID in hierarchical codelists; absent for top-level codes.'),
          })
          .describe(
            'A valid SDMX code, its human-readable label, and its parent code when hierarchical.',
          ),
      )
      .describe(
        'The requested page of codes, after available_only, parent, query, offset, and limit are applied.',
      ),
    code_count: z
      .number()
      .describe("Number of codes in this page — not the size of the dimension's codelist."),
    available_only: z
      .boolean()
      .describe(
        'True when codes holds only the codes with data, as OECD records them. False for the whole codelist, including when availability was asked for and could not be read — the notice then says why.',
      ),
    query_start_period: z
      .string()
      .optional()
      .describe('Requested lower period bound, present when applied to availability.'),
    query_end_period: z
      .string()
      .optional()
      .describe('Requested upper period bound, present when applied to availability.'),
    time_range: z
      .object({
        start: z.string().describe('First day of OECD’s reported coverage, YYYY-MM-DD, inclusive.'),
        end: z.string().describe('Last day of OECD’s reported coverage, YYYY-MM-DD, inclusive.'),
      })
      .optional()
      .describe(
        'Time range reported by OECD, when available. Can describe source coverage beyond the applied period bounds.',
      ),
    observation_count: z
      .number()
      .optional()
      .describe(
        'Observations under the key and applied period bounds, as OECD counts them. Present when available_only applied and OECD reported a count.',
      ),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the page needs explaining — a limit above the per-call maximum, availability that could not be read, a key that matches no series or pins a code that matches only by letter case, a dimension with no codelist, a parent filter or query that matched nothing, or codes beyond the page. One string when several apply; states how to reach the rest.',
      ),
    effectiveQuery: z
      .string()
      .optional()
      .describe('The substring filter as applied. Absent when the whole codelist was paged.'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Codes matching after available_only, parent, and query — before offset and limit — disclosed when the page does not cover them all.',
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
      reason: 'codelist_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'OECD does not serve the codelist revision referenced by an explicitly selected edition.',
      recovery:
        'Inspect the published editions with oecd_get_dataset_info and choose an edition whose codelist is available.',
    },
    {
      reason: 'invalid_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The key holds a character outside the SDMX key set, fewer dot-delimited segments than the dataflow has dimensions, or a non-empty segment past the dimension count.',
      recovery:
        'Use oecd_get_dataset_info to check dimension order and count, then rebuild the key with one segment per dimension — empty for a wildcard, "+" between codes — or pass "all".',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A period bound is an impossible calendar date or start_period is after end_period.',
      recovery:
        'Use valid SDMX period codes such as "2024", "2024-Q1", or "2024-02-29", with start_period on or before end_period.',
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
    const bounds = validatePeriodBounds(input.start_period, input.end_period);
    if (!bounds.ok) throw ctx.fail('invalid_period', bounds.message);
    const hasPeriod = bounds.startPeriod !== undefined || bounds.endPeriod !== undefined;
    const availableOnly = input.available_only || key !== undefined || hasPeriod;
    const parentFilter = input.parent?.trim() || undefined;
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
      parent: parentFilter,
      query: input.query,
      availableOnly,
      key,
      limit: limit.applied,
      offset: input.offset,
    });

    // Fetch the datastructure to find the codelist ref for this dimension
    let dsd: OecdDataStructure;
    try {
      dsd = await getStructureService().fetchDataStructure(budget, input.flow_ref, input.version);
    } catch (err) {
      if (err instanceof Error && isDataflowNotFound(err)) {
        throw ctx.fail(
          'dataflow_not_found',
          input.version === undefined ? `Dataflow not found: ${input.flow_ref}` : err.message,
        );
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

    // Only the segment count needs the datastructure; every-series keys pass through unchanged.
    let normalizedKey = key;
    if (key !== undefined) {
      const checked = normalizeDimensionKey(key, dsd.dimensions.length);
      if (!checked.ok) {
        throw ctx.fail(
          'invalid_key',
          checked.reason === 'too_short'
            ? `Key "${key}" has ${checked.segmentCount} ${checked.segmentCount === 1 ? 'segment' : 'segments'}, but ${input.flow_ref} has ${checked.dimensionCount} dimensions — one segment each, empty for a wildcard`
            : `Key "${key}" has ${checked.segmentCount} segments, but ${input.flow_ref} has ${checked.dimensionCount} dimensions — time is not a key segment; pass time filters via start_period / end_period`,
        );
      }
      normalizedKey = checked.key;
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
        .fetchCodelist(
          budget,
          clAgencyId,
          codelistId,
          dsd.serviceRoot,
          dim.codelistVersion,
          input.version === undefined ? 'latest' : 'fail',
        )
        .catch((err: unknown) => {
          if (
            input.version !== undefined &&
            dim.codelistVersion !== undefined &&
            err instanceof Error &&
            isDataflowNotFound(err)
          ) {
            throw ctx.fail('codelist_not_found', err.message, undefined, { cause: err });
          }
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
          ? readAvailability(budget, dsd, normalizedKey, dsd.dataRoot, bounds, input.version).catch(
              (err: unknown) => {
                throw asUpstreamFailure(err);
              },
            )
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
      if (hasPeriod) notes.push('The requested period was not applied.');
    }
    if (availability) {
      const keyNotice =
        key === undefined ? undefined : dotOnlyKeyNotice(key, dsd.dimensions.length);
      if (keyNotice) notes.push(keyNotice);
      notes.push(...keyNotes(availability, dsd, normalizedKey, hasPeriod));
    }
    if (!codelist && !read) {
      notes.push(
        'This dimension has no fixed codelist — it accepts dynamic or free-form values. Pass available_only: true to list the values that have data in this dataflow.',
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
    const byParent =
      parentFilter !== undefined ? codes.filter((c) => c.parent === parentFilter) : codes;
    const filter = input.query?.trim() ?? '';
    const term = filter.toLowerCase();
    const matched = term
      ? byParent.filter(
          (c) => c.id.toLowerCase().includes(term) || c.name.toLowerCase().includes(term),
        )
      : byParent;
    const page = matched.slice(input.offset, input.offset + limit.applied);

    if (filter) ctx.enrich.echo(filter);

    if (parentFilter !== undefined && codes.length > 0 && byParent.length === 0) {
      const caseMatch = codes.find(
        (c) => c.parent !== undefined && c.parent.toLowerCase() === parentFilter.toLowerCase(),
      )?.parent;
      notes.push(
        caseMatch !== undefined
          ? `No code in ${input.dimension_id} has parent "${parentFilter}" — found parent "${caseMatch}" (parent codes are case-sensitive).`
          : `No code in ${input.dimension_id} has parent "${parentFilter}". Omit parent to inspect all ${codes.length} codes and their parent values.`,
      );
    } else if (filter && byParent.length > 0 && matched.length === 0) {
      notes.push(
        parentFilter !== undefined
          ? `No code in ${input.dimension_id} with parent "${parentFilter}" matches "${filter}". Try a shorter term, or omit query to page ${byParent.length === 1 ? 'the 1 code' : `all ${byParent.length} codes`} under "${parentFilter}".`
          : `No code in ${input.dimension_id} matches "${filter}". Try a shorter term, or omit query to page the full ${byParent.length}-code list.`,
      );
    } else if (page.length < matched.length) {
      const shown = input.offset + page.length;
      const more = shown < matched.length;
      ctx.enrich.total(matched.length);
      notes.push(
        page.length === 0
          ? `Offset ${input.offset} is past the ${matched.length} matching codes — lower offset to page back into the list.`
          : `Showing codes ${input.offset + 1}–${shown} of ${matched.length}. ${
              more
                ? `Advance offset to ${shown} for the next page${filter ? '' : ', or pass query to narrow by code or label'}.`
                : 'This is the last page.'
            }`,
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
      ...(dsd.version === undefined ? {} : { version: dsd.version }),
      dimension_id: input.dimension_id,
      codes: page.map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.parent !== undefined ? { parent: c.parent } : {}),
      })),
      code_count: page.length,
      available_only: availability !== undefined,
      ...(availability &&
        bounds.startPeriod !== undefined && { query_start_period: bounds.startPeriod }),
      ...(availability && bounds.endPeriod !== undefined && { query_end_period: bounds.endPeriod }),
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
    const hasParent = result.codes.some((c) => c.parent !== undefined);
    const start = result.query_start_period;
    const end = result.query_end_period;
    const period =
      start !== undefined
        ? end !== undefined
          ? `${escapeMarkdownInline(start)} to ${escapeMarkdownInline(end)}`
          : `from ${escapeMarkdownInline(start)}`
        : end !== undefined
          ? `through ${escapeMarkdownInline(end)}`
          : undefined;
    const lines = [
      `**Dimension: ${escapeMarkdownInline(result.dimension_id)}** (flow: ${escapeMarkdownInline(result.flow_ref)})`,
      ...(result.version ? [`Edition: ${result.version}`] : []),
      `${result.code_count} ${result.code_count === 1 ? 'code' : 'codes'} in this page, ${
        result.available_only
          ? 'only codes with data in this dataflow (available_only: true)'
          : 'from the whole codelist (available_only: false)'
      }`,
      ...(period !== undefined ? [`Period: ${period}`] : []),
      ...(result.time_range
        ? [
            `${period === undefined ? 'Time range' : 'OECD time range'}: ${result.time_range.start} to ${result.time_range.end}`,
          ]
        : []),
      ...(result.observation_count !== undefined
        ? [`Observations: ${result.observation_count}`]
        : []),
      formatTable(
        hasParent ? ['Code', 'Name', 'Parent'] : ['Code', 'Name'],
        hasParent
          ? result.codes.map((c) => [c.id, c.name, c.parent ?? '—'])
          : result.codes.map((c) => [c.id, c.name]),
      ),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
