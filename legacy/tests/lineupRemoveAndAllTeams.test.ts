// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * X10 (decision U6). Two Lineup actions:
 *
 * 1. A visible Remove button on each roster row. It has a name, it only
 *    asks (the Hide or Remove dialog is the confirmation), and it does not
 *    toggle the row's selection.
 * 2. One-click "Optimize all teams". It applies the engine's patch with no
 *    prompt, writes nothing when the run changes nothing, and its Undo refuses
 *    after a later edit.
 *
 * The engine is stubbed at `requestOptimize`, the worker client the run goes
 * through. Its correctness is covered by bestRosterEquivalence, and the worker
 * path by allTeamsApplyWorker.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToastProvider } from '@omniswim/ui';
import type { Workspace } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';

const compute = vi.hoisted(() => vi.fn());
vi.mock('@omniswim/core/lib/optimizeClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@omniswim/core/lib/optimizeClient')>();
  return { ...actual, requestOptimize: (...args: unknown[]) => Promise.resolve(compute(...args)) };
});

import TeamRosterRow from '../packages/manager/src/components/TeamRosterRow';
import TeamRosterHeader from '../packages/manager/src/components/TeamRosterHeader';
import { useAllTeamsApply } from '../packages/manager/src/components/useAllTeamsApply';
import { BATCH_UNCHANGED_MESSAGE } from '../packages/manager/src/components/batchOptimizerView';
import { UNDO_CHANGED_MESSAGE } from '../packages/manager/src/components/optimizerUndo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  compute.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const settle = (ms = 90) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const buttonByText = (text: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe('Remove button on a roster row', () => {
  const row: ScorerRosterRow = {
    key: 'k1', name: 'Ada Lane', team: 'HSU', gender: 'Men' as ScorerRosterRow['gender'],
    classYear: 'JR', athleteRole: 'swimmer', isScorer: false, source: 'auto',
  };
  const renderRow = (props: Partial<Parameters<typeof TeamRosterRow>[0]>) => {
    const onSelect = vi.fn();
    act(() => {
      root.render(createElement('table', null, createElement('tbody', null, createElement(TeamRosterRow, {
        row, meetPts: 0, isSelected: true, profile: null, describeProfile: () => '',
        warningMessages: [], warningLabel: null, editable: true,
        onSelect, onSetScorer: () => undefined, ...props,
      }))));
    });
    return onSelect;
  };

  it('has an accessible name and opens the confirmation without toggling the selection', () => {
    const onRequestRemove = vi.fn();
    const onSelect = renderRow({ showRemoveColumn: true, onRequestRemove });
    const button = container.querySelector('button[aria-label="Remove Ada Lane from roster"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    act(() => button.click());
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the button on a row that is not selected, and keeps the cell', () => {
    const onRequestRemove = vi.fn();
    renderRow({ showRemoveColumn: true, onRequestRemove, isSelected: false });
    expect(container.querySelector('button[aria-label="Remove Ada Lane from roster"]')).toBeTruthy();
    expect(container.querySelectorAll('td')).toHaveLength(5);
  });

  it('adds no cell when the table has no Remove column', () => {
    renderRow({});
    expect(container.querySelectorAll('td')).toHaveLength(4);
  });
});

describe('Lineup header "Optimize all teams"', () => {
  const baseProps = {
    selectedTeam: 'HSU', genderLabel: "Men's", editable: true, onResetTeam: () => undefined,
    maxIndividualScorersPerTeam: 3, selectedActual: undefined, selectedBaseline: undefined, selectedProjected: 0,
    useDropdown: false, teams: ['HSU'], onSelectTeam: () => undefined,
  };

  it('calls the handler, names itself, and is not the retired exact "All teams" button', () => {
    const onOptimizeAllTeams = vi.fn();
    act(() => root.render(createElement(TeamRosterHeader, { ...baseProps, onOptimizeAllTeams })));
    const button = buttonByText('Optimize all teams');
    expect(button).toBeTruthy();
    expect(button!.textContent?.trim()).not.toBe('All teams');
    act(() => button!.click());
    expect(onOptimizeAllTeams).toHaveBeenCalledTimes(1);
  });

  it('is hidden when no handler is passed and disabled while busy', () => {
    act(() => root.render(createElement(TeamRosterHeader, { ...baseProps })));
    expect(buttonByText('Optimize all teams')).toBeUndefined();
    act(() => root.render(createElement(TeamRosterHeader, { ...baseProps, onOptimizeAllTeams: () => undefined, allTeamsBusy: true })));
    expect(buttonByText('Optimizing')?.disabled).toBe(true);
  });
});

