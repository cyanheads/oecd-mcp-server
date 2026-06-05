/**
 * @fileoverview OECD SDMX structure service — wraps dataflow, datastructure, and codelist endpoints.
 * @module services/oecd-structure/oecd-structure-service
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { OecdCode, OecdDataflow, OecdDataStructure } from './types.js';

const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';

/** Parse the `{agencyID},{dsd_id}@{df_id}` flow ref into its parts. */
export function parseFlowRef(flowRef: string): {
  agencyId: string;
  dsdId: string;
  dfId: string;
} | null {
  // Expected: OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I
  const commaIdx = flowRef.indexOf(',');
  if (commaIdx < 0) return null;
  const agencyId = flowRef.slice(0, commaIdx);
  const rest = flowRef.slice(commaIdx + 1); // DSD_NAAG@DF_NAAG_I
  const atIdx = rest.indexOf('@');
  if (atIdx < 0) return null;
  const dsdId = rest.slice(0, atIdx);
  const dfId = rest.slice(atIdx + 1);
  if (!agencyId || !dsdId || !dfId) return null;
  return { agencyId, dsdId, dfId };
}

/** Percent-encode `@` in flow ID for use in URL path segments. */
function encodeFlowId(dfId: string): string {
  return dfId.replace('@', '%40');
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
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
      headers: { Accept: STRUCTURE_ACCEPT },
      signal: combinedSignal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw serviceUnavailable(
        `OECD structure API returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        { url, status: res.status },
      );
    }
    return res.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

let _instance: OecdStructureService | undefined;

/** Service for fetching OECD SDMX structural metadata. */
export class OecdStructureService {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Fetch all dataflows, optionally filtered by agency.
   * Uses `GET /dataflow/{agencyID}` or `GET /dataflow` for all agencies.
   */
  async fetchDataflows(agencyId?: string, signal?: AbortSignal): Promise<OecdDataflow[]> {
    const url = agencyId ? `${this.baseUrl}/dataflow/${agencyId}` : `${this.baseUrl}/dataflow`;

    const retryOpts = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const data = await withRetry(() => fetchJson(url, signal), retryOpts).catch((err: unknown) => {
      throw serviceUnavailable(
        `Failed to fetch OECD dataflows${agencyId ? ` for agency ${agencyId}` : ''}`,
        { url },
        { cause: err },
      );
    });

    return parseDataflows(data);
  }

  /**
   * Fetch the datastructure for a flow ref.
   * Uses `GET /datastructure/{agencyID}/{dsdID}`.
   */
  async fetchDataStructure(flowRef: string, signal?: AbortSignal): Promise<OecdDataStructure> {
    const parts = parseFlowRef(flowRef);
    if (!parts) {
      throw new Error(`Invalid flow_ref format: ${flowRef}`);
    }
    const url = `${this.baseUrl}/datastructure/${parts.agencyId}/${parts.dsdId}`;

    const retryOptsDs = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const data = await withRetry(() => fetchJson(url, signal), retryOptsDs).catch(
      (err: unknown) => {
        throw serviceUnavailable(
          `Failed to fetch OECD datastructure for ${flowRef}`,
          { url },
          { cause: err },
        );
      },
    );

    return parseDataStructure(data, flowRef, parts.agencyId, parts.dsdId);
  }

  /**
   * Fetch all codes for a codelist.
   * Uses `GET /codelist/{agencyID}/{codelistID}`.
   */
  async fetchCodelist(
    agencyId: string,
    codelistId: string,
    signal?: AbortSignal,
  ): Promise<OecdCode[]> {
    const url = `${this.baseUrl}/codelist/${agencyId}/${codelistId}`;

    const retryOptsCl = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const data = await withRetry(() => fetchJson(url, signal), retryOptsCl).catch(
      (err: unknown) => {
        throw serviceUnavailable(
          `Failed to fetch OECD codelist ${agencyId}/${codelistId}`,
          { url },
          { cause: err },
        );
      },
    );

    return parseCodelist(data);
  }
}

export function initStructureService(): void {
  const config = getServerConfig();
  _instance = new OecdStructureService(config.baseUrl);
}

export function getStructureService(): OecdStructureService {
  if (!_instance) throw new Error('OecdStructureService not initialized');
  return _instance;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseDataflows(data: unknown): OecdDataflow[] {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawFlows = (structures?.dataflows ?? []) as Array<Record<string, unknown>>;

  return rawFlows.map((f): OecdDataflow => {
    const agencyId = String(f.agencyID ?? '');
    const dfId = String(f.id ?? '');
    // Structure includes `structure` reference pointing to the DSD
    const structureRef = f.structure as Record<string, unknown> | undefined;
    const dsdId = String(structureRef?.id ?? dfId.replace(/^DF_/, 'DSD_'));

    const nameProp = f.name as Record<string, string> | string | undefined;
    const name =
      typeof nameProp === 'string' ? nameProp : (Object.values(nameProp ?? {})[0] ?? dfId);

    // Check for NonProductionDataflow annotation
    const annotations = (f.annotations ?? []) as Array<Record<string, unknown>>;
    const nonProduction = annotations.some((a) => String(a.id ?? '') === 'NonProductionDataflow');

    return {
      flowRef: `${agencyId},${dsdId}@${dfId}`,
      agencyId,
      flowId: dfId,
      dsdId,
      name: String(name),
      nonProduction,
    };
  });
}

function parseDataStructure(
  data: unknown,
  flowRef: string,
  agencyId: string,
  dsdId: string,
): OecdDataStructure {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawDsds = (structures?.dataStructures ?? []) as Array<Record<string, unknown>>;

  const dsd = rawDsds[0];
  if (!dsd) {
    throw new Error(`DataStructure not found for ${flowRef}`);
  }

  const components = dsd.dataStructureComponents as Record<string, unknown> | undefined;
  const dimList = components?.dimensionList as Record<string, unknown> | undefined;

  const rawDims = (dimList?.dimensions ?? []) as Array<Record<string, unknown>>;
  const rawTimeDim = dimList?.timeDimension as Record<string, unknown> | undefined;

  // Check NonProductionDataflow annotation
  const annotations = (dsd.annotations ?? []) as Array<Record<string, unknown>>;
  const nonProduction = annotations.some((a) => String(a.id ?? '') === 'NonProductionDataflow');

  const dimensions = rawDims
    .map((d): import('./types.js').OecdDimension => {
      const nameProp = d.name as Record<string, string> | string | undefined;
      const name =
        typeof nameProp === 'string'
          ? nameProp
          : (Object.values(nameProp ?? {})[0] ?? String(d.id ?? ''));

      // Codelist reference sits inside localRepresentation.enumeration
      const localRep = d.localRepresentation as Record<string, unknown> | undefined;
      const enumRef = localRep?.enumeration as Record<string, unknown> | undefined;
      const clAgency = String(enumRef?.agencyID ?? agencyId);
      const clId = enumRef?.id ? String(enumRef.id) : undefined;
      const codelistRef = clId ? `${clAgency},${clId}` : undefined;

      return {
        id: String(d.id ?? ''),
        name: String(name),
        position: Number(d.position ?? 0),
        codelistRef,
      };
    })
    .sort((a, b) => a.position - b.position);

  let timeDimension: import('./types.js').OecdTimeDimension | undefined;
  if (rawTimeDim) {
    const nameProp = rawTimeDim.name as Record<string, string> | string | undefined;
    const name =
      typeof nameProp === 'string'
        ? nameProp
        : (Object.values(nameProp ?? {})[0] ?? String(rawTimeDim.id ?? 'TIME_PERIOD'));
    timeDimension = {
      id: String(rawTimeDim.id ?? 'TIME_PERIOD'),
      name: String(name),
      position: dimensions.length + 1,
    };
  }

  return {
    flowRef,
    agencyId,
    dsdId,
    dimensions,
    timeDimension,
    nonProduction,
  };
}

function parseCodelist(data: unknown): OecdCode[] {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawCls = (structures?.codelists ?? []) as Array<Record<string, unknown>>;
  const cl = rawCls[0];
  if (!cl) return [];

  const rawCodes = (cl.codes ?? []) as Array<Record<string, unknown>>;
  return rawCodes.map((c): OecdCode => {
    const nameProp = c.name as Record<string, string> | string | undefined;
    const name =
      typeof nameProp === 'string'
        ? nameProp
        : (Object.values(nameProp ?? {})[0] ?? String(c.id ?? ''));
    return { id: String(c.id ?? ''), name: String(name) };
  });
}

// Export encode helper for use in tool URL construction
export { encodeFlowId };
