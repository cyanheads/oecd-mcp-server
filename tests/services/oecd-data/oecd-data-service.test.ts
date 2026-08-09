/**
 * @fileoverview Tests for OecdDataService — SDMX-JSON decoding (dimensions,
 * observation attributes, unit scaling) and the upstream HTTP boundary
 * (retries, throttling, aborts, caller-fixable rejections).
 * @module tests/services/oecd-data/oecd-data-service.test
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  invalidQueryText,
  OecdDataService,
  throttleText,
} from '@/services/oecd-data/oecd-data-service.js';

const BASE = 'https://fake.oecd.test';
const FLOW_REF = 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I';
const DATA_URL = `${BASE}/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/A.USA..?dimensionAtObservation=AllDimensions`;

/**
 * Mirrors the live shape of `DSD_NAAG@DF_NAAG_I`: observation arrays are
 * `[obsValue, attrIdx0, …]`, `MATURITY` is declared but never populated
 * (`values: []`), `REF_YEAR_PRICE` is uncoded (`{ value }` instead of
 * `{ id, name }`) and null on most observations, and `UNIT_MULT` varies row to
 * row within the same result.
 */
const DATA_RESPONSE = {
  data: {
    dataSets: [
      {
        observations: {
          '0:0:0': [26054.614, 0, null, null, 1],
          '0:0:1': [77926.1671900703, 0, null, 0, 0],
          '0:0:2': [1.5, 0, 0, null, null],
        },
      },
    ],
    structures: [
      {
        dimensions: {
          observation: [
            { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
            { id: 'REF_AREA', values: [{ id: 'USA', name: 'United States' }] },
            {
              id: 'TIME_PERIOD',
              values: [
                { id: '2022', name: '2022' },
                { id: '2021', name: '2021' },
                { id: '2020', name: '2020' },
              ],
            },
          ],
        },
        attributes: {
          observation: [
            { id: 'OBS_STATUS', values: [{ id: 'A', name: 'Normal value' }] },
            { id: 'MATURITY', values: [] },
            { id: 'REF_YEAR_PRICE', values: [{ value: '2020' }] },
            {
              id: 'UNIT_MULT',
              values: [
                { id: '0', name: 'Units' },
                { id: '9', name: 'Billions' },
              ],
            },
          ],
        },
      },
    ],
  },
};

/**
 * Mirrors the three DSDs that bind UNIT_MULT to an OECD-local codelist rather
 * than `SDMX,CL_UNIT_MULT`: the range runs to -15 as well as 15, and `9999`
 * is a sentinel for "." rather than a power of ten. A fourth code stands in
 * for an id that is not a number at all.
 */
const LOCAL_UNIT_MULT_RESPONSE = {
  data: {
    dataSets: [
      {
        observations: {
          '0:0:0': [1.5, 0],
          '0:0:1': [1.5, 1],
          '0:0:2': [1.5, 2],
          '0:0:3': [1.5, 3],
          '0:0:4': [16868402.705, 4],
        },
      },
    ],
    structures: [
      {
        dimensions: {
          observation: [
            { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
            { id: 'REF_AREA', values: [{ id: 'USA', name: 'United States' }] },
            {
              id: 'TIME_PERIOD',
              values: [
                { id: '2019', name: '2019' },
                { id: '2020', name: '2020' },
                { id: '2021', name: '2021' },
                { id: '2022', name: '2022' },
                { id: '2023', name: '2023' },
              ],
            },
          ],
        },
        attributes: {
          observation: [
            {
              id: 'UNIT_MULT',
              values: [
                { id: '9999', name: '.' },
                { id: '-3', name: 'Thousandths' },
                { id: '15', name: 'Quadrillions' },
                { id: 'NOT_A_NUMBER', name: 'Unmapped' },
                { id: '6', name: 'Millions' },
              ],
            },
          ],
        },
      },
    ],
  },
};

const http = createFetchMock();

beforeEach(() => {
  http.reset();
  http.install();
});

afterEach(() => {
  http.restore();
});

function service(): OecdDataService {
  return new OecdDataService(BASE);
}

function respondOnce(body: BodyInit, init?: ResponseInit): void {
  http.route({ match: DATA_URL, respond: () => new Response(body, init) });
}

// ── Decoding ──────────────────────────────────────────────────────────────────

describe('OecdDataService.fetchData — decoding', () => {
  it('scales an observation carrying UNIT_MULT = Billions', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(FLOW_REF, 'A.USA..');
    const gdp = result.rows[0];

    // 26054.614 billion = USD 26.05 trillion.
    expect(gdp?.value).toBe(26_054_614_000_000);
    expect(gdp?.value_scale).toBe(1_000_000_000);
    expect(gdp?.UNIT_MULT).toBe('Billions');
    expect(gdp?.OBS_STATUS).toBe('Normal value');
  });

  it('leaves an unscaled observation at its published magnitude', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const perCapita = (await service().fetchData(FLOW_REF, 'A.USA..')).rows[1];

    expect(perCapita?.value).toBe(77926.1671900703);
    expect(perCapita?.value_scale).toBe(1);
    expect(perCapita?.UNIT_MULT).toBe('Units');
  });

  it('decodes a null attribute index and an empty values array without throwing', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(FLOW_REF, 'A.USA..');

    // REF_YEAR_PRICE is null on the first observation despite declaring values.
    expect(result.rows[0]).not.toHaveProperty('REF_YEAR_PRICE');
    // MATURITY declares no values, so its index can never resolve to a label.
    expect(result.rows[2]).not.toHaveProperty('MATURITY');
    expect(result.rows[2]?.value).toBe(1.5);
    expect(result.rows[2]?.value_scale).toBe(1);
  });

  it('labels an uncoded attribute from its bare value', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(FLOW_REF, 'A.USA..');

    expect(result.rows[1]?.REF_YEAR_PRICE).toBe('2020');
  });

  it('leaves the observation unscaled when UNIT_MULT is not a power of ten', async () => {
    respondOnce(JSON.stringify(LOCAL_UNIT_MULT_RESPONSE));

    const rows = (await service().fetchData(FLOW_REF, 'A.USA..')).rows;

    // `9999` means "." — scaling by it produces Infinity, which JSON nulls out.
    expect(rows[0]?.value).toBe(1.5);
    expect(rows[0]?.value_scale).toBe(1);
    expect(rows[0]?.UNIT_MULT).toBe('.');
    // A code id that is not a number at all falls back the same way.
    expect(rows[3]?.value).toBe(1.5);
    expect(rows[3]?.value_scale).toBe(1);
    expect(rows[3]?.UNIT_MULT).toBe('Unmapped');
  });

  it('scales down on a negative UNIT_MULT and up at the top of the codelist', async () => {
    respondOnce(JSON.stringify(LOCAL_UNIT_MULT_RESPONSE));

    const rows = (await service().fetchData(FLOW_REF, 'A.USA..')).rows;

    expect(rows[1]?.value).toBe(0.0015);
    expect(rows[1]?.value_scale).toBe(0.001);
    expect(rows[2]?.value).toBe(1.5e15);
    expect(rows[2]?.value_scale).toBe(1e15);
  });

  it('shifts the decimal exponent rather than multiplying by a float power', async () => {
    respondOnce(JSON.stringify(LOCAL_UNIT_MULT_RESPONSE));

    const scaled = (await service().fetchData(FLOW_REF, 'A.USA..')).rows[4];

    // 16868402.705 * 1e6 lands on 16868402704999.998.
    expect(scaled?.value).toBe(16_868_402_705_000);
    expect(16_868_402.705 * 1e6).not.toBe(16_868_402_705_000);
    expect((scaled?.value as number) / (scaled?.value_scale as number)).toBe(16_868_402.705);
  });

  it('keeps dimension labels alongside the attribute columns', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(FLOW_REF, 'A.USA..');

    expect(result.rows[0]).toMatchObject({
      FREQ: 'Annual',
      REF_AREA: 'United States',
      TIME_PERIOD: '2022',
      source: 'OECD',
    });
    expect(result.rowCount).toBe(3);
  });

  it('declares every resolvable component as a column, sparse ones included', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(FLOW_REF, 'A.USA..');

    expect(result.columns.map((c) => c.name)).toEqual([
      'value',
      'value_scale',
      'source',
      'FREQ',
      'REF_AREA',
      'TIME_PERIOD',
      'OBS_STATUS',
      'REF_YEAR_PRICE',
      'UNIT_MULT',
    ]);
    expect(result.columns.find((c) => c.name === 'value')?.type).toBe('number');
    expect(result.columns.find((c) => c.name === 'UNIT_MULT')?.type).toBe('string');
  });
});

