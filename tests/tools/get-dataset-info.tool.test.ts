/**
 * @fileoverview Tests for oecd_get_dataset_info tool.
 * @module tests/tools/get-dataset-info.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { oecdGetDatasetInfo } from '@/mcp-server/tools/definitions/get-dataset-info.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import { declaredRecovery, toolWireError, toolWireFailure } from '../helpers/error-contract.js';
import { cacheableJson, noResultsFound } from '../helpers/oecd-response.js';
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
    respondWith(Response.json(DSD_RESPONSE));
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
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: 'BAD_FORMAT' });
    await expect(toolWireError(oecdGetDatasetInfo, input)).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_flow_ref',
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'invalid_flow_ref') },
      },
    });
  });

  it('names a throttled structure read rate_limited with a wait-it-out hint', async () => {
    // OECD charges one throttle budget across the data and structure endpoints,
    // so a refused structure read is an ordinary outcome — and the hint matters
    // most here, since withRetry has already spent its attempts and its backoff
    // by the time the refusal surfaces.
    respondWith(
      new Response(
        'You have exceeded the number of requests currently permitted in the OECD Data API.',
        { status: 429, headers: { 'retry-after': '99999' } },
      ),
    );
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    await expect(toolWireError(oecdGetDatasetInfo, input)).resolves.toMatchObject({
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
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    await expect(toolWireError(oecdGetDatasetInfo, input)).resolves.toMatchObject({
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
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    await expect(toolWireError(oecdGetDatasetInfo, input)).resolves.toMatchObject({
      data: {
        reason: 'upstream_error',
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'upstream_error') },
      },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when DSD response is empty', async () => {
    respondWith(Response.json({ data: { dataStructures: [] } }));
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
    // A dataflow entry with no datastructure beside it and no external
    // reference to follow resolves nowhere, which the service reports as a
    // NotFound the tool maps to its contract entry.
    respondWith(
      Response.json({ data: { dataflows: [{ agencyID: 'OECD.SDD.NAD', id: 'DSD_X@DF_X' }] } }),
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
      source: 'OECD' as const,
    };
    const blocks = oecdGetDatasetInfo.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FREQ');
    expect(text).toContain('REF_AREA');
    expect(text).toContain('TIME_PERIOD');
    expect(text).toContain('Source: OECD');
  });

  it('returns name, full description with links, and resources on both surfaces with zero extra requests', async () => {
    const http = createFetchMock();
    http.install();
    try {
      const flowRef = 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I';
      const refUrl = `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I?references=datastructure`;
      http.route({
        match: refUrl,
        respond: () =>
          Response.json({
            data: {
              dataflows: [
                {
                  agencyID: 'OECD.SDD.NAD',
                  id: 'DSD_NAAG@DF_NAAG_I',
                  name: 'National Accounts *at a Glance*',
                  description:
                    '<p>Quarterly GDP growth (*real* &amp; _adjusted_ &lt;5%). See ' +
                    '<a href="https://webfs-sdd.oecd.org/files/QNA Guide (2026).pdf">QNA [User] Guide</a> ' +
                    'or <a href="mailto: STAT.Contact@oecd.org">STAT.Contact@oecd.org</a>.</p>',
                  annotations: [
                    {
                      type: 'EXT_RESOURCE',
                      text: 'Bulk *ZIP*|https://webfs-sti.oecd.org/EXGR.zip',
                    },
                    {
                      type: 'EXT_RESOURCE',
                      text: 'Excel File|https://webfs-ctp.oecd.org/itid.xlsx|https://upload.wikimedia.org/icon.svg',
                    },
                  ],
                },
              ],
              dataStructures: DSD_RESPONSE.data.dataStructures,
            },
          }),
      });
      initStructureService();

      const result = await runToolContract(oecdGetDatasetInfo, { flow_ref: flowRef });

      expect(result.isError).toBeFalsy();
      expect(http.calls.map((c) => c.request.url)).toEqual([refUrl]);
      expect(result.structuredContent).toMatchObject({
        flow_ref: flowRef,
        name: 'National Accounts *at a Glance*',
        description:
          'Quarterly GDP growth (*real* & _adjusted_ <5%). See ' +
          '[QNA \\[User\\] Guide](https://webfs-sdd.oecd.org/files/QNA%20Guide%20%282026%29.pdf) ' +
          'or [STAT.Contact@oecd.org](mailto:STAT.Contact@oecd.org).',
        resources: [
          { label: 'Bulk *ZIP*', url: 'https://webfs-sti.oecd.org/EXGR.zip' },
          { label: 'Excel File', url: 'https://webfs-ctp.oecd.org/itid.xlsx' },
        ],
      });

      const md = new MarkdownIt({ html: true });
      const text = (result.content[0] as { text: string }).text;
      const tokens = md.parse(text, {});
      const inlineChildren = tokens.flatMap((t) => t.children ?? []);
      const links = inlineChildren
        .map((t, i) =>
          t.type === 'link_open'
            ? { href: t.attrGet('href'), label: inlineChildren[i + 1]?.content }
            : null,
        )
        .filter((x) => x !== null);

      expect(links).toEqual([
        {
          href: 'https://webfs-sdd.oecd.org/files/QNA%20Guide%20%282026%29.pdf',
          label: 'QNA [User] Guide',
        },
        {
          href: 'mailto:STAT.Contact@oecd.org',
          label: 'STAT.Contact@oecd.org',
        },
        {
          href: 'https://webfs-sti.oecd.org/EXGR.zip',
          label: 'Bulk *ZIP*',
        },
        {
          href: 'https://webfs-ctp.oecd.org/itid.xlsx',
          label: 'Excel File',
        },
      ]);
      // Plain text punctuation in name, description, and resource labels must not turn into emphasis or raw HTML.
      expect(inlineChildren.some((t) => t.type === 'em_open')).toBe(false);
      expect(inlineChildren.some((t) => t.type === 'html_inline')).toBe(false);
      const renderedText = inlineChildren
        .map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : ''))
        .join('');
      expect(renderedText).toContain('National Accounts *at a Glance*');
      expect(renderedText).toContain('Quarterly GDP growth (*real* & _adjusted_ <5%).');
    } finally {
      http.restore();
    }
  });

  it('omits name, description, and resources when the upstream payload carries none', async () => {
    const result = await runToolContract(oecdGetDatasetInfo, {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('name');
    expect(result.structuredContent).not.toHaveProperty('description');
    expect(result.structuredContent).not.toHaveProperty('resources');
  });

  it('prevents accidental images and unsafe links when formatting descriptions with Markdown syntax', () => {
    const blocks = oecdGetDatasetInfo.format!({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      description:
        'Alert![Guide](https://oecd.org/g) and [bad](javascript:alert(1)) and [outer [inner](https://oecd.org/i)',
      dimensions: [{ id: 'FREQ', name: 'Frequency', position: 1 }],
      key_example: '.',
      source: 'OECD',
    });
    const md = new MarkdownIt({ html: true });
    const text = (blocks[0] as { text: string }).text;
    const tokens = md.parse(text, {}).flatMap((t) => t.children ?? []);

    expect(tokens.some((t) => t.type === 'image')).toBe(false);
    const hrefs = tokens.filter((t) => t.type === 'link_open').map((t) => t.attrGet('href'));
    expect(hrefs).toEqual(['https://oecd.org/g', 'https://oecd.org/i']);
  });

  it('round-trips escaped backslashes and brackets in description link labels through CommonMark', () => {
    const blocks = oecdGetDatasetInfo.format!({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      description:
        'See [foo\\\\](https://oecd.org/bs) and [foo\\\\\\[bar\\]](https://oecd.org/bs2).',
      dimensions: [{ id: 'FREQ', name: 'Frequency', position: 1 }],
      key_example: '.',
      source: 'OECD',
    });
    const md = new MarkdownIt({ html: true });
    const text = (blocks[0] as { text: string }).text;
    const inlineChildren = md.parse(text, {}).flatMap((t) => t.children ?? []);
    const links: Array<{ href: string | number | null; label: string }> = [];
    for (let idx = 0; idx < inlineChildren.length; idx++) {
      if (inlineChildren[idx]?.type === 'link_open') {
        const href = inlineChildren[idx]!.attrGet('href');
        const labelParts: string[] = [];
        for (let j = idx + 1; j < inlineChildren.length; j++) {
          if (inlineChildren[j]?.type === 'link_close') break;
          if (inlineChildren[j]?.type === 'text') labelParts.push(inlineChildren[j]!.content);
        }
        links.push({ href, label: labelParts.join('') });
      }
    }

    expect(links).toEqual([
      { href: 'https://oecd.org/bs', label: 'foo\\' },
      { href: 'https://oecd.org/bs2', label: 'foo\\[bar]' },
    ]);
  });

  describe('description formatter linear-time scaling', () => {
    const BASE_CHARS = 5_000;
    const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    const TRIALS = 5;
    const CHARS_PER_MEASUREMENT = 640_000;
    const CPU_CEILING_US = 200_000;

    function formatDesc(description: string): string {
      const blocks = oecdGetDatasetInfo.format!({
        flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
        description,
        dimensions: [{ id: 'FREQ', name: 'Frequency', position: 1 }],
        key_example: '.',
        source: 'OECD',
      });
      return (blocks[0] as { text: string }).text;
    }

    function cpuPerCallUs(description: string, expectedFragment: string): number {
      const calls = Math.max(1, Math.round(CHARS_PER_MEASUREMENT / description.length));
      let last = '';
      const start = process.threadCpuUsage();
      for (let i = 0; i < calls; i++) last = formatDesc(description);
      const { user, system } = process.threadCpuUsage(start);
      expect(last).toContain(expectedFragment);
      return (user + system) / calls;
    }

    function expectLinear(build: (n: number) => { input: string; expectedFragment: string }): void {
      const base = build(BASE_CHARS);
      for (const size of SIZES) {
        const sample = build(size);
        let leastGrowth = Number.POSITIVE_INFINITY;
        let leastCpu = Number.POSITIVE_INFINITY;
        for (let trial = 0; trial < TRIALS; trial++) {
          const baseline = cpuPerCallUs(base.input, base.expectedFragment);
          const cpu = cpuPerCallUs(sample.input, sample.expectedFragment);
          leastGrowth = Math.min(leastGrowth, cpu / baseline);
          leastCpu = Math.min(leastCpu, cpu);
        }
        expect(leastGrowth, `growth at ${size} characters`).toBeLessThan(4 * (size / BASE_CHARS));
        expect(leastCpu, `CPU per call at ${size} characters`).toBeLessThan(CPU_CEILING_US);
      }
    }

    it.each<[string, (n: number) => { input: string; expectedFragment: string }]>([
      [
        'nested unclosed [ openers',
        (n) => ({
          input: `${'[a'.repeat(Math.floor(n / 2))}[ok](https://oecd.org)`,
          expectedFragment: '[ok](https://oecd.org)',
        }),
      ],
      [
        'repeated unclosed [label]( openers',
        (n) => {
          const unit = '[x](https://oecd.org/';
          return {
            input: `${unit.repeat(Math.floor(n / unit.length))}tail`,
            expectedFragment: 'tail',
          };
        },
      ],
      [
        'one long line ending in a break',
        (n) => ({ input: `${'a b '.repeat(Math.floor(n / 4))}\nz`, expectedFragment: '\\\nz' }),
      ],
      [
        'breaks throughout',
        (n) => ({ input: `${'  \r\n'.repeat(Math.floor(n / 4))}ok`, expectedFragment: 'ok' }),
      ],
    ])('scales linearly on %s', (_shape, build) => expectLinear(build), 0);
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
const MISTYPED_DATAFLOW_URL = `${FAKE_BASE}/dataflow/OECD.SDD.TPS/DSD_LFS@DF_IALFS_UNE_MM?references=datastructure`;

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
    // The dataflow's own reference answers, so the prefix route is never asked.
    expect(http.calls.map((c) => c.request.url)).toEqual([MISMATCHED_DATAFLOW_URL]);
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

  it('reports a dataflow OECD does not publish as not-found after one request, though its datastructure exists', async () => {
    // The real flow is DF_IALFS_UNE_M. Its datastructure route answers for any
    // dataflow id paired with DSD_LFS, so only the dataflow route can say no.
    http.route(
      {
        match: `${FAKE_BASE}/datastructure/OECD.SDD.TPS/DSD_LFS`,
        respond: () => cacheableJson(DSD_RESPONSE),
      },
      { match: MISTYPED_DATAFLOW_URL, respond: () => noResultsFound() },
    );

    const { error, text } = await toolWireFailure(oecdGetDatasetInfo, {
      flow_ref: 'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_MM',
    });

    expect(http.calls.map((c) => c.request.url)).toEqual([MISTYPED_DATAFLOW_URL]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'dataflow_not_found',
        recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'dataflow_not_found') },
      },
    });
    expect(error.message).toContain('OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_MM');
    expect(text).toContain('(reason dataflow_not_found');
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

const NAMAIN_FLOW_REF = 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD';
/** The dataflow's own route, which answers with the datastructure revision it references. */
const REFERENCE_URL = `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD?references=datastructure`;
/** The fixture URNs reference `CS_NA(1.0)`, and that version is what gets addressed. */
const SCHEME_URL = `${FAKE_BASE}/conceptscheme/OECD.SDD.NAD/CS_NA/1.0`;

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
      { match: REFERENCE_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: NAMAIN_FLOW_REF });
    const result = await oecdGetDatasetInfo.handler(input, ctx);

    // One structure request and the concept scheme; the datastructure route is never asked.
    expect(http.calls.map((c) => c.request.url)).toEqual([REFERENCE_URL, SCHEME_URL]);
    expect(result.dimensions[0]).toMatchObject({
      id: 'INSTR_ASSET',
      name: 'Financial instruments and non-financial assets',
    });
    expect(result.dimensions[1]).toMatchObject({ id: 'ADJUSTMENT', name: 'Adjustment' });

    const text = (oecdGetDatasetInfo.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Financial instruments and non-financial assets');
  });

  it.each([true, false])(
    'identifies the edition even if the list fails (list succeeds: %s)',
    async (listOK) => {
      const response = {
        data: {
          dataStructures: NAMELESS_DSD_RESPONSE.data.dataStructures,
          dataflows: [
            {
              agencyID: 'OECD.SDD.NAD',
              id: 'DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD',
              version: '1.1',
            },
          ],
        },
      };
      http.route(
        { match: REFERENCE_URL.replace('?', '/1.1?'), respond: () => Response.json(response) },
        { match: REFERENCE_URL, respond: () => Response.json(response) },
        { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
        {
          match: REFERENCE_URL.replace(/\?.*$/, '/all'),
          respond: () =>
            listOK
              ? Response.json({
                  data: {
                    dataflows: [
                      { ...response.data.dataflows[0], version: '1.0' },
                      response.data.dataflows[0],
                    ],
                  },
                })
              : new Response('Forbidden', { status: 403 }),
        },
      );

      const result = await runToolContract(oecdGetDatasetInfo, {
        flow_ref: NAMAIN_FLOW_REF,
        ...(listOK ? { version: '1.1' } : {}),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ version: '1.1' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Edition: 1.1') });
      if (listOK) {
        expect(result.structuredContent).toMatchObject({ published_versions: ['1.0', '1.1'] });
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining('Published editions: 1.0, 1.1'),
        });
      } else {
        expect(result.structuredContent).not.toHaveProperty('published_versions');
      }
    },
  );

  it('answers with ids rather than failing when the concept scheme is down', async () => {
    http.route(
      { match: REFERENCE_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: () => new Response('Forbidden', { status: 403 }) },
    );

    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: NAMAIN_FLOW_REF });
    const result = await oecdGetDatasetInfo.handler(input, ctx);

    expect(result.dimensions.map((d) => d.name)).toEqual(['INSTR_ASSET', 'ADJUSTMENT']);
    expect(result).toMatchObject({ concept_lookup_failed_for: ['INSTR_ASSET', 'ADJUSTMENT'] });
    expect(oecdGetDatasetInfo.format!(result)[0]).toMatchObject({
      text: expect.stringContaining('Concept-name lookup failed for INSTR_ASSET, ADJUSTMENT.'),
    });
  });

  it('reports the published alternatives when an explicit edition does not exist', async () => {
    const flow = { agencyID: 'OECD.SDD.NAD', id: 'DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD' };
    http.route(
      { match: REFERENCE_URL.replace('?', '/999.999?'), respond: noResultsFound },
      { match: REFERENCE_URL, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      {
        match: REFERENCE_URL.replace(/\?.*$/, '/all'),
        respond: () =>
          Response.json({
            data: {
              dataflows: [
                { ...flow, version: '1.0' },
                { ...flow, version: '1.1' },
              ],
            },
          }),
      },
    );
    const { error, text } = await toolWireFailure(oecdGetDatasetInfo, {
      flow_ref: NAMAIN_FLOW_REF,
      version: '999.999',
    });
    expect(error.data).toMatchObject({
      reason: 'dataflow_not_found',
      recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'dataflow_not_found') },
    });
    expect(error.message).toContain('edition 999.999. Published editions: 1.0, 1.1.');
    expect(text).toContain('Published editions: 1.0, 1.1.');
  });

  it('reports a missing pinned concept scheme without using its latest revision', async () => {
    const reference = REFERENCE_URL.replace('?', '/1.1?');
    http.route(
      { match: reference, respond: () => Response.json(NAMELESS_DSD_RESPONSE) },
      { match: SCHEME_URL, respond: noResultsFound },
      {
        match: SCHEME_URL.replace(/\/1\.0$/, ''),
        respond: () => Response.json(CONCEPT_SCHEME_RESPONSE),
      },
      { match: REFERENCE_URL.replace(/\?.*$/, '/all'), respond: noResultsFound },
    );
    const result = await runToolContract(oecdGetDatasetInfo, {
      flow_ref: NAMAIN_FLOW_REF,
      version: '1.1',
    });
    expect(result.structuredContent).toMatchObject({
      version: '1.1',
      concept_lookup_failed_for: ['INSTR_ASSET', 'ADJUSTMENT'],
      dimensions: [{ name: 'INSTR_ASSET' }, { name: 'ADJUSTMENT' }],
    });
    expect(http.calls.map((call) => call.request.url)).not.toContain(
      SCHEME_URL.replace(/\/1\.0$/, ''),
    );
  });

  it('marks only the failed scheme’s time dimension while retaining other resolved labels', async () => {
    const response = structuredClone(NAMELESS_DSD_RESPONSE);
    Object.assign(
      response.data.dataStructures[0]!.dataStructureComponents.dimensionList.timeDimensions[0]!,
      {
        conceptIdentity:
          'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=OECD.SDD.NAD:CS_TIME(1.0).TIME_PERIOD',
      },
    );
    http.route(
      { match: REFERENCE_URL, respond: () => Response.json(response) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
      {
        match: `${FAKE_BASE}/conceptscheme/OECD.SDD.NAD/CS_TIME/1.0`,
        respond: () => Response.json({}),
      },
    );

    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const result = await oecdGetDatasetInfo.handler({ flow_ref: NAMAIN_FLOW_REF }, ctx);
    expect(result).toMatchObject({
      concept_lookup_failed_for: ['TIME_PERIOD'],
      dimensions: [
        { id: 'INSTR_ASSET', name: 'Financial instruments and non-financial assets', position: 1 },
        { id: 'ADJUSTMENT', name: 'Adjustment', position: 2 },
      ],
      time_dimension: { id: 'TIME_PERIOD', name: 'TIME_PERIOD' },
    });
    expect(oecdGetDatasetInfo.format!(result)[0]).toMatchObject({
      text: expect.stringContaining('Concept-name lookup failed for TIME_PERIOD.'),
    });
  });
});

