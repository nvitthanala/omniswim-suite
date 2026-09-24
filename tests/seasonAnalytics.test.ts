import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildSeasonTrends } from '../packages/core/src/lib/seasonAnalytics';
import { parseSwimCloudPasteDetailed } from '../packages/core/src/lib/athleteHistory';
import { Gender, type HistoricalSwim, type Workspace } from '../packages/core/src/types';

/**
 * The original single case was named "aggregates swimmer bests across workspaces"
 * but passed ONE workspace, so the cross-workspace merge — the thing the name
 * claims — was never executed. It is covered below.
 *
 * Note on `meetCount`: it counts RESULT ROWS, not meets. Two swims in one
 * workspace report `meetCount: 2`. That is the current behaviour and is pinned
 * here deliberately; the misnomer is recorded in
 * docs/reference/TEST_COVERAGE_AUDIT.md as an implementation finding, not fixed here.
 */

const swim = (id: string, name: string, event: string, time: string, points = 20) => ({
  id,
  name,
  event,
  time,
  team: 'Home',
  gender: 'Men',
  rank: 1,
  classYear: 'FR',
  points,
  isRelay: false,
});

function workspace(id: string, name: string, menResults: unknown[]): Workspace {
  return {
    id,
    name,
    createdAt: Date.now(),
    menResults,
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
  } as unknown as Workspace;
}

describe('seasonAnalytics', () => {
  it('keeps the fastest of two swims in one workspace', () => {
    const ws = workspace('w1', 'Test Meet', [
      swim('r1', 'Alice Swimmer', '100 Free', '52.10'),
      swim('r2', 'Alice Swimmer', '100 Free', '51.50'),
    ]);

    const trends = buildSeasonTrends([ws]);

    expect(trends.swimmerTrends).toHaveLength(1);
    expect(trends.swimmerTrends[0].bestTime).toBe('51.50');
    expect(trends.swimmerTrends[0].meetCount).toBe(2);
  });

  it('merges one swimmer across two workspaces and keeps the progression in order', () => {
    const trends = buildSeasonTrends([
      workspace('w1', 'Meet One', [swim('r1', 'Alice Swimmer', '100 Free', '52.10')]),
      workspace('w2', 'Meet Two', [swim('r2', 'Alice Swimmer', '100 Free', '51.50')]),
    ]);

    expect(trends.swimmerTrends).toHaveLength(1);
    const alice = trends.swimmerTrends[0];
    expect(alice.bestTime).toBe('51.50');
    expect(alice.meetCount).toBe(2);
    // The progression must name the workspace each swim came from, in order.
    expect(alice.progression).toEqual([
      { label: 'Meet One', time: '52.10' },
      { label: 'Meet Two', time: '51.50' },
    ]);
    // One standings row per workspace.
    expect(trends.teamScoreTrends.map(t => t.meetLabel)).toEqual(['Meet One', 'Meet Two']);
  });

  it('does not merge different swimmers or different events', () => {
    const trends = buildSeasonTrends([
      workspace('w1', 'Meet One', [
        swim('r1', 'Alice Swimmer', '100 Free', '52.10'),
        swim('r2', 'Bob Swimmer', '100 Free', '49.90'),
        swim('r3', 'Alice Swimmer', '200 Free', '1:52.00'),
      ]),
    ]);

    expect(trends.swimmerTrends).toHaveLength(3);
    const key = (n: string, e: string) =>
      trends.swimmerTrends.find(t => t.name === n && t.event === e);
    expect(key('Alice Swimmer', '100 Free')?.bestTime).toBe('52.10');
    expect(key('Alice Swimmer', '200 Free')?.bestTime).toBe('1:52.00');
    expect(key('Bob Swimmer', '100 Free')?.bestTime).toBe('49.90');
    // Bob's faster 100 must not leak into Alice's row.
    expect(key('Alice Swimmer', '100 Free')?.meetCount).toBe(1);
  });

  it('compares minutes against seconds correctly rather than by string order', () => {
    // '1:02.00' (62s) is slower than '59.90', but sorts EARLIER as a string.
    // A regression to string comparison would pick the wrong best time here.
    const trends = buildSeasonTrends([
      workspace('w1', 'Meet One', [
        swim('r1', 'Carl Swimmer', '100 Free', '1:02.00'),
        swim('r2', 'Carl Swimmer', '100 Free', '59.90'),
      ]),
    ]);

    expect(trends.swimmerTrends[0].bestTime).toBe('59.90');
  });

  it('excludes relay rows from swimmer trends', () => {
    const relay = { ...swim('r1', 'Home Relay A', '200 Free Relay', '1:22.00'), isRelay: true };
    const trends = buildSeasonTrends([
      workspace('w1', 'Meet One', [relay, swim('r2', 'Alice Swimmer', '100 Free', '52.10')]),
    ]);

    expect(trends.swimmerTrends.map(t => t.name)).toEqual(['Alice Swimmer']);
  });
});

