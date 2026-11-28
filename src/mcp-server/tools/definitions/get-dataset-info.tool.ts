/**
 * @fileoverview oecd_get_dataset_info — fetch dimensions and key construction info for a dataflow.
 * @module mcp-server/tools/definitions/get-dataset-info.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import { dataflowVersionInput } from '@/services/oecd-structure/dataflow-version.js';
import {
  getStructureService,
  isDataflowNotFound,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataStructure } from '@/services/oecd-structure/types.js';
import { formatDataflowDescription } from '@/utils/format-dataflow-description.js';
import { formatTable } from '@/utils/format-table.js';

export const oecdGetDatasetInfo = tool('oecd_get_dataset_info', {
  description:
    "Fetch a dataflow's metadata (name, full description, linked resources), dimensions, their order, and how to construct a query key. " +
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
    version: dataflowVersionInput,
  }),
  output: z.object({
    flow_ref: z.string().describe('The resolved flow reference.'),
    version: z.string().optional().describe('Resolved dataflow edition.'),
    published_versions: z
      .array(z.string().describe('Published dataflow edition.'))
      .optional()
      .describe('Published editions when the OECD edition catalog could be read.'),
    name: z
      .string()
      .optional()
      .describe(
        'Human-readable dataflow name. Omitted when the upstream response carries no dataflow entry.',
      ),
    description: z
      .string()
      .optional()
      .describe(
        'Full dataflow abstract with valid HTTP, HTTPS, and mailto links preserved as Markdown [label](url). Omitted when OECD publishes no description.',
      ),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension identifier — e.g. REF_AREA.'),
            name: z
              .string()
              .describe(
                'Concept name for the dimension — e.g. "Reference area" for REF_AREA. ' +
                  'Repeats the id when no concept name was resolved.',
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
            'Concept name for the time dimension, repeating the id when no name was resolved.',
          ),
        position: z.number().describe('Position after all regular dimensions.'),
      })
      .optional()
      .describe(
        'Time dimension — used for start_period/end_period filtering in oecd_query_dataset.',
      ),
    concept_lookup_failed_for: z
      .array(z.string().describe('Dimension ID whose concept scheme could not be read.'))
      .optional()
      .describe(
        'Dimensions affected by a failed concept-name lookup, including time when affected.',
      ),
    key_example: z
      .string()
      .describe(
        'Example dot-delimited key with wildcards — each dot corresponds to one dimension in position order. ' +
          'Empty segments are wildcards. Replace with actual codes from oecd_get_dimension_values.',
      ),
    resources: z
      .array(
        z
          .object({
            label: z.string().describe('Human-readable resource label.'),
            url: z.string().describe('Target http or https URL for the linked resource.'),
          })
          .describe(
            'An external resource published on the dataflow (methodology document, boundary file, or bulk download).',
          ),
      )
      .optional()
      .describe(
        'External resources from the dataflow EXT_RESOURCE annotations. Omitted when none are present.',
      ),
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
      when: 'OECD publishes no dataflow under the provided flow_ref, or the dataflow resolves to no datastructure.',
      recovery:
        'Verify the flow_ref with oecd_search_datasets. ' +
        'The dataflow may have been renamed or removed.',
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
        'Retry once — a structure response runs to megabytes and is occasionally slow — and raise OECD_TIMEOUT_MS if it keeps timing out; a value past 50 seconds also needs a client that waits that long for a tool result.',
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
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_ref "${input.flow_ref}" is not in the expected {agencyID},{dsd_id}@{df_id} or {agencyID},{df_id} format`,
      );
    }

    ctx.log.info('Fetching OECD datastructure', { flowRef: input.flow_ref });

    const budget = new UpstreamBudget(ctx.signal);
    const service = getStructureService();
    let dsd: OecdDataStructure;
    try {
      dsd = await service.fetchDataStructure(budget, input.flow_ref, input.version);
    } catch (err) {
      if (err instanceof Error && isDataflowNotFound(err)) {
        throw ctx.fail(
          'dataflow_not_found',
          input.version === undefined ? `Dataflow not found: ${input.flow_ref}` : err.message,
        );
      }
      const refusal = upstreamRefusal(err);
      if (refusal) {
        throw ctx.fail(refusal.reason, refusal.message, undefined, { cause: err as Error });
      }
      throw err;
    }

    if (!dsd.dimensions.length) {
      throw ctx.fail('dataflow_not_found', `Dataflow ${input.flow_ref} returned no dimensions`);
    }

    // Edition discovery is an independent enrichment. Keep its failure from
    // blocking a structure that has already resolved successfully.
    const editions =
      dsd.version === undefined
        ? undefined
        : await service.fetchDataflowVersions(budget.within(1500), input.flow_ref, dsd.dataRoot);

    // Build a wildcard key example
    const keyExample = dsd.dimensions.map(() => '').join('.');

    ctx.log.info('Datastructure fetched', {
      flowRef: input.flow_ref,
      dimensionCount: dsd.dimensions.length,
    });

    return {
      flow_ref: input.flow_ref,
      ...(dsd.version === undefined ? {} : { version: dsd.version }),
      ...(editions === undefined ? {} : { published_versions: editions }),
      ...(dsd.name !== undefined ? { name: dsd.name } : {}),
      ...(dsd.description !== undefined ? { description: dsd.description } : {}),
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
      ...(dsd.conceptLookupFailedFor
        ? { concept_lookup_failed_for: dsd.conceptLookupFailedFor }
        : {}),
      ...(dsd.resources !== undefined ? { resources: dsd.resources } : {}),
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const dimRows = result.dimensions.map((d) => [
      String(d.position),
      d.id,
      d.name,
      d.codelist_ref ?? '—',
    ]);
    if (result.time_dimension) {
      dimRows.push([
        String(result.time_dimension.position),
        `${result.time_dimension.id} (time)`,
        result.time_dimension.name,
        '—',
      ]);
    }

    const lines = [
      `**Dataflow: ${escapeMarkdownInline(result.flow_ref)}**`,
      ...(result.version ? [`Edition: ${result.version}`] : []),
      ...(result.published_versions
        ? [`Published editions: ${result.published_versions.join(', ')}`]
        : []),
      ...(result.name ? [`**Name:** ${escapeMarkdownInline(result.name)}`] : []),
      ...(result.description ? ['', formatDataflowDescription(result.description)] : []),
      '',
      formatTable(['Pos', 'Dimension ID', 'Name', 'Codelist'], dimRows),
      ...(result.concept_lookup_failed_for
        ? [
            '',
            `Concept-name lookup failed for ${result.concept_lookup_failed_for.map(escapeMarkdownInline).join(', ')}.`,
          ]
        : []),
      '',
      `**Key example (all wildcards):** ${escapeMarkdownInline(result.key_example || '.')}`,
      'Replace empty segments with codes from oecd_get_dimension_values.',
      ...(result.resources?.length
        ? [
            '',
            '**Resources:**',
            ...result.resources.map((r) => `- ${markdownLink(r.label, r.url)}`),
          ]
        : []),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
