/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The work queue for a multi-team, season-chosen SwimCloud crawl.
 *
 * Pure state machine: no `chrome.*`, no DOM, no `fetch`, no clock. Every
 * function takes a queue and returns a new queue. The impure loop that does the
 * fetching (not written yet) asks {@link nextWork} for an item, runs it, then
 * calls {@link markDone} or {@link markFailed}.
 *
 * ## What the queue holds
 *
 * - A team with a season the user chose by label. The label must be one of the
 *   options parsed from **that team's own page** (`parseTeamSeasonOptions`). A
 *   team whose page does not offer the label is `season-unavailable`: it gets no
 *   work, and its progress names the labels it does offer.
 * - Roster work: men and women, one URL each (`planTeamSeasonRoster`).
 * - Swimmer work, keyed by swimmer id alone (`swimmer|<id>`). Swimmer ids are
 *   only known after a roster is parsed, so the driver adds them with
 *   {@link addSwimmers}. See "One fetch per swimmer" below.
 *
 * ## One fetch per swimmer
 *
 * The swimmer fetch is `/api/swimmers/{id}/profile_fastest_times/`. It has no
 * team and no season in it. One swimmer on two teams, or on one team in two
 * seasons, is one request. So a swimmer's work key is `swimmer|<id>`, the same
 * dedupe `collectSwimmerIds` in `./swimmerTimes.ts` does across rosters. A team
 * crawled again for another season does not fetch its returning swimmers again.
 *
 * Every `(teamId, seasonId)` pair that listed the swimmer stays on the work
 * item as `attributions`, so progress is still per team: each team counts the
 * shared fetch in its own swimmer totals, and each team gets an error line if it
 * fails. {@link addSwimmers} meeting an existing key appends the pair.
 *
 * **Data caveat for whoever reads the results.** The endpoint returns all-time
 * bests. For a past-season roster that includes swims from LATER seasons. Do not
 * read what was fetched for a past-season roster as that season's times.
 *
 * ## Resume keys are per team and season
 *
 * The fetch is one per swimmer, but the filing is per team: the driver files the
 * one reply under every team that lists the swimmer. So a resume key is
 * `swimmer|<id>|<teamId>|<seasonId>` ({@link swimmerResumeKey}), one per team
 * that has the swimmer's reply. {@link addSwimmers} marks a swimmer
 * `skipped-resumed` only when EVERY team and season listing it has its key. A team
 * that lists the swimmer only in a later run (its roster failed the first time)
 * flips the swimmer back to `pending`: the swimmer is fetched once more, and filed
 * under every team. A skipped swimmer's body was never fetched this run, so it
 * cannot be filed under the missing team alone.
 *
 * Old-shape keys (`swimmer|<id>` alone, or the earlier `swimmer|<team>|<season>|<id>`
 * order) match nothing in practice, so that swimmer is fetched again. That is the
 * safe error.
 *
 * ## One shared concurrency limit
 *
 * `concurrency` is one number for the whole queue. {@link nextWork} counts
 * in-flight work across **all** teams against it. Nothing here multiplies it by
 * the team count, and no team has a limit of its own. Adding teams makes a longer
 * crawl, not a wider one.
 *
 * {@link createQueue} refuses a value above `SWIMMER_TIMES_CONCURRENCY`
 * (`concurrency-too-high`). Roster pages are strictly sequential at 3 s
 * (`boundedFetchPool.ts` header); only swimmer-times fetches may overlap, and
 * their limit is that constant. So {@link nextWork} also never hands out a roster
 * while ANY other work is in flight, and never hands out anything while a roster
 * is in flight, whatever `concurrency` says. (The second half is stricter than
 * the written rule, which only forbids overlapping rosters. It costs nothing at
 * a limit of 1 and keeps a roster page's pacing unshared if the limit is raised.)
 *
 * ## The default is the live pool value, not a literal
 *
 * The default is `SWIMMER_TIMES_CONCURRENCY` from `./swimmerTimes.ts`, the number
 * the real crawl runs at. That is 1: it was lowered from 3 on 2026-09-22 after a
 * 3-lane crawl drew HTTP 429 on 111 of 184 requests. A literal 3 here would loosen
 * pacing. Pacing between starts (`SWIMMER_TIMES_STAGGER_MS`) stays the driver's
 * job through `runBoundedFetchPool`-style gating; this module only decides how
 * many items may be in flight at once.
 *
 * ## Resume
 *
 * `finishedKeys` (keys of work an earlier run finished) makes
 * {@link addSwimmers} mark a matching swimmer `skipped-resumed`, so a restarted
 * crawl does not fetch it again. Roster work is always fetched again, because a
 * fresh roster is the only thing that says who is on the team now; this is the
 * same rule the single-meet crawl follows. Only `done` swimmers are finished:
 * `failed` work is retried on the next run.
 *
 * ## Stop, pause, cancel
 *
 * - Pause: {@link nextWork} hands out nothing. Work in flight finishes.
 * - Cancel: terminal. Nothing more is handed out. Work in flight finishes.
 * - A failure that must stop the whole crawl (a 403 challenge, see
 *   `crawlErrorPolicy.ts`) is reported with `markFailed(..., { haltQueue: true })`.
 *   The queue halts. Every item that halted the queue is remembered.
 *   {@link resumeQueue} clears the halt and puts each of them back to `pending`
 *   if it is still `failed`, because the challenge page was not a real answer
 *   for it. It does not matter whether the driver called {@link retryFailed}
 *   first.
 *
 * ## Rules for the driver (the queue cannot enforce these)
 *
 * 1. **Store the queue that {@link nextWork} returns before any `await`.** The
 *    queue is a value. Calling `nextWork` twice on the same value returns the
 *    same roster twice, because only the returned queue knows it is in flight.
 * 2. **Verify the season before {@link addSwimmers}.** The driver must call
 *    {@link verifyRosterSeason}`(html, work)` on the fetched roster page. If it
 *    returns `{ ok: false }`, call {@link markFailed} with its reason. A server
 *    that ignores `season_id` serves the wrong season, and nothing else notices.
 * 3. **Halt on:** a Cloudflare 403, any 5xx, a network error, and
 *    {@link CONSECUTIVE_429_HALT} consecutive 429 give-ups. {@link shouldHalt}
 *    decides this for one page outcome. On `stop`, call
 *    `markFailed(..., { haltQueue: true })`.
 */

import type { SwimCloudTeamId, SwimCloudSwimmerId } from '@omniswim/swimcloud/entities';
import { planTeamSeasonRoster, type SwimCloudCrawlGender } from '@omniswim/swimcloud/crawlPlan';
import { parseTeamSeasonOptions, resolveSeasonOption, type TeamSeasonOption } from '@omniswim/swimcloud/teamSeasons';
import { classifyCrawlPageOutcome, type SwimCloudCrawlAction, type SwimCloudCrawlPageOutcome } from './crawlErrorPolicy';
import { SWIMMER_TIMES_CONCURRENCY } from './swimmerTimes';

/** The default total in-flight limit: the live pool's value. See the module comment. */
export const MULTI_TEAM_DEFAULT_CONCURRENCY: number = SWIMMER_TIMES_CONCURRENCY;

const NUMERIC_ID = /^[1-9][0-9]{0,17}$/;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** One team the user wants, with the season they chose for it. */
export interface MultiTeamQueueTeamInput {
  readonly teamId: SwimCloudTeamId;
  /** The label the user picked, for example `2025-2026`. */
  readonly seasonLabel: string;
  /** Parsed from THIS team's own page. Never shared between teams. */
  readonly seasonOptions: readonly TeamSeasonOption[];
}

export interface CreateMultiTeamQueueInput {
  readonly teams: readonly MultiTeamQueueTeamInput[];
  /**
   * Total in-flight limit across every team. A positive integer, at most
   * `SWIMMER_TIMES_CONCURRENCY`. Defaults to {@link MULTI_TEAM_DEFAULT_CONCURRENCY}.
   */
  readonly concurrency?: number;
  /** Keys of work an earlier run finished. See the module comment. */
  readonly finishedKeys?: Iterable<string>;
}

export interface QueueRosterWork {
  readonly kind: 'roster';
  readonly key: string;
  readonly teamId: SwimCloudTeamId;
  readonly seasonId: string;
  readonly seasonLabel: string;
  readonly gender: SwimCloudCrawlGender;
  /** From `planTeamSeasonRoster`. */
  readonly canonicalUrl: string;
}

/** One team and season that listed a swimmer. */
export interface QueueSwimmerAttribution {
  readonly teamId: SwimCloudTeamId;
  readonly seasonId: string;
  readonly seasonLabel: string;
}

export interface QueueSwimmerWork {
  readonly kind: 'swimmer';
  /** `swimmer|<id>`: one fetch per swimmer. See {@link swimmerWorkKey}. */
  readonly key: string;
  /** The first team that listed this swimmer. Every team is in {@link attributions}. */
  readonly teamId: SwimCloudTeamId;
  /** The season of {@link teamId}. */
  readonly seasonId: string;
  readonly seasonLabel: string;
  readonly swimmerId: SwimCloudSwimmerId;
  /** Every (team, season) that listed this swimmer, in the order they were added. Never empty. */
  readonly attributions: readonly QueueSwimmerAttribution[];
}

export type QueueWork = QueueRosterWork | QueueSwimmerWork;

export type QueueItemStatus = 'pending' | 'in-flight' | 'done' | 'failed' | 'skipped-resumed';

interface QueueEntry {
  readonly work: QueueWork;
  readonly status: QueueItemStatus;
  readonly error?: string;
}

type QueueTeamState =
  | { readonly kind: 'ready'; readonly season: TeamSeasonOption }
  | { readonly kind: 'season-unavailable'; readonly availableLabels: readonly string[] };

interface QueueTeam {
  readonly teamId: SwimCloudTeamId;
  readonly seasonLabel: string;
  readonly state: QueueTeamState;
  /** Genders whose swimmer list the driver has handed to {@link addSwimmers}. */
  readonly swimmersListedFor: readonly SwimCloudCrawlGender[];
}

/** The whole queue. Treat as opaque; read it through {@link queueProgress}. */
export interface MultiTeamQueue {
  readonly concurrency: number;
  readonly paused: boolean;
  readonly cancelled: boolean;
  /**
   * Set by `markFailed(..., { haltQueue: true })`; cleared by {@link resumeQueue}.
   * `message` is the first halting failure's. `keys` holds every halting item.
   */
  readonly halt?: { readonly message: string; readonly keys: readonly string[] };
  readonly teams: readonly QueueTeam[];
  readonly entries: readonly QueueEntry[];
  readonly finishedKeys: ReadonlySet<string>;
}

export type MultiTeamQueueErrorCode =
  | 'invalid-concurrency'
  | 'concurrency-too-high'
  | 'invalid-429-count'
  | 'invalid-team'
  | 'duplicate-team'
  | 'unknown-team'
  | 'season-unavailable'
  | 'invalid-swimmer-id'
  | 'unknown-key'
  | 'not-in-flight'
  | 'not-failed';

/** Thrown on a call that cannot be honoured. Never returned as an empty result. */
export class MultiTeamQueueError extends Error {
  readonly code: MultiTeamQueueErrorCode;

  constructor(code: MultiTeamQueueErrorCode, detail: string) {
    super(`multiTeamQueue: ${code}: ${detail}`);
    this.name = 'MultiTeamQueueError';
    this.code = code;
  }
}

/** Why {@link nextWork} handed out nothing. */
export type QueueIdleReason =
  | 'cancelled'
  | 'halted'
  | 'paused'
  /** Work is pending, but the shared limit is full, or a roster must run alone. */
  | 'at-concurrency-limit'
  /** Nothing is pending, but work in flight may still add more (a roster adds swimmers). */
  | 'waiting-for-in-flight'
  /** Nothing is pending and nothing is in flight. */
  | 'drained';

export type NextWork =
  | { readonly kind: 'work'; readonly queue: MultiTeamQueue; readonly work: QueueWork }
  | { readonly kind: 'idle'; readonly queue: MultiTeamQueue; readonly reason: QueueIdleReason };

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Work key and resume key for one swimmer. The fetch has no team or season in
 * it, so neither is in the key. Ids are digits, so `|` cannot collide.
 */
export function swimmerWorkKey(swimmerId: SwimCloudSwimmerId): string {
  return `swimmer|${swimmerId}`;
}

/**
 * The resume key for one swimmer under one team and season: the proof that the
 * swimmer's fetched reply was filed under THAT team's capture.
 *
 * The fetch is one per swimmer, but the filing is per team. A swimmer finished
 * for team A is not finished for team B, which may list the swimmer only in a
 * later run (a roster that failed the first time). So a resume key carries the
 * team and season, and {@link addSwimmers} skips a swimmer only when EVERY team
 * that lists it has its key. Old-format keys (`swimmer|<id>` alone, or the
 * earlier `swimmer|<team>|<season>|<id>` order) are never produced by this
 * function for a real swimmer, so they match nothing and the swimmer is fetched
 * again: the safe direction.
 */
export function swimmerResumeKey(swimmerId: SwimCloudSwimmerId, teamId: SwimCloudTeamId, seasonId: string): string {
  return `swimmer|${swimmerId}|${teamId}|${seasonId}`;
}

/** Key for one roster page. */
export function rosterWorkKey(teamId: SwimCloudTeamId, seasonId: string, gender: SwimCloudCrawlGender): string {
  return `roster|${teamId}|${seasonId}|${gender}`;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

function checkConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new MultiTeamQueueError('invalid-concurrency', `${String(value)} is not a positive integer.`);
  }
  if (value > SWIMMER_TIMES_CONCURRENCY) {
    throw new MultiTeamQueueError(
      'concurrency-too-high',
      `${value} is above the swimmer-times limit of ${SWIMMER_TIMES_CONCURRENCY}. Roster pages never overlap, and only swimmer fetches may.`,
    );
  }
  return value;
}

