/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Relay leg readers shared by the meet-results and event-results parsers.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  decodeHtmlEntities,
  extractListItems,
  htmlToText,
} from './html';
import { regexGroup } from './indexed';
import type { SwimCloudRelayLeg } from './entities';
import { swimmerIdFromCell } from './swimFields';

/** Trailing time on a relay-leg line, e.g. `Landon Dehn 23.41`. */
const TRAILING_TIME = /(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}\s*$/;

/**
 * A relay entry's printed designator, after the team name.
 *
 * **Two shapes.** The real pages print the letter in parentheses:
 * `Henderson State (A)`, from the `<span>` inside the team link on
 * `tests/fixtures/swimcloud-real-meet-event-401354-event22-relay-names.html`.
 * This reader used to accept only a quoted letter (`'A'`), a shape invented
 * alongside `swimcloud-synthetic-meet-results.html` before any real relay page
 * was captured, so it matched nothing a real page prints. The parenthesised form
 * is now read. The quoted form stays because that synthetic fixture and its test
 * still use it.
 *
 * Single letter only: a longer parenthetical is part of the team's name, not a
 * designator, and stays in it.
 */
const RELAY_DESIGNATOR = /^(.*?)\s*(?:['‘’"“”]\s*([A-Za-z])\s*['‘’"“”]?|\(\s*([A-Za-z])\s*\))\s*$/;

export function readRelayDesignator(text: string): { teamName: string; designator: string } | undefined {
  const match = RELAY_DESIGNATOR.exec(text);
  if (match === null) {
    return undefined;
  }
  const teamName = regexGroup(match, 1).trim();
  if (teamName.length === 0) {
    return undefined;
  }
  // The pattern's two arms each capture the letter in their own group, so one of
  // them always took part.
  const letter = match[2] ?? match[3];
  if (letter === undefined) {
    throw new Error(
      `SwimCloud parser invariant broken: relay designator pattern matched ${JSON.stringify(match[0])} without a letter.`,
    );
  }
  return { teamName, designator: letter.toUpperCase() };
}

/**
 * Read relay legs from a `<ol>`/`<ul>` inside the relay's subject cell.
 *
 * **The structure this reads is invented.** Whether SwimCloud publishes relay
 * legs at all — let alone as a list — is open question 4 in
 * `plans/2026-09-06/04-phasing.md`. An empty result is the expected outcome
 * until that is answered, and a `relay-legs-absent` warning says so out loud.
 *
 * A leg's split is read only when the line ends in a well-formed time. Splits
 * are never reconstructed by subtracting cumulative times: that arithmetic would
 * manufacture a competition value the page never published.
 */
/**
 * The relay's leg table, hidden behind the page's own "Show names" button.
 *
 * **Corrected 2026-09-22.** This file previously recorded that SwimCloud may
 * not publish relay legs at all, and raised `relay-legs-absent` on every relay
 * row to say so. That was wrong, and it was wrong because the legs are not
 * where the old reader looked. A real capture of `/results/356467/event/11/`
 * carries, inside the same cell as the team link:
 *
 *     <div class="u-is-hidden js-hidden-list">
 *       <table>
 *         <tr><td><a href="/results/356467/swimmer/1330318/">Avery Henke</a></td>
 *             <td><a href="/times/171561951/">22.53</a></td></tr>
 *         ... one row per leg, in leg order
 *
 * Name, swimmer id, split and swim id, all four, already served. The button is
 * a CSS toggle (`js-toggle-hidden-list`), not a request — so the data is in the
 * HTML a plain fetch returns. 25 distinct swimmer links appear on a page with
 * about 24 legs.
 *
 * The old `<li>` reader stays below it: nothing proves every relay row on every
 * page uses the table shape, and a list-shaped one must keep working. Splits
 * are still never reconstructed by subtracting cumulative times — that
 * arithmetic would manufacture a competition value the page never printed.
 */
/**
 * Every hidden relay-leg list in a table, in document order, parsed.
 *
 * One entry per `js-hidden-list` the table contains. The caller decides whether
 * the count lines up with its data rows; this function only reads what is
 * there.
 */
export function readHiddenLegListsInOrder(tableHtml: string): SwimCloudRelayLeg[][] {
  const out: SwimCloudRelayLeg[][] = [];
  let from = 0;
  for (;;) {
    const at = tableHtml.indexOf('js-hidden-list', from);
    if (at < 0) break;
    const next = tableHtml.indexOf('js-hidden-list', at + 1);
    const region = tableHtml.slice(at, next < 0 ? undefined : next);
    out.push(readRelayLegsFromHiddenTable(region));
    from = at + 1;
  }
  return out;
}

function readRelayLegsFromHiddenTable(rowHtml: string): SwimCloudRelayLeg[] {
  // Located by the page's own marker class, not by walking cells.
  // `extractRowCells` is not nesting-aware: the leg table's own <td>s end the
  // outer cell early, truncating it to a few hundred characters and losing
  // exactly the markup wanted here. Making that splitter nesting-aware would
  // change a helper every parser in this file leans on, for one caller.
  const listStart = rowHtml.indexOf('js-hidden-list');
  if (listStart < 0) return [];
  let region = rowHtml.slice(listStart);

  // A leg is one `<tr>`: its swimmer link and its own split link. Pairing by
  // row (not by position across the whole region) means a leg whose row lacks
  // a split link gets no split, instead of borrowing the next leg's time. The
  // region stops at the leg table's own `</table>` so the relay's total-time
  // link in the outer row is never read as a leg split.
  const tableEnd = region.indexOf('</table>');
  if (tableEnd >= 0) region = region.slice(0, tableEnd);
  const rows = region.split(/<tr(?=[\s>])/i).slice(1);
  if (rows.length === 0) return readRelayLegsPositionally(region);

  const legs: SwimCloudRelayLeg[] = [];
  for (const row of rows) {
    const swimmer = /href="[^"]*\/swimmer\/(\d+)\/?"[^>]*>([^<]*)</.exec(row);
    if (swimmer === null) continue;
    const split = /href="\/times\/(\d+)\/?"[^>]*>([^<]*)</.exec(row);
    legs.push(legFromLinks(legs.length + 1, swimmer, split));
  }
  return legs;
}

function legFromLinks(
  order: number,
  swimmer: RegExpExecArray,
  split: RegExpExecArray | null,
): SwimCloudRelayLeg {
  const athleteName = collapseWhitespace(decodeHtmlEntities(swimmer[2] ?? ''));
  const splitText = split === null ? '' : collapseWhitespace(decodeHtmlEntities(split[2] ?? ''));
  // Only a well-formed time counts as a split. Never reconstructed by
  // subtracting cumulative times: that would manufacture a competition value
  // the page never printed.
  const splitTime = TRAILING_TIME.test(splitText) ? splitText : undefined;
  return {
    order,
    ...(swimmer[1] === undefined ? {} : { swimCloudSwimmerId: swimmer[1] }),
    ...(athleteName.length === 0 ? {} : { athleteName }),
    ...(splitTime === undefined ? {} : { splitTime }),
    ...(split === null || split[1] === undefined ? {} : { swimCloudSwimId: split[1] }),
  };
}

/** Legacy shape: a region with no `<tr>` at all. Pairs swimmer and split links by position. */
function readRelayLegsPositionally(region: string): SwimCloudRelayLeg[] {
  const swimmers = [...region.matchAll(/href="[^"]*\/swimmer\/(\d+)\/?"[^>]*>([^<]*)</g)];
  const splits = [...region.matchAll(/href="\/times\/(\d+)\/?"[^>]*>([^<]*)</g)];
  const legs: SwimCloudRelayLeg[] = [];
  swimmers.forEach((swimmer, index) => {
    const split = splits[index] ?? null;
    const leg = legFromLinks(index + 1, swimmer, split);
    if (leg.athleteName === undefined && swimmer[1] === undefined) return;
    legs.push(leg);
  });
  return legs;
}

export function readRelayLegs(subjectHtml: string): SwimCloudRelayLeg[] {
  // The served shape first. Falls through to the list reader when the cell
  // holds no leg table, so a page that uses the older markup still parses.
  const fromTable = readRelayLegsFromHiddenTable(subjectHtml);
  if (fromTable.length > 0) return fromTable;

  const items = extractListItems(subjectHtml);
  const legs: SwimCloudRelayLeg[] = [];
  items.forEach((item, index) => {
    const text = htmlToText(item);
    if (text.length === 0) {
      return;
    }
    const timeMatch = TRAILING_TIME.exec(text);
    const splitTime = timeMatch === null ? undefined : timeMatch[0].trim();
    const athleteName =
      timeMatch === null ? text : collapseWhitespace(text.slice(0, timeMatch.index));
    const swimmerId = swimmerIdFromCell(item);
    legs.push({
      order: index + 1,
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      ...(athleteName.length === 0 ? {} : { athleteName }),
      ...(splitTime === undefined ? {} : { splitTime }),
    });
  });
  return legs;
}
