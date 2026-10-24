/**
 * @fileoverview Render tabular output without interpreting upstream text as Markdown.
 * @module utils/format-table
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Multiline cells use JSON because Markdown table cells cannot preserve line breaks. */
export function formatTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if ([...columns, ...rows.flat()].some((value) => /[\r\n]/.test(value))) {
    return `\`\`\`json\n${JSON.stringify({ columns, rows }, null, 2)}\n\`\`\``;
  }
  return [
    `| ${columns.map(escapeMarkdownInline).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownInline).join(' | ')} |`),
  ].join('\n');
}
