/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The loop of a multi-team, season-chosen SwimCloud crawl.
 *
 * All I/O is injected through {@link MultiTeamDriverDeps}: the fetch, the relay
 * to the background worker, the capture bookkeeping, the clock, the sleep, the
 * saved resume keys, the progress sink and the season chooser. This module has
 * no `chrome.*`, no DOM, no `fetch` and no timers of its own, so the whole flow
 * runs in a test against archived pages with a fake clock and a fake app. The
 * thin impure half is `multiTeamPanel.ts`.
 *
 * ## Flow
 *
 * 1. **Seasons.** For each team, open the capture `team-{id}`, fetch
 *    `/team/{id}/roster/?gender=M` (no `season_id`) and read the season select
 *    from THAT page with `parseTeamSeasonOptions`. Options are never shared
 *    between teams. The options go to `deps.chooseSeasons`; the answer is one
 *    season label per team.
 * 2. **Queue.** `createQueue` with the choices and the progress saved for this
 *    exact selection. A team whose label its own page does not offer is
 *    `season-unavailable` and gets no fetch at all. Every other team's capture
 *    `team-{id}-{season}` is opened before its first page is relayed.
 * 3. **Loop.** `nextWork` hands out one item at a time (concurrency is 1; the
 *    queue refuses more). The returned queue is stored before any `await`
 *    (queue rule 1). A roster page is checked before it is relayed or parsed
 *    (queue rule 2). A swimmer item fetches
 *    `/api/swimmers/{id}/profile_fastest_times/` once per swimmer id and files
 *    the one body under every team that listed the swimmer.
 * 4. **Halt.** Every page outcome goes through `shouldHalt` (rule 3). A halt calls
 *    `markFailed(..., { haltQueue: true })` and the run ends. A 403 is never
 *    retried. A halted run has no Resume: the user starts the crawl again and
 *    finished swimmers are skipped.
 * 5. **Finish.** On every exit (completed, cancelled, halted, thrown) the driver
 *    marks each capture, then asks the worker to flush the downloads fallback for
 *    every subject it used.
 *
 * ## Why the captures are opened
 *
 * The app's pages route answers 404 for a capture that was never opened. The
 * worker then saves the page in `chrome.storage.local` and says `relayed: true`.
 * Without the open call every page of a multi-team crawl sat there, unflushed. A
 * page counts as landed only when the relay says `landed`, which the glue returns
 * only for the HTTP path; a `fallback` is not landed.
 *
 * ## Pacing (unchanged, read from the constants)
 *
 * Before every request the driver waits until the request would start at least
 * `MIN_DELAY_MS` (roster and season pages) or `SWIMMER_TIMES_STAGGER_MS`
 * (swimmer fetches) after the previous request started. The last start time
 * lives in `deps.paceClock`, which the glue shares with the meet crawl, so two
 * runs on one page cannot start closer together. A 429 is retried with
 * `decideRateLimitRetry`, which only ever waits longer. Cancel and Pause are
 * checked after every wait. No concurrency is added.
 *
 * ## The denylist
 *
 * Every URL is classified by `classifySwimCloudUrl` before it is fetched and
 * must be `fetchable` and of the kind the step expects. Anything else throws
 * {@link MultiTeamDriverError} and nothing is fetched. A reply whose final URL
 * differs from the requested one is not data: another fetchable page is a
 * failure of that item, an unfetchable one halts the run.
 *
 * ## Rules the driver bends or adds (stated so a reviewer can check them)
 *
 * - A 2xx page that fails a check (challenge, wrong season, redirect, not JSON)
 *   is NOT relayed. Relaying it would file the wrong data under the chosen capture.
 * - A 2xx page with no `<select name="season_id">`, or a JSON endpoint answering
 *   something that is not JSON, is a challenge page: it halts the run.
 * - The swimmer page outcome uses `shouldHalt` (5xx and network errors halt), the
 *   stricter queue rule, not the more forgiving `classifySwimmerTimesOutcome`.
 * - Saved progress is keyed by the sorted (team, season id) pairs of the run. It
 *   is cleared after a completed run with no failure, and kept otherwise so a
 *   retry fetches only what failed.
 */

import { captureIdForSubject, type SwimCloudCaptureSubject, type SwimCloudSwimmerId, type SwimCloudTeamId } from '@omniswim/swimcloud/entities';
import { planSwimmerFastestTimes, planTeamRosterPage, type SwimCloudCrawlGender } from '@omniswim/swimcloud/crawlPlan';
import { parseTeamRosterHtml } from '@omniswim/swimcloud/parser';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { TeamSeasonParseError, parseTeamSeasonOptions, resolveSeasonOption, type TeamSeasonOption } from '@omniswim/swimcloud/teamSeasons';
import { MIN_DELAY_MS } from './crawlPacing';
import {
  addSwimmers,
  cancelQueue,
  createQueue,
  finishedSwimmerKeys,
  markDone,
  markFailed,
  nextWork,
  pauseQueue,
  queueProgress,
  resumeQueue,
  shouldHalt,
  verifyRosterSeason,
  type MultiTeamQueue,
  type QueueProgress,
  type QueueRosterWork,
  type QueueSwimmerWork,
} from './multiTeamQueue';
import { RATE_LIMITED_STATUS, decideRateLimitRetry, formatRateLimitWaitLine } from './rateLimitBackoff';
import { SWIMMER_TIMES_STAGGER_MS, collectSwimmerIds } from './swimmerTimes';

