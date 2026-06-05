/**
 * @fileoverview Server-specific environment configuration for oecd-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://sdmx.oecd.org/public/rest')
    .describe('OECD SDMX REST API base URL'),
  timeoutMs: z.coerce.number().default(30_000).describe('Per-request timeout in milliseconds'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns the lazily-parsed server configuration. Throws ConfigurationError on invalid env vars. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'OECD_BASE_URL',
    timeoutMs: 'OECD_TIMEOUT_MS',
  });
  return _config;
}
