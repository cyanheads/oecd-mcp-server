/**
 * @fileoverview Tests for the oecd://dataflow/{agency_id}/{flow_id} resource.
 * @module tests/resources/dataflow.resource.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataflowResource } from '@/mcp-server/resources/definitions/dataflow.resource.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

const FAKE_BASE = 'https://fake.oecd.test';

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
    const ctx = createMockContext();
    // flow_id is the URL-encoded combined dsd_id@df_id
    const params = oecdDataflowResource.params.parse({
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
    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG@DF_NAAG_I',
    });
    const result = await oecdDataflowResource.handler(params, ctx);
    expect(result.flow_ref).toBe('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(result.dimensions).toHaveLength(2);
  });

  it('serves a bare df_id, which OECD publishes for datastructure-less dataflows', async () => {
    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.TAD.ARP',
      flow_id: 'DF_AEI2024_DASHBOARD',
    });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result.flow_ref).toBe('OECD.TAD.ARP,DF_AEI2024_DASHBOARD');
    expect(result.dimensions).toHaveLength(2);
  });

  it('throws notFound for a flow_id carrying path characters', async () => {
    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG%40..%2f..%2fetc',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toThrow();
  });

  it('throws notFound when DSD response is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_MISSING%40DF_MISSING',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toThrow();
  });

  it('propagates error when fetch throws with DataStructure not found message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('DataStructure not found for flow')),
    );
    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_X%40DF_X',
    });
    await expect(oecdDataflowResource.handler(params, ctx)).rejects.toThrow();
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
        match: `${FAKE_BASE}/conceptscheme/OECD.SDD.NAD/CS_NA`,
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

    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAMAIN1%40DF_QNA',
    });
    const result = await oecdDataflowResource.handler(params, ctx);

    expect(result.dimensions[0]).toMatchObject({ id: 'ADJUSTMENT', name: 'Adjustment' });
    expect(result.time_dimension).toMatchObject({ id: 'TIME_PERIOD', name: 'Time period' });
  });
});
