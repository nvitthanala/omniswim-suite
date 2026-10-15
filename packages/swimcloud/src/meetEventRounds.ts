/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Event-results round tables: locate, read and assemble the swims of each round.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractHrefs,
  extractRowCells,
  extractTableRows,
  findElementSpans,
  htmlToText,
  isHeaderRow,
  stripElements,
} from './html';
import { itemAt } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type { HtmlElementSpan } from './html';
import type {
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudMeetId,
  SwimCloudRelayLeg,
  SwimCloudResult,
  SwimCloudResultFlags,
  SwimCloudSwimmerId,
  SwimCloudTeamId,
} from './entities';
import type { SwimCloudParseWarning } from './parseResult';
import { readAttribute, startTagOf } from './parseElements';
import {
  readFlagsCell,
  readOrdinalPlace,
  readPoints,
  readTime,
  swimmerIdFromCell,
  teamIdFromCell,
} from './swimFields';
import type { ReadTime, SwimCloudCutStandardLabel } from './swimFields';
import {
  NAME_HEADERS,
  SWIMS_POINTS_HEADERS,
  SWIMS_SCORE_HEADERS,
  SWIMS_TIME_HEADERS,
  TEAM_HEADERS,
  cellAt,
  columnFor,
  normalizeHeader,
  readHeaderColumns,
  subjectCellIndex,
  textAt,
} from './parseCells';
import type { SwimsHeaderColumn } from './parseCells';
import { readHiddenLegListsInOrder } from './relayLegs';

/**
 * Which points column a round's table actually carried.
 *
 * The two are different quantities and the real capture prints both, on
 * different tables of the same page:
 *
 * - `'score'` — the **real meet points** the swim earned. A/B Final tables
 *   carry this (`20/17/16/15/14/13/12/11` for A Final's eight places,
 *   `9/7/6/5/4/3/2` for B Final's seven). This is the first page type in this
 *   pipeline that publishes meet points for an individual swim.
 * - `'pts'` — SwimCloud's **power index** (`title="Swimcloud Points"`), a
 *   0-1000-ish rating of how fast a swim is. C Final and Preliminaries tables
 *   carry this, consistent with those rounds not scoring at this meet.
 * - `'none'` — the table had neither header. Recorded rather than inferred: a
 *   caller must be able to tell "this round published no points" from "this
 *   round published zero".
 *
 * Both columns sit in a `u-is-hidden` cell — CSS-hidden on the rendered page,
 * fully present in the markup. That class is not consulted anywhere in this
 * parser: a hidden cell is read exactly like any other cell, by its header.
 */
export type SwimCloudEventRoundPointsColumn = 'score' | 'pts' | 'none';

