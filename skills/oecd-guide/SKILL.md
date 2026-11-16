---
name: oecd-guide
description: Build SDMX keys, confirm which series an OECD dataflow actually carries, and read oecd_* results without mixing units, breakdowns, or country aggregates. Use when calling oecd_* tools for cross-country statistics (GDP, growth, unemployment, labour, education, tax), when a query returns no_results or invalid_key, or when a result spills to SQL.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.2"
---

## Scope

OECD statistics on harmonised definitions, keyless: OECD members, partner economies (Brazil, China, India, South Africa and others), and group aggregates such as G7, G20, OECD, Euro area, and European Union. Use it for cross-country comparison. Each dataflow is a fixed slice of the catalog, so near-identical flows often differ only in their country set or measures. Search results show this: one national-accounts structure underlies many quarterly flows.

## Identifiers

| Identifier | Shape | Comes from |
|:--|:--|:--|
| agency id | `OECD.SDD.NAD` | `oecd_list_agencies`, or the part of a flow ref before the comma |
| flow ref | `OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA_EXPENDITURE_GROWTH_OECD` | `oecd_search_datasets` — pass through unchanged |
| dimension id and position | `REF_AREA`, position 3 | `oecd_get_dataset_info` — order differs per structure (`FREQ` is first in quarterly national accounts, ninth in monthly unemployment) |
| code | `USA`, `B1GQ`, `G1` | `oecd_get_dimension_values`; its search matches code or label, case-insensitive, so `gross domestic product` finds `B1GQ` |
| key | `Q..USA...B1GQ......G1.` | you build it: one segment per dimension in position order |
| canvas id, table name | `Bw5nAvopBg`, `spilled_54593839` | `oecd_query_dataset`, only when the result spills |

Flows whose refs share a `dsd_id` normally share a key layout. A key built for `DF_QNA_EXPENDITURE_GROWTH_OECD` also runs against `DF_QNA_EXPENDITURE_GROWTH_G20`. If a reused key fails with `invalid_key`, check that flow with `oecd_get_dataset_info`.

## Gates

**A codelist is not a coverage list.** By default `oecd_get_dimension_values` returns the whole shared codelist. A transformation codelist lists 59 codes, but the quarterly growth flow carries three of them. A listed code the flow doesn't carry returns `no_results`. To list only the codes with data, call it with `available_only: true`, or pass `key` with the key you plan to query: it lists the codes of that dimension that have data given the key's other segments. That is a structure read, never a data download. The result also carries `time_range` and `observation_count` for the key. If a result asked for `available_only` and came back with `available_only: false`, OECD's availability record could not be read and the codes are the whole codelist; read the notice. A code that matches only by letter case is named in the notice.

**Empty segments return every series, not a default one.** One country and one quarter in the growth flow return 18 rows: six expenditure components times three transformations. Monthly unemployment returns 18 rows per country, crossing two adjustments, three sexes, and three age bands. Pin every segment whose rows differ before you compare, rank, or average. `Total` and `15 years or over` are aggregates of the other rows, so summing across them double-counts.

**Wildcarding the country segment includes aggregates.** Rows for G7, G20, OECD, OECD Europe, Euro area, European Union, and USMCA come back beside the countries. Exclude them before you average countries, or use the aggregate row itself.

**Rows carry labels and codes, and constant components arrive once.** Each coded component appears as its label and as `<ID>_code`: `REF_AREA` is `United States` and `REF_AREA_code` is `USA`. Filter on the code column, not the label: a SQL filter on `REF_AREA = 'USA'` silently matches zero rows, and some labels are unexpected (`China (People’s Republic of)`, `Türkiye`, `Korea`). A component that holds one value across the whole result is not in `rows` at all; it is in `constant_columns` as `{ code, label }`, which is `{}` when every component varies. Read the unit, the frequency, or the adjustment there when no row shows it. Regional labels repeat across countries (`Amazonas` in Brazil and Peru, `North West` in Bulgaria, Romania, and South Africa), so in a regional flow group, partition, and join on `COUNTRY` together with `REF_AREA`; on `REF_AREA` alone, different regions merge into one.

**`invalid_key` means the key itself is malformed:** too few segments (`expecting 13 got 5`) or a character SDMX doesn't allow. Extra trailing empty segments are ignored, and an extra non-empty one comes back as `no_results`. A misspelled or unavailable code (`US` for `USA`) also comes back as `no_results`, and the message names the cause when OECD's availability record gives one: `REF_AREA "US" has no data given the other segments`, `"usa" matches "USA" only by case`, that the pinned segments match no series together, or that the requested period is outside the key's range. Correct that segment, or list its codes with `oecd_get_dimension_values` and the same `key`. Re-reading the whole codelist can't tell you what the flow holds.

