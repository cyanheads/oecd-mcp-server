/**
 * @fileoverview Barrel export for all OECD MCP resource definitions.
 * @module mcp-server/resources
 */

export { oecdDataflowResource } from './definitions/dataflow.resource.js';

import { oecdDataflowResource } from './definitions/dataflow.resource.js';

export const allResourceDefinitions = [oecdDataflowResource];
