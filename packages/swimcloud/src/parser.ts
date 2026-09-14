/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud parser/normalizer — HTML in, typed entities out.
 *
 * # READ THIS BEFORE TRUSTING ANY OUTPUT OF THIS FILE
 *
 * Some functions here have been run against real SwimCloud markup and some have
 * not, and the difference is reported on every result as `confidence`.
 *
 * ## The two that have not (`confidence: 'synthetic-fixture-only'`)
 *
 * {@link parseMeetResultsHtml} and {@link parseSwimmerProfileHtml} were written
 * against **hand-authored synthetic HTML**
 * (`tests/fixtures/swimcloud-synthetic-*.html`) built from the *structural
 * description* in `plans/2026-09-06/02-data-model-and-scoring.md`, not from a
 * page anybody had seen. Treat their passing tests as evidence that the
 * *contract* holds, not that the *selectors* do.
 *
 * ## The ones that have (`confidence: 'real-capture-verified'`)
 *
 * On 2026-09-08 a human captured real pages of meets 356467 and 379295 with the
 * browser extension; on 2026-09-09, both genders of team 58's roster, that
 * team's landing and meet-list pages, and swimmer 1472365's home and times
 * pages. They are archived as `tests/fixtures/swimcloud-real-*.html` with the
 * page-shape findings recorded in each file's own header comment.
 * {@link parseTeamMeetSwimsHtml}, {@link parseMeetTeamsHtml},
 * {@link parseMeetTopTeamsHtml}, {@link parseTeamRosterHtml} and
 * {@link parseSwimmerTimesHtml} were written against those. On 2026-09-10 the
 * same human captured `/results/356467/event/26/`, the per-event results page,
 * and {@link parseMeetEventResultsHtml} was written against it — the only page
 * type in this file that names which **round** a swim was contested in, and the
 * only one that publishes real meet points for an individual swim.
 *
 * ## What that capture proved wrong
 *
 * {@link parseMeetResultsHtml} reads a meet page as a sequence of
 * `Event {n} {Gender} {Distance} {Unit} {Stroke}` headings, each governing the
 * next table. **That page shape does not exist on SwimCloud.** A real meet-root
 * page carries exactly one heading — the meet's own title — and its "Events"
 * section is a flat list of links to per-event sub-pages, not a results table.
 * The function is kept (its contract and its table reader are still exercised by
 * the synthetic fixtures, and nothing is gained by deleting a shape that may yet
 * describe some other source), but it is **no longer the function a meet-results
 * import calls**, and it never was correct for the page its name suggests.
 * `tests/swimcloudParser.test.ts` pins that failure against the real fixture so
 * the fact stays discoverable instead of being rediscovered.
 *
 * ## What the swimmer capture proved about the other guessed parser
 *
 * {@link parseSwimmerProfileHtml} reads a swimmer's personal bests out of a
 * table with a separate **course column** and a bare event label (`200 Free`).
 * The real `/swimmer/{id}/times/` page has no course column at all: the course
 * is a suffix of the printed event name (`50 Free SCY`, `50 Free LCM` — two
 * rows, same stroke and distance). So that function's column model does not
 * describe the page its name suggests either. It is kept for the same reason
 * {@link parseMeetResultsHtml} is, and {@link parseSwimmerTimesHtml} is the
 * function a swimmer-times import calls.
 *
 * Anything {@link parseMeetResultsHtml} or {@link parseSwimmerProfileHtml}
 * returns should be shown to a human for confirmation before it reaches a
 * workspace.
 *
 * # Contract
 *
 * - **Input is a raw HTML string.** Both access tracks can produce one without
 *   either dictating a parser to the other: Track A's content script has
 *   `document.documentElement.outerHTML`, Track B's Playwright has
 *   `page.content()` (`plans/2026-09-06/03-architecture.md` §1.3).
 * - **Extraction is string/regex only.** No DOM, no HTML-parser dependency —
 *   see the rationale in `./html.ts`.
 * - **Absent is never empty and never zero.** A structure that is missing
 *   produces `ok: false` with a failure code. A structure that is present and
 *   genuinely holds nothing produces `ok: true` with a `zero-data-rows`
 *   warning. These are different facts and callers must be able to tell them
 *   apart — silent empties are the top failure mode this repo guards against
 *   (`CLAUDE.md` § Data provenance, rule 4).
 * - **Nothing is inferred that the page did not say.** An ambiguous "Meter"
 *   event stays `course: 'unknown'`. An unparseable time is preserved verbatim
 *   in `rawTimeToken` and left out of `finalTime`. An unmapped class year is
 *   `'unknown'`.
 * - **Points are captured, not computed here.** A points column, when
 *   present, is read into {@link SwimCloudResult.points} the same way any
 *   other cell is — verbatim, warned-about when unparseable. This parser
 *   does not decide whether those points are *trustworthy*; see
 *   {@link SwimCloudResult}'s own doc comment for that history and for why
 *   the trust decision belongs to the caller, same as `packages/core`'s
 *   `usePdfPlacePoints` is a caller decision for a PDF import.
 */

import {
  collapseWhitespace,
  decodeHtmlEntities,
  extractHrefs,
  extractListItems,
  extractRowCells,
  extractTableRows,
  findElementSpans,
  findHeadings,
  findTables,
  htmlToText,
  isHeaderRow,
  stripElements,
  stripNonContent,
} from './html';
import type { HtmlElementSpan } from './html';
import type {
  SwimCloudAthlete,
  SwimCloudCaptureTrack,
  SwimCloudClassYear,
  SwimCloudCourse,
  SwimCloudCourseOrUnknown,
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudGender,
  SwimCloudGenderOrUnknown,
  SwimCloudMeet,
  SwimCloudMeetFormat,
  SwimCloudMeetId,
  SwimCloudProvenance,
  SwimCloudRelay,
  SwimCloudRelayLeg,
  SwimCloudResult,
  SwimCloudResultFlags,
  SwimCloudRuleset,
  SwimCloudStroke,
  SwimCloudSwimmerId,
  SwimCloudTeam,
  SwimCloudTeamId,
  SwimCloudTimeString,
} from './entities';
import { SWIMCLOUD_CANONICAL_HOST, classifySwimCloudUrl } from './urlClassifier';

/* -------------------------------------------------------------------------- */
/* Confidence, warnings, failures                                              */
/* -------------------------------------------------------------------------- */

/**
 * How much the extraction rules that produced a result have actually been
 * checked.
 *
 * The second member arrived 2026-09-08, exactly as this type's original comment
 * anticipated: a real capture exists, so a parser written against it can say so,
 * and the difference is visible in the type rather than buried in a doc comment.
 *
 * - `'synthetic-fixture-only'` — these selectors have been exercised against
 *   hand-authored HTML that a human guessed at, and never against a page
 *   SwimCloud served.
 * - `'real-capture-verified'` — these selectors have been exercised against
 *   markup SwimCloud actually served, archived under
 *   `tests/fixtures/swimcloud-real-*.html`.
 *
 * Neither value is a claim of *completeness*. `'real-capture-verified'` means
 * "checked against a page we have", not "handles every page SwimCloud can
 * serve" — see {@link parseTeamMeetSwimsHtml}'s own comment for what the one
 * captured page does and does not cover (it carries no DQ or scratch rows at
 * all, for instance).
 */
export type SwimCloudParseConfidence = 'synthetic-fixture-only' | 'real-capture-verified';

/**
 * The confidence reported by the parsers that have never seen real markup —
 * {@link parseMeetResultsHtml} and {@link parseSwimmerProfileHtml}.
 *
 * Kept as the default so adding the second value could not silently upgrade a
 * parser that had not earned it: a function reports
 * `'real-capture-verified'` only by asking for it by name.
 */
export const SWIMCLOUD_PARSE_CONFIDENCE: SwimCloudParseConfidence = 'synthetic-fixture-only';

/**
 * The confidence reported by the parsers written against archived real
 * captures: {@link parseTeamMeetSwimsHtml}, {@link parseMeetTeamsHtml},
 * {@link parseMeetTopTeamsHtml}, {@link parseTeamRosterHtml},
 * {@link parseSwimmerTimesHtml} and {@link parseMeetEventResultsHtml}. See
 * {@link SwimCloudParseConfidence} for what the value does and does not claim.
 */
export const SWIMCLOUD_REAL_CAPTURE_CONFIDENCE: SwimCloudParseConfidence = 'real-capture-verified';

/** Something the parser noticed and did not silently swallow. */
export type SwimCloudParseWarningCode =
  /** The expected table was found, with a header row and no data rows. */
  | 'zero-data-rows'
  /** A data row could not be turned into an entity and was skipped. */
  | 'unparsed-row'
  /** An event heading was found but its table could not be read; the event is absent from the output. */
  | 'unparsed-event'
  /** A time cell held something that is neither a time nor a known marker. Preserved verbatim. */
  | 'unrecognized-time-token'
  /** A place cell held something that is neither an integer nor a known "no place" marker. */
  | 'unrecognized-place-token'
  /** The event label said "Meter", which is ambiguous between LCM and SCM. Course left unknown. */
  | 'ambiguous-metric-course'
  /** The event label carried no course unit at all and no meet-level course was supplied. */
  | 'missing-course-declaration'
  /** A class-year cell held a value outside the known vocabulary. Recorded as `'unknown'`. */
  | 'unmapped-class-year'
  /** An event's gender word is outside `Men`/`Women` (e.g. `Mixed`). Recorded as `'unknown'`. */
  | 'unmapped-gender'
  /** An event label's stroke could not be identified. Recorded as `'unknown'`. */
  | 'unmapped-stroke'
  /** A roster/results row named an athlete with no `/swimmer/{id}/` link. */
  | 'missing-athlete-link'
  /** A relay row listed no legs. Expected if SwimCloud does not publish them at all. */
  | 'relay-legs-absent'
  /** A row's event label said "Yard" but an explicit course column disagreed. The label wins; the disagreement is surfaced rather than silently resolved either way. */
  | 'course-column-contradicts-label'
  /** A Points cell held something that isn't a non-negative number. Preserved verbatim in `rawPointsToken`; `points` stays absent rather than guessed. */
  | 'unrecognized-points-token'
  /** A diving event's result column holds a judged score, not a time; not stored as `finalTime`. */
  | 'diving-score-not-a-time'
  /** An event cell did not match the `{distance} {course letter} {stroke}` shape a swims-list row prints. Nothing about the event is inferred from it beyond what a plain label scan finds. */
  | 'unrecognized-event-label'
  /** An event label's course letter is outside the `Y`/`L`/`S` vocabulary. Course recorded as `'unknown'`, never defaulted to yards. */
  | 'unrecognized-course-token'
  /** A row's time cell carried no `/results/{meetId}/event/{n}/?id={swimId}` link, so the swim has no SwimCloud swim id and no event reference. */
  | 'missing-swim-link'
  /** The page printed a meet date that matched no recognized shape. Start/end dates left absent rather than guessed. */
  | 'unrecognized-meet-date'
  /**
   * A per-event page's results table carried no `<caption>`, so the round its
   * swims were contested in is unknown.
   *
   * Every table on the one captured page of this type has one ("A Final",
   * "B Final", "C Final", "Preliminaries"). A single-round timed-final event is
   * *expected* to print one table with no round caption, but no such event has
   * been captured — so the round is left **absent** rather than named `'Finals'`
   * on that expectation. Absent means the caller must not treat these rows as a
   * scoring final; it does not mean they scored nothing.
   */
  | 'missing-round-caption'
  /**
   * A per-event page's results table has no leading rank cell — its `Name`
   * header spans one column, not two.
   *
   * Loud rather than silent because of what the rank cell holds on this page
   * type: not only the ordinal, but the `title="Exhibition"` marker. Without it
   * an exhibition swim is indistinguishable from a scoring one, and answering
   * `exhibition: false` quietly would let it score.
   */
  | 'missing-rank-cell'
  /**
   * A diving event's per-event page carried a `Score` column, and what that
   * column means there is unverified.
   *
   * On a swimming event `Score` is the meet points the swim earned — proven by
   * the real capture. On a diving event it could as plausibly be the judged
   * score, and a judged 300.15 stored as meet points would silently multiply a
   * team's total. No diving page has been captured, so the value is preserved
   * verbatim and **not** stored as `meetScore`.
   */
  | 'diving-score-column-unverified'
  /** A roster card's heading printed a season label outside the `YYYY-YYYY` shape. The label is preserved verbatim in `raw`; `season` stays absent rather than reshaped. */
  | 'unrecognized-season-label'
  /**
   * A `<script type="application/json">` block the page embeds its own subject
   * data in could not be read — absent, unparseable, or holding a value of the
   * wrong shape. Whatever the block would have told us is taken from another
   * source or left absent; nothing about it is guessed.
   */
  | 'unreadable-embedded-json'
  /**
   * Two statements about the same fact disagreed — the page's own heading
   * against the page's own filter form, or the page against a caller-supplied
   * option. **The page's heading wins**, and the disagreement is surfaced
   * rather than silently resolved. `raw` carries both values.
   */
  | 'contradicted-page-declaration';

/** One non-fatal observation, with enough context to find the row it came from. */
export interface SwimCloudParseWarning {
  readonly code: SwimCloudParseWarningCode;
  readonly message: string;
  /** 0-based index of the data row within its table, when row-scoped. */
  readonly rowIndex?: number;
  /** The event this warning belongs to, when event-scoped. */
  readonly eventId?: string;
  /** The offending text, verbatim. Present whenever something was rejected. */
  readonly raw?: string;
}

/** Why a parse produced nothing usable. Always loud, never an empty success. */
export type SwimCloudParseFailureCode =
  /** The input string was empty or whitespace. */
  | 'empty-input'
  /** The capture URL names a different resource than the parser was asked for, or no id could be resolved. */
  | 'source-url-mismatch'
  /** No table at all was found where one was required. */
  | 'expected-table-missing'
  /** A table was found but its header row lacks a column this parser requires. */
  | 'expected-header-missing'
  /** Data rows existed and every one of them failed to parse. */
  | 'no-rows-parsed'
  /** Event headings existed and not one of their tables could be read. */
  | 'no-events-parsed';

export interface SwimCloudParseFailure {
  readonly code: SwimCloudParseFailureCode;
  readonly message: string;
}

/** Success half of {@link SwimCloudParseResult}. */
export interface SwimCloudParseSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly provenance: SwimCloudProvenance;
  readonly confidence: SwimCloudParseConfidence;
  readonly warnings: readonly SwimCloudParseWarning[];
}

/** Failure half of {@link SwimCloudParseResult}. */
export interface SwimCloudParseFailureResult {
  readonly ok: false;
  readonly failure: SwimCloudParseFailure;
  readonly provenance: SwimCloudProvenance;
  readonly confidence: SwimCloudParseConfidence;
  readonly warnings: readonly SwimCloudParseWarning[];
}

/**
 * Every parser returns this.
 *
 * Discriminated on `ok` so a caller cannot read `data` without having handled
 * the failure case — the type system enforcing the "absent ≠ empty" rule that
 * a nullable return would leave to discipline.
 */
export type SwimCloudParseResult<T> = SwimCloudParseSuccess<T> | SwimCloudParseFailureResult;

/** What the caller knows about the capture. Supplied, never invented here. */
export interface SwimCloudParseContext {
  /** The URL the HTML was captured from. */
  readonly sourceUrl: string;
  /** ISO-8601 instant of capture. The parser has no clock of its own. */
  readonly retrievedAt: string;
  /** Which access track produced the capture. */
  readonly track: SwimCloudCaptureTrack;
  /** SHA-256 of the raw HTML, if the caller computed one. */
  readonly sha256?: string;
}

function provenanceOf(context: SwimCloudParseContext): SwimCloudProvenance {
  return {
    sourceUrl: context.sourceUrl,
    retrievedAt: context.retrievedAt,
    track: context.track,
    ...(context.sha256 === undefined ? {} : { sha256: context.sha256 }),
  };
}

function fail(
  context: SwimCloudParseContext,
  code: SwimCloudParseFailureCode,
  message: string,
  warnings: readonly SwimCloudParseWarning[] = [],
  confidence: SwimCloudParseConfidence = SWIMCLOUD_PARSE_CONFIDENCE,
): SwimCloudParseFailureResult {
  return {
    ok: false,
    failure: { code, message },
    provenance: provenanceOf(context),
    confidence,
    warnings,
  };
}

function succeed<T>(
  context: SwimCloudParseContext,
  data: T,
  warnings: readonly SwimCloudParseWarning[],
  confidence: SwimCloudParseConfidence = SWIMCLOUD_PARSE_CONFIDENCE,
): SwimCloudParseSuccess<T> {
  return {
    ok: true,
    data,
    provenance: provenanceOf(context),
    confidence,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Header mapping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Columns are located by their **printed header label**, not by position and not
 * by CSS class.
 *
 * A label is what a human sees and is the thing least likely to change silently
 * when a site restyles; a column index is the thing most likely to. Anything
 * that cannot be located by label is reported as a missing header, never
 * guessed at by position.
 */
function normalizeHeader(label: string): string {
  return collapseWhitespace(label.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

function findColumn(headers: readonly string[], synonyms: readonly string[]): number {
  for (let index = 0; index < headers.length; index += 1) {
    if (synonyms.includes(headers[index])) {
      return index;
    }
  }
  return -1;
}

const NAME_HEADERS = ['name', 'athlete', 'swimmer'] as const;
const CLASS_HEADERS = ['class', 'yr', 'year', 'class year', 'grade'] as const;
const HOMETOWN_HEADERS = ['hometown', 'home town', 'hometown high school'] as const;
const TEAM_HEADERS = ['team', 'school', 'club'] as const;
const PLACE_HEADERS = ['place', 'pl', 'pos', 'rank'] as const;
const TIME_HEADERS = ['time', 'finals', 'finals time', 'final time', 'result', 'score'] as const;
const POINTS_HEADERS = ['points', 'pts', 'score points', 'team points'] as const;

function cellAt(cells: readonly string[], index: number): string {
  if (index < 0 || index >= cells.length) {
    return '';
  }
  return cells[index];
}

function textAt(cells: readonly string[], index: number): string {
  return htmlToText(cellAt(cells, index));
}

/* -------------------------------------------------------------------------- */
/* Value vocabularies                                                          */
/* -------------------------------------------------------------------------- */

const CLASS_YEARS: Readonly<Record<string, SwimCloudClassYear>> = {
  fr: 'FR',
  freshman: 'FR',
  'fr 1': 'FR',
  so: 'SO',
  sophomore: 'SO',
  jr: 'JR',
  junior: 'JR',
  sr: 'SR',
  senior: 'SR',
  gr: 'GR',
  grad: 'GR',
  graduate: 'GR',
};

/**
 * A swim time as printed: optional hour and minute groups, then seconds to
 * hundredths. `52.10`, `1:56.47`, `1:02:33.44`.
 *
 * Hundredths are required. A value printed to tenths or to thousandths is not a
 * time this parser will accept, because accepting it would mean deciding how to
 * pad or truncate it, and that is a fabricated digit in a competition value.
 */
const TIME_TOKEN = /^(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}$/;

/** Trailing time on a relay-leg line, e.g. `Landon Dehn 23.41`. */
const TRAILING_TIME = /(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}\s*$/;

/**
 * Non-time markers with a meaning clear enough to map onto a flag.
 *
 * **Unverified** that SwimCloud prints these tokens at all — they are the
 * Hy-Tek/Meet-Manager conventions the sport uses everywhere. A token outside
 * this map is *not* guessed at: it is preserved in
 * {@link SwimCloudResult.rawTimeToken} and reported as
 * `unrecognized-time-token`.
 */
const RESULT_MARKERS: Readonly<Record<string, SwimCloudResultFlags>> = {
  dq: { disqualified: true },
  ns: { noShow: true },
  scr: { scratched: true },
  // Declared False Start: the athlete did not swim. Treated as a scratch, which
  // is the state it shares — deliberately not folded into `disqualified`, since
  // Rule 7 treats a DQ and a non-swim differently.
  dfs: { scratched: true },
};

/** Place cells that mean "no place", rather than a place we failed to read. */
const NO_PLACE_TOKENS = new Set(['', '-', '--', '---', 'x', 'ex']);

/* -------------------------------------------------------------------------- */
/* Team roster                                                                 */
/* -------------------------------------------------------------------------- */

/** Caller-supplied fallbacks for facts a roster capture's markup may not state. */
export interface SwimCloudRosterParseOptions {
  /**
   * The gender this roster was filtered to, used **only when the page itself
   * does not say**.
   *
   * The real capture does say: the roster card's heading prints
   * `Season 2025-2026 Men`, and the filter form marks the matching radio
   * `checked`. Where the page states a gender, the page wins and a disagreeing
   * option raises `contradicted-page-declaration` — labelling a men's roster
   * `Women` because a UI dropdown said so is exactly the silent, plausible
   * wrongness this package exists to prevent.
   *
   * Never inferred from athlete names. With neither source, the parse still
   * succeeds but no {@link SwimCloudTeam} is produced, because a team record
   * without a gender would violate the one-program-per-sponsored-gender rule.
   */
  readonly gender?: SwimCloudGender;
  /** Season label `YYYY-YYYY`, used only when the page's own heading does not carry one. Same page-wins rule as {@link gender}. */
  readonly season?: string;
  /** Team id, for captures whose URL cannot be classified (a Wayback snapshot, say). */
  readonly teamId?: SwimCloudTeamId;
}

/** Where a {@link SwimCloudRosterParse} field's value came from. */
export type SwimCloudRosterFieldSource =
  /** The page stated it — a heading, a title, or the filter form's checked control. */
  | 'page'
  /** The page did not state it and {@link SwimCloudRosterParseOptions} supplied it. */
  | 'caller-supplied';

/** What {@link parseTeamRosterHtml} extracts. */
export interface SwimCloudRosterParse {
  /** From the capture URL, or from {@link SwimCloudRosterParseOptions.teamId}. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** From the page `<title>` (`Roster - {team}`), falling back to an `<h1>`. */
  readonly teamName?: string;
  readonly gender?: SwimCloudGender;
  /** Season label, `YYYY-YYYY` only. A heading label of any other shape leaves this absent with an `unrecognized-season-label` warning. */
  readonly season?: string;
  /** Absent when {@link gender} is. See {@link SwimCloudRosterFieldSource}. */
  readonly genderSource?: SwimCloudRosterFieldSource;
  /** Absent when {@link season} is. See {@link SwimCloudRosterFieldSource}. */
  readonly seasonSource?: SwimCloudRosterFieldSource;
  /**
   * Built **only** when team id, name and gender are all known. Absent otherwise
   * — a half-known team is not a team.
   */
  readonly team?: SwimCloudTeam;
  /**
   * Roster rows, in page order.
   *
   * An empty array here always comes with a `zero-data-rows` warning: it means
   * the roster table existed and listed nobody (a wrong season filter, say),
   * which is a real answer. A missing table is `ok: false` instead.
   */
  readonly athletes: readonly SwimCloudAthlete[];
  /** Data rows seen, including any that failed to parse. */
  readonly rowCount: number;
}

/**
 * Parse a SwimCloud team-roster page (`/team/{id}/roster/`).
 *
 * **Real-capture-verified** as of 2026-09-09 — see the file header. Written
 * against two pages SwimCloud actually served, archived as
 * `tests/fixtures/swimcloud-real-team-roster-58-gender-{m,f}.html` (Henderson
 * State, 35 men and 16 women). Those captures resolved OQ-3.
 *
 * ## The real page shape
 *
 * One `<table>` per (season, gender), inside a `c-card` whose `<h2 class="c-title">`
 * reads `Season {label} {Men|Women}`. Columns are rank, name (linking
 * `/swimmer/{id}`), hometown, class. The table is located by that heading first
 * and by the "a table with a name column" scan second, so a page that adds
 * another table cannot displace it.
 *
 * ## What is deliberately not in the output
 *
 * - **The power index.** Every row ends in a fifth cell linking
 *   `/swimmer/{id}/score/?season_id=…` with a number like `727.45`. That is a
 *   computed power rating, not a roster fact and not a swim time. It is
 *   excluded on purpose, not missed; a field for it would need a stated use and
 *   a decision about whether the number is trustworthy, and it has neither.
 * - **The row's rank number.** The leading `1…35` cell is a position in the
 *   page's current sort (`?sort=name` or `?sort=perf`), not a property of the
 *   swimmer, so recording it would invite treating a sort artifact as a ranking.
 * - **A `season_id`.** The page's filter form publishes an id-to-label table
 *   (`29` → `2025-2026`, `30` → `2026-2027`, and so on downward). Nothing
 *   proves that numbering is stable or site-wide, so no id is stored, computed,
 *   or reversed out of a label anywhere. To fetch a roster, omit `season_id`
 *   and let the server serve its own current season — which is what both real
 *   captures show it doing.
 *
 * ## Gender and season
 *
 * Both come from the page when the page states them, and the caller's options
 * only fill a gap. The URL's `?gender=` value is deliberately **not** consulted:
 * `SwimCloudTeamRosterQuery` documents why that parameter's encoding is carried
 * verbatim and never interpreted, and the printed word answers the same question
 * without an assumption. The heading and the filter form's checked radio are
 * cross-checked against each other; on both real captures they agree, and a
 * future disagreement raises `contradicted-page-declaration` instead of being
 * resolved silently.
 */
export function parseTeamRosterHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudRosterParseOptions = {},
): SwimCloudParseResult<SwimCloudRosterParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const teamIdFromUrl = teamIdFromSourceUrl(context.sourceUrl);
  if (teamIdFromUrl.mismatch) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${teamIdFromUrl.mismatch} resource, not a team or team roster.`,
      warnings,
      confidence,
    );
  }
  const swimCloudTeamId = options.teamId ?? teamIdFromUrl.teamId;

  const cleaned = stripNonContent(html);
  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a roster page is expected to contain one.',
      warnings,
      confidence,
    );
  }

  const located = locateRosterTable(cleaned, tables);
  if (located === null) {
    return fail(
      context,
      'expected-header-missing',
      `No table carried a name column (looked for ${NAME_HEADERS.join(', ')}).`,
      warnings,
      confidence,
    );
  }
  const { headerCells, dataRows, nameColumn } = located;

  const classColumn = findColumn(headerCells, CLASS_HEADERS);
  const hometownColumn = findColumn(headerCells, HOMETOWN_HEADERS);

  const athletes: SwimCloudAthlete[] = [];
  const heading = readRosterCardHeading(cleaned, warnings);
  const gender = resolveRosterGender(cleaned, heading.gender, options.gender, warnings);
  const season = resolveRosterSeason(heading.season, options.season, warnings);

  dataRows.forEach((cells, rowIndex) => {
    const name = textAt(cells, nameColumn);
    if (name.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Roster row has an empty name cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const swimmerId = swimmerIdFromCell(cellAt(cells, nameColumn));
    if (swimmerId === undefined) {
      warnings.push({
        code: 'missing-athlete-link',
        message: `Roster row for ${name} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
        rowIndex,
        raw: name,
      });
    }

    athletes.push({
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      name,
      ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
      ...readRosterClassYear(cells, classColumn, rowIndex, warnings),
      ...(gender.value === undefined ? {} : { gender: gender.value }),
      ...(season.value === undefined ? {} : { season: season.value }),
      ...readRosterHometown(cells, hometownColumn),
    });
  });

  if (dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message:
        'The roster table was found and holds no data rows. This is a real "nobody is listed" answer, not a missing table.',
    });
  } else if (athletes.length === 0) {
    return fail(
      context,
      'no-rows-parsed',
      `The roster table held ${dataRows.length} data row(s) and none could be parsed.`,
      warnings,
      confidence,
    );
  }

  const teamName = rosterTeamName(cleaned);
  const team = buildTeam(swimCloudTeamId, teamName, gender.value, season.value);

  return succeed(
    context,
    {
      ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
      ...(teamName === undefined ? {} : { teamName }),
      ...(gender.value === undefined ? {} : { gender: gender.value, genderSource: gender.source }),
      ...(season.value === undefined ? {} : { season: season.value, seasonSource: season.source }),
      ...(team === undefined ? {} : { team }),
      athletes,
      rowCount: dataRows.length,
    },
    warnings,
    confidence,
  );
}

