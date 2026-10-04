/**
 * @fileoverview Surface-wide checks on what a tool accepts as arguments.
 *
 * Tool inputs are strict: an argument key no schema declares is rejected by
 * name before the handler runs, and the advertised `inputSchema` says so with
 * `additionalProperties: false` in the 2020-12 dialect. Both halves are pinned
 * here because a client reads the advertised one and the server enforces the
 * other — a definition that grew a `.passthrough()` or a `.catchall()` would
 * silently reopen the surface on both, and nothing else in the suite looks.
 *
 * The `canvas_id` shape is pinned the same way: every tool that takes one takes
 * it as the minted 10-character form, so an impossible value is rejected at
 * argument validation with the constraint visible in `inputSchema` — rather
 * than reaching a registry lookup that can only report it as a canvas that does
 * not exist.
 * @module tests/tool-input-strictness.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/index.js';

const FLOW_REF = 'OECD.SDD.NAD,DSD_NAAG@DF_NAAG_I';

/** A well-formed minted canvas handle — 10 chars of the URL-safe alphabet. */
const CANVAS_ID = 'canvas-001';

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
  oecd_dataframe_describe: { canvas_id: CANVAS_ID },
  oecd_dataframe_query: { canvas_id: CANVAS_ID, sql: 'SELECT 1' },
  oecd_dataframe_drop: { canvas_id: CANVAS_ID, table_name: 'spilled_abc' },
};

/** Every tool that accepts a `canvas_id`, with the rest of its arguments. */
const CANVAS_ID_TOOLS: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ['oecd_query_dataset', { flow_ref: FLOW_REF, key: 'A.USA..' }],
  ['oecd_dataframe_describe', {}],
  ['oecd_dataframe_query', { sql: 'SELECT 1' }],
  ['oecd_dataframe_drop', { table_name: 'spilled_abc' }],
];

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

describe('every tool taking a canvas_id takes it in the minted shape', () => {
  const byName = new Map(TOOLS);

  function definitionFor(name: string) {
    const definition = byName.get(name);
    if (!definition) throw new Error(`No registered tool named ${name}`);
    return definition;
  }

  it('covers every tool whose input declares canvas_id', () => {
    const declaring = TOOLS.filter(([, definition]) => {
      const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
        properties?: Record<string, unknown>;
      };
      return schema.properties !== undefined && 'canvas_id' in schema.properties;
    }).map(([name]) => name);

    expect(declaring.sort()).toEqual(CANVAS_ID_TOOLS.map(([name]) => name).sort());
  });

  it.each(CANVAS_ID_TOOLS)('%s accepts a minted handle', (name, rest) => {
    expect(definitionFor(name).input.safeParse({ ...rest, canvas_id: CANVAS_ID }).success).toBe(
      true,
    );
  });

  it.each(CANVAS_ID_TOOLS)('%s rejects a value no canvas could carry', (name, rest) => {
    const definition = definitionFor(name);

    // Too short, too long, and a character outside the URL-safe alphabet.
    for (const canvas_id of ['canvas', 'canvas-0001', 'canvas/001']) {
      expect(definition.input.safeParse({ ...rest, canvas_id }).success).toBe(false);
    }
  });

  it.each(CANVAS_ID_TOOLS)('%s advertises the constraint in inputSchema', (name) => {
    const schema = z.toJSONSchema(definitionFor(name).input, { io: 'input' }) as {
      properties: Record<string, { description?: string; pattern?: string }>;
    };
    const field = schema.properties.canvas_id;

    // The pattern is what a model reads before it calls; the description is
    // what tells it where a handle comes from, which the pattern cannot.
    expect(field?.pattern).toBe('^[A-Za-z0-9_-]{10}$');
    expect(field?.description).toContain('oecd_query_dataset');
  });
});
