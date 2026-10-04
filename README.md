<div align="center">
  <h1>@cyanheads/oecd-mcp-server</h1>
  <p><b>Search, explore, and query 1,500+ OECD statistical datasets (national accounts, employment, trade, education, health) from the OECD SDMX API via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/oecd-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/oecd-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/oecd-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

OECD statistical data via the SDMX 2.1 REST API — 1,500+ dataflows spanning national accounts, employment, trade, education, and health. Search datasets, inspect their dimensions, resolve codes, and query observations, with large multi-country time-series spilling to a queryable DataCanvas table for SQL analysis. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

Five discovery and data tools plus three DataCanvas tools for large query results:

| Tool | Description |
|:-----|:------------|
| `oecd_list_agencies` | List OECD SDMX agencies with their directorate and the number of dataflows each publishes |
| `oecd_search_datasets` | Search 1,500+ OECD dataflows by keyword or theme |
| `oecd_get_dataset_info` | Fetch a dataflow's dimensions, key order, and codelist references |
| `oecd_get_dimension_values` | Fetch valid codes and labels for one dimension (countries, measures, frequencies) |
| `oecd_query_dataset` | Fetch observations filtered by dimension key and time range; spills large results to DataCanvas |
| `oecd_dataframe_describe` | List DataCanvas tables and columns staged by a prior `oecd_query_dataset` spill |
| `oecd_dataframe_query` | Run a read-only SQL SELECT against DataCanvas tables |
| `oecd_dataframe_drop` | Drop a staged DataCanvas table or view once the analysis is done — opt-in via `OECD_DATAFRAME_DROP_ENABLED=true` |

### Resources

| Resource | Description |
|:---------|:------------|
| `oecd://dataflow/{agency_id}/{flow_id}` | Dimension metadata for a single OECD dataflow — same content as `oecd_get_dataset_info` |

All resource data is also reachable via tools. Use `oecd_get_dataset_info` for the same content.

## Capability reference

### `oecd_list_agencies` <sub>tool</sub>

- No inputs; returns every agency ID (e.g. `OECD.SDD.NAD`) with its directorate name and dataflow count, sorted by count
- Publishers outside OECD that ship dataflows through the same catalog (`ESTAT`, `IAEG-SDGs`) carry no directorate

---

### `oecd_search_datasets` <sub>tool</sub>

- `query` token-matched across dataflow names and descriptions; optional `agency_id` scope; `limit` (1–100) and `offset` paging with `total_matches`
- Each result carries its `flow_ref` — the identifier every other tool takes — and `matched_in` (`name`, `description`, or `both`)

---

### `oecd_get_dataset_info` <sub>tool</sub>

- Takes a `flow_ref`; returns every dimension in key order with its concept name and codelist reference, plus a `key_example` for `oecd_query_dataset`
- Fails `invalid_flow_ref` for a string that is not a flow reference and `dataflow_not_found` for one OECD does not publish

---

### `oecd_get_dimension_values` <sub>tool</sub>

- Takes a `flow_ref` and `dimension_id`; optional `query` substring-matches both code and label
- `limit` (1–500, default 50) and `offset` page the matches, with the full match count when more remain

---

### `oecd_query_dataset` <sub>tool</sub>

- `flow_ref` plus a dot-delimited `key` (`+` for multiple values, empty segments as wildcards) and optional `start_period` / `end_period`
- One row per observation with every dimension and attribute as its own column; `value` is pre-multiplied by `value_scale`
- Large results spill to DataCanvas with `truncated: true`, `canvas_id`, and `table_name`; without a canvas every row stays in `structuredContent` and only the rendered table is capped (`content_table_capped`)

---

### `oecd_dataframe_describe` <sub>tool</sub>

- Takes the `canvas_id` `oecd_query_dataset` returned; lists each staged table and view with its row count and column names and types

---

### `oecd_dataframe_query` <sub>tool</sub>

- `canvas_id` plus one read-only SQL `SELECT`; writes, DDL, and system-catalog access are rejected
- Returns rows capped at the canvas row limit, with `row_count` reporting the full count

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
- `AllDimensions` observation mode — one-pass SDMX-JSON decoding into flat row objects, no nested series key reconstruction
- `oecd_query_dataset` materializes large observation sets (multi-country time-series) on a DuckDB DataCanvas for in-conversation SQL analytics; the three `oecd_dataframe_*` tools work on it and need `CANVAS_PROVIDER_TYPE=duckdb`

Agent-friendly output:

- Workflow-aware tool surface — `flow_ref` from search flows directly into info, values, and query tools without reconstruction
- Spill signaling — `truncated: true` + `canvas_id` tells the agent to switch to SQL instead of parsing a truncated inline list
- Full SDMX decoding server-side — agents see `{ REF_AREA: "United States", MEASURE: "Gross domestic product", UNIT_MULT: "Billions", value: 26054614000000, value_scale: 1000000000 }`, not raw index arrays

## Getting started

### Public Hosted Instance

A public instance is available at `https://oecd.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "oecd-mcp-server": {
      "type": "streamable-http",
      "url": "https://oecd.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — eight tools for OECD data discovery, retrieval, and DataCanvas analysis. |
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

Issues are welcome — see [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for what makes one actionable, and [CODE_OF_CONDUCT.md](./.github/CODE_OF_CONDUCT.md) for how we work together. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
