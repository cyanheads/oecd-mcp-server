<div align="center">
  <h1>@cyanheads/oecd-mcp-server</h1>
  <p><b>Search, explore, and query 1,500+ OECD statistical datasets (national accounts, employment, trade, education, health) from the OECD SDMX API via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/oecd-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/oecd-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/oecd-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/oecd-mcp-server/releases/latest/download/oecd-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=oecd-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb2VjZC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22oecd-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Foecd-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://oecd.caseyjhand.com/mcp](https://oecd.caseyjhand.com/mcp)

</div>

---

## Overview

OECD statistics across 1,500+ datasets on national accounts, employment, trade, education, and health. Search datasets, inspect their dimensions, query observations, and run SQL over large multi-country time series. No API key required.

### Tools

Five discovery and data tools plus three DataCanvas tools for large query results:

| Tool | Description |
|:-----|:------------|
| `oecd_list_agencies` | List OECD SDMX agencies with their directorate and the number of dataflows each publishes |
| `oecd_search_datasets` | Search 1,500+ OECD dataflows by keyword or theme, or list an agency's or the catalog's dataflows |
| `oecd_get_dataset_info` | Fetch a dataflow's name, full description, linked resources, dimensions, key order, and codelist references |
| `oecd_get_dimension_values` | Fetch valid codes, labels, and hierarchy parents for one dimension (countries, measures, regions) |
| `oecd_query_dataset` | Fetch observations filtered by dimension key, time range, or latest N per series; spills large results to DataCanvas |
| `oecd_dataframe_describe` | List DataCanvas tables and columns staged by a prior `oecd_query_dataset` spill |
| `oecd_dataframe_query` | Run a read-only SQL SELECT against DataCanvas tables |
| `oecd_dataframe_drop` | Drop a staged DataCanvas table or view once the analysis is done — opt-in via `OECD_DATAFRAME_DROP_ENABLED=true` |

### Resources

| Resource | Description |
|:---------|:------------|
| `oecd://dataflow/{agency_id}/{flow_id}` | Dimension metadata for a single OECD dataflow — same content as `oecd_get_dataset_info` |

All resource data is also reachable via tools. Use `oecd_get_dataset_info` for the same content.

### Skill

| Skill | Description |
|:------|:------------|
| [`oecd-guide`](./skills/oecd-guide/SKILL.md) | Building SDMX keys, confirming which series a dataflow carries, and reading results without mixing breakdowns, units, or country aggregates. Served over MCP at `skill://oecd-guide/SKILL.md` |

## Capability reference

### `oecd_list_agencies` <sub>tool</sub>

- No inputs; returns every agency ID (e.g. `OECD.SDD.NAD`) with its directorate name and dataflow count, sorted by count
- Publishers outside OECD that ship dataflows through the same catalog (`ESTAT`, `IAEG-SDGs`) carry no directorate

---

### `oecd_search_datasets` <sub>tool</sub>

- Optional `query` and optional `agency_id`. Omit `query` (or leave it blank) to list every dataflow in catalog order — within `agency_id` when set (e.g. `{ "agency_id": "OECD.ELS.HD" }`)
- When `query` is set, each token must start a word in a dataflow's name or description: matching is a case-insensitive prefix, and a word starts after any character that is not a letter or digit, or at a lowercase-to-uppercase step (`markers` matches `RioMarkers`). A token that opens on such a character, like `&` or `-oecd`, matches anywhere it occurs, so `&` finds `R&D`. `tiva` finds `(TiVA)` but not `activation`, and `employment` does not reach a flow that only mentions unemployment
- Search results rank in three tiers: name matches first, then tokens split across name and description, then description-only, in catalog order within each tier
- `limit` defaults to 20 and takes any value up to 2,000; a larger one is served at 2,000 with a `notice`. `offset` pages the result list, and every response carries `total_matches`
- Each result carries its `flow_ref` — the identifier every other tool takes — plus `matched_in` (`name`, `description`, or `both`) when a query ran (omitted when listing without a query)

---

### `oecd_get_dataset_info` <sub>tool</sub>

- Takes a `flow_ref`; returns the dataflow's `name`, full `description` (with methodology links preserved as Markdown), `EXT_RESOURCE` `resources` (`{ label, url }[]`), every dimension in key order with its concept name and codelist reference, plus a `key_example` for `oecd_query_dataset` — with no extra upstream request
- Fails `invalid_flow_ref` for a string that is not a flow reference and `dataflow_not_found` for one OECD does not publish

---

### `oecd_get_dimension_values` <sub>tool</sub>

