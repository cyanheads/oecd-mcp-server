/**
 * @fileoverview Count inputs (`limit`) that serve an over-the-cap value at the
 * tool's per-call cap with a notice, a log line, and a counter — or, under
 * `OECD_CLAMP_LIMITS=false`, advertise and enforce that cap as a strict maximum.
 * @module utils/count-limit
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clamps = createCounter(
  'oecd.count_input.clamps',
  'Count inputs served at their per-call cap',
  '{clamps}',
);

/** One tool's `limit`: the most a call serves and the default it gets. */
export interface CountLimit {
  /**
   * The most one call serves. A function when the cap follows other
   * configuration, which is then read on every call rather than at import.
   */
  readonly cap: number | (() => number);
  /** Value a call that names no `limit` gets; below the cap. */
  readonly defaultValue: number;
  /** The tool the input belongs to, as the log line and the counter name it. */
  readonly tool: string;
}

/** The cap in force for this call. */
export function capOf(limit: CountLimit): number {
  return typeof limit.cap === 'function' ? limit.cap() : limit.cap;
}

/** Whether an over-the-cap value is served at the cap (the default) rather than rejected. */
function clamping(): boolean {
  return getServerConfig().clampLimits;
}

/**
 * The `limit` input schema: a default, a minimum of 1, and the description
 * `lead` followed by the default and the cap, stated once.
 *
 * Clamping advertises no `maximum`, since every larger value is served at the
 * cap. The integer check is therefore a `.check()` and the JSON Schema type is
 * set through `.meta()`, because `.int()` would advertise and enforce
 * `Number.MAX_SAFE_INTEGER` — a bound no call is served at. With
 * `OECD_CLAMP_LIMITS=false` the same check rejects a value above the cap and the
 * schema advertises the cap as `maximum`.
 *
 * The switch is read on every parse and on every emission of the schema (the
 * `maximum` and `description` getters), never at import, so a value from `.env`
 * applies however early this module loads.
 */
export function countLimitSchema(limit: CountLimit, lead: string) {
  const integer = z
    .number()
    .min(1)
    .check((payload) => {
      if (!Number.isInteger(payload.value)) {
        payload.issues.push({ code: 'invalid_type', expected: 'int', input: payload.value });
        return;
      }
      const cap = capOf(limit);
      if (!clamping() && payload.value > cap) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: cap,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .meta({
      type: 'integer',
      get maximum() {
        return clamping() ? undefined : capOf(limit);
      },
    });
  return integer.default(limit.defaultValue).meta({
    get description() {
      const cap = capOf(limit).toLocaleString('en-US');
      const def = limit.defaultValue.toLocaleString('en-US');
      return clamping()
        ? `${lead} Default ${def}; a larger value returns at most ${cap} and says so.`
        : `${lead} Default ${def}, at most ${cap}.`;
    },
  });
}

/** A `limit` as one call applies it. */
export interface AppliedLimit {
  /** The value the call serves — the requested one, or the cap when that was lower. */
  readonly applied: number;
  /**
   * The sentence to carry in the call's one notice when the request was above
   * the cap; undefined otherwise. Plain text with backticks, no caller input.
   */
  readonly notice: string | undefined;
}

/**
 * Apply a validated `limit`: serve it as asked when it is within the cap, or at
 * the cap otherwise, logging and counting the clamp and returning the sentence
 * that discloses it. Under `OECD_CLAMP_LIMITS=false` the schema has already
 * rejected anything above the cap, so this returns the request unchanged.
 */
export function applyCountLimit(requested: number, limit: CountLimit, ctx: Context): AppliedLimit {
  const cap = capOf(limit);
  if (requested <= cap) return { applied: requested, notice: undefined };
  ctx.log.info('Served limit at its per-call cap', { tool: limit.tool, requested, applied: cap });
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: limit.tool, 'oecd.count_input.cap': cap });
  return {
    applied: cap,
    notice: `\`limit\` ${requested} is above the per-call maximum of ${cap}; served ${cap}.`,
  };
}