**Periods.** The time dimension is not a key segment; set the range with `start_period` and `end_period`. Use `2015` for annual, `2015-Q1` for quarterly, and `2015-01` for monthly data. `2015Q1` is rejected as `invalid_period`. A bare year on a quarterly flow starts at its first quarter. Quarterly and monthly `TIME_PERIOD` labels use the same formats (`2024-Q1`, `2025-01`), so they sort correctly as text.

**Values are already scaled.** `value` is multiplied by the `UNIT_MULT` power of ten. A US quarterly GDP level published in millions comes back as about 6 × 10¹² (chain-linked volume) or 7.5 × 10¹² (current prices), with `value_scale` 1000000. Don't scale it again. Divide by `value_scale` only to quote the figure as OECD published it. `Percentage change` rows are in percent: `0.36` means 0.36 %.

**A spilled preview is not the result.** When `truncated` is true, `rows` holds only the leading rows in the sort order (dimension code in key order, then `TIME_PERIOD`), so a multi-country preview covers the countries that sort first, the last of them possibly partly, and none of the rest. Compute only in SQL against the staged table.

**SQL output is capped.** `oecd_dataframe_query` returns up to `limit` rows: 100 by default and at most 1,000 per call; a larger `limit` is served at 1,000 with a notice. `row_count` counts the rows returned, not the result. `truncated: true` means the result has more rows than came back, and its notice names the ways to the rest: aggregate in SQL, page with `ORDER BY … LIMIT … OFFSET`, or raise `limit` when it is below 1,000. Run `COUNT(*)` when the total matters. A query still running after 30 seconds is stopped with `query_timeout`; filter rows, select fewer columns, or aggregate so it finishes sooner.

**Data downloads are rationed.** OECD allows 60 data downloads per hour per client. The server is the client OECD sees, so on a shared deployment every caller draws on the same budget. Put several countries in one key segment (`CAN+FRA+DEU+ITA+JPN+GBR+USA`) and make one call, not one per country. Probe with a single period. Space calls a few seconds apart: a burst of back-to-back calls can return `rate_limited`, and that applies to first structure lookups. A repeat structure lookup inside OECD's cache lifetime sends no request. `download_limit` clears only when you request less: fewer codes or a shorter range. `rate_limited` clears if you wait.

**OECD marks test and experimental flows only in their names.** No result carries a production flag. When two flows look alike, compare their names before you choose.

**Search matches the catalog's words, not synonyms.** Each token matches only at the start of a word in a flow's name or description, so `ICT` does not find `jurisdiction`, and `employment` does not reach a flow that only mentions unemployment. A token that opens on a separator such as `&` matches anywhere, so `&` finds `R&D`. `jobless` finds benefit-policy flows but none of the unemployment-rate flows. Search the word you mean, in OECD's vocabulary: `unemployment`, `GDP`, `quarterly`, `national accounts`. Name matches come first.

## Core chain

`oecd_search_datasets` → `oecd_get_dataset_info` → `oecd_get_dimension_values` with `available_only` or `key` for each segment you need to pin → `oecd_query_dataset` with every varying segment pinned → `oecd_dataframe_describe` and `oecd_dataframe_query` if it spills. A probe query (one period, open segments) still works to see which series exist: each returned row is one.

## Workflows

**Growth rates.** OECD publishes growth precomputed in the `TRANSFORMATION` dimension: `G1` for growth over the previous period and `GY` for growth over the same period a year earlier. Request one of them rather than deriving growth from levels. An example is quarterly real GDP growth for the G7 since 2015: flow `DF_QNA_EXPENDITURE_GROWTH_OECD`, key `Q..CAN+FRA+DEU+ITA+JPN+GBR+USA...B1GQ......G1.`, and `start_period` `2015`.

**Comparing countries.** Put every country in one key and pin the measure, unit, price base, adjustment, and any breakdowns (sex, age). A row exists only for an observation OECD returned, so check that each country has the same number of rows before you compare. A country whose latest period isn't published yet has fewer rows.

**Finding the flow that holds X.** Search with OECD's terms, then compare names. When two flows share a `dsd_id`, probe the one whose name matches the country set you need, and read its area list: a flow named for OECD countries can also carry partner economies and the G20.

**Large pulls and SQL.** Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `oecd_dataframe_describe` with it for the staged table and column names before writing SQL, then `oecd_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first. Only a result that spills is staged: one that fits inline comes back inline, and the canvas is unchanged. The tables expire with the canvas. The table holds every column, including the `_code` columns, the components that `constant_columns` hoisted out of `rows`, and `source`, so SQL can filter on codes. Every column is VARCHAR except `value` and `value_scale`, which are DOUBLE. Tables from different flows on one canvas join on columns such as `REF_AREA_code`. `canvas_not_found` means the id was mistyped or the canvas expired, taking its tables with it; `oecd_query_dataset` checks the id before downloading, so that failure spends no download. Re-run without the stale `canvas_id`: a result that spills returns a fresh one, and each table you need beside it is re-staged by re-running its query with the new id.
