/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The loop of a multi-team, season-chosen SwimCloud crawl.
 *
 * All I/O is injected through {@link MultiTeamDriverDeps}: the fetch, the relay
 * to the background worker, the clock, the sleep, the saved resume keys, the
 * progress sink and the season chooser. This module has no `chrome.*`, no DOM,
 * no `fetch` and no timers of its own, so the whole flow runs in a test against
 * archived pages with a fake clock. The thin impure half is `multiTeamPanel.ts`.
 *
 * ## Flow
 *
 * 1. **Seasons.** For each team, fetch `/team/{id}/roster/?gender=M` (no
 *    `season_id`) and read the season select from THAT page with
 *    `parseTeamSeasonOptions`. Options are never shared between teams. The
 *    options go to `deps.chooseSeasons`; the answer is one season label per team.
 * 2. **Queue.** `createQueue` with the choices and the saved finished keys.
 *    A team whose label its own page does not offer is `season-unavailable` and
 *    gets no fetch at all.
 * 3. **Loop.** `nextWork` hands out one item at a time (concurrency is 1; the
 *    queue refuses more). The returned queue is stored before any `await`
 *    (queue rule 1). A roster page is checked with `verifyRosterSeason` before
 *    it is relayed or parsed (rule 2). A swimmer item fetches
 *    `/api/swimmers/{id}/profile_fastest_times/` once per swimmer id.
 * 4. **Halt.** Every page outcome goes through `shouldHalt` (rule 3). A halt calls
 *    `markFailed(..., { haltQueue: true })` and the run ends. A 403 is never
 *    retried.
 *
 * ## Pacing (unchanged, read from the constants)
 *
 * Before every request the driver waits until the request would start at least
 * `MIN_DELAY_MS` (roster and season pages) or `SWIMMER_TIMES_STAGGER_MS`
 * (swimmer fetches) after the previous request started. A 429 is retried with
 * `decideRateLimitRetry`, which only ever waits longer. No concurrency is added.
 *
 * ## The denylist
 *
 * Every URL is classified by `classifySwimCloudUrl` before it is fetched and
 * must be `fetchable` and of the kind the step expects. Anything else throws
 * {@link MultiTeamDriverError} and nothing is fetched.
 *
 * ## Rules the driver bends or adds (stated so a reviewer can check them)
 *
 * - A roster page whose season does not verify is NOT relayed. Relaying it under
 *   the chosen season's capture would file another season's roster there.
 * - A swimmer body that is not JSON halts the run and is not relayed. The
 *   endpoint returns JSON, so another body is a challenge page, not a result.
 * - The swimmer page outcome uses `shouldHalt` (5xx and network errors halt), the
 *   stricter queue rule, not the more forgiving `classifySwimmerTimesOutcome`.
 * - The saved finished keys are the union of the keys loaded and the keys this
 *   run finished, so a swimmer on no chosen roster this run is not forgotten.
 */

import type { SwimCloudCaptureSubject, SwimCloudSwimmerId, SwimCloudTeamId } from '@omniswim/swimcloud/entities';
import { planSwimmerFastestTimes, planTeamRosterPage, type SwimCloudCrawlGender } from '@omniswim/swimcloud/crawlPlan';
import { parseTeamRosterHtml } from '@omniswim/swimcloud/parser';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { parseTeamSeasonOptions, type TeamSeasonOption } from '@omniswim/swimcloud/teamSeasons';
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

/** What one fetch returned. Same shape as the content script's `FetchedPage`. */
export interface MultiTeamFetchedPage {
  readonly html: string;
  readonly httpStatus: number;
  readonly retryAfter?: string;
}

/** How one relay round trip ended. Same words as the content script's `RelayOutcome`. */
export type MultiTeamRelayOutcome = 'landed' | 'lost' | 'streak-stop';

export interface MultiTeamRelayRequest {
  readonly subject: SwimCloudCaptureSubject;
  readonly sourceUrl: string;
  readonly httpStatus: number;
  readonly html: string;
}

