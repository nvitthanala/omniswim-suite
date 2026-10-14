// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up to "teams with no seed expectation stay visible" (e6b35d54): over and
 * under must compare the same entries on both sides, and never against a figure
 * that is absent.
 *
 * Scenario (dual-meet table, 6 places, no B-final table): in one event Alpha is
 * seeded 1-2, Gamma 3 and 9, Beta 7-8.
 *  - Alpha: both seeds inside the table.
 *  - Gamma: a partial team. Seed 9 has no expectation, but that swimmer scored 2
 *    points in the finals, and the baseline total holds them.
 *  - Beta: every seed past the table, so `expected` is null.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - delta timeline stops skipping a team with `expected: null`   -> "Beta has no delta key"
 *  - delta timeline stops subtracting the left-out points          -> "a partial team is compared ..."
 *  - left-out points sum a row's team under the wrong key          -> "left-out points are above 0"
 *  - builder keeps `totalPoints` on a team with a number           -> "no projected team carries totalPoints"
 *  - diff table stops subtracting left-out points                  -> "the diff table ..."
 *  - standings step stops subtracting left-out points              -> "the standings step ..."
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gender, type ProjectedTeamScore, type SwimmerResult, type TeamScore, type Workspace } from '../packages/core/src/types';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('recharts', async () => {
  const React = await import('react');
  const h = React.createElement;
  const Nothing = () => null;
  return {
    LineChart: ({ children }: { children?: React.ReactNode }) => h('div', null, children),
    Tooltip: Nothing,
    Line: Nothing,
    BarChart: Nothing,
    Bar: Nothing,
    Cell: Nothing,
    CartesianGrid: Nothing,
    ReferenceLine: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
  };
});

import PrelimsDiffTable from '../packages/matrix/src/components/PrelimsDiffTable';
import { MeetOpsStandingsStep } from '../packages/matrix/src/components/MeetOpsStandingsStep';
import {
  buildPrelimsDeltaTimeline,
  entryKey,
  prelimsDeltaTimelineOptions,
  sumPrelimsOuForTeam,
  buildPrelimsOverUnderByEntryKey,
  sumProjectionLeftOutPoints,
} from '../packages/core/src/lib/prelimsProjection';
import { buildPsychDeltaTimeline, buildPsychProjectedBundle } from '../packages/core/src/lib/psychProjection';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine';
import { useWorkspaceScoring } from '../packages/core/src/lib/useWorkspaceScoring';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';

const EVENT = 'Event 5 Men 100 Yard Backstroke';
const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more');

const clock = (n: number) => (50 + n / 10).toFixed(2);

function row(
  team: string,
  name: string,
  round: string,
  rank: number,
  time: string,
  extra: Partial<SwimmerResult> = {}
): SwimmerResult {
  return {
    id: `${team}-${name}-${round}`,
    rank,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
    roundSwam: round,
    ...extra,
  } as SwimmerResult;
}

/** A prelims row with seed `seed`, and a finals row at place `place` with that swim's own prelims clock. */
const prelims = (team: string, name: string, seed: number) =>
  row(team, name, 'Preliminaries', seed, clock(seed), { prelimsTime: clock(seed) });
const finals = (team: string, name: string, seed: number, place: number) =>
  row(team, name, 'A Final', place, clock(place - 5), { prelimsTime: clock(seed) });

const meetRows: SwimmerResult[] = [
  prelims('Alpha U', 'A1', 1),
  prelims('Alpha U', 'A2', 2),
  prelims('Gamma U', 'G1', 3),
  prelims('Beta U', 'B1', 7),
  prelims('Beta U', 'B2', 8),
  prelims('Gamma U', 'G2', 9),
  finals('Alpha U', 'A1', 1, 1),
  finals('Alpha U', 'A2', 2, 2),
  finals('Gamma U', 'G1', 3, 3),
  finals('Gamma U', 'G2', 9, 4), // swam up from seed 9: 2 points
  finals('Beta U', 'B1', 7, 5), // 1 point
  finals('Beta U', 'B2', 8, 6), // 0 points
];

