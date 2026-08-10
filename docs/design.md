# OECD MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `oecd_search_datasets` | Search OECD dataflows by keyword or theme. Returns dataflow IDs, names, and agency identifiers needed for `oecd_get_dataset_info`. | `query` (text), `agency_id` (optional filter), `limit` (1–100, default 20), `offset` | `readOnlyHint: true, idempotentHint: true` | `no_match` (NotFound) — no dataflows matched; `agency_not_found` (NotFound) — `agency_id` not in the catalog; plus the shared upstream five (Design Decisions) |
| `oecd_list_agencies` | List the OECD SDMX agencies, the directorate each belongs to, and the number of dataflows each publishes. Use to discover agency IDs before filtering `oecd_search_datasets` by department. | — | `readOnlyHint: true, idempotentHint: true` | the shared upstream five (Design Decisions) only |
| `oecd_get_dataset_info` | Fetch a dataflow's dimensions, their order, and how to construct a query key. Returns per-dimension concept names, codelist references, and position in the dot-delimited key. Required before calling `oecd_query_dataset`. | `flow_ref` (e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`, or the bare `OECD.TAD.ARP,DF_AEI2024_DASHBOARD`) | `readOnlyHint: true, idempotentHint: true` | `invalid_flow_ref` (ValidationError) — malformed `flow_ref` format; `dataflow_not_found` (NotFound) — `flow_ref` does not exist; plus the shared upstream five (Design Decisions) |
| `oecd_get_dimension_values` | Fetch codes and labels for one dimension of a dataflow, narrowed by substring and returned a page at a time. Use to resolve human-readable names (countries, measures) to SDMX codes before querying. | `flow_ref`, `dimension_id`, `query` (optional substring), `limit` (1–500, default 50), `offset` | `readOnlyHint: true, idempotentHint: true` | `invalid_flow_ref` (ValidationError) — malformed `flow_ref` format; `dataflow_not_found` (NotFound) — `flow_ref` does not exist; `dimension_not_found` (NotFound) — `dimension_id` not in this dataflow's structure; plus the shared upstream five (Design Decisions) |
| `oecd_query_dataset` | Fetch observations from an OECD dataflow filtered by a dimension key and time range. Returns decoded rows (one per observation) with dimension labels, plus `canvas_id` and `truncated: true` when the result spills to DataCanvas. Large multi-country time-series spill to a DataCanvas table for follow-up SQL via `oecd_dataframe_query`. | `flow_ref`, `key` (dot-delimited), `start_period`, `end_period`, `canvas_id` (optional) | `readOnlyHint: true, idempotentHint: true` | `invalid_flow_ref` (ValidationError) — malformed `flow_ref` format; `dataflow_not_found` (NotFound) — `flow_ref` does not exist; `no_results` (NotFound) — valid flow but no observations match the key/time range; `invalid_key` (ValidationError) — OECD rejected the dimension key; `invalid_period` (ValidationError) — OECD could not parse the period; `download_limit` (RateLimited) — download/data-range throttle, only clears if the query shrinks; plus the shared upstream five (Design Decisions) |
| `oecd_dataframe_describe` | List DataCanvas tables and their columns from a prior `oecd_query_dataset` spill. Lets the agent discover staged table and column names before writing SQL. | `canvas_id` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` | `canvas_disabled` (ServiceUnavailable) — `CANVAS_PROVIDER_TYPE` is unset; `canvas_not_found` (NotFound) — `canvas_id` has expired or was never created |
| `oecd_dataframe_query` | Run a read-only SQL SELECT against tables staged on a DataCanvas by `oecd_query_dataset`. Requires `CANVAS_PROVIDER_TYPE=duckdb`. | `canvas_id`, `sql` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` | `canvas_disabled` (ServiceUnavailable) — `CANVAS_PROVIDER_TYPE` is unset; `canvas_not_found` (NotFound) — `canvas_id` has expired or was never created; `table_not_found` (NotFound) — the SQL names a table this canvas does not hold; `invalid_sql` (ValidationError) — SQL is not a valid SELECT statement |

### Resources

