/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay-leg credits, read offline from two real SwimCloud captures.
 *
 * ## The two page types
 *
 * 1. **A swimmer's page inside one meet** — `/results/{meetId}/swimmer/{id}/`
 *    (capture: `tests/fixtures/swimcloud-real-meet-swimmer-399227-1355764-relay-anchor.html`).
 *    One row per swim of that swimmer at that meet. Three kinds of row exist:
 *    an ordinary individual swim (`50 Free`, round `Timed Finals`), an
 *    **extracted split** (`50 Fly`, round `Extracted`: half of a 100 Fly, not a
 *    race the swimmer started), and a **relay leg** (`200 MED-R (Anchor)`, the
 *    leg's own split, linked `/times/{id}/`, with the relay's place).
 *    {@link parseMeetSwimmerCreditsHtml} reads it.
 * 2. **A relay event page** — `/results/{meetId}/event/{n}/`
 *    (capture: `tests/fixtures/swimcloud-real-meet-event-401354-event22-relay-names.html`).
 *    Each relay row hides a "Show names" list of four legs. The leg reader is
 *    the one that already lives in `parser.ts` (`parseMeetEventResultsHtml`);
 *    this file adds no second HTML reader for that page.
 *    {@link readRelayEventEntries} reshapes its output into relay entries and
 *    raises what that parser leaves silent (a relay row with no legs).
 *
 * ## Rules this file keeps (CLAUDE.md, "Data provenance")
 *
 * - **Absent stays absent.** A leg word that is not `Leadoff` or `Anchor`
 *   keeps its printed text and gets no `legIndex`. A relay row with no leg word
 *   gets neither. A missing place stays missing. No default is written.
 * - **An extracted split is never a swim.** It lands in `extractedSplits`, with
 *   `seedEligible: false`. It must not become a seed, a personal best or an
 *   entry. (Same ruling as `HistoricalSwim.isExtractedSplit` in core.)
 * - **Join on SwimCloud ids only.** {@link joinRelayCreditsToEventEntries}
 *   matches a credit to a leg on the leg's `/times/{id}/` id, then checks the
 *   swimmer id, the meet and the event. It never matches on name plus time.
 * - **Fail loudly.** A row with an unreadable time, a missing `/times/` link or
 *   a label that fits no known shape is skipped with a warning, and the row
 *   count on the result shows the gap. A page with no table fails.
 *
 * ## What is not proven
 *
 * The two captures are from different meets. That the `/times/{id}/` id on a
 * swimmer's relay credit equals the id on the matching leg of the event page is
 * therefore a premise (SwimCloud uses one swim-id space on both), not something
 * a capture here demonstrates. The join test uses a synthetic pair for that
 * reason. Treat the first live join as the proof.
 *
 * Pure: no network, no DOM, no clock.
 */

import { collapseWhitespace, decodeHtmlEntities, extractTableRows, findTables, htmlToText, stripNonContent } from './html';
import type { SwimCloudRelayLeg } from './entities';
import { fail, parseMeetEventResultsHtml, succeed } from './parser';
import type {
  SwimCloudMeetEventResultsParse,
  SwimCloudMeetEventResultsParseOptions,
  SwimCloudParseContext,
  SwimCloudParseResult,
  SwimCloudParseWarning,
} from './parser';
import { classifySwimCloudUrl } from './urlClassifier';

const REAL_CAPTURE = 'real-capture-verified' as const;
const TIME_TOKEN = /^(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}$/;
/**
 * The real relay team cell prints the letter in parentheses: `Henderson State (A)`.
 * (`readRelayDesignator` in `parser.ts` reads this shape too since 2026-10-09; it
 * first accepted only a quoted letter, written before any real relay page was
 * captured.)
 */
