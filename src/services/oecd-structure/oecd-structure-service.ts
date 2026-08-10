/**
 * @fileoverview OECD SDMX structure service — wraps the dataflow, datastructure,
 * codelist, concept-scheme, and agency-scheme endpoints.
 * @module services/oecd-structure/oecd-structure-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { externalServiceRootOf } from '@/services/oecd-http/external-service-root.js';
import { fetchOecd } from '@/services/oecd-http/oecd-http.js';
import type {
  OecdCode,
  OecdDataflow,
  OecdDataStructure,
  OecdDimension,
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
 * Allowed shape of an SDMX artefact version, which is a dot-separated run of
 * digits (`1.0`, `1.7`). Versions arrive inside upstream URNs and land in a URL
 * path segment, so anything else is dropped at parse time and the reference is
 * carried unversioned rather than pinned to something unfetchable.
 */
const SDMX_VERSION_SAFE = /^\d+(?:\.\d+)*$/;

/** The version an upstream URN pins a reference to, or undefined when it names none this server will address. */
function safeVersion(version: string): string | undefined {
  return SDMX_VERSION_SAFE.test(version) ? version : undefined;
}

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

/** Fetch and decode one structure endpoint. */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchOecd(url, {
    accept: STRUCTURE_ACCEPT,
    // An unknown agency or dataflow is a caller mistake, not a server fault.
    expectedStatuses: [404],
    operation: 'oecdStructureFetch',
    ...(signal ? { signal } : {}),
  });
  return res.json() as Promise<unknown>;
}

/**
 * Retry a structure fetch and label the failure with the call that produced it,
 * preserving the upstream classification so a terminal 4xx does not resurface as
 * a transient outage.
 */
function fetchStructureJson(
  url: string,
  failureMessage: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const retryOpts = { maxRetries: 2, ...(signal ? { signal } : {}) };
  return withRetry(() => fetchJson(url, signal), retryOpts).catch((err: unknown) => {
    if (err instanceof McpError) {
      throw new McpError(err.code, failureMessage, err.data, { cause: err });
    }
    throw serviceUnavailable(failureMessage, {}, { cause: err });
  });
}

