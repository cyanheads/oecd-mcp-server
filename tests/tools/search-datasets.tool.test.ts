/**
 * @fileoverview Tests for oecd_search_datasets tool.
 * @module tests/tools/search-datasets.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdSearchDatasets } from '@/mcp-server/tools/definitions/search-datasets.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery } from '../helpers/error-contract.js';

const FAKE_BASE = 'https://fake.oecd.test';

/**
 * Real API format: id is "DSD_XXX@DF_YYY" (combined), structure is a string URN,
 * description is authored HTML and absent for part of the catalog.
 */
const DATAFLOWS_RESPONSE = {
  data: {
    dataflows: [
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_NAAG@DF_NAAG_I',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAAG(1.0)',
        name: 'National Accounts at a Glance',
        description: '<p>Headline national accounts aggregates for OECD economies.</p>',
        annotations: [],
      },
      {
        agencyID: 'OECD.EDU.IMEP',
        id: 'DSD_SPI@DF_SPI',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.EDU.IMEP:DSD_SPI(1.0)',
        name: 'SPI',
        description:
          '<p>Assessment results measuring <strong>student</strong> performance across participating economies.</p>',
        annotations: [{ id: 'NonProductionDataflow' }],
      },
      {
        agencyID: 'OECD.SDD',
        id: 'DSD_HEALTH@DF_HEALTH',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD:DSD_HEALTH(1.0)',
        name: 'Health Statistics',
        annotations: [],
      },
    ],
  },
};

/** Ten uniformly-named dataflows, for exercising limit/offset windows. */
const PAGED_RESPONSE = {
  data: {
    dataflows: Array.from({ length: 10 }, (_, i) => ({
      agencyID: 'OECD.SDD.NAD',
      id: `DSD_TAX@DF_TAX_${i}`,
      structure:
        'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_TAX(1.0)',
      name: `Tax revenue series ${i}`,
      annotations: [],
    })),
  },
};

/** A fresh `Response` per call — a single instance can only be read once. */
function stubFetchJson(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(body))),
  );
}

describe('oecdSearchDatasets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
    stubFetchJson(DATAFLOWS_RESPONSE);
  });

  it('returns matching dataflows for a keyword search', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'national accounts glance' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.total_matches).toBe(1);
    expect(result.result_count).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.dataflows[0]).toMatchObject({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      agency_id: 'OECD.SDD.NAD',
      name: 'National Accounts at a Glance',
      matched_in: 'name',
      non_production: false,
    });
  });

  it('respects the limit parameter', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'tax', limit: 3 });
    stubFetchJson(PAGED_RESPONSE);
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.result_count).toBe(3);
    expect(result.total_matches).toBe(10);
  });

  it('surfaces non_production flag on experimental dataflows', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'spi' });
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

  it('throws ctx.fail(upstream_unavailable) when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'gdp' });
    await expect(oecdSearchDatasets.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdSearchDatasets, 'upstream_unavailable') },
      },
    });
  }, 20_000);

  it('names a throttled catalog read rate_limited rather than a generic outage', async () => {
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
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'gdp' });

    await expect(oecdSearchDatasets.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdSearchDatasets, 'rate_limited') },
      },
    });
  });

  it('throws ctx.fail(agency_not_found) when the agency 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('Could not find requested structures', { status: 404 })),
      ),
    );
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'gdp', agency_id: 'OECD.ELS' });

    const error = await Promise.resolve(oecdSearchDatasets.handler(input, ctx)).catch(
      (e: Error) => e,
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'agency_not_found' },
    });
    expect((error as Error).message).toContain('OECD.ELS');
    // A caller mistake is terminal, not a transient outage to retry.
    expect((error as { data?: Record<string, unknown> }).data?.retryable).not.toBe(true);
  });

  it('throws ctx.fail(agency_not_found) for an agency_id outside the SDMX character set', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'gdp', agency_id: 'OECD/../secrets' });

    const error = await Promise.resolve(oecdSearchDatasets.handler(input, ctx)).catch(
      (e: Error) => e,
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'agency_not_found' },
    });
    expect((error as { data?: Record<string, unknown> }).data?.retryable).not.toBe(true);
    // An identifier that cannot name any agency never reaches the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats results with flow_ref, agency, description, matched_in, and offset', () => {
    const output = {
      dataflows: [
        {
          flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
          agency_id: 'OECD.SDD.NAD',
          name: 'National Accounts',
          description: 'Headline national accounts aggregates.',
          matched_in: 'both' as const,
          non_production: false,
        },
      ],
      result_count: 1,
      total_matches: 12,
      offset: 4,
      source: 'OECD' as const,
    };
    const blocks = oecdSearchDatasets.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(text).toContain('National Accounts');
    expect(text).toContain('OECD.SDD.NAD');
    expect(text).toContain('Headline national accounts aggregates.');
    expect(text).toContain('matched_in: both');
    expect(text).toContain('offset 4');
  });
});