| URI Template | Description | Pagination | Errors |
|:-------------|:------------|:-----------|:-------|
| `oecd://dataflow/{agency_id}/{flow_id}` | Dimension metadata for a single dataflow — same content as `oecd_get_dataset_info` but as an injectable resource. `{flow_id}` is the combined `{DSD_ID}@{DF_ID}` string (e.g. `DSD_NAAG@DF_NAAG_I`), URL-encoded as `DSD_NAAG%40DF_NAAG_I` in the URI, or the bare `{DF_ID}` for a dataflow catalogued without a datastructure prefix. Together they reconstruct the canonical `flow_ref`. | No | `invalid_flow_ref` (ValidationError) — the two segments do not combine into a flow reference, or `{flow_id}` carries a malformed percent-escape; `dataflow_not_found` (NotFound) — the reference resolves to no datastructure; plus the shared upstream five (Design Decisions) |

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
- Attribution field in every observation row (`source: "OECD"`) per OECD terms of use
- No write operations

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OecdStructureService` | OECD SDMX structure API — dataflows, datastructures, codelists | `oecd_search_datasets`, `oecd_list_agencies`, `oecd_get_dataset_info`, `oecd_get_dimension_values`, `oecd_dataflow` resource |
| `OecdDataService` | OECD SDMX data API — observations, dimension decoding | `oecd_query_dataset` |

Both services call `fetchWithTimeout` + `withRetry` through a shared `fetchOecd` HTTP boundary (`src/services/oecd-http/oecd-http.ts`), which also corrects two retry-classification gaps OECD's own responses hit — an honored `Retry-After: 0` collapsing the backoff on a throttle, and a 500/501 landing on a terminal `InternalError` instead of a retryable `ServiceUnavailable`. The same module reads a terminal failure back into the shared upstream reason every definition declares (`upstreamRefusal()` — see Design Decisions), so a throttle, a timeout, an outage, and a refused redirect are named identically whichever service produced them. Both services parse SDMX-JSON responses and map HTTP errors to appropriate MCP error codes.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `OECD_BASE_URL` | No | `https://sdmx.oecd.org/public/rest` | SDMX REST base URL |
| `OECD_TIMEOUT_MS` | No | `30000` | Per-request timeout in milliseconds |
| `CANVAS_PROVIDER_TYPE` | No | `none` | Set to `duckdb` so a large `oecd_query_dataset` result spills to a queryable table instead of just capping the rendered preview |

---

## Implementation Order

1. Server config (`src/config/server-config.ts`) — `OECD_BASE_URL`, `OECD_TIMEOUT_MS`
2. `OecdStructureService` — `fetchDataflows()`, `fetchDataStructure()`, `fetchCodelist()`, shared HTTP/retry layer
3. `OecdDataService` — `fetchData()`, SDMX-JSON decoding (series key → row), `AllDimensions` mode
4. `oecd_list_agencies` — simplest tool, validates the service layer
5. `oecd_search_datasets` — list all dataflows, filter by query tokens and optional agency_id
6. `oecd_get_dataset_info` — fetch and expose datastructure dimensions
7. `oecd_get_dimension_values` — codelist lookup for a single dimension
8. `oecd_query_dataset` — data fetch + SDMX decode + DataCanvas spillover
9. `oecd_dataframe_describe` and `oecd_dataframe_query` — canvas query tools
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

Most dataflow IDs in the OECD API follow the format `{DSD_ID}@{DF_ID}` (e.g. `DSD_NAAG@DF_NAAG_I`); 8 of the 1,544 catalogued flows carry a bare `{DF_ID}` with no datastructure prefix. The agency is separate: `OECD.SDD.NAD`. Together they form a `flow_ref`: `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`, or `OECD.TAD.ARP,DF_AEI2024_DASHBOARD` for a bare id.

---

## Workflow Analysis

### `oecd_query_dataset` (2–3 upstream calls)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /datastructure/{agency}/{dsd_id}` | Fetch dimensions for key decoding (only on cache miss) |
| 2 | `GET /data/{flow_ref}/{key}?startPeriod=...&endPeriod=...&dimensionAtObservation=AllDimensions` | Fetch observations as flat key→value map |
| 3 | `canvas.acquire()` + `spillover()` | Stage full result on DataCanvas if row count exceeds preview threshold (omitted for small results) |