/** How often a paused driver looks at the control flags. */
export const PAUSE_POLL_MS = 250;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** What one fetch returned. */
export interface MultiTeamFetchedPage {
  readonly html: string;
  readonly httpStatus: number;
  readonly retryAfter?: string;
  /** The URL the reply came from after any redirect. Compared with the URL asked for. */
  readonly finalUrl: string;
}

/**
 * How one relay round trip ended.
 *
 * - `landed`: the app took the page (the HTTP path).
 * - `fallback`: the app did not take it; the worker saved it for the Downloads
 *   flush. Not landed.
 * - `lost`: it was saved nowhere.
 * - `streak-stop`: so many in a row failed that the run must stop.
 */
export type MultiTeamRelayOutcome = 'landed' | 'fallback' | 'lost' | 'streak-stop';

export interface MultiTeamRelayRequest {
  readonly subject: SwimCloudCaptureSubject;
  readonly sourceUrl: string;
  readonly httpStatus: number;
  readonly html: string;
}

/** What flushing one capture's downloads fallback did. */
export interface MultiTeamFlushResult {
  readonly subject: SwimCloudCaptureSubject;
  /** Pages that were in the fallback. Zero means nothing fell back. */
  readonly pageCount: number;
  readonly filename?: string;
  readonly error?: string;
}

export type MultiTeamCaptureCompleteness = 'partial' | 'every-planned-page-fetched' | 'failed';

/** Flags the panel flips. The driver reads them between items and never writes them. */
export interface MultiTeamControl {
  cancelled: boolean;
  paused: boolean;
}

/** The last request start time, shared with every other crawl on the page. */
export interface MultiTeamPaceClock {
  get(): number | undefined;
  set(ms: number): void;
}

export interface TeamSeasonChoice {
  readonly teamId: SwimCloudTeamId;
  readonly seasonLabel: string;
}

/** What step 1 learned about one team. `options` is absent when the page could not be read. */
export interface TeamSeasonOptionsReport {
  readonly teamId: SwimCloudTeamId;
  readonly options?: readonly TeamSeasonOption[];
  /** Why there are no options. Present exactly when `options` is absent. */
  readonly error?: string;
}

export type MultiTeamPhase = 'reading-seasons' | 'choosing-seasons' | 'crawling' | 'finished';

/** One snapshot for the panel. */
export interface MultiTeamDriverState {
  readonly phase: MultiTeamPhase;
  /** The team whose season page is being read, during `reading-seasons`. */
  readonly readingTeamId?: SwimCloudTeamId;
  readonly seasonReports: readonly TeamSeasonOptionsReport[];
  /** Present from `crawling` on. */
  readonly queue?: QueueProgress;
  /** The latest wait or rate-limit line. Cleared when the next page is requested. */
  readonly notice?: string;
  /** Set when the run stopped itself. */
  readonly haltMessage?: string;
}

export interface MultiTeamDriverDeps {
  /** One request, no pacing, no retry. `undefined` is a network error or timeout. */
  fetchPage(url: string): Promise<MultiTeamFetchedPage | undefined>;
  relay(request: MultiTeamRelayRequest): Promise<MultiTeamRelayOutcome>;
  /**
   * Open (or update) the capture for a subject. Resolves with its id, or
   * `undefined` when the app did not answer. Called before any page is relayed
   * under the subject, and again with a corrected planned page count.
   */
  openCapture(subject: SwimCloudCaptureSubject, plannedPageCount: number): Promise<string | undefined>;
  markCapture(subject: SwimCloudCaptureSubject, completeness: MultiTeamCaptureCompleteness): Promise<void>;
  /** Combine and download whatever fell back to Downloads, one result per subject. */
  flushDownloads(subjects: readonly SwimCloudCaptureSubject[]): Promise<readonly MultiTeamFlushResult[]>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds, the same time base as `paceClock`. */
  now(): number;
  /** ISO-8601 instant for parse provenance. */
  isoNow(): string;
  readonly paceClock: MultiTeamPaceClock;
  /** Swimmer keys finished earlier for this exact selection (see {@link resumeKeyForChoices}). */
  loadFinished(runKey: string): Promise<readonly string[]>;
  saveFinished(runKey: string, keys: readonly string[]): Promise<void>;
  clearFinished(runKey: string): Promise<void>;
  onProgress(state: MultiTeamDriverState): void;
  /** Resolve with one choice per team the user wants crawled. Teams left out are not crawled. */
  chooseSeasons(reports: readonly TeamSeasonOptionsReport[]): Promise<readonly TeamSeasonChoice[]>;
  readonly control: MultiTeamControl;
}

export interface MultiTeamCrawlInput {
  /** Team ids in the order they are to be read. Repeats are an error. */
  readonly teamIds: readonly SwimCloudTeamId[];
}

export type MultiTeamTeamStatus =
  | 'done'
  | 'done-with-errors'
  | 'running'
  | 'queued'
  | 'season-unavailable'
  /** The season page was fetched but gave no usable season list, or was not served. */
  | 'seasons-unreadable'
  /** The user chose no season for this team. */
  | 'not-chosen'
  /** The run ended before this team's season page was read. */
  | 'not-reached';

export interface MultiTeamTeamSummary {
  readonly teamId: SwimCloudTeamId;
  readonly status: MultiTeamTeamStatus;
  readonly seasonLabel?: string;
  readonly seasonId?: string;
  readonly availableLabels?: readonly string[];
  readonly rostersDone: number;
  readonly rostersFailed: number;
  readonly swimmersDone: number;
  readonly swimmersFailed: number;
  /** Swimmers a saved run already finished: not fetched again. */
  readonly swimmersSkippedResumed: number;
  /** Roster rows with no profile link: counted, never given an id. */
  readonly rosterRowsWithoutSwimmerId: number;
  /** Genders whose roster page said the team has no roster (a real answer, not an error). */
  readonly emptyRosterGenders: readonly SwimCloudCrawlGender[];
  /** One printable line per failure, per unreadable season page, or per unavailable season. */
  readonly errors: readonly string[];
}