const RELAY_LETTER = /^(.*?)\s*\(([A-Za-z])\)\s*$/;
const ORDINAL = /^(\d+)\s*(?:st|nd|rd|th)$/i;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Fields every row of a swimmer-in-meet page carries. */
interface SwimCloudMeetSwimmerRowBase {
  /** 0-based index of the data row in the page's table. */
  readonly rowIndex: number;
  readonly meetId: string;
  readonly swimmerId: string;
  /** The event label exactly as printed, whitespace collapsed: `'200 MED-R (Anchor)'`. */
  readonly eventLabel: string;
  /** `n` of the row's `/results/{meetId}/event/{n}/` link. */
  readonly eventRef: string;
  /** The round text printed beside the event (`'Timed Finals'`, `'Extracted'`). Absent when none was printed. */
  readonly round?: string;
  /** The time as printed. Validated against the time shape; never reconstructed. */
  readonly time: string;
  /** The `/times/{id}/` id of this row's time link. */
  readonly swimCloudSwimId: string;
  /** `{meetId}:swim:{swimCloudSwimId}`: the same key shape the event and swims-list parsers build. */
  readonly swimKey: string;
  /** Place printed in the Place/Lane cell. For a relay leg this is the relay's place. Absent when the cell was empty. */
  readonly place?: number;
}

/** An individual swim: started from the blocks, the swimmer's own race. */
export interface SwimCloudMeetIndividualSwim extends SwimCloudMeetSwimmerRowBase {
  readonly kind: 'individual';
}

/**
 * A split extracted from a longer swim (round printed `Extracted`).
 *
 * Not a race the swimmer started. `seedEligible` is the literal `false`: no
 * consumer may seed, rank, cut-tag or enter on it.
 */
export interface SwimCloudMeetExtractedSplit extends SwimCloudMeetSwimmerRowBase {
  readonly kind: 'extracted-split';
  readonly seedEligible: false;
}

/** The leg words this parser maps to a leg number. Nothing else is mapped. */
export type SwimCloudRelayLegWord = 'Leadoff' | 'Anchor';

/**
 * One relay leg credited to a swimmer on that swimmer's page.
 *
 * `time` is the leg split as printed. A leg that is not the leadoff starts
 * with a flying takeover, so it is **not** an individual swim from a start.
 */
export interface SwimCloudRelayLegCredit extends SwimCloudMeetSwimmerRowBase {
  readonly kind: 'relay-leg';
  /** The relay event without the leg word: `'200 MED-R'`. This is the label as printed, not a normalized event name. */
  readonly relayEvent: string;
  /**
   * The meet's own title for this event, read from the event menu of the same
   * capture: the `title` of the `c-events__link-body` inside the
   * `/results/{meetId}/event/{eventRef}/` link (`'200 Medley Relay Men'`).
   * Absent when the menu has no entry for `eventRef`, or has two entries that
   * disagree. The abbreviation in `relayEvent` (`MED-R`) is never expanded in
   * code: a leg's distance and stroke are read from this title or not at all.
   */
  readonly relayEventTitle?: string;
  /** The word in parentheses, verbatim (`'Anchor'`, `'Leadoff'`, or any other text SwimCloud prints). Absent when the label had none. */
  readonly legLabel?: string;
  /**
   * 1 for `Leadoff`, 4 for `Anchor`, absent for every other word and for a row
   * with no word. Never inferred from the event or the time.
   */
  readonly legIndex?: 1 | 4;
  /**
   * True only when the page says leadoff: the label word `Leadoff`, or a
   * `title="Leadoff"` chip in the Flags cell. False means "not stated as a
   * leadoff", not "stated to be a later leg".
   */
  readonly isLeadoff: boolean;
}

export type SwimCloudMeetSwimmerRow =
  | SwimCloudMeetIndividualSwim
  | SwimCloudMeetExtractedSplit
  | SwimCloudRelayLegCredit;

