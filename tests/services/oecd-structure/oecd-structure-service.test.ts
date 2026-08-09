/**
 * @fileoverview Tests for OecdStructureService — parseFlowRef, initStructureService, fetchDataflows/DataStructure/Codelist.
 * @module tests/services/oecd-structure/oecd-structure-service.test
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  directorateCode,
  getStructureService,
  initStructureService,
  isDataflowNotFound,
  OecdStructureService,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';

// ── parseFlowRef ──────────────────────────────────────────────────────────────

describe('parseFlowRef', () => {
  it('parses a well-formed flow ref', () => {
    const result = parseFlowRef('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(result).toEqual({ agencyId: 'OECD.SDD.NAD', dsdId: 'DSD_NAAG', dfId: 'DF_NAAG_I' });
  });

  it('parses the bare form OECD publishes for datastructure-less dataflows', () => {
    // The data endpoint answers this reference and rejects DSD_…@DF_… for these
    // flows, so it has to survive input validation.
    expect(parseFlowRef('OECD.TAD.ARP,DF_AEI2024_DASHBOARD')).toEqual({
      agencyId: 'OECD.TAD.ARP',
      dfId: 'DF_AEI2024_DASHBOARD',
    });
  });

  it('returns null when comma is missing', () => {
    expect(parseFlowRef('OECD.SDD.NAD')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseFlowRef('')).toBeNull();
  });

  it('returns null when any part is empty after splitting', () => {
    expect(parseFlowRef(',@DF_NAAG_I')).toBeNull(); // empty agencyId
    expect(parseFlowRef('OECD,@DF')).toBeNull(); // empty dsdId beside a present '@'
    expect(parseFlowRef('OECD,DSD@')).toBeNull(); // empty dfId
    expect(parseFlowRef('OECD,')).toBeNull(); // empty bare dfId
  });

  it('rejects characters that could alter the URL path', () => {
    expect(parseFlowRef('OECD.SDD.NAD,DSD_NAAG@../../etc/passwd')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,../../secret')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,DSD@DF?x=1')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,DSD@DF#frag')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,DSD/EVIL@DF')).toBeNull();
    expect(parseFlowRef('OECD/EVIL,DSD@DF')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,DF_A%2fB')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,DF_A B')).toBeNull();
  });

  it('rejects an identifier that is nothing but dots, in every position', () => {
    // A whole-segment `.` or `..` is a relative path reference: URL resolution
    // removes it and walks the request out of the endpoint it was addressed to.
    // The bare form makes the dfId position reachable with no '@' to stop it.
    expect(parseFlowRef('OECD.TAD.ARP,..')).toBeNull();
    expect(parseFlowRef('OECD.TAD.ARP,.')).toBeNull();
    expect(parseFlowRef('..,DSD_NAAG@DF_NAAG_I')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,..@DF_NAAG_I')).toBeNull();
    expect(parseFlowRef('OECD.SDD.NAD,DSD_NAAG@..')).toBeNull();
    expect(parseFlowRef('..,..')).toBeNull();
  });

  it('keeps dots inside an identifier, which every agency id carries', () => {
    expect(parseFlowRef('OECD.SDD.NAD.SEEA,DSD_A@DF_B')).toMatchObject({
      agencyId: 'OECD.SDD.NAD.SEEA',
    });
    expect(parseFlowRef('IAEG-SDGs,DF_SDG_GLH')).toMatchObject({ agencyId: 'IAEG-SDGs' });
  });
});

// ── directorateCode ───────────────────────────────────────────────────────────

describe('directorateCode', () => {
  it('reads the directorate segment regardless of how many segments follow', () => {
    expect(directorateCode('OECD.SDD.NAD')).toBe('SDD');
    expect(directorateCode('OECD.SDD.NAD.SEEA')).toBe('SDD');
    expect(directorateCode('OECD.ITF')).toBe('ITF');
  });

  it('resolves nothing for a publisher with no directorate segment', () => {
    expect(directorateCode('ESTAT')).toBeUndefined();
    expect(directorateCode('IAEG-SDGs')).toBeUndefined();
  });
});

// ── Service initialization guard ──────────────────────────────────────────────
// Tested inline in the singleton accessor describe block below via a
// fresh-module reset. Isolated in its own module-scoped test to avoid
// contaminating suites that call initStructureService() in beforeEach.

// ── fetchDataflows ─────────────────────────────────────────────────────────────

// Real API format: f.id is "DSD_XXX@DF_YYY" (combined), structure is a string URN.
// Also cover the DF-only case (no '@' in id) for the 8 non-OECD flows.
const MOCK_DATAFLOWS_RESPONSE = {
  data: {
    dataflows: [
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_NAAG@DF_NAAG_I',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAAG(1.0)',
        name: { en: 'National Accounts at a Glance' },
        annotations: [],
      },
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_NAAG@DF_NAAG_II',
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAAG(1.0)',
        name: 'National Accounts II',
        annotations: [{ id: 'NonProductionDataflow' }],
      },
      {
        agencyID: 'ESTAT',
        id: 'DF_SDG_GLC',
        structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=ESTAT:SDG_DSD(1.0)',
        name: 'SDG Global',
        annotations: [],
      },
    ],
  },
};

// OECD ships `description` as authored HTML, either as a plain string or a
// `{lang: text}` map, and omits it entirely for part of the catalog.
const MOCK_DESCRIBED_DATAFLOWS_RESPONSE = {
  data: {
    dataflows: [
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_QNA@DF_QNA',
        name: 'Quarterly National Accounts',
        description:
          '<p>Quarterly national accounts.</p><br><p>See the <a href="https://oecd.org">OECD methodology</a>&nbsp;&amp; notes&nbsp;&ndash; updated 2026.</p>',
        annotations: [],
      },
      {
        agencyID: 'OECD.ELS.SPD',
        id: 'DSD_EMP@DF_EMP',
        name: { en: 'Employment' },
        description: { en: '<strong>Employment</strong> indicators by region.' },
        annotations: [],
      },
      {
        agencyID: 'OECD.SDD',
        id: 'DSD_BARE@DF_BARE',
        name: 'Undocumented flow',
        annotations: [],
      },
    ],
  },
};

describe('OecdStructureService.fetchDataflows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed dataflows on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_DATAFLOWS_RESPONSE),
      }),
    );

    // Re-init with a fake base URL so config isn't needed
    const svc = new OecdStructureService('https://fake.oecd.test');
    const flows = await svc.fetchDataflows();

    expect(flows).toHaveLength(3);
    expect(flows[0]).toMatchObject({
      agencyId: 'OECD.SDD.NAD',
      dsdId: 'DSD_NAAG',
      flowId: 'DF_NAAG_I',
      flowRef: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      name: 'National Accounts at a Glance',
      nonProduction: false,
    });
    expect(flows[1]).toMatchObject({
      dsdId: 'DSD_NAAG',
      flowId: 'DF_NAAG_II',
      flowRef: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_II',
      nonProduction: true,
    });
    // DF-only id case: the reference stays as OECD publishes it, since pairing
    // it with the URN's datastructure produces a ref the data endpoint rejects.
    expect(flows[2]).toMatchObject({
      agencyId: 'ESTAT',
      dsdId: 'SDG_DSD',
      flowId: 'DF_SDG_GLC',
      flowRef: 'ESTAT,DF_SDG_GLC',
      nonProduction: false,
    });
  });

  it('throws ServiceUnavailable when fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Service Unavailable', { status: 503 })),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchDataflows()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('carries the dataflow description through as plain text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json(MOCK_DESCRIBED_DATAFLOWS_RESPONSE)),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const flows = await svc.fetchDataflows();

    // HTML tags become whitespace and named entities are decoded.
    expect(flows[0]?.description).toBe(
      'Quarterly national accounts. See the OECD methodology & notes – updated 2026.',
    );
    // Localized-map form is read the same way as the plain-string form.
    expect(flows[1]?.description).toBe('Employment indicators by region.');
    // A dataflow OECD publishes without a description carries none.
    expect(flows[2]).not.toHaveProperty('description');
  });
});

// ── Retry classification ──────────────────────────────────────────────────────

describe('OecdStructureService retry classification', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('does not retry a 404 and surfaces it as a not-found error', async () => {
    http.route({
      match: 'https://fake.oecd.test/dataflow/OECD.ELS',
      respond: () => new Response('Could not find requested structures', { status: 404 }),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    const error = await svc.fetchDataflows('OECD.ELS').catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(isDataflowNotFound(error as Error)).toBe(true);
  });

  it('retries a 5xx and succeeds when the upstream recovers', async () => {
    http.route(
      {
        match: 'https://fake.oecd.test/dataflow',
        once: true,
        respond: () => new Response('upstream boom', { status: 503 }),
      },
      {
        match: 'https://fake.oecd.test/dataflow',
        respond: () => Response.json(MOCK_DATAFLOWS_RESPONSE),
      },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const flows = await svc.fetchDataflows();

    expect(http.calls).toHaveLength(2);
    expect(flows).toHaveLength(3);
  });

  it('does not retry a 404 on the codelist endpoint either', async () => {
    http.route({
      match: 'https://fake.oecd.test/codelist/OECD/CL_MISSING',
      respond: () => new Response('Could not find requested structures', { status: 404 }),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchCodelist('OECD', 'CL_MISSING')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('retries a 500 instead of reporting it as an internal fault', async () => {
    http.route(
      {
        match: 'https://fake.oecd.test/dataflow',
        once: true,
        respond: () => new Response('upstream boom', { status: 500 }),
      },
      {
        match: 'https://fake.oecd.test/dataflow',
        respond: () => Response.json(MOCK_DATAFLOWS_RESPONSE),
      },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const flows = await svc.fetchDataflows();

    expect(http.calls).toHaveLength(2);
    expect(flows).toHaveLength(3);
  });

  it('surfaces a persistent 500 as an upstream outage', async () => {
    http.route({
      match: 'https://fake.oecd.test/dataflow',
      respond: () => new Response('upstream boom', { status: 500 }),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchDataflows()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(http.calls).toHaveLength(3);
  });

  it('waits before retrying a throttled request that asks to retry immediately', async () => {
    // OECD answers a throttled request with `Retry-After: 0`. Taken at face
    // value the retry lands within a millisecond and is refused again, so the
    // attempt is spent before the seconds-long throttle window can clear.
    http.route(
      {
        match: 'https://fake.oecd.test/dataflow',
        once: true,
        respond: () =>
          new Response('You have exceeded the number of requests currently permitted', {
            status: 429,
            headers: { 'retry-after': '0' },
          }),
      },
      {
        match: 'https://fake.oecd.test/dataflow',
        respond: () => Response.json(MOCK_DATAFLOWS_RESPONSE),
      },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const started = performance.now();
    const flows = await svc.fetchDataflows();

    expect(http.calls).toHaveLength(2);
    expect(flows).toHaveLength(3);
    expect(performance.now() - started).toBeGreaterThan(500);
  }, 10_000);

  it('still honors a Retry-After that names a real wait', async () => {
    http.route({
      match: 'https://fake.oecd.test/dataflow',
      respond: () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '99999' } }),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    // A wait past the retry budget is surfaced at once rather than burning attempts.
    await expect(svc.fetchDataflows()).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
    expect(http.calls).toHaveLength(1);
  });
});

// ── isDataflowNotFound ────────────────────────────────────────────────────────

describe('isDataflowNotFound', () => {
  it('finds a not-found buried under a wrapper that carries a different code', () => {
    const wrapped = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'Failed to fetch OECD datastructure for OECD.SDD.NAD,DSD_GONE@DF_GONE',
      {},
      { cause: notFound('DataStructure not found') },
    );

    expect(isDataflowNotFound(wrapped)).toBe(true);
  });

  it('does not claim a not-found for an unrelated failure', () => {
    expect(
      isDataflowNotFound(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'upstream boom',
          {},
          {
            cause: new Error('socket hang up'),
          },
        ),
      ),
    ).toBe(false);
  });
});

// ── fetchDataStructure ─────────────────────────────────────────────────────────

// Real API format: positions are 0-based, enumeration is a string URN, timeDimensions is an array.
const MOCK_DATASTRUCTURE_RESPONSE = {
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
                name: { en: 'Frequency' },
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
                name: { en: 'Time Period' },
              },
            ],
          },
        },
      },
    ],
  },
};

describe('OecdStructureService.fetchDataStructure', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed dimensions and time dimension', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_DATASTRUCTURE_RESPONSE),
      }),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');

    expect(dsd.dimensions).toHaveLength(2);
    expect(dsd.dimensions[0]).toMatchObject({ id: 'FREQ', position: 1, name: 'Frequency' });
    expect(dsd.dimensions[1]).toMatchObject({
      id: 'REF_AREA',
      position: 2,
      codelistRef: 'OECD.SDD.NAD,CL_AREA',
    });
    expect(dsd.timeDimension).toMatchObject({ id: 'TIME_PERIOD' });
    expect(dsd.nonProduction).toBe(false);
  });

  it('throws when dataStructures array is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
      }),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchDataStructure('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I')).rejects.toThrow(
      'DataStructure not found',
    );
  });

  it('throws on invalid flow_ref format', async () => {
    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchDataStructure('bad-format')).rejects.toThrow('Invalid flow_ref');
  });
});

// ── Dimension names from the concept scheme ───────────────────────────────────

/**
 * OECD's datastructure response carries no `name` on a dimension — only `id`,
 * `position`, `conceptIdentity` and `localRepresentation`. The names live in
 * the concept scheme the `conceptIdentity` URN points at.
 */
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
                id: 'FREQ',
                position: 0,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).FREQ',
                localRepresentation: {
                  enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=SDMX:CL_FREQ(2.1)',
                },
              },
              {
                id: 'INSTR_ASSET',
                position: 1,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).INSTR_ASSET',
              },
              {
                // A dimension the scheme does not cover.
                id: 'TABLE_IDENTIFIER',
                position: 2,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).TABLE_IDENTIFIER',
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