/** The id a dataflow is catalogued under — combined `{dsd}@{df}`, or bare `{df}`. */
function dataflowIdOf(parts: { dfId: string; dsdId?: string }): string {
  return parts.dsdId ? `${parts.dsdId}@${parts.dfId}` : parts.dfId;
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
 * A failed lookup resolves to undefined: this runs only when the caller already
 * holds a real error to report, and a second failure must not replace the first.
 *
 * One attempt, deliberately unretried. The caller reaches here holding a
 * failure it wants settled faster than a retry loop would settle it, so
 * answering "where does this flow live" with three requests and a backoff would
 * reintroduce the delay on the catalog endpoint that skipping the retries on
 * the data endpoint just removed.
 */
export async function fetchExternalServiceRoot(
  baseUrl: string,
  flowRef: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const parts = parseFlowRef(flowRef);
  if (!parts) return;

  const payload = await fetchJson(
    `${baseUrl}/dataflow/${parts.agencyId}/${dataflowIdOf(parts)}`,
    signal,
  ).catch(() => undefined);

  return payload === undefined ? undefined : externalServiceRootOf(payload, baseUrl);
}

let _instance: OecdStructureService | undefined;

/** Service for fetching OECD SDMX structural metadata. */
export class OecdStructureService {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Fetch all dataflows, optionally filtered by agency.
   * Uses `GET /dataflow/{agencyID}` or `GET /dataflow` for all agencies.
   */
  async fetchDataflows(agencyId?: string, signal?: AbortSignal): Promise<OecdDataflow[]> {
    // agencyId comes straight from caller input. A value outside the SDMX
    // character set cannot name any agency, so it is a not-found — never a
    // transient failure the caller should retry.
    if (agencyId !== undefined && !SDMX_ID_SAFE.test(agencyId)) {
      throw notFound(`Invalid agency identifier: ${agencyId}`, { agencyId });
    }
    const url = agencyId ? `${this.baseUrl}/dataflow/${agencyId}` : `${this.baseUrl}/dataflow`;

    const data = await fetchStructureJson(
      url,
      `Failed to fetch OECD dataflows${agencyId ? ` for agency ${agencyId}` : ''}`,
      signal,
    );

    return parseDataflows(data);
  }

  /**
   * Fetch the datastructure for a flow ref, with each dimension's name resolved
   * from its concept scheme.
   *
   * Two routes, because neither covers the catalog alone.
   *
   * A combined `{dsd_id}@{df_id}` ref names a datastructure directly, so
   * `GET /datastructure/{agencyID}/{dsd_id}` answers in one request and stays
   * the first attempt. But the `{dsd_id}` half is a label OECD does not keep in
   * step with the real datastructure — for part of the catalog it names one
   * that does not exist (`DSD_REG_LAB@DF_RATES` is backed by `DSD_REG_LABOUR`),
   * and that route answers 404 for a dataflow the data endpoint serves happily.
   *
   * So a not-found falls back to asking the dataflow for its own datastructure:
   * `GET /dataflow/{agencyID}/{id}?references=datastructure` returns the same
   * `dataStructures` payload keyed to the id OECD actually catalogues. That is
   * also the only route for a bare `{agencyID},{df_id}` ref, which carries no
   * datastructure id to address at all.
   *
   * The fallback is second rather than first because the reference route is not
   * a superset: a dataflow OECD publishes as an external reference carries no
   * inline datastructure, and for several of those the datastructure is
   * nonetheless reachable on its own endpoint. Trying the direct route first
   * keeps them working; falling back covers the mismatched prefixes. Only the
   * refs the first route cannot resolve pay the second request.
   *
   * Every route asks for latest. A `flow_ref` carries no version, and learning
   * which one to pin would cost a catalog request to answer a question nothing
   * asked — this is the entry point, not a reference followed from somewhere
   * else. Whichever revision answers is then the authority for the lookups that
   * follow it, so the codelists and concept schemes read back at the versions
   * it names are coherent with the dimensions it declared.
   *
   * A third route exists for the entries neither of the first two can answer.
   * Part of the catalog is published as a pointer rather than a definition —
   * `isExternalReference: true`, no `structure` URN, and a `links[]` entry
   * naming the OECD service root that owns the real thing. The second route's
   * response already carries that link, so following it costs one request and
   * only on a ref that would otherwise have failed.
   */
  async fetchDataStructure(flowRef: string, signal?: AbortSignal): Promise<OecdDataStructure> {
    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw new Error(`Invalid flow_ref format: ${flowRef}`);
    }

    /**
     * Root that answered. Codelists and concept schemes are versioned per root
     * — the public catalog mirrors an older revision of both for the delegated
     * entries — so the labels for this structure have to be read back from
     * whichever root defined it.
     */
    let serviceRoot = this.baseUrl;
    let parsed: ParsedDataStructure | undefined;

    if (parts.dsdId) {
      parsed = await this.loadDataStructure(
        `${this.baseUrl}/datastructure/${parts.agencyId}/${parts.dsdId}`,
        flowRef,
        parts.agencyId,
        signal,
      ).catch(swallowNotFound);
    }

    if (!parsed) {
      // The dataflow is catalogued under the id as published — combined or bare.
      const payload = await fetchStructureJson(
        `${this.baseUrl}/dataflow/${parts.agencyId}/${dataflowIdOf(parts)}?references=datastructure`,
        `Failed to fetch OECD datastructure for ${flowRef}`,
        signal,
      );
      try {
        parsed = parseDataStructure(payload, flowRef, parts.agencyId);
      } catch (err) {
        if (!isDataflowNotFound(err as Error)) throw err;
        const external = externalServiceRootOf(payload, this.baseUrl);
        // No delegation to follow means the ref genuinely resolves nowhere.
        if (!external) throw err;
        parsed = await this.loadDelegatedDataStructure(external, parts, flowRef, signal);
        serviceRoot = external;
      }
    }

    return this.applyConceptNames({ ...parsed.structure, serviceRoot }, parsed.conceptRefs, signal);
  }

  /**
   * Resolve a datastructure on the service root the catalog delegated to,
   * trying the same two routes in the same order and for the same reasons as
   * {@link fetchDataStructure}. The delegating root is only ever the validated
   * one {@link externalServiceRootOf} returns; the path is rebuilt here from
   * identifiers `parseFlowRef` already checked, never from the upstream href.
   */
  private async loadDelegatedDataStructure(
    serviceRoot: string,
    parts: { agencyId: string; dfId: string; dsdId?: string },
    flowRef: string,
    signal?: AbortSignal,
  ): Promise<ParsedDataStructure> {
    if (parts.dsdId) {
      const direct = await this.loadDataStructure(
        `${serviceRoot}/datastructure/${parts.agencyId}/${parts.dsdId}`,
        flowRef,
        parts.agencyId,
        signal,
      ).catch(swallowNotFound);
      if (direct) return direct;
    }

    return this.loadDataStructure(
      `${serviceRoot}/dataflow/${parts.agencyId}/${dataflowIdOf(parts)}?references=datastructure`,
      flowRef,
      parts.agencyId,
      signal,
    );
  }

  /** Fetch one structure endpoint and read the datastructure out of it. */
  private async loadDataStructure(
    url: string,
    flowRef: string,
    agencyId: string,
    signal?: AbortSignal,
  ): Promise<ParsedDataStructure> {
    const data = await fetchStructureJson(
      url,
      `Failed to fetch OECD datastructure for ${flowRef}`,
      signal,
    );
    return parseDataStructure(data, flowRef, agencyId);
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
   * {@link SDMX_VERSION_SAFE} and this parameter becomes a URL path segment.
   */
  async fetchConceptScheme(
    agencyId: string,
    schemeId: string,
    signal?: AbortSignal,
    serviceRoot: string = this.baseUrl,
    version?: string,
  ): Promise<Map<string, string>> {
    // Both IDs come from a datastructure URN, but validate as a safety net
    // before embedding in the URL path.
    if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(schemeId)) {
      throw serviceUnavailable(`Invalid concept scheme identifier: ${agencyId}/${schemeId}`, {
        agencyId,
        schemeId,
      });
    }
    const url = `${serviceRoot}/conceptscheme/${agencyId}/${schemeId}`;
    const label = `OECD concept scheme ${agencyId}/${schemeId}`;

    if (version !== undefined) {
      const pinned = await fetchStructureJson(
        `${url}/${version}`,
        `Failed to fetch ${label} version ${version}`,
        signal,
      ).catch(swallowNotFound);
      if (pinned !== undefined) return parseConceptScheme(pinned);
    }

    return parseConceptScheme(await fetchStructureJson(url, `Failed to fetch ${label}`, signal));
  }

  /**
   * Fetch the OECD directorate codes and their names as a `code → name` map.
   * Uses `GET /agencyscheme/OECD`, whose entries are keyed by the directorate
   * segment of a dotted agency identifier — see {@link directorateCode}.
   */
  async fetchDirectorates(signal?: AbortSignal): Promise<Map<string, string>> {
    const data = await fetchStructureJson(
      `${this.baseUrl}/agencyscheme/OECD`,
      'Failed to fetch the OECD agency scheme',
      signal,
    );

    return parseAgencyScheme(data);
  }

  /**
   * Replace each dimension's id-shaped placeholder name with the concept name
   * its `conceptIdentity` URN points at.
   *
   * Best-effort by design: OECD's datastructure response carries no name on a
   * dimension, so the names live one request away in the concept scheme. A
   * scheme that fails to fetch, or one that omits a concept, leaves the
   * dimension on its id. A missing label is a tolerable gap; failing the whole
   * dataset-info call over one is not. A datastructure whose dimensions carry
   * no parseable `conceptIdentity` issues no request at all.
   */
  private async applyConceptNames(
    structure: OecdDataStructure,
    conceptRefs: ConceptRef[],
    signal?: AbortSignal,
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
                ref.agencyId,
                ref.schemeId,
                signal,
                structure.serviceRoot,
                ref.version,
              ).catch(() => new Map<string, string>()),
            ] as const,
        ),
      ),
    );

    const names = new Map<string, string>();
    for (const ref of conceptRefs) {
      const name = bySchemeKey.get(schemeKey(ref))?.get(ref.conceptId);
      if (name) names.set(ref.dimensionId, name);
    }
    if (names.size === 0) return structure;

    return {
      ...structure,
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
   * Pass an {@link OecdDimension.codelistVersion}; anything else has not been
   * through {@link SDMX_VERSION_SAFE} and this parameter becomes a URL path
   * segment.
   */
  async fetchCodelist(
    agencyId: string,
    codelistId: string,
    signal?: AbortSignal,
    serviceRoot: string = this.baseUrl,
    version?: string,
  ): Promise<OecdCode[]> {
    // Both IDs are derived from upstream DSD responses, but validate as a safety net
    // before embedding in the URL path.
    if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(codelistId)) {
      throw serviceUnavailable(`Invalid codelist identifier: ${agencyId}/${codelistId}`, {
        agencyId,
        codelistId,
      });
    }
    const url = `${serviceRoot}/codelist/${agencyId}/${codelistId}`;
    const label = `OECD codelist ${agencyId}/${codelistId}`;

    if (version !== undefined) {
      const pinned = await fetchStructureJson(
        `${url}/${version}`,
        `Failed to fetch ${label} version ${version}`,
        signal,
      ).catch(swallowNotFound);
      if (pinned !== undefined) return parseCodelist(pinned);
    }

    return parseCodelist(await fetchStructureJson(url, `Failed to fetch ${label}`, signal));
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

/**
 * Named character references that appear in OECD dataflow descriptions, plus the
 * partners of the ones that do (`lt`, `mdash`). Numeric references do not occur
 * in the catalog and are left alone.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  deg: '°',
  eacute: 'é',
  gt: '>',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  ocirc: 'ô',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
  uuml: 'ü',
};

/**
 * Reduce an OECD description to plain text. The catalog copy is authored HTML —
 * paragraphs, lists, anchors, and headings — so tags become whitespace and the
 * named entities OECD uses are resolved. Tags are removed before entities are
 * decoded so a decoded `&lt;` can never form a new tag.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read an OECD localized string field, which is either a plain string or a `{lang: text}` map. */
function localizedString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.values(value as Record<string, string>)[0];
  return;
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
    version: safeVersion(tail.slice(paren + 1, close)),
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
    paren >= 0 && close > paren ? safeVersion(rest.slice(paren + 1, close)) : undefined;
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
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawFlows = (structures?.dataflows ?? []) as Array<Record<string, unknown>>;

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

    // Check for NonProductionDataflow annotation
    const annotations = (f.annotations ?? []) as Array<Record<string, unknown>>;
    const nonProduction = annotations.some((a) => String(a.id ?? '') === 'NonProductionDataflow');

    return {
      flowRef,
      agencyId,
      flowId,
      dsdId,
      name: String(name),
      ...(description ? { description } : {}),
      nonProduction,
    };
  });
}

