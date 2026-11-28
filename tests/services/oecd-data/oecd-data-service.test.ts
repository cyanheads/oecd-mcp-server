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
import { getServerConfig } from '@/config/server-config.js';
import { invalidQueryText, OecdDataService } from '@/services/oecd-data/oecd-data-service.js';
import { throttleText } from '@/services/oecd-http/oecd-http.js';
import { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  type BodyStub,
  onResponseHeaders,
  type StubAnswer,
  startBodyStub,
} from '../../helpers/body-stub.js';
import { answerAfter, onFakeTime, onPinnedClock, stall } from '../../helpers/scripted-fetch.js';

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

/**
 * Mirrors the live `DSD_PU@DF_PU` answer for Canada and China in 2019: every
 * attribute sits at the dataset level (`structure.attributes.dataSet`, one
 * value index each in `dataSets[0].attributes`) and the observations carry the
 * value alone. `CONF_STATUS` stands in for an attribute the dataset presents
 * without a value — a `null` index.
 */
const DATASET_ATTRIBUTE_RESPONSE = {
  data: {
    dataSets: [
      {
        attributes: [0, 0, 0, 0, null],
        observations: {
          '0:0': [7.539],
          '1:0': [94.0061],
        },
      },
    ],
    structures: [
      {
        dimensions: {
          dataSet: [],
          observation: [
            {
              id: 'REF_AREA',
              keyPosition: 0,
              values: [
                { id: 'CAN', name: 'Canada' },
                { id: 'CHN', name: 'China (People’s Republic of)' },
              ],
            },
            { id: 'TIME_PERIOD', keyPosition: 1, values: [{ id: '2019', name: '2019' }] },
          ],
        },
        attributes: {
          dataSet: [
            { id: 'OBS_STATUS', values: [{ id: 'E', name: 'Estimated value' }] },
            { id: 'UNIT_MULT', values: [{ id: '6', name: 'Millions' }] },
            { id: 'UNIT_MEASURE', values: [{ id: 'T', name: 'Tonnes' }] },
            { id: 'DECIMALS', values: [{ id: '2', name: 'Two' }] },
            { id: 'CONF_STATUS', values: [{ id: 'F', name: 'Free (free for publication)' }] },
          ],
          dimensionGroup: [],
          series: [],
          observation: [],
        },
      },
    ],
  },
};

/**
 * Attributes attached to a subset of the dimensions, presented at the
 * dimension-group level. Each `dimensionGroupAttributes` key binds some key
 * positions (`~` or empty at the rest) and holds one value index per
 * `structure.attributes.dimensionGroup` attribute, then annotation indexes:
 * `UNIT_MEASURE` and `UNIT_MULT` vary by `REF_AREA`, `DECIMALS` by `REF_AREA`
 * and `TIME_PERIOD`, and a trailing `11` is an annotation, not a value.
 */
const DIMENSION_GROUP_RESPONSE = {
  data: {
    dataSets: [
      {
        dimensionGroupAttributes: {
          '~:0:~': [0, 0],
          ':1:': [1, null, null, 11],
          '~:1:1': [null, null, 0],
        },
        observations: {
          '0:0:0': [1.5],
          '0:0:1': [2.5],
          '0:1:0': [3.5],
          '0:1:1': [4.5],
        },
      },
    ],
    structures: [
      {
        dimensions: {
          observation: [
            { id: 'FREQ', values: [{ id: 'A', name: 'Annual' }] },
            {
              id: 'REF_AREA',
              values: [
                { id: 'USA', name: 'United States' },
                { id: 'DEU', name: 'Germany' },
              ],
            },
            {
              id: 'TIME_PERIOD',
              values: [
                { id: '2021', name: '2021' },
                { id: '2022', name: '2022' },
              ],
            },
          ],
        },
        attributes: {
          dimensionGroup: [
            {
              id: 'UNIT_MEASURE',
              values: [
                { id: 'USD', name: 'US dollars' },
                { id: 'EUR', name: 'Euro' },
              ],
            },
            { id: 'UNIT_MULT', values: [{ id: '6', name: 'Millions' }] },
            { id: 'DECIMALS', values: [{ id: '2', name: 'Two' }] },
          ],
          observation: [],
        },
      },
    ],
  },
};

/**
 * What OECD's quarterly national accounts send: a `dimensionGroupAttributes`
 * map whose entries hold only the index of the `HAS_METADATA` annotation,
 * beside an empty `structure.attributes.dimensionGroup`.
 */
const ANNOTATION_ONLY_GROUPS = {
  '~:0:~': [11],
  '~:~:~': [11],
};

/**
 * A dimension presented at the dataset level, as SDMX-JSON allows for one that
 * holds a single value: `FREQ` leaves the observation keys, which index
 * `REF_AREA` and `TIME_PERIOD` alone, while a dimension-group key still spans
 * every dimension in key order — `~:1:~` binds `REF_AREA`, the second
 * dimension of the key, not the second index of an observation key.
 */
const DATASET_DIMENSION_RESPONSE = {
  data: {
    dataSets: [
      {
        dimensionGroupAttributes: { '~:1:~': [0] },
        observations: {
          '0:0': [10],
          '1:0': [20],
        },
      },
    ],
    structures: [
      {
        dimensions: {
          dataSet: [{ id: 'FREQ', keyPosition: 0, values: [{ id: 'A', name: 'Annual' }] }],
          observation: [
            {
              id: 'REF_AREA',
              keyPosition: 1,
              values: [
                { id: 'USA', name: 'United States' },
                { id: 'DEU', name: 'Germany' },
              ],
            },
            { id: 'TIME_PERIOD', keyPosition: 2, values: [{ id: '2021', name: '2021' }] },
          ],
        },
        attributes: {
          dimensionGroup: [{ id: 'UNIT_MEASURE', values: [{ id: 'EUR', name: 'Euro' }] }],
        },
      },
    ],
  },
};

/** The runtime's own `fetch`, held before the harness replaces it. */
const realFetch = globalThis.fetch;

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

/** The upstream budget a handler opens for one call, carrying the caller's signal. */
function budget(signal?: AbortSignal): UpstreamBudget {
  return new UpstreamBudget(signal);
}

/** What `new Response(...)` accepts, read off the constructor rather than a global. */
type ResponseBody = ConstructorParameters<typeof Response>[0];

function respondOnce(body: ResponseBody, init?: ResponseInit): void {
  http.route({ match: DATA_URL, respond: () => new Response(body, init) });
}

/**
 * Valid JSON with a field of the wrong type: `dimensions.observation` is a map
 * where SDMX puts a list.
 */
const MISTYPED_RESPONSE = {
  data: {
    dataSets: [{ observations: { '0:0': [1.5] } }],
    structures: [{ dimensions: { observation: { FREQ: { id: 'A' } } } }],
  },
};

// ── Decoding ──────────────────────────────────────────────────────────────────

