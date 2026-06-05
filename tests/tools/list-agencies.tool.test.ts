/**
 * @fileoverview Tests for oecd_list_agencies tool.
 * @module tests/tools/list-agencies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdListAgencies } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

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
        agencyID: 'OECD.EDU',
        id: 'DSD_PISA@DF_PISA',
        structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.EDU:DSD_PISA(1.0)',
        name: 'PISA',
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
    // NAD has 2, EDU has 1 — sorted descending
    expect(result.agencies[0]).toMatchObject({ agency_id: 'OECD.SDD.NAD', dataflow_count: 2 });
    expect(result.agencies[1]).toMatchObject({ agency_id: 'OECD.EDU', dataflow_count: 1 });
  });

  it('throws ctx.fail(upstream_error) when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    const ctx = createMockContext({ errors: oecdListAgencies.errors });
    await expect(oecdListAgencies.handler({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats output with agency table and totals', () => {
    const output = {
      agencies: [
        { agency_id: 'OECD.SDD.NAD', dataflow_count: 500 },
        { agency_id: 'OECD.EDU', dataflow_count: 100 },
      ],
      total_agencies: 2,
      total_dataflows: 600,
      source: 'OECD' as const,
    };
    const blocks = oecdListAgencies.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OECD.SDD.NAD');
    expect(text).toContain('500');
    expect(text).toContain('OECD.EDU');
    expect(text).toContain('600');
    expect(text).toContain('Source: OECD');
  });
});