Call 1 can be cached per `flow_ref` within the session (TTL matches request lifetime). The key decoding step converts the `0:9:0:0:0` SDMX index notation into row objects carrying each dimension and each observation-level attribute as its own column, resolved to labels — `{ REF_AREA: "United States", MEASURE: "Gross domestic product", UNIT_MULT: "Billions", value: 26054614000000, value_scale: 1000000000 }`.

**Output schema — three paths:**

- **Inline (small result):** `{ rows: DecodedRow[], row_count: number, source: "OECD" }` — all observations in response
- **Spill (large result, canvas configured):** `{ rows: DecodedRow[], row_count: number, canvas_id: string, table_name: string, truncated: true, source: "OECD" }` — `rows` holds the inline preview, `canvas_id` + `table_name` address the full table, `truncated: true` signals the agent to use `oecd_dataframe_query` for analytics
- **Large result, no canvas:** `rows` holds every observation, and the enrichment fields `content_table_capped` + `content_table_rows` disclose that the rendered table stopped short of it. `truncated` stays absent — it promises a `canvas_id`, and there is none to give

`format()` must render the inline `rows` in both paths — it should include the `canvas_id` and a note to use `oecd_dataframe_query` when `truncated: true`, so `content[]`-only clients (Claude Desktop) see the same signal as `structuredContent` clients.

**One preview budget, two fates for the remainder.** `spillover()`'s `previewChars` only bounds the response when a canvas exists, and `CANVAS_PROVIDER_TYPE` defaults to `none` (the `.mcpb` bundle ships without the DuckDB native, so that is the common configuration). The same budget therefore also caps the rendered table on the no-canvas path, counted the same way — accumulated `JSON.stringify` length, first row over the line excluded — so the preview is identical either way and only the destination of the omitted rows differs: a canvas table, or `structuredContent.rows`.

---

## Design Decisions

**DataCanvas adopted.** OECD observations are the canonical example of analytical tabular data: country × measure × time rows that agents aggregate, compare, and filter. A query for GDP across all 38 OECD members for 10 years produces 380+ rows — clearly crosses the `previewChars` threshold for typical queries. Both gates pass: shape is analytical (GROUP BY country, year) AND size exceeds inline. `oecd_query_dataset` uses `spillover()` and is paired with mandatory `oecd_dataframe_describe` + `oecd_dataframe_query` tools.

**`UNIT_MULT` is applied, not just labelled.** A dataflow publishes GDP as `26054.614` with `UNIT_MULT = Billions`; two dataflows publishing the same figure disagree on magnitude by a factor of a thousand (`Millions` vs `Billions`), so a raw value is not comparable across flows and an agent that sums or ranks them silently gets the wrong answer. The decoder multiplies by `10 ** id` — the code id is the base-10 exponent in `SDMX,CL_UNIT_MULT` and in the three OECD-local variants of it — and every row carries `value_scale`, the divisor that recovers the published figure. Codes outside the codelist range (`9999`, meaning ".") are not exponents and leave the value alone.

**`AllDimensions` observation mode.** Instead of the default SDMX-JSON `series`-grouped format (which requires two-pass decoding of series key + observation time index), we request `?dimensionAtObservation=AllDimensions`. This returns a flat `observations` map keyed by a full dimension index tuple. One-pass decoding: split key string on `:`, look up each index in the corresponding dimension's `values` array. Simpler implementation and cleaner row output for the canvas.

**Flow ref format: the id as OECD catalogues it, not a reconstructed one.** The SDMX API uses `{agencyID},{flowID}` in the data URL path, where `flowID` is usually the combined `{DSD}@{DF}` string URL-encoded (`%40`) and occasionally a bare `{DF}`. Tools expose either as a single `flow_ref` parameter — the service layer handles URL encoding. Pairing a bare id with the datastructure named in its `structure` URN builds a combined ref the data endpoint rejects, so the catalog id is passed through verbatim and both forms are accepted everywhere a `flow_ref` is.

