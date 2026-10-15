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

// Barrel. The code lives in the sibling modules named below. This file keeps every
// name it exported before the split, so no importer changes.

export {
  SWIMCLOUD_PARSE_CONFIDENCE,
  SWIMCLOUD_REAL_CAPTURE_CONFIDENCE,
  fail,
  succeed,
  type SwimCloudParseConfidence,
  type SwimCloudParseWarningCode,
  type SwimCloudParseWarning,
  type SwimCloudParseFailureCode,
  type SwimCloudParseFailure,
  type SwimCloudParseSuccess,
  type SwimCloudParseFailureResult,
  type SwimCloudParseResult,
  type SwimCloudParseContext,
} from './parseResult';

export {
  type SwimCloudCutStandardLabel,
} from './swimFields';

export {
  readRelayDesignator,
} from './relayLegs';

export {
  parseTeamRosterHtml,
  type SwimCloudRosterParseOptions,
  type SwimCloudRosterFieldSource,
  type SwimCloudRosterParse,
} from './rosterPage';

export {
  parseMeetResultsHtml,
  type SwimCloudMeetResultsParseOptions,
  type SwimCloudParsedEvent,
  type SwimCloudMeetResultsParse,
} from './meetResultsPage';

export {
  parseSwimmerProfileHtml,
  type SwimCloudPersonalBest,
  type SwimCloudSwimmerProfileParseOptions,
  type SwimCloudSwimmerProfileParse,
} from './swimmerProfilePage';

export {
  parseSwimmerTimesHtml,
  type SwimCloudSwimmerTimesTag,
  type SwimCloudPersonalBestSwim,
  type SwimCloudSwimmerTimesFieldSource,
  type SwimCloudSwimmerTimesParseOptions,
  type SwimCloudSwimmerTimesParse,
} from './swimmerTimesPage';

export {
  parseSwimmerFastestTimesJson,
} from './swimmerFastestTimes';

export {
  parseTeamMeetSwimsHtml,
  type SwimCloudTeamMeetSwimsParseOptions,
  type SwimCloudTeamMeetSwim,
  type SwimCloudPagination,
  type SwimCloudTeamMeetSwimsParse,
} from './teamMeetSwimsPage';

export {
  parseMeetTeamsHtml,
  parseMeetTopTeamsHtml,
  type SwimCloudMeetTeamStanding,
  type SwimCloudMeetTeamsDiscoveryCompleteness,
  type SwimCloudMeetTeamsParse,
  type SwimCloudMeetTeamsParseOptions,
} from './meetTeamsPage';

export {
  readMeetEventIndex,
  type SwimCloudMeetEventIndexEntry,
} from './meetEventIndex';

export {
  type SwimCloudEventRoundPointsColumn,
  type SwimCloudMeetEventSwim,
  type SwimCloudMeetEventRound,
} from './meetEventRounds';

export {
  parseMeetEventResultsHtml,
  type SwimCloudMeetEventResultsParseOptions,
  type SwimCloudMeetEventResultsParse,
} from './meetEventPage';
