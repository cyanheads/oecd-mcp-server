/**
 * @fileoverview Tests for oecd_get_dimension_values tool.
 * @module tests/tools/get-dimension-values.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdGetDimensionValues } from '@/mcp-server/tools/definitions/get-dimension-values.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

const FAKE_BASE = 'https://fake.oecd.test';

// Real API format: positions are 0-based, enumeration is a string URN, timeDimensions is an array.
// DSD with one dimension that has a codelist and one that doesn't
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
                id: 'MEASURE',
                position: 1,
                name: 'Measure',
                localRepresentation: {},
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

const CODELIST_RESPONSE = {
  data: {
    codelists: [
      {
        codes: [
          { id: 'A', name: 'Annual' },
          { id: 'Q', name: 'Quarterly' },
          { id: 'M', name: 'Monthly' },
        ],
      },
    ],
  },
};

describe('oecdGetDimensionValues', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
  });

  it('returns codes for a dimension with a codelist', async () => {
    // First fetch → DSD, second fetch → codelist
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(DSD_RESPONSE),
          text: () => Promise.resolve(''),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(CODELIST_RESPONSE),
          text: () => Promise.resolve(''),
        }),
    );

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.code_count).toBe(3);
    expect(result.codes).toEqual([
      { id: 'A', name: 'Annual' },
      { id: 'Q', name: 'Quarterly' },
      { id: 'M', name: 'Monthly' },
    ]);
  });

  it('enriches with a notice for a dimension with no codelist reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(''),
      }),
    );

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'MEASURE',
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.code_count).toBe(0);
    expect(result.codes).toHaveLength(0);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/no fixed codelist/i);
    expect(notice).toMatch(/free-form/i);
  });

  it('leaves the notice unset when the dimension has a codelist', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(DSD_RESPONSE),
          text: () => Promise.resolve(''),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(CODELIST_RESPONSE),
          text: () => Promise.resolve(''),
        }),
    );

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });
    await oecdGetDimensionValues.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('reads the codelist at the version the dimension references', async () => {
    /**
     * The unversioned endpoint answers with the root's current latest, which
     * for a codelist that has moved on since the datastructure was published
     * offers codes the dimension rejects.
     */
    const http = createFetchMock();
    http.route(
      {
        match: `${FAKE_BASE}/datastructure/OECD.SDD.NAD/DSD_NAAG`,
        respond: () => Response.json(DSD_RESPONSE),
      },
      {
        match: `${FAKE_BASE}/codelist/OECD/CL_FREQ/1.0`,
        respond: () => Response.json(CODELIST_RESPONSE),
      },
      // Latest, carrying a code the referenced revision does not have.
      {
        match: `${FAKE_BASE}/codelist/OECD/CL_FREQ`,
        respond: () =>
          Response.json({ data: { codelists: [{ codes: [{ id: 'W', name: 'Weekly' }] }] } }),
      },
    );
    http.install();

    try {
      const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
      const input = oecdGetDimensionValues.input.parse({
        flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
        dimension_id: 'FREQ',
      });
      const result = await oecdGetDimensionValues.handler(input, ctx);

      expect(result.codes.map((c) => c.id)).toEqual(['A', 'Q', 'M']);
      expect(http.calls.map((c) => c.request.url)).toEqual([
        `${FAKE_BASE}/datastructure/OECD.SDD.NAD/DSD_NAAG`,
        `${FAKE_BASE}/codelist/OECD/CL_FREQ/1.0`,
      ]);
    } finally {
      http.restore();
    }
  });

  it('throws ctx.fail(dataflow_not_found) for malformed flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'BAD',
      dimension_id: 'FREQ',
    });
    await expect(oecdGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when 200 response has empty dataStructures', async () => {
    // parseDataStructure throws a NotFound for an empty array in a 200 response;
    // the tool maps it to the dataflow_not_found contract entry.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_MISSING@DF_MISSING',
      dimension_id: 'FREQ',
    });
    await expect(oecdGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(dimension_not_found) for an unknown dimension_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(''),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'NONEXISTENT',
    });
    await expect(oecdGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dimension_not_found' },
    });
  });

  it('formats output with code table', () => {
    const output = {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
      ],
      code_count: 2,
      source: 'OECD' as const,
    };
    const blocks = oecdGetDimensionValues.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FREQ');
    expect(text).toContain('Annual');
    expect(text).toContain('Quarterly');
    expect(text).toContain('Source: OECD');
  });

  it('carries the notice on both client surfaces when the dimension has no codelist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(''),
      }),
    );

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'MEASURE',
    });

    // structuredContent clients (Claude Code) read the merged output object.
    expect(result.structuredContent).toMatchObject({
      dimension_id: 'MEASURE',
      code_count: 0,
      notice: expect.stringContaining('no fixed codelist'),
    });
    // content[] clients (Claude Desktop) read the enrichment trailer.
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('MEASURE');
    expect(text).toContain('no fixed codelist');
    expect(text).toContain('Source: OECD');
  });
});

