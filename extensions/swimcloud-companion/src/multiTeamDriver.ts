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
  /**
   * `label` is the school name the team's roster pages print, passed only when
   * every roster page read for that team printed the same one. Never a guess.
   */
  markCapture(subject: SwimCloudCaptureSubject, completeness: MultiTeamCaptureCompleteness, label?: string): Promise<void>;
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
 * Everything one run reads and writes, passed explicitly to each phase.
 *
 * The collections are owned by the run. The scalar fields are the run's
 * progress: a phase reads and writes them through `ctx`, never through a
 * closure, so each phase can be read (and tested) on its own.
 */
interface RunContext {
  readonly deps: MultiTeamDriverDeps;
  readonly input: MultiTeamCrawlInput;
  readonly requestedUrls: string[];
  readonly seasonReports: TeamSeasonOptionsReport[];
  readonly teamNotes: Map<SwimCloudTeamId, TeamNotes>;
  /** Every subject opened or relayed under, by capture id. Flushed at the end. */
  readonly usedSubjects: Map<string, SwimCloudCaptureSubject>;
  readonly optionsLanded: Map<SwimCloudTeamId, boolean>;
  /** School names the roster pages printed, by team. More than one name means no label. */
  readonly rosterNames: Map<SwimCloudTeamId, Set<string>>;
  /** Source URLs the app really took, per capture id. Completeness is checked against this. */
  readonly landedPages: Map<string, Set<string>>;
  readonly plannedBySubject: Map<string, number>;
  phase: MultiTeamPhase;
  readingTeamId: SwimCloudTeamId | undefined;
  queue: MultiTeamQueue | undefined;
  notice: string | undefined;
  haltMessage: string | undefined;
  recent429: number;
  choiceAsked: boolean;
  plannedCorrected: boolean;
  runKey: string;
}

function newRunContext(deps: MultiTeamDriverDeps, input: MultiTeamCrawlInput): RunContext {
  return {
    deps,
    input,
    requestedUrls: [],
    seasonReports: [],
    teamNotes: new Map(),
    usedSubjects: new Map(),
    optionsLanded: new Map(),
    rosterNames: new Map(),
    landedPages: new Map(),
    plannedBySubject: new Map(),
    phase: 'reading-seasons',
    readingTeamId: undefined,
    queue: undefined,
    notice: undefined,
    haltMessage: undefined,
    recent429: 0,
    choiceAsked: false,
    plannedCorrected: false,
    runKey: '',
  };
}

function notesFor(ctx: RunContext, teamId: SwimCloudTeamId): TeamNotes {
  let notes = ctx.teamNotes.get(teamId);
  if (notes === undefined) {
    notes = { rosterRowsWithoutSwimmerId: 0, emptyRosterGenders: [] };
    ctx.teamNotes.set(teamId, notes);
  }
  return notes;
}

function emit(ctx: RunContext): void {
  ctx.deps.onProgress({
    phase: ctx.phase,
    ...(ctx.readingTeamId === undefined ? {} : { readingTeamId: ctx.readingTeamId }),
    seasonReports: [...ctx.seasonReports],
    ...(ctx.queue === undefined ? {} : { queue: queueProgress(ctx.queue) }),
    ...(ctx.notice === undefined ? {} : { notice: ctx.notice }),
    ...(ctx.haltMessage === undefined ? {} : { haltMessage: ctx.haltMessage }),
  });
}

function currentQueue(ctx: RunContext): MultiTeamQueue {
  if (ctx.queue === undefined) throw new MultiTeamDriverError('queue-invariant', 'no queue.');
  return ctx.queue;
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

  const ctx = newRunContext(deps, input);
  let endedBy: MultiTeamSummary['outcome'] = 'halted';
  let thrown: { readonly error: unknown } | undefined;
  emit(ctx);
  try {
    await readSeasonLists(ctx);
    ctx.readingTeamId = undefined;
    const choices = await askForChoices(ctx);
    endedBy = ctx.haltMessage !== undefined ? 'halted' : deps.control.cancelled ? 'cancelled' : 'completed';
    if (endedBy === 'completed' && choices.length > 0) endedBy = await crawlQueue(ctx, choices);
  } catch (error) {
    thrown = { error };
  }
  ctx.phase = 'finished';
  ctx.haltMessage = ctx.haltMessage ?? ctx.queue?.halt?.message;
  ctx.notice = undefined;
  await markCaptures(ctx, thrown === undefined ? endedBy : 'halted');
  const downloads = await flushAll(ctx);
  emit(ctx);
  if (thrown !== undefined) throw thrown.error;
  return buildSummary(ctx, endedBy, downloads);
}

