/**
 * @fileoverview Tests for oecd_get_dimension_values tool.
 * @module tests/tools/get-dimension-values.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { oecdGetDimensionValues } from '@/mcp-server/tools/definitions/get-dimension-values.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery, toolWireError, toolWireFailure } from '../helpers/error-contract.js';
import { cacheableJson, noResultsFound } from '../helpers/oecd-response.js';
import {
  installScriptedFetch,
  json,
  observe,
  PROXY_PAGE,
  rejectionOf,
  runUntil,
  type ScriptedAnswer,
  type ScriptedFetch,
  STALL,
} from '../helpers/scripted-fetch.js';

/**
 * Before the imports run: `tool()` emits the input schema once at definition
 * time, and the `limit` schema's getters read the server config, so importing
 * the tool parses that config. The base URL and timeout have to be in the
 * environment by then.
 */
vi.hoisted(() => {
  process.env.OECD_BASE_URL = 'https://fake.oecd.test';
  process.env.OECD_TIMEOUT_MS = '5000';
});

/** OECD's own wording for the request-rate throttle, which is charged across every endpoint. */
const THROTTLE_BODY =
  'You have exceeded the number of requests currently permitted in the OECD Data API.';

/**
 * A throttle naming a wait longer than the retry budget, so the refusal surfaces
 * on the first attempt instead of spending the backoff inside the test.
 */
function throttleResponse(): Response {
  return new Response(THROTTLE_BODY, { status: 429, headers: { 'retry-after': '99999' } });
}

const FAKE_BASE = 'https://fake.oecd.test';

/** The dataflow route every structure lookup for `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I` starts at. */
const REFERENCE_URL = `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I?references=datastructure`;

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
        .mockResolvedValueOnce(Response.json(DSD_RESPONSE))
        .mockResolvedValueOnce(Response.json(CODELIST_RESPONSE)),
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(DSD_RESPONSE)));

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
        .mockResolvedValueOnce(Response.json(DSD_RESPONSE))
        .mockResolvedValueOnce(Response.json(CODELIST_RESPONSE)),
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
      { match: REFERENCE_URL, respond: () => Response.json(DSD_RESPONSE) },
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
        REFERENCE_URL,
        `${FAKE_BASE}/codelist/OECD/CL_FREQ/1.0`,
      ]);
    } finally {
      http.restore();
    }
  });

  it('throws ctx.fail(invalid_flow_ref) for malformed flow_ref', async () => {
    // No request is issued for a string that is not a flow reference, so
    // "not found" would assert something this tool never checked — and its hint
    // sends the caller to re-look-up a reference they may already hold.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'BAD',
      dimension_id: 'FREQ',
    });
    await expect(toolWireError(oecdGetDimensionValues, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_flow_ref',
        recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'invalid_flow_ref') },
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws ctx.fail(dataflow_not_found) when 200 response has empty dataStructures', async () => {
    // A ref that no route resolves to a datastructure is a NotFound from the
    // service; the tool maps it to the dataflow_not_found contract entry. A
    // fresh Response per call, since a body reads once and more than one route
    // is tried.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: { dataStructures: [] } }))),
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(DSD_RESPONSE)));
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

  it('names a throttled datastructure read rate_limited, not an unexplained refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(throttleResponse())),
    );
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });

    await expect(toolWireError(oecdGetDimensionValues, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'rate_limited') },
      },
    });
  });

  it('names a throttled codelist read too, which no datastructure catch covers', async () => {
    // The codelist is fetched after the datastructure resolves, outside the
    // catch that handles it. OECD charges the throttle across every endpoint,
    // so the refusal lands on whichever of the two is in flight.
    const http = createFetchMock();
    http.route(
      { match: REFERENCE_URL, respond: () => Response.json(DSD_RESPONSE) },
      { match: `${FAKE_BASE}/codelist/OECD/CL_FREQ/1.0`, respond: () => throttleResponse() },
    );
    http.install();

    try {
      const input = oecdGetDimensionValues.input.parse({
        flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
        dimension_id: 'FREQ',
      });

      await expect(toolWireError(oecdGetDimensionValues, input)).resolves.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'rate_limited',
          recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'rate_limited') },
        },
      });
    } finally {
      http.restore();
    }
  });

  it('names a status it does not model upstream_error rather than passing the code bare', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('Forbidden', { status: 403 }))),
    );
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });

    await expect(toolWireError(oecdGetDimensionValues, input)).resolves.toMatchObject({
      data: {
        reason: 'upstream_error',
        recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'upstream_error') },
      },
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
      available_only: false,
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(DSD_RESPONSE)));

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
      .mockResolvedValueOnce(Response.json(DSD_RESPONSE))
      .mockImplementation(() => Promise.resolve(Response.json(LARGE_CODELIST_RESPONSE))),
  );
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Everything `content[]` carries, as one string. */
function textOf(result: ToolResult): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

/** What a CommonMark reader reads `content[]` as — the text with every Markdown escape resolved. */
function renderedOf(result: ToolResult): string {
  return new MarkdownIt()
    .parse(textOf(result), {})
    .flatMap((token) => token.children ?? [token])
    .map((token) => (token.type === 'text' || token.type === 'code_inline' ? token.content : ''))
    .join('');
}

