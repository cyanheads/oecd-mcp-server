/**
 * @fileoverview oecd_list_agencies — list OECD SDMX agencies with their directorate and dataflow count.
 * @module mcp-server/tools/definitions/list-agencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  directorateCode,
  getStructureService,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDataflow } from '@/services/oecd-structure/types.js';
import { formatTable } from '@/utils/format-table.js';

export const oecdListAgencies = tool('oecd_list_agencies', {
  description:
    'List OECD SDMX agencies, the directorate each belongs to, and the number of dataflows each publishes. ' +
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
            directorate: z
              .string()
              .optional()
              .describe(
                'Name of the OECD directorate the agency sits in, resolved from the ' +
                  'directorate segment of the identifier — OECD.SDD.NAD is "Statistics and Data ' +
                  'Directorate". Absent for a publisher outside OECD and when the agency scheme ' +
                  'could not be reached.',
              ),
            dataflow_count: z.number().describe('Number of dataflows published by this agency.'),
          })
          .describe('An agency, its directorate, and its dataflow count.'),
      )
      .describe('Agencies and their dataflow counts, sorted descending by count.'),
    directorate_lookup_failed_for: z
      .array(z.string().describe('Agency ID whose directorate lookup failed.'))
      .optional()
      .describe('Agencies affected when the OECD agency scheme could not be read.'),
    total_agencies: z.number().describe('Total number of distinct agencies.'),
    total_dataflows: z.number().describe('Total number of dataflows across all agencies.'),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  errors: [
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
        'Retry once — the whole-catalog response runs to megabytes and is occasionally slow — and raise OECD_TIMEOUT_MS if it keeps timing out; a value past 50 seconds also needs a client that waits that long for a tool result.',
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

  async handler(_input, ctx) {
    ctx.log.info('Fetching all OECD dataflows to tally agencies');
    const budget = new UpstreamBudget(ctx.signal);

    // Independent of the catalog fetch, and not load-bearing: the agency list
    // stands on its own, so a degraded scheme costs the directorate labels
    // rather than the whole call. Both reads spend the same budget.
    const service = getStructureService();
    const directoratesPromise = service.fetchDirectorates(budget).catch((err: unknown) => {
      if (ctx.signal?.aborted) throw err;
      ctx.log.warning('OECD agency scheme unavailable — listing agencies without directorates', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    let dataflows: OecdDataflow[];
    let directorates: Map<string, string> | null;
    try {
      [dataflows, directorates] = await Promise.all([
        service.fetchDataflows(budget),
        directoratesPromise,
      ]);
    } catch (err) {
      const refusal = upstreamRefusal(err);
      if (refusal) {
        throw ctx.fail(refusal.reason, refusal.message, undefined, { cause: err as Error });
      }
      throw err;
    }

    // Aggregate by agency
    const counts = new Map<string, number>();
    for (const df of dataflows) {
      counts.set(df.agencyId, (counts.get(df.agencyId) ?? 0) + 1);
    }

    const agencies = [...counts.entries()]
      .map(([agency_id, dataflow_count]) => {
        const code = directorateCode(agency_id);
        const directorate = code ? directorates?.get(code) : undefined;
        return { agency_id, ...(directorate ? { directorate } : {}), dataflow_count };
      })
      .sort((a, b) => b.dataflow_count - a.dataflow_count);

    const failedFor = directorates
      ? []
      : agencies.map((agency) => agency.agency_id).filter(directorateCode);

    ctx.log.info('Agency list built', {
      agencyCount: agencies.length,
      totalDataflows: dataflows.length,
    });

    return {
      agencies,
      ...(failedFor.length > 0 ? { directorate_lookup_failed_for: failedFor } : {}),
      total_agencies: agencies.length,
      total_dataflows: dataflows.length,
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    const lines = [
      `**OECD Agencies** (${result.total_agencies} agencies, ${result.total_dataflows} total dataflows)`,
      '',
      formatTable(
        ['Agency', 'Directorate', 'Dataflows'],
        result.agencies.map((a) => [a.agency_id, a.directorate ?? '—', String(a.dataflow_count)]),
      ),
      ...(result.directorate_lookup_failed_for
        ? [
            '',
            `Directorate lookup failed for ${result.directorate_lookup_failed_for.map(escapeMarkdownInline).join(', ')}.`,
          ]
        : []),
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
