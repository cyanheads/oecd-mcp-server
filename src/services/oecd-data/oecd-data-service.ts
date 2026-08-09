/**
 * @fileoverview OECD SDMX data service — wraps the observations endpoint and decodes SDMX-JSON v2.
 * @module services/oecd-data/oecd-data-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { fetchOecd, upstreamStatus } from '@/services/oecd-http/oecd-http.js';
import { parseFlowRef } from '@/services/oecd-structure/oecd-structure-service.js';

/**
 * Allowed characters in an SDMX dimension key segment value.
 * Keys are dot-delimited; each segment is alphanumeric/underscore/hyphen or empty (wildcard).
 * The '+' separator (multi-value) and trailing dots (wildcards) are also permitted.
 * Reject path-traversal sequences and special chars that could alter the URL structure.
 */
const SDMX_KEY_SAFE = /^[A-Za-z0-9._+%-]*$/;

import type { DecodedRow, OecdColumn, OecdDataResult } from './types.js';

const DATA_ACCEPT = 'application/vnd.sdmx.data+json;version=2.0';

/**
 * Attribute whose code ID is the base-10 exponent the observation value is
 * expressed in — `0` = Units, `9` = Billions, `15` = Quadrillions (shared SDMX
 * codelist `SDMX,CL_UNIT_MULT`).
 */
const UNIT_MULT = 'UNIT_MULT';

/**
 * Largest `|exponent|` any UNIT_MULT codelist in the catalog gives a meaning.
 * `SDMX,CL_UNIT_MULT` stops at `15` (Quadrillions); the three OECD-local
 * variants extend it to `-15` (Quadrillionths) and add `9999`, a sentinel for
 * "." rather than a power of ten. Read as an exponent it scales the
 * observation to `Infinity`, which JSON serializes as `null` — so an
 * out-of-range code leaves the value at the magnitude OECD published and
 * leaves its label on the row for the caller to see.
 */
const MAX_UNIT_MULT_EXPONENT = 15;

/** Statuses handled here rather than surfaced as a server fault. */
const HANDLED_STATUSES = [
  // No matching series, and an unknown dataflow, both arrive as 404.
  404,
  // A malformed key or an unparseable period, with the explanation in the body.
  400, 422,
];

/** Fetch and parse one observations response. */
async function fetchDataJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchOecd(url, {
    accept: DATA_ACCEPT,
    expectedStatuses: HANDLED_STATUSES,
    operation: 'oecdDataFetch',
    ...(signal ? { signal } : {}),
  });
  return res.json().catch((err: unknown) => {
    throw serializationError(
      'OECD data API returned a body that is not SDMX-JSON',
      {},
      {
        cause: err,
      },
    );
  });
}

/**
 * Restate a failed observations fetch as the outcome the caller acts on.
 *
 * OECD answers a wrong-arity key and an unparseable period with a 4xx whose
 * plain-text body names the mistake; that text is the whole value of the
 * response, so it rides through on the message and on `data.body`. Everything
 * else keeps the classification `fetchOecd` produced — a retried-and-exhausted
 * 503 stays `ServiceUnavailable`, a caller abort stays an abort.
 */
function dataFetchFailure(err: unknown, flowRef: string): McpError {
  const upstream = upstreamStatus(err);
  if (upstream?.status === 404) {
    return notFound(`Dataflow not found: ${flowRef}`, { flowRef, status: 404 }, { cause: err });
  }
  if (upstream && (upstream.status === 400 || upstream.status === 422)) {
    const detail = upstream.body.trim();
    return validationError(
      detail === ''
        ? `OECD rejected the query for ${flowRef}`
        : `OECD rejected the query: ${detail}`,
      { body: detail, flowRef, status: upstream.status },
      { cause: err },
    );
  }
  if (err instanceof McpError) {
    return new McpError(err.code, `Failed to fetch OECD data for ${flowRef}`, err.data, {
      cause: err,
    });
  }
  return serviceUnavailable(`Failed to fetch OECD data for ${flowRef}`, {}, { cause: err });
}

/**
 * Explanatory text from a query OECD refused because the key or the period is
 * wrong. Tool handlers use it to pick the contract reason and to pass OECD's
 * own wording through to the caller. Returns undefined for any other failure.
 */