/** One row of a per-event results table: one swim of one round. */
export interface SwimCloudMeetEventSwim {
  /**
   * `{meetId}:swim:{swimCloudSwimId}` — deliberately the *same* key shape
   * {@link SwimCloudTeamMeetSwim.swimKey} builds, because that is what makes
   * the two page types joinable at all. A swim that appears on both a team's
   * swims list and its event's results page carries one SwimCloud swim id, so
   * one key, on both.
   *
   * Falls back to a composite of the row's own printed values when the time
   * cell carried no swim link (`missing-swim-link`). The fallback invents
   * nothing, but it will not join against the swims list — see
   * `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` for what that costs.
   */
  readonly swimKey: string;
  /** SwimCloud's own id for this swim, from the time cell's `/times/{id}/` link. Absent when the row carried no such link. */
  readonly swimCloudSwimId?: string;
  /**
   * The relay's legs, when this row is a relay entry and the page served them.
   *
   * A per-event results page carries them in a table hidden behind its own
   * "Show names" toggle, inside the same cell as the team link — name, swimmer
   * id, split and swim id per leg, in leg order. The toggle is CSS, not a
   * request, so a plain fetch already has them.
   *
   * Absent on an individual row, and on a relay row whose page did not serve
   * them. Absent is never an empty relay.
   */
  readonly relayLegs?: readonly SwimCloudRelayLeg[];
  /**
   * The round this swim was contested in, **verbatim** from the owning table's
   * `<caption>` — `'A Final'`, `'B Final'`, `'C Final'`, `'Preliminaries'`.
   *
   * Not mapped to a tier here. `packages/core`'s `classifyRoundTier` already
   * owns that vocabulary and reads these exact strings correctly, so mapping
   * them here would be a second, divergent copy of a classifier this repo
   * already has. Absent when the table carried no caption — see
   * `'missing-round-caption'`.
   */
  readonly roundLabel?: string;
  readonly entry: SwimCloudEntry;
  readonly result: SwimCloudResult;
  /**
   * The swim was marked **exhibition**, read from the rank cell.
   *
   * Mirrors `result.flags.exhibition`, always a boolean, so a caller never has
   * to distinguish `false` from "the flags object was absent". See
   * {@link readEventRankCell} for the marker this is read from, and why it is
   * not the leading-`X`-on-a-time-token convention {@link readTime} guesses at.
   */
  readonly exhibition: boolean;
  /** Mirrors `result.flags.relayLeadoff`. Always false on every real capture of this page type; read anyway rather than assumed. */
  readonly relayLeadoff: boolean;
  /** Cut-standard badges on the row, in printed order. Empty when the row had none. */
  readonly cutStandards: readonly SwimCloudCutStandardLabel[];
  /**
   * The **real meet points** this swim earned, from a `Score` column.
   *
   * Present only when the owning round's `pointsColumn` is `'score'`. Never
   * populated from a `Pts` column — see
   * {@link SwimCloudEventRoundPointsColumn} for why those are different
   * numbers, and {@link SwimCloudTeamMeetSwim.meetScore} for the measurements
   * behind that.
   */
  readonly meetScore?: number;
}

/** One `<caption>`-labelled table on a per-event results page: one round of the event. */
export interface SwimCloudMeetEventRound {
  /**
   * The caption text, verbatim. Absent when the table carried no `<caption>`.
   *
   * A single-round timed-final event is **expected** to print one table with no
   * round caption at all, but no such event has been captured, so nothing here
   * assumes it: an absent caption raises `'missing-round-caption'` and the
   * round stays absent rather than being named `'Finals'` on a guess.
   */
  readonly round?: string;
  readonly pointsColumn: SwimCloudEventRoundPointsColumn;
  /** One per data row that parsed, in printed order. */
  readonly swims: readonly SwimCloudMeetEventSwim[];
  /** Data rows seen in this table, including any that failed to parse. */
  readonly rowCount: number;
}

/* ---- Per-event page: locating the round tables ----------------------------- */

/** One round's table, located, with its caption and its columns already resolved. */
interface LocatedEventRoundTable {
  /** The `<caption>` text, verbatim. Absent when the table carried none. */
  readonly caption?: string;
  /**
   * Relay legs, one entry per data row, read from the RAW table before its
   * nested tables were stripped.
   *
   * `extractTableRows` deletes nested tables on purpose, so that an inner
   * table's rows are never mistaken for the outer table's. That is right, and
   * it also destroys the relay leg list, which SwimCloud serves as a nested
   * table hidden behind its own "Show names" toggle. By the time a caller has
   * `dataRows`, the legs are gone.
   *
   * So they are collected here, while the raw markup is still in hand, and
   * carried alongside. Paired by position: a relay entry has exactly one hidden
   * list, so the Nth list belongs to the Nth data row. An empty array means
   * that row had none, which is the normal case for an individual swim.
   */
  readonly relayLegsByRow: readonly (readonly SwimCloudRelayLeg[])[];
  readonly name: SwimsHeaderColumn;
  /**
   * The Time column. **Absent on a diving round**, which has none.
   *
   * A diving table's header is `Name | Team | Pts | Score`: the result is a
   * judged score, not a time. Requiring this column is what made all four of
   * meet 356467's diving events fail to parse at all, so their points were
   * missing from every team total with nothing to show for it.
   */
  readonly time?: SwimsHeaderColumn;
  readonly team?: SwimsHeaderColumn;
  readonly score?: SwimsHeaderColumn;
  readonly points?: SwimsHeaderColumn;
  /**
   * Body columns sitting under a header cell with **no printed label** — where
   * this page type puts its cut-standard and personal/season-best badges.
   *
   * The swims list has a labelled `Flags` column; this page does not label
   * those columns at all, so they cannot be located by label the way every
   * other column in this file is. They are located by the *absence* of a label
   * on their own header cell — still a fact the header row states, not a
   * position this parser assumed — and their contents are then filtered by
   * {@link readFlagsCell}, which only accepts a `c-label--royal` badge or a
   * `title="Leadoff"` span. A cell that holds anything else contributes
   * nothing.
   */
  readonly unlabeled: readonly number[];
  readonly dataRows: readonly (readonly string[])[];
}

