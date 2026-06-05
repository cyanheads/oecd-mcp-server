/**
 * @fileoverview Tests for oecd_get_dimension_values tool.
 * @module tests/tools/get-dimension-values.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdGetDimensionValues } from '@/mcp-server/tools/definitions/get-dimension-values.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

const FAKE_BASE = 'https://fake.oecd.test';

// Real API format: positions are 0-based, enumeration is a string URN, timeDimensions is an array.
// DSD with one dimension that has a codelist and one that doesn't
const DSD_RESPONSE = {
  data: {
    dataStructures: [
      {
        annotations: [],
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'FREQ',
                position: 0,
                name: 'Frequency',
                localRepresentation: {
                  enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD:CL_FREQ(1.0)',
                },
              },
              {
                id: 'MEASURE',
                position: 1,
                name: 'Measure',
                localRepresentation: {},
              },
            ],
            timeDimensions: [
              {
                id: 'TIME_PERIOD',
                name: 'Time Period',
              },
            ],
          },
        },
      },
    ],
  },
};

const CODELIST_RESPONSE = {
  data: {
    codelists: [
      {
        codes: [
          { id: 'A', name: 'Annual' },
          { id: 'Q', name: 'Quarterly' },
          { id: 'M', name: 'Monthly' },
        ],
      },
    ],
  },
};

describe('oecdGetDimensionValues', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
  });

  it('returns codes for a dimension with a codelist', async () => {
    // First fetch → DSD, second fetch → codelist
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(DSD_RESPONSE),
          text: () => Promise.resolve(''),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(CODELIST_RESPONSE),
          text: () => Promise.resolve(''),
        }),
    );

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.code_count).toBe(3);
    expect(result.codes).toEqual([
      { id: 'A', name: 'Annual' },
      { id: 'Q', name: 'Quarterly' },
      { id: 'M', name: 'Monthly' },
    ]);
  });

  it('returns empty codes for a dimension with no codelist reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(''),
      }),
    );

    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'MEASURE',
    });
    const result = await oecdGetDimensionValues.handler(input, ctx);

    expect(result.code_count).toBe(0);
    expect(result.codes).toHaveLength(0);
  });

  it('throws ctx.fail(dataflow_not_found) for malformed flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'BAD',
      dimension_id: 'FREQ',
    });
    await expect(oecdGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when 200 response has empty dataStructures', async () => {
    // parseDataStructure throws "DataStructure not found" for an empty array in a 200 response.
    // The tool catches that message and maps to the dataflow_not_found contract entry.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_MISSING@DF_MISSING',
      dimension_id: 'FREQ',
    });
    await expect(oecdGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(dimension_not_found) for an unknown dimension_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(''),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDimensionValues.errors });
    const input = oecdGetDimensionValues.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'NONEXISTENT',
    });
    await expect(oecdGetDimensionValues.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dimension_not_found' },
    });
  });

  it('formats output with code table', () => {
    const output = {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimension_id: 'FREQ',
      codes: [
        { id: 'A', name: 'Annual' },
        { id: 'Q', name: 'Quarterly' },
      ],
      code_count: 2,
      source: 'OECD' as const,
    };
    const blocks = oecdGetDimensionValues.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FREQ');
    expect(text).toContain('Annual');
    expect(text).toContain('Quarterly');
    expect(text).toContain('Source: OECD');
  });
});
