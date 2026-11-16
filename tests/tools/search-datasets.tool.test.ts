/**
 * @fileoverview Tests for oecd_search_datasets tool.
 * @module tests/tools/search-datasets.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { oecdListAgencies } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { oecdSearchDatasets } from '@/mcp-server/tools/definitions/search-datasets.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery, toolWireError, toolWireFailure } from '../helpers/error-contract.js';
import { cacheableJson } from '../helpers/oecd-response.js';
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

/**
 * Building a definition with a clamped `limit` reads the server config, so it is
 * parsed when this file imports the tool — before any `beforeEach` runs.
 */
vi.hoisted(() => {
  process.env.OECD_BASE_URL = 'https://fake.oecd.test';
  process.env.OECD_TIMEOUT_MS = '5000';
});

const FAKE_BASE = 'https://fake.oecd.test';

/**
 * Real API format: id is "DSD_XXX@DF_YYY" (combined), structure is a string URN,
 * description is authored HTML and absent for part of the catalog. OECD tags
 * every catalogued dataflow `NonProductionDataflow` under `type`, production
 * flows included, as the SPI entry here is.
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
        annotations: [{ type: 'NonProductionDataflow', text: 'true' }],
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

  it('reports no non_production status on either surface, since OECD annotates every flow alike', async () => {
    const result = await runToolContract(oecdSearchDatasets, { query: 'spi' });

    expect(result.isError).toBeFalsy();
    const [flow] = (result.structuredContent as { dataflows: Array<Record<string, unknown>> })
      .dataflows;
    expect(flow).toMatchObject({ flow_ref: 'OECD.EDU.IMEP,DSD_SPI@DF_SPI' });
    expect(flow).not.toHaveProperty('non_production');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('OECD.EDU.IMEP,DSD_SPI@DF_SPI');
    expect(text).not.toContain('non_production');
    expect(JSON.stringify(z.toJSONSchema(oecdSearchDatasets.output))).not.toContain(
      'non_production',
    );
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
    const input = oecdSearchDatasets.input.parse({ query: 'gdp' });
    await expect(toolWireError(oecdSearchDatasets, input)).resolves.toMatchObject({
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
    const input = oecdSearchDatasets.input.parse({ query: 'gdp' });

    await expect(toolWireError(oecdSearchDatasets, input)).resolves.toMatchObject({
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

// ── Word-start matching and name-first ranking (#50) ──────────────────────────

/** A catalog entry in the shape the dataflow endpoint publishes. */
function catalogFlow(agencyID: string, id: string, name: string, description?: string) {
  return {
    agencyID,
    id,
    structure: `urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=${agencyID}:${id.split('@')[0]}(1.0)`,
    name,
    ...(description ? { description } : {}),
    annotations: [],
  };
}

/**
 * Live catalog records the `TiVA`, `house prices`, and `rio markers` searches
 * reach, cut to the text that decides them, in an order that puts the mid-word
 * and description-only hits ahead of the name matches.
 */
const RANKING_RESPONSE = {
  data: {
    dataflows: [
      catalogFlow(
        'OECD.ELS.JAI',
        'DSD_TAXBEN_SBE@DF_SBE',
        'Strictness of activation requirements for benefit recipients',
        'This indicator measures the strictness of activity-related eligibility criteria for recipients of unemployment benefits.',
      ),
      catalogFlow(
        'OECD.ENV.EPI',
        'DSD_LAND_USE@DF_LAND_USE',
        'Land use',
        '<p>Land resources include cultivated land, forest, and built-up areas.</p>',
      ),
      catalogFlow(
        'OECD.SDD.TPS',
        'DSD_BATIS@DF_BATIS',
        'Balanced trade in services (BaTIS)',
        'Balanced trade in services data form an essential input to the OECD Trade in Value Added (TiVA) initiative.',
      ),
      catalogFlow(
        'OECD.STI.PIE',
        'DSD_TIVA_MAINLV@DF_MAINLV',
        'Trade in Value Added (TiVA) 2025 edition: Principal Indicators, levels',
        '<font color="#00008B"><strong>Trade in Value Added (TiVA)</strong></font> is a collection of measures that provide insights into global production networks.',
      ),
      catalogFlow(
        'OECD.STI.PIE',
        'DSD_TIVA_FDVA@DF_FDVA',
        'Trade in Value Added (TiVA) 2025 edition: Origin of value added in final demand',
        'The origin of value added in final demand is derived from the Inter-Country Input-Output tables.',
      ),
      catalogFlow(
        'OECD.SDD.TPS',
        'DSD_RPP@DF_RPP',
        'Residential property indices',
        'House prices and rents across OECD economies.',
      ),
      catalogFlow(
        'OECD.SDD.NAD',
        'DSD_NAMAIN10@DF_TABLE1_EXPENDITURE_CPC',
        'Annual GDP and components - expenditure approach, US $, current prices, current PPPs, millions',
        'Final consumption expenditure of households and government, gross fixed capital formation, exports and imports.',
      ),
      catalogFlow(
        'OECD.CTP.TPS',
        'DSD_NECR@DF_NECRSHARES',
        'Shares of emissions priced',
        'The share of greenhouse gas emissions with a carbon price, net of fossil fuel prices support.',
      ),
      catalogFlow(
        'OECD.ECO.MPD',
        'DSD_AN_HOUSE_PRICES@DF_HOUSE_PRICES',
        'Analytical house prices indicators',
        'Residential Property Prices Indices measure the prices of residential properties over time.',
      ),
      catalogFlow(
        'OECD.DCD.FSD',
        'DSD_RIOMRKR@DF_RIOMARKERS',
        'RioMarkers: Aid (ODA) activities targeting global environmental objectives',
        'Bilateral commitment data on aid in support of environment sustainability.',
      ),
    ],
  },
};

