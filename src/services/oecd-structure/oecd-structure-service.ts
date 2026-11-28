/**
 * @fileoverview OECD SDMX structure service — wraps the dataflow, datastructure,
 * codelist, concept-scheme, and agency-scheme endpoints, behind one response
 * cache.
 * @module services/oecd-structure/oecd-structure-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { externalServiceRootOf } from '@/services/oecd-http/external-service-root.js';
import {
  decodeUpstream,
  fetchOecd,
  parseJsonBody,
  type RequestWindow,
  sdmxRecord,
  sdmxRecords,
} from '@/services/oecd-http/oecd-http.js';
import { isBudgetExpiry, UpstreamBudget } from '@/services/oecd-http/upstream-budget.js';
import { htmlToMarkdown, isHttpUrl, stripHtml } from './dataflow-description.js';
import { sdmxVersion } from './dataflow-version.js';
import { type LoadedResponse, ResponseCache } from './response-cache.js';
import type {
  OecdCode,
  OecdDataflow,
  OecdDataStructure,
  OecdDimension,
  OecdExternalResource,
  OecdTimeDimension,
} from './types.js';

const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';

/**
 * Allowed characters in SDMX identifier path segments (agencyId, dsdId, dfId).
 * SDMX IDs use letters, digits, underscores, hyphens, and dots only, and always
 * open on a letter or digit — every identifier the catalog publishes does.
 *
 * Both halves of that carry weight. The character class rejects `/`, `\0`, `?`,
 * `#`, and `%`, which would alter the URL structure or smuggle an encoded
 * separator. The leading alphanumeric rejects an identifier that is nothing but
 * dots: an identifier occupies one path segment, so `.` or `..` is read as a
 * relative path reference and resolved away, walking the request out of the
 * endpoint it was addressed to.
 */
const SDMX_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse a flow ref into its parts.
 *
 * Two forms are published. Nearly every OECD dataflow carries the combined
 * `{agencyID},{dsd_id}@{df_id}`, but a handful are catalogued under a bare
 * `DF_*` id with no datastructure prefix, and for those `{agencyID},{df_id}` is
 * the only reference the data endpoint answers — the combined form built by
 * pairing the URN's datastructure with the dataflow id is rejected. Both forms
 * are accepted here; `dsdId` is absent for the bare one.
 */
export function parseFlowRef(flowRef: string): {
  agencyId: string;
  dsdId?: string;
  dfId: string;
} | null {
  // Expected: OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I or OECD.TAD.ARP,DF_AEI2024_DASHBOARD
  const commaIdx = flowRef.indexOf(',');
  if (commaIdx < 0) return null;
  const agencyId = flowRef.slice(0, commaIdx);
  const rest = flowRef.slice(commaIdx + 1); // DSD_NAAG@DF_NAAG_I or DF_AEI2024_DASHBOARD
  const atIdx = rest.indexOf('@');
  const dsdId = atIdx < 0 ? undefined : rest.slice(0, atIdx);
  const dfId = atIdx < 0 ? rest : rest.slice(atIdx + 1);
  // An empty segment on either side of a present '@' is malformed, not bare.
  if (!agencyId || !dfId || dsdId === '') return null;
  // Reject characters that could alter URL path structure
  if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(dfId)) return null;
  if (dsdId !== undefined && !SDMX_ID_SAFE.test(dsdId)) return null;
  return { agencyId, ...(dsdId ? { dsdId } : {}), dfId };
}

/**
 * The directorate segment of a dotted OECD agency identifier — `OECD.SDD.NAD`
 * and `OECD.SDD.NAD.SEEA` both resolve to `SDD`, and `OECD.ITF` to `ITF`.
 * Undefined for the non-OECD publishers that ship dataflows through the same
 * catalog (`ESTAT`, `IAEG-SDGs`), which carry no directorate segment.
 */
export function directorateCode(agencyId: string): string | undefined {
  return agencyId.split('.')[1] || undefined;
}

/** Retries a structure read gets after its first attempt, on a transient failure. */
const STRUCTURE_RETRIES = 2;

/** One structure response read to the end: its parsed body, and what the cache needs to know about it. */
interface StructureBody {
  /** Characters in the body. */
  bodyChars: number;
  /** See {@link freshForMs}. */
  freshForMs: number | undefined;
  payload: unknown;
}

/**
 * How long OECD lets a structure response be reused, in milliseconds: its
 * `max-age` less the `Age` a cache in front of OECD already spent of it
 * (RFC 9111 freshness). Undefined when the response forbids reuse
 * (`no-store`, `no-cache`), names no `max-age`, or is already stale — OECD's
 * 404s answer `no-cache,no-store`, and its 2xx `public,max-age=86400` on the
 * catalog and every definition, `7200` on availability.
 */
function freshForMs(headers: Headers): number | undefined {
  const directives = new Map<string, string>();
  for (const part of (headers.get('cache-control') ?? '').split(',')) {
    const [name = '', value = ''] = part.split('=', 2);
    directives.set(name.trim().toLowerCase(), value.trim());
  }
  if (directives.has('no-store') || directives.has('no-cache')) return;
  const maxAge = directives.get('max-age');
  if (maxAge === undefined || !/^\d+$/.test(maxAge)) return;
  const age = headers.get('age')?.trim() ?? '';
  const spentS = /^\d+$/.test(age) ? Number(age) : 0;
  const freshMs = (Number(maxAge) - spentS) * 1000;
  return freshMs > 0 ? freshMs : undefined;
}

/**
 * Fetch one structure endpoint inside one request's share of the budget and
 * read its body to the end.
 *
 * The read keeps the body's length and caching headers, which the cache needs,
 * so it reads the text itself and parses it through `parseJsonBody`, failing the
 * way `readJsonBody` does: a read cut short keeps the classification
 * `fetchWithTimeout` gave it, and only a body that arrived whole and is not JSON
 * becomes `SerializationError`.
 */
async function fetchStructureBody(url: string, window: RequestWindow): Promise<StructureBody> {
  const res = await fetchOecd(
    url,
    {
      accept: STRUCTURE_ACCEPT,
      // An unknown agency or dataflow is a caller mistake, not a server fault.
      expectedStatuses: [404],
      operation: 'oecdStructureFetch',
    },
    window,
  );
  const text = await res.text();
  return {
    bodyChars: text.length,
    freshForMs: freshForMs(res.headers),
    payload: parseJsonBody(text, res.headers),
  };
}

