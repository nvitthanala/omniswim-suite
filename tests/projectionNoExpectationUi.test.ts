// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C7 follow-up 2 (UI): where a team's expected prelims figure would show, a team
 * with every seed past the end of the place-point table shows
 * "— (N seeds past table)". A team with some seeds past the table shows its sum
 * and a small "N seeds past table" note. Neither case shows 0, and no team is
 * hidden.
 *
 * Every fixture total is chosen so that no legitimate "0.0" appears on screen:
 * `noBareZero` then fails for a figure that was read as 0.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - compact summary drops the no-expectation text      -> "compact ... every seed past the table"
 *  - compact summary drops the partial note             -> "compact ... some seeds past the table"
 *  - full summary drops either                          -> the two "full summary" cases
 *  - diff table reads a null expected as 0              -> "the diff table ..." (shows 0.0, O/U = baseline)
 *  - diff table sorts a null over/under first or NaN    -> "sorts the team with no expectation last"
 *  - standings step stops passing the count             -> "the standings step ..."
 *  - TeamCard stops passing the count to the header     -> "the team card header ..."
 *  - momentum note keyed on the wrong anchor            -> "the momentum note follows the anchor"
 *  - hook builds prelimsByTeam from every team          -> "the scoring hook ..."
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Gender,
  type ProjectedTeamScore,
  type ScoringSettings,
  type SwimmerResult,
  type TeamScore,
} from '../packages/core/src/types';

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

import ProjectedActualScore from '../packages/matrix/src/components/ProjectedActualScore';
import PrelimsDiffTable from '../packages/matrix/src/components/PrelimsDiffTable';
import TeamCard from '../packages/matrix/src/components/TeamCard';
import { MeetOpsStandingsStep } from '../packages/matrix/src/components/MeetOpsStandingsStep';
import { MeetOpsAnalyzeStep } from '../packages/matrix/src/components/MeetOpsAnalyzeStep';
import { noExpectationText, seedsPastTableLabel } from '../packages/matrix/src/lib/noExpectation';
import { useWorkspaceScoring } from '../packages/core/src/lib/useWorkspaceScoring';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';
import { workspaceFixture } from './helpers/typedFixtures';

const EVENT = 'Event 5 Men 100 Yard Backstroke';

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

const text = () => document.body.textContent ?? '';
/** A "0.0" that is not the tail of another number (10.0, 20.0, 1.0). */
const BARE_ZERO = /(^|[^\d.])0\.0/;
const noBareZero = () => expect(text()).not.toMatch(BARE_ZERO);
const noExpectationTexts = (scope: ParentNode = document.body) => [...scope.querySelectorAll('[data-no-expectation]')];
const notes = (scope: ParentNode = document.body) => [...scope.querySelectorAll('[data-seeds-past-table]')];

describe('the words', () => {
  it('say "N seeds past table", with a singular for one', () => {
    expect(seedsPastTableLabel(3)).toBe('3 seeds past table');
    expect(seedsPastTableLabel(1)).toBe('1 seed past table');
    expect(noExpectationText(3)).toBe('— (3 seeds past table)');
    expect(noExpectationText(1)).toBe('— (1 seed past table)');
  });
});