describe('OecdDataService.fetchData — decoding', () => {
  it('scales an observation carrying UNIT_MULT = Billions', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');
    const gdp = result.rows.find((r) => r.TIME_PERIOD === '2022');

    // 26054.614 billion = USD 26.05 trillion.
    expect(gdp?.value).toBe(26_054_614_000_000);
    expect(gdp?.value_scale).toBe(1_000_000_000);
    expect(gdp?.UNIT_MULT).toBe('Billions');
    expect(gdp?.OBS_STATUS).toBe('Normal value');
  });

  it('leaves an unscaled observation at its published magnitude', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const perCapita = (await service().fetchData(budget(), FLOW_REF, 'A.USA..')).rows[1];

    expect(perCapita?.value).toBe(77926.1671900703);
    expect(perCapita?.value_scale).toBe(1);
    expect(perCapita?.UNIT_MULT).toBe('Units');
  });

  it('decodes a null attribute index and an empty values array without throwing', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');
    const first = result.rows.find((r) => r.TIME_PERIOD === '2022');
    const third = result.rows.find((r) => r.TIME_PERIOD === '2020');

    // REF_YEAR_PRICE is null on the first observation despite declaring values.
    expect(first).not.toHaveProperty('REF_YEAR_PRICE');
    // MATURITY declares no values, so its index can never resolve to a label.
    expect(third).not.toHaveProperty('MATURITY');
    expect(third?.value).toBe(1.5);
    expect(third?.value_scale).toBe(1);
  });

  it('labels an uncoded attribute from its bare value', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result.rows[1]?.REF_YEAR_PRICE).toBe('2020');
  });

  it('leaves the observation unscaled when UNIT_MULT is not a power of ten', async () => {
    respondOnce(JSON.stringify(LOCAL_UNIT_MULT_RESPONSE));

    const rows = (await service().fetchData(budget(), FLOW_REF, 'A.USA..')).rows;

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

    const rows = (await service().fetchData(budget(), FLOW_REF, 'A.USA..')).rows;

    expect(rows[1]?.value).toBe(0.0015);
    expect(rows[1]?.value_scale).toBe(0.001);
    expect(rows[2]?.value).toBe(1.5e15);
    expect(rows[2]?.value_scale).toBe(1e15);
  });

  it('shifts the decimal exponent rather than multiplying by a float power', async () => {
    respondOnce(JSON.stringify(LOCAL_UNIT_MULT_RESPONSE));

    const scaled = (await service().fetchData(budget(), FLOW_REF, 'A.USA..')).rows[4];

    // 16868402.705 * 1e6 lands on 16868402704999.998.
    expect(scaled?.value).toBe(16_868_402_705_000);
    expect(16_868_402.705 * 1e6).not.toBe(16_868_402_705_000);
    expect((scaled?.value as number) / (scaled?.value_scale as number)).toBe(16_868_402.705);
  });

  it('keeps dimension labels alongside the attribute columns', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result.rows.find((r) => r.TIME_PERIOD === '2022')).toMatchObject({
      FREQ: 'Annual',
      REF_AREA: 'United States',
      TIME_PERIOD: '2022',
      source: 'OECD',
    });
    expect(result.rowCount).toBe(3);
  });

  it('declares every resolvable component as a column, sparse ones included', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    // A coded component's code column follows its label; TIME_PERIOD and the
    // uncoded REF_YEAR_PRICE have none.
    expect(result.columns.map((c) => c.name)).toEqual([
      'value',
      'value_scale',
      'source',
      'FREQ',
      'FREQ_code',
      'REF_AREA',
      'REF_AREA_code',
      'TIME_PERIOD',
      'OBS_STATUS',
      'OBS_STATUS_code',
      'REF_YEAR_PRICE',
      'UNIT_MULT',
      'UNIT_MULT_code',
    ]);
    expect(result.columns.find((c) => c.name === 'value')?.type).toBe('number');
    expect(result.columns.find((c) => c.name === 'UNIT_MULT')?.type).toBe('string');
  });
});

describe('OecdDataService.fetchData — codes and row order', () => {
  /**
   * Six observations in upstream order, which is neither key nor code order:
   * `REF_AREA` declares its values USA, CAN, DEU, and the time dimension
   * comes first in the key.
   */
  const SCRAMBLED_RESPONSE = {
    data: {
      dataSets: [
        {
          observations: {
            '0:0': [1],
            '1:1': [2],
            '0:2': [3],
            '1:0': [4],
            '0:1': [5],
            '1:2': [6],
          },
        },
      ],
      structures: [
        {
          dimensions: {
            observation: [
              {
                id: 'TIME_PERIOD',
                values: [
                  { id: '2022', name: '2022' },
                  { id: '2021', name: '2021' },
                ],
              },
              {
                id: 'REF_AREA',
                values: [
                  { id: 'USA', name: 'United States' },
                  { id: 'CAN', name: 'Canada' },
                  { id: 'DEU', name: 'Germany' },
                ],
              },
            ],
          },
        },
      ],
    },
  };

  it('sorts rows by dimension code in key order, with the time dimension last', async () => {
    respondOnce(JSON.stringify(SCRAMBLED_RESPONSE));

    const { rows } = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(rows.map((r) => [r.REF_AREA_code, r.TIME_PERIOD, r.value])).toEqual([
      ['CAN', '2021', 2],
      ['CAN', '2022', 5],
      ['DEU', '2021', 6],
      ['DEU', '2022', 3],
      ['USA', '2021', 4],
      ['USA', '2022', 1],
    ]);
  });

  it('puts each coded component’s code beside its label, at every attribute level', async () => {
    const decode = async (response: unknown) => {
      http.reset();
      respondOnce(JSON.stringify(response));
      return service().fetchData(budget(), FLOW_REF, 'A.USA..');
    };
    const { rows } = await decode(DATA_RESPONSE);
    const grouped = await decode(DIMENSION_GROUP_RESPONSE);
    const atDataSet = await decode(DATASET_ATTRIBUTE_RESPONSE);

    expect(rows.find((r) => r.TIME_PERIOD === '2022')).toMatchObject({
      FREQ: 'Annual',
      FREQ_code: 'A',
      REF_AREA: 'United States',
      REF_AREA_code: 'USA',
      OBS_STATUS_code: 'A',
      UNIT_MULT: 'Billions',
      UNIT_MULT_code: '9',
    });
    expect(grouped.rows.find((r) => r.REF_AREA_code === 'DEU')).toMatchObject({
      UNIT_MEASURE: 'Euro',
      UNIT_MEASURE_code: 'EUR',
    });
    expect(atDataSet.rows[0]).toMatchObject({ OBS_STATUS_code: 'E', UNIT_MULT_code: '6' });
  });

  it('gives no code to the time dimension or to an uncoded attribute', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    const { rows } = await service().fetchData(budget(), FLOW_REF, 'A.USA..');
    const perCapita = rows.find((r) => r.TIME_PERIOD === '2021');

    expect(perCapita?.REF_YEAR_PRICE).toBe('2020');
    expect(perCapita).not.toHaveProperty('REF_YEAR_PRICE_code');
    expect(perCapita).not.toHaveProperty('TIME_PERIOD_code');
  });

  it('codes a dataset-level dimension too', async () => {
    respondOnce(JSON.stringify(DATASET_DIMENSION_RESPONSE));

    const { columns, rows } = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ FREQ: 'Annual', FREQ_code: 'A' });
    expect(columns.map((c) => c.name).slice(3, 8)).toEqual([
      'FREQ',
      'FREQ_code',
      'REF_AREA',
      'REF_AREA_code',
      'TIME_PERIOD',
    ]);
  });

  it('keeps the full non-time key positions across dataset and observation dimensions', async () => {
    const { data } = DATASET_DIMENSION_RESPONSE;
    const structure = data.structures[0]!;
    const [frequency] = structure.dimensions.dataSet;
    const [area, time] = structure.dimensions.observation;
    respondOnce(
      JSON.stringify({
        data: {
          dataSets: [{ observations: { '1:0': [20] } }],
          structures: [
            {
              ...structure,
              dimensions: {
                dataSet: [{ ...frequency, keyPosition: 2 }],
                observation: [
                  { ...area, keyPosition: 0 },
                  { ...time, keyPosition: 3 },
                ],
              },
            },
          ],
        },
      }),
    );

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result.keyDimensionIds).toEqual(['REF_AREA', undefined, 'FREQ']);
    expect(result.rows[0]).toMatchObject({ REF_AREA_code: 'DEU', FREQ_code: 'A' });
  });
});

