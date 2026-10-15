/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Result envelope for every SwimCloud parser: confidence, warning and failure codes, the parse context, and the `fail` and `succeed` constructors.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import type { SwimCloudCaptureTrack, SwimCloudProvenance } from './entities';

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
  /**
   * The page rendered SwimCloud's own "No rosters found" empty state instead of
   * a table. That is an answer, not a failure: the school does not field this
   * gender, or has posted no roster for the season being asked for.
   */
  | 'no-roster-posted'
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
  /**
   * The page printed no meet name: no `meet-name` element and no level-1 heading.
   * `meet.name` is then `''`, as `format`, `ruleset` and `course` read
   * `'unknown'` when unstated. An empty name means "not stated", never a meet
   * called nothing. `meetName` stays absent on the payload.
   */
  | 'meet-name-missing'
  /** A class-year cell held a value outside the known vocabulary. Recorded as `'unknown'`. */
  | 'unmapped-class-year'
  /** An event's gender word is outside `Men`/`Women` (e.g. `Mixed`). Recorded as `'unknown'`. */
  | 'unmapped-gender'
  /** An event label's stroke could not be identified. Recorded as `'unknown'`. */
  | 'unmapped-stroke'
  /** A roster/results row named an athlete with no `/swimmer/{id}/` link. */
  | 'missing-athlete-link'
  /** A relay row listed no legs. SwimCloud does publish them — a per-event page serves them in a table behind its own "Show names" toggle — so this is a genuine gap, not the expected state. */
  | 'relay-legs-absent'
  /**
   * A relay row on a per-event results page (`parseMeetEventResultsHtml`) read no
   * legs: the page had no hidden "Show names" list for it, or the list was
   * unreadable. The row is kept without legs, so its swimmers cannot be
   * credited. Raised by the parser itself. `readRelayEventEntries` still adds its
   * own `relay-legs-absent` for the same row, so a caller reading both sees the
   * row twice under two codes.
   */
  | 'relay-row-without-legs'
  /** A per-event page carried no `js-event-item` event index, so it cannot enumerate the rest of the meet. Never read as "the meet has no events". */
  | 'event-index-absent'
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
  | 'contradicted-page-declaration'
  /**
   * A relay event page lists a relay whose leg count is not four. Every relay
   * SwimCloud models here has four legs, so a different count means the hidden
   * "Show names" list was cut short or the markup changed. The legs that were
   * read are kept; none is invented to make four.
   */
  | 'relay-leg-count-unexpected'
  /**
   * A conference home page names teams only incidentally (latest results, top
   * swims, commitments, top swimmers). It is never the member list. Emitted on
   * every successful parse so no caller can read the result as complete.
   */
  | 'conference-teams-list-incomplete'
  /** The conference home page carried no readable `<title>` display name. `displayName` stays absent. */
  | 'conference-name-absent'
  /** The conference home page carried no link to its own Teams tab. `teamsTabUrl` stays absent; the URL is not rebuilt from the slug. */
  | 'conference-teams-tab-absent'
  /** The conference home page linked no team at all. Absent evidence, not proof the conference has no teams. */
  | 'conference-no-team-mentions';

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
  /** A JSON response body was not valid JSON, or not the array shape the parser requires. */
  | 'unreadable-json'
  /** Data rows existed and every one of them failed to parse. */
  | 'no-rows-parsed'
  /** Event headings existed and not one of their tables could be read. */
  | 'no-events-parsed'
  /** The page lacks the structure of the page type the parser was asked for (for example no section headings and no nav links on a conference home). */
  | 'expected-structure-missing'
  /** An event page parsed fine but is not a relay event, so it has no relay entries to read. */
  | 'not-a-relay-event';

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

/** Shared with the sibling page parsers in this package (`relayLegCredits.ts`, `conferencePage.ts`). Not part of the public barrel. */
export function fail(
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

/** See {@link fail}. */
export function succeed<T>(
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