export interface MultiTeamSummary {
  readonly outcome: 'completed' | 'cancelled' | 'halted';
  readonly haltMessage?: string;
  readonly teams: readonly MultiTeamTeamSummary[];
  /** Every request this run issued, in order, retries included. */
  readonly requestedUrls: readonly string[];
  /** Captures whose downloads fallback held pages, or whose flush failed. Empty when nothing fell back. */
  readonly downloads: readonly MultiTeamFlushResult[];
}

export type MultiTeamDriverErrorCode =
  | 'duplicate-team'
  | 'denylisted-url'
  | 'unknown-choice'
  | 'queue-invariant';

/** Thrown when the run cannot honestly continue. Never swallowed into a summary. */
export class MultiTeamDriverError extends Error {
  readonly code: MultiTeamDriverErrorCode;

  constructor(code: MultiTeamDriverErrorCode, detail: string) {
    super(`multiTeamDriver: ${code}: ${detail}`);
    this.name = 'MultiTeamDriverError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

type ExpectedKind = 'teamRoster' | 'swimmerFastestTimes';

/** Whether `url` is fetchable and of the expected kind. */
function urlIsFetchable(url: string, expected: ExpectedKind): boolean {
  const classified = classifySwimCloudUrl(url);
  return classified.outcome === 'fetchable' && classified.resource.kind === expected;
}

/** Throws unless `url` is fetchable and of the expected kind. The denylist check, run before every fetch. */
export function assertFetchableUrl(url: string, expected: ExpectedKind): void {
  const classified = classifySwimCloudUrl(url);
  if (classified.outcome !== 'fetchable') {
    throw new MultiTeamDriverError('denylisted-url', `${url} classifies as ${classified.outcome}; it is not fetched.`);
  }
  if (classified.resource.kind !== expected) {
    throw new MultiTeamDriverError('denylisted-url', `${url} is a ${classified.resource.kind} URL, not a ${expected} URL; it is not fetched.`);
  }
}

/** The subject a team's pages are filed under. A season label files them under that season. */
export function teamSubject(teamId: SwimCloudTeamId, seasonLabel?: string): SwimCloudCaptureSubject {
  return seasonLabel === undefined ? { kind: 'team', teamId } : { kind: 'team', teamId, season: seasonLabel };
}

/** Compare two team ids as numbers without losing digits: shorter first, then by digits. */
function compareTeamIds(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The key saved progress is stored under: the sorted `teamId:seasonId` pairs of
 * the choices whose label the team's own page offers, joined by commas. A team
 * whose label is not offered is not part of the run and is not in the key.
 * Another team set or another season is another key, so it inherits no skips.
 * Empty when no choice resolves.
 */
export function resumeKeyForChoices(reports: readonly TeamSeasonOptionsReport[], choices: readonly TeamSeasonChoice[]): string {
  const pairs: { teamId: string; seasonId: string }[] = [];
  for (const choice of choices) {
    const options = reports.find((r) => r.teamId === choice.teamId)?.options;
    const season = options === undefined ? undefined : resolveSeasonOption(options, choice.seasonLabel);
    if (season !== undefined) pairs.push({ teamId: choice.teamId, seasonId: season.seasonId });
  }
  pairs.sort((a, b) => compareTeamIds(a.teamId, b.teamId) || compareTeamIds(a.seasonId, b.seasonId));
  return pairs.map((p) => `${p.teamId}:${p.seasonId}`).join(',');
}

/**
 * Whether a season capture may be marked `every-planned-page-fetched`: the team
 * finished with no failure AND the pages present in the app (landed this run,
 * plus swimmers a saved run proved filed under this team) reach the planned
 * count. A capture is never called complete while a planned page is missing.
 */
export function capturePagesComplete(input: {
  readonly planned: number | undefined;
  readonly landedThisRun: number;
  readonly resumedProven: number;
  readonly teamDone: boolean;
}): boolean {
  return input.teamDone && input.planned !== undefined && input.landedThisRun + input.resumedProven >= input.planned;
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The swimmer endpoint answers a JSON object or array. A bare string, number or null is not a result. */
function looksLikeJson(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Whether a 2xx team page is a challenge page. A real team page always prints a
 * `<select name="season_id">`, so its absence means the page is something else;
 * a "Just a moment" title says so directly.
 */
function looksLikeChallengePage(html: string): boolean {
  if (/<title>\s*Just a moment/i.test(html)) return true;
  try {
    parseTeamSeasonOptions(html);
    return false;
  } catch (error) {
    return error instanceof TeamSeasonParseError && error.code === 'season-select-missing';
  }
}

/** The URL with case, a trailing slash and query order removed, for "is this the page I asked for". */
function normalizedUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const query = [...parsed.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&');
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}?${query}`.toLowerCase();
  } catch {
    return undefined;
  }
}

const CHALLENGE_TEXT = 'SwimCloud returned a challenge. Open the page in a tab, pass the check, then start the crawl again. Finished swimmers are skipped.';

/**
 * Rewrite a halt message for a run that has ended. The shared policy text says
 * "Resume", which exists only for a paused run. A halted run is started again,
 * and finished swimmers are skipped.
 */
export function restartText(message: string): string {
  return message
    .replace(/Open the page in a tab, pass it, then Resume\./, 'Open the page in a tab, pass the check, then start the crawl again. Finished swimmers are skipped.')
    .replace(/Retry once, or Cancel to keep what was already captured\./, 'Start the crawl again later. What was already captured is kept.')
    .replace(/Resume when the connection is back\./, 'Start the crawl again when the connection is back.')
    .replace(/Wait a while, then Resume\./, 'Wait a while, then start the crawl again.');
}

const OPEN_FAILED_TEXT =
  "The Omniswim app did not open a capture for this crawl, so its pages would not be saved. Check that the app is running and the pairing token is saved in the extension's options, then start the crawl again.";
const NOT_HANDED_TEXT = 'not handed to the app, so it is not counted as finished';
const RELAY_STREAK_TEXT = 'Several pages in a row could not be handed to the Omniswim app. Start the crawl again when it is reachable.';
const NOT_JSON_TEXT =
  'SwimCloud answered the swimmer-times request with a page that is not JSON. Refresh your SwimCloud session in this tab, then start the crawl again.';

function genderWord(gender: SwimCloudCrawlGender): string {
  return gender === 'M' ? "men's" : "women's";
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

interface FetchResult {
  readonly page: MultiTeamFetchedPage | undefined;
  /** Cancel arrived while waiting. Nothing was requested. */
  readonly aborted: boolean;
}

/** A reason a 2xx page cannot be used. `halt` stops the run; otherwise it fails the item. */
interface PageProblem {
  readonly halt: boolean;
  readonly message: string;
}

/** What to do with one fetched page. `relay` says whether the page is recorded with the app. */
interface Screen {
  readonly action: 'clean' | 'halt' | 'fail';
  readonly message: string;
  readonly relay: boolean;
}

interface TeamNotes {
  rosterRowsWithoutSwimmerId: number;
  emptyRosterGenders: SwimCloudCrawlGender[];
}

/**
 * Run the whole crawl. Resolves with a summary when the run completes, is
 * cancelled, or halts itself. Rejects only for a bug or a denylist hit
 * ({@link MultiTeamDriverError}) and for whatever a dependency throws; the
 * captures are marked and the downloads flushed before it rejects.
 */
export async function runMultiTeamCrawl(deps: MultiTeamDriverDeps, input: MultiTeamCrawlInput): Promise<MultiTeamSummary> {
  const seenTeams = new Set<string>();
  for (const teamId of input.teamIds) {
    if (seenTeams.has(teamId)) throw new MultiTeamDriverError('duplicate-team', `team ${teamId} is listed more than once.`);
    seenTeams.add(teamId);
  }

  const { control } = deps;
  const requestedUrls: string[] = [];
  const seasonReports: TeamSeasonOptionsReport[] = [];
  const teamNotes = new Map<SwimCloudTeamId, TeamNotes>();
  /** Every subject opened or relayed under, by capture id. Flushed at the end. */
  const usedSubjects = new Map<string, SwimCloudCaptureSubject>();
  const optionsLanded = new Map<SwimCloudTeamId, boolean>();
  /** Source URLs the app really took, per capture id. Completeness is checked against this. */
  const landedPages = new Map<string, Set<string>>();
  const plannedBySubject = new Map<string, number>();
  const notesFor = (teamId: SwimCloudTeamId): TeamNotes => {
    let notes = teamNotes.get(teamId);
    if (notes === undefined) {
      notes = { rosterRowsWithoutSwimmerId: 0, emptyRosterGenders: [] };
      teamNotes.set(teamId, notes);
    }
    return notes;
  };

  let phase: MultiTeamPhase = 'reading-seasons';
  let readingTeamId: SwimCloudTeamId | undefined;
  let queue: MultiTeamQueue | undefined;
  let notice: string | undefined;
  let haltMessage: string | undefined;
  let recent429 = 0;
  let choiceAsked = false;
  let plannedCorrected = false;
  let runKey = '';

  const emit = (): void => {
    deps.onProgress({
      phase,
      ...(readingTeamId === undefined ? {} : { readingTeamId }),
      seasonReports: [...seasonReports],
      ...(queue === undefined ? {} : { queue: queueProgress(queue) }),
      ...(notice === undefined ? {} : { notice }),
      ...(haltMessage === undefined ? {} : { haltMessage }),
    });
  };

  function currentQueue(): MultiTeamQueue {
    if (queue === undefined) throw new MultiTeamDriverError('queue-invariant', 'no queue.');
    return queue;
  }

  /** Holds while paused. Returns false when the run was cancelled. */
  const gate = async (): Promise<boolean> => {
    if (control.paused && !control.cancelled) {
      if (queue !== undefined) {
        queue = pauseQueue(queue);
        emit();
      }
      while (control.paused && !control.cancelled) await deps.sleep(PAUSE_POLL_MS);
      if (queue !== undefined && !control.cancelled) {
        queue = resumeQueue(queue);
        emit();
      }
    }
    return !control.cancelled;
  };

  /** Wait for the pacing gap, honouring Cancel and Pause before and after the wait. False means cancelled. */
  const paceWait = async (gapMs: number): Promise<boolean> => {
    if (!(await gate())) return false;
    const last = deps.paceClock.get();
    if (last === undefined) return true;
    const elapsed = deps.now() - last;
    if (elapsed >= gapMs) return true;
    await deps.sleep(gapMs - elapsed);
    return gate();
  };

  /** One paced request: check the denylist, wait the gap, fetch, retry only on 429. */
  const fetchPaced = async (url: string, expected: ExpectedKind, gapMs: number): Promise<FetchResult> => {
    assertFetchableUrl(url, expected);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (!(await paceWait(gapMs))) return { page: undefined, aborted: true };
      deps.paceClock.set(deps.now());
      requestedUrls.push(url);
      const page = await deps.fetchPage(url);
      if (page === undefined || page.httpStatus !== RATE_LIMITED_STATUS) return { page, aborted: false };

      const decision = decideRateLimitRetry(attempt, page.retryAfter, deps.now());
      notice = formatRateLimitWaitLine(url, decision);
      emit();
      if (decision.action === 'give-up') return { page, aborted: false };
      if (control.cancelled) return { page: undefined, aborted: true };
      await deps.sleep(decision.waitMs);
    }
  };

  /** Final outcome of one page to the halt rule. Updates the 429 streak. */
  const haltDecision = (page: MultiTeamFetchedPage | undefined): { stop: true; message: string } | { stop: false } => {
    const outcome = page === undefined ? ({ kind: 'network-error' } as const) : ({ kind: 'http-status', httpStatus: page.httpStatus } as const);
    const action = shouldHalt(outcome, recent429);
    recent429 = outcome.kind === 'http-status' && outcome.httpStatus === RATE_LIMITED_STATUS ? recent429 + 1 : 0;
    return action.action === 'stop' ? { stop: true, message: restartText(action.message) } : { stop: false };
  };

  /** A redirect is a problem; one to an unfetchable URL halts, another fetchable page fails the item. */
  const redirectProblem = (url: string, expected: ExpectedKind, page: MultiTeamFetchedPage): PageProblem | undefined => {
    if (normalizedUrl(page.finalUrl) === normalizedUrl(url) && normalizedUrl(url) !== undefined) return undefined;
    if (!urlIsFetchable(page.finalUrl, expected)) {
      return { halt: true, message: `SwimCloud redirected ${url} to ${page.finalUrl}, which this crawl does not fetch. Refresh your SwimCloud session in this tab, then start the crawl again.` };
    }
    return { halt: false, message: `the page was redirected to ${page.finalUrl}, so it is not the page that was asked for` };
  };

  /** Decide what one fetched page means. Updates the 429 streak. */
  const screenPage = (
    url: string,
    expected: ExpectedKind,
    page: MultiTeamFetchedPage | undefined,
    contentCheck: (html: string) => PageProblem | undefined,
  ): Screen => {
    const stop = haltDecision(page);
    const redirect = page === undefined ? undefined : redirectProblem(url, expected, page);
    // A halting status (403, 5xx, a 429 give-up) carries no data. It is not relayed: the app keeps the newest
    // entry for a URL, and a recorded error must never replace a page that was saved.
    if (stop.stop) return { action: 'halt', message: stop.message, relay: false };
    if (page === undefined) return { action: 'fail', message: 'no response', relay: false };
    if (redirect !== undefined) return { action: redirect.halt ? 'halt' : 'fail', message: redirect.message, relay: false };
    if (!isOkStatus(page.httpStatus)) {
      const text = page.httpStatus === RATE_LIMITED_STATUS ? 'rate-limited (HTTP 429) after retries' : `HTTP ${page.httpStatus}`;
      return { action: 'fail', message: text, relay: true };
    }
    const problem = contentCheck(page.html);
    if (problem !== undefined) return { action: problem.halt ? 'halt' : 'fail', message: problem.message, relay: false };
    return { action: 'clean', message: '', relay: true };
  };

  /** Relay one page under each subject. A `fallback` or `lost` is not landed. */
  const relayTo = async (
    subjects: readonly SwimCloudCaptureSubject[],
    sourceUrl: string,
    page: MultiTeamFetchedPage,
  ): Promise<'landed' | 'not-landed' | 'streak-stop'> => {
    let result: 'landed' | 'not-landed' = 'landed';
    for (const subject of subjects) {
      usedSubjects.set(captureIdForSubject(subject), subject);
      const outcome = await deps.relay({ subject, sourceUrl, httpStatus: page.httpStatus, html: page.html });
      if (outcome === 'streak-stop') return 'streak-stop';
      if (outcome !== 'landed') {
        result = 'not-landed';
        continue;
      }
      const id = captureIdForSubject(subject);
      landedPages.set(id, (landedPages.get(id) ?? new Set<string>()).add(sourceUrl));
    }
    return result;
  };

  /** Open a capture. False when the app gave no id. */
  const openSubject = async (subject: SwimCloudCaptureSubject, planned: number): Promise<boolean> => {
    const id = await deps.openCapture(subject, planned);
    if (id === undefined) return false;
    usedSubjects.set(captureIdForSubject(subject), subject);
    plannedBySubject.set(captureIdForSubject(subject), planned);
    return true;
  };

  /* ---- The steps, in order, with the finish on every exit -------------- */

  let endedBy: MultiTeamSummary['outcome'] = 'halted';
  let thrown: { readonly error: unknown } | undefined;
  emit();
  try {
    await readSeasonLists();
    readingTeamId = undefined;
    const choices = await askForChoices();
    endedBy = haltMessage !== undefined ? 'halted' : control.cancelled ? 'cancelled' : 'completed';
    if (endedBy === 'completed' && choices.length > 0) endedBy = await crawlQueue(choices);
  } catch (error) {
    thrown = { error };
  }
  phase = 'finished';
  haltMessage = haltMessage ?? queue?.halt?.message;
  notice = undefined;
  await markCaptures(thrown === undefined ? endedBy : 'halted');
  const downloads = await flushAll();
  emit();
  if (thrown !== undefined) throw thrown.error;
  return buildSummary(endedBy, downloads);

  /* ---- Step 1: each team's own season list ---------------------------- */

  async function readSeasonLists(): Promise<void> {
    for (const teamId of input.teamIds) {
      if (!(await gate())) return;
      readingTeamId = teamId;
      emit();
      if (!(await openSubject(teamSubject(teamId), 1))) {
        haltMessage = OPEN_FAILED_TEXT;
        seasonReports.push({ teamId, error: OPEN_FAILED_TEXT });
        return;
      }
      const step = planTeamRosterPage(teamId, 'M');
      const { page, aborted } = await fetchPaced(step.canonicalUrl, 'teamRoster', MIN_DELAY_MS);
      notice = undefined;
      if (aborted) return;

      const screen = screenPage(step.canonicalUrl, 'teamRoster', page, challengeProblem);
      if (screen.relay && page !== undefined) {
        const relayed = await relayTo([teamSubject(teamId)], step.canonicalUrl, page);
        optionsLanded.set(teamId, relayed === 'landed' && screen.action === 'clean');
        if (relayed === 'streak-stop') {
          haltMessage = RELAY_STREAK_TEXT;
          seasonReports.push({ teamId, error: haltMessage });
          return;
        }
      }
      if (screen.action === 'halt') {
        haltMessage = screen.message;
        seasonReports.push({ teamId, error: screen.message });
        return;
      }
      seasonReports.push(reportSeasons(teamId, screen, page));
    }
  }

  function challengeProblem(html: string): PageProblem | undefined {
    return looksLikeChallengePage(html) ? { halt: true, message: CHALLENGE_TEXT } : undefined;
  }

  function reportSeasons(teamId: SwimCloudTeamId, screen: Screen, page: MultiTeamFetchedPage | undefined): TeamSeasonOptionsReport {
    if (screen.action === 'fail' || page === undefined) {
      const why = screen.message.startsWith('HTTP') || screen.message === 'no response' ? `returned ${screen.message}` : screen.message;
      return { teamId, error: `The season page for team ${teamId} ${why}.` };
    }
    try {
      return { teamId, options: parseTeamSeasonOptions(page.html) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { teamId, error: `The season list on team ${teamId}'s page could not be read: ${detail}` };
    }
  }

  /* ---- Step 2: the choice ---------------------------------------------- */

  async function askForChoices(): Promise<readonly TeamSeasonChoice[]> {
    if (haltMessage !== undefined || control.cancelled) return [];
    phase = 'choosing-seasons';
    emit();
    const withOptions = seasonReports.filter((r) => r.options !== undefined);
    choiceAsked = withOptions.length > 0;
    if (!choiceAsked) return [];
    const picked = await deps.chooseSeasons(seasonReports);
    for (const choice of picked) {
      if (!withOptions.some((r) => r.teamId === choice.teamId)) {
        throw new MultiTeamDriverError('unknown-choice', `a season was chosen for team ${choice.teamId}, which has no season list.`);
      }
    }
    return picked;
  }

  /* ---- Step 3: the queue loop ------------------------------------------ */

  async function crawlQueue(picked: readonly TeamSeasonChoice[]): Promise<MultiTeamSummary['outcome']> {
    runKey = resumeKeyForChoices(seasonReports, picked);
    const finishedAtStart = runKey === '' ? [] : await deps.loadFinished(runKey);
    queue = createQueue({
      teams: picked.map((choice) => {
        const options = seasonReports.find((r) => r.teamId === choice.teamId)?.options;
        if (options === undefined) throw new MultiTeamDriverError('unknown-choice', `team ${choice.teamId} has no season list.`);
        return { teamId: choice.teamId, seasonLabel: choice.seasonLabel, seasonOptions: options };
      }),
      finishedKeys: finishedAtStart,
    });
    phase = 'crawling';
    emit();
    if (!(await openSeasonCaptures())) return 'halted';

    const persistFinished = async (): Promise<void> => {
      await deps.saveFinished(runKey, [...new Set([...finishedAtStart, ...finishedSwimmerKeys(currentQueue())])]);
    };

    for (;;) {
      if (!(await gate())) {
        queue = cancelQueue(currentQueue());
        return 'cancelled';
      }
      const next = nextWork(currentQueue());
      queue = next.queue; // Stored before any await: queue rule 1.
      if (next.kind === 'idle') {
        const outcome = idleOutcome(next.reason);
        if (outcome === 'completed') {
          await correctPlannedCounts();
          await clearIfClean();
        }
        return outcome;
      }
      notice = undefined;
      emit();

      const work = next.work;
      if (work.kind === 'swimmer') await correctPlannedCounts();
      const halted = work.kind === 'roster' ? await runRosterWork(work) : await runSwimmerWork(work, persistFinished);
      emit();
      if (halted) return 'halted';
    }
  }

  /** What an idle queue means. With one item at a time, only these three can happen. */
  function idleOutcome(reason: string): MultiTeamSummary['outcome'] {
    if (reason === 'drained') return 'completed';
    if (reason === 'halted') return 'halted';
    if (reason === 'cancelled') return 'cancelled';
    throw new MultiTeamDriverError('queue-invariant', `the queue is idle (${reason}) with nothing in flight.`);
  }

  /** The teams whose season the queue accepted. Season-unavailable teams get no capture. */
  function readyTeams(): readonly { teamId: SwimCloudTeamId; seasonLabel: string; swimmerTotal: number }[] {
    return queueProgress(currentQueue()).teams.flatMap((t) =>
      t.status === 'season-unavailable' ? [] : [{ teamId: t.teamId, seasonLabel: t.seasonLabel, swimmerTotal: t.swimmers.total }],
    );
  }

  /**
   * Whether every page the capture was told to expect is in the app: the pages
   * this run landed, plus the swimmers a saved run proved were filed under this
   * team (`skipped-resumed` needs this team's own key), against the planned count.
   */
  function captureHasEveryPlannedPage(teamId: SwimCloudTeamId, seasonLabel: string): boolean {
    const id = captureIdForSubject(teamSubject(teamId, seasonLabel));
    const team = queueProgress(currentQueue()).teams.find((t) => t.teamId === teamId);
    if (team === undefined) return false;
    return capturePagesComplete({
      planned: plannedBySubject.get(id),
      landedThisRun: landedPages.get(id)?.size ?? 0,
      resumedProven: team.swimmers.skippedResumed,
      teamDone: team.status === 'done',
    });
  }

  /** Open every season capture before its first roster is fetched. False stops the run. */
  async function openSeasonCaptures(): Promise<boolean> {
    for (const team of readyTeams()) {
      if (!(await openSubject(teamSubject(team.teamId, team.seasonLabel), 2))) {
        haltMessage = OPEN_FAILED_TEXT;
        return false;
      }
    }
    return true;
  }

  /** Once the rosters are read, tell the app each capture's real page count: two rosters plus its swimmers. */
  async function correctPlannedCounts(): Promise<void> {
    if (plannedCorrected) return;
    plannedCorrected = true;
    for (const team of readyTeams()) {
      const subject = teamSubject(team.teamId, team.seasonLabel);
      const planned = 2 + team.swimmerTotal;
      if (plannedBySubject.get(captureIdForSubject(subject)) === planned) continue;
      if (!(await openSubject(subject, planned))) {
        notice = `The app did not accept the corrected page count for team ${team.teamId}. The crawl goes on.`;
        emit();
      }
    }
  }

  /** After a completed run with no failure, forget the saved progress: the next crawl of this selection starts fresh. */
  async function clearIfClean(): Promise<void> {
    if (runKey === '') return;
    const failed = queueProgress(currentQueue()).teams.some((t) => t.rosters.failed + t.swimmers.failed > 0);
    if (!failed) await deps.clearFinished(runKey);
  }

  /* ---- Work items ------------------------------------------------------ */

  /** Mark the item failed and halt. Returns true. */
  function halt(key: string, message: string): true {
    queue = markFailed(currentQueue(), key, message, { haltQueue: true });
    haltMessage = haltMessage ?? message;
    return true;
  }

  /** Mark one item failed without halting. Returns false: the run goes on. */
  function failItem(key: string, message: string): false {
    queue = markFailed(currentQueue(), key, message);
    return false;
  }

  /** Act on a screen that is not clean. Returns whether the run halted. */
  function actOn(key: string, screen: Screen): boolean {
    return screen.action === 'halt' ? halt(key, screen.message) : failItem(key, screen.message);
  }

  /** Relay under the subjects. Returns a halt/fail result, or undefined when the page landed. */
  async function relayItem(key: string, subjects: readonly SwimCloudCaptureSubject[], url: string, page: MultiTeamFetchedPage): Promise<boolean | undefined> {
    const relayed = await relayTo(subjects, url, page);
    if (relayed === 'streak-stop') return halt(key, RELAY_STREAK_TEXT);
    if (relayed === 'not-landed') return failItem(key, NOT_HANDED_TEXT);
    return undefined;
  }

  function rosterProblem(work: QueueRosterWork): (html: string) => PageProblem | undefined {
    return (html) => {
      if (looksLikeChallengePage(html)) return { halt: true, message: CHALLENGE_TEXT };
      const check = verifyRosterSeason(html, work);
      return check.ok ? undefined : { halt: false, message: check.reason };
    };
  }

  async function runRosterWork(work: QueueRosterWork): Promise<boolean> {
    const { page, aborted } = await fetchPaced(work.canonicalUrl, 'teamRoster', MIN_DELAY_MS);
    if (aborted) return failItem(work.key, 'not fetched: the run was cancelled');
    const screen = screenPage(work.canonicalUrl, 'teamRoster', page, rosterProblem(work));

    if (screen.relay && page !== undefined) {
      const subject = teamSubject(work.teamId, work.seasonLabel);
      if (screen.action === 'clean') {
        const stopped = await relayItem(work.key, [subject], work.canonicalUrl, page);
        if (stopped !== undefined) return stopped;
      } else if ((await relayTo([subject], work.canonicalUrl, page)) === 'streak-stop') {
        return halt(work.key, RELAY_STREAK_TEXT);
      }
    }
    if (screen.action !== 'clean' || page === undefined) return actOn(work.key, screen);
    return finishRoster(work, page.html);
  }

  /** Parse a roster page that passed every check and queue its swimmers. */
  function finishRoster(work: QueueRosterWork, html: string): boolean {
    const parsed = parseTeamRosterHtml(
      html,
      { sourceUrl: work.canonicalUrl, retrievedAt: deps.isoNow(), track: 'browser-extension' },
      { gender: work.gender === 'M' ? 'Men' : 'Women', season: work.seasonLabel, teamId: work.teamId },
    );
    if (!parsed.ok) return failItem(work.key, `the ${genderWord(work.gender)} roster could not be read: ${parsed.failure.message}`);

    const says = parsed.warnings.some((w) => w.code === 'no-roster-posted');
    if (parsed.data.athletes.length === 0 && !says) {
      const codes = parsed.warnings.map((w) => w.code).join(', ') || 'no warnings';
      return failItem(work.key, `the ${genderWord(work.gender)} roster page lists nobody and does not say that no roster is posted (${codes}), so it is not treated as an empty roster`);
    }
    const collected = collectSwimmerIds([parsed.data.athletes]);
    const notes = notesFor(work.teamId);
    notes.rosterRowsWithoutSwimmerId += collected.withoutSwimmerId;
    if (parsed.data.athletes.length === 0) notes.emptyRosterGenders.push(work.gender);
    queue = addSwimmers(currentQueue(), work.teamId, work.gender, collected.swimmerIds);
    queue = markDone(currentQueue(), work.key);
    return false;
  }

  /** The endpoint answers JSON. A 2xx body that is not JSON is a challenge page. */
  function swimmerProblem(html: string): PageProblem | undefined {
    return looksLikeJson(html) ? undefined : { halt: true, message: NOT_JSON_TEXT };
  }

  async function runSwimmerWork(work: QueueSwimmerWork, persist: () => Promise<void>): Promise<boolean> {
    const step = planSwimmerFastestTimes(work.swimmerId as SwimCloudSwimmerId);
    const { page, aborted } = await fetchPaced(step.canonicalUrl, 'swimmerFastestTimes', SWIMMER_TIMES_STAGGER_MS);
    if (aborted) return failItem(work.key, 'not fetched: the run was cancelled');
    const screen = screenPage(step.canonicalUrl, 'swimmerFastestTimes', page, swimmerProblem);

    // The one body goes under every team that listed this swimmer: no extra request.
    const subjects = work.attributions.map((a) => teamSubject(a.teamId, a.seasonLabel));
    if (screen.relay && page !== undefined) {
      if (screen.action === 'clean') {
        const stopped = await relayItem(work.key, subjects, step.canonicalUrl, page);
        if (stopped !== undefined) return stopped;
      } else if ((await relayTo(subjects, step.canonicalUrl, page)) === 'streak-stop') {
        return halt(work.key, RELAY_STREAK_TEXT);
      }
    }
    if (screen.action !== 'clean') return actOn(work.key, screen);
    queue = markDone(currentQueue(), work.key);
    await persist();
    return false;
  }

  /* ---- Finish ---------------------------------------------------------- */

  /** Mark each capture. Complete only for a clean run of a team whose pages all landed. */
  async function markCaptures(outcome: MultiTeamSummary['outcome']): Promise<void> {
    const seasonDone = new Set<string>();
    if (queue !== undefined && outcome === 'completed') {
      for (const t of queueProgress(queue).teams) {
        if (captureHasEveryPlannedPage(t.teamId, t.seasonLabel)) {
          seasonDone.add(captureIdForSubject(teamSubject(t.teamId, t.seasonLabel)));
        }
      }
    }
    for (const [id, subject] of usedSubjects) {
      const complete =
        subject.kind === 'team' && subject.season === undefined ? optionsLanded.get(subject.teamId) === true : seasonDone.has(id);
      await deps.markCapture(subject, complete ? 'every-planned-page-fetched' : 'partial');
    }
  }

  /** Flush the downloads fallback for every subject used. Reports only what fell back or failed. */
  async function flushAll(): Promise<readonly MultiTeamFlushResult[]> {
    if (usedSubjects.size === 0) return [];
    const results = await deps.flushDownloads([...usedSubjects.values()]);
    return results.filter((r) => r.pageCount > 0 || r.error !== undefined);
  }

  /* ---- Summary --------------------------------------------------------- */

  function buildSummary(outcome: MultiTeamSummary['outcome'], downloads: readonly MultiTeamFlushResult[]): MultiTeamSummary {
    const progress = queue === undefined ? undefined : queueProgress(queue);
    const teams: MultiTeamTeamSummary[] = input.teamIds.map((teamId) => {
      const notes = notesFor(teamId);
      const base = {
        teamId,
        rostersDone: 0,
        rostersFailed: 0,
        swimmersDone: 0,
        swimmersFailed: 0,
        swimmersSkippedResumed: 0,
        rosterRowsWithoutSwimmerId: notes.rosterRowsWithoutSwimmerId,
        emptyRosterGenders: notes.emptyRosterGenders,
      };
      const queued = progress?.teams.find((t) => t.teamId === teamId);
      if (queued !== undefined) {
        return {
          ...base,
          status: queued.status,
          seasonLabel: queued.seasonLabel,
          ...(queued.seasonId === undefined ? {} : { seasonId: queued.seasonId }),
          ...(queued.availableLabels === undefined ? {} : { availableLabels: queued.availableLabels }),
          rostersDone: queued.rosters.done,
          rostersFailed: queued.rosters.failed,
          swimmersDone: queued.swimmers.done,
          swimmersFailed: queued.swimmers.failed,
          swimmersSkippedResumed: queued.swimmers.skippedResumed,
          errors: queued.errorLines,
        };
      }
      const report = seasonReports.find((r) => r.teamId === teamId);
      if (report === undefined) return { ...base, status: 'not-reached', errors: [] };
      if (report.error !== undefined) return { ...base, status: 'seasons-unreadable', errors: [report.error] };
      return { ...base, status: choiceAsked ? 'not-chosen' : 'not-reached', errors: [] };
    });
    return {
      outcome,
      ...(haltMessage === undefined ? {} : { haltMessage }),
      teams,
      requestedUrls,
      downloads,
    };
  }
}