**A datastructure is addressed directly first, then through its dataflow.** `GET /datastructure/{agency}/{dsd_id}` answers in one request, so it stays the first attempt for a combined ref. But the `{dsd_id}` half is a label OECD does not keep in step with the real datastructure — for 49 of 1,544 flows it names one that does not exist — so a not-found falls back to `GET /dataflow/{agency}/{id}?references=datastructure`, which is also the only route for a bare ref. The fallback is second rather than first because the reference route is not a superset: 27 flows are published as external references whose reference response carries no datastructure, and 10 of those still resolve on the direct route. Only a ref the first route cannot resolve pays a second request.

**A delegated catalog entry is followed to the service root that owns it.** 27 of the 1,544 flows are published on `/public/rest` as a pointer rather than a definition — `isExternalReference: true`, no `structure` URN, and a `links[]` entry with `rel: "external"` naming another OECD service root. Three roots appear: `/sti-public/rest` (14 flows), `/dcd-public/rest` (10), `/archive/rest` (3). The mapping is not derivable from the agency — `OECD.SDD.TPS` delegates to `sti-public` for three flows and `archive` for three others — so the root is read per-entry from `links[]` and never guessed.

Both halves of the collection are affected, and differently. The datastructure resolves on `/public/rest` for 10 of the 27 and 404s for the other 17. The data endpoint answers 500 (`Object reference not set to an instance of an object.`) for all 27, so `oecd_query_dataset` could not serve a single externally-referenced flow — including the DAC creditor-reporting aid series and Trade in Value Added. Each delegating root serves both `/datastructure` and `/data` for its own flows.

Following the delegation makes all 27 usable, so `oecd_search_datasets` does not flag them: a marker that always reads "this one works anyway" is noise on every result. A future entry naming no followable root degrades to the ordinary `dataflow_not_found`, which already tells the caller what a flag would have.

The lookups sit on the failure path, so the common case pays nothing. `fetchDataStructure` reads the delegation off the `?references=datastructure` response it has already fetched — that payload carries `links[]` alongside the empty `dataStructures` — so a delegated structure costs one request beyond the two the ref would otherwise have spent failing when the delegated root answers its own direct route, and two when that root's `dsd_id` label is stale the same way the configured root's was, and its reference route has to answer instead. `fetchData` holds no such payload, so a 404 or 500 from the configured root buys one `GET /dataflow/{agency}/{id}` before the query is reissued against the delegated root. A 429, a 503, or a timeout buys nothing: none of them says anything about where the flow lives, and another request is the last thing a failing service needs.

**The lookup runs before the retries, not after.** Delegation and an unwell service are spelled the same way — HTTP 500 — and the catalog is the only thing that tells them apart. Retrying first gets that backwards: the delegated 500 is a fixed property of a flow the root does not host, so it repeats on every attempt, and each of the 27 flows would pay three requests and the framework's 1s/2s backoff on every single query before the delegation was even consulted. So the first pass at the configured root withholds its retry budget from a 404 or a 500 (`data.retryable: false`, the framework's in-band opt-out), and the catalog answers in one request — itself deliberately unretried, since moving the same three requests onto the catalog endpoint would only relocate the delay. Held back is not spent: a 500 the catalog cannot explain is an ordinary transient fault after all and resumes its remaining attempts against the configured root, backoff intact. The order costs the common case nothing — a flow the configured root serves answers on the first request either way — and it is what lets a delegated query succeed without reporting three upstream faults on the way. 500 is in `HANDLED_STATUSES` for the same reason: whether it is a fault at all is not known until a request later, and the one that turns out to be real still surfaces at the tool boundary like every other failed query.

**Codelists and concept schemes are read at the root and the version the datastructure names.** Both axes carry real codes, and getting either wrong offers the caller values the dimension rejects.

The root, because both artefacts are versioned per root and `/public/rest` mirrors an older revision: it answers `OECD.STI.PIE/CL_TIVA_MEASURE` with version 1.0 (47 codes) while `sti-public` — the root owning `DSD_TIVA_EXGRVA` — answers with 44. `OecdDataStructure.serviceRoot` records which root answered so the follow-up lookups address the same one.

The version, because an unversioned `GET /codelist/{agency}/{id}` answers with whatever that root currently calls latest, and a codelist moves on independently of the datastructures using it. `DSD_TIVA_EXGRVA`'s `VALUE_ADDED_SOURCE_AREA` references `CL_AREA(1.7)`, 560 codes; the root's latest is 1.9, 568. The enumeration URN names the revision the dimension accepts, so it is carried onto `OecdDimension.codelistVersion` and appended to the request. The same holds for the `conceptIdentity` URN and its concept scheme, at no extra cost — the versioned URL is exactly as cheap as the unversioned one.