/** One roster table, located and split into a header row and its data rows. */
interface LocatedRosterTable {
  /** {@link normalizeHeader}-normalized printed header labels. */
  readonly headerCells: readonly string[];
  /** Body rows, each already split into cell fragments. */
  readonly dataRows: readonly string[][];
  /** Index of the name column within {@link headerCells}. */
  readonly nameColumn: number;
}

/**
 * The roster table, preferring the one belonging to the page's own
 * `Season …` card.
 *
 * Both routes require a name column, so neither can pick up a sidebar table.
 * The card lookup exists because the real page carries its roster inside a
 * titled `c-card`, which is a stronger signal than table order and stays
 * correct if SwimCloud adds another table above it. The scan is the fallback
 * for a capture with no such card (the synthetic fixture, a trimmed snapshot).
 */
function locateRosterTable(
  cleaned: string,
  tables: readonly HtmlElementSpan[],
): LocatedRosterTable | null {
  const cardTable = locateSeasonCardTable(cleaned);
  const ordered = cardTable === null ? tables : [cardTable, ...tables];
  for (const table of ordered) {
    const rows = extractTableRows(table.html);
    if (rows.length === 0) {
      continue;
    }
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const headerCells = extractRowCells(rows[headerIndex]).map((cell) =>
      normalizeHeader(htmlToText(cell)),
    );
    const nameColumn = findColumn(headerCells, NAME_HEADERS);
    if (nameColumn < 0) {
      continue;
    }
    return {
      headerCells,
      nameColumn,
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    };
  }
  return null;
}

/** `Season 2025-2026 Men` — the roster card's own heading, as the real page prints it. */
const ROSTER_SEASON_HEADING = /^season\b\s*(.*)$/i;
/** A season label this parser will record. Anything else is reported, not reshaped. */
const SEASON_LABEL = /^\d{4}-\d{4}$/;

/** The `<h2 class="c-title">` of the roster card, when the page has one. */
function findSeasonCardHeading(cleaned: string): HtmlElementSpan | undefined {
  return findElementSpans(cleaned, 'h2').find(
    (h) =>
      classTokens(startTagOf(h.html)).includes('c-title') &&
      ROSTER_SEASON_HEADING.test(htmlToText(h.inner).trim()),
  );
}

/** The nearest table starting after the roster card's heading. */
function locateSeasonCardTable(cleaned: string): HtmlElementSpan | null {
  const heading = findSeasonCardHeading(cleaned);
  if (heading === undefined) {
    return null;
  }
  const after = findTables(cleaned).filter((t) => t.start > heading.start);
  if (after.length === 0) {
    return null;
  }
  return after.reduce((closest, t) => (t.start < closest.start ? t : closest));
}

/**
 * The season label and gender word the roster card's heading prints.
 *
 * The heading is one string carrying both facts — `Season 2025-2026 Men`. The
 * trailing gender word is taken off first, and what remains is the season
 * label. A label outside `YYYY-YYYY` is **not** reshaped into one: it is
 * reported with the raw text and the season is left absent, the same rule
 * {@link readMeetDateRange} follows for an unrecognized meet date.
 */
function readRosterCardHeading(
  cleaned: string,
  warnings: SwimCloudParseWarning[],
): { season?: string; gender?: SwimCloudGender } {
  const heading = findSeasonCardHeading(cleaned);
  if (heading === undefined) {
    return {};
  }
  const match = ROSTER_SEASON_HEADING.exec(htmlToText(heading.inner).trim());
  if (match === null) {
    return {};
  }

  let rest = match[1].trim();
  let gender: SwimCloudGender | undefined;
  const trailing = /\s*(men|women|mens|womens|mixed|boys|girls)$/i.exec(rest);
  if (trailing !== null) {
    const mapped = mapGender(trailing[1]);
    if (mapped !== 'unknown') {
      gender = mapped;
    }
    rest = rest.slice(0, trailing.index).trim();
  }

  if (rest.length === 0) {
    return gender === undefined ? {} : { gender };
  }
  if (!SEASON_LABEL.test(rest)) {
    warnings.push({
      code: 'unrecognized-season-label',
      message: `Roster heading season label ${JSON.stringify(rest)} is not the YYYY-YYYY shape; no season recorded.`,
      raw: rest,
    });
    return gender === undefined ? {} : { gender };
  }
  return { season: rest, ...(gender === undefined ? {} : { gender }) };
}

/**
 * The gender printed on the filter form's checked radio — the page's second,
 * independent statement of the same fact.
 *
 * The **label's printed word** is read, never the input's `value`. `value="M"`
 * next to the word `Men` is suggestive but is still an encoding nobody has been
 * told, which is the same reason `SwimCloudTeamRosterQuery` carries `gender`
 * verbatim without interpreting it.
 */
function readCheckedGenderLabel(cleaned: string): SwimCloudGender | undefined {
  for (const label of findElementSpans(cleaned, 'label')) {
    if (!hasCheckedGenderInput(label.inner)) {
      continue;
    }
    const mapped = mapGender(/^\s*(men|women|mens|womens)\b/i.exec(htmlToText(label.inner))?.[1]);
    if (mapped !== 'unknown') {
      return mapped;
    }
  }
  return undefined;
}

const INPUT_TAG = /<input\b[^>]*>/gi;

function hasCheckedGenderInput(fragment: string): boolean {
  INPUT_TAG.lastIndex = 0;
  for (let match = INPUT_TAG.exec(fragment); match !== null; match = INPUT_TAG.exec(fragment)) {
    const tag = match[0];
    if (readAttribute(tag, 'name') !== 'gender') {
      continue;
    }
    // `checked=""` and a bare `checked` are the same assertion; only the first
    // has a value for `readAttribute` to find.
    if (readAttribute(tag, 'checked') !== undefined || /\schecked(?=[\s/>])/i.test(tag)) {
      INPUT_TAG.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/** One page-versus-page or page-versus-caller disagreement, surfaced rather than resolved silently. */
function warnContradiction(
  warnings: SwimCloudParseWarning[],
  field: string,
  winner: string,
  loser: string,
  loserSource: string,
): void {
  warnings.push({
    code: 'contradicted-page-declaration',
    message: `The page's roster heading says the ${field} is ${JSON.stringify(winner)}; ${loserSource} says ${JSON.stringify(loser)}. The heading wins.`,
    raw: `${winner} vs ${loser}`,
  });
}

/** The page's heading wins; the filter form and the caller's option are cross-checks. */
function resolveRosterGender(
  cleaned: string,
  fromHeading: SwimCloudGender | undefined,
  fromOptions: SwimCloudGender | undefined,
  warnings: SwimCloudParseWarning[],
): { value?: SwimCloudGender; source?: SwimCloudRosterFieldSource } {
  const fromForm = readCheckedGenderLabel(cleaned);
  if (fromHeading !== undefined && fromForm !== undefined && fromHeading !== fromForm) {
    warnContradiction(warnings, 'gender', fromHeading, fromForm, "the filter form's checked control");
  }
  const fromPage = fromHeading ?? fromForm;
  if (fromPage !== undefined) {
    if (fromOptions !== undefined && fromOptions !== fromPage) {
      warnContradiction(warnings, 'gender', fromPage, fromOptions, 'the caller-supplied option');
    }
    return { value: fromPage, source: 'page' };
  }
  return fromOptions === undefined ? {} : { value: fromOptions, source: 'caller-supplied' };
}

/** Same page-wins rule as {@link resolveRosterGender}. */
function resolveRosterSeason(
  fromHeading: string | undefined,
  fromOptions: string | undefined,
  warnings: SwimCloudParseWarning[],
): { value?: string; source?: SwimCloudRosterFieldSource } {
  if (fromHeading !== undefined) {
    if (fromOptions !== undefined && fromOptions !== fromHeading) {
      warnContradiction(warnings, 'season', fromHeading, fromOptions, 'the caller-supplied option');
    }
    return { value: fromHeading, source: 'page' };
  }
  return fromOptions === undefined ? {} : { value: fromOptions, source: 'caller-supplied' };
}

function readRosterClassYear(
  cells: readonly string[],
  classColumn: number,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): { classYear?: SwimCloudClassYear } {
  if (classColumn < 0) {
    return {};
  }
  const rawClass = textAt(cells, classColumn);
  if (rawClass.length === 0) {
    // No class cell is a real "the page did not say", never a defaulted year.
    return {};
  }
  const mapped = CLASS_YEARS[normalizeHeader(rawClass)];
  if (mapped !== undefined) {
    return { classYear: mapped };
  }
  warnings.push({
    code: 'unmapped-class-year',
    message: `Class year ${JSON.stringify(rawClass)} is outside the known vocabulary; recorded as unknown.`,
    rowIndex,
    raw: rawClass,
  });
  return { classYear: 'unknown' };
}

/** A hometown cell holding a bare country code and no city — `MEX`, `USA`, `HUN`, `LTU` on the real capture. */
const BARE_COUNTRY_CODE = /^[A-Z]{3}$/;

/** See {@link SwimCloudAthlete.hometownCountryCode} for why these are two fields. */
function readRosterHometown(
  cells: readonly string[],
  hometownColumn: number,
): { hometown?: string; hometownCountryCode?: string } {
  if (hometownColumn < 0) {
    return {};
  }
  const text = textAt(cells, hometownColumn);
  if (text.length === 0) {
    return {};
  }
  if (BARE_COUNTRY_CODE.test(text)) {
    return { hometownCountryCode: text };
  }
  return { hometown: text };
}

function buildTeam(
  teamId: SwimCloudTeamId | undefined,
  teamName: string | undefined,
  gender: SwimCloudGender | undefined,
  season: string | undefined,
): SwimCloudTeam | undefined {
  if (teamId === undefined || teamName === undefined || gender === undefined) {
    return undefined;
  }
  return {
    swimCloudTeamId: teamId,
    gender,
    name: teamName,
    ...(season === undefined ? {} : { season }),
  };
}

/** `Roster - Henderson State University`, the only place the real roster page names the team. */
const ROSTER_TITLE = /^roster\s*-\s*(.+)$/i;

/**
 * The team's name.
 *
 * The real roster page carries no `<h1>` and no bare `/team/{id}/` link with the
 * team's name on it — its nav links to `/team/58/` under the word `Home`, which
 * is how a link-based rule would name the team "Home". The `<title>` is the one
 * place the name appears, as `Roster - {team}`; the prefix is stripped only when
 * it is exactly there, so a title of some other shape is used whole rather than
 * cut at a guessed separator. An `<h1>` is the fallback, for a capture whose
 * `<head>` was trimmed away.
 */
function rosterTeamName(cleaned: string): string | undefined {
  const title = findElementSpans(cleaned, 'title')[0];
  if (title !== undefined) {
    const text = htmlToText(title.inner);
    const match = ROSTER_TITLE.exec(text);
    const name = (match === null ? text : match[1]).trim();
    if (name.length > 0) {
      return name;
    }
  }
  return firstHeadingText(cleaned);
}

function firstHeadingText(html: string): string | undefined {
  const headings = findHeadings(html);
  for (const heading of headings) {
    if (heading.level === 1 && heading.text.length > 0) {
      return heading.text;
    }
  }
  return undefined;
}

function teamIdFromSourceUrl(sourceUrl: string): {
  teamId?: SwimCloudTeamId;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'team' || resource.kind === 'teamRoster' || resource.kind === 'teamResults') {
    return { teamId: resource.teamId };
  }
  return { mismatch: resource.kind };
}

/**
 * The swimmer id a row's athlete link carries, from either link shape.
 *
 * Both shapes are accepted because SwimCloud uses both, and a swimmer id is the
 * same fact whichever page linked to it. The meet-scoped
 * `/results/{meetId}/swimmer/{id}/` form is the one every results row actually
 * uses — confirmed on all three real captures — so restricting this to the bare
 * `/swimmer/{id}/` form (as it was until 2026-09-08) silently dropped the id
 * from every row of every real results page and fell back to matching athletes
 * by printed name, which is the ambiguity `suggestAliasCandidates` exists to
 * clean up after.
 */
function swimmerIdFromCell(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable') {
      continue;
    }
    const resource = classification.resource;
    if (resource.kind === 'swimmer' || resource.kind === 'meetSwimmer') {
      return resource.swimmerId;
    }
  }
  return undefined;
}

/**
 * The team id a row's team link carries, from any of the three link shapes.
 *
 * Same reasoning as {@link swimmerIdFromCell}: the meet-root results table links
 * its team column at `/results/{meetId}/team/{teamId}/`, never at `/team/{id}/`.
 */
function teamIdFromCell(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable') {
      continue;
    }
    const resource = classification.resource;
    if (resource.kind === 'team' || resource.kind === 'meetTeam' || resource.kind === 'meetTeamSwims') {
      return resource.teamId;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Meet results                                                                */
/* -------------------------------------------------------------------------- */

/** Caller-supplied facts a results page's markup cannot be trusted to state. */
export interface SwimCloudMeetResultsParseOptions {
  /**
   * Meet id, for captures whose URL cannot be classified (a Wayback snapshot,
   * say). Required if the capture URL does not name a meet.
   */
  readonly meetId?: SwimCloudMeetId;
  /**
   * The meet's course.
   *
   * This is the **only** thing that can turn a "200 Meter Freestyle" label into
   * LCM or SCM. Supplying it is the caller asserting a fact; leaving it out
   * leaves every metric event `course: 'unknown'` with an
   * `ambiguous-metric-course` warning. Yard events do not need it.
   */
  readonly meetCourse?: SwimCloudCourse;
  /**
   * Meet format, which selects the point table
   * (`plans/2026-09-06/02-data-model-and-scoring.md` §3).
   *
   * SwimCloud is not known to publish this in a machine-readable way, so it is
   * a caller assertion. Omitted means `'unknown'` — never `'dual'`.
   */
  readonly meetFormat?: SwimCloudMeetFormat;
  /** Governing rulebook. Omitted means `'unknown'` — never `'NCAA'`. */
  readonly meetRuleset?: SwimCloudRuleset;
}

/** One event and everything read from its results table. */
export interface SwimCloudParsedEvent {
  readonly event: SwimCloudEvent;
  /** One entry per data row, in page order. */
  readonly entries: readonly SwimCloudEntry[];
  /** One result per data row, paired to {@link entries} by `entryId`. */
  readonly results: readonly SwimCloudResult[];
  /** Relay units, for relay events only. Empty for individual events. */
  readonly relays: readonly SwimCloudRelay[];
}

/** What {@link parseMeetResultsHtml} extracts. */
export interface SwimCloudMeetResultsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** From the page's first heading. */
  readonly meetName?: string;
  /**
   * The meet record.
   *
   * `format`, `ruleset` and `course` are `'unknown'` unless the caller asserted
   * them through {@link SwimCloudMeetResultsParseOptions}. They are never
   * inferred from the page.
   */
  readonly meet: SwimCloudMeet;
  readonly events: readonly SwimCloudParsedEvent[];
  /**
   * How many event headings the page carried.
   *
   * Compare against `events.length`: a shortfall means some event's table could
   * not be read, and each shortfall has a matching `unparsed-event` warning.
   * This field exists so a caller can detect a partial parse without diffing
   * warning codes — a partially-read meet must not look like a complete one.
   */
  readonly eventHeadingCount: number;
}

/**
 * Parse a SwimCloud meet-results page.
 *
 * **Synthetic-fixture-only** — see the file header. Never validated against a
 * page SwimCloud served.
 *
 * The page is read as a sequence of event headings (`Event 3 Women 200 Yard
 * Freestyle Relay`) each governing the next table. Sessions and heats are **not**
 * extracted: no evidence exists that SwimCloud's results view exposes them, and
 * emitting an empty session list would assert that we looked and found none.
 *
 * @deprecated Since 2026-09-08. A real capture proved this page shape does
 * not exist on SwimCloud (see this file's header). Its last user-reachable
 * call site, `packages/manager/src/components/RosterImportWizard.tsx`'s
 * `handleClipboardMeetResults`, was re-pointed the same day to
 * `parseTeamMeetSwimsHtml` — see
 * `plans/2026-09-08/04-parsers-and-fixtures.md`'s "Retired" section for the
 * three-step retirement plan this is step 2 of. Kept for one more round
 * (its table-reading and points/place-token edge cases are still exercised
 * only by this function's synthetic fixtures) before deletion alongside
 * `SwimCloudMeetResultsParse`, `SwimCloudParsedEvent`,
 * `swimCloudMeetResultsToSwimmerResults` and
 * `swimCloudMeetResultsToHistoricalSwims`.
 */
