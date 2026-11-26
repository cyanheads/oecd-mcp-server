/**
 * @fileoverview The availability seam: decoding OECD's `availableconstraint`
 * message (against the shapes OECD answered live), reading a key's findings
 * back out of it, placing a requested period against its time range, and the
 * best-effort read — which failures degrade, which pass through, and what the
 * structure cache keeps. Each tool's own tests prove only that it is wired here.
 * @module tests/services/oecd-structure/availability.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { SDMX_KEY_SAFE } from '@/services/oecd-data/oecd-data-service.js';
import { isBudgetExpiry, UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  type AvailabilityOutcome,
  availabilityKey,
  describeFindings,
  diagnoseKey,
  isInvertedPeriodRange,
  normalizeDimensionKey,
  type OecdAvailability,
  parseAvailability,
  periodOutside,
  readAvailability,
} from '@/services/oecd-structure/availability.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDimension } from '@/services/oecd-structure/types.js';
import {
  installScriptedFetch,
  json,
  observe,
  rejectionOf,
  runUntil,
  type ScriptedAnswer,
  type ScriptedFetch,
  STALL,
} from '../../helpers/scripted-fetch.js';

// ── What OECD answered ────────────────────────────────────────────────────────

/** The 53 REF_AREA codes `DF_QNA_EXPENDITURE_GROWTH_OECD` has data for, as OECD lists them. */
const REF_AREAS =
  'ARG AUS AUT BEL BRA CAN CHE CHL CHN COL CRI CZE DEU DNK EA ESP EST EU FIN FRA G20 G7 GBR GRC HUN IDN IND IRL ISL ISR ITA JPN KOR LTU LUX LVA MEX NLD NOR NZL OECD OECDE POL PRT RUS SAU SVK SVN SWE TUR USA USMCA ZAF'.split(
    ' ',
  );

/** OECD's no-data sentinel: a `TIME_PERIOD` range whose start falls after its end. */
const NO_DATA_RANGE = {
  id: 'TIME_PERIOD',
  timeRange: {
    startPeriod: { period: '9999-01-01T00:00:00', isInclusive: true },
    endPeriod: { period: '0001-12-31T23:59:59', isInclusive: true },
  },
};

/** An `availableconstraint` message in the shape OECD sends, `meta` and names left out. */
function constraintMessage(keyValues: unknown[], obsCount: string, dataflow: string): unknown {
  return {
    data: {
      contentConstraints: [
        {
          id: 'CC',
          annotations: [{ id: 'obs_count', title: obsCount, type: 'sdmx_metrics' }],
          type: 'Actual',
          constraintAttachment: {
            dataflows: [`urn:sdmx:org.sdmx.infomodel.datastructure.Dataflow=${dataflow}`],
          },
          cubeRegions: [{ isIncluded: true, keyValues }],
        },
      ],
    },
  };
}

const QNA = 'OECD.SDD.NAD:DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD(1.1)';

/** `DF_QNA_EXPENDITURE_GROWTH_OECD`, key `all`: every dimension, its time range, and its count. */
const G1 = constraintMessage(
  [
    { id: 'FREQ', values: ['A', 'Q'] },
    { id: 'ADJUSTMENT', values: ['Y'] },
    { id: 'REF_AREA', values: REF_AREAS },
    { id: 'SECTOR', values: ['S1', 'S13', 'S1M'] },
    { id: 'COUNTERPART_SECTOR', values: ['S1'] },
    { id: 'TRANSACTION', values: ['B1GQ', 'P3', 'P51G', 'P6', 'P7'] },
    { id: 'INSTR_ASSET', values: ['_Z'] },
    { id: 'ACTIVITY', values: ['_T', '_Z'] },
    { id: 'EXPENDITURE', values: ['_T', '_Z'] },
    { id: 'UNIT_MEASURE', values: ['PC'] },
    { id: 'PRICE_BASE', values: ['L'] },
    { id: 'TRANSFORMATION', values: ['G1', 'GCM', 'GY'] },
    { id: 'TABLE_IDENTIFIER', values: ['T0102'] },
    {
      id: 'TIME_PERIOD',
      timeRange: {
        startPeriod: { period: '1947-04-01T00:00:00', isInclusive: true },
        endPeriod: { period: '2026-09-30T23:59:59', isInclusive: true },
      },
    },
  ],
  '164463',
  QNA,
);

/** `DF_IALFS_UNE_M`, key `all`, component `AGE`: one dimension and no time range. */
const G2 = constraintMessage(
  [{ id: 'AGE', values: ['Y_GE15', 'Y_GE25', 'Y15T24'] }],
  '464759',
  'OECD.SDD.TPS:DSD_LFS@DF_IALFS_UNE_M(1.0)',
);

/**
 * Key `Q..US...B1GQ......G1.` in `mode=available`: no series, so OECD lists
 * only REF_AREA — the one dimension with codes given the other segments — and
 * the inverted range.
 */
const G4 = constraintMessage([{ id: 'REF_AREA', values: REF_AREAS }, NO_DATA_RANGE], '0', QNA);

