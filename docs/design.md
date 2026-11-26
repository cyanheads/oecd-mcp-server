# OECD MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `oecd_search_datasets` | Search OECD dataflows by keyword or theme (word-start token matching, name matches first), or omit `query` to list an agency's or the catalog's dataflows in catalog order. Returns dataflow IDs, names, and agency identifiers needed for `oecd_get_dataset_info`. | `query` (optional text), `agency_id` (optional filter), `limit` (default 20; above 2,000 it is served at 2,000 with a `notice`, or rejected under `OECD_CLAMP_LIMITS=false`), `offset` | `readOnlyHint: true, idempotentHint: true` | `no_match` (NotFound) — no dataflows matched (or none published in scope); `agency_not_found` (NotFound) — `agency_id` not in the catalog; plus the shared upstream six (Design Decisions) |
| `oecd_list_agencies` | List the OECD SDMX agencies, the directorate each belongs to, and the number of dataflows each publishes. Use to discover agency IDs before filtering `oecd_search_datasets` by department. | — | `readOnlyHint: true, idempotentHint: true` | the shared upstream six (Design Decisions) only |
| `oecd_get_dataset_info` | Fetch a dataflow's name, full description (with methodology links preserved as Markdown), `EXT_RESOURCE` links, dimensions, their order, and how to construct a query key. Required before calling `oecd_query_dataset`. | `flow_ref` (e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`, or the bare `OECD.TAD.ARP,DF_AEI2024_DASHBOARD`) | `readOnlyHint: true, idempotentHint: true` | `invalid_flow_ref` (ValidationError) — malformed `flow_ref` format; `dataflow_not_found` (NotFound) — `flow_ref` does not exist; plus the shared upstream six (Design Decisions) |
| `oecd_get_dimension_values` | Fetch codes, labels, and optional hierarchy `parent` IDs for one dimension of a dataflow, narrowed by `available_only`/`key`, exact `parent`, and substring `query`, returned a page at a time. Returns `available_only`, and with it `time_range` and `observation_count`. | `flow_ref`, `dimension_id`, `parent` (optional exact parent code filter), `query` (optional substring), `available_only` (default false), `key` (optional; implies `available_only`), `limit` (default 50; above 10,000 it is served at 10,000 with a `notice`), `offset` | `readOnlyHint: true, idempotentHint: true` | `invalid_flow_ref` (ValidationError) — malformed `flow_ref` format; `dataflow_not_found` (NotFound) — `flow_ref` does not exist; `dimension_not_found` (NotFound) — `dimension_id` not in this dataflow's structure; `invalid_key` (ValidationError) — `key` holds a character outside the SDMX key set, fewer segments than dimensions, or any non-empty segment past the dimension count; plus the shared upstream six (Design Decisions) |
| `oecd_query_dataset` | Fetch observations from an OECD dataflow filtered by a dimension key, optional time range, and optional `last_n_observations` per series. Returns decoded rows (one per observation, sorted by dimension code then period) carrying the dimensions that vary as labels with `<ID>_code` beside them, `constant_columns` for the components that hold one value across the result, plus `canvas_id`, `table_name`, `truncated: true`, and at most 25 preview rows when the result spills to DataCanvas. | `flow_ref`, `key` (dot-delimited), `start_period`, `end_period`, `last_n_observations` (optional integer `1..100,000`), `canvas_id` (optional) | `readOnlyHint: true, idempotentHint: true` | `invalid_flow_ref` (ValidationError) — malformed `flow_ref` format; `dataflow_not_found` (NotFound) — `flow_ref` does not exist; `no_results` (NotFound) — valid flow but no observations match the key/time range; the message names the pinned segment with no data given the rest of the key, a code matching only by letter case, or a period wholly outside the key's range, read from OECD's availability record; `invalid_key` (ValidationError) — a character outside the SDMX key set, too few segments, an extra non-empty segment past the dimension count, or OECD rejected the key; `invalid_period` (ValidationError) — `start_period` after `end_period`, or OECD could not parse the period; `download_limit` (RateLimited) — download/data-range throttle, only clears if the query shrinks; `canvas_not_found` (NotFound) — explicit `canvas_id` has expired or was never created, checked before the download; plus the shared upstream six (Design Decisions) |
| `oecd_dataframe_describe` | List DataCanvas tables and their columns from a prior `oecd_query_dataset` spill. Lets the agent discover staged table and column names before writing SQL. | `canvas_id` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` | `canvas_disabled` (ServiceUnavailable) — `CANVAS_PROVIDER_TYPE=none`; `canvas_not_found` (NotFound) — `canvas_id` has expired or was never created |
| `oecd_dataframe_query` | Run a read-only SQL SELECT against tables staged on a DataCanvas by `oecd_query_dataset`. Returns up to `limit` rows, with `truncated: true` and a `notice` when the result has more. Requires `CANVAS_PROVIDER_TYPE=duckdb`. | `canvas_id`, `sql`, `limit` (default 100; above 1,000 it is served at 1,000 with a `notice`) | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` | `canvas_disabled` (ServiceUnavailable) — `CANVAS_PROVIDER_TYPE=none`; `canvas_not_found` (NotFound) — `canvas_id` has expired or was never created; `table_not_found` (NotFound) — the SQL names a table this canvas does not hold; `invalid_sql` (ValidationError) — SQL is not a valid SELECT statement; `sql_execution_error` (ValidationError) — the SELECT ran and failed on the staged data; `query_timeout` (Timeout) — still running after 30 seconds |
| `oecd_dataframe_drop` | Drop one table or view from a DataCanvas staged by `oecd_query_dataset`; the canvas and its other tables stay queryable. Opt-in: registered disabled (listed, not callable) unless `OECD_DATAFRAME_DROP_ENABLED=true`. Requires `CANVAS_PROVIDER_TYPE=duckdb`. | `canvas_id`, `table_name` | `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false` | `canvas_disabled` (ServiceUnavailable) — `CANVAS_PROVIDER_TYPE=none`; `canvas_not_found` (NotFound) — `canvas_id` has expired or was never created; `table_not_found` (NotFound) — the canvas holds no table or view by that name |

### Resources

| URI Template | Description | Pagination | Errors |
|:-------------|:------------|:-----------|:-------|
| `oecd://dataflow/{agency_id}/{flow_id}` | Metadata (name, full description with links, `EXT_RESOURCE` links, and dimensions) for a single dataflow — same content as `oecd_get_dataset_info` as an injectable resource. `{flow_id}` is the combined `{DSD_ID}@{DF_ID}` string (e.g. `DSD_NAAG@DF_NAAG_I`), URL-encoded as `DSD_NAAG%40DF_NAAG_I` in the URI, or the bare `{DF_ID}` for a dataflow catalogued without a datastructure prefix. Together they reconstruct the canonical `flow_ref`. | No | `invalid_flow_ref` (ValidationError) — the two segments do not combine into a flow reference, or `{flow_id}` carries a malformed percent-escape; `dataflow_not_found` (NotFound) — OECD publishes no dataflow under the reference, or the dataflow resolves to no datastructure; plus the shared upstream six (Design Decisions) |

