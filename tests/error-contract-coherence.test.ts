/**
 * @fileoverview Cross-surface checks on the declared error contracts. Each
 * definition's own test proves its handler reaches its contract; these prove the
 * contracts agree with each other, which no single-definition test can see. A
 * caller must not have to know which surface it called to read a failure.
 * @module tests/error-contract-coherence.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { oecdDataflowResource } from '@/mcp-server/resources/definitions/dataflow.resource.js';
import { oecdGetDatasetInfo } from '@/mcp-server/tools/definitions/get-dataset-info.tool.js';
import { oecdGetDimensionValues } from '@/mcp-server/tools/definitions/get-dimension-values.tool.js';
import { oecdListAgencies } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { oecdQueryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { oecdSearchDatasets } from '@/mcp-server/tools/definitions/search-datasets.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/index.js';
import { declaredError, declaredErrors, type WithErrors } from './helpers/error-contract.js';

/** Every definition whose failures can come from OECD rather than from itself. */
const OECD_REACHING: ReadonlyArray<readonly [string, WithErrors]> = [
  ['oecd_list_agencies', oecdListAgencies],
  ['oecd_search_datasets', oecdSearchDatasets],
  ['oecd_get_dataset_info', oecdGetDatasetInfo],
  ['oecd_get_dimension_values', oecdGetDimensionValues],
  ['oecd_query_dataset', oecdQueryDataset],
  ['oecd://dataflow/{agency_id}/{flow_id}', oecdDataflowResource],
];

/** The surfaces that take a flow reference and can find it unparseable. */
const FLOW_REF_SURFACES: ReadonlyArray<readonly [string, WithErrors]> = [
  ['oecd_get_dataset_info', oecdGetDatasetInfo],
  ['oecd_get_dimension_values', oecdGetDimensionValues],
  ['oecd_query_dataset', oecdQueryDataset],
];

/** Every definition on the surface, including the three that reach no network. */
const ALL_DEFINITIONS: ReadonlyArray<readonly [string, WithErrors]> = [
  ...allToolDefinitions.map((t) => [t.name, t as WithErrors] as const),
  ['oecd://dataflow/{agency_id}/{flow_id}', oecdDataflowResource],
];