/** One structure endpoint to read through the service's response cache. */
export interface StructureRead<T> {
  /**
   * `retry` gives the read its retries on a transient failure, the default for
   * a structure read; `once` sends a single attempt at `OECD_TIMEOUT_MS`, for a
   * lookup its caller treats as best-effort.
   */
  attempts: 'once' | 'retry';
  /**
   * Turn the parsed body into the value the read returns. The cache stores that
   * value, so it is a pure function of the body; it runs once per load, after
   * the attempts, and a throw fails the load without storing anything. A
   * `TypeError` reports as `SerializationError` (see `decodeUpstream`).
   */
  decode: (payload: unknown) => T;
  /** What the caller reports when the read fails; the upstream failure stays its cause, code and data intact. */
  failureMessage: string;
  /** The request URL, service root included. One URL is always decoded the same way. */
  url: string;
}

/**
 * Load one structure read under the cache's own signal and a budget of its own
 * that starts with the load. The load outlives no caller (the cache aborts it
 * when the last one leaves), and a caller's abort or deadline ends only that
 * caller's wait, never the load. The load's own deadline ends it for every
 * waiter, so a caller that joined later and still has time when that deadline
 * passes starts a fresh load rather than take the expiry (see `ResponseCache`).
 */
async function loadStructure<T>(
  read: StructureRead<T>,
  signal: AbortSignal,
): Promise<LoadedResponse<T>> {
  const budget = new UpstreamBudget(signal);
  const attempt = (window: RequestWindow) => fetchStructureBody(read.url, window);
  const body =
    read.attempts === 'retry'
      ? await budget.retry(attempt, STRUCTURE_RETRIES)
      : await budget.once(attempt);
  return {
    bodyChars: body.bodyChars,
    freshForMs: body.freshForMs,
    value: decodeUpstream(() => read.decode(body.payload)),
  };
}

/**
 * Label a failed read with the call that produced it, preserving the upstream
 * classification so a terminal 4xx does not resurface as a transient outage.
 */
function relabel(err: unknown, failureMessage: string): McpError {
  if (err instanceof McpError)
    return new McpError(err.code, failureMessage, err.data, { cause: err });
  return serviceUnavailable(failureMessage, {}, { cause: err });
}

/** The id a dataflow is catalogued under — combined `{dsd}@{df}`, or bare `{df}`. */
function dataflowIdOf(parts: { dfId: string; dsdId?: string }): string {
  return parts.dsdId ? `${parts.dsdId}@${parts.dfId}` : parts.dfId;
}

/**
 * The two routes one root answers a datastructure on, in the order they are
 * read: the dataflow's reference, then the datastructure itself, which only a
 * combined ref names.
 */
function structureRoutes(
  root: string,
  parts: { agencyId: string; dfId: string; dsdId?: string },
  version?: string,
): { direct: string | undefined; reference: string } {
  return {
    direct:
      parts.dsdId && version === undefined
        ? `${root}/datastructure/${parts.agencyId}/${parts.dsdId}`
        : undefined,
    reference: `${root}/dataflow/${parts.agencyId}/${dataflowIdOf(parts)}${version === undefined ? '' : `/${version}`}?references=datastructure`,
  };
}

/** The cache key of a structure read: one URL, decoded one way. */
function structureCacheKey(url: string): string {
  return `${STRUCTURE_ACCEPT}\n${url}`;
}

/**
 * Absorb a missing datastructure so the caller can try another route, while an
 * outage or a timeout is reported as itself rather than retried down a path
 * that was never going to answer it.
 */
function swallowNotFound(err: unknown): undefined {
  if (err instanceof Error && isDataflowNotFound(err)) return;
  throw err;
}

/**
 * The service root the catalog entry for a flow ref delegates to, or undefined
 * when it names none this server will follow.
 *
 * Takes the base URL rather than reading the singleton so the data service can
 * resolve a delegation without depending on structure-service initialization.
 * A failed lookup resolves to undefined — an unreadable catalog entry included:
 * this runs only when the caller already holds a real error to report, and a
 * second failure must not replace the first. Two outcomes are the exception,
 * because each is the outcome now and the error held from before it would
 * report something false: the caller's own abort, and the call's budget running
 * out mid-lookup, which leaves nothing to try next and is no more "not found"
 * than it is an outage.
 *
 * One attempt, deliberately unretried. The caller reaches here holding a
 * failure it wants settled faster than a retry loop would settle it, so
 * answering "where does this flow live" with three requests and a backoff would
 * reintroduce the delay on the catalog endpoint that skipping the retries on
 * the data endpoint just removed.
 *
 * Uncached, unlike every read the service makes: it has no service instance to
 * hold a cache, and it runs only after a data query has already failed.
 */
export async function fetchExternalServiceRoot(
  budget: UpstreamBudget,
  baseUrl: string,
  flowRef: string,
): Promise<string | undefined> {
  const parts = parseFlowRef(flowRef);
  if (!parts) return;

  const url = `${baseUrl}/dataflow/${parts.agencyId}/${dataflowIdOf(parts)}`;
  try {
    const { payload } = await budget.once((window) => fetchStructureBody(url, window));
    return externalServiceRootOf(payload, baseUrl);
  } catch (err) {
    if (budget.signal?.aborted || isBudgetExpiry(err)) throw err;
    return;
  }
}

let _instance: OecdStructureService | undefined;

/**
 * Service for fetching OECD SDMX structural metadata.
 *
 * Every structure read goes through one {@link ResponseCache} the instance
 * owns, keyed by the request — the service root included, so a delegated root
 * never answers for the configured one — and kept for the lifetime OECD's
 * `cache-control` grants each response. The catalog, the dataflow references,
 * datastructures, concept schemes, codelists, and the agency scheme are all
 * reused that way; the data service's requests and its delegation lookup
 * ({@link fetchExternalServiceRoot}) are not. One instance serves the whole
 * process, every tenant included: structure requests carry no credentials, so
 * a URL answers every caller alike.
 */
export class OecdStructureService {
  private readonly baseUrl: string;
  readonly #cache = new ResponseCache();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Read one structure endpoint through this service's response cache.
   *
   * A stored, fresh response costs no request. A miss joins the load of the
   * same request already in flight, or starts one; the load spends a budget of
   * its own, and this call waits on it only as long as its own `budget` and
   * signal allow, so a waiter that leaves early fails alone and reports a wait
   * its budget cut short as the budget's expiry (`isBudgetExpiry`). A failure of
   * any kind is never stored.
   *
   * @throws {McpError} The upstream or decode failure with `read.failureMessage` as
   *   its message and the original as its cause; `RequestCancelled` on the
   *   caller's abort; `Timeout` when its budget runs out first.
   */
  readStructure<T>(budget: UpstreamBudget, read: StructureRead<T>): Promise<T> {
    return this.#cache
      .get(structureCacheKey(read.url), budget, (signal) => loadStructure(read, signal))
      .catch((err: unknown) => {
        // A lone read reports its budget running out as `budget.once` does, so
        // a best-effort caller can still tell the expiry apart (`isBudgetExpiry`).
        if (read.attempts === 'once' && isBudgetExpiry(err)) throw err;
        throw relabel(err, read.failureMessage);
      });
  }