/** What {@link parseMeetSwimmerCreditsHtml} returns. */
export interface SwimCloudMeetSwimmerCredits {
  readonly meetId: string;
  readonly swimmerId: string;
  /** From the page's swimmer heading link. Absent when not found. */
  readonly swimmerName?: string;
  /** From the `/results/{meetId}/team/{id}/` link under the heading. Absent when not found. */
  readonly teamId?: string;
  readonly teamName?: string;
  /** Data rows seen, including any skipped with a warning. `individualSwims + extractedSplits + relayLegs` may be fewer. */
  readonly rowCount: number;
  readonly individualSwims: readonly SwimCloudMeetIndividualSwim[];
  readonly extractedSplits: readonly SwimCloudMeetExtractedSplit[];
  readonly relayLegs: readonly SwimCloudRelayLegCredit[];
}

/** One relay entry of a relay event page. */
export interface SwimCloudRelayEventEntry {
  readonly meetId: string;
  readonly eventRef: string;
  /** The round caption of the table the entry sat in (`'Timed Finals'`). Absent when none. */
  readonly round?: string;
  /** The team cell as printed: `'Henderson State (A)'`. */
  readonly printedName: string;
  /** From the team cell's `/team/{id}/` link. Absent when none. */
  readonly teamId?: string;
  /** `printedName` without the relay letter. Absent when the cell had no letter. */
  readonly teamName?: string;
  /** The relay letter (`'A'`, `'B'`). Absent when the page printed none. Never defaulted to `'A'`. */
  readonly relayLetter?: string;
  readonly place?: number;
  /** The relay's total time as printed. */
  readonly finalTime?: string;
  /** Meet points from the Score column. Absent when the round has none. */
  readonly score?: number;
  /** The `/times/{id}/` id of the relay's total time. */
  readonly swimCloudSwimId?: string;
  /** Legs in the order the hidden list printed them. `swimCloudSwimId` on a leg is its `/times/{id}/`. */
  readonly legs: readonly SwimCloudRelayLeg[];
}

/** What {@link readRelayEventEntries} returns. */
export interface SwimCloudRelayEventPage {
  readonly meetId: string;
  readonly eventRef: string;
  readonly eventLabel?: string;
  readonly entries: readonly SwimCloudRelayEventEntry[];
}

/* -------------------------------------------------------------------------- */
/* Small readers                                                               */
/* -------------------------------------------------------------------------- */

function attr(tagAttrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagAttrs);
  if (match === null) return undefined;
  return decodeHtmlEntities(match[2] ?? match[3] ?? '');
}

function colspanOf(tagAttrs: string): number {
  const raw = attr(tagAttrs, 'colspan');
  const n = raw === undefined ? 1 : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

interface Cell {
  readonly column: number;
  readonly attrs: string;
  readonly inner: string;
}

function cellsOf(rowHtml: string, tag: 'td' | 'th'): Cell[] {
  const cells: Cell[] = [];
  let column = 0;
  for (const m of rowHtml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi'))) {
    cells.push({ column, attrs: m[1] ?? '', inner: m[2] ?? '' });
    column += colspanOf(m[1] ?? '');
  }
  return cells;
}

function firstLink(html: string, pattern: RegExp): { id: string; text: string; tag: string } | undefined {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1] ?? '', 'href');
    if (href === undefined) continue;
    const hit = pattern.exec(href);
    if (hit !== null && hit[1] !== undefined) {
      return { id: hit[1], text: htmlToText(m[2] ?? ''), tag: m[1] ?? '' };
    }
  }
  return undefined;
}

