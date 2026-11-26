/**
 * @fileoverview oecd_query_dataset — fetch observations from an OECD dataflow, staging a result too large for the inline preview on DataCanvas.
 * @module mcp-server/tools/definitions/query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  CanvasIdSchema,
  type CanvasInstance,
  type ColumnSchema,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';
import {
  getDataService,
  invalidQueryText,
  SDMX_KEY_SAFE,
} from '@/services/oecd-data/oecd-data-service.js';
import type { OecdDataResult } from '@/services/oecd-data/types.js';
import { throttleText, upstreamRefusal } from '@/services/oecd-http/oecd-http.js';
import { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  availabilityKey,
  describeFindings,
  diagnoseKey,
  isInvertedPeriodRange,
  normalizeDimensionKey,
  type OecdAvailability,
  periodOutside,
  readAvailability,
} from '@/services/oecd-structure/availability.js';
import {
  getStructureService,
  isDataflowNotFound,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { OecdDimension } from '@/services/oecd-structure/types.js';
import { formatTable } from '@/utils/format-table.js';

/** A decoded observation row as it leaves the handler. */
type OutputRow = Record<string, string | number | null>;

/** The one value a component holds on every row of a result. */
interface ConstantColumn {
  code: string;
  label: string;
}

/** Components that hold one value across a result, keyed by component ID in structure order. */
type ConstantColumns = Record<string, ConstantColumn>;

/**
 * Character threshold for spilling to DataCanvas: the `JSON.stringify` length
 * of `constant_columns` plus the accumulated length of the rows taken so far.
 * When DataCanvas is configured and the result crosses this threshold, every
 * decoded row stages on the canvas and the inline response carries a short
 * preview head capped at {@link SPILL_PREVIEW_ROWS}.
 */
const INLINE_BUDGET_CHARS = 100_000;

/** Maximum preview rows returned alongside a spilled DataCanvas handle. */
const SPILL_PREVIEW_ROWS = 25;

/** Alphabet of the suffix a generated canvas table name carries after `spilled_`. */
const TABLE_NAME_HEX = '0123456789abcdef';

/**
 * Number of leading rows that fit {@link INLINE_BUDGET_CHARS} beside the
 * constants. The first row that crosses the budget is excluded, so a spill
 * triggers whenever the result exceeds the threshold and a gigantic single row
 * still yields zero preview rows rather than blowing the inline budget.
 */
function inlineRowCount(rows: readonly OutputRow[], constantColumns: ConstantColumns): number {
  let chars = JSON.stringify(constantColumns).length;
  for (const [index, row] of rows.entries()) {
    chars += JSON.stringify(row).length;
    if (chars > INLINE_BUDGET_CHARS) return index;
  }
  return rows.length;
}

/**
 * Split a decoded result into the components that hold one value on every row
 * — label and code alike — and the rows carrying only what varies.
 *
 * Constancy is a property of the whole result, never of a preview slice, so a
 * spilled preview never asserts one value for a table that holds several. A
 * component missing from some rows, or carrying one label under two codes,
 * varies. Per-row `source` leaves the rows as well, since the top-level
 * `source` already carries it; `value` and `value_scale` always stay.
 */
