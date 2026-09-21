/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Omniswim SwimCloud Companion — Track A′ crawl loop.
 *
 * This is the impure half `plans/2026-09-08/03-extension-crawler.md` says
 * cannot be unit-tested without a browser: it touches `fetch()`, the DOM
 * (the injected progress panel), and `chrome.runtime`. It is bundled by
 * `../build.mjs` into `crawler.js`, a classic (non-module) IIFE that
 * `manifest.json` injects into every SwimCloud page alongside the existing
 * `content.js` — the single-page clipboard flow (Track A) stays completely
 * untouched, this is an independent script and button.
 *
 * What IS unit-tested (imported from here, not reimplemented):
 *   - `@omniswim/swimcloud/crawlPlan`  — the pure meet-crawl planner.
 *   - `./crawlRequest.ts`             — step -> fetch request, dedupe, union.
 *   - `./captureResume.ts`            — what a restarted crawl may skip.
 *   - `./crawlErrorPolicy.ts`         — the 403/404/5xx/network-error table.
 *   - `./progress.ts`                 — every string the panel shows.
 *   - `./boundedFetchPool.ts`         — the concurrency/stagger scheduler.
 *   - `./swimmerTimes.ts`             — roster rows -> swimmer ids -> steps.
 *   - `./eventResults.ts`             — swims rows -> event refs -> steps.
 * Everything below is wiring those together with real I/O, per the design
 * doc's "Where the crawl loop actually runs" — this script owns the whole
 * crawl for the lifetime of the tab; the background service worker only
 * relays pages, owns the capture record, and owns the downloads fallback.
 *
 * ## The five passes, and which two are paced differently
 *
 *   1. Page 1 of every team+gender's swims — sequential, 3 s apart.
 *   2. Pages 2..N of those, now that the page counts are known — same pacing.
 *  2b. One `/results/{meetId}/event/{n}/` page per **distinct** event those
 *      lists referenced — **bounded concurrency**,
 *      `EVENT_RESULTS_CONCURRENCY` at a time with an
 *      `EVENT_RESULTS_STAGGER_MS` floor. This is the pass that resolves
 *      prelims from finals; without it the import cannot tell them apart.
 *   3. Every team's two roster pages — sequential 3 s pacing again.
 *   4. One `/swimmer/{id}/times/` page per rostered swimmer — bounded
 *      concurrency, `SWIMMER_TIMES_CONCURRENCY` / `SWIMMER_TIMES_STAGGER_MS`.
 *
 * Passes 2b and 4 are the only relaxations of the design doc's "one at a time,
 * 3 s apart" rule. They use the *same* two constants' values (3 lanes, 400 ms)
 * and never run at once, so the peak in-flight depth this extension reaches is
 * three whichever pass is running. The reasoning, and what it costs, is argued
 * in `./boundedFetchPool.ts` — it is a real change in traffic shape, not a free
 * one.
 *
 * See `plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md` for the checklist a
 * human must run before trusting this against a real SwimCloud page — none
 * of that has been run yet.
 */

import {
  DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID,
  SWIMCLOUD_CRAWL_SCOPES,
  crawlScopeRecordFor,
  passesNewlyPlannedBy,
  planMeetTeamDiscovery,
  planMeetTeamDiscoveryFallback,
  planScopedMeetCrawl,
  swimCloudCrawlScope,
  type SwimCloudCaptureCrawlScope,
  type SwimCloudCrawlGender,
  type SwimCloudCrawlScope,
  type SwimCloudCrawlStep,
} from '@omniswim/swimcloud/crawlPlan';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import {
  parseMeetTeamsHtml,
  parseMeetTopTeamsHtml,
  parseTeamMeetSwimsHtml,
  parseTeamRosterHtml,
} from '@omniswim/swimcloud/parser';
import type { SwimCloudTeamMeetSwimsParse } from '@omniswim/swimcloud/parser';
import type { SwimCloudCaptureSubject, SwimCloudMeetId, SwimCloudTeamId } from '@omniswim/swimcloud/entities';
import { crawlStepToFetchRequest, stepsStillNeeded, unionTeamIds } from './crawlRequest';
import { decideResumeFromRoundTrip, partitionResumableSteps, type SwimCloudResumeDecision } from './captureResume';
import { classifyCrawlPageOutcome } from './crawlErrorPolicy';
import { runBoundedFetchPool } from './boundedFetchPool';
import {
  SWIMMER_TIMES_CONCURRENCY,
  SWIMMER_TIMES_STAGGER_MS,
  classifySwimmerTimesOutcome,
  collectSwimmerIds,
  planSwimmerTimesSteps,
  type SwimCloudRosterAthleteRef,
} from './swimmerTimes';
import {
  EVENT_RESULTS_CONCURRENCY,
  EVENT_RESULTS_STAGGER_MS,
  classifyEventResultsOutcome,
  planEventResultsSteps,
  type SwimCloudSwimEventRef,
} from './eventResults';
import {
  BACKGROUND_ROUND_TRIP_TIMEOUT_MS,
  PAGE_FETCH_TIMEOUT_MS,
  RELAY_ROUND_TRIP_TIMEOUT_MS,
  classifyRelayFailureStreak,
  createFetchDeadline,
  errorText,
  isRoundTripOk,
  roundTripFailureText,
  sendWithTimeout,
  type BackgroundRoundTrip,
} from './backgroundRoundTrip';
import {
  crawlPassLabel,
  formatCrawlScopeNote,
  formatCrawlVolumeFloorLineForScope,
  formatDownloadsFallbackNote,
  formatDownloadsFallbackSummary,
  formatEventResultsLine1,
  formatEventResultsPlanLine,
  formatPage1SweepLine1,
  formatPage1SweepLine2,
  formatPassTwoHeadline,
  formatProgressLine1,
  formatProgressLine2,
  formatResumeDegradationLine,
  formatResumeSkipLine,
  formatRosterSweepLine1,
  formatRosterSweepLine2,
  formatStoredCaptureLine,
  formatSwimmerTimesLine1,
  formatSwimmerTimesLine2,
  formatSwimmerTimesPlanLine,
  genderLabelFor,
  progressFraction,
  type SwimCloudCrawlPage1SweepState,
  type SwimCloudCrawlProgressState,
  type SwimCloudCrawlRosterSweepState,
  type SwimCloudSwimmerTimesProgressState,
} from './progress';

const MIN_DELAY_MS = 3000;
const BUTTON_ID = 'omniswim-swimcloud-crawler-button';
const PANEL_ID = 'omniswim-swimcloud-crawler-panel';

/* -------------------------------------------------------------------------- */
/* Messages exchanged with the background service worker (`./background.ts`)   */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `captureStore.ts`'s `SwimCloudCaptureTeamDiscovery`, field for
 * field. Declared locally for the reason `./captureResume.ts` documents: that
 * module is Node-hosted and cannot be imported into this bundle.
 */
interface SwimCloudCrawlTeamDiscovery {
  readonly source: 'topteams' | 'meet-root-links-fallback';
  /** The gender query values discovery actually used — `'M'`/`'F'`, as the planner writes them. */
  readonly genders: readonly string[];
  readonly teamIds: readonly string[];
  readonly completeness: 'unproven' | 'verified-complete-for-this-capture' | 'user-confirmed';
}

interface RelayPageMessage {
  readonly type: 'omniswim-swimcloud-relay-page';
  readonly subject: SwimCloudCaptureSubject;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly httpStatus?: number;
  readonly html: string;
}

/**
 * Open or update the capture record.
 *
 * Sent more than once per crawl, deliberately. Every field on the route's
 * `POST /api/swimcloud/captures` is a partial update, so a later send that
 * carries a bigger `plannedPageCount` corrects the earlier one instead of
 * fighting it. The first send happens before any team's pages are fetched and
 * can only carry the page-1 floor (team count × 2); the real total is not
 * knowable until every team's page 1 has been read for its pagination, and a
 * capture left claiming the floor would render as "66 of 8 planned pages" in
 * the Matrix picker and make a `'partial'` capture's outstanding-page
 * arithmetic go negative.
 */
interface OpenCaptureMessage {
  readonly type: 'omniswim-swimcloud-open-capture';
  readonly subject: SwimCloudCaptureSubject;
  readonly plannedPageCount: number;
  readonly teamDiscovery?: SwimCloudCrawlTeamDiscovery;
  /**
   * Which passes this crawl committed to.
   *
   * Sent on **every** open-capture message, not only the first, for the same
   * reason `plannedPageCount` is: each is a partial update, and a later message
   * that omitted the scope would leave a record whose page total had moved but
   * whose plan had not been stated. The route unions `plannedPasses` across
   * crawls, so re-sending the same scope is idempotent.
   *
   * Without this field a meet-results capture ends up reporting
   * `'every-planned-page-fetched'` with zero roster pages in it, and nothing
   * downstream can tell that apart from a meet whose teams have no rosters.
   */
  readonly crawlScope?: SwimCloudCaptureCrawlScope;
}

interface MarkCaptureMessage {
  readonly type: 'omniswim-swimcloud-mark-capture';
  readonly subject: SwimCloudCaptureSubject;
  readonly completeness: 'partial' | 'every-planned-page-fetched' | 'failed';
}

/** Ask the local app what it already holds for this subject, so this run can skip it. */
interface ReadCaptureMessage {
  readonly type: 'omniswim-swimcloud-read-capture';
  readonly subject: SwimCloudCaptureSubject;
}

/** The worker's reply to {@link ReadCaptureMessage}. See `./background.ts` for the contract. */
interface ReadCaptureResponse {
  readonly captureId: string;
  readonly available: boolean;
  readonly found: boolean;
  readonly capture?: unknown;
}

/**
 * Ask the worker to combine every buffered `chrome.downloads`-fallback page
 * for this subject into one file and clear its accumulator. Sent exactly
 * once per crawl, from {@link finishCrawl} — never per page. See
 * `./background.ts`'s `flushDownloads` for the accumulator this drains.
 */