### Prompts

None. The server is data-oriented; workflow guidance belongs in tool descriptions.

---

## Overview

OECD statistics as a workflow server over the OECD SDMX 2.1 REST API (`sdmx.oecd.org/public/rest`). The API is keyless and returns SDMX-JSON (`application/vnd.sdmx.data+json;version=2.0` for data, `application/vnd.sdmx.structure+json;version=1.0` for structural metadata).

The OECD publishes 1,500+ dataflows across 50+ publishing agencies — national accounts, employment, inflation, trade, education, health, environment, taxation, inequality — for its 38 member economies and dozens of partner countries. This server exposes the full discovery-to-data workflow: find a dataset, inspect its dimensions, resolve codes, and pull observations.

Target audience: economists, policy researchers, data journalists, and agents answering comparative questions across OECD economies.

---

## Requirements

- Keyless (no auth); OECD terms require source attribution in output — include `source: "OECD"` in every data response
- Discovery: search 1,500+ dataflows across 50+ agency namespaces, browse by agency
- Structure introspection: dataflow dimensions, dimension order, codelist references
- Code resolution: convert human terms to SDMX codes (country names → `USA`, `DEU`; measure names → `B1GQ`)
- Data retrieval: observations filtered by dimension key + time range; decoded to human-readable form
- Large analytical results (multi-country time-series) spill to DataCanvas for SQL; small results inline
- Dimension keys are dot-delimited, position-sensitive, and support `+` for OR and empty segments for wildcards
- All SDMX-JSON decoding handled server-side — agents see decoded row objects, not raw index arrays
- Attribution field on every data response (`source: "OECD"`) per OECD terms of use; the staged canvas table keeps it as a column
- No write operations

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OecdStructureService` | OECD SDMX structure API — dataflows, datastructures, codelists | `oecd_search_datasets`, `oecd_list_agencies`, `oecd_get_dataset_info`, `oecd_get_dimension_values`, `oecd_dataflow` resource |
| `OecdDataService` | OECD SDMX data API — observations, dimension decoding | `oecd_query_dataset` |

Both services call `fetchWithTimeout` + `withRetry` through a shared `fetchOecd` HTTP boundary (`src/services/oecd-http/oecd-http.ts`), which also corrects a retry-classification gap OECD's own responses hit: an honored `Retry-After: 0` collapsing the backoff on a throttle. Each request gets `min(OECD_TIMEOUT_MS, time left in the call's budget)`, and one that would start with nothing left is never sent. Both services read a response body through the same module's `readJsonBody()`, which reads the body whole before parsing it: a failure while the body is arriving keeps the classification the fetch gave it — a timeout, the caller's abort, a dropped connection — and only a complete body that is not JSON becomes a `SerializationError`, whose message names the content type the response declared. `decodeUpstream()` wraps every SDMX-JSON decoder and restates the `TypeError` a mistyped field raises as a `SerializationError` too, after the one request. The same module reads a terminal failure back into the shared upstream reason every definition declares (`upstreamRefusal()` — see Design Decisions), so a throttle, a timeout, an outage, an unreadable body, and a refused redirect are named identically whichever service produced them. Both services parse SDMX-JSON responses and map HTTP errors to appropriate MCP error codes.

A handler creates one `UpstreamBudget` (`src/services/oecd-http/upstream-budget.ts`) and passes it to every service call it makes. It carries the caller's signal and one deadline of `max(50 s, OECD_TIMEOUT_MS)` over every request, retry backoff, and honored `Retry-After` the call spends, so the call settles inside the 60-second request timeout MCP SDK clients apply by default. The structure service reads through an in-process `ResponseCache` (`src/services/oecd-structure/response-cache.ts`); see Design Decisions.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `OECD_BASE_URL` | No | `https://sdmx.oecd.org/public/rest` | SDMX REST base URL |
| `OECD_TIMEOUT_MS` | No | `30000` | Per-request timeout in milliseconds. Each call's requests and retries also share one upstream budget of max(50 s, this value) |
| `OECD_CLAMP_LIMITS` | No | `true` | A `limit` above a tool's per-call cap is served at the cap with a `notice`; `false` rejects it and advertises the cap as the schema `maximum`. Covers `oecd_search_datasets` (2,000), `oecd_get_dimension_values` (10,000), and `oecd_dataframe_query` (1,000) |
| `CANVAS_PROVIDER_TYPE` | No | `duckdb` | A large `oecd_query_dataset` result spills to a queryable table with a short preview head (≤25 rows); `none` returns every observation inline on both `structuredContent` and `content[]` |
| `OECD_DATAFRAME_DROP_ENABLED` | No | `false` | `true` registers `oecd_dataframe_drop` and names it in the server instructions; otherwise the tool is registered disabled, absent from `tools/list`, with this variable as its enable hint. Accepts `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`, and fails startup on anything else |

---

## Implementation Order

1. Server config (`src/config/server-config.ts`) — `OECD_BASE_URL`, `OECD_TIMEOUT_MS`
2. `OecdStructureService` — `fetchDataflows()`, `fetchDataStructure()`, `fetchCodelist()`, shared HTTP/retry layer
3. `OecdDataService` — `fetchData()`, SDMX-JSON decoding (series key → row), `AllDimensions` mode
4. `oecd_list_agencies` — simplest tool, validates the service layer
5. `oecd_search_datasets` — list all dataflows, match query tokens at word starts, rank name matches first, optional agency_id
6. `oecd_get_dataset_info` — fetch and expose datastructure dimensions
7. `oecd_get_dimension_values` — codelist lookup for a single dimension
8. `oecd_query_dataset` — data fetch + SDMX decode + DataCanvas staging
9. `oecd_dataframe_describe`, `oecd_dataframe_query`, and the opt-in `oecd_dataframe_drop` — canvas tools
10. `oecd://dataflow/{agency_id}/{flow_id}` resource — wrap the structure service

Each step is independently buildable and testable before the next.

---

## Domain Mapping

| Noun | SDMX Concept | Operations |
|:-----|:------------|:-----------|
| Dataflow | Dataset (e.g. `DSD_NAAG@DF_NAAG_I`) | list (by agency), search (keyword), get structure |
| DataStructure | Dimension schema for a dataflow | get (with dimension list) |
| Dimension | Axis of a dataflow (FREQ, REF_AREA, MEASURE, etc.) | list (from datastructure), get values (codelist) |
| Codelist | Valid codes for a dimension | fetch (returns id + name pairs) |
| Observation | Actual data point (value + dimension coordinates + time) | query (by key + time range) |

Most dataflow IDs in the OECD API follow the format `{DSD_ID}@{DF_ID}` (e.g. `DSD_NAAG@DF_NAAG_I`); 8 of the 1,553 catalogued flows carry a bare `{DF_ID}` with no datastructure prefix. The agency is separate: `OECD.SDD.NAD`. Together they form a `flow_ref`: `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`, or `OECD.TAD.ARP,DF_AEI2024_DASHBOARD` for a bare id.

---

## Workflow Analysis

### `oecd_query_dataset` (1 upstream data call, plus 0 warm / 1 cold cached structure check for non-wildcard keys)

| # | Call | Purpose |
|:--|:-----|:--------|
| 0 | `GET /dataflow/{agency}/{id}?references=datastructure` (cached, no concept-scheme read) | Only for non-wildcard keys: checks segment count before calling `/data` (trims extra trailing empty segments; rejects too-short keys and extra non-empty segments as `invalid_key`) |
| 1 | `GET /data/{flow_ref}/{key}?startPeriod=...&endPeriod=...&lastNObservations=...&dimensionAtObservation=AllDimensions` | Fetch observations as flat key→value map. The response carries the dimension and attribute metadata the decoder needs |
| 2 | `GET /dataflow/{agency}/{id}`, then call 1 again on the service root it names | Only when the configured root answers 404 or 500 and the catalog entry delegates the flow to another root |
| 3 | `canvas.acquire()` + `registerTable()` | Stage the full result on DataCanvas if the hoisted result exceeds the 100,000-character inline threshold (omitted for small results) |
| 4 | `GET /dataflow/{agency}/{id}?references=datastructure` plus the concept scheme (served from the structure cache once the dataflow has been looked up), then `GET {root}/availableconstraint/{flow_ref}/{key}/all/all?mode=available`, one attempt. `{root}` is the root that answered call 1; `oecd_get_dimension_values` reads the same record on the datastructure's data root | Only when call 1 returns no observations: why the key matched nothing |

The key decoding step converts the `0:9:0:0:0` SDMX index notation into row objects carrying each dimension and attribute as its own column, resolved to labels with the code beside each coded one — `{ REF_AREA: "United States", REF_AREA_code: "USA", MEASURE: "Gross domestic product", MEASURE_code: "B1GQ", value: 26054614000000, value_scale: 1000000000 }`. Attributes are read at all three levels the response carries: dataset, dimension group, and observation. `dimensionGroupAttributes` is keyed by a partial series key, and each entry holds one value index per dimension-group attribute followed by annotation indexes, which are not values and are never read. `dimensions.dataSet` is read as well. Rows are sorted by each dimension's code in key order, `TIME_PERIOD` last.

Components that hold one value across the whole result — label and code alike — move out of the rows into `constant_columns`, a `{ code, label }` record keyed by component ID that is always present (`{}` when nothing is constant). Constancy is a property of the whole result, never of a preview slice. Per-row `source` leaves the rows too, since the top-level `source` carries it.

**Output schema — two paths:**

- **Inline (fits within 100,000 characters, or DataCanvas disabled):** `{ rows: DecodedRow[], row_count: number, constant_columns, source: "OECD" }` — every observation in both `structuredContent.rows` and `content[]` (`format()` never caps rows independently of `structuredContent`).
- **Spill (exceeds 100,000 characters with DataCanvas configured):** `{ rows: DecodedRow[], row_count: number, constant_columns, canvas_id: string, table_name: string, truncated: true, source: "OECD" }` — `rows` holds a short preview head of at most 25 rows (still bounded by the inline budget when a single row exceeds it), and `canvas_id` + `table_name` address the full staged table, which holds every column: the constants, the `_code` columns, and `source` too, so SQL never joins `constant_columns` back in. An enrichment `notice` names both handles and directs callers to `oecd_dataframe_describe` before SQL with `oecd_dataframe_query`.

`format()` renders `result.rows` verbatim (the full inline set, or the ≤25-row spill preview), the spill handle, and the truncation disclosure. The spill-only enrichment `notice` carries the same describe-then-query route on `content[]` and `structuredContent`.

**Acquire only when needed.** The inline threshold is checked before an omitted-ID acquisition, so fitting results consume no canvas slots even when the tenant pool is full. An explicit ID is resolved before the download, so an unknown or expired one fails as `canvas_not_found` without spending one of OECD's rationed downloads; resolving a live ID mints nothing, and a spill stages on that same canvas. The failure is re-raised through `ctx.fail` so the declared recovery reaches the wire — the framework's own hint would otherwise win, and it sends the caller back to the same call. A stale ID never falls back to a fresh canvas: the caller passed it to keep tables together for a join. A staging failure releases a canvas only if that acquisition minted it; caller-owned canvases and successfully staged results remain available, and cleanup never replaces the staging error.

**Separate spill trigger and preview head, full parity with canvas off.** The 100,000-character inline threshold (`INLINE_BUDGET_CHARS`) decides whether a DataCanvas-enabled call spills; once it spills, the caller is directed to SQL so `rows` returns at most `SPILL_PREVIEW_ROWS` (25) rows instead of 100 KB of preview text. With DataCanvas disabled (`CANVAS_PROVIDER_TYPE=none`, including the `.mcpb` bundle), `content[]` renders every row `structuredContent.rows` carries so `content[]`-only clients see the full result rather than a silently truncated table.

**Staging goes through `registerTable()` directly, not `spillover()`.** The budget above decides whether to stage, over what the caller receives. `spillover()` runs its own drain over the full, unhoisted rows, which serialize differently and can decide the other way, on a one-row result for instance. The table is registered with a schema declared from the decoder's columns rather than sniffed, because attribute columns are sparse and one that resolves on no row inside the sniff window would be missing from the table and fail a later query.

---

## Design Decisions

**DataCanvas adopted.** OECD observations are the canonical example of analytical tabular data: country × measure × time rows that agents aggregate, compare, and filter. A query for GDP across all 38 OECD members for 10 years produces 380+ rows, and the multi-country, multi-measure pulls agents actually make cross the preview budget. Both gates pass: shape is analytical (GROUP BY country, year) AND size can exceed inline. `oecd_query_dataset` stages the full result on the canvas and is paired with mandatory `oecd_dataframe_describe` + `oecd_dataframe_query` tools.

**`oecd_dataframe_drop` is opt-in.** It ships registered but disabled (`disabledTool()`, listed on the landing page with its enable hint, absent from `tools/list`) unless `OECD_DATAFRAME_DROP_ENABLED=true`. With `MCP_AUTH_MODE=none` every caller shares the `default` tenant, so a drop is a destructive operation against tables another caller may hold the `canvas_id` for; canvases already age out on their own TTL, so a deployment turns the tool on only when it wants callers to free memory early. It resolves the name against `describe()` before dropping, so any name the canvas does not hold — malformed ones included — is one `table_not_found` pointing at `oecd_dataframe_describe`.

**`oecd_dataframe_query` returns a bounded page.** `limit` defaults to 100, which keeps a `SELECT *` over a staged table in the envelope `oecd_query_dataset`'s preview already returns. One call serves at most 1,000 rows (or the canvas row limit, when a deployment sets that lower), and anything larger is paged with SQL `ORDER BY … LIMIT … OFFSET` or aggregated. A `limit` above that has one obvious reading, so it is served at the maximum with a notice rather than rejected; under `OECD_CLAMP_LIMITS=false` it is rejected and the schema advertises the cap as its `maximum`. Output size is the caller's `limit` and nothing else: there is no server-side byte budget, so a page is never cut short of the rows the caller asked for. A query is stopped after 30 seconds, so the call settles inside a 60-second client request timeout; a caller's own abort stays a cancellation. A SQL engine error message is relayed up to 2,000 characters, with a marker where it was cut. There is no `offset` input, since SQL has one, and no total, which would mean running the SQL twice.

**`UNIT_MULT` is applied, not just labelled.** A dataflow publishes GDP as `26054.614` with `UNIT_MULT = Billions`; two dataflows publishing the same figure disagree on magnitude by a factor of a thousand (`Millions` vs `Billions`), so a raw value is not comparable across flows and an agent that sums or ranks them silently gets the wrong answer. The decoder multiplies by `10 ** id` — the code id is the base-10 exponent in `SDMX,CL_UNIT_MULT` and in the three OECD-local variants of it — and every row carries `value_scale`, the divisor that recovers the published figure. Codes outside the codelist range (`9999`, meaning ".") are not exponents and leave the value alone. The multiplier applies from whichever level carries it — dataset, dimension group, or observation — since a dataflow that states its unit once for the whole dataset would otherwise return unscaled values.

**`AllDimensions` observation mode.** Instead of the default SDMX-JSON `series`-grouped format (which requires two-pass decoding of series key + observation time index), we request `?dimensionAtObservation=AllDimensions`. This returns a flat `observations` map keyed by a full dimension index tuple. One-pass decoding: split key string on `:`, look up each index in the corresponding dimension's `values` array. Simpler implementation and cleaner row output for the canvas.

**Flow ref format: the id as OECD catalogues it, not a reconstructed one.** The SDMX API uses `{agencyID},{flowID}` in the data URL path, where `flowID` is usually the combined `{DSD}@{DF}` string URL-encoded (`%40`) and occasionally a bare `{DF}`. Tools expose either as a single `flow_ref` parameter — the service layer handles URL encoding. Pairing a bare id with the datastructure named in its `structure` URN builds a combined ref the data endpoint rejects, so the catalog id is passed through verbatim and both forms are accepted everywhere a `flow_ref` is.

**A datastructure is resolved through its dataflow first.** `GET /dataflow/{agency}/{id}?references=datastructure` answers two questions in one request: whether OECD publishes the dataflow at all, and which datastructure revision it references. The direct route `GET /datastructure/{agency}/{dsd_id}` answers neither. The `{dsd_id}` half of a combined ref names a datastructure, not a dataflow, so a mistyped or retired dataflow id resolves there as long as its datastructure exists; it is also a label OECD does not keep in step with the real datastructure — for 45 of 1,553 flows it names one that does not exist; and it answers with the datastructure's latest revision, which is not always the one the dataflow references (`DF_UOE_FIN_NATURE` references `DSD_EAG_UOE_FIN` 1.0, eight dimensions, where the direct route answers 3.2 with nine). A 404 on the reference route is the `dataflow_not_found` the caller reports, never a cue to try another route.

The direct route stays for one class: the 27 flows published as external references, whose reference response carries no datastructure and where the configured root can still hold it. Datastructure requests by class, before the concept-scheme read that names the dimensions:

| Class | Requests |
|:------|:---------|
| common | 1 |
| mismatched prefix | 1 |
| bare | 1 |
| external, held by the configured root | 2 |
| other external | 3 |
| nonexistent | 1, reported as `dataflow_not_found` |

**A delegated catalog entry is followed to the service root that owns it.** 27 of the 1,553 flows are published on `/public/rest` as a pointer rather than a definition — `isExternalReference: true`, no `structure` URN, and a `links[]` entry with `rel: "external"` naming another OECD service root. Three roots appear: `/sti-public/rest` (14 flows), `/dcd-public/rest` (10), `/archive/rest` (3). The mapping is not derivable from the agency — `OECD.SDD.TPS` delegates to `sti-public` for three flows and `archive` for three others — so the root is read per-entry from `links[]` and never guessed.

Both halves of the collection are affected, and differently. The datastructure resolves on `/public/rest` for 10 of the 27 and 404s for the other 17. The data endpoint answers 500 (`Object reference not set to an instance of an object.`) for all 27, so `oecd_query_dataset` could not serve a single externally-referenced flow — including the DAC creditor-reporting aid series and Trade in Value Added. Each delegating root serves both `/datastructure` and `/data` for its own flows.

Following the delegation makes all 27 usable, so `oecd_search_datasets` does not flag them: a marker that always reads "this one works anyway" is noise on every result. A future entry naming no followable root degrades to the ordinary `dataflow_not_found`, which already tells the caller what a flag would have.

The lookups sit on the failure path, so the common case pays nothing. `fetchDataStructure` reads the delegation off the `?references=datastructure` response it has already fetched — that payload carries `links[]` alongside the empty `dataStructures` — so a delegated structure costs no lookup of its own: two requests when the configured root holds the datastructure, three when the delegated root's reference route has to answer. The delegated root is read the same way, reference route first. `fetchData` holds no such payload, so a 404 or 500 from the configured root buys one `GET /dataflow/{agency}/{id}` before the query is reissued against the delegated root. A 429, a 503, or a timeout buys nothing: none of them says anything about where the flow lives, and another request is the last thing a failing service needs.

**The lookup runs before the retries, not after.** Delegation and an unwell service are spelled the same way — HTTP 500 — and the catalog is the only thing that tells them apart. Retrying first gets that backwards: the delegated 500 is a fixed property of a flow the root does not host, so it repeats on every attempt, and each of the 27 flows would pay three requests and the framework's 1s/2s backoff on every single query before the delegation was even consulted. So the first pass at the configured root withholds its retry budget from a 404 or a 500 (`data.retryable: false`, the framework's in-band opt-out), and the catalog answers in one request — itself deliberately unretried, since moving the same three requests onto the catalog endpoint would only relocate the delay. Held back is not spent: a 500 the catalog cannot explain is an ordinary transient fault after all and resumes its remaining attempts against the configured root, backoff intact. The order costs the common case nothing — a flow the configured root serves answers on the first request either way — and it is what lets a delegated query succeed without reporting three upstream faults on the way. 500 is in `HANDLED_STATUSES` for the same reason: whether it is a fault at all is not known until a request later, and the one that turns out to be real still surfaces at the tool boundary like every other failed query.

