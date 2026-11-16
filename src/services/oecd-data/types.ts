/**
 * @fileoverview Domain types for the OECD SDMX data API.
 * @module services/oecd-data/types
 */

/** A decoded observation row — dimension and attribute codes resolved to human-readable labels, each code kept beside its label. */
export interface DecodedRow {
  /** OECD attribution — always "OECD". */
  source: 'OECD';
  /**
   * Observation value, already multiplied by {@link DecodedRow.value_scale}
   * (null when the observation carries no numeric value).
   */
  value: number | null;
  /**
   * Power of ten applied to `value` from the `UNIT_MULT` attribute, at
   * whichever level the response presents it — 1 when the dataflow declares
   * no multiplier. Divide `value` by it to recover the figure as OECD
   * published it.
   */
  value_scale: number;
  /**
   * One entry per dimension and per attribute the response presents — at the
   * dataset, dimension-group, or observation level — holding its label, e.g.
   * `{ REF_AREA: "United States", UNIT_MULT: "Billions" }`, plus `<ID>_code`
   * beside each coded one (`REF_AREA_code: "USA"`). `TIME_PERIOD` and uncoded
   * attributes, whose value is already the code, have none. Attributes absent
   * from a slice are omitted from the row.
   */
  [component: string]: string | number | null;
}

/** One column of a decoded result, in row order. */
export interface OecdColumn {
  /**
   * On a coded component's label column, the name of the column holding its
   * code — `REF_AREA_code` beside `REF_AREA`.
   */
  codeColumn?: string;
  /**
   * Column name — `value`, `value_scale`, `source`, a dimension or attribute
   * ID, or the `<ID>_code` column that follows a coded component.
   */
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
  /** Sorted by each observation-level dimension's code in key order, `TIME_PERIOD` last. */
  rows: DecodedRow[];
  /**
   * The service root that answered the query, empty result included: the
   * configured root, or the root a delegated catalog entry named. A read that
   * follows the query — the availability record of a key that matched nothing —
   * belongs on this root, which is not always the one that defines the
   * datastructure. It has passed the origin check, so it may become a URL.
   */
  serviceRoot: string;
  source: 'OECD';
}