describe('one-click all-teams apply', () => {
  const start = {
    id: 'ws1', conference: 'NSISC',
    scorerRosterOverrides: [{ name: 'Before', team: 'HSU', gender: 'Men', isScorer: true }],
    meetEntryPlans: [], activeEntryIds: [],
  } as unknown as Workspace;
  const optimized = {
    outcome: 'improved',
    overrides: [{ name: 'After', team: 'HSU', gender: 'Men', isScorer: true }],
    meetEntryPlans: [{ id: 'p1' }],
    activeEntryIds: ['p1'],
    projectedTotal: 110,
    previousTotal: 100,
  };

  let current: Workspace;
  const confirmSpy = () => vi.spyOn(window, 'confirm').mockReturnValue(true);

  function Harness({ enabled = true }: { enabled?: boolean }) {
    const [ws, setWs] = useState<Workspace>(start);
    current = ws;
    const { run } = useAllTeamsApply({
      workspace: ws, gender: 'Men' as never, settings: {} as never, editable: enabled,
      onWorkspaceUpdate: patch => setWs(prev => ({ ...prev, ...patch })),
    });
    return createElement('div', null,
      createElement('button', { id: 'run', onClick: run ?? (() => undefined) }, 'run'),
      createElement('button', { id: 'edit', onClick: () => setWs(prev => ({ ...prev, scorerRosterOverrides: [] })) }, 'edit'),
    );
  }
  const mount = (props = {}) => act(() => root.render(createElement(ToastProvider, null, createElement(Harness, props))));
  const click = (id: string) => act(() => (container.querySelector(`#${id}`) as HTMLButtonElement).click());
  const undoButton = () => buttonByText('Undo');

  it('applies the engine patch at once, with no prompt, and offers Undo', async () => {
    const confirm = confirmSpy();
    compute.mockReturnValue(optimized);
    mount();
    click('run');
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(current.scorerRosterOverrides).toEqual(optimized.overrides);
    expect(current.meetEntryPlans).toEqual(optimized.meetEntryPlans);
    expect(current.activeEntryIds).toEqual(optimized.activeEntryIds);
    expect(container.textContent).toContain('+10.0 pts');
    expect(undoButton()).toBeTruthy();
  });

  it('writes nothing when the run changes nothing', async () => {
    compute.mockReturnValue({ ...optimized, outcome: 'unchanged' });
    mount();
    click('run');
    await settle();
    expect(current).toBe(start);
    expect(container.textContent).toContain(BATCH_UNCHANGED_MESSAGE);
    expect(undoButton()).toBeUndefined();
  });

  it('Undo puts the lineup back when nothing changed since', async () => {
    compute.mockReturnValue(optimized);
    mount();
    click('run');
    await settle();
    act(() => undoButton()!.click());
    expect(current.scorerRosterOverrides).toEqual(start.scorerRosterOverrides);
    expect(current.meetEntryPlans).toEqual([]);
    expect(current.activeEntryIds).toEqual([]);
  });

  it('Undo refuses after a later edit and keeps the edit', async () => {
    compute.mockReturnValue(optimized);
    mount();
    click('run');
    await settle();
    const undo = undoButton()!;
    click('edit');
    // The toast is leaving, but its button is still in the page for one transition. Press it.
    act(() => undo.click());
    expect(current.scorerRosterOverrides).toEqual([]);
    expect(current.meetEntryPlans).toEqual(optimized.meetEntryPlans);
    expect(container.textContent).toContain(UNDO_CHANGED_MESSAGE);
  });

  it('drops the Undo when the Lineup step goes away, even if its button is pressed during the exit', async () => {
    compute.mockReturnValue(optimized);
    let setStep: (on: boolean) => void = () => undefined;
    function App() {
      const [on, set] = useState(true);
      setStep = set;
      return createElement(ToastProvider, null, on ? createElement(Harness) : createElement('p', null, 'other step'));
    }
    act(() => root.render(createElement(App)));
    click('run');
    await settle();
    const undo = undoButton()!;
    expect(undo).toBeTruthy();
    const afterRun = { ...current };
    act(() => setStep(false));
    // The toast is leaving but its button is still in the page for one transition. Press it.
    act(() => undo.click());
    expect(container.textContent).not.toContain('undone');
    expect(afterRun.scorerRosterOverrides).toEqual(optimized.overrides);
    await settle(400);
    expect(undoButton()).toBeUndefined();
  });

  it('ignores a second click while a run is working, and does nothing when disabled', async () => {
    compute.mockReturnValue(optimized);
    mount();
    click('run');
    click('run');
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);

    compute.mockClear();
    act(() => root.render(createElement(ToastProvider, null, createElement(Harness, { enabled: false }))));
    click('run');
    await settle();
    expect(compute).not.toHaveBeenCalled();
  });
});