const TIMES_LINK = /^\/times\/(\d+)\/?$/;
const EVENT_LINK = /^\/results\/(\d+)\/event\/(\d+)\/?(?:[?#].*)?$/;

function warn(
  warnings: SwimCloudParseWarning[],
  code: SwimCloudParseWarning['code'],
  message: string,
  rowIndex: number,
  raw?: string,
): void {
  warnings.push({ code, message, rowIndex, ...(raw === undefined ? {} : { raw }) });
}

/* -------------------------------------------------------------------------- */
/* Swimmer-in-meet page                                                        */
/* -------------------------------------------------------------------------- */

/** The swimmer link inside a heading element. The avatar link before it prints initials, not a name. */
function headingSwimmerLink(content: string): { id: string; text: string; tag: string } | undefined {
  for (const m of content.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    const link = firstLink(m[1] ?? '', /^\/swimmer\/(\d+)\/?$/);
    if (link !== undefined) return link;
  }
  return undefined;
}

const REQUIRED_TITLES = ['Event', 'Time', 'Place/Lane'] as const;

/** A relay label ends in `-R` (`200 MED-R`) or says Relay. */
function isRelayLabel(base: string): boolean {
  return /-R$/i.test(base) || /\brelay\b/i.test(base);
}

interface LabelParts {
  readonly base: string;
  readonly word?: string;
}

function splitLabel(label: string): LabelParts {
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(label);
  if (m === null) return { base: label };
  const word = collapseWhitespace(m[2] ?? '');
  return word.length === 0 ? { base: collapseWhitespace(m[1] ?? '') } : { base: collapseWhitespace(m[1] ?? ''), word };
}

function legIndexOf(word: string | undefined): 1 | 4 | undefined {
  if (word === undefined) return undefined;
  const w = word.toLowerCase();
  if (w === 'leadoff') return 1;
  if (w === 'anchor') return 4;
  return undefined;
}

interface HeaderMap {
  readonly event: number;
  readonly time: number;
  readonly place: number;
  readonly flags?: number;
}

function readHeaderMap(headerRow: string): HeaderMap | undefined {
  const byTitle = new Map<string, number>();
  for (const cell of cellsOf(headerRow, 'th')) {
    const title = attr(cell.attrs, 'title');
    if (title !== undefined && !byTitle.has(title)) byTitle.set(title, cell.column);
  }
  const [event, time, place] = REQUIRED_TITLES.map((title) => byTitle.get(title));
  if (event === undefined || time === undefined || place === undefined) return undefined;
  const flags = byTitle.get('Flags');
  return { event, time, place, ...(flags === undefined ? {} : { flags }) };
}

interface RowContext {
  readonly meetId: string;
  readonly swimmerId: string;
  readonly rowIndex: number;
  readonly warnings: SwimCloudParseWarning[];
  /** `eventRef` to the event menu's title for it. See {@link readEventMenuTitles}. */
  readonly eventTitles: ReadonlyMap<string, string>;
}

/**
 * The event menu of a meet page: `eventRef` to the title SwimCloud prints for
 * it (`c-events__link-body` `title`, on the `/results/{meetId}/event/{n}/` link).
 *
 * The menu can print twice on a page (a desktop and a mobile list). A ref whose
 * entries print different titles is left out, because choosing one would be a
 * guess. Only links of this meet are read. A page with no menu gives an empty
 * map, and every credit then keeps `relayEventTitle` absent.
 */
function readEventMenuTitles(content: string, meetId: string): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  const ambiguous = new Set<string>();
  const wanted = new RegExp(`^/results/${meetId}/event/(\\d+)/?$`);
  for (const m of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1] ?? '', 'href');
    const hit = href === undefined ? null : wanted.exec(href);
    if (hit === null || !/\bc-events__link\b/.test(attr(m[1] ?? '', 'class') ?? '')) continue;
    const eventRef = hit[1] ?? '';
    for (const div of (m[2] ?? '').matchAll(/<div\b([^>]*)>/gi)) {
      if (!/\bc-events__link-body\b/.test(attr(div[1] ?? '', 'class') ?? '')) continue;
      const title = collapseWhitespace(attr(div[1] ?? '', 'title') ?? '');
      if (title.length === 0) break;
      const seen = titles.get(eventRef);
      if (seen !== undefined && seen !== title) ambiguous.add(eventRef);
      else titles.set(eventRef, title);
      break;
    }
  }
  for (const eventRef of ambiguous) titles.delete(eventRef);
  return titles;
}