export function parseMeetResultsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetResultsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetResultsParse> {
  const warnings: SwimCloudParseWarning[] = [];

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.');
  }

  const fromUrl = meetIdFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a meet.`,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  if (meetId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a meet and no meetId option was supplied.`,
    );
  }

  const tables = findTables(html);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a results page is expected to contain at least one.',
    );
  }

  const headings = findHeadings(html);
  const eventHeadings = headings
    .map((heading) => ({ heading, parsed: parseEventHeading(heading.text) }))
    .filter((candidate): candidate is { heading: (typeof headings)[number]; parsed: ParsedEventHeading } =>
      candidate.parsed !== null,
    );

  if (eventHeadings.length === 0) {
    return fail(
      context,
      'expected-header-missing',
      'No heading matched the expected "Event {n} {Gender} {Distance} {Unit} {Stroke}" shape.',
    );
  }

  const parsedEvents: SwimCloudParsedEvent[] = [];

  for (const table of tables) {
    // Each table belongs to the last event heading that precedes it.
    let owner: (typeof eventHeadings)[number] | undefined;
    for (const candidate of eventHeadings) {
      if (candidate.heading.start < table.start) {
        owner = candidate;
      }
    }
    if (owner === undefined) {
      continue;
    }
    const ownerRef = owner.parsed.eventRef;
    // A second table under the same heading is not modelled; only the first is
    // read, and the extra is reported rather than silently merged.
    if (parsedEvents.some((parsed) => parsed.event.eventRef === ownerRef)) {
      warnings.push({
        code: 'unparsed-event',
        message: `A second table follows event heading ${JSON.stringify(owner.heading.text)}; only the first table of an event is read.`,
        raw: owner.heading.text,
      });
      continue;
    }

    const built = buildEvent(meetId, owner.parsed, options, warnings);
    const parsed = parseEventTable(table.html, built, warnings);
    if (parsed === null) {
      warnings.push({
        code: 'unparsed-event',
        message: `Results table for ${JSON.stringify(owner.heading.text)} lacks the columns required to read it; the event is absent from the output.`,
        eventId: built.eventId,
        raw: owner.heading.text,
      });
      continue;
    }
    parsedEvents.push(parsed);
  }

  if (parsedEvents.length === 0) {
    return fail(
      context,
      'no-events-parsed',
      `${eventHeadings.length} event heading(s) were found and none of their tables could be read.`,
      warnings,
    );
  }

  const meetName = firstHeadingText(html);
  const meet: SwimCloudMeet = {
    swimCloudMeetId: meetId,
    name: meetName ?? '',
    format: options.meetFormat ?? 'unknown',
    ruleset: options.meetRuleset ?? 'unknown',
    course: options.meetCourse ?? 'unknown',
  };

  return succeed(
    context,
    {
      swimCloudMeetId: meetId,
      ...(meetName === undefined ? {} : { meetName }),
      meet,
      events: parsedEvents,
      eventHeadingCount: eventHeadings.length,
    },
    warnings,
  );
}

function meetIdFromSourceUrl(sourceUrl: string): { meetId?: SwimCloudMeetId; mismatch?: string } {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'meet' || resource.kind === 'meetEvent') {
    return { meetId: resource.meetId };
  }
  return { mismatch: resource.kind };
}

/* -------------------------------------------------------------------------- */
/* Event headings                                                              */
/* -------------------------------------------------------------------------- */

interface ParsedEventHeading {
  readonly label: string;
  /** Always present: the heading pattern requires an event reference to match at all. */
  readonly eventRef: string;
  readonly gender: SwimCloudGenderOrUnknown;
  readonly genderWord?: string;
  readonly distance?: number;
  readonly unit: 'yard' | 'metric' | 'none';
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
}

const EVENT_HEADING = /^event\s+(\S+)\s+(.*)$/i;

/**
 * Parse an event heading such as `Event 3 Women 200 Yard Freestyle Relay`.
 *
 * Returns `null` for a heading that is not an event heading — the page title,
 * a section label — so those are skipped rather than turned into an event with
 * unknown everything.
 */
function parseEventHeading(text: string): ParsedEventHeading | null {
  const match = EVENT_HEADING.exec(text);
  if (match === null) {
    return null;
  }
  const eventRef = match[1];
  const rest = match[2];
  const lower = rest.toLowerCase();

  const genderMatch = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(rest);
  const genderWord = genderMatch === null ? undefined : genderMatch[1];
  const gender = mapGender(genderWord);

  const distanceMatch = /\b(\d{1,4})\b/.exec(rest);
  const distance = distanceMatch === null ? undefined : Number.parseInt(distanceMatch[1], 10);

  const unit: ParsedEventHeading['unit'] = /\byards?\b/.test(lower)
    ? 'yard'
    : /\bmet(?:er|re)s?\b|\bmtr\b/.test(lower)
      ? 'metric'
      : 'none';

  const isRelay = /\brelay\b/.test(lower);

  return {
    label: text,
    eventRef,
    gender,
    ...(genderWord === undefined ? {} : { genderWord }),
    ...(distance === undefined ? {} : { distance }),
    unit,
    stroke: mapStroke(lower, isRelay),
    isRelay,
  };
}

function mapGender(word: string | undefined): SwimCloudGenderOrUnknown {
  if (word === undefined) {
    return 'unknown';
  }
  const lower = word.toLowerCase();
  if (lower === 'men' || lower === 'mens') {
    return 'Men';
  }
  if (lower === 'women' || lower === 'womens') {
    return 'Women';
  }
  // `Mixed`, `Boys`, `Girls` have no home in the two-value program vocabulary
  // this repo uses. They are reported as unknown rather than forced into one.
  return 'unknown';
}

function mapStroke(lowerLabel: string, isRelay: boolean): SwimCloudStroke {
  if (/\bdiving\b|\bdiver\b|\bdive\b/.test(lowerLabel)) {
    return 'Diving';
  }
  if (isRelay) {
    if (/\bmedley\b/.test(lowerLabel)) {
      return 'Medley Relay';
    }
    if (/\bfree(style)?\b/.test(lowerLabel)) {
      return 'Freestyle Relay';
    }
    return 'unknown';
  }
  if (/\bindividual medley\b|\bim\b/.test(lowerLabel)) {
    return 'Individual Medley';
  }
  if (/\bbutterfly\b|\bfly\b/.test(lowerLabel)) {
    return 'Butterfly';
  }
  if (/\bbackstroke\b|\bback\b/.test(lowerLabel)) {
    return 'Backstroke';
  }
  if (/\bbreaststroke\b|\bbreast\b/.test(lowerLabel)) {
    return 'Breaststroke';
  }
  if (/\bfreestyle\b|\bfree\b/.test(lowerLabel)) {
    return 'Freestyle';
  }
  return 'unknown';
}

function buildEvent(
  meetId: SwimCloudMeetId,
  heading: ParsedEventHeading,
  options: SwimCloudMeetResultsParseOptions,
  warnings: SwimCloudParseWarning[],
): SwimCloudEvent {
  // Deterministic and capture-local: re-parsing the same HTML yields the same
  // ids, so a re-import updates rather than duplicates. These are not SwimCloud
  // ids and must never be presented as such.
  const eventId = `${meetId}:event:${heading.eventRef}`;

  let course: SwimCloudCourseOrUnknown;
  if (heading.unit === 'yard') {
    course = 'SCY';
  } else if (heading.unit === 'metric') {
    if (options.meetCourse === undefined) {
      course = 'unknown';
      warnings.push({
        code: 'ambiguous-metric-course',
        message: `Event ${JSON.stringify(heading.label)} is metric, which is ambiguous between LCM and SCM. No meet-level course was supplied, so the course is left unknown rather than guessed.`,
        eventId,
        raw: heading.label,
      });
    } else {
      course = options.meetCourse;
    }
  } else if (options.meetCourse === undefined) {
    course = 'unknown';
    warnings.push({
      code: 'missing-course-declaration',
      message: `Event ${JSON.stringify(heading.label)} names no course unit and no meet-level course was supplied.`,
      eventId,
      raw: heading.label,
    });
  } else {
    course = options.meetCourse;
  }

  if (heading.stroke === 'unknown') {
    warnings.push({
      code: 'unmapped-stroke',
      message: `Stroke could not be identified in ${JSON.stringify(heading.label)}; recorded as unknown.`,
      eventId,
      raw: heading.label,
    });
  }
  if (heading.gender === 'unknown') {
    warnings.push({
      code: 'unmapped-gender',
      message: `Gender ${JSON.stringify(heading.genderWord ?? '')} in ${JSON.stringify(heading.label)} is outside Men/Women; recorded as unknown.`,
      eventId,
      raw: heading.label,
    });
  }

  return {
    eventId,
    swimCloudMeetId: meetId,
    ...(heading.eventRef === undefined ? {} : { eventRef: heading.eventRef }),
    label: heading.label,
    kind: heading.isRelay ? 'relay' : 'individual',
    course,
    gender: heading.gender,
    ...(heading.distance === undefined ? {} : { distance: heading.distance }),
    stroke: heading.stroke,
  };
}

/* -------------------------------------------------------------------------- */
/* Results tables                                                              */
/* -------------------------------------------------------------------------- */

