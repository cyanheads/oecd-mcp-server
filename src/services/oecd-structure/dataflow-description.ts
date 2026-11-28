/**
 * @fileoverview Preserve the structure and links in OECD dataflow descriptions.
 * @module services/oecd-structure/dataflow-description
 */

/**
 * Named character references that appear in OECD dataflow descriptions, plus the
 * partners of the ones that do (`lt`, `mdash`). Numeric references do not occur
 * in the catalog and are left alone.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  deg: '°',
  eacute: 'é',
  gt: '>',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  ocirc: 'ô',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
  uuml: 'ü',
};

/** Inline formatting tags whose removal should not insert a synthetic word break. */
const INLINE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'cite',
  'code',
  'em',
  'font',
  'i',
  'mark',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
]);

/** Elements whose contents are stripped along with their tags. */
const IGNORED_BLOCK_TAGS = new Set(['head', 'script', 'style']);

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiAlpha(code) || (code >= 48 && code <= 57);
}

function isAsciiSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** Whether `<` at `ltIndex` opens a tag, closing tag, comment, doctype, or PI rather than literal `< 5`. */
function isHtmlTagOpener(html: string, ltIndex: number): boolean {
  if (ltIndex + 1 >= html.length) return false;
  const next = html.charCodeAt(ltIndex + 1);
  return isAsciiAlpha(next) || next === 47 || next === 33 || next === 63;
}

/** Decode the named HTML entities OECD descriptions use. */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&([a-zA-Z]+);/g,
    (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match,
  );
}

/** Collapse all runs of whitespace to single spaces and trim edges. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Read an ASCII tag name starting at `from`, lowercased, plus the index after it. */
function readAsciiTagName(
  html: string,
  from: number,
  limit: number,
): { end: number; name: string } {
  let i = from;
  while (i < limit && isAsciiAlnum(html.charCodeAt(i))) i++;
  return { end: i, name: html.slice(from, i).toLowerCase() };
}

/**
 * Scan forward from `from` for a matching closing block tag (`</head>`,
 * `</style>`, `</script>`), returning the index right after its `>` or `-1` if
 * unclosed. Single-pass linear scan.
 */
function findClosingBlockTag(html: string, from: number, tagName: string): number {
  const len = html.length;
  let pos = from;
  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt < 0 || lt + 2 + tagName.length >= len) return -1;
    if (html.charCodeAt(lt + 1) === 47) {
      let matches = true;
      for (let k = 0; k < tagName.length; k++) {
        const ch = html.charCodeAt(lt + 2 + k);
        const lower = ch >= 65 && ch <= 90 ? ch + 32 : ch;
        if (lower !== tagName.charCodeAt(k)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        let j = lt + 2 + tagName.length;
        while (j < len && isAsciiSpace(html.charCodeAt(j))) j++;
        if (j < len && html.charCodeAt(j) === 62) return j + 1;
      }
    }
    pos = lt + 1;
  }
  return -1;
}

/**
 * Extract the `href` attribute value from the attribute slice of an `<a ...>`
 * tag. Handles double-quoted, single-quoted, and unquoted values, whitespace
 * around `=`, attributes before `href`, and HTML entities inside `href`.
 */
function extractAnchorHref(attrs: string): string | undefined {
  const len = attrs.length;
  let i = 0;
  while (i < len) {
    while (i < len && isAsciiSpace(attrs.charCodeAt(i))) i++;
    if (i >= len || attrs.charCodeAt(i) === 47) break;

    const nameStart = i;
    while (i < len) {
      const c = attrs.charCodeAt(i);
      if (isAsciiSpace(c) || c === 61 || c === 47) break;
      i++;
    }
    const name = attrs.slice(nameStart, i).toLowerCase();

    while (i < len && isAsciiSpace(attrs.charCodeAt(i))) i++;
    if (i >= len || attrs.charCodeAt(i) !== 61) continue;
    i++; // '='
    while (i < len && isAsciiSpace(attrs.charCodeAt(i))) i++;
    if (i >= len) break;

    let rawValue: string;
    const quote = attrs.charCodeAt(i);
    if (quote === 34 || quote === 39) {
      const valueStart = i + 1;
      const close = attrs.indexOf(quote === 34 ? '"' : "'", valueStart);
      if (close < 0) {
        rawValue = attrs.slice(valueStart);
        i = len;
      } else {
        rawValue = attrs.slice(valueStart, close);
        i = close + 1;
      }
    } else {
      const valueStart = i;
      while (i < len && !isAsciiSpace(attrs.charCodeAt(i))) i++;
      rawValue = attrs.slice(valueStart, i);
    }

    if (name === 'href') return decodeHtmlEntities(rawValue).trim();
  }
  return;
}

