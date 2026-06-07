<div align="center">
  <h1>@cyanheads/oecd-mcp-server</h1>
  <p><b>Search, explore, and query 1,500+ OECD statistical datasets (national accounts, employment, trade, PISA, health) via SDMX via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/oecd-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/oecd-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/oecd-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `oecd_list_agencies` | List OECD SDMX agencies and the number of dataflows each publishes |
| `oecd_search_datasets` | Search 1,500+ OECD dataflows by keyword or theme |
| `oecd_get_dataset_info` | Fetch a dataflow's dimensions, key order, and codelist references |
| `oecd_get_dimension_values` | Fetch valid codes and labels for one dimension (countries, measures, frequencies) |
| `oecd_query_dataset` | Fetch observations filtered by dimension key and time range; spills large results to DataCanvas |
| `oecd_dataframe_describe` | List DataCanvas tables and columns staged by a prior `oecd_query_dataset` spill |
| `oecd_dataframe_query` | Run a read-only SQL SELECT against DataCanvas tables |

### `oecd_list_agencies`

Entry point for discovery — enumerate OECD's statistical departments before searching.

- Returns agency IDs (e.g. `OECD.SDD.NAD`, `OECD.ELS`, `OECD.EDU`) and dataflow counts
- Useful for scoping `oecd_search_datasets` by department (national accounts, labour, education, etc.)

---

### `oecd_search_datasets`

Search the full catalog of 1,500+ OECD dataflows by keyword or department.

- Token-matching across dataflow names — finds GDP, PISA, trade, inflation, and other datasets by description
- Optional `agency_id` filter scopes results to a specific statistical department
- Returns `flow_ref` values (e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`) — pass directly to `oecd_get_dataset_info` or `oecd_query_dataset`
- Fetches and filters in-memory; the full catalog is ~800 KB and bounded (OECD adds datasets weekly, not continuously)

---

### `oecd_get_dataset_info`

Inspect a dataflow's structure before querying.

- Returns all dimensions in key order (position 1, 2, 3 …) — dimension order is required to construct the dot-delimited key for `oecd_query_dataset`
- Shows codelist references for each dimension — pass to `oecd_get_dimension_values` to resolve human-readable names to SDMX codes
- Surfaces `NonProductionDataflow` flag — marks experimental or deprecated dataflows
- Required before calling `oecd_query_dataset` on an unfamiliar dataflow

---

### `oecd_get_dimension_values`

Resolve human-readable names (countries, measures) to SDMX codes.

- Returns all valid code + label pairs for a single dimension (e.g. `REF_AREA` → `USA`/`United States`, `DEU`/`Germany`)
- The `REF_AREA` codelist has 570+ entries and is returned in full
- Use substring matching on the returned list to find the right code before building a key

---

### `oecd_query_dataset`

Fetch observations from an OECD dataflow filtered by dimension key and time range.

- Accepts a dot-delimited key (e.g. `A.USA+DEU.B1GQ_R.PC.`) where empty segments are wildcards and `+` separates multiple values
- Optional `start_period` / `end_period` bound the time range (ISO format: `2010`, `2010-Q1`)
- Decodes SDMX-JSON index notation (`0:0:2:3:0`) into human-readable row objects with dimension labels
- Every response row includes `source: "OECD"` per OECD terms of use
- **Small results** (few countries, narrow time range): all observations returned inline
- **Large results** (multi-country, multi-year time-series): returns a `canvas_id` + `truncated: true` — use `oecd_dataframe_describe` to list tables, then `oecd_dataframe_query` for SQL analytics

---

### `oecd_dataframe_describe` / `oecd_dataframe_query`

SQL analytics over observation data staged by `oecd_query_dataset`.

When `oecd_query_dataset` returns `truncated: true`, the full result is staged on a DuckDB-backed DataCanvas. Pass the `canvas_id` to:

- **`oecd_dataframe_describe`** — list staged table names and their columns. Run this first to discover the schema before writing SQL.
- **`oecd_dataframe_query`** — run a single-statement SQL SELECT. Supports aggregates, window functions, GROUP BY, ORDER BY, and standard DuckDB SQL.

Requires `CANVAS_PROVIDER_TYPE=duckdb`. Read-only: writes, DDL, and system catalog access are rejected.

**Typical workflow for a large query:**

```text
oecd_query_dataset → { canvas_id, truncated: true, rows: [preview...] }
  → oecd_dataframe_describe(canvas_id) → table/column names
  → oecd_dataframe_query(canvas_id, "SELECT ref_area, AVG(obs_value) FROM df_... GROUP BY ref_area")
```

## Resources

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `oecd://dataflow/{agency_id}/{flow_id}` | Dimension metadata for a single OECD dataflow — same content as `oecd_get_dataset_info` |

`{flow_id}` is the combined `{dsd_id}@{df_id}` string with `@` percent-encoded as `%40`. Example: `oecd://dataflow/OECD.SDD.NAD/DSD_NAAG%40DF_NAAG_I`.

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
- `AllDimensions` observation mode — one-pass SDMX-JSON decoding into flat row objects; no nested series key reconstruction
- `oecd_query_dataset` materializes large observation sets (multi-country time-series) on a DuckDB DataCanvas for in-conversation SQL analytics
- OECD source attribution (`source: "OECD"`) on every observation row per OECD terms of use

Agent-friendly output:

- Workflow-aware tool surface — `flow_ref` from search flows directly into info, values, and query tools without reconstruction
- Spill signaling — `truncated: true` + `canvas_id` tells the agent to switch to SQL instead of parsing a truncated inline list
- Full SDMX decoding server-side — agents see `{ ref_area: "United States", measure: "Gross domestic product", obs_value: 26054 }`, not raw index arrays

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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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
| `OECD_BASE_URL` | OECD SDMX REST API base URL. | `https://sdmx.oecd.org/public/rest` |
| `OECD_TIMEOUT_MS` | Per-request timeout in milliseconds. | `30000` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. Set to `duckdb` to enable DataCanvas for large `oecd_query_dataset` results. | `none` |
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