Pinning is anchored to the datastructure actually fetched, not to a version the caller supplied. A `flow_ref` carries no version and `GET /datastructure/{agency}/{dsd_id}` is answered with latest by design: it is the entry point, and asking for a specific revision would cost a catalog request to learn which one to ask for. Whichever revision answers is then the authority for everything downstream, so the codelist and the concept scheme are always coherent with the dimensions being described. A version the root no longer serves 404s, and that falls back to latest: an outdated list beats failing the dimension outright, and the fallback costs a request only on a reference gone stale. A version outside the SDMX digit-and-dot shape is dropped at parse time rather than addressed — it reaches a URL path segment, and the same reasoning that governs identifiers governs it.

**A delegated href is a hint about where, never a request to replay.** The href arrives inside an upstream response body, so fetching it unchecked is a server-side request forgery — whoever shapes that body picks the host. `externalServiceRoot()` is the only gate, and it is deliberately narrow: the URL must parse, its origin must equal the configured base URL's origin exactly (scheme, host, and port), its scheme must be `https`, and its path must match `/{service}/rest/dataflow/…`. Only the leading `{service}` segment survives — the root is rebuilt as `{origin}/{service}/rest`, and every request path is reassembled from identifiers `parseFlowRef` has already validated. An href failing any check resolves to undefined and the caller reports the structure or the observations as unreachable rather than fetching anything. So the reachable blast radius of a fully attacker-controlled href is a different path prefix on the host the server was already configured to talk to, and it stops there. Do not loosen the origin check to a suffix or hostname-contains match, and do not pass an href through as a request URL.

**Every definition declares its failures, and every surface names the same failure the same way.** A definition that can fail carries an `errors[]` contract — reason, code, when, recovery — and the handler throws through `ctx.fail(reason, …, ctx.recoveryFor(reason))`, so `data.reason` and `data.recovery.hint` travel with the code. The alternative is a bare code, which tells a caller that something failed and nothing about what to do next.

Two rules hold the contract together across the seven definitions rather than leaving each one internally consistent and mutually contradictory. A reason means one thing wherever it is declared and always carries the same code. And no failure a caller can act on identically is reported under two reasons: an unparseable `flow_ref` and a refused redirect each resolve to one reason whichever surface received the call, because a client cannot be expected to know which one it reached before it can read the answer. A reason splits only where the next move genuinely splits with it, which happens once — the download throttle, whose `download_limit` is declared on the one surface that can shrink its request and folded into `rate_limited` everywhere else. Recovery hints are the looser part, free to differ wherever a surface offers a different move.

Where the contract lands differs by definition type, and only in the envelope. A tool failure is a result — `isError: true`, with the code on `result.structuredContent.error.code` and the reason and hint under its `.data`. A resource re-throws instead, so the read request itself fails and the same code, reason, and hint arrive in the JSON-RPC top-level `error.{code, data}`. The declaration is identical either way; `resource()` takes `errors[]` on the same terms `tool()` does.

`oecd://dataflow/{agency_id}/{flow_id}` resolves the same identifier against the same endpoints as `oecd_get_dataset_info`, so it declares the same reasons under the same codes. One hint has to diverge: the tool takes a single `flow_ref` string where the resource takes it split across two URI segments, so the resource's `invalid_flow_ref` recovery says how to perform that split and where the `@` becomes `%40`. The resource also folds a malformed percent-escape into `invalid_flow_ref` — `decodeURIComponent` raises a `URIError` on `%ZZ`, and an unreadable identifier is the caller's mistake whether the parse or the decode caught it, not an internal fault.

**An unparseable `flow_ref` is a syntax failure, never a missing dataflow.** `parseFlowRef` returning null means the string is not a flow reference at all and no request is issued, so `NotFound` would assert an absence this server never checked and send the caller to look the reference up again when the reference may be the one thing they had right. All four surfaces that accept a flow reference — `oecd_get_dataset_info`, `oecd_get_dimension_values`, `oecd_query_dataset`, and the resource — report it as `invalid_flow_ref` (ValidationError), with the same `when` and the same hint on the three tools. `dataflow_not_found` keeps the case it names: a reference that parses and resolves to no datastructure.