function parseEventTable(
  tableHtml: string,
  event: SwimCloudEvent,
  warnings: SwimCloudParseWarning[],
): SwimCloudParsedEvent | null {
  const rows = extractTableRows(tableHtml);
  const headerIndex = rows.findIndex((row) => isHeaderRow(row));
  if (headerIndex < 0) {
    return null;
  }
  const headers = extractRowCells(rows[headerIndex]).map((cell) => normalizeHeader(htmlToText(cell)));

  const placeColumn = findColumn(headers, PLACE_HEADERS);
  const nameColumn = findColumn(headers, NAME_HEADERS);
  const teamColumn = findColumn(headers, TEAM_HEADERS);
  const timeColumn = findColumn(headers, TIME_HEADERS);
  const pointsColumn = findColumn(headers, POINTS_HEADERS);

  if (timeColumn < 0) {
    return null;
  }
  const subjectColumn = event.kind === 'relay' ? teamColumn : nameColumn;
  if (subjectColumn < 0) {
    return null;
  }


  const dataRows = rows
    .slice(headerIndex + 1)
    .filter((row) => !isHeaderRow(row))
    .map((row) => extractRowCells(row));

  const entries: SwimCloudEntry[] = [];
  const results: SwimCloudResult[] = [];
  const relays: SwimCloudRelay[] = [];

  dataRows.forEach((cells, rowIndex) => {
    const entryId = `${event.eventId}:entry:${rowIndex}`;
    const subjectHtml = cellAt(cells, subjectColumn);
    const subjectText = htmlToText(stripElements(subjectHtml, ['ol', 'ul']));
    if (subjectText.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Result row has an empty subject cell and was skipped.',
        eventId: event.eventId,
        rowIndex,
      });
      return;
    }

    const teamId =
      teamColumn >= 0 ? teamIdFromCell(cellAt(cells, teamColumn)) : teamIdFromCell(subjectHtml);
    const place = readPlace(textAt(cells, placeColumn), event, rowIndex, warnings);
    const time = readTime(textAt(cells, timeColumn), event, rowIndex, warnings);
    const points = pointsColumn >= 0 ? readPoints(textAt(cells, pointsColumn), event, rowIndex, warnings) : {};

    let relayId: string | undefined;
    let teamName: string | undefined;
    if (event.kind === 'relay') {
      relayId = `${event.eventId}:relay:${rowIndex}`;
      const designator = readRelayDesignator(subjectText);
      const legs = readRelayLegs(subjectHtml);
      if (legs.length === 0) {
        warnings.push({
          code: 'relay-legs-absent',
          message: `Relay row for ${JSON.stringify(subjectText)} lists no legs. If SwimCloud does not publish relay leg splits at all, this is the permanent, expected state — see plans/2026-09-06/04-phasing.md open question 4.`,
          eventId: event.eventId,
          rowIndex,
          raw: subjectText,
        });
      }
      teamName = designator === undefined ? subjectText : designator.teamName;
      relays.push({
        relayId,
        eventId: event.eventId,
        ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
        teamName,
        ...(designator === undefined ? {} : { designator: designator.designator }),
        legs,
      });
    } else if (teamColumn >= 0) {
      // Individual event: the subject column is the athlete's name, not the
      // team — the team's printed name lives in its own column, same one
      // teamIdFromCell already reads for the id.
      const rawTeamName = textAt(cells, teamColumn);
      teamName = rawTeamName.length === 0 ? undefined : rawTeamName;
    }

    const swimmerId = event.kind === 'relay' ? undefined : swimmerIdFromCell(subjectHtml);
    if (event.kind === 'individual' && swimmerId === undefined) {
      warnings.push({
        code: 'missing-athlete-link',
        message: `Result row for ${subjectText} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
        eventId: event.eventId,
        rowIndex,
        raw: subjectText,
      });
    }

    entries.push({
      entryId,
      eventId: event.eventId,
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      ...(event.kind === 'individual' ? { athleteName: subjectText } : {}),
      ...(relayId === undefined ? {} : { relayId }),
      ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
      ...(teamName === undefined ? {} : { teamName }),
    });

    results.push({
      resultId: `${event.eventId}:result:${rowIndex}`,
      entryId,
      eventId: event.eventId,
      ...(place === undefined ? {} : { place }),
      ...(points.points === undefined ? {} : { points: points.points }),
      ...(points.rawPointsToken === undefined ? {} : { rawPointsToken: points.rawPointsToken }),
      ...(time.finalTime === undefined ? {} : { finalTime: time.finalTime }),
      ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
      ...(time.flags === undefined ? {} : { flags: time.flags }),
    });
  });

  if (dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message: `Results table for ${JSON.stringify(event.label)} was found and holds no data rows. This is a real "nobody swam / nothing posted yet" answer, not a missing table.`,
      eventId: event.eventId,
    });
  }

  return { event, entries, results, relays };
}

function readPlace(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): number | undefined {
  const token = raw.trim();
  if (NO_PLACE_TOKENS.has(token.toLowerCase())) {
    return undefined;
  }
  if (/^\d+$/.test(token)) {
    const value = Number.parseInt(token, 10);
    if (value > 0) {
      return value;
    }
    // "0" is numeric but not a valid place (places start at 1). Falls through
    // to the same warning below as a non-numeric token, rather than silently
    // becoming "no place" with no audit trail — a real "no place" always
    // comes from NO_PLACE_TOKENS above, never from a printed zero.
  }
  warnings.push({
    code: 'unrecognized-place-token',
    message: `Place cell ${JSON.stringify(token)} is neither a valid place (an integer of 1 or more) nor a known "no place" marker; no place recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return undefined;
}

interface ReadPoints {
  readonly points?: number;
  readonly rawPointsToken?: string;
}

/**
 * See {@link SwimCloudResult}'s doc comment for why this field exists at
 * all — it was not always captured, and still isn't *trusted* by anything
 * in this file; capturing is all a parser ever does.
 *
 * An empty cell is not a warning-worthy case (plenty of rows — DQ, no-show,
 * exhibition — legitimately score nothing) but anything present that isn't
 * a clean non-negative number is preserved verbatim and flagged, same
 * discipline as every other cell in this file.
 */
function readPoints(raw: string, event: SwimCloudEvent, rowIndex: number, warnings: SwimCloudParseWarning[]): ReadPoints {
  const token = raw.trim();
  if (token.length === 0) {
    return {};
  }
  if (/^\d+(\.\d+)?$/.test(token)) {
    const value = Number.parseFloat(token);
    return { points: value };
  }
  warnings.push({
    code: 'unrecognized-points-token',
    message: `Points cell ${JSON.stringify(token)} is not a non-negative number; no points recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return { rawPointsToken: token };
}

interface ReadTime {
  readonly finalTime?: string;
  readonly rawTimeToken?: string;
  readonly flags?: SwimCloudResultFlags;
}

function readTime(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): ReadTime {
  const token = raw.trim();
  if (token.length === 0) {
    return {};
  }

  // A leading `X` on the *time token* marks an exhibition swim in Hy-Tek-derived
  // output. **Still unverified for SwimCloud** — kept, deliberately, and here is
  // the reasoning as of 2026-09-10.
  //
  // The per-event results page (`parseMeetEventResultsHtml`) has a *different*,
  // now-confirmed exhibition marker: a `<span title="Exhibition">X</span>`
  // replacing the ordinal in the row's rank cell. That finding says what the
  // per-event page does. It says nothing about the swims list, which this
  // function also serves and which has **no rank-cell marker of any kind** —
  // its rows carry an ordinal that is only a row number. So retiring this check
  // would leave the swims-list path with no exhibition detection whatsoever,
  // and an exhibition swim there would silently score. Keeping an unproven
  // check that has never fired on a real capture costs nothing; removing the
  // only check on that path could cost a wrong team score.
  //
  // The two cannot collide: the per-event page's time cells print a bare time
  // (`54.27`), never `X54.27`, so on that page this branch never fires and the
  // rank cell is the sole source of the flag.
  const exhibition = /^x/i.test(token) && TIME_TOKEN.test(token.slice(1));
  const body = exhibition ? token.slice(1) : token;

  if (event.stroke === 'Diving') {
    // A diving column holds a judged score, not a time. Storing it in a time
    // field would put a non-time into a field everything downstream reads as a
    // time.
    warnings.push({
      code: 'diving-score-not-a-time',
      message: `Diving result ${JSON.stringify(token)} is a judged score, not a time; preserved verbatim and not stored as finalTime.`,
      eventId: event.eventId,
      rowIndex,
      raw: token,
    });
    return {
      rawTimeToken: token,
      ...(exhibition ? { flags: { exhibition: true } } : {}),
    };
  }

  if (TIME_TOKEN.test(body)) {
    return {
      finalTime: body,
      ...(exhibition ? { flags: { exhibition: true } } : {}),
    };
  }

  const marker = RESULT_MARKERS[body.toLowerCase()];
  if (marker !== undefined) {
    return {
      rawTimeToken: token,
      flags: exhibition ? { ...marker, exhibition: true } : marker,
    };
  }

  warnings.push({
    code: 'unrecognized-time-token',
    message: `Time cell ${JSON.stringify(token)} is neither a time nor a known marker (${Object.keys(RESULT_MARKERS).join(', ').toUpperCase()}); preserved verbatim, no time recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return { rawTimeToken: token };
}

const RELAY_DESIGNATOR = /^(.*?)\s*['‘’"“”]\s*([A-Za-z])\s*['‘’"“”]?\s*$/;

function readRelayDesignator(text: string): { teamName: string; designator: string } | undefined {
  const match = RELAY_DESIGNATOR.exec(text);
  if (match === null) {
    return undefined;
  }
  const teamName = match[1].trim();
  if (teamName.length === 0) {
    return undefined;
  }
  return { teamName, designator: match[2].toUpperCase() };
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
function readRelayLegs(subjectHtml: string): SwimCloudRelayLeg[] {
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

/* -------------------------------------------------------------------------- */
/* Swimmer profile / personal bests                                           */
/* -------------------------------------------------------------------------- */

/**
 * One personal-best row from a swimmer's profile page.
 *
 * **This is the guessed shape, not the real one.** The 2026-09-09 capture of
 * `/swimmer/{id}/times/` settled it: the real Personal Bests table is the
 * default tab, fully server-rendered (no click needed, contrary to the
 * prior-art research in `plans/2026-09-06/04-phasing.md` open question 2), and
 * it carries **no course column** — the course is a suffix of the event label.
 * This type models a course column and a bare event label, so it describes a
 * table SwimCloud does not serve. Use {@link SwimCloudPersonalBestSwim} and
 * {@link parseSwimmerTimesHtml} for the real page.
 *
 * The sibling "EVENT PROGRESSION" tab remains uncaptured and its markup
 * unknown; nothing in this file parses it or assumes its shape.
 */
export interface SwimCloudPersonalBest {
  /** Event exactly as printed, e.g. `'200 Free'` or `'200 Yard Freestyle'`. */
  readonly label: string;
  readonly course: SwimCloudCourseOrUnknown;
  readonly stroke: SwimCloudStroke;
  readonly distance?: number;
  /** Absent when the time cell held anything other than a well-formed hundredths-precision time. */
  readonly time?: SwimCloudTimeString;
  /** The cell's raw contents, kept whenever {@link time} could not be populated. */
  readonly rawTimeToken?: string;
  /** As printed. Never parsed into a Date — a partial/ambiguous date string is not this parser's business to interpret. */
  readonly date?: string;
  /** Meet name as printed, when the row names one. */
  readonly meetName?: string;
}

export interface SwimCloudSwimmerProfileParseOptions {
  /** Swimmer id, for captures whose URL cannot be classified (a Wayback snapshot, say). */
  readonly swimmerId?: SwimCloudSwimmerId;
  /**
   * The swimmer's program gender. Never inferred from the page or the name —
   * same discipline as {@link SwimCloudRosterParseOptions.gender}.
   */
  readonly gender?: SwimCloudGender;
  /**
   * Default course for a row whose event label carries no explicit unit (a
   * bare `'200 Free'` rather than `'200 Yard Free'`). SwimCloud's own course
   * convention for this table is unverified; supplying this is a caller
   * assertion, same shape as {@link SwimCloudMeetResultsParseOptions.meetCourse}.
   */
  readonly defaultCourse?: SwimCloudCourse;
}

export interface SwimCloudSwimmerProfileParse {
  readonly swimCloudSwimmerId: SwimCloudSwimmerId;
  /** From the page's first heading. */
  readonly name?: string;
  readonly gender?: SwimCloudGender;
  /**
   * Personal-best rows, in page order.
   *
   * An empty array here always comes with a `zero-data-rows` warning — the
   * table existed and listed nothing, a real (if unusual) answer. A missing
   * table is `ok: false`, per this file's absent-is-never-empty rule.
   */
  readonly personalBests: readonly SwimCloudPersonalBest[];
  readonly rowCount: number;
}

const EVENT_LABEL_HEADERS = ['event', 'race'] as const;
const DATE_HEADERS = ['date', 'swam'] as const;
const MEET_HEADERS = ['meet', 'competition'] as const;
const COURSE_HEADERS = ['course', 'pool'] as const;

/**
 * Distance/unit/stroke out of a personal-best row's event label — the same
 * job {@link parseEventHeading} does for a meet heading, but without an
 * "Event {n}" prefix or a gender word to strip first.
 */
function parsePersonalBestEventLabel(label: string): {
  readonly distance?: number;
  readonly unit: 'yard' | 'metric' | 'none';
  readonly stroke: SwimCloudStroke;
} {
  const lower = label.toLowerCase();
  const distanceMatch = /\b(\d{1,4})\b/.exec(label);
  const distance = distanceMatch === null ? undefined : Number.parseInt(distanceMatch[1], 10);
  const unit: 'yard' | 'metric' | 'none' = /\byards?\b/.test(lower)
    ? 'yard'
    : /\bmet(?:er|re)s?\b|\bmtr\b/.test(lower)
      ? 'metric'
      : 'none';
  const isRelay = /\brelay\b/.test(lower);
  return {
    ...(distance === undefined ? {} : { distance }),
    unit,
    stroke: mapStroke(lower, isRelay),
  };
}

/**
 * Parse a SwimCloud swimmer-profile page's personal-bests table.
 *
 * **Synthetic-fixture-only** — see this file's header. Additionally
 * unverified whether the underlying table is ever present without a
 * tab-click first; see {@link SwimCloudPersonalBest}'s doc comment.
 *
 * Locates the first table whose header row carries both an event column and
 * a time column, then reads rows by header label — same discipline as
 * {@link parseTeamRosterHtml} and {@link parseMeetResultsHtml}: columns
 * located by printed label, never by position.
 *
 * @deprecated Since 2026-09-09. Real captures proved both of its assumptions
 * wrong: `/swimmer/{id}/` carries a narrower "Latest Results" panel rather than
 * a bests table, and the real bests table (on `/swimmer/{id}/times/`) has no
 * course column. Use {@link parseSwimmerTimesHtml}. No longer called from
 * `packages/manager/src/components/RosterImportWizard.tsx`; kept for one round
 * per `plans/2026-09-08/04-parsers-and-fixtures.md`'s "Retired" section.
 */
export function parseSwimmerProfileHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudSwimmerProfileParseOptions = {},
): SwimCloudParseResult<SwimCloudSwimmerProfileParse> {
  const warnings: SwimCloudParseWarning[] = [];

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.');
  }

  const classification = classifySwimCloudUrl(context.sourceUrl);
  let swimmerIdFromUrl: SwimCloudSwimmerId | undefined;
  if (classification.outcome === 'fetchable') {
    if (classification.resource.kind === 'swimmer') {
      swimmerIdFromUrl = classification.resource.swimmerId;
    } else {
      return fail(
        context,
        'source-url-mismatch',
        `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${classification.resource.kind} resource, not a swimmer.`,
      );
    }
  }
  const swimCloudSwimmerId = options.swimmerId ?? swimmerIdFromUrl;
  if (swimCloudSwimmerId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No swimmer id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a swimmer and no swimmerId option was supplied.`,
    );
  }

  const tables = findTables(html);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a personal-bests table is expected. If the swimmer page loads times behind a tab, that tab may need to be opened before capturing — see SwimCloudPersonalBest\'s doc comment.',
    );
  }

  let headerCells: string[] | null = null;
  let dataRows: string[][] = [];
  let eventColumn = -1;
  let timeColumn = -1;
  let courseColumn = -1;
  let dateColumn = -1;
  let meetColumn = -1;

  for (const table of tables) {
    const rows = extractTableRows(table.html);
    if (rows.length === 0) {
      continue;
    }
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const headers = extractRowCells(rows[headerIndex]).map((cell) => normalizeHeader(htmlToText(cell)));
    const candidateEvent = findColumn(headers, EVENT_LABEL_HEADERS);
    const candidateTime = findColumn(headers, TIME_HEADERS);
    if (candidateEvent < 0 || candidateTime < 0) {
      continue;
    }
    headerCells = headers;
    eventColumn = candidateEvent;
    timeColumn = candidateTime;
    courseColumn = findColumn(headers, COURSE_HEADERS);
    dateColumn = findColumn(headers, DATE_HEADERS);
    meetColumn = findColumn(headers, MEET_HEADERS);
    dataRows = rows
      .slice(headerIndex + 1)
      .filter((row) => !isHeaderRow(row))
      .map((row) => extractRowCells(row));
    break;
  }

  if (headerCells === null) {
    return fail(
      context,
      'expected-header-missing',
      `No table carried both an event column (${EVENT_LABEL_HEADERS.join(', ')}) and a time column (${TIME_HEADERS.join(', ')}).`,
    );
  }

  const personalBests: SwimCloudPersonalBest[] = [];
  dataRows.forEach((cells, rowIndex) => {
    const label = textAt(cells, eventColumn);
    if (label.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Personal-best row has an empty event cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const { distance, unit, stroke } = parsePersonalBestEventLabel(label);

    let course: SwimCloudCourseOrUnknown;
    if (unit === 'yard') {
      course = 'SCY';
      // "Yard" in the label is about as unambiguous a signal as this domain
      // has, so it still wins — but an explicit course column that disagrees
      // is a real anomaly (stale markup, a copy-pasted row) worth a human's
      // attention, not something to resolve silently either direction.
      if (courseColumn >= 0) {
        const rawCourseCell = textAt(cells, courseColumn);
        if (rawCourseCell.length > 0 && normalizeHeader(rawCourseCell) !== 'scy') {
          warnings.push({
            code: 'course-column-contradicts-label',
            message: `Row for ${JSON.stringify(label)} names a yard event, but its course column reads ${JSON.stringify(rawCourseCell)}. Recorded as SCY (the label); the column is preserved here for review, not silently trusted over the label.`,
            rowIndex,
            raw: rawCourseCell,
          });
        }
      }
    } else if (courseColumn >= 0 && textAt(cells, courseColumn).length > 0) {
      const raw = normalizeHeader(textAt(cells, courseColumn));
      course = raw === 'scy' ? 'SCY' : raw === 'scm' ? 'SCM' : raw === 'lcm' ? 'LCM' : 'unknown';
      if (course === 'unknown') {
        warnings.push({
          code: 'ambiguous-metric-course',
          message: `Course cell ${JSON.stringify(textAt(cells, courseColumn))} on row for ${JSON.stringify(label)} did not match a known course; recorded as unknown.`,
          rowIndex,
          raw: textAt(cells, courseColumn),
        });
      }
    } else if (unit === 'metric') {
      if (options.defaultCourse === undefined) {
        course = 'unknown';
        warnings.push({
          code: 'ambiguous-metric-course',
          message: `Row for ${JSON.stringify(label)} is metric with no course column and no defaultCourse supplied; recorded as unknown.`,
          rowIndex,
          raw: label,
        });
      } else {
        course = options.defaultCourse;
      }
    } else if (options.defaultCourse === undefined) {
      course = 'unknown';
      warnings.push({
        code: 'missing-course-declaration',
        message: `Row for ${JSON.stringify(label)} names no course unit, no course column, and no defaultCourse was supplied.`,
        rowIndex,
        raw: label,
      });
    } else {
      course = options.defaultCourse;
    }

    if (stroke === 'unknown') {
      warnings.push({
        code: 'unmapped-stroke',
        message: `Stroke could not be identified in ${JSON.stringify(label)}; recorded as unknown.`,
        rowIndex,
        raw: label,
      });
    }

    const time = readTime(textAt(cells, timeColumn), fakeEventFor(label, stroke), rowIndex, warnings);
    const date = dateColumn >= 0 ? textAt(cells, dateColumn) : '';
    const meetName = meetColumn >= 0 ? textAt(cells, meetColumn) : '';

    personalBests.push({
      label,
      course,
      stroke,
      ...(distance === undefined ? {} : { distance }),
      ...(time.finalTime === undefined ? {} : { time: time.finalTime }),
      ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
      ...(date.length === 0 ? {} : { date }),
      ...(meetName.length === 0 ? {} : { meetName }),
    });
  });

  if (dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message: 'The personal-bests table was found and holds no data rows.',
    });
  } else if (personalBests.length === 0) {
    return fail(
      context,
      'no-rows-parsed',
      `The personal-bests table held ${dataRows.length} data row(s) and none could be parsed.`,
      warnings,
    );
  }

  const name = firstHeadingText(html);

  return succeed(
    context,
    {
      swimCloudSwimmerId,
      ...(name === undefined ? {} : { name }),
      ...(options.gender === undefined ? {} : { gender: options.gender }),
      personalBests,
      rowCount: dataRows.length,
    },
    warnings,
  );
}

/**
 * `readTime` takes a {@link SwimCloudEvent} only to read its `stroke` (for the
 * diving-score-is-not-a-time branch) and its `eventId` (to scope warnings). A
 * personal-bests row has neither a real event id nor, usually, a diving flag
 * worth the same branch — this builds the minimal stand-in `readTime` needs
 * without duplicating its ~40 lines of marker/exhibition logic for a second
 * table shape.
 */
function fakeEventFor(label: string, stroke: SwimCloudStroke): SwimCloudEvent {
  return {
    eventId: `personal-best:${label}`,
    swimCloudMeetId: 'personal-best' as SwimCloudMeetId,
    label,
    kind: 'individual',
    course: 'unknown',
    gender: 'unknown',
    stroke,
  };
}

/* -------------------------------------------------------------------------- */
/* Swimmer times — the real `/swimmer/{id}/times/` personal-bests table        */
/* -------------------------------------------------------------------------- */

/**
 * One chip printed in a personal-best row's badge column, captured verbatim.
 *
 * The real capture prints four kinds in one column and does not say which kind
 * a given chip is: `NCAA B` and `WIN JRS` are qualifying standards, `X`
 * (`title="Extracted"`) is a statement about where SwimCloud got the time, and
 * `R` (`title="Leadoff"`) says the time is a relay leadoff split. Because the
 * page does not separate them, this type does not either — it carries the
 * visible code and the tooltip, and resolves neither.
 *
 * Resolving a code to a meaning is deliberately out of scope, for the reason
 * {@link SwimCloudCutStandardLabel} gives: a scraped badge is not a cut
 * decision, and `CLAUDE.md`'s provenance rules reserve that answer for the
 * cutline tables, which trace every value to an archived PDF.
 *
 * **`X` here is not the Hy-Tek exhibition marker.** {@link readTime} treats a
 * leading `X` on a *time token* as exhibition; this `X` is a separate chip in a
 * separate cell whose own tooltip reads `Extracted`. They are unrelated, and
 * this parser never maps one to the other.
 */
export interface SwimCloudSwimmerTimesTag {
  /** The visible short code, e.g. `'NCAA B'`, `'WIN JRS'`, `'X'`, `'R'`. */
  readonly code: string;
  /** The chip's `title` tooltip, e.g. `'Extracted'` for `'X'`. Absent when the markup carried none. */
  readonly title?: string;
}

/**
 * One row of the "Personal Bests" table: this swimmer's single fastest time in
 * one course-qualified event, and the swim that set it.
 *
 * **One row per event, not per swim.** The table is a bests list, so a swimmer
 * with 29 rows has swum 29 events, not attended 29 meets. Never compare a row
 * count here against a meet's entry count.
 */
export interface SwimCloudPersonalBestSwim {
  /**
   * A key unique to this swim and stable across captures.
   *
   * `{meetId}:swim:{swimCloudSwimId}` whenever the row's time link carried a
   * swim id — **the identical scheme {@link SwimCloudTeamMeetSwim.swimKey}
   * uses**, deliberately: the same swim reached from a team's swims list and
   * from the swimmer's own bests table produces the same key, so a caller
   * holding both can tell they are one swim rather than two.
   *
   * When that link was missing, this falls back to a composite of values the
   * row did print. Deterministic and built only from real data, but only as
   * stable as those values — a caller needing a true SwimCloud identity should
   * check {@link swimCloudSwimId} instead.
   */
  readonly swimKey: string;
  /** SwimCloud's own id for this swim, from `?id=` on the time cell's link. Absent when the row carried no such link. */
  readonly swimCloudSwimId?: string;
  /**
   * The event id this swim belongs to.
   *
   * `{meetId}:event:{eventRef}` when the time link named both — again the same
   * scheme {@link parseTeamMeetSwimsHtml} builds, so the two parsers agree on
   * what "the same event of the same meet" means. Without a link it falls back
   * to a capture-local `swimmer-times:event-label:{label}` key, whose prefix
   * says out loud that it is not meet-scoped and not a SwimCloud id.
   */
  readonly eventId: string;
  /** The `{n}` of `/results/{meetId}/event/{n}/`, kept as a string — see `SwimCloudResource`'s `meetEvent`. Absent when the row carried no time link. */
  readonly eventRef?: string;
  /**
   * The event exactly as the page prints it — `'50 Free SCY'`, `'200 IM LCM'`.
   *
   * **The course is inside this string**, which is what makes this table's
   * event labels a different shape from a swims list's (`'50 Y Free'`, course
   * letter in the middle) and from a meet heading's. The three are not
   * interchangeable and no reader here is shared between them.
   */
  readonly eventLabel: string;
  /**
   * Distance, in the unit {@link course} names. Derived from {@link eventLabel}
   * — see that field.
   */
  readonly distance?: number;
  /**
   * Course, **derived from the trailing token of {@link eventLabel}**, not read
   * from a column of its own. This page publishes no course field; `SCY` and
   * `LCM` are suffixes of the printed event name.
   *
   * A label this parser has not seen the shape of yields `'unknown'` plus a
   * warning — never a default. `50 Free SCY` and `50 Free LCM` are two separate
   * rows of this table and scoring one against the other's standard is exactly
   * the silently-wrong number the provenance rules exist to stop.
   */
  readonly course: SwimCloudCourseOrUnknown;
  /** Stroke, derived from {@link eventLabel}. `'unknown'` with a warning when the label names no stroke this parser recognizes. */
  readonly stroke: SwimCloudStroke;
  /** The meet this swim happened at, from the row's own links. Absent when the row carried neither link. */
  readonly swimCloudMeetId?: SwimCloudMeetId;
  /** The meet's name as printed on the row's `/results/{meetId}` link. */
  readonly meetName?: string;
  /** Absent when the time cell held anything other than a well-formed hundredths-precision time. */
  readonly time?: SwimCloudTimeString;
  /** The time cell's raw contents, kept whenever {@link time} could not be populated. */
  readonly rawTimeToken?: string;
  /**
   * The date **exactly as printed**, e.g. `'Mar 1, 2025'`. Never converted.
   *
   * This is the date of *this swim*, not of the meet: two rows of the real
   * capture name the same meet (338673) on `Mar 1, 2025` and `Feb 28, 2025`.
   * That makes it a different fact from the meet-scoped date range
   * {@link parseTeamMeetSwimsHtml} reads out of `<li id="meet-date">`, so it is
   * deliberately **not** passed through that reader — whose `DATE_SINGLE`
   * pattern would happily match this text and whose failure warning
   * (`unrecognized-meet-date`) would then describe a meet date this row never
   * printed. Kept verbatim rather than half-parsed into a `Date`, same rule as
   * {@link SwimCloudPersonalBest.date}.
   */
  readonly date?: string;
  /** Every chip printed on the row, in printed order. Empty on most rows — the column is optional per row, never assumed present. */
  readonly tags: readonly SwimCloudSwimmerTimesTag[];
  /**
   * True when a chip's tooltip reads `Leadoff`.
   *
   * Matched on `title="Leadoff"` and never on the visible `R`, exactly as
   * {@link readFlagsCell} does for a swims list. See
   * {@link SwimCloudResultFlags.relayLeadoff}: a leadoff split is not an
   * individual swim and must not be entered or scored as one, even though this
   * table lists it among the swimmer's bests.
   */
  readonly relayLeadoff: boolean;
}

/** Which source answered for a {@link SwimCloudSwimmerTimesParse} field. */
export type SwimCloudSwimmerTimesFieldSource =
  /** The page's own `#swimmer-info` JSON block. */
  | 'swimmer-info-json'
  /** The capture URL. */
  | 'capture-url'
  /** {@link SwimCloudSwimmerTimesParseOptions}. */
  | 'caller-supplied';

export interface SwimCloudSwimmerTimesParseOptions {
  /**
   * Swimmer id, for a capture whose URL cannot be classified (a Wayback
   * snapshot, say) and whose `#swimmer-info` block was stripped.
   *
   * **Outranks both**, same rule as {@link SwimCloudTeamMeetSwimsParseOptions.gender}:
   * a caller asserting a fact outranks a parser reading one. A disagreement is
   * reported as `contradicted-page-declaration` rather than resolved silently.
   */
  readonly swimmerId?: SwimCloudSwimmerId;
}

/** What {@link parseSwimmerTimesHtml} extracts. */
export interface SwimCloudSwimmerTimesParse {
  readonly swimCloudSwimmerId: SwimCloudSwimmerId;
  /** Which of the three sources {@link swimCloudSwimmerId} came from. */
  readonly swimmerIdSource: SwimCloudSwimmerTimesFieldSource;
  /**
   * The swimmer's name **verbatim from `#swimmer-info`**, which prints it
   * family name first: `'Paulk, River J'`.
   *
   * See {@link parseSwimmerTimesHtml}'s "One name, one source" note for why
   * this order and not the `/swimmer/{id}/` page's `'River Paulk'`. Absent when
   * the JSON block was missing or unreadable — never reconstructed from the
   * page title, which prints the other order.
   */
  readonly name?: string;
  /**
   * Personal-best rows, in page order.
   *
   * An **empty array is a real, valid answer** — a swimmer with no recorded
   * times yet — and always arrives with a `zero-data-rows` warning. A missing
   * table is `ok: false` instead. Absent ≠ empty, as everywhere in this file.
   */
  readonly personalBests: readonly SwimCloudPersonalBestSwim[];
  /** Data rows seen, including any that failed to parse. */
  readonly rowCount: number;
}

/**
 * Parse a SwimCloud swimmer's times page (`/swimmer/{id}/times/`).
 *
 * **Real-capture-verified** as of 2026-09-09 — see the file header. Written
 * against a page SwimCloud actually served, archived as
 * `tests/fixtures/swimcloud-real-swimmer-times-1472365.html` (River Paulk,
 * Auburn; 29 real rows, trimmed to 9 in the fixture). That capture resolved
 * OQ-4.
 *
 * ## The real page shape
 *
 * One server-rendered `<table>` inside `#swimmer-profile-times`, under a
 * `PERSONAL BESTS` tab that is the default view — no click, no AJAX, no
 * tab-opening precondition. Columns are event, time, an **unlabelled** badge
 * column, meet, date. One row per course-qualified event.
 *
 * ## The sibling tab is not parsed and its shape is unknown
 *
 * `EVENT PROGRESSION` sits next to `PERSONAL BESTS` in the same card. Nothing
 * has captured it, it is rendered separately, and this function neither reads
 * it nor assumes anything about it. A capture taken with that tab active may
 * well not contain the table this function needs — in which case it reports
 * `expected-header-missing` rather than inventing an empty list.
 *
 * ## One name, one source
 *
 * Two pages print this swimmer's name in two different orders: the
 * `#swimmer-info` JSON here gives `Paulk, River J` (family name first), and
 * `/swimmer/{id}/`'s own `<h1>` gives `River Paulk`. **The JSON wins**, for
 * three reasons: it is on the page this function parses (the `<h1>` is not);
 * it is structured data with a labelled field rather than a display string;
 * and reading the `<h1>` order would mean deciding by heuristic which token is
 * the family name, which is precisely the guess that produces a wrong name.
 * No third normalized form is invented — `'River Paulk'` is not reconstructed
 * from `'Paulk, River J'`, because splitting a comma-separated name into given
 * and family parts is a guess for any swimmer with a two-word family name, and
 * this repo has no reason to make it. A caller that wants display order should
 * capture `/swimmer/{id}/` and read the heading there.
 *
 * ## What is deliberately not in the output
 *
 * - **`#swimmer-profile-times`'s `data-season-ids`.** The real capture carries
 *   `[30, 29, …, 18]`, matching the roster page's own season `<select>`. That
 *   is *consistent with* a site-wide season-id space and does not *prove* one,
 *   and no URL this package emits carries a `season_id` anyway (see
 *   `./crawlPlan.ts`'s header). Recording the list would invite treating it as
 *   proof.
 * - **The rest of `#swimmer-info`.** The block also holds `gender`, `city`,
 *   `state`, `gradhs`, `gradcollege`, `team_ids` and `photo`. None is read.
 *   `gender: "M"` in particular is a one-letter code from a single sample, and
 *   `SwimCloudTeamRosterQuery` records why this package refuses to decide an
 *   encoding from one of those. The fields are named here so a future need has
 *   a documented starting point rather than a rediscovery.
 * - **A `SwimCloudEvent` per row.** That type requires a gender, and this page
 *   states none for an event — the swimmer's own gender is not the event's.
 *   Distance, course and stroke are surfaced as flat derived fields instead.
 *
 * ## The derived fields are derived
 *
 * `distance`, `course` and `stroke` are **parsed out of the printed event
 * label**, not read from fields the page publishes. A label whose shape this
 * parser has not seen (`{distance} {stroke} {COURSE}`) raises
 * `unrecognized-event-label` and leaves those fields absent or `'unknown'`; it
 * never crashes, and it never falls back to yards.
 */
export function parseSwimmerTimesHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudSwimmerTimesParseOptions = {},
): SwimCloudParseResult<SwimCloudSwimmerTimesParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = swimmerIdFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a swimmer.`,
      warnings,
      confidence,
    );
  }

  const info = readSwimmerInfoJson(html, warnings);
  const resolved = resolveSwimmerId(options.swimmerId, info?.swimmerId, fromUrl.swimmerId, warnings);
  if (resolved === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No swimmer id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a swimmer page, the page carries no readable #swimmer-info block, and no swimmerId option was supplied.`,
      warnings,
      confidence,
    );
  }

  // One strip up front, as `parseTeamMeetSwimsHtml` does: every table lookup
  // below reads this, so a fixture's own explanatory comments — which quote real
  // markup, `title="Leadoff"` included — can never be read as page content.
  const cleaned = stripNonContent(html);

  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a swimmer times page is expected to contain the Personal Bests table.',
      warnings,
      confidence,
    );
  }

  const located = locateSwimmerTimesTable(tables);
  if (located === null) {
    return fail(
      context,
      'expected-header-missing',
      `None of the ${tables.length} table(s) carries all four of an event column (${EVENT_LABEL_HEADERS.join(', ')}), a time column (${TIME_HEADERS.join(', ')}), a meet column (${MEET_HEADERS.join(', ')}) and a date column (${DATE_HEADERS.join(', ')}), which is what identifies the Personal Bests table. A swimmer's home page carries a narrower "Latest Results" table (event, time, improvement, place) that is deliberately rejected here rather than parsed as if it were this one.`,
      warnings,
      confidence,
    );
  }

  const personalBests = readSwimmerTimesRows(located, warnings);

  if (located.dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message:
        'The Personal Bests table was found and holds no data rows. This is a real "this swimmer has no recorded times" answer, not a missing table.',
    });
  } else if (personalBests.length === 0) {
    return fail(
      context,
      'no-rows-parsed',
      `The Personal Bests table held ${located.dataRows.length} data row(s) and none could be parsed.`,
      warnings,
      confidence,
    );
  }

  return succeed(
    context,
    {
      swimCloudSwimmerId: resolved.swimmerId,
      swimmerIdSource: resolved.source,
      ...(info?.name === undefined ? {} : { name: info.name }),
      personalBests,
      rowCount: located.dataRows.length,
    },
    warnings,
    confidence,
  );
}

