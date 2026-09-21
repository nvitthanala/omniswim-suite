/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One capture-browsing surface, used by every applet that needs one.
 *
 * Replaces two independently-grown components that did the same job for two
 * different consumers — `packages/matrix/src/components/SwimCloudCapturePicker.tsx`
 * (769 lines) and `packages/manager/src/components/SwimCloudCaptureRosterImportPanel.tsx`
 * (476 lines). Both fetched the pairing token, listed captures, parsed one,
 * rendered honest completeness, and offered a "forget this capture" action.
 * Only what they DID with a parsed capture ever differed, and that difference
 * is real: Matrix converts meet results into `SwimmerResult[]`; Manager
 * converts a roster plus its swimmer-times pages into `HistoricalSwim[]`.
 * See `plans/2026-09-09/01-UI-REDESIGN-PLAN.md` §3.
 *
 * So this component browses. It never converts. Each consumer passes one
 * callback that receives exactly what it selected, and owns its own toasts,
 * its own workspace writes, and its own decision to close the window.
 *
 * ## Server contract this builds against
 *
 * ```
 * GET    /api/swimcloud/pairing-token   -> 200, { token }
 * GET    /api/swimcloud/captures        -> 200, SwimCloudCaptureRecord[]
 * POST   /api/swimcloud/captures/:id/parse
 *          -> 200, { captureId, subject, parses, rosters, swimmerTimes,
 *                    eventResults, warnings }
 *          -> 404 if the capture id doesn't exist
 * DELETE /api/swimcloud/captures/:id    -> 200, { success, captureId, pagesDeleted }
 * ```
 *
 * `apps/shell/lib/swimcloudCaptureRoutes.ts` gates every capture route behind
 * a pairing-token header (`X-Omniswim-Capture-Token`). The token is fetched
 * once from `GET /api/swimcloud/pairing-token`, which is gated by this app's
 * own auth. If that fetch fails — capture routes not registered on a
 * non-loopback bind, or this app's auth rejecting it — the browser says why
 * and never calls a capture route it knows will 401.
 *
 * ## Progressive disclosure
 *
 * One always-visible picker plus one honest status line. Below it, three
 * collapsible sections — rosters, swimmer times, meet results — of which the
 * `mode`-relevant one starts expanded and carries the action button. The
 * other two collapse until a coach asks for them, and are omitted entirely
 * when the capture holds nothing of that kind. `mode` chooses which section
 * leads; it never changes which network calls happen.
 *
 * ## Honest completeness — no bare "Complete"
 *
 * `SwimCloudCaptureCompleteness` deliberately has no `'complete'` value (see
 * that type's own doc comment in `packages/swimcloud/src/captureStore.ts`):
 * `'every-planned-page-fetched'` is a claim about the crawl plan, not a claim
 * that SwimCloud's own team list was ever verified. {@link describeCompleteness}
 * always folds `teamDiscovery.completeness` into the sentence instead of
 * collapsing either value to "Complete." The word is not rendered anywhere in
 * this file, not even as a column heading.
 *
 * ## Motion
 *
 * None is added. Sections show and hide instantly, so there is no transition
 * for `prefers-reduced-motion` to reduce. The only `transition-*` classes here
 * are the repo's existing hover colour transitions, which carry no movement.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ClipboardPaste, RefreshCw, Trash2 } from 'lucide-react';
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
import { Button } from './Button';
import { FloatingWindow, type FloatingWindowState } from './FloatingWindow';
import { useToast } from './Toast';

const CAPTURES_ENDPOINT = '/api/swimcloud/captures';
const PAIRING_TOKEN_ENDPOINT = '/api/swimcloud/pairing-token';
const CAPTURE_TOKEN_HEADER = 'X-Omniswim-Capture-Token';

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
/* Window geometry                                                            */
/* ========================================================================== */

const MIN_WINDOW_WIDTH = 380;
const MIN_WINDOW_HEIGHT = 320;

function defaultWindowState(): FloatingWindowState {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const w = Math.max(MIN_WINDOW_WIDTH, Math.min(680, vw - 64));
  const h = Math.max(MIN_WINDOW_HEIGHT, Math.min(640, vh - 96));
  return {
    x: Math.max(0, Math.round((vw - w) / 2)),
    y: Math.max(0, Math.round((vh - h) / 3)),
    w,
    h,
  };
}

/** Reads a remembered position, falling back to a centred default on anything unexpected. */
function loadWindowState(key: string): FloatingWindowState {
  const fallback = defaultWindowState();
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<FloatingWindowState>;
    return {
      x: typeof parsed.x === 'number' ? parsed.x : fallback.x,
      y: typeof parsed.y === 'number' ? parsed.y : fallback.y,
      w: typeof parsed.w === 'number' ? parsed.w : fallback.w,
      h: typeof parsed.h === 'number' ? parsed.h : fallback.h,
    };
  } catch {
    return fallback;
  }
}