describe('OecdDataService.fetchData — attributes above the observation level', () => {
  /** The decoded rows of one canned response, looked up by what they describe rather than by position. */
  async function decode(response: unknown) {
    respondOnce(JSON.stringify(response));
    return service().fetchData(budget(), FLOW_REF, 'A.USA..');
  }

  function rowWhere(
    rows: readonly Record<string, unknown>[],
    match: Record<string, string>,
  ): Record<string, unknown> | undefined {
    return rows.find((row) => Object.entries(match).every(([key, value]) => row[key] === value));
  }

  it('lands every dataset-level attribute on every row and scales by its UNIT_MULT', async () => {
    const { rows } = await decode(DATASET_ATTRIBUTE_RESPONSE);

    expect(rows).toHaveLength(2);
    expect(rowWhere(rows, { REF_AREA: 'Canada' })).toMatchObject({
      value: 7_539_000,
      value_scale: 1_000_000,
      UNIT_MULT: 'Millions',
    });
    expect(rowWhere(rows, { REF_AREA: 'China (People’s Republic of)' })?.value).toBe(94_006_100);
    for (const row of rows) {
      expect(row).toMatchObject({
        value_scale: 1_000_000,
        OBS_STATUS: 'Estimated value',
        UNIT_MEASURE: 'Tonnes',
        DECIMALS: 'Two',
      });
    }
  });

  it('adds no key for a dataset-level attribute with a null index, yet still declares its column', async () => {
    const { columns, rows } = await decode(DATASET_ATTRIBUTE_RESPONSE);

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toHaveProperty('CONF_STATUS');
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'OBS_STATUS',
        'UNIT_MULT',
        'UNIT_MEASURE',
        'DECIMALS',
        'CONF_STATUS',
      ]),
    );
  });

  it('lands a dimension-group attribute only on the observations its entry binds', async () => {
    const { columns, rows } = await decode(DIMENSION_GROUP_RESPONSE);
    const usa2021 = rowWhere(rows, { REF_AREA: 'United States', TIME_PERIOD: '2021' });
    const usa2022 = rowWhere(rows, { REF_AREA: 'United States', TIME_PERIOD: '2022' });
    const deu2021 = rowWhere(rows, { REF_AREA: 'Germany', TIME_PERIOD: '2021' });
    const deu2022 = rowWhere(rows, { REF_AREA: 'Germany', TIME_PERIOD: '2022' });

    // `~:0:~` binds REF_AREA = USA, so both US periods take its two values.
    for (const row of [usa2021, usa2022]) {
      expect(row).toMatchObject({ UNIT_MEASURE: 'US dollars', UNIT_MULT: 'Millions' });
      expect(row).not.toHaveProperty('DECIMALS');
    }
    expect(usa2021).toMatchObject({ value: 1_500_000, value_scale: 1_000_000 });
    // `:1:` (empty, not `~`, at the unbound positions) binds Germany; its null
    // UNIT_MULT adds nothing, and its trailing annotation index is not a value.
    for (const row of [deu2021, deu2022]) {
      expect(row).toMatchObject({ UNIT_MEASURE: 'Euro', value_scale: 1 });
      expect(row).not.toHaveProperty('UNIT_MULT');
    }
    expect(deu2021?.value).toBe(3.5);
    // `~:1:1` binds Germany in 2022 alone, on top of the REF_AREA-wide entry.
    expect(deu2021).not.toHaveProperty('DECIMALS');
    expect(deu2022).toMatchObject({ DECIMALS: 'Two', UNIT_MEASURE: 'Euro' });
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['UNIT_MEASURE', 'UNIT_MULT', 'DECIMALS']),
    );
  });

  it('changes nothing for a dimension-group entry that holds only annotation indexes', async () => {
    const plain = await decode(DATA_RESPONSE);
    http.reset();
    const annotated = await decode({
      data: {
        ...DATA_RESPONSE.data,
        dataSets: [
          { ...DATA_RESPONSE.data.dataSets[0], dimensionGroupAttributes: ANNOTATION_ONLY_GROUPS },
        ],
        structures: [
          {
            ...DATA_RESPONSE.data.structures[0],
            attributes: { ...DATA_RESPONSE.data.structures[0]?.attributes, dimensionGroup: [] },
          },
        ],
      },
    });

    expect(annotated).toEqual(plain);
  });

  it('carries a dataset-level dimension onto every row, in its key position', async () => {
    const { columns, rows } = await decode(DATASET_DIMENSION_RESPONSE);

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ FREQ: 'Annual', TIME_PERIOD: '2021' });
    const names = columns.map((c) => c.name);
    expect(names.indexOf('FREQ')).toBeGreaterThan(-1);
    expect(names.indexOf('FREQ')).toBeLessThan(names.indexOf('REF_AREA'));
  });

  it('matches a dimension-group key over every dimension, dataset-level ones included', async () => {
    const { rows } = await decode(DATASET_DIMENSION_RESPONSE);

    expect(rowWhere(rows, { REF_AREA: 'Germany' })?.UNIT_MEASURE).toBe('Euro');
    expect(rowWhere(rows, { REF_AREA: 'United States' })).not.toHaveProperty('UNIT_MEASURE');
  });
});

// ── Reference forms ───────────────────────────────────────────────────────────