export function invalidQueryText(err: unknown): string | undefined {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.ValidationError) return;
  const body = err.data?.body;
  return typeof body === 'string' && body.trim() !== '' ? body.trim() : err.message;
}

/**
 * Explanatory text from a query OECD throttled. OECD names which limit was hit
 * — request rate, or the separate cap on downloads and very large data ranges
 * — and only that wording tells the two apart, so tool handlers read it to
 * pick between "wait" and "ask for less". Returns undefined for any failure
 * that is not a throttle.
 */
export function throttleText(err: unknown): string | undefined {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.RateLimited) return;
  const body = err.data?.body;
  return typeof body === 'string' && body.trim() !== '' ? body.trim() : err.message;
}

let _instance: OecdDataService | undefined;

/** Service for fetching and decoding OECD SDMX observation data. */
export class OecdDataService {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Fetch observations for a dataflow, decoding SDMX-JSON with AllDimensions mode.
   *
   * @param flowRef - e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`
   * @param key - dot-delimited dimension key, e.g. `A.USA.B1GQ..`
   * @param startPeriod - ISO date string or period code, e.g. `2010`
   * @param endPeriod - ISO date string or period code, e.g. `2023`
   * @param signal - optional AbortSignal
   */
  async fetchData(
    flowRef: string,
    key: string,
    startPeriod?: string,
    endPeriod?: string,
    signal?: AbortSignal,
  ): Promise<OecdDataResult> {
    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw new Error(`Invalid flow_ref format: ${flowRef}`);
    }

    // Validate the key before inserting it into the URL path.
    // SDMX keys use dots as dimension separators, '+' for multi-value, and alphanumerics/underscores.
    // Reject any characters that could alter the URL path structure (e.g. '/', '\0', '?', '#').
    if (!SDMX_KEY_SAFE.test(key)) {
      throw validationError('Dimension key contains characters SDMX does not allow', { flowRef });
    }

    // URL-encode `@` in the combined flowId
    const encodedFlowId = `${parts.dsdId}%40${parts.dfId}`;
    let url = `${this.baseUrl}/data/${parts.agencyId},${encodedFlowId}/${key}?dimensionAtObservation=AllDimensions`;
    if (startPeriod) url += `&startPeriod=${encodeURIComponent(startPeriod)}`;
    if (endPeriod) url += `&endPeriod=${encodeURIComponent(endPeriod)}`;

    const retryOpts = { maxRetries: 2, ...(signal ? { signal } : {}) };
    let parsed: unknown;
    try {
      parsed = await withRetry(() => fetchDataJson(url, signal), retryOpts);
    } catch (err) {
      const upstream = upstreamStatus(err);
      // OECD reports "the query was valid, nothing matched" as a 404.
      if (
        upstream?.status === 404 &&
        (upstream.body.includes('NoResultsFound') || upstream.body.includes('no result'))
      ) {
        return { columns: [], rowCount: 0, rows: [], source: 'OECD' };
      }
      throw dataFetchFailure(err, flowRef);
    }

    return decodeObservations(parsed);
  }
}

export function initDataService(): void {
  const config = getServerConfig();
  _instance = new OecdDataService(config.baseUrl);
}

export function getDataService(): OecdDataService {
  if (!_instance) throw new Error('OecdDataService not initialized');
  return _instance;
}

// ── SDMX-JSON v2 AllDimensions decoder ───────────────────────────────────────

/** One declared dimension or attribute, with its code positions resolved to labels. */
interface ComponentValues {
  id: string;
  values: Array<{ id: string; label: string } | undefined>;
}

/**
 * Index a component list by position.
 *
 * Enumerated components carry `{ id, name }`; uncoded ones — `REF_YEAR_PRICE`
 * is the common case — carry a bare `{ value }`, so the label falls back
 * through both before the ID. A component declared on the DSD but unused in the
 * slice has an empty `values` array and can never resolve.
 */
function indexComponents(components: Array<Record<string, unknown>>): ComponentValues[] {
  return components.map((component) => ({
    id: String(component.id ?? ''),
    values: ((component.values ?? []) as Array<Record<string, unknown>>).map((v) => {
      const label = v.name ?? v.value ?? v.id;
      return label === undefined || label === null
        ? undefined
        : { id: String(v.id ?? ''), label: String(label) };
    }),
  }));
}

/**
 * Shift a value by a power of ten through its decimal literal rather than a
 * float multiply — `16868402.705 * 1e6` lands on `16868402704999.998`, while
 * re-parsing `"16868402.705e6"` is exact. Values already in exponential
 * notation produce an unparseable literal and fall back to the multiply.
 */
function applyScale(value: number, exponent: number): number {
  if (exponent === 0) return value;
  const shifted = Number(`${value}e${exponent}`);
  return Number.isFinite(shifted) ? shifted : value * 10 ** exponent;
}

function decodeObservations(data: unknown): OecdDataResult {
  const root = data as Record<string, unknown>;
  const dataRoot = root?.data as Record<string, unknown> | undefined;
  const dataSets = (dataRoot?.dataSets ?? []) as Array<Record<string, unknown>>;
  const structures = (dataRoot?.structures ?? []) as Array<Record<string, unknown>>;

  if (!dataSets.length || !structures.length) {
    return { columns: [], rowCount: 0, rows: [], source: 'OECD' };
  }

  // Safe: length checks above guarantee both arrays have at least one element
  const dataSet = dataSets[0] as Record<string, unknown>;
  const structure = structures[0] as Record<string, unknown>;

  // AllDimensions: all dimensions are at observation level
  const dimsMeta = structure?.dimensions as Record<string, unknown> | undefined;
  const attrsMeta = structure?.attributes as Record<string, unknown> | undefined;
  const dimensions = indexComponents(
    (dimsMeta?.observation ?? []) as Array<Record<string, unknown>>,
  );
  const attributes = indexComponents(
    (attrsMeta?.observation ?? []) as Array<Record<string, unknown>>,
  );

  /**
   * Declared shape, not observed shape. An attribute that resolves on only a
   * handful of rows still gets a column, so a consumer sizing itself from a
   * sample of the rows does not drop it.
   */
  const columns: OecdColumn[] = [
    { name: 'value', type: 'number' },
    { name: 'value_scale', type: 'number' },
    { name: 'source', type: 'string' },
    ...dimensions.map((d): OecdColumn => ({ name: d.id, type: 'string' })),
    ...attributes
      .filter((a) => a.values.length > 0)
      .map((a): OecdColumn => ({ name: a.id, type: 'string' })),
  ];

  /**
   * Observations are `[obsValue, attrIdx0, attrIdx1, …]` keyed by a
   * colon-delimited dimension index tuple, e.g. `"0:0:2:3:0:0"` — so attribute
   * n sits at array position n + 1.
   */
  const observations = (dataSet.observations ?? {}) as Record<string, Array<unknown>>;

  const rows: DecodedRow[] = [];

  for (const [key, obsValues] of Object.entries(observations)) {
    const indices = key.split(':').map(Number);
    // Key order is the rendered column order — keep it aligned with `columns`.
    const row: DecodedRow = { value: null, value_scale: 1, source: 'OECD' };

    for (let i = 0; i < indices.length; i++) {
      const dimMeta = dimensions[i];
      if (!dimMeta) continue;
      const idx = indices[i];
      if (idx === undefined) continue;
      const valueEntry = dimMeta.values[idx];
      if (!valueEntry) continue;
      // Use the label (human-readable)
      row[dimMeta.id] = valueEntry.label;
    }

    let exponent = 0;
    for (let i = 0; i < attributes.length; i++) {
      const attrMeta = attributes[i];
      if (!attrMeta) continue;
      const idx = obsValues[i + 1];
      if (typeof idx !== 'number') continue;
      const valueEntry = attrMeta.values[idx];
      if (!valueEntry) continue;
      row[attrMeta.id] = valueEntry.label;
      if (attrMeta.id === UNIT_MULT) {
        const declared = Number(valueEntry.id);
        if (Number.isInteger(declared) && Math.abs(declared) <= MAX_UNIT_MULT_EXPONENT) {
          exponent = declared;
        }
      }
    }

    const numVal = obsValues[0];
    row.value = typeof numVal === 'number' ? applyScale(numVal, exponent) : null;
    row.value_scale = 10 ** exponent;

    rows.push(row);
  }

  return { columns, rowCount: rows.length, rows, source: 'OECD' };
}
