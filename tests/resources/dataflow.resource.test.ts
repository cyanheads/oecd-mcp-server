/**
 * @fileoverview Tests for the oecd://dataflow/{agency_id}/{flow_id} resource.
 * @module tests/resources/dataflow.resource.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { oecdDataflowResource } from '@/mcp-server/resources/definitions/dataflow.resource.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import {
  declaredRecovery as declaredRecoveryOf,
  resourceWireError,
} from '../helpers/error-contract.js';
import { cacheableJson, noResultsFound } from '../helpers/oecd-response.js';
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

/**
 * The resource's own params schema, read once. `params` is optional on the
 * definition type, so pinning it here keeps every case free of a per-call
 * narrowing that would say nothing about the resource.
 */
const resourceParams = oecdDataflowResource.params;
if (!resourceParams) throw new Error('oecdDataflowResource must declare params');
const resourceOutput = oecdDataflowResource.output;
if (!resourceOutput) throw new Error('oecdDataflowResource must declare output');

/**
 * The recovery text the resource declares for a reason. A resource handler's own
 * throw carries no hint — the framework's resource factory fills the declared
 * one in by reason — so hints are asserted on what a `resources/read` returns.
 */
const declaredRecovery = (reason: string): string =>
  declaredRecoveryOf(oecdDataflowResource, reason);

/** The JSON-RPC error a `resources/read` of these URI segments returns. */
const readError = (params: { agency_id: string; flow_id: string }) =>
  resourceWireError(oecdDataflowResource, `oecd://dataflow/${params.agency_id}/${params.flow_id}`);

/** A fresh `Response` over `body` per call — a single instance can only be read once. */
function stubFetchJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(body))),
  );
}

// Real API format: positions are 0-based, enumeration is a string URN, timeDimensions is an array.
const DSD_RESPONSE = {
  data: {
    dataStructures: [
      {
        annotations: [],
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'FREQ',
                position: 0,
                name: 'Frequency',
                localRepresentation: {
                  enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD:CL_FREQ(1.0)',
                },
              },
              {
                id: 'REF_AREA',
                position: 1,
                name: 'Reference Area',
                localRepresentation: {
                  enumeration:
                    'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD.SDD.NAD:CL_AREA(1.0)',
                },
              },
            ],
            timeDimensions: [
              {
                id: 'TIME_PERIOD',
                name: 'Time Period',
              },
            ],
          },
        },
      },
    ],
  },
};

