#!/usr/bin/env node
/**
 * @fileoverview oecd-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allPromptDefinitions } from './mcp-server/prompts/index.js';
import { allResourceDefinitions } from './mcp-server/resources/index.js';
import { allToolDefinitions } from './mcp-server/tools/index.js';
import { setCanvas } from './services/canvas-accessor/canvas-accessor.js';
import { initDataService } from './services/oecd-data/oecd-data-service.js';
import { initStructureService } from './services/oecd-structure/oecd-structure-service.js';

await createApp({
  name: 'oecd-mcp-server',
  title: 'oecd-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'OECD Statistics MCP server — keyless access to 1,500+ OECD dataflows via SDMX 2.1.\n' +
    'Workflow: oecd_list_agencies → oecd_search_datasets → oecd_get_dataset_info ' +
    '→ oecd_get_dimension_values → oecd_query_dataset.\n' +
    'Large results (multi-country time-series) spill to DataCanvas; ' +
    'use oecd_dataframe_describe + oecd_dataframe_query for SQL analytics.\n' +
    'All data is attributed to OECD per their terms of use.',
  setup(core) {
    setCanvas(core.canvas);
    initStructureService();
    initDataService();
  },
});