function buildTeam(input: MultiTeamQueueTeamInput): { team: QueueTeam; rosters: QueueEntry[] } {
  if (!NUMERIC_ID.test(input.teamId)) {
    throw new MultiTeamQueueError('invalid-team', `team id ${JSON.stringify(input.teamId)} is not a positive integer.`);
  }
  const season = resolveSeasonOption(input.seasonOptions, input.seasonLabel);
  if (season === undefined) {
    return {
      team: {
        teamId: input.teamId,
        seasonLabel: input.seasonLabel,
        state: { kind: 'season-unavailable', availableLabels: input.seasonOptions.map((o) => o.label) },
        swimmersListedFor: [],
      },
      rosters: [],
    };
  }
  const rosters: QueueEntry[] = planTeamSeasonRoster({ teamId: input.teamId, season }).map((step) => ({
    status: 'pending' as const,
    work: {
      kind: 'roster' as const,
      key: rosterWorkKey(step.teamId, step.seasonId, step.gender),
      teamId: step.teamId,
      seasonId: step.seasonId,
      seasonLabel: season.label,
      gender: step.gender,
      canonicalUrl: step.canonicalUrl,
    },
  }));
  return {
    team: { teamId: input.teamId, seasonLabel: input.seasonLabel, state: { kind: 'ready', season }, swimmersListedFor: [] },
    rosters,
  };
}

