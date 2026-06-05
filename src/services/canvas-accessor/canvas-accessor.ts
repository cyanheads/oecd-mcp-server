/**
 * @fileoverview Module-level DataCanvas accessor — wired from createApp setup().
 * @module services/canvas-accessor/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Set the canvas instance from the setup() callback. */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Get the canvas instance. Returns undefined when CANVAS_PROVIDER_TYPE is not duckdb. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
