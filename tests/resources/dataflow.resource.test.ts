/**
 * @fileoverview Tests for the oecd://dataflow/{agency_id}/{flow_id} resource.
 * @module tests/resources/dataflow.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataflowResource } from '@/mcp-server/resources/definitions/dataflow.resource.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery as declaredRecoveryOf } from '../helpers/error-contract.js';

const FAKE_BASE = 'https://fake.oecd.test';

/**
 * The resource's own params schema, read once. `params` is optional on the
 * definition type, so pinning it here keeps every case free of a per-call
 * narrowing that would say nothing about the resource.
 */
const resourceParams = oecdDataflowResource.params;
if (!resourceParams) throw new Error('oecdDataflowResource must declare params');

/**
 * The recovery text the resource declares for a reason. A resource re-throws
 * rather than producing an `isError` envelope, so the `McpError` a handler
 * throws is what the framework hands the SDK verbatim and what reaches the
 * client as `error.{code, data}` — asserting the throw is asserting the wire.
 * Reading the expected hint off the contract is what proves the handler spread
 * `ctx.recoveryFor(...)` onto the throw: a `ctx.fail` that omitted it would
 * still carry the reason, and only this comparison would notice.
 */
const declaredRecovery = (reason: string): string =>
  declaredRecoveryOf(oecdDataflowResource, reason);

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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(JSON.stringify(DSD_RESPONSE)),
      }),
    );
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
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40..%2f..%2fetc',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_flow_ref',
        recovery: { hint: declaredRecovery('invalid_flow_ref') },
      },
    });
  });

  it('throws ctx.fail(invalid_flow_ref) for a flow_id carrying a malformed percent-escape', async () => {
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    // decodeURIComponent throws a URIError on this, which without the contract
    // reaches the client as an unexplained internal fault.
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%ZZDF_NAAG_I',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_MISSING%40DF_MISSING',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'dataflow_not_found',
        recovery: { hint: declaredRecovery('dataflow_not_found') },
      },
    });
  });

  it('throws ctx.fail(dataflow_not_found) for a dataflow OECD does not publish', async () => {
    // A fresh Response per call: both the direct datastructure route and the
    // dataflow reference route are tried, and a body can only be read once.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response('Could not find requested structures', { status: 404 })),
        ),
    );
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_X%40DF_X',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'dataflow_not_found',
        recovery: { hint: declaredRecovery('dataflow_not_found') },
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
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });

    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
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
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });

    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
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
    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40DF_NAAG_I',
    });

    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toMatchObject({
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

  it('renders concept names rather than repeating the dimension ids', async () => {
    http.route(
      {
        match: `${FAKE_BASE}/datastructure/OECD.SDD.NAD/DSD_NAMAIN1`,
        respond: () => Response.json(NAMELESS_DSD_RESPONSE),
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

    const ctx = createMockContext({ errors: oecdDataflowResource.errors });
    const params = resourceParams.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAMAIN1%40DF_QNA',
    });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result.dimensions[0]).toMatchObject({ id: 'ADJUSTMENT', name: 'Adjustment' });
    expect(result.time_dimension).toMatchObject({ id: 'TIME_PERIOD', name: 'Time period' });
  });
});