/** The same key in `mode=exact`: no dimension at all, and the inverted range. */
const G5 = constraintMessage([NO_DATA_RANGE], '0', QNA);

/** The 13 dimensions of `DF_QNA_EXPENDITURE_GROWTH_OECD`, in key order, 1-based. */
const QNA_DIMENSIONS: OecdDimension[] = [
  'FREQ',
  'ADJUSTMENT',
  'REF_AREA',
  'SECTOR',
  'COUNTERPART_SECTOR',
  'TRANSACTION',
  'INSTR_ASSET',
  'ACTIVITY',
  'EXPENDITURE',
  'UNIT_MEASURE',
  'PRICE_BASE',
  'TRANSFORMATION',
  'TABLE_IDENTIFIER',
].map((id, index) => ({ id, name: id, position: index + 1 }));

/** A decoded availability record, for the cases that build one directly. */
function availability(
  codes: Record<string, string[]>,
  observationCount: number | undefined = 0,
): OecdAvailability {
  return { codes: new Map(Object.entries(codes)), observationCount, timeRange: undefined };
}

// ── parseAvailability ─────────────────────────────────────────────────────────

describe('parseAvailability', () => {
  it('reads every dimension’s codes, the time range as dates, and the observation count', () => {
    const read = parseAvailability(G1);

    expect([...read.codes.keys()]).toEqual(QNA_DIMENSIONS.map((d) => d.id));
    expect(read.codes.get('FREQ')).toEqual(['A', 'Q']);
    expect(read.codes.get('REF_AREA')).toHaveLength(53);
    expect(read.codes.get('TRANSFORMATION')).toEqual(['G1', 'GCM', 'GY']);
    expect(read.timeRange).toEqual({ start: '1947-04-01', end: '2026-09-30' });
    expect(read.observationCount).toBe(164_463);
  });

  it('keeps TIME_PERIOD out of the codes', () => {
    expect(parseAvailability(G1).codes.has('TIME_PERIOD')).toBe(false);
    expect(parseAvailability(G4).codes.has('TIME_PERIOD')).toBe(false);
  });

  it('leaves the time range unset when OECD sends none', () => {
    const read = parseAvailability(G2);

    expect(read.codes).toEqual(new Map([['AGE', ['Y_GE15', 'Y_GE25', 'Y15T24']]]));
    expect(read.timeRange).toBeUndefined();
    expect(read.observationCount).toBe(464_759);
  });

  it('reads the inverted no-data range as no range, beside a zero count', () => {
    const read = parseAvailability(G4);

    expect([...read.codes.keys()]).toEqual(['REF_AREA']);
    expect(read.timeRange).toBeUndefined();
    expect(read.observationCount).toBe(0);
  });

  it('reads a message naming no dimension as no codes at all', () => {
    const read = parseAvailability(G5);

    expect(read.codes.size).toBe(0);
    expect(read.timeRange).toBeUndefined();
    expect(read.observationCount).toBe(0);
  });

  it('merges the included regions in first-seen order and skips an excluded one', () => {
    const message = {
      data: {
        contentConstraints: [
          {
            cubeRegions: [
              {
                isIncluded: true,
                keyValues: [
                  { id: 'FREQ', values: ['Q', 'A'] },
                  {
                    id: 'TIME_PERIOD',
                    timeRange: {
                      startPeriod: { period: '2001-01-01T00:00:00' },
                      endPeriod: { period: '2010-12-31T23:59:59' },
                    },
                  },
                ],
              },
              { isIncluded: false, keyValues: [{ id: 'FREQ', values: ['W'] }] },
              {
                keyValues: [
                  { id: 'FREQ', values: ['A', 'M'] },
                  { id: 'REF_AREA', values: ['USA'] },
                  {
                    id: 'TIME_PERIOD',
                    timeRange: {
                      startPeriod: { period: '1995-01-01T00:00:00' },
                      endPeriod: { period: '2005-12-31T23:59:59' },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const read = parseAvailability(message);

    expect(read.codes).toEqual(
      new Map([
        ['FREQ', ['Q', 'A', 'M']],
        ['REF_AREA', ['USA']],
      ]),
    );
    expect(read.timeRange).toEqual({ start: '1995-01-01', end: '2010-12-31' });
    expect(read.observationCount).toBeUndefined();
  });

  it.each([
    ['no annotations', undefined],
    ['no obs_count annotation', [{ id: 'other', title: '12' }]],
    ['a count that is not a whole number', [{ id: 'obs_count', title: '12a' }]],
    ['a count that is not a string', [{ id: 'obs_count', title: 12 }]],
  ])('leaves the observation count unset for %s', (_case, annotations) => {
    const message = {
      data: {
        contentConstraints: [{ annotations, cubeRegions: [{ isIncluded: true, keyValues: [] }] }],
      },
    };

    expect(parseAvailability(message).observationCount).toBeUndefined();
  });

  /** A G1-shaped message with one field replaced. */
  function withKeyValue(entry: unknown): unknown {
    return { data: { contentConstraints: [{ cubeRegions: [{ keyValues: [entry] }] }] } };
  }

  it.each([
    ['a null body', null],
    ['no contentConstraints', { data: {} }],
    ['an empty contentConstraints', { data: { contentConstraints: [] } }],
    ['cubeRegions as an object', { data: { contentConstraints: [{ cubeRegions: {} }] } }],
    ['keyValues missing', { data: { contentConstraints: [{ cubeRegions: [{}] }] } }],
    ['a key value with no id', withKeyValue({ values: ['A'] })],
    ['a key value with a numeric id', withKeyValue({ id: 7, values: ['A'] })],
    ['values missing', withKeyValue({ id: 'FREQ' })],
    ['values as a string', withKeyValue({ id: 'FREQ', values: 'AQ' })],
    ['values as an object', withKeyValue({ id: 'FREQ', values: { A: true } })],
    ['a value that is not a code', withKeyValue({ id: 'FREQ', values: ['A', 7] })],
    [
      'annotations as an object',
      { data: { contentConstraints: [{ annotations: {}, cubeRegions: [] }] } },
    ],
  ])('throws TypeError on %s', (_case, payload) => {
    expect(() => parseAvailability(payload)).toThrow(TypeError);
  });
});

// ── availabilityKey ───────────────────────────────────────────────────────────

describe('availabilityKey', () => {
  it.each([undefined, '', 'all', '.', '..', '%2E', '%2e%2E'])(
    'sends %j as the every-series key',
    (key) => {
      expect(availabilityKey(key)).toBe('all');
    },
  );

  it('sends any other key as written', () => {
    expect(availabilityKey('Q..usa+CAN...B1GQ......G1.')).toBe('Q..usa+CAN...B1GQ......G1.');
  });
});

// ── normalizeDimensionKey ─────────────────────────────────────────────────────

describe('normalizeDimensionKey', () => {
  it.each(['', 'all', '.', '..', '%2E', '%2e%2E'])(
    'passes every-series key %j through unchanged',
    (key) => {
      expect(normalizeDimensionKey(key, 13)).toEqual({ ok: true, key });
      expect(normalizeDimensionKey(key, 1)).toEqual({ ok: true, key });
    },
  );

  it('passes keys with exact dimension count unchanged', () => {
    expect(normalizeDimensionKey('Q..USA...B1GQ......G1.', 13)).toEqual({
      ok: true,
      key: 'Q..USA...B1GQ......G1.',
    });
    expect(normalizeDimensionKey('A.B', 2)).toEqual({ ok: true, key: 'A.B' });
    expect(normalizeDimensionKey('A', 1)).toEqual({ ok: true, key: 'A' });
  });

  it('rejects keys with fewer segments than dimensionCount as too_short', () => {
    expect(normalizeDimensionKey('Q..USA', 13)).toEqual({
      ok: false,
      reason: 'too_short',
      segmentCount: 3,
      dimensionCount: 13,
    });
    expect(normalizeDimensionKey('...', 13)).toEqual({
      ok: false,
      reason: 'too_short',
      segmentCount: 4,
      dimensionCount: 13,
    });
    expect(normalizeDimensionKey('A', 2)).toEqual({
      ok: false,
      reason: 'too_short',
      segmentCount: 1,
      dimensionCount: 2,
    });
  });

  it('trims extra trailing empty segments to dimensionCount', () => {
    // 14-segment key with one extra empty segment on a 13-dimension flow
    expect(normalizeDimensionKey('Q..USA...B1GQ......G1..', 13)).toEqual({
      ok: true,
      key: 'Q..USA...B1GQ......G1.',
    });
    // 15-segment key with two extra empty segments
    expect(normalizeDimensionKey('Q..USA...B1GQ......G1...', 13)).toEqual({
      ok: true,
      key: 'Q..USA...B1GQ......G1.',
    });
    // 14-segment key with trailing empty segments after B1GQ
    expect(normalizeDimensionKey('Q..USA...B1GQ........', 13)).toEqual({
      ok: true,
      key: 'Q..USA...B1GQ.......',
    });
    expect(normalizeDimensionKey('A..', 1)).toEqual({ ok: true, key: 'A' });
    expect(normalizeDimensionKey('...', 3)).toEqual({ ok: true, key: '..' });
  });

  it('rejects keys with any non-empty segment past dimensionCount as too_long', () => {
    expect(normalizeDimensionKey('Q..USA...B1GQ......G1..2025-Q1', 13)).toEqual({
      ok: false,
      reason: 'too_long',
      segmentCount: 14,
      dimensionCount: 13,
    });
    // Non-empty extra segment followed by another empty trailing segment
    expect(normalizeDimensionKey('Q..USA...B1GQ......G1..2025-Q1.', 13)).toEqual({
      ok: false,
      reason: 'too_long',
      segmentCount: 15,
      dimensionCount: 13,
    });
    expect(normalizeDimensionKey('A.B.C', 2)).toEqual({
      ok: false,
      reason: 'too_long',
      segmentCount: 3,
      dimensionCount: 2,
    });
  });
});

// ── isInvertedPeriodRange ─────────────────────────────────────────────────────

describe('isInvertedPeriodRange', () => {
  it.each([
    ['2024', '2020'],
    ['2024-Q2', '2024-Q1'],
    ['2024-S2', '2024-S1'],
    ['2024-05', '2024-04'],
    ['2024-M05', '2024-M04'],
    ['2024-04-01', '2024-03-31'],
    ['2024-Q2', '2024-03'],
    ['2024-03-01', '2024-02'],
    ['2024-S2', '2024-Q2'],
    ['2025-Q1', '2024'],
  ])('returns true when %s starts after %s ends', (start, end) => {
    expect(isInvertedPeriodRange(start, end)).toBe(true);
  });

  it.each([
    ['2020', '2024'],
    ['2024', '2024'],
    ['2024', '2024-Q1'],
    ['2024-Q1', '2024'],
    ['2024-Q4', '2024'],
    ['2024', '2024-Q4'],
    ['2024-02-29', '2024-02'],
    ['2024-Q1', '2024-03'],
    ['2024-01-01', '2024-01-01'],
  ])('returns false when %s and %s are ordered or overlapping', (start, end) => {
    expect(isInvertedPeriodRange(start, end)).toBe(false);
  });

  it.each([
    [undefined, '2020'],
    ['2024', undefined],
    [undefined, undefined],
    ['2024-Q5', '2020'],
    ['2024', 'FY2020'],
    ['bad', 'also-bad'],
  ])('returns false when either bound (%j, %j) is missing or unparseable', (start, end) => {
    expect(isInvertedPeriodRange(start, end)).toBe(false);
  });
});

// ── diagnoseKey and describeFindings ──────────────────────────────────────────

describe('diagnoseKey and describeFindings', () => {
  it('names the one pinned code with no data, given what OECD answered for its key', () => {
    const findings = diagnoseKey(parseAvailability(G4), QNA_DIMENSIONS, 'Q..US...B1GQ......G1.');

    expect(findings).toEqual([
      { caseOnly: [], dimensionId: 'REF_AREA', matchesNothing: true, withoutData: ['US'] },
    ]);
    expect(describeFindings(findings)).toEqual([
      'REF_AREA "US" has no data given the other segments',
    ]);
  });

  it('skips the pinned dimensions OECD left out of the read', () => {
    // FREQ, TRANSACTION, and TRANSFORMATION are pinned too, and G4 lists none of them.
    const findings = diagnoseKey(parseAvailability(G4), QNA_DIMENSIONS, 'Q..US...B1GQ......G1.');

    expect(findings.map((f) => f.dimensionId)).toEqual(['REF_AREA']);
  });

  it.each(['usa', 'Usa'])(
    'names %j, which matches an available code only by case, with the code OECD lists',
    (pinned) => {
      // OECD reads the code as `USA`, so the read for this key lists every dimension as G1 does.
      const findings = diagnoseKey(
        parseAvailability(G1),
        QNA_DIMENSIONS,
        `Q..${pinned}...B1GQ......G1.`,
      );

      expect(findings).toEqual([
        {
          caseOnly: [{ available: 'USA', pinned }],
          dimensionId: 'REF_AREA',
          matchesNothing: true,
          withoutData: [],
        },
      ]);
      expect(describeFindings(findings)).toEqual([
        `REF_AREA "${pinned}" matches "USA" only by case, and codes are case-sensitive`,
      ]);
    },
  );

  it('names both segments of a pair that match no series together', () => {
    // Each dimension's list is computed against the other segments, so a conflicting
    // pair shows up as two segments missing from their lists; every other pinned
    // dimension has nothing given the pair and is omitted.
    const read = availability({ FREQ: ['Q'], TRANSFORMATION: ['G1', 'GY'] });

    const findings = diagnoseKey(read, QNA_DIMENSIONS, 'A..USA...B1GQ......GCM.');

    expect(describeFindings(findings)).toEqual([
      'FREQ "A" has no data given the other segments',
      'TRANSFORMATION "GCM" has no data given the other segments',
    ]);
  });

  it('reports an OR segment with one code that has data as matching something', () => {
    const findings = diagnoseKey(availability({ FREQ: ['A', 'Q'] }), QNA_DIMENSIONS, 'Q+W');

    expect(findings).toEqual([
      { caseOnly: [], dimensionId: 'FREQ', matchesNothing: false, withoutData: ['W'] },
    ]);
  });

  it('lists every missing code of a segment in one clause', () => {
    const findings = diagnoseKey(availability({ FREQ: ['A', 'Q'] }), QNA_DIMENSIONS, 'W+X++Y');

    expect(describeFindings(findings)).toEqual([
      'FREQ "W", "X", "Y" have no data given the other segments',
    ]);
  });

  it('gives a case-only code its own clause, ahead of the codes with no data', () => {
    const findings = diagnoseKey(availability({ FREQ: ['A', 'Q'] }), QNA_DIMENSIONS, 'q+W');

    expect(findings[0]?.matchesNothing).toBe(true);
    expect(describeFindings(findings)).toEqual([
      'FREQ "q" matches "Q" only by case, and codes are case-sensitive',
      'FREQ "W" has no data given the other segments',
    ]);
  });

  it.each(['all', '', '.', '..'])('finds nothing in the every-series key %j', (key) => {
    expect(diagnoseKey(availability({ FREQ: ['A'] }), QNA_DIMENSIONS, key)).toEqual([]);
  });

  it('skips wildcard segments and segments past the last dimension', () => {
    const read = availability({ FREQ: ['A'], ADJUSTMENT: ['Y'] });
    const key = `${'.'.repeat(QNA_DIMENSIONS.length - 1)}.EXTRA`;

    expect(diagnoseKey(read, QNA_DIMENSIONS, key)).toEqual([]);
  });

  it('matches segments to dimensions by position, whatever order the dimensions arrive in', () => {
    const shuffled = [...QNA_DIMENSIONS].reverse();

    const findings = diagnoseKey(availability({ ADJUSTMENT: ['Y'] }), shuffled, '.N');

    expect(findings.map((f) => [f.dimensionId, f.withoutData])).toEqual([['ADJUSTMENT', ['N']]]);
  });

  it('describes no findings as no clauses', () => {
    expect(describeFindings([])).toEqual([]);
  });
});

// ── periodOutside ─────────────────────────────────────────────────────────────

describe('periodOutside', () => {
  /** The 2019 range OECD answered for a key pinned to one year. */
  const YEAR_2019 = { start: '2019-01-01', end: '2019-12-31' };

  const INSIDE = ['2019', '2019-Q2', '2019-S1', '2019-04', '2019-M04', '2019-04-15'];

  it.each(INSIDE)('reads %s as inside the range, as a start and as an end', (period) => {
    expect(periodOutside(YEAR_2019, period, undefined)).toBe(false);
    expect(periodOutside(YEAR_2019, undefined, period)).toBe(false);
    expect(periodOutside(YEAR_2019, period, period)).toBe(false);
  });

  it.each(['2020', '2020-Q1', '2020-S1', '2020-01', '2020-M01', '2020-01-01'])(
    'reads a start of %s as after the range',
    (period) => {
      expect(periodOutside(YEAR_2019, period, undefined)).toBe(true);
    },
  );

  it.each(['2018', '2018-Q4', '2018-S2', '2018-12', '2018-M12', '2018-12-31'])(
    'reads an end of %s as before the range',
    (period) => {
      expect(periodOutside(YEAR_2019, undefined, period)).toBe(true);
    },
  );

  it('counts a period that touches the range on its first or last day as inside', () => {
    expect(periodOutside(YEAR_2019, '2019-12-31', undefined)).toBe(false);
    expect(periodOutside(YEAR_2019, undefined, '2019-01-01')).toBe(false);
    expect(periodOutside(YEAR_2019, '2020-01-01', undefined)).toBe(true);
    expect(periodOutside(YEAR_2019, undefined, '2018-12-31')).toBe(true);
  });

  it('compares a start by its first day and an end by its last', () => {
    const fromMidQuarter = { start: '2019-02-15', end: '2019-11-15' };

    // Q4 starts on 1 October, before the range ends; Q1 ends on 31 March, after it starts.
    expect(periodOutside(fromMidQuarter, '2019-Q4', undefined)).toBe(false);
    expect(periodOutside(fromMidQuarter, undefined, '2019-Q1')).toBe(false);
    expect(periodOutside(fromMidQuarter, undefined, '2019-01')).toBe(true);
    expect(periodOutside(fromMidQuarter, '2019-12', undefined)).toBe(true);
    expect(periodOutside(fromMidQuarter, '2019-S2', '2019-S2')).toBe(false);
  });

  it('ends a February on its leap day', () => {
    const fromLeapDay = { start: '2020-02-29', end: '2020-12-31' };

    expect(periodOutside(fromLeapDay, undefined, '2020-02')).toBe(false);
    expect(periodOutside(fromLeapDay, undefined, '2020-M02')).toBe(false);
    expect(periodOutside(fromLeapDay, undefined, '2020-02-28')).toBe(true);
  });

  it('cannot tell when no period was requested', () => {
    expect(periodOutside(YEAR_2019, undefined, undefined)).toBeUndefined();
  });

  it.each(['2019-Q5', '2019-Q0', '2019-S3', '2019-13', '2019-00', '2019-W12', 'FY2019', '19'])(
    'cannot tell for the period code %s',
    (period) => {
      expect(periodOutside(YEAR_2019, period, undefined)).toBeUndefined();
      expect(periodOutside(YEAR_2019, undefined, period)).toBeUndefined();
      // One unreadable side leaves the whole answer unknown.
      expect(periodOutside(YEAR_2019, '2020', period)).toBeUndefined();
    },
  );
});

// ── Caller text timing ────────────────────────────────────────────────────────

/**
 * CPU growth of the two paths caller text takes here — a key checked against
 * the SDMX key set and read against an availability record, and a period
 * placed against a range — across a 64-fold span, on shapes built to make a
 * scan revisit what it has read. Thread CPU time, least of several trials,
 * with the 5k baseline re-timed beside each size.
 */
describe('caller text timing', () => {
  const BASE_CHARS = 5_000;
  const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const TRIALS = 5;
  /** Characters handled per measurement, so the 5k input is timed over a batch of calls. */
  const CHARS_PER_MEASUREMENT = 640_000;
  /** Per-call ceiling at any size, in microseconds of thread CPU time. */
  const CPU_CEILING_US = 100_000;
  const RANGE = { start: '2019-01-01', end: '2019-12-31' };
  const READ = parseAvailability(G1);
  const WILDCARDS = '.'.repeat(QNA_DIMENSIONS.length - 1);

  /** The key as `oecd_get_dimension_values` and `oecd_query_dataset` handle it, start to end. */
  function keyPath(key: string): number {
    if (!SDMX_KEY_SAFE.test(key)) return 0;
    return describeFindings(diagnoseKey(READ, QNA_DIMENSIONS, key)).length;
  }

  function periodPath(period: string): number {
    return periodOutside(RANGE, period, undefined) === undefined ? 0 : 1;
  }

  function cpuPerCallUs(run: (text: string) => number, text: string): number {
    const calls = Math.max(1, Math.round(CHARS_PER_MEASUREMENT / text.length));
    let sink = 0;
    const start = process.threadCpuUsage();
    for (let i = 0; i < calls; i++) sink += run(text);
    const { user, system } = process.threadCpuUsage(start);
    expect(sink).toBeGreaterThanOrEqual(0);
    return (user + system) / calls;
  }

  /** Double the input from 10k to 320k, checking the bound at each size before the next. */
  function expectLinear(run: (text: string) => number, build: (n: number) => string): void {
    const base = build(BASE_CHARS);
    for (const size of SIZES) {
      const sample = build(size);
      let leastGrowth = Number.POSITIVE_INFINITY;
      let leastCpu = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < TRIALS; trial++) {
        const baseline = cpuPerCallUs(run, base);
        const cpu = cpuPerCallUs(run, sample);
        leastGrowth = Math.min(leastGrowth, cpu / baseline);
        leastCpu = Math.min(leastCpu, cpu);
      }
      expect(leastGrowth, `growth at ${size} characters`).toBeLessThan(4 * (size / BASE_CHARS));
      expect(leastCpu, `CPU per call at ${size} characters`).toBeLessThan(CPU_CEILING_US);
    }
  }

  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['OR codes that all match', (n: number) => `${'Q+'.repeat(n / 2)}Q${WILDCARDS}`],
    ['OR codes that all miss', (n: number) => `${'ZZ+'.repeat(n / 3)}ZZ${WILDCARDS}`],
    ['OR codes that match by case', (n: number) => `${'q+'.repeat(n / 2)}q${WILDCARDS}`],
    ['segments past the last dimension', (n: number) => `Q${'.'.repeat(n)}`],
  ])('reads a key linearly on %s', (_shape, build) => expectLinear(keyPath, build), 0);

  it.each([
    ['one long line ending in a break', (n: number) => `2019-${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => `${'  \r\n'.repeat(n / 4)}2019`],
    ['a long digit run', (n: number) => '1'.repeat(n)],
    ['openers that never close', (n: number) => '2019-Q'.repeat(n / 6)],
    ['padding around a valid code', (n: number) => `2019${' '.repeat(n)}`],
  ])('places a period linearly on %s', (_shape, build) => expectLinear(periodPath, build), 0);
});

// ── readAvailability ──────────────────────────────────────────────────────────

const ROOT = 'https://fake.oecd.test';
const QNA_FLOW_REF = 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD';
const QNA_DSD = { dataRoot: ROOT, flowRef: QNA_FLOW_REF, serviceRoot: ROOT };
const QNA_AVAILABILITY = `${ROOT}/availableconstraint/OECD.SDD.NAD,DSD_NAMAIN1%40DF_QNA_EXPENDITURE_GROWTH_OECD`;

/** A `200` availability answer with OECD's own caching header on `/public/rest`. */
function cacheable(message: unknown): ScriptedAnswer {
  return {
    body: JSON.stringify(message),
    headers: { 'cache-control': 'public,max-age=7200', 'content-type': 'application/json' },
    kind: 'answer',
  };
}

describe('readAvailability', () => {
  const config = getServerConfig();
  const configured = { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
  let fake: ScriptedFetch | undefined;

  function serve(answer: (url: string, index: number) => ScriptedAnswer): ScriptedFetch {
    fake = installScriptedFetch(answer);
    return fake;
  }

  beforeEach(() => {
    config.baseUrl = ROOT;
    config.timeoutMs = 5000;
    initStructureService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.assign(config, configured);
    initStructureService();
    const installed = fake;
    fake = undefined;
    installed?.restore();
  });

  it('reads the key on the datastructure’s data root, in one request', async () => {
    const http = serve(() => cacheable(G4));
    const delegated = {
      dataRoot: `${ROOT}/sti-public/rest`,
      flowRef: QNA_FLOW_REF,
      serviceRoot: `${ROOT}/sti-public/rest`,
    };

    const outcome = await readAvailability(
      new UpstreamBudget(),
      delegated,
      'Q..US...B1GQ......G1.',
    );

    expect(http.requests.map((r) => r.url)).toEqual([
      `${ROOT}/sti-public/rest/availableconstraint/OECD.SDD.NAD,DSD_NAMAIN1%40DF_QNA_EXPENDITURE_GROWTH_OECD/Q..US...B1GQ......G1./all/all?mode=available`,
    ]);
    expect(outcome).toEqual({ availability: parseAvailability(G4), kind: 'read' });
  });

  it.each([undefined, '', '..'])('sends the every-series key for %j', async (key) => {
    const http = serve(() => cacheable(G1));

    await readAvailability(new UpstreamBudget(), QNA_DSD, key);

    expect(http.requests.map((r) => r.url)).toEqual([
      `${QNA_AVAILABILITY}/all/all/all?mode=available`,
    ]);
  });

  it.each([
    [400, 'OECD answered HTTP 400'],
    [403, 'OECD answered HTTP 403'],
    [404, 'OECD answered HTTP 404'],
    [422, 'OECD answered HTTP 422'],
    [429, 'OECD answered HTTP 429'],
    [500, 'OECD answered HTTP 500'],
    [503, 'OECD answered HTTP 503'],
  ])('degrades an HTTP %i to a failure naming it, after one request', async (status, clause) => {
    const http = serve(() => ({ body: 'Refused', kind: 'answer', status }));

    const outcome = await readAvailability(new UpstreamBudget(), QNA_DSD, undefined);

    expect(outcome).toEqual({ failure: clause, kind: 'failed' });
    expect(http.requests.map((r) => r.url)).toEqual([
      `${QNA_AVAILABILITY}/all/all/all?mode=available`,
    ]);
  });

  it.each([
    ['a body that is not JSON', { body: '<html>Maintenance</html>', kind: 'answer' } as const],
    ['JSON without the SDMX shape', json({ data: { contentConstraints: {} } })],
  ])('degrades %s to an unreadable-body failure, after one request', async (_case, answer) => {
    const http = serve(() => answer);

    const outcome = await readAvailability(new UpstreamBudget(), QNA_DSD, undefined);

    expect(outcome).toEqual({
      failure: 'OECD answered with a body this server could not read',
      kind: 'failed',
    });
    expect(http.requests).toHaveLength(1);
  });

  it('degrades an unreachable host to a failure saying so', async () => {
    const network = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', network);

    const outcome = await readAvailability(new UpstreamBudget(), QNA_DSD, undefined);

    expect(outcome).toEqual({ failure: 'OECD could not be reached', kind: 'failed' });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('degrades a request still unanswered at OECD_TIMEOUT_MS, without a retry', async () => {
    vi.useFakeTimers({ now: 0 });
    const http = serve(() => STALL);

    const read = observe(readAvailability(new UpstreamBudget(), QNA_DSD, undefined));
    const { outcome, pendingBefore } = await runUntil(read, 5000);

    expect(pendingBefore).toBe(true);
    expect(outcome).toEqual({
      status: 'fulfilled',
      value: { failure: 'OECD did not answer within OECD_TIMEOUT_MS', kind: 'failed' },
    });
    expect(http.requests).toHaveLength(1);
  });

  it('lets the call’s budget running out through as the budget’s expiry', async () => {
    vi.useFakeTimers({ now: 0 });
    const budget = new UpstreamBudget();
    // The call has spent 47 s of its 50 s on the reads before this one.
    vi.setSystemTime(47_000);
    const http = serve(() => STALL);

    const read = observe(readAvailability(budget, QNA_DSD, undefined));
    const { pendingBefore } = await runUntil(read, 50_000);

    expect(pendingBefore).toBe(true);
    const error = await rejectionOf(read);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(isBudgetExpiry(error)).toBe(true);
    expect(http.requests).toHaveLength(1);
  });

  it('lets the caller’s cancellation through as RequestCancelled', async () => {
    vi.useFakeTimers({ now: 0 });
    const caller = new AbortController();
    // The caller gives up once the request is on the wire, which never answers.
    const http = serve(() => {
      queueMicrotask(() => caller.abort());
      return STALL;
    });

    const read = observe(readAvailability(new UpstreamBudget(caller.signal), QNA_DSD, undefined));
    // Far past OECD_TIMEOUT_MS: a read that ignored the abort would settle as a timeout.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(read.settledAtMs).toBe(0);
    expect(await rejectionOf(read)).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(http.requests).toHaveLength(1);
  });

  it('serves a repeat read of the same key from the structure cache', async () => {
    const http = serve(() => cacheable(G4));

    const first = await readAvailability(new UpstreamBudget(), QNA_DSD, 'Q..US...B1GQ......G1.');
    const second = await readAvailability(new UpstreamBudget(), QNA_DSD, 'Q..US...B1GQ......G1.');

    expect(http.requests).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('keeps each key, and each root, apart in the cache', async () => {
    const http = serve(() => cacheable(G1));
    // Production-shaped roots, both ending in `/rest`: only what comes before it tells them apart.
    const publicRoot = `${ROOT}/public/rest`;
    const stiRoot = `${ROOT}/sti-public/rest`;
    const configured = { ...QNA_DSD, dataRoot: publicRoot };
    const delegated = { ...QNA_DSD, dataRoot: stiRoot };
    const path = '/availableconstraint/OECD.SDD.NAD,DSD_NAMAIN1%40DF_QNA_EXPENDITURE_GROWTH_OECD';

    await readAvailability(new UpstreamBudget(), configured, undefined);
    await readAvailability(new UpstreamBudget(), configured, 'Q............');
    await readAvailability(new UpstreamBudget(), delegated, undefined);

    expect(http.requests.map((r) => r.url)).toEqual([
      `${publicRoot}${path}/all/all/all?mode=available`,
      `${publicRoot}${path}/Q............/all/all?mode=available`,
      `${stiRoot}${path}/all/all/all?mode=available`,
    ]);
  });

  it('never stores a failure, so the next read asks again', async () => {
    let reads = 0;
    const http = serve(() => {
      reads += 1;
      return reads === 1
        ? { body: 'Internal server error', kind: 'answer', status: 500 }
        : cacheable(G1);
    });

    const failed = await readAvailability(new UpstreamBudget(), QNA_DSD, undefined);
    const read = await readAvailability(new UpstreamBudget(), QNA_DSD, undefined);

    expect(failed.kind).toBe('failed');
    expect(read).toEqual({ availability: parseAvailability(G1), kind: 'read' });
    expect(http.requests.map((r) => r.url)).toEqual([
      `${QNA_AVAILABILITY}/all/all/all?mode=available`,
      `${QNA_AVAILABILITY}/all/all/all?mode=available`,
    ]);
  });

  /**
   * Ten of the delegated catalog entries — DF_ITIC among them — have a
   * datastructure the configured root also holds, so the datastructure's
   * `serviceRoot` is the configured root while its `dataRoot` is the root the
   * catalog entry delegates to. Their availability record lives on the data
   * root; the configured root answers the read with a 500.
   */
  describe('for a delegated dataflow whose datastructure the configured root holds', () => {
    const DELEGATED_ROOT = `${ROOT}/sti-public/rest`;
    const ITIC_DSD = {
      dataRoot: DELEGATED_ROOT,
      flowRef: 'OECD.SDD.TPS,DSD_ITIC@DF_ITIC',
      serviceRoot: ROOT,
    };
    const ITIC_PATH =
      '/availableconstraint/OECD.SDD.TPS,DSD_ITIC%40DF_ITIC/all/all/all?mode=available';
    const CONFIGURED_READ = `${ROOT}${ITIC_PATH}`;
    const DELEGATED_READ = `${DELEGATED_ROOT}${ITIC_PATH}`;
    const INTERNAL_ERROR: ScriptedAnswer = {
      body: 'Internal server error',
      kind: 'answer',
      status: 500,
    };

    /** Answer the read on either root; any other request fails the test at restore. */
    function serveRoots(answers: {
      configured?: ScriptedAnswer;
      delegated?: ScriptedAnswer;
    }): ScriptedFetch {
      const routes = new Map<string, ScriptedAnswer>([
        [CONFIGURED_READ, answers.configured ?? INTERNAL_ERROR],
        [DELEGATED_READ, answers.delegated ?? cacheable(G2)],
      ]);
      return serve((url) => {
        const answer = routes.get(url);
        if (!answer) throw new Error(`Unexpected request: ${url}`);
        return answer;
      });
    }

    it('reads on the data root in one request, not on the root that defined the datastructure', async () => {
      const http = serveRoots({});

      const outcome = await readAvailability(new UpstreamBudget(), ITIC_DSD, undefined);

      expect(outcome).toEqual({ availability: parseAvailability(G2), kind: 'read' });
      expect(http.requests.map((r) => r.url)).toEqual([DELEGATED_READ]);
    });

    it('degrades the data root’s own refusal after that one request', async () => {
      const http = serveRoots({ delegated: { body: 'Busy', kind: 'answer', status: 503 } });

      const outcome = await readAvailability(new UpstreamBudget(), ITIC_DSD, undefined);

      expect(outcome).toEqual({ failure: 'OECD answered HTTP 503', kind: 'failed' });
      expect(http.requests.map((r) => r.url)).toEqual([DELEGATED_READ]);
    });

    it.each<[string, string, string, AvailabilityOutcome]>([
      [
        'the configured root',
        ROOT,
        CONFIGURED_READ,
        { failure: 'OECD answered HTTP 500', kind: 'failed' },
      ],
      [
        'the delegated root',
        DELEGATED_ROOT,
        DELEGATED_READ,
        { availability: parseAvailability(G2), kind: 'read' },
      ],
    ])(
      'reads on %s when the caller names it, in one request',
      async (_case, root, url, outcome) => {
        const http = serveRoots({});

        expect(await readAvailability(new UpstreamBudget(), ITIC_DSD, undefined, root)).toEqual(
          outcome,
        );
        expect(http.requests.map((r) => r.url)).toEqual([url]);
      },
    );

    it('serves a repeat read from the cache, with no request', async () => {
      const http = serveRoots({});

      const first = await readAvailability(new UpstreamBudget(), ITIC_DSD, undefined);
      const second = await readAvailability(new UpstreamBudget(), ITIC_DSD, undefined);

      expect(second).toEqual(first);
      expect(http.requests.map((r) => r.url)).toEqual([DELEGATED_READ]);
    });
  });
});