describe('invalid_flow_ref is one failure with one answer', () => {
  it.each(FLOW_REF_SURFACES)('%s states the format and how to obtain a valid ref', (_name, def) => {
    const entry = declaredError(def, 'invalid_flow_ref');

    expect(entry.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(entry).toMatchObject(declaredError(oecdGetDatasetInfo, 'invalid_flow_ref'));
  });

  it('never reports an unparseable ref as a dataflow that does not exist', () => {
    for (const [, def] of FLOW_REF_SURFACES) {
      // NotFound asserts the server looked and found nothing. Nothing is looked
      // up for a string that is not a flow reference — no request is issued.
      expect(declaredError(def, 'invalid_flow_ref').code).not.toBe(JsonRpcErrorCode.NotFound);
    }
  });

  it('gives the resource the same reason and code, and the split its URI needs', () => {
    const resource = declaredError(oecdDataflowResource, 'invalid_flow_ref');
    const tool = declaredError(oecdGetDatasetInfo, 'invalid_flow_ref');

    expect(resource.code).toBe(tool.code);
    // The one deliberate divergence: the tool takes one string, the resource
    // takes it split across two URI segments with the `@` percent-encoded.
    expect(resource.recovery).not.toBe(tool.recovery);
    expect(resource.recovery).toContain('%40');
    expect(resource.recovery).toContain('oecd_search_datasets');
  });
});

describe('invalid_key is one failure with one answer', () => {
  it('reads the same on oecd_query_dataset and oecd_get_dimension_values', () => {
    const query = declaredError(oecdQueryDataset, 'invalid_key');
    const dimensions = declaredError(oecdGetDimensionValues, 'invalid_key');

    expect(dimensions.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(dimensions.code).toBe(query.code);
    expect(dimensions.retryable).toBe(query.retryable);
    for (const entry of [query, dimensions]) {
      // Both check the key's characters themselves; a wrong segment count fails either way.
      expect(entry.when).toContain('outside the SDMX key set');
      expect(entry.when).toMatch(/\bsegments\b/);
      expect(entry.recovery).toMatch(
        /^Use oecd_get_dataset_info to check dimension order and count, then rebuild the\b/,
      );
    }
  });
});

describe('every OECD-reaching definition names an upstream failure the same way', () => {
  const UPSTREAM: ReadonlyArray<readonly [string, JsonRpcErrorCode, boolean | undefined]> = [
    ['rate_limited', JsonRpcErrorCode.RateLimited, true],
    ['upstream_timeout', JsonRpcErrorCode.Timeout, true],
    ['upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable, true],
    ['upstream_redirect', JsonRpcErrorCode.Forbidden, false],
    ['upstream_error', JsonRpcErrorCode.ServiceUnavailable, undefined],
    ['upstream_unreadable', JsonRpcErrorCode.ServiceUnavailable, false],
  ];

  for (const [reason, code, retryable] of UPSTREAM) {
    it.each(OECD_REACHING)(`%s declares ${reason} as ${JsonRpcErrorCode[code]}`, (_name, def) => {
      const entry = declaredError(def, reason);
      expect(entry.code).toBe(code);
      expect(entry.retryable).toBe(retryable);
      // A hint may be tailored per surface, but it always has to say something.
      expect(entry.recovery.split(/\s+/).length).toBeGreaterThan(4);
    });
  }

  it('tells the caller of an unreadable answer what changes the next one', () => {
    for (const [name, def] of OECD_REACHING) {
      const recovery = declaredError(def, 'upstream_unreadable').recovery;
      if (name === 'oecd_query_dataset') {
        // The one surface whose caller shapes the request: a narrower one is a different body.
        expect(recovery).toMatch(/\bkey\b/);
        expect(recovery).toMatch(/\bperiod\b/);
        expect(recovery).not.toContain('OECD_BASE_URL');
      } else {
        // A fixed artefact comes back the same, so the fault is reported, not retried.
        expect(recovery).toContain('OECD_BASE_URL');
      }
    }
  });

  it('describes the timeout as the request or the call running past its budget, everywhere', () => {
    const when = declaredError(oecdGetDatasetInfo, 'upstream_timeout').when;

    expect(when).toContain('OECD_TIMEOUT_MS');
    expect(when).toContain('50 seconds');
    for (const [, def] of OECD_REACHING) {
      const entry = declaredError(def, 'upstream_timeout');
      expect(entry.when).toBe(when);
      // A raised OECD_TIMEOUT_MS only helps a client that waits for it.
      expect(entry.recovery).toMatch(/past 50 seconds also needs a client that waits that long/);
    }
  });

  it('asks for the HTTP status and OECD text an upstream_error carries, everywhere', () => {
    for (const [, def] of OECD_REACHING) {
      expect(declaredError(def, 'upstream_error').recovery).toContain(
        'report the HTTP status and OECD text this error carries',
      );
    }
  });

  it('declares download_limit only where the caller has a request to shrink', () => {
    const declaring = OECD_REACHING.filter(([, def]) =>
      declaredErrors(def).some((e) => e.reason === 'download_limit'),
    ).map(([name]) => name);

    // Every other surface asks OECD for one fixed artefact, so "ask for less"
    // is advice its caller cannot act on and the throttle stays rate_limited.
    expect(declaring).toEqual(['oecd_query_dataset']);
    expect(declaredError(oecdQueryDataset, 'download_limit').code).toBe(
      JsonRpcErrorCode.RateLimited,
    );
  });
});

describe('one reason, one code, across the whole surface', () => {
  it('never gives the same reason two different codes', () => {
    const codesByReason = new Map<string, Map<number, string[]>>();
    for (const [name, def] of ALL_DEFINITIONS) {
      for (const entry of declaredErrors(def)) {
        const byCode = codesByReason.get(entry.reason) ?? new Map<number, string[]>();
        byCode.set(entry.code, [...(byCode.get(entry.code) ?? []), name]);
        codesByReason.set(entry.reason, byCode);
      }
    }

    const conflicts = [...codesByReason]
      .filter(([, byCode]) => byCode.size > 1)
      .map(([reason, byCode]) => `${reason}: ${JSON.stringify([...byCode])}`);

    expect(conflicts).toEqual([]);
  });
});
