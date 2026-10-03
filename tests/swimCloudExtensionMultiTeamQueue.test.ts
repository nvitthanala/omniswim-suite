/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `extensions/swimcloud-companion/src/multiTeamQueue.ts`: the pure queue for a
 * multi-team, season-chosen crawl. No `chrome.*`, no network, no timers.
 *
 * Season options come from the real captured roster filter forms (see
 * `tests/swimcloudTeamSeasons.test.ts` for their provenance). A team with a
 * different table is made by changing the real slice with `replace`:
 *
 * - TEAM_A: team 412's own table (`2025-2026` is id 29).
 * - TEAM_B: the same page with ids renumbered, so `2025-2026` is id 91. A queue
 *   that shared one team's id with another would send B to season 29.
 * - TEAM_C: the same page with `2025-2026` removed, so C cannot be crawled for it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SWIMCLOUD_CHALLENGE_MESSAGE, classifyCrawlPageOutcome } from '../extensions/swimcloud-companion/src/crawlErrorPolicy';
import { parseTeamSeasonOptions } from '../packages/swimcloud/src/teamSeasons';
import { SWIMMER_TIMES_CONCURRENCY } from '../extensions/swimcloud-companion/src/swimmerTimes';
import {
  MULTI_TEAM_DEFAULT_CONCURRENCY,
  CONSECUTIVE_429_HALT,
  MultiTeamQueueError,
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
  retryFailed,
  rosterWorkKey,
  shouldHalt,
  swimmerWorkKey,
  verifyRosterSeason,
  type MultiTeamQueue,
  type MultiTeamQueueErrorCode,
  type MultiTeamQueueTeamInput,
  type QueueRosterWork,
  type QueueWork,
} from '../extensions/swimcloud-companion/src/multiTeamQueue';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swimcloud');
const REAL_FORM = readFileSync(join(fixturesDir, 'team-412-roster-gender-F-season-form.html'), 'utf8');

const OPTIONS_A = parseTeamSeasonOptions(REAL_FORM);
const OPTIONS_B = parseTeamSeasonOptions(REAL_FORM.replace('<option value="29" selected>', '<option value="91" selected>'));
const OPTIONS_C = parseTeamSeasonOptions(REAL_FORM.replace('<option value="29" selected>2025-2026</option>', ''));

const teamA = (label = '2025-2026'): MultiTeamQueueTeamInput => ({ teamId: '412', seasonLabel: label, seasonOptions: OPTIONS_A });
const teamB = (label = '2025-2026'): MultiTeamQueueTeamInput => ({ teamId: '58', seasonLabel: label, seasonOptions: OPTIONS_B });
const teamC = (label = '2025-2026'): MultiTeamQueueTeamInput => ({ teamId: '48', seasonLabel: label, seasonOptions: OPTIONS_C });

function errorCode(run: () => unknown): MultiTeamQueueErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof MultiTeamQueueError) return error.code;
    throw error;
  }
  throw new Error('expected a MultiTeamQueueError');
}

/** Hand out the next item or fail the test. */
function lease(queue: MultiTeamQueue): { queue: MultiTeamQueue; work: QueueWork } {
  const next = nextWork(queue);
  if (next.kind !== 'work') throw new Error(`expected work, got idle: ${next.reason}`);
  return { queue: next.queue, work: next.work };
}

function idleReason(queue: MultiTeamQueue): string {
  const next = nextWork(queue);
  if (next.kind !== 'idle') throw new Error('expected idle, got work');
  return next.reason;
}

/**
 * TEST ONLY. `createQueue` refuses a concurrency above SWIMMER_TIMES_CONCURRENCY,
 * so a test of the in-flight rules (shared limit, roster exclusivity, two
 * failures at once) widens a queue it built through the API. The queue is a plain
 * readonly record, so a spread is a valid value of its type.
 */
function widen(queue: MultiTeamQueue, concurrency: number): MultiTeamQueue {
  return { ...queue, concurrency };
}

/** Lease and finish every roster, one at a time, and list the swimmers each roster holds. */
function finishRosters(start: MultiTeamQueue, swimmersByRoster: Readonly<Record<string, readonly string[]>>): MultiTeamQueue {
  let queue = start;
  for (;;) {
    const next = nextWork(queue);
    // Rosters come first, so the first non-roster item means every roster is done.
    if (next.kind === 'idle' || next.work.kind !== 'roster') return queue;
    queue = addSwimmers(markDone(next.queue, next.work.key), next.work.teamId, next.work.gender, swimmersByRoster[next.work.key] ?? []);
  }
}

/** Lease, finish and (for a roster) list swimmers, one item at a time, until drained. Returns the keys in order. */
function runAll(
  start: MultiTeamQueue,
  swimmersByRoster: Readonly<Record<string, readonly string[]>>,
): { queue: MultiTeamQueue; order: string[] } {
  let queue = start;
  const order: string[] = [];
  for (let guard = 0; guard < 10_000; guard += 1) {
    const next = nextWork(queue);
    if (next.kind === 'idle') {
      expect(next.reason).toBe('drained');
      return { queue, order };
    }
    queue = markDone(next.queue, next.work.key);
    order.push(next.work.key);
    if (next.work.kind === 'roster') {
      queue = addSwimmers(queue, next.work.teamId, next.work.gender, swimmersByRoster[next.work.key] ?? []);
    }
  }
  throw new Error('queue did not drain');
}