/**
 * A new queue. Roster work for every team whose season resolved, men then
 * women, in team order. Throws on a bad team id, a repeated team id, or a bad
 * concurrency. A team whose season is unavailable is kept, with no work.
 */
export function createQueue(input: CreateMultiTeamQueueInput): MultiTeamQueue {
  const concurrency = checkConcurrency(input.concurrency ?? MULTI_TEAM_DEFAULT_CONCURRENCY);
  const seen = new Set<string>();
  const teams: QueueTeam[] = [];
  const entries: QueueEntry[] = [];
  for (const teamInput of input.teams) {
    if (seen.has(teamInput.teamId)) {
      throw new MultiTeamQueueError('duplicate-team', `team ${teamInput.teamId} is listed more than once.`);
    }
    seen.add(teamInput.teamId);
    const built = buildTeam(teamInput);
    teams.push(built.team);
    entries.push(...built.rosters);
  }
  return {
    concurrency,
    paused: false,
    cancelled: false,
    teams,
    entries,
    finishedKeys: new Set(input.finishedKeys ?? []),
  };
}

/**
 * Add the swimmers one roster page listed. Call once per parsed roster, after
 * that roster's work is done.
 *
 * A swimmer already in the queue, for this team or any other, is kept once: the
 * pair (team, season) is added to its `attributions` and nothing else changes,
 * including its status. A swimmer whose key is in `finishedKeys` is added as
 * `skipped-resumed` and is never handed out. Throws for an unknown team, for a team whose season is
 * unavailable (it gets no work), and for an id that is not a positive integer.
 */
