/**
 * @fileoverview Tests for oecd_list_agencies tool.
 * @module tests/tools/list-agencies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdListAgencies } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery } from '../helpers/error-contract.js';

const FAKE_BASE = 'https://fake.oecd.test';

function setupMockFetch(responseBody: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    }),
  );
}

// Real API format: id is "DSD_XXX@DF_YYY" (combined), structure is a string URN.
const DATAFLOWS_RESPONSE = {
  data: {
    dataflows: [
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_NAAG@DF_NAAG_I',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAAG(1.0)',
        name: 'National Accounts',
        annotations: [],
      },
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_NAAG@DF_NAAG_II',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAAG(1.0)',
        name: 'National Accounts II',
        annotations: [],
      },
      {
        agencyID: 'OECD.EDU.IMEP',
        id: 'DSD_SPI@DF_SPI',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.EDU.IMEP:DSD_SPI(1.0)',
        name: 'SPI',
        annotations: [],
      },
    ],
  },
};

describe('oecdListAgencies', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
  });

  it('returns aggregated agency counts', async () => {
    setupMockFetch(DATAFLOWS_RESPONSE);
    const ctx = createMockContext({ errors: oecdListAgencies.errors });
    const result = await oecdListAgencies.handler({}, ctx);

    expect(result.source).toBe('OECD');
    expect(result.total_dataflows).toBe(3);
    expect(result.total_agencies).toBe(2);
    // NAD has 2, EDU.IMEP has 1 — sorted descending
    expect(result.agencies[0]).toMatchObject({ agency_id: 'OECD.SDD.NAD', dataflow_count: 2 });
    expect(result.agencies[1]).toMatchObject({ agency_id: 'OECD.EDU.IMEP', dataflow_count: 1 });
  });

  it('throws ctx.fail(upstream_unavailable) when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    const ctx = createMockContext({ errors: oecdListAgencies.errors });
    await expect(oecdListAgencies.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdListAgencies, 'upstream_unavailable') },
      },
    });
  }, 20_000);

  it('names a throttled catalog read rate_limited rather than a generic outage', async () => {
    // The wait that clears a throttle is seconds, not the minutes an outage
    // hint asks for, and the two used to arrive under the same reason here.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              'You have exceeded the number of requests currently permitted in the OECD Data API.',
              { status: 429, headers: { 'retry-after': '99999' } },
            ),
          ),
        ),
    );
    const ctx = createMockContext({ errors: oecdListAgencies.errors });

    await expect(oecdListAgencies.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdListAgencies, 'rate_limited') },
      },
    });
  });

  it('separates a redirecting host from a transient outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('', { status: 302, headers: { Location: 'https://elsewhere.test/' } }),
        ),
    );
    const ctx = createMockContext({ errors: oecdListAgencies.errors });

    // Not upstream_unavailable: that reason is retryable and its hint says to
    // wait, and no wait clears a redirect.
    await expect(oecdListAgencies.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'upstream_redirect', retryable: false },
    });
    // The sentence the fetch boundary wrote survives the service's relabel.
    await expect(oecdListAgencies.handler({}, ctx)).rejects.toThrow(/OECD_BASE_URL/);
  });

  it('formats output with agency table and totals', () => {
    const output = {
      agencies: [
        {
          agency_id: 'OECD.SDD.NAD',
          directorate: 'Statistics and Data Directorate',
          dataflow_count: 500,
        },
        { agency_id: 'ESTAT', dataflow_count: 100 },
      ],
      total_agencies: 2,
      total_dataflows: 600,
      source: 'OECD' as const,
    };
    const blocks = oecdListAgencies.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OECD.SDD.NAD');
    expect(text).toContain('Statistics and Data Directorate');
    expect(text).toContain('500');
    expect(text).toContain('ESTAT');
    expect(text).toContain('600');
    expect(text).toContain('Source: OECD');
  });
});

// ── Directorates ──────────────────────────────────────────────────────────────

const AGENCY_SCHEME_RESPONSE = {
  data: {
    agencySchemes: [
      {
        agencies: [
          { id: 'SDD', name: { en: 'Statistics and Data Directorate' } },
          { id: 'EDU', name: 'Directorate for Education and Skills' },
        ],
      },
    ],
  },
};

/** `ESTAT` ships dataflows through the same catalog but is not an OECD agency. */
const MIXED_PUBLISHER_DATAFLOWS = {
  data: {
    dataflows: [
      { agencyID: 'OECD.SDD.NAD', id: 'DSD_NAAG@DF_NAAG_I', name: 'National Accounts' },
      { agencyID: 'OECD.EDU.IMEP', id: 'DSD_SPI@DF_SPI', name: 'SPI' },
      { agencyID: 'ESTAT', id: 'SEEA_AEA_A', name: 'Air emissions accounts' },
    ],
  },
};

describe('oecdListAgencies directorates', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
  });

  afterEach(() => {
    http.restore();
  });

  function routeDataflows(): void {
    http.route({
      match: `${FAKE_BASE}/dataflow`,
      respond: () => Response.json(MIXED_PUBLISHER_DATAFLOWS),
    });
  }

  it('names the directorate each agency reports to', async () => {
    http.route({
      match: `${FAKE_BASE}/agencyscheme/OECD`,
      respond: () => Response.json(AGENCY_SCHEME_RESPONSE),
    });
    routeDataflows();

    const ctx = createMockContext({ errors: oecdListAgencies.errors });
    const result = await oecdListAgencies.handler({}, ctx);

    expect(result.agencies).toContainEqual({
      agency_id: 'OECD.SDD.NAD',
      directorate: 'Statistics and Data Directorate',
      dataflow_count: 1,
    });
    expect(result.agencies).toContainEqual({
      agency_id: 'OECD.EDU.IMEP',
      directorate: 'Directorate for Education and Skills',
      dataflow_count: 1,
    });
  });

  it('leaves a publisher with no directorate segment unlabelled rather than wrong or blank', async () => {
    http.route({
      match: `${FAKE_BASE}/agencyscheme/OECD`,
      respond: () => Response.json(AGENCY_SCHEME_RESPONSE),
    });
    routeDataflows();

    const ctx = createMockContext({ errors: oecdListAgencies.errors });
    const result = await oecdListAgencies.handler({}, ctx);

    const estat = result.agencies.find((a) => a.agency_id === 'ESTAT');
    expect(estat).toEqual({ agency_id: 'ESTAT', dataflow_count: 1 });
    expect(estat).not.toHaveProperty('directorate');
  });

  it('still returns the agency list when the agency scheme is unreachable', async () => {
    http.route({
      match: `${FAKE_BASE}/agencyscheme/OECD`,
      respond: () => new Response('upstream boom', { status: 503 }),
    });
    routeDataflows();

    const ctx = createMockContext({ errors: oecdListAgencies.errors });
    const result = await oecdListAgencies.handler({}, ctx);

    expect(result.total_agencies).toBe(3);
    expect(result.agencies.every((a) => a.directorate === undefined)).toBe(true);
  });
});