describe('createQueue: each team resolves its season from its own options', () => {
  it('plans men then women rosters per team, in team order, with each team\'s own season id', () => {
    let queue = createQueue({ teams: [teamA(), teamB()] });
    const leased: QueueWork[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = lease(queue);
      queue = markDone(next.queue, next.work.key);
      leased.push(next.work);
    }
    expect(leased.map((w) => w.key)).toStrictEqual([
      rosterWorkKey('412', '29', 'M'),
      rosterWorkKey('412', '29', 'F'),
      rosterWorkKey('58', '91', 'M'),
      rosterWorkKey('58', '91', 'F'),
    ]);
    expect(leased.map((w) => (w.kind === 'roster' ? w.canonicalUrl : ''))).toStrictEqual([
      'https://www.swimcloud.com/team/412/roster/?page=1&gender=M&season_id=29&sort=name',
      'https://www.swimcloud.com/team/412/roster/?page=1&gender=F&season_id=29&sort=name',
      'https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=91&sort=name',
      'https://www.swimcloud.com/team/58/roster/?page=1&gender=F&season_id=91&sort=name',
    ]);
  });

  it('keeps unrelated seasons separate: the same label on two teams yields two ids', () => {
    const progress = queueProgress(createQueue({ teams: [teamA(), teamB()] }));
    expect(progress.teams.map((t) => [t.teamId, t.seasonId])).toStrictEqual([
      ['412', '29'],
      ['58', '91'],
    ]);
  });

  it('rejects a repeated team, a bad team id and a bad concurrency', () => {
    expect(errorCode(() => createQueue({ teams: [teamA(), teamA('2024-2025')] }))).toBe('duplicate-team');
    expect(errorCode(() => createQueue({ teams: [{ ...teamA(), teamId: '04x' }] }))).toBe('invalid-team');
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorCode(() => createQueue({ teams: [teamA()], concurrency }))).toBe('invalid-concurrency');
    }
  });

  it('refuses a concurrency above the live swimmer-times limit, and accepts the limit itself', () => {
    for (const concurrency of [SWIMMER_TIMES_CONCURRENCY + 1, SWIMMER_TIMES_CONCURRENCY + 49, 99]) {
      expect(errorCode(() => createQueue({ teams: [teamA()], concurrency }))).toBe('concurrency-too-high');
    }
    expect(createQueue({ teams: [teamA()], concurrency: SWIMMER_TIMES_CONCURRENCY }).concurrency).toBe(SWIMMER_TIMES_CONCURRENCY);
    // The message names the live limit, not a literal.
    try {
      createQueue({ teams: [teamA()], concurrency: SWIMMER_TIMES_CONCURRENCY + 1 });
    } catch (error) {
      expect((error as Error).message).toContain(`${SWIMMER_TIMES_CONCURRENCY}`);
    }
    // A value that is both not an integer and too big is reported as invalid first.
    expect(errorCode(() => createQueue({ teams: [teamA()], concurrency: Number.POSITIVE_INFINITY }))).toBe('invalid-concurrency');
  });
});

describe('a team whose chosen season its own page does not offer', () => {
  it('is season-unavailable, lists the labels it does offer, and gets no fetches', () => {
    const queue = createQueue({ teams: [teamC(), teamA()] });
    const progress = queueProgress(queue);
    const c = progress.teams[0];
    expect(c.status).toBe('season-unavailable');
    expect(c.seasonId).toBeUndefined();
    expect(c.availableLabels).toStrictEqual(OPTIONS_C.map((o) => o.label));
    expect(c.availableLabels).not.toContain('2025-2026');
    expect(c.availableLabels?.[0]).toBe('2026-2027');
    expect(c.errorLines).toHaveLength(1);
    expect(c.errorLines[0]).toContain('Team 48');
    expect(c.errorLines[0]).toContain('2025-2026');
    expect(c.errorLines[0]).toContain('2026-2027, 2024-2025');
    expect(c.rosters.total).toBe(0);
    expect(c.swimmers.total).toBe(0);

    // Every item the queue ever hands out belongs to the other team.
    const handedOut: string[] = [];
    let q = queue;
    for (;;) {
      const next = nextWork(q);
      if (next.kind === 'idle') break;
      handedOut.push(next.work.teamId);
      q = markDone(next.queue, next.work.key);
    }
    expect(handedOut).toStrictEqual(['412', '412']);
  });

  it('does not fall back to a nearby season or to the selected one', () => {
    const queue = createQueue({ teams: [teamC('2025-26')] });
    expect(queueProgress(queue).teams[0].status).toBe('season-unavailable');
    expect(nextWork(queue)).toMatchObject({ kind: 'idle', reason: 'drained' });
  });

  it('says so, with an empty list, when no season was read from the page at all', () => {
    const queue = createQueue({ teams: [{ teamId: '9', seasonLabel: '2025-2026', seasonOptions: [] }] });
    const t = queueProgress(queue).teams[0];
    expect(t.status).toBe('season-unavailable');
    expect(t.availableLabels).toStrictEqual([]);
    expect(t.errorLines[0]).toContain('none read');
  });

  it('refuses addSwimmers for it', () => {
    const queue = createQueue({ teams: [teamC()] });
    expect(errorCode(() => addSwimmers(queue, '48', 'M', ['1']))).toBe('season-unavailable');
  });
});