/**
 * Every table on the page that is one round's results table.
 *
 * Identified by carrying `Name` and `Time` columns together — the same
 * discipline {@link locateSwimsTable} uses, minus `Event`, which this page type
 * has no column for (the event is a page-level fact here, printed once in the
 * dropdown). A `Teams` standings card (`Team`/`Score`) and a `High point` card
 * (`Name`/`Gold`/…/`Pts Avg`) both fail it, which is the point.
 *
 * Deliberately **not** keyed on the `o-table-group` wrapper div or on any other
 * CSS class. The wrapper is real and every round table on the capture sits in
 * one, but a class is a styling decision that can change under a restyle
 * without the table's meaning changing, and the header row is the page stating
 * what the columns are.
 */
export function locateEventRoundTables(tables: readonly HtmlElementSpan[]): LocatedEventRoundTable[] {
  const located: LocatedEventRoundTable[] = [];
  for (const table of tables) {
    const rows = extractTableRows(table.html);
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const columns = readHeaderColumns(itemAt(rows, headerIndex));
    const name = columnFor(columns, NAME_HEADERS);
    const time = columnFor(columns, SWIMS_TIME_HEADERS);
    const team = columnFor(columns, TEAM_HEADERS);
    const score = columnFor(columns, SWIMS_SCORE_HEADERS);
    const points = columnFor(columns, SWIMS_POINTS_HEADERS);
    // A round table names its subject and reports a result. The result is
    // usually a time, but a diving round reports a judged score in `Pts` and
    // its meet points in `Score` and has no Time column at all. Demanding one
    // rejected every diving page outright.
    //
    // A table with a name and NO result column of any kind is still rejected:
    // that is a roster or a nav block, not a round.
    if (name === undefined || (time === undefined && score === undefined && points === undefined)) {
      continue;
    }

    const unlabeled: number[] = [];
    for (const column of columns) {
      if (column.label.length > 0) continue;
      for (let index = column.start; index < column.start + column.span; index += 1) {
        unlabeled.push(index);
      }
    }

    const caption = readTableCaption(table.html);
    // Relay legs, paired by occurrence rather than by row index.
    //
    // Splitting the raw body on <tr> cannot be indexed against `dataRows`: the
    // hidden leg tables contain their own <tr>s, so a four-leg relay yields
    // five entries where the flattened split yields one. Instead every hidden
    // list in the table is read in document order, and paired 1:1 with the data
    // rows ONLY when the counts match exactly -- which is what a relay round
    // looks like, since every relay entry carries one. Any other shape is left
    // unpaired rather than guessed at: attaching the wrong swimmers to the
    // wrong relay would be a plausible, silent, wrong answer.
    const dataRowHtml = rows.slice(headerIndex + 1).filter((row) => !isHeaderRow(row));
    const hiddenLists = readHiddenLegListsInOrder(table.html);
    const relayLegsByRow =
      hiddenLists.length === dataRowHtml.length ? hiddenLists : dataRowHtml.map(() => []);
    located.push({
      ...(caption === undefined ? {} : { caption }),
      relayLegsByRow,
      name,
      ...(time === undefined ? {} : { time }),
      ...(team === undefined ? {} : { team }),
      ...(score === undefined ? {} : { score }),
      ...(points === undefined ? {} : { points }),
      unlabeled,
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    });
  }
  return located;
}

