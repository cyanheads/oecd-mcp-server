/**
 * @fileoverview Tests for oecd_search_datasets tool.
 * @module tests/tools/search-datasets.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdSearchDatasets } from '@/mcp-server/tools/definitions/search-datasets.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

const FAKE_BASE = 'https://fake.oecd.test';

const DATAFLOWS_RESPONSE = {
  data: {
    dataflows: [
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DF_NAAG_I',
        structure: { id: 'DSD_NAAG' },
        name: 'National Accounts at a Glance',
        annotations: [],
      },
      {
        agencyID: 'OECD.EDU',
        id: 'DF_PISA',
        structure: { id: 'DSD_PISA' },
        name: 'PISA Student Performance',
        annotations: [{ id: 'NonProductionDataflow' }],
      },
      {
        agencyID: 'OECD.SDD',
        id: 'DF_HEALTH',
        structure: { id: 'DSD_HEALTH' },
        name: 'Health Statistics',
        annotations: [],
      },
    ],
  },
};

describe('oecdSearchDatasets', () => {
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
        json: () => Promise.resolve(DATAFLOWS_RESPONSE),
        text: () => Promise.resolve(JSON.stringify(DATAFLOWS_RESPONSE)),
      }),
    );
  });

  it('returns matching dataflows for a keyword search', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'national' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.total_matches).toBe(1);
    expect(result.result_count).toBe(1);
    expect(result.dataflows[0]).toMatchObject({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      agency_id: 'OECD.SDD.NAD',
      name: 'National Accounts at a Glance',
      non_production: false,
    });
  });

  it('respects the limit parameter', async () => {
    // Both 'a Glance' and 'Statistics' share no common token — use broad query
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'a', limit: 1 });
    const result = await oecdSearchDatasets.handler(input, ctx);

    // 'a' matches 'at a Glance', 'PISA' (no — 'a' not in 'PISA'), 'Health Statistics' ('a' in 'Statistics')
    expect(result.result_count).toBeLessThanOrEqual(1);
    expect(result.total_matches).toBeGreaterThanOrEqual(result.result_count);
  });

  it('surfaces non_production flag on experimental dataflows', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'pisa' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.dataflows[0]?.non_production).toBe(true);
  });

  it('throws ctx.fail(no_match) when no dataflows match', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'xyzzy_no_match_possible' });
    await expect(oecdSearchDatasets.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });

  it('throws ctx.fail(upstream_error) when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'gdp' });
    await expect(oecdSearchDatasets.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats results with flow_ref and agency', () => {
    const output = {
      dataflows: [
        {
          flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
          agency_id: 'OECD.SDD.NAD',
          name: 'National Accounts',
          non_production: false,
        },
      ],
      result_count: 1,
      total_matches: 1,
      source: 'OECD' as const,
    };
    const blocks = oecdSearchDatasets.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(text).toContain('National Accounts');
    expect(text).toContain('OECD.SDD.NAD');
  });
});
