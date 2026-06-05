/**
 * @fileoverview Domain types for the OECD SDMX data API.
 * @module services/oecd-data/types
 */

/** A decoded observation row — all dimension values resolved to human-readable labels. */
export interface DecodedRow {
  /** OECD attribution — always "OECD". */
  source: 'OECD';
  /** Numeric observation value (null when not present). */
  value: number | null;
  /** Key-value pairs for each dimension, e.g. `{ REF_AREA: "USA", MEASURE: "B1GQ" }`. */
  [dimension: string]: string | number | null;
}

/** Result of an OECD data query. */
export interface OecdDataResult {
  rowCount: number;
  rows: DecodedRow[];
  source: 'OECD';
}