**The upstream half is identical on every definition that reaches OECD.** Once a handler's own branches have declined a failure — no missing dataflow, no rejected key — what is left is the upstream's answer, and `upstreamRefusal()` in `src/services/oecd-http/oecd-http.ts` reads it into one of five reasons that all six tools and the resource declare:

| Reason | Code | Fires on |
|:-------|:-----|:---------|
| `rate_limited` | RateLimited (retryable) | A 429. OECD charges one throttle budget across the data and structure endpoints, so a refused `/datastructure`, `/codelist`, or `/conceptscheme` call is as ordinary as a refused `/data` one |
| `upstream_timeout` | Timeout (retryable) | No response within `OECD_TIMEOUT_MS`, or a 408/504 |
| `upstream_unavailable` | ServiceUnavailable (retryable) | A server fault or an unreachable host once the retries ran out |
| `upstream_redirect` | Forbidden (not retryable) | A 3xx, refused at the fetch boundary |
| `upstream_error` | ServiceUnavailable | Any other status this server does not model — a 401, a 403, a 400, a 409 |

The throttle earns its entry twice over. `withRetry` has already spent its attempts and its backoff by the time a 429 surfaces, so "retry now" is precisely the wrong next move and the bare code invites it. And the throttle is the one upstream refusal an ordinary caller provokes without anything being misconfigured.

`upstream_error` exists because the alternative is worse than a slightly loose bucket. A `Forbidden`, an `Unauthorized`, or an `InvalidParams` from a keyless public API tells a caller nothing they can act on, and none of them is a code a client would think to switch on. Restating them as one reason with one honest hint — retry once, then report the response and check `OECD_BASE_URL` — costs the precision of the original code and buys a next move. The code it carries is `ServiceUnavailable` because from the caller's seat that is what happened: the server could not complete the upstream call.

**Deliberate boundaries.** Five gaps in the contract are decisions, not oversights.

`InternalError` and `SerializationError` are never restated. A caller's own abort arrives as an `InternalError` and a body this server could not decode arrives as a `SerializationError`; both name this server or its client, and reporting either as an OECD refusal would blame the wrong party. A `ValidationError` that reaches the terminal ladder is left alone for the same reason — it is claimed where the caller's own input caused it (`invalid_flow_ref`, `invalid_key`, `invalid_period`) and is not OECD's answer anywhere else.

`download_limit` is declared only on `oecd_query_dataset`. OECD spells its two throttles differently in the response body — the request-rate one clears by waiting, the download-and-data-range one only by asking for less — but "ask for less" is advice only a caller holding a key and a period can act on. Every other surface asks for one fixed artefact: a codelist is the size it is. So they map both bodies to `rate_limited`, whose recovery is the safe answer for either, rather than declaring a reason whose hint their caller cannot perform.

`upstream_timeout`'s hint diverges by surface, across three moves. `oecd_query_dataset` can tell a caller to split the key or the period; `oecd_search_datasets` can tell one to set `agency_id` and fetch a single agency's dataflows instead of the whole catalog; `oecd_list_agencies` and the three surfaces that fetch one structure have nothing to narrow and can only say to raise `OECD_TIMEOUT_MS`. Same failure, same reason, same code — different move available.

The catch-all claims a status, not an absence, and it claims nothing at all outside its five. `upstream_error` is reached only after a handler's own branches decline the failure, so a `NotFound` none of them claimed lands there and is reported as `ServiceUnavailable` — the codelist `oecd_get_dimension_values` reads after the datastructure resolves is the case that reaches it, since only the datastructure call has a `dataflow_not_found` branch in front of it. A dedicated `codelist_not_found` would be more precise and would hand the caller the move `upstream_error` already gives: report the response, because no change to the request conjures a codelist OECD does not publish. In the other direction, where `upstreamRefusal()` declines outright — one of the three own-fault codes, or a thrown value that is not an `McpError` — the failure bubbles undeclared rather than being restated. `oecd_list_agencies` and `oecd_search_datasets` previously wrapped everything left over as `upstream_error`; they no longer do, so a caller's own abort surfaces as the `InternalError` it is instead of as an OECD outage.