export function addSwimmers(
  queue: MultiTeamQueue,
  teamId: SwimCloudTeamId,
  gender: SwimCloudCrawlGender,
  swimmerIds: readonly SwimCloudSwimmerId[],
): MultiTeamQueue {
  const team = queue.teams.find((t) => t.teamId === teamId);
  if (team === undefined) {
    throw new MultiTeamQueueError('unknown-team', `team ${teamId} is not in this queue.`);
  }
  if (team.state.kind !== 'ready') {
    throw new MultiTeamQueueError('season-unavailable', `team ${teamId} has no season ${team.seasonLabel}, so it gets no work.`);
  }
  const season = team.state.season;
  const pair: QueueSwimmerAttribution = { teamId, seasonId: season.seasonId, seasonLabel: season.label };
  const entries = [...queue.entries];
  const indexByKey = new Map(entries.map((e, i) => [e.work.key, i] as const));
  for (const swimmerId of swimmerIds) {
    if (!NUMERIC_ID.test(swimmerId)) {
      throw new MultiTeamQueueError('invalid-swimmer-id', `swimmer id ${JSON.stringify(swimmerId)} is not a positive integer.`);
    }
    const key = swimmerWorkKey(swimmerId);
    const existingIndex = indexByKey.get(key);
    const pairKey = swimmerResumeKey(swimmerId, teamId, season.seasonId);
    if (existingIndex === undefined) {
      indexByKey.set(key, entries.length);
      entries.push({
        status: queue.finishedKeys.has(pairKey) ? 'skipped-resumed' : 'pending',
        work: { kind: 'swimmer', key, teamId, seasonId: season.seasonId, seasonLabel: season.label, swimmerId, attributions: [pair] },
      });
      continue;
    }
    // Already queued for another team or season (or this one): one fetch, one more pair.
    const existing = entries[existingIndex];
    if (existing.work.kind !== 'swimmer') continue;
    const known = existing.work.attributions.some((a) => a.teamId === teamId && a.seasonId === season.seasonId);
    if (known) continue;
    // A swimmer skipped because every earlier team had its key is NOT finished for this team:
    // its reply is in no capture of this team. It goes back to pending. The body of a skipped
    // swimmer was never fetched this run, so the fix is one refetch, filed under every team.
    const status = existing.status === 'skipped-resumed' && !queue.finishedKeys.has(pairKey) ? 'pending' : existing.status;
    entries[existingIndex] = { ...existing, status, work: { ...existing.work, attributions: [...existing.work.attributions, pair] } };
  }
  const listed = team.swimmersListedFor.includes(gender) ? team.swimmersListedFor : [...team.swimmersListedFor, gender];
  return {
    ...queue,
    teams: queue.teams.map((t) => (t === team ? { ...t, swimmersListedFor: listed } : t)),
    entries,
  };
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

function countStatus(queue: MultiTeamQueue, status: QueueItemStatus): number {
  return queue.entries.filter((e) => e.status === status).length;
}

function withStatus(queue: MultiTeamQueue, index: number, entry: QueueEntry): MultiTeamQueue {
  return { ...queue, entries: queue.entries.map((e, i) => (i === index ? entry : e)) };
}

function firstPendingIndex(queue: MultiTeamQueue): number {
  // Rosters first, in plan order: a roster is what tells the crawl who to fetch next.
  const roster = queue.entries.findIndex((e) => e.status === 'pending' && e.work.kind === 'roster');
  if (roster !== -1) return roster;
  return queue.entries.findIndex((e) => e.status === 'pending');
}

function idle(queue: MultiTeamQueue, reason: QueueIdleReason): NextWork {
  return { kind: 'idle', queue, reason };
}

/**
 * The next item to fetch, or why there is none.
 *
 * Hands out one item and marks it `in-flight`. Refuses once `concurrency` items
 * are in flight across all teams. Never hands out a roster while any other work
 * is in flight, and nothing while a roster is in flight. Hands out nothing while paused, halted or cancelled. Rosters come
 * before swimmers; within each, queue order.
 *
 * Pure. Store the returned `queue` before any `await`: this function called
 * again on the queue it was given returns the same item.
 */
export function nextWork(queue: MultiTeamQueue): NextWork {
  if (queue.cancelled) return idle(queue, 'cancelled');
  if (queue.halt !== undefined) return idle(queue, 'halted');
  if (queue.paused) return idle(queue, 'paused');

  const inFlight = countStatus(queue, 'in-flight');
  const index = firstPendingIndex(queue);
  if (index === -1) return idle(queue, inFlight > 0 ? 'waiting-for-in-flight' : 'drained');
  if (inFlight >= queue.concurrency) return idle(queue, 'at-concurrency-limit');

  const entry = queue.entries[index];
  // A roster page runs alone: nothing starts beside it, and it starts beside nothing.
  // Only swimmer fetches may overlap, and only with each other (see the module comment).
  const rosterInFlight = queue.entries.some((e) => e.status === 'in-flight' && e.work.kind === 'roster');
  if (rosterInFlight || (entry.work.kind === 'roster' && inFlight > 0)) return idle(queue, 'at-concurrency-limit');
  return { kind: 'work', queue: withStatus(queue, index, { work: entry.work, status: 'in-flight' }), work: entry.work };
}

function inFlightIndex(queue: MultiTeamQueue, key: string): number {
  const index = queue.entries.findIndex((e) => e.work.key === key);
  if (index === -1) throw new MultiTeamQueueError('unknown-key', `no work has key ${key}.`);
  if (queue.entries[index].status !== 'in-flight') {
    throw new MultiTeamQueueError('not-in-flight', `work ${key} is ${queue.entries[index].status}, not in-flight.`);
  }
  return index;
}

/** The item finished. Allowed while paused, halted or cancelled: work in flight is allowed to finish. */
export function markDone(queue: MultiTeamQueue, key: string): MultiTeamQueue {
  const index = inFlightIndex(queue, key);
  return withStatus(queue, index, { work: queue.entries[index].work, status: 'done' });
}

export interface MarkFailedOptions {
  /** Stop handing out work until {@link resumeQueue}. For a failure the crawl policy says must stop the crawl. */
  readonly haltQueue?: boolean;
}

/** The item failed. `message` is shown on the team's error lines. */
export function markFailed(
  queue: MultiTeamQueue,
  key: string,
  message: string,
  options: MarkFailedOptions = {},
): MultiTeamQueue {
  const index = inFlightIndex(queue, key);
  const next = withStatus(queue, index, { work: queue.entries[index].work, status: 'failed', error: message });
  if (options.haltQueue !== true) return next;
  // A second halting failure (work finishing while the queue halts) is kept
  // beside the first. The first message is the one reported.
  const halt = queue.halt === undefined ? { message, keys: [key] } : { message: queue.halt.message, keys: [...queue.halt.keys, key] };
  return { ...next, halt };
}

/** A failed item goes back to `pending`. Throws if it is not `failed`. */
export function retryFailed(queue: MultiTeamQueue, key: string): MultiTeamQueue {
  const index = queue.entries.findIndex((e) => e.work.key === key);
  if (index === -1) throw new MultiTeamQueueError('unknown-key', `no work has key ${key}.`);
  if (queue.entries[index].status !== 'failed') {
    throw new MultiTeamQueueError('not-failed', `work ${key} is ${queue.entries[index].status}, not failed.`);
  }
  return withStatus(queue, index, { work: queue.entries[index].work, status: 'pending' });
}

export function pauseQueue(queue: MultiTeamQueue): MultiTeamQueue {
  return queue.cancelled ? queue : { ...queue, paused: true };
}

/**
 * Clear Pause and any halt. Each item that caused a halt returns to `pending`
 * if it is still `failed`. An item the driver already put back with
 * {@link retryFailed} is left as it is, so the call order does not matter and
 * never throws. A cancelled queue stays cancelled.
 */
export function resumeQueue(queue: MultiTeamQueue): MultiTeamQueue {
  if (queue.cancelled) return queue;
  const { halt, ...rest } = queue;
  let resumed: MultiTeamQueue = { ...rest, paused: false };
  for (const key of halt?.keys ?? []) {
    const entry = resumed.entries.find((e) => e.work.key === key);
    if (entry?.status === 'failed') resumed = retryFailed(resumed, key);
  }
  return resumed;
}

/** Terminal. Nothing more is handed out. */
export function cancelQueue(queue: MultiTeamQueue): MultiTeamQueue {
  return { ...queue, cancelled: true };
}

/**
 * Resume keys of finished swimmer work (`done` or `skipped-resumed`), one per
 * team and season that lists the swimmer, to carry into the next run's
 * `finishedKeys`. See {@link swimmerResumeKey}.
 */
export function finishedSwimmerKeys(queue: MultiTeamQueue): readonly string[] {
  return queue.entries.flatMap((e) =>
    e.work.kind === 'swimmer' && (e.status === 'done' || e.status === 'skipped-resumed')
      ? e.work.attributions.map((a) => swimmerResumeKey(e.work.kind === 'swimmer' ? e.work.swimmerId : '', a.teamId, a.seasonId))
      : [],
  );
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export interface QueueCounts {
  readonly total: number;
  readonly pending: number;
  readonly inFlight: number;
  readonly done: number;
  readonly failed: number;
  readonly skippedResumed: number;
}

export type QueueTeamStatus =
  | 'season-unavailable'
  /** Nothing started yet. */
  | 'queued'
  /** Work is pending or in flight, or a roster is parsed and its swimmers are not yet added. */
  | 'running'
  | 'done'
  | 'done-with-errors';

export interface QueueTeamProgress {
  readonly teamId: SwimCloudTeamId;
  readonly seasonLabel: string;
  /** Absent for `season-unavailable`. Never guessed. */
  readonly seasonId?: string;
  readonly status: QueueTeamStatus;
  /** Present only for `season-unavailable`: the labels this team's own page offers. */
  readonly availableLabels?: readonly string[];
  readonly rosters: QueueCounts;
  readonly swimmers: QueueCounts;
  /** One line per failure, or per unavailable season. Ready to print. */
  readonly errorLines: readonly string[];
}

export interface QueueProgress {
  readonly concurrency: number;
  readonly inFlight: number;
  readonly paused: boolean;
  readonly cancelled: boolean;
  readonly haltMessage?: string;
  readonly teams: readonly QueueTeamProgress[];
}

function counts(entries: readonly QueueEntry[]): QueueCounts {
  const of = (status: QueueItemStatus): number => entries.filter((e) => e.status === status).length;
  return {
    total: entries.length,
    pending: of('pending'),
    inFlight: of('in-flight'),
    done: of('done'),
    failed: of('failed'),
    skippedResumed: of('skipped-resumed'),
  };
}

function isForTeam(entry: QueueEntry, teamId: SwimCloudTeamId): boolean {
  return entry.work.kind === 'swimmer' ? entry.work.attributions.some((a) => a.teamId === teamId) : entry.work.teamId === teamId;
}

function entryErrorLine(team: QueueTeam, entry: QueueEntry): string {
  const subject = entry.work.kind === 'roster' ? `${entry.work.gender === 'M' ? 'men' : 'women'}'s roster` : `swimmer ${entry.work.swimmerId}`;
  return `Team ${team.teamId} · ${team.seasonLabel} · ${subject}: ${entry.error ?? 'failed'}`;
}

function teamStatus(rosters: QueueCounts, swimmers: QueueCounts, awaitingSwimmerList: boolean): QueueTeamStatus {
  const started = rosters.inFlight + rosters.done + rosters.failed + swimmers.inFlight + swimmers.done + swimmers.failed > 0;
  const open = rosters.pending + rosters.inFlight + swimmers.pending + swimmers.inFlight > 0 || awaitingSwimmerList;
  if (open) return started ? 'running' : 'queued';
  return rosters.failed + swimmers.failed > 0 ? 'done-with-errors' : 'done';
}

function teamProgress(queue: MultiTeamQueue, team: QueueTeam): QueueTeamProgress {
  if (team.state.kind === 'season-unavailable') {
    const labels = team.state.availableLabels;
    const offered = labels.length === 0 ? 'none read from this team\'s page' : labels.join(', ');
    return {
      teamId: team.teamId,
      seasonLabel: team.seasonLabel,
      status: 'season-unavailable',
      availableLabels: labels,
      rosters: counts([]),
      swimmers: counts([]),
      errorLines: [`Team ${team.teamId} · season ${team.seasonLabel} is not offered on this team's page. Available: ${offered}. Nothing is fetched for this team.`],
    };
  }
  // A shared swimmer fetch counts for every team that listed it.
  const mine = queue.entries.filter((e) => isForTeam(e, team.teamId));
  const rosterEntries = mine.filter((e) => e.work.kind === 'roster');
  const swimmerEntries = mine.filter((e) => e.work.kind === 'swimmer');
  const rosters = counts(rosterEntries);
  const swimmers = counts(swimmerEntries);
  // A roster that is done but whose swimmers were never handed to addSwimmers
  // would read as a finished team. It is not: its swimmers are unknown.
  const awaitingSwimmerList = rosterEntries.some(
    (e) => e.status === 'done' && e.work.kind === 'roster' && !team.swimmersListedFor.includes(e.work.gender),
  );
  return {
    teamId: team.teamId,
    seasonLabel: team.seasonLabel,
    seasonId: team.state.season.seasonId,
    status: teamStatus(rosters, swimmers, awaitingSwimmerList),
    rosters,
    swimmers,
    errorLines: mine.filter((e) => e.status === 'failed').map((e) => entryErrorLine(team, e)),
  };
}

/** Per-team counts, status and error lines, plus the queue-level flags. */
export function queueProgress(queue: MultiTeamQueue): QueueProgress {
  return {
    concurrency: queue.concurrency,
    inFlight: countStatus(queue, 'in-flight'),
    paused: queue.paused,
    cancelled: queue.cancelled,
    ...(queue.halt === undefined ? {} : { haltMessage: queue.halt.message }),
    teams: queue.teams.map((team) => teamProgress(queue, team)),
  };
}

/* -------------------------------------------------------------------------- */
/* Driver helpers                                                              */
/* -------------------------------------------------------------------------- */

export type RosterSeasonCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Check that a fetched roster page is for the season the work asked for.
 *
 * The page prints a `<select name="season_id">` with the season it shows marked
 * `selected`. That must be `work.seasonId`. Anything else is `{ ok: false }`
 * with a reason: a different season, no season selected (the page ignored
 * `season_id` and shows "All Seasons"), two selected, or a page that has no
 * season select at all (a challenge page). It never throws for a bad page.
 * Call it before {@link addSwimmers}. On `{ ok: false }`, call {@link markFailed}.
 */
export function verifyRosterSeason(html: string, work: Pick<QueueRosterWork, 'seasonId' | 'seasonLabel'>): RosterSeasonCheck {
  let selected: readonly TeamSeasonOption[];
  try {
    selected = parseTeamSeasonOptions(html).filter((option) => option.selected);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `The roster page's season list could not be read, so its season is not verified: ${detail}` };
  }
  if (selected.length === 0) {
    return { ok: false, reason: `The roster page selects no season. It was asked for season ${work.seasonLabel} (id ${work.seasonId}).` };
  }
  const shown = selected[0];
  if (shown.seasonId !== work.seasonId) {
    return {
      ok: false,
      reason: `The roster page shows season ${shown.label} (id ${shown.seasonId}). It was asked for season ${work.seasonLabel} (id ${work.seasonId}).`,
    };
  }
  return { ok: true };
}

/** Consecutive pages given up on after HTTP 429 that stop the crawl. */
export const CONSECUTIVE_429_HALT = 3;

/**
 * Whether one page's outcome stops the whole crawl.
 *
 * Reuses `classifyCrawlPageOutcome` (`crawlErrorPolicy.ts`): a 403, any 5xx and
 * a network error stop. It adds one rule: a page given up on after HTTP 429
 * (see `rateLimitBackoff.ts`) stops the crawl when it is the
 * {@link CONSECUTIVE_429_HALT}th in a row.
 *
 * `outcome` is the page's final outcome, after any 429 retries.
 * `recent429Count` is how many pages in a row were given up on after a 429
 * BEFORE this one. The driver resets it to 0 on any other outcome. A 429
 * outcome counts itself, so `recent429Count: 2` plus a 429 is the third.
 * Throws for a count that is not a non-negative integer.
 */
export function shouldHalt(outcome: SwimCloudCrawlPageOutcome, recent429Count: number): SwimCloudCrawlAction {
  if (!Number.isInteger(recent429Count) || recent429Count < 0) {
    throw new MultiTeamQueueError('invalid-429-count', `${String(recent429Count)} is not a non-negative integer.`);
  }
  const policy = classifyCrawlPageOutcome(outcome);
  if (policy.action === 'stop') return policy;
  if (outcome.kind === 'http-status' && outcome.httpStatus === 429 && recent429Count + 1 >= CONSECUTIVE_429_HALT) {
    return {
      action: 'stop',
      retryable: true,
      message: `SwimCloud rate-limited ${CONSECUTIVE_429_HALT} pages in a row. Wait a while, then Resume.`,
    };
  }
  return policy;
}