describe('the compact score summary', () => {
  it('a team with every seed past the table reads "— (N seeds past table)" and no 0', () => {
    render(
      React.createElement(ProjectedActualScore, {
        compact: true,
        projected: 12,
        baseline: 20,
        prelimsWithoutExpectationCount: 3,
      })
    );
    expect(text()).toContain('Prelims — (3 seeds past table)');
    expect(noExpectationTexts()).toHaveLength(1);
    expect(notes()).toHaveLength(0);
    noBareZero();
  });

  it('a team with some seeds past the table shows its sum and the note', () => {
    render(
      React.createElement(ProjectedActualScore, {
        compact: true,
        projected: 22,
        prelimsProjected: 13,
        baselineOverUnder: 7,
        projectedOverUnder: 9,
        prelimsWithoutExpectationCount: 2,
      })
    );
    expect(text()).toContain('Prelims 13.0');
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.textContent).toBe('2 seeds past table');
    // The dash text is only for a team with no figure at all.
    expect(noExpectationTexts()).toHaveLength(0);
    expect(text()).toContain('vs prelims +7.0');
    noBareZero();
  });

  it('a team with no seed past the table shows neither', () => {
    render(
      React.createElement(ProjectedActualScore, {
        compact: true,
        projected: 22,
        prelimsProjected: 13,
        baselineOverUnder: 7,
        prelimsWithoutExpectationCount: 0,
      })
    );
    expect(text()).toContain('Prelims 13.0');
    expect(notes()).toHaveLength(0);
    expect(noExpectationTexts()).toHaveLength(0);
    expect(text()).not.toContain('seeds past table');
  });
});

describe('the full score summary', () => {
  it('a team with every seed past the table reads "— (N seeds past table)" beside the label', () => {
    render(
      React.createElement(ProjectedActualScore, {
        projected: 12,
        baseline: 20,
        prelimsWithoutExpectationCount: 4,
      })
    );
    expect(text()).toContain('Prelims proj');
    expect(text()).toContain('— (4 seeds past table)');
    expect(noExpectationTexts()).toHaveLength(1);
    noBareZero();
  });

  it('a team with some seeds past the table shows its sum and the note', () => {
    render(
      React.createElement(ProjectedActualScore, {
        projected: 22,
        baseline: 20,
        prelimsProjected: 13,
        baselineOverUnder: 7,
        projectedOverUnder: 9,
        prelimsWithoutExpectationCount: 1,
      })
    );
    expect(text()).toContain('13.0');
    expect(notes()[0]!.textContent).toBe('1 seed past table');
    expect(noExpectationTexts()).toHaveLength(0);
    noBareZero();
  });
});

describe('the prelims diff table', () => {
  const team = (teamName: string, totalPoints: number): TeamScore => ({
    teamName,
    totalPoints,
    swimmers: [],
    color: '#ff0000',
  });
  const projectedTeam = (
    teamName: string,
    expected: number | null,
    withoutExpectationCount: number
  ): ProjectedTeamScore => ({
    teamName,
    swimmers: [],
    color: '#ff0000',
    expected,
    withoutExpectation: Array.from({ length: withoutExpectationCount }, (_, i) => `${EVENT}|${teamName}|s${i}`),
    withoutExpectationCount,
  });

  const props = {
    // Beta has the larger gap to baseline; it has no expectation, so it must still sort last.
    projectedTeams: [team('Alpha U', 22), team('Beta U', 12), team('Gamma U', 31)],
    baselineTeams: [team('Alpha U', 20), team('Beta U', 10), team('Gamma U', 33)],
    prelimsTeams: [projectedTeam('Alpha U', 13, 0), projectedTeam('Gamma U', 28, 2), projectedTeam('Beta U', null, 2)],
    searchQuery: '',
  };

  function rowFor(name: string): HTMLTableRowElement {
    const rows = [...document.body.querySelectorAll('tbody tr')] as HTMLTableRowElement[];
    const row = rows.find(r => r.textContent!.includes(name));
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  }

  it('keeps a team with no expectation, shows the dash text and no figure against 0', () => {
    render(React.createElement(PrelimsDiffTable, props));
    const beta = rowFor('Beta U');
    expect(beta.textContent).toContain('— (2 seeds past table)');
    // Baseline 10.0 and projected 12.0 are real. No over/under is worked out against nothing:
    // 10.0 and 12.0 each appear once (the baseline and projected columns), never as an over/under.
    expect(beta.textContent!.match(/10\.0/g)).toHaveLength(1);
    expect(beta.textContent!.match(/12\.0/g)).toHaveLength(1);
    expect(beta.querySelectorAll('[data-no-expectation-dash]')).toHaveLength(2);
    noBareZero();
  });

  it('shows a partial team its sum with the note, and its over/under as before', () => {
    render(React.createElement(PrelimsDiffTable, props));
    const gamma = rowFor('Gamma U');
    expect(gamma.textContent).toContain('28.0');
    expect(gamma.textContent).toContain('2 seeds past table');
    expect(gamma.textContent).toContain('+5.0'); // baseline 33 - 28
    expect(gamma.textContent).toContain('+3.0'); // projected 31 - 28
    expect(noExpectationTexts(gamma)).toHaveLength(0);
  });

  it('a team with no seed past the table has no note', () => {
    render(React.createElement(PrelimsDiffTable, props));
    const alpha = rowFor('Alpha U');
    expect(alpha.textContent).not.toContain('seed');
    expect(alpha.textContent).toContain('13.0');
    expect(alpha.textContent).toContain('+7.0');
    expect(alpha.textContent).toContain('+9.0');
  });

  it('sorts the team with no expectation last', () => {
    render(React.createElement(PrelimsDiffTable, props));
    const names = [...document.body.querySelectorAll('tbody tr')].map(r => r.textContent!);
    expect(names).toHaveLength(3);
    expect(names[0]).toContain('Alpha U'); // larger over/under: +7.0 and +9.0
    expect(names[1]).toContain('Gamma U'); // +5.0 and +3.0
    expect(names[2]).toContain('Beta U'); // no over/under: after every row that has one
  });
});