**Codelists and concept schemes are read at the root and the version the datastructure names.** Both axes carry real codes, and getting either wrong offers the caller values the dimension rejects.

The root, because both artefacts are versioned per root and `/public/rest` mirrors an older revision: it answers `OECD.STI.PIE/CL_TIVA_MEASURE` with version 1.0 (47 codes) while `sti-public` — the root owning `DSD_TIVA_EXGRVA` — answers with 44. `OecdDataStructure.serviceRoot` records which root answered so the follow-up lookups address the same one.

The version, because an unversioned `GET /codelist/{agency}/{id}` answers with whatever that root currently calls latest, and a codelist moves on independently of the datastructures using it. `DSD_TIVA_EXGRVA`'s `VALUE_ADDED_SOURCE_AREA` references `CL_AREA(1.7)`, 560 codes; the root's latest is 1.9, 568. The enumeration URN names the revision the dimension accepts, so it is carried onto `OecdDimension.codelistVersion` and appended to the request. The same holds for the `conceptIdentity` URN and its concept scheme, at no extra cost — the versioned URL is exactly as cheap as the unversioned one.

Pinning is anchored to the datastructure actually fetched, not to a version the caller supplied. A `flow_ref` carries no version, so the entry point is the dataflow's own reference, which names the revision the dataflow uses at no extra request. Whichever revision answers is then the authority for everything downstream, so the codelist and the concept scheme are always coherent with the dimensions being described. A version the root no longer serves 404s, and that falls back to latest: an outdated list beats failing the dimension outright, and the fallback costs a request only on a reference gone stale. A version outside the SDMX digit-and-dot shape is dropped at parse time rather than addressed — it reaches a URL path segment, and the same reasoning that governs identifiers governs it.

