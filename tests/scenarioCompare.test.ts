// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F3: compare any two saved snapshots. The test scores two real workspaces
 * through `computeScenarioDiff`, so a swapped A/B order or a made-up zero
 * shows up as a wrong number. Written without JSX, like the other panel tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type Workspace } from '@omniswim/core/types';
import type { Snapshot } from '@omniswim/core/api/snapshots';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { computeScenarioDiff } from '@omniswim/core/lib/scenarioDiff';

const contentById = new Map<string, Workspace>();

vi.mock('@omniswim/core/api/snapshots', () => ({
  getSnapshotContent: async (id: string) => {
    const ws = contentById.get(id);
    if (!ws) throw new Error(`no snapshot ${id}`);
    return ws;
  },
}));

// Keep the test off the Worker path: score in-thread with the same function.
vi.mock('@omniswim/core/lib/scenarioDiffClient', async () => {
  const mod = await import('@omniswim/core/lib/scenarioDiff');
  return {
    requestScenarioDiff: async (
      current: Workspace,
      snapshot: Workspace,
      opts: Parameters<typeof mod.computeScenarioDiff>[2]
    ) => mod.computeScenarioDiff(current, snapshot, opts),
  };
});

import ScenarioCompare from '../packages/manager/src/components/ScenarioCompare';
import { ScenarioCompareResult } from '../packages/manager/src/components/ScenarioCompareTables';
import {
  ABSENT_LABEL,
  compareSnapshots,
  rowStatus,
  sidePointsLabel,
  snapshotOptionLabel,
} from '../packages/manager/src/components/scenarioCompareView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEN = Gender.MEN;
const A_FINAL = 'A Final';
const SETTINGS = {
  scoringPoints: [5, 3, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};

function swim(
  id: string,
  name: string,
  team: string,
  event: string,
  time: string,
  rank: number
): Record<string, unknown> {
  return {
    id,
    rank,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    roundSwam: A_FINAL,
  };
}

function workspace(menResults: Record<string, unknown>[]): Workspace {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    scoringSettings: SETTINGS,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
  } as unknown as Workspace;
}

// Snapshot A: Alice 100 Free 50.00 (5), Bob 200 Free 1:50.00 (5). HSU total 10.
const WS_A = workspace([
  swim('a1', 'Alice Adams', 'HSU', '100 Free', '50.00', 1),
  swim('b1', 'Bob Brown', 'HSU', '200 Free', '1:50.00', 1),
  swim('v1', 'Vic Rivers', 'RIV', '100 Free', '51.00', 2),
]);
// Snapshot B: Alice swims faster, Bob is gone, Carl enters 50 Free (5).
// Dan enters 100 Back (5). HSU total 15.
const WS_B = workspace([
  swim('a1', 'Alice Adams', 'HSU', '100 Free', '49.50', 1),
  swim('c1', 'Carl Cole', 'HSU', '50 Free', '22.00', 1),
  swim('d1', 'Dan Drake', 'HSU', '100 Back', '55.00', 1),
  swim('v1', 'Vic Rivers', 'RIV', '100 Free', '51.00', 2),
]);

const SNAPSHOTS: Snapshot[] = [
  { id: 'snap-b', workspaceId: 'ws', label: 'Depth plan · 15.0 pts', createdAt: 2000 },
  { id: 'snap-a', workspaceId: 'ws', label: 'Opening plan · 10.0 pts', createdAt: 1000 },
];

const EMPTY_SNAPSHOT: Snapshot = { id: 'snap-empty', workspaceId: 'ws', label: 'No HSU plan', createdAt: 500 };
const CONTEXT = { team: 'HSU', gender: MEN, settings: SETTINGS, removeSeniors: false };

