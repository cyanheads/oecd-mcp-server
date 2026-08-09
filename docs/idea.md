---
name: oecd-mcp-server
description: "OECD statistics — economic, social, and environmental indicators across member and partner economies, queried live over the OECD SDMX REST API by dataflow and dimension."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/oecd-mcp-server"
created: 2026-06-02
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
licensing: "VERIFIED 2026-06-02 (oecd.org terms). Open-by-default since 2024-07-01: Data may be extracted, distributed, and used commercially WITH attribution (cite OECD per the dataset citation). The carve-out is real and confirmed: some Data is third-party-owned with extra restrictions, and it is the USER's responsibility to check the per-dataset metadata / 'source' tab before reuse — so surface that source field in tool output. IEA energy is the classic third-party example. Live-proxy posture keeps this low-stakes."
pattern: deep single-source (SDMX, live query)
complexity: medium
api-deps: OECD SDMX 2.1 REST API (the OECD Data Explorer backend, sdmx.oecd.org/public/rest) — keyless; SDMX-JSON / SDMX-ML / CSV
api-cost: free (keyless; OECD terms of use require source attribution)
hostable: true
composes-with: worldbank-mcp-server, eurostat-mcp-server, imf-mcp-server, un-comtrade-mcp-server, who-gho-mcp-server
---

# oecd-mcp-server

OECD statistics as a workflow server over the OECD's SDMX REST API. The OECD publishes thousands of dataflows — GDP and national accounts, employment, inflation (CPI/PPI), trade, education, health, environment, productivity, taxation, inequality — across its member and partner economies, **keyless** via the SDMX 2.1 API that backs the OECD Data Explorer.

The fleet's international-statistics coverage spans `worldbank` (development indicators), `eurostat` (EU), `imf` (idea — macro/financial), `un-comtrade` (trade flows), and `who-gho` (health) — but the **OECD**, the canonical source for comparative data across advanced economies (and the home of PISA, the Better Life Index, and standardized productivity/tax/inequality series), has no coverage. It's the missing peer to `worldbank`/`eurostat`.

**Audience:** economists, policy researchers, data journalists, and agents answering "how does country X compare across OECD economies on indicator Y."

## Data Model (SDMX — like eurostat)

| Concept | What it is |
|:--------|:-----------|
| **Dataflow** | A dataset (national accounts, air emissions, etc.), addressed by an agency-qualified ID. Primary discovery target. |
| **Dimensions** | The axes of a dataflow (reference area, measure, unit, time) — they define the query key. |
| **Codelists** | Valid values per dimension (country codes, measure codes) — resolve human terms to codes before querying. |
| **Observations** | The actual data points returned for a dimension key + time range. |

## User Goals

- Find an OECD dataset by topic (search/browse dataflows)
- See a dataset's dimensions and the valid codes for each
- Pull a time series for a country + indicator + measure
- Compare an indicator across many OECD economies
- Resolve a human term (country name, measure) to the SDMX code a query needs

## Tool Surface (sketch)

Tools use the `oecd_` prefix and mirror `eurostat`'s SDMX workflow shape.

```
oecd_search_datasets       — the discovery entry point. Find dataflows by keyword/theme.
                             Returns dataflow IDs + titles.

oecd_get_dataset_info      — the dimensions of a dataflow and how to key a query against it.

oecd_get_dimension_values  — valid codes for a dimension (countries, measures, units).
                             Resolve human terms → SDMX codes before querying.

oecd_query_dataset         — fetch observations for a dataflow filtered by dimension key +
                             time range. The 80% data-retrieval tool. Large analytical pulls
                             spill to DataCanvas (paired with oecd_dataframe_query).

oecd_dataframe_describe    — list DataCanvas tables and columns from a prior oecd_query_dataset
                             spill (canvas_id). Required to make canvas output usable.

oecd_dataframe_query       — run SELECT SQL against staged DataCanvas tables (canvas_id).
                             Gated on CANVAS_PROVIDER_TYPE=duckdb. Completes the DataCanvas pair
                             mandated by the half-build audit.
```

## Design Notes

- **Lift the SDMX plumbing from `eurostat`.** Same standard (SDMX 2.1), same workflow (find dataflow → inspect dimensions → resolve codes → query observations), same gotcha (filter by dimension to avoid timeouts/huge responses on broad dataflows). `eurostat` already solved discovery, code resolution, and result shaping — OECD is largely a re-point to the OECD endpoint + agency IDs.
- **Verify the current API at build — OECD migrated recently.** The legacy SDMX-JSON API (`stats.oecd.org`) was retired in favor of the OECD Data Explorer's SDMX 2.1 REST API (`sdmx.oecd.org/public/rest`). Confirm the exact base URL, the agency/dataflow ID format, format negotiation (SDMX-JSON vs CSV), and any rate limits with live probes during design Step 1 — this is the single fact most likely to have drifted since this stub was written.
- **Dimension-first querying is mandatory.** OECD dataflows can be enormous; an unfiltered query times out or returns megabytes. Require a dimension key (at least reference area + measure + time range) and surface truncation honestly — same discipline as `eurostat`.
- **Attribution.** OECD data is free to reuse under OECD terms but requires source attribution — carry it in tool output/provenance. Some datasets carry tighter terms; flag per-dataflow if encountered.
- **DataCanvas fits here** (unlike the static-lookup stubs): OECD observations *are* analytical rows (country × measure × time) an agent would aggregate/compare. Pair `oecd_query_dataset`'s canvas spillover with an `oecd_dataframe_query` (+ `oecd_dataframe_describe`) tool, gated on `CANVAS_PROVIDER_TYPE=duckdb`, exactly as `eia`/`bls`/`socrata` do — and don't half-build it (a `canvas_id` with no query tool is dead output; see `kb/audits/2026-05-31-datacanvas-half-builds.md`).
- **Composes with** `worldbank` / `imf` / `eurostat` (triangulate the same indicator across sources), `un-comtrade` (trade), `who-gho` (health).
- **Moonshot:** a cross-source indicator compare — given a metric and a set of countries, pull the OECD series and the World Bank/IMF equivalent, align them on a common time axis, and flag where the sources diverge.
- README one-liner: "OECD statistics — economic, social, and environmental indicators across member and partner economies, over the keyless OECD SDMX API."
