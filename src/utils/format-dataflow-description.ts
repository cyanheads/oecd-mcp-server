/**
 * @fileoverview Render OECD abstract blocks and links on the Markdown tool surface.
 * @module utils/format-dataflow-description
 */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Render only the table separators produced for an HTML row. */
function formatRow(line: string): string {
  const cells: string[] = [];
  let cell = '';
  const contents = line.slice(2, -2);
  for (let i = 0; i < contents.length; i++) {
    const char = contents[i];
    const next = contents[i + 1];
    if (char === '\\' && (next === '\\' || next === '|')) {
      cell += next;
      i++;
    } else if (char === ' ' && contents.startsWith(' | ', i)) {
      cells.push(formatInline(cell));
      cell = '';
      i += 2;
    } else {
      cell += char;
    }
  }
  cells.push(formatInline(cell));
  return `| ${cells.join(' | ')} |`;
}

/** Keep table columns and list items separate while escaping the text in each. */
export function formatDataflowDescription(text: string): string {
  if (!text.includes('\n\n') && !/^(?:\| | *(?:-|[0-9]+\.) )/m.test(text))
    return formatInline(text);
  const lines = text.split('\n');
  let table = false;
  return lines
    .map((line, index) => {
      if (table && /^\|(?: --- \|)+$/.test(line)) return line;
      if (line.startsWith('| ') && line.endsWith(' |')) {
        if (table || /^\|(?: --- \|)+$/.test(lines[index + 1] ?? '')) {
          table = true;
          return formatRow(line);
        }
      }
      table = false;
      const list = /^( *(?:-|\d+\.) )/.exec(line);
      if (list) return list[0] + formatInline(line.slice(list[0].length));
      return formatInline(line);
    })
    .join('\n');
}

/** Whether a Markdown link destination uses an allowed scheme (`http:`, `https:`, or `mailto:`). */
function isAllowedDescriptionUrl(url: string): boolean {
  if (!url || /[\s<>()]/.test(url)) return false;
  if (/^mailto:/i.test(url)) return url.length > 7;
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * Escape a prose run adjacent to a link without turning internal spaces at
 * link boundaries into `&#32;`, while still escaping line-start and line-end
 * edges and a trailing `!` before `[label](url)` (which would form an image).
 */
function escapeProseChunk(
  text: string,
  atStart: boolean,
  atEnd: boolean,
  beforeLink: boolean,
): string {
  if (!text) return '';
  let lead = '';
  let core = text;
  let trail = '';
  if (!atStart) {
    let s = 0;
    while (s < core.length && core[s] === ' ') s++;
    lead = core.slice(0, s);
    core = core.slice(s);
  }
  if (!atEnd) {
    let e = core.length;
    while (e > 0 && core[e - 1] === ' ') e--;
    trail = core.slice(e);
    core = core.slice(0, e);
  }
  let escaped = core ? escapeMarkdownInline(core) : '';
  if (beforeLink && trail === '' && escaped.endsWith('!')) {
    escaped = `${escaped.slice(0, -1)}\\!`;
  }
  return `${lead}${escaped}${trail}`;
}

/**
 * Render a dataflow description for `content[]` in linear time: valid
 * `[label](url)` links (`http:`, `https:`, `mailto:`) stay clickable Markdown
 * links with escaped labels, while surrounding prose is escaped via
 * {@link escapeMarkdownInline} so upstream punctuation never corrupts into
 * unintended emphasis, raw HTML, headings, or unsafe links.
 */
function formatInline(text: string): string {
  const tokens: Array<
    { kind: 'link'; label: string; url: string } | { kind: 'prose'; value: string }
  > = [];
  const len = text.length;
  let proseStart = 0;
  let i = 0;

  const pushProse = (end: number) => {
    if (end > proseStart) tokens.push({ kind: 'prose', value: text.slice(proseStart, end) });
  };

  while (i < len) {
    const open = text.indexOf('[', i);
    if (open < 0) break;

    // Scan label linearly; an unescaped nested `[` invalidates the outer candidate.
    let j = open + 1;
    let nestedOpen = -1;
    let closeBracket = -1;
    while (j < len) {
      const ch = text[j];
      if (ch === '\\' && j + 1 < len) {
        j += 2;
        continue;
      }
      if (ch === '[') {
        nestedOpen = j;
        break;
      }
      if (ch === ']') {
        closeBracket = j;
        break;
      }
      j++;
    }

    if (nestedOpen >= 0) {
      i = nestedOpen;
      continue;
    }
    if (closeBracket < 0) break;

    if (text[closeBracket + 1] !== '(') {
      i = closeBracket + 1;
      continue;
    }

    // Scan URL linearly; stop early on whitespace or disallowed chars.
    let k = closeBracket + 2;
    let closeParen = -1;
    while (k < len) {
      const ch = text[k];
      if (ch === ')') {
        closeParen = k;
        break;
      }
      if (ch === '(' || ch === '<' || ch === '>' || /\s/.test(ch ?? '')) break;
      k++;
    }

    if (closeParen < 0) {
      i = closeBracket + 1;
      continue;
    }

    const url = text.slice(closeBracket + 2, closeParen);
    const rawLabel = text.slice(open + 1, closeBracket).replace(/\\([\\[\]])/g, '$1');
    if (!rawLabel || !isAllowedDescriptionUrl(url)) {
      i = closeBracket + 1;
      continue;
    }

    pushProse(open);
    tokens.push({ kind: 'link', label: rawLabel, url });
    proseStart = closeParen + 1;
    i = closeParen + 1;
  }

  pushProse(len);

  return tokens
    .map((tok, idx) => {
      if (tok.kind === 'link') {
        return `[${escapeMarkdownInline(tok.label)}](${tok.url})`;
      }
      const nextIsLink = tokens[idx + 1]?.kind === 'link';
      return escapeProseChunk(tok.value, idx === 0, idx === tokens.length - 1, nextIsLink);
    })
    .join('');
}
