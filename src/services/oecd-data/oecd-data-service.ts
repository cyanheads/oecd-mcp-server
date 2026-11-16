/**
 * @fileoverview OECD SDMX data service — wraps the observations endpoint and decodes SDMX-JSON v2.
 * @module services/oecd-data/oecd-data-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import {
  decodeUpstream,
  fetchOecd,
  type RequestWindow,
  readJsonBody,
  upstreamStatus,
} from '@/services/oecd-http/oecd-http.js';
import type { UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import {
  fetchExternalServiceRoot,
  parseFlowRef,
} from '@/services/oecd-structure/oecd-structure-service.js';
import type { DecodedRow, OecdColumn, OecdDataResult } from './types.js';

/**
 * Allowed characters in an SDMX dimension key segment value.
 * Keys are dot-delimited; each segment is alphanumeric/underscore/hyphen or empty (wildcard).
 * The '+' separator (multi-value) and trailing dots (wildcards) are also permitted.
 * Reject path-traversal sequences and special chars that could alter the URL structure.
 */
export const SDMX_KEY_SAFE = /^[A-Za-z0-9._+%-]*$/;

/**
 * All-wildcard keys that URL normalization removes.
 *
 * The key occupies one path segment, so a key of `.` or `..` is read as a
 * relative path reference and resolved away before the request is sent — `..`
 * takes the flow reference with it and OECD answers the remainder with
 * `Invalid structure: data`. Both are the every-series selection for a two- or
 * three-dimension dataflow, which is exactly the `key_example` those dataflows
 * advertise. SDMX spells the same selection as `all`, which survives
 * normalization; longer wildcard keys (`...`) are unaffected.
 *
 * The pattern covers the percent-encoded spellings too. URL parsing treats
 * `%2e` as a dot when it decides whether a segment is a dot reference, so
 * `%2e%2e` resolves away exactly as `..` does.
 */
export const NORMALIZED_AWAY_KEY = /^(?:\.|%2e){1,2}$/i;

const DATA_ACCEPT = 'application/vnd.sdmx.data+json;version=2.0';

/** Plain-text query rejection shapes OECD also returns with HTTP 403. */
const KEY_REJECTION = /^Not enough key values in query, expecting \d+ got \d+$/i;
const DATE_REJECTION = /^Semantic Error - Invalid Date Format `[^<>\r\n]*`$/i;

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
  // What a root answers for a dataflow it catalogues without hosting. Whether
  // that is a fault at all is settled a request later, by the catalog lookup —
  // a query the delegation carries to a successful answer should not have
  // reported an upstream fault along the way. One that turns out to be a real
  // fault surfaces where every other failed query does, at the tool boundary.
  500,
];

/**
 * Withhold the retry from a deadline that fired while the body was arriving.
 *
 * By then OECD has answered — the headers are in and the observations are
 * streaming — and the answer is larger than `OECD_TIMEOUT_MS` lets through.
 * Repeating the request repeats that download from the start: another of the
 * data downloads OECD allows each hour, and most likely another full timeout,
 * twice over before the caller hears anything. One request, then
 * `upstream_timeout`, whose recovery is to ask for less. A deadline that fires
 * before the headers says nothing about the size of the answer and keeps its
 * retries.
 */
function unretriedBodyTimeout(err: unknown): unknown {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.Timeout) return err;
  return withoutRetries(err);
}

/** The same failure, marked so `withRetry` surfaces it on the attempt that raised it. */
function withoutRetries(err: McpError): McpError {
  return new McpError(err.code, err.message, { ...err.data, retryable: false }, { cause: err });
}

/** Fetch and parse one observations response inside one request's share of the budget. */
async function fetchDataJson(url: string, window: RequestWindow): Promise<unknown> {
  const res = await fetchOecd(
    url,
    { accept: DATA_ACCEPT, expectedStatuses: HANDLED_STATUSES, operation: 'oecdDataFetch' },
    window,
  );
  return readJsonBody(res).catch((err: unknown) => {
    throw unretriedBodyTimeout(err);
  });
}