  /**
   * Fetch all dataflows, optionally filtered by agency.
   * Uses `GET /dataflow/{agencyID}` or `GET /dataflow` for all agencies.
   */
  fetchDataflows(budget: UpstreamBudget, agencyId?: string): Promise<OecdDataflow[]> {
    // agencyId comes straight from caller input. A value outside the SDMX
    // character set cannot name any agency, so it is a not-found — never a
    // transient failure the caller should retry.
    if (agencyId !== undefined && !SDMX_ID_SAFE.test(agencyId)) {
      return Promise.reject(notFound(`Invalid agency identifier: ${agencyId}`, { agencyId }));
    }
    return this.readStructure(budget, {
      attempts: 'retry',
      decode: parseDataflows,
      failureMessage: `Failed to fetch OECD dataflows${agencyId ? ` for agency ${agencyId}` : ''}`,
      url: agencyId ? `${this.baseUrl}/dataflow/${agencyId}` : `${this.baseUrl}/dataflow`,
    });
  }

  /**
   * Fetch the datastructure a flow ref's dataflow references, with each
   * dimension's name resolved from its concept scheme.
   *
   * Every ref starts at the dataflow itself:
   * `GET /dataflow/{agencyID}/{id}?references=datastructure`, the id as OECD
   * catalogues it, combined or bare. One request answers two questions there.
   * Whether OECD publishes the dataflow at all — a 404 is the not-found the
   * caller reports, never a cue to try another route. And which datastructure
   * revision the dataflow references, which is not always the latest:
   * `DF_UOE_FIN_NATURE` references `DSD_EAG_UOE_FIN` 1.0, eight dimensions,
   * where the datastructure's own route answers with 3.2 and nine.
   *
   * That route cannot answer the first question and gets the second wrong for
   * part of the catalog, which is why it does not lead. The `{dsd_id}` half of
   * a combined ref names a datastructure, not a dataflow, so the route resolves
   * a mistyped or retired dataflow id as long as its datastructure exists; and
   * the `{dsd_id}` is a label OECD does not keep in step with the real
   * datastructure (`DSD_REG_LAB@DF_RATES` is backed by `DSD_REG_LABOUR`). A bare
   * `{agencyID},{df_id}` ref carries no datastructure id to address at all.
   *
   * The datastructure route stays for one class. Part of the catalog is
   * published as a pointer rather than a definition — `isExternalReference:
   * true`, no inline datastructure, and a `links[]` entry naming the OECD
   * service root that owns the real thing. For several of those the configured
   * root holds the datastructure anyway, so the datastructure route is tried
   * next, and then the root the link names, read the same way.
   *
   * Whichever revision answers is the authority for the lookups that follow
   * it, so the codelists and concept schemes read back at the versions it names
   * are coherent with the dimensions it declared.
   *
   * A pointer also names where the dataflow's data lives, whichever route then
   * answers for the structure, so the result records that root as `dataRoot`
   * beside the `serviceRoot` that defined the structure. Without a pointer the
   * two are the same root.
   *
   * A repeat call for a pointer whose root already answered is served from that
   * answer, before the configured root's datastructure route — see
   * {@link cachedDataStructure}.
   *
   * Every route and every concept-scheme read spends the one budget it is
   * given, so the whole cascade ends when the budget does.
   */
  async fetchDataStructure(
    budget: UpstreamBudget,
    flowRef: string,
    version?: string,
  ): Promise<OecdDataStructure> {
    const { conceptRefs, structure } = await this.resolveDataStructure(budget, flowRef, version);
    return this.applyConceptNames(budget, structure, conceptRefs, version !== undefined);
  }

  /** Read the edition catalogue on the root whose dataflow owns it, within the existing budget. */
  async fetchDataflowVersions(
    budget: UpstreamBudget,
    flowRef: string,
    root: string = this.baseUrl,
  ): Promise<string[] | undefined> {
    const parts = parseFlowRef(flowRef);
    if (!parts) throw new Error(`Invalid flow_ref format: ${flowRef}`);
    const flowId = dataflowIdOf(parts);
    try {
      return await this.readStructure(budget, {
        attempts: 'once',
        decode: (payload) => {
          const data = sdmxRecord(sdmxRecord(payload, 'response').data, 'data');
          const versions = new Set<string>();
          for (const entry of sdmxRecords(data.dataflows, 'dataflows')) {
            if (entry.agencyID !== parts.agencyId || entry.id !== flowId) continue;
            const edition = sdmxVersion(entry.version);
            if (edition !== undefined) versions.add(edition);
          }
          return versions.size > 0 ? [...versions] : undefined;
        },
        failureMessage: `Failed to fetch OECD dataflow editions for ${flowRef}`,
        url: `${root}/dataflow/${parts.agencyId}/${flowId}/all`,
      });
    } catch (err) {
      if (budget.signal?.aborted || !(err instanceof McpError)) throw err;
      return;
    }
  }

  /**
   * Resolve a dataflow's non-time dimension count through the cached structure
   * cascade without fetching concept schemes (0 requests warm, 1 structure
   * request cold for normal/bare flows).
   *
   * @throws {Error} When `flowRef` fails `parseFlowRef`.
   * @throws {McpError} `NotFound` when the dataflow does not resolve to a
   *   datastructure or declares zero dimensions.
   */
  async fetchQueryStructure(
    budget: UpstreamBudget,
    flowRef: string,
    version?: string,
  ): Promise<{
    dimensionCount: number;
    dimensionIds: string[];
    dataRoot: string;
    version?: string;
  }> {
    const { structure } = await this.resolveDataStructure(budget, flowRef, version);
    if (structure.dimensions.length === 0) {
      throw notFound(`Dataflow ${flowRef} returned no dimensions`, { flowRef });
    }
    return {
      dimensionCount: structure.dimensions.length,
      dimensionIds: structure.dimensions.map((dimension) => dimension.id),
      dataRoot: structure.dataRoot,
      ...(structure.version === undefined ? {} : { version: structure.version }),
    };
  }

