/**
 * @fileoverview Tests for oecd_get_dataset_info tool.
 * @module tests/tools/get-dataset-info.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oecdGetDatasetInfo } from '@/mcp-server/tools/definitions/get-dataset-info.tool.js';
import { initStructureService } from '@/services/oecd-structure/oecd-structure-service.js';

const FAKE_BASE = 'https://fake.oecd.test';

// Real API format: positions are 0-based, enumeration is a string URN, timeDimensions is an array.
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
                id: 'REF_AREA',
                position: 1,
                name: { en: 'Reference Area' },
                localRepresentation: {
                  enumeration:
                    'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=OECD.SDD.NAD:CL_AREA(1.0)',
                },
              },
              {
                id: 'MEASURE',
                position: 2,
                name: 'Measure',
                localRepresentation: {},
              },
            ],
            timeDimensions: [
              {
                id: 'TIME_PERIOD',
                name: { en: 'Time Period' },
              },
            ],
          },
        },
      },
    ],
  },
};

describe('oecdGetDatasetInfo', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OECD_BASE_URL = FAKE_BASE;
    process.env.OECD_TIMEOUT_MS = '5000';
    initStructureService();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(DSD_RESPONSE),
        text: () => Promise.resolve(JSON.stringify(DSD_RESPONSE)),
      }),
    );
  });

  it('returns dimensions and time dimension for a valid flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
    });
    const result = await oecdGetDatasetInfo.handler(input, ctx);

    expect(result.source).toBe('OECD');
    expect(result.flow_ref).toBe('OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I');
    expect(result.dimensions).toHaveLength(3);
    expect(result.dimensions[0]).toMatchObject({ id: 'FREQ', position: 1, name: 'Frequency' });
    expect(result.dimensions[1]).toMatchObject({
      id: 'REF_AREA',
      position: 2,
      codelist_ref: 'OECD.SDD.NAD,CL_AREA',
    });
    expect(result.time_dimension).toMatchObject({ id: 'TIME_PERIOD' });
    // key_example should have 2 dots for 3 dimensions
    expect(result.key_example.split('.').length).toBe(3);
  });

  it('throws ctx.fail(invalid_flow_ref) for malformed flow_ref', async () => {
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({ flow_ref: 'BAD_FORMAT' });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_flow_ref' },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when DSD response is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_MISSING@DF_MISSING',
    });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail(dataflow_not_found) when datastructure is missing from the 200 response', async () => {
    // The "DataStructure not found" error originates from parseDataStructure when
    // the dataStructures array is empty in a 200 response — this is what triggers
    // the `e.message?.includes('DataStructure not found')` check in the tool handler.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { dataStructures: [] } }),
        text: () => Promise.resolve('{}'),
      }),
    );
    const ctx = createMockContext({ errors: oecdGetDatasetInfo.errors });
    const input = oecdGetDatasetInfo.input.parse({
      flow_ref: 'OECD.SDD.NAD,DSD_X@DF_X',
    });
    await expect(oecdGetDatasetInfo.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('formats output with dimension table and key example', () => {
    const output = {
      flow_ref: 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I',
      dimensions: [
        { id: 'FREQ', name: 'Frequency', position: 1, codelist_ref: 'OECD,CL_FREQ' },
        { id: 'REF_AREA', name: 'Reference Area', position: 2, codelist_ref: undefined },
      ],
      time_dimension: { id: 'TIME_PERIOD', name: 'Time Period', position: 3 },
      key_example: '.',
      non_production: false,
      source: 'OECD' as const,
    };
    const blocks = oecdGetDatasetInfo.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FREQ');
    expect(text).toContain('REF_AREA');
    expect(text).toContain('TIME_PERIOD');
    expect(text).toContain('Source: OECD');
  });
});