/** The clamp sentence a `limit` of 20,000 adds to the page's one notice. */
const CLAMP_20000 = '`limit` 20000 is above the per-call maximum of 10000; served 10000.';

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

  it('keeps the caller query raw in the notice and escapes it only where content[] renders it', async () => {
    stubLargeCodelist();

    const query = '*rate* [x](y) #';
    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      query,
    });

    // structuredContent carries the notice as written, with no Markdown escapes in it.
    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      effectiveQuery: query,
      notice:
        'No code in FREQ matches "*rate* [x](y) #". Try a shorter term, or omit query to page the full 1164-code list.',
    });
    // content[] escapes it, and a CommonMark parse reads the query back verbatim.
    const raw = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(raw).toContain(
      '> No code in FREQ matches "\\*rate\\* \\[x\\](y) #". Try a shorter term, or omit query to page the full 1164-code list.',
    );
    const rendered = new MarkdownIt()
      .parse(raw, {})
      .flatMap((token) => token.children ?? [token])
      .map((token) => (token.type === 'text' || token.type === 'code_inline' ? token.content : ''))
      .join('');
    expect(rendered).toContain(
      'No code in FREQ matches "*rate* [x](y) #". Try a shorter term, or omit query to page the full 1164-code list.',
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

  it('serves a limit of 501 as asked, with no clamp sentence', async () => {
    stubLargeCodelist();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      limit: 501,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      code_count: 501,
      totalCount: 1164,
      notice:
        'Showing codes 1–501 of 1164. Advance offset to 501 for the next page, or pass query to narrow by code or label.',
    });
  });

  it('serves a limit at the cap with neither a clamp nor a paging sentence', async () => {
    stubLargeCodelist();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      limit: 10_000,
    });

    expect(result.structuredContent).toMatchObject({ code_count: 1164 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('serves a limit above the cap at the cap, in one notice with the paging sentence, on both surfaces', async () => {
    stubLargeCodelist();
    const notice = `${CLAMP_20000} Showing codes 1001–1164 of 1164. This is the last page.`;

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      limit: 20_000,
      offset: 1000,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ code_count: 164, totalCount: 1164, notice });
    expect(renderedOf(result)).toContain(notice);
  });

  it('leaves totalCount unset when the page covers every match', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(DSD_RESPONSE))
        .mockResolvedValueOnce(Response.json(CODELIST_RESPONSE)),
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
      available_only: false,
      source: 'OECD' as const,
    };
    const text = (oecdGetDimensionValues.format!(output)[0] as { text: string }).text;

    expect(text).toContain('| C0 | Measure 0 |');
    expect(text).toContain('| C119 | Measure 119 |');
    expect(text).not.toContain('Showing first 50');
  });
});

// ── Upstream failure wiring ───────────────────────────────────────────────────

/**
 * How each upstream failure reaches this tool's caller, from either of its two
 * reads — the datastructure, and the codelist that sits outside the
 * datastructure's catch. The mechanisms — the reason mapping and the call's
 * budget — are tabled at the HTTP boundary; these prove the tool is wired to
 * them, one case per side of each branch.
 */
describe('oecdGetDimensionValues upstream failure wiring', () => {
  const input = { flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I', dimension_id: 'FREQ' };
  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  /** Answer the datastructure and the codelist each from its own script. */
  function serve(datastructure: ScriptedAnswer, codelist = json(CODELIST_RESPONSE)): ScriptedFetch {
    fake = installScriptedFetch((url) => (url.includes('/codelist/') ? codelist : datastructure));
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

  it('names a datastructure body that is not JSON upstream_unreadable, after one request', async () => {
    const http = serve(PROXY_PAGE);
    const hint = declaredRecovery(oecdGetDimensionValues, 'upstream_unreadable');

    const { error, text } = await toolWireFailure(oecdGetDimensionValues, input);

    expect(http.requests.map((r) => r.url)).toEqual([REFERENCE_URL]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable', recovery: { hint }, retryable: false },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
    expect(text).toContain(hint);
  });

  it('names a codelist body that is not JSON upstream_unreadable, after one codelist request', async () => {
    const http = serve(json(DSD_RESPONSE), PROXY_PAGE);

    const error = await toolWireError(oecdGetDimensionValues, input);

    expect(http.requestsTo('/codelist/')).toHaveLength(1);
    expect(error.data).toMatchObject({
      reason: 'upstream_unreadable',
      recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'upstream_unreadable') },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
  });

  it('names a datastructure that points at a codelist outside the SDMX character set upstream_unreadable, without requesting it', async () => {
    const outsideCharset = JSON.parse(
      JSON.stringify(DSD_RESPONSE).replace('OECD:CL_FREQ(1.0)', 'OECD:CL/FREQ(1.0)'),
    ) as unknown;
    const http = serve(json(outsideCharset));

    const error = await toolWireError(oecdGetDimensionValues, input);

    expect(http.requestsTo('/codelist/')).toHaveLength(0);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toContain('OECD/CL/FREQ');
  });

  it('names a datastructure 422 upstream_error, carrying the status and OECD’s text', async () => {
    serve({ body: 'Semantic error in the structure query', kind: 'answer', status: 422 });

    const error = await toolWireError(oecdGetDimensionValues, input);

    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'upstream_error') },
    });
    expect(error.message).toContain(
      'OECD answered HTTP 422: Semantic error in the structure query',
    );
  });

  it('gives a stalled codelist only what a slow datastructure left of the one budget', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(json(DSD_RESPONSE, 20_000), STALL);

    const call = observe(toolWireError(oecdGetDimensionValues, input));
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(http.requestsTo('/codelist/')).toEqual([
      { atMs: 20_000, url: `${FAKE_BASE}/codelist/OECD/CL_FREQ/1.0` },
    ]);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'upstream_timeout') },
        },
      },
    });
  });

  it('lets a failure with no OECD answer behind it through as itself', async () => {
    getServerConfig().baseUrl = 'ftp://fake.oecd.test';
    initStructureService();
    const http = serve(json(DSD_RESPONSE));

    const error = await toolWireError(oecdGetDimensionValues, input);

    expect(http.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_url' },
    });
  });
});

// ── The codes with data: available_only and key ───────────────────────────────

const FLOW_REF = 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I';
const CODELIST_URL = `${FAKE_BASE}/codelist/OECD/CL_FREQ/1.0`;

/** The availability URL for {@link FLOW_REF} under `key`. */
function availabilityUrl(key = 'all', root = FAKE_BASE): string {
  return `${root}/availableconstraint/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/${key}/all/all?mode=available`;
}

/**
 * An `availableconstraint` message in the shape OECD sends: each dimension's
 * codes, the `TIME_PERIOD` range — OECD's inverted no-data sentinel when no
 * range is given — and the `obs_count` annotation.
 */