The two DataCanvas tools declare their own reasons and none of the upstream five. They read a canvas this server already holds and issue no request, so there is no upstream to answer for.

**An origin checked before a request is only the first hop, so redirects are refused.** A host that answers a 3xx moves the request wherever its `Location` points, cross-origin included, which leaves the origin check above worth exactly what the fetch boundary's redirect policy is worth. `fetchOecd` issues every request with `redirect: 'manual'` and restates a 3xx as a terminal `Forbidden`, never retried — a redirect is a fixed property of the endpoint, so another attempt only repeats it. The rule covers every OECD call rather than the delegated ones alone: a redirect needs no href to be read, so it is the one way an upstream can move a request off-host on a path that consults no response body at all.

No hop is followed, rather than same-origin hops up to a bound. OECD does not redirect — `/dataflow`, `/datastructure`, `/codelist`, `/conceptscheme`, `/agencyscheme`, and `/data` each answer directly on all four service roots — and a validated hop could not be re-issued without rebuilding the boundary, since `fetchWithTimeout` reports a 3xx as a status-mapped failure and does not carry the `Location` onto it. Following nothing also leaves no chain to bound. The visible cost is a base URL configured over plaintext: OECD answers `http://sdmx.oecd.org/…` with a 301 to https, a different origin, so it now fails with an error naming `OECD_BASE_URL` instead of being upgraded in silence.

Every definition that reaches OECD declares that failure as `upstream_redirect` (Forbidden, not retryable) and reports the boundary's own sentence. It is kept distinct from `upstream_unavailable` and `upstream_error`, both of which advise a retry: no wait clears a misconfigured origin, and the only fix is to `OECD_BASE_URL`. Both services relabel an upstream failure with a message of their own on the way up, so the sentence naming the variable is read back off the cause chain rather than rewritten per tool.

**An empty match is spelled two different ways.** OECD reports "the query parsed and matched nothing" as a 404 whose body is `NoResultsFound` on some service roots and `NoRecordsFound` on others, while a root that genuinely lacks the flow says so in prose. Both sentinels map to an empty result, so a valid query against a delegated flow reports `no_results` instead of claiming the dataflow does not exist.

**Identifier validation is what keeps the ref out of the URL structure.** Every segment of a `flow_ref` lands in a URL path segment, so it must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` before any request goes out. The character class stops `/`, `?`, `#`, `%`, and NUL; the leading alphanumeric stops an identifier that is nothing but dots, which URL resolution reads as a relative path reference and removes — walking the request out of the endpoint it was addressed to and, on the reference route, into the whole-catalog listing. Every identifier the catalog publishes opens on a letter or digit, so nothing real is excluded.

**`oecd_search_datasets` uses MCP-side filtering over all dataflows.** With 1,544 dataflows across 52 publishing agencies, the SDMX API has no native full-text search endpoint. We fetch all dataflows per agency (or all agencies at once via `GET /dataflow`) and filter in-memory by token-matching against the `name` field. This is the bounded-set list-filter pattern — one batch fetch, then local filtering. The full set fits in memory (~5.9 MB JSON) and is naturally bounded (OECD publishes datasets at a pace measurable in weeks, not seconds). Agency-filter (`agency_id`) reduces fetch scope when provided.

**One `flow_ref` parameter instead of separate `agency_id` + `flow_id` inputs.** The combined format `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I` is what `oecd_search_datasets` returns and what the data URL needs. Accepting it as a single string avoids agent reconstruction errors and mirrors how other SDMX servers (eurostat) handle dataset codes.

**Codelist search lives inside `oecd_get_dimension_values`, not in a tool of its own.** The tool takes an optional `query` and matches it case-insensitively as a substring against both the code id and its label, then pages the matches with `limit`/`offset`. Filtering happens on the result set rather than in `format()`, so both client surfaces carry the same bounded page — an earlier shape returned the whole codelist in `structuredContent` while rendering only the first 50 rows, which put the remaining codes out of reach for a `content[]`-only client and shipped 66 KB to everyone else. `UNIT_MEASURE` runs to 1,164 codes and `REF_AREA` to 570, so "small enough to inline completely" does not hold. A separate search tool is still not warranted: the filter is one parameter on the tool that already owns the codelist.