describe('the team card', () => {
  const row = (name: string, points: number, event = EVENT): SwimmerResult =>
    ({
      id: `Beta U-${name}-${event}`,
      rank: 1,
      name,
      classYear: 'JR',
      team: 'Beta U',
      time: '50.00',
      points,
      event,
      gender: Gender.MEN,
      roundSwam: 'A Final',
    }) as SwimmerResult;

  const team: TeamScore = {
    teamName: 'Beta U',
    totalPoints: 12,
    color: '#ff0000',
    swimmers: [row('Bea', 7), row('Bo', 5, 'Event 7 Men 200 Yard Freestyle')],
  };

  const renderCard = (extra: Record<string, unknown>) =>
    render(
      React.createElement(TeamCard as unknown as React.ComponentType<Record<string, unknown>>, {
        team,
        index: 0,
        gender: Gender.MEN,
        showPrelimsPerformance: true,
        prelimsOuByEntry: new Map(),
        baselineScore: 10,
        ...extra,
      })
    );

  it('the team card header shows "— (N seeds past table)" for a team with no expected figure', () => {
    renderCard({ prelimsWithoutExpectationCount: 3 });
    const header = document.body.querySelector('button[aria-expanded]')!;
    expect(header.textContent).toContain('Prelims — (3 seeds past table)');
    expect(noExpectationTexts(header)).toHaveLength(1);
    expect(header.textContent).toContain('Beta U');
    noBareZero();
  });

  it('the team card header shows the sum and the note for a partial team', () => {
    renderCard({
      prelimsProjectedScore: 13,
      baselineOverUnder: -3,
      projectedOverUnder: -1,
      prelimsWithoutExpectationCount: 2,
    });
    const header = document.body.querySelector('button[aria-expanded]')!;
    expect(header.textContent).toContain('Prelims 13.0');
    expect(notes(header)[0]!.textContent).toBe('2 seeds past table');
    noBareZero();
  });

  it('the momentum note follows the anchor', () => {
    renderCard({
      showPsychPerformance: true,
      psychOuByEntry: new Map(),
      prelimsWithoutExpectationCount: 1,
      psychWithoutExpectationCount: 4,
    });
    const note = () => document.body.querySelector('[data-testid="momentum-no-expectation-note"]');
    expect(note()!.textContent).toContain('1 seed past table');
    expect(note()!.textContent).not.toContain('4 seeds');
    const psychButton = [...document.body.querySelectorAll('button')].find(
      b => b.getAttribute('aria-label') === 'Show team momentum versus psych sheet'
    )!;
    act(() => {
      psychButton.click();
    });
    expect(note()!.textContent).toContain('4 seeds past table');
  });

  it('the psych momentum total leaves the baseline points of left-out entries out', () => {
    // Baseline 10 holds 2 points from an entry with no psych expectation. Psych expects 7.
    renderCard({
      showPsychPerformance: true,
      psychOuByEntry: new Map(),
      psychProjectedScore: 7,
      psychBaselineLeftOut: 2,
      psychWithoutExpectationCount: 1,
    });
    const psychButton = [...document.body.querySelectorAll('button')].find(
      b => b.getAttribute('aria-label') === 'Show team momentum versus psych sheet'
    )!;
    act(() => {
      psychButton.click();
    });
    const heading = [...document.body.querySelectorAll('h4')].find(h => h.textContent === 'Momentum vs Psych')!;
    const total = heading.parentElement!.textContent ?? '';
    expect(total).toContain('+1.0');
    expect(total).not.toContain('+3.0');
  });

  it('the psych momentum total is baseline minus psych when nothing is left out', () => {
    renderCard({
      showPsychPerformance: true,
      psychOuByEntry: new Map(),
      psychProjectedScore: 7,
    });
    const psychButton = [...document.body.querySelectorAll('button')].find(
      b => b.getAttribute('aria-label') === 'Show team momentum versus psych sheet'
    )!;
    act(() => {
      psychButton.click();
    });
    const heading = [...document.body.querySelectorAll('h4')].find(h => h.textContent === 'Momentum vs Psych')!;
    expect(heading.parentElement!.textContent).toContain('+3.0');
  });

  it('shows no momentum note for a team with no seed past the table', () => {
    renderCard({ prelimsProjectedScore: 13, baselineOverUnder: -3, prelimsWithoutExpectationCount: 0 });
    expect(document.body.querySelector('[data-testid="momentum-no-expectation-note"]')).toBeNull();
  });
});