**A delegated href is a hint about where, never a request to replay.** The href arrives inside an upstream response body, so fetching it unchecked is a server-side request forgery — whoever shapes that body picks the host. `externalServiceRoot()` is the only gate, and it is deliberately narrow: the URL must parse, its origin must equal the configured base URL's origin exactly (scheme, host, and port), its scheme must be `https`, and its path must match `/{service}/rest/dataflow/…`. Only the leading `{service}` segment survives — the root is rebuilt as `{origin}/{service}/rest`, and every request path is reassembled from identifiers `parseFlowRef` has already validated. An href failing any check resolves to undefined and the caller reports the structure or the observations as unreachable rather than fetching anything. So the reachable blast radius of a fully attacker-controlled href is a different path prefix on the host the server was already configured to talk to, and it stops there. Do not loosen the origin check to a suffix or hostname-contains match, and do not pass an href through as a request URL.

**Every definition declares its failures, and every surface names the same failure the same way.** A definition that can fail carries an `errors[]` contract — reason, code, when, recovery — and the handler throws through `ctx.fail(reason, …)`; the framework fills `data.recovery.hint` from the declared entry for that reason, so `data.reason` and the hint travel with the code. The alternative is a bare code, which tells a caller that something failed and nothing about what to do next.

Two rules hold the contract together across every definition rather than leaving each one internally consistent and mutually contradictory. A reason means one thing wherever it is declared and always carries the same code. And no failure a caller can act on identically is reported under two reasons: an unparseable `flow_ref` and a refused redirect each resolve to one reason whichever surface received the call, because a client cannot be expected to know which one it reached before it can read the answer. A reason splits only where the next move genuinely splits with it, which happens once — the download throttle, whose `download_limit` is declared on the one surface that can shrink its request and folded into `rate_limited` everywhere else. Recovery hints are the looser part, free to differ wherever a surface offers a different move.