function availabilityOf(
  codes: Record<string, string[]>,
  obsCount: number,
  range?: { end: string; start: string },
): unknown {
  return {
    data: {
      contentConstraints: [
        {
          id: 'CC',
          annotations: [{ id: 'obs_count', title: String(obsCount), type: 'sdmx_metrics' }],
          type: 'Actual',
          cubeRegions: [
            {
              isIncluded: true,
              keyValues: [
                ...Object.entries(codes).map(([id, values]) => ({ id, values })),
                {
                  id: 'TIME_PERIOD',
                  timeRange: {
                    startPeriod: {
                      period: `${range?.start ?? '9999-01-01'}T00:00:00`,
                      isInclusive: true,
                    },
                    endPeriod: {
                      period: `${range?.end ?? '0001-12-31'}T23:59:59`,
                      isInclusive: true,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** What OECD answers for {@link FLOW_REF} with key `all`: FREQ carries a code CL_FREQ 1.0 does not list. */
const ALL_SERIES = availabilityOf({ FREQ: ['Q', 'W', 'A'], MEASURE: ['B1GQ', 'P3'] }, 1234, {
  start: '1990-01-01',
  end: '2024-12-31',
});

describe('oecdGetDimensionValues available_only and key', () => {
  let configured: { baseUrl: string; clampLimits: boolean; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  /** Answer each of the three reads from its own script. */
  function serve(answers: {
    availability?: ScriptedAnswer;
    codelist?: ScriptedAnswer;
    datastructure?: ScriptedAnswer;
  }): ScriptedFetch {
    fake = installScriptedFetch((url) => {
      if (url.includes('/availableconstraint/')) {
        if (!answers.availability) throw new Error(`Unexpected availability request: ${url}`);
        return answers.availability;
      }
      if (url.includes('/codelist/')) return answers.codelist ?? json(CODELIST_RESPONSE);
      return answers.datastructure ?? json(DSD_RESPONSE);
    });
    return fake;
  }

  beforeEach(() => {
    const config = getServerConfig();
    configured = {
      baseUrl: config.baseUrl,
      clampLimits: config.clampLimits,
      timeoutMs: config.timeoutMs,
    };
    initStructureService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.assign(getServerConfig(), configured);
    initStructureService();
    const installed = fake;
    fake = undefined;
    installed?.restore();
  });

  it('lists only the codes with data, in codelist order, then those the codelist lacks under their id', async () => {
    serve({ availability: json(ALL_SERIES) });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
    });

    expect(result.structuredContent).toEqual({
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
        { id: 'W', name: 'W' },
      ],
      code_count: 3,
      available_only: true,
      time_range: { start: '1990-01-01', end: '2024-12-31' },
      observation_count: 1234,
      source: 'OECD',
    });
    const text = textOf(result);
    expect(text).toContain('only codes with data in this dataflow (available_only: true)');
    expect(text).toContain('Time range: 1990-01-01 to 2024-12-31');
    expect(text).toContain('Observations: 1234');
    expect(text).toContain('| W | W |');
    expect(text).not.toContain('Monthly');
  });

  it('reads availability at the key-less URL beside the datastructure and the codelist', async () => {
    const http = serve({ availability: json(ALL_SERIES) });

    await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
    });

    const urls = http.requests.map((r) => r.url);
    expect(urls).toHaveLength(3);
    expect(urls).toEqual(expect.arrayContaining([REFERENCE_URL, CODELIST_URL, availabilityUrl()]));
  });

  it('sends the codelist and availability reads together, so the call waits on the slower one', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve({
      availability: json(ALL_SERIES, 1000),
      codelist: json(CODELIST_RESPONSE, 1000),
    });

    const call = observe(
      runToolContract(oecdGetDimensionValues, {
        flow_ref: FLOW_REF,
        dimension_id: 'FREQ',
        available_only: true,
      }),
    );
    const { pendingBefore } = await runUntil(call, 1000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(1000);
    expect(http.requestsTo('/codelist/').map((r) => r.atMs)).toEqual([0]);
    expect(http.requestsTo('/availableconstraint/').map((r) => r.atMs)).toEqual([0]);
  });

  it.each([
    ['neither available_only nor key', {}],
    ['a blank key', { key: '' }],
  ])('sends no availability read for %s, only the usual two', async (_case, extra) => {
    const http = serve({});

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      ...extra,
    });

    expect(http.requests.map((r) => r.url)).toEqual([REFERENCE_URL, CODELIST_URL]);
    expect(result.structuredContent).toEqual({
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
        { id: 'M', name: 'Monthly' },
      ],
      code_count: 3,
      available_only: false,
      source: 'OECD',
    });
    expect(textOf(result)).toContain('from the whole codelist (available_only: false)');
  });

  it('reads availability under a key, which implies available_only', async () => {
    const http = serve({
      availability: json(
        availabilityOf({ FREQ: ['A', 'Q'], MEASURE: ['B1GQ'] }, 40, {
          start: '2000-01-01',
          end: '2009-12-31',
        }),
      ),
    });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'Q.B1GQ',
    });

    expect(http.requestsTo('/availableconstraint/').map((r) => r.url)).toEqual([
      availabilityUrl('Q.B1GQ'),
    ]);
    expect(result.structuredContent).toMatchObject({
      available_only: true,
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
      ],
      observation_count: 40,
      time_range: { start: '2000-01-01', end: '2009-12-31' },
    });
  });

  it('sends the every-series key unsegmented, with no segment count to check', async () => {
    const http = serve({ availability: json(ALL_SERIES) });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'all',
    });

    expect(result.isError).toBeFalsy();
    expect(http.requestsTo('/availableconstraint/').map((r) => r.url)).toEqual([availabilityUrl()]);
  });

  it.each(['Q/A', 'Q A', 'Q.B1GQ?x=1', 'Q.B1GQ#'])(
    'rejects the key %j as invalid_key before any request',
    async (key) => {
      const http = serve({ availability: json(ALL_SERIES) });

      const error = await toolWireError(oecdGetDimensionValues, {
        flow_ref: FLOW_REF,
        dimension_id: 'FREQ',
        key,
      });

      expect(http.requests).toHaveLength(0);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_key',
          recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'invalid_key') },
        },
      });
      expect(error.message).toContain(
        `Key "${key}" holds a character outside the SDMX key set — letters, digits, ".", "+", "_", "-", and "%"`,
      );
    },
  );

  it('rejects a key with fewer segments than dimensions as invalid_key after the datastructure alone', async () => {
    const http = serve({ availability: json(ALL_SERIES) });

    const error = await toolWireError(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'Q',
    });

    expect(http.requests.map((r) => r.url)).toEqual([REFERENCE_URL]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_key',
        recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'invalid_key') },
      },
    });
    expect(error.message).toContain(
      `Key "Q" has 1 segment, but ${FLOW_REF} has 2 dimensions — one segment each, empty for a wildcard`,
    );
  });

  it('trims extra trailing empty segments before calling availability and diagnosing the key', async () => {
    const http = serve({
      availability: json(
        availabilityOf({ FREQ: ['A', 'Q'], MEASURE: ['B1GQ'] }, 40, {
          start: '2000-01-01',
          end: '2009-12-31',
        }),
      ),
    });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'Q.B1GQ..',
    });

    expect(result.isError).toBeFalsy();
    expect(http.requestsTo('/availableconstraint/').map((r) => r.url)).toEqual([
      availabilityUrl('Q.B1GQ'),
    ]);
    expect(result.structuredContent).toMatchObject({
      available_only: true,
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
      ],
      observation_count: 40,
      time_range: { start: '2000-01-01', end: '2009-12-31' },
    });
  });

  it('rejects a key with an extra non-empty segment as invalid_key without calling codelist or availability', async () => {
    const http = serve({ availability: json(ALL_SERIES) });

    const error = await toolWireError(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'Q.B1GQ.2025-Q1',
    });

    expect(http.requests.map((r) => r.url)).toEqual([REFERENCE_URL]);
    expect(http.requestsTo('/codelist/')).toHaveLength(0);
    expect(http.requestsTo('/availableconstraint/')).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_key',
        recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'invalid_key') },
      },
    });
    expect(error.message).toContain('3 segments');
    expect(error.message).toContain('2 dimensions');
    expect(error.message).toContain('time is not a key segment');
    expect(error.message).toContain('on oecd_query_dataset');
  });

  it('lists a dimension with no codelist from availability, each code under its id', async () => {
    const http = serve({ availability: json(ALL_SERIES) });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'MEASURE',
      available_only: true,
    });

    expect(http.requests.map((r) => r.url)).toEqual([REFERENCE_URL, availabilityUrl()]);
    expect(result.structuredContent).toMatchObject({
      available_only: true,
      code_count: 2,
      codes: [
        { id: 'B1GQ', name: 'B1GQ' },
        { id: 'P3', name: 'P3' },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('points a dimension with no codelist at available_only when it was not asked for', async () => {
    serve({});

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'MEASURE',
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      available_only: false,
      notice:
        'This dimension has no fixed codelist — it accepts dynamic or free-form values. Pass available_only: true to list the values that have data in this dataflow.',
    });
  });

  it('names the pinned segment with no data when the key matches no series', async () => {
    // FREQ's list is computed against MEASURE=B1GQ; MEASURE has nothing given FREQ=W.
    serve({ availability: json(availabilityOf({ FREQ: ['A', 'Q'] }, 0)) });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'W.B1GQ',
    });

    expect(result.structuredContent).toMatchObject({
      available_only: true,
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
      ],
      observation_count: 0,
      notice: 'The key matches no series: FREQ "W" has no data given the other segments.',
    });
    expect(result.structuredContent).not.toHaveProperty('time_range');
    expect(textOf(result)).toContain(
      'The key matches no series: FREQ "W" has no data given the other segments.',
    );
  });

  it('says the pinned segments match nothing together when no single segment can be named', async () => {
    serve({ availability: json(availabilityOf({}, 0)) });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'A.P3',
    });

    expect(result.structuredContent).toMatchObject({
      available_only: true,
      code_count: 0,
      notice: 'The key matches no series: its pinned segments match no series together.',
    });
  });

  it('says a key-less read found no observations at all', async () => {
    serve({ availability: json(availabilityOf({}, 0)) });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      notice: 'OECD records no observations for this dataflow.',
    });
  });

  it('names a pinned code that matches only by case, on both surfaces', async () => {
    // OECD reads `q` as `Q`, so the read finds series; the data endpoint would not.
    serve({
      availability: json(
        availabilityOf({ FREQ: ['A', 'Q'], MEASURE: ['B1GQ'] }, 40, {
          start: '2000-01-01',
          end: '2009-12-31',
        }),
      ),
    });
    const notice = 'In the key, FREQ "q" matches "Q" only by case, and codes are case-sensitive.';

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      key: 'q.B1GQ',
    });

    expect(result.structuredContent).toMatchObject({ available_only: true, notice });
    expect(renderedOf(result)).toContain(notice);
  });

  it.each([
    [500, 'OECD answered HTTP 500'],
    [429, 'OECD answered HTTP 429'],
  ])('lists the whole codelist on an availability %i, saying why', async (status, clause) => {
    const http = serve({ availability: { body: 'Refused', kind: 'answer', status } });
    const notice = `Availability could not be read (${clause}), so this lists the whole codelist, which can hold codes this dataflow has no data for.`;

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
    });

    // The datastructure, the codelist, and the one availability read: nothing more.
    expect(http.requests.map((r) => r.url)).toEqual(
      expect.arrayContaining([REFERENCE_URL, CODELIST_URL, availabilityUrl()]),
    );
    expect(http.requests).toHaveLength(3);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
        { id: 'M', name: 'Monthly' },
      ],
      code_count: 3,
      available_only: false,
      notice,
      source: 'OECD',
    });
    expect(textOf(result)).toContain('from the whole codelist (available_only: false)');
    expect(renderedOf(result)).toContain(notice);
  });

  it('says there is nothing to list instead when availability fails for a dimension with no codelist', async () => {
    serve({ availability: PROXY_PAGE });

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'MEASURE',
      available_only: true,
    });

    expect(result.structuredContent).toMatchObject({
      available_only: false,
      code_count: 0,
      notice:
        'Availability could not be read (OECD answered with a body this server could not read), and this dimension has no codelist to list instead.',
    });
  });

  it('carries a clamp, an availability failure, and a page into one notice', async () => {
    fake = installScriptedFetch((url) => {
      if (url.includes('/availableconstraint/')) {
        return { body: 'Internal server error', kind: 'answer', status: 500 };
      }
      return url.includes('/codelist/') ? json(LARGE_CODELIST_RESPONSE) : json(DSD_RESPONSE);
    });
    const notice = `${CLAMP_20000} Availability could not be read (OECD answered HTTP 500), so this lists the whole codelist, which can hold codes this dataflow has no data for. Showing codes 1001–1164 of 1164. This is the last page.`;

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
      limit: 20_000,
      offset: 1000,
    });

    expect(result.structuredContent).toMatchObject({
      available_only: false,
      code_count: 164,
      totalCount: 1164,
      notice,
    });
    expect(renderedOf(result)).toContain(notice);
  });

  it('names the call’s budget running out during the availability read upstream_timeout, at 50 s', async () => {
    vi.useFakeTimers({ now: 0 });
    // The default OECD_TIMEOUT_MS, so the availability read is cut by the budget, not by its own timeout.
    getServerConfig().timeoutMs = 30_000;
    initStructureService();
    const http = serve({ availability: STALL, datastructure: json(DSD_RESPONSE, 25_000) });

    const call = observe(
      toolWireError(oecdGetDimensionValues, {
        flow_ref: FLOW_REF,
        dimension_id: 'FREQ',
        available_only: true,
      }),
    );
    const { outcome, pendingBefore } = await runUntil(call, 50_000);

    expect(pendingBefore).toBe(true);
    expect(call.settledAtMs).toBe(50_000);
    expect(http.requestsTo('/availableconstraint/')).toEqual([
      { atMs: 25_000, url: availabilityUrl() },
    ]);
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'upstream_timeout',
          recovery: { hint: declaredRecovery(oecdGetDimensionValues, 'upstream_timeout') },
        },
      },
    });
  });

  it('ends the call as RequestCancelled when the caller aborts during the availability read', async () => {
    vi.useFakeTimers({ now: 0 });
    const caller = new AbortController();
    // The datastructure and the codelist are cached, so the availability read is the only one in flight.
    const cacheable = { headers: { 'cache-control': 'public,max-age=86400' } };
    const warm = serve({
      codelist: { ...json(CODELIST_RESPONSE), ...cacheable },
      datastructure: { ...json(DSD_RESPONSE), ...cacheable },
    });
    await oecdGetDimensionValues.handler(
      oecdGetDimensionValues.input.parse({ flow_ref: FLOW_REF, dimension_id: 'FREQ' }),
      createMockContext({ errors: oecdGetDimensionValues.errors }),
    );
    const warmed = warm.requests.length;
    fake = undefined;
    warm.restore();
    fake = installScriptedFetch((url) => {
      if (!url.includes('/availableconstraint/')) throw new Error(`Unexpected request: ${url}`);
      queueMicrotask(() => caller.abort());
      return STALL;
    });

    const call = observe(
      Promise.resolve(
        oecdGetDimensionValues.handler(
          oecdGetDimensionValues.input.parse({
            flow_ref: FLOW_REF,
            dimension_id: 'FREQ',
            available_only: true,
          }),
          createMockContext({ errors: oecdGetDimensionValues.errors, signal: caller.signal }),
        ),
      ),
    );
    // Far past OECD_TIMEOUT_MS: a read that absorbed the abort would settle with the codelist.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(warmed).toBe(2);
    expect(fake.requests.map((r) => r.url)).toEqual([availabilityUrl()]);
    expect(call.settledAtMs).toBe(0);
    expect(await rejectionOf(call)).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it('reports a dataflow OECD does not publish as dataflow_not_found, reading neither codelist nor availability', async () => {
    const reference = `${FAKE_BASE}/dataflow/OECD.SDD.TPS/DSD_LFS@DF_IALFS_UNE_MM?references=datastructure`;
    const http = createFetchMock();
    http.route({ match: reference, respond: () => noResultsFound() });
    http.install();

    try {
      const error = await toolWireError(oecdGetDimensionValues, {
        flow_ref: 'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_MM',
        dimension_id: 'AGE',
        available_only: true,
      });

      expect(http.calls.map((c) => c.request.url)).toEqual([reference]);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'dataflow_not_found' },
      });
    } finally {
      http.restore();
    }
  });

  it('serves a repeat call from the structure cache, availability included, with no request', async () => {
    const http = createFetchMock();
    http.route(
      { match: REFERENCE_URL, respond: () => cacheableJson(DSD_RESPONSE) },
      { match: CODELIST_URL, respond: () => cacheableJson(CODELIST_RESPONSE) },
      { match: availabilityUrl(), respond: () => cacheableJson(ALL_SERIES) },
    );
    http.install();
    const input = { flow_ref: FLOW_REF, dimension_id: 'FREQ', available_only: true };

    try {
      const first = await runToolContract(oecdGetDimensionValues, input);
      const calls = http.calls.length;
      const second = await runToolContract(oecdGetDimensionValues, input);

      expect(calls).toBe(3);
      expect(http.calls).toHaveLength(3);
      expect(second.structuredContent).toEqual(first.structuredContent);
    } finally {
      http.restore();
    }
  });

  it('reads a delegated dataflow’s availability on the root that defines it, never the configured one', async () => {
    const delegatedRoot = `${FAKE_BASE}/sti-public/rest`;
    const tivaRef = 'OECD.STI.PIE,DSD_TIVA_MAINLV@DF_MAINLV';
    const tivaAvailability = `${delegatedRoot}/availableconstraint/OECD.STI.PIE,DSD_TIVA_MAINLV%40DF_MAINLV/all/all/all?mode=available`;
    const http = createFetchMock();
    http.route(
      {
        match: `${FAKE_BASE}/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV?references=datastructure`,
        respond: () =>
          Response.json({
            data: {
              dataStructures: [],
              dataflows: [
                {
                  agencyID: 'OECD.STI.PIE',
                  id: 'DSD_TIVA_MAINLV@DF_MAINLV',
                  isExternalReference: true,
                  links: [
                    {
                      rel: 'external',
                      href: `${delegatedRoot}/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV/1.2`,
                    },
                  ],
                },
              ],
            },
          }),
      },
      {
        match: `${FAKE_BASE}/datastructure/OECD.STI.PIE/DSD_TIVA_MAINLV`,
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
      {
        match: `${delegatedRoot}/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV?references=datastructure`,
        respond: () => Response.json(DSD_RESPONSE),
      },
      {
        match: `${delegatedRoot}/codelist/OECD/CL_FREQ/1.0`,
        respond: () => Response.json(CODELIST_RESPONSE),
      },
      { match: tivaAvailability, respond: () => Response.json(ALL_SERIES) },
    );
    http.install();

    try {
      const result = await runToolContract(oecdGetDimensionValues, {
        flow_ref: tivaRef,
        dimension_id: 'FREQ',
        available_only: true,
      });

      const urls = http.calls.map((c) => c.request.url);
      expect(urls.filter((url) => url.includes('/availableconstraint/'))).toEqual([
        tivaAvailability,
      ]);
      expect(result.structuredContent).toMatchObject({ available_only: true, code_count: 3 });
    } finally {
      http.restore();
    }
  });

  /**
   * The configured root's datastructure route 404s for a dataflow only its
   * delegated root defines, and a 404 is never stored; the repeat call still
   * sends nothing, availability included.
   */
  it('serves a repeat call for a dataflow its delegated root defines with no request', async () => {
    const delegatedRoot = `${FAKE_BASE}/sti-public/rest`;
    const flowPath = '/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV?references=datastructure';
    const http = createFetchMock();
    http.route(
      {
        match: `${FAKE_BASE}${flowPath}`,
        respond: () =>
          cacheableJson({
            data: {
              dataStructures: [],
              dataflows: [
                {
                  agencyID: 'OECD.STI.PIE',
                  id: 'DSD_TIVA_MAINLV@DF_MAINLV',
                  isExternalReference: true,
                  links: [
                    {
                      rel: 'external',
                      href: `${delegatedRoot}/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV/1.2`,
                    },
                  ],
                },
              ],
            },
          }),
      },
      {
        match: `${FAKE_BASE}/datastructure/OECD.STI.PIE/DSD_TIVA_MAINLV`,
        respond: () => new Response('Could not find requested structures', { status: 404 }),
      },
      { match: `${delegatedRoot}${flowPath}`, respond: () => cacheableJson(DSD_RESPONSE) },
      {
        match: `${delegatedRoot}/codelist/OECD/CL_FREQ/1.0`,
        respond: () => cacheableJson(CODELIST_RESPONSE),
      },
      {
        match: `${delegatedRoot}/availableconstraint/OECD.STI.PIE,DSD_TIVA_MAINLV%40DF_MAINLV/all/all/all?mode=available`,
        respond: () => cacheableJson(ALL_SERIES),
      },
    );
    http.install();
    const input = {
      flow_ref: 'OECD.STI.PIE,DSD_TIVA_MAINLV@DF_MAINLV',
      dimension_id: 'FREQ',
      available_only: true,
    };

    try {
      const first = await runToolContract(oecdGetDimensionValues, input);
      const cold = http.calls.length;
      const second = await runToolContract(oecdGetDimensionValues, input);

      expect({ cold, warm: http.calls.length - cold }).toEqual({ cold: 5, warm: 0 });
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(first.structuredContent).toMatchObject({ available_only: true, code_count: 3 });
    } finally {
      http.restore();
    }
  });

  /**
   * A delegated dataflow whose datastructure the configured root holds as well,
   * as ten of them do: the datastructure resolves on the configured root, which
   * answers the availability read with a 500. The dataflow's reference already
   * names the root that serves its data, and the read goes there.
   */
  it('reads a delegated dataflow’s availability on its data root when the configured root holds its datastructure, and serves a repeat from the cache', async () => {
    const delegatedRoot = `${FAKE_BASE}/sti-public/rest`;
    const dataflow = `${FAKE_BASE}/dataflow/OECD.SDD.TPS/DSD_ITIC@DF_ITIC`;
    const reference = `${dataflow}?references=datastructure`;
    const datastructure = `${FAKE_BASE}/datastructure/OECD.SDD.TPS/DSD_ITIC`;
    const availabilityPath =
      '/availableconstraint/OECD.SDD.TPS,DSD_ITIC%40DF_ITIC/all/all/all?mode=available';
    const availability = `${delegatedRoot}${availabilityPath}`;
    /** The configured root's catalog entry for DF_ITIC: a pointer to the root that serves its data. */
    const pointer = () =>
      cacheableJson({
        data: {
          dataStructures: [],
          dataflows: [
            {
              agencyID: 'OECD.SDD.TPS',
              id: 'DSD_ITIC@DF_ITIC',
              isExternalReference: true,
              links: [
                {
                  rel: 'external',
                  href: `${delegatedRoot}/dataflow/OECD.SDD.TPS/DSD_ITIC@DF_ITIC/1.0`,
                },
              ],
            },
          ],
        },
      });
    const http = createFetchMock();
    http.route(
      { match: reference, respond: pointer },
      { match: datastructure, respond: () => cacheableJson(DSD_RESPONSE) },
      { match: CODELIST_URL, respond: () => cacheableJson(CODELIST_RESPONSE) },
      { match: availability, respond: () => cacheableJson(ALL_SERIES) },
      // What OECD answers on the configured root, which the read must not spend a request on.
      {
        match: `${FAKE_BASE}${availabilityPath}`,
        respond: () => new Response('Internal server error', { status: 500 }),
      },
      { match: dataflow, respond: pointer },
    );
    http.install();
    const input = {
      flow_ref: 'OECD.SDD.TPS,DSD_ITIC@DF_ITIC',
      dimension_id: 'FREQ',
      available_only: true,
    };

    try {
      const first = await runToolContract(oecdGetDimensionValues, input);
      const cold = http.calls.map((c) => c.request.url);
      const second = await runToolContract(oecdGetDimensionValues, input);
      const warm = http.calls.slice(cold.length);

      expect({ cold: cold.length, warm: warm.length }).toEqual({ cold: 4, warm: 0 });
      expect(cold).toEqual(
        expect.arrayContaining([reference, datastructure, CODELIST_URL, availability]),
      );
      expect(first.structuredContent).toMatchObject({
        available_only: true,
        codes: [
          { id: 'A', name: 'Annual' },
          { id: 'Q', name: 'Quarterly' },
          { id: 'W', name: 'W' },
        ],
        observation_count: 1234,
      });
      expect(first.structuredContent).not.toHaveProperty('notice');
      expect(second.structuredContent).toEqual(first.structuredContent);
    } finally {
      http.restore();
    }
  });

  it('points the time dimension at available_only rather than calling it missing', async () => {
    serve({});

    const error = await toolWireError(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'TIME_PERIOD',
    });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dimension_not_found' },
    });
    expect(error.message).toContain(
      `TIME_PERIOD is the time dimension of ${FLOW_REF} and has no codelist; pass available_only: true with any other dimension for its time_range`,
    );
  });

  describe('limit', () => {
    /** The `limit` property as `tools/list` advertises it. */
    const advertisedLimit = (): Record<string, unknown> =>
      z.toJSONSchema(oecdGetDimensionValues.input, { io: 'input' }).properties?.limit as Record<
        string,
        unknown
      >;

    it('advertises the default and the cap once, and no maximum', () => {
      const limit = advertisedLimit();

      expect(limit).toMatchObject({ type: 'integer', minimum: 1, default: 50 });
      expect(limit).not.toHaveProperty('maximum');
      expect(limit.description).toBe(
        'Maximum codes to return. Default 50; a larger value returns at most 10,000 and says so.',
      );
    });

    it('under OECD_CLAMP_LIMITS=false, advertises 10,000 as the maximum and rejects 10,001 before any request', async () => {
      getServerConfig().clampLimits = false;
      const http = serve({});

      const result = await runToolContract(oecdGetDimensionValues, {
        flow_ref: FLOW_REF,
        dimension_id: 'FREQ',
        limit: 10_001,
      });
      const accepted = await runToolContract(oecdGetDimensionValues, {
        flow_ref: FLOW_REF,
        dimension_id: 'FREQ',
        limit: 10_000,
      });

      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toMatch(/too big/i);
      expect(accepted.isError).toBeFalsy();
      expect(http.requests).toHaveLength(2);
      expect(advertisedLimit()).toMatchObject({
        maximum: 10_000,
        description: 'Maximum codes to return. Default 50, at most 10,000.',
      });
    });
  });
});

