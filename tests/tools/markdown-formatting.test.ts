/**
 * @fileoverview CommonMark round trips for upstream strings in tool output.
 * @module tests/tools/markdown-formatting.test
 */

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { oecdDataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { oecdDataframeDrop } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { oecdDataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { oecdGetDatasetInfo } from '@/mcp-server/tools/definitions/get-dataset-info.tool.js';
import { oecdGetDimensionValues } from '@/mcp-server/tools/definitions/get-dimension-values.tool.js';
import { oecdListAgencies } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { oecdQueryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { oecdSearchDatasets } from '@/mcp-server/tools/definitions/search-datasets.tool.js';
import { formatTable } from '@/utils/format-table.js';

const markdown = new MarkdownIt({ html: true });
const punctuation = 'A*B* [C](https://invalid.example) | <tag> &amp; `D` _E_ ~F~';
const multiline = `${punctuation}\n- next line\n`;

/** Read text nodes as a client does, rather than asserting encoded Markdown bytes. */
function textOf(blocks: readonly { type: string; text?: string }[]): string {
  const source = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return markdown
    .parse(source, {})
    .flatMap((token) => token.children ?? [token])
    .map((token) => {
      if (token.type === 'hardbreak' || token.type === 'softbreak') return '\n';
      return token.type === 'text' || token.type === 'code_inline' ? token.content : '';
    })
    .join('');
}

/** JSON blocks preserve multiline table cells without turning a line into a new row. */
function jsonTable(blocks: readonly { type: string; text?: string }[]): unknown {
  const source = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const fence = markdown.parse(source, {}).find((token) => token.type === 'fence');
  expect(fence?.info).toBe('json');
  return JSON.parse(fence?.content ?? 'null');
}

describe('upstream text rendering', () => {
  it('preserves all inline table cells through a Markdown parse', () => {
    const cells = markdown
      .parse(formatTable([punctuation], [[punctuation], ['last']]), {})
      .filter((token) => token.type === 'inline')
      .map((token) => token.children?.map((child) => child.content).join(''));
    expect(cells).toEqual([punctuation, punctuation, 'last']);
  });

  it('preserves every multiline cell and header in a JSON table', () => {
    expect(
      jsonTable([{ type: 'text', text: formatTable([multiline], [[multiline], ['last']]) }]),
    ).toEqual({
      columns: [multiline],
      rows: [[multiline], ['last']],
    });
  });

  it('renders every returned agency and directorate literally', () => {
    const blocks = oecdListAgencies.format!({
      agencies: [{ agency_id: punctuation, directorate: multiline, dataflow_count: 4 }],
      total_agencies: 1,
      total_dataflows: 4,
      source: 'OECD',
    });
    expect(jsonTable(blocks)).toEqual({
      columns: ['Agency', 'Directorate', 'Dataflows'],
      rows: [[punctuation, multiline, '4']],
    });
  });

  it('renders search identifiers, names, and descriptions literally', () => {
    const blocks = oecdSearchDatasets.format!({
      dataflows: [
        {
          flow_ref: punctuation,
          agency_id: punctuation,
          name: punctuation,
          description: multiline,
          matched_in: 'both',
          non_production: false,
        },
      ],
      result_count: 1,
      total_matches: 1,
      offset: 0,
      source: 'OECD',
    });
    const text = textOf(blocks);
    expect(text.split(punctuation)).toHaveLength(5);
    expect(text).toContain(multiline);
  });

  it('renders all dataset dimensions including the time dimension', () => {
    const blocks = oecdGetDatasetInfo.format!({
      flow_ref: punctuation,
      dimensions: [{ id: 'D', name: multiline, position: 1, codelist_ref: punctuation }],
      time_dimension: { id: 'T', name: punctuation, position: 2 },
      key_example: punctuation,
      non_production: false,
      source: 'OECD',
    });
    expect(jsonTable(blocks)).toEqual({
      columns: ['Pos', 'Dimension ID', 'Name', 'Codelist'],
      rows: [
        ['1', 'D', multiline, punctuation],
        ['2', 'T (time)', punctuation, '—'],
      ],
    });
    expect(textOf(blocks)).toContain(`Dataflow: ${punctuation}`);
    expect(textOf(blocks)).toContain(`Key example (all wildcards): ${punctuation}`);
  });

  it('renders every returned dimension code and label', () => {
    const blocks = oecdGetDimensionValues.format!({
      flow_ref: punctuation,
      dimension_id: punctuation,
      codes: [{ id: punctuation, name: multiline }],
      code_count: 1,
      source: 'OECD',
    });
    expect(jsonTable(blocks)).toEqual({
      columns: ['Code', 'Name'],
      rows: [[punctuation, multiline]],
    });
    expect(textOf(blocks)).toContain(`Dimension: ${punctuation}`);
  });

  it('renders every query observation in the existing preview with literal metadata', () => {
    const blocks = oecdQueryDataset.format!({
      rows: [
        { label: multiline, value: 2, source: 'OECD' },
        { label: 'last', value: 3, source: 'OECD' },
      ],
      row_count: 2,
      query_flow_ref: punctuation,
      query_key: punctuation,
      query_start_period: punctuation,
      query_end_period: punctuation,
      source: 'OECD',
    });
    expect(jsonTable(blocks)).toEqual({
      columns: ['label', 'value', 'source'],
      rows: [
        [multiline, '2', 'OECD'],
        ['last', '3', 'OECD'],
      ],
    });
    expect(textOf(blocks).split(punctuation)).toHaveLength(5);
  });

  it('renders each returned dataframe value without changing table selection', () => {
    const blocks = oecdDataframeQuery.format!({
      rows: [{ label: multiline }, { label: 'last' }],
      row_count: 2,
      column_names: ['label'],
    });
    expect(jsonTable(blocks)).toEqual({ columns: ['label'], rows: [[multiline], ['last']] });
  });

  it('renders the complete dataframe description literally', () => {
    const blocks = oecdDataframeDescribe.format!({
      canvas_id: punctuation,
      tables: [
        {
          name: punctuation,
          kind: 'table',
          row_count: 2,
          columns: [{ name: punctuation, type: 'VARCHAR' }],
        },
      ],
      table_count: 1,
    });
    expect(textOf(blocks).split(punctuation)).toHaveLength(4);
  });

  it('renders the dropped name and every remaining name literally', () => {
    const blocks = oecdDataframeDrop.format!({
      canvas_id: punctuation,
      table_name: punctuation,
      kind: 'table',
      remaining_tables: [punctuation, 'last'],
    });
    expect(textOf(blocks).split(punctuation)).toHaveLength(4);
    expect(textOf(blocks)).toContain('last');
  });
});
