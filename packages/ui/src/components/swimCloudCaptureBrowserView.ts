/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s pure surface: the capture-store shapes it
 * mirrors, the prop and selection types it hands consumers, and the honest-text
 * helpers both consumers already proved. No React, no I/O, no state.
 *
 * Pure extraction from `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 * That file re-exports everything here, so every existing import path keeps
 * working. Its header comment holds the design notes (server contract,
 * progressive disclosure, honest completeness).
 */

// `@omniswim/swimcloud/captureStore` (and `./cache`, which it re-exports types
// from) is Node-hosted — `packages/ui/tsconfig.json` sets `"types": []`
// specifically so this UI package cannot accidentally pull in `node:fs`, and
// even a type-only import of that subpath makes `tsc` walk the whole file and
// fail. So the capture-store shapes below are declared locally, matching
// `packages/swimcloud/src/captureStore.ts` field for field. The parser and
// entity subpaths below are browser-safe and are imported directly, the same
// discipline every other consumer follows: never the package root.
import type { SwimCloudCaptureSubject } from '@omniswim/swimcloud/entities';
// `crawlPlan` is pure planning data — it imports only `./entities` and
// `./urlClassifier`, both browser-safe — so unlike `./captureStore` it can be
// imported here rather than mirrored. Mirroring the scope rules would be worse
// than mirroring a shape: two copies of "which passes did this capture plan"
// that can disagree is exactly the silent wrongness they exist to prevent.
import {
  SWIMCLOUD_CRAWL_PASSES,
  capturePlannedPassStatus,
  readSwimCloudCrawlScopeId,
  swimCloudCrawlScope,
  type SwimCloudCaptureCrawlScope,
  type SwimCloudCrawlPass,
  passRequiresRenderedDom,
} from '@omniswim/swimcloud/crawlPlan';
import type {
  SwimCloudMeetEventResultsParse,
  SwimCloudRosterParse,
  SwimCloudSwimmerTimesParse,
  SwimCloudTeamMeetSwimsParse,
} from '@omniswim/swimcloud/parser';

/* ========================================================================== */
/* Shapes                                                                     */
/* ========================================================================== */

/** Mirrors `captureStore.ts`'s `SwimCloudCaptureCompleteness`. No `'complete'`
 * value exists there on purpose — see this file's header comment. */
export type SwimCloudCaptureCompleteness =
  | 'in-progress'
  | 'every-planned-page-fetched'
  | 'partial'
  | 'failed';

/** Mirrors `captureStore.ts`'s `SwimCloudCaptureTeamDiscovery`. */
export interface SwimCloudCaptureTeamDiscovery {
  readonly source: 'topteams' | 'meet-root-links-fallback';
  readonly genders: readonly string[];
  readonly teamIds: readonly string[];
  readonly completeness: 'unproven' | 'verified-complete-for-this-capture' | 'user-confirmed';
}

/** Mirrors `captureStore.ts`'s `SwimCloudCapturePageRef` — only the fields this browser reads. */
export interface SwimCloudCapturePageRef {
  readonly canonicalUrl: string;
  readonly teamId?: string;
  readonly gender?: string;
}

/** Mirrors `captureStore.ts`'s `SwimCloudCaptureRecord`. */
export interface SwimCloudCaptureRecord {
  readonly captureId: string;
  readonly subject: SwimCloudCaptureSubject;
  readonly label?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completeness: SwimCloudCaptureCompleteness;
  readonly teamDiscovery?: SwimCloudCaptureTeamDiscovery;
  /**
   * Which passes the crawls that filled this capture planned, when the record
   * says. **Absent is not "everything"** — see {@link describeCaptureScope}.
   */
  readonly crawlScope?: SwimCloudCaptureCrawlScope;
  readonly plannedPageCount: number;
  readonly pages: readonly SwimCloudCapturePageRef[];
  readonly notes: readonly string[];
}

/**
 * What `POST /api/swimcloud/captures/:id/parse` answers with — mirrors
 * `apps/shell/lib/swimcloudCaptureRoutes.ts`'s `SwimCloudCaptureParseResponse`,
 * declared locally rather than imported because `apps/shell` is a different
 * package this one must not depend on.
 */
export interface SwimCloudCaptureParseResponse {
  readonly captureId: string;
  readonly subject: SwimCloudCaptureSubject;
  /** One entry per stored `meetTeamSwims` page that parsed, in stored page order. */
  readonly parses: readonly SwimCloudTeamMeetSwimsParse[];
  /** One entry per stored team-roster page that parsed. */
  readonly rosters: readonly SwimCloudRosterParse[];
  /** One entry per stored swimmer-times page that parsed. */
  readonly swimmerTimes: readonly SwimCloudSwimmerTimesParse[];
  /**
   * One entry per stored per-event results page (`/results/{meetId}/event/{n}/`)
   * that parsed.
   *
   * **Not browsed — used.** A meet-results consumer reads a swim's round, rank,
   * exhibition flag and real meet score off these. Without them a swimmer who
   * made finals imports as an unresolvable duplicate and is excluded with a
   * named reason; with them the swim scores as the round it actually was. A
   * capture stored before the event-results pass answers `[]`, and the import
   * behaves exactly as it did before — never worse, never guessed.
   */
  readonly eventResults: readonly SwimCloudMeetEventResultsParse[];
  readonly warnings: readonly string[];
}

/**
 * What a capture actually covers of one roster — counted, never estimated.
 *
 * Structurally identical to `packages/manager/src/lib/rosterQueueImport.ts`'s
 * `RosterCaptureCoverage`, which is where the single pairing rule that produces
 * it lives. This package declares the shape but never the rule: a roster-history
 * consumer injects its own {@link SwimCloudCaptureRosterHistoryProps.rosterCoverage},
 * so the number a coach sees before committing is computed by the same code the
 * import itself will run.
 */
export interface SwimCloudCaptureRosterCoverage {
  readonly rosterAthleteCount: number;
  /** Athletes this capture holds a swimmer-times page for. */
  readonly withCapturedTimes: number;
  /** Athletes it does not — they stay on the consumer's checklist for a manual capture. */
  readonly withoutCapturedTimes: number;
}

/** One team/gender filter group derived from a parse response's own parses — never an invented field. */
export interface SwimCloudCaptureParseGroup {
  readonly key: string;
  readonly label: string;
  readonly parses: readonly SwimCloudTeamMeetSwimsParse[];
  readonly rowCount: number;
}

/* ========================================================================== */
/* Honest text — the phrases both consumers already proved                    */
/* ========================================================================== */

export function subjectLabel(subject: SwimCloudCaptureSubject): string {
  if (subject.kind === 'meet') return `Meet ${subject.meetId}`;
  return subject.season ? `Team ${subject.teamId} (${subject.season})` : `Team ${subject.teamId}`;
}

export function captureDisplayLabel(capture: SwimCloudCaptureRecord): string {
  return capture.label !== undefined && capture.label.length > 0
    ? capture.label
    : subjectLabel(capture.subject);
}

/**
 * The honest, qualified phrase for what a capture's team-discovery step
 * proved — never "verified" or "complete" standing alone with no qualifier.
 */
function teamDiscoveryPhrase(discovery: SwimCloudCaptureTeamDiscovery | undefined): string {
  if (!discovery) return 'team list discovery not recorded';
  switch (discovery.completeness) {
    case 'unproven':
      return 'team list unverified';
    case 'verified-complete-for-this-capture':
      return 'team list verified complete for this capture';
    case 'user-confirmed':
      return 'team list user-confirmed complete';
  }
}

function pagesPhrase(capture: SwimCloudCaptureRecord): string {
  const fetched = capture.pages.length;
  const planned = capture.plannedPageCount;
  if (planned > 0) {
    return `${fetched} of ${planned} planned page${planned === 1 ? '' : 's'}`;
  }
  return `${fetched} page${fetched === 1 ? '' : 's'}`;
}

/**
 * How many of a capture's planned pages it actually holds — stated as a
 * fraction, never as the word "complete". Short enough to sit inside a picker
 * option, where a coach chooses between captures before selecting one; the
 * fuller {@link describeCompleteness} sentence follows for whichever they pick.
 */
export function capturePagesPhrase(capture: SwimCloudCaptureRecord): string {
  if (capture.completeness === 'failed') return 'capture failed';
  const pages = pagesPhrase(capture);
  return capture.completeness === 'in-progress' ? `${pages} so far — still crawling` : pages;
}

/**
 * `${teamId} (${gender})` combinations `teamDiscovery` named that no stored
 * page's own facets (`SwimCloudCapturePageRef.teamId`/`.gender`) cover yet.
 * Built only from recorded facts — never a guess at what "should" exist
 * beyond what the crawler's own discovery step already named.
 */
function missingTeamGenderCombos(capture: SwimCloudCaptureRecord): readonly string[] {
  const discovery = capture.teamDiscovery;
  if (!discovery) return [];
  const seen = new Set(capture.pages.map(page => `${page.teamId ?? '?'}::${page.gender ?? '?'}`));
  const missing: string[] = [];
  for (const teamId of discovery.teamIds) {
    for (const gender of discovery.genders) {
      if (!seen.has(`${teamId}::${gender}`)) missing.push(`${teamId} (${gender})`);
    }
  }
  return missing;
}

/**
 * The honest, human-readable completeness sentence for one capture. Never
 * renders the bare word "Complete" — see this file's header comment.
 */
export function describeCompleteness(capture: SwimCloudCaptureRecord): string {
  const completeness: SwimCloudCaptureCompleteness = capture.completeness;
  const discoveryPhrase = teamDiscoveryPhrase(capture.teamDiscovery);

  if (completeness === 'failed') {
    return 'Capture failed — see notes below.';
  }
  if (completeness === 'in-progress') {
    return `${pagesPhrase(capture)} fetched so far · ${discoveryPhrase}`;
  }
  if (completeness === 'partial') {
    const missing = capture.plannedPageCount - capture.pages.length;
    const combos = missingTeamGenderCombos(capture);
    const parts = [pagesPhrase(capture)];
    if (missing > 0) parts.push(`${missing} planned page${missing === 1 ? '' : 's'} not yet fetched`);
    if (combos.length > 0) {
      const shown = combos.slice(0, 3).join(', ');
      parts.push(`missing ${shown}${combos.length > 3 ? `, +${combos.length - 3} more` : ''}`);
    }
    parts.push(discoveryPhrase);
    return parts.join(' · ');
  }
  // 'every-planned-page-fetched' — a claim about the crawl plan, not about
  // SwimCloud itself. See captureStore.ts's own doc comment on this value.
  return `${pagesPhrase(capture)} fetched · ${discoveryPhrase}`;
}

/* -------------------------------------------------------------------------- */
/* Crawl scope — absent is not empty                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a capture is known to have planned one pass.
 *
 * Three values, not two. `'not-recorded'` is a capture stored before crawl
 * scopes existed — `data/swimcloud-captures/` holds a real 234-page one — and
 * nothing on disk says which passes its crawl planned. "It holds no roster
 * pages" and "it never asked for roster pages" cannot be told apart for such a
 * capture, and this UI must say so rather than pick whichever reads better.
 */
export type SwimCloudCapturePassStatus = 'planned' | 'not-planned' | 'not-recorded';

/** {@link SwimCloudCapturePassStatus} for one pass of one capture. */
export function capturePassStatus(
  capture: SwimCloudCaptureRecord | null | undefined,
  pass: SwimCloudCrawlPass,
): SwimCloudCapturePassStatus {
  return capturePlannedPassStatus(capture?.crawlScope, pass);
}

/** What a coach calls each pass's pages. */
const PASS_NOUN: Readonly<Record<SwimCloudCrawlPass, string>> = {
  meetTeamSwims: 'this meet’s team results',
  meetEvent: 'per-event round pages',
  teamRoster: 'team rosters',
  swimmerTimes: 'swimmers’ personal-best pages',
};

/** The scope's own label, or `undefined` when the record names a scope this build does not know. */
function recordedScopeLabel(capture: SwimCloudCaptureRecord): string | undefined {
  const id = readSwimCloudCrawlScopeId(capture.crawlScope?.latestScopeId);
  return id === undefined ? undefined : swimCloudCrawlScope(id).label;
}

/**
 * One line saying what this capture's crawl set out to fetch — rendered under
 * the completeness sentence, for every capture.
 *
 * This exists because `'every-planned-page-fetched'` is a claim about a plan,
 * and since 2026-09-20 the plan itself can be narrow. A meet-results capture
 * legitimately reports every planned page fetched while holding zero roster and
 * zero swimmer-times pages; at the completeness field alone it is
 * indistinguishable from a full crawl. This line is the difference.
 *
 * Never returns an empty string. A capture that records no scope gets a
 * sentence saying that, because "we do not know" is a fact a coach acts on
 * differently from "everything was fetched", and a blank row would be read as
 * the latter.
 */
export function describeCaptureScope(capture: SwimCloudCaptureRecord): string {
  const scope = capture.crawlScope;
  if (scope === undefined) {
    return 'Crawl scope not recorded — this capture was stored before crawls recorded what they planned, so pages it does not hold cannot be told apart from pages it never asked for.';
  }
  const label = recordedScopeLabel(capture);
  // Derived from the recorded `plannedPasses`, never from the scope id's own
  // table. The two agree for a capture crawled once, and only `plannedPasses`
  // is right for one crawled twice at different scopes — it is the union the
  // route stores, and the union is what the pages on disk actually cover.
  const skipped = SWIMCLOUD_CRAWL_PASSES.filter(pass => !scope.plannedPasses.includes(pass));
  const named = label === undefined ? 'an unrecognised scope' : `“${label}”`;
  if (skipped.length === 0) {
    return `Crawled as ${named} — every pass was planned.`;
  }
  return `Crawled as ${named} — never planned: ${skipped.map(pass => PASS_NOUN[pass]).join(', ')}. Those pages are absent by plan, not missing from the meet.`;
}

/**
 * What an empty section means, beyond the fact that it is empty.
 *
 * **Qualifies a caller's own sentence; never replaces it.** The observed fact
 * — "this capture holds no team-roster page" — is true under every status and
 * stays the first thing a coach reads. What changes is what that fact is
 * evidence of, and that is what this adds.
 *
 * `null` when the pass **was** planned: the capture asked for rosters, got
 * none, and there is nothing further to say.
 *
 * `CLAUDE.md`'s "absent is not empty", one level above a parser: an empty
 * roster list that reads as "this meet has no rostered swimmers" is the exact
 * failure this repo names as its most expensive.
 */
export function describeUnplannedPass(
  capture: SwimCloudCaptureRecord | null | undefined,
  pass: SwimCloudCrawlPass,
): string | null {
  if (capture === null || capture === undefined) return null;
  const status = capturePassStatus(capture, pass);
  if (status === 'planned') return null;
  const noun = PASS_NOUN[pass];
  if (status === 'not-recorded') {
    return `This capture does not record which passes its crawl planned, so an empty list here could mean ${noun} were never requested, or that none exist. Re-crawl this meet in the extension to settle it.`;
  }
  // A pass no scope can ever deliver needs different advice. Telling a coach to
  // "re-crawl with a wider scope" would send them to do something that cannot
  // work: the swimmer personal-bests page builds its table in the browser, so
  // every fetched copy is a shell. See SWIMCLOUD_DOM_RENDERED_PASSES.
  if (passRequiresRenderedDom(pass)) {
    return `No crawl fetches ${noun}, whatever scope it uses. That page builds its table in the browser after loading, so a fetched copy holds none of it. Capture those swimmers one at a time with the extension's clipboard button instead — that reads the rendered page.`;
  }
  const label = recordedScopeLabel(capture);
  const named = label === undefined ? 'a narrower scope' : `“${label}”`;
  return `This capture was crawled as ${named}, which never plans ${noun}. None were fetched and none are missing — re-crawl this meet with a wider scope to add them.`;
}