// ── Hierarchical codelists: codes[].parent and parent filter ──────────────────

/** Regional codelist spanning country → TL2 → TL3, plus non-French regions whose names contain "Fr". */
const REGIONAL_CODELIST_RESPONSE = {
  data: {
    codelists: [
      {
        codes: [
          { id: 'FRA', name: 'France' },
          { id: 'FR1', name: 'Île-de-France', parent: 'FRA' },
          { id: 'FRB', name: 'Centre — Val de Loire', parent: 'FRA' },
          { id: 'FRC', name: 'Bourgogne-Franche-Comté', parent: 'FRA' },
          { id: 'FR101', name: 'Paris', parent: 'FR1' },
          { id: 'FR102', name: 'Seine-et-Marne', parent: 'FR1' },
          { id: 'ITA', name: 'Italy' },
          { id: 'ITH', name: 'Friuli-Venezia Giulia', parent: 'ITA' },
          { id: 'NLD', name: 'Netherlands' },
          { id: 'NL1', name: 'Friesland', parent: 'NLD' },
        ],
      },
    ],
  },
};

/** Four-level tax-revenue hierarchy: _T → T_1000 → T_1100 → T_1110. */
const REVENUE_CODELIST_RESPONSE = {
  data: {
    codelists: [
      {
        codes: [
          { id: '_T', name: 'Total tax revenue' },
          { id: 'T_1000', name: 'Taxes on income, profits and capital gains', parent: '_T' },
          {
            id: 'T_1100',
            name: 'Taxes on income, profits and capital gains of individuals',
            parent: 'T_1000',
          },
          { id: 'T_1110', name: 'On income and profits of individuals', parent: 'T_1100' },
          { id: 'T_2000', name: 'Social security contributions', parent: '_T' },
        ],
      },
    ],
  },
};

