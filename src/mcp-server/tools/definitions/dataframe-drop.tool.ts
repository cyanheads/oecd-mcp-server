/**
 * @fileoverview oecd_dataframe_drop — remove one table or view from a DataCanvas staged by
 * oecd_query_dataset. Opt-in: registered disabled unless OECD_DATAFRAME_DROP_ENABLED=true.
 * @module mcp-server/tools/definitions/dataframe-drop.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor/canvas-accessor.js';

const oecdDataframeDropDefinition = tool('oecd_dataframe_drop', {
  description:
    'Drop one table or view from a DataCanvas staged by oecd_query_dataset, freeing it once the ' +
    'analysis no longer needs it. The canvas and its other tables stay queryable. ' +
    'Call oecd_dataframe_describe first for the exact table names. ' +
    'Only available when CANVAS_PROVIDER_TYPE=duckdb is set.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by oecd_query_dataset — exactly 10 characters of letters, digits, ' +
        'hyphens, and underscores. Identifies the DataCanvas holding the table to drop.',
    ),
    table_name: z
      .string()
      .describe(
        'Name of the table or view to drop, exactly as oecd_dataframe_describe lists it ' +
          '(e.g. spilled_ab12cd34ef).',
      ),
  }),
  output: z.object({
    canvas_id: z.string().describe('The canvas the table was dropped from.'),
    table_name: z.string().describe('The table or view that was dropped.'),
    kind: z.enum(['table', 'view']).describe('Whether the dropped object was a table or a view.'),
    remaining_tables: z
      .array(z.string())
      .describe('Tables and views still staged on the canvas after the drop.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured — CANVAS_PROVIDER_TYPE is unset.',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb to enable DataCanvas, then retry.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id has expired or was never created.',
      recovery:
        'The canvas is already gone, so there is nothing left to drop. Re-run oecd_query_dataset ' +
        'only if the data is still needed.',
    },
    {
      reason: 'table_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas holds no table or view by that name — it was already dropped, expired, or the name is wrong.',
      recovery:
        'Call oecd_dataframe_describe with this canvas_id for the tables it currently holds, ' +
        'then retry with one of those names.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb to use oecd_dataframe_drop.',
      );
    }

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err) {
      throw ctx.fail(
        'canvas_not_found',
        `Canvas "${input.canvas_id}" not found or expired`,
        undefined,
        { cause: err as Error },
      );
    }

    /**
     * Resolved against `describe()` rather than handed to `drop()` directly: a
     * name that is not a staged object — malformed ones included, which the
     * canvas would otherwise reject as an identifier error — is the same miss
     * to the caller, and the listing also yields the kind and what remains.
     */
    const staged = await instance.describe();
    const target = staged.find((t) => t.name === input.table_name);
    const notFoundMessage = `Canvas "${input.canvas_id}" holds no table or view named "${input.table_name}"`;
    if (!target) throw ctx.fail('table_not_found', notFoundMessage);

    ctx.log.info('Dropping DataCanvas table', {
      canvasId: input.canvas_id,
      tableName: target.name,
      kind: target.kind,
    });
    if (!(await instance.drop(target.name))) throw ctx.fail('table_not_found', notFoundMessage);

    return {
      canvas_id: instance.canvasId,
      table_name: target.name,
      kind: target.kind,
      remaining_tables: staged.filter((t) => t.name !== target.name).map((t) => t.name),
    };
  },

  format: (result) => {
    const remaining =
      result.remaining_tables.length > 0
        ? `${result.remaining_tables.length} remain: ${result.remaining_tables.join(', ')}`
        : 'No tables remain on this canvas.';
    return [
      {
        type: 'text',
        text: `Dropped ${result.kind} **${result.table_name}** from DataCanvas ${result.canvas_id}. ${remaining}`,
      },
    ];
  },
});

/** Registered for clients only when OECD_DATAFRAME_DROP_ENABLED=true; otherwise listed as disabled. */
export const oecdDataframeDrop = getServerConfig().dataframeDropEnabled
  ? oecdDataframeDropDefinition
  : disabledTool(oecdDataframeDropDefinition, {
      reason: 'Dropping staged DataCanvas tables is turned off in this deployment.',
      hint: 'OECD_DATAFRAME_DROP_ENABLED=true',
    });