  /**
   * Resolve a flow ref's datastructure and dataflow metadata through the cached
   * reference → direct → delegated cascade, before concept-scheme enrichment.
   */
  private async resolveDataStructure(
    budget: UpstreamBudget,
    flowRef: string,
    version?: string,
  ): Promise<{ conceptRefs: ConceptRef[]; structure: OecdDataStructure }> {
    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw new Error(`Invalid flow_ref format: ${flowRef}`);
    }

    if (version !== undefined && sdmxVersion(version) === undefined) {
      throw new Error(`Invalid dataflow version: ${version}`);
    }
    const configured = structureRoutes(this.baseUrl, parts, version);
    const reference = await this.readDataStructure(
      budget,
      configured.reference,
      flowRef,
      version,
    ).catch(async (err: unknown) => {
      if (version === undefined) throw err;
      swallowNotFound(err);
      // Older editions may be absent from the public catalog entirely. Its
      // latest entry can establish a root, but cannot answer this edition.
      const latest = structureRoutes(this.baseUrl, parts);
      const current = await this.readDataStructure(budget, latest.reference, flowRef).catch(
        swallowNotFound,
      );
      if (current?.kind === 'delegated') return current;
      throw await this.missingEdition(budget, flowRef, version, this.baseUrl);
    });

    /**
     * Root that answered. Codelists and concept schemes are versioned per root
     * — the public catalog mirrors an older revision of both for the delegated
     * entries — so the labels for this structure have to be read back from
     * whichever root defined it.
     */
    let serviceRoot = this.baseUrl;
    let parsed = reference.kind === 'structure' ? reference.parsed : undefined;

    if (!parsed && reference.kind === 'delegated') {
      parsed = this.cachedDataStructure(reference.root, parts, version);
      if (parsed) serviceRoot = reference.root;
    }

    if (!parsed && configured.direct) {
      const direct = await this.readDataStructure(budget, configured.direct, flowRef).catch(
        swallowNotFound,
      );
      if (direct?.kind === 'structure') parsed = direct.parsed;
    }

    if (!parsed) {
      // No delegation to follow means the ref genuinely resolves nowhere.
      if (reference.kind !== 'delegated') {
        if (version !== undefined) {
          throw await this.missingEdition(budget, flowRef, version, this.baseUrl);
        }
        throw notFound(`DataStructure not found for ${flowRef}`, { flowRef });
      }
      parsed = await this.loadDelegatedDataStructure(
        budget,
        reference.root,
        parts,
        flowRef,
        version,
      );
      serviceRoot = reference.root;
    }

    // Prefer the resolved response's own `dataflows[0]` metadata (e.g. from the
    // delegated root's reference response), falling back to the configured
    // root's stub when a `/datastructure/...` route answered without `dataflows[]`.
    const fallbackMeta =
      reference.kind !== 'structure' &&
      (version === undefined || reference.meta?.version === version)
        ? reference.meta
        : undefined;
    const meta = parsed.meta ?? fallbackMeta;
    const resolvedVersion = parsed.meta?.version ?? fallbackMeta?.version;
    if (version !== undefined && resolvedVersion !== undefined && resolvedVersion !== version) {
      throw serializationError(
        `OECD returned dataflow edition ${resolvedVersion} for a request for edition ${version}`,
      );
    }
    const edition = resolvedVersion ?? version;