describe('oecdGetDimensionValues hierarchy (parent)', () => {
  let fake: ScriptedFetch | undefined;

  function serveHierarchy(
    codelist: unknown = REGIONAL_CODELIST_RESPONSE,
    availability?: ScriptedAnswer,
  ): ScriptedFetch {
    fake = installScriptedFetch((url) => {
      if (url.includes('/availableconstraint/')) {
        if (!availability) throw new Error(`Unexpected availability request: ${url}`);
        return availability;
      }
      if (url.includes('/codelist/')) return json(codelist);
      return json(DSD_RESPONSE);
    });
    return fake;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
  });

  afterEach(() => {
    const installed = fake;
    fake = undefined;
    installed?.restore();
  });

  it('preserves codes[].parent for child codes, omits it for top-level codes, and renders a Parent column on mixed pages', async () => {
    serveHierarchy();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      limit: 3,
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 3,
      codes: [
        { id: 'FRA', name: 'France' },
        { id: 'FR1', name: 'Île-de-France', parent: 'FRA' },
        { id: 'FRB', name: 'Centre — Val de Loire', parent: 'FRA' },
      ],
    });
    const codes = (result.structuredContent as { codes: Array<Record<string, unknown>> }).codes;
    expect(codes[0]).not.toHaveProperty('parent');

    const text = textOf(result);
    expect(text).toContain('| Code | Name | Parent |');
    expect(text).toContain('| FRA | France | — |');
    expect(text).toContain('| FR1 | Île-de-France | FRA |');
    expect(text).toContain('| FRB | Centre — Val de Loire | FRA |');
  });

  it('keeps the two-column table on flat pages where no returned code has a parent', async () => {
    serveHierarchy(CODELIST_RESPONSE);

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
    });

    const text = textOf(result);
    expect(text).toContain('| Code | Name |');
    expect(text).not.toContain('| Parent |');
  });

  it('filters by exact parent across TL2 and TL3 levels and excludes non-French regions containing FR', async () => {
    serveHierarchy();

    const tl2 = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: 'FRA',
    });

    expect(tl2.structuredContent).toMatchObject({
      code_count: 3,
      codes: [
        { id: 'FR1', name: 'Île-de-France', parent: 'FRA' },
        { id: 'FRB', name: 'Centre — Val de Loire', parent: 'FRA' },
        { id: 'FRC', name: 'Bourgogne-Franche-Comté', parent: 'FRA' },
      ],
    });
    expect(tl2.structuredContent).not.toHaveProperty('notice');
    const tl2Text = textOf(tl2);
    expect(tl2Text).toContain('| Code | Name | Parent |');
    expect(tl2Text).toContain('| FR1 | Île-de-France | FRA |');
    expect(tl2Text).not.toContain('Friuli-Venezia Giulia');
    expect(tl2Text).not.toContain('Friesland');
    expect(tl2Text).not.toContain('Paris');

    const tl3 = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: 'FR1',
    });

    expect(tl3.structuredContent).toMatchObject({
      code_count: 2,
      codes: [
        { id: 'FR101', name: 'Paris', parent: 'FR1' },
        { id: 'FR102', name: 'Seine-et-Marne', parent: 'FR1' },
      ],
    });
  });

  it('walks a four-level hierarchy (_T → T_1000 → T_1100 → T_1110) via parent', async () => {
    serveHierarchy(REVENUE_CODELIST_RESPONSE);

    const level1 = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: '_T',
    });
    const level2 = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: 'T_1000',
    });
    const level3 = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: 'T_1100',
    });

    expect(level1.structuredContent).toMatchObject({
      code_count: 2,
      codes: [
        { id: 'T_1000', name: 'Taxes on income, profits and capital gains', parent: '_T' },
        { id: 'T_2000', name: 'Social security contributions', parent: '_T' },
      ],
    });
    expect(level2.structuredContent).toMatchObject({
      code_count: 1,
      codes: [
        {
          id: 'T_1100',
          name: 'Taxes on income, profits and capital gains of individuals',
          parent: 'T_1000',
        },
      ],
    });
    expect(level3.structuredContent).toMatchObject({
      code_count: 1,
      codes: [{ id: 'T_1110', name: 'On income and profits of individuals', parent: 'T_1100' }],
    });
  });

  it('applies available_only, then parent, then query, then offset and limit', async () => {
    serveHierarchy(
      REGIONAL_CODELIST_RESPONSE,
      json(
        availabilityOf({ FREQ: ['FRA', 'FR1', 'FRB', 'ITH'], MEASURE: ['B1GQ'] }, 99, {
          start: '2010-01-01',
          end: '2023-12-31',
        }),
      ),
    );

    // FRC is omitted by availability; ITH is omitted by parent; FRB is omitted by query.
    const narrowed = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
      parent: 'FRA',
      query: 'île',
    });

    expect(narrowed.structuredContent).toMatchObject({
      available_only: true,
      code_count: 1,
      codes: [{ id: 'FR1', name: 'Île-de-France', parent: 'FRA' }],
      effectiveQuery: 'île',
    });

    // Pagination reflects the 2 available children under FRA, not all 3 in the codelist.
    const page1 = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
      parent: 'FRA',
      limit: 1,
      offset: 0,
    });
    expect(page1.structuredContent).toMatchObject({
      code_count: 1,
      codes: [{ id: 'FR1', name: 'Île-de-France', parent: 'FRA' }],
      totalCount: 2,
      notice:
        'Showing codes 1–1 of 2. Advance offset to 1 for the next page, or pass query to narrow by code or label.',
    });

    const pastEnd = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
      parent: 'FRA',
      offset: 5,
    });
    expect(pastEnd.structuredContent).toMatchObject({
      code_count: 0,
      codes: [],
      totalCount: 2,
      notice: 'Offset 5 is past the 2 matching codes — lower offset to page back into the list.',
    });
  });

  it.each(['', '   '])('treats blank or whitespace parent %j as unset', async (blankParent) => {
    serveHierarchy();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: blankParent,
    });

    expect(result.structuredContent).toMatchObject({ code_count: 10 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('names the exact-case parent code in notice when parent differs only by letter case', async () => {
    serveHierarchy();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: 'fra',
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      codes: [],
      notice: expect.stringContaining('FRA'),
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('"fra"');
    expect(notice).toContain('"FRA"');
    expect(renderedOf(result)).toContain(notice);
  });

  it('emits an actionable miss notice when parent matches no codes and escapes Markdown in content[]', async () => {
    serveHierarchy();
    const rawParent = '*NOPE* [x](y)';

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: rawParent,
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      codes: [],
      notice: expect.stringContaining(`"${rawParent}"`),
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('Omit parent');
    expect(notice).not.toContain('no fixed codelist');
    expect(renderedOf(result)).toContain(notice);
  });

  it('reports the post-parent count when parent matches codes but query matches none', async () => {
    serveHierarchy();

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      parent: 'FRA',
      query: 'zzz-nothing',
    });

    expect(result.structuredContent).toMatchObject({
      code_count: 0,
      codes: [],
      effectiveQuery: 'zzz-nothing',
      notice: expect.stringContaining('3'),
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('FRA');
    expect(notice).toContain('zzz-nothing');
    expect(notice).not.toContain('10');
  });

  it('does not add a parent miss notice when available_only already returned zero codes', async () => {
    serveHierarchy(REGIONAL_CODELIST_RESPONSE, json(availabilityOf({}, 0)));

    const result = await runToolContract(oecdGetDimensionValues, {
      flow_ref: FLOW_REF,
      dimension_id: 'FREQ',
      available_only: true,
      parent: 'FRA',
    });

    expect(result.structuredContent).toMatchObject({
      available_only: true,
      code_count: 0,
      codes: [],
      notice: 'OECD records no observations for this dataflow.',
    });
  });
});