/**
 * The first `<caption>`'s text inside a table's own source. Absent when there
 * is none, or it is blank.
 *
 * A relay round's caption carries the page's own "Show names" button inside the
 * `<caption>` element, so the raw text reads `"Timed Finals Show names"`. That
 * string became the round label and would have been compared against round
 * vocabulary, matched nothing, and left a relay round unidentifiable. Buttons
 * are stripped before the text is read: they are controls the page draws, not
 * part of what it says.
 */
function readTableCaption(tableHtml: string): string | undefined {
  const caption = findElementSpans(tableHtml, 'caption')[0];
  if (caption === undefined) {
    return undefined;
  }
  const text = htmlToText(stripElements(caption.inner, ['button']));
  return text.length === 0 ? undefined : text;
}

/* ---- Per-event page: the row loop ------------------------------------------- */

interface EventRoundContext {
  readonly meetId: SwimCloudMeetId;
  readonly eventId: string;
  readonly event: SwimCloudEvent;
  readonly warnings: SwimCloudParseWarning[];
}

/**
 * The time cell's swim id, from its `/times/{swimId}/` link.
 *
 * A **different link shape** from the swims list's, which points at
 * `/results/{meetId}/event/{n}/?id={swimId}` and is read by
 * {@link readSwimLink}. The id itself is the same id — that is what makes the
 * two pages joinable — but the URL is not, so the reader cannot be.
 *
 * The `<div id="time{swimId}">` wrapper is a second, redundant statement of the
 * same id and is used only when the link is absent. Neither is invented: with
 * both gone the row simply has no swim id.
 */