    return {
      conceptRefs: parsed.conceptRefs,
      structure: {
        ...parsed.structure,
        agencyId: parts.agencyId,
        dataRoot: reference.kind === 'delegated' ? reference.root : serviceRoot,
        flowRef,
        serviceRoot,
        ...(meta?.name !== undefined ? { name: meta.name } : {}),
        ...(meta?.description !== undefined ? { description: meta.description } : {}),
        ...(meta?.resources !== undefined ? { resources: meta.resources } : {}),
        ...(edition === undefined ? {} : { version: edition }),
      },
    };
  }

  /**
   * Resolve a datastructure on the service root the catalog delegated to, in
   * the order and for the reasons {@link fetchDataStructure} gives: the
   * dataflow's reference first, the datastructure route when that carries
   * none. The configured root has already answered that the dataflow exists, so
   * a 404 on the first route still leaves the second to try. The delegating root
   * is only ever the validated one {@link externalServiceRootOf} returns; the
   * paths are rebuilt here from identifiers `parseFlowRef` already checked,
   * never from the upstream href.
   */
  private async loadDelegatedDataStructure(
    budget: UpstreamBudget,
    serviceRoot: string,
    parts: { agencyId: string; dfId: string; dsdId?: string },
    flowRef: string,
    version?: string,
  ): Promise<ParsedDataStructure> {
    const routes = structureRoutes(serviceRoot, parts, version);
    const reference = await this.readDataStructure(
      budget,
      routes.reference,
      flowRef,
      version,
    ).catch(swallowNotFound);
    if (reference?.kind === 'structure') return reference.parsed;

    const direct = routes.direct
      ? await this.readDataStructure(budget, routes.direct, flowRef)
      : undefined;
    if (direct?.kind === 'structure') return direct.parsed;
    if (version !== undefined)
      throw await this.missingEdition(budget, flowRef, version, serviceRoot);
    throw notFound(`DataStructure not found for ${flowRef}`, { flowRef });
  }

  /**
   * The datastructure a delegated root has already answered with, read from the
   * cache alone in {@link loadDelegatedDataStructure}'s order; undefined when
   * neither of its routes holds one.
   *
   * It lets a repeat call skip the configured root's datastructure route, whose
   * 404 is never stored. Skipping it changes no answer: a delegated root's
   * routes are read only by {@link loadDelegatedDataStructure}, which runs only
   * once that route has found nothing, so a stored answer is the resolution the
   * full cascade reached, kept for the lifetime OECD granted it. When it
   * expires, the next call reads the cascade in full again.
   */
  private cachedDataStructure(
    serviceRoot: string,
    parts: { agencyId: string; dfId: string; dsdId?: string },
    version?: string,
  ): ParsedDataStructure | undefined {
    const routes = structureRoutes(serviceRoot, parts, version);
    for (const url of [routes.reference, routes.direct]) {
      if (url === undefined) continue;
      const stored = this.#cache.peek<StructureResponse>(structureCacheKey(url));
      if (stored?.kind === 'structure') return stored.parsed;
    }
    return;
  }

  private async missingEdition(
    budget: UpstreamBudget,
    flowRef: string,
    version: string,
    root: string,
  ): Promise<McpError> {
    const known = await this.fetchDataflowVersions(budget, flowRef, root);
    const alternatives = known?.length ? ` Published editions: ${known.join(', ')}.` : '';
    return notFound(
      `OECD did not return a datastructure for ${flowRef} edition ${version}.${alternatives}`,
    );
  }

  /** Read one datastructure or dataflow-reference response. */
  private readDataStructure(
    budget: UpstreamBudget,
    url: string,
    flowRef: string,
    version?: string,
  ): Promise<StructureResponse> {
    return this.readStructure(budget, {
      attempts: 'retry',
      decode: (payload) => parseStructureResponse(payload, this.baseUrl, version !== undefined),
      failureMessage: `Failed to fetch OECD datastructure for ${flowRef}`,
      url,
    });
  }

  /**
   * Fetch one concept scheme as a `concept id → name` map.
   * Uses `GET /conceptscheme/{agencyID}/{conceptSchemeID}`.
   *
   * `serviceRoot` addresses the root that defined the datastructure this scheme
   * names. Omit it, or pass an {@link OecdDataStructure.serviceRoot} — those are
   * the only two values that have been through the origin check, and this
   * parameter becomes a request URL.
   *
   * `version` pins the scheme to the revision the datastructure references, for
   * the reason {@link fetchCodelist} pins a codelist. Pass a
   * {@link ConceptRef.version}; anything else has not been through
   * {@link sdmxVersion} and this parameter becomes a URL path segment.
   */
  async fetchConceptScheme(
    budget: UpstreamBudget,
    agencyId: string,
    schemeId: string,
    serviceRoot: string = this.baseUrl,
    version?: string,
    onMissingVersion: 'latest' | 'fail' = 'latest',
  ): Promise<Map<string, string>> {
    // Both IDs come from a datastructure URN, but validate as a safety net
    // before embedding in the URL path. One outside the SDMX character set is a
    // fault in what OECD published, and no retry clears it.
    if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(schemeId)) {
      throw serializationError(
        `OECD named a concept scheme identifier outside the SDMX character set: ${agencyId}/${schemeId}`,
        { agencyId, schemeId },
      );
    }
    const url = `${serviceRoot}/conceptscheme/${agencyId}/${schemeId}`;
    const label = `OECD concept scheme ${agencyId}/${schemeId}`;

    if (version !== undefined) {
      const read = this.readStructure(budget, {
        attempts: 'retry',
        decode: parseConceptScheme,
        failureMessage: `Failed to fetch ${label} version ${version}`,
        url: `${url}/${version}`,
      });
      if (onMissingVersion === 'fail') return read;
      const pinned = await read.catch(swallowNotFound);
      if (pinned !== undefined) return pinned;
    }

    return this.readStructure(budget, {
      attempts: 'retry',
      decode: parseConceptScheme,
      failureMessage: `Failed to fetch ${label}`,
      url,
    });
  }

  /**
   * Fetch the OECD directorate codes and their names as a `code → name` map.
   * Uses `GET /agencyscheme/OECD`, whose entries are keyed by the directorate
   * segment of a dotted agency identifier — see {@link directorateCode}.
   */
  fetchDirectorates(budget: UpstreamBudget): Promise<Map<string, string>> {
    return this.readStructure(budget, {
      attempts: 'retry',
      decode: parseAgencyScheme,
      failureMessage: 'Failed to fetch the OECD agency scheme',
      url: `${this.baseUrl}/agencyscheme/OECD`,
    });
  }

  /**
   * Replace each dimension's id-shaped placeholder name with the concept name
   * its `conceptIdentity` URN points at.
   *
   * Best-effort by design: OECD's datastructure response carries no name on a
   * dimension, so the names live one request away in the concept scheme. A
   * scheme that fails to fetch, or one that omits a concept, leaves the
   * dimension on its id. Failed reads also mark the dimensions they affect.
   * A missing label is a tolerable gap; failing the whole
   * dataset-info call over one is not. A budget that runs out during the
   * scheme reads is one more way for a scheme to fail to arrive, so the
   * structure comes back on its ids. The caller's own abort is not a scheme
   * failing to fetch: it ends the call as the cancellation it is, rather than
   * returning a structure nobody is waiting for. A datastructure whose
   * dimensions carry no parseable `conceptIdentity` issues no request at all.
   */
  private async applyConceptNames(
    budget: UpstreamBudget,
    structure: OecdDataStructure,
    conceptRefs: ConceptRef[],
    exactEdition: boolean,
  ): Promise<OecdDataStructure> {
    // Every dimension of a datastructure shares one scheme in practice; keying
    // by scheme collapses them to the single request that fact implies.
    const schemes = new Map(conceptRefs.map((ref) => [schemeKey(ref), ref] as const));
    const bySchemeKey = new Map(
      await Promise.all(
        [...schemes].map(
          async ([key, ref]) =>
            [
              key,
              await this.fetchConceptScheme(
                budget,
                ref.agencyId,
                ref.schemeId,
                structure.serviceRoot,
                ref.version,
                exactEdition ? 'fail' : 'latest',
              ).catch((err: unknown) => {
                if (budget.signal?.aborted) throw err;
                return null;
              }),
            ] as const,
        ),
      ),
    );

    const names = new Map<string, string>();
    const failedFor = new Set<string>();
    for (const ref of conceptRefs) {
      const scheme = bySchemeKey.get(schemeKey(ref));
      if (scheme === null) failedFor.add(ref.dimensionId);
      const name = scheme?.get(ref.conceptId);
      if (name) names.set(ref.dimensionId, name);
    }
    if (names.size === 0 && failedFor.size === 0) return structure;

    return {
      ...structure,
      ...(failedFor.size > 0 ? { conceptLookupFailedFor: [...failedFor] } : {}),
      dimensions: structure.dimensions.map((d) => ({ ...d, name: names.get(d.id) ?? d.name })),
      ...(structure.timeDimension
        ? {
            timeDimension: {
              ...structure.timeDimension,
              name: names.get(structure.timeDimension.id) ?? structure.timeDimension.name,
            },
          }
        : {}),
    };
  }

  /**
   * Fetch all codes for a codelist.
   * Uses `GET /codelist/{agencyID}/{codelistID}`, with `/{version}` appended
   * when the datastructure named one.
   *
   * `serviceRoot` addresses the root that defined the datastructure the
   * codelist belongs to. The distinction carries real codes: the public catalog
   * answers `OECD.STI.PIE/CL_TIVA_MEASURE` with version 1.0 while the root that
   * owns `DSD_TIVA_EXGRVA` answers with the 1.1 the datastructure actually
   * references, three codes shorter. Omit it, or pass an
   * {@link OecdDataStructure.serviceRoot} — those are the only two values that
   * have been through the origin check, and this parameter becomes a request URL.
   *
   * `version` pins the same lookup on the other axis. An unversioned request
   * answers with whatever the root currently calls latest, which for a codelist
   * that has moved on since the datastructure was published means codes the
   * dimension rejects — `CL_AREA` is at 1.9 (568 codes) where
   * `DSD_TIVA_EXGRVA` references 1.7 (560). A version the root no longer serves
   * 404s, and that falls back to latest: an outdated list is a better answer
   * than none, and the fallback costs a request only on a reference gone stale.
   * Explicitly selected editions pass `onMissingVersion: 'fail'` to avoid
   * mixing a different codelist revision into the requested edition.
   * Pass an {@link OecdDimension.codelistVersion}; anything else has not been
   * through {@link sdmxVersion} and this parameter becomes a URL path
   * segment.
   */
  async fetchCodelist(
    budget: UpstreamBudget,
    agencyId: string,
    codelistId: string,
    serviceRoot: string = this.baseUrl,
    version?: string,
    onMissingVersion: 'latest' | 'fail' = 'latest',
  ): Promise<OecdCode[]> {
    // Both IDs are derived from upstream DSD responses, but validate as a safety
    // net before embedding in the URL path. One outside the SDMX character set
    // is a fault in what OECD published, and no retry clears it.
    if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(codelistId)) {
      throw serializationError(
        `OECD named a codelist identifier outside the SDMX character set: ${agencyId}/${codelistId}`,
        { agencyId, codelistId },
      );
    }
    const url = `${serviceRoot}/codelist/${agencyId}/${codelistId}`;
    const label = `OECD codelist ${agencyId}/${codelistId}`;

    if (version !== undefined) {
      const read = this.readStructure(budget, {
        attempts: 'retry',
        decode: parseCodelist,
        failureMessage: `Failed to fetch ${label} version ${version}`,
        url: `${url}/${version}`,
      });
      if (onMissingVersion === 'fail') return read;
      const pinned = await read.catch(swallowNotFound);
      if (pinned !== undefined) return pinned;
    }

    return this.readStructure(budget, {
      attempts: 'retry',
      decode: parseCodelist,
      failureMessage: `Failed to fetch ${label}`,
      url,
    });
  }
}