interface FlushDownloadsMessage {
  readonly type: 'omniswim-swimcloud-flush-downloads';
  readonly subject: SwimCloudCaptureSubject;
}

/** The worker's reply to {@link FlushDownloadsMessage}. */
interface FlushDownloadsResponse {
  readonly flushed: boolean;
  readonly pageCount: number;
  readonly filename?: string;
  readonly error?: string;
}

type BackgroundMessage =
  | RelayPageMessage
  | OpenCaptureMessage
  | MarkCaptureMessage
  | ReadCaptureMessage
  | FlushDownloadsMessage;

/**
 * The raw `chrome.runtime.sendMessage` promise wrapper.
 *
 * Private on purpose — nothing on the crawl's critical path awaits this
 * directly. It rejects when `chrome.runtime.lastError` is set, but it has no
 * outcome at all for the case that actually froze a live crawl: a background
 * listener that returned `true` and then never called `sendResponse`. That
 * callback never fires, so this promise never settles. Use
 * {@link sendToBackground}, which puts a deadline on it.
 */
function sendMessageRaw<T>(message: BackgroundMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? 'chrome.runtime.sendMessage failed'));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Every message this crawl sends to the background worker, under a deadline.
 *
 * Returns an outcome rather than throwing, because a failed round trip is an
 * ordinary state here (app closed, pairing token never pasted, Manifest V3
 * service worker torn down during the team-confirmation pause) and every call
 * site has a defined thing to do about it. What no call site may do is wait
 * forever.
 */
function sendToBackground<T>(
  message: BackgroundMessage,
  timeoutMs: number = BACKGROUND_ROUND_TRIP_TIMEOUT_MS,
): Promise<BackgroundRoundTrip<T>> {
  return sendWithTimeout<T>(() => sendMessageRaw<T>(message), timeoutMs);
}

/** Sleep, real timers — the content script's own event loop, not `chrome.alarms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchedPage {
  readonly html: string;
  readonly httpStatus: number;
}

class SwimCloudCrawlNetworkError extends Error {}

/**
 * A same-origin `fetch()` against the page's own SwimCloud origin. No
 * `host_permissions` needed.
 *
 * Bounded by an `AbortController`. `fetch` has no timeout of its own, and
 * neither does `response.text()`: a server that accepts the connection and then
 * stalls — exactly what a rate limiter does to a client that has just issued
 * twenty-six requests — leaves both promises pending forever. The crawl loop
 * above has no way to notice that, so the deadline lives here, where the
 * unbounded wait is.
 */
async function fetchPage(url: string): Promise<FetchedPage> {
  const deadline = createFetchDeadline(PAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: 'include', signal: deadline.signal });
    const html = await response.text();
    return { html, httpStatus: response.status };
  } catch (error) {
    if (deadline.expired()) {
      throw new SwimCloudCrawlNetworkError(
        `SwimCloud did not answer within ${Math.round(PAGE_FETCH_TIMEOUT_MS / 1000)}s`,
      );
    }
    throw new SwimCloudCrawlNetworkError(errorText(error));
  } finally {
    deadline.cancel();
  }
}

/* -------------------------------------------------------------------------- */
/* Progress panel — plain DOM, no framework, mirrors content.css's approach.   */
/* -------------------------------------------------------------------------- */

interface PanelHandles {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly line1: HTMLElement;
  readonly line2: HTMLElement;
  /**
   * What this crawl's scope is, and which passes it therefore never plans.
   * Written once, right after the coach confirms, and never overwritten — the
   * progress lines and the resume note both churn every few seconds, and the
   * one sentence explaining why this capture will hold no roster pages has to
   * outlive both of them.
   */
  readonly scopeLine: HTMLElement;
  /** Persistent resume note. Stays visible under the changing progress lines. */
  readonly resumeLine: HTMLElement;
  /**
   * Anything that went wrong but did not stop the crawl: a bookkeeping round
   * trip that timed out, a page the app would not accept. Every one of these
   * used to be invisible, which is what made a degraded crawl look identical to
   * a healthy one — and a stalled one look identical to a slow one.
   */
  readonly warnLine: HTMLElement;
  readonly bar: HTMLElement;
  readonly cancelButton: HTMLButtonElement;
  readonly pauseButton: HTMLButtonElement;
  readonly retryButton: HTMLButtonElement;
  /** Shown only during the pre-flight pairing gate — see `awaitPairingConfirmation`. */
  readonly continueAnywayButton: HTMLButtonElement;
}

function createPanel(subjectTitle: string): PanelHandles {
  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = PANEL_ID;

  const title = document.createElement('div');
  title.className = 'omniswim-crawler-panel__title';
  title.textContent = subjectTitle;

  const line1 = document.createElement('div');
  line1.className = 'omniswim-crawler-panel__line';
  const line2 = document.createElement('div');
  line2.className = 'omniswim-crawler-panel__line';

  const scopeLine = document.createElement('div');
  scopeLine.className = 'omniswim-crawler-panel__line omniswim-crawler-panel__resume';
  scopeLine.hidden = true;

  const resumeLine = document.createElement('div');
  resumeLine.className = 'omniswim-crawler-panel__line omniswim-crawler-panel__resume';
  resumeLine.hidden = true;

  const warnLine = document.createElement('div');
  warnLine.className = 'omniswim-crawler-panel__line omniswim-crawler-panel__warn';
  warnLine.hidden = true;

  const barTrack = document.createElement('div');
  barTrack.className = 'omniswim-crawler-panel__bar-track';
  const bar = document.createElement('div');
  bar.className = 'omniswim-crawler-panel__bar-fill';
  barTrack.appendChild(bar);

  const buttons = document.createElement('div');
  buttons.className = 'omniswim-crawler-panel__buttons';

  const pauseButton = document.createElement('button');
  pauseButton.type = 'button';
  pauseButton.textContent = 'Pause';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';

  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = 'Retry';
  retryButton.hidden = true;

  const continueAnywayButton = document.createElement('button');
  continueAnywayButton.type = 'button';
  continueAnywayButton.textContent = 'Continue anyway (save to Downloads)';
  continueAnywayButton.hidden = true;

  buttons.append(pauseButton, cancelButton, retryButton, continueAnywayButton);
  root.append(title, line1, line2, scopeLine, resumeLine, warnLine, barTrack, buttons);
  document.body.appendChild(root);

  return {
    root,
    title,
    line1,
    line2,
    scopeLine,
    resumeLine,
    warnLine,
    bar,
    cancelButton,
    pauseButton,
    retryButton,
    continueAnywayButton,
  };
}

function renderProgress(panel: PanelHandles, state: SwimCloudCrawlProgressState): void {
  panel.line1.textContent = formatProgressLine1(state);
  panel.line2.textContent = formatProgressLine2(state);
  renderBar(panel, state.pagesDone, state.pagesTotal);
}

/** Pass 1's own two lines and its own denominator — see `progress.ts` on why it has one. */
function renderPage1Sweep(panel: PanelHandles, state: SwimCloudCrawlPage1SweepState): void {
  panel.line1.textContent = formatPage1SweepLine1(state);
  panel.line2.textContent = formatPage1SweepLine2(state);
  renderBar(panel, state.pagesDone, state.pagesTotal);
}

/** Pass 3 (rosters). Its own denominator again — `teamCount × 2`. */
function renderRosterSweep(panel: PanelHandles, state: SwimCloudCrawlRosterSweepState): void {
  panel.line1.textContent = formatRosterSweepLine1(state);
  panel.line2.textContent = formatRosterSweepLine2(state);
  renderBar(panel, state.pagesDone, state.pagesTotal);
}

/** Pass 4 (swimmer times). One of the two passes whose fetches overlap. */
function renderSwimmerTimes(panel: PanelHandles, state: SwimCloudSwimmerTimesProgressState): void {
  panel.line1.textContent = formatSwimmerTimesLine1(state);
  panel.line2.textContent = formatSwimmerTimesLine2(state);
  renderBar(panel, state.alreadyCaptured + state.fetched, state.total);
}

/** Pass 2b (per-event results). Same pooled shape as pass 4, same pacing line. */
function renderEventResults(panel: PanelHandles, state: SwimCloudSwimmerTimesProgressState): void {
  panel.line1.textContent = formatEventResultsLine1(state);
  panel.line2.textContent = formatSwimmerTimesLine2(state);
  renderBar(panel, state.alreadyCaptured + state.fetched, state.total);
}

function renderBar(panel: PanelHandles, pagesDone: number, pagesTotal: number): void {
  panel.bar.style.width = `${Math.round(progressFraction(pagesDone, pagesTotal) * 100)}%`;
}

function renderMessage(panel: PanelHandles, message: string): void {
  panel.line1.textContent = message;
  panel.line2.textContent = '';
}

/**
 * Show the crawl-scope sentence. Written once per crawl; nothing else touches
 * this row, so a narrowed crawl keeps saying it is narrowed for the whole run.
 */
function renderScopeNote(panel: PanelHandles, message: string): void {
  panel.scopeLine.textContent = message;
  panel.scopeLine.hidden = message.length === 0;
}

/** Show (or clear) the persistent resume note. An empty string hides the row entirely. */
function renderResumeNote(panel: PanelHandles, message: string): void {
  panel.resumeLine.textContent = message;
  panel.resumeLine.hidden = message.length === 0;
}

/** Show (or clear) the warning row. An empty string hides it entirely. */
function renderWarning(panel: PanelHandles, message: string): void {
  panel.warnLine.textContent = message;
  panel.warnLine.hidden = message.length === 0;
}

/**
 * A crawl that died on an unexpected error, said out loud.
 *
 * `runCrawl` used to be started with a bare `void`, so any rejection inside it
 * — including the message round trips that had no error handling of their own —
 * became an unhandled promise rejection in the page's console and nothing at
 * all on the panel. The panel simply stopped changing, which is exactly what a
 * hang looks like.
 */