function workspaceOf(extra: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w',
    name: 'w',
    createdAt: 0,
    menResults: meetRows,
    womenResults: [],
    scoringSettings: dual,
    ...extra,
  } as Workspace;
}

function deltaFor(snapshot: ReturnType<typeof buildScoringSnapshot>) {
  const options = prelimsDeltaTimelineOptions(
    snapshot.prelimsProjected,
    snapshot.baseline.allScored,
    snapshot.projected.allScored
  );
  return {
    options,
    timeline: buildPrelimsDeltaTimeline(
      snapshot.baseline.timelineData,
      snapshot.projected.timelineData,
      snapshot.prelimsProjected.timelineData,
      options
    ),
  };
}

describe('the scenario is the one the cases below rely on', () => {
  const snapshot = buildScoringSnapshot(workspaceOf(), Gender.MEN, false);
  const byName = (name: string) => snapshot.prelimsProjected.sortedTeams.find(t => t.teamName === name)!;

  it('Alpha has a sum, Gamma a sum and one left-out seed, Beta no expectation', () => {
    expect(byName('Alpha U').expected).toBe(13);
    expect(byName('Gamma U').expected).toBe(3);
    expect(byName('Gamma U').withoutExpectationCount).toBe(1);
    expect(byName('Beta U').expected).toBeNull();
    expect(byName('Beta U').withoutExpectationCount).toBe(2);
    const baseline = new Map(snapshot.baseline.sortedTeams.map(t => [t.teamName, t.totalPoints]));
    expect(baseline.get('Alpha U')).toBe(13);
    expect(baseline.get('Gamma U')).toBe(5);
    expect(baseline.get('Beta U')).toBe(1);
  });

  it('no projected team carries totalPoints at runtime, with or without a number', () => {
    for (const bundle of [snapshot.prelimsProjected, buildPsychProjectedBundle({ workspace: workspaceOf(), gender: Gender.MEN })]) {
      for (const team of bundle.sortedTeams) {
        expect('totalPoints' in team).toBe(false);
      }
    }
    expect(snapshot.prelimsProjected.sortedTeams.some(t => typeof t.expected === 'number')).toBe(true);
    expect(snapshot.prelimsProjected.sortedTeams.some(t => t.expected === null)).toBe(true);
  });
});

describe('finding 1: a team with no expectation has no delta', () => {
  const snapshot = buildScoringSnapshot(workspaceOf(), Gender.MEN, false);
  const { options, timeline } = deltaFor(snapshot);

  it('Beta has no delta key, on either delta', () => {
    expect(options).toBeDefined();
    expect(timeline).toHaveLength(1);
    const point = timeline[0]!;
    expect('Beta U' in point.baselineDelta).toBe(false);
    expect('Beta U' in point.projectedDelta).toBe(false);
  });

  it('a team that has an expectation keeps its key, and a real 0 is a 0', () => {
    const point = timeline[0]!;
    expect(point.baselineDelta['Alpha U']).toBe(0);
    expect(point.baselineDelta['Gamma U']).toBe(0);
  });

  it('a team the bundle does not list keeps its delta against 0, and a carried 0 stays', () => {
    // Delta U is on the baseline timeline only. X first appears on the second prelims point.
    const baseline = [
      { name: 'E1', fullEvent: 'Event 1 100 Yard Freestyle', 'Delta U': 4, X: 5, Beta: 7 },
      { name: 'E2', fullEvent: 'Event 2 100 Yard Backstroke', 'Delta U': 6, X: 8, Beta: 9 },
    ];
    const prelimsTimeline = [{ name: 'E2', fullEvent: 'Event 2 100 Yard Backstroke', X: 6 }];
    const out = buildPrelimsDeltaTimeline(baseline, baseline, prelimsTimeline, {
      noExpectationTeams: new Set(['Beta']),
    });
    expect(out.map(p => p.baselineDelta)).toEqual([
      { 'Delta U': 4, X: 5 },
      { 'Delta U': 6, X: 2 },
    ]);
  });
});

