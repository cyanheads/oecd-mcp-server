/**
 * @fileoverview Surface-wide checks on what a tool accepts as arguments.
 *
 * Tool inputs are strict: an argument key no schema declares is rejected by
 * name before the handler runs, and the advertised `inputSchema` says so with
 * `additionalProperties: false` in the 2020-12 dialect. Both halves are pinned
 * here because a client reads the advertised one and the server enforces the
 * other — a definition that grew a `.passthrough()` or a `.catchall()` would
 * silently reopen the surface on both, and nothing else in the suite looks.
 * @module tests/tool-input-strictness.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/index.js';

const FLOW_REF = 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I';

/**
 * Arguments each tool's schema accepts as they stand. Nothing is fetched — the
 * schema is what is under test — so these only have to satisfy the declared
 * shape, not name a real dataflow.
 */
const VALID_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  oecd_list_agencies: {},
  oecd_search_datasets: { query: 'gdp' },
  oecd_get_dataset_info: { flow_ref: FLOW_REF },
  oecd_get_dimension_values: { flow_ref: FLOW_REF, dimension_id: 'REF_AREA' },
  oecd_query_dataset: { flow_ref: FLOW_REF, key: 'A.USA..' },
  oecd_dataframe_describe: { canvas_id: 'canvas-001' },
  oecd_dataframe_query: { canvas_id: 'canvas-001', sql: 'SELECT 1' },
};

const TOOLS = allToolDefinitions.map((definition) => [definition.name, definition] as const);

describe('every tool advertises a closed input schema', () => {
  it.each(TOOLS)('%s emits additionalProperties: false in 2020-12', (_name, definition) => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as Record<string, unknown>;

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('every tool rejects an argument key it never declared', () => {
  it('covers the whole registered surface', () => {
    expect(Object.keys(VALID_ARGUMENTS).sort()).toEqual(TOOLS.map(([name]) => name).sort());
  });

  it.each(TOOLS)('%s names the stray key rather than stripping it', (name, definition) => {
    const valid = VALID_ARGUMENTS[name];
    if (!valid) throw new Error(`No sample arguments declared for ${name}`);

    // The same arguments without the stray key are accepted, so a rejection
    // below is the extra key and not a malformed sample.
    expect(definition.input.safeParse(valid).success).toBe(true);

    const rejected = definition.input.safeParse({ ...valid, not_a_declared_key: 'x' });

    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues).toContainEqual(
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['not_a_declared_key'] }),
    );
  });
});