**Dimension names come from a second request.** OECD's datastructure response carries no `name` on a dimension, so without a follow-up every name just repeats the id. The names live in the concept scheme each dimension's `conceptIdentity` URN points at, and every dimension of a datastructure shares one scheme in practice, so one `GET /conceptscheme/{agency}/{schemeId}` resolves them all. `?references=children` would inline them in the first request but also inlines every codelist — 866 KB for `DSD_NAMAIN1` against 7,949 + 5,927 for the two-request path. The lookup is best-effort: a scheme that fails or omits a concept leaves that dimension on its id rather than failing the call.

---

## Known Limitations

- **No native search across the whole catalog** — `oecd_search_datasets` fetches all 1,544 flows at query time (~5.9 MB JSON, ~5–8s). A MirrorService cache would help but adds complexity for v0.1.
- **Dimension key construction requires prior `oecd_get_dataset_info` call** — dimension order varies per dataflow. The tool description documents this workflow requirement clearly.
- **Some dataflows have `NonProductionDataflow: true` annotation** — these are experimental or deprecated. Surfaced in `oecd_get_dataset_info` output so agents can see the flag.
- **Third-party data within OECD dataflows** — IEA energy data is embedded in some flows with stricter terms. The OECD terms place the burden on users to check per-dataset source metadata; the `source` field in tool output is the mechanism.
- **No SDMX hierarchy support** — dimension codes sometimes have hierarchical relationships (parent/child aggregates). This server treats all codes as flat — hierarchical rollups must be done manually or via DataCanvas SQL.

---

## API Reference

### Endpoint patterns

| Operation | Pattern |
|:----------|:--------|
| All dataflows (all agencies) | `GET /dataflow` |
| Dataflows by agency | `GET /dataflow/{agencyID}` |
| Specific dataflow | `GET /dataflow/{agencyID}/{flowID}/{version}?references=none` |
| Datastructure | `GET /datastructure/{agencyID}/{dsdID}` |
| Datastructure via its dataflow | `GET /dataflow/{agencyID}/{flowID}?references=datastructure` |
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
      "observations": {
        "0:0:2:3:0:0": [26054.614, 0, 0, 0]
      }
    }],
    "structures": [{
      "dimensions": {
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

Observation key `"0:0:2:3:0:0"` decodes as: FREQ[0]=A, REF_AREA[0]=USA, MEASURE[2]=..., UNIT_MEASURE[3]=..., CHAPTER[0]=NAAG_I, TIME_PERIOD[0]=2022. The first element of the observation array is the numeric value; subsequent elements are attribute values.

When `AllDimensions` is requested, all dimensions move to the `observation` level — `series` is empty. This simplifies decoding to one pass over the observation map.

### Error shapes

| HTTP | Body | Meaning |
|:-----|:-----|:--------|
| 404 | `"Could not find Dataflow and/or DSD related with this data request"` | Invalid `flow_ref` in data query |
| 404 | `"NoResultsFound"` | Valid flow but no data matching the key/time range |
| 400 | `"Invalid structure: data"` | Malformed key or unsupported query parameter |
| 200 | Empty `dataSets[0].observations` | Valid query, zero matching observations |

Error bodies are plain text, not JSON — check `Content-Type` before attempting to parse.

### Rate limits and pagination

OECD publishes no rate-limit figures, but it does throttle. Two separate limits arrive as a 429 whose plain-text body names which one was hit — a request-rate limit that clears by waiting, and a download-and-data-range limit that only clears if the query shrinks. Both budgets are charged against the client across every endpoint, so a throttled `/datastructure`, `/codelist`, or `/conceptscheme` call is as ordinary as a throttled `/data` one. Structure responses for all dataflows (1,544 entries) are ~5.9 MB and take 8–10s. Data responses for narrow queries (single country, few measures, 3–5 years) return in 1–3s. Always filter by time range — unfiltered time-series go back decades and can produce hundreds of observations per series.

No pagination for structure endpoints — all results in one response. The data endpoint has no pagination either; dimension key filtering is the only mechanism to bound result size.