describe('the standings step', () => {
  // Scored swimmers, so the card's own point totals are real figures and not 0.0.
  const scored = (name: string, points: number): SwimmerResult =>
    ({
      id: `Beta U-${name}`,
      rank: 1,
      name,
      classYear: 'JR',
      team: 'Beta U',
      time: '50.00',
      points,
      event: EVENT,
      gender: Gender.MEN,
      roundSwam: 'A Final',
    }) as SwimmerResult;
  const team: TeamScore = {
    teamName: 'Beta U',
    totalPoints: 12,
    color: '#ff0000',
    swimmers: [scored('Bea', 7), scored('Bo', 5)],
  };
  const props = {
    reconciliationSummary: { status: 'none', rows: [] },
    scoringSettings: { scoringPoints: [9, 4, 3, 2, 1] },
    searchQuery: '',
    onSearchChange: () => undefined,
    teamsWithLineStyles: [team],
    gender: Gender.MEN,
    visibleEvents: [],
    officialLookup: new Map(),
    baselineByTeam: new Map([['Beta U', 10]]),
    // Beta has no expected figure: absent from the numeric map, present in the count map.
    prelimsByTeam: new Map<string, number>(),
    psychByTeam: new Map<string, number>(),
    prelimsWithoutExpectationByTeam: new Map([['Beta U', 5]]),
    psychWithoutExpectationByTeam: new Map<string, number>(),
    showPrelimsPerformance: true,
    prelimsOuByEntry: new Map(),
    showPsychPerformance: false,
    psychOuByEntry: new Map(),
    scoringRefreshKey: 0,
    topContributors: [],
  };

  it('keeps the team and shows its count where the expected figure would be, with no over/under', () => {
    render(React.createElement(MeetOpsStandingsStep as unknown as React.ComponentType<Record<string, unknown>>, props));
    const header = document.body.querySelector('button[aria-expanded]')!;
    expect(header.textContent).toContain('Beta U');
    expect(header.textContent).toContain('Prelims — (5 seeds past table)');
    // No over/under was worked out against the absent figure.
    expect(header.textContent).not.toContain('vs prelims');
    noBareZero();
  });
});

