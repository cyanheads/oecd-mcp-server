<div align="center">
  <h1>@cyanheads/oecd-mcp-server</h1>
  <p><b>Search, explore, and query 1,500+ OECD statistical datasets (national accounts, employment, trade, education, health) via SDMX via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/oecd-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/oecd-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/oecd-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/oecd-mcp-server/releases/latest/download/oecd-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=oecd-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb2VjZC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22oecd-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Foecd-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Five discovery and data tools plus two SQL analytics tools for large query results:

| Tool | Description |
|:-----|:------------|
| `oecd_list_agencies` | List OECD SDMX agencies with their directorate and the number of dataflows each publishes |
| `oecd_search_datasets` | Search 1,500+ OECD dataflows by keyword or theme |
| `oecd_get_dataset_info` | Fetch a dataflow's dimensions, key order, and codelist references |
| `oecd_get_dimension_values` | Fetch valid codes and labels for one dimension (countries, measures, frequencies) |
| `oecd_query_dataset` | Fetch observations filtered by dimension key and time range; spills large results to DataCanvas |
| `oecd_dataframe_describe` | List DataCanvas tables and columns staged by a prior `oecd_query_dataset` spill |
| `oecd_dataframe_query` | Run a read-only SQL SELECT against DataCanvas tables |

### `oecd_list_agencies`

Entry point for discovery — enumerate OECD's statistical departments before searching.

- Returns agency IDs (e.g. `OECD.SDD.NAD`, `OECD.ELS.SPD`, `OECD.EDU.IMEP`) and dataflow counts
- Each agency carries the name of its directorate — `OECD.CTP.TPS` is the Centre for Tax Policy and Administration, `OECD.SDD.NAD` the Statistics and Data Directorate — so a department can be picked without decoding the identifier
- Publishers outside OECD that ship dataflows through the same catalog (`ESTAT`, `IAEG-SDGs`) carry no directorate
- Useful for scoping `oecd_search_datasets` by department (national accounts, labour, education, etc.)

---

### `oecd_search_datasets`

Search the full catalog of 1,500+ OECD dataflows by keyword or department.