function renderCrawlFailure(panel: PanelHandles, error: unknown): void {
  renderMessage(panel, `The crawl stopped on an unexpected error: ${errorText(error)}`);
  renderWarning(panel, 'Nothing already captured is lost. Retry restarts from team discovery and skips stored pages.');
  panel.retryButton.hidden = false;
}

/* -------------------------------------------------------------------------- */
/* Resume — what the local store already holds                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ask the background worker for this subject's stored capture and turn it into
 * the set of canonical URLs that already have real bytes on disk.
 *
 * Reachable before anything is fetched: a meet subject's capture id is fully
 * determined by the meet id in the page URL, so this needs no team discovery.
 *
 * Every failure path — not paired, app not running, worker asleep, round trip
 * timed out, unreadable reply — yields an empty set, which plans every page.
 * That is slower and correct. The opposite default (assume stored, skip) would
 * drop pages from a capture on the strength of a reply this script could not
 * read. The decision itself is pure and unit-tested; this function only does
 * the round trip and the rendering.
 *
 * The deadline is the load-bearing part. This is the crawl's very first message
 * to the background worker, so it is also the first place a worker that cannot
 * answer would have stranded the whole run before a single request went out.
 */
async function readAlreadyCaptured(
  panel: PanelHandles,
  subject: SwimCloudCaptureSubject,
): Promise<SwimCloudResumeDecision> {
  const trip = await sendToBackground<ReadCaptureResponse>({
    type: 'omniswim-swimcloud-read-capture',
    subject,
  });
  const decision: SwimCloudResumeDecision = decideResumeFromRoundTrip(
    trip.kind === 'ok'
      ? { kind: 'ok', response: trip.value }
      : trip.kind === 'timeout'
        ? { kind: 'timeout' }
        : { kind: 'error', message: trip.message },
  );

  renderWarning(panel, formatResumeDegradationLine(decision.degradation));
  if (decision.alreadyCaptured.size > 0) {
    renderResumeNote(panel, formatStoredCaptureLine(decision.alreadyCaptured.size));
  }
  return decision;
}

/**
 * The pre-flight gate this crawl never had before 2026-09-09.
 *
 * `readAlreadyCaptured`'s round trip is already the crawl's very first
 * message to the background worker — the same round trip that, on a healthy
 * connection, tells this run what is already stored. `degradation ===
 * 'app-unreachable'` is exactly the "not paired, or the app isn't running"
 * case, and it is knowable before a single SwimCloud page is fetched. Letting
 * the crawl run anyway used to mean discovering the problem only after every
 * one of 200+ pages had silently fallen back to `chrome.downloads` — a real
 * 234-page crawl did exactly that, with zero warning anywhere on the panel,
 * because `formatResumeDegradationLine` had no case for `'app-unreachable'`
 * either (fixed in the same pass as this gate).
 *
 * A coach gets an actual choice here: fix the pairing and retry (cheapest),
 * or explicitly accept the Downloads-only run (now batched into one file at
 * the end, not 200+ separate ones — see `finishCrawl`). Silence is never one
 * of the options.
 */
async function awaitPairingConfirmation(
  panel: PanelHandles,
  control: CrawlControl,
  decision: SwimCloudResumeDecision,
): Promise<'proceed' | 'cancelled'> {
  if (decision.degradation !== 'app-unreachable') return 'proceed';

  renderMessage(panel, 'Not connected to the Omniswim app.');
  renderWarning(panel, formatResumeDegradationLine('app-unreachable'));
  panel.continueAnywayButton.hidden = false;

  return new Promise((resolve) => {
    const cleanup = () => {
      panel.continueAnywayButton.hidden = true;
      panel.continueAnywayButton.removeEventListener('click', onContinue);
      panel.cancelButton.removeEventListener('click', onCancel);
    };
    const onContinue = () => {
      cleanup();
      renderWarning(panel, formatResumeDegradationLine('app-unreachable'));
      resolve('proceed');
    };
    const onCancel = () => {
      control.cancelled = true;
      cleanup();
      resolve('cancelled');
    };
    panel.continueAnywayButton.addEventListener('click', onContinue);
    panel.cancelButton.addEventListener('click', onCancel);
  });
}

/* -------------------------------------------------------------------------- */
/* Team discovery                                                             */
/* -------------------------------------------------------------------------- */

interface TeamDiscoveryOutcome {
  readonly teamIds: readonly SwimCloudTeamId[];
  readonly source: 'topteams' | 'meet-root-links-fallback';
  /**
   * The gender query values whose page actually parsed into a team list —
   * `'M'`/`'F'` verbatim from `crawlPlan.ts`, never mapped to `'Men'`/
   * `'Women'`. Recording only the genders that really contributed is what lets
   * the Matrix picker say "this team list came from the men's page only"
   * rather than implying both were read.
   */
  readonly genders: readonly string[];
}

/**
 * Fetch and parse the two `topteams` pages (both genders); fall back to the
 * meet-root pages only if that fails outright — exactly the two-step
 * sequence in the design doc's "Request sequencing" §1-2. Only the
 * structural read (team links) is used, never the score column, per the
 * "take every team row regardless of score" rule.
 */
