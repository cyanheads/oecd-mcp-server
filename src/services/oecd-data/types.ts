/**
 * @fileoverview Domain types for the OECD SDMX data API.
 * @module services/oecd-data/types
 */

/** A decoded observation row — dimension and attribute codes resolved to human-readable labels. */
export interface DecodedRow {
  /** OECD attribution — always "OECD". */
  source: 'OECD';
  /**
   * Observation value, already multiplied by {@link DecodedRow.value_scale}
   * (null when the observation carries no numeric value).
   */
  value: number | null;
  /**
   * Power of ten applied to `value` from the observation's `UNIT_MULT`
   * attribute — 1 when the dataflow declares no multiplier. Divide `value` by
   * it to recover the figure as OECD published it.
   */
  value_scale: number;
  /**
   * One entry per dimension and per observation-level attribute declared by the
   * dataflow, e.g. `{ REF_AREA: "United States", UNIT_MULT: "Billions" }`.
   * Attributes absent from a slice are omitted from the row.
   */
  [component: string]: string | number | null;
}

/** One column of a decoded result, in row order. */
export interface OecdColumn {
  /** Column name — `value`, `value_scale`, `source`, a dimension ID, or an attribute ID. */
  name: string;
  /** JS type of the column's values. */
  type: 'number' | 'string';
}

/** Result of an OECD data query. */
export interface OecdDataResult {
  /**
   * Every column the dataflow declares, including attributes that are sparse or
   * absent across the returned rows. Sized from the SDMX structure rather than
   * the rows, so a downstream consumer sees the full shape without sampling.
   */
  columns: OecdColumn[];
  rowCount: number;
  rows: DecodedRow[];
  source: 'OECD';
}