const MAINLV = 'OECD.STI.PIE,DSD_TIVA_MAINLV@DF_MAINLV';
const FDVA = 'OECD.STI.PIE,DSD_TIVA_FDVA@DF_FDVA';
const BATIS = 'OECD.SDD.TPS,DSD_BATIS@DF_BATIS';
const HOUSE_PRICES = 'OECD.ECO.MPD,DSD_AN_HOUSE_PRICES@DF_HOUSE_PRICES';
const TABLE1 = 'OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE1_EXPENDITURE_CPC';
const RPP = 'OECD.SDD.TPS,DSD_RPP@DF_RPP';

describe('oecdSearchDatasets word-start matching and ranking', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
    stubFetchJson(RANKING_RESPONSE);
  });

  async function search(query: string, extra: { limit?: number; offset?: number } = {}) {
    const ctx = createMockContext({ errors: oecdSearchDatasets.errors });
    const result = await oecdSearchDatasets.handler(
      oecdSearchDatasets.input.parse({ query, ...extra }),
      ctx,
    );
    return { result, ctx };
  }

  it('matches a token as a word prefix, case-insensitively', async () => {
    const { result } = await search('PRICE');

    expect(result.dataflows.map((d) => d.flow_ref)).toContain(HOUSE_PRICES);
  });

  it('matches a token that opens on a separator wherever it occurs', async () => {
    stubFetchJson({
      data: {
        dataflows: [
          catalogFlow(
            'OECD.STI.STP',
            'DSD_MSTI@DF_MSTI',
            'Main Science and Technology Indicators',
            'Indicators of the financial and human resources devoted to R&D.',
          ),
        ],
      },
    });

    const { result } = await search('science & technology');

    expect(result.dataflows.map((d) => d.flow_ref)).toEqual(['OECD.STI.STP,DSD_MSTI@DF_MSTI']);
  });

  it('requires every token to match', async () => {
    await expect(search('house prices xyzzy')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });

  it('matches a token at a lowercase-to-uppercase step in the published name', async () => {
    const { result } = await search('rio markers');

    expect(result.dataflows.map((d) => d.flow_ref)).toEqual([
      'OECD.DCD.FSD,DSD_RIOMRKR@DF_RIOMARKERS',
    ]);
    expect(result.dataflows[0]?.matched_in).toBe('name');
  });

  it('skips a token that sits inside a word and counts only word-start matches', async () => {
    const { result } = await search('TiVA');

    const refs = result.dataflows.map((d) => d.flow_ref);
    expect(refs).not.toContain('OECD.ELS.JAI,DSD_TAXBEN_SBE@DF_SBE');
    expect(refs).not.toContain('OECD.ENV.EPI,DSD_LAND_USE@DF_LAND_USE');
    expect(result.total_matches).toBe(3);
    expect(result.result_count).toBe(3);
  });

  it('lists name matches first, then split matches, then description-only, each in catalog order', async () => {
    const tiva = await search('TiVA');
    expect(tiva.result.dataflows.map((d) => [d.flow_ref, d.matched_in])).toEqual([
      [MAINLV, 'both'],
      [FDVA, 'name'],
      [BATIS, 'description'],
    ]);

    const housePrices = await search('house prices');
    expect(housePrices.result.dataflows.map((d) => [d.flow_ref, d.matched_in])).toEqual([
      [HOUSE_PRICES, 'name'],
      [TABLE1, 'both'],
      [RPP, 'description'],
    ]);
  });

  it('keeps catalog order inside the split and description-only tiers', async () => {
    // Two flows in each lower tier, the name match between them in the catalog.
    stubFetchJson({
      data: {
        dataflows: [
          catalogFlow(
            'OECD.SDD.TPS',
            'DSD_RPP@DF_RPP',
            'Residential property indices',
            'House prices and rents across OECD economies.',
          ),
          catalogFlow(
            'OECD.SDD.NAD',
            'DSD_NAMAIN10@DF_TABLE1_EXPENDITURE_CPC',
            'Annual GDP and components - expenditure approach, US $, current prices, current PPPs, millions',
            'Final consumption expenditure of households and government, gross fixed capital formation, exports and imports.',
          ),
          catalogFlow(
            'OECD.ECO.MPD',
            'DSD_AN_HOUSE_PRICES@DF_HOUSE_PRICES',
            'Analytical house prices indicators',
          ),
          catalogFlow(
            'OECD.ECO.MPD',
            'DSD_REM@DF_REAL_ESTATE',
            'Real estate market indicators',
            'Nominal and real house prices, rents, and price-to-income ratios.',
          ),
          catalogFlow(
            'OECD.SDD.TPS',
            'DSD_PRICES@DF_PRICES_ALL',
            'Consumer prices, all items',
            'Price indices for the goods and services households buy.',
          ),
        ],
      },
    });

    const { result } = await search('house prices');

    expect(result.dataflows.map((d) => [d.flow_ref, d.matched_in])).toEqual([
      [HOUSE_PRICES, 'name'],
      [TABLE1, 'both'],
      ['OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'both'],
      [RPP, 'description'],
      ['OECD.ECO.MPD,DSD_REM@DF_REAL_ESTATE', 'description'],
    ]);
  });

  it('pages the ranked list with offset and discloses the total while matches remain', async () => {
    const pages: string[] = [];
    const disclosed: Array<number | undefined> = [];
    for (const offset of [0, 1, 2, 3]) {
      const { result, ctx } = await search('house prices', { limit: 1, offset });
      pages.push(...result.dataflows.map((d) => d.flow_ref));
      disclosed.push(getEnrichment(ctx).totalCount as number | undefined);
      expect(result.total_matches).toBe(3);
    }

    expect(pages).toEqual([HOUSE_PRICES, TABLE1, RPP]);
    expect(disclosed).toEqual([3, 3, undefined, undefined]);
  });

  it('carries the ranked order on both surfaces', async () => {
    const result = await runToolContract(oecdSearchDatasets, { query: 'house prices' });

    expect(result.isError).toBeFalsy();
    const refs = (
      result.structuredContent as { dataflows: Array<{ flow_ref: string }> }
    ).dataflows.map((d) => d.flow_ref);
    expect(refs).toEqual([HOUSE_PRICES, TABLE1, RPP]);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    const positions = refs.map((ref) => text.indexOf(ref));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).not.toContain('DF_NECRSHARES');
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

// ── Limit clamp (#51) ─────────────────────────────────────────────────────────

/**
 * The clamp's value table lives at its own seam (`tests/utils/count-limit.test.ts`);
 * these prove this tool is wired to it, with a 2,000 cap, one case per side.
 */
describe('oecdSearchDatasets limit clamp', () => {
  /** One more match than the per-call cap serves. */
  const OVER_CAP_RESPONSE = {
    data: {
      dataflows: Array.from({ length: 2_001 }, (_, i) =>
        catalogFlow('OECD.SDD.NAD', `DSD_TAX@DF_TAX_${i}`, `Tax revenue series ${i}`),
      ),
    },
  };
  let clampLimits: boolean;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    clampLimits = getServerConfig().clampLimits;
    initStructureService();
    stubFetchJson(OVER_CAP_RESPONSE);
  });

  afterEach(() => {
    getServerConfig().clampLimits = clampLimits;
  });

  it('serves a limit above the cap at 2,000 with the notice on both surfaces', async () => {
    const result = await runToolContract(oecdSearchDatasets, { query: 'tax', limit: 5000 });

    expect(result.isError).toBeFalsy();
    const notice = '`limit` 5000 is above the per-call maximum of 2000; served 2000.';
    expect(result.structuredContent).toMatchObject({
      result_count: 2_000,
      total_matches: 2_001,
      notice,
      totalCount: 2_001,
    });
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('limit');
    expect(text).toContain('is above the per-call maximum of 2000; served 2000.');
  });

  it('serves a limit at or below the cap as asked, with no notice', async () => {
    const result = await runToolContract(oecdSearchDatasets, { query: 'tax', limit: 101 });

    expect(result.structuredContent).toMatchObject({ result_count: 101, total_matches: 2_001 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('advertises no maximum, and still rejects a limit below 1 or a fraction', () => {
    const limit = z.toJSONSchema(oecdSearchDatasets.input).properties?.limit;

    expect(limit).toMatchObject({ type: 'integer', minimum: 1, default: 20 });
    expect(limit).not.toHaveProperty('maximum');
    expect(oecdSearchDatasets.input.safeParse({ query: 'tax', limit: 0 }).success).toBe(false);
    expect(oecdSearchDatasets.input.safeParse({ query: 'tax', limit: 1.5 }).success).toBe(false);
  });

  it('rejects a limit above the cap and advertises it as the maximum under OECD_CLAMP_LIMITS=false', () => {
    getServerConfig().clampLimits = false;
    const limit = z.toJSONSchema(oecdSearchDatasets.input).properties?.limit;

    expect(limit).toMatchObject({ type: 'integer', maximum: 2_000 });
    expect(oecdSearchDatasets.input.safeParse({ query: 'tax', limit: 2_001 }).success).toBe(false);
    expect(oecdSearchDatasets.input.safeParse({ query: 'tax', limit: 2_000 }).success).toBe(true);
  });
});

// ── Catalog reuse (#49) ───────────────────────────────────────────────────────

/**
 * The tools reach the catalog through the structure service's response cache.
 * What the cache stores, for how long, and what it refuses are tabled at its
 * own seam; this proves the catalog tools are wired through it.
 */
describe('oecdSearchDatasets catalog reuse', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    // A fresh service holds an empty cache, so no earlier test's catalog is served here.
    initStructureService();
  });

  afterEach(() => {
    http.restore();
  });

  it('reads the catalog once for two searches and an agency listing inside its max-age', async () => {
    http.route(
      { match: `${FAKE_BASE}/dataflow`, respond: () => cacheableJson(DATAFLOWS_RESPONSE) },
      {
        match: `${FAKE_BASE}/agencyscheme/OECD`,
        respond: () => cacheableJson({ data: { agencySchemes: [] } }),
      },
    );

    const national = await runToolContract(oecdSearchDatasets, { query: 'national' });
    const student = await runToolContract(oecdSearchDatasets, { query: 'student' });
    const agencies = await runToolContract(oecdListAgencies, {});

    expect(http.calls.filter((c) => c.request.url === `${FAKE_BASE}/dataflow`)).toHaveLength(1);
    // Each call still answers from the catalog the one request returned.
    expect(national.structuredContent).toMatchObject({
      dataflows: [{ flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I' }],
      total_matches: 1,
    });
    expect(student.structuredContent).toMatchObject({
      dataflows: [{ flow_ref: 'OECD.EDU.IMEP,DSD_SPI@DF_SPI' }],
      total_matches: 1,
    });
    expect(agencies.structuredContent).toMatchObject({ total_agencies: 3, total_dataflows: 3 });
  });
});

// ── Upstream failure wiring ───────────────────────────────────────────────────

/**
 * How each upstream failure reaches this tool's caller. The mechanisms — the
 * reason mapping and the call's budget — are tabled at the HTTP boundary; these
 * prove the tool is wired to them, one case per side of each branch.
 */
describe('oecdSearchDatasets upstream failure wiring', () => {
  const input = { query: 'national' };
  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  function serve(catalog: ScriptedAnswer): ScriptedFetch {
    fake = installScriptedFetch(() => catalog);
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
    const hint = declaredRecovery(oecdSearchDatasets, 'upstream_unreadable');

    const { error, text } = await toolWireFailure(oecdSearchDatasets, input);

    expect(http.requests).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable', recovery: { hint }, retryable: false },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
    expect(text).toContain(hint);
  });

  it('names a catalog 422 upstream_error, carrying the status and OECD’s text', async () => {
    serve({ body: 'Semantic error in the structure query', kind: 'answer', status: 422 });

    const error = await toolWireError(oecdSearchDatasets, input);

    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: declaredRecovery(oecdSearchDatasets, 'upstream_error') },
    });
    expect(error.message).toContain(
      'OECD answered HTTP 422: Semantic error in the structure query',
    );
  });

  it('ends a stalled catalog read as upstream_timeout when the call’s budget runs out', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(STALL);

    const call = observe(toolWireError(oecdSearchDatasets, input));
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(http.requests).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          recovery: { hint: declaredRecovery(oecdSearchDatasets, 'upstream_timeout') },
        },
      },
    });
  });

  it('lets a failure with no OECD answer behind it through as itself', async () => {
    getServerConfig().baseUrl = 'ftp://fake.oecd.test';
    initStructureService();
    const http = serve(json(DATAFLOWS_RESPONSE));

    const error = await toolWireError(oecdSearchDatasets, input);

    expect(http.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_url' },
    });
  });
});