/**
 * The datastructure plus the concept references needed to name its dimensions,
 * which the response itself does not carry.
 */
interface ParsedDataStructure {
  conceptRefs: ConceptRef[];
  /** The root that served it is the caller's to record — see {@link OecdDataStructure.serviceRoot}. */
  structure: Omit<OecdDataStructure, 'serviceRoot'>;
}

function parseDataStructure(data: unknown, flowRef: string, agencyId: string): ParsedDataStructure {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawDsds = (structures?.dataStructures ?? []) as Array<Record<string, unknown>>;

  const dsd = rawDsds[0];
  if (!dsd) {
    throw notFound(`DataStructure not found for ${flowRef}`, { flowRef });
  }

  const components = dsd.dataStructureComponents as Record<string, unknown> | undefined;
  const dimList = components?.dimensionList as Record<string, unknown> | undefined;

  const rawDims = (dimList?.dimensions ?? []) as Array<Record<string, unknown>>;
  // API uses "timeDimensions" (plural, array) — not "timeDimension" (singular)
  const rawTimeDims = (dimList?.timeDimensions ?? []) as Array<Record<string, unknown>>;
  const rawTimeDim = rawTimeDims[0];

  // Check NonProductionDataflow annotation
  const annotations = (dsd.annotations ?? []) as Array<Record<string, unknown>>;
  const nonProduction = annotations.some((a) => String(a.id ?? '') === 'NonProductionDataflow');

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
    structure: {
      flowRef,
      agencyId,
      // The response is authoritative: the `{dsd_id}` half of a combined flow
      // ref is a label OECD does not keep in step with the real datastructure.
      dsdId: String(dsd.id ?? ''),
      dimensions,
      timeDimension,
      nonProduction,
    },
  };
}