export function initStructureService(): void {
  const config = getServerConfig();
  _instance = new OecdStructureService(config.baseUrl);
}

export function getStructureService(): OecdStructureService {
  if (!_instance) throw new Error('OecdStructureService not initialized');
  return _instance;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Read an OECD localized string field, which is either a plain string or a `{lang: text}` map. */
function localizedString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.values(value as Record<string, string>)[0];
  return;
}

/** Read a non-empty trimmed OECD string, falling through from an empty singular value to the plural map. */
function nonEmptyLocalizedString(primary: unknown, plural: unknown): string | undefined {
  return localizedString(primary)?.trim() || localizedString(plural)?.trim() || undefined;
}

/** A dimension's concept, as named by its `conceptIdentity` URN. */
interface ConceptRef {
  /** Agency owning the concept scheme — e.g. `OECD.SDD.NAD`. */
  agencyId: string;
  /** Concept identifier within the scheme — e.g. `FREQ`. */
  conceptId: string;
  /** Dimension the concept names, which is not always the concept id. */
  dimensionId: string;
  /** Concept scheme identifier — e.g. `CS_NA`. */
  schemeId: string;
  /** Scheme version the URN pins — see {@link OecdDimension.codelistVersion} for why a reference is fetched at its version. */
  version?: string | undefined;
}

/** Identity of the concept scheme a ref points at, for de-duplicating fetches. */
function schemeKey(ref: ConceptRef): string {
  return `${ref.agencyId}/${ref.schemeId}/${ref.version ?? ''}`;
}

/**
 * Resolve the concept scheme and concept a `conceptIdentity` URN names.
 * URN format: `urn:sdmx:...Concept=AGENCY:SCHEME_ID(version).CONCEPT_ID`.
 * Returns undefined when the URN is absent or carries no version, which is the
 * only thing separating the scheme id from the concept id.
 */
function conceptRefFromUrn(urn: unknown, dimensionId: string): ConceptRef | undefined {
  if (typeof urn !== 'string') return;
  const eq = urn.lastIndexOf('=');
  if (eq < 0) return;
  const rest = urn.slice(eq + 1); // "AGENCY:SCHEME_ID(version).CONCEPT_ID"
  const colon = rest.indexOf(':');
  if (colon < 0) return;
  const agencyId = rest.slice(0, colon);
  const tail = rest.slice(colon + 1); // "SCHEME_ID(version).CONCEPT_ID"
  const paren = tail.indexOf('(');
  const close = tail.indexOf(')', paren + 1);
  if (paren < 0 || close < 0) return;
  const schemeId = tail.slice(0, paren);
  const conceptId = tail.slice(close + 1).replace(/^\./, '');
  if (!agencyId || !schemeId || !conceptId) return;
  return {
    agencyId,
    conceptId,
    dimensionId,
    schemeId,
    version: sdmxVersion(tail.slice(paren + 1, close)),
  };
}

/**
 * Resolve the codelist a dimension's `localRepresentation.enumeration` URN names.
 * URN format: `urn:sdmx:...Codelist=AGENCY:CL_ID(version)`.
 * Returns undefined when the URN is absent or names no agency and id.
 */
function codelistRefFromUrn(
  urn: unknown,
): { ref: string; version?: string | undefined } | undefined {
  if (typeof urn !== 'string') return;
  const eq = urn.lastIndexOf('=');
  if (eq < 0) return;
  const rest = urn.slice(eq + 1); // "AGENCY:CL_ID(version)"
  const paren = rest.indexOf('(');
  const close = rest.indexOf(')', paren + 1);
  const agencyCl = paren >= 0 ? rest.slice(0, paren) : rest; // "AGENCY:CL_ID"
  const colon = agencyCl.indexOf(':');
  if (colon < 0) return;
  const agencyId = agencyCl.slice(0, colon);
  const codelistId = agencyCl.slice(colon + 1);
  if (!agencyId || !codelistId) return;
  const version =
    paren >= 0 && close > paren ? sdmxVersion(rest.slice(paren + 1, close)) : undefined;
  return { ref: `${agencyId},${codelistId}`, version };
}