describe('oecdDataflowResource', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
    stubFetchJson(DSD_RESPONSE);
  });

  it('returns dimension metadata for a valid resource URI', async () => {
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    // flow_id is the URL-encoded combined dsd_id@df_id
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result.flow_ref).toBe('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(result.source).toBe('OECD');
    expect(result.dimensions).toHaveLength(2);
    expect(result.dimensions[0]).toMatchObject({ id: 'FREQ', position: 1 });
    expect(result.time_dimension).toMatchObject({ id: 'TIME_PERIOD' });
  });

  it('handles plain @ (not percent-encoded) in flow_id', async () => {
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG@DF_NAAG_I',
    });
    const result = await oecdDataflowResource.handler(params, ctx);
    expect(result.flow_ref).toBe('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(result.dimensions).toHaveLength(2);
  });

  it('serves a bare df_id, which OECD publishes for datastructure-less dataflows', async () => {
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.TAD.ARP',
      flow_id: 'DF_AEI2024_DASHBOARD',
    });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result.flow_ref).toBe('OECD.TAD.ARP,DF_AEI2024_DASHBOARD');
    expect(result.dimensions).toHaveLength(2);
  });

  it('throws ctx.fail(invalid_flow_ref) for a flow_id carrying path characters', async () => {
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40..%2f..%2fetc',
    });
    await expect(readError(params)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_flow_ref',
        recovery: { hint: declaredRecovery('invalid_flow_ref') },
      },
    });
  });

  it('throws ctx.fail(invalid_flow_ref) for a flow_id carrying a malformed percent-escape', async () => {
    // decodeURIComponent throws a URIError on this, which without the contract
    // reaches the client as an unexplained internal fault.
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%ZZDF_NAAG_I',
    });
    await expect(readError(params)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_flow_ref',
        recovery: { hint: declaredRecovery('invalid_flow_ref') },
      },
    });
  });

  it('tells the client how to split a flow_ref across the two URI segments', () => {
    // The one place the resource's contract must diverge from
    // oecd_get_dataset_info's: the tool takes one flow_ref string, this takes it
    // split in two, so the hint has to name the split and the %40 encoding.
    expect(declaredRecovery('invalid_flow_ref')).toContain('%40');
    expect(declaredRecovery('invalid_flow_ref')).toContain('oecd_search_datasets');
  });

  it('throws ctx.fail(dataflow_not_found) when DSD response is empty', async () => {
    stubFetchJson({ data: { dataStructures: [] } });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_MISSING%40DF_MISSING',
    });
    await expect(readError(params)).resolves.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'dataflow_not_found',
        recovery: { hint: declaredRecovery('dataflow_not_found') },
      },
    });
  });

  it('throws ctx.fail(dataflow_not_found) for a dataflow OECD does not publish, after one request', async () => {
    // The real flow is DF_IALFS_UNE_M. Its datastructure route answers for any
    // dataflow id paired with DSD_LFS, so only the dataflow route can say no.
    const fetchSpy = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/datastructure/') ? cacheableJson(DSD_RESPONSE) : noResultsFound(),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.TPS',
      flow_id: 'DSD_LFS%40DF_IALFS_UNE_MM',
    });

    const error = await readError(params);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      `${FAKE_BASE}/dataflow/OECD.SDD.TPS/DSD_LFS@DF_IALFS_UNE_MM?references=datastructure`,
    ]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'dataflow_not_found',
        recovery: { hint: declaredRecovery('dataflow_not_found') },
      },
    });
    expect(error.message).toContain('OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_MM');
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
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });

    await expect(readError(params)).resolves.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: {
        reason: 'upstream_redirect',
        retryable: false,
        recovery: { hint: declaredRecovery('upstream_redirect') },
      },
    });
    // The sentence the fetch boundary wrote survives the service's relabel.
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toThrow(/OECD_BASE_URL/);
  });

  it('names a throttled read rate_limited, the reason the tools give it', async () => {
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
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });

    await expect(readError(params)).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: declaredRecovery('rate_limited') },
      },
    });
  });

  it('names a status it does not model upstream_error rather than passing the code bare', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('Forbidden', { status: 403 }))),
    );
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });

    await expect(readError(params)).resolves.toMatchObject({
      data: {
        reason: 'upstream_error',
        recovery: { hint: declaredRecovery('upstream_error') },
      },
    });
  });
});

// ── Dimension names ───────────────────────────────────────────────────────────

/** OECD's datastructure response carries no `name` on a dimension. */
const NAMELESS_DSD_RESPONSE = {
  data: {
    dataStructures: [
      {
        id: 'DSD_NAMAIN1',
        annotations: [],
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'ADJUSTMENT',
                position: 0,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).ADJUSTMENT',
              },
            ],
            timeDimensions: [
              {
                id: 'TIME_PERIOD',
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).TIME_PERIOD',
              },
            ],
          },
        },
      },
    ],
  },
};