/**
 * The coverage sentence, in full. Says what is missing as plainly as what is
 * present — a coach reading "31 of 35" must not have to infer the other 4.
 */
export function describeRosterCoverage(coverage: SwimCloudCaptureRosterCoverage): string {
  if (coverage.rosterAthleteCount === 0) return 'This roster page listed no athletes.';
  if (coverage.withCapturedTimes === 0) {
    return `0 of ${coverage.rosterAthleteCount} athletes have captured times — all ${coverage.rosterAthleteCount} will need a manual capture.`;
  }
  if (coverage.withoutCapturedTimes === 0) {
    return `${coverage.withCapturedTimes} of ${coverage.rosterAthleteCount} athletes have captured times.`;
  }
  return `${coverage.withCapturedTimes} of ${coverage.rosterAthleteCount} athletes have captured times · ${coverage.withoutCapturedTimes} will need a manual capture.`;
}

function groupKeyFor(parse: SwimCloudTeamMeetSwimsParse): string {
  return `${parse.teamName ?? 'unknown-team'}::${parse.gender}`;
}

function groupLabelFor(parse: SwimCloudTeamMeetSwimsParse): string {
  const team = parse.teamName ?? 'Unknown team';
  const gender = parse.gender === 'unknown' ? 'Unknown gender' : parse.gender;
  return `${team} · ${gender}`;
}