/** Read a concept scheme into a `concept id → name` map. */
function parseConceptScheme(data: unknown): Map<string, string> {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawSchemes = (structures?.conceptSchemes ?? []) as Array<Record<string, unknown>>;
  const rawConcepts = (rawSchemes[0]?.concepts ?? []) as Array<Record<string, unknown>>;

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
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawSchemes = (structures?.agencySchemes ?? []) as Array<Record<string, unknown>>;
  const rawAgencies = (rawSchemes[0]?.agencies ?? []) as Array<Record<string, unknown>>;

  const names = new Map<string, string>();
  for (const agency of rawAgencies) {
    const id = String(agency.id ?? '');
    const name = localizedString(agency.name);
    if (id && name) names.set(id, name);
  }
  return names;
}

function parseCodelist(data: unknown): OecdCode[] {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawCls = (structures?.codelists ?? []) as Array<Record<string, unknown>>;
  const cl = rawCls[0];
  if (!cl) return [];

  const rawCodes = (cl.codes ?? []) as Array<Record<string, unknown>>;
  return rawCodes.map(
    (c): OecdCode => ({
      id: String(c.id ?? ''),
      name: localizedString(c.name) ?? String(c.id ?? ''),
    }),
  );
}

/**
 * Returns true when an error (or its cause chain) signals that an agency,
 * dataflow, or datastructure was not found. Both sources are structural: an
 * upstream HTTP 404 arrives as `NotFound` from `fetchWithTimeout`, and an empty
 * `dataStructures` array is thrown as `notFound()` by `parseDataStructure`. Tool
 * handlers use it to map service errors onto their typed not-found contract entry.
 */
export function isDataflowNotFound(e: Error): boolean {
  if (e instanceof McpError && e.code === JsonRpcErrorCode.NotFound) return true;
  const cause = (e as { cause?: unknown }).cause;
  return cause instanceof Error ? isDataflowNotFound(cause) : false;
}