function readPlace(cell: Cell | undefined, ctx: RowContext): number | undefined {
  if (cell === undefined) return undefined;
  const text = htmlToText(cell.inner);
  if (text.length === 0) return undefined;
  const hit = ORDINAL.exec(text);
  if (hit === null) {
    warn(ctx.warnings, 'unrecognized-place-token', `Place cell ${JSON.stringify(text)} is not an ordinal; place left absent.`, ctx.rowIndex, text);
    return undefined;
  }
  return Number.parseInt(hit[1] ?? '', 10);
}

function readRow(
  cells: readonly Cell[],
  map: HeaderMap,
  ctx: RowContext,
): SwimCloudMeetSwimmerRow | undefined {
  const at = (column: number | undefined): Cell | undefined =>
    column === undefined ? undefined : cells.find((c) => c.column === column);
  const eventCell = at(map.event);
  const timeCell = at(map.time);
  if (eventCell === undefined || timeCell === undefined) {
    warn(ctx.warnings, 'unparsed-row', 'Row lacks its Event or Time cell and was skipped.', ctx.rowIndex);
    return undefined;
  }

  const eventLink = firstLink(eventCell.inner, EVENT_LINK);
  const eventHref = eventLink === undefined ? undefined : attr(eventLink.tag, 'href');
  const eventHit = eventHref === undefined ? null : EVENT_LINK.exec(eventHref);
  if (eventLink === undefined || eventHit === null) {
    warn(ctx.warnings, 'unparsed-row', 'Event cell carries no /results/{meetId}/event/{n}/ link; row skipped.', ctx.rowIndex);
    return undefined;
  }
  const eventLabel = eventLink.text;
  const roundText = /class="[^"]*rf-swimmer-times__table-event-round[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(eventCell.inner);
  const round = roundText === null ? '' : htmlToText(roundText[1] ?? '');

  const timeLink = firstLink(timeCell.inner, TIMES_LINK);
  if (timeLink === undefined) {
    warn(ctx.warnings, 'missing-swim-link', `Row ${JSON.stringify(eventLabel)} has no /times/{id}/ link; skipped, because it cannot be joined or keyed.`, ctx.rowIndex, eventLabel);
    return undefined;
  }
  if (!TIME_TOKEN.test(timeLink.text)) {
    warn(ctx.warnings, 'unrecognized-time-token', `Time ${JSON.stringify(timeLink.text)} on ${JSON.stringify(eventLabel)} is not a time; row skipped, nothing recorded.`, ctx.rowIndex, timeLink.text);
    return undefined;
  }

  const flagsText = at(map.flags)?.inner ?? '';
  const flagTitles = [...flagsText.matchAll(/\btitle\s*=\s*"([^"]*)"/gi)].map((m) => decodeHtmlEntities(m[1] ?? ''));
  const place = readPlace(at(map.place), ctx);

  const base: SwimCloudMeetSwimmerRowBase = {
    rowIndex: ctx.rowIndex,
    meetId: ctx.meetId,
    swimmerId: ctx.swimmerId,
    eventLabel,
    eventRef: eventHit[2] ?? '',
    ...(round.length === 0 ? {} : { round }),
    time: timeLink.text,
    swimCloudSwimId: timeLink.id,
    swimKey: `${ctx.meetId}:swim:${timeLink.id}`,
    ...(place === undefined ? {} : { place }),
  };

  if (round === 'Extracted' || flagTitles.includes('Extracted')) {
    return { ...base, kind: 'extracted-split', seedEligible: false };
  }
  const { base: relayEvent, word } = splitLabel(eventLabel);
  if (isRelayLabel(relayEvent)) {
    const legIndex = legIndexOf(word);
    const relayEventTitle = ctx.eventTitles.get(base.eventRef);
    return {
      ...base,
      kind: 'relay-leg',
      relayEvent,
      ...(relayEventTitle === undefined ? {} : { relayEventTitle }),
      ...(word === undefined ? {} : { legLabel: word }),
      ...(legIndex === undefined ? {} : { legIndex }),
      isLeadoff: legIndex === 1 || flagTitles.includes('Leadoff'),
    };
  }
  if (word !== undefined) {
    warn(ctx.warnings, 'unrecognized-event-label', `Label ${JSON.stringify(eventLabel)} has a parenthetical but is not a relay label; row skipped.`, ctx.rowIndex, eventLabel);
    return undefined;
  }
  return { ...base, kind: 'individual' };
}