/** Fold a parse response's pages into one row per team/gender, summing their row counts. */
export function groupParses(
  parses: readonly SwimCloudTeamMeetSwimsParse[]
): SwimCloudCaptureParseGroup[] {
  const groups = new Map<string, SwimCloudCaptureParseGroup>();
  for (const parse of parses) {
    const key = groupKeyFor(parse);
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, {
        ...existing,
        parses: [...existing.parses, parse],
        rowCount: existing.rowCount + parse.rowCount,
      });
    } else {
      groups.set(key, { key, label: groupLabelFor(parse), parses: [parse], rowCount: parse.rowCount });
    }
  }
  return [...groups.values()];
}

/**
 * A stable key for one roster parse in the list. Rosters carry no id of their
 * own, so this is built from whatever the parse does state plus its position
 * — good enough for a React key, for a radio group, and for remembering which
 * rows are expanded; not claimed to be a SwimCloud identity.
 */
export function rosterKeyFor(parse: SwimCloudRosterParse, index: number): string {
  return `${parse.swimCloudTeamId ?? 'unknown-team'}::${parse.gender ?? 'unknown'}::${parse.season ?? 'unknown-season'}::${index}`;
}

export function rosterTeamLabel(parse: SwimCloudRosterParse): string {
  return parse.teamName ?? parse.swimCloudTeamId ?? 'Unknown team';
}