/**
 * The swimmer id the capture URL names.
 *
 * Both swimmer-subject kinds are accepted. `swimmerTimes` is the page this
 * parser is for; the bare `swimmer` kind is accepted too so a capture whose
 * recorded URL is the profile root still reaches the table check, where the
 * failure message can say *which* table shape was found instead of rejecting on
 * a URL technicality. A URL naming any other resource is a real mismatch.
 */
function swimmerIdFromSourceUrl(sourceUrl: string): {
  swimmerId?: SwimCloudSwimmerId;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'swimmerTimes' || resource.kind === 'swimmer') {
    return { swimmerId: resource.swimmerId };
  }
  return { mismatch: resource.kind };
}

/**
 * Pick the swimmer id, in precedence order, and say out loud when two sources
 * disagree.
 *
 * Caller > page JSON > capture URL. The JSON outranks the URL because it is
 * inside the document SwimCloud served: a mis-recorded capture URL — a redirect
 * followed, the wrong tab's address pasted — cannot rename the subject, while
 * a wrong URL silently would.
 */
function resolveSwimmerId(
  fromOptions: SwimCloudSwimmerId | undefined,
  fromJson: SwimCloudSwimmerId | undefined,
  fromUrl: SwimCloudSwimmerId | undefined,
  warnings: SwimCloudParseWarning[],
): { swimmerId: SwimCloudSwimmerId; source: SwimCloudSwimmerTimesFieldSource } | undefined {
  if (fromJson !== undefined && fromUrl !== undefined && fromJson !== fromUrl) {
    warnings.push({
      code: 'contradicted-page-declaration',
      message: `The page's #swimmer-info block names swimmer ${fromJson} but the capture URL names swimmer ${fromUrl}. The page's own block wins; the disagreement is reported rather than resolved silently.`,
      raw: `swimmer-info=${fromJson} capture-url=${fromUrl}`,
    });
  }
  const fromPage = fromJson ?? fromUrl;
  if (fromOptions !== undefined) {
    if (fromPage !== undefined && fromPage !== fromOptions) {
      warnings.push({
        code: 'contradicted-page-declaration',
        message: `The caller supplied swimmer ${fromOptions} but the capture states swimmer ${fromPage}. The caller's assertion wins; the disagreement is reported rather than resolved silently.`,
        raw: `caller=${fromOptions} page=${fromPage}`,
      });
    }
    return { swimmerId: fromOptions, source: 'caller-supplied' };
  }
  if (fromJson !== undefined) {
    return { swimmerId: fromJson, source: 'swimmer-info-json' };
  }
  if (fromUrl !== undefined) {
    return { swimmerId: fromUrl, source: 'capture-url' };
  }
  return undefined;
}

/**
 * Comments only.
 *
 * {@link stripNonContent} would take `<script>` blocks with them, and the block
 * this parser wants *is* a script. Comments still go, so a fixture's own header
 * comment cannot be read as page data.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** What the page's `#swimmer-info` block states about its own subject. */
interface SwimmerInfo {
  readonly swimmerId?: SwimCloudSwimmerId;
  readonly name?: string;
}

/** A SwimCloud numeric id, as a string. Same shape the URL classifier requires. */
const EMBEDDED_NUMERIC_ID = /^[1-9][0-9]{0,17}$/;

/**
 * Read `<script id="swimmer-info" type="application/json">` — the page's own
 * structured statement of who it is about.
 *
 * Never throws. A missing block, unparseable JSON, or a field of an unexpected
 * type each produce an `unreadable-embedded-json` warning and an absent value,
 * so the caller falls back to the capture URL rather than to a guess.
 */
function readSwimmerInfoJson(html: string, warnings: SwimCloudParseWarning[]): SwimmerInfo | undefined {
  const commentless = html.replace(HTML_COMMENT, ' ');
  for (const span of findElementSpans(commentless, 'script')) {
    if (readAttribute(startTagOf(span.html), 'id') !== 'swimmer-info') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(span.inner) as unknown;
    } catch {
      warnings.push({
        code: 'unreadable-embedded-json',
        message:
          'The page\'s #swimmer-info block is not valid JSON. The swimmer id and name were not read from it.',
        raw: collapseWhitespace(span.inner).slice(0, 200),
      });
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      warnings.push({
        code: 'unreadable-embedded-json',
        message: 'The page\'s #swimmer-info block parsed to something other than a JSON object.',
        raw: collapseWhitespace(span.inner).slice(0, 200),
      });
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const rawId = record['id'];
    // Accepted as a number (what the real capture prints) or as an all-digit
    // string. Anything else is reported, never coerced — `Number(x)` on a
    // surprising value is how a wrong id gets a plausible look.
    const id =
      typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0
        ? String(rawId)
        : typeof rawId === 'string' && EMBEDDED_NUMERIC_ID.test(rawId.trim())
          ? rawId.trim()
          : undefined;
    if (rawId !== undefined && id === undefined) {
      warnings.push({
        code: 'unreadable-embedded-json',
        message: `The page's #swimmer-info block holds an "id" of ${JSON.stringify(rawId)}, which is not a positive integer id; no swimmer id was read from it.`,
        raw: String(rawId),
      });
    }
    const rawName = record['name'];
    const name =
      typeof rawName === 'string' && collapseWhitespace(rawName).length > 0
        ? collapseWhitespace(rawName)
        : undefined;
    return {
      ...(id === undefined ? {} : { swimmerId: id }),
      ...(name === undefined ? {} : { name }),
    };
  }
  return undefined;
}

/** The Personal Bests table, located and split into its columns and data rows. */
interface LocatedSwimmerTimesTable {
  readonly event: number;
  readonly time: number;
  readonly meet: number;
  readonly date: number;
  /**
   * Columns no header label claimed — where the badge chips live.
   *
   * The real page's badge column has an **empty** `<th>`, so it cannot be found
   * by printed label the way every other column in this file is. It is found by
   * elimination instead of by a hardcoded index, so a page that adds a column
   * before it does not shift the chips into the wrong cell.
   */
  readonly tagColumns: readonly number[];
  readonly dataRows: readonly string[][];
}

/**
 * The first table carrying all four of Event, Time, Meet and Date.
 *
 * All four are required on purpose. The swimmer **home** page ships a narrower
 * "Latest Results" table — event, time, improvement, place, for one selected
 * meet — that would satisfy a looser Event+Time test and is a different fact
 * entirely (one meet's swims, not career bests). Requiring the Meet and Date
 * columns makes this parser refuse that table loudly instead of returning
 * plausible rows from the wrong shape.
 */
function locateSwimmerTimesTable(
  tables: readonly HtmlElementSpan[],
): LocatedSwimmerTimesTable | null {
  for (const table of tables) {
    const rows = extractTableRows(table.html);
    if (rows.length === 0) {
      continue;
    }
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const headers = extractRowCells(rows[headerIndex]).map((cell) => normalizeHeader(htmlToText(cell)));
    const event = findColumn(headers, EVENT_LABEL_HEADERS);
    const time = findColumn(headers, TIME_HEADERS);
    const meet = findColumn(headers, MEET_HEADERS);
    const date = findColumn(headers, DATE_HEADERS);
    if (event < 0 || time < 0 || meet < 0 || date < 0) {
      continue;
    }
    const claimed = new Set([event, time, meet, date]);
    const tagColumns: number[] = [];
    for (let index = 0; index < headers.length; index += 1) {
      if (!claimed.has(index)) {
        tagColumns.push(index);
      }
    }
    return {
      event,
      time,
      meet,
      date,
      tagColumns,
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    };
  }
  return null;
}

/**
 * A Personal Bests event cell: `{distance} {stroke} {COURSE}`.
 *
 * `50 Free SCY`, `1000 Free SCY`, `200 IM LCM`. The course is the **trailing**
 * token — a different shape from the swims list's `{distance} {letter}
 * {stroke}` (`50 Y Free`), which is why {@link SWIMS_EVENT_LABEL} is not reused
 * here and neither pattern is generalized to cover both.
 */
const SWIMMER_TIMES_EVENT_LABEL = /^(\d{1,4})\s+(.+?)\s+([A-Za-z]{3})$/;

/**
 * The three-letter course codes this table prints.
 *
 * `SCY` and `LCM` are confirmed by the real capture — both appear, on separate
 * rows for the same stroke and distance. `SCM` is accepted on the same two
 * grounds {@link COURSE_LETTERS} records: it is the third member of
 * {@link SwimCloudCourse}, and it is the sport's universal abbreviation. Any
 * other trailing token is `'unknown'` with a warning and is never defaulted to
 * yards.
 */
const SWIMMER_TIMES_COURSE_TOKENS: Readonly<Record<string, SwimCloudCourse>> = {
  scy: 'SCY',
  lcm: 'LCM',
  scm: 'SCM',
};

interface ParsedSwimmerTimesEventLabel {
  readonly distance?: number;
  readonly course: SwimCloudCourseOrUnknown;
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
  /** The trailing course token as printed, when the label matched the expected shape. */
  readonly courseToken?: string;
  /** False when the label did not match `{distance} {stroke} {COURSE}` at all. */
  readonly matchedShape: boolean;
}

/**
 * Read distance, course and stroke out of a Personal Bests event label.
 *
 * Pure — it raises nothing and warns nothing, so the caller can build the event
 * id first and then attribute any warning to it. Same division of labour as
 * {@link readSwimsEventLabel}.
 */
function readSwimmerTimesEventLabel(label: string): ParsedSwimmerTimesEventLabel {
  const trimmed = label.trim();
  const lower = trimmed.toLowerCase();
  const isRelay = /\brelay\b/.test(lower);
  const match = SWIMMER_TIMES_EVENT_LABEL.exec(trimmed);

  if (match === null) {
    // Keep whatever can still be read honestly, and let the caller say out loud
    // that the shape was not the expected one.
    const loose = /\b(\d{1,4})\b/.exec(trimmed);
    return {
      ...(loose === null ? {} : { distance: Number.parseInt(loose[1], 10) }),
      course: 'unknown',
      stroke: mapStroke(lower, isRelay),
      isRelay,
      matchedShape: false,
    };
  }

  const courseToken = match[3];
  return {
    distance: Number.parseInt(match[1], 10),
    course: SWIMMER_TIMES_COURSE_TOKENS[courseToken.toLowerCase()] ?? 'unknown',
    // Only the stroke portion, so a course token can never be mistaken for a
    // stroke word by a future addition to `mapStroke`'s vocabulary.
    stroke: mapStroke(match[2].toLowerCase(), isRelay),
    isRelay,
    courseToken,
    matchedShape: true,
  };
}

/** What a Personal Bests row's time link states: the meet, the event, the swim. */
interface SwimmerTimesRowLink {
  readonly meetId: SwimCloudMeetId;
  readonly eventRef: string;
  readonly swimId?: string;
}

/**
 * Read meet, event and swim ids out of a row's time link
 * (`/results/{meetId}/event/{n}/?id={swimId}#time{swimId}`).
 *
 * Unlike {@link readSwimLink}, this cannot filter by an expected meet id: a
 * bests table spans a whole career, so every row names a different meet and the
 * link is the only place the row states which.
 */
function readSwimmerTimesRowLink(cellHtml: string): SwimmerTimesRowLink | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetEvent') {
      continue;
    }
    const id = readQueryParam(href, 'id');
    return {
      meetId: classification.resource.meetId,
      eventRef: classification.resource.eventRef,
      ...(id !== undefined && /^\d+$/.test(id) ? { swimId: id } : {}),
    };
  }
  return undefined;
}

/** The meet id a row's meet-name link carries. */
function meetIdFromCell(cellHtml: string): SwimCloudMeetId | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome === 'fetchable' && classification.resource.kind === 'meet') {
      return classification.resource.meetId;
    }
  }
  return undefined;
}

/** What the badge column(s) of one row carry. */
interface SwimmerTimesTagCells {
  readonly tags: SwimCloudSwimmerTimesTag[];
  readonly relayLeadoff: boolean;
}

/**
 * Read a row's chips.
 *
 * Every `c-label` span is captured, whatever its modifier class — the real page
 * prints `c-label--energized` for `NCAA B` and `c-label--neutral` for `X` and
 * `R`, so filtering on one modifier (as {@link readFlagsCell} does for a swims
 * list's `c-label--royal` cut badges) would silently drop most of them.
 *
 * `relayLeadoff` is matched on `title="Leadoff"` and nothing else, never on the
 * visible `R` — same rule and same reason as {@link readFlagsCell}.
 */
function readSwimmerTimesTagCells(cellHtmls: readonly string[]): SwimmerTimesTagCells {
  const tags: SwimCloudSwimmerTimesTag[] = [];
  let relayLeadoff = false;

  for (const cellHtml of cellHtmls) {
    for (const span of findElementSpans(cellHtml, 'span')) {
      const startTag = startTagOf(span.html);
      if (!classTokens(startTag).includes('c-label')) {
        continue;
      }
      const title = readAttribute(startTag, 'title');
      if (title !== undefined && title.trim().toLowerCase() === 'leadoff') {
        relayLeadoff = true;
      }
      const code = htmlToText(span.inner);
      if (code.length > 0) {
        tags.push({ code, ...(title === undefined ? {} : { title }) });
      }
    }
  }

  return { tags, relayLeadoff };
}

/**
 * `readTime` takes a {@link SwimCloudEvent} to read its `stroke` (the
 * diving-score-is-not-a-time branch) and its `eventId` (to scope warnings).
 *
 * This builds the minimal stand-in it needs, carrying the row's **real** event
 * id so a warning points at the event the page named rather than at a
 * capture-local placeholder. It is deliberately not returned to callers: a
 * `SwimCloudEvent` must state a gender, and this page states none for an event.
 */
function swimmerTimesRowEvent(
  eventId: string,
  meetId: SwimCloudMeetId | undefined,
  label: string,
  parsed: ParsedSwimmerTimesEventLabel,
): SwimCloudEvent {
  return {
    eventId,
    swimCloudMeetId: meetId ?? ('swimmer-times' as SwimCloudMeetId),
    label,
    kind: parsed.isRelay ? 'relay' : 'individual',
    course: parsed.course,
    gender: 'unknown',
    ...(parsed.distance === undefined ? {} : { distance: parsed.distance }),
    stroke: parsed.stroke,
  };
}

function readSwimmerTimesRows(
  table: LocatedSwimmerTimesTable,
  warnings: SwimCloudParseWarning[],
): SwimCloudPersonalBestSwim[] {
  const personalBests: SwimCloudPersonalBestSwim[] = [];

  table.dataRows.forEach((cells, rowIndex) => {
    const eventLabel = textAt(cells, table.event);
    if (eventLabel.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Personal-best row has an empty event cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const timeCellHtml = cellAt(cells, table.time);
    const link = readSwimmerTimesRowLink(timeCellHtml);
    const meetCellHtml = cellAt(cells, table.meet);
    const meetLinkId = meetIdFromCell(meetCellHtml);
    const parsed = readSwimmerTimesEventLabel(eventLabel);

    // The time link is authoritative for ids: it is the one that also names the
    // event and the swim, so taking the meet from anywhere else could attach a
    // swim id to a meet it does not belong to.
    const meetId = link?.meetId ?? meetLinkId;

    const eventId =
      link === undefined
        ? `swimmer-times:event-label:${normalizeHeader(eventLabel)}`
        : `${link.meetId}:event:${link.eventRef}`;

    if (link !== undefined && meetLinkId !== undefined && link.meetId !== meetLinkId) {
      warnings.push({
        code: 'contradicted-page-declaration',
        message: `Row for ${JSON.stringify(eventLabel)} links its time to meet ${link.meetId} and its meet name to meet ${meetLinkId}. The time link wins, because it is the link that also names the event and the swim; the disagreement is reported rather than resolved silently.`,
        eventId,
        rowIndex,
        raw: `time-link=${link.meetId} meet-link=${meetLinkId}`,
      });
    }

    if (!parsed.matchedShape) {
      warnings.push({
        code: 'unrecognized-event-label',
        message: `Event cell ${JSON.stringify(eventLabel)} does not match the expected "{distance} {stroke} {COURSE}" shape; course was not read from it and is recorded as unknown.`,
        eventId,
        rowIndex,
        raw: eventLabel,
      });
    } else if (parsed.course === 'unknown') {
      warnings.push({
        code: 'unrecognized-course-token',
        message: `Course token ${JSON.stringify(parsed.courseToken ?? '')} in ${JSON.stringify(eventLabel)} is outside SCY/SCM/LCM; course recorded as unknown rather than assumed.`,
        eventId,
        rowIndex,
        raw: eventLabel,
      });
    }

    if (parsed.stroke === 'unknown') {
      warnings.push({
        code: 'unmapped-stroke',
        message: `Stroke could not be identified in ${JSON.stringify(eventLabel)}; recorded as unknown.`,
        eventId,
        rowIndex,
        raw: eventLabel,
      });
    }

    if (link === undefined) {
      warnings.push({
        code: 'missing-swim-link',
        message: `Time cell for ${JSON.stringify(eventLabel)} carries no /results/{meetId}/event/{n}/ link; the swim has no SwimCloud swim id, meet id or event reference, and a composite key derived from the row's own values is used instead.`,
        eventId,
        rowIndex,
      });
    } else if (link.swimId === undefined) {
      warnings.push({
        code: 'missing-swim-link',
        message: `Time cell for ${JSON.stringify(eventLabel)} links to event ${link.eventRef} of meet ${link.meetId} but carries no "?id=" swim id; a composite key derived from the row's own values is used instead.`,
        eventId,
        rowIndex,
      });
    }

    const time = readTime(
      htmlToText(timeCellHtml),
      swimmerTimesRowEvent(eventId, meetId, eventLabel, parsed),
      rowIndex,
      warnings,
    );

    const swimKey =
      link?.swimId === undefined
        ? `${eventId}:swim:${time.finalTime ?? time.rawTimeToken ?? `row${rowIndex}`}`
        : `${link.meetId}:swim:${link.swimId}`;

    const meetName = htmlToText(meetCellHtml);
    const date = textAt(cells, table.date);
    const chips = readSwimmerTimesTagCells(table.tagColumns.map((column) => cellAt(cells, column)));

    personalBests.push({
      swimKey,
      ...(link?.swimId === undefined ? {} : { swimCloudSwimId: link.swimId }),
      eventId,
      ...(link === undefined ? {} : { eventRef: link.eventRef }),
      eventLabel,
      ...(parsed.distance === undefined ? {} : { distance: parsed.distance }),
      course: parsed.course,
      stroke: parsed.stroke,
      ...(meetId === undefined ? {} : { swimCloudMeetId: meetId }),
      ...(meetName.length === 0 ? {} : { meetName }),
      ...(time.finalTime === undefined ? {} : { time: time.finalTime }),
      ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
      ...(date.length === 0 ? {} : { date }),
      tags: chips.tags,
      relayLeadoff: chips.relayLeadoff,
    });
  });

  return personalBests;
}

/* -------------------------------------------------------------------------- */
/* Team-in-meet swims list — the first real-capture-verified parser            */
/* -------------------------------------------------------------------------- */

/**
 * Caller-supplied facts a swims-list capture's markup cannot be trusted to
 * state. Every one is an assertion the caller makes, never a default this
 * parser reaches for on its own.
 */
export interface SwimCloudTeamMeetSwimsParseOptions {
  /** Meet id, for a capture whose URL cannot be classified (a Wayback snapshot, say). */
  readonly meetId?: SwimCloudMeetId;
  /** Team id, same reason. */
  readonly teamId?: SwimCloudTeamId;
  /**
   * The gender this page was filtered to.
   *
   * Normally unnecessary: the page's own gender dropdown prints `Men` or
   * `Women` on its active item, and that printed word is what this parser
   * reads. Supply this only for a capture missing the dropdown. It
   * **overrides** the printed word when both are present, because a caller
   * asserting a fact outranks a parser reading one.
   */
  readonly gender?: SwimCloudGender;
  /**
   * The meet's course, used only when the page does not print one.
   *
   * A real capture prints it (`<li id="meet-course">SCY</li>`), so this is a
   * fallback, not the primary source.
   */
  readonly meetCourse?: SwimCloudCourse;
  /** Meet format. Omitted means `'unknown'` — never `'dual'`. See {@link SwimCloudMeetResultsParseOptions}. */
  readonly meetFormat?: SwimCloudMeetFormat;
  /** Governing rulebook. Omitted means `'unknown'` — never `'NCAA'`. */
  readonly meetRuleset?: SwimCloudRuleset;
}

/**
 * A cut-standard badge printed in a row's flags cell, captured verbatim.
 *
 * Informational only. This package does **not** resolve a badge to a standard:
 * deciding that `D2 B` means a particular published time is the job
 * `CLAUDE.md`'s provenance rules reserve for the cutline tables, which trace
 * every value to an archived PDF. Copying a scraped badge into a cut decision
 * is how a swimmer gets told they made a cut they did not make.
 */
export interface SwimCloudCutStandardLabel {
  /** The badge text as printed, e.g. `'D2 B'`. */
  readonly label: string;
  /** The badge's tooltip, e.g. `'NCAA Division II Championship'`. Absent when the markup carried none. */
  readonly title?: string;
}

/**
 * One row of a swims list: one swim, with the event it was swum in, the entry
 * that swam it, and its result.
 *
 * The page has no event grouping — prelims and finals rows for one event sit
 * apart, sorted by SwimCloud points — so this is deliberately a flat row rather
 * than the event-grouped {@link SwimCloudParsedEvent}. The grouped view is still
 * available as {@link SwimCloudTeamMeetSwimsParse.events}.
 */
export interface SwimCloudTeamMeetSwim {
  /**
   * A key unique to this swim and stable across captures.
   *
   * `{meetId}:swim:{swimCloudSwimId}` whenever the row's time link carried a
   * swim id — which is every row of the real capture. This is what a caller
   * merging page 2 into page 1, or the women's list into the men's, dedupes on.
   *
   * When that link was missing (`missing-swim-link`), this falls back to a
   * composite of values the row *did* print. The fallback is deterministic and
   * built only from real data — it invents no id — but it is only as stable as
   * the values behind it, so a caller needing a true SwimCloud identity should
   * check {@link swimCloudSwimId} instead.
   */
  readonly swimKey: string;
  /** SwimCloud's own id for this swim, from `?id=` on the time cell's link. Absent when the row carried no such link. */
  readonly swimCloudSwimId?: string;
  /** The row's printed leading ordinal (`1`, `2`, …). Presentational; absent when the table has no ordinal column. */
  readonly rowOrdinal?: number;
  readonly event: SwimCloudEvent;
  readonly entry: SwimCloudEntry;
  readonly result: SwimCloudResult;
  /**
   * Convenience mirror of `result.flags?.relayLeadoff`, always a boolean.
   *
   * See {@link SwimCloudResultFlags.relayLeadoff}: a leadoff split is not an
   * individual swim and must not be scored or displayed as one.
   */
  readonly relayLeadoff: boolean;
  /** Cut-standard badges on the row, in printed order. Empty when the row had none. */
  readonly cutStandards: readonly SwimCloudCutStandardLabel[];
  /**
   * The **meet points** this swim earned, from a `Score` column.
   *
   * ## Read this before using `result.points` for scoring
   *
   * `result.points` is the `Pts` column, and `Pts` is SwimCloud's **power
   * index** — a 0-1000-ish rating of how fast a swim is — **not** the points it
   * scored at the meet. `meetScore` is the meet points. They are different
   * numbers and this is measured, not inferred:
   *
   * - The meet-root results card prints **both columns on one row**: `Score` 20
   *   and `Pts` 846, for a first-place 1000 Free.
   * - On the swims list every `Pts` value sits between 692 and 767 and descends
   *   monotonically down the page — the list is sorted by it. Meet points for
   *   thirty swims would be 20, 17, 16, …
   * - Henderson State's actual score for the meet is **1056** — printed twice,
   *   as the team's `Points scored` splash-stat and in the meet-root standings.
   *   The `Pts` column across all 8 pages sums to roughly twenty times that.
   *
   * So a caller must not feed `result.points` into a meet-scoring field. See
   * `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` for the conversion
   * that respects this.
   *
   * **Absent on the swims list**, which has no `Score` column at all — meet
   * points for an individual swim are simply not published on that page.
   * Absent means "the page did not say", never zero.
   */
  readonly meetScore?: number;
}

/**
 * The paginated-list position of a capture.
 *
 * Absent from {@link SwimCloudTeamMeetSwimsParse} entirely when the page carried
 * no `<ul class="c-pagination">`. That absence is the normal single-page case,
 * **not** a parse gap: SwimCloud omits the widget when everything fits on one
 * page, so a caller reads "no pagination" as "one page", never as "unknown page
 * count".
 */
export interface SwimCloudPagination {
  /** 1-based page this capture is of, from the widget's active item. */
  readonly currentPage: number;
  /** Highest page the widget offers. */
  readonly totalPages: number;
  /** The "Next page" link's href exactly as printed, e.g. `'?page=2'`. Absent on the last page. */
  readonly nextPageHref?: string;
}

/** What {@link parseTeamMeetSwimsHtml} extracts. */
export interface SwimCloudTeamMeetSwimsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** From `<h1 id="meet-name">`, falling back to the page's first heading. */
  readonly meetName?: string;
  readonly meet: SwimCloudMeet;
  /** From the capture URL, or {@link SwimCloudTeamMeetSwimsParseOptions.teamId}. Absent on a meet-root capture, which is scoped to no team. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** The team's printed name, from the page's own `/team/{id}` link. */
  readonly teamName?: string;
  /** Built **only** when team id, name and gender are all known. A half-known team is not a team. */
  readonly team?: SwimCloudTeam;
  /** The gender this page was filtered to, from the printed word on the gender dropdown's active item. */
  readonly gender: SwimCloudGenderOrUnknown;
  /**
   * The team's `Entries` splash-stat, when the page printed one.
   *
   * **Not** a swim count. A swim row exists per attempt, so prelims and finals
   * of one entry are two rows; the real capture shows 134 entries against 8
   * pages of 30 swims. Never compare this against
   * {@link SwimCloudTeamMeetSwimsParse.rowCount} to decide whether a capture is
   * complete.
   */
  readonly entryCount?: number;
  /** One per data row, in page order. */
  readonly swims: readonly SwimCloudTeamMeetSwim[];
  /** The distinct events the rows referenced, in first-seen order. */
  readonly events: readonly SwimCloudEvent[];
  /** Data rows seen, including any that failed to parse. */
  readonly rowCount: number;
  /** Absent when the page carried no pagination widget — see {@link SwimCloudPagination}. */
  readonly pagination?: SwimCloudPagination;
}

