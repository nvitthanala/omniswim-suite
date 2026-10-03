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
 * - Swimmer work, keyed `(teamId, seasonId, swimmerId)`. Swimmer ids are only
 *   known after a roster is parsed, so the driver adds them with
 *   {@link addSwimmers}.
 *
 * ## One shared concurrency limit
 *
 * `concurrency` is one number for the whole queue. {@link nextWork} counts
 * in-flight work across **all** teams against it. Nothing here multiplies it by
 * the team count, and no team has a limit of its own. Adding teams makes a longer
 * crawl, not a wider one.
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
 *   The queue halts. {@link resumeQueue} clears the halt and puts that one item
 *   back to `pending`, because the challenge page was not a real answer for it.
 */

import type { SwimCloudTeamId, SwimCloudSwimmerId } from '@omniswim/swimcloud/entities';
import { planTeamSeasonRoster, type SwimCloudCrawlGender } from '@omniswim/swimcloud/crawlPlan';
import { resolveSeasonOption, type TeamSeasonOption } from '@omniswim/swimcloud/teamSeasons';
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
  /** Total in-flight limit across every team. A positive integer. Defaults to {@link MULTI_TEAM_DEFAULT_CONCURRENCY}. */
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

export interface QueueSwimmerWork {
  readonly kind: 'swimmer';
  readonly key: string;
  readonly teamId: SwimCloudTeamId;
  readonly seasonId: string;
  readonly seasonLabel: string;
  readonly swimmerId: SwimCloudSwimmerId;
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
  /** Set by `markFailed(..., { haltQueue: true })`; cleared by {@link resumeQueue}. */
  readonly halt?: { readonly message: string; readonly key: string };
  readonly teams: readonly QueueTeam[];
  readonly entries: readonly QueueEntry[];
  readonly finishedKeys: ReadonlySet<string>;
}

export type MultiTeamQueueErrorCode =
  | 'invalid-concurrency'
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
  /** Work is pending, but the shared limit is full. */
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

/** Resume key for one swimmer of one team in one season. Ids are digits, so `|` cannot collide. */
export function swimmerWorkKey(teamId: SwimCloudTeamId, seasonId: string, swimmerId: SwimCloudSwimmerId): string {
  return `swimmer|${teamId}|${seasonId}|${swimmerId}`;
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
 * A swimmer already in the queue for this team and season is kept once. A
 * swimmer whose key is in `finishedKeys` is added as `skipped-resumed` and is
 * never handed out. Throws for an unknown team, for a team whose season is
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
  const present = new Set(queue.entries.map((e) => e.work.key));
  const added: QueueEntry[] = [];
  for (const swimmerId of swimmerIds) {
    if (!NUMERIC_ID.test(swimmerId)) {
      throw new MultiTeamQueueError('invalid-swimmer-id', `swimmer id ${JSON.stringify(swimmerId)} is not a positive integer.`);
    }
    const key = swimmerWorkKey(teamId, season.seasonId, swimmerId);
    if (present.has(key)) continue;
    present.add(key);
    added.push({
      status: queue.finishedKeys.has(key) ? 'skipped-resumed' : 'pending',
      work: { kind: 'swimmer', key, teamId, seasonId: season.seasonId, seasonLabel: season.label, swimmerId },
    });
  }
  const listed = team.swimmersListedFor.includes(gender) ? team.swimmersListedFor : [...team.swimmersListedFor, gender];
  return {
    ...queue,
    teams: queue.teams.map((t) => (t === team ? { ...t, swimmersListedFor: listed } : t)),
    entries: [...queue.entries, ...added],
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
 * are in flight across all teams. Hands out nothing while paused, halted or
 * cancelled. Rosters come before swimmers; within each, queue order.
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
  return options.haltQueue === true ? { ...next, halt: { message, key } } : next;
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
 * Clear Pause and any halt. The item that caused a halt returns to `pending`.
 * A cancelled queue stays cancelled.
 */
export function resumeQueue(queue: MultiTeamQueue): MultiTeamQueue {
  if (queue.cancelled) return queue;
  const { halt, ...rest } = queue;
  const resumed: MultiTeamQueue = { ...rest, paused: false };
  return halt === undefined ? resumed : retryFailed(resumed, halt.key);
}

/** Terminal. Nothing more is handed out. */
export function cancelQueue(queue: MultiTeamQueue): MultiTeamQueue {
  return { ...queue, cancelled: true };
}

/** Keys of finished swimmer work (`done` or `skipped-resumed`), to carry into the next run's `finishedKeys`. */
export function finishedSwimmerKeys(queue: MultiTeamQueue): readonly string[] {
  return queue.entries
    .filter((e) => e.work.kind === 'swimmer' && (e.status === 'done' || e.status === 'skipped-resumed'))
    .map((e) => e.work.key);
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
  const mine = queue.entries.filter((e) => e.work.teamId === team.teamId);
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
