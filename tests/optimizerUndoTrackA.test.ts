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
  APPLY_NOT_SAVED_MESSAGE,
  UNDO_CHANGED_MESSAGE,
  UNDO_NOT_SAVED_MESSAGE,
  buildOptimizerUndo,
  fingerprintOptimizerArrays,
  optimizerArraysOf,
  optimizerUndoIsClean,
  optimizerUndoState,
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
    // A real press focuses the button first. The focus tests depend on that.
    button!.focus();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const toastTexts = () => Array.from(document.querySelectorAll('.toast-message')).map(n => n.textContent ?? '');
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });

  const gainWorkspace = () => buildMeetWorkspace({ unheldEvent: true, seniorIndexes: [2, 3] });

  /** The step with a workspace that follows onUpdate, and a way to make an outside edit. */
  async function mount(ws: Workspace, selectedTeam = HOME_TEAM) {
    const updates: Array<Partial<Workspace>> = [];
    // `applyUpdates: false` models a provider whose save failed and reloaded the server copy:
    // the write is made but the workspace the step sees does not change.
    const state = { current: ws, team: selectedTeam, gender: Gender.MEN, applyUpdates: true };
    const draw = () =>
      root.render(createElement(ToastProvider, null,
        createElement(RosterOptimizeStep, {
          workspace: state.current, gender: state.gender, scoringSettings: resolvedScoringSettings(ws),
          whatIfMode: true, removeSeniors: false, selectedTeam: state.team, teams: [HOME_TEAM],
          onUpdate: (p: Partial<Workspace>) => {
            updates.push(p);
            if (!state.applyUpdates) return;
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
    const setGender = (gender: Gender) => act(async () => {
      state.gender = gender;
      draw();
    });
    return { updates, state, editOutside, setGender };
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

  describe('Undo waits for the save instead of trusting the write (defect 2)', () => {
    // The provider's updateWorkspace resolves before the debounced PUT runs, so no save result
    // can be awaited. The step watches the workspace arrays instead. These tests drive that watch
    // with a workspace that does or does not follow onUpdate.
    const beforeArrays = (ws: Workspace) => ({
      scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
      meetEntryPlans: ws.meetEntryPlans ?? [],
      activeEntryIds: ws.activeEntryIds ?? [],
    });

    it('claims nothing while the workspace has not taken the Undo: no toast, summary and Undo stay', async () => {
      const ws = gainWorkspace();
      const { updates, state } = await mount(ws);
      await applyAllTeams();
      state.applyUpdates = false; // the save fails and the server copy stays in view
      await click(/Undo this optimize/);
      expect(updates).toHaveLength(2); // the write was issued
      expect(toastTexts().some(t => t.startsWith('Undid:'))).toBe(false);
      expect(findButton(/Undo this optimize/)).toBeTruthy();
    });

    it('shows the success toast and drops the summary once the arrays read as the pre-run arrays', async () => {
      const ws = gainWorkspace();
      const { state, editOutside } = await mount(ws);
      await applyAllTeams();
      state.applyUpdates = false;
      await click(/Undo this optimize/);
      expect(toastTexts().some(t => t.startsWith('Undid:'))).toBe(false);
      // The save lands and the provider now shows the pre-run arrays.
      await editOutside(beforeArrays(ws));
      expect(toastTexts()).toContain('Undid: All teams optimize');
      expect(findButton(/Undo this optimize/)).toBeUndefined();
    });

    it('a failed Undo save brings the optimized lineup back: says so and puts the Undo back', async () => {
      const ws = gainWorkspace();
      const { updates, state, editOutside } = await mount(ws);
      await applyAllTeams();
      const applied = {
        scorerRosterOverrides: state.current.scorerRosterOverrides,
        meetEntryPlans: state.current.meetEntryPlans,
        activeEntryIds: state.current.activeEntryIds,
      };
      await click(/Undo this optimize/);
      expect(toastTexts()).toContain('Undid: All teams optimize');
      expect(findButton(/Undo this optimize/)).toBeUndefined();
      // The provider reloads the server copy after the failed save: the optimized arrays return.
      await editOutside(applied);
      expect(toastTexts()).toContain(UNDO_NOT_SAVED_MESSAGE);
      expect(findButton(/Undo this optimize/)).toBeTruthy();
      expect(alert()).toBeNull(); // not the "Lineup changed" refusal
      // Pressing it again writes again.
      await click(/Undo this optimize/);
      expect(updates).toHaveLength(3);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
    });

    it('when the APPLY was not saved, Undo says so instead of "Lineup changed"', async () => {
      const ws = gainWorkspace();
      const { updates, editOutside } = await mount(ws);
      await applyAllTeams();
      // The apply's save failed: the provider reloaded the server copy, which is the pre-run lineup.
      await editOutside(beforeArrays(ws));
      await click(/Undo this optimize/);
      expect(updates).toHaveLength(1); // nothing written
      expect(alert()?.textContent).toContain(APPLY_NOT_SAVED_MESSAGE);
      expect(alert()?.textContent).not.toContain(UNDO_CHANGED_MESSAGE);
      // True in both causes (a failed save, or the coach editing the lineup back by hand).
      expect(APPLY_NOT_SAVED_MESSAGE).toBe(
        'The lineup is back to how it was before the run. If you did not undo it, the apply was not saved.'
      );
      // Nothing is left to undo, so there is no "Undo anyway" and no "Keep my edits".
      expect(findButton(/^Undo anyway$/)).toBeUndefined();
      expect(findButton(/^Keep my edits$/)).toBeUndefined();
      await click(/^Dismiss$/);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
    });

    it('a real later edit still says "Lineup changed" (not the apply-not-saved message)', async () => {
      const { editOutside } = await mount(gainWorkspace());
      await applyAllTeams();
      await editOutside({ activeEntryIds: ['later-edit|50 Free'] });
      await click(/Undo this optimize/);
      expect(alert()?.textContent).toContain(UNDO_CHANGED_MESSAGE);
      expect(alert()?.textContent).not.toContain(APPLY_NOT_SAVED_MESSAGE);
    });

    it('the pure state check tells the three cases apart', () => {
      const before = { overrides: [], plans: [], activeIds: ['a'] };
      const applied = { scorerRosterOverrides: [], meetEntryPlans: [], activeEntryIds: ['b'] };
      const undo = buildOptimizerUndo({ label: 'T', workspaceId: 'w', before, applied });
      expect(optimizerUndoState(undo, optimizerArraysOf(applied))).toBe('clean');
      expect(optimizerUndoState(undo, before)).toBe('apply_not_saved');
      expect(optimizerUndoState(undo, { overrides: [], plans: [], activeIds: ['c'] })).toBe('changed');
    });
  });

  describe('focus after the Undo choices (defect 3)', () => {
    it('"Keep my edits" moves focus to the summary heading, not <body>', async () => {
      const { editOutside } = await mount(gainWorkspace());
      await applyAllTeams();
      await editOutside({ meetEntryPlans: [] });
      await click(/Undo this optimize/);
      await click(/^Keep my edits$/);
      expect(alert()).toBeNull();
      const active = document.activeElement as HTMLElement | null;
      expect(active).not.toBe(document.body);
      expect(active?.hasAttribute('data-optimizer-summary-heading')).toBe(true);
      expect(active?.textContent).toContain('All teams');
    });

    it('"Undo anyway" moves focus to the Optimize team button, not <body>', async () => {
      const { editOutside } = await mount(gainWorkspace());
      await applyAllTeams();
      await editOutside({ activeEntryIds: ['later-edit|50 Free'] });
      await click(/Undo this optimize/);
      await click(/^Undo anyway$/);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
      const active = document.activeElement as HTMLElement | null;
      expect(active).not.toBe(document.body);
      expect(active?.textContent).toContain('Optimize team');
    });

    it('a plain Undo and Dismiss keep focus in the step too', async () => {
      await mount(gainWorkspace());
      await applyAllTeams();
      await click(/Undo this optimize/);
      expect(document.activeElement).not.toBe(document.body);
      expect((document.activeElement as HTMLElement).textContent).toContain('Optimize team');

      await applyAllTeams();
      await click(/Dismiss optimizer summary/);
      expect(document.activeElement).not.toBe(document.body);
      expect((document.activeElement as HTMLElement).textContent).toContain('Optimize team');
    });

    it('does not steal focus the coach put somewhere else', async () => {
      const { editOutside } = await mount(gainWorkspace());
      await applyAllTeams();
      const select = document.querySelector('select') as HTMLSelectElement;
      await editOutside({ activeEntryIds: ['later-edit|50 Free'] });
      await click(/Undo this optimize/);
      select.focus();
      await act(async () => {
        findButton(/^Undo anyway$/)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(document.activeElement).toBe(select);
    });

    it('the refusal message uses the warning tokens, not the toast tokens', async () => {
      const { editOutside } = await mount(gainWorkspace());
      await applyAllTeams();
      await editOutside({ meetEntryPlans: [] });
      await click(/Undo this optimize/);
      const el = alert()!;
      expect(el.className).toContain('border-warning-faint');
      expect(el.className).toContain('bg-warning-faint');
      expect(el.querySelector('p')?.className).toContain('text-warning');
      expect(el.outerHTML).not.toContain('--toast-');
    });
  });

  describe('gender switch (defect 4, then the keep-and-hide rule)', () => {
    const beforeArrays = (ws: Workspace) => ({
      scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
      meetEntryPlans: ws.meetEntryPlans ?? [],
      activeEntryIds: ws.activeEntryIds ?? [],
    });

    it('a single-team run summary and its Undo are cleared when the gender changes', async () => {
      const { setGender } = await mount(gainWorkspace());
      await click(/Quick optimize \(greedy\)/);
      expect(findButton(/Undo this optimize/)).toBeTruthy();
      expect(findButton(/Dismiss optimizer summary/)).toBeTruthy();
      await setGender(Gender.WOMEN);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
      expect(findButton(/Dismiss optimizer summary/)).toBeUndefined();
      // Cleared, not hidden: flipping back does not bring it back.
      await setGender(Gender.MEN);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
      expect(findButton(/Dismiss optimizer summary/)).toBeUndefined();
    });

    it('an All-teams summary is kept but hidden in the other gender, and returns when flipped back', async () => {
      const { updates, setGender } = await mount(gainWorkspace());
      await applyAllTeams();
      expect(findButton(/Undo this optimize/)).toBeTruthy();
      await setGender(Gender.WOMEN);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
      expect(findButton(/Dismiss optimizer summary/)).toBeUndefined();
      await setGender(Gender.MEN);
      expect(findButton(/Dismiss optimizer summary/)).toBeTruthy();
      // The kept Undo still works.
      await click(/Undo this optimize/);
      expect(updates).toHaveLength(2);
      expect(toastTexts()).toContain('Undid: All teams optimize');
    });

    it('an Undo still waiting for its save keeps waiting through a gender switch', async () => {
      const ws = gainWorkspace();
      const { state, editOutside, setGender } = await mount(ws);
      await applyAllTeams();
      const applied = {
        scorerRosterOverrides: state.current.scorerRosterOverrides,
        meetEntryPlans: state.current.meetEntryPlans,
        activeEntryIds: state.current.activeEntryIds,
      };
      state.applyUpdates = false; // the Undo's save has not landed yet
      await click(/Undo this optimize/);
      expect(toastTexts().some(t => t.startsWith('Undid:'))).toBe(false);

      await setGender(Gender.WOMEN);
      expect(toastTexts().some(t => t.startsWith('Undid:'))).toBe(false); // still claims nothing

      await editOutside(beforeArrays(ws)); // the save lands
      expect(toastTexts()).toContain('Undid: All teams optimize');

      // A later failure still gets its message, although the coach is looking at the other gender.
      await editOutside(applied);
      expect(toastTexts()).toContain(UNDO_NOT_SAVED_MESSAGE);
      expect(findButton(/Undo this optimize/)).toBeUndefined(); // hidden here
      await setGender(Gender.MEN);
      expect(findButton(/Undo this optimize/)).toBeTruthy(); // back within reach
    });

    it('a single-team Undo still waiting for its save also keeps waiting through a gender switch', async () => {
      const ws = gainWorkspace();
      const { state, editOutside, setGender } = await mount(ws);
      await click(/Quick optimize \(greedy\)/);
      state.applyUpdates = false;
      await click(/Undo this optimize/);
      await setGender(Gender.WOMEN);
      expect(toastTexts().some(t => t.startsWith('Undid:'))).toBe(false);
      await editOutside(beforeArrays(ws));
      expect(toastTexts().some(t => t.startsWith('Undid:'))).toBe(true);
    });
  });

  describe('Undo watcher is bound to its workspace (P3)', () => {
    it('after a settled Undo, a workspace whose lineup equals the optimized arrays does not re-arm it', async () => {
      const { state, editOutside } = await mount(gainWorkspace());
      await applyAllTeams();
      const applied = {
        scorerRosterOverrides: state.current.scorerRosterOverrides,
        meetEntryPlans: state.current.meetEntryPlans,
        activeEntryIds: state.current.activeEntryIds,
      };
      await click(/Undo this optimize/);
      expect(toastTexts()).toContain('Undid: All teams optimize');
      // Another workspace whose lineup happens to equal the optimized arrays.
      await editOutside({ id: 'another-workspace', ...applied });
      expect(toastTexts()).not.toContain(UNDO_NOT_SAVED_MESSAGE);
      expect(findButton(/Undo this optimize/)).toBeUndefined();
      expect(findButton(/Dismiss optimizer summary/)).toBeUndefined();
    });
  });
});