const CONCEPT_SCHEME_RESPONSE = {
  data: {
    conceptSchemes: [
      {
        id: 'CS_NA',
        concepts: [
          { id: 'FREQ', name: { en: 'Frequency of observation' } },
          { id: 'INSTR_ASSET', name: 'Financial instruments and non-financial assets' },
          { id: 'TIME_PERIOD', name: 'Time period' },
        ],
      },
    ],
  },
};

const DSD_URL = 'https://fake.oecd.test/datastructure/OECD.SDD.NAD/DSD_NAMAIN1';
const SCHEME_URL = 'https://fake.oecd.test/conceptscheme/OECD.SDD.NAD/CS_NA';
const NAMAIN_FLOW_REF = 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD';

describe('OecdStructureService.fetchDataStructure — dimension names', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('names each dimension from the concept scheme instead of echoing the id', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    expect(dsd.dimensions[0]).toMatchObject({ id: 'FREQ', name: 'Frequency of observation' });
    expect(dsd.dimensions[1]).toMatchObject({
      id: 'INSTR_ASSET',
      name: 'Financial instruments and non-financial assets',
    });
    expect(dsd.timeDimension).toMatchObject({ id: 'TIME_PERIOD', name: 'Time period' });
  });

  it('leaves a dimension the scheme omits on its id', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    expect(dsd.dimensions[2]).toMatchObject({
      id: 'TABLE_IDENTIFIER',
      name: 'TABLE_IDENTIFIER',
    });
  });

  it('fetches one scheme for the whole datastructure', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    expect(http.calls.filter((c) => c.request.url === SCHEME_URL)).toHaveLength(1);
  });

  it('still returns the datastructure when the concept scheme is unreachable', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => new Response('upstream boom', { status: 503 }) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    expect(dsd.dimensions.map((d) => d.name)).toEqual(['FREQ', 'INSTR_ASSET', 'TABLE_IDENTIFIER']);
    expect(dsd.timeDimension).toMatchObject({ name: 'TIME_PERIOD' });
  });

  it('degrades without a request when conceptIdentity is absent or unparseable', async () => {
    const noConcepts = {
      data: {
        dataStructures: [
          {
            id: 'DSD_NAMAIN1',
            annotations: [],
            dataStructureComponents: {
              dimensionList: {
                dimensions: [
                  { id: 'FREQ', position: 0 },
                  { id: 'REF_AREA', position: 1, conceptIdentity: 'not-a-urn' },
                  { id: 'MEASURE', position: 2, conceptIdentity: 42 },
                  {
                    // Versionless URN: nothing separates the scheme id from the concept id.
                    id: 'SECTOR',
                    position: 3,
                    conceptIdentity:
                      'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA.SECTOR',
                  },
                ],
                timeDimensions: [{ id: 'TIME_PERIOD' }],
              },
            },
          },
        ],
      },
    };
    http.route({ match: DSD_URL, respond: () => Response.json(noConcepts) });

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    expect(dsd.dimensions.map((d) => d.name)).toEqual(['FREQ', 'REF_AREA', 'MEASURE', 'SECTOR']);
    // No conceptIdentity to follow means no second request is issued at all.
    expect(http.calls).toHaveLength(1);
  });

  it('resolves through the dataflow when the ref prefix names no datastructure', async () => {
    // OECD publishes combined ids whose `@`-prefix is not the datastructure —
    // the prefix 404s while the catalogued id answers.
    http.route(
      {
        match: 'https://fake.oecd.test/datastructure/OECD.CFE.EDS/DSD_REG_LAB',
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
      {
        match:
          'https://fake.oecd.test/dataflow/OECD.CFE.EDS/DSD_REG_LAB@DF_RATES?references=datastructure',
        respond: () => Response.json(NAMELESS_DSD_RESPONSE),
      },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure('OECD.CFE.EDS,DSD_REG_LAB@DF_RATES');

    // The response names the datastructure the ref prefix got wrong.
    expect(dsd.dsdId).toBe('DSD_NAMAIN1');
    expect(dsd.dimensions).toHaveLength(3);
  });

  it('spends one structure request when the ref prefix resolves', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    // Datastructure + concept scheme, with no speculative dataflow lookup.
    expect(http.calls.map((c) => c.request.url)).toEqual([DSD_URL, SCHEME_URL]);
  });

  it('reports an outage on the datastructure route instead of retrying down the other one', async () => {
    http.route({ match: DSD_URL, respond: () => new Response('boom', { status: 503 }) });

    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchDataStructure(NAMAIN_FLOW_REF)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    // Three attempts on the one route; the dataflow route is never reached.
    expect(http.calls.every((c) => c.request.url === DSD_URL)).toBe(true);
  });

  it('reports not-found when neither route resolves the ref', async () => {
    http.route(
      {
        match: 'https://fake.oecd.test/datastructure/OECD.SDD.NAD/DSD_GONE',
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
      {
        match:
          'https://fake.oecd.test/dataflow/OECD.SDD.NAD/DSD_GONE@DF_GONE?references=datastructure',
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const error = await svc
      .fetchDataStructure('OECD.SDD.NAD,DSD_GONE@DF_GONE')
      .catch((e: Error) => e);

    expect(isDataflowNotFound(error as Error)).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  it('falls back when the datastructure route answers 200 with nothing in it', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json({ data: { dataStructures: [] } }) },
      {
        match: `https://fake.oecd.test/dataflow/OECD.SDD.NAD/DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD?references=datastructure`,
        respond: () => Response.json(NAMELESS_DSD_RESPONSE),
      },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure(NAMAIN_FLOW_REF);

    expect(dsd.dimensions).toHaveLength(3);
  });

  it('resolves a bare flow ref through the dataflow entry that carries its datastructure', async () => {
    http.route(
      {
        match:
          'https://fake.oecd.test/dataflow/OECD.TAD.ARP/DF_AEI2024_DASHBOARD?references=datastructure',
        respond: () => Response.json(NAMELESS_DSD_RESPONSE),
      },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const dsd = await svc.fetchDataStructure('OECD.TAD.ARP,DF_AEI2024_DASHBOARD');

    expect(dsd.dimensions).toHaveLength(3);
    expect(dsd.dimensions[0]).toMatchObject({ id: 'FREQ', name: 'Frequency of observation' });
    // The response names the datastructure the bare reference could not.
    expect(dsd.dsdId).toBe('DSD_NAMAIN1');
  });
});

// ── fetchDirectorates ─────────────────────────────────────────────────────────

const AGENCY_SCHEME_RESPONSE = {
  data: {
    agencySchemes: [
      {
        id: 'AGENCIES',
        agencies: [
          { id: 'SDD', name: { en: 'Statistics and Data Directorate' } },
          { id: 'CTP', name: 'Centre for Tax Policy and Administration' },
          { id: 'ITF', name: 'International Transport Forum' },
        ],
      },
    ],
  },
};

describe('OecdStructureService.fetchDirectorates', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('maps directorate codes to their published names', async () => {
    http.route({
      match: 'https://fake.oecd.test/agencyscheme/OECD',
      respond: () => Response.json(AGENCY_SCHEME_RESPONSE),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    const directorates = await svc.fetchDirectorates();

    expect(directorates.get('SDD')).toBe('Statistics and Data Directorate');
    expect(directorates.get('CTP')).toBe('Centre for Tax Policy and Administration');
    expect(directorates.get('ITF')).toBe('International Transport Forum');
    expect(directorates.has('NAD')).toBe(false);
  });

  it('returns an empty map when the scheme carries no agencies', async () => {
    http.route({
      match: 'https://fake.oecd.test/agencyscheme/OECD',
      respond: () => Response.json({ data: { agencySchemes: [] } }),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    expect((await svc.fetchDirectorates()).size).toBe(0);
  });

  it('surfaces an upstream failure to the caller', async () => {
    http.route({
      match: 'https://fake.oecd.test/agencyscheme/OECD',
      respond: () => new Response('upstream boom', { status: 503 }),
    });

    const svc = new OecdStructureService('https://fake.oecd.test');
    await expect(svc.fetchDirectorates()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

// ── fetchCodelist ─────────────────────────────────────────────────────────────

const MOCK_CODELIST_RESPONSE = {
  data: {
    codelists: [
      {
        codes: [
          { id: 'A', name: { en: 'Annual' } },
          { id: 'Q', name: 'Quarterly' },
        ],
      },
    ],
  },
};

describe('OecdStructureService.fetchCodelist', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_CODELIST_RESPONSE),
      }),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const codes = await svc.fetchCodelist('OECD', 'CL_FREQ');

    expect(codes).toHaveLength(2);
    expect(codes[0]).toEqual({ id: 'A', name: 'Annual' });
    expect(codes[1]).toEqual({ id: 'Q', name: 'Quarterly' });
  });

  it('returns empty array when codelist has no codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { codelists: [{ codes: [] }] } }),
      }),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const codes = await svc.fetchCodelist('OECD', 'CL_EMPTY');
    expect(codes).toHaveLength(0);
  });

  it('returns empty array when codelists array is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { codelists: [] } }),
      }),
    );

    const svc = new OecdStructureService('https://fake.oecd.test');
    const codes = await svc.fetchCodelist('OECD', 'CL_MISSING');
    expect(codes).toHaveLength(0);
  });
});

// ── Singleton accessor ────────────────────────────────────────────────────────

describe('initStructureService / getStructureService', () => {
  it('getStructureService returns instance after init', () => {
    // Stub env so parseEnvConfig succeeds
    process.env.OECD_BASE_URL = 'https://sdmx.oecd.org/public/rest';
    process.env.OECD_TIMEOUT_MS = '30000';
    initStructureService();
    const svc = getStructureService();
    expect(svc).toBeInstanceOf(OecdStructureService);
  });
});