describe('OecdDataService.fetchData — flow reference forms', () => {
  it('percent-encodes the separator of a combined reference', async () => {
    respondOnce(JSON.stringify(DATA_RESPONSE));

    await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(http.calls[0]?.request.url).toBe(DATA_URL);
  });

  it('queries a datastructure-less dataflow under the bare reference OECD answers', async () => {
    // Pairing this dataflow with the datastructure named in its URN produces
    // `OECD.TAD.ARP,DSD_AEI2024_DASHBOARD%40DF_AEI2024_DASHBOARD`, which the
    // data endpoint refuses; the bare id is the reference that resolves.
    const bareUrl = `${BASE}/data/OECD.TAD.ARP,DF_AEI2024_DASHBOARD/AUS.NBAL.?dimensionAtObservation=AllDimensions`;
    http.route({ match: bareUrl, respond: () => Response.json(DATA_RESPONSE) });

    const result = await service().fetchData(
      budget(),
      'OECD.TAD.ARP,DF_AEI2024_DASHBOARD',
      'AUS.NBAL.',
    );

    expect(http.calls[0]?.request.url).toBe(bareUrl);
    expect(result.rowCount).toBe(3);
  });

  it('keeps the flow reference on an all-wildcard key that URL resolution would eat', async () => {
    // `..` is the every-series key for a three-dimension dataflow and the
    // key_example those dataflows advertise. Left in the path it resolves away
    // along with the flow reference, and OECD answers the remainder with a 400.
    const allUrl = `${BASE}/data/OECD.TAD.ARP,DF_AEI2024_DASHBOARD/all?dimensionAtObservation=AllDimensions`;
    http.route({ match: allUrl, respond: () => Response.json(DATA_RESPONSE) });

    const result = await service().fetchData(budget(), 'OECD.TAD.ARP,DF_AEI2024_DASHBOARD', '..');

    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe(
      '/data/OECD.TAD.ARP,DF_AEI2024_DASHBOARD/all',
    );
    expect(result.rowCount).toBe(3);
  });

  it('does the same for the two-dimension all-wildcard key', async () => {
    const allUrl = `${BASE}/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/all?dimensionAtObservation=AllDimensions`;
    http.route({ match: allUrl, respond: () => Response.json(DATA_RESPONSE) });

    await service().fetchData(budget(), FLOW_REF, '.');

    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe(
      '/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/all',
    );
  });

  it('does the same for the percent-encoded spelling of a dot key', async () => {
    // URL parsing reads `%2e` as a dot when it decides whether a segment is a
    // dot reference, so `%2e%2e` resolves away exactly as `..` does.
    const allUrl = `${BASE}/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/all?dimensionAtObservation=AllDimensions`;
    http.route({ match: allUrl, respond: () => Response.json(DATA_RESPONSE) });

    await service().fetchData(budget(), FLOW_REF, '%2e%2e');

    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe(
      '/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/all',
    );
  });

  it('rejects a flow reference whose segment is nothing but dots', async () => {
    await expect(service().fetchData(budget(), 'OECD.TAD.ARP,..', 'all')).rejects.toThrow(
      'Invalid flow_ref',
    );
    await expect(service().fetchData(budget(), '..,DSD_A@DF_B', 'all')).rejects.toThrow(
      'Invalid flow_ref',
    );
    expect(http.calls).toHaveLength(0);
  });

  it('leaves a longer wildcard key alone', async () => {
    const url = `${BASE}/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/...?dimensionAtObservation=AllDimensions`;
    http.route({ match: url, respond: () => Response.json(DATA_RESPONSE) });

    await service().fetchData(budget(), FLOW_REF, '...');

    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe(
      '/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/...',
    );
  });

  it('rejects a reference carrying path characters before any request goes out', async () => {
    await expect(
      service().fetchData(budget(), 'OECD.TAD.ARP,../../etc/passwd', '..'),
    ).rejects.toThrow('Invalid flow_ref');
    expect(http.calls).toHaveLength(0);
  });

  it('appends lastNObservations to the data URL when given and omits it when unset', async () => {
    const withLastN = `${DATA_URL}&lastNObservations=2`;
    http.route(
      { match: withLastN, respond: () => Response.json(DATA_RESPONSE) },
      { match: DATA_URL, respond: () => Response.json(DATA_RESPONSE) },
    );

    await service().fetchData(budget(), FLOW_REF, 'A.USA..');
    await service().fetchData(budget(), FLOW_REF, 'A.USA..', undefined, undefined, 2);

    expect(http.calls.map((c) => c.request.url)).toEqual([DATA_URL, withLastN]);
  });
});

// ── Upstream boundary ─────────────────────────────────────────────────────────

