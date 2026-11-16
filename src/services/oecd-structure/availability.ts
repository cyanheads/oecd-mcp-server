/**
 * @fileoverview OECD's `availableconstraint` read — which codes of each
 * dimension have data given a key, the key's `TIME_PERIOD` range, and its
 * observation count — and what that says about a key that matches nothing.
 * Shared by oecd_get_dimension_values (`available_only`) and the `no_results`
 * diagnosis of oecd_query_dataset.
 * @module services/oecd-structure/availability
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { NORMALIZED_AWAY_KEY } from '@/services/oecd-data/oecd-data-service.js';
import { upstreamStatus } from '@/services/oecd-http/oecd-http.js';
import { isBudgetExpiry, type UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import { getStructureService } from './oecd-structure-service.js';
import type { OecdDataStructure, OecdDimension } from './types.js';

/** What OECD reports as available for a dataflow under one key. */
export interface OecdAvailability {
  /**
   * Codes with data per dimension ID, in OECD's order. In `mode=available` each
   * dimension's list holds the codes that have data given the key's *other*
   * segments, so a dimension's own pinned code does not narrow its list. A
   * dimension OECD leaves out has no code with data given the other segments.
   */
  readonly codes: ReadonlyMap<string, readonly string[]>;
  /** OECD's `obs_count` annotation — observations under the key. Undefined when OECD sends none. */
  readonly observationCount: number | undefined;
  /**
   * OECD's inclusive `TIME_PERIOD` bounds as `YYYY-MM-DD`. Undefined when no
   * series matches, which OECD signals with an inverted `9999-01-01` …
   * `0001-12-31` range, or when it sends no range.
   */
  readonly timeRange: { readonly end: string; readonly start: string } | undefined;
}

/** The outcome of a best-effort availability read. */
export type AvailabilityOutcome =
  | { readonly availability: OecdAvailability; readonly kind: 'read' }
  /** `failure` says what went wrong, in a clause fit for a notice. */
  | { readonly failure: string; readonly kind: 'failed' };

/** The key as the availability URL carries it: `all` for no key or an every-series key. */
export function availabilityKey(key: string | undefined): string {
  return key === undefined || key === '' || NORMALIZED_AWAY_KEY.test(key) ? 'all' : key;
}

/**
 * Read what OECD has data for under `key`: one unretried request, best-effort,
 * through the structure cache, spending what is left of the call's `budget`.
 *
 * The record lives on the root that serves the dataflow's data, so the read
 * goes to `root`: the datastructure's {@link OecdDataStructure.dataRoot} unless
 * the caller holds more direct evidence — `oecd_query_dataset` passes the
 * `OecdDataResult.serviceRoot` that answered its query. It is not the
 * datastructure's `serviceRoot`, because the configured root also defines the
 * datastructure of some delegated dataflows and answers their availability read
 * with a 500.
 *
 * Any failure OECD answers for — an HTTP status, a timeout at
 * `OECD_TIMEOUT_MS`, an unreachable host, a body this server cannot read —
 * becomes `failed`, so the caller's primary answer stands. Three throws pass
 * through: the caller's cancellation, the call's budget running out (everything
 * after this read waits on the same exhausted clock), and anything that is not
 * an `McpError`, which is this server's own fault.
 *
 * `root` becomes the request URL, so it must have passed the origin check: a
 * datastructure's `dataRoot` or a data result's `serviceRoot`.
 */
export async function readAvailability(
  budget: UpstreamBudget,
  dsd: Pick<OecdDataStructure, 'dataRoot' | 'flowRef'>,
  key: string | undefined,
  root: string = dsd.dataRoot,
): Promise<AvailabilityOutcome> {
  // The path percent-encodes the `@` of a combined flow ref.
  const flow = dsd.flowRef.replaceAll('@', '%40');
  try {
    const availability = await getStructureService().readStructure(budget, {
      attempts: 'once',
      decode: parseAvailability,
      failureMessage: `Failed to fetch OECD availability for ${dsd.flowRef}`,
      url: `${root}/availableconstraint/${flow}/${availabilityKey(key)}/all/all?mode=available`,
    });
    return { availability, kind: 'read' };
  } catch (err) {
    if (budget.signal?.aborted || isBudgetExpiry(err) || !(err instanceof McpError)) throw err;
    if (err.code === JsonRpcErrorCode.RequestCancelled) throw err;
    return { failure: failureClause(err), kind: 'failed' };
  }
}

