/**
 * @fileoverview The count-input seam: what a `limit` schema accepts, rejects,
 * and advertises with the clamp on and with `OECD_CLAMP_LIMITS=false`, and what
 * applying a limit returns, logs, and counts. Each tool's own tests prove only
 * that its `limit` is wired here.
 * @module tests/utils/count-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { applyCountLimit, type CountLimit, countLimitSchema } from '@/utils/count-limit.js';

/** Every `add` the clamp counter receives. */
const recorded = vi.hoisted(() => ({
  adds: [] as Array<{ attributes: unknown; value: number }>,
  names: [] as string[],
}));

// The counter is the one effect with no other observable; record it at the factory.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    recorded.names.push(name);
    return {
      add: (value: number, attributes?: unknown) => recorded.adds.push({ attributes, value }),
    };
  },
}));

const LIMIT: CountLimit = { cap: 2000, defaultValue: 20, tool: 'oecd_example_tool' };
const LEAD = 'Most results to return.';

/** The `limit` property as `tools/list` advertises it. */
function advertised(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(z.object({ limit: schema }), { io: 'input' }) as Record<
    string,
    unknown
  >;
  return (json.properties as { limit: Record<string, unknown> }).limit;
}

describe('a count input with the clamp on (the default)', () => {
  const schema = countLimitSchema(LIMIT, LEAD);

  it('advertises an integer with a default and a minimum, and no maximum', () => {
    expect(advertised(schema)).toEqual({
      default: 20,
      description:
        'Most results to return. Default 20; a larger value returns at most 2,000 and says so.',
      minimum: 1,
      type: 'integer',
    });
  });

  it.each([
    [undefined, 20],
    [1, 1],
    [2000, 2000],
    [2001, 2001],
    [1e20, 1e20],
  ])('accepts %s as %s, leaving any clamp to the handler', (value, parsed) => {
    expect(schema.parse(value)).toBe(parsed);
  });

  it.each([
    [0, 'too_small'],
    [-5, 'too_small'],
    [1.5, 'invalid_type'],
    [Number.POSITIVE_INFINITY, 'invalid_type'],
    [Number.NaN, 'invalid_type'],
    ['50', 'invalid_type'],
  ])('rejects %s as %s', (value, code) => {
    const result = schema.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toContain(code);
  });

  it('names a fraction an integer mistake, not a size one', () => {
    expect(schema.safeParse(1.5).error?.issues).toEqual([
      expect.objectContaining({ code: 'invalid_type', expected: 'int' }),
    ]);
  });
});

describe('a count input under OECD_CLAMP_LIMITS=false', () => {
  const schema = countLimitSchema(LIMIT, LEAD);

  beforeEach(() => {
    getServerConfig().clampLimits = false;
  });

  afterEach(() => {
    getServerConfig().clampLimits = true;
  });

  it('advertises the cap as its maximum, and says so in the description', () => {
    expect(advertised(schema)).toEqual({
      default: 20,
      description: 'Most results to return. Default 20, at most 2,000.',
      maximum: 2000,
      minimum: 1,
      type: 'integer',
    });
  });

  it('accepts the cap itself', () => {
    expect(schema.parse(2000)).toBe(2000);
  });

  it.each([2001, 1e20])('rejects %s above the cap as too_big', (value) => {
    expect(schema.safeParse(value).error?.issues).toEqual([
      expect.objectContaining({ code: 'too_big', inclusive: true, maximum: 2000 }),
    ]);
  });

  it('still names a fraction an integer mistake', () => {
    expect(schema.safeParse(1.5).error?.issues).toEqual([
      expect.objectContaining({ code: 'invalid_type', expected: 'int' }),
    ]);
  });
});

describe('the switch is read on every parse and every emission', () => {
  afterEach(() => {
    getServerConfig().clampLimits = true;
  });

  it('follows a change to the setting on a schema built before it', () => {
    const schema = countLimitSchema(LIMIT, LEAD);

    expect(schema.safeParse(5000).success).toBe(true);
    expect(advertised(schema).maximum).toBeUndefined();

    getServerConfig().clampLimits = false;

    expect(schema.safeParse(5000).success).toBe(false);
    expect(advertised(schema).maximum).toBe(2000);
  });

  it('reads a cap given as a function on every call', () => {
    let cap = 1000;
    const limit: CountLimit = { cap: () => cap, defaultValue: 100, tool: 'oecd_example_tool' };
    const schema = countLimitSchema(limit, LEAD);
    getServerConfig().clampLimits = false;

    expect(advertised(schema).maximum).toBe(1000);
    expect(schema.safeParse(800).success).toBe(true);

    cap = 500;

    expect(advertised(schema)).toMatchObject({
      description: 'Most results to return. Default 100, at most 500.',
      maximum: 500,
    });
    expect(schema.safeParse(800).success).toBe(false);
    expect(applyCountLimit(800, limit, createMockContext()).applied).toBe(500);
  });
});

describe('applyCountLimit', () => {
  beforeEach(() => {
    recorded.adds.length = 0;
  });

  it('serves a limit within the cap as asked, silently', () => {
    const ctx = createMockContext();

    expect(applyCountLimit(2000, LIMIT, ctx)).toEqual({ applied: 2000, notice: undefined });
    expect((ctx.log as MockContextLogger).calls).toEqual([]);
    expect(recorded.adds).toEqual([]);
  });

  it('serves a limit above the cap at the cap, with a notice, a log line, and a count', () => {
    const ctx = createMockContext();

    expect(applyCountLimit(5000, LIMIT, ctx)).toEqual({
      applied: 2000,
      notice: '`limit` 5000 is above the per-call maximum of 2000; served 2000.',
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        data: { applied: 2000, requested: 5000, tool: 'oecd_example_tool' },
        level: 'info',
        msg: 'Served limit at its per-call cap',
      },
    ]);
    expect(recorded.names).toEqual(['oecd.count_input.clamps']);
    expect(recorded.adds).toEqual([
      {
        attributes: { 'mcp.tool.name': 'oecd_example_tool', 'oecd.count_input.cap': 2000 },
        value: 1,
      },
    ]);
  });

  it('counts each clamp once', () => {
    const ctx = createMockContext();
    applyCountLimit(2001, LIMIT, ctx);
    applyCountLimit(1e20, LIMIT, ctx);

    expect(recorded.adds.map((add) => add.value)).toEqual([1, 1]);
  });

  it('names a non-defaulted count input in its notice and log and uses the same counter', () => {
    const ctx = createMockContext();
    const cap = { cap: 100_000, tool: 'oecd_query_dataset', parameter: 'last_n_observations' };

    expect(applyCountLimit(100_001, cap, ctx)).toEqual({
      applied: 100_000,
      notice:
        '`last_n_observations` 100001 is above the per-call maximum of 100000; served 100000.',
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        data: { applied: 100_000, requested: 100_001, tool: 'oecd_query_dataset' },
        level: 'info',
        msg: 'Served last_n_observations at its per-call cap',
      },
    ]);
    expect(recorded.adds).toEqual([
      {
        attributes: { 'mcp.tool.name': 'oecd_query_dataset', 'oecd.count_input.cap': 100_000 },
        value: 1,
      },
    ]);
  });
});