describe('one shared concurrency limit', () => {
  it('defaults to the live pool value, which is not the retired 3-lane setting', () => {
    expect(MULTI_TEAM_DEFAULT_CONCURRENCY).toBe(SWIMMER_TIMES_CONCURRENCY);
    expect(createQueue({ teams: [teamA()] }).concurrency).toBe(SWIMMER_TIMES_CONCURRENCY);
    expect(queueProgress(createQueue({ teams: [teamA()] })).concurrency).toBe(SWIMMER_TIMES_CONCURRENCY);
  });

  it('hands out at most `concurrency` items in total, across all teams, then says why it stopped', () => {
    // Swimmer work only: rosters never overlap anything (see the roster-exclusivity tests).
    const base = finishRosters(createQueue({ teams: [teamA(), teamB()] }), {
      [rosterWorkKey('412', '29', 'M')]: ['5001', '5002'],
      [rosterWorkKey('58', '91', 'M')]: ['5003', '5004'],
    });
    let queue = widen(base, 3);
    const a = lease(queue);
    const b = lease(a.queue);
    const c = lease(b.queue);
    queue = c.queue;
    expect(new Set([a.work.teamId, b.work.teamId, c.work.teamId]).size).toBe(2);
    expect(idleReason(queue)).toBe('at-concurrency-limit');
    expect(queueProgress(queue).inFlight).toBe(3);

    queue = markDone(queue, a.work.key);
    expect(lease(queue).work.key).toBe(swimmerWorkKey('5004'));
  });

  it('never exceeds the limit over a whole run of five teams, uses the whole limit, and runs a roster alone', () => {
    const teams: MultiTeamQueueTeamInput[] = ['11', '12', '13', '14', '15'].map((teamId) => ({
      teamId,
      seasonLabel: '2025-2026',
      seasonOptions: OPTIONS_A,
    }));
    for (const limit of [1, 2, 3]) {
      let queue = widen(createQueue({ teams }), limit);
      const inFlight: QueueWork[] = [];
      let peak = 0;
      const teamsSeenInFlightTogether = new Set<string>();
      for (let step = 0; step < 5000; step += 1) {
        // Fill every free slot first, as a pool of `limit` lanes would.
        for (;;) {
          const next = nextWork(queue);
          if (next.kind === 'idle') break;
          queue = next.queue;
          inFlight.push(next.work);
        }
        peak = Math.max(peak, queueProgress(queue).inFlight);
        if (inFlight.some((w) => w.kind === 'roster')) expect(inFlight).toHaveLength(1);
        if (limit > 1) inFlight.forEach((w) => teamsSeenInFlightTogether.add(w.teamId));
        if (inFlight.length === 0) break;
        const finished = inFlight.shift() as QueueWork;
        queue = markDone(queue, finished.key);
        if (finished.kind === 'roster') {
          queue = addSwimmers(queue, finished.teamId, finished.gender, ['101', '102', '103', '104'].map((s) => `${finished.teamId}${s}`));
        }
      }
      expect(peak).toBe(limit);
      expect(queueProgress(queue).teams.every((t) => t.status === 'done')).toBe(true);
      expect(queueProgress(queue).inFlight).toBe(0);
      if (limit > 1) expect(teamsSeenInFlightTogether.size).toBeGreaterThan(1);
    }
  });

  it('is not multiplied by the number of teams', () => {
    for (const teamCount of [1, 2, 5]) {
      const teams = Array.from({ length: teamCount }, (_, i) => ({
        teamId: String(200 + i),
        seasonLabel: '2025-2026',
        seasonOptions: OPTIONS_A,
      }));
      const ids = (teamId: string): string[] => ['1', '2', '3', '4', '5', '6'].map((n) => `${teamId}${n}`);
      const rosters = Object.fromEntries(teams.map((t) => [rosterWorkKey(t.teamId, '29', 'M'), ids(t.teamId)]));
      let queue = widen(finishRosters(createQueue({ teams }), rosters), 2);
      let leased = 0;
      for (;;) {
        const next = nextWork(queue);
        if (next.kind === 'idle') break;
        queue = next.queue;
        leased += 1;
      }
      expect(leased).toBe(2);
    }
  });
});

describe('roster pages never overlap other work', () => {
  it('hands out no roster while a roster is in flight, even when the queue is widened', () => {
    const queue = widen(createQueue({ teams: [teamA(), teamB()] }), 3);
    const first = lease(queue);
    expect(first.work.kind).toBe('roster');
    expect(idleReason(first.queue)).toBe('at-concurrency-limit');
  });

  it('hands out no swimmer while a roster is in flight, even when the queue is widened', () => {
    const m = lease(createQueue({ teams: [teamA()] }));
    const listed = addSwimmers(markDone(m.queue, m.work.key), '412', 'M', ['6001']);
    const f = lease(widen(listed, 3));
    expect(f.work.key).toBe(rosterWorkKey('412', '29', 'F'));
    expect(idleReason(f.queue)).toBe('at-concurrency-limit');
    expect(lease(markDone(f.queue, f.work.key)).work.key).toBe(swimmerWorkKey('6001'));
  });

  it('hands out no roster while a swimmer is in flight, even when the queue is widened', () => {
    // A failed roster put back with Retry is how a roster is pending beside swimmer work.
    let queue = createQueue({ teams: [teamA(), teamB()] });
    const keys = [rosterWorkKey('412', '29', 'M'), rosterWorkKey('412', '29', 'F'), rosterWorkKey('58', '91', 'M')];
    for (const key of keys) {
      const next = lease(queue);
      expect(next.work.key).toBe(key);
      queue = addSwimmers(markDone(next.queue, key), next.work.teamId, (next.work as { gender: 'M' | 'F' }).gender, key === keys[0] ? ['6001', '6002'] : []);
    }
    const last = lease(queue);
    expect(last.work.key).toBe(rosterWorkKey('58', '91', 'F'));
    queue = markFailed(last.queue, last.work.key, 'HTTP 404');
    const swimmer = lease(widen(queue, 3));
    expect(swimmer.work.key).toBe(swimmerWorkKey('6001'));
    queue = retryFailed(swimmer.queue, last.work.key);
    expect(queueProgress(queue).teams[1].rosters.pending).toBe(1);
    expect(queueProgress(queue).inFlight).toBe(1);
    // Room is left (1 of 3) and a roster is pending, but a swimmer is in flight: wait.
    expect(idleReason(queue)).toBe('at-concurrency-limit');
    queue = markDone(queue, swimmer.work.key);
    expect(lease(queue).work.key).toBe(last.work.key);
  });
});

