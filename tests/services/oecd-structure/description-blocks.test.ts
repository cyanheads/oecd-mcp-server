/**
 * @fileoverview HTML block structure in OECD dataflow abstracts.
 * @module tests/services/oecd-structure/description-blocks.test
 */
import MarkdownIt from 'markdown-it';
import { expect, it } from 'vitest';
import { oecdGetDatasetInfo } from '@/mcp-server/tools/definitions/get-dataset-info.tool.js';
import { htmlToMarkdown } from '@/services/oecd-structure/dataflow-description.js';
import { formatDataflowDescription } from '@/utils/format-dataflow-description.js';

it('retains the final column and methodology link when its URL contains a pipe', () => {
  const description = htmlToMarkdown(
    '<table><tr><th>Guide</th><th>Unit</th></tr><tr><td><a href="https://oecd.org/x|y">X | Y</a></td><td>EUR</td></tr></table>',
  );
  const rendered = new MarkdownIt().render(formatDataflowDescription(description));
  expect(rendered).toContain('<td>EUR</td>');
  expect(rendered).toContain('>X | Y</a>');
});

it('keeps an inline link inside a sentence', () => {
  expect(htmlToMarkdown('Read <a href="https://oecd.org/guide">the guide</a>.')).toBe(
    'Read [the guide](https://oecd.org/guide).',
  );
});

it('keeps a list marker around a paragraph and retains nested item order', () => {
  expect(
    htmlToMarkdown('<ul><li><p>Parent</p><ul><li>Child</li></ul></li><li>Next</li></ul>'),
  ).toBe('- Parent\n  - Child\n- Next');
});

it('retains paragraphs, list items, headers and empty cells of a supply table on both surfaces', () => {
  const description = htmlToMarkdown(
    '<p>The supply table.</p><ol><li>Read the guide</li><li>Choose a year</li></ol><table><tr><th></th><th>Industries</th><th>Households</th><th>Stocks</th><th>Imports</th><th>Environment</th><th>Total</th></tr><tr><td>Energy products</td><td>Output</td><td></td><td></td><td>Imports</td><td></td><td>Total supply</td></tr></table>',
  );
  expect(description).toContain('1. Read the guide\n2. Choose a year');
  expect(description).toContain('| Energy products | Output |  |  | Imports |  | Total supply |');
  const blocks = oecdGetDatasetInfo.format!({
    flow_ref: 'OECD,DF',
    dimensions: [],
    key_example: '',
    source: 'OECD',
    description,
  });
  const markdown = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const tokens = new MarkdownIt().parse(markdown, {});
  expect(tokens.filter((t) => t.type === 'list_item_open')).toHaveLength(2);
  const firstTable = tokens.slice(
    tokens.findIndex((t) => t.type === 'table_open'),
    tokens.findIndex((t) => t.type === 'table_close'),
  );
  expect(firstTable.filter((t) => t.type === 'th_open')).toHaveLength(7);
  expect(firstTable.filter((t) => t.type === 'td_open')).toHaveLength(7);
});