/* ========================================================================== */
/* Sections                                                                   */
/* ========================================================================== */

type SectionId = 'rosters' | 'swimmerTimes' | 'meetResults';

function defaultExpandedFor(mode: SwimCloudCaptureBrowserMode): Record<SectionId, boolean> {
  return {
    rosters: mode === 'roster-history',
    swimmerTimes: false,
    meetResults: mode === 'meet-results',
  };
}

function CaptureSection({
  id,
  title,
  expanded,
  onToggle,
  action,
  children,
}: {
  readonly id: SectionId;
  readonly title: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const bodyId = `swimcloud-capture-section-${id}`;
  return (
    <section className="border border-theme-soft rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex flex-1 min-w-0 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown size={14} className="text-theme-secondary shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-theme-secondary shrink-0" />
          )}
          <span className="text-ui-caption font-bold uppercase tracking-widest text-[var(--text-primary)] truncate">
            {title}
          </span>
        </button>
        {action}
      </div>
      {expanded ? (
        <div id={bodyId} className="px-3 pb-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/* ========================================================================== */
/* The browser                                                                */
/* ========================================================================== */

export function SwimCloudCaptureBrowser(props: SwimCloudCaptureBrowserProps) {
  const { mode, onClose, pasteFallback } = props;
  const toast = useToast();

  const windowTitle =
    props.title ??
    (mode === 'meet-results'
      ? 'SwimCloud captures — meet results'
      : 'SwimCloud captures — roster history');
  const description =
    props.description ??
    (mode === 'meet-results'
      ? 'Pick a capture the extension has fetched, then choose which teams and genders to load.'
      : `Pick a capture, then a roster in it. Every swimmer it captured times for is imported at once, into ${
          props.mode === 'roster-history' && props.team.trim() ? props.team.trim() : 'the selected team'
        } · ${props.mode === 'roster-history' ? props.genderLabel : ''}`.trim());
  const storageKey = props.storageKey ?? `omni-swimcloud-capture-browser-${mode}`;

  const [windowState, setWindowState] = useState<FloatingWindowState>(() => loadWindowState(storageKey));
  const [captures, setCaptures] = useState<readonly SwimCloudCaptureRecord[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [parseResponse, setParseResponse] = useState<SwimCloudCaptureParseResponse | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>(() =>
    defaultExpandedFor(mode)
  );
  const [checkedGroups, setCheckedGroups] = useState<Record<string, boolean>>({});
  const [selectedRosterKey, setSelectedRosterKey] = useState<string | null>(null);
  // Read-only browsing state for the collapsed sections — separate from
  // `checkedGroups`/`selectedRosterKey`, which drive what actually gets imported.
  const [expandedRosterKeys, setExpandedRosterKeys] = useState<Record<string, boolean>>({});
  const [expandedSwimmerKeys, setExpandedSwimmerKeys] = useState<Record<string, boolean>>({});
  // `null` = not yet fetched, `undefined` = fetched and unavailable (see
  // `tokenError`), a string = the real pairing token. Every capture-route call
  // below waits on this rather than firing with no header and drawing a
  // guaranteed 401.
  const [pairingToken, setPairingToken] = useState<string | null | undefined>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const pickerRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(windowState));
    } catch {
      // A browser with site data blocked still gets a working window; it just
      // forgets where it was put.
    }
  }, [storageKey, windowState]);

  // Escape closes, the same way every dialog in this suite should. The window
  // is deliberately non-modal (it is draggable, and the page behind it stays
  // usable), so no focus trap is claimed and `aria-modal` is not set.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const loadPairingToken = useCallback(async (): Promise<string | undefined> => {
    try {
      const res = await fetch(PAIRING_TOKEN_ENDPOINT);
      if (!res.ok) {
        setTokenError(
          res.status === 404
            ? 'SwimCloud capture routes are not available on this server (it may not be bound to localhost only).'
            : `Could not obtain the SwimCloud pairing token (HTTP ${res.status}).`
        );
        setPairingToken(undefined);
        return undefined;
      }
      const data = (await res.json()) as { token?: unknown };
      if (typeof data.token !== 'string' || data.token.length === 0) {
        setTokenError('The server did not return a usable pairing token.');
        setPairingToken(undefined);
        return undefined;
      }
      setPairingToken(data.token);
      return data.token;
    } catch (err) {
      setTokenError(`Could not reach the server for the pairing token: ${String(err)}`);
      setPairingToken(undefined);
      return undefined;
    }
  }, []);

  /** Headers for a capture-route call. Never called before the token fetch resolves. */
  const captureAuthHeaders = (token: string): HeadersInit => ({ [CAPTURE_TOKEN_HEADER]: token });

  const loadCaptures = useCallback(async (token: string) => {
    setListError(null);
    try {
      const res = await fetch(CAPTURES_ENDPOINT, { headers: captureAuthHeaders(token) });
      if (!res.ok) {
        setListError(`Could not list captures (HTTP ${res.status}).`);
        setCaptures([]);
        return;
      }
      setCaptures((await res.json()) as SwimCloudCaptureRecord[]);
    } catch (err) {
      setListError(`Could not reach the capture store: ${String(err)}`);
      setCaptures([]);
    }
  }, []);

  const refresh = useCallback(async () => {
    const token = pairingToken ?? (await loadPairingToken());
    if (token) await loadCaptures(token);
  }, [pairingToken, loadPairingToken, loadCaptures]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pickerRef.current?.focus();
  }, []);

  const selectedCapture = useMemo(
    () => captures?.find(capture => capture.captureId === selectedCaptureId) ?? null,
    [captures, selectedCaptureId]
  );

  const groups = useMemo(
    () => (parseResponse ? groupParses(parseResponse.parses) : []),
    [parseResponse]
  );

  const rosterOptions = useMemo(() => {
    if (!parseResponse) return [];
    if (props.mode !== 'roster-history') {
      return parseResponse.rosters.map((roster, index) => ({
        key: rosterKeyFor(roster, index),
        roster,
        coverage: null as SwimCloudCaptureRosterCoverage | null,
        genderMismatch: false,
      }));
    }
    const { rosterCoverage, genderLabel } = props;
    return parseResponse.rosters.map((roster, index) => ({
      key: rosterKeyFor(roster, index),
      roster,
      coverage: rosterCoverage(roster, parseResponse.swimmerTimes),
      genderMismatch: roster.gender !== undefined && (roster.gender as string) !== genderLabel,
    }));
    // `props` is narrowed above; the mode-specific fields are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parseResponse, props.mode, props.mode === 'roster-history' ? props.rosterCoverage : null, props.mode === 'roster-history' ? props.genderLabel : null]);

  const selectedRoster = rosterOptions.find(option => option.key === selectedRosterKey) ?? null;

  const selectCapture = async (captureId: string) => {
    if (!pairingToken) return;
    setSelectedCaptureId(captureId);
    setConfirmingForget(false);
    setParseResponse(null);
    setSelectedRosterKey(null);
    setExpandedRosterKeys({});
    setExpandedSwimmerKeys({});
    setExpandedSections(defaultExpandedFor(mode));
    setIsParsing(true);
    try {
      const res = await fetch(`${CAPTURES_ENDPOINT}/${captureId}/parse`, {
        method: 'POST',
        headers: captureAuthHeaders(pairingToken),
      });
      if (res.status === 404) {
        toast.push('error', 'That capture no longer exists. Refreshing the list.');
        setSelectedCaptureId(null);
        await loadCaptures(pairingToken);
        return;
      }
      if (!res.ok) {
        toast.push('error', `Could not parse that capture (HTTP ${res.status}).`);
        setSelectedCaptureId(null);
        return;
      }
      const data = (await res.json()) as SwimCloudCaptureParseResponse;
      setParseResponse(data);
      const nextChecked: Record<string, boolean> = {};
      for (const group of groupParses(data.parses)) nextChecked[group.key] = true;
      setCheckedGroups(nextChecked);
      if (data.rosters.length === 1) setSelectedRosterKey(rosterKeyFor(data.rosters[0], 0));
      if (data.warnings.length > 0) {

        console.warn('SwimCloud capture parse: warnings', data.warnings);
        toast.push('info', `Parsed with ${data.warnings.length} warning(s) — see console.`);
      }
      // Looked up by id rather than read off `selectedCapture`: this closure
      // was created before `setSelectedCaptureId` above, so the memo still
      // points at whatever was selected previously.
      const justSelected = captures?.find(c => c.captureId === captureId) ?? null;
      if (mode === 'roster-history') {
        if (data.rosters.length === 0) {
          const why = describeUnplannedPass(justSelected, 'teamRoster');
          toast.push(
            'info',
            why === null
              ? 'This capture holds no team-roster page. Crawl the team’s roster in the extension, or capture swimmers one at a time from the clipboard.'
              : `This capture holds no team-roster page. ${why}`
          );
        }
      } else if (
        data.parses.length === 0 &&
        data.rosters.length === 0 &&
        data.swimmerTimes.length === 0
      ) {
        const why = describeUnplannedPass(justSelected, 'meetTeamSwims');
        toast.push(
          'info',
          why === null
            ? 'This capture has no parseable team-results pages yet.'
            : `This capture has no parseable team-results pages. ${why}`
        );
      }
    } catch (err) {
      toast.push('error', `Could not parse that capture: ${String(err)}`);
      setSelectedCaptureId(null);
    } finally {
      if (mountedRef.current) setIsParsing(false);
    }
  };

  const forgetSelectedCapture = async () => {
    if (!pairingToken || !selectedCapture) return;
    const captureId = selectedCapture.captureId;
    try {
      const res = await fetch(`${CAPTURES_ENDPOINT}/${captureId}`, {
        method: 'DELETE',
        headers: captureAuthHeaders(pairingToken),
      });
      if (!res.ok && res.status !== 404) {
        toast.push('error', `Could not forget that capture (HTTP ${res.status}).`);
        return;
      }
      setConfirmingForget(false);
      setSelectedCaptureId(null);
      setParseResponse(null);
      setSelectedRosterKey(null);
      await loadCaptures(pairingToken);
      toast.push('success', 'Capture forgotten. It can be re-fetched from the extension.');
    } catch (err) {
      toast.push('error', `Could not forget that capture: ${String(err)}`);
    }
  };

  const toggleSection = (id: SectionId) => {
    setExpandedSections(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleGroup = (key: string) => {
    setCheckedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleRosterExpanded = (key: string) => {
    setExpandedRosterKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSwimmerExpanded = (key: string) => {
    setExpandedSwimmerKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const importMeetResults = async () => {
    if (props.mode !== 'meet-results' || !parseResponse) return;
    const chosen = groups.filter(group => checkedGroups[group.key] !== false);
    const selectedParses = chosen.flatMap(group => group.parses);
    if (selectedParses.length === 0) {
      toast.push('error', 'Select at least one team/gender to import.');
      return;
    }
    setIsImporting(true);
    try {
      await props.onImportMeetResults({
        parses: selectedParses,
        // An older capture that predates the event-results pass answers `[]`;
        // a response that omits the field entirely is treated the same way,
        // never as "there were no finals".
        eventResults: parseResponse.eventResults ?? [],
        pageCount: selectedParses.length,
        groups: chosen,
        warnings: parseResponse.warnings,
      });
    } catch (err) {
      toast.push('error', `Could not apply the selected results: ${String(err)}`);
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  const importRoster = async () => {
    if (props.mode !== 'roster-history' || !parseResponse || !selectedRoster) return;
    setIsImporting(true);
    try {
      await props.onImportRoster({
        roster: selectedRoster.roster,
        swimmerTimes: parseResponse.swimmerTimes,
        coverage: selectedRoster.coverage ?? {
          rosterAthleteCount: selectedRoster.roster.athletes.length,
          withCapturedTimes: 0,
          withoutCapturedTimes: selectedRoster.roster.athletes.length,
        },
        genderMismatch: selectedRoster.genderMismatch,
        swimmerTimesPass: capturePassStatus(selectedCapture, 'swimmerTimes'),
      });
    } catch (err) {
      toast.push('error', `Could not import that roster: ${String(err)}`);
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  const hasCaptureRows = captures !== null && captures.length > 0;
  const isLoadingList = tokenError === null && (pairingToken === null || captures === null);

  /* ---------------------------------------------------------------------- */
  /* Section bodies                                                          */
  /* ---------------------------------------------------------------------- */

  const rosterSection = (() => {
    if (!parseResponse) return null;
    const isLead = mode === 'roster-history';
    if (!isLead && parseResponse.rosters.length === 0) return null;

    const count = parseResponse.rosters.length;
    // Each roster's coverage sentence ("0 of 35 athletes have captured times")
    // is true whether or not the crawl planned the swimmer-times pass, but it
    // reads as a gap in the capture. When the pass was definitely never planned
    // it is not a gap, and that decides whether re-crawling would help. An
    // unrecorded scope is left to the status line rather than repeated over
    // every roster — it says nothing this specific.
    const rosterTimesCaveat =
      capturePassStatus(selectedCapture, 'swimmerTimes') === 'not-planned'
        ? describeUnplannedPass(selectedCapture, 'swimmerTimes')
        : null;
    const action =
      isLead && props.mode === 'roster-history' ? (
        <Button
          variant="primary"
          size="sm"
          onClick={() => void importRoster()}
          disabled={isImporting || selectedRoster === null || props.team.trim() === ''}
          aria-label={
            selectedRoster?.genderMismatch
              ? 'Import this roster despite the gender disagreement'
              : 'Import the selected roster'
          }
          title={
            selectedRoster === null
              ? 'Pick a capture, then a roster in it.'
              : `Imports ${selectedRoster.coverage?.withCapturedTimes ?? 0} swimmer(s) now; the other ${
                  selectedRoster.coverage?.withoutCapturedTimes ?? 0
                } stay on the checklist.`
          }
          className="shrink-0"
        >
          {isImporting
            ? 'Importing…'
            : selectedRoster?.genderMismatch
              ? 'Import anyway'
              : 'Import this roster'}
        </Button>
      ) : undefined;

    return (
      <CaptureSection
        id="rosters"
        title={`Rosters in this capture (${count} team${count === 1 ? '' : 's'})`}
        expanded={expandedSections.rosters}
        onToggle={() => toggleSection('rosters')}
        action={action}
      >
        {count > 0 && rosterTimesCaveat !== null ? (
          <p className="text-ui-body text-theme-muted mb-2">{rosterTimesCaveat}</p>
        ) : null}
        {count === 0 ? (
          <p className="text-ui-body text-theme-muted">
            This capture holds no team-roster page, so there is no roster to import.{' '}
            {describeUnplannedPass(selectedCapture, 'teamRoster') ??
              'The clipboard path still works for one swimmer at a time.'}
          </p>
        ) : isLead ? (
          <ul className="space-y-1.5">
            {rosterOptions.map(option => (
              <li key={option.key} className="border border-theme-soft rounded-lg px-3 py-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="swimcloud-capture-roster"
                    className="mt-1"
                    checked={selectedRosterKey === option.key}
                    onChange={() => setSelectedRosterKey(option.key)}
                  />
                  <span className="flex-1">
                    <span className="block text-ui-body text-[var(--text-primary)]">
                      {rosterHeading(option.roster)}
                    </span>
                    <span className="block text-ui-caption text-theme-muted">
                      {option.coverage ? describeRosterCoverage(option.coverage) : ''}
                    </span>
                    {option.genderMismatch && props.mode === 'roster-history' ? (
                      <span className="mt-1 inline-flex items-center gap-1 text-ui-micro badge-warning px-1.5 py-0.5 rounded-full">
                        <AlertTriangle size={11} />
                        This roster is {option.roster.gender}; this importer is scoped to{' '}
                        {props.genderLabel}.
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-1.5">
            {rosterOptions.map(option => {
              const isExpanded = expandedRosterKeys[option.key] === true;
              return (
                <li key={option.key} className="border border-theme-soft rounded-lg">
                  <button
                    type="button"
                    onClick={() => toggleRosterExpanded(option.key)}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Hide' : 'Show'} athletes on ${rosterTeamLabel(option.roster)}`}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-theme-secondary shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-theme-secondary shrink-0" />
                    )}
                    <span className="text-sm text-[var(--text-primary)]">
                      {rosterTeamLabel(option.roster)}
                    </span>
                    <span className="text-ui-caption text-theme-secondary">
                      {option.roster.gender ?? 'unknown gender'} ·{' '}
                      {option.roster.season ?? 'unknown season'} · {option.roster.athletes.length}{' '}
                      athlete{option.roster.athletes.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  {isExpanded ? (
                    <ul className="px-3 pb-2 space-y-1">
                      {option.roster.athletes.map((athlete, athleteIndex) => (
                        <li
                          key={athlete.swimCloudSwimmerId ?? `${option.key}::athlete::${athleteIndex}`}
                          className="text-ui-caption text-theme-secondary flex flex-wrap gap-x-1.5"
                        >
                          <span className="text-[var(--text-primary)]">{athlete.name}</span>
                          {athlete.hometown ? <span>· {athlete.hometown}</span> : null}
                          {athlete.classYear && athlete.classYear !== 'unknown' ? (
                            <span>· {athlete.classYear}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CaptureSection>
    );
  })();

  const swimmerTimesSection = (() => {
    if (!parseResponse) return null;
    const count = parseResponse.swimmerTimes.length;
    // An empty swimmer-times list normally means nothing worth a section, and
    // a capture that merely does not record its scope has already said so on
    // the status line above. A capture that *definitely* declined the pass is
    // different: there, a missing section reads as "there was nothing here",
    // which is the one reading that is wrong. So the section is conjured for
    // 'not-planned' only — a statement, never an uncertainty.
    const unplanned =
      count === 0 && capturePassStatus(selectedCapture, 'swimmerTimes') === 'not-planned'
        ? describeUnplannedPass(selectedCapture, 'swimmerTimes')
        : null;
    if (count === 0 && unplanned === null) return null;
    return (
      <CaptureSection
        id="swimmerTimes"
        title={`Swimmer times in this capture (${count} swimmer${count === 1 ? '' : 's'})`}
        expanded={expandedSections.swimmerTimes || unplanned !== null}
        onToggle={() => toggleSection('swimmerTimes')}
      >
        {unplanned !== null ? <p className="text-ui-body text-theme-muted">{unplanned}</p> : null}
        <ul className="space-y-1.5">
          {parseResponse.swimmerTimes.map(swimmer => {
            const key = swimmer.swimCloudSwimmerId;
            const isExpanded = expandedSwimmerKeys[key] === true;
            return (
              <li key={key} className="border border-theme-soft rounded-lg">
                <button
                  type="button"
                  onClick={() => toggleSwimmerExpanded(key)}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Hide' : 'Show'} personal bests for ${swimmerTimesLabel(swimmer)}`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left"
                >
                  {isExpanded ? (
                    <ChevronDown size={14} className="text-theme-secondary shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-theme-secondary shrink-0" />
                  )}
                  <span
                    className="text-sm text-[var(--text-primary)]"
                    title={
                      swimmer.name
                        ? 'Printed by SwimCloud as "Last, First M" — not reformatted here.'
                        : undefined
                    }
                  >
                    {swimmerTimesLabel(swimmer)}
                  </span>
                  <span className="text-ui-caption text-theme-secondary">
                    {swimmer.personalBests.length} personal best
                    {swimmer.personalBests.length === 1 ? '' : 's'}
                  </span>
                </button>
                {isExpanded ? (
                  <div className="overflow-x-auto px-3 pb-2">
                    <table className="w-full text-ui-caption">
                      <thead>
                        <tr className="text-left text-theme-muted">
                          <th className="py-1 pr-3">Event</th>
                          <th className="py-1 pr-3">Time</th>
                          <th className="py-1 pr-3">Meet</th>
                          <th className="py-1 pr-3">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {swimmer.personalBests.map(pb => (
                          <tr key={pb.swimKey}>
                            <td className="py-1 pr-3 text-[var(--text-primary)]">{pb.eventLabel}</td>
                            <td className="py-1 pr-3 text-theme-secondary tabular-nums">
                              {pb.time ?? pb.rawTimeToken ?? '—'}
                            </td>
                            <td className="py-1 pr-3 text-theme-secondary">{pb.meetName ?? '—'}</td>
                            <td className="py-1 pr-3 text-theme-secondary">{pb.date ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CaptureSection>
    );
  })();

  const meetResultsSection = (() => {
    if (!parseResponse) return null;
    const isLead = mode === 'meet-results';
    if (!isLead && parseResponse.parses.length === 0) return null;

    const action = isLead ? (
      <Button
        variant="primary"
        size="sm"
        onClick={() => void importMeetResults()}
        disabled={isImporting || groups.length === 0}
        aria-label="Import the checked teams and genders"
        className="shrink-0"
      >
        {isImporting ? 'Importing…' : 'Import selected'}
      </Button>
    ) : undefined;

    return (
      <CaptureSection
        id="meetResults"
        title={`Meet results in this capture (${groups.length} team/gender group${groups.length === 1 ? '' : 's'})`}
        expanded={expandedSections.meetResults}
        onToggle={() => toggleSection('meetResults')}
        action={action}
      >
        {groups.length === 0 ? (
          <p className="text-ui-body text-theme-muted">
            Nothing parseable in this capture yet.{' '}
            {describeUnplannedPass(selectedCapture, 'meetTeamSwims') ?? ''}
          </p>
        ) : isLead ? (
          <ul className="space-y-1.5">
            {groups.map(group => (
              <li key={group.key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`swimcloud-capture-group-${group.key}`}
                  checked={checkedGroups[group.key] !== false}
                  onChange={() => toggleGroup(group.key)}
                />
                <label
                  htmlFor={`swimcloud-capture-group-${group.key}`}
                  className="text-sm text-[var(--text-primary)]"
                >
                  {group.label}
                </label>
                <span className="text-ui-caption text-theme-secondary tabular-nums">
                  ({group.rowCount} row{group.rowCount === 1 ? '' : 's'}, {group.parses.length} page
                  {group.parses.length === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-1.5">
            {groups.map(group => (
              <li key={group.key} className="text-ui-caption text-theme-secondary">
                <span className="text-[var(--text-primary)]">{group.label}</span>{' '}
                <span className="tabular-nums">
                  ({group.rowCount} row{group.rowCount === 1 ? '' : 's'}, {group.parses.length} page
                  {group.parses.length === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        )}
      </CaptureSection>
    );
  })();

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  return (
    <FloatingWindow
      title={windowTitle}
      open
      onClose={onClose}
      state={windowState}
      onStateChange={setWindowState}
      minWidth={MIN_WINDOW_WIDTH}
      minHeight={MIN_WINDOW_HEIGHT}
    >
      <div className="h-full overflow-y-auto custom-scrollbar p-4 space-y-3">
        <p className="text-ui-caption text-theme-muted">{description}</p>

        {tokenError !== null ? (
          <p className="text-ui-caption badge-warning px-3 py-2 rounded-lg">{tokenError}</p>
        ) : listError !== null ? (
          <p className="text-ui-caption badge-warning px-3 py-2 rounded-lg">{listError}</p>
        ) : null}

        {tokenError === null ? (
          <div className="flex items-center gap-2">
            <select
              ref={pickerRef}
              aria-label="SwimCloud capture"
              value={selectedCaptureId ?? ''}
              disabled={!hasCaptureRows || isParsing}
              onChange={event => {
                const captureId = event.target.value;
                if (captureId === '') {
                  setSelectedCaptureId(null);
                  setParseResponse(null);
                  setSelectedRosterKey(null);
                  return;
                }
                void selectCapture(captureId);
              }}
              className="glass-input flex-1 min-w-0 px-3 py-2 rounded-lg text-ui-body appearance-none disabled:opacity-40"
            >
              <option value="">
                {isLoadingList ? 'Loading captures…' : hasCaptureRows ? 'Choose a capture…' : 'No captures'}
              </option>
              {captures?.map(capture => {
                const label = captureDisplayLabel(capture);
                const subject = subjectLabel(capture.subject);
                return (
                  <option key={capture.captureId} value={capture.captureId}>
                    {label === subject ? label : `${label} · ${subject}`} · {capturePagesPhrase(capture)}
                  </option>
                );
              })}
            </select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              aria-label="Refresh capture list"
              title="Re-read the local capture store."
              className="p-2 shrink-0"
              leadingIcon={<RefreshCw size={16} />}
            />
            {selectedCapture !== null ? (
              confirmingForget ? (
                <span className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void forgetSelectedCapture()}
                    aria-label={`Confirm forgetting capture ${captureDisplayLabel(selectedCapture)}`}
                    className="px-2 py-1"
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingForget(false)}
                    aria-label="Keep this capture"
                    className="px-2 py-1"
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmingForget(true)}
                  aria-label={`Forget capture ${captureDisplayLabel(selectedCapture)}`}
                  title="Forget this capture (deletes its stored pages). The only way to make a final page re-fetchable."
                  className="p-2 border-transparent bg-transparent shrink-0"
                  leadingIcon={<Trash2 size={16} />}
                />
              )
            ) : null}
          </div>
        ) : null}

        {selectedCapture !== null ? (
          <div className="space-y-1" aria-live="polite">
            <p className="text-ui-caption text-theme-secondary">
              {isParsing ? 'Parsing…' : describeCompleteness(selectedCapture)}
            </p>
            {/* Rendered for every capture, including ones that record no scope.
                `every-planned-page-fetched` above is a claim about a plan, and
                the plan can be narrow — this line is the only thing separating
                a full crawl from a meet-results-only one. */}
            <p className="text-ui-caption text-theme-muted">{describeCaptureScope(selectedCapture)}</p>
            {selectedCapture.completeness === 'partial' ? (
              <span
                className="inline-flex items-center gap-1 text-ui-micro text-theme-muted border border-theme-soft rounded px-1.5 py-0.5 opacity-70"
                title="This capture is incomplete. There is no way to resume a crawl from this panel — reopen the meet in the browser extension and let it continue."
              >
                <AlertTriangle size={11} /> Resume in the extension
              </span>
            ) : null}
            {selectedCapture.notes.length > 0 ? (
              <ul className="text-ui-micro text-theme-muted list-disc pl-4">
                {selectedCapture.notes.map((note, index) => (
                  <li key={`${index}-${note}`}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {tokenError === null && isLoadingList ? (
          <p className="text-ui-body text-theme-muted">Loading captures…</p>
        ) : null}

        {!isLoadingList && !hasCaptureRows ? (
          <div className="space-y-2">
            <p className="text-ui-body text-theme-muted">
              No captures yet. Use the Omniswim SwimCloud Companion browser extension to crawl a meet or
              a team, then come back here.
            </p>
            {pasteFallback ? (
              <div className="space-y-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={pasteFallback.onPaste}
                  aria-label={pasteFallback.label}
                  className="text-[var(--text-accent)] hover:underline"
                  leadingIcon={<ClipboardPaste size={13} />}
                >
                  {pasteFallback.label}
                </Button>
                {pasteFallback.hint !== undefined ? (
                  <p className="text-ui-micro text-theme-muted">{pasteFallback.hint}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {parseResponse !== null ? (
          <div className="space-y-2 border-t border-theme-soft pt-3">
            {rosterSection}
            {swimmerTimesSection}
            {meetResultsSection}
          </div>
        ) : null}
      </div>
    </FloatingWindow>
  );
}