async function discoverTeams(meetId: SwimCloudMeetId, retrievedAt: () => string): Promise<TeamDiscoveryOutcome> {
  const primarySteps = planMeetTeamDiscovery(meetId);
  const primaryByGender: Array<{ gender: string; teamIds: string[] }> = [];
  let primaryFailed = false;

  for (const step of primarySteps) {
    const { url } = crawlStepToFetchRequest(step);
    const page = await fetchPageWithDelay(url);
    if (page === undefined || page.httpStatus >= 400) {
      primaryFailed = true;
      break;
    }
    const parsed = parseMeetTopTeamsHtml(page.html, {
      sourceUrl: url,
      retrievedAt: retrievedAt(),
      track: 'browser-extension',
    });
    if (!parsed.ok) {
      primaryFailed = true;
      break;
    }
    primaryByGender.push({
      gender: step.gender ?? '',
      teamIds: parsed.data.teams.map((t) => t.swimCloudTeamId),
    });
  }

  if (!primaryFailed && primaryByGender.length === primarySteps.length) {
    return {
      teamIds: unionTeamIds(primaryByGender[0]?.teamIds ?? [], primaryByGender[1]?.teamIds ?? []),
      source: 'topteams',
      genders: primaryByGender.map((g) => g.gender).filter((g) => g.length > 0),
    };
  }

  // Fallback: meet-root pages, unioned. Per the design doc this is
  // defense-in-depth only — a malformed page here marks that branch
  // 'partial' rather than aborting the whole crawl.
  const fallbackSteps = planMeetTeamDiscoveryFallback(meetId);
  const fallbackByGender: Array<{ gender: string; teamIds: string[] }> = [];
  for (const step of fallbackSteps) {
    const { url } = crawlStepToFetchRequest(step);
    const page = await fetchPageWithDelay(url);
    if (page === undefined || page.httpStatus >= 400) continue;
    const parsed = parseMeetTeamsHtml(page.html, {
      sourceUrl: url,
      retrievedAt: retrievedAt(),
      track: 'browser-extension',
    });
    if (!parsed.ok) continue;
    fallbackByGender.push({
      gender: step.gender ?? '',
      teamIds: parsed.data.teams.map((t) => t.swimCloudTeamId),
    });
  }
  return {
    teamIds: unionTeamIds(fallbackByGender[0]?.teamIds ?? [], fallbackByGender[1]?.teamIds ?? []),
    source: 'meet-root-links-fallback',
    genders: fallbackByGender.map((g) => g.gender).filter((g) => g.length > 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Crawl loop                                                                  */
/* -------------------------------------------------------------------------- */

interface CrawlControl {
  cancelled: boolean;
  paused: boolean;
}

/**
 * How the hand-off of fetched pages to the background worker is going.
 *
 * Counted, not just logged. One failed relay is worth a line on the panel and
 * nothing more — the page is gone, the other sixty are not. A streak means the
 * worker or the app is unreachable and every remaining page will be lost the
 * same way, so the crawl stops rather than spending more of SwimCloud's
 * patience on requests whose results go nowhere.
 */
interface RelayState {
  consecutiveFailures: number;
  totalFailures: number;
  /**
   * Pages that landed via `chrome.downloads` instead of the app — a real save,
   * not a failure, but a genuinely different outcome a coach needs visible
   * live, not just in a final summary. Before 2026-09-09 this was never
   * tracked at all: `relayFetchedPage` treated `{ relayed: true, via:
   * 'downloads' }` identically to `{ relayed: true, via: 'http' }`, so a
   * crawl where every single page silently fell back — 234 pages, one real
   * report — finished reporting zero failures and showing no warning of any
   * kind. See that function's own doc comment.
   */
  downloadsFallbackCount: number;
}

let lastFetchAtMs: number | undefined;

/** Enforces the 3s politeness delay across every fetch this loop issues, same discipline as `SwimCloudPoliteFetcher`. */
async function fetchPageWithDelay(url: string): Promise<FetchedPage | undefined> {
  const now = Date.now();
  if (lastFetchAtMs !== undefined) {
    const elapsed = now - lastFetchAtMs;
    if (elapsed < MIN_DELAY_MS) {
      await sleep(MIN_DELAY_MS - elapsed);
    }
  }
  lastFetchAtMs = Date.now();
  try {
    return await fetchPage(url);
  } catch {
    return undefined;
  }
}

/**
 * One swimmer-times fetch, issued from the bounded pool.
 *
 * **Deliberately does not take the 3 s gate above.** The pool has its own
 * pacing — a concurrency cap and a start stagger, both documented in
 * `./boundedFetchPool.ts` and `./swimmerTimes.ts` — and running these through
 * `fetchPageWithDelay` would serialise them at 3 s apart, which is the whole
 * thing this pass exists to avoid.
 *
 * It is **only** for `/swimmer/{id}/times/` pages. Team-swims, roster and
 * team-discovery pages carry the meet's actual results and keep the sequential
 * pacing that `plans/2026-09-08/03-extension-crawler.md` says not to lower.
 * `lastFetchAtMs` is still stamped, so a sequential fetch that follows the pool
 * (a Retry, say) still honours its own gap rather than starting on top of a
 * request the pool just issued.
 *
 * Timeout-bounded like every other fetch, through `fetchPage`'s
 * `createFetchDeadline`: a stalled swimmer page must not hold a lane forever.
 */
async function fetchPageForPool(url: string): Promise<FetchedPage | undefined> {
  lastFetchAtMs = Date.now();
  try {
    return await fetchPage(url);
  } catch {
    return undefined;
  }
}

/**
 * What a pass this crawl's scope declined contributes to the totals: nothing
 * fetched, nothing planned, and **not** a partial capture.
 *
 * `'every-planned-page-fetched'` is the honest completeness for a declined
 * pass, because completeness is a claim about the plan and this pass was never
 * in it. Reporting `'partial'` instead would mark every narrowed capture as
 * broken; reporting a non-zero `total` would make the panel promise pages that
 * were never going to be fetched. The thing that keeps this honest downstream
 * is the capture's recorded `crawlScope`, not this value.
 */
const PASS_NOT_IN_SCOPE_EVENT_RESULTS: EventResultsPassResult = {
  total: 0,
  done: 0,
  stoppedMessage: '',
  stopped: false,
};

/** The same, for pass 4. See {@link PASS_NOT_IN_SCOPE_EVENT_RESULTS}. */
const PASS_NOT_IN_SCOPE_SWIMMER_TIMES: SwimmerTimesPassResult = {
  total: 0,
  done: 0,
  completeness: 'every-planned-page-fetched',
  stoppedMessage: '',
};

async function runCrawl(meetId: SwimCloudMeetId, panel: PanelHandles, control: CrawlControl): Promise<void> {
  const subject: SwimCloudCaptureSubject = { kind: 'meet', meetId };
  const retrievedAt = () => new Date().toISOString();

  // Before anything is fetched: what does the local store already hold? A
  // restarted or retried crawl must not re-request pages SwimCloud has already
  // served once.
  renderMessage(panel, 'Checking what is already captured…');
  const resumeDecision = await readAlreadyCaptured(panel, subject);
  const alreadyCaptured = resumeDecision.alreadyCaptured;

  if ((await awaitPairingConfirmation(panel, control, resumeDecision)) === 'cancelled') {
    renderMessage(panel, 'Cancelled before fetching started.');
    return;
  }

  renderMessage(panel, 'Discovering teams…');
  const discovery = await discoverTeams(meetId, retrievedAt);
  if (discovery.teamIds.length === 0) {
    renderMessage(panel, 'Could not discover any teams for this meet. Nothing to crawl.');
    return;
  }

  const confirmation = await confirmTeamList(panel, discovery.teamIds, resumeDecision.storedScope);
  if (confirmation === undefined) {
    renderMessage(panel, 'Cancelled before fetching started.');
    return;
  }
  const confirmedTeamIds = confirmation.teamIds;
  const scope = confirmation.scope;
  // Posted on every open-capture message from here on. The route unions
  // `plannedPasses` across crawls, so a capture that was narrowed once and
  // widened later reports the union — the only statement about the stored
  // pages that is true.
  const crawlScope = crawlScopeRecordFor(scope);

  // `'user-confirmed'` is the honest value the moment the coach clicks through
  // the checklist above: a human looked at this exact team list and accepted
  // it. That is a stronger claim than `'unproven'` (nobody checked) and a
  // weaker one than `'verified-complete-for-this-capture'` (which would assert
  // something about SwimCloud's field that neither the topteams page nor the
  // truncating meet-root card can prove).
  const teamDiscovery: SwimCloudCrawlTeamDiscovery = {
    source: discovery.source,
    genders: discovery.genders,
    teamIds: confirmedTeamIds,
    completeness: 'user-confirmed',
  };

  // The whole up-front plan, in one gated value. Every pass this scope declined
  // arrives as an empty step array or a false flag, so a declined pass costs no
  // request and cannot be re-planned further down by a second branch that
  // forgot about the scope.
  //
  // Step 1 of the paged fetch is `swimsSteps`: page 1 of every team+gender, to
  // learn each one's total page count before committing to the full plan.
  const structural = planScopedMeetCrawl({ meetId, teamIds: confirmedTeamIds, scope });
  const page1Steps = structural.swimsSteps;
  // Planned up front, fetched in pass 3. Its size is known now (`teamCount × 2`,
  // or zero when the scope declines rosters), which is why the very first
  // `plannedPageCount` can include it — a capture record whose planned total
  // climbs as passes are discovered is fine, but one that ends up below the
  // pages actually filed against it is not.
  const rosterSteps = structural.rosterSteps;
  renderScopeNote(panel, formatCrawlScopeNote(scope));
  const fetchedUrls = new Set<string>();
  const knownTotalPages: Record<string, number> = {};
  // Every swims-list page read this run, reduced to just its event references —
  // pass 2b's input. Accumulated as the pages arrive rather than re-read after,
  // because the content script never sees the app's stored bytes.
  const swimsEventRefs: SwimCloudSwimEventRef[][] = [];
  const relay: RelayState = { consecutiveFailures: 0, totalFailures: 0, downloadsFallbackCount: 0 };

  // This is the first thing that happens after the coach clicks Start crawl, so
  // it is also the first thing they must see happen. Without this line the
  // panel kept showing the confirmation prompt while it waited on a round trip
  // that had no deadline — a stalled worker and a slow one looked identical,
  // and both looked like the crawl had simply stopped.
  renderMessage(panel, 'Opening the capture record in the Omniswim app…');
  const opened = await sendToBackground({
    type: 'omniswim-swimcloud-open-capture',
    subject,
    plannedPageCount: page1Steps.length + rosterSteps.length,
    teamDiscovery,
    crawlScope,
  });
  if (!isRoundTripOk(opened)) {
    // The crawl continues. Pages whose capture record was never opened are
    // rejected by the app's pages route (404, "open it first") and land in the
    // chrome.downloads fallback instead, so nothing fetched is lost — but that
    // is a very different afternoon for the coach, and it must not be silent.
    renderWarning(
      panel,
      `${roundTripFailureText('Opening the capture record', opened)} Fetched pages will be saved to your downloads folder instead.`,
    );
  }

  // Page 1 is fetched even when the store already holds it. Only a fresh page
  // 1 carries the pagination widget that says how many pages this team+gender
  // has; the stored page refs give the pages a previous run *got to*, which is
  // a floor and never the total. Planning against that floor would silently
  // drop every page past it — the exact class of quiet, plausible wrongness
  // `CLAUDE.md` forbids. The bulk of the crawl (pages 2..N) is where the
  // resume saving actually lives, and that is applied below.
  for (const step of page1Steps) {
    if (control.cancelled) {
      await finishCrawl(panel, subject, 'partial', relay);
      return;
    }
    await waitWhilePaused(control);

    renderPage1Sweep(panel, page1SweepStateFor(step, confirmedTeamIds, fetchedUrls.size, page1Steps.length));

    const { url } = crawlStepToFetchRequest(step);
    const page = await fetchPageWithDelay(url);
    fetchedUrls.add(url);
    renderPage1Sweep(panel, page1SweepStateFor(step, confirmedTeamIds, fetchedUrls.size, page1Steps.length));

    const outcomeAction = await handleFetchedPage(panel, subject, url, page, retrievedAt(), relay);
    if (outcomeAction === 'stop') {
      return;
    }
    if (page !== undefined && page.httpStatus < 400 && step.gender !== undefined && step.teamId !== undefined) {
      const parsed = parseTeamMeetSwimsHtml(page.html, {
        sourceUrl: url,
        retrievedAt: retrievedAt(),
        track: 'browser-extension',
      });
      const totalPages = parsed.ok ? parsed.data.pagination?.totalPages ?? 1 : 1;
      knownTotalPages[`${step.teamId}:${step.gender}`] = totalPages;
      if (parsed.ok) swimsEventRefs.push(eventRefsOf(parsed.data));
    }
  }

  // Step 2: the full plan, now that every team+gender's page count is known.
  // Through the same scope gate as step 1, so a scope that declined the swims
  // pass cannot acquire one here.
  const fullSteps = planScopedMeetCrawl({
    meetId,
    teamIds: confirmedTeamIds,
    scope,
    knownTotalPages,
  }).swimsSteps;
  const pagesTotal = fullSteps.length;

  // The corrected total, sent before the bulk fetch rather than after it, so
  // the panel's bar and a Matrix picker open in another window both see the
  // real denominator while the crawl is still running.
  if (pagesTotal > 0) renderMessage(panel, formatPassTwoHeadline(fetchedUrls.size, pagesTotal));
  const corrected = await sendToBackground({
    type: 'omniswim-swimcloud-open-capture',
    subject,
    plannedPageCount: pagesTotal + rosterSteps.length,
    teamDiscovery,
    crawlScope,
  });
  if (!isRoundTripOk(corrected)) {
    renderWarning(
      panel,
      `${roundTripFailureText('Correcting the planned page count', corrected)} The crawl continues; the app may show a stale page total.`,
    );
  }

  const thisRunRemaining = stepsStillNeeded(fullSteps, fetchedUrls);
  const resume = partitionResumableSteps(thisRunRemaining, alreadyCaptured);
  if (pagesTotal > 0) {
    renderResumeNote(
      panel,
      formatResumeSkipLine({
        skippedPages: resume.alreadyCaptured.length,
        pagesTotal,
        storedPageCount: alreadyCaptured.size,
      }),
    );
  }

  // A skipped page is still a page of this crawl: it counts toward progress
  // and it is named on the panel. A crawl that quietly fetched a handful of
  // pages and reported "done" would be indistinguishable from a broken one.
  let pagesDone = fetchedUrls.size + resume.alreadyCaptured.length;

  for (const step of resume.toFetch) {
    if (control.cancelled) {
      await finishCrawl(panel, subject, 'partial', relay);
      return;
    }
    await waitWhilePaused(control);

    const { url } = crawlStepToFetchRequest(step);
    const page = await fetchPageWithDelay(url);

    renderProgress(panel, progressStateFor(step, confirmedTeamIds, pagesDone, pagesTotal, knownTotalPages));
    const outcomeAction = await handleFetchedPage(panel, subject, url, page, retrievedAt(), relay);
    if (outcomeAction === 'stop') {
      return;
    }
    // Parsed for its event references only — pass 2b's input. The page's bytes
    // are already relayed and are what the app parses for real; this is the
    // content script learning which event pages exist, which no URL can say.
    if (page !== undefined && page.httpStatus < 400) {
      const parsed = parseTeamMeetSwimsHtml(page.html, {
        sourceUrl: url,
        retrievedAt: retrievedAt(),
        track: 'browser-extension',
      });
      if (parsed.ok) swimsEventRefs.push(eventRefsOf(parsed.data));
    }
    pagesDone += 1;
    renderProgress(panel, progressStateFor(step, confirmedTeamIds, pagesDone, pagesTotal, knownTotalPages));
  }

  // Pass 2b: per-event results — the round labels and the real meet Score. Runs
  // before the rosters because its input is complete now and what it fetches
  // finishes the meet results; see `runEventResultsPass`.
  const eventPagesDone = structural.plansEventResults
    ? await runEventResultsPass({
        meetId,
        // Refs gathered this run, plus the ones the app derived from swims
        // pages it already holds. Without the second half, a re-crawl of a
        // complete capture gathers nothing -- resume skips every swims page, so
        // none is parsed here -- and this pass plans zero pages, leaving every
        // prelims/finals pair unresolved while the crawl reports success.
        // Deduplicated downstream by planEventResultsSteps.
        swimsPages: [
          ...swimsEventRefs,
          resumeDecision.storedEventRefs.map((eventRef: string) => ({ event: { eventRef } })),
        ],
        swimsPagesResumeSkipped: resume.alreadyCaptured.length,
        alreadyCaptured,
        plannedBeforeThisPass: pagesTotal + rosterSteps.length,
        subject,
        teamDiscovery,
        crawlScope,
        panel,
        retrievedAt,
        relay,
        control,
      })
    : PASS_NOT_IN_SCOPE_EVENT_RESULTS;
  if (control.cancelled) {
    await finishCrawl(panel, subject, 'partial', relay);
    return;
  }

  // Pass 3: rosters. Same sequential 3 s pacing as the swims passes — nothing
  // about this pass is relaxed. Its second job is that each parsed roster names
  // the swimmers whose times pages pass 4 fetches.
  const rosterAthletes = await runRosterPass(rosterSteps, confirmedTeamIds, panel, subject, retrievedAt, relay, control);
  if (rosterAthletes === undefined) return;

  // Pass 4: swimmer times. The other pass that overlaps its fetches.
  const swimmerPagesDone = structural.plansSwimmerTimes
    ? await runSwimmerTimesPass({
        meetId,
        rosters: rosterAthletes,
        alreadyCaptured,
        plannedBeforeThisPass: pagesTotal + rosterSteps.length + eventPagesDone.total,
        subject,
        teamDiscovery,
        crawlScope,
        panel,
        retrievedAt,
        relay,
        control,
      })
    : PASS_NOT_IN_SCOPE_SWIMMER_TIMES;

  const totalPlanned = pagesTotal + rosterSteps.length + eventPagesDone.total + swimmerPagesDone.total;
  const totalDone = pagesDone + rosterSteps.length + eventPagesDone.done + swimmerPagesDone.done;
  // A pass 2b that ended early makes the whole capture partial, the same way a
  // short swimmer-times pass does: the pages it did not fetch are pages the
  // capture was planned to hold.
  const completeness =
    swimmerPagesDone.completeness === 'partial' || eventPagesDone.stopped
      ? 'partial'
      : 'every-planned-page-fetched';

  await finishCrawl(panel, subject, completeness, relay);
  // The count goes on line 2 rather than being folded into line 1, so a pass
  // that ended early keeps its reason as the headline. A crawl that stopped
  // must never read as "Done".
  const stoppedMessage =
    swimmerPagesDone.stoppedMessage.length > 0
      ? swimmerPagesDone.stoppedMessage
      : eventPagesDone.stoppedMessage;
  if (stoppedMessage.length > 0) {
    renderMessage(panel, stoppedMessage);
    panel.line2.textContent = `${totalDone} of ${totalPlanned} pages captured before stopping.`;
  } else if (completeness === 'partial') {
    renderMessage(panel, `Stopped — ${totalDone} of ${totalPlanned} pages captured.`);
  } else {
    renderMessage(panel, `Done — ${totalDone} of ${totalPlanned} pages captured.`);
  }
}

/**
 * One swims-list parse reduced to just what pass 2b needs: the `/event/{n}/`
 * reference each row's time link carried.
 *
 * Reduced rather than held whole because a full-field crawl reads thousands of
 * swims and the pass needs one string from each. `event.eventRef` is absent
 * when the row carried no time link at all; that absence is passed through, and
 * `collectEventRefs` counts it rather than inventing a reference.
 */
function eventRefsOf(parse: SwimCloudTeamMeetSwimsParse): SwimCloudSwimEventRef[] {
  return parse.swims.map((swim) => ({
    event: swim.event.eventRef === undefined ? {} : { eventRef: swim.event.eventRef },
  }));
}

/* -------------------------------------------------------------------------- */
/* Pass 2b — per-event results, the second bounded pool                        */
/* -------------------------------------------------------------------------- */

interface EventResultsPassInput {
  /** Recorded on every planned step; an event-results URL is meet-scoped already. */
  readonly meetId: SwimCloudMeetId;
  /**
   * The event references every swims-list page read **this run** carried, one
   * array per page. See {@link runEventResultsPass} on what a resumed crawl
   * does and does not see here.
   */
  readonly swimsPages: readonly (readonly SwimCloudSwimEventRef[])[];
  /** How many swims-list pages this run skipped because the store already held them. */
  readonly swimsPagesResumeSkipped: number;
  readonly alreadyCaptured: ReadonlySet<string>;
  /** Pages the plan already committed to before this pass, so the corrected total is additive. */
  readonly plannedBeforeThisPass: number;
  readonly subject: SwimCloudCaptureSubject;
  readonly teamDiscovery: SwimCloudCrawlTeamDiscovery;
  /** Re-sent with this pass's corrected page total; see {@link OpenCaptureMessage.crawlScope}. */
  readonly crawlScope: SwimCloudCaptureCrawlScope;
  readonly panel: PanelHandles;
  readonly retrievedAt: () => string;
  readonly relay: RelayState;
  readonly control: CrawlControl;
}

interface EventResultsPassResult {
  /** Event pages planned, including ones a previous crawl already stored. */
  readonly total: number;
  /** Pages this run fetched plus pages skipped as already captured. */
  readonly done: number;
  /** Non-empty when the pass ended early; shown verbatim on the panel. */
  readonly stoppedMessage: string;
  /** True when the pass ended on a cancel or a stop, so the caller does not report "Done". */
  readonly stopped: boolean;
}

/**
 * Fetch one `/results/{meetId}/event/{n}/` page per **distinct** event the
 * meet's swims lists referenced, through the bounded pool.
 *
 * ## Why this pass exists at all
 *
 * The swims lists this crawl has just finished fetching carry no round column.
 * Without this pass, a swimmer who made finals imports as two indistinguishable
 * rows and the app excludes both rather than scoring one twice — visible, but
 * missing points. These pages carry the round captions and the real meet
 * `Score`, and they are what turns that exclusion into a correct score. See
 * `packages/matrix/src/lib/swimCloudMeetImportBridge.ts`.
 *
 * ## Why it runs here, before the rosters
 *
 * Its input is complete at exactly this point — every swims-list page has been
 * read — and what it fetches finishes the *meet results*, which is the
 * capture's primary product. Rosters and swimmer histories are enrichment. A
 * crawl a coach cancels halfway should have the scoring data, not the
 * enrichment.
 *
 * ## What a resumed crawl sees, and what it does not
 *
 * Event references come from swims-list pages **read in this run**. A resumed
 * crawl skips the pages the store already holds, so their references are not in
 * this run's memory and their event pages are not planned. That is stated on
 * the panel rather than hidden, and it degrades safely: an event page that was
 * never fetched simply leaves those swims unresolved, and the import excludes
 * them with a named reason — exactly the behaviour that existed before this
 * pass. It never produces a wrong round.
 *
 * Re-reading every swims page to close that gap is not the same trade
 * {@link runRosterPass} takes. A roster pass is `teamCount × 2` pages; a swims
 * pass is that many times the page count of every team, and at 3 s a page a
 * resumed crawl would pay for the whole original crawl again.
 */
async function runEventResultsPass(input: EventResultsPassInput): Promise<EventResultsPassResult> {
  const { panel, subject, relay, control } = input;

  const plan = planEventResultsSteps(input.meetId, input.swimsPages);
  const partition = partitionResumableSteps(plan.steps, input.alreadyCaptured);
  if (plan.steps.length === 0) {
    renderResumeNote(
      panel,
      'No swim on this meet\'s lists carried an event link, so no per-event results pages were planned. Prelims and finals cannot be told apart in this capture.',
    );
    return { total: 0, done: 0, stoppedMessage: '', stopped: false };
  }

  const planLine = formatEventResultsPlanLine(plan);
  if (planLine.length > 0) renderResumeNote(panel, planLine);
  if (input.swimsPagesResumeSkipped > 0) {
    renderWarning(
      panel,
      `${input.swimsPagesResumeSkipped} swims page(s) were skipped as already captured, so any event only they referenced is not fetched this run. Those swims import with their round unresolved, never with a guessed one.`,
    );
  }

  const corrected = await sendToBackground({
    type: 'omniswim-swimcloud-open-capture',
    subject,
    plannedPageCount: input.plannedBeforeThisPass + plan.steps.length,
    teamDiscovery: input.teamDiscovery,
    crawlScope: input.crawlScope,
  });
  if (!isRoundTripOk(corrected)) {
    renderWarning(
      panel,
      `${roundTripFailureText('Correcting the planned page count', corrected)} The crawl continues; the app may show a stale page total.`,
    );
  }

  let fetched = 0;
  let failed = 0;
  let notServed = 0;
  let stoppedMessage = '';
  const progress = (): SwimCloudSwimmerTimesProgressState => ({
    fetched,
    total: plan.steps.length,
    alreadyCaptured: partition.alreadyCaptured.length,
    failed,
    notServed,
    concurrency: EVENT_RESULTS_CONCURRENCY,
    staggerMs: EVENT_RESULTS_STAGGER_MS,
  });
  renderEventResults(panel, progress());

  await runBoundedFetchPool<SwimCloudCrawlStep>({
    items: partition.toFetch,
    concurrency: EVENT_RESULTS_CONCURRENCY,
    staggerMs: EVENT_RESULTS_STAGGER_MS,
    sleep,
    shouldStop: () => control.cancelled || stoppedMessage.length > 0,
    beforeStart: () => waitWhilePaused(control),
    run: async (step) => {
      const page = await fetchPageForPool(step.canonicalUrl);
      fetched += 1;

      if (page === undefined) {
        failed += 1;
      } else {
        if (page.httpStatus >= 400) notServed += 1;
        const relayOutcome = await relayFetchedPage(
          panel,
          subject,
          step.canonicalUrl,
          page,
          input.retrievedAt(),
          relay,
        );
        if (relayOutcome !== 'landed') failed += 1;
        if (relayOutcome === 'streak-stop') {
          stoppedMessage =
            'Stopped fetching event results: several pages in a row could not be handed to the Omniswim app. The meet results already captured are unaffected.';
        }
      }

      // Same reasoning as pass 4's: `classifyCrawlPageOutcome` would stop the
      // whole crawl on a 5xx, which is right for a results page and wrong for
      // one event's round labels. `classifyEventResultsOutcome` owns that call.
      const verdict = classifyEventResultsOutcome(
        page === undefined ? { kind: 'network-error' } : { kind: 'http-status', httpStatus: page.httpStatus },
      );
      if (verdict.action === 'record-and-stop-phase') {
        stoppedMessage = verdict.message;
        panel.retryButton.hidden = false;
      }

      renderEventResults(panel, progress());
    },
  });

  const done = partition.alreadyCaptured.length + fetched;
  return {
    total: plan.steps.length,
    done,
    stoppedMessage,
    stopped: stoppedMessage.length > 0 || control.cancelled || done !== plan.steps.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Pass 3 — rosters                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fetch every confirmed team's two roster pages, sequentially and paced, and
 * return each one's parsed athlete rows.
 *
 * `undefined` means the crawl stopped inside this pass (cancelled, or a
 * `classifyCrawlPageOutcome` stop) and the caller must return; the capture has
 * already been marked.
 *
 * ## Why a roster page is never resume-skipped
 *
 * Every other page in this crawl is skipped when the store already holds its
 * bytes. A roster page is not, and the difference is not an oversight. Those
 * stored bytes are on the app's disk; this content script never sees them, and
 * what it needs from a roster is the swimmer list *in this run's memory* to
 * plan pass 4 against. Skipping a stored roster would leave that team's
 * swimmers out of pass 4 entirely — a capture quietly missing 35 swimmers'
 * histories, which reads exactly like a capture of a smaller meet. Re-reading
 * `teamCount × 2` pages is the honest price. It is the same argument page 1 of
 * each team's swims already carries.
 */
async function runRosterPass(
  rosterSteps: readonly SwimCloudCrawlStep[],
  teamIds: readonly SwimCloudTeamId[],
  panel: PanelHandles,
  subject: SwimCloudCaptureSubject,
  retrievedAt: () => string,
  relay: RelayState,
  control: CrawlControl,
): Promise<readonly (readonly SwimCloudRosterAthleteRef[])[] | undefined> {
  const rosters: Array<readonly SwimCloudRosterAthleteRef[]> = [];
  let pagesDone = 0;
  let unreadable = 0;

  const state = (step: SwimCloudCrawlStep): SwimCloudCrawlRosterSweepState => {
    const teamIndex = step.teamId === undefined ? 1 : teamIds.indexOf(step.teamId) + 1;
    return {
      teamIndex: Math.max(1, teamIndex),
      teamCount: teamIds.length,
      gender: genderLabelFor(step.gender ?? 'M'),
      pagesDone,
      pagesTotal: rosterSteps.length,
      swimmersSoFar: collectSwimmerIds(rosters).swimmerIds.length,
      minDelayMs: MIN_DELAY_MS,
    };
  };

  for (const step of rosterSteps) {
    if (control.cancelled) {
      await finishCrawl(panel, subject, 'partial', relay);
      return undefined;
    }
    await waitWhilePaused(control);

    renderRosterSweep(panel, state(step));
    const { url } = crawlStepToFetchRequest(step);
    const page = await fetchPageWithDelay(url);
    pagesDone += 1;

    const outcomeAction = await handleFetchedPage(panel, subject, url, page, retrievedAt(), relay);
    if (outcomeAction === 'stop') return undefined;

    // A 404 here is a real answer, not a failure: a school that sponsors only
    // one gender's programme has no roster for the other. It is recorded by
    // `handleFetchedPage` and contributes no swimmers, which is correct.
    if (page !== undefined && page.httpStatus < 400) {
      const parsed = parseTeamRosterHtml(page.html, {
        sourceUrl: url,
        retrievedAt: retrievedAt(),
        track: 'browser-extension',
      });
      if (parsed.ok) {
        rosters.push(parsed.data.athletes);
      } else {
        // The page's bytes are already relayed and safe; only this run's
        // swimmer list is short. Said out loud, because the alternative is a
        // pass-4 count that is quietly missing a whole team.
        unreadable += 1;
        renderWarning(
          panel,
          `${unreadable} roster page(s) could not be read for their swimmer list, so those swimmers' times pages are not fetched. The roster page itself is captured.`,
        );
      }
    }

    renderRosterSweep(panel, state(step));
  }

  return rosters;
}

/* -------------------------------------------------------------------------- */
/* Pass 4 — swimmer times, the bounded pool                                    */
/* -------------------------------------------------------------------------- */

interface SwimmerTimesPassInput {
  /** Recorded on every planned step; a swimmer-times URL is not meet-scoped. */
  readonly meetId: SwimCloudMeetId;
  readonly rosters: readonly (readonly SwimCloudRosterAthleteRef[])[];
  readonly alreadyCaptured: ReadonlySet<string>;
  /** Pages the plan already committed to before this pass, so the corrected total is additive. */
  readonly plannedBeforeThisPass: number;
  readonly subject: SwimCloudCaptureSubject;
  readonly teamDiscovery: SwimCloudCrawlTeamDiscovery;
  /** Re-sent with this pass's corrected page total; see {@link OpenCaptureMessage.crawlScope}. */
  readonly crawlScope: SwimCloudCaptureCrawlScope;
  readonly panel: PanelHandles;
  readonly retrievedAt: () => string;
  readonly relay: RelayState;
  readonly control: CrawlControl;
}

interface SwimmerTimesPassResult {
  /** Swimmer-times pages planned, including ones a previous crawl already stored. */
  readonly total: number;
  /** Pages this run fetched plus pages skipped as already captured. */
  readonly done: number;
  readonly completeness: 'partial' | 'every-planned-page-fetched';
  /** Non-empty when the pass ended early; shown verbatim on the panel. */
  readonly stoppedMessage: string;
}

/**
 * Fetch one `/swimmer/{id}/times/` page per rostered swimmer, through the
 * bounded pool.
 *
 * This never returns `undefined` the way {@link runRosterPass} can. The pass is
 * last, and everything it can hit — a cancel, a challenge, a run of failed
 * relays — ends the pass rather than discarding the crawl, because by this
 * point the meet's results and rosters are already captured and a partial
 * swimmer-times pass is a strictly better outcome than none.
 */
async function runSwimmerTimesPass(input: SwimmerTimesPassInput): Promise<SwimmerTimesPassResult> {
  const { panel, subject, relay, control } = input;

  const plan = planSwimmerTimesSteps(input.meetId, input.rosters);
  // The same partition every other pass uses. A swimmer-times page's URL is
  // knowable without its content — unlike a roster page, whose content this run
  // needs — so this is where a resumed crawl's saving on this pass actually is.
  const partition = partitionResumableSteps(plan.steps, input.alreadyCaptured);
  if (plan.steps.length === 0) {
    // Distinguishable from "the pass ran and fetched nothing": an empty plan
    // means no roster named a swimmer with a profile link, which is a fact
    // worth printing rather than a silent skip to "Done".
    renderResumeNote(panel, 'No rostered swimmer carried a SwimCloud profile link, so no swimmer times pages were planned.');
    return { total: 0, done: 0, completeness: 'every-planned-page-fetched', stoppedMessage: '' };
  }

  const planLine = formatSwimmerTimesPlanLine(plan);
  if (planLine.length > 0) renderResumeNote(panel, planLine);

  // The last correction to the planned total, now that the swimmer count is
  // real. Sent before the pass rather than after it, same rule as pass 2's.
  const corrected = await sendToBackground({
    type: 'omniswim-swimcloud-open-capture',
    subject,
    plannedPageCount: input.plannedBeforeThisPass + plan.steps.length,
    teamDiscovery: input.teamDiscovery,
    crawlScope: input.crawlScope,
  });
  if (!isRoundTripOk(corrected)) {
    renderWarning(
      panel,
      `${roundTripFailureText('Correcting the planned page count', corrected)} The crawl continues; the app may show a stale page total.`,
    );
  }

  let fetched = 0;
  let failed = 0;
  let notServed = 0;
  let stoppedMessage = '';
  const progress = (): SwimCloudSwimmerTimesProgressState => ({
    fetched,
    total: plan.steps.length,
    alreadyCaptured: partition.alreadyCaptured.length,
    failed,
    notServed,
    concurrency: SWIMMER_TIMES_CONCURRENCY,
    staggerMs: SWIMMER_TIMES_STAGGER_MS,
  });
  renderSwimmerTimes(panel, progress());

  await runBoundedFetchPool<SwimCloudCrawlStep>({
    items: partition.toFetch,
    concurrency: SWIMMER_TIMES_CONCURRENCY,
    staggerMs: SWIMMER_TIMES_STAGGER_MS,
    sleep,
    shouldStop: () => control.cancelled || stoppedMessage.length > 0,
    beforeStart: () => waitWhilePaused(control),
    run: async (step) => {
      const page = await fetchPageForPool(step.canonicalUrl);
      fetched += 1;

      if (page === undefined) {
        // A timeout or a dropped connection on one swimmer's page. Nothing to
        // relay; counted and shown, and the other lanes keep going.
        failed += 1;
      } else {
        if (page.httpStatus >= 400) notServed += 1;
        const relayOutcome = await relayFetchedPage(
          panel,
          subject,
          step.canonicalUrl,
          page,
          input.retrievedAt(),
          relay,
        );
        if (relayOutcome !== 'landed') failed += 1;
        if (relayOutcome === 'streak-stop') {
          stoppedMessage =
            'Stopped fetching swimmer times: several pages in a row could not be handed to the Omniswim app. The meet results already captured are unaffected.';
        }
      }

      // The same shape `handleFetchedPage` uses, against a different table.
      // Routed through the policy for both branches rather than short-circuiting
      // the network-error case here, so the function that owns this decision is
      // the one that makes it — `classifyCrawlPageOutcome` would stop the whole
      // crawl on a 5xx or a dropped connection, which is right for a results
      // page and wrong for one swimmer's history.
      const verdict = classifySwimmerTimesOutcome(
        page === undefined ? { kind: 'network-error' } : { kind: 'http-status', httpStatus: page.httpStatus },
      );
      if (verdict.action === 'record-and-stop-phase') {
        stoppedMessage = verdict.message;
        panel.retryButton.hidden = false;
      }

      renderSwimmerTimes(panel, progress());
    },
  });

  const done = partition.alreadyCaptured.length + fetched;
  const finishedEverything = stoppedMessage.length === 0 && !control.cancelled && done === plan.steps.length;
  return {
    total: plan.steps.length,
    done,
    completeness: finishedEverything ? 'every-planned-page-fetched' : 'partial',
    stoppedMessage,
  };
}

/** Pass-1 progress state for one step. Its denominator is the pass, not the crawl. */
function page1SweepStateFor(
  step: SwimCloudCrawlStep,
  teamIds: readonly SwimCloudTeamId[],
  pagesDone: number,
  pagesTotal: number,
): SwimCloudCrawlPage1SweepState {
  const teamIndex = step.teamId === undefined ? 1 : teamIds.indexOf(step.teamId) + 1;
  const gender: SwimCloudCrawlGender = step.gender ?? 'M';
  return {
    teamIndex: Math.max(1, teamIndex),
    teamCount: teamIds.length,
    gender: genderLabelFor(gender),
    pagesDone,
    pagesTotal,
    minDelayMs: MIN_DELAY_MS,
  };
}

function progressStateFor(
  step: SwimCloudCrawlStep,
  teamIds: readonly SwimCloudTeamId[],
  pagesDone: number,
  pagesTotal: number,
  knownTotalPages: Readonly<Record<string, number>>,
): SwimCloudCrawlProgressState {
  const teamIndex = step.teamId === undefined ? 1 : teamIds.indexOf(step.teamId) + 1;
  const gender: SwimCloudCrawlGender = step.gender ?? 'M';
  const pageCountForTeamGender =
    step.teamId === undefined ? step.page ?? 1 : knownTotalPages[`${step.teamId}:${gender}`] ?? step.page ?? 1;
  return {
    teamIndex: Math.max(1, teamIndex),
    teamCount: teamIds.length,
    gender: genderLabelFor(gender),
    page: step.page ?? 1,
    pageCountForTeamGender,
    pagesDone,
    pagesTotal,
    minDelayMs: MIN_DELAY_MS,
  };
}

/**
 * Relay one fetched (or failed) page to the background, applying the
 * error-handling table. Returns whether the caller must stop.
 *
 * The relay round trip is the crawl's most-repeated message — once per page,
 * sixty-odd times on a real meet — and it was the crawl's longest unbounded
 * wait. It carries a whole page of HTML, and the worker behind it does a
 * localhost POST or a `chrome.downloads` write, either of which could fail in a
 * way that left the old `.then(sendResponse)` chain silent. One unanswered
 * relay froze the panel mid-crawl with no error and no way back.
 */
/**
 * How one relay round trip ended, for a caller that decides for itself what to
 * do about it.
 *
 * Split out of {@link handleFetchedPage} so the swimmer-times pool can relay a
 * page without inheriting the sequential loop's "stop the whole crawl"
 * reactions — the pool's failure policy is `classifySwimmerTimesOutcome`, which
 * is deliberately different. The relay bookkeeping (the streak counter, the
 * panel warning) is identical for both and lives here once.
 */
type RelayOutcome = 'landed' | 'lost' | 'streak-stop';

async function relayFetchedPage(
  panel: PanelHandles,
  subject: SwimCloudCaptureSubject,
  canonicalUrl: string,
  page: FetchedPage,
  retrievedAt: string,
  relay: RelayState,
): Promise<RelayOutcome> {
  const relayed = await sendToBackground<{ relayed?: boolean; via?: 'http' | 'downloads'; error?: string }>(
    {
      type: 'omniswim-swimcloud-relay-page',
      subject,
      sourceUrl: canonicalUrl,
      retrievedAt,
      httpStatus: page.httpStatus,
      html: page.html,
    },
    RELAY_ROUND_TRIP_TIMEOUT_MS,
  );

  // A round trip that came back is not the same as a page that landed: the
  // worker answers `{ relayed: false }` when both the HTTP POST and the
  // downloads fallback failed, and `{ error }` when the handler threw.
  //
  // `via` matters as of 2026-09-09: `{ relayed: true, via: 'downloads' }` used
  // to be treated identically to `{ relayed: true, via: 'http' }` here — both
  // just "landed" — so a crawl where every page fell back to Downloads (an
  // unpaired extension is the real case this was found against, 234 pages)
  // reported zero failures and showed no warning anywhere. The page IS saved
  // either way, so this still isn't a failure; it is a third, distinct
  // outcome that has to be visible while the crawl is still running, not only
  // guessed at afterward from a full Downloads folder.
  const ok = isRoundTripOk(relayed) && relayed.value?.relayed === true;
  if (ok && relayed.value?.via === 'downloads') {
    relay.consecutiveFailures = 0;
    relay.downloadsFallbackCount += 1;
    renderWarning(panel, formatDownloadsFallbackNote(relay.downloadsFallbackCount));
    return 'landed';
  }
  if (ok) {
    relay.consecutiveFailures = 0;
    return 'landed';
  }

  relay.consecutiveFailures += 1;
  relay.totalFailures += 1;
  const why = isRoundTripOk(relayed)
    ? (relayed.value?.error ?? 'the Omniswim app rejected it')
    : roundTripFailureText('Handing the page to the Omniswim app', relayed);
  renderWarning(panel, `Page not saved (${relay.totalFailures} so far): ${why}`);

  const verdict = classifyRelayFailureStreak(relay.consecutiveFailures);
  if (verdict.action === 'stop') {
    renderMessage(panel, verdict.message);
    panel.retryButton.hidden = !verdict.retryable;
    return 'streak-stop';
  }
  return 'lost';
}

async function handleFetchedPage(
  panel: PanelHandles,
  subject: SwimCloudCaptureSubject,
  canonicalUrl: string,
  page: FetchedPage | undefined,
  retrievedAt: string,
  relay: RelayState,
): Promise<'continue' | 'stop'> {
  const outcomeAction = classifyCrawlPageOutcome(
    page === undefined ? { kind: 'network-error' } : { kind: 'http-status', httpStatus: page.httpStatus },
  );

  if (page !== undefined) {
    const relayOutcome = await relayFetchedPage(panel, subject, canonicalUrl, page, retrievedAt, relay);
    if (relayOutcome === 'streak-stop') {
      await finishCrawl(panel, subject, 'partial', relay);
      return 'stop';
    }
  }

  if (outcomeAction.action === 'stop') {
    renderMessage(panel, outcomeAction.message);
    if (outcomeAction.retryable) {
      panel.retryButton.hidden = false;
    }
    await finishCrawl(panel, subject, 'partial', relay);
    return 'stop';
  }
  return 'continue';
}

/**
 * The one function every crawl exit path calls — cancelled, stopped on an
 * error, or finished cleanly. `relay` is threaded through here (rather than
 * flushed at the single tail of the happy path) specifically so a crawl that
 * exits early still gets its buffered downloads-fallback pages combined into
 * one file and reported, instead of only the normal-completion path getting
 * that treatment.
 */
async function finishCrawl(
  panel: PanelHandles,
  subject: SwimCloudCaptureSubject,
  completeness: 'partial' | 'every-planned-page-fetched' | 'failed',
  relay: RelayState,
): Promise<void> {
  // The capture record is best-effort bookkeeping; a failure to mark it must
  // not hide the fact that every page already relayed is safely stored — see
  // the design doc's "State is in-memory" note. It also must not be the last
  // thing a finished crawl waits on forever, which is why it is bounded like
  // every other message rather than wrapped in a bare try/catch that only
  // catches rejections.
  const marked = await sendToBackground({ type: 'omniswim-swimcloud-mark-capture', subject, completeness });
  if (!isRoundTripOk(marked)) {
    renderWarning(panel, roundTripFailureText('Marking the capture finished', marked));
  }

  // Combine every buffered fallback page into one download, once, regardless
  // of how the crawl ended. `flush.error`/`flush.filename === undefined` with
  // `pageCount > 0` means combining failed after the pages were already
  // durably written to `chrome.storage.local` — nothing is lost, only the
  // one-file convenience, and `formatDownloadsFallbackSummary` says so.
  //
  // Built into one string with the true-failure count, not two sequential
  // `renderWarning` calls — `renderWarning` replaces the whole line, so a
  // second call here would have silently erased the first. These are two
  // genuinely different facts (a page saved via Downloads is not lost; a page
  // counted in `totalFailures` is) and a coach needs to see both if both
  // happened, not whichever was rendered last.
  const parts: string[] = [];
  if (relay.downloadsFallbackCount > 0) {
    const flush = await sendToBackground<FlushDownloadsResponse>({
      type: 'omniswim-swimcloud-flush-downloads',
      subject,
    });
    const filename = isRoundTripOk(flush) ? flush.value.filename : undefined;
    parts.push(formatDownloadsFallbackSummary(relay.downloadsFallbackCount, filename));
  }
  if (relay.totalFailures > 0) {
    parts.push(
      `${relay.totalFailures} page${relay.totalFailures === 1 ? '' : 's'} could not be saved anywhere — not to the app, not to Downloads — and ${relay.totalFailures === 1 ? 'is' : 'are'} not in this capture.`,
    );
  }
  if (parts.length > 0) renderWarning(panel, parts.join(' '));
}

async function waitWhilePaused(control: CrawlControl): Promise<void> {
  while (control.paused && !control.cancelled) {
    await sleep(250);
  }
}

/** What the coach settled on before the first bulk request: which teams, and which passes. */
interface TeamListConfirmation {
  readonly teamIds: readonly SwimCloudTeamId[];
  readonly scope: SwimCloudCrawlScope;
}

/**
 * The team checklist described in the design doc: show discovered teams,
 * wait for the user to confirm or amend before any bulk fetching starts.
 * Renders directly into the panel — deliberately minimal (checkboxes plus a
 * Start button), matching this extension's existing plain-DOM style.
 *
 * ## The scope radios
 *
 * Added 2026-09-20 beside the team checkboxes rather than on a separate step,
 * because the two choices trade against each other: a coach dropping teams to
 * shorten a crawl and a coach dropping passes to shorten it are doing the same
 * arithmetic, and the estimate line under both must answer it with one number.
 * That line is re-rendered on **every** change to either control — an estimate
 * that did not move when the scope did would be worse than no estimate, since
 * the whole point of the choice is seeing what it costs before committing.
 *
 * `storedScope` is read for one line of text and never to decide what is
 * fetched: it says what widening the scope is about to add to a capture that
 * already exists. Resume stays a per-URL decision in `captureResume.ts`.
 */
function confirmTeamList(
  panel: PanelHandles,
  teamIds: readonly SwimCloudTeamId[],
  storedScope: SwimCloudCaptureCrawlScope | undefined,
): Promise<TeamListConfirmation | undefined> {
  return new Promise((resolve) => {
    panel.line1.textContent = `${teamIds.length} team(s) discovered. Confirm before fetching:`;
    panel.line2.textContent = '';

    const list = document.createElement('div');
    list.className = 'omniswim-crawler-panel__team-list';
    const checkboxes: Array<{ id: SwimCloudTeamId; input: HTMLInputElement }> = [];
    for (const id of teamIds) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = true;
      label.append(input, document.createTextNode(` Team ${id}`));
      list.appendChild(label);
      checkboxes.push({ id, input });
    }

    const scopeList = document.createElement('div');
    scopeList.className = 'omniswim-crawler-panel__scope-list';
    const scopeRadios: Array<{ scope: SwimCloudCrawlScope; input: HTMLInputElement }> = [];
    for (const scope of SWIMCLOUD_CRAWL_SCOPES) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      // One shared name so the browser enforces single selection for us. The
      // id is namespaced because this markup lives in SwimCloud's document,
      // where a bare `crawl-scope` could collide with the site's own form.
      input.name = 'omniswim-crawl-scope';
      input.value = scope.id;
      input.checked = scope.id === DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID;
      label.append(input, document.createTextNode(` ${scope.label}`));
      const summary = document.createElement('span');
      summary.className = 'omniswim-crawler-panel__scope-summary';
      summary.textContent = scope.summary;
      scopeList.append(label, summary);
      scopeRadios.push({ scope, input });
    }

    const estimateLine = document.createElement('div');
    estimateLine.className = 'omniswim-crawler-panel__line';

    const scopeNoteLine = document.createElement('div');
    scopeNoteLine.className = 'omniswim-crawler-panel__line omniswim-crawler-panel__resume';

    const selectedScope = (): SwimCloudCrawlScope =>
      scopeRadios.find((radio) => radio.input.checked)?.scope ??
      swimCloudCrawlScope(DEFAULT_SWIMCLOUD_CRAWL_SCOPE_ID);

    const refreshEstimate = (): void => {
      const scope = selectedScope();
      const selectedTeams = checkboxes.filter((c) => c.input.checked).length;
      estimateLine.textContent = formatCrawlVolumeFloorLineForScope(selectedTeams, MIN_DELAY_MS, scope);
      const added = passesNewlyPlannedBy(storedScope, scope);
      scopeNoteLine.textContent =
        storedScope === undefined || added.length === 0
          ? ''
          : `This capture has not planned ${added.map(crawlPassLabel).join(' or ')} before. Widening to ${scope.label} adds those pages to it.`;
    };

    for (const { input } of checkboxes) input.addEventListener('change', refreshEstimate);
    for (const { input } of scopeRadios) input.addEventListener('change', refreshEstimate);
    refreshEstimate();

    const startButton = document.createElement('button');
    startButton.type = 'button';
    startButton.textContent = 'Start crawl';
    // Explicitly styled rather than left as a bare `<button>` inside the panel:
    // this element lives in SwimCloud's document and inherits SwimCloud's own
    // element-level button rules, which this extension has never seen and
    // cannot predict. The other three buttons already get their look from
    // `.omniswim-crawler-panel__buttons button`; the one button the whole crawl
    // waits on should not be the one taking its chances.
    startButton.className = 'omniswim-crawler-panel__start';

    panel.root.insertBefore(list, panel.bar.parentElement);
    panel.root.insertBefore(scopeList, panel.bar.parentElement);
    panel.root.insertBefore(estimateLine, panel.bar.parentElement);
    panel.root.insertBefore(scopeNoteLine, panel.bar.parentElement);
    panel.root.insertBefore(startButton, panel.bar.parentElement);

    const cleanup = () => {
      list.remove();
      scopeList.remove();
      estimateLine.remove();
      scopeNoteLine.remove();
      startButton.remove();
    };

    panel.cancelButton.addEventListener(
      'click',
      () => {
        cleanup();
        resolve(undefined);
      },
      { once: true },
    );

    startButton.addEventListener('click', () => {
      const selected = checkboxes.filter((c) => c.input.checked).map((c) => c.id);
      const scope = selectedScope();
      cleanup();
      resolve({ teamIds: selected, scope });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

function meetIdFromCurrentPage(): SwimCloudMeetId | undefined {
  const classification = classifySwimCloudUrl(location.href);
  if (classification.outcome !== 'fetchable') return undefined;
  const resource = classification.resource;
  if (resource.kind === 'meet' || resource.kind === 'meetTopTeams' || resource.kind === 'meetTeam' || resource.kind === 'meetTeamSwims') {
    return resource.meetId;
  }
  return undefined;
}

function createCrawlerButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = 'Auto-fetch full meet (Omniswim)';
  button.setAttribute(
    'aria-label',
    'Fetch every team’s results for this meet into Omniswim Suite, several minutes, several requests',
  );
  return button;
}

function main(): void {
  if (document.getElementById(BUTTON_ID)) return; // Already injected.

  const meetId = meetIdFromCurrentPage();
  if (meetId === undefined) return; // Not a meet-scoped page; nothing to crawl.

  const button = createCrawlerButton();
  document.body.appendChild(button);

  button.addEventListener('click', () => {
    button.remove();
    const panel = createPanel(`Meet ${meetId} — full-field crawl`);
    const control: CrawlControl = { cancelled: false, paused: false };

    panel.cancelButton.addEventListener('click', () => {
      control.cancelled = true;
    });
    panel.pauseButton.addEventListener('click', () => {
      control.paused = !control.paused;
      panel.pauseButton.textContent = control.paused ? 'Resume' : 'Pause';
    });
    // Both start paths go through `startCrawl`, never a bare `void runCrawl(…)`.
    // An unhandled rejection inside the crawl used to leave the panel frozen on
    // whatever line it had last rendered, with the failure visible only in the
    // page's devtools console — which is not somewhere a coach is looking
    // during a meet.
    panel.retryButton.addEventListener('click', () => {
      panel.retryButton.hidden = true;
      renderWarning(panel, '');
      startCrawl(meetId, panel, control);
    });

    startCrawl(meetId, panel, control);
  });
}

function startCrawl(meetId: SwimCloudMeetId, panel: PanelHandles, control: CrawlControl): void {
  runCrawl(meetId, panel, control).catch((error: unknown) => {
    renderCrawlFailure(panel, error);
  });
}

main();