// ── Upstream boundary ─────────────────────────────────────────────────────────

describe('OecdDataService.fetchData — upstream failures', () => {
  it('retries a 503 instead of spending a single attempt', async () => {
    http.route(
      {
        match: DATA_URL,
        once: true,
        respond: () => new Response('upstream boom', { status: 503 }),
      },
      {
        match: DATA_URL,
        once: true,
        respond: () => new Response('upstream boom', { status: 503 }),
      },
      { match: DATA_URL, respond: () => Response.json(DATA_RESPONSE) },
    );

    const result = await service().fetchData(FLOW_REF, 'A.USA..');

    expect(http.calls).toHaveLength(3);
    expect(result.rowCount).toBe(3);
  }, 15_000);

  it('does not let a Retry-After of 0 collapse the backoff on a throttle', async () => {
    http.route({
      match: DATA_URL,
      respond: () =>
        new Response(
          'You have exceeded the number of requests currently permitted in the OECD Data API.',
          { status: 429, headers: { 'Retry-After': '0' } },
        ),
    });

    const startedAt = Date.now();
    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);
    const elapsed = Date.now() - startedAt;

    expect(http.calls).toHaveLength(3);
    // Honoring the literal hint would fire all three attempts inside a few ms.
    expect(elapsed).toBeGreaterThan(500);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    // OECD's own wording survives the retries — it is what names which limit was hit.
    expect(throttleText(error)).toContain('exceeded the number of requests currently permitted');
  }, 15_000);

  it('keeps the download-limit wording distinguishable from the request-rate one', async () => {
    respondOnce(
      'You have exceeded the number of requests for data downloads or very large data ranges permitted in the OECD Data API.',
      // Longer than the retry budget, so the limit surfaces without burning attempts.
      { headers: { 'Retry-After': '120' }, status: 429 },
    );

    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(throttleText(error)).toContain('data downloads or very large data ranges');
  });

  it('reads no throttle text off a failure that is not a throttle', async () => {
    respondOnce('Not enough key values in query, expecting 13 got 12', { status: 422 });

    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(throttleText(error)).toBeUndefined();
  });

  it('issues no request when the caller signal is already aborted', async () => {
    /**
     * Run against a real socket rather than the fetch harness: the harness
     * answers every call regardless of the signal, so only a listening server
     * can show that nothing was sent.
     */
    http.restore();
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(DATA_RESPONSE));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const outcome = await new OecdDataService(`http://127.0.0.1:${port}`)
        .fetchData(FLOW_REF, 'A.USA..', undefined, undefined, AbortSignal.abort())
        .catch((e: Error) => e);

      expect(hits).toBe(0);
      expect(outcome).toBeInstanceOf(Error);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      http.install();
    }
  });

  it('surfaces a 422 key-arity rejection with the upstream text intact', async () => {
    respondOnce('Not enough key values in query, expecting 13 got 12', { status: 422 });

    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(invalidQueryText(error)).toBe('Not enough key values in query, expecting 13 got 12');
  });

  it('surfaces a 422 period rejection with the upstream text intact', async () => {
    respondOnce('Semantic Error - Invalid Date Format `not-a-date`', { status: 422 });

    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(invalidQueryText(error)).toBe('Semantic Error - Invalid Date Format `not-a-date`');
  });

  it('surfaces a 400 the same way as a 422, with the upstream text intact', async () => {
    respondOnce('Bad Request - the data query could not be parsed', { status: 400 });

    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    // 400 classifies as InvalidParams upstream — restated so the tool's
    // caller-fixable branch reads it the same way it reads a 422.
    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(invalidQueryText(error)).toBe('Bad Request - the data query could not be parsed');
  });

  it('reads a 404 NoResultsFound body as an empty result, not an error', async () => {
    respondOnce('NoResultsFound', { status: 404 });

    const result = await service().fetchData(FLOW_REF, 'A.USA..');

    expect(result).toEqual({ columns: [], rowCount: 0, rows: [], source: 'OECD' });
  });

  it('reads any other 404 as a missing dataflow', async () => {
    respondOnce('Could not find Dataflow and/or DSD related with this data request', {
      status: 404,
    });

    const error = await service()
      .fetchData(FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('rejects a key carrying characters SDMX does not allow before any request', async () => {
    const error = await service()
      .fetchData(FLOW_REF, 'A/../etc')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(0);
    expect(invalidQueryText(error)).toContain('Dimension key contains characters');
  });
});
