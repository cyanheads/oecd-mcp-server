/**
 * @fileoverview Domain types for the OECD SDMX structure API.
 * @module services/oecd-structure/types
 */

/** A single OECD dataflow entry from the structure API. */
export interface OecdDataflow {
  /** Agency identifier — e.g. `OECD.SDD.NAD`. */
  agencyId: string;
  /**
   * Full abstract as plain text. OECD publishes it as HTML; tags and entities are
   * resolved at parse time. Absent for the dataflows OECD ships without one.
   */
  description?: string | undefined;
  /** Datastructure identifier — e.g. `DSD_NAAG`. */
  dsdId: string;
  /** Dataflow identifier — e.g. `DF_NAAG_I`. */
  flowId: string;
  /**
   * Full flow reference as OECD catalogues it — `{agencyID},{dsd_id}@{df_id}`
   * for nearly every dataflow (`OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`), and the bare
   * `{agencyID},{df_id}` for the handful published without a datastructure
   * prefix (`OECD.TAD.ARP,DF_AEI2024_DASHBOARD`).
   */
  flowRef: string;
  /** Human-readable name. */
  name: string;
}

/** A dimension of a datastructure. */
export interface OecdDimension {
  /** Codelist reference, if available — e.g. `OECD.SDD.NAD,CL_AREA`. */
  codelistRef?: string | undefined;
  /**
   * Codelist version the datastructure references — e.g. `1.7`. A codelist is
   * versioned independently of the datastructures that use it, and an
   * unversioned request answers with the root's current latest, which offers
   * codes a dimension pinned to an older revision rejects. Absent when the
   * enumeration URN names no version this server will address.
   */
  codelistVersion?: string | undefined;
  /** Dimension identifier — e.g. `REF_AREA`. */
  id: string;
  /**
   * Concept name resolved from the datastructure's concept scheme — e.g.
   * `Reference area`. Falls back to the id when the scheme is unreachable or
   * does not cover the dimension.
   */
  name: string;
  /** 1-based position in the dot-delimited key. */
  position: number;
}

/** A time dimension — always the last position. */
export interface OecdTimeDimension {
  id: string;
  /** Concept name, falling back to the id — see {@link OecdDimension.name}. */
  name: string;
  position: number;
}

/** An external resource linked from a dataflow's `EXT_RESOURCE` annotation. */
export interface OecdExternalResource {
  /** Human-readable resource label. */
  label: string;
  /** Target URL (`http:` or `https:` only). */
  url: string;
}

/** Datastructure metadata for a dataflow, at the revision the dataflow references. */
export interface OecdDataStructure {
  agencyId: string;
  /** Dimension IDs, including time, whose concept schemes could not be read. */
  conceptLookupFailedFor?: string[];
  /**
   * OECD service root that serves this dataflow's data, and so its availability
   * record: the root the configured catalog's dataflow entry delegates to when
   * it is published as a pointer (`rel: external`), and {@link serviceRoot}
   * otherwise. The two differ only for a delegated dataflow whose datastructure
   * the configured root also holds — the configured root defines the structure
   * but answers its data and availability reads with a 500.
   */
  dataRoot: string;
  /**
   * Full dataflow abstract as plain text with valid `<a>` links preserved as
   * Markdown `[label](url)`. Absent when OECD publishes no description.
   */
  description?: string | undefined;
  dimensions: OecdDimension[];
  dsdId: string;
  flowRef: string;
  /** Human-readable dataflow name. Absent when the upstream response carries no dataflow entry. */
  name?: string | undefined;
  /**
   * Linked external resources from the dataflow's `EXT_RESOURCE` annotations
   * (`http:` / `https:` URLs only). Absent when the dataflow carries none.
   */
  resources?: OecdExternalResource[] | undefined;
  /**
   * OECD service root that served this datastructure — the configured base URL
   * for nearly every dataflow, and the root named in the catalog entry's
   * `rel: external` link for the ones published as a pointer rather than a
   * definition. Codelists and concept schemes are versioned per root and the
   * public catalog mirrors an older revision of both, so a label lookup for
   * these dimensions has to address the root recorded here.
   */
  serviceRoot: string;
  timeDimension?: OecdTimeDimension | undefined;
  /** Edition published by the dataflow, independent of the datastructure revision. */
  version?: string;
}

/** A single code in a codelist. */
export interface OecdCode {
  /** Code identifier — e.g. `USA`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Parent code identifier in hierarchical codelists — e.g. `FRA` for French TL2 regions. */
  parent?: string | undefined;
}
