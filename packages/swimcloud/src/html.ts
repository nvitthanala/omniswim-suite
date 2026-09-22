/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal HTML text extraction, implemented with string and regular-expression
 * operations only.
 *
 * ## Why there is no HTML parser here
 *
 * This package has **zero runtime dependencies** and does not use the DOM. That
 * is deliberate and it is a scope decision, not an oversight:
 *
 * - Choosing an HTML parser (cheerio? jsdom? the extension's own live
 *   `document`?) is an integration decision that belongs to the phase that
 *   actually wires in a live source, not to the phase that defines the contract.
 * - Both access tracks can produce a **string**: Track A's content script has
 *   `document.documentElement.outerHTML`, Track B's Playwright has
 *   `page.content()`. A string is the one input shape both can supply without
 *   either one dictating a parser to the other
 *   (`plans/2026-09-06/03-architecture.md` §1.3 requires the parser to be
 *   shared by both tracks and to have no idea which produced its input).
 *
 * ## Known limits of regex extraction
 *
 * These are stated rather than hidden, because they are the reason the parser
 * that uses them reports `confidence: 'synthetic-fixture-only'`:
 *
 * - Tag matching is textual. A `<` inside an attribute value, or a tag broken
 *   across a CDATA-ish construct, will confuse it.
 * - {@link findTables} tracks `<table>` nesting with a stack and so survives
 *   nested tables, but {@link extractTableRows} **removes nested tables before
 *   splitting rows**, so content that lives inside a nested table is dropped
 *   from the outer table's cells.
 * - Optional end tags (`<tr>` without `</tr>`) are tolerated by ending an
 *   element at the next sibling's start tag, which is right for `tr`/`td`/`th`
 *   and would be wrong for a general parser.
 *
 * If a real captured page defeats any of this, the fix is to introduce a real
 * parser at the integration boundary — not to bolt more regexes on here.
 */

/* -------------------------------------------------------------------------- */
/* Entities                                                                    */
/* -------------------------------------------------------------------------- */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  ccedil: 'ç',
  eacute: 'é',
  aacute: 'á',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
};