/**
 * Extract the DSD identifier from the structure URN.
 * URN format: `urn:sdmx:...=AGENCY:DSD_ID(version)` or `urn:sdmx:...=AGENCY:DSD_ID`.
 * Returns undefined when the URN cannot be parsed.
 *
 * The version is discarded rather than carried, unlike the codelist and
 * concept-scheme URNs: this one only labels a catalog entry. Nothing addresses
 * a datastructure by it — a `flow_ref` is what the endpoints answer, and it is
 * built from the catalogued id.
 */
function dsdIdFromStructureUrn(urn: string): string | undefined {
  // Match the part after the last '=' and before any '(' or end
  const eq = urn.lastIndexOf('=');
  if (eq < 0) return;
  const rest = urn.slice(eq + 1); // "AGENCY:DSD_ID(version)" or "AGENCY:DSD_ID"
  const colon = rest.indexOf(':');
  if (colon < 0) return;
  const dsdPart = rest.slice(colon + 1); // "DSD_ID(version)" or "DSD_ID"
  const paren = dsdPart.indexOf('(');
  return paren >= 0 ? dsdPart.slice(0, paren) : dsdPart;
}

function parseDataflows(data: unknown): OecdDataflow[] {
  const structures = sdmxRecord(sdmxRecord(data, 'response').data, 'data');
  const rawFlows = sdmxRecords(structures.dataflows, 'dataflows');

  return rawFlows.map((f): OecdDataflow => {
    const agencyId = String(f.agencyID ?? '');
    const rawId = String(f.id ?? '');

    // f.id is either "DSD_XXX@DF_YYY" (most flows) or just "DF_YYY" (a few non-OECD flows).
    // The structure field is a string URN — not an object — so we extract the DSD id from it.
    const atIdx = rawId.indexOf('@');
    let dsdId: string;
    let flowId: string;
    if (atIdx >= 0) {
      // Combined format: split into DSD and DF parts
      dsdId = rawId.slice(0, atIdx);
      flowId = rawId.slice(atIdx + 1);
    } else {
      // DF-only id: extract DSD from the structure URN; fall back to replacing DF_ prefix
      const structureUrn = typeof f.structure === 'string' ? f.structure : '';
      dsdId = dsdIdFromStructureUrn(structureUrn) ?? rawId.replace(/^DF_/, 'DSD_');
      flowId = rawId;
    }
    // The catalog id is the reference the endpoints answer. Pairing a DF-only
    // id with the datastructure named in its URN builds a combined ref the data
    // endpoint rejects, so the id is passed through as published.
    const flowRef = `${agencyId},${rawId}`;

    const name = localizedString(f.name) ?? rawId;

    // OECD ships the abstract as HTML; store it as plain text so search and
    // rendering both work on the same value.
    const rawDescription = localizedString(f.description);
    const description = rawDescription ? stripHtml(rawDescription) : undefined;

    return {
      flowRef,
      agencyId,
      flowId,
      dsdId,
      name: String(name),
      ...(description ? { description } : {}),
    };
  });
}

/** Dataflow-level metadata carried by `data.dataflows[0]`. */
interface DataflowMeta {
  description?: string | undefined;
  name?: string | undefined;
  resources?: OecdExternalResource[] | undefined;
  version?: string;
}

/** Parse `EXT_RESOURCE` annotations (`label|url` or `label|url|icon_url`, `http:`/`https:` only). */
function parseExternalResources(annotations: unknown): OecdExternalResource[] | undefined {
  if (!Array.isArray(annotations)) return;
  const resources: OecdExternalResource[] = [];
  for (const entry of annotations) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'EXT_RESOURCE') continue;
    const raw = nonEmptyLocalizedString(record.text, record.texts);
    if (!raw) continue;
    const segments = raw.split('|');
    if (segments.length < 2) continue;
    const label = segments[0]?.trim() ?? '';
    const url = segments[1]?.trim() ?? '';
    if (!label || !url || !isHttpUrl(url)) continue;
    resources.push({ label, url });
  }
  return resources.length > 0 ? resources : undefined;
}