describe('the analyze step', () => {
  const emptyBundle = {
    allResults: [],
    allScored: [],
    events: [],
    visibleEvents: [],
    sortedTeams: [],
    timelineData: [],
    teamStyleSignature: '',
  };

  it('the prelims difference table lists the team with no expectation', () => {
    const beta: ProjectedTeamScore = {
      teamName: 'Beta U',
      swimmers: [],
      color: '#ff0000',
      expected: null,
      withoutExpectation: ['a', 'b'],
      withoutExpectationCount: 2,
    };
    render(
      React.createElement(MeetOpsAnalyzeStep as unknown as React.ComponentType<Record<string, unknown>>, {
        chartTheme: {
          chartGrid: 'var(--chart-grid)',
          chartTick: 'var(--chart-tick)',
          accent: 'var(--text-accent)',
          isHighContrast: false,
          isDark: true,
        },
        showPrelimsPerformance: true,
        showPsychPerformance: false,
        timelineData: [],
        timelineChartKey: 'k',
        teamsWithLineStyles: [{ teamName: 'Beta U', totalPoints: 12, swimmers: [], color: '#ff0000' }],
        prelimsDeltaByLabel: new Map(),
        meetMomentumAnchor: 'prelims',
        onMeetMomentumAnchorChange: () => undefined,
        meetMomentumData: [],
        analysisView: 'prelims',
        onAnalysisViewChange: () => undefined,
        baselineBundle: {
          ...emptyBundle,
          sortedTeams: [{ teamName: 'Beta U', totalPoints: 10, swimmers: [], color: '#ff0000' }],
        },
        prelimsProjectedBundle: { ...emptyBundle, sortedTeams: [beta] },
        searchQuery: '',
      })
    );
    const row = document.body.querySelector('tbody tr')!;
    expect(row.textContent).toContain('Beta U');
    expect(row.textContent).toContain('— (2 seeds past table)');
    noBareZero();
  });
});

describe('the scoring hook', () => {
  const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more') as ScoringSettings;
  const swim = (team: string, name: string, rank: number): SwimmerResult =>
    ({
      id: `${team}-${name}`,
      rank,
      name,
      classYear: 'JR',
      team,
      time: `${50 + rank}.00`,
      points: 0,
      event: EVENT,
      gender: Gender.MEN,
      roundSwam: 'Preliminaries',
    }) as SwimmerResult;

  it('puts a team with no expectation in the count map and not in the numeric map', () => {
    const workspace = workspaceFixture({
      id: 'ws',
      name: 'ws',
      createdAt: 0,
      menResults: [
        swim('Alpha U', 'Ann', 1),
        swim('Gamma U', 'Gus', 3),
        swim('Gamma U', 'Gil', 9),
        swim('Beta U', 'Bea', 7),
        swim('Beta U', 'Bo', 8),
      ],
      womenResults: [],
      scoringSettings: dual,
    });

    let seen: ReturnType<typeof useWorkspaceScoring> | null = null;
    function Probe() {
      seen = useWorkspaceScoring({ workspace, gender: Gender.MEN, removeSeniors: false, scoringRefreshKey: 0 });
      return null;
    }
    render(React.createElement(Probe));
    const hook = seen!;
    expect([...hook.prelimsByTeam.entries()].sort()).toEqual([
      ['Alpha U', 9],
      ['Gamma U', 3],
    ]);
    expect(hook.prelimsByTeam.has('Beta U')).toBe(false);
    expect([...hook.prelimsWithoutExpectationByTeam.entries()].sort()).toEqual([
      ['Beta U', 2],
      ['Gamma U', 1],
    ]);
    // The team is still in the bundle, with expected null.
    const beta = hook.prelimsProjected.sortedTeams.find(t => t.teamName === 'Beta U');
    expect(beta?.expected).toBeNull();
    expect(hook.psychWithoutExpectationByTeam.size).toBe(0);
  });
});
