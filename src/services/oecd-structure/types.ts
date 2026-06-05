/**
 * @fileoverview Domain types for the OECD SDMX structure API.
 * @module services/oecd-structure/types
 */

/** A single OECD dataflow entry from the structure API. */
export interface OecdDataflow {
  /** Agency identifier — e.g. `OECD.SDD.NAD`. */
  agencyId: string;
  /** Datastructure identifier — e.g. `DSD_NAAG`. */
  dsdId: string;
  /** Dataflow identifier — e.g. `DF_NAAG_I`. */
  flowId: string;
  /** Full flow reference: `{agencyID},{dsd_id}@{df_id}` — e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`. */
  flowRef: string;
  /** Human-readable name. */
  name: string;
  /** True when flagged NonProductionDataflow. */
  nonProduction: boolean;
}

/** A dimension of a datastructure. */
export interface OecdDimension {
  /** Codelist reference, if available — e.g. `OECD.SDD.NAD,CL_AREA`. */
  codelistRef?: string | undefined;
  /** Dimension identifier — e.g. `REF_AREA`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** 1-based position in the dot-delimited key. */
  position: number;
}

/** A time dimension — always the last position. */
export interface OecdTimeDimension {
  id: string;
  name: string;
  position: number;
}

/** Datastructure metadata for a dataflow. */
export interface OecdDataStructure {
  agencyId: string;
  dimensions: OecdDimension[];
  dsdId: string;
  flowRef: string;
  nonProduction: boolean;
  timeDimension?: OecdTimeDimension | undefined;
}

/** A single code in a codelist. */
export interface OecdCode {
  /** Code identifier — e.g. `USA`. */
  id: string;
  /** Human-readable name. */
  name: string;
}