/** Team, gender and season in one line — what a coach picks a roster by. */
export function rosterHeading(parse: SwimCloudRosterParse): string {
  return `${rosterTeamLabel(parse)} · ${parse.gender ?? 'unknown gender'} · ${parse.season ?? 'unknown season'}`;
}

/** Name shown for a swimmer-times row, falling back to the id when the page's own `#swimmer-info` block never named the swimmer. */
export function swimmerTimesLabel(parse: SwimCloudSwimmerTimesParse): string {
  return parse.name ?? parse.swimCloudSwimmerId;
}

/* ========================================================================== */
/* Props                                                                      */
/* ========================================================================== */

/** Which section leads. Never which network calls happen, and never what a selection converts to. */
export type SwimCloudCaptureBrowserMode = 'meet-results' | 'roster-history';

/**
 * The demoted single-page path, offered only where there is no capture to
 * browse — no captures stored yet, or the capture routes unreachable. It is a
 * secondary link, not a peer of the primary action; see
 * `plans/2026-09-10/02-UI-REDESIGN-WHOLE-APP.md` §0.
 */
export interface SwimCloudCapturePasteFallback {
  readonly label: string;
  readonly hint?: string;
  /** Runs the consumer's own clipboard import. The consumer closes this window if it wants to. */
  readonly onPaste: () => void;
}