- Token-matching across dataflow names and descriptions — reaches datasets whose name never carries the term, so `inflation` returns `Economic Outlook 119` and `poverty` returns `Income inequality - Regions`
- Each result reports `matched_in` (`name`, `description`, or `both`) and a plain-text description trimmed to 240 characters
- Optional `agency_id` filter scopes results to a specific statistical department
- `limit` (1–100) and `offset` page through the match list; `total_matches` reports the full count
- Returns `flow_ref` values (e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`) — pass directly to `oecd_get_dataset_info` or `oecd_query_dataset`. A handful of dataflows are catalogued without a datastructure prefix and come back in the bare `{agencyID},{df_id}` form (`OECD.TAD.ARP,DF_AEI2024_DASHBOARD`); both forms are accepted everywhere a `flow_ref` is
- Fetches and filters in-memory; the full catalog is ~5.9 MB and bounded (OECD adds datasets weekly, not continuously)

---

### `oecd_get_dataset_info`

Inspect a dataflow's structure before querying.

- Returns all dimensions in key order (position 1, 2, 3 …) — dimension order is required to construct the dot-delimited key for `oecd_query_dataset`
- Each dimension carries its concept name from the datastructure's concept scheme, so `INSTR_ASSET` reads as "Financial instruments and non-financial assets" rather than repeating the id. A dimension the scheme does not cover keeps the id
- Shows codelist references for each dimension — pass to `oecd_get_dimension_values` to resolve human-readable names to SDMX codes
- Surfaces `NonProductionDataflow` flag — marks experimental or deprecated dataflows
- Resolves a `flow_ref` whose id prefix names no datastructure of its own by asking the dataflow for its structure — `OECD.CFE.EDS,DSD_REG_LAB@DF_RATES` is backed by `DSD_REG_LABOUR`, and answers here rather than reporting the dataflow as missing
- Required before calling `oecd_query_dataset` on an unfamiliar dataflow

---

### `oecd_get_dimension_values`

Resolve human-readable names (countries, measures) to SDMX codes.

- Returns code + label pairs for a single dimension (e.g. `REF_AREA` → `USA`/`United States`, `DEU`/`Germany`)
- `query` matches a case-insensitive substring against both the code and its label, so `PA` and `percent` each reach `PA` / `Percent per annum`
- `limit` (1–500, default 50) and `offset` page the matching list. Both client surfaces carry the same page, so a 1,164-code dimension like `UNIT_MEASURE` no longer ships 66 KB of pairs to `structuredContent` to find one code
- When matches remain beyond the page, the response reports the full match count and how to reach the rest

---

### `oecd_query_dataset`

Fetch observations from an OECD dataflow filtered by dimension key and time range.

- Accepts a dot-delimited key (e.g. `A.USA+DEU.B1GQ_R.PC.`) where empty segments are wildcards and `+` separates multiple values
- Optional `start_period` / `end_period` bound the time range (ISO format: `2010`, `2010-Q1`)
- Decodes SDMX-JSON index notation (`0:0:2:3:0`) into human-readable row objects with dimension labels
- Observation attributes (`UNIT_MULT`, `OBS_STATUS`, `PRICE_BASE`, `DECIMALS`, …) each become their own column, so an estimated or break-flagged point is distinguishable from a confirmed one
- `value` arrives already multiplied by the observation's `UNIT_MULT` — a GDP figure OECD publishes as `26054.614` billions comes back as `26054614000000`. Every row carries `value_scale`, the power of ten applied; divide by it for the figure as OECD published it
- Every response row includes `source: "OECD"` per OECD terms of use
- **Small results** (few countries, narrow time range): every observation is returned inline, in `structuredContent` and in the rendered table alike — no `canvas_id`, and `truncated` is omitted rather than set to `false`
- **Large results** (multi-country, multi-year time-series) with `CANVAS_PROVIDER_TYPE=duckdb`: a leading preview slice plus `canvas_id` + `truncated: true` — use `oecd_dataframe_describe` to list tables, then `oecd_dataframe_query` for SQL analytics
- **Large results** without DataCanvas: there is nowhere to stage the remainder, so every observation still comes back in `structuredContent`, while the rendered table stops at the same preview budget a canvas would have used — the response reports `content_table_capped` and the number of rows it showed. Narrow the key or the `start_period` / `end_period` range to shrink the result itself

---

### `oecd_dataframe_describe` / `oecd_dataframe_query`

SQL analytics over observation data staged by `oecd_query_dataset`.

When `oecd_query_dataset` returns `truncated: true`, the full result is staged on a DuckDB-backed DataCanvas. Pass the `canvas_id` to:

- **`oecd_dataframe_describe`** — list staged table names and their columns. Run this first to discover the schema before writing SQL.
- **`oecd_dataframe_query`** — run a single-statement SQL SELECT. Supports aggregates, window functions, GROUP BY, ORDER BY, and standard DuckDB SQL.

Requires `CANVAS_PROVIDER_TYPE=duckdb`. Read-only: writes, DDL, and system catalog access are rejected.

**Typical workflow for a large query:**

```text
oecd_query_dataset → { canvas_id, table_name, truncated: true, rows: [preview...] }
  → oecd_dataframe_describe(canvas_id) → table/column names
  → oecd_dataframe_query(canvas_id, "SELECT REF_AREA, AVG(value) FROM spilled_... GROUP BY REF_AREA")
```

## Resources

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `oecd://dataflow/{agency_id}/{flow_id}` | Dimension metadata for a single OECD dataflow — same content as `oecd_get_dataset_info` |

`{flow_id}` is the combined `{dsd_id}@{df_id}` string with `@` percent-encoded as `%40`, or the bare `{df_id}` for a dataflow catalogued without a datastructure prefix. Example: `oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I`.

All resource data is also reachable via tools. Use `oecd_get_dataset_info` for the same content.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

OECD-specific:

- Keyless access — no API key required; OECD SDMX 2.1 REST API is fully public
- Covers 1,500+ dataflows across 20+ OECD statistical departments (national accounts, employment, inflation, trade, education, health, environment, taxation, inequality)
- Delegated dataflows resolved end to end — the entries OECD catalogues on one service root but defines on another (Trade in Value Added, the DAC creditor-reporting aid series) follow the catalog's own link for structure, codes, and observations, with the target checked against the configured origin before any request goes out
- Codes read at the revision the dataflow references — a codelist moves on independently of the datastructures using it, so a dimension's values come from the version its structure names rather than the endpoint's current latest, and never include a code the dimension rejects
- `AllDimensions` observation mode — one-pass SDMX-JSON decoding into flat row objects; no nested series key reconstruction
- `oecd_query_dataset` materializes large observation sets (multi-country time-series) on a DuckDB DataCanvas for in-conversation SQL analytics
- OECD source attribution (`source: "OECD"`) on every observation row per OECD terms of use

Agent-friendly output:

- Workflow-aware tool surface — `flow_ref` from search flows directly into info, values, and query tools without reconstruction
- Spill signaling — `truncated: true` + `canvas_id` tells the agent to switch to SQL instead of parsing a truncated inline list
- Full SDMX decoding server-side — agents see `{ REF_AREA: "United States", MEASURE: "Gross domestic product", UNIT_MULT: "Billions", value: 26054614000000, value_scale: 1000000000 }`, not raw index arrays

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "oecd-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/oecd-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "oecd-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/oecd-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "oecd-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/oecd-mcp-server:latest"
      ]
    }
  }
}
```

To enable DataCanvas SQL analytics for large query results, add `CANVAS_PROVIDER_TYPE=duckdb`:

```json
{
  "mcpServers": {
    "oecd-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/oecd-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "CANVAS_PROVIDER_TYPE": "duckdb"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.14](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — OECD SDMX is a free, public API.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/oecd-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd oecd-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env — most vars are optional; no API key required
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OECD_BASE_URL` | OECD SDMX REST API base URL. Must be an https origin that answers directly — no redirect is followed, so a plaintext `http://` origin fails instead of being upgraded to https. | `https://sdmx.oecd.org/public/rest` |
| `OECD_TIMEOUT_MS` | Per-request timeout in milliseconds. | `30000` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. Set to `duckdb` so a large `oecd_query_dataset` result spills to a queryable table instead of just capping the rendered preview — unset, every row still comes back in `structuredContent`, only the rendered table is capped. | `none` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t oecd-mcp-server .
docker run --rm -p 3010:3010 oecd-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/oecd-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and initializes services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — seven tools for OECD data discovery and retrieval. |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`) — the `oecd://dataflow` resource. |
| `src/services/oecd-http/` | Shared OECD fetch boundary — timeout and retry-classification corrections used by both services below, the origin check every delegated service root passes before it is addressed, the refusal of any redirect off the configured host, and the classification that gives an upstream refusal the same declared reason on every tool and resource. |
| `src/services/oecd-structure/` | OECD SDMX structure service — dataflows, data structures, codelists. |
| `src/services/oecd-data/` | OECD SDMX data service — observations, SDMX-JSON decoding, DataCanvas spillover. |
| `src/services/canvas-accessor/` | DataCanvas accessor — registers and exposes the framework canvas instance to tools. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/index.ts`
- Wrap external API calls: validate raw SDMX-JSON → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
