/**
 * @fileoverview OECD dataflow edition identifiers on tool inputs and SDMX responses.
 * @module services/oecd-structure/dataflow-version
 */

import { z } from '@cyanheads/mcp-ts-core';

const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;
const DATAFLOW_URN =
  /^urn:sdmx:org\.sdmx\.infomodel\.datastructure\.Dataflow=([^:]+):([^(]+)\((\d+(?:\.\d+)*)\)$/;

/** An optional edition selector. Omitting it asks OECD for the latest edition. */
export const dataflowVersionInput = z
  .string()
  .regex(VERSION_PATTERN, 'Use a dot-separated numeric SDMX version such as 1.1.')
  .optional()
  .describe('Published dataflow edition, for example 1.1. Omit to use the latest edition.');

/** Retain only versions the server can address as an exact path or key component. */
export function sdmxVersion(value: unknown): string | undefined {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : undefined;
}

/** Read the edition from a Dataflow URN for this flow, ignoring unrelated artefacts. */
export function versionFromDataflowUrn(urn: unknown, flowRef: string): string | undefined {
  if (typeof urn !== 'string') return;
  const match = DATAFLOW_URN.exec(urn);
  if (match && `${match[1]},${match[2]}` === flowRef) return match[3];
  return;
}