Where the contract lands differs by definition type, and only in the envelope. A tool failure is a result — `isError: true`, with the code on `result.structuredContent.error.code` and the reason and hint under its `.data`. A resource re-throws instead, so the read request itself fails and the same code, reason, and hint arrive in the JSON-RPC top-level `error.{code, data}`. The declaration is identical either way; `resource()` takes `errors[]` on the same terms `tool()` does.

`oecd://dataflow/{agency_id}/{flow_id}` resolves the same identifier against the same endpoints as `oecd_get_dataset_info`, so it declares the same reasons under the same codes. One hint has to diverge: the tool takes a single `flow_ref` string where the resource takes it split across two URI segments, so the resource's `invalid_flow_ref` recovery says how to perform that split and where the `@` becomes `%40`. The resource also folds a malformed percent-escape into `invalid_flow_ref` — `decodeURIComponent` raises a `URIError` on `%ZZ`, and an unreadable identifier is the caller's mistake whether the parse or the decode caught it, not an internal fault.

**An unparseable `flow_ref` is a syntax failure, never a missing dataflow.** `parseFlowRef` returning null means the string is not a flow reference at all and no request is issued, so `NotFound` would assert an absence this server never checked and send the caller to look the reference up again when the reference may be the one thing they had right. All four surfaces that accept a flow reference — `oecd_get_dataset_info`, `oecd_get_dimension_values`, `oecd_query_dataset`, and the resource — report it as `invalid_flow_ref` (ValidationError), with the same `when` and the same hint on the three tools. `dataflow_not_found` keeps the cases it names: a reference that parses and names no dataflow OECD publishes, or a dataflow that resolves to no datastructure.

**The upstream half is identical on every definition that reaches OECD.** Once a handler's own branches have declined a failure — no missing dataflow, no rejected key — what is left is the upstream's answer, and `upstreamRefusal()` in `src/services/oecd-http/oecd-http.ts` reads it into one of six reasons that the five tools reaching OECD and the resource declare:

| Reason | Code | Fires on |
|:-------|:-----|:---------|
| `rate_limited` | RateLimited (retryable) | A 429. OECD charges one throttle budget across the data and structure endpoints, so a refused `/datastructure`, `/codelist`, or `/conceptscheme` call is as ordinary as a refused `/data` one. A call whose budget runs out right after a 429 reports the 429, not a timeout |
| `upstream_timeout` | Timeout (retryable) | A request ran past `OECD_TIMEOUT_MS` before the response finished arriving — the headers or the body — a 408/504, or the call's requests and retries together ran past its upstream budget (50 s, or `OECD_TIMEOUT_MS` when that is longer) |
| `upstream_unavailable` | ServiceUnavailable (retryable) | A server fault or an unreachable host once the retries ran out |
| `upstream_redirect` | Forbidden (not retryable) | A 3xx, refused at the fetch boundary |
| `upstream_unreadable` | ServiceUnavailable (not retryable) | A body that is not JSON, JSON whose fields do not have the SDMX shape, or a codelist identifier outside the SDMX character set. The message names the read that failed, and a repeat returns the same body |
| `upstream_error` | ServiceUnavailable | Any other status this server does not model — a 401, a 403, a 400, a 409, a structure endpoint's 422, a 501. The message carries the HTTP status and OECD's text: a plain-text or JSON body as sent, an HTML body reduced to its `<title>` |

The throttle earns its entry twice over. `withRetry` has already spent its attempts and its backoff by the time a 429 surfaces, so "retry now" is precisely the wrong next move and the bare code invites it. And the throttle is the one upstream refusal an ordinary caller provokes without anything being misconfigured.

**A data body that outlasts the deadline costs one request.** `OECD_TIMEOUT_MS` covers the body as well as the headers. When observations have started arriving and the deadline still runs out, OECD has answered with more than the deadline lets through, and repeating the request repeats the same download from the start — another of the data downloads OECD allows each hour, and most likely another full timeout, twice over before the caller hears anything. So the data endpoint opts that timeout out of its retries, and `oecd_query_dataset` returns `upstream_timeout`, whose recovery is to ask for less, after one request. A timeout before the headers says nothing about the size of the answer and keeps its retries on both endpoints, and the structure endpoints retry a stalled body as they always have. A connection dropped mid-body is retried on both and ends as `upstream_unavailable`.

