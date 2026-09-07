import { describe, it, expect } from 'vitest';
import { buildSeasonTrends } from '../packages/core/src/lib/seasonAnalytics';
import type { Workspace } from '../packages/core/src/types';

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
