/**
 * @fileoverview Render tabular output without interpreting upstream text as Markdown.
 * @module utils/format-table
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Render records as a table unless blank cells would conceal distinct values. */
export function formatRecordTable(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  let hasEmptyText = false;
  let hasMissingValue = false;
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column];
      if (value === '') hasEmptyText = true;
      if (value === null || value === undefined) hasMissingValue = true;
      if (hasEmptyText && hasMissingValue) {
        return `\`\`\`json\n${JSON.stringify({ columns, rows }, null, 2)}\n\`\`\``;
      }
    }
  }

  return formatTable(
    columns,
    rows.map((row) =>
      columns.map((column) => {
        const value = row[column];
        return typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : String(value ?? '');
      }),
    ),
  );
}

/** Multiline cells use JSON because Markdown table cells cannot preserve line breaks. */
export function formatTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const hasLineBreak = (value: string) => /[\r\n]/.test(value);
  if (columns.some(hasLineBreak) || rows.some((row) => row.some(hasLineBreak))) {
    return `\`\`\`json\n${JSON.stringify({ columns, rows }, null, 2)}\n\`\`\``;
  }
  return [
    `| ${columns.map(escapeMarkdownInline).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownInline).join(' | ')} |`),
  ].join('\n');
}