/**
 * Parse a SwimCloud results table of the shape every results page shares.
 *
 * **Real-capture-verified** — see the file header. Written against three pages
 * SwimCloud actually served, archived as `tests/fixtures/swimcloud-real-*.html`.
 *
 * ## Which page to give it
 *
 * The same row shape appears on three pages, and only one of them is complete:
 *
 * | Page | What its table holds |
 * | --- | --- |
 * | `/results/{meetId}/` | The whole meet's top 5 swims |
 * | `/results/{meetId}/team/{teamId}/` | That team's top 10 swims, sorted by improvement |
 * | `/results/{meetId}/team/{teamId}/swims/` | **That team's full list**, 30 rows a page |
 *
 * This function parses all three correctly. It cannot tell a caller that the
 * first two are partial, because their markup does not say so — which is why
 * those two pages have their own classifier kinds, and why the import UI, not
 * this parser, is where a user gets told to capture the `swims` page instead.
 *
 * ## What this page type cannot tell you
 *
 * **Disqualified and scratched swims are absent from it entirely.** The user who
 * captured the fixture confirmed from first-hand knowledge that DQs occurred at
 * that meet, and not one appears on the list. A caller must not read a complete
 * capture as a complete account of what happened — DQ and scratch data lives
 * only on `/results/{meetId}/event/{n}/`, which nothing here parses. Reporting
 * `confidence: 'real-capture-verified'` says these selectors match a page
 * SwimCloud served; it does not say the page holds every swim.
 *
 * Relays are likewise absent as relays. A relay's **leadoff** leg does appear,
 * and looks exactly like an individual swim except for one `title="Leadoff"`
 * badge — see {@link SwimCloudResultFlags.relayLeadoff}.
 */
export function parseTeamMeetSwimsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudTeamMeetSwimsParseOptions = {},
): SwimCloudParseResult<SwimCloudTeamMeetSwimsParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = meetScopeFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a meet or a team within one.`,
      warnings,
      confidence,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  if (meetId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a meet page and no meetId option was supplied.`,
      warnings,
      confidence,
    );
  }
  const teamId = options.teamId ?? fromUrl.teamId;

  // One strip up front. Every non-table lookup below reads this rather than the
  // raw input, so a fixture's own explanatory comments — which quote real
  // markup, `title="Leadoff"` included — can never be read as page content.
  const cleaned = stripNonContent(html);

  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a results page is expected to contain at least one.',
      warnings,
      confidence,
    );
  }

  const located = locateSwimsTable(tables);
  if (located === null) {
    return fail(
      context,
      'expected-header-missing',
      `None of the ${tables.length} table(s) on the page has both an "Event" and a "Time" column, which is what identifies a results table on a SwimCloud results page.`,
      warnings,
      confidence,
    );
  }

  const gender = options.gender ?? readActiveGenderWord(cleaned);
  const meetName = elementTextById(cleaned, 'meet-name') ?? firstHeadingText(cleaned);
  const meetCourse = readPrintedCourse(cleaned) ?? options.meetCourse;
  const dates = readMeetDateRange(cleaned, warnings);
  const teamName = teamId === undefined ? undefined : teamNameForId(cleaned, teamId);
  const entryCount = readSplashStat(cleaned, 'entries');

  const rows = readSwimRows(located, {
    meetId,
    gender,
    meetCourse,
    fallbackTeamId: teamId,
    fallbackTeamName: teamName,
    warnings,
  });

  const events: SwimCloudEvent[] = [];
  for (const swim of rows.swims) {
    if (!events.some((event) => event.eventId === swim.event.eventId)) {
      events.push(swim.event);
    }
  }

  const meet: SwimCloudMeet = {
    swimCloudMeetId: meetId,
    name: meetName ?? '',
    format: options.meetFormat ?? 'unknown',
    ruleset: options.meetRuleset ?? 'unknown',
    course: meetCourse ?? 'unknown',
    ...(dates.startDate === undefined ? {} : { startDate: dates.startDate }),
    ...(dates.endDate === undefined ? {} : { endDate: dates.endDate }),
  };

  const team: SwimCloudTeam | undefined =
    teamId !== undefined && teamName !== undefined && gender !== 'unknown'
      ? { swimCloudTeamId: teamId, gender, name: teamName }
      : undefined;

  const pagination = readPagination(cleaned, fromUrl.page);

  return succeed(
    context,
    {
      swimCloudMeetId: meetId,
      ...(meetName === undefined ? {} : { meetName }),
      meet,
      ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
      ...(teamName === undefined ? {} : { teamName }),
      ...(team === undefined ? {} : { team }),
      gender,
      ...(entryCount === undefined ? {} : { entryCount }),
      swims: rows.swims,
      events,
      rowCount: rows.rowCount,
      ...(pagination === undefined ? {} : { pagination }),
    },
    warnings,
    confidence,
  );
}

/* ---- Meet team standings: the meet-root "Teams" card, and the full
   "topteams" page it links to when it truncates ----------------------------- */

/**
 * One row of a team-standings table — the meet-root "Teams" card, or the
 * `topteams` page. Same row shape on both real captures.
 */
export interface SwimCloudMeetTeamStanding {
  readonly swimCloudTeamId: SwimCloudTeamId;
  /** The team's printed name, from its own `/team/{id}/` link. */
  readonly teamName: string;
  /**
   * Absent when the page printed an em dash — a team that scored zero, not
   * a team the parser failed to read. Never inferred from row position.
   */
  readonly rank?: number;
  /** Absent when the page printed an em dash. Never defaulted to 0 — see `CLAUDE.md`'s "absent, not zero" rule. */
  readonly score?: number;
}

/**
 * What a caller can trust about whether {@link SwimCloudMeetTeamsParse.teams}
 * is the whole field.
 *
 * `'unproven'` — the meet-root Teams card. A real 13-team capture
 * (2026-09-08) proved it shows only the leaders (5 of 13) with no signal
 * distinguishing "that's everyone" from "that's the top of a longer list" —
 * see `plans/2026-09-08/01-decisions.md`'s OQ-1 finding. Never call this
 * kind's output the whole meet.
 *
 * `'verified-complete-for-this-capture'` — the `topteams` page. Two real
 * captures (same 13-team meet, both genders) show every competing team,
 * including seven/three that scored zero and still appear as rows rather
 * than being omitted (OQ-1b). This is evidence for the one meet captured,
 * not a guarantee the page can never truncate on a larger field — see
 * OQ-1b's own caveat and OQ-8 (a crawl-side page cap) in
 * `plans/2026-09-08/08-open-questions.md`.
 */
export type SwimCloudMeetTeamsDiscoveryCompleteness = 'unproven' | 'verified-complete-for-this-capture';

export interface SwimCloudMeetTeamsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** From `<h1 id="meet-name">`, falling back to the page's first heading. */
  readonly meetName?: string;
  /** The gender this page was filtered to, from the printed word on the gender dropdown's active item. */
  readonly gender: SwimCloudGenderOrUnknown;
  readonly teams: readonly SwimCloudMeetTeamStanding[];
  readonly discoveryCompleteness: SwimCloudMeetTeamsDiscoveryCompleteness;
}

export interface SwimCloudMeetTeamsParseOptions {
  /** Meet id, for a capture whose URL cannot be classified. */
  readonly meetId?: SwimCloudMeetId;
}

/**
 * Find the `<table>` belonging to a named card (`<h2 class="c-title">{title}</h2>`
 * followed by its table) — the nearest table starting after that heading.
 *
 * Both `parseMeetTeamsHtml` and `parseMeetTopTeamsHtml` need this: the
 * meet-root landing page carries several cards (Teams, High point,
 * Performances, Records), so locating "the Teams table" by content, not by
 * table order, is what makes this robust to a page that reorders or adds
 * cards. The `topteams` page happens to carry only the one table, but using
 * the same lookup there costs nothing and stays correct if that ever
 * changes.
 */
function locateCardTable(html: string, cardTitle: string): HtmlElementSpan | null {
  const heading = findElementSpans(html, 'h2').find(
    (h) => classTokens(startTagOf(h.html)).includes('c-title') && htmlToText(h.inner).trim() === cardTitle,
  );
  if (heading === undefined) {
    return null;
  }
  const tablesAfter = findTables(html).filter((t) => t.start > heading.start);
  if (tablesAfter.length === 0) {
    return null;
  }
  return tablesAfter.reduce((closest, t) => (t.start < closest.start ? t : closest));
}

/**
 * The team-standings row shape shared by the Teams card and `topteams`:
 * rank cell, a team link+name cell, a score cell — 3 `<td>`s per row (the
 * header's single `<th colspan="2">Team</th>` covers the first two
 * visually, but the body still prints three real cells).
 */
function extractTeamStandingsRows(tableHtml: string): SwimCloudMeetTeamStanding[] {
  const standings: SwimCloudMeetTeamStanding[] = [];
  for (const row of extractTableRows(tableHtml)) {
    if (isHeaderRow(row)) {
      continue;
    }
    const cells = extractRowCells(row);
    if (cells.length < 3) {
      continue;
    }
    const linkCell = cells[1] ?? '';
    const teamHref = extractHrefs(linkCell).find((href) => /\/team\/\d+\/?/.test(href));
    if (teamHref === undefined) {
      continue;
    }
    const idMatch = /\/team\/(\d+)\//.exec(teamHref);
    if (idMatch === null) {
      continue;
    }
    const teamName = htmlToText(linkCell).trim();
    if (teamName.length === 0) {
      continue;
    }
    const rankText = htmlToText(cells[0] ?? '').trim();
    const scoreText = htmlToText(cells[2] ?? '').trim();
    const rank = /^\d+$/.test(rankText) ? Number.parseInt(rankText, 10) : undefined;
    const score = /^[\d.]+$/.test(scoreText) ? Number.parseFloat(scoreText) : undefined;
    standings.push({
      swimCloudTeamId: idMatch[1] as SwimCloudTeamId,
      teamName,
      ...(rank === undefined ? {} : { rank }),
      ...(score === undefined ? {} : { score }),
    });
  }
  return standings;
}

function parseTeamStandingsPage(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetTeamsParseOptions,
  cardTitle: string,
  discoveryCompleteness: SwimCloudMeetTeamsDiscoveryCompleteness,
): SwimCloudParseResult<SwimCloudMeetTeamsParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = meetScopeFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a meet.`,
      warnings,
      confidence,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  if (meetId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a meet page and no meetId option was supplied.`,
      warnings,
      confidence,
    );
  }

  const cleaned = stripNonContent(html);
  const table = locateCardTable(cleaned, cardTitle);
  if (table === null) {
    return fail(
      context,
      'expected-table-missing',
      `No "${cardTitle}" card table was found on this page.`,
      warnings,
      confidence,
    );
  }

  const teams = extractTeamStandingsRows(table.html);
  const gender = readActiveGenderWord(cleaned);
  const meetName = elementTextById(cleaned, 'meet-name') ?? firstHeadingText(cleaned);

  return succeed(
    context,
    {
      swimCloudMeetId: meetId,
      ...(meetName === undefined ? {} : { meetName }),
      gender,
      teams,
      discoveryCompleteness,
    },
    warnings,
    confidence,
  );
}

/**
 * The meet root's "Teams" card — a **summary**, not the full field. A real
 * 13-team capture shows only 5 rows here; see
 * {@link SwimCloudMeetTeamsDiscoveryCompleteness}. Use
 * {@link parseMeetTopTeamsHtml} for the complete list when the card's "More"
 * link is present.
 */
export function parseMeetTeamsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetTeamsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetTeamsParse> {
  return parseTeamStandingsPage(html, context, options, 'Teams', 'unproven');
}

/**
 * The full team-standings page a truncated Teams card's "More" link points
 * to (`/results/{meetId}/topteams/`). See
 * {@link SwimCloudMeetTeamsDiscoveryCompleteness} for exactly what
 * "verified complete" does and does not claim.
 */
export function parseMeetTopTeamsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetTeamsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetTeamsParse> {
  return parseTeamStandingsPage(html, context, options, 'Teams', 'verified-complete-for-this-capture');
}

/* ========================================================================== */
/* Per-event results page — the one page type that names the round             */
/* ========================================================================== */

/**
 * Caller-supplied facts a per-event results capture's markup may not state.
 *
 * Same discipline as {@link SwimCloudTeamMeetSwimsParseOptions}: every field is
 * an assertion the caller makes, never a default this parser reaches for.
 */
export interface SwimCloudMeetEventResultsParseOptions {
  /** Meet id, for a capture whose URL cannot be classified (a Wayback snapshot, say). */
  readonly meetId?: SwimCloudMeetId;
  /** SwimCloud's `/event/{n}/` reference, same reason. */
  readonly eventRef?: string;
  /**
   * The gender this event is for.
   *
   * Normally unnecessary — the page's own gender dropdown prints `Men` or
   * `Women` on its active item. **Never derived from the event id.** The real
   * capture's gender toggle on event 26 points at `event/100/` (Men) and
   * `event/400/` (Women), so event-id arithmetic would place this swim on the
   * wrong side of the meet. Supplied here it **overrides** the printed word, on
   * the same rule as everywhere else: a caller asserting a fact outranks a
   * parser reading one.
   */
  readonly gender?: SwimCloudGender;
  /** The meet's course, used only when the page does not print one in `<li id="meet-course">`. */
  readonly meetCourse?: SwimCloudCourse;
  /** Meet format. Omitted means `'unknown'` — never `'dual'`. */
  readonly meetFormat?: SwimCloudMeetFormat;
  /** Governing rulebook. Omitted means `'unknown'` — never `'NCAA'`. */
  readonly meetRuleset?: SwimCloudRuleset;
}

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

/** What {@link parseMeetEventResultsHtml} extracts. */
export interface SwimCloudMeetEventResultsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** SwimCloud's `/event/{n}/` reference this page is. A **results-page** id, not a round id — see {@link parseMeetEventResultsHtml}. */
  readonly eventRef: string;
  /** From `<h1 id="meet-name">`, falling back to the page's first heading. */
  readonly meetName?: string;
  readonly meet: SwimCloudMeet;
  /** The event, as this page names it. Its `eventId` matches the swims list's for the same `/event/{n}/` page. */
  readonly event: SwimCloudEvent;
  /** The printed event label from the page's own Event dropdown, e.g. `'100 Breast'`. Absent when the page carried no such dropdown. */
  readonly eventLabel?: string;
  /** From the printed word on the gender dropdown's active item — never from the event id. */
  readonly gender: SwimCloudGenderOrUnknown;
  /** One per round table, in printed order (which is program order, not chronological order). */
  readonly rounds: readonly SwimCloudMeetEventRound[];
  /** Data rows seen across every round table, including any that failed to parse. */
  readonly rowCount: number;
}

/**
 * Parse `/results/{meetId}/event/{n}/` — the only SwimCloud page type that
 * names which **round** a swim was contested in.
 *
 * **Real-capture-verified**, against exactly one page: the 2026-09-10 capture
 * of `/results/356467/event/26/` ("100 Breast Men Finals"), archived as
 * `tests/fixtures/swimcloud-real-meet-event-356467-event26.html` with the
 * page-shape findings in its own header comment. Read that before trusting any
 * of this against a page shape it does not cover.
 *
 * ## Why this page exists in the pipeline
 *
 * The team swims list (`parseTeamMeetSwimsHtml`) has no round or session column
 * at all, so a swimmer who made finals appears twice with nothing to tell the
 * two rows apart — and each row's `Place` is that *round's* placement, not the
 * event's. `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` had to
 * exclude every such pair outright. This page resolves them: it holds every
 * round of one event as its own `<div class="o-table-group"><table>` block with
 * a `<caption>` naming the round, and its A/B Final tables carry the real meet
 * `Score`.
 *
 * ## What one page does and does not cover
 *
 * - **One `/event/{n}/` id is a results page, not a round and not a labelled
 *   event.** Three "100 Y Breast" swims by one swimmer on the real swims list
 *   split across `event/26/` and `event/100/`. This page holds two of them; the
 *   third is on a page with no "Finals" suffix, at an id above the meet's
 *   numbered program (1–42), which matches `packages/core`'s already-documented
 *   finding that HyTek numbers post-meet time-trial sessions above the program
 *   (`isOutsideScoredProgram` / `scoredEventNumberMax`). Fetching every unique
 *   event id a swims list references is what covers a meet; one page is not
 *   assumed to hold every swim of its printed event label.
 * - **No diving event has been captured.** `Score` on a diving page could
 *   plausibly be the judged score rather than meet points, and storing a judged
 *   300.15 as meet points would silently multiply a team's score. So a diving
 *   event's `Score` column is read, reported as `'diving-score-column-unverified'`,
 *   and **not** stored in `meetScore`. Nothing about a diving row's markup is
 *   invented here.
 * - **No DQ, scratch or single-round timed-final table has been seen on this
 *   page type.** A time cell holding `DQ`/`NS`/`SCR` goes through the same
 *   {@link readTime} path every other page uses; a table with no caption raises
 *   `'missing-round-caption'` and is never renamed to `'Finals'` on a guess.
 * - **Relays.** The captured page is an individual event. A relay event's page
 *   is unseen; a `title="Leadoff"` badge is still read if one appears, rather
 *   than assumed absent.
 */
