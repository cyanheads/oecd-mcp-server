/**
 * @fileoverview oecd_get_dimension_values — fetch a filtered, paged set of valid
 * codes for one dimension of a dataflow.
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

/** Codes returned when the caller names no page size. */
const DEFAULT_LIMIT = 50;

/** Largest page a caller can ask for — enough to hold most codelists whole. */
const MAX_LIMIT = 500;

export const oecdGetDimensionValues = tool('oecd_get_dimension_values', {
  description:
    'Fetch the valid codes and labels for one dimension of a dataflow. ' +
    'Use to resolve human-readable names (countries, measures) to SDMX codes before querying with oecd_query_dataset. ' +
    'Pass query to match a code or label by substring — codelists run to a thousand-plus entries, ' +
    'and the response is a page of at most limit codes either way.',
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Maximum codes to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
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
            name: z.string().describe('Human-readable label for the code.'),
          })
          .describe('A valid SDMX code and its human-readable label.'),
      )
      .describe('The requested page of codes, after query, offset, and limit are applied.'),
    code_count: z
      .number()
      .describe("Number of codes in this page — not the size of the dimension's codelist."),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the page needs explaining — the dimension has no codelist, the query ' +
          'matched nothing, or codes remain beyond the page. States how to reach the rest.',
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
      query: input.query,
      limit: input.limit,
      offset: input.offset,
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
      // Dimension has no codelist — return empty with an explanatory notice
      ctx.log.info('Dimension has no codelist reference', {
        flowRef: input.flow_ref,
        dimensionId: input.dimension_id,
      });
      ctx.enrich.notice(
        'This dimension has no fixed codelist — it accepts dynamic or free-form values. ' +
          'Inspect actual data observations with oecd_query_dataset to discover valid values.',
      );
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

    /**
     * Read the codelist at the root and the version the datastructure names.
     * Both matter, and for the same reason: a codelist read from the wrong root
     * or at the wrong revision carries codes this dimension does not accept.
     */
    const codes: OecdCode[] = await getStructureService().fetchCodelist(
      clAgencyId,
      codelistId,
      ctx.signal,
      dsd.serviceRoot,
      dim.codelistVersion,
    );

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
    const page = matched.slice(input.offset, input.offset + input.limit);

    if (filter) ctx.enrich.echo(filter);

    if (filter && matched.length === 0) {
      ctx.enrich.notice(
        `No code in ${input.dimension_id} matches "${filter}". ` +
          `Try a shorter term, or omit query to page the full ${codes.length}-code list.`,
      );
    } else if (page.length < matched.length) {
      const shown = input.offset + page.length;
      const more = shown < matched.length;
      ctx.enrich.total(matched.length);
      ctx.enrich.notice(
        page.length === 0
          ? `Offset ${input.offset} is past the ${matched.length} matching codes — lower offset to page back into the list.`
          : `Showing codes ${input.offset + 1}–${shown} of ${matched.length}. ` +
              (more
                ? `Advance offset to ${shown} for the next page${filter ? '' : ', or pass query to narrow by code or label'}.`
                : 'This is the last page.'),
      );
    }

    ctx.log.info('Dimension values fetched', {
      flowRef: input.flow_ref,
      dimensionId: input.dimension_id,
      codelistSize: codes.length,
      matchCount: matched.length,
      returned: page.length,
    });

    return {
      flow_ref: input.flow_ref,
      dimension_id: input.dimension_id,
      codes: page.map((c) => ({ id: c.id, name: c.name })),
      code_count: page.length,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const lines = [
      `**Dimension: ${result.dimension_id}** (flow: ${result.flow_ref})`,
      `${result.code_count} ${result.code_count === 1 ? 'code' : 'codes'} in this page`,
      '| Code | Name |',
      '|------|------|',
      ...result.codes.map((c) => `| ${c.id} | ${c.name} |`),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
