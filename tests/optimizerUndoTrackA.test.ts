// @vitest-environment happy-dom
/**
 * Track A3: one-shot Undo must not overwrite lineup edits made after the run.
 *
 * Each applied run records a fingerprint of the three optimizer-owned arrays as the run left
 * them. Undo writes the pre-run arrays back only while the live arrays still match that
 * fingerprint. Otherwise it shows a message and waits for an explicit "Undo anyway".
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { Gender, type Workspace } from '@omniswim/core/types';
import RosterOptimizeStep from '../packages/manager/src/components/RosterOptimizeStep';
import {
  UNDO_CHANGED_MESSAGE,
  buildOptimizerUndo,
  fingerprintOptimizerArrays,
  optimizerArraysOf,
  optimizerUndoIsClean,
} from '../packages/manager/src/components/optimizerUndo';
import { HOME_TEAM, buildMeetWorkspace, resolvedScoringSettings } from './optimizerStepFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('optimizerUndo (pure)', () => {
  const plan = (name: string, event: string, extra: Record<string, unknown> = {}) =>
    ({ id: `${name}-${event}`, team: 'T', name, event, time: '20.00', gender: Gender.MEN, ...extra }) as never;

  it('fingerprints content: key order does not matter, array order and values do', () => {
    const a = { overrides: [], plans: [{ a: 1, b: 2 }], activeIds: ['x', 'y'] } as never;
    const sameKeysReordered = { overrides: [], plans: [{ b: 2, a: 1 }], activeIds: ['x', 'y'] } as never;
    expect(fingerprintOptimizerArrays(a)).toBe(fingerprintOptimizerArrays(sameKeysReordered));
    expect(fingerprintOptimizerArrays(a)).not.toBe(
      fingerprintOptimizerArrays({ overrides: [], plans: [{ a: 1, b: 2 }], activeIds: ['y', 'x'] } as never)
    );
    expect(fingerprintOptimizerArrays(a)).not.toBe(
      fingerprintOptimizerArrays({ overrides: [], plans: [{ a: 1, b: 3 }], activeIds: ['x', 'y'] } as never)
    );
  });

  it('treats absent arrays as empty and keeps the three arrays apart', () => {
    expect(fingerprintOptimizerArrays(optimizerArraysOf({}))).toBe(
      fingerprintOptimizerArrays({ overrides: [], plans: [], activeIds: [] })
    );
    // The same item in a different array is a different state.
    expect(fingerprintOptimizerArrays({ overrides: [], plans: [], activeIds: ['x'] })).not.toBe(
      fingerprintOptimizerArrays({ overrides: [], plans: ['x'] as never, activeIds: [] })
    );
  });

  it('is clean only while the live arrays equal what the run left', () => {
    const before = { overrides: [], plans: [plan('A', '50 Free')], activeIds: ['A|50 Free'] };
    const applied = { scorerRosterOverrides: [], meetEntryPlans: [plan('A', '100 Free')], activeEntryIds: ['A|100 Free'] };
    const undo = buildOptimizerUndo({ label: 'T', workspaceId: 'w', before, applied });
    expect(undo.patch).toEqual({ scorerRosterOverrides: [], meetEntryPlans: before.plans, activeEntryIds: before.activeIds });
    expect(optimizerUndoIsClean(undo, optimizerArraysOf(applied))).toBe(true);
    // A copy with equal content is still clean.
    expect(optimizerUndoIsClean(undo, optimizerArraysOf(JSON.parse(JSON.stringify(applied))))).toBe(true);
    // The pre-run state (nothing applied yet) is not what the run left.
    expect(optimizerUndoIsClean(undo, before)).toBe(false);
    // One more edit is not clean, in any of the three arrays.
    expect(optimizerUndoIsClean(undo, optimizerArraysOf({ ...applied, activeEntryIds: [] }))).toBe(false);
    expect(optimizerUndoIsClean(undo, optimizerArraysOf({ ...applied, meetEntryPlans: [] }))).toBe(false);
    expect(
      optimizerUndoIsClean(undo, optimizerArraysOf({ ...applied, scorerRosterOverrides: [{ team: 'T' } as never] }))
    ).toBe(false);
  });
});

describe('Optimize step Undo after later edits', () => {
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

  const buttons = () => Array.from(document.querySelectorAll('button'));
  const findButton = (text: RegExp) =>
    buttons().find(b => text.test(b.textContent ?? '') || text.test(b.getAttribute('aria-label') ?? ''));
  const click = async (text: RegExp) => {
    const button = findButton(text);
    expect(button, `button ${text}`).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });

  const gainWorkspace = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });

  /** The step with a workspace that follows onUpdate, and a way to make an outside edit. */
  async function mount(ws: Workspace, selectedTeam = HOME_TEAM) {
    const updates: Array<Partial<Workspace>> = [];
    const state = { current: ws, team: selectedTeam };
    const draw = () =>
      root.render(createElement(ToastProvider, null,
        createElement(RosterOptimizeStep, {
          workspace: state.current, gender: Gender.MEN, scoringSettings: resolvedScoringSettings(ws),
          whatIfMode: true, removeSeniors: false, selectedTeam: state.team, teams: [HOME_TEAM],
          onUpdate: (p: Partial<Workspace>) => {
            updates.push(p);
            state.current = { ...state.current, ...p };
            draw();
          },
        })));
    await act(async () => draw());
    /** An edit made outside the optimizer (the Lineup step, an import). Does not go through onUpdate. */
    const editOutside = (patch: Partial<Workspace>) => act(async () => {
      state.current = { ...state.current, ...patch };
      draw();
    });
    return { updates, state, editOutside };
  }

  async function applyAllTeams() {
    await click(/^All teams…$/);
    await click(/Run optimizer/);
    await settle();
    await click(/Apply to workspace/);
  }

  const alert = () => document.querySelector('[role="alert"]');

  it('an All-teams run, then a lineup edit, then Undo: refuses with a message and writes nothing', async () => {
    const ws = gainWorkspace();
    const { updates, state, editOutside } = await mount(ws);
    await applyAllTeams();
    expect(updates).toHaveLength(1);

    // The coach edits the lineup after the run.
    const afterRun = state.current;
    const edited = [...(afterRun.activeEntryIds ?? []), 'later-edit|50 Free'];
    await editOutside({ activeEntryIds: edited });

    await click(/Undo this optimize/);
    expect(updates).toHaveLength(1); // nothing written
    expect(alert()?.textContent).toContain(UNDO_CHANGED_MESSAGE);
    expect(UNDO_CHANGED_MESSAGE).toBe('Lineup changed since the run. Undo would discard later edits.');
    expect(findButton(/^Undo anyway$/)).toBeTruthy();
    expect(state.current.activeEntryIds).toEqual(edited); // the later edit is intact
  });

  it('"Undo anyway" writes the pre-run arrays and clears the message', async () => {
    const ws = gainWorkspace();
    const { updates, editOutside } = await mount(ws);
    await applyAllTeams();
    await editOutside({ activeEntryIds: ['later-edit|50 Free'] });
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(1);

    await click(/^Undo anyway$/);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({
      scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
      meetEntryPlans: ws.meetEntryPlans ?? [],
      activeEntryIds: ws.activeEntryIds ?? [],
    });
    expect(alert()).toBeNull();
    expect(findButton(/Undo this optimize/)).toBeUndefined();
  });

  it('"Keep my edits" closes the message, writes nothing and leaves Undo available', async () => {
    const { updates, editOutside } = await mount(gainWorkspace());
    await applyAllTeams();
    await editOutside({ meetEntryPlans: [] });
    await click(/Undo this optimize/);
    expect(alert()).not.toBeNull();

    await click(/^Keep my edits$/);
    expect(alert()).toBeNull();
    expect(updates).toHaveLength(1);
    expect(findButton(/Undo this optimize/)).toBeTruthy();
  });

  it('with no later edit, Undo still writes straight away and shows no message', async () => {
    const ws = gainWorkspace();
    const { updates } = await mount(ws);
    await applyAllTeams();
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(2);
    expect(alert()).toBeNull();
    expect(updates[1].meetEntryPlans).toEqual(ws.meetEntryPlans ?? []);
  });

  it('a per-team Quick optimize is guarded the same way', async () => {
    const { updates, editOutside } = await mount(gainWorkspace());
    await click(/Quick optimize \(greedy\)/);
    expect(updates).toHaveLength(1);
    await editOutside({ activeEntryIds: ['later-edit|50 Free'] });
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(1);
    expect(alert()?.textContent).toContain(UNDO_CHANGED_MESSAGE);
  });

  it('an edit that is later reverted by hand counts as clean', async () => {
    const { updates, state, editOutside } = await mount(gainWorkspace());
    await applyAllTeams();
    const original = state.current.activeEntryIds ?? [];
    await editOutside({ activeEntryIds: [...original, 'tmp|50 Free'] });
    await editOutside({ activeEntryIds: original });
    await click(/Undo this optimize/);
    expect(updates).toHaveLength(2);
    expect(alert()).toBeNull();
  });

  it('dismissing the summary leaves no Undo anywhere, and the next run arms a fresh one', async () => {
    const ws = gainWorkspace();
    const { updates } = await mount(ws);
    await applyAllTeams();
    expect(findButton(/Undo this optimize/)).toBeTruthy();
    await click(/Dismiss optimizer summary/);
    expect(findButton(/Undo this optimize/)).toBeUndefined();
    expect(findButton(/^Undo anyway$/)).toBeUndefined();
    expect(updates).toHaveLength(1);
  });

  it('switching workspace drops the summary and the Undo', async () => {
    const ws = gainWorkspace();
    const { state, editOutside } = await mount(ws);
    await applyAllTeams();
    expect(findButton(/Undo this optimize/)).toBeTruthy();
    // Same arrays, different workspace id: the snapshot must not follow it.
    await editOutside({ id: 'another-workspace' });
    expect(state.current.id).toBe('another-workspace');
    expect(findButton(/Undo this optimize/)).toBeUndefined();
  });
});