export function parseMeetEventResultsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetEventResultsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetEventResultsParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = eventScopeFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a /results/{meetId}/event/{n}/ page.`,
      warnings,
      confidence,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  const eventRef = options.eventRef ?? fromUrl.eventRef;
  if (meetId === undefined || eventRef === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id and event reference could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a per-event results page and no meetId/eventRef options were supplied.`,
      warnings,
      confidence,
    );
  }

  // One strip up front, same rule as the swims-list parser: every non-table
  // lookup below reads this rather than the raw input, so the fixture's own
  // header comment — which quotes real markup, `title="Exhibition"` included —
  // can never be read as page content.
  const cleaned = stripNonContent(html);

  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a per-event results page is expected to contain one per round.',
      warnings,
      confidence,
    );
  }

  const located = locateEventRoundTables(tables);
  if (located.length === 0) {
    return fail(
      context,
      'expected-header-missing',
      `None of the ${tables.length} table(s) on the page has both a "Name" and a "Time" column, which is what identifies a round's results table on a per-event results page.`,
      warnings,
      confidence,
    );
  }

  const gender = options.gender ?? readEventPageGender(cleaned);
  const eventLabel = readDropdownActiveText(cleaned, 'event');
  const meetName = elementTextById(cleaned, 'meet-name') ?? firstHeadingText(cleaned);
  const meetCourse = readPrintedCourse(cleaned) ?? options.meetCourse;
  const dates = readMeetDateRange(cleaned, warnings);

  const eventId = `${meetId}:event:${eventRef}`;
  const parsedLabel = readEventPageEventLabel(eventLabel ?? '');
  const event: SwimCloudEvent = {
    eventId,
    swimCloudMeetId: meetId,
    eventRef,
    label: eventLabel ?? '',
    kind: parsedLabel.isRelay ? 'relay' : 'individual',
    course: meetCourse ?? 'unknown',
    gender,
    ...(parsedLabel.distance === undefined ? {} : { distance: parsedLabel.distance }),
    stroke: parsedLabel.stroke,
  };

  if (!parsedLabel.matchedShape) {
    warnings.push({
      code: 'unrecognized-event-label',
      message: `Event dropdown label ${JSON.stringify(eventLabel ?? '')} does not match the expected "{distance} {stroke}" shape this page type prints; distance was not read from it.`,
      eventId,
      raw: eventLabel ?? '',
    });
  }
  if (meetCourse === undefined) {
    // The event label on this page type carries no course letter — the course
    // is a page-level fact (`<li id="meet-course">SCY</li>`). With neither that
    // element nor a caller-supplied course, the course stays unknown; it is
    // never defaulted to yards.
    warnings.push({
      code: 'missing-course-declaration',
      message:
        'The page printed no <li id="meet-course"> and no meetCourse option was supplied; the event\'s course is recorded as "unknown" rather than assumed.',
      eventId,
    });
  }

  const rounds: SwimCloudMeetEventRound[] = [];
  let rowCount = 0;
  for (const table of located) {
    const round = readEventRound(table, { meetId, eventId, event, warnings });
    rounds.push(round);
    rowCount += round.rowCount;
  }

  const meet: SwimCloudMeet = {
    swimCloudMeetId: meetId,
    name: meetName ?? '',
    format: options.meetFormat ?? 'unknown',
    ruleset: options.meetRuleset ?? 'unknown',
    course: meetCourse ?? 'unknown',
    ...(dates.startDate === undefined ? {} : { startDate: dates.startDate }),
    ...(dates.endDate === undefined ? {} : { endDate: dates.endDate }),
  };

  return succeed(
    context,
    {
      swimCloudMeetId: meetId,
      eventRef,
      ...(meetName === undefined ? {} : { meetName }),
      meet,
      event,
      ...(eventLabel === undefined ? {} : { eventLabel }),
      gender,
      rounds,
      rowCount,
    },
    warnings,
    confidence,
  );
}

/* ---- Per-event page: locating the round tables ----------------------------- */

