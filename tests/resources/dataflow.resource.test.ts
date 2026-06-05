/**
 * @fileoverview Tests for the oecd://dataflow/{agency_id}/{flow_id} resource.
 * @module tests/resources/dataflow.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdDataflowResource } from '@/mcp-server/resources/definitions/dataflow.resource.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

const FAKE_BASE = 'https://fake.oecd.test';

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
                position: 1,
                name: 'Frequency',
                localRepresentation: {
                  enumeration: { agencyID: 'OECD', id: 'CL_FREQ' },
                },
              },
              {
                id: 'REF_AREA',
                position: 2,
                name: 'Reference Area',
                localRepresentation: {
                  enumeration: { agencyID: 'OECD.SDD.NAD', id: 'CL_AREA' },
                },
              },
            ],
            timeDimension: {
              id: 'TIME_PERIOD',
              name: 'Time Period',
            },
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

  it('throws notFound for an invalid (missing @) flow_id', async () => {
    const ctx = createMockContext();
    const params = oecdDataflowResource.params.parse({
      agency_id: 'OECD.SDD.NAD',
      flow_id: 'DSD_NAAG_DF_NAAG_I', // missing @ separator
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