const TIMES_LINK = /^(?:https?:\/\/[^/]+)?\/times\/(\d+)\/?(?:[?#].*)?$/i;

const TIME_DIV_ID = /^time(\d+)$/i;

function readEventPageSwimId(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const match = TIMES_LINK.exec(href.trim());
    if (match !== null) return match[1];
  }
  for (const div of findElementSpans(cellHtml, 'div')) {
    const id = readAttribute(startTagOf(div.html), 'id');
    const match = id === undefined ? null : TIME_DIV_ID.exec(id);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * The athlete's name out of a per-event page's name cell.
 *
 * **This cell is not the swims list's.** It repeats the team name in a
 * mobile-only `<div>` under the athlete's link:
 *
 * ```html
 * <td><a href="/results/356467/swimmer/1330318/">Avery Henke</a>
 *     <div class="… visible-xs-block">Henderson State</div></td>
 * ```
 *
 * Taking the cell's text the way the swims list does would produce
 * `"Avery Henke Henderson State"` — a name that matches no roster, no alias and
 * no swims-list row, and looks entirely plausible while doing it.
 *
 * So the name comes from **the anchor that carries the swimmer id**, which is
 * the page identifying the athlete rather than this parser guessing which part
 * of the cell is the name. The `visible-xs-block` class is not consulted: it is
 * a styling decision, and the anchor is the fact.
 *
 * With no such anchor (the `missing-athlete-link` case) the fallback reads the
 * cell with its `<div>` children lifted out, and only falls back again to the
 * whole cell if that leaves nothing — losing a real name to make a point about
 * markup would be the worse outcome.
 */
function readEventPageAthleteName(cellHtml: string): string {
  for (const anchor of findElementSpans(cellHtml, 'a')) {
    const href = readAttribute(startTagOf(anchor.html), 'href');
    if (href === undefined) continue;
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable') continue;
    const kind = classification.resource.kind;
    if (kind !== 'swimmer' && kind !== 'meetSwimmer') continue;
    const text = htmlToText(anchor.inner);
    if (text.length > 0) return text;
  }
  const withoutBlocks = htmlToText(stripElements(cellHtml, ['div']));
  return withoutBlocks.length > 0 ? withoutBlocks : htmlToText(cellHtml);
}

interface EventRankCell {
  readonly place?: number;
  readonly exhibition: boolean;
}

/**
 * Read a per-event page's rank cell — the leading `<td>` the `Name` header's
 * `colspan` covers.
 *
 * **This is where exhibition is marked on this page type, and it is a confirmed
 * mechanism rather than a convention this file guessed at.** An exhibition
 * swim's ordinal is *replaced* by
 * `<span class="c-label c-label--neutral c-label--outline u-cursor-help"
 * title="Exhibition">X</span>` — ten such rows on the real capture, and
 * SwimCloud tags a swimmer consistently across every round they appear in on
 * the page, not only the round they did not score in.
 *
 * That is **not** the leading-`X`-on-a-time-token Hy-Tek convention
 * {@link readTime} looks for. The two live side by side deliberately: this one
 * is proven for this page type, that one remains unproven for any SwimCloud
 * page, and the time cells here carry no leading `X` at all, so they never
 * both fire on one row. See {@link readTime}'s own comment.
 *
 * A row marked exhibition has **no place**, because the page printed none — the
 * marker took the ordinal's place. That absence is real, not a parse failure,
 * so it raises no warning.
 */
function readEventRankCell(
  cellHtml: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): EventRankCell {
  for (const span of findElementSpans(cellHtml, 'span')) {
    const title = readAttribute(startTagOf(span.html), 'title');
    if (title !== undefined && title.trim().toLowerCase() === 'exhibition') {
      return { exhibition: true };
    }
  }
  const place = readOrdinalPlace(htmlToText(cellHtml), event, rowIndex, warnings);
  return { ...(place === undefined ? {} : { place }), exhibition: false };
}

/** The time/judged-score/points/score readers for one per-event round row. */
interface EventRoundMeasurements {
  readonly time: ReadTime;
  readonly score: ReturnType<typeof readPoints> | Record<string, never>;
  readonly points: ReturnType<typeof readPoints> | Record<string, never>;
}

/**
 * Read the time (or, for a diving round with no time column, the judged
 * score), score and points cells of one per-event round row, and push
 * `missing-swim-link` when a timed round's row carries none. Extracted from
 * {@link readEventRound} purely to keep that function's own complexity down;
 * every reader call and the judged-score fallback are unchanged.
 *
 * A diving result is the judged score in the `Pts` column, preserved
 * verbatim in `rawTimeToken` because it is emphatically not a time. That
 * is where `data/meets.json` already carries it for this very meet:
 * Santiago Santodomingo's 1M final reads `"time": "503.95"`.
 */
function readEventRoundMeasurements(
  cells: readonly string[],
  table: LocatedEventRoundTable,
  event: SwimCloudEvent,
  timeCellHtml: string,
  athleteName: string,
  eventId: string,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): EventRoundMeasurements {
  const swimId = table.time === undefined ? undefined : readEventPageSwimId(timeCellHtml);
  // Only a round that HAS a time cell can be missing a link in it. A diving
  // round prints no time cell and no /times/ link anywhere, so its swims
  // legitimately carry no SwimCloud swim id and fall back to a composite key.
  if (table.time !== undefined && swimId === undefined) {
    warnings.push({
      code: 'missing-swim-link',
      message: `Time cell for ${JSON.stringify(athleteName)} carries neither a /times/{id}/ link nor a <div id="time{id}"> wrapper; the swim has no SwimCloud swim id, so it cannot be joined against a team's swims list.`,
      eventId,
      rowIndex,
    });
  }

  const judgedScore =
    table.time !== undefined || table.points === undefined
      ? undefined
      : collapseWhitespace(textAt(cells, table.points.start));
  const time =
    table.time === undefined
      ? judgedScore === undefined || judgedScore.length === 0
        ? {}
        : { rawTimeToken: judgedScore }
      : readTime(htmlToText(timeCellHtml), event, rowIndex, warnings);
  const score =
    table.score === undefined ? {} : readPoints(textAt(cells, table.score.start), event, rowIndex, warnings);
  const points =
    table.points === undefined ? {} : readPoints(textAt(cells, table.points.start), event, rowIndex, warnings);

  return { time, score, points };
}

/** Badge-cell tally for one per-event round row: leadoff flag and cut-standard chips. */
function readEventRoundBadges(
  cells: readonly string[],
  table: LocatedEventRoundTable,
): { readonly relayLeadoff: boolean; readonly cutStandards: SwimCloudCutStandardLabel[] } {
  let relayLeadoff = false;
  const cutStandards: SwimCloudCutStandardLabel[] = [];
  for (const index of table.unlabeled) {
    const flags = readFlagsCell(cellAt(cells, index));
    if (flags.relayLeadoff) relayLeadoff = true;
    cutStandards.push(...flags.cutStandards);
  }
  return { relayLeadoff, cutStandards };
}

/** The athlete/team facts a per-event round row's `entry` is built from. */
interface EventRoundAthlete {
  readonly swimmerId: SwimCloudSwimmerId | undefined;
  readonly relayLegs: readonly SwimCloudRelayLeg[];
  readonly teamId: SwimCloudTeamId | undefined;
  readonly rowTeamName: string;
}

/**
 * Resolve a per-event round row's swimmer id, relay legs and team, and push
 * `missing-athlete-link` when neither a swimmer link nor relay legs are
 * present. Extracted from {@link readEventRound} for the same reason as
 * {@link readEventRoundMeasurements}.
 *
 * A relay row names a team, not a person, so it legitimately carries no
 * swimmer link — the swimmers are in the hidden leg table in this same
 * cell. Reading those first means the warning can tell "a relay,
 * correctly identified" from "an individual row that lost its link", which
 * it previously could not: every relay row raised it.
 */
function resolveEventRoundAthlete(
  nameCellHtml: string,
  teamCellHtml: string,
  athleteName: string,
  table: LocatedEventRoundTable,
  rowIndex: number,
  eventId: string,
  warnings: SwimCloudParseWarning[],
): EventRoundAthlete {
  const swimmerId = swimmerIdFromCell(nameCellHtml);
  const relayLegs = table.relayLegsByRow[rowIndex] ?? [];
  if (swimmerId === undefined && relayLegs.length === 0) {
    warnings.push({
      code: 'missing-athlete-link',
      message: `Per-event results row for ${athleteName} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
      eventId,
      rowIndex,
      raw: athleteName,
    });
  }

  const rowTeamName = htmlToText(teamCellHtml);
  // A relay event's table has NO Team column — its header is a single
  // `<th colspan=2>Name</th>` — and the team is stated only as a link inside
  // the name cell: `<a href="/results/{meetId}/team/58/">…Henderson State
  // (A)</a>`. Reading it there is the page's own statement about which team
  // the entry belongs to, so a relay row is no longer team-less. Without
  // this, every relay on the page was dropped for having no team, which
  // silently removed the double-weighted relay events from a team score.
  //
  // The Team column still wins where one exists: on an individual event it
  // holds the team name as well as the id, and this is only the fallback.
  const teamId = teamIdFromCell(teamCellHtml) ?? teamIdFromCell(nameCellHtml);

  return { swimmerId, relayLegs, teamId, rowTeamName };
}

/**
 * Assemble one {@link SwimCloudMeetEventSwim} from a round row's
 * already-resolved parts. Extracted from {@link readEventRound} purely so
 * the per-field "omit when absent" spreads don't count against that
 * function's complexity; every field and its absence rule is unchanged.
 */
function assembleEventRoundSwim(fields: {
  readonly eventId: string;
  readonly meetId: SwimCloudMeetId;
  readonly swimId: string | undefined;
  readonly athlete: EventRoundAthlete;
  readonly athleteName: string;
  readonly rank: EventRankCell;
  readonly measurements: EventRoundMeasurements;
  readonly relayLeadoff: boolean;
  readonly cutStandards: readonly SwimCloudCutStandardLabel[];
  readonly roundCaption: string | undefined;
  readonly rowIndex: number;
}): SwimCloudMeetEventSwim {
  const { eventId, meetId, swimId, athlete, athleteName, rank, measurements, relayLeadoff, cutStandards, roundCaption, rowIndex } =
    fields;
  const { time, score, points } = measurements;

  // The same key shape the swims list builds, so one swim carries one key on
  // both pages. The composite fallback is capture-local and joins nothing.
  const roundKey = roundCaption === undefined ? 'uncaptioned' : normalizeHeader(roundCaption);
  const swimKey =
    swimId === undefined
      ? `${eventId}:round:${roundKey}:swim:${athlete.swimmerId ?? `row${rowIndex}`}:${time.finalTime ?? time.rawTimeToken ?? `row${rowIndex}`}`
      : `${meetId}:swim:${swimId}`;

  const resultFlags: SwimCloudResultFlags | undefined =
    time.flags === undefined && !rank.exhibition && !relayLeadoff
      ? undefined
      : {
          ...(time.flags ?? {}),
          ...(rank.exhibition ? { exhibition: true } : {}),
          ...(relayLeadoff ? { relayLeadoff: true } : {}),
        };

  const entry: SwimCloudEntry = {
    entryId: `${swimKey}:entry`,
    eventId,
    ...(athlete.swimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimmerId }),
    athleteName,
    ...(athlete.teamId === undefined ? {} : { swimCloudTeamId: athlete.teamId }),
    ...(athlete.rowTeamName.length === 0 ? {} : { teamName: athlete.rowTeamName }),
  };

  const result: SwimCloudResult = {
    resultId: `${swimKey}:result`,
    entryId: entry.entryId,
    eventId,
    ...(rank.place === undefined ? {} : { place: rank.place }),
    ...(points.points === undefined ? {} : { points: points.points }),
    ...(points.rawPointsToken === undefined ? {} : { rawPointsToken: points.rawPointsToken }),
    ...(time.finalTime === undefined ? {} : { finalTime: time.finalTime }),
    ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
    ...(resultFlags === undefined ? {} : { flags: resultFlags }),
  };

  return {
    swimKey,
    ...(swimId === undefined ? {} : { swimCloudSwimId: swimId }),
    ...(athlete.relayLegs.length === 0 ? {} : { relayLegs: athlete.relayLegs }),
    ...(roundCaption === undefined ? {} : { roundLabel: roundCaption }),
    entry,
    result,
    exhibition: rank.exhibition,
    relayLeadoff,
    cutStandards,
    ...(score.points === undefined ? {} : { meetScore: score.points }),
  };
}

/**
 * Say so when a relay row on a per-event page read no legs. Silence here looked
 * like "this relay has no swimmers", which is never true: the legs sit in a
 * hidden table, so no legs means that table was missing from the capture or
 * unreadable. A non-relay event never warns.
 */
function warnRelayRowWithoutLegs(
  event: SwimCloudEvent,
  athlete: EventRoundAthlete,
  athleteName: string,
  eventId: string,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): void {
  if (event.kind !== 'relay' || athlete.relayLegs.length > 0) {
    return;
  }
  warnings.push({
    code: 'relay-row-without-legs',
    message: `Relay row ${JSON.stringify(athleteName)} read no legs. SwimCloud serves them in a hidden "Show names" table on this page, so the capture lacks that table or it could not be read. The row is kept without legs; its swimmers cannot be credited.`,
    eventId,
    rowIndex,
    raw: athleteName,
  });
}

export function readEventRound(
  table: LocatedEventRoundTable,
  ctx: EventRoundContext,
): SwimCloudMeetEventRound {
  const { event, eventId } = ctx;
  const swims: SwimCloudMeetEventSwim[] = [];

  const pointsColumn: SwimCloudEventRoundPointsColumn =
    table.score !== undefined ? 'score' : table.points !== undefined ? 'pts' : 'none';

  if (table.caption === undefined) {
    ctx.warnings.push({
      code: 'missing-round-caption',
      message:
        'A results table on this per-event page carries no <caption>, so the round its swims were contested in is unknown. The round is left absent rather than named; a caller must not score these rows as finals on that basis.',
      eventId,
    });
  }

  // The rank cell only exists when the Name header spans the column before the
  // athlete's. Without it there is no ordinal AND no place to read the
  // exhibition marker from — so this is said out loud rather than answered with
  // a silent `exhibition: false`, which would let an exhibition swim score.
  const hasRankCell = table.name.span > 1;
  if (!hasRankCell) {
    ctx.warnings.push({
      code: 'missing-rank-cell',
      message: `The "Name" header of the ${JSON.stringify(table.caption ?? 'uncaptioned')} table spans one column, so the leading rank cell this page type prints is absent. No place was read, and the rank cell's exhibition marker could not be checked for any row of this table.`,
      eventId,
    });
  }

  // **Resolved 2026-09-22 against four real diving pages.** This used to warn
  // that a diving `Score` might be the judged score and refuse to store it.
  // The full-field crawl of meet 356467 settles it: on events 9, 18, 29 and 40
  // the `Pts` column holds the judged score (503.95, 431.25, ...) and the
  // hidden `Score` column holds 20, 17, 16, 15, 14, 13, 12, 11 — the
  // championship individual table, place for place. `data/meets.json`, built
  // from the meet's own PDF, independently gives Santiago Santodomingo
  // `"points": 20` for that same 1M final.
  //
  // So a diving `Score` is meet points, exactly like a swimming one, and is
  // stored. Refusing it left every diving event contributing nothing to a team
  // total.

  table.dataRows.forEach((cells, rowIndex) => {
    const nameIndex = subjectCellIndex(cells, table.name);
    const nameCellHtml = cellAt(cells, nameIndex);
    const athleteName = readEventPageAthleteName(nameCellHtml);
    if (athleteName.length === 0) {
      ctx.warnings.push({
        code: 'unparsed-row',
        message: 'Per-event results row has an empty athlete cell and was skipped.',
        eventId,
        rowIndex,
      });
      return;
    }

    const rank = hasRankCell
      ? readEventRankCell(cellAt(cells, table.name.start), event, rowIndex, ctx.warnings)
      : { exhibition: false };

    const timeCellHtml = table.time === undefined ? '' : cellAt(cells, table.time.start);
    const swimId = table.time === undefined ? undefined : readEventPageSwimId(timeCellHtml);
    const measurements = readEventRoundMeasurements(
      cells,
      table,
      event,
      timeCellHtml,
      athleteName,
      eventId,
      rowIndex,
      ctx.warnings,
    );
    const { relayLeadoff, cutStandards } = readEventRoundBadges(cells, table);

    const teamCellHtml = table.team === undefined ? '' : cellAt(cells, table.team.start);
    const athlete = resolveEventRoundAthlete(
      nameCellHtml,
      teamCellHtml,
      athleteName,
      table,
      rowIndex,
      eventId,
      ctx.warnings,
    );

    warnRelayRowWithoutLegs(event, athlete, athleteName, eventId, rowIndex, ctx.warnings);

    swims.push(
      assembleEventRoundSwim({
        eventId,
        meetId: ctx.meetId,
        swimId,
        athlete,
        athleteName,
        rank,
        measurements,
        relayLeadoff,
        cutStandards,
        roundCaption: table.caption,
        rowIndex,
      }),
    );
  });

  if (table.dataRows.length === 0) {
    ctx.warnings.push({
      code: 'zero-data-rows',
      message: `The ${JSON.stringify(table.caption ?? 'uncaptioned')} results table was found and holds no data rows. This is a real "nothing posted for this round" answer, not a missing table.`,
      eventId,
    });
  }

  return {
    ...(table.caption === undefined ? {} : { round: table.caption }),
    pointsColumn,
    swims,
    rowCount: table.dataRows.length,
  };
}
