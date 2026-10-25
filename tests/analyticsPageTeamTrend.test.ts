// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C3-UI (U7), X7, X8: the Season analytics page.
 *
 * recharts is replaced with stand-ins that write their props into the DOM, so
 * these tests read the rows and line settings the page hands the chart. They do
 * not test recharts.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - page calls buildSeasonTrends(workspaces) with no team   -> "defaults to the active workspace's own team"
 *  - picker defaults to a team the workspace does not name as its own -> "starts empty until an own team is set"
 *  - own-team button saves nothing, or saves without the key  -> "Make ... my team saves ownTeam"
 *  - picker not wired to the request                         -> "changing the picker changes the chart"
 *  - connectNulls true, or a null read as 0                  -> "a gender the team did not enter is a gap"
 *  - unreadable-rows note dropped                            -> "says how many rows had unreadable points"
 *  - legend or dash pattern removed                          -> "legend names both series..."
 *  - empty state without the Matrix link                     -> "no teams: guidance and a link to Matrix"
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  workspaces: [] as unknown[],
  activeWorkspace: null as unknown,
  updateWorkspace: undefined as unknown as (patch: unknown) => Promise<void>,
}));

vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', () => ({
  useSuiteWorkspace: () => ({
    workspaces: state.workspaces,
    activeWorkspace: state.activeWorkspace,
    updateWorkspace: state.updateWorkspace,
  }),
}));

vi.mock('recharts', async () => {
  const React = await import('react');
  const h = React.createElement;
  const Nothing = () => null;
  return {
    LineChart: ({ data, children }: { data: unknown; children: React.ReactNode }) =>
      h('div', { 'data-testid': 'line-chart', 'data-rows': JSON.stringify(data) }, children),
    Line: (p: { dataKey: string; strokeDasharray?: string; connectNulls?: boolean; dot?: unknown; stroke?: string }) =>
      h('div', {
        'data-testid': `line-${p.dataKey}`,
        'data-dash': p.strokeDasharray ?? '',
        'data-connect-nulls': String(p.connectNulls ?? false),
        'data-has-dot': String(typeof p.dot === 'function'),
        'data-stroke': p.stroke ?? '',
      }),
    CartesianGrid: Nothing,
    Tooltip: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
  };
});

import AnalyticsPage from '../apps/shell/src/pages/AnalyticsPage';
import type { Workspace } from '../packages/core/src/types';

const row = (id: string, team: string, points: number | string) => ({
  id,
  name: `${team} Swimmer ${id}`,
  team,
  event: '100 Free',
  time: '50.00',
  gender: 'Men',
  rank: 1,
  classYear: 'FR',
  points,
  isRelay: false,
});

function ws(name: string, men: unknown[], women: unknown[] = []): Workspace {
  return {
    id: name,
    name,
    createdAt: 1,
    menResults: men,
    womenResults: women,
    recruits: [],
    deletedSwimmers: [],
  } as unknown as Workspace;
}

const TRI = ws(
  'Tri Meet',
  [row('a1', 'Alpha U', 20), row('a2', 'Alpha U', 17), row('b1', 'Beta U', 16), row('b2', 'Beta U', 15), row('c1', 'Gamma U', 14)],
  [row('w1', 'Alpha U', 10)]
);
const DUAL = ws('Dual Meet', [row('a3', 'Alpha U', 30), row('b3', 'Beta U', 20)]);
const OTHER = ws('Other Meet', [row('c2', 'Gamma U', 50)]);
const OWN_ALPHA = {
  ...ws('Alpha roster', [row('o1', 'Alpha U', 0)]),
  scoringSettings: { ownTeam: 'Alpha U' },
} as unknown as Workspace;
const NO_OWN = ws('Alpha roster', [row('o1', 'Alpha U', 0)]);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(MemoryRouter, null, React.createElement(AnalyticsPage)));
  });
}

