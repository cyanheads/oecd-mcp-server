#!/usr/bin/env node
/**
 * @fileoverview oecd-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allPromptDefinitions } from './mcp-server/prompts/index.js';
import { allResourceDefinitions } from './mcp-server/resources/index.js';
import { allToolDefinitions } from './mcp-server/tools/index.js';
import { setCanvas } from './services/canvas-accessor/canvas-accessor.js';
import { initDataService } from './services/oecd-data/oecd-data-service.js';
import { initStructureService } from './services/oecd-structure/oecd-structure-service.js';

await createApp({
  name: 'oecd-mcp-server',
  title: 'oecd-mcp-server',
  /**
   * No tool here calls `ctx.requestInput`, and a DataCanvas handle is keyed by
   * `canvas_id` rather than by session, so nothing needs a session store.
   * Declared in source so a deployment that never sets `MCP_SESSION_MODE` —
   * and the schema default `auto`, which resolves to stateful — cannot diverge
   * from what the Dockerfile and `.env.example` already set.
   */
  sessionMode: 'stateless',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'OECD Statistics MCP server — keyless access to 1,500+ OECD dataflows via SDMX 2.1.\n' +
    'Workflow: oecd_list_agencies → oecd_search_datasets → oecd_get_dataset_info ' +
    '→ oecd_get_dimension_values → oecd_query_dataset.\n' +
    'Large results (multi-country time-series) spill to DataCanvas; ' +
    'use oecd_dataframe_describe + oecd_dataframe_query for SQL analytics.\n' +
    (getServerConfig().dataframeDropEnabled
      ? 'oecd_dataframe_drop removes a staged table once the analysis no longer needs it.\n'
      : '') +
    'All data is attributed to OECD per their terms of use.',
  setup(core) {
    getServerConfig();
    setCanvas(core.canvas);
    initStructureService();
    initDataService();
  },
});
