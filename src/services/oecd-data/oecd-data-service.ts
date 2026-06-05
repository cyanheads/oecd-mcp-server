/**
 * @fileoverview OECD SDMX data service — wraps the observations endpoint and decodes SDMX-JSON v2.
 * @module services/oecd-data/oecd-data-service
 */

import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { parseFlowRef } from '@/services/oecd-structure/oecd-structure-service.js';
import type { DecodedRow, OecdDataResult } from './types.js';

const DATA_ACCEPT = 'application/vnd.sdmx.data+json;version=2.0';
// OECD's HTTP/2 endpoint requires Accept-Language to avoid HTTP 500 responses
// when a structured Accept header is sent. Node.js fetch defaults to HTTP/2 and
// omits Accept-Language; adding it explicitly fixes the server-side routing bug.
const ACCEPT_LANGUAGE = 'en';

async function fetchDataRaw(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const config = getServerConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const combinedSignal = signal
    ? (() => {
        const ac = new AbortController();
        signal.addEventListener('abort', () => ac.abort());
        controller.signal.addEventListener('abort', () => ac.abort());
        return ac.signal;
      })()
    : controller.signal;

  try {
    const res = await fetch(url, {
      headers: { Accept: DATA_ACCEPT, 'Accept-Language': ACCEPT_LANGUAGE },
      signal: combinedSignal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

let _instance: OecdDataService | undefined;

/** Service for fetching and decoding OECD SDMX observation data. */
export class OecdDataService {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Fetch observations for a dataflow, decoding SDMX-JSON with AllDimensions mode.
   *
   * @param flowRef - e.g. `OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I`
   * @param key - dot-delimited dimension key, e.g. `A.USA.B1GQ..`
   * @param startPeriod - ISO date string or period code, e.g. `2010`
   * @param endPeriod - ISO date string or period code, e.g. `2023`
   * @param signal - optional AbortSignal
   */
  async fetchData(
    flowRef: string,
    key: string,
    startPeriod?: string,
    endPeriod?: string,
    signal?: AbortSignal,
  ): Promise<OecdDataResult> {
    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw new Error(`Invalid flow_ref format: ${flowRef}`);
    }

    // URL-encode `@` in the combined flowId
    const encodedFlowId = `${parts.dsdId}%40${parts.dfId}`;
    let url = `${this.baseUrl}/data/${parts.agencyId},${encodedFlowId}/${key}?dimensionAtObservation=AllDimensions`;
    if (startPeriod) url += `&startPeriod=${encodeURIComponent(startPeriod)}`;
    if (endPeriod) url += `&endPeriod=${encodeURIComponent(endPeriod)}`;

    const retryOpts = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const { status, body } = await withRetry(() => fetchDataRaw(url, signal), retryOpts).catch(
      (err: unknown) => {
        throw serviceUnavailable(
          `Failed to fetch OECD data for ${flowRef}`,
          { url },
          { cause: err },
        );
      },
    );

    // Handle known OECD error shapes (plain text bodies)
    if (status === 404) {
      if (body.includes('NoResultsFound') || body.includes('no result')) {
        return { rows: [], rowCount: 0, source: 'OECD' };
      }
      throw notFound(`Dataflow not found: ${flowRef}`, { flowRef, status });
    }
    if (status === 400) {
      throw new Error(`Invalid key or query parameter: ${body.slice(0, 200)}`);
    }
    if (status >= 500) {
      throw serviceUnavailable(`OECD data API returned HTTP ${status}`, { url, status });
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw serviceUnavailable('OECD data API returned non-JSON response', {
        url,
        preview: body.slice(0, 200),
      });
    }

    return decodeObservations(parsed);
  }
}

export function initDataService(): void {
  const config = getServerConfig();
  _instance = new OecdDataService(config.baseUrl);
}

export function getDataService(): OecdDataService {
  if (!_instance) throw new Error('OecdDataService not initialized');
  return _instance;
}

// ── SDMX-JSON v2 AllDimensions decoder ───────────────────────────────────────

function decodeObservations(data: unknown): OecdDataResult {
  const root = data as Record<string, unknown>;
  const dataRoot = root?.data as Record<string, unknown> | undefined;
  const dataSets = (dataRoot?.dataSets ?? []) as Array<Record<string, unknown>>;
  const structures = (dataRoot?.structures ?? []) as Array<Record<string, unknown>>;

  if (!dataSets.length || !structures.length) {
    return { rows: [], rowCount: 0, source: 'OECD' };
  }

  // Safe: length checks above guarantee both arrays have at least one element
  const dataSet = dataSets[0] as Record<string, unknown>;
  const structure = structures[0] as Record<string, unknown>;

  // AllDimensions: all dimensions are at observation level
  const dimsMeta = structure?.dimensions as Record<string, unknown> | undefined;
  const obsDims = (dimsMeta?.observation ?? []) as Array<Record<string, unknown>>;

  // Build dimension value lookup: dimIndex → { valueIndex → { id, name } }
  const dimValueMaps = obsDims.map((dim) => {
    const values = (dim.values ?? []) as Array<Record<string, unknown>>;
    return {
      id: String(dim.id ?? ''),
      values: values.map((v) => ({
        id: String(v.id ?? ''),
        name: String(v.name ?? v.id ?? ''),
      })),
    };
  });

  // Observations: key is colon-delimited index tuple e.g. "0:0:2:3:0:0"
  const observations = (dataSet.observations ?? {}) as Record<string, Array<unknown>>;

  const rows: DecodedRow[] = [];

  for (const [key, obsValues] of Object.entries(observations)) {
    const indices = key.split(':').map(Number);
    const row: DecodedRow = { value: null, source: 'OECD' };

    const numVal = (obsValues as Array<unknown>)[0];
    row.value = typeof numVal === 'number' ? numVal : null;

    for (let i = 0; i < indices.length; i++) {
      const dimMeta = dimValueMaps[i];
      if (!dimMeta) continue;
      const idx = indices[i];
      if (idx === undefined) continue;
      const valueEntry = dimMeta.values[idx];
      if (!valueEntry) continue;
      // Use the name (human-readable label)
      row[dimMeta.id] = valueEntry.name;
    }

    rows.push(row);
  }

  return { rows, rowCount: rows.length, source: 'OECD' };
}