describe('ScenarioCompare (F3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    contentById.clear();
    contentById.set('snap-a', WS_A);
    contentById.set('snap-b', WS_B);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(
    loadDiff = (a: string, b: string) => compareSnapshots(a, b, CONTEXT),
    snapshots: Snapshot[] = SNAPSHOTS
  ) {
    await act(async () => {
      root.render(createElement(ScenarioCompare, { snapshots, loadDiff }));
    });
  }

  function select(label: string): HTMLSelectElement {
    const labels = [...container.querySelectorAll('label')];
    const found = labels.find(l => (l.textContent ?? '').includes(label));
    if (!found) throw new Error(`no label ${label}`);
    return container.querySelector<HTMLSelectElement>(`#${CSS.escape(found.htmlFor)}`)!;
  }

  async function choose(sel: HTMLSelectElement, id: string) {
    await act(async () => {
      sel.value = id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('offers both pickers as labelled text selects with every snapshot', async () => {
    await mount();
    const a = select('Snapshot A');
    const b = select('Snapshot B');
    expect(a.tagName).toBe('SELECT');
    expect(b.tagName).toBe('SELECT');
    expect(a.tabIndex).toBeGreaterThanOrEqual(0);
    const optionsA = [...a.options].map(o => o.textContent);
    expect(optionsA).toEqual([
      'Choose a snapshot',
      snapshotOptionLabel(SNAPSHOTS[0]),
      snapshotOptionLabel(SNAPSHOTS[1]),
    ]);
    expect(optionsA[1]).toContain('Depth plan');
    expect(optionsA[1]).toContain('15.0 pts');
    expect(container.textContent).toContain('Choose a snapshot for A and for B');
  });

  it('shows totals, change, added and removed events and a clock change for A to B', async () => {
    await mount();
    await choose(select('Snapshot A'), 'snap-a');
    expect(container.textContent).toContain('Choose a snapshot for A and for B');
    await choose(select('Snapshot B'), 'snap-b');

    const tables = container.querySelectorAll('table');
    expect(tables.length).toBe(3);
    const totals = [...tables[0].querySelectorAll('tbody td')].map(td => td.textContent);
    expect(totals).toEqual(['10.0', '15.0', '+5.0']);

    const text = container.textContent ?? '';
    expect(text).toContain('Added 50 Free');
    expect(text).toContain('Added 100 Back');
    expect(text).toContain('Removed 200 Free');
    expect(text).toContain('100 Free: 50.00 to 49.50');
    expect(text).not.toContain('No differences');

    const bobRow = [...tables[1].querySelectorAll('tbody tr')].find(tr =>
      (tr.textContent ?? '').includes('Bob Brown')
    )!;
    // Before, after, change. Bob is absent from B, so the after cell is a dash, not 0.0.
    const bobCells = [...bobRow.querySelectorAll('td')].map(td => td.textContent);
    expect(bobCells.slice(0, 3)).toEqual(['5.0', ABSENT_LABEL, '-5.0']);
    expect(bobRow.querySelector('th')!.textContent).toContain('Bob Brown');
    expect(bobRow.querySelector('th')!.textContent).toContain('(Removed)');

    const carlRow = [...tables[1].querySelectorAll('tbody tr')].find(tr =>
      (tr.textContent ?? '').includes('Carl Cole')
    )!;
    const carlCells = [...carlRow.querySelectorAll('td')].map(td => td.textContent);
    expect(carlCells.slice(0, 3)).toEqual([ABSENT_LABEL, '5.0', '+5.0']);
    expect(carlRow.querySelector('th')!.textContent).toContain('(Added)');

    // Alice swam in both snapshots: numbers on both sides and no status word.
    const aliceRow = [...tables[1].querySelectorAll('tbody tr')].find(tr =>
      (tr.textContent ?? '').includes('Alice Adams')
    );
    expect(aliceRow).toBeDefined();
    expect(aliceRow!.querySelector('th')!.textContent).not.toMatch(/Added|Removed/);
    const aliceCells = [...aliceRow!.querySelectorAll('td')].map(td => td.textContent);
    expect(aliceCells.slice(0, 3)).toEqual(['5.0', '5.0', '0.0']);
  });

  it('shows a dash, not 0.0, for the side of a team that has no rows', async () => {
    const noHsu = workspace([swim('v1', 'Vic Rivers', 'RIV', '100 Free', '51.00', 1)]);
    contentById.set('snap-empty', noHsu);
    await mount(undefined, [...SNAPSHOTS, EMPTY_SNAPSHOT]);
    await choose(select('Snapshot A'), 'snap-empty');
    await choose(select('Snapshot B'), 'snap-b');
    const tables = container.querySelectorAll('table');
    const totals = [...tables[0].querySelectorAll('tbody td')].map(td => td.textContent);
    expect(totals).toEqual([ABSENT_LABEL, '15.0', '+15.0']);
  });

  it('says the team has no results, not "No differences", when neither snapshot has it', async () => {
    const noHsu = workspace([swim('v1', 'Vic Rivers', 'RIV', '100 Free', '51.00', 1)]);
    contentById.set('snap-empty', noHsu);
    await mount(undefined, [...SNAPSHOTS, EMPTY_SNAPSHOT]);
    await choose(select('Snapshot A'), 'snap-empty');
    await choose(select('Snapshot B'), 'snap-empty');
    const text = container.textContent ?? '';
    expect(text).toContain('Neither snapshot has results for HSU');
    expect(text).not.toContain('No differences');
    const totals = [...container.querySelectorAll('tbody td')].map(td => td.textContent);
    expect(totals).toEqual([ABSENT_LABEL, ABSENT_LABEL, ABSENT_LABEL]);
  });

  it('keeps A as before and B as after: swapping the picks flips the sign', async () => {
    await mount();
    await choose(select('Snapshot A'), 'snap-b');
    await choose(select('Snapshot B'), 'snap-a');
    const totals = [...container.querySelectorAll('table')[0].querySelectorAll('tbody td')].map(
      td => td.textContent
    );
    expect(totals).toEqual(['15.0', '10.0', '-5.0']);
    expect(container.textContent).toContain('Removed 50 Free');
    expect(container.textContent).toContain('Added 200 Free');
  });

  it('says "No differences" in text when both pickers hold the same snapshot', async () => {
    await mount();
    await choose(select('Snapshot A'), 'snap-a');
    await choose(select('Snapshot B'), 'snap-a');
    expect(container.textContent).toContain('No differences');
    expect(container.querySelectorAll('table').length).toBe(1);
    const totals = [...container.querySelectorAll('tbody td')].map(td => td.textContent);
    expect(totals).toEqual(['10.0', '10.0', '0.0']);
  });

  it('shows an error in text and keeps the pickers when a snapshot fails to load', async () => {
    const failing = vi.fn(async () => {
      throw new Error('Snapshot fetch failed (404)');
    });
    await mount(failing);
    await choose(select('Snapshot A'), 'snap-a');
    await choose(select('Snapshot B'), 'snap-b');
    expect(failing).toHaveBeenCalledWith('snap-a', 'snap-b');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('404');
  });

  it('ignores a slow answer that a newer pick has replaced', async () => {
    const pending: Array<(r: ScenarioDiffResult) => void> = [];
    const loadDiff = (a: string, b: string) =>
      new Promise<ScenarioDiffResult>(resolve => {
        pending.push(resolve);
        void a;
        void b;
      });
    await mount(loadDiff);
    await choose(select('Snapshot A'), 'snap-a');
    await choose(select('Snapshot B'), 'snap-b');
    await choose(select('Snapshot B'), 'snap-a');
    const stale = computeScenarioDiff(WS_B, WS_A, CONTEXT);
    const fresh = computeScenarioDiff(WS_A, WS_A, CONTEXT);
    await act(async () => {
      pending[1](fresh);
      pending[0](stale);
    });
    expect(container.textContent).toContain('No differences');
  });
});

describe('ScenarioCompareResult empty values', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('writes NT for a missing clock and never 0 or 0.00', async () => {
    const result: ScenarioDiffResult = {
      team: 'HSU',
      gender: MEN,
      totals: { then: 12, now: 12, delta: 0, inThen: true, inNow: true },
      swimmers: [
        {
          name: 'Alice Adams',
          isRelay: false,
          eventsAdded: [],
          eventsRemoved: [],
          eventsChanged: [{ event: '100 Free', timeThen: '', timeNow: '49.50' }],
          pointsThen: 5,
          pointsNow: 5,
          deltaPoints: 0,
          inThen: true,
          inNow: true,
        },
        {
          name: 'Bob Brown',
          isRelay: false,
          eventsAdded: [],
          eventsRemoved: [],
          eventsChanged: [{ event: '200 Free', timeThen: '1:50.00', timeNow: '  ' }],
          pointsThen: 5,
          pointsNow: 5,
          deltaPoints: 0,
          inThen: true,
          inNow: true,
        },
      ],
      events: [],
    };
    await act(async () => {
      root.render(createElement(ScenarioCompareResult, { result, labelA: 'A', labelB: 'B' }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('100 Free: NT to 49.50');
    expect(text).toContain('200 Free: 1:50.00 to NT');
    expect(text).not.toMatch(/(^|[^\d])0\.00/);
    expect(text).not.toMatch(/(^|[^\d.:])0(?![\d.:])/);
    // The change cell of a row that only moved a clock reads "0.0", a real change of zero.
    expect(text).toContain('0.0');
  });
});

describe('absent is not zero in the compare tables', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const swimmerBase = {
    isRelay: false,
    eventsAdded: [] as string[],
    eventsRemoved: [] as string[],
    eventsChanged: [] as { event: string; timeThen: string; timeNow: string }[],
  };

  it('shows 0.0 for a swimmer who scored 0 and a dash for one who was not entered', async () => {
    const result: ScenarioDiffResult = {
      team: 'HSU',
      gender: MEN,
      totals: { then: 5, now: 5, delta: 0, inThen: true, inNow: true },
      swimmers: [
        {
          ...swimmerBase,
          name: 'Zero Zed',
          eventsChanged: [{ event: '200 Free', timeThen: '1:59.00', timeNow: '1:58.00' }],
          pointsThen: 0,
          pointsNow: 0,
          deltaPoints: 0,
          inThen: true,
          inNow: true,
        },
        {
          ...swimmerBase,
          name: 'Gone Gus',
          eventsRemoved: ['100 Back'],
          pointsThen: 0,
          pointsNow: 0,
          deltaPoints: 0,
          inThen: true,
          inNow: false,
        },
        {
          ...swimmerBase,
          name: 'New Nat',
          eventsAdded: ['100 Back'],
          pointsThen: 0,
          pointsNow: 0,
          deltaPoints: 0,
          inThen: false,
          inNow: true,
        },
      ],
      events: [
        {
          event: '100 Back',
          pointsThen: 0,
          pointsNow: 0,
          delta: 0,
          swimmersChanged: 2,
          inThen: true,
          inNow: false,
        },
      ],
    };
    await act(async () => {
      root.render(createElement(ScenarioCompareResult, { result, labelA: 'A', labelB: 'B' }));
    });
    const rows = [...container.querySelectorAll('table')[1].querySelectorAll('tbody tr')];
    const cellsOf = (name: string) => {
      const row = rows.find(tr => (tr.textContent ?? '').includes(name))!;
      return {
        head: row.querySelector('th')!.textContent,
        cells: [...row.querySelectorAll('td')].map(td => td.textContent).slice(0, 3),
      };
    };
    expect(cellsOf('Zero Zed').cells).toEqual(['0.0', '0.0', '0.0']);
    expect(cellsOf('Zero Zed').head).not.toMatch(/Added|Removed/);
    expect(cellsOf('Gone Gus').cells).toEqual(['0.0', ABSENT_LABEL, '0.0']);
    expect(cellsOf('Gone Gus').head).toContain('(Removed)');
    expect(cellsOf('New Nat').cells).toEqual([ABSENT_LABEL, '0.0', '0.0']);
    expect(cellsOf('New Nat').head).toContain('(Added)');

    const eventRow = container.querySelectorAll('table')[2].querySelector('tbody tr')!;
    expect([...eventRow.querySelectorAll('td')].map(td => td.textContent).slice(0, 3)).toEqual([
      '0.0',
      ABSENT_LABEL,
      '0.0',
    ]);
    expect(eventRow.querySelector('th')!.textContent).toContain('(Removed)');
  });

  it('labels helpers: dash for absent, number for present, status in words', () => {
    expect(sidePointsLabel(false, 0)).toBe(ABSENT_LABEL);
    expect(sidePointsLabel(true, 0)).toBe('0.0');
    expect(sidePointsLabel(true, 3.25)).toBe('3.3');
    expect(rowStatus(false, true)).toBe('Added');
    expect(rowStatus(true, false)).toBe('Removed');
    expect(rowStatus(true, true)).toBeNull();
  });
});