/** Flags the panel flips. The driver reads them between items and never writes them. */
export interface MultiTeamControl {
  cancelled: boolean;
  paused: boolean;
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
  sleep(ms: number): Promise<void>;
  /** Milliseconds, monotonic enough for pacing. */
  now(): number;
  /** ISO-8601 instant for parse provenance. */
  isoNow(): string;
  loadFinished(): Promise<readonly string[]>;
  saveFinished(keys: readonly string[]): Promise<void>;
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

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function looksLikeJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function genderWord(gender: SwimCloudCrawlGender): string {
  return gender === 'M' ? "men's" : "women's";
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

interface FetchResult {
  readonly page: MultiTeamFetchedPage | undefined;
}

interface TeamNotes {
  rosterRowsWithoutSwimmerId: number;
  emptyRosterGenders: SwimCloudCrawlGender[];
}

/**
 * Run the whole crawl. Resolves with a summary when the run completes, is
 * cancelled, or halts itself. Rejects only for a bug or a denylist hit
 * ({@link MultiTeamDriverError}) and for whatever a dependency throws.
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
  let lastRequestStartMs: number | undefined;
  let recent429 = 0;
  let choiceAsked = false;

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

  /** One paced request: wait for the gap, check the denylist, fetch, retry only on 429. */
  const fetchPaced = async (url: string, expected: ExpectedKind, gapMs: number): Promise<FetchResult> => {
    assertFetchableUrl(url, expected);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (lastRequestStartMs !== undefined) {
        const elapsed = deps.now() - lastRequestStartMs;
        if (elapsed < gapMs) await deps.sleep(gapMs - elapsed);
      }
      lastRequestStartMs = deps.now();
      requestedUrls.push(url);
      const page = await deps.fetchPage(url);
      if (page === undefined || page.httpStatus !== RATE_LIMITED_STATUS) return { page };

      const decision = decideRateLimitRetry(attempt, page.retryAfter, deps.now());
      notice = formatRateLimitWaitLine(url, decision);
      emit();
      if (decision.action === 'give-up' || control.cancelled) return { page };
      await deps.sleep(decision.waitMs);
    }
  };

  /** Final outcome of one page to the halt rule. Updates the 429 streak. */
  const haltDecision = (page: MultiTeamFetchedPage | undefined): { stop: true; message: string } | { stop: false } => {
    const outcome = page === undefined ? ({ kind: 'network-error' } as const) : ({ kind: 'http-status', httpStatus: page.httpStatus } as const);
    const action = shouldHalt(outcome, recent429);
    recent429 = outcome.kind === 'http-status' && outcome.httpStatus === RATE_LIMITED_STATUS ? recent429 + 1 : 0;
    return action.action === 'stop' ? { stop: true, message: action.message } : { stop: false };
  };

  /* ---- The three steps, in order -------------------------------------- */

  emit();
  await readSeasonLists();
  readingTeamId = undefined;
  const choices = await askForChoices();

  let endedBy: MultiTeamSummary['outcome'] = haltMessage !== undefined ? 'halted' : control.cancelled ? 'cancelled' : 'completed';
  if (endedBy === 'completed' && choices.length > 0) endedBy = await crawlQueue(choices);
  phase = 'finished';
  haltMessage = haltMessage ?? queue?.halt?.message;
  notice = undefined;
  emit();
  return buildSummary(endedBy);

  /* ---- Step 1: each team's own season list ---------------------------- */

  async function readSeasonLists(): Promise<void> {
    for (const teamId of input.teamIds) {
      if (!(await gate())) return;
      readingTeamId = teamId;
      emit();
      const step = planTeamRosterPage(teamId, 'M');
      const { page } = await fetchPaced(step.canonicalUrl, 'teamRoster', MIN_DELAY_MS);
      notice = undefined;

      if (page !== undefined) {
        const relayed = await deps.relay({ subject: teamSubject(teamId), sourceUrl: step.canonicalUrl, httpStatus: page.httpStatus, html: page.html });
        if (relayed === 'streak-stop') {
          haltMessage = 'Several pages in a row could not be handed to the Omniswim app. Stopping so nothing more is fetched into the void.';
          seasonReports.push({ teamId, error: haltMessage });
          return;
        }
      }
      const verdict = haltDecision(page);
      if (verdict.stop) {
        haltMessage = verdict.message;
        seasonReports.push({ teamId, error: verdict.message });
        return;
      }
      seasonReports.push(reportSeasons(teamId, page));
    }
  }