/**
 * Plans/2026-09-22/01, P14 item d. A trend keyed on `name::rawLabel` did two
 * wrong things at once:
 *
 * - It mixed courses. A pasted row stores its course in `timeType`, not in
 *   the label, so Gavin Kock's `100 IM SCM 58.25` and `100 IM SCY 52.57`
 *   (`hsuroster26-27.txt` lines 180 and 200) were one trend whose "best" was
 *   a yards time beside a metres time.
 * - It split one event across labels. A meet row
 *   (`Event 35 Men 100 Yard Freestyle`) and a SwimCloud row (`100 Free SCY`)
 *   of the same swimmer were two trends.
 *
 * Trends now key on the swimmer, `swimEventIdentity` and the course.
 */
describe('seasonAnalytics keys trends by event identity and course', () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const gavinKock = (() => {
    const lines = readFileSync(join(repoRoot, 'hsuroster26-27.txt'), 'utf8').split(/\r?\n/);
    const block = lines.slice(160, 200);
    expect(block[0]).toBe('Gavin Kock');
    return parseSwimCloudPasteDetailed(block.join('\n'), { team: 'Henderson State', gender: Gender.MEN }).swims;
  })();

  function historyWorkspace(athleteHistory: HistoricalSwim[], menResults: unknown[] = []): Workspace {
    return { ...workspace('w-hist', 'History', menResults), athleteHistory } as Workspace;
  }

  it('keeps a yards swim and a metres swim of one event apart (Gavin Kock, HSU)', () => {
    const trends = buildSeasonTrends([historyWorkspace(gavinKock)]).swimmerTrends;
    const im = trends.filter(t => t.name === 'Gavin Kock' && t.event === '100 Individual Medley');
    expect(im.map(t => [t.course, t.bestTime, t.meetCount])).toStrictEqual([
      ['SCM', '58.25', 1],
      ['SCY', '52.57', 1],
    ]);
    // 50 Free: 20.46 SCY, 23.39 SCM, 23.84 LCM — three courses, three trends.
    const fifty = trends.filter(t => t.name === 'Gavin Kock' && t.event === '50 Freestyle');
    expect(fifty.map(t => [t.course, t.bestTime]).sort()).toStrictEqual([
      ['LCM', '23.84'],
      ['SCM', '23.39'],
      ['SCY', '20.46'],
    ]);
  });

  it('folds a meet label and a SwimCloud label of one event into one trend', () => {
    const meetRow = {
      ...swim('r1', 'Alessandro Giustolisi', 'Event 35 Men 100 Yard Freestyle', '47.83'),
      team: 'Delta State University',
    };
    const history: HistoricalSwim = {
      name: 'Alessandro Giustolisi',
      team: 'Delta State University',
      gender: Gender.MEN,
      event: '100 Free SCY',
      time: '48.10',
      timeType: 'SCY',
      source: 'swimcloud',
    };
    const trends = buildSeasonTrends([historyWorkspace([history], [meetRow])]).swimmerTrends;
    expect(trends).toHaveLength(1);
    expect(trends[0]).toMatchObject({ course: 'SCY', bestTime: '47.83', meetCount: 2 });
    // A time trial of that event is its own trend.
    const trial = { ...swim('r2', 'Alessandro Giustolisi', 'Event 201 Men 100 Yard Freestyle Time Trial', '47.00') };
    const withTrial = buildSeasonTrends([historyWorkspace([history], [meetRow, trial])]).swimmerTrends;
    expect(withTrial.map(t => [t.event, t.bestTime]).sort()).toStrictEqual([
      ['Event 201 Men 100 Yard Freestyle Time Trial', '47.00'],
      ['Event 35 Men 100 Yard Freestyle', '47.83'],
    ]);
  });

  it('reads the course off a SwimCloud label when the row states no timeType', () => {
    const row = (event: string, time: string): HistoricalSwim => ({
      name: 'Test Swimmer',
      team: 'Home',
      gender: Gender.MEN,
      event,
      time,
      source: 'swimcloud',
    });
    const trends = buildSeasonTrends([historyWorkspace([row('50 Free LCM', '24.10'), row('50 Free SCY', '21.00')])])
      .swimmerTrends;
    expect(trends.map(t => [t.course, t.bestTime]).sort()).toStrictEqual([
      ['LCM', '24.10'],
      ['SCY', '21.00'],
    ]);
  });

  it('takes the higher score as a diver’s best', () => {
    const dive = (id: string, time: string) => ({
      ...swim(id, 'Santiago Santodomingo', 'Event 9 Men 1 mtr Diving', time),
      team: 'Delta State University',
    });
    const trends = buildSeasonTrends([
      workspace('w1', 'Meet One', [dive('d1', '431.25')]),
      workspace('w2', 'Meet Two', [dive('d2', '503.95')]),
    ]).swimmerTrends;
    expect(trends).toHaveLength(1);
    expect(trends[0].bestTime).toBe('503.95');
  });
});