describe('ordering', () => {
  it('hands out a pending roster before any known swimmer', () => {
    let queue = createQueue({ teams: [teamA(), teamB()], concurrency: 1 });
    const first = lease(queue);
    queue = addSwimmers(markDone(first.queue, first.work.key), '412', 'M', ['5001', '5002']);
    // Team 412's women's roster and both of team 58's rosters are still pending: they go first.
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = lease(queue);
      order.push(next.work.key);
      queue = markDone(next.queue, next.work.key);
    }
    expect(order).toStrictEqual([
      rosterWorkKey('412', '29', 'F'),
      rosterWorkKey('58', '91', 'M'),
      rosterWorkKey('58', '91', 'F'),
      swimmerWorkKey('5001'),
    ]);
  });
});

describe('resume keyed by swimmer id', () => {
  it('does not hand out a swimmer whose key an earlier run finished, and counts it as skipped', () => {
    const finishedKeys = [swimmerWorkKey('7001'), swimmerWorkKey('7002')];
    const { queue, order } = runAll(createQueue({ teams: [teamA()], finishedKeys }), {
      [rosterWorkKey('412', '29', 'M')]: ['7001', '7002', '7003'],
    });
    expect(order).toStrictEqual([
      rosterWorkKey('412', '29', 'M'),
      rosterWorkKey('412', '29', 'F'),
      swimmerWorkKey('7003'),
    ]);
    const swimmers = queueProgress(queue).teams[0].swimmers;
    expect(swimmers).toMatchObject({ total: 3, done: 1, skippedResumed: 2, pending: 0 });
  });

  it('matches on the swimmer id alone: the fetch has no team or season in it', () => {
    // The same swimmer finished under another team and season is not fetched again.
    const { order } = runAll(createQueue({ teams: [teamA()], finishedKeys: [swimmerWorkKey('7001')] }), {
      [rosterWorkKey('412', '29', 'M')]: ['7001'],
    });
    expect(order).not.toContain(swimmerWorkKey('7001'));
  });

  it('does not match a key of the old (teamId, seasonId, swimmerId) shape: that swimmer is fetched', () => {
    // Fetching again is the safe error. Skipping on a key that no longer means the same thing is not.
    const { order } = runAll(createQueue({ teams: [teamA()], finishedKeys: ['swimmer|412|29|7001'] }), {
      [rosterWorkKey('412', '29', 'M')]: ['7001'],
    });
    expect(order).toContain(swimmerWorkKey('7001'));
  });

  it('resumes from a previous run: only done swimmers are carried over, failed ones are retried', () => {
    const rosterSwimmers = { [rosterWorkKey('412', '29', 'M')]: ['8001', '8002', '8003'] };
    let queue = createQueue({ teams: [teamA()], concurrency: 1 });
    // Run 1: finish both rosters, finish 8001, fail 8002, leave 8003 unstarted.
    for (let i = 0; i < 2; i += 1) {
      const r = lease(queue);
      queue = markDone(r.queue, r.work.key);
      if (r.work.kind === 'roster') queue = addSwimmers(queue, '412', r.work.gender, rosterSwimmers[r.work.key] ?? []);
    }
    const s1 = lease(queue);
    queue = markDone(s1.queue, s1.work.key);
    const s2 = lease(queue);
    queue = markFailed(s2.queue, s2.work.key, 'HTTP 404');
    const carried = finishedSwimmerKeys(queue);
    expect(carried).toStrictEqual([swimmerWorkKey('8001')]);

    // Run 2: a restarted crawl.
    const second = runAll(createQueue({ teams: [teamA()], finishedKeys: carried }), rosterSwimmers);
    expect(second.order).toStrictEqual([
      rosterWorkKey('412', '29', 'M'),
      rosterWorkKey('412', '29', 'F'),
      swimmerWorkKey('8002'),
      swimmerWorkKey('8003'),
    ]);
  });

  it('always fetches rosters again, even when everything under them is finished', () => {
    const finishedKeys = [swimmerWorkKey('9001')];
    const { order } = runAll(createQueue({ teams: [teamA()], finishedKeys }), { [rosterWorkKey('412', '29', 'M')]: ['9001'] });
    expect(order).toStrictEqual([rosterWorkKey('412', '29', 'M'), rosterWorkKey('412', '29', 'F')]);
  });

  it('keeps a swimmer listed on both rosters once, and validates ids', () => {
    let queue = createQueue({ teams: [teamA()] });
    queue = addSwimmers(queue, '412', 'M', ['3001', '3002']);
    queue = addSwimmers(queue, '412', 'F', ['3002', '3003']);
    expect(queueProgress(queue).teams[0].swimmers.total).toBe(3);
    expect(errorCode(() => addSwimmers(queue, '412', 'M', ['x1']))).toBe('invalid-swimmer-id');
    expect(errorCode(() => addSwimmers(queue, '999', 'M', ['1']))).toBe('unknown-team');
  });
});

