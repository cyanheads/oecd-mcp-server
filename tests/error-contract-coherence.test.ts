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

/** Every definition on the surface, including the two that reach no network. */
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

describe('every OECD-reaching definition names an upstream failure the same way', () => {
  const UPSTREAM: ReadonlyArray<readonly [string, JsonRpcErrorCode, boolean | undefined]> = [
    ['rate_limited', JsonRpcErrorCode.RateLimited, true],
    ['upstream_timeout', JsonRpcErrorCode.Timeout, true],
    ['upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable, true],
    ['upstream_redirect', JsonRpcErrorCode.Forbidden, false],
    ['upstream_error', JsonRpcErrorCode.ServiceUnavailable, undefined],
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