/** Validate an `http:` or `https:` URL with no line breaks. */
export function isHttpUrl(url: string): boolean {
  if (/[\r\n]/.test(url)) return false;
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

/** Percent-encode characters that break CommonMark link destinations. */
function encodeLinkUrlChars(value: string): string {
  return value.replace(/[\s()<>]/g, (ch) => {
    switch (ch) {
      case '(':
        return '%28';
      case ')':
        return '%29';
      case '<':
        return '%3C';
      case '>':
        return '%3E';
      default:
        return '%20';
    }
  });
}

/**
 * Normalize an anchor `href` into a CommonMark-safe `http:`, `https:`, or
 * `mailto:` destination, or `undefined` when empty or using another scheme.
 */
function normalizeAnchorHref(rawHref: string | undefined): string | undefined {
  if (!rawHref) return;
  const trimmed = rawHref.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return;

  if (/^mailto:/i.test(trimmed)) {
    const recipient = trimmed.slice(7).trim();
    if (!recipient || /\s/.test(recipient)) return;
    return `mailto:${encodeLinkUrlChars(recipient)}`;
  }

  const encoded = encodeLinkUrlChars(trimmed);
  return isHttpUrl(encoded) ? encoded : undefined;
}

/**
 * Find the `>` closing a tag whose name starts at `start`, where `lastGt` is
 * the input's last `>` and lies at or after `start`. A quote opens a quoted
 * attribute value only right after `=`, as in the HTML tokenizer; anywhere
 * else it is a literal character. A quoted value that runs past a `>` and then
 * a tag opener is read as a broken quote (OECD descriptions carry typographic
 * closing quotes, as in `href="…FDI”>Portal</a>`), so the tag ends at the
 * first `>` after the quote. Linear: each quoted value's scan stops at its
 * closing quote or that tag opener, and the tag consumes what it scanned.
 */
function findTagClose(html: string, start: number, lastGt: number): number {
  let at: 'name' | 'valueStart' | 'unquotedValue' = 'name';
  for (let p = start; p < lastGt; p++) {
    const ch = html.charCodeAt(p);
    if (ch === 62) return p; // `>`
    if (at === 'valueStart' && (ch === 34 || ch === 39)) {
      const close = html.indexOf(ch === 34 ? '"' : "'", p + 1);
      if (close < 0 || close > lastGt || crossesTagEnd(html, p + 1, close)) {
        return html.indexOf('>', p + 1);
      }
      p = close;
      at = 'name';
    } else if (isAsciiSpace(ch)) {
      if (at === 'unquotedValue') at = 'name';
    } else if (at === 'valueStart') {
      at = 'unquotedValue';
    } else if (at === 'name' && ch === 61) {
      at = 'valueStart'; // `=`
    }
  }
  return lastGt;
}

/** Whether `[from, end)` holds a `>` followed by a tag opener (see {@link isHtmlTagOpener}). */
function crossesTagEnd(html: string, from: number, end: number): boolean {
  let gtSeen = false;
  for (let k = from; k < end; k++) {
    const ch = html.charCodeAt(k);
    if (ch === 62) gtSeen = true;
    else if (gtSeen && ch === 60 && isHtmlTagOpener(html, k)) return true;
  }
  return false;
}

/**
 * Index just past the end of the comment whose `<!--` starts at `lt`, or -1
 * when it never closes. As in the HTML tokenizer, `-->` may reuse the opener's
 * dashes (`<!-->`, `<!--->`), while `--!>` needs both dashes after the opener.
 */
function commentEnd(html: string, lt: number): number {
  for (let k = html.indexOf('--', lt + 2); k >= 0; k = html.indexOf('--', k + 1)) {
    if (html.charCodeAt(k + 2) === 62) return k + 3;
    if (k >= lt + 4 && html.startsWith('!>', k + 2)) return k + 4;
  }
  return -1;
}

/**
 * Single-pass linear-time HTML scanner powering both {@link stripHtml} and
 * {@link htmlToMarkdown}. Strips `<head>`, `<style>`, and `<script>` blocks
 * including their contents, preserves bare `<` comparisons (e.g. `< 3 months`),
 * decodes `HTML_ENTITIES` on text runs only so decoded `&lt;` can never form a
 * tag, and optionally turns valid `<a>` elements into Markdown `[label](url)`.
 */
function scanHtml(html: string, preserveLinks: boolean): string {
  const len = html.length;
  const lastGt = html.lastIndexOf('>');
  const out: string[] = [];
  const lines: string[] = [];
  const listCounters: Array<number | undefined> = [];
  let prefix = '';
  let paragraph = false;
  let cells: string[] | undefined;
  let cellOpen = false;
  let heading = false;
  let firstRow = true;
  let anchor: { chunks: string[]; href: string | undefined } | null = null;
  let i = 0;

  const pushText = (raw: string) => {
    if (!raw) return;
    const decoded = decodeHtmlEntities(raw);
    if (anchor) anchor.chunks.push(decoded);
    else out.push(decoded);
  };

  const pushSpace = () => {
    if (anchor) anchor.chunks.push(' ');
    else out.push(' ');
  };

  const flushAnchorAsPlainText = () => {
    if (!anchor) return;
    for (const chunk of anchor.chunks) out.push(chunk);
    anchor = null;
  };

  function takeText(): string {
    flushAnchorAsPlainText();
    const value = collapseWhitespace(out.join(''));
    out.length = 0;
    return value;
  }

  function line(text: string): void {
    if (paragraph && lines.length) lines.push('');
    lines.push(text);
    paragraph = false;
  }

  function endLine(): void {
    const value = takeText();
    if (value) {
      line(prefix + value);
      prefix = '';
    }
  }

  function endCell(): void {
    if (!cells || !cellOpen) return;
    cells.push(takeText().replace(/[\\|]/g, '\\$&'));
    cellOpen = false;
  }

  function endRow(): void {
    if (!cells) return;
    endCell();
    if (cells.length) {
      const row = `| ${cells.join(' | ')} |`;
      if (firstRow) {
        line(heading ? row : `| ${cells.map(() => '').join(' | ')} |`);
        line(`| ${cells.map(() => '---').join(' | ')} |`);
      }
      if (!firstRow || !heading) line(row);
      firstRow = false;
    }
    cells = undefined;
  }

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    // A bare `<` followed by a digit or space (e.g. "< 3 months", "<6 months") is text.
    if (!isHtmlTagOpener(html, lt)) {
      pushText('<');
      i = lt + 1;
      continue;
    }

    // No closing `>` anywhere past this point: emit remainder literally in O(1).
    if (lt >= lastGt) {
      pushText(html.slice(lt));
      break;
    }

    const next = html.charCodeAt(lt + 1);
    // Comments (an unclosed one runs to the end), doctypes, and processing instructions (`<!DOCTYPE`, `<?...`)
    if (next === 33 || next === 63) {
      pushSpace();
      if (next === 33 && html.startsWith('<!--', lt)) {
        const end = commentEnd(html, lt);
        if (end < 0) break;
        i = end;
      } else {
        i = html.indexOf('>', lt + 1) + 1;
      }
      continue;
    }

    const isClosing = next === 47;
    const nameStart = isClosing ? lt + 2 : lt + 1;
    const gt = findTagClose(html, nameStart, lastGt);
    const { end: nameEnd, name: tagName } = readAsciiTagName(html, nameStart, gt);
    const beforeSlash = gt - 2 >= nameEnd ? html.charCodeAt(gt - 2) : -1;
    // Unquoted attribute values can end in `/` (e.g. `<a href=https://oecd.org/x/>`),
    // so only a standalone `/` (after tag name, whitespace, or a closing quote) self-closes.
    const selfClosing =
      !isClosing &&
      gt > nameEnd &&
      html.charCodeAt(gt - 1) === 47 &&
      (gt - 1 === nameEnd || isAsciiSpace(beforeSlash) || beforeSlash === 34 || beforeSlash === 39);

    // Skip `<head>...</head>`, `<style>...</style>`, and `<script>...</script>` in full.
    if (!isClosing && !selfClosing && IGNORED_BLOCK_TAGS.has(tagName)) {
      const closeEnd = findClosingBlockTag(html, gt + 1, tagName);
      pushSpace();
      if (closeEnd < 0) break;
      i = closeEnd;
      continue;
    }

    if (preserveLinks && tagName === 'a') {
      if (isClosing) {
        if (anchor) {
          const label = collapseWhitespace(anchor.chunks.join(''));
          if (anchor.href !== undefined && label.length > 0) {
            const escapedLabel = label.replace(/[\\[\]]/g, '\\$&');
            if (out.at(-1)?.endsWith('!')) out.push(' ');
            const destination = cells ? anchor.href.replaceAll('|', '%7C') : anchor.href;
            out.push(`[${escapedLabel}](${destination})`);
          } else if (label.length > 0) {
            out.push(label);
          }
          anchor = null;
        }
      } else {
        // An unclosed outer `<a>` or a malformed `<a/>` flushes any open anchor as plain text.
        flushAnchorAsPlainText();
        if (!selfClosing) {
          const rawHref = extractAnchorHref(html.slice(nameEnd, gt));
          anchor = { chunks: [], href: normalizeAnchorHref(rawHref) };
        }
      }
      i = gt + 1;
      continue;
    }

    if (tagName === 'table') {
      endRow();
      endLine();
      paragraph = true;
      firstRow = true;
    } else if (tagName === 'tr') {
      endRow();
      if (!isClosing) {
        endLine();
        cells = [];
        heading = false;
      }
    } else if ((tagName === 'th' || tagName === 'td') && cells) {
      endCell();
      if (!isClosing) {
        heading ||= tagName === 'th';
        cellOpen = true;
      }
    } else if (cells) {
      if (!INLINE_HTML_TAGS.has(tagName)) pushSpace();
    } else if (tagName === 'ul' || tagName === 'ol') {
      endLine();
      if (isClosing) listCounters.pop();
      else listCounters.push(tagName === 'ol' ? 0 : undefined);
      if (!listCounters.length || (!isClosing && listCounters.length === 1)) paragraph = true;
    } else if (tagName === 'li') {
      endLine();
      prefix = '';
      if (!isClosing) {
        const index = listCounters.length - 1;
        const count = listCounters[index];
        if (count !== undefined) listCounters[index] = count + 1;
        const marker = count === undefined ? '-' : `${count + 1}.`;
        prefix = `${'  '.repeat(Math.max(0, index))}${marker} `;
      }
    } else if (tagName === 'p' || tagName === 'br') {
      const previous = lines.length;
      endLine();
      if (!listCounters.length && (tagName === 'p' || previous === lines.length)) paragraph = true;
    } else if (!INLINE_HTML_TAGS.has(tagName)) {
      pushSpace();
    }
    i = gt + 1;
  }

  endRow();
  endLine();
  return lines.join('\n');
}

/**
 * Reduce an OECD description to plain text. Strips `<head>`, `<style>`, and
 * `<script>` blocks including their contents, strips remaining HTML tags, and
 * resolves the named entities OECD uses.
 */
export function stripHtml(html: string): string {
  return scanHtml(html, false);
}

/**
 * Convert an OECD HTML dataflow description to Markdown-safe plain text in
 * linear time, stripping `<head>`, `<style>`, and `<script>` blocks and
 * preserving valid `http:`, `https:`, and `mailto:` anchors as `[label](url)`.
 */
export function htmlToMarkdown(html: string): string {
  return scanHtml(html, true);
}