function hoistConstantColumns(result: OecdDataResult): {
  constantColumns: ConstantColumns;
  rows: OutputRow[];
} {
  const codeColumns = new Set(result.columns.flatMap((c) => c.codeColumn ?? []));
  const constantColumns: ConstantColumns = {};
  const hoisted = new Set(['source']);
  const [first] = result.rows;

  for (const { codeColumn, name } of result.columns) {
    if (name === 'value' || name === 'value_scale' || name === 'source') continue;
    if (codeColumns.has(name)) continue;
    const label = first?.[name];
    const code = codeColumn ? first?.[codeColumn] : label;
    if (typeof label !== 'string' || typeof code !== 'string') continue;
    const constant = result.rows.every(
      (row) => row[name] === label && (!codeColumn || row[codeColumn] === code),
    );
    if (!constant) continue;
    constantColumns[name] = { code, label };
    hoisted.add(name);
    if (codeColumn) hoisted.add(codeColumn);
  }

  // Every key a decoded row holds is a declared column, written in column order.
  const kept = result.columns.map((c) => c.name).filter((name) => !hoisted.has(name));
  const rows = result.rows.map((row) => {
    const out: OutputRow = {};
    for (const key of kept) {
      const value = row[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  });
  return { constantColumns, rows };
}

// Passthrough schema — dimension keys are dynamic per-dataflow and cannot be
// enumerated at schema definition time. z.object({}).passthrough() forwards all
// fields to structuredContent without linter false-positives for undefined keys.
const DecodedRowSchema = z
  .object({})
  .passthrough()
  .describe(
    'Decoded observation row: "value" — the observation already multiplied by "value_scale", the power of ten from UNIT_MULT (1 when the dataflow declares no multiplier; divide value by it for the figure as OECD published it) — plus one key per dimension and attribute that varies across the result (e.g. REF_AREA, TIME_PERIOD, OBS_STATUS), holding its human-readable label, with "<ID>_code" beside each coded one (REF_AREA: "Germany", REF_AREA_code: "DEU"). TIME_PERIOD and uncoded attributes carry no _code key, since their value is the code. An attribute with no value on this row is omitted. Components holding one value on every row are in constant_columns instead.',
  );

/** Words that only appear in OECD's period-format rejections, never its key-arity ones. */
const PERIOD_REJECTION = /\b(date|period)\b/i;

/**
 * Words that appear in OECD's response-size throttle and not in its
 * request-rate one. The two arrive as the same 429 and need opposite advice:
 * the rate limit clears on its own, the size limit only clears if the query
 * shrinks. An unrecognized throttle body falls back to the rate-limit reason,
 * whose recovery is the safe answer for either.
 */
const DOWNLOAD_THROTTLE = /\b(downloads?|data ranges?)\b/i;

/**
 * Which of OECD's two throttles refused the query, read off its own wording.
 * Only this tool splits them: the download cap clears by asking for less, and
 * this is the only surface whose caller has a key and a period to shrink.
 */
function throttleReason(throttle: string): 'download_limit' | 'rate_limited' {
  return DOWNLOAD_THROTTLE.test(throttle) ? 'download_limit' : 'rate_limited';
}

/**
 * The most of the call's budget the `no_results` diagnosis spends. The empty
 * result is already the answer, so a stalled or throttled diagnosis read must
 * not hold it back for the rest of the call.
 */
const DIAGNOSIS_CAP_MS = 10_000;

/** A query that matched no observations. */
interface EmptyQuery {
  endPeriod: string | undefined;
  flowRef: string;
  key: string;
  lastNObservations: number | undefined;
  /** The root that answered the query, and so holds the key's availability record. */
  serviceRoot: string;
  startPeriod: string | undefined;
}

/**
 * Why a query matched no observations, as one raw clause for the `no_results`
 * message, or undefined when OECD's availability record for the key does not
 * say.
 *
 * Best-effort beside an answer the call already has: the datastructure read
 * (which the structure cache serves once the dataflow has been looked up) and
 * one unretried availability read on the root that answered the query, both
 * spending `budget` — the caller's share of the call, {@link DIAGNOSIS_CAP_MS}
 * at most. Every failure an `McpError` describes — an HTTP status, a timeout, an
 * unreadable body, that share running out — leaves the message as it was,
 * because the empty result stands either way. The caller's cancellation, and a
 * throw that is not an `McpError` and so is this server's own fault, pass
 * through.
 */
async function emptyResultCause(
  budget: UpstreamBudget,
  query: EmptyQuery,
): Promise<string | undefined> {
  try {
    const dsd = await getStructureService().fetchDataStructure(budget, query.flowRef);
    const read = await readAvailability(budget, dsd, query.key, query.serviceRoot);
    return read.kind === 'read' ? causeOf(read.availability, dsd.dimensions, query) : undefined;
  } catch (err) {
    if (budget.signal?.aborted || !(err instanceof McpError)) throw err;
    return;
  }
}

/**
 * The cause the availability record gives, most specific first: the pinned
 * segments none of whose codes has data given the rest of the key, each code
 * that matches only by letter case named as such; then a key whose pinned
 * segments OECD records no series for together; then a period wholly outside
 * the range the key's series cover; then `last_n_observations` with
 * `end_period`, which OECD applies in that order.
 */
function causeOf(
  availability: OecdAvailability,
  dimensions: readonly OecdDimension[],
  query: EmptyQuery,
): string | undefined {
  const blocking = diagnoseKey(availability, dimensions, query.key).filter(
    (finding) => finding.matchesNothing,
  );
  if (blocking.length > 0) return describeFindings(blocking).join('; ');
  const pinsASegment =
    availabilityKey(query.key) !== 'all' && query.key.split('.').some((segment) => segment !== '');
  if (availability.observationCount === 0 && pinsASegment) {
    return "the key's pinned segments match no series together";
  }
  const range = availability.timeRange;
  if (range && periodOutside(range, query.startPeriod, query.endPeriod)) {
    return `the requested period lies outside ${range.start} to ${range.end}, the range OECD records for this key`;
  }
  if (query.lastNObservations !== undefined && query.endPeriod !== undefined) {
    return `last_n_observations (${query.lastNObservations}) is applied before end_period ("${query.endPeriod}"), so series whose latest observations are newer than end_period return nothing — omit end_period for the latest observations, or drop last_n_observations and bound the window with start_period / end_period`;
  }
  return;
}

export const oecdQueryDataset = tool('oecd_query_dataset', {
  description:
    'Fetch observations from an OECD dataflow filtered by a dimension key, optional time range, and optional last_n_observations. Returns one row per observation, sorted by dimension code and then period, carrying the dimensions and attributes that vary — each label with its SDMX code beside it as <ID>_code — and values already scaled by the unit multiplier; the components holding one value across the whole result come back once, in constant_columns. Large multi-country time-series spill to a DataCanvas table holding every column, codes included, returning a preview head of up to 25 rows — inspect columns with oecd_dataframe_describe, then query the full table with SQL using oecd_dataframe_query; without DataCanvas every row comes back inline on both surfaces. Call oecd_get_dataset_info first to learn the dimension order for constructing the key.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    flow_ref: z
      .string()
      .describe(
        'Full flow reference — e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I", or the bare "OECD.TAD.ARP,DF_AEI2024_DASHBOARD" form for a dataflow published without a datastructure prefix. Obtain from oecd_search_datasets and pass it through unchanged.',
      ),
    key: z
      .string()
      .describe(
        'Dot-delimited dimension key matching the dimension order from oecd_get_dataset_info. Empty segments are wildcards; "+" separates multiple values per segment. Example: "A.USA+DEU.B1GQ.." — Annual, USA or Germany, GDP, all remaining dimensions.',
      ),
    start_period: z
      .string()
      .optional()
      .describe(
        'Start of the time range — ISO period code such as "2010", "2010-Q1", or "2010-01". Omit to include all history (may produce very large results).',
      ),
    end_period: z
      .string()
      .optional()
      .describe(
        'End of the time range — ISO period code such as "2023" or "2023-Q4". Omit to include up to the latest available period.',
      ),
    last_n_observations: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe(
        'Return only the most recent N observations per series (SDMX lastNObservations, 1 to 100,000). OECD applies lastNObservations to each series before start_period / end_period, so setting end_period before a series’s latest N periods excludes those observations — omit end_period when asking for the latest N observations.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID from a prior oecd_query_dataset call — exactly 10 characters of letters, digits, hyphens, and underscores — to stage this result alongside that one if it spills; a result that fits inline comes back inline and leaves that canvas unchanged. Omit to let the server mint a canvas if this result needs one; a canvas_id comes back only when the result was large enough to spill.',
    ),
  }),
  output: z.object({
    rows: z
      .array(DecodedRowSchema)
      .describe(
        "Observation rows, sorted by each dimension's code in key order with TIME_PERIOD last. Every row of the result when truncated is absent; a leading preview head of up to 25 rows when truncated is true — query the canvas table for the rest.",
      ),
    row_count: z.number().describe('Total rows in the result (or on the canvas when truncated).'),
    constant_columns: z
      .record(
        z.string(),
        z
          .object({
            code: z
              .string()
              .describe(
                'SDMX code of the value — for TIME_PERIOD and an uncoded attribute, the published value itself.',
              ),
            label: z.string().describe('Human-readable label of the value.'),
          })
          .describe('The one value this component holds on every row.'),
      )
      .describe(
        'Each dimension and attribute holding one value on every row of the whole result — the staged canvas table included, not only the rows returned here — keyed by component ID in structure order: dimensions in key order, then attributes. These components are left out of rows. Empty when every component varies.',
      ),
    query_flow_ref: z.string().describe('Flow reference used in this query.'),
    query_key: z.string().describe('Dimension key used in this query.'),
    query_start_period: z
      .string()
      .optional()
      .describe('Start period filter applied in this query, if any.'),
    query_end_period: z
      .string()
      .optional()
      .describe('End period filter applied in this query, if any.'),
    query_last_n_observations: z
      .number()
      .optional()
      .describe('Most recent N observations per series filter applied in this query, if any.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas handle for the staged result. Present only when DataCanvas is configured and the result exceeded the inline threshold; absent when DataCanvas is off, and absent when it is on but the result fit inline. Pass to oecd_dataframe_query or oecd_dataframe_describe.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'Canvas table name holding the full result — present when canvas_id is set. Inspect columns with oecd_dataframe_describe, then query this table with SQL using oecd_dataframe_query.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows is a preview head of up to 25 rows and the full result was staged on DataCanvas; omitted entirely (never false) when rows holds the complete result. Use oecd_dataframe_query with the canvas_id for analytics over the full set.',
      ),
    source: z.literal('OECD').describe('Data source attribution — always "OECD".'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'How to inspect and query the staged result, including its canvas_id and table name; present only after a spill.',
      ),
  },
  errors: [
    {
      reason: 'invalid_flow_ref',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The flow_ref parameter matches neither the {agencyID},{dsd_id}@{df_id} nor the {agencyID},{df_id} format.',
      recovery:
        'Obtain valid flow_ref values from oecd_search_datasets and pass one unchanged, e.g. "OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I".',
    },
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The flow_ref does not correspond to a known OECD dataflow.',
      recovery: 'Verify the flow_ref using oecd_search_datasets before querying.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dataflow exists but no observations matched the key and time range.',
      recovery:
        'Broaden the key (use empty segments as wildcards) or extend the time range. To list the codes of a dimension that have data given the rest of this key, call oecd_get_dimension_values with that dimension_id, available_only: true, and this same key.',
    },
    {
      reason: 'invalid_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The key holds a character outside the SDMX key set, fewer dot-delimited segments than the dataflow has dimensions, a non-empty segment past the dimension count, or a format OECD rejected.',
      recovery:
        'Use oecd_get_dataset_info to check dimension order and count, then rebuild the dot-delimited key matching that order — pass time filters via start_period / end_period instead of an extra segment.',
    },
    {
      reason: 'invalid_period',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_period is after end_period, or OECD could not parse start_period or end_period.',
      recovery:
        'Ensure start_period is on or before end_period and format each as an ISO code matching the dataflow frequency — "2022" for annual, "2022-Q1" for quarterly, "2022-01" for monthly.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      when: "OECD throttled the request rate and was still refusing after the retries, or asked for a wait longer than the call's upstream budget had left.",
      recovery:
        'Wait several seconds before calling again, and space out consecutive queries ' +
        'rather than issuing them back to back.',
    },
    {
      reason: 'download_limit',
      code: JsonRpcErrorCode.RateLimited,
      retryable: false,
      when: 'OECD refused the query for exceeding its data-download or data-range limit.',
      recovery:
        'Shrink the query itself — name fewer values per key segment, or set a shorter ' +
        'start_period / end_period span — because waiting will not clear this limit.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id has expired or was never created. It is checked before anything is fetched from OECD.',
      recovery:
        'Check the canvas_id was copied exactly, or retry without it; a result that spills comes back with a fresh canvas_id. An expired canvas takes its tables with it, so re-run the queries that staged them, passing the new canvas_id.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      when: "An OECD request ran past OECD_TIMEOUT_MS, or the call's requests and retries together ran past its upstream budget — 50 seconds, or OECD_TIMEOUT_MS when that is longer.",
      recovery:
        'Split the query into smaller key or period slices so each answer arrives sooner, or raise OECD_TIMEOUT_MS when the whole range must come back in one call — a value past 50 seconds also needs a client that waits that long for a tool result.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: true,
      when: 'OECD returned a server fault or was unreachable once the retries ran out.',
      recovery:
        'Retry after a short pause; if it keeps failing, check OECD API availability ' +
        'before issuing further queries.',
    },
    {
      reason: 'upstream_redirect',
      code: JsonRpcErrorCode.Forbidden,
      retryable: false,
      when: 'The configured OECD host answered with a redirect, which this server never follows.',
      recovery:
        'Stop retrying and report the server configuration — OECD_BASE_URL must name the https ' +
        'origin that answers directly, and no wait clears a redirect.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'OECD refused the request with a status this server does not model — an authorization challenge, a rejection from something sitting in front of the API, a request read as malformed, or a method it does not implement (HTTP 501).',
      recovery:
        'Retry once; a repeat is not transient, so report the HTTP status and OECD text this error carries and check that OECD_BASE_URL names the public SDMX API rather than a proxy in front of it.',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      retryable: false,
      when: 'OECD answered with a body this server could not read — not JSON, or JSON whose fields do not have the shape SDMX gives them.',
      recovery:
        'Narrow the key or the period and call again; the same request returns the same body, so repeating it unchanged will not help.',
    },
  ],

  async handler(input, ctx) {
    const parts = parseFlowRef(input.flow_ref);
    if (!parts) {
      throw ctx.fail(
        'invalid_flow_ref',
        `flow_ref "${input.flow_ref}" is not in the expected {agencyID},{dsd_id}@{df_id} or {agencyID},{df_id} format`,
      );
    }

    if (!SDMX_KEY_SAFE.test(input.key)) {
      throw ctx.fail(
        'invalid_key',
        `Key "${input.key}" holds a character outside the SDMX key set — letters, digits, ".", "+", "_", "-", and "%"`,
      );
    }

    if (isInvertedPeriodRange(input.start_period, input.end_period)) {
      throw ctx.fail(
        'invalid_period',
        `start_period "${input.start_period}" is after end_period "${input.end_period}"`,
      );
    }

    /**
     * Resolve a caller's canvas before the download, so a stale or mistyped id
     * fails without spending an OECD download. Resolving an existing id mints
     * nothing, and the instance is reused if the result spills. The re-raise is
     * what puts this tool's recovery on the wire: the framework's own hint on
     * the acquire failure would otherwise win, and it points back at this same
     * call. No fallback to a fresh canvas — the caller passed the id to keep
     * tables together for a join.
     */
    const canvas = getCanvas();
    let callerCanvas: CanvasInstance | undefined;
    if (canvas && input.canvas_id !== undefined) {
      try {
        callerCanvas = await canvas.acquire(input.canvas_id, ctx);
      } catch (err) {
        if (err instanceof McpError && err.data?.reason === 'canvas_not_found') {
          throw ctx.fail(
            'canvas_not_found',
            `Canvas "${input.canvas_id}" not found or expired`,
            undefined,
            { cause: err },
          );
        }
        throw err;
      }
    }

    // One budget for key validation, the query, and — when it matches nothing — a capped share for diagnosis.
    const budget = new UpstreamBudget(ctx.signal);

    let normalizedKey = input.key;
    if (availabilityKey(input.key) !== 'all') {
      let dimensionCount: number;
      try {
        dimensionCount = await getStructureService().fetchDimensionCount(budget, input.flow_ref);
      } catch (err) {
        const e = err as Error;
        if (isDataflowNotFound(e)) {
          throw ctx.fail('dataflow_not_found', `Dataflow not found: ${input.flow_ref}`, undefined, {
            cause: e,
          });
        }
        const refusal = upstreamRefusal(e);
        if (refusal) {
          throw ctx.fail(refusal.reason, refusal.message, undefined, { cause: e });
        }
        throw err;
      }

      const keyCheck = normalizeDimensionKey(input.key, dimensionCount);
      if (!keyCheck.ok) {
        if (keyCheck.reason === 'too_short') {
          throw ctx.fail(
            'invalid_key',
            `Key "${input.key}" has ${keyCheck.segmentCount} ${keyCheck.segmentCount === 1 ? 'segment' : 'segments'}, but ${input.flow_ref} has ${keyCheck.dimensionCount} dimensions — one segment each, empty for a wildcard`,
          );
        }
        throw ctx.fail(
          'invalid_key',
          `Key "${input.key}" has ${keyCheck.segmentCount} segments, but ${input.flow_ref} has ${keyCheck.dimensionCount} dimensions — pass time filters via start_period / end_period instead of an extra key segment`,
        );
      }
      normalizedKey = keyCheck.key;
    }

    ctx.log.info('Querying OECD dataset', {
      flowRef: input.flow_ref,
      key: normalizedKey,
      startPeriod: input.start_period,
      endPeriod: input.end_period,
      lastNObservations: input.last_n_observations,
    });

    let dataResult: OecdDataResult;
    try {
      dataResult = await getDataService().fetchData(
        budget,
        input.flow_ref,
        normalizedKey,
        input.start_period,
        input.end_period,
        input.last_n_observations,
      );
    } catch (err) {
      const e = err as Error;
      if (isDataflowNotFound(e)) {
        throw ctx.fail('dataflow_not_found', `Dataflow not found: ${input.flow_ref}`, undefined, {
          cause: e,
        });
      }
      const rejection = invalidQueryText(e);
      if (rejection !== undefined) {
        // OECD's own wording names the mistake; the two cases need different fixes.
        if (PERIOD_REJECTION.test(rejection)) {
          throw ctx.fail(
            'invalid_period',
            `OECD rejected the time range for ${input.flow_ref}: ${rejection}`,
            undefined,
            { cause: e },
          );
        }
        throw ctx.fail(
          'invalid_key',
          `OECD rejected the dimension key "${normalizedKey}": ${rejection}`,
          undefined,
          { cause: e },
        );
      }
      const throttle = throttleText(e);
      if (throttle !== undefined) {
        const reason = throttleReason(throttle);
        throw ctx.fail(
          reason,
          `OECD throttled the query for ${input.flow_ref}: ${throttle}`,
          undefined,
          { cause: e },
        );
      }
      const refusal = upstreamRefusal(e);
      if (refusal) {
        throw ctx.fail(refusal.reason, refusal.message, undefined, { cause: e });
      }
      throw err;
    }

    if (dataResult.rows.length === 0) {
      const cause = await emptyResultCause(budget.within(DIAGNOSIS_CAP_MS), {
        endPeriod: input.end_period,
        flowRef: input.flow_ref,
        key: normalizedKey,
        lastNObservations: input.last_n_observations,
        serviceRoot: dataResult.serviceRoot,
        startPeriod: input.start_period,
      });
      throw ctx.fail(
        'no_results',
        `No observations found for key "${normalizedKey}" in ${input.flow_ref}${cause ? `: ${cause}.` : ''}`,
      );
    }

    ctx.log.info('OECD data fetched', { rowCount: dataResult.rows.length });

    const { constantColumns, rows } = hoistConstantColumns(dataResult);

    // Only a result that exceeds the inline threshold needs a canvas, so an omitted id mints one only here.
    if (canvas) {
      const shown = inlineRowCount(rows, constantColumns);
      if (shown < rows.length) {
        const instance = callerCanvas ?? (await canvas.acquire(undefined, ctx));
        /**
         * Declare the schema rather than letting the provider sniff it. Attribute
         * columns are sparse — one that resolves on no row inside the sniff window
         * would be missing from the registered table entirely, so a later SQL
         * query against it fails instead of returning nulls.
         */
        const schema: ColumnSchema[] = dataResult.columns.map((column) => ({
          name: column.name,
          type: column.type === 'number' ? 'DOUBLE' : 'VARCHAR',
        }));
        /**
         * The table takes the decoded rows whole — `source`, every constant, and
         * every code — so SQL never has to join `constant_columns` back in. The
         * decision to stage is the threshold's above, over what the caller
         * receives: a full row serializes differently from a hoisted one, so
         * `spillover()`'s own drain over the full rows could disagree with it.
         */
        const handle = await instance
          .registerTable(
            `spilled_${idGenerator.generateRandomString(8, TABLE_NAME_HEX)}`,
            dataResult.rows,
            { schema, signal: ctx.signal },
          )
          .catch(async (err: unknown) => {
            if (instance.isNew) {
              try {
                await canvas.drop(instance.canvasId, ctx);
              } catch (cleanupError) {
                ctx.log.warning('Failed to release a canvas after staging failed', {
                  cleanupError,
                });
              }
            }
            throw err;
          });

        /**
         * A notice is authored Markdown, and the canvas_id can be the caller's.
         * Both identifiers are code spans: neither can hold a backtick (canvas IDs
         * are `[A-Za-z0-9_-]{10}`, generated table names `spilled_<hex>`), so the
         * notice reads the same on both surfaces and copies without escapes.
         */
        ctx.enrich.notice(
          `The full result is in table \`${handle.tableName}\` on canvas \`${instance.canvasId}\`. Call oecd_dataframe_describe with this canvas_id to inspect columns, then oecd_dataframe_query with this canvas_id and SQL to query the full table.`,
        );
        return {
          rows: rows.slice(0, Math.min(SPILL_PREVIEW_ROWS, shown)),
          row_count: handle.rowCount,
          constant_columns: constantColumns,
          query_flow_ref: input.flow_ref,
          query_key: normalizedKey,
          query_start_period: input.start_period,
          query_end_period: input.end_period,
          ...(input.last_n_observations !== undefined
            ? { query_last_n_observations: input.last_n_observations }
            : {}),
          canvas_id: instance.canvasId,
          table_name: handle.tableName,
          truncated: true,
          source: 'OECD' as const,
        };
      }
    }

    return {
      rows,
      row_count: rows.length,
      constant_columns: constantColumns,
      query_flow_ref: input.flow_ref,
      query_key: normalizedKey,
      query_start_period: input.start_period,
      query_end_period: input.end_period,
      ...(input.last_n_observations !== undefined
        ? { query_last_n_observations: input.last_n_observations }
        : {}),
      source: 'OECD' as const,
    };
  },

  format: (result) => {
    /**
     * Union the keys across every row, not just the first. Attributes are
     * sparse, so a column that only appears further down the result would
     * otherwise be dropped from the table.
     */
    const allKeys = [...new Set(result.rows.flatMap((r) => Object.keys(r)))];
    const rows = result.rows.map((r) => allKeys.map((k) => String(r[k] ?? '')));
    const constants = Object.entries(result.constant_columns);

    const periodRange =
      result.query_start_period || result.query_end_period
        ? ` | Period: ${escapeMarkdownInline(result.query_start_period ?? '…')} – ${escapeMarkdownInline(result.query_end_period ?? '…')}`
        : '';
    const lastN =
      result.query_last_n_observations !== undefined
        ? ` | Last N: ${result.query_last_n_observations}`
        : '';

    const scaled = result.rows.some(
      (r) => typeof r.value_scale === 'number' && r.value_scale !== 1,
    );

    const note =
      result.truncated && result.canvas_id
        ? `\n> Truncated — showing the first ${result.rows.length} of ${result.row_count} rows. The rest is on DataCanvas (canvas_id: ${escapeMarkdownInline(result.canvas_id)}, table: ${escapeMarkdownInline(String(result.table_name))}).\n`
        : `\n> Not truncated — all ${result.rows.length} rows of the result are shown below.\n`;

    const lines = [
      `**OECD Dataset Query** — ${result.row_count} observations`,
      `Query: ${escapeMarkdownInline(result.query_flow_ref)} key=${escapeMarkdownInline(result.query_key)}${periodRange}${lastN}`,
      note,
      scaled
        ? '> Values are scaled by the unit multiplier (UNIT_MULT) — divide `value` by `value_scale` for the figure as OECD published it.\n'
        : '',
      '',
      constants.length > 0
        ? `**Constant on every row**\n\n${formatTable(
            ['component', 'code', 'label'],
            constants.map(([component, { code, label }]) => [component, code, label]),
          )}\n`
        : '',
      result.rows.length > 0 ? formatTable(allKeys, rows) : '_(no rows)_',
      '',
      `Source: ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