// ── The dataflow reference ────────────────────────────────────────────────────

/**
 * What the dataflow route answers: the dataflow entry, carrying the
 * `NonProductionDataflow` annotation OECD puts on every catalogued flow, beside
 * the datastructure revision it references.
 */
const REFERENCE_RESPONSE = {
  data: {
    dataflows: [
      {
        agencyID: 'OECD.SDD.NAD',
        id: 'DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD',
        annotations: [{ type: 'NonProductionDataflow', text: 'true' }],
      },
    ],
    dataStructures: NAMELESS_DSD_RESPONSE.data.dataStructures,
  },
};

describe('oecdGetDatasetInfo dataflow reference', () => {
  const http = createFetchMock();

  beforeEach(() => {
    http.reset();
    http.install();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    // A fresh service holds an empty cache, so no earlier test's structure is served here.
    initStructureService();
  });

  afterEach(() => {
    http.restore();
  });

  it('reports no non_production status on either surface, since OECD annotates every flow alike', async () => {
    http.route(
      { match: REFERENCE_URL, respond: () => Response.json(REFERENCE_RESPONSE) },
      { match: SCHEME_URL, respond: () => Response.json(CONCEPT_SCHEME_RESPONSE) },
    );

    const result = await runToolContract(oecdGetDatasetInfo, { flow_ref: NAMAIN_FLOW_REF });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ flow_ref: NAMAIN_FLOW_REF });
    expect(result.structuredContent).not.toHaveProperty('non_production');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Financial instruments and non-financial assets');
    expect(text).not.toContain('non_production');
    expect(JSON.stringify(z.toJSONSchema(oecdGetDatasetInfo.output))).not.toContain(
      'non_production',
    );
  });

  it('answers a repeat call inside max-age without a request', async () => {
    http.route(
      { match: REFERENCE_URL, respond: () => cacheableJson(REFERENCE_RESPONSE) },
      { match: SCHEME_URL, respond: () => cacheableJson(CONCEPT_SCHEME_RESPONSE) },
    );

    const first = await runToolContract(oecdGetDatasetInfo, { flow_ref: NAMAIN_FLOW_REF });
    expect(http.calls.map((c) => c.request.url)).toEqual([REFERENCE_URL, SCHEME_URL]);

    const repeat = await runToolContract(oecdGetDatasetInfo, { flow_ref: NAMAIN_FLOW_REF });

    expect(http.calls).toHaveLength(2);
    expect(repeat.isError).toBeFalsy();
    expect(repeat.structuredContent).toEqual(first.structuredContent);
    expect(repeat.content).toEqual(first.content);
    // The names came from the stored concept scheme, not from the ids.
    expect(repeat.structuredContent).toMatchObject({
      dimensions: [
        { name: 'Financial instruments and non-financial assets' },
        { name: 'Adjustment' },
      ],
    });
  });

  /**
   * A dataflow the configured root catalogues as a pointer and only the root it
   * points to defines. The configured root's datastructure route 404s, and a 404
   * is never stored; the repeat call still sends nothing.
   */
  it('answers a repeat call for a dataflow its delegated root defines without a request', async () => {
    const delegatedRoot = `${FAKE_BASE}/sti-public/rest`;
    const flowRef = 'OECD.STI.PIE,DSD_TIVA_MAINLV@DF_MAINLV';
    const flowPath = '/dataflow/OECD.STI.PIE/DSD_TIVA_MAINLV@DF_MAINLV?references=datastructure';
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
      { match: `${delegatedRoot}${flowPath}`, respond: () => cacheableJson(NAMELESS_DSD_RESPONSE) },
      {
        match: `${delegatedRoot}/conceptscheme/OECD.SDD.NAD/CS_NA/1.0`,
        respond: () => cacheableJson(CONCEPT_SCHEME_RESPONSE),
      },
    );

    const first = await runToolContract(oecdGetDatasetInfo, { flow_ref: flowRef });
    const cold = http.calls.length;
    const repeat = await runToolContract(oecdGetDatasetInfo, { flow_ref: flowRef });

    expect({ cold, warm: http.calls.length - cold }).toEqual({ cold: 4, warm: 0 });
    expect(repeat.isError).toBeFalsy();
    expect(repeat.structuredContent).toEqual(first.structuredContent);
    expect(repeat.content).toEqual(first.content);
    expect(repeat.structuredContent).toMatchObject({
      dimensions: [{ name: 'Financial instruments and non-financial assets' }, {}],
    });
  });
});