- Takes a `flow_ref` and `dimension_id`; returns `codes` (`{ id, name, parent? }`) where hierarchical codelists carry each code's `parent` ID (rendered as a `Parent` column when any code on the page has one)
- Optional `parent` filters to codes whose `parent` equals that code (exact match, e.g. `parent: "FRA"` for France's TL2 regions), applied after `available_only` / `key` and before substring `query`, `offset`, and `limit`
- A codelist is shared across dataflows and can list codes a flow holds no data for. `available_only` lists only the codes with data, from OECD's availability record; `key` (the `oecd_query_dataset` form) lists the codes with data given the key's other segments, and implies `available_only`. Either adds `time_range`, `observation_count`, and `available_only: true` to the result. An availability read that fails falls back to the whole codelist with `available_only: false` and a `notice` naming the failure. Extra trailing empty segments in `key` are trimmed to the dimension count; a key holding a character outside the SDMX key set, fewer segments than dimensions, or any non-empty segment past the dimension count fails `invalid_key`
- Availability costs one structure request, sent alongside the codelist read, and no data download. A delegated dataflow's availability is read on the root its data lives on, the one its catalog entry points to. A cold call sends 3 requests without the flag (dataflow reference, concept scheme, codelist) and 4 with it, or 5 for a delegated dataflow whose datastructure `/public/rest` also holds, which adds the datastructure route; a repeat call is served from the structure cache with no request
- `limit` (default 50) and `offset` page the matches, with the full match count when more remain; a `limit` above 10,000 is served at 10,000 with a `notice`

---

### `oecd_query_dataset` <sub>tool</sub>

- `flow_ref` plus a dot-delimited `key` (`+` for multiple values, empty segments as wildcards), optional `start_period` / `end_period`, and optional `last_n_observations` (`1..100,000`) for the latest N observations per series (`lastNObservations`, evaluated by OECD before `start_period` / `end_period`)
- Key length is checked against the dataflow's cached dimension count before calling `/data`: extra trailing empty segments are trimmed, and too few segments or any extra non-empty segment fail `invalid_key`; a `start_period` after `end_period` fails `invalid_period` before any upstream request
- One row per observation, sorted by dimension code in key order and then by `TIME_PERIOD`. A row carries `value` (pre-multiplied by `value_scale`) and each component that varies across the result; a coded component appears twice, as its label and as `<ID>_code`
- Components holding one value across the whole result come back once, in `constant_columns` (`{ code, label }` per component; `{}` when nothing is constant), and leave the rows. Attributes are read at dataset, dimension-group, and observation level, and `UNIT_MULT` scales the value from whichever level carries it
- A query that matches nothing fails `no_results`, naming the pinned code that has no data, a code matching only by letter case, or a period outside the key's range. Producing that costs one structure request once the dataflow's structure is cached and no data download; if the read fails or takes longer than 10 seconds, the plain message stands
- Large results (>100,000 characters inline) spill to DataCanvas with `truncated: true`, `canvas_id`, `table_name`, and a short preview head of at most 25 rows; with DataCanvas off (`CANVAS_PROVIDER_TYPE=none`), every observation comes back in both `structuredContent.rows` and `content[]`
- A spill includes a `notice` naming the canvas and table: inspect columns with `oecd_dataframe_describe`, then use `oecd_dataframe_query` for SQL over the full result. The staged table holds every column, constants and `_code` columns included, so SQL can filter on codes. Fitting results allocate no new canvas; an explicit `canvas_id` is checked before the download, so a stale one fails as `canvas_not_found` without spending an OECD request.

---

### `oecd_dataframe_describe` <sub>tool</sub>

- Takes the `canvas_id` `oecd_query_dataset` returned; lists each staged table and view with its row count and column names and types

---

### `oecd_dataframe_query` <sub>tool</sub>

- `canvas_id` plus one read-only SQL `SELECT`; writes, DDL, and system-catalog access are rejected
- `limit` (default 100) returns up to 1,000 rows per call; a larger `limit` is served at 1,000 with a notice
- `truncated: true` marks a result with more rows than it returned, and its `notice` names how to reach the rest; `row_count` counts the rows returned
- A query still running after 30 seconds is stopped with `query_timeout`

---

### `oecd_dataframe_drop` <sub>tool</sub>

- `canvas_id` plus a `table_name` as `oecd_dataframe_describe` lists it; returns the dropped object's `kind` and the `remaining_tables`
- Opt-in: listed but not callable unless `OECD_DATAFRAME_DROP_ENABLED=true`

---

### `oecd://dataflow/{agency_id}/{flow_id}` <sub>resource</sub>

- Same content as `oecd_get_dataset_info`, as `application/json`
- `{flow_id}` is `{dsd_id}@{df_id}` with `@` encoded as `%40` (e.g. `oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I`), or the bare `{df_id}`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OECD-specific:

- Keyless access — no API key required; OECD SDMX 2.1 REST API is fully public
- Covers 1,500+ dataflows across 20+ OECD statistical departments (national accounts, employment, inflation, trade, education, health, environment, taxation, inequality)
- Delegated dataflows and codelist revisions resolved end to end — a dataflow OECD catalogues on one service root but defines on another follows the catalog's own link for structure, codes, and observations, and codes come from the revision the datastructure names rather than the endpoint's current latest
- Structure responses (the dataflow catalog, datastructures, codelists, concept schemes, availability) are cached in process for the lifetime OECD grants each, bounded at 64 MiB, so repeating a lookup inside that window sends no OECD request. The bound and lifetime are not configurable; observations are never cached
- `AllDimensions` observation mode — one-pass SDMX-JSON decoding into flat row objects, no nested series key reconstruction
- `oecd_query_dataset` materializes large observation sets (multi-country time-series) on a DuckDB DataCanvas for in-conversation SQL analytics; the `oecd_dataframe_*` tools work on it; DataCanvas is on by default and `CANVAS_PROVIDER_TYPE=none` disables it

Agent-friendly output:

- Workflow-aware tool surface — `flow_ref` from search flows directly into info, values, and query tools without reconstruction
- Spill signaling — `truncated: true` + `canvas_id` tells the agent to switch to SQL instead of parsing a truncated inline list
- Full SDMX decoding server-side — agents see `{ REF_AREA: "United States", REF_AREA_code: "USA", MEASURE: "Gross domestic product", MEASURE_code: "B1GQ", value: 26054614000000, value_scale: 1000000000 }`, with components that never vary hoisted into `constant_columns`, not raw index arrays

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http oecd-mcp-server https://oecd.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add oecd-mcp-server -- npx -y @cyanheads/oecd-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "oecd-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/oecd-mcp-server"]
    }
  }
}
```

No API key is needed — OECD SDMX is a free, public API. DataCanvas SQL analytics over large query results is on by default; set `CANVAS_PROVIDER_TYPE=none` to return every observation inline instead. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OECD_BASE_URL` | OECD SDMX REST API base URL. Must be an https origin that answers directly — no redirect is followed, so a plaintext `http://` origin fails instead of being upgraded to https. | `https://sdmx.oecd.org/public/rest` |
| `OECD_TIMEOUT_MS` | Per-request timeout in milliseconds. Each tool or resource call also spends one upstream budget of max(50 s, this value) across all its requests and retries, so a value past 50 s needs a client that waits that long for a result. | `30000` |
| `OECD_CLAMP_LIMITS` | Serve a `limit` above a tool's per-call cap (`oecd_search_datasets` 2,000, `oecd_get_dimension_values` 10,000, `oecd_dataframe_query` 1,000) at the cap, with a `notice`. `false` rejects it instead and advertises the cap as the schema `maximum`. | `true` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. With `duckdb`, a large `oecd_query_dataset` result spills to a queryable table with a short preview head (≤25 rows); with `none`, every row comes back inline in both `structuredContent` and `content[]`. | `duckdb` |
| `OECD_DATAFRAME_DROP_ENABLED` | Set to `true` to register `oecd_dataframe_drop`. Off, the tool is listed as disabled and clients cannot call it. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session posture: `stateful`, `stateless`, or `auto`. The server declares `stateless` in source — it keeps no per-session state, and a DataCanvas handle is keyed by `canvas_id` — so set this only to override that. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/oecd-mcp-server.git
  cd oecd-mcp-server && bun install
  cp .env.example .env   # optional — every variable has a default
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/oecd-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/oecd-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/oecd-mcp-server:latest"]`. To build locally, `docker build -t oecd-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and initializes services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — eight tools for OECD data discovery, retrieval, and DataCanvas analysis. |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`) — the `oecd://dataflow` resource. |
| `src/services/oecd-http/` | Shared OECD fetch boundary — timeout and retry-classification corrections used by both services below, the response-body reader both share, the per-call upstream budget, the origin check every delegated service root passes before it is addressed, the refusal of any redirect off the configured host, and the classification that gives an upstream refusal the same declared reason on every tool and resource. |
| `src/services/oecd-structure/` | OECD SDMX structure service — dataflows, data structures, codelists, availability — and the in-process cache in front of its reads. |
| `src/services/oecd-data/` | OECD SDMX data service — observations and SDMX-JSON decoding. |
| `src/services/canvas-accessor/` | DataCanvas accessor — registers and exposes the framework canvas instance to tools. |
| `src/utils/` | Shared helpers — table formatting, `limit` clamping, word-start text matching. |
| `skills/` | Published agent skill (`oecd-guide`), served over MCP and shipped in the npm package and Docker image. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/index.ts`
- Wrap external API calls: validate raw SDMX-JSON → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome — see [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for what makes one actionable, and [CODE_OF_CONDUCT.md](./.github/CODE_OF_CONDUCT.md) for how we work together. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