/** What `meet-results` mode hands back when the coach commits. */
export interface SwimCloudCaptureMeetResultsSelection {
  /** Every stored page belonging to a checked team/gender group, flattened in list order. */
  readonly parses: readonly SwimCloudTeamMeetSwimsParse[];
  /**
   * Every parsed event page in the capture, not only those whose team was
   * checked: one event page covers the whole field, so filtering them by the
   * team selection would drop the round labels for exactly the swimmers being
   * imported.
   */
  readonly eventResults: readonly SwimCloudMeetEventResultsParse[];
  /**
   * Every parsed roster page in the capture, for the class-year join — see
   * `buildSwimCloudClassYearIndex`.
   *
   * Unfiltered by the team selection, same reasoning as `eventResults`: an
   * event page holds the whole field, so the swimmers being imported can
   * belong to teams the coach did not check, and their class year is on their
   * own team's roster. Empty means no roster is in this capture, and every
   * row's class year reads unknown with that stated as the reason.
   */
  readonly rosters: readonly SwimCloudRosterParse[];
  /** `parses.length`, named for the "Loaded N swim(s) from M page(s)" sentence. */
  readonly pageCount: number;
  /** The checked groups themselves, in list order. */
  readonly groups: readonly SwimCloudCaptureParseGroup[];
  /**
   * Every warning `/parse` reported for this capture, already formatted by
   * the route (not `{code, message}` pairs — see that route's own doc
   * comment). Not filtered by the checked groups, same reasoning as
   * `eventResults`: a coach reading these wants to know what the whole
   * capture reported, not just the pages they happened to check.
   */
  readonly warnings: readonly string[];
}