`upstream_error` exists because the alternative is worse than a slightly loose bucket. A `Forbidden`, an `Unauthorized`, or an `InvalidParams` from a keyless public API tells a caller nothing they can act on, and none of them is a code a client would think to switch on. Restating them as one reason with one honest hint — retry once, then report the response and check `OECD_BASE_URL` — costs the precision of the original code and buys a next move. The code it carries is `ServiceUnavailable` because from the caller's seat that is what happened: the server could not complete the upstream call.

**Deliberate boundaries.** Five gaps in the contract are decisions, not oversights.

`RequestCancelled`, `InternalError`, and a `ValidationError` carrying no HTTP status are never restated. A caller's own abort arrives as `RequestCancelled`, whether it lands before the headers or while the body is arriving, or while it waits on a structure read another call shares ("The caller cancelled the call while its OECD request was in flight"); a fault in this server's own work arrives as `InternalError`; and a `ValidationError` raised before any request left — an `OECD_BASE_URL` that is not http or https — is the operator's configuration, not OECD's answer. Each names this server or its client, and reporting any of them as an OECD refusal would blame the wrong party. A `ValidationError` that carries an upstream status is OECD's answer and is restated: a structure endpoint's 422 lands in `upstream_error` with its status and text. A `SerializationError` is restated as `upstream_unreadable`. It only ever describes a body OECD sent, and it arrives after one request, since a retry would fetch the same bytes.

`download_limit` is declared only on `oecd_query_dataset`. OECD spells its two throttles differently in the response body — the request-rate one clears by waiting, the download-and-data-range one only by asking for less — but "ask for less" is advice only a caller holding a key and a period can act on. Every other surface asks for one fixed artefact: a codelist is the size it is. So they map both bodies to `rate_limited`, whose recovery is the safe answer for either, rather than declaring a reason whose hint their caller cannot perform.

`upstream_timeout`'s hint diverges by surface, across three moves. `oecd_query_dataset` can tell a caller to split the key or the period; `oecd_search_datasets` can tell one to set `agency_id` and fetch a single agency's dataflows instead of the whole catalog; `oecd_list_agencies` and the three surfaces that fetch one structure have nothing to narrow and can only say to raise `OECD_TIMEOUT_MS`, adding that a value past 50 seconds also needs a client that waits that long for a result. Same failure, same reason, same code — different move available.

The catch-all claims a status, not an absence, and it claims nothing at all outside its six. `upstream_error` is reached only after a handler's own branches decline the failure, so a `NotFound` none of them claimed lands there and is reported as `ServiceUnavailable` — the codelist `oecd_get_dimension_values` reads after the datastructure resolves is the case that reaches it, since only the datastructure call has a `dataflow_not_found` branch in front of it. A dedicated `codelist_not_found` would be more precise and would hand the caller the move `upstream_error` already gives: report the response, because no change to the request conjures a codelist OECD does not publish. In the other direction, where `upstreamRefusal()` declines outright — one of the three failures above, or a thrown value that is not an `McpError` — the failure bubbles undeclared rather than being restated. `oecd_list_agencies` and `oecd_search_datasets` previously wrapped everything left over as `upstream_error`; they no longer do, so a caller's own abort surfaces as the `RequestCancelled` it is instead of as an OECD outage.

The three DataCanvas tools declare their own reasons and none of the upstream six. They work on a canvas this server already holds and issue no request, so there is no upstream to answer for.

**An origin checked before a request is only the first hop, so redirects are refused.** A host that answers a 3xx moves the request wherever its `Location` points, cross-origin included, which leaves the origin check above worth exactly what the fetch boundary's redirect policy is worth. `fetchOecd` issues every request with `redirect: 'manual'` and restates a 3xx as a terminal `Forbidden`, never retried — a redirect is a fixed property of the endpoint, so another attempt only repeats it. The rule covers every OECD call rather than the delegated ones alone: a redirect needs no href to be read, so it is the one way an upstream can move a request off-host on a path that consults no response body at all.

No hop is followed, rather than same-origin hops up to a bound. OECD does not redirect — `/dataflow`, `/datastructure`, `/codelist`, `/conceptscheme`, `/agencyscheme`, and `/data` each answer directly on all four service roots — and a validated hop could not be re-issued without rebuilding the boundary, since `fetchWithTimeout` reports a 3xx as a status-mapped failure and does not carry the `Location` onto it. Following nothing also leaves no chain to bound. The visible cost is a base URL configured over plaintext: OECD answers `http://sdmx.oecd.org/…` with a 301 to https, a different origin, so it now fails with an error naming `OECD_BASE_URL` instead of being upgraded in silence.

Every definition that reaches OECD declares that failure as `upstream_redirect` (Forbidden, not retryable) and reports the boundary's own sentence. It is kept distinct from `upstream_unavailable` and `upstream_error`, both of which advise a retry: no wait clears a misconfigured origin, and the only fix is to `OECD_BASE_URL`. Both services relabel an upstream failure with a message of their own on the way up, so the sentence naming the variable is read back off the cause chain rather than rewritten per tool.

**An empty match is spelled two different ways.** OECD reports "the query parsed and matched nothing" as a 404 whose body is `NoResultsFound` on some service roots and `NoRecordsFound` on others, while a root that genuinely lacks the flow says so in prose. Both sentinels map to an empty result, so a valid query against a delegated flow reports `no_results` instead of claiming the dataflow does not exist.

**Identifier validation is what keeps the ref out of the URL structure.** Every segment of a `flow_ref` lands in a URL path segment, so it must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` before any request goes out. The character class stops `/`, `?`, `#`, `%`, and NUL; the leading alphanumeric stops an identifier that is nothing but dots, which URL resolution reads as a relative path reference and removes — walking the request out of the endpoint it was addressed to and, on the reference route, into the whole-catalog listing. Every identifier the catalog publishes opens on a letter or digit, so nothing real is excluded.

**`oecd_search_datasets` uses MCP-side filtering over all dataflows.** With 1,553 dataflows across 52 publishing agencies, the SDMX API has no native full-text search endpoint. We fetch all dataflows per agency (or all agencies at once via `GET /dataflow`) and filter in-memory. This is the bounded-set list-filter pattern — one batch fetch, then local filtering. The full set fits in memory and is naturally bounded (OECD publishes datasets at a pace measurable in weeks, not seconds). Agency-filter (`agency_id`) reduces fetch scope when provided.

Every query token must start a word in the name or description, matched case-insensitively as a prefix; a word starts after any character that is not a letter or digit, or at a lowercase-to-uppercase step in the text as published (`RioMarkers`). Results rank in three tiers — the name carries every token; the tokens are split across name and description; the description alone carries every token — in catalog order within each tier. Substring matching inside words pushed the TiVA flows past the default page (`tiva` inside `activation`, `house` inside `greenhouse`), so there is no fallback substring tier. The narrowings are accepted: `employment` does not reach flows that only mention unemployment, and `health` does not reach `unhealthy`. A token found only inside words returns `no_match`. A token that opens on a separator (`&`, `-oecd`) has no word start to anchor and cannot sit inside a word, so it matches wherever it occurs: `science & technology` still finds the flows that write `R&D`, where anchoring the `&` would have refused every one of them. Each token is one `indexOf` scan per field with a fixed character-class test at each hit, so nothing is compiled from caller text.

