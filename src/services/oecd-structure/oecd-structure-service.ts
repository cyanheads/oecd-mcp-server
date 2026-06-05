/**
 * @fileoverview OECD SDMX structure service — wraps dataflow, datastructure, and codelist endpoints.
 * @module services/oecd-structure/oecd-structure-service
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  OecdCode,
  OecdDataflow,
  OecdDataStructure,
  OecdDimension,
  OecdTimeDimension,
} from './types.js';

const STRUCTURE_ACCEPT = 'application/vnd.sdmx.structure+json;version=1.0';
// OECD's HTTP/2 endpoint requires Accept-Language to avoid HTTP 500 responses
// when a structured Accept header is sent. Node.js fetch defaults to HTTP/2 and
// omits Accept-Language; adding it explicitly fixes the server-side routing bug.
const ACCEPT_LANGUAGE = 'en';

/**
 * Allowed characters in SDMX identifier path segments (agencyId, dsdId, dfId).
 * SDMX IDs use letters, digits, underscores, hyphens, and dots only.
 * Reject path-traversal sequences (/  \0  ?  #) that could alter the URL structure.
 */
const SDMX_ID_SAFE = /^[A-Za-z0-9._-]+$/;

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
  // Reject characters that could alter URL path structure
  if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(dsdId) || !SDMX_ID_SAFE.test(dfId)) {
    return null;
  }
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
      headers: { Accept: STRUCTURE_ACCEPT, 'Accept-Language': ACCEPT_LANGUAGE },
      signal: combinedSignal,
    });
    if (!res.ok) {
      throw serviceUnavailable(`OECD structure API returned HTTP ${res.status}`, {
        status: res.status,
      });
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
    if (agencyId !== undefined && !SDMX_ID_SAFE.test(agencyId)) {
      throw serviceUnavailable(`Invalid agency identifier: ${agencyId}`, { agencyId });
    }
    const url = agencyId ? `${this.baseUrl}/dataflow/${agencyId}` : `${this.baseUrl}/dataflow`;

    const retryOpts = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const data = await withRetry(() => fetchJson(url, signal), retryOpts).catch((err: unknown) => {
      throw serviceUnavailable(
        `Failed to fetch OECD dataflows${agencyId ? ` for agency ${agencyId}` : ''}`,
        {},
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

    const retryOpts = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const data = await withRetry(() => fetchJson(url, signal), retryOpts).catch((err: unknown) => {
      throw serviceUnavailable(
        `Failed to fetch OECD datastructure for ${flowRef}`,
        {},
        { cause: err },
      );
    });

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
    // Both IDs are derived from upstream DSD responses, but validate as a safety net
    // before embedding in the URL path.
    if (!SDMX_ID_SAFE.test(agencyId) || !SDMX_ID_SAFE.test(codelistId)) {
      throw serviceUnavailable(`Invalid codelist identifier: ${agencyId}/${codelistId}`, {
        agencyId,
        codelistId,
      });
    }
    const url = `${this.baseUrl}/codelist/${agencyId}/${codelistId}`;

    const retryOpts = signal ? { maxRetries: 2, signal } : { maxRetries: 2 };
    const data = await withRetry(() => fetchJson(url, signal), retryOpts).catch((err: unknown) => {
      throw serviceUnavailable(
        `Failed to fetch OECD codelist ${agencyId}/${codelistId}`,
        {},
        { cause: err },
      );
    });

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

/**
 * Extract the DSD identifier from the structure URN.
 * URN format: `urn:sdmx:...=AGENCY:DSD_ID(version)` or `urn:sdmx:...=AGENCY:DSD_ID`.
 * Returns undefined when the URN cannot be parsed.
 */
function dsdIdFromStructureUrn(urn: string): string | undefined {
  // Match the part after the last '=' and before any '(' or end
  const eq = urn.lastIndexOf('=');
  if (eq < 0) return;
  const rest = urn.slice(eq + 1); // "AGENCY:DSD_ID(version)" or "AGENCY:DSD_ID"
  const colon = rest.indexOf(':');
  if (colon < 0) return;
  const dsdPart = rest.slice(colon + 1); // "DSD_ID(version)" or "DSD_ID"
  const paren = dsdPart.indexOf('(');
  return paren >= 0 ? dsdPart.slice(0, paren) : dsdPart;
}

function parseDataflows(data: unknown): OecdDataflow[] {
  const root = data as Record<string, unknown>;
  const structures = root?.data as Record<string, unknown> | undefined;
  const rawFlows = (structures?.dataflows ?? []) as Array<Record<string, unknown>>;

  return rawFlows.map((f): OecdDataflow => {
    const agencyId = String(f.agencyID ?? '');
    const rawId = String(f.id ?? '');

    // f.id is either "DSD_XXX@DF_YYY" (most flows) or just "DF_YYY" (a few non-OECD flows).
    // The structure field is a string URN — not an object — so we extract the DSD id from it.
    const atIdx = rawId.indexOf('@');
    let dsdId: string;
    let flowId: string;
    if (atIdx >= 0) {
      // Combined format: split into DSD and DF parts
      dsdId = rawId.slice(0, atIdx);
      flowId = rawId.slice(atIdx + 1);
    } else {
      // DF-only id: extract DSD from the structure URN; fall back to replacing DF_ prefix
      const structureUrn = typeof f.structure === 'string' ? f.structure : '';
      dsdId = dsdIdFromStructureUrn(structureUrn) ?? rawId.replace(/^DF_/, 'DSD_');
      flowId = rawId;
    }

    const nameProp = f.name as Record<string, string> | string | undefined;
    const name =
      typeof nameProp === 'string' ? nameProp : (Object.values(nameProp ?? {})[0] ?? rawId);

    // Check for NonProductionDataflow annotation
    const annotations = (f.annotations ?? []) as Array<Record<string, unknown>>;
    const nonProduction = annotations.some((a) => String(a.id ?? '') === 'NonProductionDataflow');

    return {
      flowRef: `${agencyId},${dsdId}@${flowId}`,
      agencyId,
      flowId,
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
  // API uses "timeDimensions" (plural, array) — not "timeDimension" (singular)
  const rawTimeDims = (dimList?.timeDimensions ?? []) as Array<Record<string, unknown>>;
  const rawTimeDim = rawTimeDims[0];

  // Check NonProductionDataflow annotation
  const annotations = (dsd.annotations ?? []) as Array<Record<string, unknown>>;
  const nonProduction = annotations.some((a) => String(a.id ?? '') === 'NonProductionDataflow');

  const dimensions = rawDims
    .map((d): OecdDimension => {
      const nameProp = d.name as Record<string, string> | string | undefined;
      const name =
        typeof nameProp === 'string'
          ? nameProp
          : (Object.values(nameProp ?? {})[0] ?? String(d.id ?? ''));

      // Codelist reference sits inside localRepresentation.enumeration, which
      // is a string URN: "urn:sdmx:...=AGENCY:CL_ID(version)".
      // Parse the AGENCY:CL_ID portion from the URN.
      const localRep = d.localRepresentation as Record<string, unknown> | undefined;
      const enumUrn = localRep?.enumeration;
      let codelistRef: string | undefined;
      if (typeof enumUrn === 'string') {
        // Extract "AGENCY:CL_ID" from "urn:sdmx:...=AGENCY:CL_ID(version)"
        const eq = enumUrn.lastIndexOf('=');
        if (eq >= 0) {
          const rest = enumUrn.slice(eq + 1); // "AGENCY:CL_ID(version)"
          const paren = rest.indexOf('(');
          const agencyCl = paren >= 0 ? rest.slice(0, paren) : rest; // "AGENCY:CL_ID"
          const colon = agencyCl.indexOf(':');
          if (colon >= 0) {
            const clAgency = agencyCl.slice(0, colon);
            const clId = agencyCl.slice(colon + 1);
            if (clAgency && clId) codelistRef = `${clAgency},${clId}`;
          }
        }
      }

      // API positions are 0-based; expose as 1-based for user-facing key construction
      return {
        id: String(d.id ?? ''),
        name: String(name),
        position: Number(d.position ?? 0) + 1,
        codelistRef,
      };
    })
    .sort((a, b) => a.position - b.position);

  let timeDimension: OecdTimeDimension | undefined;
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

/**
 * Returns true when an error (or its cause chain) signals that a datastructure
 * or dataflow was not found — matches messages thrown by `parseDataStructure` and
 * HTTP 404 responses from `fetchJson`. Used by tool handlers to map service errors
 * to the typed `dataflow_not_found` contract entry.
 */
export function isDataflowNotFound(e: Error): boolean {
  const msg = e.message ?? '';
  if (msg.includes('DataStructure not found') || msg.includes('HTTP 404')) return true;
  const cause = (e as NodeJS.ErrnoException).cause;
  return cause instanceof Error ? isDataflowNotFound(cause) : false;
}

// Export encode helper for use in tool URL construction
export { encodeFlowId };