describe('finding 2: a partial team is compared on the entries that have an expectation', () => {
  const snapshot = buildScoringSnapshot(workspaceOf(), Gender.MEN, false);
  const { timeline } = deltaFor(snapshot);

  it('left-out points are above 0 (the gap key matches a baseline row)', () => {
    const baselineLeftOut = sumProjectionLeftOutPoints(
      snapshot.baseline.allScored,
      snapshot.prelimsProjected.sortedTeams
    );
    expect(baselineLeftOut.byTeam.get('Gamma U')).toBe(2);
    expect(baselineLeftOut.byTeam.get('Beta U')).toBe(1);
    expect(baselineLeftOut.byTeam.has('Alpha U')).toBe(false);
  });

  it('a partial team is compared on the entries that have an expectation', () => {
    const gamma = timeline[0]!.baselineDelta['Gamma U'];
    // Baseline 5 holds G2's 2 points; expected 3 leaves G2 out. 5 - 2 - 3 = 0, not +2.
    expect(gamma).toBe(0);
    // It is the sum of the per-entry over/under: one entry has an expectation, and it met it.
    const lookup = buildPrelimsOverUnderByEntryKey(
      snapshot.baseline.allScored,
      snapshot.prelimsProjected.allScored
    );
    expect(sumPrelimsOuForTeam('Gamma U', lookup)).toBe(gamma);
  });

  it('subtracts a left-out entry from its own event on, not before', () => {
    const base = [
      { name: 'E1', fullEvent: 'Event 1 100 Yard Freestyle', T: 10 },
      { name: 'E2', fullEvent: 'Event 2 100 Yard Backstroke', T: 17 },
    ];
    const expectedTimeline = [
      { name: 'E1', fullEvent: 'Event 1 100 Yard Freestyle', T: 10 },
      { name: 'E2', fullEvent: 'Event 2 100 Yard Backstroke', T: 12 },
    ];
    const out = buildPrelimsDeltaTimeline(base, base, expectedTimeline, {
      baselineLeftOut: new Map([['T', new Map([['Event 2 100 Yard Backstroke', 5]])]]),
      projectedLeftOut: new Map([['T', new Map([['Event 2 100 Yard Backstroke', 3]])]]),
    });
    // Event 1: nothing left out yet. Event 2: baseline 17 - 5 - 12 = 0, projected 17 - 3 - 12 = 2.
    expect(out.map(p => p.baselineDelta['T'])).toEqual([0, 0]);
    expect(out.map(p => p.projectedDelta['T'])).toEqual([0, 2]);
  });

  it('with no team left out the options are undefined and the plain timeline is unchanged', () => {
    const clean = buildScoringSnapshot(
      workspaceOf({ menResults: meetRows.filter(r => !['Beta U'].includes(r.team) && r.name !== 'G2') }),
      Gender.MEN,
      false
    );
    expect(clean.prelimsProjected.sortedTeams.every(t => t.expected !== null && t.withoutExpectationCount === 0)).toBe(
      true
    );
    const options = prelimsDeltaTimelineOptions(
      clean.prelimsProjected,
      clean.baseline.allScored,
      clean.projected.allScored
    );
    expect(options).toBeUndefined();
    const plain = buildPrelimsDeltaTimeline(
      clean.baseline.timelineData,
      clean.projected.timelineData,
      clean.prelimsProjected.timelineData
    );
    // The same call with the options a no-gap bundle would give: no key is dropped, no number moves.
    expect(
      buildPrelimsDeltaTimeline(
        clean.baseline.timelineData,
        clean.projected.timelineData,
        clean.prelimsProjected.timelineData,
        {}
      )
    ).toEqual(plain);
  });
});

