// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C7-UI: where a projection shows an over/under or a momentum value, an entry
 * with no actual result yet shows a visible dash with the words "No result
 * yet" for a screen reader. It never shows 0.
 *
 * The fixtures carry a null actual on purpose: the real data has none.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - TeamCardMatrixRow drops noActual                   -> "a swimmer row with no result shows the marker"
 *  - TeamCardTooltips swimmer row drops noActual        -> "the event tooltip row ..."
 *  - TooltipHeader / TeamCard eventData drop noActual   -> "the event tooltip header ..."
 *  - group marker removed                               -> "a group whose sum skipped an entry ..."
 *  - momentum note removed                              -> "the momentum card says how many ..."
 *  - multi tooltip reads null as 0                      -> "the meet momentum tooltip ..."
 *  - helpers: rowHasNoActual / countGroupEntriesWithoutActual / eventsWithoutActual unit cases
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gender, type SwimmerResult, type TeamScore } from '../../packages/core/src/types';
import { buildPrelimsOverUnderByEntryKey } from '../../packages/core/src/lib/prelimsProjection';

vi.mock('motion/react', async () => (await import('../../tests/motionStub')).motionStub);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('recharts', async () => {
  const React = await import('react');
  const h = React.createElement;
  const Nothing = () => null;
  type ChartProps = {
    data?: unknown;
    children?: React.ReactNode;
    onClick?: (state: unknown) => void;
  };
  return {
    // A chart with a click handler gets a button that fires it at the first point.
    LineChart: ({ data, children, onClick }: ChartProps) =>
      h(
        'div',
        { 'data-testid': 'line-chart', 'data-rows': JSON.stringify(data) },
        onClick
          ? h('button', {
              type: 'button',
              'data-testid': 'pin-point',
              onClick: () => onClick({ activeTooltipIndex: 1, activeCoordinate: { x: 10, y: 10 } }),
            })
          : null,
        children
      ),
    // The tooltip's `content` is called with a null value for one team, as recharts does.
    Tooltip: ({ content }: { content?: (p: unknown) => React.ReactNode }) =>
      content
        ? h(
            'div',
            { 'data-testid': 'chart-tooltip' },
            content({
              active: true,
              label: 'Free',
              payload: [
                { dataKey: 'Alpha U', value: -4 },
                { dataKey: 'Beta U', value: null },
              ],
            })
          )
        : null,
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

import { eventsWithoutActual, countGroupEntriesWithoutActual, rowHasNoActual } from '../packages/matrix/src/lib/noActual';
import { NoActualMarker, PrelimsOuValue } from '../packages/matrix/src/components/matrixPresentation';
import { TeamCardMatrixList } from '../packages/matrix/src/components/TeamCardMatrixList';
import { TooltipHeader, TooltipSwimmerRow } from '../packages/matrix/src/components/TeamCardTooltips';
import MomentumChartCard from '../packages/matrix/src/components/MomentumChartCard';
import TeamCard from '../packages/matrix/src/components/TeamCard';
import { MeetOpsAnalyzeStep } from '../packages/matrix/src/components/MeetOpsAnalyzeStep';

const EVENT_A = 'Event 5 Men 100 Yard Backstroke';
const EVENT_B = 'Event 7 Men 200 Yard Freestyle';

const row = (name: string, team: string, points: number, event = EVENT_A): SwimmerResult =>
  ({
    id: `${team}-${name}-${event}`,
    rank: 1,
    name,
    classYear: 'JR',
    team,
    time: '50.00',
    points,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
  }) as SwimmerResult;

// Ann has a baseline result (9 of an expected 17). Bea's swim has no baseline row: no actual yet.
const ANN_EXPECTED = row('Ann', 'Alpha U', 17, EVENT_A);
const BEA_EXPECTED = row('Bea', 'Alpha U', 16, EVENT_B);
const ANN_ACTUAL = row('Ann', 'Alpha U', 9, EVENT_A);
const BEA_NO_RESULT = row('Bea', 'Alpha U', 0, EVENT_B);
const LOOKUP = buildPrelimsOverUnderByEntryKey([ANN_ACTUAL], [ANN_EXPECTED, BEA_EXPECTED]);

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

const markers = (scope: ParentNode = document.body) => [...scope.querySelectorAll('[data-no-actual]')];
const text = () => document.body.textContent ?? '';

describe('the marker', () => {
  it('draws a dash and the words "No result yet" for a screen reader', () => {
    render(React.createElement(NoActualMarker));
    const marker = markers()[0];
    expect(marker!.querySelector('[aria-hidden="true"]')!.textContent).toBe('—');
    expect(marker!.querySelector('.sr-only')!.textContent).toBe('No result yet');
    expect(marker!.getAttribute('title')).toBe('No result yet');
  });

  it('PrelimsOuValue draws it for a null value only when asked, and never draws 0', () => {
    render(
      React.createElement(
        'div',
        null,
        React.createElement(PrelimsOuValue, { value: null, noActual: true }),
        React.createElement(PrelimsOuValue, { value: undefined }),
        React.createElement(PrelimsOuValue, { value: -8, noActual: true, compact: true })
      )
    );
    expect(markers()).toHaveLength(1);
    expect(text()).toContain('-8.0');
    expect(text()).not.toMatch(/(^|[^\d.])0\.0/);
  });
});

describe('helpers read hasActual', () => {
  it('rowHasNoActual is true only for a row whose entry has no actual and no credited points', () => {
    expect(rowHasNoActual(BEA_NO_RESULT, LOOKUP)).toBe(true);
    expect(rowHasNoActual(ANN_ACTUAL, LOOKUP)).toBe(false);
    // A row with no entry in the lookup (timed finals, no expected) is not "no actual".
    expect(rowHasNoActual(row('Cy', 'Beta U', 0), LOOKUP)).toBe(false);
  });

  it('countGroupEntriesWithoutActual counts each entry once', () => {
    expect(countGroupEntriesWithoutActual([ANN_ACTUAL, BEA_NO_RESULT, BEA_NO_RESULT], LOOKUP)).toBe(1);
    expect(countGroupEntriesWithoutActual([ANN_ACTUAL], LOOKUP)).toBe(0);
  });

  it('eventsWithoutActual names the events of one team', () => {
    expect([...eventsWithoutActual(LOOKUP, 'Alpha U')]).toEqual([EVENT_B]);
    expect([...eventsWithoutActual(LOOKUP, 'Beta U')]).toEqual([]);
    expect([...eventsWithoutActual(undefined, 'Alpha U')]).toEqual([]);
  });
});

describe('team card swimmer rows and groups', () => {
  const baseProps = {
    viewMode: 'event' as const,
    gender: Gender.MEN,
    teamName: 'Alpha U',
    showPrelimsPerformance: true,
    prelimsOuByEntry: LOOKUP,
    onUpdateTime: () => undefined,
    editingResultId: null,
    editValue: '',
    onStartEdit: () => undefined,
    onEditValueChange: () => undefined,
    onCancelEdit: () => undefined,
  };

  it('a swimmer row with no result shows the marker; a row with a result shows its over/under', () => {
    render(
      React.createElement(TeamCardMatrixList, {
        ...baseProps,
        groups: [
          { event: EVENT_A, points: 9, swimmers: [ANN_ACTUAL] },
          { event: EVENT_B, points: 0, swimmers: [BEA_NO_RESULT] },
        ],
      } as never)
    );
    const cards = [...container!.querySelectorAll('.group')];
    expect(cards).toHaveLength(2);
    // Ann: -8.0, no marker. Bea: marker, and no "0.0" over/under.
    expect(cards[0]!.textContent).toContain('-8.0');
    expect(markers(cards[0])).toHaveLength(0);
    // The swimmer row's own marker says exactly "No result yet" (the group marker's words are longer).
    const rowMarkers = markers(cards[1]).filter(el => el.querySelector('.sr-only')!.textContent === 'No result yet');
    expect(rowMarkers).toHaveLength(1);
  });

  it('a group whose sum skipped an entry says so and does not call the sum 0', () => {
    render(
      React.createElement(TeamCardMatrixList, {
        ...baseProps,
        groups: [{ event: 'Mixed', points: 9, swimmers: [ANN_ACTUAL, BEA_NO_RESULT] }],
      } as never)
    );
    const card = container!.querySelector('.group')!;
    const groupMarker = [...card.querySelectorAll('[data-no-actual]')].find(el =>
      el.querySelector('.sr-only')!.textContent!.includes('left out of this over/under')
    );
    expect(groupMarker, 'the group marker').toBeDefined();
    expect(groupMarker!.querySelector('.sr-only')!.textContent).toContain('1 entry is left out');
    expect(card.textContent).toContain('-8.0');
  });

  it('a group with no skipped entry has no group marker', () => {
    render(
      React.createElement(TeamCardMatrixList, {
        ...baseProps,
        groups: [{ event: EVENT_A, points: 9, swimmers: [ANN_ACTUAL] }],
      } as never)
    );
    expect(text()).not.toContain('left out of this over/under');
  });
});

describe('the event tooltip', () => {
  it('the event tooltip row for a swimmer with no result shows the marker', () => {
    render(
      React.createElement(TooltipSwimmerRow, {
        s: BEA_NO_RESULT,
        gender: Gender.MEN,
        teamName: 'Alpha U',
        showPrelimsPerformance: true,
        prelimsOuByEntry: LOOKUP,
      })
    );
    expect(markers()).toHaveLength(1);
  });

  it('the event tooltip header shows the marker for an event with no result and no over/under', () => {
    render(
      React.createElement(TooltipHeader, {
        isClass: false,
        showPrelimsPerformance: true,
        data: { name: EVENT_B, rawEvent: EVENT_B, points: 0, overUnder: null, cumulativeOu: null, noActual: true, swimmers: [] },
      })
    );
    expect(markers()).toHaveLength(1);
  });

  it('the event tooltip header shows nothing extra for an event with no momentum entry at all', () => {
    render(
      React.createElement(TooltipHeader, {
        isClass: false,
        showPrelimsPerformance: true,
        data: { name: EVENT_A, rawEvent: EVENT_A, points: 4, overUnder: null, cumulativeOu: null, noActual: false, swimmers: [] },
      })
    );
    expect(markers()).toHaveLength(0);
  });
});

describe('momentum charts', () => {
  it('the momentum card says how many entries it left out', () => {
    render(
      React.createElement(MomentumChartCard, {
        title: 'Momentum vs Prelims',
        series: [{ rawEvent: EVENT_A, label: 'A', delta: -8, cumulative: -8 }],
        noActualCount: 2,
      })
    );
    const note = document.body.querySelector('[data-testid="momentum-no-actual-note"]')!;
    expect(note.textContent).toContain('2 entries have no result yet');
    expect(note.textContent).toContain('not counted as 0');
  });

  it('the momentum card has no note when every entry has a result', () => {
    render(
      React.createElement(MomentumChartCard, {
        title: 'Momentum vs Prelims',
        series: [{ rawEvent: EVENT_A, label: 'A', delta: -8, cumulative: -8 }],
        noActualCount: 0,
      })
    );
    expect(document.body.querySelector('[data-testid="momentum-no-actual-note"]')).toBeNull();
  });

  it('the meet momentum tooltip shows a marker for a team with no value, and a number for one with a value', () => {
    render(
      React.createElement(MomentumChartCard, {
        mode: 'multi',
        title: 'Meet Momentum vs Prelims',
        data: [{ name: 'Free', 'Alpha U': -4, 'Beta U': null }],
        teams: [
          { teamName: 'Alpha U', color: 'var(--text-accent)' },
          { teamName: 'Beta U', color: 'var(--text-accent)' },
        ],
      })
    );
    const tooltip = document.body.querySelector('[data-testid="chart-tooltip"]')!;
    expect(tooltip.textContent).toContain('-4.0');
    expect(markers(tooltip)).toHaveLength(1);
  });
});

describe('the score timeline tooltip', () => {
  const emptyBundle = {
    allResults: [],
    allScored: [],
    events: [],
    visibleEvents: [],
    sortedTeams: [],
    timelineData: [],
    teamStyleSignature: '',
  };
  const teams = ['Alpha U', 'Beta U'].map(teamName => ({
    teamName,
    totalPoints: 0,
    swimmers: [],
    color: 'var(--text-accent)',
  }));

  it('drops a team whose value is null instead of listing it as 0.0 (Number(null) is 0)', () => {
    render(
      React.createElement(MeetOpsAnalyzeStep, {
        chartTheme: { chartGrid: 'var(--chart-grid)', chartTick: 'var(--chart-tick)', accent: 'var(--text-accent)', isHighContrast: false, isDark: true },
        showPrelimsPerformance: false,
        showPsychPerformance: false,
        timelineData: [{ name: 'E1', 'Alpha U': 10, 'Beta U': null }],
        timelineChartKey: 'k',
        teamsWithLineStyles: teams,
        prelimsDeltaByLabel: new Map(),
        meetMomentumAnchor: 'prelims',
        onMeetMomentumAnchorChange: () => undefined,
        meetMomentumData: [],
        analysisView: 'diff',
        onAnalysisViewChange: () => undefined,
        baselineBundle: emptyBundle,
        prelimsProjectedBundle: emptyBundle,
        searchQuery: '',
      } as never)
    );
    const tooltip = document.body.querySelector('[data-testid="chart-tooltip"]')!;
    expect(tooltip.textContent).toContain('Alpha U');
    expect(tooltip.textContent).not.toContain('Beta U');
  });
});

describe('the team card', () => {
  const team: TeamScore = {
    teamName: 'Alpha U',
    totalPoints: 9,
    color: '#ff0000',
    swimmers: [ANN_ACTUAL, BEA_NO_RESULT],
  };

  function renderCard() {
    render(
      React.createElement(TeamCard as unknown as React.ComponentType<Record<string, unknown>>, {
        team,
        index: 0,
        gender: Gender.MEN,
        showPrelimsPerformance: true,
        prelimsOuByEntry: LOOKUP,
        baselineOverUnder: -8,
        prelimsProjectedScore: 17,
      })
    );
  }

  it('says how many entries its momentum line leaves out', () => {
    renderCard();
    const note = document.body.querySelector('[data-testid="momentum-no-actual-note"]');
    expect(note, 'momentum note').not.toBeNull();
    expect(note!.textContent).toContain('1 entry has no result yet');
  });

  it('the header "vs prelims" difference carries a marker that says it counts the missing entry as 0', () => {
    renderCard();
    const header = document.body.querySelector('button[aria-expanded]')!;
    expect(header.textContent).toContain('vs prelims');
    const marker = markers(header)[0];
    expect(marker, 'header marker').toBeDefined();
    const words = marker!.querySelector('.sr-only')!.textContent!;
    expect(words).toContain('1 entry has no result yet');
    expect(words).toContain('counts it as 0 points');
  });

  it('pinning the event with no result shows the marker in its tooltip header, not an over/under of 0', () => {
    renderCard();
    const rows = JSON.parse(
      document.body.querySelector('[data-testid="line-chart"]')!.getAttribute('data-rows')!
    ) as Array<{ rawEvent: string; overUnder: number | null; cumulativeOu: number | null; noActual: boolean }>;
    const bea = rows.find(r => r.rawEvent === EVENT_B)!;
    expect(bea.overUnder).toBeNull();
    expect(bea.noActual).toBe(true);
    const ann = rows.find(r => r.rawEvent === EVENT_A)!;
    expect(ann.overUnder).toBe(-8);
    expect(ann.noActual).toBe(false);

    const before = markers().length;
    act(() => {
      (document.body.querySelector('[data-testid="pin-point"]') as HTMLButtonElement).click();
    });
    expect(markers().length).toBeGreaterThan(before);
  });
});