describe('marking work', () => {
  it('refuses a key it does not know, work that is not in flight, and a second finish', () => {
    const queue = createQueue({ teams: [teamA()] });
    expect(errorCode(() => markDone(queue, 'nope'))).toBe('unknown-key');
    expect(errorCode(() => markDone(queue, rosterWorkKey('412', '29', 'M')))).toBe('not-in-flight');
    const { queue: leased, work } = lease(queue);
    const done = markDone(leased, work.key);
    expect(errorCode(() => markDone(done, work.key))).toBe('not-in-flight');
    expect(errorCode(() => markFailed(done, work.key, 'x'))).toBe('not-in-flight');
    expect(errorCode(() => retryFailed(done, work.key))).toBe('not-failed');
  });

  it('does not change the queue it was given', () => {
    const queue = createQueue({ teams: [teamA()] });
    const before = JSON.stringify(queueProgress(queue));
    const { queue: leased, work } = lease(queue);
    markDone(leased, work.key);
    addSwimmers(queue, '412', 'M', ['1']);
    expect(JSON.stringify(queueProgress(queue))).toBe(before);
    expect(queueProgress(leased).inFlight).toBe(1);
  });
});

describe('per-team progress and error lines', () => {
  it('moves a team from queued to running to done, and is not done until swimmers are listed', () => {
    let queue = createQueue({ teams: [teamA()], concurrency: 1 });
    expect(queueProgress(queue).teams[0].status).toBe('queued');

    const m = lease(queue);
    expect(queueProgress(m.queue).teams[0].status).toBe('running');
    queue = markDone(m.queue, m.work.key);
    const f = lease(queue);
    queue = markDone(f.queue, f.work.key);
    // Both rosters done, no swimmers listed yet: the team's swimmers are unknown, not finished.
    expect(queueProgress(queue).teams[0].status).toBe('running');
    queue = addSwimmers(queue, '412', 'M', ['6001']);
    queue = addSwimmers(queue, '412', 'F', []);
    expect(queueProgress(queue).teams[0].status).toBe('running');
    const s = lease(queue);
    queue = markDone(s.queue, s.work.key);
    expect(queueProgress(queue).teams[0]).toMatchObject({
      status: 'done',
      rosters: { total: 2, done: 2 },
      swimmers: { total: 1, done: 1 },
      errorLines: [],
    });
  });

  it('records one error line per failure with the team, season and subject, and ends done-with-errors', () => {
    let queue = createQueue({ teams: [teamA(), teamB()], concurrency: 1 });
    const failures: Record<string, string> = {
      [rosterWorkKey('58', '91', 'F')]: 'HTTP 404',
      [swimmerWorkKey('4002')]: 'times endpoint returned no rows',
    };
    for (let guard = 0; guard < 100; guard += 1) {
      const next = nextWork(queue);
      if (next.kind === 'idle') break;
      const message = failures[next.work.key];
      queue = message === undefined ? markDone(next.queue, next.work.key) : markFailed(next.queue, next.work.key, message);
      if (next.work.kind === 'roster' && message === undefined) {
        queue = addSwimmers(queue, next.work.teamId, next.work.gender, next.work.teamId === '412' && next.work.gender === 'M' ? ['4001', '4002'] : []);
      }
    }
    const [a, b] = queueProgress(queue).teams;
    expect(a.status).toBe('done-with-errors');
    expect(a.errorLines).toStrictEqual(["Team 412 · 2025-2026 · swimmer 4002: times endpoint returned no rows"]);
    expect(a.swimmers).toMatchObject({ done: 1, failed: 1 });
    expect(b.status).toBe('done-with-errors');
    expect(b.errorLines).toStrictEqual(["Team 58 · 2025-2026 · women's roster: HTTP 404"]);
  });

  it('a failure does not stop the other teams unless it asks to', () => {
    let queue = createQueue({ teams: [teamA(), teamB()], concurrency: 1 });
    const first = lease(queue);
    queue = markFailed(first.queue, first.work.key, 'HTTP 404');
    expect(lease(queue).work.key).toBe(rosterWorkKey('412', '29', 'F'));
  });
});

