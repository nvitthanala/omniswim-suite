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

import { parseTeamSeasonOptions } from '../packages/swimcloud/src/teamSeasons';
import { SWIMMER_TIMES_CONCURRENCY } from '../extensions/swimcloud-companion/src/swimmerTimes';
import {
  MULTI_TEAM_DEFAULT_CONCURRENCY,
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
  swimmerWorkKey,
  type MultiTeamQueue,
  type MultiTeamQueueErrorCode,
  type MultiTeamQueueTeamInput,
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
    let queue = createQueue({ teams: [teamA(), teamB()], concurrency: 99 });
    const leased: QueueWork[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = lease(queue);
      queue = next.queue;
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
});

describe('a team whose chosen season its own page does not offer', () => {
  it('is season-unavailable, lists the labels it does offer, and gets no fetches', () => {
    const queue = createQueue({ teams: [teamC(), teamA()], concurrency: 99 });
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
      q = next.queue;
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
    let queue = createQueue({ teams: [teamA(), teamB()], concurrency: 3 });
    const a = lease(queue);
    const b = lease(a.queue);
    const c = lease(b.queue);
    queue = c.queue;
    expect(new Set([a.work.teamId, b.work.teamId, c.work.teamId]).size).toBe(2);
    expect(idleReason(queue)).toBe('at-concurrency-limit');
    expect(queueProgress(queue).inFlight).toBe(3);

    queue = markDone(queue, a.work.key);
    expect(lease(queue).work.key).toBe(rosterWorkKey('58', '91', 'F'));
  });

  it('never exceeds the limit over a whole run of five teams, and uses the whole limit', () => {
    const teams: MultiTeamQueueTeamInput[] = ['11', '12', '13', '14', '15'].map((teamId) => ({
      teamId,
      seasonLabel: '2025-2026',
      seasonOptions: OPTIONS_A,
    }));
    for (const limit of [1, 2, 3]) {
      let queue = createQueue({ teams, concurrency: limit });
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
      let queue = createQueue({ teams, concurrency: 2 });
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
      swimmerWorkKey('412', '29', '5001'),
    ]);
  });
});

describe('resume keyed by (teamId, seasonId, swimmerId)', () => {
  it('does not hand out a swimmer whose key an earlier run finished, and counts it as skipped', () => {
    const finishedKeys = [swimmerWorkKey('412', '29', '7001'), swimmerWorkKey('412', '29', '7002')];
    const { queue, order } = runAll(createQueue({ teams: [teamA()], finishedKeys }), {
      [rosterWorkKey('412', '29', 'M')]: ['7001', '7002', '7003'],
    });
    expect(order).toStrictEqual([
      rosterWorkKey('412', '29', 'M'),
      rosterWorkKey('412', '29', 'F'),
      swimmerWorkKey('412', '29', '7003'),
    ]);
    const swimmers = queueProgress(queue).teams[0].swimmers;
    expect(swimmers).toMatchObject({ total: 3, done: 1, skippedResumed: 2, pending: 0 });
  });

  it('matches on the whole tuple: another season or another team with the same swimmer id is not skipped', () => {
    const finishedKeys = [swimmerWorkKey('412', '28', '7001'), swimmerWorkKey('58', '29', '7001')];
    const { order } = runAll(createQueue({ teams: [teamA()], finishedKeys }), {
      [rosterWorkKey('412', '29', 'M')]: ['7001'],
    });
    expect(order).toContain(swimmerWorkKey('412', '29', '7001'));
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
    expect(carried).toStrictEqual([swimmerWorkKey('412', '29', '8001')]);

    // Run 2: a restarted crawl.
    const second = runAll(createQueue({ teams: [teamA()], finishedKeys: carried }), rosterSwimmers);
    expect(second.order).toStrictEqual([
      rosterWorkKey('412', '29', 'M'),
      rosterWorkKey('412', '29', 'F'),
      swimmerWorkKey('412', '29', '8002'),
      swimmerWorkKey('412', '29', '8003'),
    ]);
  });

  it('always fetches rosters again, even when everything under them is finished', () => {
    const finishedKeys = [swimmerWorkKey('412', '29', '9001')];
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
      [swimmerWorkKey('412', '29', '4002')]: 'times endpoint returned no rows',
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
    let queue = createQueue({ teams: [teamA()], concurrency: 2 });
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
    let queue = createQueue({ teams: [teamA()], concurrency: 2 });
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
    let queue = createQueue({ teams: [teamA()], concurrency: 5 });
    const m = lease(queue);
    const f = lease(m.queue);
    expect(idleReason(f.queue)).toBe('waiting-for-in-flight');
    queue = markDone(markDone(f.queue, m.work.key), f.work.key);
    expect(idleReason(queue)).toBe('drained');
  });
});