/** Extract `name`, full Markdown `description`, and `EXT_RESOURCE` links from `data.dataflows[0]`. */
function parseDataflowMeta(record: Record<string, unknown>): DataflowMeta | undefined {
  const name = nonEmptyLocalizedString(record.name, record.names);

  const rawDesc = nonEmptyLocalizedString(record.description, record.descriptions);
  const description = (rawDesc ? htmlToMarkdown(rawDesc) : '') || undefined;

  const resources = parseExternalResources(record.annotations);
  const version = sdmxVersion(record.version);

  if (
    name === undefined &&
    description === undefined &&
    resources === undefined &&
    version === undefined
  )
    return;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * The datastructure plus the concept references needed to name its dimensions,
 * which the response itself does not carry.
 */
interface ParsedDataStructure {
  conceptRefs: ConceptRef[];
  meta?: DataflowMeta | undefined;
  /**
   * What the response defines. The flow ref and agency it was asked for, and
   * the roots that served it and its data, are the caller's to record: one
   * datastructure response can answer more than one flow ref.
   */
  structure: Omit<
    OecdDataStructure,
    | 'agencyId'
    | 'conceptLookupFailedFor'
    | 'dataRoot'
    | 'description'
    | 'flowRef'
    | 'name'
    | 'resources'
    | 'serviceRoot'
  >;
}

/**
 * What a datastructure or dataflow-reference response carries: the
 * datastructure, or failing that the service root the dataflow entry delegates
 * to, or neither.
 */
type StructureResponse =
  | { kind: 'absent'; meta?: DataflowMeta | undefined }
  | { kind: 'delegated'; meta?: DataflowMeta | undefined; root: string }
  | { kind: 'structure'; parsed: ParsedDataStructure };

/**
 * Read a datastructure or dataflow-reference response. The delegation links
 * are read only from a response that carries no datastructure — the one case
 * that needs them.
 */
function parseStructureResponse(
  data: unknown,
  baseUrl: string,
  exactEdition: boolean,
): StructureResponse {
  const structures = sdmxRecord(sdmxRecord(data, 'response').data, 'data');
  const { dataflows, dataStructures } = structures;
  if (dataflows === undefined && dataStructures === undefined) {
    throw new TypeError('Expected SDMX dataflows or dataStructures');
  }
  const flow = dataflows === undefined ? undefined : sdmxRecords(dataflows, 'dataflows')[0];
  const candidates =
    dataStructures === undefined ? [] : sdmxRecords(dataStructures, 'dataStructures');
  const dsd =
    exactEdition && candidates.length > 0
      ? referencedDataStructure(candidates, flow?.structure)
      : candidates[0];
  const meta = flow && parseDataflowMeta(flow);
  const parsed = dsd && parseDataStructure(dsd, meta);
  if (parsed) return { kind: 'structure', parsed };
  const root = externalServiceRootOf(data, baseUrl);
  return root
    ? { kind: 'delegated', root, ...(meta ? { meta } : {}) }
    : { kind: 'absent', ...(meta ? { meta } : {}) };
}

/** Prefer the DSD named by the flow's URN. Sparse identity fields do not contradict it. */
function referencedDataStructure(
  candidates: Record<string, unknown>[],
  urn: unknown,
): Record<string, unknown> | undefined {
  if (typeof urn !== 'string') return candidates[0];
  const reference =
    /^urn:sdmx:org\.sdmx\.infomodel\.datastructure\.DataStructure=([^:]+):([^(]+?)(?:\(([^)]+)\))?$/.exec(
      urn,
    );
  if (!reference) return candidates[0];
  const fields = [
    ['agencyID', reference[1]],
    ['id', reference[2]],
    ['version', reference[3]],
  ] as const;
  let best: Record<string, unknown> | undefined;
  let bestMatch = -1;
  for (const candidate of candidates) {
    if (
      fields.some(
        ([key, value]) =>
          value !== undefined && candidate[key] !== undefined && candidate[key] !== value,
      )
    )
      continue;
    const matches = fields.filter(
      ([key, value]) => value !== undefined && candidate[key] === value,
    ).length;
    if (matches > bestMatch) {
      best = candidate;
      bestMatch = matches;
    }
  }
  if (best === undefined)
    throw serializationError(
      'OECD returned a different datastructure than the dataflow edition references',
    );
  return best;
}

/** Decode the selected datastructure in a structure response. */
function parseDataStructure(
  dsd: Record<string, unknown>,
  meta?: DataflowMeta,
): ParsedDataStructure {
  const components = sdmxRecord(dsd.dataStructureComponents, 'dataStructureComponents');
  const dimList = sdmxRecord(components.dimensionList, 'dimensionList');
  const rawDims = sdmxRecords(dimList.dimensions, 'dimensions');
  // API uses "timeDimensions" (plural, array) — not "timeDimension" (singular)
  const rawTimeDims =
    dimList.timeDimensions === undefined
      ? []
      : sdmxRecords(dimList.timeDimensions, 'timeDimensions');
  const rawTimeDim = rawTimeDims[0];

  const conceptRefs: ConceptRef[] = [];
  for (const d of [...rawDims, ...(rawTimeDim ? [rawTimeDim] : [])]) {
    const ref = conceptRefFromUrn(d.conceptIdentity, String(d.id ?? ''));
    if (ref) conceptRefs.push(ref);
  }

  const dimensions = rawDims
    .map((d): OecdDimension => {
      const name = localizedString(d.name) ?? String(d.id ?? '');

      // Codelist reference sits inside localRepresentation.enumeration, which
      // is a string URN: "urn:sdmx:...=AGENCY:CL_ID(version)".
      const localRep = d.localRepresentation as Record<string, unknown> | undefined;
      const codelist = codelistRefFromUrn(localRep?.enumeration);

      // API positions are 0-based; expose as 1-based for user-facing key construction
      return {
        id: String(d.id ?? ''),
        name: String(name),
        position: Number(d.position ?? 0) + 1,
        codelistRef: codelist?.ref,
        codelistVersion: codelist?.version,
      };
    })
    .sort((a, b) => a.position - b.position);

  let timeDimension: OecdTimeDimension | undefined;
  if (rawTimeDim) {
    const name = localizedString(rawTimeDim.name) ?? String(rawTimeDim.id ?? 'TIME_PERIOD');
    timeDimension = {
      id: String(rawTimeDim.id ?? 'TIME_PERIOD'),
      name: String(name),
      position: dimensions.length + 1,
    };
  }

  return {
    conceptRefs,
    ...(meta ? { meta } : {}),
    structure: {
      // The response is authoritative: the `{dsd_id}` half of a combined flow
      // ref is a label OECD does not keep in step with the real datastructure.
      dsdId: String(dsd.id ?? ''),
      dimensions,
      timeDimension,
    },
  };
}

/** Read a concept scheme into a `concept id → name` map. */
function parseConceptScheme(data: unknown): Map<string, string> {
  const structures = sdmxRecord(sdmxRecord(data, 'response').data, 'data');
  const [scheme] = sdmxRecords(structures.conceptSchemes, 'conceptSchemes');
  const rawConcepts =
    scheme?.concepts === undefined ? [] : sdmxRecords(scheme.concepts, 'concepts');

  const names = new Map<string, string>();
  for (const concept of rawConcepts) {
    const id = String(concept.id ?? '');
    const name = localizedString(concept.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

/** Read the OECD agency scheme into a `directorate code → name` map. */
function parseAgencyScheme(data: unknown): Map<string, string> {
  const structures = sdmxRecord(sdmxRecord(data, 'response').data, 'data');
  const [scheme] = sdmxRecords(structures.agencySchemes, 'agencySchemes');
  const rawAgencies =
    scheme?.agencies === undefined ? [] : sdmxRecords(scheme.agencies, 'agencies');

  const names = new Map<string, string>();
  for (const agency of rawAgencies) {
    const id = String(agency.id ?? '');
    const name = localizedString(agency.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

function parseCodelist(data: unknown): OecdCode[] {
  const structures = sdmxRecord(sdmxRecord(data, 'response').data, 'data');
  const [cl] = sdmxRecords(structures.codelists, 'codelists');
  if (!cl) return [];

  const rawCodes = cl.codes === undefined ? [] : sdmxRecords(cl.codes, 'codes');
  return rawCodes.map((c): OecdCode => {
    const parent = typeof c.parent === 'string' && c.parent.length > 0 ? c.parent : undefined;
    return {
      id: String(c.id ?? ''),
      name: localizedString(c.name) ?? String(c.id ?? ''),
      ...(parent !== undefined ? { parent } : {}),
    };
  });
}

/**
 * Returns true when an error (or its cause chain) signals that an agency,
 * dataflow, or datastructure was not found. Both sources are structural: an
 * upstream HTTP 404 arrives as `NotFound` from `fetchWithTimeout`, and a ref
 * that no route resolves to a datastructure is thrown as `notFound()` by
 * `fetchDataStructure`. Tool handlers use it to map service errors onto their
 * typed not-found contract entry.
 */
export function isDataflowNotFound(e: Error): boolean {
  if (e instanceof McpError && e.code === JsonRpcErrorCode.NotFound) return true;
  const cause = (e as { cause?: unknown }).cause;
  return cause instanceof Error ? isDataflowNotFound(cause) : false;
}