describe('pause, cancel and halt', () => {
  it('Pause hands out nothing, lets in-flight work finish, and Resume continues', () => {
    let queue = createQueue({ teams: [teamA()] });
    const a = lease(queue);
    queue = pauseQueue(a.queue);
    expect(idleReason(queue)).toBe('paused');
    expect(queueProgress(queue).paused).toBe(true);
    queue = markDone(queue, a.work.key);
    expect(idleReason(queue)).toBe('paused');
    queue = resumeQueue(queue);
    expect(queueProgress(queue).paused).toBe(false);
    expect(lease(queue).work.key).toBe(rosterWorkKey('412', '29', 'F'));
  });

  it('Cancel is terminal: nothing more is handed out, in-flight work may finish, Resume does not undo it', () => {
    let queue = createQueue({ teams: [teamA()] });
    const a = lease(queue);
    queue = cancelQueue(a.queue);
    expect(idleReason(queue)).toBe('cancelled');
    queue = markDone(queue, a.work.key);
    expect(queueProgress(queue).teams[0].rosters).toMatchObject({ done: 1, pending: 1 });
    queue = resumeQueue(queue);
    expect(idleReason(queue)).toBe('cancelled');
    expect(idleReason(pauseQueue(queue))).toBe('cancelled');
    expect(queueProgress(queue).cancelled).toBe(true);
  });

  it('Cancel wins over Pause and over a halt in the reported reason', () => {
    let queue = createQueue({ teams: [teamA()] });
    const a = lease(queue);
    queue = markFailed(a.queue, a.work.key, 'challenge', { haltQueue: true });
    queue = pauseQueue(queue);
    expect(idleReason(queue)).toBe('halted');
    expect(idleReason(cancelQueue(queue))).toBe('cancelled');
  });

  it('a halting failure stops the whole queue, and Resume retries that one item first', () => {
    let queue = createQueue({ teams: [teamA(), teamB()], concurrency: 1 });
    const a = lease(queue);
    queue = markFailed(a.queue, a.work.key, 'SwimCloud returned a challenge.', { haltQueue: true });
    expect(idleReason(queue)).toBe('halted');
    expect(queueProgress(queue).haltMessage).toBe('SwimCloud returned a challenge.');
    expect(queueProgress(queue).teams[0].errorLines).toHaveLength(1);

    queue = resumeQueue(queue);
    expect(queueProgress(queue).haltMessage).toBeUndefined();
    expect(queueProgress(queue).teams[0].errorLines).toHaveLength(0);
    expect(lease(queue).work.key).toBe(a.work.key);
  });

  it('retryFailed puts a failed item back to pending', () => {
    let queue = createQueue({ teams: [teamA()], concurrency: 1 });
    const a = lease(queue);
    queue = markFailed(a.queue, a.work.key, 'HTTP 500');
    queue = retryFailed(queue, a.work.key);
    expect(lease(queue).work.key).toBe(a.work.key);
  });

  it('reports waiting-for-in-flight when only in-flight work remains, and drained at the end', () => {
    let queue = createQueue({ teams: [teamA()] });
    const m = lease(queue);
    const f = lease(markDone(m.queue, m.work.key));
    expect(idleReason(f.queue)).toBe('waiting-for-in-flight');
    queue = markDone(f.queue, f.work.key);
    expect(idleReason(queue)).toBe('drained');
  });
});

describe('a swimmer is fetched once, whatever team and season asked for it', () => {
  // The fetch is /api/swimmers/{id}/profile_fastest_times/. It has no team and no season in it.
  const M412 = rosterWorkKey('412', '29', 'M');
  const M58 = rosterWorkKey('58', '91', 'M');

  it('keys a swimmer by id alone', () => {
    expect(swimmerWorkKey('7001')).toBe('swimmer|7001');
  });

  it('fetches a swimmer on two teams once, and each team still counts its own swimmers done', () => {
    const { queue, order } = runAll(createQueue({ teams: [teamA(), teamB()] }), {
      [M412]: ['7001', '7002'],
      [M58]: ['7001', '7003'],
    });
    const swimmerKeys = order.filter((k) => k.startsWith('swimmer|'));
    expect(swimmerKeys).toStrictEqual([swimmerWorkKey('7001'), swimmerWorkKey('7002'), swimmerWorkKey('7003')]);
    const [a, b] = queueProgress(queue).teams;
    expect(a.swimmers).toMatchObject({ total: 2, done: 2, pending: 0 });
    expect(b.swimmers).toMatchObject({ total: 2, done: 2, pending: 0 });
    expect(a.status).toBe('done');
    expect(b.status).toBe('done');
  });

  it('keeps every (team, season) pair on the shared work, in the order they were added', () => {
    const queue = finishRosters(createQueue({ teams: [teamA(), teamB()] }), { [M412]: ['7001'], [M58]: ['7001'] });
    const next = lease(queue);
    expect(next.work).toMatchObject({ kind: 'swimmer', swimmerId: '7001', key: swimmerWorkKey('7001') });
    expect((next.work as { attributions: unknown }).attributions).toStrictEqual([
      { teamId: '412', seasonId: '29', seasonLabel: '2025-2026' },
      { teamId: '58', seasonId: '91', seasonLabel: '2025-2026' },
    ]);
  });

  it('a second team that lists a swimmer already in flight shares that fetch', () => {
    let queue = createQueue({ teams: [teamA(), teamB()] });
    queue = finishRosters(queue, { [M412]: ['7001'] });
    const swimmer = lease(queue);
    queue = swimmer.queue;
    // Team 58's roster is listed late, while 7001 is already being fetched.
    queue = addSwimmers(queue, '58', 'M', ['7001']);
    const [a, b] = queueProgress(queue).teams;
    expect(a.swimmers).toMatchObject({ total: 1, inFlight: 1 });
    expect(b.swimmers).toMatchObject({ total: 1, inFlight: 1 });
    queue = markDone(queue, swimmer.work.key);
    expect(queueProgress(queue).teams.map((t) => t.swimmers.done)).toStrictEqual([1, 1]);
    expect(queueProgress(queue).inFlight).toBe(0);
  });

  it('a failed shared fetch is an error line on every team that asked for it', () => {
    const queue = finishRosters(createQueue({ teams: [teamA(), teamB()] }), { [M412]: ['7001'], [M58]: ['7001'] });
    const swimmer = lease(queue);
    const failed = markFailed(swimmer.queue, swimmer.work.key, 'HTTP 404');
    expect(queueProgress(failed).teams.map((t) => t.errorLines)).toStrictEqual([
      ['Team 412 · 2025-2026 · swimmer 7001: HTTP 404'],
      ['Team 58 · 2025-2026 · swimmer 7001: HTTP 404'],
    ]);
  });

  it('listing the same swimmer again for the same team does not add a pair or a count', () => {
    let queue = createQueue({ teams: [teamA()] });
    queue = addSwimmers(queue, '412', 'M', ['7001']);
    queue = addSwimmers(queue, '412', 'F', ['7001']);
    queue = finishRosters(queue, {});
    const next = lease(queue);
    expect((next.work as { attributions: unknown[] }).attributions).toHaveLength(1);
    expect(queueProgress(queue).teams[0].swimmers.total).toBe(1);
  });

  it('a team crawled again for another season does not re-fetch its returning swimmers', () => {
    // Run 1: team 412, 2025-2026.
    const first = runAll(createQueue({ teams: [teamA('2025-2026')] }), { [M412]: ['7001', '7002'] });
    const carried = finishedSwimmerKeys(first.queue);
    expect(carried).toStrictEqual([swimmerWorkKey('7001'), swimmerWorkKey('7002')]);
    // Run 2: the same team, 2024-2025 (id 28). 7001 returns, 7005 is new.
    const second = runAll(createQueue({ teams: [teamA('2024-2025')], finishedKeys: carried }), {
      [rosterWorkKey('412', '28', 'M')]: ['7001', '7005'],
    });
    const fetched = second.order.filter((k) => k.startsWith('swimmer|'));
    expect(fetched).toStrictEqual([swimmerWorkKey('7005')]);
    expect(queueProgress(second.queue).teams[0].swimmers).toMatchObject({ total: 2, done: 1, skippedResumed: 1 });
  });
});