// ── Filtering and pagination over a large codelist ────────────────────────────

/** Stands in for UNIT_MEASURE — a codelist far past any sane page. */
const LARGE_CODELIST_RESPONSE = {
  data: {
    codelists: [
      {
        codes: [
          ...Array.from({ length: 1163 }, (_, i) => ({
            id: `C${i}`,
            name: `Filler measure ${i}`,
          })),
          { id: 'PA', name: 'Percent per annum' },
        ],
      },
    ],
  },
};

function stubLargeCodelist() {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(''),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(LARGE_CODELIST_RESPONSE),
        text: () => Promise.resolve(''),
      }),
  );
}

describe('oecdGetDimensionValues filtering', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
  });

  it('narrows both client surfaces to the matching code and discloses the total', async () => {
    stubLargeCodelist();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      query: 'percent per annum',
    });

    // structuredContent no longer carries the whole 1,164-code list.
    expect(result.structuredContent).toMatchObject({
      code_count: 1,
      codes: [{ id: 'PA', name: 'Percent per annum' }],
      effectiveQuery: 'percent per annum',
    });
    // content[] reaches the same code, which used to sit past the 50-row cap.
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Percent per annum');
    expect(text).not.toContain('Filler measure');
  });

  it('matches the code id as well as the label', async () => {
    stubLargeCodelist();

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      query: 'pa',
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.codes.map((c) => c.id)).toContain('PA');
  });

  it('pages the codelist by default rather than returning all 1,164 codes', async () => {
    stubLargeCodelist();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });

    expect(result.structuredContent).toMatchObject({ code_count: 50, totalCount: 1164 });
    expect((result.structuredContent as { codes: unknown[] }).codes).toHaveLength(50);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('1164');
    expect(text).toMatch(/Showing codes 1–50 of 1164/);
  });

  it('returns an empty page for an offset past the end rather than an error', async () => {
    stubLargeCodelist();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      offset: 5000,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      codes: [],
      totalCount: 1164,
      notice: expect.stringContaining('past the 1164 matching codes'),
    });
  });

  it('explains an empty filtered result instead of reporting no codelist', async () => {
    stubLargeCodelist();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      query: 'zzz-nothing-matches',
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      effectiveQuery: 'zzz-nothing-matches',
      notice: expect.stringContaining('No code in FREQ matches'),
    });
    // Distinct from the dimension-has-no-codelist notice.
    expect((result.structuredContent as { notice: string }).notice).not.toContain(
      'no fixed codelist',
    );
  });

  it('honors an explicit limit and offset', async () => {
    stubLargeCodelist();

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      limit: 3,
      offset: 2,
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.codes.map((c) => c.id)).toEqual(['C2', 'C3', 'C4']);
    expect(getEnrichment(ctx).totalCount).toBe(1164);
  });

  it('names the last page as the last rather than pointing at an empty one', async () => {
    stubLargeCodelist();

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      limit: 500,
      offset: 1000,
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.code_count).toBe(164);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Showing codes 1001–1164 of 1164');
    expect(notice).toContain('This is the last page.');
    expect(notice).not.toContain('next page');
  });

  it('points at the next page by absolute offset rather than by an increment', async () => {
    stubLargeCodelist();

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      limit: 20,
      offset: 30,
    });
    await oecdGetDimensionValues.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('Advance offset to 50 for the next page');
  });

  it('leaves totalCount unset when the page covers every match', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(DSD_RESPONSE),
          text: () => Promise.resolve(''),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(CODELIST_RESPONSE),
          text: () => Promise.resolve(''),
        }),
    );

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.code_count).toBe(3);
    expect(getEnrichment(ctx).totalCount).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('renders every code on the page, with no formatter-side cap', async () => {
    const output = {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      codes: Array.from({ length: 120 }, (_, i) => ({ id: `C${i}`, name: `Measure ${i}` })),
      code_count: 120,
      source: 'OECD' as const,
    };
    const text = (oecdGetDimensionValues.format!(output)[0] as { text: string }).text;

    expect(text).toContain('| C0 | Measure 0 |');
    expect(text).toContain('| C119 | Measure 119 |');
    expect(text).not.toContain('Showing first 50');
  });
});