describe('the psych delta timeline reads its bundle the same way', () => {
  // Psych seeds by time order: Alpha 1-2, Gamma 3, Filler 4-6, Beta 7-8, Gamma 9.
  const psych = (team: string, name: string, seed: number) =>
    row(team, name, 'Psych Sheet', seed, clock(seed), { isPsychSheet: true });
  const psychRows = [
    psych('Alpha U', 'A1', 1),
    psych('Alpha U', 'A2', 2),
    psych('Gamma U', 'G1', 3),
    psych('Filler U', 'F1', 4),
    psych('Filler U', 'F2', 5),
    psych('Filler U', 'F3', 6),
    psych('Beta U', 'B1', 7),
    psych('Beta U', 'B2', 8),
    psych('Gamma U', 'G2', 9),
  ];
  const workspace = workspaceOf({ psychMenResults: psychRows });

  it('Beta has no delta key and Gamma is compared without its seed past the table', () => {
    const snapshot = buildScoringSnapshot(workspace, Gender.MEN, false);
    const options = prelimsDeltaTimelineOptions(
      snapshot.psychProjected,
      snapshot.baseline.allScored,
      snapshot.projected.allScored
    );
    expect(options).toBeDefined();
    const out = buildPsychDeltaTimeline(
      snapshot.baseline.timelineData,
      snapshot.projected.timelineData,
      snapshot.psychProjected.timelineData,
      options
    );
    const gamma = snapshot.psychProjected.sortedTeams.find(t => t.teamName === 'Gamma U')!;
    expect(gamma.withoutExpectationCount).toBe(1);
    const point = out[0]!;
    expect('Beta U' in point.baselineDelta).toBe(false);
    // Gamma baseline 5 - G2's 2 points - expected 3 (G1 at seed 3).
    expect(point.baselineDelta['Gamma U']).toBe(0);
    // Without the options the same call reads Beta's whole baseline as over and counts G2's points.
    const plain = buildPsychDeltaTimeline(
      snapshot.baseline.timelineData,
      snapshot.projected.timelineData,
      snapshot.psychProjected.timelineData
    );
    expect(plain[0]!.baselineDelta['Beta U']).toBeDefined();
    expect(plain[0]!.baselineDelta['Gamma U']).toBe(2);
  });
});

