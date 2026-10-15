/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Low-level element and attribute readers shared by the SwimCloud page parsers.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import { decodeHtmlEntities, findHeadings, htmlToText } from './html';
import { regexGroup } from './indexed';
import { SWIMCLOUD_CANONICAL_HOST } from './urlClassifier';

export function firstHeadingText(html: string): string | undefined {
  const headings = findHeadings(html);
  for (const heading of headings) {
    if (heading.level === 1 && heading.text.length > 0) {
      return heading.text;
    }
  }
  return undefined;
}

/* ---- Attribute and element helpers ---------------------------------------- */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The start tag of an element's full source, `<` through the first `>`. */
export function startTagOf(elementHtml: string): string {
  const end = elementHtml.indexOf('>');
  return end < 0 ? elementHtml : elementHtml.slice(0, end + 1);
}

/**
 * Read one attribute's value out of a start tag.
 *
 * The name must be preceded by whitespace or the tag's own start. That is not
 * fussiness: without it, `\bid` also matches inside `data-meet-id`, and a
 * lookup for `id` would return the wrong element's identifier. Same trap with
 * `title` inside `data-original-title`, which the improvement column uses on
 * every row of a real results table.
 */
export function readAttribute(tagHtml: string, name: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const match = pattern.exec(tagHtml);
  if (match === null) {
    return undefined;
  }
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

/** The `class` attribute split into tokens. Empty when there is no class. */
export function classTokens(tagHtml: string): string[] {
  const value = readAttribute(tagHtml, 'class');
  return value === undefined ? [] : value.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * The text of the **leaf** element carrying the given `id`.
 *
 * Leaf-only by design, and sufficient: the three elements this is used for
 * (`meet-name`, `meet-date`, `meet-course`) hold text and nothing else on every
 * real capture. It reads to the first matching end tag, so an element of the
 * same tag nested inside would end it early — which is why it is not offered as
 * a general-purpose selector.
 */
export function elementTextById(html: string, id: string): string | undefined {
  const pattern = new RegExp(
    `<([A-Za-z][A-Za-z0-9]*)\\b[^>]*\\sid\\s*=\\s*["']?${escapeRegExp(id)}["'\\s>]`,
    'i',
  );
  const match = pattern.exec(html);
  if (match === null) {
    return undefined;
  }
  const tag = regexGroup(match, 1).toLowerCase();
  const startEnd = html.indexOf('>', match.index);
  if (startEnd < 0) {
    return undefined;
  }
  const close = html.toLowerCase().indexOf(`</${tag}`, startEnd);
  if (close < 0) {
    return undefined;
  }
  const text = htmlToText(html.slice(startEnd + 1, close));
  return text.length === 0 ? undefined : text;
}

/** One query parameter of an href, resolved against the canonical host so a site-relative link works. */
export function readQueryParam(href: string, name: string): string | undefined {
  try {
    const url = new URL(href, `https://${SWIMCLOUD_CANONICAL_HOST}`);
    const value = url.searchParams.get(name);
    return value === null || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}