const ENTITY = /&(#[Xx][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

/**
 * Decode the HTML entities that appear in athlete names and meet titles.
 *
 * Single pass, so `&amp;lt;` decodes to the literal text `&lt;` rather than to
 * `<` — double decoding would silently rewrite a name.
 *
 * An entity this function does not know is **left exactly as written**. That is
 * the honest outcome: a mangled name is visible to a human reviewing an import
 * preview, whereas a name silently emptied by an over-eager strip is not.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
        return whole;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/* -------------------------------------------------------------------------- */
/* Tag stripping                                                               */
/* -------------------------------------------------------------------------- */

const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG = /<\/?[A-Za-z][^>]*>/g;

/** Remove comments and `<script>`/`<style>` blocks, contents included. */
export function stripNonContent(html: string): string {
  return html.replace(COMMENT, ' ').replace(SCRIPT_OR_STYLE, ' ');
}

/**
 * Replace every tag with a single space.
 *
 * A space, not the empty string: collapsing `<td>Alice</td><td>Smith</td>`
 * without a separator would produce `AliceSmith`, and a fabricated name is
 * exactly the failure mode this package exists to avoid.
 */
export function stripHtmlTags(html: string): string {
  return html.replace(ANY_TAG, ' ');
}

/** Collapse all whitespace runs (including `&nbsp;`) to single spaces and trim. */
export function collapseWhitespace(text: string): string {
  // The second character in the class is a literal U+00A0. `\s` already matches
  // it in JavaScript, so it is redundant -- but it is deliberate and documented
  // above, and this parser's whole job is HTML whitespace. Kept rather than
  // silently narrowed to satisfy a linter.
  // eslint-disable-next-line no-irregular-whitespace
  return text.replace(/[\s ]+/g, ' ').trim();
}

/**
 * Full HTML fragment → plain text: drop comments/scripts/styles, drop tags,
 * decode entities, collapse whitespace.
 *
 * Returns `''` for a fragment with no text. Callers must treat `''` as "this
 * cell was blank", never as a value.
 */
export function htmlToText(html: string): string {
  return collapseWhitespace(decodeHtmlEntities(stripHtmlTags(stripNonContent(html))));
}

/**
 * Remove whole elements (start tag through matching end tag) by tag name,
 * nesting-aware.
 *
 * Used to lift a relay's leg list out of a team cell before reading the team
 * name, so the name does not absorb the leg swimmers' names.
 */
export function stripElements(html: string, tagNames: readonly string[]): string {
  let out = html;
  for (const tag of tagNames) {
    out = removeNested(out, tag);
  }
  return out;
}

function removeNested(html: string, tag: string): string {
  return spliceOutSpans(html, findElementSpans(html, tag));
}

/**
 * Cut the given spans out of `source`, replacing each with a space.
 *
 * Spans nested inside an earlier span are skipped, so a pair is never removed
 * twice and offsets stay valid.
 */
function spliceOutSpans(source: string, spans: readonly HtmlElementSpan[]): string {
  if (spans.length === 0) {
    return source;
  }
  let out = '';
  let index = 0;
  let cursor = -1;
  for (const span of spans) {
    if (span.start < cursor) {
      continue;
    }
    out += source.slice(index, span.start);
    out += ' ';
    index = span.end;
    cursor = span.end;
  }
  out += source.slice(index);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Element spans                                                               */
/* -------------------------------------------------------------------------- */

/** A located element, with its full source text and its position in the input. */
export interface HtmlElementSpan {
  /** The element's full source, start tag through end tag. */
  readonly html: string;
  /** The element's content, between the start and end tags. */
  readonly inner: string;
  /** Index of the `<` of the start tag. */
  readonly start: number;
  /** Index just past the `>` of the end tag. */
  readonly end: number;
}

function tagPattern(tag: string): RegExp {
  return new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
}

/**
 * Find every element with the given tag name, nesting-aware, in document order
 * (outermost first, since an outer element's start tag precedes its children's).
 *
 * An unbalanced start tag with no matching end tag is **discarded**, not closed
 * at end-of-input: a silently invented element boundary would produce a
 * plausible-looking table that does not exist on the page.
 */
export function findElementSpans(html: string, tag: string): HtmlElementSpan[] {
  const pattern = tagPattern(tag);
  const stack: Array<{ start: number; contentStart: number }> = [];
  const found: Array<{ start: number; contentStart: number; contentEnd: number; end: number }> = [];

  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const isClose = match[1] === '/';
    const start = match.index;
    const after = start + match[0].length;
    if (isClose) {
      const open = stack.pop();
      if (open !== undefined) {
        found.push({ start: open.start, contentStart: open.contentStart, contentEnd: start, end: after });
      }
      continue;
    }
    // A self-closing `<table/>` is not a thing worth modelling; treat every
    // non-close tag as an opener.
    stack.push({ start, contentStart: after });
  }

  found.sort((a, b) => a.start - b.start);
  return found.map((span) => ({
    html: html.slice(span.start, span.end),
    inner: html.slice(span.contentStart, span.contentEnd),
    start: span.start,
    end: span.end,
  }));
}

/**
 * Every `<table>` in the fragment, nesting-aware, outermost first.
 *
 * Positions are returned so a caller can associate a table with the heading that
 * precedes it — which is how meet-results pages tie an event title to its
 * results table.
 */
export function findTables(html: string): HtmlElementSpan[] {
  return findElementSpans(stripNonContent(html), 'table');
}

/** Every heading (`<h1>`–`<h6>`) with its text and position, in document order. */
export interface HtmlHeading {
  readonly level: number;
  readonly text: string;
  readonly start: number;
}

const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;

/** Find every `<h1>`–`<h6>` and return its decoded text and position. */
export function findHeadings(html: string): HtmlHeading[] {
  const cleaned = stripNonContent(html);
  const headings: HtmlHeading[] = [];
  HEADING.lastIndex = 0;
  for (let match = HEADING.exec(cleaned); match !== null; match = HEADING.exec(cleaned)) {
    headings.push({
      level: Number.parseInt(match[1], 10),
      text: htmlToText(match[2]),
      start: match.index,
    });
  }
  HEADING.lastIndex = 0;
  return headings;
}

/* -------------------------------------------------------------------------- */
/* Rows and cells                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Split a table's source into row fragments (the inner HTML of each `<tr>`).
 *
 * Nested tables are removed first, so a row of an inner table is never mistaken
 * for a row of the outer one. A `<tr>` with no `</tr>` ends at the next `<tr>`
 * or at the end of the table.
 */
export function extractTableRows(tableHtml: string): string[] {
  const flattened = removeNestedTablesFromTableBody(tableHtml);
  return splitRepeatedElements(flattened, ['tr']);
}

/**
 * Split a row fragment into cell fragments (the inner HTML of each `<td>`/`<th>`).
 *
 * Inner HTML, not text: a caller that needs the text calls {@link htmlToText},
 * and a caller that needs a link or a nested list (relay legs) still has the
 * markup to work with.
 */
export function extractRowCells(rowHtml: string): string[] {
  return splitRepeatedElements(rowHtml, ['td', 'th']);
}


/** True when the row's cells are `<th>` — used to find a table's header row. */
export function isHeaderRow(rowHtml: string): boolean {
  return /<th\b/i.test(rowHtml);
}

function removeNestedTablesFromTableBody(tableHtml: string): string {
  const spans = findElementSpans(tableHtml, 'table');
  // When the caller passed a full `<table>…</table>`, the first span is that
  // table; its inner text is the body to work on. Re-scanning that body finds
  // only genuinely nested tables, with offsets already relative to it.
  const body = spans.length > 0 ? spans[0].inner : tableHtml;
  return spliceOutSpans(body, findElementSpans(body, 'table'));
}

/**
 * Split a fragment on repeated sibling elements whose end tag may be omitted.
 *
 * Correct for `tr`/`td`/`th`, which cannot nest inside themselves.
 */
function splitRepeatedElements(html: string, tagNames: readonly string[]): string[] {
  const alternation = tagNames.join('|');
  const opener = new RegExp(`<(${alternation})\\b[^>]*>`, 'gi');
  const starts: Array<{ contentStart: number; tag: string }> = [];
  for (let match = opener.exec(html); match !== null; match = opener.exec(html)) {
    starts.push({ contentStart: match.index + match[0].length, tag: match[1].toLowerCase() });
  }
  if (starts.length === 0) {
    return [];
  }

  const results: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const limit = index + 1 < starts.length ? starts[index + 1].contentStart : html.length;
    const slice = html.slice(current.contentStart, limit);
    const closer = new RegExp(`</${current.tag}\\s*>`, 'i');
    const closeAt = closer.exec(slice);
    results.push(closeAt === null ? trimTrailingOpenTag(slice) : slice.slice(0, closeAt.index));
  }
  return results;
}

/** Drop a trailing start tag left behind when an end tag was omitted. */
function trimTrailingOpenTag(slice: string): string {
  return slice.replace(/<[A-Za-z][^>]*>\s*$/, '');
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

const HREF = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/**
 * Every `href` value in the fragment, in document order, entity-decoded.
 *
 * Used to recover SwimCloud ids from a roster or results row — the row's link to
 * `/swimmer/{id}/` is a far more reliable identifier than the printed name,
 * which is exactly the ambiguity `suggestAliasCandidates` exists to handle.
 */
export function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  HREF.lastIndex = 0;
  for (let match = HREF.exec(html); match !== null; match = HREF.exec(html)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined && value.length > 0) {
      hrefs.push(decodeHtmlEntities(value));
    }
  }
  HREF.lastIndex = 0;
  return hrefs;
}

/** Every `<li>` fragment (inner HTML) inside the given fragment. */
export function extractListItems(html: string): string[] {
  return findElementSpans(html, 'li').map((span) => span.inner);
}