describe('OecdDataService.fetchData — upstream failures', () => {
  it.each([
    'Forbidden',
    '<html>Semantic Error - Invalid Date Format `last year`</html>',
    'Access denied: Not enough key values in query, expecting 5 got 3',
    'Semantic Error - Invalid Date Format `<html>last year</html>`',
    'Not enough key values in query,\nexpecting 5 got 3',
    'Semantic Error - Invalid\r\nDate Format `last year`',
  ])('keeps an unrelated 403 refusal upstream: %s', async (body) => {
    respondOnce(body, { status: 403 });
    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: unknown) => e);
    expect(http.calls).toHaveLength(1);
    expect(invalidQueryText(error)).toBeUndefined();
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });

  it('accepts outer HTTP line endings without accepting breaks inside a rejection', async () => {
    respondOnce('\r\nSemantic Error - Invalid Date Format `last year`\r\n', { status: 403 });
    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: unknown) => e);
    expect(invalidQueryText(error)).toBe('Semantic Error - Invalid Date Format `last year`');
  });

  it.each([400, 422, 403])('preserves query rejections at HTTP %i', async (status) => {
    for (const body of [
      'Not enough key values in query, expecting 5 got 3',
      'Semantic Error - Invalid Date Format `last year`',
    ]) {
      http.reset();
      respondOnce(body, { status });
      const error = await service()
        .fetchData(budget(), FLOW_REF, 'A.USA..')
        .catch((e: unknown) => e);
      expect(http.calls).toHaveLength(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { status, body },
      });
      expect(invalidQueryText(error)).toBe(body);
    }
  });

  describe('on a pinned clock', () => {
    onPinnedClock();

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

      const { elapsedMs, value } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls).toHaveLength(3);
      expect(value?.rowCount).toBe(3);
      // The third attempt, after the 1 s and 2 s backoffs.
      expect(elapsedMs).toBe(3_000);
    });

    it('does not let a Retry-After of 0 collapse the backoff on a throttle', async () => {
      http.route({
        match: DATA_URL,
        respond: () =>
          new Response(
            'You have exceeded the number of requests currently permitted in the OECD Data API.',
            { status: 429, headers: { 'Retry-After': '0' } },
          ),
      });

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls).toHaveLength(3);
      // The 1 s and 2 s backoffs; honoring the literal hint would fire all three attempts at once.
      expect(elapsedMs).toBe(3_000);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      // OECD's own wording survives the retries — it is what names which limit was hit.
      expect(throttleText(error)).toContain('exceeded the number of requests currently permitted');
    });
  });

  it('keeps the download-limit wording distinguishable from the request-rate one', async () => {
    respondOnce(
      'You have exceeded the number of requests for data downloads or very large data ranges permitted in the OECD Data API.',
      // Longer than the retry budget, so the limit surfaces without burning attempts.
      { headers: { 'Retry-After': '120' }, status: 429 },
    );

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(throttleText(error)).toContain('data downloads or very large data ranges');
  });

  it('reads no throttle text off a failure that is not a throttle', async () => {
    respondOnce('Not enough key values in query, expecting 13 got 12', { status: 422 });

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
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
        .fetchData(budget(AbortSignal.abort()), FLOW_REF, 'A.USA..')
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
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(invalidQueryText(error)).toBe('Not enough key values in query, expecting 13 got 12');
  });

  it('surfaces a 422 period rejection with the upstream text intact', async () => {
    respondOnce('Semantic Error - Invalid Date Format `not-a-date`', { status: 422 });

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(invalidQueryText(error)).toBe('Semantic Error - Invalid Date Format `not-a-date`');
  });

  it('surfaces a 400 the same way as a 422, with the upstream text intact', async () => {
    respondOnce('Bad Request - the data query could not be parsed', { status: 400 });

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    // 400 classifies as InvalidParams upstream — restated so the tool's
    // caller-fixable branch reads it the same way it reads a 422.
    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(invalidQueryText(error)).toBe('Bad Request - the data query could not be parsed');
  });

  it('reads a 404 NoResultsFound body as an empty result, not an error', async () => {
    respondOnce('NoResultsFound', { status: 404 });

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result).toEqual({
      columns: [],
      keyDimensionIds: [],
      rowCount: 0,
      rows: [],
      serviceRoot: BASE,
      source: 'OECD',
    });
  });

  it('reads a 404 NoRecordsFound body as an empty result too', async () => {
    // The service roots do not agree on the sentinel: one says NoResultsFound,
    // another NoRecordsFound, for the same "valid query, nothing matched".
    respondOnce('NoRecordsFound', { status: 404 });

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result).toEqual({
      columns: [],
      keyDimensionIds: [],
      rowCount: 0,
      rows: [],
      serviceRoot: BASE,
      source: 'OECD',
    });
  });

  it('reads any other 404 as a missing dataflow', async () => {
    respondOnce('Could not find Dataflow and/or DSD related with this data request', {
      status: 404,
    });

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('keeps explicitly empty datasets and structures as zero rows', async () => {
    respondOnce(JSON.stringify({ data: { dataSets: [], structures: [] } }));
    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');
    expect(result).toMatchObject({ rowCount: 0, rows: [] });
  });

  it.each([{}, { data: { dataSets: [] } }, { data: { dataSets: [{}], structures: [{}] } }])(
    'reports observations JSON missing a required collection as unreadable: %j',
    async (body) => {
      respondOnce(JSON.stringify(body));
      await expect(service().fetchData(budget(), FLOW_REF, 'A.USA..')).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it('reports observations JSON with a mistyped field as unreadable after one request', async () => {
    respondOnce(JSON.stringify(MISTYPED_RESPONSE));

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    // Not the outage a retry could clear: the same request returns the same bytes.
    expect(http.calls).toHaveLength(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: `Failed to fetch OECD data for ${FLOW_REF}`,
    });
    expect((error as Error).cause).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'OECD answered with JSON whose fields do not have the SDMX shape',
    });
  });

  it('rejects a key carrying characters SDMX does not allow before any request', async () => {
    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A/../etc')
      .catch((e: Error) => e);

    expect(http.calls).toHaveLength(0);
    expect(invalidQueryText(error)).toContain('Dimension key contains characters');
  });
});

// ── The response body ─────────────────────────────────────────────────────────

/**
 * Failures before the body and while it arrives, over a real loopback socket,
 * so each one reaches the boundary in the shape the runtime's own network stack
 * gives it — a deadline cutting a stalled read, a caller abort mid-body, a
 * connection dropped partway through. That proves the classification against
 * what Bun's and Node's `fetch` actually throw, where a fake would prove only
 * what it was written to throw. Every row counts the requests its outcome cost.
 */
describe('OecdDataService.fetchData — the response body', () => {
  const config = getServerConfig();
  const configuredTimeoutMs = config.timeoutMs;
  const stubs: BodyStub[] = [];

  /** A service whose configured root is a fresh stub answering every request with `answer`. */
  async function stubbedService(
    answer: StubAnswer,
  ): Promise<{ stub: BodyStub; svc: OecdDataService }> {
    const stub = await startBodyStub(() => answer);
    stubs.push(stub);
    return { stub, svc: new OecdDataService(stub.origin) };
  }

  beforeEach(() => {
    http.restore();
    config.timeoutMs = 300;
  });

  afterEach(async () => {
    config.timeoutMs = configuredTimeoutMs;
    await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  });

  it('keeps the retries on a deadline that fires before the headers', async () => {
    const { stub, svc } = await stubbedService({ kind: 'no-headers' });

    const error = await svc.fetchData(budget(), FLOW_REF, 'A.USA..').catch((e: Error) => e);

    expect(stub.requests).toHaveLength(3);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  }, 15_000);

  it('spends one request on a deadline that fires while the body is arriving', async () => {
    const { stub, svc } = await stubbedService({ kind: 'stalled-body' });

    const error = await svc.fetchData(budget(), FLOW_REF, 'A.USA..').catch((e: Error) => e);

    // A repeat would download the same answer from the start, against the
    // same deadline.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.bodyStarted).toBe(true);
    await stub.requests[0]?.closed;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: `Failed to fetch OECD data for ${FLOW_REF}`,
    });
  }, 15_000);

  it('reports the caller’s abort mid-body as RequestCancelled, with no further attempt', async () => {
    const { stub, svc } = await stubbedService({ kind: 'stalled-body' });
    const caller = new AbortController();
    const restoreFetch = onResponseHeaders(() => caller.abort());

    try {
      const error = await svc
        .fetchData(budget(caller.signal), FLOW_REF, 'A.USA..')
        .catch((e: Error) => e);

      expect(stub.requests).toHaveLength(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
        data: { errorSource: 'FetchAborted' },
        message: `Failed to fetch OECD data for ${FLOW_REF}`,
      });
      expect((error as Error).cause).toMatchObject({ message: expect.stringMatching(/aborted/) });
    } finally {
      restoreFetch();
    }
  });

  it('retries a connection dropped mid-body and reports it as an outage', async () => {
    const { stub, svc } = await stubbedService({ kind: 'dropped-body' });

    const error = await svc.fetchData(budget(), FLOW_REF, 'A.USA..').catch((e: Error) => e);

    expect(stub.requests).toHaveLength(3);
    expect(stub.requests.every((request) => request.bodyStarted)).toBe(true);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: `Failed to fetch OECD data for ${FLOW_REF}`,
    });
  }, 15_000);

  it('reports a complete body that is not JSON as a SerializationError after one request', async () => {
    const { stub, svc } = await stubbedService({
      body: '<html>Service notice</html>',
      kind: 'complete',
    });

    const error = await svc.fetchData(budget(), FLOW_REF, 'A.USA..').catch((e: Error) => e);

    expect(stub.requests).toHaveLength(1);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
  });
});