/**
 * Fetch one observations response, retrying the failures worth retrying inside
 * whatever the call's budget has left.
 *
 * `maxRetries` is the caller's because the attempts at a root are not always a
 * fresh allowance — a query resumed after the catalog lookup ruled delegation
 * out has already spent one of them.
 */
function loadObservations(budget: UpstreamBudget, url: string, maxRetries = 2): Promise<unknown> {
  return budget.retry((attempt) => fetchDataJson(url, attempt), maxRetries);
}

/**
 * Restate a failed observations fetch as the outcome the caller acts on.
 *
 * OECD answers a wrong-arity key and an unparseable period with a 4xx whose
 * plain-text body names the mistake; that text is the whole value of the
 * response, so it rides through on the message and on `data.body`. Everything
 * else keeps the classification the request produced — a retried-and-exhausted
 * 503 or a connection dropped while the body was arriving stays
 * `ServiceUnavailable`, a caller abort stays an abort — and a failure that
 * carries none is reported as an outage.
 */
function dataFetchFailure(err: unknown, flowRef: string): McpError {
  const upstream = upstreamStatus(err);
  const detail = upstream?.body.trim();
  if (upstream?.status === 404) {
    return notFound(`Dataflow not found: ${flowRef}`, { flowRef, status: 404 }, { cause: err });
  }
  if (
    upstream &&
    detail !== undefined &&
    (upstream.status === 400 ||
      upstream.status === 422 ||
      (upstream.status === 403 && (KEY_REJECTION.test(detail) || DATE_REJECTION.test(detail))))
  ) {
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
 *
 * Only this service's own rejections qualify — the 4xx relabel and the
 * key-character check, both of which name the flow on `data.flowRef`. A
 * `ValidationError` raised before any request left, as for an `OECD_BASE_URL`
 * that is not http or https, is a configuration fault and carries none.
 */
export function invalidQueryText(err: unknown): string | undefined {
  if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.ValidationError) return;
  if (typeof err.data?.flowRef !== 'string') return;
  const body = err.data?.body;
  return typeof body === 'string' && body.trim() !== '' ? body.trim() : err.message;
}

/**
 * How OECD spells "the query was valid and matched nothing", which it answers
 * with a 404 rather than a 200 carrying no observations. The sentinel is not
 * uniform across the service roots — `sti-public` returns `NoResultsFound` and
 * `dcd-public` returns `NoRecordsFound` for the same outcome — and a root that
 * genuinely does not hold the dataflow says so in prose instead
 * (`Could not find Dataflow and/or DSD related with this data request`), which
 * stays a not-found.
 */
const NO_MATCH_BODY = /No(?:Results|Records)Found|no result/;

/**
 * An empty result from `serviceRoot` for the failure OECD reports as one.
 * Returns undefined for every other failure.
 */
function emptyResultFor(err: unknown, serviceRoot: string): OecdDataResult | undefined {
  const upstream = upstreamStatus(err);
  if (upstream?.status === 404 && NO_MATCH_BODY.test(upstream.body)) {
    return { columns: [], rowCount: 0, rows: [], serviceRoot, source: 'OECD' };
  }
  return;
}

/**
 * Whether a failed read of a dataflow's data is worth one catalog lookup to see
 * if the dataflow is served by a different OECD service root.
 *
 * Only the two statuses the public root answers with for an entry it catalogues
 * but does not host: a 500 (`Object reference not set to an instance of an
 * object.`, what the data endpoint returns for an externally-referenced
 * dataflow) and a plain 404. A throttle or an exhausted outage is a fact about
 * the service, not about where the dataflow lives, and spending another request
 * on it would only deepen the hole.
 */
function mayLiveElsewhere(err: unknown): boolean {
  const status = upstreamStatus(err)?.status;
  return status === 404 || status === 500;
}

/**
 * The first pass at the configured root, with the retry budget withheld from
 * the statuses a catalog lookup can settle — see {@link mayLiveElsewhere}.
 *
 * `data.retryable: false` is the framework's in-band opt-out from `withRetry`'s
 * classification, so such a failure surfaces on the first attempt rather than
 * after two backoffs. It is withheld, not spent: a 500 the lookup does not
 * explain is a genuine fault and gets its remaining attempts afterwards. A 429,
 * a 503, or a timeout before the headers is never held back — none of them says
 * anything about where a dataflow lives, so the lookup has nothing cheaper to
 * offer and the ordinary budget is what clears them. A timeout while the body
 * is arriving gets no retries at any root; {@link fetchDataJson} has already
 * opted it out.
 */
function probeConfiguredRoot(budget: UpstreamBudget, url: string): Promise<unknown> {
  return budget.retry(
    (attempt) =>
      fetchDataJson(url, attempt).catch((err: unknown) => {
        if (!mayLiveElsewhere(err) || !(err instanceof McpError)) throw err;
        throw withoutRetries(err);
      }),
    2,
  );
}

/**
 * Decode one observations response from `serviceRoot`, reading OECD's
 * empty-match 404 as an empty result and restating every other failure as the
 * outcome the caller acts on.
 */
async function settleObservations(
  load: Promise<unknown>,
  flowRef: string,
  serviceRoot: string,
): Promise<OecdDataResult> {
  try {
    const data = await load;
    return { ...decodeUpstream(() => decodeObservations(data)), serviceRoot };
  } catch (err) {
    const empty = emptyResultFor(err, serviceRoot);
    if (empty) return empty;
    throw dataFetchFailure(err, flowRef);
  }
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
   * The configured root is tried first and answers for nearly the whole
   * catalog. The entries it publishes as external references are the exception:
   * it holds the catalog entry but not the observations, and answers the data
   * endpoint with a 500. For those, one catalog lookup names the OECD service
   * root that does host them and the same request is reissued there — see
   * {@link fetchExternalServiceRoot} for what makes a delegation followable.
   *
   * The lookup runs before the retries rather than after, because it is the
   * only thing that tells a 500 meaning "not served here" from a 500 meaning
   * "unwell right now", and the first repeats on every attempt. The one it
   * cannot explain resumes its retries against the configured root.
   *
   * The probe, the lookup, and the follow-up all spend the one budget given, so
   * the chain ends when it does — mid-lookup included, where the expiry is the
   * outcome rather than the failure the probe held.
   *
   * The result names the root that answered on `serviceRoot`, for a read that
   * has to follow the data there.
   *
   * @param budget - the call's upstream budget, carrying the caller's signal
   * @param flowRef - e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`
   * @param key - dot-delimited dimension key, e.g. `A.USA.B1GQ..`
   * @param startPeriod - ISO date string or period code, e.g. `2010`
   * @param endPeriod - ISO date string or period code, e.g. `2023`
   */
  async fetchData(
    budget: UpstreamBudget,
    flowRef: string,
    key: string,
    startPeriod?: string,
    endPeriod?: string,
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

    // The combined form needs `@` percent-encoded; a bare DF-only ref has no
    // datastructure part and is sent as published.
    const encodedFlowId = parts.dsdId ? `${parts.dsdId}%40${parts.dfId}` : parts.dfId;
    const pathKey = NORMALIZED_AWAY_KEY.test(key) ? 'all' : key;
    let path = `/data/${parts.agencyId},${encodedFlowId}/${pathKey}?dimensionAtObservation=AllDimensions`;
    if (startPeriod) path += `&startPeriod=${encodeURIComponent(startPeriod)}`;
    if (endPeriod) path += `&endPeriod=${encodeURIComponent(endPeriod)}`;

    const primary = `${this.baseUrl}${path}`;
    try {
      const data = await probeConfiguredRoot(budget, primary);
      return { ...decodeUpstream(() => decodeObservations(data)), serviceRoot: this.baseUrl };
    } catch (err) {
      const empty = emptyResultFor(err, this.baseUrl);
      if (empty) return empty;
      if (!mayLiveElsewhere(err)) throw dataFetchFailure(err, flowRef);

      const serviceRoot = await fetchExternalServiceRoot(budget, this.baseUrl, flowRef);
      // The delegated root owns the data, so its refusal is the one to report.
      if (serviceRoot !== undefined) {
        return settleObservations(
          loadObservations(budget, `${serviceRoot}${path}`),
          flowRef,
          serviceRoot,
        );
      }

      // No other root claims the flow, so the failure was the configured root's
      // own. A 404 is terminal — the dataflow is nowhere. A 500 is the
      // transient fault it looked like before delegation was ruled out, and
      // gets the attempts the probe withheld, less the one already spent.
      if (upstreamStatus(err)?.status !== 500) throw dataFetchFailure(err, flowRef);
      return settleObservations(loadObservations(budget, primary, 1), flowRef, this.baseUrl);
    }
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

/**
 * The time dimension. Its code is the period itself (`2025-Q1`) and its label
 * repeats it, so it carries no code column, and rows sort on it last.
 */
const TIME_PERIOD = 'TIME_PERIOD';

/** One declared dimension or attribute, with its code positions resolved to labels. */
interface ComponentValues {
  /**
   * Row key holding the SDMX code beside the label, `<ID>_code`. Absent for
   * {@link TIME_PERIOD} and for an uncoded component, whose published value is
   * already the label.
   */
  codeColumn?: string;
  id: string;
  values: Array<{ id: string; label: string } | undefined>;
}

/** A dimension, placed in the series key and in the observation keys. */
interface KeyedDimension extends ComponentValues {
  /** Position in the full series key, which a dimension-group key indexes. */
  keyPosition: number;
  /**
   * Position in an observation key; absent for a dimension presented at the
   * dataset level, whose one value covers every observation.
   */
  observationIndex?: number;
}

/**
 * The dimension-group entries that bind one set of key positions, keyed by the
 * value indexes they bind them to. Grouping entries by their bound positions
 * resolves each observation with one lookup per set instead of a scan of every
 * entry.
 */
interface DimensionGroupLookup {
  entries: Map<string, unknown[]>;
  positions: number[];
}

/**
 * Index a component list by position.
 *
 * Enumerated components carry `{ id, name }`; uncoded ones — `REF_YEAR_PRICE`
 * is the common case — carry a bare `{ value }`, so the label falls back
 * through both before the ID. A component declared on the DSD but unused in the
 * slice has an empty `values` array and can never resolve. A component whose
 * values carry IDs is coded, and gets a code column beside its label.
 */
function indexComponents(components: Array<Record<string, unknown>>): ComponentValues[] {
  return components.map((component) => {
    const id = String(component.id ?? '');
    const values = ((component.values ?? []) as Array<Record<string, unknown>>).map((v) => {
      const label = v.name ?? v.value ?? v.id;
      return label === undefined || label === null
        ? undefined
        : { id: String(v.id ?? ''), label: String(label) };
    });
    const coded = id !== TIME_PERIOD && values.some((v) => v !== undefined && v.id !== '');
    return { id, values, ...(coded ? { codeColumn: `${id}_code` } : {}) };
  });
}

/** Ordinal comparison of two rows' dimension codes, position by position. */
function compareCodes(a: readonly string[], b: readonly string[]): number {
  for (const [i, code] of a.entries()) {
    const other = b[i] ?? '';
    if (code !== other) return code < other ? -1 : 1;
  }
  return 0;
}

/** A component's label column, followed by its code column when it is coded. */
function componentColumns(component: ComponentValues): OecdColumn[] {
  return component.codeColumn
    ? [
        { codeColumn: component.codeColumn, name: component.id, type: 'string' },
        { name: component.codeColumn, type: 'string' },
      ]
    : [{ name: component.id, type: 'string' }];
}

/**
 * Index the dimensions presented at one level, placing each in the series key.
 * `keyPosition` is mandatory in SDMX-JSON and OECD sends it; a dimension
 * without one takes its place in presentation order — dataset level first,
 * then observation level — which is the key order whenever no dimension sits
 * at the dataset level.
 */
function indexDimensions(
  components: Array<Record<string, unknown>>,
  firstPosition: number,
  atObservation: boolean,
): KeyedDimension[] {
  return indexComponents(components).map((dimension, i) => {
    const declared = components[i]?.keyPosition;
    return {
      ...dimension,
      keyPosition: typeof declared === 'number' ? declared : firstPosition + i,
      ...(atObservation ? { observationIndex: i } : {}),
    };
  });
}

/**
 * Index `dataSets[0].dimensionGroupAttributes` for lookup by observation.
 *
 * Each key is a partial series key: a value index at each bound position, `~`
 * or nothing at the rest, spanning every dimension in key order whatever level
 * it is presented at. Each entry holds one value index per
 * `structure.attributes.dimensionGroup` attribute, then the indexes of
 * annotations, which are not attribute values — so a reader takes only the
 * first `attributeCount` elements, and an entry carrying annotations alone
 * contributes nothing.
 */
function indexDimensionGroups(raw: unknown, attributeCount: number): DimensionGroupLookup[] {
  if (attributeCount === 0) return [];
  const byPattern = new Map<string, DimensionGroupLookup>();
  for (const [key, entry] of Object.entries((raw ?? {}) as Record<string, unknown[]>)) {
    const parts = key.split(':');
    const positions = parts.flatMap((part, i) => (part === '' || part === '~' ? [] : [i]));
    const pattern = positions.join(',');
    let lookup = byPattern.get(pattern);
    if (!lookup) {
      lookup = { entries: new Map(), positions };
      byPattern.set(pattern, lookup);
    }
    lookup.entries.set(positions.map((i) => parts[i]).join(':'), entry);
  }
  return [...byPattern.values()];
}

/**
 * Put one component's value on a row — the label, and the code beside it when
 * the component is coded. Returns the value, or undefined when the index
 * resolves to none.
 */
function setComponent(
  row: DecodedRow,
  component: ComponentValues,
  index: unknown,
): { id: string; label: string } | undefined {
  if (typeof index !== 'number') return;
  const value = component.values[index];
  if (!value) return;
  row[component.id] = value.label;
  if (component.codeColumn) row[component.codeColumn] = value.id;
  return value;
}

/**
 * Put one attribute's value on a row. Returns the exponent a `UNIT_MULT` value
 * declares when it is a power of ten the guard accepts, and undefined
 * otherwise — an out-of-range code leaves the scale where it was.
 */
function setAttribute(
  row: DecodedRow,
  attribute: ComponentValues,
  index: unknown,
): number | undefined {
  const value = setComponent(row, attribute, index);
  if (!value || attribute.id !== UNIT_MULT) return;
  const declared = Number(value.id);
  return Number.isInteger(declared) && Math.abs(declared) <= MAX_UNIT_MULT_EXPONENT
    ? declared
    : undefined;
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

/** Decode an SDMX-JSON v2 AllDimensions body; the caller records the root that sent it. */
function decodeObservations(data: unknown): Omit<OecdDataResult, 'serviceRoot'> {
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

  /**
   * AllDimensions puts every dimension in the observation keys except one that
   * holds a single value, which SDMX-JSON may present at the dataset level
   * instead. Both levels merge into one list in key order.
   */
  const dimsMeta = structure?.dimensions as Record<string, unknown> | undefined;
  const attrsMeta = structure?.attributes as Record<string, unknown> | undefined;
  const dataSetDimensions = indexDimensions(
    (dimsMeta?.dataSet ?? []) as Array<Record<string, unknown>>,
    0,
    false,
  );
  const dimensions = [
    ...dataSetDimensions,
    ...indexDimensions(
      (dimsMeta?.observation ?? []) as Array<Record<string, unknown>>,
      dataSetDimensions.length,
      true,
    ),
  ].sort((a, b) => a.keyPosition - b.keyPosition);

  /**
   * Attributes arrive at three levels — the dataset, a dimension group, and
   * the observation — and an attribute is presented at exactly one of them, so
   * each becomes the same column whichever level carries it. There is no
   * series level: SDMX-JSON forbids `series` in the flat AllDimensions view.
   */
  const dataSetAttributes = indexComponents(
    (attrsMeta?.dataSet ?? []) as Array<Record<string, unknown>>,
  );
  const groupAttributes = indexComponents(
    (attrsMeta?.dimensionGroup ?? []) as Array<Record<string, unknown>>,
  );
  const observationAttributes = indexComponents(
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
    ...dimensions.flatMap(componentColumns),
    ...[...dataSetAttributes, ...groupAttributes, ...observationAttributes]
      .filter((a) => a.values.length > 0)
      .flatMap(componentColumns),
  ];

  /**
   * Rows sort on each observation-level dimension's code in key order, with
   * the time dimension last. Codes, not labels: labels can repeat across
   * codes, and a period's code sorts as text within one frequency. A
   * dataset-level dimension holds one value, so it cannot reorder anything.
   */
  const sortDimensions = dimensions
    .filter((d) => d.observationIndex !== undefined)
    .sort((a, b) => Number(a.id === TIME_PERIOD) - Number(b.id === TIME_PERIOD));

  /** Dataset-level attribute value indexes, one per attribute; `null` means no value. */
  const dataSetAttributeIndexes = (dataSet.attributes ?? []) as Array<unknown>;
  const dimensionGroups = indexDimensionGroups(
    dataSet.dimensionGroupAttributes,
    groupAttributes.length,
  );

  /**
   * Observations are `[obsValue, attrIdx0, attrIdx1, …]` keyed by a
   * colon-delimited dimension index tuple, e.g. `"0:0:2:3:0:0"` — so attribute
   * n sits at array position n + 1.
   */
  const observations = (dataSet.observations ?? {}) as Record<string, Array<unknown>>;

  const decoded: Array<{ codes: string[]; row: DecodedRow }> = [];

  for (const [key, obsValues] of Object.entries(observations)) {
    const indices = key.split(':').map(Number);
    // Key order is the rendered column order — keep it aligned with `columns`.
    const row: DecodedRow = { value: null, value_scale: 1, source: 'OECD' };
    // Value index per series-key position — the coordinates a dimension-group key names.
    const seriesKey: Array<number | undefined> = [];

    for (const dimension of dimensions) {
      const idx =
        dimension.observationIndex === undefined ? 0 : indices[dimension.observationIndex];
      seriesKey[dimension.keyPosition] = idx;
      setComponent(row, dimension, idx);
    }

    let exponent = 0;
    for (const [i, attribute] of dataSetAttributes.entries()) {
      exponent = setAttribute(row, attribute, dataSetAttributeIndexes[i]) ?? exponent;
    }
    for (const group of dimensionGroups) {
      const values = group.entries.get(group.positions.map((p) => seriesKey[p]).join(':'));
      if (!values) continue;
      for (const [i, attribute] of groupAttributes.entries()) {
        exponent = setAttribute(row, attribute, values[i]) ?? exponent;
      }
    }
    for (const [i, attribute] of observationAttributes.entries()) {
      exponent = setAttribute(row, attribute, obsValues[i + 1]) ?? exponent;
    }

    const numVal = obsValues[0];
    row.value = typeof numVal === 'number' ? applyScale(numVal, exponent) : null;
    row.value_scale = 10 ** exponent;

    const codes = sortDimensions.map((d) => {
      const idx = seriesKey[d.keyPosition];
      return (idx === undefined ? undefined : d.values[idx]?.id) ?? '';
    });
    decoded.push({ codes, row });
  }

  const rows = decoded.sort((a, b) => compareCodes(a.codes, b.codes)).map(({ row }) => row);
  return { columns, rowCount: rows.length, rows, source: 'OECD' };
}
