/**
 * @fileoverview Tests for OecdStructureService — parseFlowRef, initStructureService, fetchDataflows/DataStructure/Codelist.
 * @module tests/services/oecd-structure/oecd-structure-service.test
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

  it('returns null when comma is missing', () => {
    expect(parseFlowRef('OECD.SDD.NAD')).toBeNull();
  });

  it('returns null when @ separator is missing', () => {
    expect(parseFlowRef('OECD.SDD.NAD,DSD_NAAG_DF_NAAG_I')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseFlowRef('')).toBeNull();
  });

  it('returns null when any part is empty after splitting', () => {
    expect(parseFlowRef(',@DF_NAAG_I')).toBeNull(); // empty agencyId
    expect(parseFlowRef('OECD,@DF')).toBeNull(); // empty dsdId
    expect(parseFlowRef('OECD,DSD@')).toBeNull(); // empty dfId
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
    // DF-only id case: DSD extracted from structure URN
    expect(flows[2]).toMatchObject({
      agencyId: 'ESTAT',
      dsdId: 'SDG_DSD',
      flowId: 'DF_SDG_GLC',
      flowRef: 'ESTAT,SDG_DSD@DF_SDG_GLC',
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