/** What `roster-history` mode hands back when the coach commits. */
export interface SwimCloudCaptureRosterSelection {
  readonly roster: SwimCloudRosterParse;
  /** Every swimmer-times page the same capture holds. One belonging to another team simply never pairs. */
  readonly swimmerTimes: readonly SwimCloudSwimmerTimesParse[];
  /** Exactly what was shown to the coach before they committed. */
  readonly coverage: SwimCloudCaptureRosterCoverage;
  /**
   * Whether the capture is known to have planned the swimmer-times pass.
   *
   * Handed to the consumer because the consumer owns the message a coach reads
   * when the import yields no swims. "No importable times in this capture" is
   * true under every status, but it means three different things: the pages
   * were fetched and held nothing, the crawl never asked for them, or nobody
   * recorded which. Only the second is fixed by re-crawling with a wider scope.
   */
  readonly swimmerTimesPass: SwimCloudCapturePassStatus;
  /** True when the roster page states a gender the consumer is not scoped to. Stated, never resolved here. */
  readonly genderMismatch: boolean;
}

interface SwimCloudCaptureBrowserBaseProps {
  /** Closes the window. The consumer unmounts this component; nothing is cached across a close. */
  readonly onClose: () => void;
  /** Window title, and the dialog's accessible name. Defaults per mode. */
  readonly title?: string;
  /** One line under the title saying what picking a capture will do. Defaults per mode. */
  readonly description?: string;
  readonly pasteFallback?: SwimCloudCapturePasteFallback;
  /** `localStorage` key for the window's position and size. Defaults per mode. */
  readonly storageKey?: string;
}

export interface SwimCloudCaptureMeetResultsProps extends SwimCloudCaptureBrowserBaseProps {
  readonly mode: 'meet-results';
  /**
   * Applies the checked team/gender groups. Owns its own success and failure
   * messages, and closes this window itself if it wants to — this component
   * knows nothing about workspaces.
   */
  readonly onImportMeetResults: (
    selection: SwimCloudCaptureMeetResultsSelection
  ) => void | Promise<void>;
}

export interface SwimCloudCaptureRosterHistoryProps extends SwimCloudCaptureBrowserBaseProps {
  readonly mode: 'roster-history';
  /** The team the consumer is importing under, already selected there. Never re-asked here. */
  readonly team: string;
  /** The gender the consumer is scoped to. A roster stating a different one is flagged, not silently imported. */
  readonly genderLabel: string;
  /**
   * The consumer's own pairing rule — `rosterCaptureCoverage` in
   * `packages/manager/src/lib/rosterQueueImport.ts`. Injected rather than
   * reimplemented so the count shown here and the import that follows read the
   * one rule, not two copies of it.
   */
  readonly rosterCoverage: (
    roster: SwimCloudRosterParse,
    swimmerTimes: readonly SwimCloudSwimmerTimesParse[]
  ) => SwimCloudCaptureRosterCoverage;
  /** Hands the chosen roster back. Same division of labour as the meet-results callback. */
  readonly onImportRoster: (selection: SwimCloudCaptureRosterSelection) => void | Promise<void>;
}

export type SwimCloudCaptureBrowserProps =
  | SwimCloudCaptureMeetResultsProps
  | SwimCloudCaptureRosterHistoryProps;

/* ========================================================================== */
/* Sections                                                                   */
/* ========================================================================== */

export type SectionId = 'rosters' | 'swimmerTimes' | 'meetResults';

export function defaultExpandedFor(mode: SwimCloudCaptureBrowserMode): Record<SectionId, boolean> {
  return {
    rosters: mode === 'roster-history',
    swimmerTimes: false,
    meetResults: mode === 'meet-results',
  };
}