// ── Delegated service roots ───────────────────────────────────────────────────

/**
 * The configured root catalogues part of the collection without hosting its
 * observations. Those entries answer the data endpoint with a 500 and carry a
 * `links[]` entry naming the OECD service root that does host them.
 */
describe('OecdDataService.fetchData — delegated service roots', () => {
  const CATALOG_URL = `${BASE}/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I`;
  const DELEGATED_ROOT = `${BASE}/sti-public/rest`;
  const DELEGATED_DATA_URL = `${DELEGATED_ROOT}/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/A.USA..?dimensionAtObservation=AllDimensions`;

  it('queries an exact edition directly on a known data root', async () => {
    const url = DELEGATED_DATA_URL.replace('/A.USA..', ',1.1/A.USA..');
    const response = structuredClone(DATA_RESPONSE);
    Object.assign(response.data.structures[0]!, {
      links: [
        {
          rel: 'datastructure',
          urn: 'urn:sdmx:org.sdmx.infomodel.datastructure.Dataflow=OECD.SDD.NAD:DSD_NAAG@DF_NAAG_I(1.1)',
        },
      ],
    });
    http.route({ match: url, respond: () => Response.json(response) });

    const result = await service().fetchData(
      budget(),
      FLOW_REF,
      'A.USA..',
      undefined,
      undefined,
      undefined,
      {
        dataRoot: DELEGATED_ROOT,
        version: '1.1',
      },
    );
    expect(result).toMatchObject({ serviceRoot: DELEGATED_ROOT, version: '1.1' });
    expect(http.calls.map((call) => call.request.url)).toEqual([url]);
  });

  it('reads the latest edition from the matching Dataflow link without fetching metadata', async () => {
    const response = structuredClone(DATA_RESPONSE);
    Object.assign(response.data.structures[0]!, {
      links: [
        {
          rel: 'datastructure',
          urn: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=OECD.SDD.NAD:DSD_NAAG(9.0)',
        },
        {
          rel: 'datastructure',
          urn: 'urn:sdmx:org.sdmx.infomodel.datastructure.Dataflow=OTHER:FLOW(8.0)',
        },
        {
          rel: 'datastructure',
          urn: 'urn:sdmx:org.sdmx.infomodel.datastructure.Dataflow=OECD.SDD.NAD:DSD_NAAG@DF_NAAG_I(1.2)',
        },
      ],
    });
    http.route({ match: DATA_URL, respond: () => Response.json(response) });
    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');
    expect(result.version).toBe('1.2');
    expect(http.calls.map((call) => call.request.url)).toEqual([DATA_URL]);
  });

  /** The catalog entry for the flow, delegating to `href`. */
  function delegatingEntry(href: string): Response {
    return Response.json({
      data: {
        dataflows: [
          {
            agencyID: 'OECD.SDD.NAD',
            id: 'DSD_NAAG@DF_NAAG_I',
            isExternalReference: true,
            links: [{ rel: 'external', href }],
          },
        ],
      },
    });
  }

  /** A catalog entry delegating to `href`. */
  function routeCatalog(href: string): void {
    http.route({ match: CATALOG_URL, respond: () => delegatingEntry(href) });
  }

  /**
   * A permissive last route answering anything still requested with a usable
   * result, so following a rejected href would succeed. A test that ends in the
   * original failure therefore proves the request was never issued.
   */
  function routeAnythingElse(): void {
    http.route({ match: () => true, respond: () => Response.json(DATA_RESPONSE) });
  }

  it('reissues the query against the root the catalog entry delegates to', async () => {
    http.route(
      {
        match: DATA_URL,
        respond: () =>
          new Response('Object reference not set to an instance of an object.', { status: 500 }),
      },
      { match: DELEGATED_DATA_URL, respond: () => Response.json(DATA_RESPONSE) },
    );
    routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result.rowCount).toBe(3);
    expect(http.calls.at(-1)?.request.url).toBe(DELEGATED_DATA_URL);
  });

  it('carries the key and period filters through to the delegated root unchanged', async () => {
    const delegatedWithPeriod = `${DELEGATED_DATA_URL}&startPeriod=2020&endPeriod=2021`;
    http.route(
      {
        match: `${DATA_URL}&startPeriod=2020&endPeriod=2021`,
        respond: () => new Response('Object reference not set', { status: 500 }),
      },
      { match: delegatedWithPeriod, respond: () => Response.json(DATA_RESPONSE) },
    );
    routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..', '2020', '2021');

    expect(result.rowCount).toBe(3);
    expect(http.calls.at(-1)?.request.url).toBe(delegatedWithPeriod);
  });

  it('carries lastNObservations through to the delegated root unchanged', async () => {
    const delegatedWithLastN = `${DELEGATED_DATA_URL}&lastNObservations=3`;
    http.route(
      {
        match: `${DATA_URL}&lastNObservations=3`,
        respond: () => new Response('Object reference not set', { status: 500 }),
      },
      { match: delegatedWithLastN, respond: () => Response.json(DATA_RESPONSE) },
    );
    routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

    const result = await service().fetchData(
      budget(),
      FLOW_REF,
      'A.USA..',
      undefined,
      undefined,
      3,
    );

    expect(result.rowCount).toBe(3);
    expect(http.calls.at(-1)?.request.url).toBe(delegatedWithLastN);
  });

  it('surfaces the delegated root’s own rejection rather than the first failure', async () => {
    http.route(
      {
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      },
      {
        match: DELEGATED_DATA_URL,
        respond: () =>
          new Response('Not enough key values in query, expecting 6 got 3', { status: 422 }),
      },
    );
    routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(invalidQueryText(error)).toBe('Not enough key values in query, expecting 6 got 3');
  });

  it('reads a NoResultsFound from the delegated root as an empty result', async () => {
    http.route(
      {
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      },
      { match: DELEGATED_DATA_URL, respond: () => new Response('NoRecordsFound', { status: 404 }) },
    );
    routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    // The delegated root answered, so a read that follows this result goes there.
    expect(result).toEqual({
      columns: [],
      keyDimensionIds: [],
      rowCount: 0,
      rows: [],
      serviceRoot: DELEGATED_ROOT,
      source: 'OECD',
    });
  });

  it('reports a delegated answer with a mistyped field as unreadable, with no retry', async () => {
    http.route(
      {
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      },
      { match: DELEGATED_DATA_URL, respond: () => Response.json(MISTYPED_RESPONSE) },
    );
    routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

    const error = await service()
      .fetchData(budget(), FLOW_REF, 'A.USA..')
      .catch((e: Error) => e);

    expect(http.calls.map((c) => c.request.url)).toEqual([
      DATA_URL,
      CATALOG_URL,
      DELEGATED_DATA_URL,
    ]);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: `Failed to fetch OECD data for ${FLOW_REF}`,
    });
    expect((error as Error).cause).toMatchObject({
      message: 'OECD answered with JSON whose fields do not have the SDMX shape',
    });
  });

  describe('on a pinned clock', () => {
    onPinnedClock();

    it('asks the catalog after one 500 rather than after three', async () => {
      // The 500 is a fixed property of a flow this root does not host, so the
      // backoff cannot clear it and the lookup settles it for one request.
      http.route(
        {
          match: DATA_URL,
          respond: () =>
            new Response('Object reference not set to an instance of an object.', { status: 500 }),
        },
        { match: DELEGATED_DATA_URL, respond: () => Response.json(DATA_RESPONSE) },
      );
      routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

      const { elapsedMs, value } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(value?.rowCount).toBe(3);
      expect(http.calls.map((c) => c.request.url)).toEqual([
        DATA_URL,
        CATALOG_URL,
        DELEGATED_DATA_URL,
      ]);
      // Three attempts would have carried the framework's 1 s and 2 s backoffs first.
      expect(elapsedMs).toBe(0);
    });

    it('never issues a request to a host the delegation names but the base URL does not', async () => {
      http.route({
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      });
      routeCatalog(
        'https://attacker.example/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF/1.1',
      );
      routeAnythingElse();

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.map((c) => new URL(c.request.url).host)).not.toContain('attacker.example');
      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      // The probe, the lookup, then the two attempts the probe withheld, 1 s apart.
      expect(http.calls.map((c) => c.request.url)).toEqual([
        DATA_URL,
        CATALOG_URL,
        DATA_URL,
        DATA_URL,
      ]);
      expect(elapsedMs).toBe(1_000);
    });

    it('never issues a request for a delegation over plaintext', async () => {
      http.route({
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      });
      routeCatalog(`http://fake.oecd.test/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF/1.1`);
      routeAnythingElse();

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.map((c) => new URL(c.request.url).protocol)).not.toContain('http:');
      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        DATA_URL,
        CATALOG_URL,
        DATA_URL,
        DATA_URL,
      ]);
      expect(elapsedMs).toBe(1_000);
    });

    it('reports the original failure when the catalog entry delegates nowhere', async () => {
      http.route({
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      });
      http.route({
        match: CATALOG_URL,
        respond: () =>
          Response.json({ data: { dataflows: [{ agencyID: 'OECD.SDD.NAD', links: [] }] } }),
      });
      routeAnythingElse();

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(http.calls.map((c) => c.request.url)).not.toContain(DELEGATED_DATA_URL);
      expect(elapsedMs).toBe(1_000);
    });

    it.each([
      [
        'an outage',
        () => new Response('boom', { status: 503 }),
        JsonRpcErrorCode.ServiceUnavailable,
      ],
      [
        'a throttle',
        () =>
          new Response('You have exceeded the number of requests currently permitted.', {
            headers: { 'retry-after': '0' },
            status: 429,
          }),
        JsonRpcErrorCode.RateLimited,
      ],
    ])('spends no catalog lookup on %s', async (_case, answer, code) => {
      // Neither says anything about where the dataflow lives, and another request
      // is the last thing a throttled or failing service needs. The throttle's
      // `Retry-After: 0` is dropped, so it backs off exactly as the outage does.
      http.route({ match: DATA_URL, respond: answer });
      routeAnythingElse();

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.map((c) => c.request.url)).toEqual([DATA_URL, DATA_URL, DATA_URL]);
      expect(error).toMatchObject({ code });
      expect(elapsedMs).toBe(3_000);
    });

    it('spends one request on the catalog lookup, not a retry loop of its own', async () => {
      // Skipping the retries at the data endpoint buys nothing if the question
      // that replaces them costs the same three requests and backoff.
      http.route({
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      });
      http.route({ match: CATALOG_URL, respond: () => new Response('boom', { status: 503 }) });

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.filter((c) => c.request.url === CATALOG_URL)).toHaveLength(1);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      // The lookup's failure costs no backoff of its own: only the resumed ladder's 1 s.
      expect(elapsedMs).toBe(1_000);
    });

    it('still retries a 500 the catalog cannot explain', async () => {
      // Delegation and an unwell service are spelled the same way, and only the
      // lookup tells them apart. Ruling delegation out leaves an ordinary
      // transient fault, which gets the attempts the probe withheld.
      http.route({
        match: DATA_URL,
        respond: () => new Response('Object reference not set', { status: 500 }),
      });
      http.route({
        match: CATALOG_URL,
        respond: () =>
          Response.json({ data: { dataflows: [{ agencyID: 'OECD.SDD.NAD', links: [] }] } }),
      });

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.filter((c) => c.request.url === DATA_URL)).toHaveLength(3);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(elapsedMs).toBe(1_000);
    });

    it.each<[string, () => void, string, string[]]>([
      [
        'the configured root, answering the probe',
        () => http.route({ match: DATA_URL, respond: () => Response.json(DATA_RESPONSE) }),
        BASE,
        [DATA_URL],
      ],
      [
        'the delegated root, after the lookup',
        () => {
          http.route(
            {
              match: DATA_URL,
              respond: () => new Response('Object reference not set', { status: 500 }),
            },
            { match: DELEGATED_DATA_URL, respond: () => Response.json(DATA_RESPONSE) },
          );
          routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);
        },
        DELEGATED_ROOT,
        [DATA_URL, CATALOG_URL, DELEGATED_DATA_URL],
      ],
      [
        'the configured root, on a retry after the lookup named no other',
        () => {
          http.route(
            {
              match: DATA_URL,
              once: true,
              respond: () => new Response('Object reference not set', { status: 500 }),
            },
            { match: DATA_URL, respond: () => Response.json(DATA_RESPONSE) },
            {
              match: CATALOG_URL,
              respond: () =>
                Response.json({ data: { dataflows: [{ agencyID: 'OECD.SDD.NAD', links: [] }] } }),
            },
          );
        },
        BASE,
        [DATA_URL, CATALOG_URL, DATA_URL],
      ],
    ])('names %s as the root that served the rows', async (_case, route, root, urls) => {
      route();

      const { value } = await onFakeTime(() => service().fetchData(budget(), FLOW_REF, 'A.USA..'));

      expect(value?.rowCount).toBe(3);
      expect(value?.serviceRoot).toBe(root);
      expect(http.calls.map((c) => c.request.url)).toEqual(urls);
    });
  });

  it('succeeds on a retry the catalog lookup cleared the way for', async () => {
    let attempts = 0;
    http.route({
      match: DATA_URL,
      respond: () => {
        attempts += 1;
        return attempts === 1
          ? new Response('Object reference not set', { status: 500 })
          : Response.json(DATA_RESPONSE);
      },
    });
    http.route({
      match: CATALOG_URL,
      respond: () =>
        Response.json({ data: { dataflows: [{ agencyID: 'OECD.SDD.NAD', links: [] }] } }),
    });

    const result = await service().fetchData(budget(), FLOW_REF, 'A.USA..');

    expect(result.rowCount).toBe(3);
    expect(attempts).toBe(2);
  });

  describe('the response body', () => {
    const config = getServerConfig();
    const configuredTimeoutMs = config.timeoutMs;
    const stubs: BodyStub[] = [];

    beforeEach(() => {
      config.timeoutMs = 300;
    });

    afterEach(async () => {
      config.timeoutMs = configuredTimeoutMs;
      await Promise.all(stubs.splice(0).map((stub) => stub.close()));
    });

    it('spends one request at the delegated root on a body that outlasts the deadline', async () => {
      /**
       * The delegation is https-only and pinned to the base URL's origin, so the
       * probe and the catalog lookup stay on the harness while the delegated
       * request is carried to a real socket — the body deadline runs only
       * against a body that is actually streaming.
       */
      const stub = await startBodyStub(() => ({ kind: 'stalled-body' }));
      stubs.push(stub);
      http.route(
        {
          match: DATA_URL,
          respond: () =>
            new Response('Object reference not set to an instance of an object.', {
              status: 500,
            }),
        },
        {
          match: DELEGATED_DATA_URL,
          respond: (request) => realFetch(`${stub.origin}/stalled`, { signal: request.signal }),
        },
      );
      routeCatalog(`${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`);

      const error = await service()
        .fetchData(budget(), FLOW_REF, 'A.USA..')
        .catch((e: Error) => e);

      expect(http.calls.map((c) => c.request.url)).toEqual([
        DATA_URL,
        CATALOG_URL,
        DELEGATED_DATA_URL,
      ]);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.bodyStarted).toBe(true);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    }, 15_000);

    it('reports a caller abort during the catalog lookup as RequestCancelled, not the failure it held', async () => {
      http.restore();
      const stub = await startBodyStub((path) =>
        path.startsWith('/data/')
          ? { body: 'Could not find Dataflow and/or DSD', kind: 'complete', status: 404 }
          : { kind: 'stalled-body' },
      );
      stubs.push(stub);
      const caller = new AbortController();
      const restoreFetch = onResponseHeaders((response) => {
        if (new URL(response.url).pathname.startsWith('/dataflow/')) caller.abort();
      });

      try {
        const error = await new OecdDataService(stub.origin)
          .fetchData(budget(caller.signal), FLOW_REF, 'A.USA..')
          .catch((e: Error) => e);

        expect(stub.requests.map((r) => r.path.split('?')[0])).toEqual([
          '/data/OECD.SDD.NAD,DSD_NAAG%40DF_NAAG_I/A.USA..',
          '/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I',
        ]);
        // Not the NotFound the data endpoint answered before the abort.
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.RequestCancelled,
          message: expect.stringMatching(/was aborted\.$/),
        });
      } finally {
        restoreFetch();
      }
    });
  });

  /**
   * One budget spans the probe, the catalog lookup, and the follow-up, on fake
   * time. `OECD_TIMEOUT_MS` stays at its 30 s default, below the 50 s budget,
   * so no request timeout can end a case before the budget does, and the
   * backoff jitter is pinned so each ladder's timing is exact.
   */
  describe('one upstream budget across the chain', () => {
    const config = getServerConfig();
    const configuredTimeoutMs = config.timeoutMs;
    const DELEGATING_HREF = `${BASE}/sti-public/rest/dataflow/OECD.SDD.NAD/DSD_NAAG@DF_NAAG_I/1.1`;

    onPinnedClock();

    beforeEach(() => {
      config.timeoutMs = 30_000;
    });

    afterEach(() => {
      config.timeoutMs = configuredTimeoutMs;
    });

    it('ends a probe that never answers at the budget, after two requests', async () => {
      http.route({ match: DATA_URL, respond: stall });

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      // 30 s, a 1 s backoff, then the 19 s left — not a third 30 s attempt.
      expect(http.calls).toHaveLength(2);
      expect(elapsedMs).toBe(50_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `Failed to fetch OECD data for ${FLOW_REF}`,
      });
    });

    it('ends the call as the budget’s expiry when it runs out mid-lookup, not as the 404 it held', async () => {
      http.route(
        { match: DATA_URL, once: true, respond: stall },
        {
          match: DATA_URL,
          respond: () =>
            new Response('Could not find Dataflow and/or DSD related with this data request', {
              status: 404,
            }),
        },
        { match: CATALOG_URL, respond: stall },
      );

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.map((c) => c.request.url)).toEqual([DATA_URL, DATA_URL, CATALOG_URL]);
      expect(elapsedMs).toBe(50_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'The OECD requests of this call ran past its 50000 ms upstream budget',
      });
    });

    it('gives a delegated request only what the lookup left of the budget', async () => {
      http.route(
        {
          match: DATA_URL,
          respond: () =>
            new Response('Object reference not set to an instance of an object.', { status: 500 }),
        },
        {
          match: CATALOG_URL,
          respond: (request) =>
            answerAfter(25_000, request, () => delegatingEntry(DELEGATING_HREF)),
        },
        { match: DELEGATED_DATA_URL, respond: stall },
      );

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      // One 25 s attempt at the delegated root, not three of 30 s.
      expect(http.calls.map((c) => c.request.url)).toEqual([
        DATA_URL,
        CATALOG_URL,
        DELEGATED_DATA_URL,
      ]);
      expect(elapsedMs).toBe(50_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `Failed to fetch OECD data for ${FLOW_REF}`,
      });
    });

    it('gives the resumed retries only what the lookup left when no other root claims the flow', async () => {
      http.route(
        {
          match: DATA_URL,
          once: true,
          respond: () => new Response('Object reference not set', { status: 500 }),
        },
        { match: DATA_URL, respond: stall },
        {
          match: CATALOG_URL,
          respond: (request) =>
            answerAfter(25_000, request, () =>
              Response.json({ data: { dataflows: [{ agencyID: 'OECD.SDD.NAD', links: [] }] } }),
            ),
        },
      );

      const { elapsedMs, error } = await onFakeTime(() =>
        service().fetchData(budget(), FLOW_REF, 'A.USA..'),
      );

      expect(http.calls.map((c) => c.request.url)).toEqual([DATA_URL, CATALOG_URL, DATA_URL]);
      expect(elapsedMs).toBe(50_000);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: `Failed to fetch OECD data for ${FLOW_REF}`,
      });
    });
  });
});