**One `flow_ref` parameter instead of separate `agency_id` + `flow_id` inputs.** The combined format `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I` is what `oecd_search_datasets` returns and what the data URL needs. Accepting it as a single string avoids agent reconstruction errors and mirrors how other SDMX servers (eurostat) handle dataset codes.

**Codelist search lives inside `oecd_get_dimension_values`, not in a tool of its own.** The tool takes an optional `query` and matches it case-insensitively as a substring against both the code id and its label, then pages the matches with `limit`/`offset`. Filtering happens on the result set rather than in `format()`, so both client surfaces carry the same bounded page — an earlier shape returned the whole codelist in `structuredContent` while rendering only the first 50 rows, which put the remaining codes out of reach for a `content[]`-only client and shipped 66 KB to everyone else. `UNIT_MEASURE` runs to 1,164 codes and `REF_AREA` to 570, so "small enough to inline completely" does not hold. A separate search tool is still not warranted: the filter is one parameter on the tool that already owns the codelist.

**A codelist is not a coverage list, so `oecd_get_dimension_values` can narrow it to what the dataflow holds.** A codelist is shared across dataflows and lists codes a given flow carries no data for. `available_only`, or a `key` (which implies it), reads OECD's availability record — `GET {dataRoot}/availableconstraint/{flow_ref}/{key}/all/all?mode=available`, which answers `public,max-age=7200` on `/public/rest` — and lists only the codes with data given the key's other segments, in codelist order, then any code the codelist lacks, labelled with its own id. The read is one unretried attempt on the datastructure's data root (`dsd.dataRoot`): the delegated root its dataflow's catalog entry points to, read off the `?references=datastructure` response the structure lookup already fetched, and the configured root for every other flow. It is not the root that defined the datastructure, because `/public/rest` also holds the datastructure of 10 of the 27 delegated flows and answers their availability read with a 500. It runs concurrently with the codelist read on the call's one budget, which makes a cold call 3 requests without the flag (dataflow reference, concept scheme, codelist) and 4 with it. Every sentence that explains the page — a clamped `limit`, a failed availability read, a key that matches no series or pins a code that matches only by letter case, a dimension with no codelist, codes beyond the page — is joined into one `notice`, stored raw in `structuredContent` and escaped only where `content[]` renders it as Markdown, since it carries the caller's query and key and OECD's codes.

The availability read is part of the answer once the caller asked for it, so its failure handling splits three ways. A caller abort ends the call as cancellation. A budget expiry fails the call as `upstream_timeout`. Any other failure degrades to the whole codelist, with `available_only: false` and a notice that names the failure.

**An empty `oecd_query_dataset` result is diagnosed from the same availability record.** When a query returns no observations, the handler reads the datastructure (served from the structure cache once the dataflow has been looked up) and one unretried availability read on the root that answered the query, and names the likeliest cause in the `no_results` message. The diagnosis is best-effort, run beside an answer the call already has — no rows — so it never replaces that answer: any `McpError`, a budget expiry included, keeps the plain `no_results` message, and only a caller abort or a non-`McpError` propagates. This is the counterpart of `oecd_get_dimension_values`, where the availability read is the answer and an expiry fails the call. Clause order: segments that match nothing given the rest of the key, with a code matching only by letter case named as such; then a key whose pinned segments together match no series; then a period wholly outside the key's range; then `last_n_observations` combined with `end_period` (OECD applies `lastNObservations` before `endPeriod`). Without `last_n_observations` and `end_period` together, an overlapping period or a key that pins nothing gets no clause. Cold, a non-wildcard key costs 2 extra requests, delegated flow or not (the pre-request dimension-count check already cached the datastructure, leaving concept scheme + availability); a wildcard (`all`) key costs 3, or 4–5 on a delegated flow. Once the datastructure is cached the diagnosis costs 1, and 0 when the same key repeats, since the availability record is cached for its `max-age` of 7,200 seconds. The diagnosis spends at most 10 seconds of what the call's budget has left (`UpstreamBudget.within`), so a stalled or throttled diagnosis read holds `no_results` back by no more than that: a `Retry-After` past those 10 seconds is never waited out, and the read in flight is abandoned when they run out. The empty result is already the answer, so a side lookup that cannot finish quickly is not worth the rest of the call's 50 seconds.

**One upstream budget per call, and one cache in front of the structure reads.** Each handler's `UpstreamBudget` bounds the whole call to `max(50 s, OECD_TIMEOUT_MS)`, so a call settles inside the 60-second timeout MCP SDK clients apply by default rather than after it. `OECD_TIMEOUT_MS` stays the per-request timeout, and a value raised past the floor buys one longer attempt, not a longer ladder of them. A retry ladder, an honored `Retry-After`, and a cascade of structure reads all end with the budget; a `Retry-After` that would outlast it rejects at once with the throttle it answered.

`ResponseCache` keeps decoded structure responses, keyed by `Accept` plus URL, for `max-age − Age`. A response that is `no-store`, `no-cache`, or names no `max-age` is never stored, and neither is a failure. That includes the 404 the configured root's datastructure route answers for a delegated flow only its delegated root defines, so a repeat call for such a flow checks the delegated root's stored answer first and, finding it, sends no request. A delegated root is read only after that route has found nothing, so its stored answer is the one the full cascade reached; once it expires, the next call runs the cascade again. The bound is 64 MiB, charged at 4 bytes per body character, with the least recently used entry evicted first. The charge covers a decoder that retains its whole parsed body: the 5.97 M-character catalog is charged 23.9 MB, where its entry retains 6.95 MB on Bun and 2.94 MB on Node against a parsed body of 19.6 MB on Bun and 9.0 MB on Node. Concurrent readers of a missed key share one load, run under the cache's own signal and budget, and each waits within its own signal and budget; when the last waiter leaves, the load is aborted. A reader that joined a load already in progress and still has time when that load's own budget runs out starts a fresh load with what it has left; only this server's own timeout does that, while an OECD-answered 408 or 504, a 404, or a throttle is shared as it is. `/data` and the delegated-root lookup stay uncached — observations are the download OECD rations, and the lookup is deliberately a single unretried request. There is one cache per process, shared across tenants, since structure requests carry no credentials. Measured: a repeat `oecd_get_dataset_info` goes from 2 requests to 0, and a repeat catalog read from 1 to 0. The bound and the lifetime are not configurable; nothing is asked of a caller.

**Dimension names come from a second request.** OECD's datastructure response carries no `name` on a dimension, so without a follow-up every name just repeats the id. The names live in the concept scheme each dimension's `conceptIdentity` URN points at, and every dimension of a datastructure shares one scheme in practice, so one `GET /conceptscheme/{agency}/{schemeId}` resolves them all. `?references=children` would inline them in the first request but also inlines every codelist — 866 KB for `DSD_NAMAIN1` against 7,949 + 5,927 for the two-request path. The lookup is best-effort: a scheme that fails or omits a concept leaves that dimension on its id rather than failing the call.

---