/**
 * Parse `/results/{meetId}/swimmer/{id}/`: one swimmer's swims at one meet,
 * relay-leg credits included.
 *
 * The capture URL must classify as a `meetSwimmer` resource; its ids are the
 * ids of every row. A heading link that names another swimmer fails the parse.
 */
export function parseMeetSwimmerCreditsHtml(
  html: string,
  context: SwimCloudParseContext,
): SwimCloudParseResult<SwimCloudMeetSwimmerCredits> {
  if (html.trim().length === 0) return fail(context, 'empty-input', 'The HTML input is empty.');
  const classification = classifySwimCloudUrl(context.sourceUrl);
  if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetSwimmer') {
    return fail(context, 'source-url-mismatch', `Source URL ${context.sourceUrl} is not /results/{meetId}/swimmer/{id}/.`, [], REAL_CAPTURE);
  }
  const { meetId, swimmerId } = classification.resource;
  const content = stripNonContent(html);

  const heading = headingSwimmerLink(content);
  if (heading !== undefined && heading.id !== swimmerId) {
    return fail(context, 'source-url-mismatch', `Source URL names swimmer ${swimmerId} but the page heading links swimmer ${heading.id}.`, [], REAL_CAPTURE);
  }
  const teamLink = firstLink(content, new RegExp(`^/results/${meetId}/team/(\\d+)/?$`));

  const warnings: SwimCloudParseWarning[] = [];
  const eventTitles = readEventMenuTitles(content, meetId);
  const individualSwims: SwimCloudMeetIndividualSwim[] = [];
  const extractedSplits: SwimCloudMeetExtractedSplit[] = [];
  const relayLegs: SwimCloudRelayLegCredit[] = [];
  let rowCount = 0;
  let tablesRead = 0;

  for (const table of findTables(content)) {
    const rows = extractTableRows(table.html);
    const headerRow = rows.find((row) => /<th\b/i.test(row));
    const map = headerRow === undefined ? undefined : readHeaderMap(headerRow);
    if (map === undefined) continue;
    tablesRead += 1;
    for (const row of rows.filter((r) => !/<th\b/i.test(r))) {
      const parsed = readRow(cellsOf(row, 'td'), map, { meetId, swimmerId, rowIndex: rowCount, warnings, eventTitles });
      rowCount += 1;
      if (parsed === undefined) continue;
      if (parsed.kind === 'individual') individualSwims.push(parsed);
      else if (parsed.kind === 'extracted-split') extractedSplits.push(parsed);
      else relayLegs.push(parsed);
    }
  }

  if (tablesRead === 0) {
    return fail(context, 'expected-table-missing', 'No table with Event, Time and Place/Lane column titles was found.', [], REAL_CAPTURE);
  }
  if (rowCount === 0) {
    warnings.push({ code: 'zero-data-rows', message: 'The swims table has a header and no data rows. That is an answer ("no swims on this page"), not a parse of anything.' });
  }
  const data: SwimCloudMeetSwimmerCredits = {
    meetId,
    swimmerId,
    ...(heading === undefined || heading.text.length === 0 ? {} : { swimmerName: heading.text }),
    ...(teamLink === undefined ? {} : { teamId: teamLink.id }),
    ...(teamLink === undefined || teamLink.text.length === 0 ? {} : { teamName: teamLink.text }),
    rowCount,
    individualSwims,
    extractedSplits,
    relayLegs,
  };
  return succeed(context, data, warnings, REAL_CAPTURE);
}

