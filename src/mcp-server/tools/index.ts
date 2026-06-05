/**
 * @fileoverview Barrel export for all OECD MCP tool definitions.
 * @module mcp-server/tools
 */

export { oecdDataframeDescribe } from './definitions/dataframe-describe.tool.js';
export { oecdDataframeQuery } from './definitions/dataframe-query.tool.js';
export { oecdGetDatasetInfo } from './definitions/get-dataset-info.tool.js';
export { oecdGetDimensionValues } from './definitions/get-dimension-values.tool.js';
export { oecdListAgencies } from './definitions/list-agencies.tool.js';
export { oecdQueryDataset } from './definitions/query-dataset.tool.js';
export { oecdSearchDatasets } from './definitions/search-datasets.tool.js';

import { oecdDataframeDescribe } from './definitions/dataframe-describe.tool.js';
import { oecdDataframeQuery } from './definitions/dataframe-query.tool.js';
import { oecdGetDatasetInfo } from './definitions/get-dataset-info.tool.js';
import { oecdGetDimensionValues } from './definitions/get-dimension-values.tool.js';
import { oecdListAgencies } from './definitions/list-agencies.tool.js';
import { oecdQueryDataset } from './definitions/query-dataset.tool.js';
import { oecdSearchDatasets } from './definitions/search-datasets.tool.js';

export const allToolDefinitions = [
  oecdListAgencies,
  oecdSearchDatasets,
  oecdGetDatasetInfo,
  oecdGetDimensionValues,
  oecdQueryDataset,
  oecdDataframeDescribe,
  oecdDataframeQuery,
];