describe('finding 2 on screen', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function render(element: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(element);
    });
  }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 300, width: 600, height: 300, toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  // Gamma: expected 28 leaves one seed out. That swimmer earned 3 in the baseline and 5 projected.
  const gammaSwim = (name: string, points: number) =>
    row('Gamma U', name, 'A Final', 1, '50.00', { points });
  const gammaBaseline: TeamScore = {
    teamName: 'Gamma U',
    totalPoints: 33,
    color: '#00ff00',
    swimmers: [gammaSwim('Gus Gamma', 30), gammaSwim('Gil Gamma', 3)],
  };
  const gammaProjected: TeamScore = {
    teamName: 'Gamma U',
    totalPoints: 31,
    color: '#00ff00',
    swimmers: [gammaSwim('Gus Gamma', 26), gammaSwim('Gil Gamma', 5)],
  };
  const gammaProjection: ProjectedTeamScore = {
    teamName: 'Gamma U',
    swimmers: [],
    color: '#00ff00',
    expected: 28,
    withoutExpectation: [entryKey(gammaSwim('Gil Gamma', 0))],
    withoutExpectationCount: 1,
  };

  it('the diff table leaves the left-out points out of both over/unders, and keeps the real totals', () => {
    render(
      React.createElement(PrelimsDiffTable, {
        projectedTeams: [gammaProjected],
        baselineTeams: [gammaBaseline],
        prelimsTeams: [gammaProjection],
        searchQuery: '',
      })
    );
    const cells = [...document.body.querySelectorAll('tbody tr td')].map(td => td.textContent ?? '');
    const text = cells.join(' | ');
    // Baseline 33 - 3 - 28 = +2.0. Projected 31 - 5 - 28 = -2.0. Not +5.0 and +3.0.
    expect(text).toContain('33.0');
    expect(text).toContain('31.0');
    expect(text).toContain('+2.0');
    expect(text).toMatch(/[-−]2\.0/);
    expect(text).not.toContain('+5.0');
    expect(text).not.toContain('+3.0');
    expect(text).toContain('1 seed past table');
  });

  it('the standings step leaves the left-out points out of "vs prelims"', () => {
    const props = {
      reconciliationSummary: { status: 'none', rows: [] },
      scoringSettings: { scoringPoints: [9, 4, 3, 2, 1] },
      searchQuery: '',
      onSearchChange: () => undefined,
      teamsWithLineStyles: [gammaProjected],
      gender: Gender.MEN,
      visibleEvents: [],
      officialLookup: new Map(),
      baselineByTeam: new Map([['Gamma U', 33]]),
      prelimsByTeam: new Map([['Gamma U', 28]]),
      psychByTeam: new Map<string, number>(),
      prelimsWithoutExpectationByTeam: new Map([['Gamma U', 1]]),
      psychWithoutExpectationByTeam: new Map<string, number>(),
      prelimsBaselineLeftOutByTeam: new Map([['Gamma U', 3]]),
      prelimsProjectedLeftOutByTeam: new Map([['Gamma U', 5]]),
      showPrelimsPerformance: true,
      prelimsOuByEntry: new Map(),
      showPsychPerformance: false,
      psychOuByEntry: new Map(),
      scoringRefreshKey: 0,
      topContributors: [],
    };
    render(React.createElement(MeetOpsStandingsStep as unknown as React.ComponentType<Record<string, unknown>>, props));
    const header = document.body.querySelector('button[aria-expanded]')!.textContent ?? '';
    expect(header).toContain('vs prelims +2.0');
    expect(header).not.toContain('+5.0');
  });
});

describe('the store hook hands the like-for-like options to both delta timelines', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function mountHook(workspace: Workspace) {
    let seen: ReturnType<typeof useWorkspaceScoring> | null = null;
    function Probe() {
      seen = useWorkspaceScoring({ workspace, gender: Gender.MEN, removeSeniors: false, scoringRefreshKey: 0 });
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(Probe));
    });
    return seen!;
  }

  it('prelims: Beta has no delta key and Gamma is compared without its seed past the table', () => {
    const hook = mountHook(workspaceOf());
    const point = hook.prelimsDeltaTimeline[0]!;
    expect('Beta U' in point.baselineDelta).toBe(false);
    expect('Beta U' in point.projectedDelta).toBe(false);
    expect(point.baselineDelta['Gamma U']).toBe(0);
    // Same numbers the pure builder gives with the options.
    const snapshot = buildScoringSnapshot(workspaceOf(), Gender.MEN, false);
    expect(hook.prelimsDeltaTimeline).toEqual(deltaFor(snapshot).timeline);
  });

  it('psych: Beta has no delta key and Gamma is compared without its seed past the table', () => {
    const psych = (team: string, name: string, seed: number) =>
      row(team, name, 'Psych Sheet', seed, clock(seed), { isPsychSheet: true });
    const workspace = workspaceOf({
      psychMenResults: [
        psych('Alpha U', 'A1', 1),
        psych('Alpha U', 'A2', 2),
        psych('Gamma U', 'G1', 3),
        psych('Filler U', 'F1', 4),
        psych('Filler U', 'F2', 5),
        psych('Filler U', 'F3', 6),
        psych('Beta U', 'B1', 7),
        psych('Beta U', 'B2', 8),
        psych('Gamma U', 'G2', 9),
      ],
    });
    const hook = mountHook(workspace);
    const point = hook.psychDeltaTimeline[0]!;
    expect('Beta U' in point.baselineDelta).toBe(false);
    expect(point.baselineDelta['Gamma U']).toBe(0);
  });
});