/* -------------------------------------------------------------------------- */
/* Pacing, fetch and page screening                                            */
/* -------------------------------------------------------------------------- */

/** Holds while paused. Returns false when the run was cancelled. */
async function gate(ctx: RunContext): Promise<boolean> {
  const { control } = ctx.deps;
  if (control.paused && !control.cancelled) {
    if (ctx.queue !== undefined) {
      ctx.queue = pauseQueue(ctx.queue);
      emit(ctx);
    }
    while (control.paused && !control.cancelled) await ctx.deps.sleep(PAUSE_POLL_MS);
    if (ctx.queue !== undefined && !control.cancelled) {
      ctx.queue = resumeQueue(ctx.queue);
      emit(ctx);
    }
  }
  return !control.cancelled;
}

/** Wait for the pacing gap, honouring Cancel and Pause before and after the wait. False means cancelled. */
async function paceWait(ctx: RunContext, gapMs: number): Promise<boolean> {
  if (!(await gate(ctx))) return false;
  const last = ctx.deps.paceClock.get();
  if (last === undefined) return true;
  const elapsed = ctx.deps.now() - last;
  if (elapsed >= gapMs) return true;
  await ctx.deps.sleep(gapMs - elapsed);
  return gate(ctx);
}

/** One paced request: check the denylist, wait the gap, fetch, retry only on 429. */
async function fetchPaced(ctx: RunContext, url: string, expected: ExpectedKind, gapMs: number): Promise<FetchResult> {
  const { deps } = ctx;
  assertFetchableUrl(url, expected);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (!(await paceWait(ctx, gapMs))) return { page: undefined, aborted: true };
    deps.paceClock.set(deps.now());
    ctx.requestedUrls.push(url);
    const page = await deps.fetchPage(url);
    if (page === undefined || page.httpStatus !== RATE_LIMITED_STATUS) return { page, aborted: false };

    const decision = decideRateLimitRetry(attempt, page.retryAfter, deps.now());
    ctx.notice = formatRateLimitWaitLine(url, decision);
    emit(ctx);
    if (decision.action === 'give-up') return { page, aborted: false };
    if (deps.control.cancelled) return { page: undefined, aborted: true };
    await deps.sleep(decision.waitMs);
  }
}

/** Final outcome of one page to the halt rule. Updates the 429 streak. */
function haltDecision(ctx: RunContext, page: MultiTeamFetchedPage | undefined): { stop: true; message: string } | { stop: false } {
  const outcome = page === undefined ? ({ kind: 'network-error' } as const) : ({ kind: 'http-status', httpStatus: page.httpStatus } as const);
  const action = shouldHalt(outcome, ctx.recent429);
  ctx.recent429 = outcome.kind === 'http-status' && outcome.httpStatus === RATE_LIMITED_STATUS ? ctx.recent429 + 1 : 0;
  return action.action === 'stop' ? { stop: true, message: restartText(action.message) } : { stop: false };
}

/** A redirect is a problem; one to an unfetchable URL halts, another fetchable page fails the item. */
function redirectProblem(url: string, expected: ExpectedKind, page: MultiTeamFetchedPage): PageProblem | undefined {
  if (normalizedUrl(page.finalUrl) === normalizedUrl(url) && normalizedUrl(url) !== undefined) return undefined;
  if (!urlIsFetchable(page.finalUrl, expected)) {
    return { halt: true, message: `SwimCloud redirected ${url} to ${page.finalUrl}, which this crawl does not fetch. Refresh your SwimCloud session in this tab, then start the crawl again.` };
  }
  return { halt: false, message: `the page was redirected to ${page.finalUrl}, so it is not the page that was asked for` };
}

/** Decide what one fetched page means. Updates the 429 streak. */
function screenPage(
  ctx: RunContext,
  url: string,
  expected: ExpectedKind,
  page: MultiTeamFetchedPage | undefined,
  contentCheck: (html: string) => PageProblem | undefined,
): Screen {
  const stop = haltDecision(ctx, page);
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
}

/* -------------------------------------------------------------------------- */
/* Relay and capture bookkeeping                                               */
/* -------------------------------------------------------------------------- */

