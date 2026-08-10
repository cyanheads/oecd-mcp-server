/**
 * @fileoverview Tests for oecd_get_dataset_info tool.
 * @module tests/tools/get-dataset-info.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdGetDatasetInfo } from '@/mcp-server/tools/definitions/get-dataset-info.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery } from '../helpers/error-contract.js';

/** Answer every request with a fresh copy of one response — a body reads once. */
function respondWith(build: Response): void {
  const init = {
    headers: build.headers,
    status: build.status,
    statusText: build.statusText,
  };
  const body = build.clone().text();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(await body, init)),
  );
}

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
                name: { en: 'Reference Area' },
                localRepresentation: {
                  enumeration:
                    'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD.SDD.NAD:CL_AREA(1.0)',
                },
              },
              {
                id: 'MEASURE',
                position: 2,
                name: 'Measure',
                localRepresentation: {},
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

describe('oecdGetDatasetInfo', () => {
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

  it('returns dimensions and time dimension for a valid flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });
    const result = await oecdGetDatasetInfo.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.flow_ref).toBe('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(result.dimensions).toHaveLength(3);
    expect(result.dimensions[0]).toMatchObject({ id: 'FREQ', position: 1, name: 'Frequency' });
    expect(result.dimensions[1]).toMatchObject({
      id: 'REF_AREA',
      position: 2,
      codelist_ref: 'OECD.SDD.NAD,CL_AREA',
    });
    expect(result.time_dimension).toMatchObject({ id: 'TIME_PERIOD' });
    // key_example should have 2 dots for 3 dimensions
    expect(result.key_example.split('.').length).toBe(3);
  });

  it('throws ctx.fail(invalid_flow_ref) for malformed flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: 'BAD_FORMAT' });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_flow_ref',
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'invalid_flow_ref') },
      },
    });
  });

  it('names a throttled structure read rate_limited with a wait-it-out hint', async () => {
    // OECD charges one throttle budget across the data and structure endpoints,
    // so a refused /datastructure is an ordinary outcome — and the hint matters
    // most here, since withRetry has already spent its attempts and its backoff
    // by the time the refusal surfaces.
    respondWith(
      new Response(
        'You have exceeded the number of requests currently permitted in the OECD Data API.',
        { status: 429, headers: { 'retry-after': '99999' } },
      ),
    );
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'rate_limited') },
      },
    });
  });

  it('names an exhausted outage upstream_unavailable', async () => {
    respondWith(new Response('boom', { status: 503 }));
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_unavailable',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'upstream_unavailable') },
      },
    });
  }, 20_000);

  it('names a status it does not model upstream_error rather than passing the code bare', async () => {
    // An Unauthorized on a keyless public API tells the caller nothing about
    // what to do next. The reason and its hint do.
    respondWith(new Response('Unauthorized', { status: 401 }));
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'upstream_error',
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'upstream_error') },
      },
    });
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
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_MISSING@DF_MISSING',
    });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when datastructure is missing from the 200 response', async () => {
    // parseDataStructure throws a NotFound for an empty dataStructures array in a
    // 200 response, which isDataflowNotFound picks up through the cause chain.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_X@DF_X',
    });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('rejects a flow_ref carrying path characters', async () => {
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@../../etc/passwd',
    });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_flow_ref' },
    });
  });

  it('formats output with dimension table and key example', () => {
    const output = {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimensions: [
        { id: 'FREQ', name: 'Frequency', position: 1, codelist_ref: 'OECD,CL_FREQ' },
        { id: 'REF_AREA', name: 'Reference Area', position: 2, codelist_ref: undefined },
      ],
      time_dimension: { id: 'TIME_PERIOD', name: 'Time Period', position: 3 },
      key_example: '.',
      non_production: false,
      source: 'OECD' as const,
    };
    const blocks = oecdGetDatasetInfo.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FREQ');
    expect(text).toContain('REF_AREA');
    expect(text).toContain('TIME_PERIOD');
    expect(text).toContain('Source: OECD');
  });
});

// ── Combined refs whose @-prefix is not the datastructure id ──────────────────

/**
 * `OECD.CFE.EDS,DSD_REG_LAB@DF_RATES` is backed by `DSD_REG_LABOUR`, so the
 * `@`-prefix names no datastructure at all. The response is keyed to the real
 * one, as OECD's own payload is.
 */
