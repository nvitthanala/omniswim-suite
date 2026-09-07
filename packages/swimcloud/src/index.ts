/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@omniswim/swimcloud` — everything specific to SwimCloud as a *source*, kept
 * out of the domain model in `@omniswim/core` and out of persistence in
 * `@omniswim/db` so the domain layer never learns where an Entry or Result came
 * from (`plans/2026-09-06/03-architecture.md` §1).
 *
 * Zero runtime dependencies. No network access. No DOM.
 *
 * ## What is in this package today (Phase 1)
 *
 * - **Entities** (`./entities`) — the typed shape of what a SwimCloud page says.
 * - **URL classifier** (`./urlClassifier`) — pure `string -> classification`,
 *   including the robots.txt denylist as a first-class `forbidden` outcome.
 * - **Parser/normalizer** (`./parser`) — HTML string in, entities out, shared by
 *   both access tracks.
 * - **HTML helpers** (`./html`) — the regex-only extraction primitives the
 *   parser is built from, exported because the browser extension will need the
 *   same ones.
 *
 * Not here yet: the politeness-enforcing fetcher wrapper and the status-keyed
 * cache (Phase 2), and the browser extension (Phase 3).
 *
 * ## Two things every caller must know
 *
 * 1. **The URL patterns are believed, not verified.** They come from prior-art
 *    scraper code and search results; SwimCloud's Cloudflare challenge prevented
 *    direct confirmation. See the header of `./urlClassifier.ts`.
 * 2. **The parser has never seen real SwimCloud markup.** Every extraction rule
 *    was written against hand-authored synthetic fixtures, which is why every
 *    parse result carries `confidence: 'synthetic-fixture-only'`. See the header
 *    of `./parser.ts`.
 *
 * Neither of those is a bug to be fixed by writing more code. Both are resolved
 * by one human capturing one real page each.
 */

export type {
  SwimCloudAthlete,
  SwimCloudCaptureTrack,
  SwimCloudClassYear,
  SwimCloudConference,
  SwimCloudConferenceSlug,
  SwimCloudCourse,
  SwimCloudCourseOrUnknown,
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudEventKind,
  SwimCloudGender,
  SwimCloudGenderOrUnknown,
  SwimCloudHeat,
  SwimCloudMeet,
  SwimCloudMeetFormat,
  SwimCloudMeetId,
  SwimCloudNumericId,
  SwimCloudProgramStatus,
  SwimCloudProvenance,
  SwimCloudRelay,
  SwimCloudRelayLeg,
  SwimCloudResult,
  SwimCloudResultFlags,
  SwimCloudRuleset,
  SwimCloudSession,
  SwimCloudSessionKind,
  SwimCloudStroke,
  SwimCloudSwimmerId,
  SwimCloudTeam,
  SwimCloudTeamId,
  SwimCloudTimeString,
} from './entities';

export {
  SWIMCLOUD_APEX_HOST,
  SWIMCLOUD_CANONICAL_HOST,
  SWIMCLOUD_ROBOTS_DISALLOW_RULES,
  canonicalPathForResource,
  classifySwimCloudUrl,
  isFetchableSwimCloudUrl,
  isForbiddenSwimCloudUrl,
  isSwimCloudHost,
} from './urlClassifier';

export type {
  SwimCloudConferenceUrlForm,
  SwimCloudMalformedReason,
  SwimCloudResource,
  SwimCloudResourceKind,
  SwimCloudRobotsRule,
  SwimCloudTeamResultsQuery,
  SwimCloudTeamRosterQuery,
  SwimCloudUnrecognizedReason,
  SwimCloudUrlClassification,
  SwimCloudUrlFetchable,
  SwimCloudUrlForbidden,
  SwimCloudUrlMalformed,
  SwimCloudUrlUnrecognized,
} from './urlClassifier';

export { SWIMCLOUD_PARSE_CONFIDENCE, parseMeetResultsHtml, parseTeamRosterHtml } from './parser';

export type {
  SwimCloudMeetResultsParse,
  SwimCloudMeetResultsParseOptions,
  SwimCloudParseConfidence,
  SwimCloudParseContext,
  SwimCloudParseFailure,
  SwimCloudParseFailureCode,
  SwimCloudParseFailureResult,
  SwimCloudParseResult,
  SwimCloudParseSuccess,
  SwimCloudParseWarning,
  SwimCloudParseWarningCode,
  SwimCloudParsedEvent,
  SwimCloudRosterParse,
  SwimCloudRosterParseOptions,
} from './parser';

export {
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
  stripHtmlTags,
  stripNonContent,
} from './html';

export type { HtmlElementSpan, HtmlHeading } from './html';