/** Relay one page under each subject. A `fallback` or `lost` is not landed. */
async function relayTo(
  ctx: RunContext,
  subjects: readonly SwimCloudCaptureSubject[],
  sourceUrl: string,
  page: MultiTeamFetchedPage,
): Promise<'landed' | 'not-landed' | 'streak-stop'> {
  let result: 'landed' | 'not-landed' = 'landed';
  for (const subject of subjects) {
    ctx.usedSubjects.set(captureIdForSubject(subject), subject);
    const outcome = await ctx.deps.relay({ subject, sourceUrl, httpStatus: page.httpStatus, html: page.html });
    if (outcome === 'streak-stop') return 'streak-stop';
    if (outcome !== 'landed') {
      result = 'not-landed';
      continue;
    }
    const id = captureIdForSubject(subject);
    ctx.landedPages.set(id, (ctx.landedPages.get(id) ?? new Set<string>()).add(sourceUrl));
  }
  return result;
}

/** Open a capture. False when the app gave no id. */
async function openSubject(ctx: RunContext, subject: SwimCloudCaptureSubject, planned: number): Promise<boolean> {
  const id = await ctx.deps.openCapture(subject, planned);
  if (id === undefined) return false;
  ctx.usedSubjects.set(captureIdForSubject(subject), subject);
  ctx.plannedBySubject.set(captureIdForSubject(subject), planned);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Step 1: each team's own season list                                         */
/* -------------------------------------------------------------------------- */

async function readSeasonLists(ctx: RunContext): Promise<void> {
  for (const teamId of ctx.input.teamIds) {
    if (!(await gate(ctx))) return;
    ctx.readingTeamId = teamId;
    emit(ctx);
    if (!(await openSubject(ctx, teamSubject(teamId), 1))) {
      ctx.haltMessage = OPEN_FAILED_TEXT;
      ctx.seasonReports.push({ teamId, error: OPEN_FAILED_TEXT });
      return;
    }
    const step = planTeamRosterPage(teamId, 'M');
    const { page, aborted } = await fetchPaced(ctx, step.canonicalUrl, 'teamRoster', MIN_DELAY_MS);
    ctx.notice = undefined;
    if (aborted) return;

    const screen = screenPage(ctx, step.canonicalUrl, 'teamRoster', page, challengeProblem);
    if (screen.relay && page !== undefined) {
      const relayed = await relayTo(ctx, [teamSubject(teamId)], step.canonicalUrl, page);
      ctx.optionsLanded.set(teamId, relayed === 'landed' && screen.action === 'clean');
      if (relayed === 'streak-stop') {
        ctx.haltMessage = RELAY_STREAK_TEXT;
        ctx.seasonReports.push({ teamId, error: ctx.haltMessage });
        return;
      }
    }
    if (screen.action === 'halt') {
      ctx.haltMessage = screen.message;
      ctx.seasonReports.push({ teamId, error: screen.message });
      return;
    }
    ctx.seasonReports.push(reportSeasons(teamId, screen, page));
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

/* -------------------------------------------------------------------------- */
/* Step 2: the choice                                                          */
/* -------------------------------------------------------------------------- */

async function askForChoices(ctx: RunContext): Promise<readonly TeamSeasonChoice[]> {
  if (ctx.haltMessage !== undefined || ctx.deps.control.cancelled) return [];
  ctx.phase = 'choosing-seasons';
  emit(ctx);
  const withOptions = ctx.seasonReports.filter((r) => r.options !== undefined);
  ctx.choiceAsked = withOptions.length > 0;
  if (!ctx.choiceAsked) return [];
  const picked = await ctx.deps.chooseSeasons(ctx.seasonReports);
  for (const choice of picked) {
    if (!withOptions.some((r) => r.teamId === choice.teamId)) {
      throw new MultiTeamDriverError('unknown-choice', `a season was chosen for team ${choice.teamId}, which has no season list.`);
    }
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Step 3: the queue loop                                                      */
/* -------------------------------------------------------------------------- */

async function crawlQueue(ctx: RunContext, picked: readonly TeamSeasonChoice[]): Promise<MultiTeamSummary['outcome']> {
  ctx.runKey = resumeKeyForChoices(ctx.seasonReports, picked);
  const finishedAtStart = ctx.runKey === '' ? [] : await ctx.deps.loadFinished(ctx.runKey);
  ctx.queue = createQueue({
    teams: picked.map((choice) => {
      const options = ctx.seasonReports.find((r) => r.teamId === choice.teamId)?.options;
      if (options === undefined) throw new MultiTeamDriverError('unknown-choice', `team ${choice.teamId} has no season list.`);
      return { teamId: choice.teamId, seasonLabel: choice.seasonLabel, seasonOptions: options };
    }),
    finishedKeys: finishedAtStart,
  });
  ctx.phase = 'crawling';
  emit(ctx);
  if (!(await openSeasonCaptures(ctx))) return 'halted';

  const persistFinished = async (): Promise<void> => {
    await ctx.deps.saveFinished(ctx.runKey, [...new Set([...finishedAtStart, ...finishedSwimmerKeys(currentQueue(ctx))])]);
  };

  for (;;) {
    if (!(await gate(ctx))) {
      ctx.queue = cancelQueue(currentQueue(ctx));
      return 'cancelled';
    }
    const next = nextWork(currentQueue(ctx));
    ctx.queue = next.queue; // Stored before any await: queue rule 1.
    if (next.kind === 'idle') {
      const outcome = idleOutcome(next.reason);
      if (outcome === 'completed') {
        await correctPlannedCounts(ctx);
        await clearIfClean(ctx);
      }
      return outcome;
    }
    ctx.notice = undefined;
    emit(ctx);

    const work = next.work;
    if (work.kind === 'swimmer') await correctPlannedCounts(ctx);
    const halted = work.kind === 'roster' ? await runRosterWork(ctx, work) : await runSwimmerWork(ctx, work, persistFinished);
    emit(ctx);
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
function readyTeams(ctx: RunContext): readonly { teamId: SwimCloudTeamId; seasonLabel: string; swimmerTotal: number }[] {
  return queueProgress(currentQueue(ctx)).teams.flatMap((t) =>
    t.status === 'season-unavailable' ? [] : [{ teamId: t.teamId, seasonLabel: t.seasonLabel, swimmerTotal: t.swimmers.total }],
  );
}

/**
 * Whether every page the capture was told to expect is in the app: the pages
 * this run landed, plus the swimmers a saved run proved were filed under this
 * team (`skipped-resumed` needs this team's own key), against the planned count.
 */
function captureHasEveryPlannedPage(ctx: RunContext, teamId: SwimCloudTeamId, seasonLabel: string): boolean {
  const id = captureIdForSubject(teamSubject(teamId, seasonLabel));
  const team = queueProgress(currentQueue(ctx)).teams.find((t) => t.teamId === teamId);
  if (team === undefined) return false;
  return capturePagesComplete({
    planned: ctx.plannedBySubject.get(id),
    landedThisRun: ctx.landedPages.get(id)?.size ?? 0,
    resumedProven: team.swimmers.skippedResumed,
    teamDone: team.status === 'done',
  });
}

/** Open every season capture before its first roster is fetched. False stops the run. */
async function openSeasonCaptures(ctx: RunContext): Promise<boolean> {
  for (const team of readyTeams(ctx)) {
    if (!(await openSubject(ctx, teamSubject(team.teamId, team.seasonLabel), 2))) {
      ctx.haltMessage = OPEN_FAILED_TEXT;
      return false;
    }
  }
  return true;
}

/** Once the rosters are read, tell the app each capture's real page count: two rosters plus its swimmers. */
async function correctPlannedCounts(ctx: RunContext): Promise<void> {
  if (ctx.plannedCorrected) return;
  ctx.plannedCorrected = true;
  for (const team of readyTeams(ctx)) {
    const subject = teamSubject(team.teamId, team.seasonLabel);
    const planned = 2 + team.swimmerTotal;
    if (ctx.plannedBySubject.get(captureIdForSubject(subject)) === planned) continue;
    if (!(await openSubject(ctx, subject, planned))) {
      ctx.notice = `The app did not accept the corrected page count for team ${team.teamId}. The crawl goes on.`;
      emit(ctx);
    }
  }
}

/** After a completed run with no failure, forget the saved progress: the next crawl of this selection starts fresh. */
async function clearIfClean(ctx: RunContext): Promise<void> {
  if (ctx.runKey === '') return;
  const failed = queueProgress(currentQueue(ctx)).teams.some((t) => t.rosters.failed + t.swimmers.failed > 0);
  if (!failed) await ctx.deps.clearFinished(ctx.runKey);
}

/* -------------------------------------------------------------------------- */
/* Work items                                                                  */
/* -------------------------------------------------------------------------- */

/** Mark the item failed and halt. Returns true. */
function haltItem(ctx: RunContext, key: string, message: string): true {
  ctx.queue = markFailed(currentQueue(ctx), key, message, { haltQueue: true });
  ctx.haltMessage = ctx.haltMessage ?? message;
  return true;
}

/** Mark one item failed without halting. Returns false: the run goes on. */
function failItem(ctx: RunContext, key: string, message: string): false {
  ctx.queue = markFailed(currentQueue(ctx), key, message);
  return false;
}

/** Act on a screen that is not clean. Returns whether the run halted. */
function actOn(ctx: RunContext, key: string, screen: Screen): boolean {
  return screen.action === 'halt' ? haltItem(ctx, key, screen.message) : failItem(ctx, key, screen.message);
}

/** Relay under the subjects. Returns a halt/fail result, or undefined when the page landed. */
async function relayItem(
  ctx: RunContext,
  key: string,
  subjects: readonly SwimCloudCaptureSubject[],
  url: string,
  page: MultiTeamFetchedPage,
): Promise<boolean | undefined> {
  const relayed = await relayTo(ctx, subjects, url, page);
  if (relayed === 'streak-stop') return haltItem(ctx, key, RELAY_STREAK_TEXT);
  if (relayed === 'not-landed') return failItem(ctx, key, NOT_HANDED_TEXT);
  return undefined;
}

function rosterProblem(work: QueueRosterWork): (html: string) => PageProblem | undefined {
  return (html) => {
    if (looksLikeChallengePage(html)) return { halt: true, message: CHALLENGE_TEXT };
    const check = verifyRosterSeason(html, work);
    return check.ok ? undefined : { halt: false, message: check.reason };
  };
}

async function runRosterWork(ctx: RunContext, work: QueueRosterWork): Promise<boolean> {
  const { page, aborted } = await fetchPaced(ctx, work.canonicalUrl, 'teamRoster', MIN_DELAY_MS);
  if (aborted) return failItem(ctx, work.key, 'not fetched: the run was cancelled');
  const screen = screenPage(ctx, work.canonicalUrl, 'teamRoster', page, rosterProblem(work));

  if (screen.relay && page !== undefined) {
    const subject = teamSubject(work.teamId, work.seasonLabel);
    if (screen.action === 'clean') {
      const stopped = await relayItem(ctx, work.key, [subject], work.canonicalUrl, page);
      if (stopped !== undefined) return stopped;
    } else if ((await relayTo(ctx, [subject], work.canonicalUrl, page)) === 'streak-stop') {
      return haltItem(ctx, work.key, RELAY_STREAK_TEXT);
    }
  }
  if (screen.action !== 'clean' || page === undefined) return actOn(ctx, work.key, screen);
  return finishRoster(ctx, work, page.html);
}

/** Parse a roster page that passed every check and queue its swimmers. */
function finishRoster(ctx: RunContext, work: QueueRosterWork, html: string): boolean {
  const parsed = parseTeamRosterHtml(
    html,
    { sourceUrl: work.canonicalUrl, retrievedAt: ctx.deps.isoNow(), track: 'browser-extension' },
    { gender: work.gender === 'M' ? 'Men' : 'Women', season: work.seasonLabel, teamId: work.teamId },
  );
  if (!parsed.ok) return failItem(ctx, work.key, `the ${genderWord(work.gender)} roster could not be read: ${parsed.failure.message}`);

  const printed = parsed.data.teamName?.trim();
  if (printed !== undefined && printed.length > 0) {
    ctx.rosterNames.set(work.teamId, (ctx.rosterNames.get(work.teamId) ?? new Set<string>()).add(printed));
  }

  const says = parsed.warnings.some((w) => w.code === 'no-roster-posted');
  if (parsed.data.athletes.length === 0 && !says) {
    const codes = parsed.warnings.map((w) => w.code).join(', ') || 'no warnings';
    return failItem(
      ctx,
      work.key,
      `the ${genderWord(work.gender)} roster page lists nobody and does not say that no roster is posted (${codes}), so it is not treated as an empty roster`,
    );
  }
  const collected = collectSwimmerIds([parsed.data.athletes]);
  const notes = notesFor(ctx, work.teamId);
  notes.rosterRowsWithoutSwimmerId += collected.withoutSwimmerId;
  if (parsed.data.athletes.length === 0) notes.emptyRosterGenders.push(work.gender);
  ctx.queue = addSwimmers(currentQueue(ctx), work.teamId, work.gender, collected.swimmerIds);
  ctx.queue = markDone(currentQueue(ctx), work.key);
  return false;
}

/** The endpoint answers JSON. A 2xx body that is not JSON is a challenge page. */
function swimmerProblem(html: string): PageProblem | undefined {
  return looksLikeJson(html) ? undefined : { halt: true, message: NOT_JSON_TEXT };
}

async function runSwimmerWork(ctx: RunContext, work: QueueSwimmerWork, persist: () => Promise<void>): Promise<boolean> {
  const step = planSwimmerFastestTimes(work.swimmerId as SwimCloudSwimmerId);
  const { page, aborted } = await fetchPaced(ctx, step.canonicalUrl, 'swimmerFastestTimes', SWIMMER_TIMES_STAGGER_MS);
  if (aborted) return failItem(ctx, work.key, 'not fetched: the run was cancelled');
  const screen = screenPage(ctx, step.canonicalUrl, 'swimmerFastestTimes', page, swimmerProblem);

  // The one body goes under every team that listed this swimmer: no extra request.
  const subjects = work.attributions.map((a) => teamSubject(a.teamId, a.seasonLabel));
  if (screen.relay && page !== undefined) {
    if (screen.action === 'clean') {
      const stopped = await relayItem(ctx, work.key, subjects, step.canonicalUrl, page);
      if (stopped !== undefined) return stopped;
    } else if ((await relayTo(ctx, subjects, step.canonicalUrl, page)) === 'streak-stop') {
      return haltItem(ctx, work.key, RELAY_STREAK_TEXT);
    }
  }
  if (screen.action !== 'clean') return actOn(ctx, work.key, screen);
  ctx.queue = markDone(currentQueue(ctx), work.key);
  await persist();
  return false;
}

/* -------------------------------------------------------------------------- */
/* Finish                                                                      */
/* -------------------------------------------------------------------------- */

/** Mark each capture. Complete only for a clean run of a team whose pages all landed. */
async function markCaptures(ctx: RunContext, outcome: MultiTeamSummary['outcome']): Promise<void> {
  const seasonDone = new Set<string>();
  if (ctx.queue !== undefined && outcome === 'completed') {
    for (const t of queueProgress(ctx.queue).teams) {
      if (captureHasEveryPlannedPage(ctx, t.teamId, t.seasonLabel)) {
        seasonDone.add(captureIdForSubject(teamSubject(t.teamId, t.seasonLabel)));
      }
    }
  }
  for (const [id, subject] of ctx.usedSubjects) {
    const complete =
      subject.kind === 'team' && subject.season === undefined ? ctx.optionsLanded.get(subject.teamId) === true : seasonDone.has(id);
    const names = subject.kind === 'team' ? ctx.rosterNames.get(subject.teamId) : undefined;
    const label = names?.size === 1 ? [...names][0] : undefined;
    await ctx.deps.markCapture(subject, complete ? 'every-planned-page-fetched' : 'partial', label);
  }
}

/** Flush the downloads fallback for every subject used. Reports only what fell back or failed. */
async function flushAll(ctx: RunContext): Promise<readonly MultiTeamFlushResult[]> {
  if (ctx.usedSubjects.size === 0) return [];
  const results = await ctx.deps.flushDownloads([...ctx.usedSubjects.values()]);
  return results.filter((r) => r.pageCount > 0 || r.error !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

function buildSummary(ctx: RunContext, outcome: MultiTeamSummary['outcome'], downloads: readonly MultiTeamFlushResult[]): MultiTeamSummary {
  const progress = ctx.queue === undefined ? undefined : queueProgress(ctx.queue);
  const teams: MultiTeamTeamSummary[] = ctx.input.teamIds.map((teamId) => {
    const notes = notesFor(ctx, teamId);
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
    const report = ctx.seasonReports.find((r) => r.teamId === teamId);
    if (report === undefined) return { ...base, status: 'not-reached', errors: [] };
    if (report.error !== undefined) return { ...base, status: 'seasons-unreadable', errors: [report.error] };
    return { ...base, status: ctx.choiceAsked ? 'not-chosen' : 'not-reached', errors: [] };
  });
  return {
    outcome,
    ...(ctx.haltMessage === undefined ? {} : { haltMessage: ctx.haltMessage }),
    teams,
    requestedUrls: ctx.requestedUrls,
    downloads,
  };
}