/* -------------------------------------------------------------------------- */
/* Relay event page                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reshape a parsed per-event page into relay entries.
 *
 * Reads the output of `parseMeetEventResultsHtml`; it does not read HTML. Adds
 * what that parser leaves silent: a relay row with no legs raises
 * `relay-legs-absent`, and a relay whose leg count is not four raises
 * `relay-leg-count-unexpected`. A page whose event is not a relay fails with
 * `not-a-relay-event`. A parse failure passes through unchanged.
 */
export function readRelayEventEntries(
  parsed: SwimCloudParseResult<SwimCloudMeetEventResultsParse>,
): SwimCloudParseResult<SwimCloudRelayEventPage> {
  if (!parsed.ok) return parsed;
  const page = parsed.data;
  const context: SwimCloudParseContext = {
    sourceUrl: parsed.provenance.sourceUrl,
    retrievedAt: parsed.provenance.retrievedAt,
    track: parsed.provenance.track,
    ...(parsed.provenance.sha256 === undefined ? {} : { sha256: parsed.provenance.sha256 }),
  };
  if (page.event.kind !== 'relay') {
    return fail(context, 'not-a-relay-event', `Event ${page.event.eventId} (${page.event.label}) is not a relay event.`, parsed.warnings, REAL_CAPTURE);
  }

  const warnings: SwimCloudParseWarning[] = [...parsed.warnings];
  const entries: SwimCloudRelayEventEntry[] = [];
  for (const round of page.rounds) {
    round.swims.forEach((swim, rowIndex) => {
      const printedName = swim.entry.athleteName ?? '';
      const letter = RELAY_LETTER.exec(printedName);
      const teamName = letter === null ? '' : collapseWhitespace(letter[1] ?? '');
      const legs = swim.relayLegs ?? [];
      if (legs.length === 0) {
        warnings.push({
          code: 'relay-legs-absent',
          message: `Relay ${JSON.stringify(printedName)} has no legs on this page (no hidden "Show names" list). It is not an empty relay.`,
          eventId: page.event.eventId,
          rowIndex,
          raw: printedName,
        });
      } else if (legs.length !== 4) {
        warnings.push({
          code: 'relay-leg-count-unexpected',
          message: `Relay ${JSON.stringify(printedName)} lists ${legs.length} legs, not 4. The legs read are kept as printed.`,
          eventId: page.event.eventId,
          rowIndex,
          raw: printedName,
        });
      }
      entries.push({
        meetId: page.swimCloudMeetId,
        eventRef: page.eventRef,
        ...(round.round === undefined ? {} : { round: round.round }),
        printedName,
        ...(swim.entry.swimCloudTeamId === undefined ? {} : { teamId: swim.entry.swimCloudTeamId }),
        ...(letter === null || teamName.length === 0 ? {} : { teamName, relayLetter: (letter[2] ?? '').toUpperCase() }),
        ...(swim.result.place === undefined ? {} : { place: swim.result.place }),
        ...(swim.result.finalTime === undefined ? {} : { finalTime: swim.result.finalTime }),
        ...(swim.meetScore === undefined ? {} : { score: swim.meetScore }),
        ...(swim.swimCloudSwimId === undefined ? {} : { swimCloudSwimId: swim.swimCloudSwimId }),
        legs,
      });
    });
  }
  if (entries.length === 0) {
    warnings.push({ code: 'zero-data-rows', message: `Relay event ${page.event.eventId} parsed with no relay entries.`, eventId: page.event.eventId });
  }
  const data: SwimCloudRelayEventPage = {
    meetId: page.swimCloudMeetId,
    eventRef: page.eventRef,
    ...(page.eventLabel === undefined ? {} : { eventLabel: page.eventLabel }),
    entries,
  };
  return succeed(context, data, warnings, REAL_CAPTURE);
}