beforeEach(() => {
  state.workspaces = [TRI, DUAL, OTHER];
  state.activeWorkspace = OWN_ALPHA;
  state.updateWorkspace = vi.fn(async () => undefined);
  // happy-dom lays nothing out. ChartShell draws its chart only once it measures a size.
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

const q = <T extends Element = HTMLElement>(sel: string) => container!.querySelector<T>(sel);
const rows = () => JSON.parse(q('[data-testid="line-chart"]')!.getAttribute('data-rows')!) as Array<Record<string, unknown>>;
const sentence = () => q('[data-testid="season-team-sentence"]')!.textContent!;
const picker = () => q<HTMLSelectElement>('#season-team')!;

function choose(team: string) {
  act(() => {
    const select = picker();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, team);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('which team the chart shows', () => {
  it("defaults to the active workspace's own team", () => {
    render();
    expect(picker().value).toBe('Alpha U');
    expect(sentence()).toContain('Alpha U');
    expect(rows()).toEqual([
      { name: 'Tri Meet', men: 37, women: 10 },
      { name: 'Dual Meet', men: 30, women: null },
    ]);
  });

  it('starts empty until an own team is set, even when the workspace rows name one team', () => {
    state.activeWorkspace = NO_OWN;
    render();
    expect(picker().value).toBe('');
    expect(sentence()).toBe('Choose a team to chart.');
    expect(q('[data-testid="line-chart"]')).toBeNull();
    expect(q('[data-testid="season-own-team-note"]')!.textContent).toBe('No team is set as yours yet.');
    expect(container!.querySelectorAll('[data-testid="season-own-team"] button')).toHaveLength(0);
  });

  it('lists every team the meets name in the picker', () => {
    render();
    const options = [...picker().options].map(o => o.value).filter(Boolean);
    expect(options).toEqual(['Alpha U', 'Beta U', 'Gamma U']);
  });

  it('changing the picker changes the chart', () => {
    render();
    choose('Beta U');
    expect(picker().value).toBe('Beta U');
    expect(rows()).toEqual([
      { name: 'Tri Meet', men: 31, women: null },
      { name: 'Dual Meet', men: 20, women: null },
    ]);
  });
});

describe('the own-team control', () => {
  const saved = () => (state.updateWorkspace as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const button = (label: string) =>
    [...container!.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;
  const click = (b: HTMLButtonElement) => act(() => b.click());

  it('offers to make the picked team my team, and saves it in the workspace settings', () => {
    state.activeWorkspace = NO_OWN;
    render();
    expect(button('Make Alpha U my team')).toBeUndefined();
    choose('Beta U');
    expect(q('[data-testid="season-own-team-note"]')!.textContent).toBe('No team is set as yours yet.');
    click(button('Make Beta U my team')!);
    expect(saved()).toHaveLength(1);
    const patch = saved()[0]![0] as { scoringSettings: { ownTeam: string } };
    expect(patch.scoringSettings.ownTeam).toBe('Beta U');
  });

  it('keeps the other scoring settings when it saves the own team', () => {
    state.activeWorkspace = { ...NO_OWN, scoringSettings: { relayMultiplier: 2, scoringPoints: [9, 7] } } as unknown as Workspace;
    render();
    choose('Beta U');
    click(button('Make Beta U my team')!);
    const patch = saved()[0]![0] as { scoringSettings: Record<string, unknown> };
    expect(patch.scoringSettings).toMatchObject({ relayMultiplier: 2, scoringPoints: [9, 7], ownTeam: 'Beta U' });
  });

  it('with an own team set: says so, offers a different picked team, and can clear', () => {
    render();
    expect(q('[data-testid="season-own-team-note"]')!.textContent).toBe('Your team is Alpha U.');
    expect(button('Make Alpha U my team')).toBeUndefined();
    choose('Gamma U');
    expect(button('Make Gamma U my team')).toBeDefined();
    click(button('Clear my team')!);
    const patch = saved()[0]![0] as { scoringSettings: { ownTeam: string } };
    expect(patch.scoringSettings.ownTeam).toBe('');
  });

  it('is absent when no workspace is open', () => {
    state.activeWorkspace = null;
    render();
    expect(q('[data-testid="season-own-team"]')).toBeNull();
  });
});

describe('absent is a gap, never 0', () => {
  it('a meet the team did not enter has no point, and the page says how many', () => {
    render();
    expect(rows().map(r => r.name)).not.toContain('Other Meet');
    expect(q('[data-testid="season-missing-workspaces"]')!.textContent).toBe(
      '1 of 3 workspaces holds no score for this team and has no point on the chart.'
    );
  });

  it('a gender the team did not enter is a gap: null, not 0, and the line is not joined across it', () => {
    render();
    const dual = rows().find(r => r.name === 'Dual Meet')!;
    expect(dual.women).toBeNull();
    expect(dual.women).not.toBe(0);
    expect(q('[data-testid="line-women"]')!.getAttribute('data-connect-nulls')).toBe('false');
    expect(q('[data-testid="line-men"]')!.getAttribute('data-connect-nulls')).toBe('false');
  });

  it('says how many rows had unreadable points', () => {
    state.workspaces = [ws('Bad Points', [row('a1', 'Alpha U', 20), row('a2', 'Alpha U', 'x?')])];
    render();
    expect(q('[data-testid="season-unreadable-rows"]')!.textContent).toBe(
      '1 row had unreadable points and was left out.'
    );
    expect(rows()).toEqual([{ name: 'Bad Points', men: 20, women: null }]);
  });

  it('shows no unreadable-rows note when every point reads', () => {
    render();
    expect(q('[data-testid="season-unreadable-rows"]')).toBeNull();
  });
});

describe('each selection state has a plain sentence', () => {
  it('several teams and no own team: asks for a pick and plots nothing', () => {
    state.activeWorkspace = null;
    render();
    expect(sentence()).toBe('Choose a team to chart.');
    expect(q('[data-testid="line-chart"]')).toBeNull();
    expect(container!.textContent).toContain('Choose a team above');
    expect(container!.textContent).not.toContain('Load a meet to see');
  });

  it("the workspace's own team is in no meet: says so, does not chart another team", () => {
    state.activeWorkspace = {
      ...ws('Zed roster', [row('z1', 'Zed U', 0)]),
      scoringSettings: { ownTeam: 'Zed U' },
    } as unknown as Workspace;
    render();
    expect(sentence()).toBe('Zed U does not appear in any loaded meet. Pick a team from the list.');
    expect(q('[data-testid="line-chart"]')).toBeNull();
  });

  it('one team in the meets and no own team: still asks, and does not assume that team is theirs', () => {
    state.activeWorkspace = null;
    state.workspaces = [ws('Solo', [row('a1', 'Alpha U', 12)])];
    render();
    expect(picker().value).toBe('');
    expect(sentence()).toBe('Choose a team to chart.');
    expect(q('[data-testid="line-chart"]')).toBeNull();
    expect([...picker().options].map(o => o.value).filter(Boolean)).toEqual(['Alpha U']);
  });

  it('one team in the meets and it is the own team: charts it', () => {
    state.activeWorkspace = OWN_ALPHA;
    state.workspaces = [ws('Solo', [row('a1', 'Alpha U', 12)])];
    render();
    expect(picker().value).toBe('Alpha U');
    expect(rows()).toEqual([{ name: 'Solo', men: 12, women: null }]);
  });

  it('no teams: guidance and a link to Matrix', () => {
    state.workspaces = [];
    state.activeWorkspace = null;
    render();
    expect(sentence()).toBe('No loaded meet names a team yet, so there is nothing to chart.');
    expect(container!.textContent).toContain('Load a meet to see a team');
    const link = q<HTMLAnchorElement>('a[href="/matrix"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('Open Matrix');
  });
});

describe('men and women differ without color', () => {
  it('legend names both series with a line style and a marker shape each', () => {
    render();
    const legend = q('ul[aria-label="Chart legend"]')!;
    const men = legend.querySelector('[data-series="men"]')!;
    const women = legend.querySelector('[data-series="women"]')!;
    expect(men.textContent).toContain('Men');
    expect(women.textContent).toContain('Women');
    expect(men.querySelector('line')!.getAttribute('stroke-dasharray')).toBeNull();
    expect(women.querySelector('line')!.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(men.querySelector('circle')).not.toBeNull();
    expect(men.querySelector('rect')).toBeNull();
    expect(women.querySelector('rect')).not.toBeNull();
    expect(women.querySelector('circle')).toBeNull();
  });

  it('the chart lines carry the same dash and a marker', () => {
    render();
    expect(q('[data-testid="line-men"]')!.getAttribute('data-dash')).toBe('');
    expect(q('[data-testid="line-women"]')!.getAttribute('data-dash')).toBe('6 4');
    expect(q('[data-testid="line-men"]')!.getAttribute('data-has-dot')).toBe('true');
    expect(q('[data-testid="line-women"]')!.getAttribute('data-has-dot')).toBe('true');
  });
});