const MISMATCHED_PREFIX_DSD_RESPONSE = {
  data: {
    dataflows: [{ agencyID: 'OECD.CFE.EDS', id: 'DSD_REG_LAB@DF_RATES' }],
    dataStructures: [
      {
        id: 'DSD_REG_LABOUR',
        annotations: [],
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              { id: 'FREQ', position: 0, name: 'Frequency' },
              { id: 'REF_AREA', position: 1, name: 'Reference Area' },
            ],
            timeDimensions: [{ id: 'TIME_PERIOD', name: 'Time Period' }],
          },
        },
      },
    ],
  },
};

const MISMATCHED_FLOW_REF = 'OECD.CFE.EDS,DSD_REG_LAB@DF_RATES';
const MISMATCHED_DATAFLOW_URL = `${FAKE_BASE}/dataflow/OECD.CFE.EDS/DSD_REG_LAB@DF_RATES?references=datastructure`;

describe('oecdGetDatasetInfo prefix/datastructure mismatch', () => {
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

  it('resolves a dataflow whose @-prefix names no datastructure', async () => {
    http.route(
      {
        // The route the prefix would address, answering as OECD does for these.
        match: `${FAKE_BASE}/datastructure/OECD.CFE.EDS/DSD_REG_LAB`,
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
      {
        match: MISMATCHED_DATAFLOW_URL,
        respond: () => Response.json(MISMATCHED_PREFIX_DSD_RESPONSE),
      },
    );

    const result = await runToolContract(oecdGetDatasetInfo, { flow_ref: MISMATCHED_FLOW_REF });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      flow_ref: MISMATCHED_FLOW_REF,
      dimensions: [
        { id: 'FREQ', position: 1 },
        { id: 'REF_AREA', position: 2 },
      ],
      time_dimension: { id: 'TIME_PERIOD', position: 3 },
    });
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('REF_AREA');
  });

  it('still reports a dataflow OECD does not publish as not-found', async () => {
    http.route(
      {
        match: `${FAKE_BASE}/datastructure/OECD.SDD.NAD/DSD_GONE`,
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
      {
        match: `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_GONE@DF_GONE?references=datastructure`,
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
    );

    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: 'OECD.SDD.NAD,DSD_GONE@DF_GONE' });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('rejects a prefix carrying path characters before any request is issued', async () => {
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.CFE.EDS,../../etc/passwd@DF_RATES',
    });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_flow_ref' },
    });
    expect(http.calls).toHaveLength(0);
  });
});

// ── Dimension names ───────────────────────────────────────────────────────────

/**
 * OECD's datastructure response carries no `name` on a dimension, so without a
 * concept-scheme lookup the Name column just repeats the ID column.
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
                id: 'INSTR_ASSET',
                position: 0,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).INSTR_ASSET',
              },
              {
                id: 'ADJUSTMENT',
                position: 1,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_NA(1.0).ADJUSTMENT',
              },
            ],
            timeDimensions: [{ id: 'TIME_PERIOD' }],
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
        concepts: [
          { id: 'INSTR_ASSET', name: 'Financial instruments and non-financial assets' },
          { id: 'ADJUSTMENT', name: { en: 'Adjustment' } },
        ],
      },
    ],
  },
};

const DSD_URL = `${FAKE_BASE}/datastructure/OECD.SDD.NAD/DSD_NAMAIN1`;
/** The fixture URNs reference `CS_NA(1.0)`, and that version is what gets addressed. */
const SCHEME_URL = `${FAKE_BASE}/conceptscheme/OECD.SDD.NAD/CS_NA/1.0`;
const NAMAIN_FLOW_REF = 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD';

describe('oecdGetDatasetInfo dimension names', () => {
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

  it('reports what an opaque dimension id means', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: NAMAIN_FLOW_REF });
    const result = await oecdGetDatasetInfo.handler(input, ctx);

    expect(result.dimensions[0]).toMatchObject({
      id: 'INSTR_ASSET',
      name: 'Financial instruments and non-financial assets',
    });
    expect(result.dimensions[1]).toMatchObject({ id: 'ADJUSTMENT', name: 'Adjustment' });

    const text = (oecdGetDatasetInfo.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Financial instruments and non-financial assets');
  });

  it('answers with ids rather than failing when the concept scheme is down', async () => {
    http.route(
      { match: DSD_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => new Response('upstream boom', { status: 503 }) },
    );

    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: NAMAIN_FLOW_REF });
    const result = await oecdGetDatasetInfo.handler(input, ctx);

    expect(result.dimensions.map((d) => d.name)).toEqual(['INSTR_ASSET', 'ADJUSTMENT']);
  });
});