// ── Upstream failure wiring ───────────────────────────────────────────────────

/**
 * How each upstream failure reaches this tool's caller. The mechanisms — the
 * reason mapping and the call's budget — are tabled at the HTTP boundary; these
 * prove the tool is wired to them, one case per side of each branch.
 */
describe('oecdGetDatasetInfo upstream failure wiring', () => {
  const input = { flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I' };
  let configured: { baseUrl: string; timeoutMs: number };
  let fake: ScriptedFetch | undefined;

  function serve(datastructure: ScriptedAnswer): ScriptedFetch {
    fake = installScriptedFetch(() => datastructure);
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
    const hint = declaredRecovery(oecdGetDatasetInfo, 'upstream_unreadable');

    const { error, text } = await toolWireFailure(oecdGetDatasetInfo, input);

    expect(http.requests.map((r) => r.url)).toEqual([
      `${FAKE_BASE}/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I?references=datastructure`,
    ]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable', recovery: { hint }, retryable: false },
    });
    expect(error.message).toContain('not JSON (declared content type: text/html)');
    expect(text).toContain(hint);
  });

  it('names a datastructure 422 upstream_error, carrying the status and OECD’s text', async () => {
    serve({ body: 'Semantic error in the structure query', kind: 'answer', status: 422 });

    const error = await toolWireError(oecdGetDatasetInfo, input);

    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'upstream_error') },
    });
    expect(error.message).toContain(
      'OECD answered HTTP 422: Semantic error in the structure query',
    );
  });

  it('ends a stalled datastructure read as upstream_timeout when the call’s budget runs out', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(STALL);

    const call = observe(toolWireError(oecdGetDatasetInfo, input));
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
          recovery: { hint: declaredRecovery(oecdGetDatasetInfo, 'upstream_timeout') },
        },
      },
    });
  });

  it('lets a failure with no OECD answer behind it through as itself', async () => {
    getServerConfig().baseUrl = 'ftp://fake.oecd.test';
    initStructureService();
    const http = serve(json(DSD_RESPONSE));

    const error = await toolWireError(oecdGetDatasetInfo, input);

    expect(http.requests).toHaveLength(0);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_url' },
    });
  });
});
