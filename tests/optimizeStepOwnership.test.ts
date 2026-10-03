// @vitest-environment happy-dom
/**
 * Phase 4: the Optimize step owns every optimizer.
 *
 * - The "All teams" dialog passes Drop seniors to optimizeRosterAllTeams.
 * - An `unchanged` result applies nothing and arms no Undo.
 * - An applied result shows Undo, and Undo restores the pre-run state.
 * - "Quick optimize (greedy)" sits under "More options" and still offers Undo.
 * - The Lineup step has one "Optimize this lineup" link and no optimizer.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import * as rosterOptimizer from '@omniswim/core/lib/rosterOptimizer';
import RosterOptimizeStep from '../packages/manager/src/components/RosterOptimizeStep';
import TeamRosterPanel from '../packages/manager/src/components/TeamRosterPanel';
import {
  buildBatchApplyPatch,
  computeBatchOptimizationResult,
} from '../packages/manager/src/components/batchOptimizerView';
import {
  HOME_TEAM,
  buildMeetWorkspace,
  resolvedScoringSettings,
  scoringBundleFor,
} from './optimizerStepFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);
// Pass-through spy: the real optimizer still runs, the test only watches its arguments.
vi.mock('@omniswim/core/lib/rosterOptimizer', async importOriginal => {
  const actual = await importOriginal<typeof import('@omniswim/core/lib/rosterOptimizer')>();
  return { ...actual, optimizeRosterAllTeams: vi.fn(actual.optimizeRosterAllTeams) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const allTeamsSpy = vi.mocked(rosterOptimizer.optimizeRosterAllTeams);

// A gain exists (a strong history time in an event HSU did not swim) and two HSU
// swimmers are seniors, so Drop seniors changes the field.
const gainWorkspace = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });
// Every candidate event is held at the meet, so nothing beats the current lineup.
const heldWorkspace = () => buildMeetWorkspace();

describe('Optimize step owns the all-teams optimizer', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    allTeamsSpy.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const buttons = () => Array.from(container.querySelectorAll('button'));
  const findButton = (text: RegExp) =>
    buttons().find(b => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''));
  const click = async (text: RegExp) => {
    const button = findButton(text);
    expect(button, `button ${text}`).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const settle = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
    });

  async function renderStep(
    ws: Workspace,
    options: { removeSeniors?: boolean; whatIfMode?: boolean; selectedTeam?: string } = {}
  ) {
    const updates: Array<Partial<Workspace>> = [];
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(RosterOptimizeStep, {
            workspace: ws,
            gender: Gender.MEN,
            scoringSettings: resolvedScoringSettings(ws),
            whatIfMode: options.whatIfMode ?? true,
            removeSeniors: options.removeSeniors ?? false,
            selectedTeam: options.selectedTeam ?? HOME_TEAM,
            teams: [HOME_TEAM],
            onUpdate: (patch: Partial<Workspace>) => updates.push(patch),
          })
        )
      );
    });
    return updates;
  }

  const runAllTeamsDialog = async () => {
    await click(/^All teams…$/);
    await click(/Run Optimizer/);
    await settle();
  };

  it('passes Drop seniors on to optimizeRosterAllTeams', async () => {
    await renderStep(gainWorkspace(), { removeSeniors: true });
    await runAllTeamsDialog();
    expect(allTeamsSpy).toHaveBeenCalledTimes(1);
    // (workspace, gender, removeSeniors, settings, stage)
    expect(allTeamsSpy.mock.calls[0][2]).toBe(true);
    expect(container.textContent).toContain('Drop seniors is on');
  });

  it('passes Drop seniors off when it is off', async () => {
    await renderStep(gainWorkspace(), { removeSeniors: false });
    await runAllTeamsDialog();
    expect(allTeamsSpy.mock.calls[0][2]).toBe(false);
    expect(container.textContent).toContain('Drop seniors is off');
  });

  it('computeBatchOptimizationResult hands removeSeniors to the optimizer, and it changes the answer', () => {
    const ws = gainWorkspace();
    const settings = resolvedScoringSettings(ws);
    const kept = computeBatchOptimizationResult(ws, Gender.MEN, settings, 'all', false);
    const dropped = computeBatchOptimizationResult(ws, Gender.MEN, settings, 'all', true);
    expect(allTeamsSpy.mock.calls.map(call => call[2])).toEqual([false, true]);
    // If the flag were ignored, both runs would start from the same field.
    expect(dropped.optimizer.previousTotal).not.toBe(kept.optimizer.previousTotal);
  });

  it('an unchanged result applies nothing and arms no Undo', async () => {
    const ws = heldWorkspace();
    const updates = await renderStep(ws);
    await runAllTeamsDialog();
    const apply = findButton(/Apply to Workspace/) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await click(/Apply to Workspace/);
    expect(updates).toHaveLength(0);
    expect(container.textContent).toContain('nothing was applied');
    expect(findButton(/Undo this optimize/)).toBeUndefined();
  });

  it('buildBatchApplyPatch returns no patch for an unchanged result and all three fields otherwise', () => {
    const held = heldWorkspace();
    const unchanged = computeBatchOptimizationResult(held, Gender.MEN, resolvedScoringSettings(held), 'all', false);
    expect(unchanged.outcome).toBe('unchanged');
    expect(buildBatchApplyPatch(unchanged)).toBeNull();

    const gain = gainWorkspace();
    const improved = computeBatchOptimizationResult(gain, Gender.MEN, resolvedScoringSettings(gain), 'all', false);
    expect(improved.outcome).toBe('improved');
    const patch = buildBatchApplyPatch(improved)!;
    expect(Object.keys(patch).sort()).toEqual(['activeEntryIds', 'meetEntryPlans', 'scorerRosterOverrides']);
  });

  it('an applied all-teams run shows Undo, and Undo restores the pre-run state', async () => {
    const ws = gainWorkspace();
    const updates = await renderStep(ws);
    await runAllTeamsDialog();
    await click(/Apply to Workspace/);
    expect(updates).toHaveLength(1);
    expect(updates[0].meetEntryPlans?.length).toBeGreaterThan(0);

    expect(findButton(/Undo this optimize/)).toBeTruthy();
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({
      scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
      meetEntryPlans: ws.meetEntryPlans ?? [],
      activeEntryIds: ws.activeEntryIds ?? [],
    });
  });

  it('is disabled while What-if is off', async () => {
    await renderStep(gainWorkspace(), { whatIfMode: false });
    expect((findButton(/^All teams…$/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is reachable before a team is chosen', async () => {
    await renderStep(gainWorkspace(), { selectedTeam: '' });
    const allTeams = findButton(/^All teams…$/) as HTMLButtonElement;
    expect(allTeams.disabled).toBe(false);
    await runAllTeamsDialog();
    expect(allTeamsSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the old header Batch optimizer name out of the step', async () => {
    await renderStep(gainWorkspace());
    expect(container.textContent).not.toMatch(/Batch optimizer/i);
  });

  describe('Quick optimize (greedy)', () => {
    it('lives under a collapsed More options disclosure that toggles aria-expanded', async () => {
      await renderStep(gainWorkspace());
      const toggle = findButton(/^More options$/) as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const quick = findButton(/Quick optimize \(greedy\)/)!;
      expect(quick.closest('[role="region"]')?.hasAttribute('hidden')).toBe(true);
      await click(/^More options$/);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(quick.closest('[role="region"]')?.hasAttribute('hidden')).toBe(false);
      expect(findButton(/^Classic$/)).toBeUndefined();
    });

    it('still shows Undo after applying, and Undo restores the pre-run state', async () => {
      const ws = gainWorkspace();
      const updates = await renderStep(ws);
      await click(/Quick optimize \(greedy\)/);
      expect(updates).toHaveLength(1);
      await click(/Undo this optimize/);
      expect(updates).toHaveLength(2);
      expect(updates[1].meetEntryPlans).toEqual(ws.meetEntryPlans ?? []);
    });

    it('applies nothing and offers no Undo when nothing beats the lineup', async () => {
      const updates = await renderStep(heldWorkspace());
      await click(/Quick optimize \(greedy\)/);
      expect(updates).toHaveLength(0);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
    });
  });
});

describe('Lineup step has one Optimize this lineup link and no optimizer of its own', () => {
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

  async function renderPanel(
    onOpenOptimize: (() => void) | undefined,
    onWorkspaceUpdate: (patch: Partial<Workspace>) => void
  ) {
    const ws = gainWorkspace();
    const bundle = scoringBundleFor(ws, false);
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(TeamRosterPanel, {
            results: bundle.allResults,
            scoredResults: bundle.allScored,
            settings: resolvedScoringSettings(ws),
            gender: Gender.MEN,
            overrides: [],
            onChangeOverrides: () => {},
            editable: true,
            projectedByTeam: new Map(bundle.sortedTeams.map(t => [t.teamName, t.totalPoints])),
            baselineByTeam: new Map(),
            showTeamSidebar: false,
            teamPickerMode: 'dropdown',
            hideTeamSelect: true,
            selectedTeam: HOME_TEAM,
            workspace: ws,
            onOpenOptimize,
            onWorkspaceUpdate,
          })
        )
      );
    });
  }

  const labels = () => Array.from(container.querySelectorAll('button')).map(b => (b.textContent ?? '').trim());

  it('shows one Optimize this lineup button that opens the Optimize step and writes nothing', async () => {
    const onOpenOptimize = vi.fn();
    const onWorkspaceUpdate = vi.fn();
    await renderPanel(onOpenOptimize, onWorkspaceUpdate);
    expect(labels().filter(label => label === 'Optimize this lineup')).toHaveLength(1);
    expect(labels()).not.toContain('Best roster');
    expect(labels()).not.toContain('All teams');
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Optimize this lineup')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenOptimize).toHaveBeenCalledTimes(1);
    expect(onWorkspaceUpdate).not.toHaveBeenCalled();
  });

  it('hides the link when no Optimize step is wired', async () => {
    await renderPanel(undefined, vi.fn());
    expect(labels()).not.toContain('Optimize this lineup');
  });
});