/** What went wrong with a failed read, as a clause: "OECD answered HTTP 500". */
function failureClause(err: McpError): string {
  const status = upstreamStatus(err)?.status;
  if (status !== undefined) return `OECD answered HTTP ${status}`;
  switch (err.code) {
    case JsonRpcErrorCode.Timeout:
      return 'OECD did not answer within OECD_TIMEOUT_MS';
    case JsonRpcErrorCode.SerializationError:
      return 'OECD answered with a body this server could not read';
    default:
      return 'OECD could not be reached';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Decode an `availableconstraint` structure message. A field of the wrong type
 * throws `TypeError`, which the read reports as an unreadable body.
 */
export function parseAvailability(payload: unknown): OecdAvailability {
  const constraints = (payload as { data: { contentConstraints: unknown[] } }).data
    .contentConstraints;
  const constraint = constraints[0] as Record<string, unknown> | undefined;
  if (!constraint) throw new TypeError('availableconstraint answered with no content constraint');

  const codes = new Map<string, string[]>();
  let start: string | undefined;
  let end: string | undefined;
  for (const region of constraint.cubeRegions as Array<Record<string, unknown>>) {
    if (region.isIncluded === false) continue;
    for (const entry of region.keyValues as Array<Record<string, unknown>>) {
      const id = entry.id;
      if (typeof id !== 'string') throw new TypeError('availability key value without an id');
      const range = entry.timeRange as Record<string, { period?: unknown }> | undefined;
      if (range) {
        start = earlier(start, isoDate(range.startPeriod?.period));
        end = later(end, isoDate(range.endPeriod?.period));
        continue;
      }
      // A string would iterate as one code per character.
      if (!Array.isArray(entry.values)) {
        throw new TypeError(`availability values of ${id} are not a list`);
      }
      const listed = codes.get(id) ?? [];
      for (const value of entry.values) {
        if (typeof value !== 'string') {
          throw new TypeError(`availability value of ${id} is not a code`);
        }
        if (!listed.includes(value)) listed.push(value);
      }
      codes.set(id, listed);
    }
  }

  const annotations = (constraint.annotations ?? []) as Array<Record<string, unknown>>;
  const count = annotations.find((a) => a.id === 'obs_count')?.title;
  return {
    codes,
    observationCount: typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : undefined,
    // The inverted sentinel orders start after end; so would any range with no series.
    timeRange: start && end && start <= end ? { end, start } : undefined,
  };
}

function isoDate(period: unknown): string | undefined {
  return typeof period === 'string' && ISO_DATE.test(period) ? period.slice(0, 10) : undefined;
}

function earlier(a: string | undefined, b: string | undefined): string | undefined {
  return a === undefined || (b !== undefined && b < a) ? b : a;
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  return a === undefined || (b !== undefined && b > a) ? b : a;
}

/** What one pinned segment of a key looks like against the availability read for that key. */
export interface SegmentFinding {
  /** Pinned codes matching an available code only by letter case, each with the code OECD lists. */
  readonly caseOnly: ReadonlyArray<{ readonly available: string; readonly pinned: string }>;
  readonly dimensionId: string;
  /** True when no pinned code in the segment matches an available code exactly. */
  readonly matchesNothing: boolean;
  /** Pinned codes with no available counterpart, exact or by case. */
  readonly withoutData: readonly string[];
}

/**
 * Compare each pinned segment of `key` against the codes OECD lists for its
 * dimension. `availability` must be the read for this same key.
 *
 * A segment is reported when one of its codes is missing from its dimension's
 * list or matches an entry there only by case — the availability endpoint
 * matches case-insensitively, the data endpoint does not. A dimension OECD left
 * out of the read entirely is not reported: in `mode=available` that follows
 * from some other segment, which is the one reported.
 */
export function diagnoseKey(
  availability: OecdAvailability,
  dimensions: readonly OecdDimension[],
  key: string,
): SegmentFinding[] {
  if (availabilityKey(key) === 'all') return [];
  const ordered = [...dimensions].sort((a, b) => a.position - b.position);
  const findings: SegmentFinding[] = [];
  for (const [index, segment] of key.split('.').entries()) {
    const dimension = ordered[index];
    const listed = dimension && availability.codes.get(dimension.id);
    if (!dimension || !listed || segment === '') continue;
    const byCase = new Map(listed.map((code) => [code.toLowerCase(), code]));
    const pinned = segment.split('+').filter((code) => code !== '');
    const caseOnly: Array<{ available: string; pinned: string }> = [];
    const withoutData: string[] = [];
    let exact = 0;
    for (const code of pinned) {
      if (listed.includes(code)) exact += 1;
      else {
        const available = byCase.get(code.toLowerCase());
        if (available) caseOnly.push({ available, pinned: code });
        else withoutData.push(code);
      }
    }
    if (caseOnly.length > 0 || withoutData.length > 0) {
      findings.push({
        caseOnly,
        dimensionId: dimension.id,
        matchesNothing: exact === 0,
        withoutData,
      });
    }
  }
  return findings;
}

/**
 * The findings as one clause each, raw text: `REF_AREA "US" has no data given
 * the other segments`, `REF_AREA "usa" matches "USA" only by case`.
 */
export function describeFindings(findings: readonly SegmentFinding[]): string[] {
  return findings.flatMap((finding) => [
    ...finding.caseOnly.map(
      ({ available, pinned }) =>
        `${finding.dimensionId} "${pinned}" matches "${available}" only by case, and codes are case-sensitive`,
    ),
    ...(finding.withoutData.length > 0
      ? [
          `${finding.dimensionId} ${finding.withoutData.map((code) => `"${code}"`).join(', ')} ${
            finding.withoutData.length === 1 ? 'has' : 'have'
          } no data given the other segments`,
        ]
      : []),
  ]);
}

/** First and last day of an SDMX period code (`2019`, `2019-Q2`, `2019-S1`, `2019-04`, `2019-M04`, `2019-04-15`). */
function periodDays(code: string): { first: string; last: string } | undefined {
  const match = /^(\d{4})(?:-(?:([QS])(\d)|M?(\d{2})(?:-(\d{2}))?))?$/.exec(code.trim());
  if (!match) return;
  const [, year, unit, part, month, day] = match;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastOfMonth = (m: number) => pad(new Date(Date.UTC(Number(year), m, 0)).getUTCDate());
  if (day && month) return { first: `${year}-${month}-${day}`, last: `${year}-${month}-${day}` };
  let firstMonth = 1;
  let lastMonth = 12;
  if (month) {
    firstMonth = Number(month);
    lastMonth = firstMonth;
  } else if (unit) {
    const span = unit === 'Q' ? 3 : 6;
    lastMonth = Number(part) * span;
    firstMonth = lastMonth - span + 1;
  }
  if (firstMonth < 1 || lastMonth > 12) return;
  return {
    first: `${year}-${pad(firstMonth)}-01`,
    last: `${year}-${pad(lastMonth)}-${lastOfMonth(lastMonth)}`,
  };
}

/**
 * Whether a requested period lies wholly outside `range`. Undefined when that
 * cannot be told — no period requested, or a period code this reader does not
 * parse.
 */
export function periodOutside(
  range: { readonly end: string; readonly start: string },
  startPeriod: string | undefined,
  endPeriod: string | undefined,
): boolean | undefined {
  if (startPeriod === undefined && endPeriod === undefined) return;
  const from = startPeriod === undefined ? undefined : periodDays(startPeriod)?.first;
  const to = endPeriod === undefined ? undefined : periodDays(endPeriod)?.last;
  if ((startPeriod !== undefined && !from) || (endPeriod !== undefined && !to)) return;
  return (from !== undefined && from > range.end) || (to !== undefined && to < range.start);
}
