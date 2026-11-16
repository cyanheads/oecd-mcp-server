/**
 * @fileoverview Tests for oecd_list_agencies tool.
 * @module tests/tools/list-agencies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { oecdListAgencies } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery, toolWireError, toolWireFailure } from '../helpers/error-contract.js';
import {
  installScriptedFetch,
  json,
  observe,
  PROXY_PAGE,
  runUntil,
  type ScriptedAnswer,
  type ScriptedFetch,
  STALL,
} from '../helpers/scripted-fetch.js';

const FAKE_BASE = 'https://fake.oecd.test';

/** A fresh `Response` per call — a single instance can only be read once. */
function stubFetchJson(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(body))),
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
    stubFetchJson(DATAFLOWS_RESPONSE);
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
    await expect(toolWireError(oecdListAgencies, {})).resolves.toMatchObject({
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

    await expect(toolWireError(oecdListAgencies, {})).resolves.toMatchObject({
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

// ── Upstream failure wiring ───────────────────────────────────────────────────

/**
 * How each upstream failure reaches this tool's caller. The mechanisms — the
 * reason mapping and the call's budget — are tabled at the HTTP boundary; these
 * prove the tool is wired to them, one case per side of each branch.
 */
describe('oecdListAgencies upstream failure wiring', () => {
  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  /** Answer the catalog and the agency scheme each from its own script. */
  function serve(
    catalog: ScriptedAnswer,
    agencyScheme = json(AGENCY_SCHEME_RESPONSE),
  ): ScriptedFetch {
    fake = installScriptedFetch((url) => (url.includes('/agencyscheme/') ? agencyScheme : catalog));
    return fake;
  }

  beforeEach(() => {
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    const config = getServerConfig();
    configured = { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
    // The default OECD_TIMEOUT_MS: a stalled ladder runs into the budget, not out of attempts.
    config.timeoutMs = 30_000;
    initStructureService();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(getServerConfig(), configured);
    initStructureService();
    const installed = fake;
    fake = undefined;
    installed?.restore();
  });

  it('names a catalog body that is not JSON upstream_unreadable, after one request', async () => {
    const http = serve(PROXY_PAGE);
    const hint = declaredRecovery(oecdListAgencies, 'upstream_unreadable');

    const { error, text } = await toolWireFailure(oecdListAgencies, {});

    expect(http.requestsTo('/dataflow')).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable', recovery: { hint }, retryable: false },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
    expect(text).toContain(hint);
    expect(text).toContain('(reason upstream_unreadable · not retryable)');
  });

  it('names a catalog 422 upstream_error, carrying the status and OECD’s text', async () => {
    serve({ body: 'Semantic error in the structure query', kind: 'answer', status: 422 });

    const error = await toolWireError(oecdListAgencies, {});

    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: declaredRecovery(oecdListAgencies, 'upstream_error') },
    });
    expect(error.message).toContain(
      'OECD answered HTTP 422: Semantic error in the structure query',
    );
  });

  it('ends a stalled catalog read as upstream_timeout when the call’s budget runs out', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(STALL, STALL);

    const call = observe(toolWireError(oecdListAgencies, {}));
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(http.requestsTo('/dataflow')).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          recovery: { hint: declaredRecovery(oecdListAgencies, 'upstream_timeout') },
        },
      },
    });
  });

  it('lists agencies without directorates once a stalled agency scheme spends the budget', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(json(MIXED_PUBLISHER_DATAFLOWS), STALL);

    const call = observe(runToolContract(oecdListAgencies, {}));
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(http.requestsTo('/agencyscheme/')).toHaveLength(2);
    expect(outcome.status).toBe('fulfilled');
    const result = (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof runToolContract>>>)
      .value;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total_agencies: 3 });
    expect(
      (result.structuredContent as { agencies: Array<{ directorate?: string }> }).agencies.every(
        (a) => a.directorate === undefined,
      ),
    ).toBe(true);
  });

  it('lets a failure with no OECD answer behind it through as itself', async () => {
    getServerConfig().baseUrl = 'ftp://fake.oecd.test';
    initStructureService();
    const http = serve(json(MIXED_PUBLISHER_DATAFLOWS));

    const error = await toolWireError(oecdListAgencies, {});

    expect(http.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_url' },
    });
  });
});