describe('Resume after a halt, in either order', () => {
  function halted(): { queue: MultiTeamQueue; key: string } {
    const a = lease(createQueue({ teams: [teamA(), teamB()] }));
    return { queue: markFailed(a.queue, a.work.key, 'challenge', { haltQueue: true }), key: a.work.key };
  }

  it('retryFailed first, then resumeQueue: the queue runs again and the item is handed out once', () => {
    const { queue, key } = halted();
    const retried = retryFailed(queue, key);
    expect(idleReason(retried)).toBe('halted');
    const resumed = resumeQueue(retried);
    expect(queueProgress(resumed).haltMessage).toBeUndefined();
    expect(queueProgress(resumed).teams[0].errorLines).toStrictEqual([]);
    const first = lease(resumed);
    expect(first.work.key).toBe(key);
    expect(lease(markDone(first.queue, key)).work.key).not.toBe(key);
  });

  it('resumeQueue alone: same result', () => {
    const { queue, key } = halted();
    const resumed = resumeQueue(queue);
    expect(queueProgress(resumed).haltMessage).toBeUndefined();
    expect(lease(resumed).work.key).toBe(key);
  });

  it('resumeQueue without a halt changes no item', () => {
    const a = lease(createQueue({ teams: [teamA()] }));
    const failed = markFailed(a.queue, a.work.key, 'HTTP 500');
    expect(queueProgress(resumeQueue(failed)).teams[0].rosters).toMatchObject({ failed: 1 });
  });
});

describe('two halting failures', () => {
  /** Two swimmers in flight at once. The cap forbids this, so the queue is widened (see `widen`). */
  function twoInFlight(): { queue: MultiTeamQueue; first: QueueWork; second: QueueWork } {
    const base = finishRosters(createQueue({ teams: [teamA()] }), { [rosterWorkKey('412', '29', 'M')]: ['7001', '7002'] });
    const first = lease(widen(base, 2));
    const second = lease(first.queue);
    return { queue: second.queue, first: first.work, second: second.work };
  }

  it('keeps both failures and the first message, and Resume returns both to pending', () => {
    const { queue, first, second } = twoInFlight();
    let q = markFailed(queue, first.key, 'challenge on 7001', { haltQueue: true });
    q = markFailed(q, second.key, 'challenge on 7002', { haltQueue: true });
    expect(idleReason(q)).toBe('halted');
    expect(queueProgress(q).haltMessage).toBe('challenge on 7001');
    expect(queueProgress(q).teams[0].swimmers).toMatchObject({ failed: 2 });

    const resumed = resumeQueue(q);
    expect(queueProgress(resumed).haltMessage).toBeUndefined();
    expect(queueProgress(resumed).teams[0].swimmers).toMatchObject({ failed: 0, pending: 2 });
    const handedOut = [lease(resumed)];
    handedOut.push(lease(handedOut[0].queue));
    expect(handedOut.map((h) => h.work.key).sort()).toStrictEqual([first.key, second.key].sort());
  });

  it('Resume after one of the two was retried first returns only the one still failed', () => {
    const { queue, first, second } = twoInFlight();
    let q = markFailed(queue, first.key, 'a', { haltQueue: true });
    q = markFailed(q, second.key, 'b', { haltQueue: true });
    q = retryFailed(q, second.key);
    const resumed = resumeQueue(q);
    expect(queueProgress(resumed).teams[0].swimmers).toMatchObject({ failed: 0, pending: 2 });
  });

  it('a failure without halt beside a halting one is not returned to pending by Resume', () => {
    const { queue, first, second } = twoInFlight();
    let q = markFailed(queue, first.key, 'plain 404');
    q = markFailed(q, second.key, 'challenge', { haltQueue: true });
    const resumed = resumeQueue(q);
    expect(queueProgress(resumed).teams[0].swimmers).toMatchObject({ failed: 1, pending: 1 });
  });
});

