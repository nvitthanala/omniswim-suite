/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `@omniswim/swimcloud` — everything specific to SwimCloud as a *source*, kept
 * out of the domain model in `@omniswim/core` and out of persistence in
 * `@omniswim/db` so the domain layer never learns where an Entry or Result came
 * from (`plans/2026-09-06/03-architecture.md` §1).
 *
 * Everything except `./playwrightFetcher` has zero runtime dependencies, no
 * network access, and no DOM. `./playwrightFetcher` is the one exception: it
 * depends on `playwright-core` (already present in this repo's tree at the
 * version `@playwright/test` resolves to, for the root e2e suite — no new
 * browser-automation dependency was introduced) because launching a real
 * browser is the only way to pass SwimCloud's Cloudflare challenge. Every
 * other module stays as it was in Phase 1: pure functions over strings.
 *
 * ## What is in this package today (Phase 2)
 *
 * - **Entities** (`./entities`) — the typed shape of what a SwimCloud page says.
 * - **URL classifier** (`./urlClassifier`) — pure `string -> classification`,
 *   including the robots.txt denylist as a first-class `forbidden` outcome.
 * - **Parser/normalizer** (`./parser`) — HTML string in, entities out, shared by
 *   both access tracks.
 * - **HTML helpers** (`./html`) — the regex-only extraction primitives the
 *   parser is built from, exported because the browser extension will need the
 *   same ones.
 * - **Status-keyed cache** (`./cache`) — in-memory and filesystem-backed
 *   stores for captured pages, `'final'` snapshots treated as immutable.
 * - **Politeness-enforcing fetcher wrapper** (`./fetcher`) — the single choke
 *   point Track B's requests pass through: robots.txt denylist, rate
 *   limiting, cache read-through. Framework-agnostic — takes any
 *   `SwimCloudRawFetcher`.
 * - **The real Track B raw fetcher** (`./playwrightFetcher`) — a
 *   `playwright-core`-backed `SwimCloudRawFetcher`. **Never run against a live
 *   site in this repo's history** — see its file header before using it.
 *
 * Not here yet: the browser extension (Phase 3) and any wiring into
 * `packages/db` persistence (descoped from Phase 1, still descoped).
 *
 * ## Three things every caller must know
 *
 * 1. **Most URL patterns are believed, not verified.** They come from prior-art
 *    scraper code and search results; SwimCloud's Cloudflare challenge prevented
 *    direct confirmation. The `/results/…` family is the exception — a real
 *    capture on 2026-09-08 confirmed four of its patterns. See the header of
 *    `./urlClassifier.ts` for exactly which.
 * 2. **Two parsers have never seen real SwimCloud markup.**
 *    `parseMeetResultsHtml` and `parseSwimmerProfileHtml` were written against
 *    hand-authored synthetic fixtures and report
 *    `confidence: 'synthetic-fixture-only'`. `parseTeamMeetSwimsHtml`,
 *    `parseMeetTeamsHtml`, `parseMeetTopTeamsHtml`, `parseTeamRosterHtml` and
 *    `parseSwimmerTimesHtml` were written against real captures and report
 *    `confidence: 'real-capture-verified'`. Those captures also proved that
 *    **both** guessed parsers describe page shapes SwimCloud does not serve —
 *    read the header of `./parser.ts` before using either for anything. A
 *    swimmer's own event history is parsed by `parseSwimmerTimesHtml`, against
 *    the real `/swimmer/{id}/times/` capture, not by `parseSwimmerProfileHtml`.
 * 3. **`./playwrightFetcher` has never fetched a real page, from SwimCloud or
 *    anywhere else.** It is type-checked against the real `playwright-core` API
 *    and unit-tested only where that doesn't require launching a browser. See
 *    its file header for exactly what still has to happen, and why that step
 *    is deliberately not something any agent should do unattended.
 *
 * None of these is a bug to be fixed by writing more code. All are resolved by
 * one human, present, running one real capture each — which is exactly how the
 * `/results/…` family stopped being a guess.
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
  SwimCloudMeetTeamQuery,
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

export {
  SWIMCLOUD_PARSE_CONFIDENCE,
  SWIMCLOUD_REAL_CAPTURE_CONFIDENCE,
  parseMeetEventResultsHtml,
  readMeetEventIndex,
  parseMeetResultsHtml,
  parseMeetTeamsHtml,
  parseMeetTopTeamsHtml,
  parseSwimmerProfileHtml,
  parseSwimmerTimesHtml,
  parseSwimmerFastestTimesJson,
  parseTeamMeetSwimsHtml,
  parseTeamRosterHtml,
} from './parser';