// ── Description matching (#14) ────────────────────────────────────────────────

describe('oecdSearchDatasets description matching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
    stubFetchJson(DATAFLOWS_RESPONSE);
  });

  it('matches a term that appears only in the description', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'student' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.total_matches).toBe(1);
    expect(result.dataflows[0]).toMatchObject({
      name: 'SPI',
      matched_in: 'description',
    });
  });

  it('reports both when the query spans name and description', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'spi student' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.dataflows[0]?.matched_in).toBe('both');
  });

  it('omits description for a dataflow OECD ships without one', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'health' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.dataflows[0]?.name).toBe('Health Statistics');
    expect(result.dataflows[0]).not.toHaveProperty('description');
    expect(result.dataflows[0]?.matched_in).toBe('name');
  });

  it('returns descriptions as plain text, free of the upstream HTML', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'glance' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.dataflows[0]?.description).toBe(
      'Headline national accounts aggregates for OECD economies.',
    );
  });

  it('truncates a long description on a word boundary', async () => {
    const sentence = 'This dataset provides comparable indicators across member economies. ';
    stubFetchJson({
      data: {
        dataflows: [
          {
            agencyID: 'OECD.SDD.NAD',
            id: 'DSD_LONG@DF_LONG',
            structure:
              'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_LONG(1.0)',
            name: 'Verbose flow',
            description: `<p>${sentence.repeat(20)}</p>`,
            annotations: [],
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'verbose' });
    const result = await oecdSearchDatasets.handler(input, ctx);

    const description = result.dataflows[0]?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(241);
    expect(description.endsWith('…')).toBe(true);
    expect(description).not.toContain(' …');
  });
});

// ── Pagination and truncation disclosure (#5, #15) ────────────────────────────

describe('oecdSearchDatasets pagination', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
    stubFetchJson(PAGED_RESPONSE);
  });

  it('validates an uncapped success against the advertised output schema', async () => {
    // Regression: totalCount is only enriched when a page is capped, so a
    // required enrichment field failed every uncapped search.
    const result = await runToolContract(oecdSearchDatasets, { query: 'tax', limit: 20 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      result_count: 10,
      total_matches: 10,
      offset: 0,
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
  });

  it('discloses totalCount only when matches remain beyond the page', async () => {
    const capped = createMockContext({ errors: oecdSearchDatasets.errors });
    await oecdSearchDatasets.handler(
      oecdSearchDatasets.input.parse({ query: 'tax', limit: 4 }),
      capped,
    );
    expect(getEnrichment(capped).totalCount).toBe(10);

    const uncapped = createMockContext({ errors: oecdSearchDatasets.errors });
    await oecdSearchDatasets.handler(
      oecdSearchDatasets.input.parse({ query: 'tax', limit: 20 }),
      uncapped,
    );
    expect(getEnrichment(uncapped).totalCount).toBeUndefined();
  });

  it('applies offset before limit', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'tax', limit: 3, offset: 4 });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.offset).toBe(4);
    expect(result.result_count).toBe(3);
    expect(result.total_matches).toBe(10);
    expect(result.dataflows.map((d) => d.name)).toEqual([
      'Tax revenue series 4',
      'Tax revenue series 5',
      'Tax revenue series 6',
    ]);
  });

  it('keeps the disclosure offset-aware on the final page', async () => {
    // offset 5 + limit 5 returns the last five of ten: nothing remains, so the
    // pre-offset comparison (matches.length > returned) must not fire.
    const last = createMockContext({ errors: oecdSearchDatasets.errors });
    const lastPage = await oecdSearchDatasets.handler(
      oecdSearchDatasets.input.parse({ query: 'tax', limit: 5, offset: 5 }),
      last,
    );
    expect(lastPage.result_count).toBe(5);
    expect(getEnrichment(last).totalCount).toBeUndefined();

    // A middle page still leaves matches behind, so the total is disclosed.
    const middle = createMockContext({ errors: oecdSearchDatasets.errors });
    await oecdSearchDatasets.handler(
      oecdSearchDatasets.input.parse({ query: 'tax', limit: 5, offset: 2 }),
      middle,
    );
    expect(getEnrichment(middle).totalCount).toBe(10);
  });

  it('returns an empty page rather than no_match when offset is past the end', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'tax', limit: 5, offset: 50 });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.dataflows).toHaveLength(0);
    expect(result.result_count).toBe(0);
    expect(result.total_matches).toBe(10);
    expect(result.offset).toBe(50);
  });

  it('returns an empty page when offset lands exactly on total_matches', async () => {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const input = oecdSearchDatasets.input.parse({ query: 'tax', offset: 10 });
    const result = await oecdSearchDatasets.handler(input, ctx);

    expect(result.result_count).toBe(0);
    expect(result.total_matches).toBe(10);
  });
});