describe('oecdDataflowResource dimension names', () => {
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

  /** Answer the dataflow's reference with `reference`, and its concept scheme with names for both concepts. */
  function routeReference(reference: unknown): void {
    http.route(
      {
        match: `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAMAIN1@DF_QNA?references=datastructure`,
        respond: () => Response.json(reference),
      },
      {
        // The fixture URNs reference `CS_NA(1.0)`, and that version is addressed.
        match: `${FAKE_BASE}/conceptscheme/OECD.SDD.NAD/CS_NA/1.0`,
        respond: () =>
          Response.json({
            data: {
              conceptSchemes: [
                {
                  concepts: [
                    { id: 'ADJUSTMENT', name: 'Adjustment' },
                    { id: 'TIME_PERIOD', name: 'Time period' },
                  ],
                },
              ],
            },
          }),
      },
    );
  }

  const params = resourceParams.parse({
    agency_id: 'OECD.SDD.NAD',
    flow_id: 'DSD_NAMAIN1%40DF_QNA',
  });

  it('renders concept names rather than repeating the dimension ids', async () => {
    routeReference(NAMELESS_DSD_RESPONSE);

    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result.dimensions[0]).toMatchObject({ id: 'ADJUSTMENT', name: 'Adjustment' });
    expect(result.time_dimension).toMatchObject({ id: 'TIME_PERIOD', name: 'Time period' });
  });

  it('reports no non_production status, since OECD annotates every flow alike', async () => {
    // The dataflow route answers with the dataflow entry beside its datastructure.
    routeReference({
      data: {
        dataflows: [
          {
            agencyID: 'OECD.SDD.NAD',
            id: 'DSD_NAMAIN1@DF_QNA',
            annotations: [{ type: 'NonProductionDataflow', text: 'true' }],
          },
        ],
        dataStructures: NAMELESS_DSD_RESPONSE.data.dataStructures,
      },
    });

    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result).toMatchObject({ flow_ref: 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA' });
    expect(result).not.toHaveProperty('non_production');
    expect(JSON.stringify(z.toJSONSchema(resourceOutput))).not.toContain('non_production');
  });
});

// ── Upstream failure wiring ───────────────────────────────────────────────────

/**
 * How each upstream failure reaches a `resources/read` caller. The mechanisms —
 * the reason mapping and the call's budget — are tabled at the HTTP boundary;
 * these prove the resource is wired to them, one case per side of each branch.
 */
describe('oecdDataflowResource upstream failure wiring', () => {
  const URI = 'oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I';
  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  function serve(datastructure: ScriptedAnswer): ScriptedFetch {
    fake = installScriptedFetch(() => datastructure);
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

  it('names a datastructure body that is not JSON upstream_unreadable, after one request', async () => {
    const http = serve(PROXY_PAGE);

    const error = await resourceWireError(oecdDataflowResource, URI);

    expect(http.requests.map((r) => r.url)).toEqual([
      `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I?references=datastructure`,
    ]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unreadable',
        recovery: { hint: declaredRecovery('upstream_unreadable') },
        retryable: false,
      },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
  });

  it('names a datastructure 422 upstream_error, carrying the status and OECD’s text', async () => {
    serve({ body: 'Semantic error in the structure query', kind: 'answer', status: 422 });

    const error = await resourceWireError(oecdDataflowResource, URI);

    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: declaredRecovery('upstream_error') },
    });
    expect(error.message).toContain(
      'OECD answered HTTP 422: Semantic error in the structure query',
    );
  });

  it('ends a stalled datastructure read as upstream_timeout when the call’s budget runs out', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(STALL);

    const read = observe(resourceWireError(oecdDataflowResource, URI));
    const { outcome, pendingBefore } = await runUntil(read, 50_000);

    expect(pendingBefore).toBe(true);
    expect(read.settledAtMs).toBe(50_000);
    expect(http.requests).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          recovery: { hint: declaredRecovery('upstream_timeout') },
        },
      },
    });
  });

  it('lets a failure with no OECD answer behind it through as itself', async () => {
    getServerConfig().baseUrl = 'ftp://fake.oecd.test';
    initStructureService();
    const http = serve(json(DSD_RESPONSE));

    const error = await resourceWireError(oecdDataflowResource, URI);

    expect(http.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_url' },
    });
  });
});