export type {
  SwimCloudCutStandardLabel,
  SwimCloudEventRoundPointsColumn,
  SwimCloudMeetEventIndexEntry,
  SwimCloudMeetEventResultsParse,
  SwimCloudMeetEventResultsParseOptions,
  SwimCloudMeetEventRound,
  SwimCloudMeetEventSwim,
  SwimCloudMeetResultsParse,
  SwimCloudMeetResultsParseOptions,
  SwimCloudMeetTeamStanding,
  SwimCloudMeetTeamsDiscoveryCompleteness,
  SwimCloudMeetTeamsParse,
  SwimCloudMeetTeamsParseOptions,
  SwimCloudPagination,
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
  SwimCloudPersonalBest,
  SwimCloudPersonalBestSwim,
  SwimCloudRosterFieldSource,
  SwimCloudRosterParse,
  SwimCloudRosterParseOptions,
  SwimCloudSwimmerProfileParse,
  SwimCloudSwimmerProfileParseOptions,
  SwimCloudSwimmerTimesFieldSource,
  SwimCloudSwimmerTimesParse,
  SwimCloudSwimmerTimesParseOptions,
  SwimCloudSwimmerTimesTag,
  SwimCloudTeamMeetSwim,
  SwimCloudTeamMeetSwimsParse,
  SwimCloudTeamMeetSwimsParseOptions,
} from './parser';

export { captureIdForSubject, FileSystemSwimCloudCaptureStore } from './captureStore';
export type {
  SwimCloudCaptureCompleteness,
  SwimCloudCapturePageOutcome,
  SwimCloudCapturePageRef,
  SwimCloudCaptureRecord,
  SwimCloudCaptureSubject,
  SwimCloudCaptureTeamDiscovery,
} from './captureStore';

export {
  DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID,
  SWIMCLOUD_CRAWL_PASSES,
  SWIMCLOUD_CRAWL_PASS_PREREQUISITE,
  SWIMCLOUD_DOM_RENDERED_PASSES,
  passRequiresRenderedDom,
  scopePassesNeedingRenderedDom,
  SWIMCLOUD_CRAWL_SCOPES,
  capturePlannedPassStatus,
  crawlScopeDependencyGaps,
  crawlScopeFloorPagesPerTeam,
  crawlScopePlansPass,
  crawlScopeRecordFor,
  defaultSwimCloudCrawlScope,
  mergeCaptureCrawlScopes,
  orderCrawlPasses,
  passesNewlyPlannedBy,
  passesOutsideCrawlScope,
  planMeetEventResults,
  planMeetSwimmerTimes,
  planMeetTeamDiscovery,
  planMeetTeamDiscoveryFallback,
  planMeetTeamRosters,
  planMeetTeamSwims,
  planScopedMeetCrawl,
  readSwimCloudCrawlPass,
  readSwimCloudCrawlScopeId,
  swimCloudCrawlScope,
} from './crawlPlan';
export type {
  SwimCloudCaptureCrawlScope,
  SwimCloudCrawlGender,
  SwimCloudCrawlPass,
  SwimCloudCrawlScope,
  SwimCloudCrawlScopeId,
  SwimCloudCrawlStep,
  SwimCloudMeetEventResultsCrawlInput,
  SwimCloudMeetRostersCrawlInput,
  SwimCloudScopedMeetCrawlInput,
  SwimCloudScopedMeetCrawlPlan,
  SwimCloudMeetSwimmerTimesCrawlInput,
  SwimCloudMeetSwimsCrawlInput,
} from './crawlPlan';

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

export type {
  SwimCloudCacheEntry,
  SwimCloudCacheStatus,
  SwimCloudCacheStore,
} from './cache';
export { FileSystemSwimCloudCache, InMemorySwimCloudCache } from './cache';

export {
  SwimCloudFetchPolicyError,
  SwimCloudFinalEntryImmutableError,
  SwimCloudForbiddenUrlError,
  SwimCloudPoliteFetcher,
  SwimCloudUnfetchableUrlError,
} from './fetcher';
export type {
  SwimCloudPoliteFetchOptions,
  SwimCloudPoliteFetchResult,
  SwimCloudPoliteFetcherClock,
  SwimCloudPoliteFetcherOptions,
  SwimCloudRawFetchResult,
  SwimCloudRawFetcher,
} from './fetcher';

export { PlaywrightSwimCloudFetcher, storageStateArgument } from './playwrightFetcher';
export type { PlaywrightSwimCloudFetcherOptions } from './playwrightFetcher';

export { readSwimCloudClipboardPayload } from './clipboardPayload';
export type {
  SwimCloudClipboardAccepted,
  SwimCloudClipboardPayload,
  SwimCloudClipboardPayloadV2,
  SwimCloudClipboardReadResult,
  SwimCloudClipboardRejected,
  SwimCloudClipboardRejectionReason,
} from './clipboardPayload';