## Known Limitations

- **No native search across the whole catalog** — `oecd_search_datasets` reads all 1,553 flows (~6 MB JSON, about 3 s) on a cold cache and filters them in memory. The decoded catalog is then served from the structure cache for the `max-age` OECD grants it, so a repeat search sends no request.
- **Dimension key construction requires prior `oecd_get_dataset_info` call** — dimension order varies per dataflow. The tool description documents this workflow requirement clearly.
- **Test and experimental flows are marked only in their names** — OECD carries no flag for them that any output reads. Compare names when two flows look alike.
- **Third-party data within OECD dataflows** — IEA energy data is embedded in some flows with stricter terms. The OECD terms place the burden on users to check per-dataset source metadata; the `source` field in tool output is the mechanism.
- **No server-side hierarchical rollups** — `oecd_get_dimension_values` exposes each code's `parent` ID and filters direct children by `parent`, but observation queries return rows at the codes requested; multi-level rollups must be computed via DataCanvas SQL or by the caller.

---

## API Reference

### Endpoint patterns

| Operation | Pattern |
|:----------|:--------|
| All dataflows (all agencies) | `GET /dataflow` |
| Dataflows by agency | `GET /dataflow/{agencyID}` |
| Dataflow entry (delegation lookup) | `GET /dataflow/{agencyID}/{flowID}` — read by the data service after a 404 or 500, to name the root a delegated flow lives on |
| Datastructure | `GET /datastructure/{agencyID}/{dsdID}` — only for an external reference that carries no inline datastructure |
| Datastructure via its dataflow | `GET /dataflow/{agencyID}/{flowID}?references=datastructure` — the first read for every ref |
| Availability | `GET {dataRoot}/availableconstraint/{agencyID},{flowID}/{key}/all/all?mode=available`, on the root that serves the dataflow's data — answers `public,max-age=7200` on `/public/rest` and `public,max-age=2592000` on `sti-public` |
| Delegated structure or data | Same patterns, against the `{origin}/{service}/rest` root read from the catalog entry's `rel: "external"` link — `sti-public`, `dcd-public`, `archive` |
| Concept scheme (dimension names) | `GET /conceptscheme/{agencyID}/{conceptSchemeID}/{version}`, falling back to the unversioned form |
| Agency scheme (directorate names) | `GET /agencyscheme/OECD` |
| Codelist | `GET /codelist/{agencyID}/{codelistID}/{version}`, falling back to the unversioned form |
| Data query | `GET /data/{agencyID},{flowID}/{key}?startPeriod=...&endPeriod=...&dimensionAtObservation=AllDimensions` |

### Format negotiation

Structure endpoints: `Accept: application/vnd.sdmx.structure+json;version=1.0`

Data endpoints: `Accept: application/vnd.sdmx.data+json;version=2.0`

The OECD API ignores `?format=` query parameters — the `Accept` header is the only supported format negotiation mechanism. Without the Accept header, XML (SDMX-ML) is returned by default.

### Dimension key syntax

The key is a dot-delimited string where each segment corresponds to a dimension in `dataStructureComponents.dimensionList.dimensions` order (ascending `position`). Empty segments are wildcards; `+` separates multiple values in one segment.

```
FREQ.REF_AREA.MEASURE.UNIT_MEASURE.CHAPTER
A    .USA+DEU .B1GQ_R  .PC          .        → Annual, USA or Germany, real GDP, %, any chapter
```

Concrete example: `A.USA+DEU.B1GQ_R.PC.` — the trailing dot is the wildcard CHAPTER segment.

### SDMX-JSON v2 data response shape (`dimensionAtObservation=AllDimensions`)

```json
{
  "data": {
    "dataSets": [{
      "series": {},
      "attributes": [],
      "dimensionGroupAttributes": {},
      "observations": {
        "0:0:2:3:0:0": [26054.614, 0, 0, 0]
      }
    }],
    "structures": [{
      "attributes": { "dataSet": [], "dimensionGroup": [], "observation": [] },
      "dimensions": {
        "dataSet": [],
        "series": [],
        "observation": [
          { "id": "FREQ",        "values": [{ "id": "A",   "name": "Annual" }] },
          { "id": "REF_AREA",    "values": [{ "id": "USA", "name": "United States" }] },
          { "id": "MEASURE",     "values": [{ "id": "B1GQ","name": "Gross domestic product" }] },
          { "id": "UNIT_MEASURE","values": [{ "id": "USD_PPP", "name": "US dollars, PPP" }] },
          { "id": "CHAPTER",     "values": [{ "id": "NAAG_I", "name": "Part I: GDP" }] },
          { "id": "TIME_PERIOD", "values": [{ "id": "2022" }] }
        ]
      }
    }]
  }
}
```

Observation key `"0:0:2:3:0:0"` decodes as: FREQ[0]=A, REF_AREA[0]=USA, MEASURE[2]=..., UNIT_MEASURE[3]=..., CHAPTER[0]=NAAG_I, TIME_PERIOD[0]=2022. The first element of the observation array is the numeric value; subsequent elements are the observation-level attribute values. Dataset-level attribute values sit in `dataSets[0].attributes`, one index per attribute, and dimension-group attribute values in `dataSets[0].dimensionGroupAttributes`, keyed by a partial series key.

When `AllDimensions` is requested, the dimensions move to the `observation` level — `series` is empty — except one that holds a single value, which may be presented in `dimensions.dataSet`. This simplifies decoding to one pass over the observation map.

### Error shapes

| HTTP | Body | Meaning |
|:-----|:-----|:--------|
| 404 | `"Could not find Dataflow and/or DSD related with this data request"` | Invalid `flow_ref` in data query |
| 404 | `"NoResultsFound"` | Valid flow but no data matching the key/time range |
| 400 | `"Invalid structure: data"` | Malformed key or unsupported query parameter |
| 403 | `Not enough key values in query, expecting 5 got 3` | Rejected key; only this plain-text shape is treated as `invalid_key` at 403 |
| 403 | ``Semantic Error - Invalid Date Format `last year` `` | Rejected period; only this plain-text shape is treated as `invalid_period` at 403 |
| 200 | Empty `dataSets[0].observations` | Valid query, zero matching observations |

Error bodies are plain text, not JSON — check `Content-Type` before attempting to parse.

### Rate limits and pagination

OECD's API best-practices page caps data downloads at 60 per hour per client, and it throttles further. Two separate limits arrive as a 429 whose plain-text body names which one was hit — a request-rate limit that clears by waiting, and a download-and-data-range limit that only clears if the query shrinks. Both budgets are charged against the client across every endpoint, so a throttled `/datastructure`, `/codelist`, or `/conceptscheme` call is as ordinary as a throttled `/data` one. Structure responses for all dataflows (1,553 entries) are ~6 MB and take about 3 s on a cold cache. Data responses for narrow queries (single country, few measures, 3–5 years) return in 1–3s. Always filter by time range — unfiltered time-series go back decades and can produce hundreds of observations per series.

No pagination for structure endpoints — all results in one response. The data endpoint has no pagination either; dimension key filtering is the only mechanism to bound result size.
