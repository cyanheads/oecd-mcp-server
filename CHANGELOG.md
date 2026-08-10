# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-08-10 · 🛡️ Security

OECD fetch boundary refuses redirects instead of following them; five tools now report the refusal as a misconfiguration, not a retryable outage

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-08-09

Delegated dataflows resolve end to end; codelists and concept schemes read at the root and version the datastructure references

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-08-09 · ⚠️ Breaking · 🛡️ Security

Dataflow reference resolution, concept-name and directorate metadata, paged codelists, dot-segment identifier fix

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-08-09

UNIT_MULT value scaling correction, full inline rendering, typed upstream-failure classification

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-08-09

oecd_search_datasets description matching + offset paging, agency-not-found and retry fixes, mcp-ts-core ^0.11.1

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption — total-count enrichment on search, system-catalog deny on SQL, error-code contract migration, container healthcheck

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

DX fixes: search description cleanup, query echo, dimension notice, canvas_disabled contract

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 7 tools + 1 resource over the OECD SDMX API with DataCanvas SQL support and SDMX path-traversal hardening