describe('driver rules the queue cannot enforce', () => {
  it('nextWork does not change the queue it was given: store the returned queue before any await', () => {
    const queue = createQueue({ teams: [teamA()] });
    const first = nextWork(queue);
    const second = nextWork(queue);
    if (first.kind !== 'work' || second.kind !== 'work') throw new Error('expected work twice');
    // Calling it again on the same value hands out the SAME roster, and only
    // the returned queue knows it is in flight.
    expect(second.work.key).toBe(first.work.key);
    expect(queueProgress(queue).inFlight).toBe(0);
    expect(queueProgress(first.queue).inFlight).toBe(1);
    expect(nextWork(first.queue)).toMatchObject({ kind: 'idle', reason: 'at-concurrency-limit' });
  });
});

describe('verifyRosterSeason', () => {
  const work29 = { seasonId: '29', seasonLabel: '2025-2026' };

  it('accepts a page whose selected season is the work\'s season', () => {
    expect(verifyRosterSeason(REAL_FORM, work29)).toStrictEqual({ ok: true });
  });

  it('refuses a page that selects another season, naming both ids', () => {
    const result = verifyRosterSeason(REAL_FORM, { seasonId: '30', seasonLabel: '2026-2027' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('29');
      expect(result.reason).toContain('30');
    }
  });

  it('refuses a page with no selected season (a server that ignored season_id shows "All Seasons")', () => {
    const none = REAL_FORM.replace('<option value="29" selected>', '<option value="29">');
    expect(none).not.toBe(REAL_FORM);
    expect(verifyRosterSeason(none, work29).ok).toBe(false);
  });

  it('refuses a page that is not a roster page, such as a challenge page, instead of throwing', () => {
    for (const html of ['', '<html><title>Just a moment...</title></html>']) {
      const result = verifyRosterSeason(html, work29);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('season-select-missing');
    }
  });

  it('refuses a page with two selected seasons', () => {
    const two = REAL_FORM.replace('<option value="30">', '<option value="30" selected>');
    expect(two).not.toBe(REAL_FORM);
    expect(verifyRosterSeason(two, work29).ok).toBe(false);
  });

  it('takes a queue roster work item, and team B\'s season 91 does not pass on a page that selects 29', () => {
    const a = lease(createQueue({ teams: [teamA(), teamB()] }));
    expect(a.work.kind).toBe('roster');
    expect(verifyRosterSeason(REAL_FORM, a.work as QueueRosterWork)).toStrictEqual({ ok: true });
    const queue = markDone(a.queue, a.work.key);
    const f = lease(queue);
    const b = lease(markDone(f.queue, f.work.key));
    expect(b.work.teamId).toBe('58');
    expect(verifyRosterSeason(REAL_FORM, b.work as QueueRosterWork).ok).toBe(false);
  });
});

describe('shouldHalt', () => {
  it('halts at three consecutive 429 give-ups, counting the current one', () => {
    expect(CONSECUTIVE_429_HALT).toBe(3);
    const rateLimited = { kind: 'http-status', httpStatus: 429 } as const;
    expect(shouldHalt(rateLimited, 0)).toStrictEqual({ action: 'continue' });
    expect(shouldHalt(rateLimited, 1)).toStrictEqual({ action: 'continue' });
    expect(shouldHalt(rateLimited, 2)).toMatchObject({ action: 'stop', retryable: true });
    expect(shouldHalt(rateLimited, 7)).toMatchObject({ action: 'stop' });
  });

  it('a non-429 outcome never halts on the 429 count', () => {
    expect(shouldHalt({ kind: 'http-status', httpStatus: 200 }, 50)).toStrictEqual({ action: 'continue' });
    expect(shouldHalt({ kind: 'http-status', httpStatus: 404 }, 50)).toStrictEqual({ action: 'continue' });
  });

  it('halts on a Cloudflare 403 with the challenge message, not retryable', () => {
    expect(shouldHalt({ kind: 'http-status', httpStatus: 403 }, 0)).toStrictEqual({
      action: 'stop',
      retryable: false,
      message: SWIMCLOUD_CHALLENGE_MESSAGE,
    });
  });

  it('halts on any 5xx (retryable) and on a network error (not retryable)', () => {
    for (const httpStatus of [500, 502, 503, 599]) {
      expect(shouldHalt({ kind: 'http-status', httpStatus }, 0)).toMatchObject({ action: 'stop', retryable: true });
    }
    expect(shouldHalt({ kind: 'network-error' }, 0)).toMatchObject({ action: 'stop', retryable: false });
  });

  it('refuses a count that is not a non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(errorCode(() => shouldHalt({ kind: 'http-status', httpStatus: 429 }, bad))).toBe('invalid-429-count');
    }
  });

  it('agrees with the existing crawl policy on everything but a 429', () => {
    for (const httpStatus of [200, 301, 400, 403, 404, 418, 500, 503]) {
      expect(shouldHalt({ kind: 'http-status', httpStatus }, 0)).toStrictEqual(
        classifyCrawlPageOutcome({ kind: 'http-status', httpStatus }),
      );
    }
  });
});