  function reportSeasons(teamId: SwimCloudTeamId, page: MultiTeamFetchedPage | undefined): TeamSeasonOptionsReport {
    if (page === undefined || !isOkStatus(page.httpStatus)) {
      return { teamId, error: `The season page for team ${teamId} returned HTTP ${page?.httpStatus ?? 'no response'}.` };
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
    const finishedAtStart = await deps.loadFinished();
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

    const persistFinished = async (): Promise<void> => {
      await deps.saveFinished([...new Set([...finishedAtStart, ...finishedSwimmerKeys(currentQueue())])]);
    };

    for (;;) {
      if (!(await gate())) {
        queue = cancelQueue(currentQueue());
        return 'cancelled';
      }
      const next = nextWork(currentQueue());
      queue = next.queue; // Stored before any await: queue rule 1.
      if (next.kind === 'idle') return idleOutcome(next.reason);
      notice = undefined;
      emit();

      const work = next.work;
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


  /* ---- Work items ------------------------------------------------------ */

  function currentQueue(): MultiTeamQueue {
    if (queue === undefined) throw new MultiTeamDriverError('queue-invariant', 'no queue.');
    return queue;
  }

  /** Mark the item failed and halt. Returns true. */
  function halt(key: string, message: string): true {
    queue = markFailed(currentQueue(), key, message, { haltQueue: true });
    haltMessage = haltMessage ?? message;
    return true;
  }

  async function runRosterWork(work: QueueRosterWork): Promise<boolean> {
    const { page } = await fetchPaced(work.canonicalUrl, 'teamRoster', MIN_DELAY_MS);
    const subject = teamSubject(work.teamId, work.seasonLabel);

    // A 2xx page for the wrong season is not relayed: it would be filed under the chosen season.
    let seasonProblem: string | undefined;
    if (page !== undefined && isOkStatus(page.httpStatus)) {
      const check = verifyRosterSeason(page.html, work);
      if (!check.ok) seasonProblem = check.reason;
    }
    if (page !== undefined && seasonProblem === undefined) {
      const relayed = await deps.relay({ subject, sourceUrl: work.canonicalUrl, httpStatus: page.httpStatus, html: page.html });
      if (relayed === 'streak-stop') {
        return halt(work.key, 'Several pages in a row could not be handed to the Omniswim app. Resume when it is reachable.');
      }
    }

    const verdict = haltDecision(page);
    if (verdict.stop) return halt(work.key, verdict.message);
    if (page === undefined) return failItem(work.key, 'no response');
    if (!isOkStatus(page.httpStatus)) {
      return failItem(work.key, page.httpStatus === RATE_LIMITED_STATUS ? 'rate-limited (HTTP 429) after retries' : `HTTP ${page.httpStatus}`);
    }
    if (seasonProblem !== undefined) return failItem(work.key, seasonProblem);

    const parsed = parseTeamRosterHtml(
      page.html,
      { sourceUrl: work.canonicalUrl, retrievedAt: deps.isoNow(), track: 'browser-extension' },
      { gender: work.gender === 'M' ? 'Men' : 'Women', season: work.seasonLabel, teamId: work.teamId },
    );
    if (!parsed.ok) {
      return failItem(work.key, `the ${genderWord(work.gender)} roster could not be read: ${parsed.failure.message}`);
    }
    const collected = collectSwimmerIds([parsed.data.athletes]);
    const notes = notesFor(work.teamId);
    notes.rosterRowsWithoutSwimmerId += collected.withoutSwimmerId;
    if (parsed.data.athletes.length === 0) notes.emptyRosterGenders.push(work.gender);
    queue = addSwimmers(currentQueue(), work.teamId, work.gender, collected.swimmerIds);
    queue = markDone(currentQueue(), work.key);
    return false;
  }

  async function runSwimmerWork(work: QueueSwimmerWork, persist: () => Promise<void>): Promise<boolean> {
    const step = planSwimmerFastestTimes(work.swimmerId as SwimCloudSwimmerId);
    const { page } = await fetchPaced(step.canonicalUrl, 'swimmerFastestTimes', SWIMMER_TIMES_STAGGER_MS);

    // The endpoint answers JSON. A 2xx body that is not JSON is a challenge page.
    if (page !== undefined && isOkStatus(page.httpStatus) && !looksLikeJson(page.html)) {
      recent429 = 0;
      return halt(work.key, 'SwimCloud answered the swimmer-times request with a page that is not JSON. Refresh your SwimCloud session in this tab, then Resume.');
    }
    if (page !== undefined) {
      const relayed = await deps.relay({
        subject: teamSubject(work.teamId, work.seasonLabel),
        sourceUrl: step.canonicalUrl,
        httpStatus: page.httpStatus,
        html: page.html,
      });
      if (relayed === 'streak-stop') {
        return halt(work.key, 'Several pages in a row could not be handed to the Omniswim app. Resume when it is reachable.');
      }
    }

    const verdict = haltDecision(page);
    if (verdict.stop) return halt(work.key, verdict.message);
    if (page === undefined) return failItem(work.key, 'no response');
    if (!isOkStatus(page.httpStatus)) {
      return failItem(work.key, page.httpStatus === RATE_LIMITED_STATUS ? 'rate-limited (HTTP 429) after retries' : `HTTP ${page.httpStatus}`);
    }
    queue = markDone(currentQueue(), work.key);
    await persist();
    return false;
  }

  /** Mark one item failed without halting. Returns false: the run goes on. */
  function failItem(key: string, message: string): false {
    queue = markFailed(currentQueue(), key, message);
    return false;
  }

  /* ---- Summary --------------------------------------------------------- */

  function buildSummary(outcome: 'completed' | 'cancelled' | 'halted'): MultiTeamSummary {
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
        const status: MultiTeamTeamStatus = queued.status === 'season-unavailable' ? 'season-unavailable' : queued.status;
        return {
          ...base,
          status,
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
    };
  }
}