/** `parseMeetEventResultsHtml` then {@link readRelayEventEntries}. */
export function parseRelayEventEntriesHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetEventResultsParseOptions = {},
): SwimCloudParseResult<SwimCloudRelayEventPage> {
  return readRelayEventEntries(parseMeetEventResultsHtml(html, context, options));
}

/* -------------------------------------------------------------------------- */
/* Join                                                                        */
/* -------------------------------------------------------------------------- */

export type SwimCloudRelayCreditConflictReason =
  /** The ids match but the meet or event differs. */
  | 'meet-or-event-differs'
  /** The `/times/` id matches a leg whose swimmer id is another swimmer. */
  | 'swimmer-id-differs'
  /** The credit says Leadoff (1) or Anchor (4) and the leg sits at another position. */
  | 'leg-position-differs';

export interface SwimCloudRelayCreditMatch {
  readonly credit: SwimCloudRelayLegCredit;
  readonly entry: SwimCloudRelayEventEntry;
  readonly leg: SwimCloudRelayLeg;
}

export interface SwimCloudRelayCreditJoin {
  readonly matched: readonly SwimCloudRelayCreditMatch[];
  /** Credits whose `/times/` id appears on no leg of this page. Not an error: the credit may belong to another event. */
  readonly unmatchedCredits: readonly SwimCloudRelayLegCredit[];
  /** Ids matched but something else disagreed. Not joined. */
  readonly conflicts: readonly (SwimCloudRelayCreditMatch & { readonly reason: SwimCloudRelayCreditConflictReason })[];
}

/**
 * The position a credit states: the leg word's `legIndex`, else 1 when the page
 * flagged the row Leadoff (the Flags chip can say so with no leg word). Absent
 * when the page stated neither. `isLeadoff: false` states nothing.
 */
function statedPositionOf(credit: SwimCloudRelayLegCredit): 1 | 4 | undefined {
  return credit.legIndex ?? (credit.isLeadoff ? 1 : undefined);
}

/**
 * Join swimmer relay credits to the legs of one relay event page.
 *
 * Key: the credit's `swimCloudSwimId` equals the leg's `swimCloudSwimId`
 * (`/times/{id}/`). Then three checks: same swimmer id, same meet and event,
 * and (when the credit names Leadoff or Anchor, by leg word or by the Leadoff
 * flag) the same position. A failed
 * check puts the pair in `conflicts` and never in `matched`. Name and time are
 * not consulted.
 */
export function joinRelayCreditsToEventEntries(
  credits: readonly SwimCloudRelayLegCredit[],
  page: SwimCloudRelayEventPage,
): SwimCloudRelayCreditJoin {
  const matched: SwimCloudRelayCreditMatch[] = [];
  const conflicts: Array<SwimCloudRelayCreditMatch & { reason: SwimCloudRelayCreditConflictReason }> = [];
  const unmatchedCredits: SwimCloudRelayLegCredit[] = [];
  for (const credit of credits) {
    let found = false;
    for (const entry of page.entries) {
      const leg = entry.legs.find((l) => l.swimCloudSwimId !== undefined && l.swimCloudSwimId === credit.swimCloudSwimId);
      if (leg === undefined) continue;
      found = true;
      const pair = { credit, entry, leg };
      if (credit.meetId !== page.meetId || credit.eventRef !== page.eventRef) {
        conflicts.push({ ...pair, reason: 'meet-or-event-differs' });
      } else if (leg.swimCloudSwimmerId !== credit.swimmerId) {
        conflicts.push({ ...pair, reason: 'swimmer-id-differs' });
      } else if (statedPositionOf(credit) !== undefined && statedPositionOf(credit) !== leg.order) {
        conflicts.push({ ...pair, reason: 'leg-position-differs' });
      } else {
        matched.push(pair);
      }
      break;
    }
    if (!found) unmatchedCredits.push(credit);
  }
  return { matched, unmatchedCredits, conflicts };
}