/** One round's table, located, with its caption and its columns already resolved. */
interface LocatedEventRoundTable {
  /** The `<caption>` text, verbatim. Absent when the table carried none. */
  readonly caption?: string;
  readonly name: SwimsHeaderColumn;
  readonly time: SwimsHeaderColumn;
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
function locateEventRoundTables(tables: readonly HtmlElementSpan[]): LocatedEventRoundTable[] {
  const located: LocatedEventRoundTable[] = [];
  for (const table of tables) {
    const rows = extractTableRows(table.html);
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const columns = readHeaderColumns(rows[headerIndex]);
    const name = columnFor(columns, NAME_HEADERS);
    const time = columnFor(columns, SWIMS_TIME_HEADERS);
    if (name === undefined || time === undefined) {
      continue;
    }
    const team = columnFor(columns, TEAM_HEADERS);
    const score = columnFor(columns, SWIMS_SCORE_HEADERS);
    const points = columnFor(columns, SWIMS_POINTS_HEADERS);

    const unlabeled: number[] = [];
    for (const column of columns) {
      if (column.label.length > 0) continue;
      for (let index = column.start; index < column.start + column.span; index += 1) {
        unlabeled.push(index);
      }
    }

    const caption = readTableCaption(table.html);
    located.push({
      ...(caption === undefined ? {} : { caption }),
      name,
      time,
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

/** The first `<caption>`'s text inside a table's own source. Absent when there is none, or it is blank. */
function readTableCaption(tableHtml: string): string | undefined {
  const captions = findElementSpans(tableHtml, 'caption');
  if (captions.length === 0) {
    return undefined;
  }
  const text = htmlToText(captions[0].inner);
  return text.length === 0 ? undefined : text;
}

/* ---- Per-event page: page-level facts --------------------------------------- */

function eventScopeFromSourceUrl(sourceUrl: string): {
  meetId?: SwimCloudMeetId;
  eventRef?: string;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'meetEvent') {
    return { meetId: resource.meetId, eventRef: resource.eventRef };
  }
  return { mismatch: resource.kind };
}

/**
 * The text of the active item in the dropdown menu introduced by a given
 * subheader (`Event`, `Gender`).
 *
 * A per-event page carries two dropdowns and **its gender items link to no
 * `?gender=` parameter at all** — on the real capture the Men/Women toggle for
 * one labelled event points at `/event/100/` and `/event/400/`. So
 * {@link readActiveGenderWord}, which requires a `?gender=`-bearing link to
 * identify a gender item, answers `'unknown'` here and cannot be reused.
 *
 * The menus are told apart by their own printed `dropdown-subheader` item
 * instead — the page labelling its own control, which is the same class of fact
 * a column header is. The **innermost** matching `<ul>` wins: the page nests
 * both menus inside one outer list, so an outer list contains every
 * subheader and would match all of them.
 */
function readDropdownActiveText(html: string, subheader: string): string | undefined {
  const wanted = normalizeHeader(subheader);
  let best: { inner: string; length: number } | undefined;

  for (const list of findElementSpans(html, 'ul')) {
    const items = findElementSpans(list.inner, 'li');
    const introduces = items.some(
      (item) =>
        classTokens(startTagOf(item.html)).includes('dropdown-subheader') &&
        normalizeHeader(htmlToText(item.inner)) === wanted,
    );
    if (!introduces) continue;
    if (best === undefined || list.inner.length < best.length) {
      best = { inner: list.inner, length: list.inner.length };
    }
  }

  if (best === undefined) {
    return undefined;
  }
  for (const item of findElementSpans(best.inner, 'li')) {
    const tokens = classTokens(startTagOf(item.html));
    if (!tokens.includes('active') || tokens.includes('dropdown-subheader')) continue;
    const text = htmlToText(item.inner);
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * The gender a per-event page is for, from the printed word on its Gender
 * dropdown's active item.
 *
 * **Never from the event id.** See
 * {@link SwimCloudMeetEventResultsParseOptions.gender}: the real capture's own
 * toggle proves that arithmetic wrong.
 */
function readEventPageGender(html: string): SwimCloudGenderOrUnknown {
  const text = readDropdownActiveText(html, 'gender');
  if (text === undefined) {
    return 'unknown';
  }
  const word = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(text);
  return mapGender(word === null ? undefined : word[1]);
}

/**
 * A per-event page's event label: `{distance} {stroke}`, e.g. `100 Breast`.
 *
 * **No course letter**, unlike the swims list's `100 Y Breast` — this page
 * prints the course once, page-level, as `<li id="meet-course">`. So
 * {@link readSwimsEventLabel} is deliberately not reused: its
 * `{distance} {letter} {stroke}` shape would fail on every label this page
 * prints and fire a warning on a page that is perfectly well-formed.
 */
const EVENT_PAGE_EVENT_LABEL = /^(\d{1,4})\s+(.+)$/;

interface ParsedEventPageLabel {
  readonly distance?: number;
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
  /** False when the label did not match `{distance} {stroke}` at all. */
  readonly matchedShape: boolean;
}

function readEventPageEventLabel(label: string): ParsedEventPageLabel {
  const lower = label.toLowerCase();
  const isRelay = /\brelay\b/.test(lower);
  const match = EVENT_PAGE_EVENT_LABEL.exec(label.trim());
  if (match === null) {
    return { stroke: mapStroke(lower, isRelay), isRelay, matchedShape: false };
  }
  return {
    distance: Number.parseInt(match[1], 10),
    stroke: mapStroke(lower, isRelay),
    isRelay,
    matchedShape: true,
  };
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

function readEventRound(
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

  // A diving page has never been captured. `Score` there could plausibly be the
  // judged score rather than meet points, and a judged 300.15 stored as meet
  // points would silently multiply a team's total. The column is read and
  // reported; it is not stored.
  const divingScoreUnverified = pointsColumn === 'score' && event.stroke === 'Diving';
  if (divingScoreUnverified) {
    ctx.warnings.push({
      code: 'diving-score-column-unverified',
      message: `The ${JSON.stringify(table.caption ?? 'uncaptioned')} table of this diving event carries a "Score" column, but no diving page has been captured and a diving "Score" may be the judged score rather than meet points. It is preserved in the row's rawPointsToken and not stored as meetScore.`,
      eventId,
    });
  }

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

    const timeCellHtml = cellAt(cells, table.time.start);
    const swimId = readEventPageSwimId(timeCellHtml);
    if (swimId === undefined) {
      ctx.warnings.push({
        code: 'missing-swim-link',
        message: `Time cell for ${JSON.stringify(athleteName)} carries neither a /times/{id}/ link nor a <div id="time{id}"> wrapper; the swim has no SwimCloud swim id, so it cannot be joined against a team's swims list.`,
        eventId,
        rowIndex,
      });
    }

    const time = readTime(htmlToText(timeCellHtml), event, rowIndex, ctx.warnings);
    const score =
      table.score === undefined
        ? {}
        : readPoints(textAt(cells, table.score.start), event, rowIndex, ctx.warnings);
    const points =
      table.points === undefined
        ? {}
        : readPoints(textAt(cells, table.points.start), event, rowIndex, ctx.warnings);

    // Badge cells: every unlabeled body column, filtered by readFlagsCell's own
    // `c-label--royal` / `title="Leadoff"` tests. A cell holding a PB/SB chip or
    // nothing at all contributes nothing.
    let relayLeadoff = false;
    const cutStandards: SwimCloudCutStandardLabel[] = [];
    for (const index of table.unlabeled) {
      const flags = readFlagsCell(cellAt(cells, index));
      if (flags.relayLeadoff) relayLeadoff = true;
      cutStandards.push(...flags.cutStandards);
    }

    const swimmerId = swimmerIdFromCell(nameCellHtml);
    if (swimmerId === undefined) {
      ctx.warnings.push({
        code: 'missing-athlete-link',
        message: `Per-event results row for ${athleteName} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
        eventId,
        rowIndex,
        raw: athleteName,
      });
    }

    const teamCellHtml = table.team === undefined ? '' : cellAt(cells, table.team.start);
    const rowTeamName = htmlToText(teamCellHtml);
    const teamId = teamIdFromCell(teamCellHtml);

    // The same key shape the swims list builds, so one swim carries one key on
    // both pages. The composite fallback is capture-local and joins nothing.
    const roundKey = table.caption === undefined ? 'uncaptioned' : normalizeHeader(table.caption);
    const swimKey =
      swimId === undefined
        ? `${eventId}:round:${roundKey}:swim:${swimmerId ?? `row${rowIndex}`}:${time.finalTime ?? time.rawTimeToken ?? `row${rowIndex}`}`
        : `${ctx.meetId}:swim:${swimId}`;

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
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      athleteName,
      ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
      ...(rowTeamName.length === 0 ? {} : { teamName: rowTeamName }),
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

    swims.push({
      swimKey,
      ...(swimId === undefined ? {} : { swimCloudSwimId: swimId }),
      ...(table.caption === undefined ? {} : { roundLabel: table.caption }),
      entry,
      result,
      exhibition: rank.exhibition,
      relayLeadoff,
      cutStandards,
      ...(score.points === undefined || divingScoreUnverified ? {} : { meetScore: score.points }),
    });
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

/* ---- Attribute and element helpers ---------------------------------------- */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The start tag of an element's full source, `<` through the first `>`. */
function startTagOf(elementHtml: string): string {
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
function readAttribute(tagHtml: string, name: string): string | undefined {
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
function classTokens(tagHtml: string): string[] {
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
function elementTextById(html: string, id: string): string | undefined {
  const pattern = new RegExp(
    `<([A-Za-z][A-Za-z0-9]*)\\b[^>]*\\sid\\s*=\\s*["']?${escapeRegExp(id)}["'\\s>]`,
    'i',
  );
  const match = pattern.exec(html);
  if (match === null) {
    return undefined;
  }
  const tag = match[1].toLowerCase();
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
function readQueryParam(href: string, name: string): string | undefined {
  try {
    const url = new URL(href, `https://${SWIMCLOUD_CANONICAL_HOST}`);
    const value = url.searchParams.get(name);
    return value === null || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

/* ---- Page-level facts ------------------------------------------------------ */

function meetScopeFromSourceUrl(sourceUrl: string): {
  meetId?: SwimCloudMeetId;
  teamId?: SwimCloudTeamId;
  page?: string;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'meet' || resource.kind === 'meetEvent' || resource.kind === 'meetTopTeams') {
    return { meetId: resource.meetId };
  }
  if (resource.kind === 'meetTeam' || resource.kind === 'meetTeamSwims') {
    return {
      meetId: resource.meetId,
      teamId: resource.teamId,
      ...(resource.query.page === undefined ? {} : { page: resource.query.page }),
    };
  }
  return { mismatch: resource.kind };
}

/**
 * The gender the page is filtered to, read from the **printed word** on the
 * gender dropdown's active item.
 *
 * Deliberately not read from the URL's `?gender=` value. The real capture does
 * show `M` next to `Men` and `F` next to `Women`, but one sample is not an
 * encoding, and `SwimCloudMeetTeamQuery` documents why the classifier refuses to
 * interpret that parameter. The printed word is the page stating the fact, which
 * is the same rule `parseTeamRosterHtml` follows for a roster's gender.
 *
 * A dropdown item is a gender item only if it links to a `?gender=`-bearing URL,
 * so an unrelated `active` list item (a nav tab, say) cannot answer this.
 */
function readActiveGenderWord(html: string): SwimCloudGenderOrUnknown {
  for (const item of findElementSpans(html, 'li')) {
    if (!classTokens(startTagOf(item.html)).includes('active')) {
      continue;
    }
    const linksGender = extractHrefs(item.inner).some(
      (href) => readQueryParam(href, 'gender') !== undefined,
    );
    if (!linksGender) {
      continue;
    }
    const word = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(htmlToText(item.inner));
    const mapped = mapGender(word === null ? undefined : word[1]);
    if (mapped !== 'unknown') {
      return mapped;
    }
  }
  return 'unknown';
}

/** The course the page printed, e.g. `<li id="meet-course">SCY</li>`. Only the three real values are accepted. */
function readPrintedCourse(html: string): SwimCloudCourse | undefined {
  const text = elementTextById(html, 'meet-course');
  if (text === undefined) {
    return undefined;
  }
  const token = text.trim().toUpperCase();
  if (token === 'SCY' || token === 'SCM' || token === 'LCM') {
    return token;
  }
  return undefined;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** `Feb 17 – Mar 2, 2026`. */
const DATE_CROSS_MONTH = /^([A-Za-z]+)\.?\s+(\d{1,2})\s*[–—-]\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/;
/** `Feb 17–21, 2026` — the shape the real capture prints. */
const DATE_SAME_MONTH = /^([A-Za-z]+)\.?\s+(\d{1,2})\s*[–—-]\s*(\d{1,2}),\s*(\d{4})$/;
/** `Feb 17, 2026`. */
const DATE_SINGLE = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/;

function isoDate(year: number, monthWord: string, day: number): string | undefined {
  const month = MONTHS[monthWord.toLowerCase()];
  if (month === undefined || day < 1 || day > 31) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The meet's start and end dates, from the printed `<li id="meet-date">` line.
 *
 * Three shapes are recognized and nothing else. A line that matches none of them
 * leaves both dates **absent** and raises `unrecognized-meet-date` — a meet date
 * is not worth guessing at, and a wrong one silently mis-seasons every swim under
 * it.
 */
function readMeetDateRange(
  html: string,
  warnings: SwimCloudParseWarning[],
): { startDate?: string; endDate?: string } {
  const text = elementTextById(html, 'meet-date');
  if (text === undefined) {
    return {};
  }

  const cross = DATE_CROSS_MONTH.exec(text);
  if (cross !== null) {
    const year = Number.parseInt(cross[5], 10);
    const startDate = isoDate(year, cross[1], Number.parseInt(cross[2], 10));
    const endDate = isoDate(year, cross[3], Number.parseInt(cross[4], 10));
    if (startDate !== undefined && endDate !== undefined) {
      return { startDate, endDate };
    }
  }

  const same = DATE_SAME_MONTH.exec(text);
  if (same !== null) {
    const year = Number.parseInt(same[4], 10);
    const startDate = isoDate(year, same[1], Number.parseInt(same[2], 10));
    const endDate = isoDate(year, same[1], Number.parseInt(same[3], 10));
    if (startDate !== undefined && endDate !== undefined) {
      return { startDate, endDate };
    }
  }

  const single = DATE_SINGLE.exec(text);
  if (single !== null) {
    const startDate = isoDate(
      Number.parseInt(single[3], 10),
      single[1],
      Number.parseInt(single[2], 10),
    );
    if (startDate !== undefined) {
      return { startDate };
    }
  }

  warnings.push({
    code: 'unrecognized-meet-date',
    message: `Meet date ${JSON.stringify(text)} matches none of the recognized shapes ("Feb 17, 2026", "Feb 17-21, 2026", "Feb 17 - Mar 2, 2026"); no start or end date recorded.`,
    raw: text,
  });
  return {};
}

/**
 * The team's printed name, from the page's own bare `/team/{id}/` link.
 *
 * Bare links only. A meet-scoped `/results/{meetId}/team/{teamId}/` link carries
 * the same team id but is used for other things — on the real capture the gender
 * dropdown links to exactly that URL with the link text `Men`, which is how a
 * looser rule would name the team "Men".
 */
function teamNameForId(html: string, teamId: SwimCloudTeamId): string | undefined {
  for (const anchor of findElementSpans(html, 'a')) {
    const href = readAttribute(startTagOf(anchor.html), 'href');
    if (href === undefined) {
      continue;
    }
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'team') {
      continue;
    }
    if (classification.resource.teamId !== teamId) {
      continue;
    }
    const text = htmlToText(anchor.inner);
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

/** One `c-splash-stats` value, looked up by its printed label. Only a whole number is accepted. */
function readSplashStat(html: string, label: string): number | undefined {
  for (const item of extractListItems(html)) {
    const divs = findElementSpans(item, 'div');
    const labelDiv = divs.find((div) =>
      classTokens(startTagOf(div.html)).includes('c-splash-stats__label'),
    );
    if (labelDiv === undefined || htmlToText(labelDiv.inner).trim().toLowerCase() !== label) {
      continue;
    }
    const valueDiv = divs.find((div) =>
      classTokens(startTagOf(div.html)).includes('c-splash-stats__value'),
    );
    if (valueDiv === undefined) {
      return undefined;
    }
    const text = htmlToText(valueDiv.inner).trim();
    return /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
  }
  return undefined;
}

/**
 * The `<ul class="c-pagination">` widget, when the page has one.
 *
 * Returns `undefined` for a page with no widget. That is the single-page case,
 * not an error: SwimCloud omits the widget entirely when everything fits.
 *
 * `currentPage` comes from the widget's own active item. When the widget carries
 * no active marker it falls back to the capture URL's `?page=`, and then to 1 —
 * page 1 being the page a `page`-less URL serves, which the real capture
 * confirms (no `page` parameter, active item `1`).
 */
function readPagination(html: string, pageFromUrl: string | undefined): SwimCloudPagination | undefined {
  const widget = findElementSpans(html, 'ul').find((list) =>
    classTokens(startTagOf(list.html)).includes('c-pagination'),
  );
  if (widget === undefined) {
    return undefined;
  }

  let activePage: number | undefined;
  let totalPages = 0;
  let nextPageHref: string | undefined;

  for (const item of extractListItems(widget.inner)) {
    const actions = [...findElementSpans(item, 'button'), ...findElementSpans(item, 'a')];
    for (const action of actions) {
      const startTag = startTagOf(action.html);
      const text = htmlToText(action.inner).trim();
      const printed = /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
      if (printed !== undefined) {
        totalPages = Math.max(totalPages, printed);
        if (classTokens(startTag).includes('c-pagination__action--active')) {
          activePage = printed;
        }
      }
      const href = readAttribute(startTag, 'href');
      if (href === undefined) {
        continue;
      }
      const page = readQueryParam(href, 'page');
      if (page !== undefined && /^\d+$/.test(page)) {
        totalPages = Math.max(totalPages, Number.parseInt(page, 10));
      }
      if (readAttribute(startTag, 'aria-label')?.trim().toLowerCase() === 'next page') {
        nextPageHref = href;
      }
    }
  }

  if (totalPages === 0) {
    return undefined;
  }

  const fromUrl =
    pageFromUrl !== undefined && /^\d+$/.test(pageFromUrl) ? Number.parseInt(pageFromUrl, 10) : undefined;
  return {
    currentPage: activePage ?? fromUrl ?? 1,
    totalPages,
    ...(nextPageHref === undefined ? {} : { nextPageHref }),
  };
}

/* ---- Header columns, colspan-aware ----------------------------------------- */

/** One header cell, and the body columns it covers. */
interface SwimsHeaderColumn {
  /** {@link normalizeHeader}-normalized printed label. */
  readonly label: string;
  /** 0-based index of the first body cell this header covers. */
  readonly start: number;
  /** How many body cells it covers — its `colspan`, or 1. */
  readonly span: number;
}

/** Same set, same order, as `extractRowCells`'s own splitter, so index `n` here is cell `n` there. */
const CELL_START_TAG = /<(?:td|th)\b[^>]*>/gi;

/**
 * Header cells with the body columns each one covers.
 *
 * **`colspan` is not optional detail here.** Every real results table opens with
 * `<th colspan="2">Name</th>` spanning the row-ordinal column and the athlete
 * column, so a header row has seven cells against a body row's eight. Pairing
 * them by position — the obvious implementation — puts `Event` over the athlete
 * name and shifts every column after it by one, silently, with no parse error to
 * show for it.
 */
function readHeaderColumns(headerRowHtml: string): SwimsHeaderColumn[] {
  const cells = extractRowCells(headerRowHtml);
  const spans: number[] = [];
  CELL_START_TAG.lastIndex = 0;
  for (
    let match = CELL_START_TAG.exec(headerRowHtml);
    match !== null;
    match = CELL_START_TAG.exec(headerRowHtml)
  ) {
    const raw = readAttribute(match[0], 'colspan');
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    spans.push(Number.isInteger(parsed) && parsed > 0 ? parsed : 1);
  }
  CELL_START_TAG.lastIndex = 0;

  const columns: SwimsHeaderColumn[] = [];
  let start = 0;
  cells.forEach((cell, index) => {
    const span = spans[index] ?? 1;
    columns.push({ label: normalizeHeader(htmlToText(cell)), start, span });
    start += span;
  });
  return columns;
}

function columnFor(
  columns: readonly SwimsHeaderColumn[],
  synonyms: readonly string[],
): SwimsHeaderColumn | undefined {
  return columns.find((column) => synonyms.includes(column.label));
}

/**
 * Header labels for the swims table.
 *
 * Deliberately **not** the file's existing {@link TIME_HEADERS}, which lists
 * `score` as a synonym for a time column. On a real meet-root results table both
 * `Time` and `Score` are present and mean different things — `Score` is the
 * meet points the swim earned. Reusing the looser list would let a restyle that
 * reorders those two columns bind a time field to a score.
 */
const SWIMS_EVENT_HEADERS = ['event'] as const;
const SWIMS_TIME_HEADERS = ['time'] as const;
const SWIMS_PLACE_HEADERS = ['place'] as const;
const SWIMS_FLAGS_HEADERS = ['flags'] as const;

/**
 * The `Pts` column — SwimCloud's **power index**, not meet points.
 *
 * `'pts avg'` is deliberately absent: the `High point` card prints that as an
 * average over a swimmer's meet, and matching it here would read one table's
 * average into another table's per-swim field.
 */
const SWIMS_POINTS_HEADERS = ['pts', 'points'] as const;

/**
 * The `Score` column — the meet points the swim actually earned.
 *
 * A different quantity from {@link SWIMS_POINTS_HEADERS}, and the real capture
 * proves it rather than merely suggesting it: the meet-root results card carries
 * **both** columns on the same row, reading `Score` 20 and `Pts` 846 for one
 * first-place 1000 Free. See {@link SwimCloudTeamMeetSwim.meetScore}.
 */
const SWIMS_SCORE_HEADERS = ['score'] as const;

/** A results table, located and with its columns already resolved. */
interface LocatedSwimsTable {
  readonly name: SwimsHeaderColumn;
  readonly event: SwimsHeaderColumn;
  readonly time: SwimsHeaderColumn;
  readonly place?: SwimsHeaderColumn;
  readonly points?: SwimsHeaderColumn;
  readonly score?: SwimsHeaderColumn;
  readonly flags?: SwimsHeaderColumn;
  readonly team?: SwimsHeaderColumn;
  readonly dataRows: readonly (readonly string[])[];
}

/**
 * The first table on the page that is a results table.
 *
 * Identified by carrying `Name`, `Event` and `Time` columns together. That
 * combination is what separates the results card from the other tables a real
 * page ships — a `Teams` standings card (`Team`/`Score`) and a `High point`
 * card (`Name`/`Gold`/`Silver`/`Bronze`/`Score`/`Pts Avg`) both fail it, which
 * is the point: neither holds swims.
 *
 * `Place` and `Pts` are **not** required. The meet-root card prints `Score`
 * where the team pages print `Place`, and a table without a place column yields
 * rows with no place — absent, never zero.
 */
function locateSwimsTable(tables: readonly HtmlElementSpan[]): LocatedSwimsTable | null {
  for (const table of tables) {
    const rows = extractTableRows(table.html);
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const columns = readHeaderColumns(rows[headerIndex]);
    const name = columnFor(columns, NAME_HEADERS);
    const event = columnFor(columns, SWIMS_EVENT_HEADERS);
    const time = columnFor(columns, SWIMS_TIME_HEADERS);
    if (name === undefined || event === undefined || time === undefined) {
      continue;
    }
    const place = columnFor(columns, SWIMS_PLACE_HEADERS);
    const points = columnFor(columns, SWIMS_POINTS_HEADERS);
    const score = columnFor(columns, SWIMS_SCORE_HEADERS);
    const flags = columnFor(columns, SWIMS_FLAGS_HEADERS);
    const team = columnFor(columns, TEAM_HEADERS);
    return {
      name,
      event,
      time,
      ...(place === undefined ? {} : { place }),
      ...(points === undefined ? {} : { points }),
      ...(score === undefined ? {} : { score }),
      ...(flags === undefined ? {} : { flags }),
      ...(team === undefined ? {} : { team }),
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    };
  }
  return null;
}

/**
 * Which cell inside a spanned `Name` header actually holds the athlete.
 *
 * The athlete's cell is the one carrying the `/swimmer/{id}/` link. Falling back
 * to the **last** cell of the span rather than the first is what keeps a row's
 * printed ordinal (`1`, `2`, …) out of the athlete-name field on a capture whose
 * athlete happens to have no profile link.
 */
function subjectCellIndex(cells: readonly string[], column: SwimsHeaderColumn): number {
  const end = Math.min(column.start + column.span, cells.length);
  for (let index = column.start; index < end; index += 1) {
    if (swimmerIdFromCell(cells[index]) !== undefined) {
      return index;
    }
  }
  return Math.max(column.start, end - 1);
}

/* ---- Event label, course letter -------------------------------------------- */

/**
 * A swims-list event cell: `{distance} {course letter} {stroke}`.
 *
 * `100 Y Breast`, `1650 Y Free`, `200 Y IM`. No `Event {n}` prefix ever appears
 * — the event *number* lives in the row's time link, not in this text.
 */
const SWIMS_EVENT_LABEL = /^(\d{1,4})\s+([A-Za-z])\s+(.+)$/;

/**
 * SwimCloud's one-letter course codes.
 *
 * `Y` is confirmed by the real capture: every label on it reads `… Y …` and the
 * page's own `<li id="meet-course">` says `SCY`. `L` and `S` are **not** in that
 * capture. They are mapped anyway on two grounds, both recorded rather than
 * assumed: `entities.ts`'s {@link SwimCloudEvent.course} comment documents a
 * 2024-era scraper finding that SwimCloud appends exactly an `L`/`S`/`Y` course
 * suffix to event ids, and the letters are the sport's universal abbreviations.
 *
 * Any other letter is `'unknown'` with an `unrecognized-course-token` warning.
 * It is never defaulted to yards — a metric time scored against a yard cut is
 * precisely the silently-wrong number this repo's provenance rules exist to
 * stop.
 */
const COURSE_LETTERS: Readonly<Record<string, SwimCloudCourse>> = {
  y: 'SCY',
  l: 'LCM',
  s: 'SCM',
};

interface ParsedSwimsEventLabel {
  readonly distance?: number;
  readonly course: SwimCloudCourseOrUnknown;
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
  /** The course letter as printed, when the label matched the expected shape. */
  readonly courseLetter?: string;
  /** False when the label did not match `{distance} {letter} {stroke}` at all. */
  readonly matchedShape: boolean;
}

/**
 * Read distance, course and stroke out of a swims-list event cell.
 *
 * Pure — it raises nothing and warns nothing, so the caller can build the event
 * id first and then attribute any warning to it.
 */
function readSwimsEventLabel(label: string): ParsedSwimsEventLabel {
  const lower = label.toLowerCase();
  const isRelay = /\brelay\b/.test(lower);
  const match = SWIMS_EVENT_LABEL.exec(label.trim());

  if (match === null) {
    // Keep whatever can still be read honestly, and let the caller say out loud
    // that the shape was not the expected one.
    const loose = /\b(\d{1,4})\b/.exec(label);
    return {
      ...(loose === null ? {} : { distance: Number.parseInt(loose[1], 10) }),
      course: 'unknown',
      stroke: mapStroke(lower, isRelay),
      isRelay,
      matchedShape: false,
    };
  }

  const courseLetter = match[2];
  const course = COURSE_LETTERS[courseLetter.toLowerCase()] ?? 'unknown';
  return {
    distance: Number.parseInt(match[1], 10),
    course,
    stroke: mapStroke(lower, isRelay),
    isRelay,
    courseLetter,
    matchedShape: true,
  };
}

/* ---- Row-level readers ------------------------------------------------------ */

/** What a row's time cell links to: the event it belongs to, and the swim's own id. */
interface SwimLink {
  readonly eventRef: string;
  readonly swimId?: string;
}

/**
 * Read the event reference and swim id out of a row's time link.
 *
 * The link is `/results/{meetId}/event/{eventRef}/?id={swimId}#time{swimId}`. It
 * is the **only** place a row states which event it belongs to: the printed
 * label cannot say, and on the real capture two rows both reading `100 Y Breast`
 * point at event `26` and event `100`.
 *
 * A link naming a different meet is ignored rather than trusted, so a stray
 * cross-meet link cannot attach a swim to the wrong meet.
 */
function readSwimLink(cellHtml: string, meetId: SwimCloudMeetId): SwimLink | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetEvent') {
      continue;
    }
    if (classification.resource.meetId !== meetId) {
      continue;
    }
    const id = readQueryParam(href, 'id');
    return {
      eventRef: classification.resource.eventRef,
      ...(id !== undefined && /^\d+$/.test(id) ? { swimId: id } : {}),
    };
  }
  return undefined;
}

/**
 * Place cells that mean "no place" on a swims list.
 *
 * The **en dash** (U+2013) is the confirmed one — it is what a real capture
 * prints for an unplaced swim, and it is not the hyphen a reader might assume.
 * The rest are carried over from {@link NO_PLACE_TOKENS} because they express the
 * same idea and none of them can be confused with an ordinal.
 *
 * A separate set from {@link NO_PLACE_TOKENS} on purpose: adding the en dash
 * there would change how {@link parseMeetResultsHtml} treats a page shape nobody
 * has verified, turning a loud warning into a silent absence on evidence that
 * does not cover it.
 */
const SWIMS_NO_PLACE_TOKENS = new Set(['', '–', '—', '-', '--', '---']);

/** `1st`, `2nd`, `3rd`, `17th`. */
const ORDINAL_PLACE = /^(\d+)\s*(?:st|nd|rd|th)$/i;

/**
 * Read a swims-list place cell, which prints an **ordinal**, not an integer.
 *
 * A bare integer is accepted too. It never appears on the captured page, but an
 * integer in a place column is unambiguous, and refusing it would discard a real
 * place to make a point. Anything else is `unrecognized-place-token` and no
 * place at all — never coerced, never zero.
 *
 * Kept separate from {@link readPlace}, which stays exactly as it was for the
 * page shape it was written against.
 */
function readOrdinalPlace(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): number | undefined {
  const token = raw.trim();
  if (SWIMS_NO_PLACE_TOKENS.has(token)) {
    return undefined;
  }
  const ordinal = ORDINAL_PLACE.exec(token);
  const digits = ordinal !== null ? ordinal[1] : /^\d+$/.test(token) ? token : undefined;
  if (digits !== undefined) {
    const value = Number.parseInt(digits, 10);
    if (value > 0) {
      return value;
    }
  }
  warnings.push({
    code: 'unrecognized-place-token',
    message: `Place cell ${JSON.stringify(token)} is neither an ordinal ("1st", "17th"), a positive integer, nor a known "no place" marker; no place recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return undefined;
}

/** What the flags cell carries. Both parts are optional and can co-occur. */
interface SwimFlagsCell {
  readonly relayLeadoff: boolean;
  readonly cutStandards: SwimCloudCutStandardLabel[];
}

/**
 * Read a row's flags cell.
 *
 * Leadoff detection matches on `title="Leadoff"` and nothing else. Not the
 * visible `R` glyph, and never the event name: a leadoff split's event cell is
 * character-for-character identical to a genuine individual swim of the same
 * event, and the real capture contains both.
 */
function readFlagsCell(cellHtml: string): SwimFlagsCell {
  let relayLeadoff = false;
  const cutStandards: SwimCloudCutStandardLabel[] = [];

  for (const span of findElementSpans(cellHtml, 'span')) {
    const startTag = startTagOf(span.html);
    const title = readAttribute(startTag, 'title');
    if (title !== undefined && title.trim().toLowerCase() === 'leadoff') {
      relayLeadoff = true;
      continue;
    }
    if (!classTokens(startTag).includes('c-label--royal')) {
      continue;
    }
    const label = htmlToText(span.inner);
    if (label.length > 0) {
      cutStandards.push({ label, ...(title === undefined ? {} : { title }) });
    }
  }

  return { relayLeadoff, cutStandards };
}

/* ---- The row loop ----------------------------------------------------------- */

interface SwimRowsContext {
  readonly meetId: SwimCloudMeetId;
  readonly gender: SwimCloudGenderOrUnknown;
  readonly meetCourse?: SwimCloudCourse;
  readonly fallbackTeamId?: SwimCloudTeamId;
  readonly fallbackTeamName?: string;
  readonly warnings: SwimCloudParseWarning[];
}

function readSwimRows(
  table: LocatedSwimsTable,
  ctx: SwimRowsContext,
): { swims: SwimCloudTeamMeetSwim[]; rowCount: number } {
  const swims: SwimCloudTeamMeetSwim[] = [];

  table.dataRows.forEach((cells, rowIndex) => {
    const nameIndex = subjectCellIndex(cells, table.name);
    const nameCellHtml = cellAt(cells, nameIndex);
    const athleteName = htmlToText(nameCellHtml);
    if (athleteName.length === 0) {
      ctx.warnings.push({
        code: 'unparsed-row',
        message: 'Results row has an empty athlete cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const eventLabel = htmlToText(cellAt(cells, table.event.start));
    const timeCellHtml = cellAt(cells, table.time.start);
    const link = readSwimLink(timeCellHtml, ctx.meetId);
    const parsedLabel = readSwimsEventLabel(eventLabel);

    // The event id keys off the page's own event reference whenever there is
    // one. The label fallback is deterministic and capture-local; it is not a
    // SwimCloud id and is never presented as one.
    const eventId =
      link === undefined
        ? `${ctx.meetId}:event-label:${normalizeHeader(eventLabel)}`
        : `${ctx.meetId}:event:${link.eventRef}`;

    const course: SwimCloudCourseOrUnknown =
      parsedLabel.course !== 'unknown' ? parsedLabel.course : (ctx.meetCourse ?? 'unknown');

    const event: SwimCloudEvent = {
      eventId,
      swimCloudMeetId: ctx.meetId,
      ...(link === undefined ? {} : { eventRef: link.eventRef }),
      label: eventLabel,
      kind: parsedLabel.isRelay ? 'relay' : 'individual',
      course,
      gender: ctx.gender,
      ...(parsedLabel.distance === undefined ? {} : { distance: parsedLabel.distance }),
      stroke: parsedLabel.stroke,
    };

    if (!parsedLabel.matchedShape) {
      ctx.warnings.push({
        code: 'unrecognized-event-label',
        message: `Event cell ${JSON.stringify(eventLabel)} does not match the expected "{distance} {course letter} {stroke}" shape; distance and course were not read from it.`,
        eventId,
        rowIndex,
        raw: eventLabel,
      });
    } else if (parsedLabel.course === 'unknown') {
      ctx.warnings.push({
        code: 'unrecognized-course-token',
        message: `Course letter ${JSON.stringify(parsedLabel.courseLetter ?? '')} in ${JSON.stringify(eventLabel)} is outside Y/L/S; course recorded as ${JSON.stringify(course)} rather than assumed.`,
        eventId,
        rowIndex,
        raw: eventLabel,
      });
    } else if (ctx.meetCourse !== undefined && parsedLabel.course !== ctx.meetCourse) {
      ctx.warnings.push({
        code: 'course-column-contradicts-label',
        message: `Event ${JSON.stringify(eventLabel)} is ${parsedLabel.course} by its course letter, but the page declares the meet as ${ctx.meetCourse}. The label wins; the disagreement is reported rather than resolved silently.`,
        eventId,
        rowIndex,
        raw: eventLabel,
      });
    }

    if (link === undefined) {
      ctx.warnings.push({
        code: 'missing-swim-link',
        message: `Time cell for ${JSON.stringify(athleteName)} carries no /results/${ctx.meetId}/event/{n}/ link; the swim has no SwimCloud swim id or event reference, and a composite key derived from the row's own values is used instead.`,
        eventId,
        rowIndex,
      });
    } else if (link.swimId === undefined) {
      ctx.warnings.push({
        code: 'missing-swim-link',
        message: `Time cell for ${JSON.stringify(athleteName)} links to event ${link.eventRef} but carries no "?id=" swim id; a composite key derived from the row's own values is used instead.`,
        eventId,
        rowIndex,
      });
    }

    const place =
      table.place === undefined
        ? undefined
        : readOrdinalPlace(textAt(cells, table.place.start), event, rowIndex, ctx.warnings);
    const time = readTime(htmlToText(timeCellHtml), event, rowIndex, ctx.warnings);
    const points =
      table.points === undefined
        ? {}
        : readPoints(textAt(cells, table.points.start), event, rowIndex, ctx.warnings);
    // The Score column, when the table has one. Read with the same reader as
    // Pts — both are plain non-negative numbers — but kept in its own field,
    // because they measure different things. See SwimCloudTeamMeetSwim.meetScore.
    const score =
      table.score === undefined
        ? {}
        : readPoints(textAt(cells, table.score.start), event, rowIndex, ctx.warnings);
    const flagsCell = readFlagsCell(table.flags === undefined ? '' : cellAt(cells, table.flags.start));

    const swimmerId = swimmerIdFromCell(nameCellHtml);
    if (swimmerId === undefined) {
      ctx.warnings.push({
        code: 'missing-athlete-link',
        message: `Results row for ${athleteName} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
        eventId,
        rowIndex,
        raw: athleteName,
      });
    }

    const teamCellHtml = table.team === undefined ? '' : cellAt(cells, table.team.start);
    const rowTeamName = htmlToText(teamCellHtml);
    const teamId = teamIdFromCell(teamCellHtml) ?? ctx.fallbackTeamId;
    const teamName = rowTeamName.length > 0 ? rowTeamName : ctx.fallbackTeamName;

    const swimKey =
      link?.swimId === undefined
        ? `${eventId}:swim:${swimmerId ?? `row${rowIndex}`}:${time.finalTime ?? time.rawTimeToken ?? `row${rowIndex}`}`
        : `${ctx.meetId}:swim:${link.swimId}`;

    const flags: SwimCloudResultFlags | undefined =
      time.flags === undefined && !flagsCell.relayLeadoff
        ? undefined
        : { ...(time.flags ?? {}), ...(flagsCell.relayLeadoff ? { relayLeadoff: true } : {}) };

    const entry: SwimCloudEntry = {
      entryId: `${swimKey}:entry`,
      eventId,
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      athleteName,
      ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
      ...(teamName === undefined ? {} : { teamName }),
    };

    const result: SwimCloudResult = {
      resultId: `${swimKey}:result`,
      entryId: entry.entryId,
      eventId,
      ...(place === undefined ? {} : { place }),
      ...(points.points === undefined ? {} : { points: points.points }),
      ...(points.rawPointsToken === undefined ? {} : { rawPointsToken: points.rawPointsToken }),
      ...(time.finalTime === undefined ? {} : { finalTime: time.finalTime }),
      ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
      ...(flags === undefined ? {} : { flags }),
    };

    // The printed ordinal only exists when the Name header spans the column
    // before it. Read from that leading cell, never from the row's position:
    // page 2 of a list starts at 31, not at 1.
    const ordinalText =
      table.name.span > 1 && nameIndex !== table.name.start
        ? textAt(cells, table.name.start)
        : '';
    const rowOrdinal = /^\d+$/.test(ordinalText) ? Number.parseInt(ordinalText, 10) : undefined;

    swims.push({
      swimKey,
      ...(link?.swimId === undefined ? {} : { swimCloudSwimId: link.swimId }),
      ...(rowOrdinal === undefined ? {} : { rowOrdinal }),
      event,
      entry,
      result,
      relayLeadoff: flagsCell.relayLeadoff,
      cutStandards: flagsCell.cutStandards,
      ...(score.points === undefined ? {} : { meetScore: score.points }),
    });
  });

  if (table.dataRows.length === 0) {
    ctx.warnings.push({
      code: 'zero-data-rows',
      message:
        'The results table was found and holds no data rows. This is a real "nothing posted for this team and gender" answer, not a missing table.',
    });
  }

  return { swims, rowCount: table.dataRows.length };
}
