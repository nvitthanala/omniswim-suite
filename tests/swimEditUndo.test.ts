// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The toolbar "Undo: <swim edit>" must not outlive the lineup it was made against.
 *
 * `swimEditor`'s inverse holds the full earlier meetEntryPlans (and often activeEntryIds). Writing
 * it back after the workspace changed, or after an optimizer run, would replace another
 * workspace's plans or throw away the run. The record is bound to its workspace id and to a
 * fingerprint of the fields the inverse overwrites (plus the three lineup fields), taken right
 * after the edit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '@omniswim/core/types';
import { removePlannedEntry, updatePlannedEntry } from '@omniswim/core/lib/swimEditor';
import {
  SWIM_EDIT_UNDO_CHANGED_MESSAGE,
  SWIM_EDIT_UNDO_NOT_SAVED_MESSAGE,
  buildSwimEditUndo,
  fingerprintInverseFields,
  swimEditUndoState,
  useSwimEditUndo,
} from '../packages/manager/src/components/useSwimEditUndo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plan = (id: string, event = '50 Freestyle') =>
  ({ id, team: 'T', name: id, event, time: '22.00', gender: Gender.MEN, active: true, source: 'manual' }) as never;

function workspace(id: string, plans: string[], activeIds?: string[]): Workspace {
  return {
    id,
    name: id,
    meetEntryPlans: plans.map(p => plan(p)),
    ...(activeIds ? { activeEntryIds: activeIds } : {}),
  } as unknown as Workspace;
}

describe('swim edit undo record (pure)', () => {
  it('is clean right after the edit, and not once a field the inverse overwrites differs', () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const built = removePlannedEntry(ws, 'p1');
    const after = { ...ws, ...built.patch } as Workspace;
    const record = buildSwimEditUndo({ afterEdit: after, build: built });
    expect(swimEditUndoState(record, after)).toBe('clean');
    expect(swimEditUndoState(record, { ...after, meetEntryPlans: [] } as Workspace)).toBe('changed');
    expect(swimEditUndoState(record, { ...after, activeEntryIds: ['x'] } as Workspace)).toBe('changed');
  });

  it('an optimizer write to a lineup field the inverse does not touch still invalidates it', () => {
    // Removing a plan with no activeEntryIds allowlist: the inverse is only meetEntryPlans.
    const ws = workspace('A', ['p1', 'p2']);
    const built = removePlannedEntry(ws, 'p1');
    expect(Object.keys(built.inverse)).toEqual(['meetEntryPlans']);
    const after = { ...ws, ...built.patch } as Workspace;
    const record = buildSwimEditUndo({ afterEdit: after, build: built });
    const overrides = [{ team: 'T', gender: Gender.MEN, name: 'p2', isScorer: true }];
    expect(swimEditUndoState(record, { ...after, scorerRosterOverrides: overrides } as Workspace)).toBe('changed');
  });

  it('another workspace is its own state, even with identical arrays', () => {
    const ws = workspace('A', ['p1']);
    const built = removePlannedEntry(ws, 'p1');
    const after = { ...ws, ...built.patch } as Workspace;
    const record = buildSwimEditUndo({ afterEdit: after, build: built });
    expect(swimEditUndoState(record, { ...after, id: 'B' } as Workspace)).toBe('other_workspace');
  });

  it('fingerprints content: key order is irrelevant, absent equals null', () => {
    expect(fingerprintInverseFields({ meetEntryPlans: [{ a: 1, b: 2 }] as never }, { meetEntryPlans: [] })).toBe(
      fingerprintInverseFields({ meetEntryPlans: [{ b: 2, a: 1 }] as never }, { meetEntryPlans: [] })
    );
  });
});

describe('useSwimEditUndo', () => {
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

  /** A parent that follows onUpdate, like the provider does, and can be changed from outside. */
  async function mount(initial: Workspace) {
    const toasts: Array<[string, string]> = [];
    const writes: Array<Partial<Workspace>> = [];
    // `follow: false` models a save that has not landed: the write is made, the workspace does not change.
    const state = { ws: initial, follow: true };
    /** What every render showed: the workspace it was for and the Undo it offered. */
    const renders: Array<{ wsId: string; undo: string }> = [];
    let api!: ReturnType<typeof useSwimEditUndo>;
    const Probe = ({ ws }: { ws: Workspace }) => {
      api = useSwimEditUndo({
        workspace: ws,
        onUpdate: patch => {
          writes.push(patch);
          if (!state.follow) return;
          state.ws = { ...state.ws, ...patch } as Workspace;
          draw();
        },
        toast: { push: (kind, message) => void toasts.push([kind, message]) },
      });
      renders.push({ wsId: ws.id, undo: api.lastSwimEdit?.description ?? '' });
      return createElement('span', { 'data-undo': api.lastSwimEdit?.description ?? '' });
    };
    const draw = () => root.render(createElement(Probe, { ws: state.ws }));
    await act(async () => draw());
    /** A write that did not come from the swim editor: the optimizer, an import, another tab. */
    const outside = (patch: Partial<Workspace>) =>
      act(async () => {
        state.ws = { ...state.ws, ...patch } as Workspace;
        draw();
      });
    const switchTo = (ws: Workspace) =>
      act(async () => {
        state.ws = ws;
        draw();
      });
    const edit = (build: Parameters<typeof api.applySwimPatch>[0]) =>
      act(async () => {
        api.applySwimPatch(build);
      });
    const undo = () =>
      act(async () => {
        api.undoSwimEdit();
      });
    const visible = () => container.querySelector('span')!.getAttribute('data-undo');
    return { state, toasts, writes, renders, outside, switchTo, edit, undo, visible, api: () => api };
  }

  it('undoes the last edit when nothing else touched the lineup', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    expect(h.visible()).toContain('Remove');
    expect(h.state.ws.meetEntryPlans).toHaveLength(1);
    await h.undo();
    expect(h.state.ws.meetEntryPlans).toEqual(ws.meetEntryPlans);
    expect(h.state.ws.activeEntryIds).toEqual(['p1', 'p2']);
    expect(h.toasts.some(([kind, m]) => kind === 'success' && m.startsWith('Undid:'))).toBe(true);
    expect(h.visible()).toBe('');
  });

  it('scenario A: edit in workspace A, switch to B, the Undo is gone and B is untouched', async () => {
    const a = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const b = workspace('B', ['q1'], ['q1']);
    const h = await mount(a);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const writesBefore = h.writes.length;
    await h.switchTo(b);
    expect(h.visible()).toBe(''); // no stale button
    // Not even for one render: no render for B ever offered A's Undo.
    expect(h.renders.filter(r => r.wsId === 'B' && r.undo !== '')).toEqual([]);
    await h.undo(); // even a stale click must write nothing
    expect(h.writes).toHaveLength(writesBefore);
    expect(h.state.ws.meetEntryPlans).toEqual(b.meetEntryPlans);
    expect(h.state.ws.activeEntryIds).toEqual(['q1']);
  });

  it('scenario A, back again: returning to A does not revive the Undo', async () => {
    const a = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(a);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const afterEdit = h.state.ws;
    await h.switchTo(workspace('B', ['q1']));
    await h.switchTo(afterEdit);
    expect(h.visible()).toBe('');
  });

  it('scenario B: an optimizer run after the edit makes Undo refuse, and the run is kept', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    // The optimizer apply writes all three lineup arrays.
    const optimized = {
      scorerRosterOverrides: [{ team: 'T', gender: Gender.MEN, name: 'p2', isScorer: true }],
      meetEntryPlans: [plan('p2', '100 Freestyle'), plan('p3')],
      activeEntryIds: ['p2', 'p3'],
    } as unknown as Partial<Workspace>;
    await h.outside(optimized);
    const writesBefore = h.writes.length;
    await h.undo();
    expect(h.writes).toHaveLength(writesBefore); // nothing written
    expect(h.state.ws.scorerRosterOverrides).toEqual(optimized.scorerRosterOverrides);
    expect(h.state.ws.meetEntryPlans).toEqual(optimized.meetEntryPlans);
    expect(h.state.ws.activeEntryIds).toEqual(optimized.activeEntryIds);
    expect(h.toasts).toContainEqual(['error', SWIM_EDIT_UNDO_CHANGED_MESSAGE]);
    expect(h.visible()).toBe(''); // the record cannot become valid again
  });

  it('a run that only changes the scorer overrides also invalidates it', async () => {
    const ws = workspace('A', ['p1', 'p2']); // no allowlist: the inverse is meetEntryPlans only
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    await h.outside({ scorerRosterOverrides: [{ team: 'T', gender: Gender.MEN, name: 'p2', isScorer: true }] });
    const writesBefore = h.writes.length;
    await h.undo();
    expect(h.writes).toHaveLength(writesBefore);
    expect(h.toasts).toContainEqual(['error', SWIM_EDIT_UNDO_CHANGED_MESSAGE]);
  });

  it('an import (new plans) after the edit makes Undo refuse', async () => {
    const h = await mount(workspace('A', ['p1', 'p2']));
    await h.edit(w => removePlannedEntry(w, 'p1'));
    await h.outside({ meetEntryPlans: [plan('p2'), plan('imported')] } as never);
    await h.undo();
    expect(h.state.ws.meetEntryPlans).toHaveLength(2);
    expect(h.toasts).toContainEqual(['error', SWIM_EDIT_UNDO_CHANGED_MESSAGE]);
  });

  it('a second edit replaces the first: Undo reverts only the second', async () => {
    const ws = workspace('A', ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const afterFirst = h.state.ws.meetEntryPlans;
    await h.edit(w => updatePlannedEntry(w, 'p2', { time: '21.00' }));
    await h.undo();
    expect(h.state.ws.meetEntryPlans).toEqual(afterFirst); // the first edit stays
    expect(h.toasts.some(([, m]) => m === SWIM_EDIT_UNDO_CHANGED_MESSAGE)).toBe(false);
  });

  it('a lineup that is put back exactly as the edit left it counts as clean', async () => {
    const ws = workspace('A', ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const left = h.state.ws.meetEntryPlans;
    await h.outside({ meetEntryPlans: [] });
    await h.outside({ meetEntryPlans: JSON.parse(JSON.stringify(left)) });
    await h.undo();
    expect(h.state.ws.meetEntryPlans).toEqual(ws.meetEntryPlans);
  });
});

describe('useSwimEditUndo waits for the save (P5)', () => {
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

  async function mount(initial: Workspace) {
    const toasts: Array<[string, string]> = [];
    const writes: Array<Partial<Workspace>> = [];
    const state = { ws: initial, follow: true };
    let api!: ReturnType<typeof useSwimEditUndo>;
    const Probe = ({ ws }: { ws: Workspace }) => {
      api = useSwimEditUndo({
        workspace: ws,
        onUpdate: patch => {
          writes.push(patch);
          if (!state.follow) return;
          state.ws = { ...state.ws, ...patch } as Workspace;
          draw();
        },
        toast: { push: (kind, message) => void toasts.push([kind, message]) },
      });
      return createElement('span', { 'data-undo': api.lastSwimEdit?.description ?? '' });
    };
    const draw = () => root.render(createElement(Probe, { ws: state.ws }));
    await act(async () => draw());
    const outside = (ws: Workspace) =>
      act(async () => {
        state.ws = ws;
        draw();
      });
    const edit = (build: Parameters<typeof api.applySwimPatch>[0]) => act(async () => api.applySwimPatch(build));
    const undo = () => act(async () => api.undoSwimEdit());
    const visible = () => container.querySelector('span')!.getAttribute('data-undo');
    const undid = () => toasts.filter(([k, m]) => k === 'success' && m.startsWith('Undid:')).length;
    return { state, toasts, writes, outside, edit, undo, visible, undid };
  }

  it('claims nothing while the workspace has not taken the Undo, then claims once it has', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    h.state.follow = false; // the Undo's save has not landed
    await h.undo();
    expect(h.writes).toHaveLength(2); // the write was issued
    expect(h.undid()).toBe(0);
    expect(h.visible()).toBe(''); // no second press while it waits
    await h.outside({ ...h.state.ws, ...ws } as Workspace); // the save lands
    expect(h.undid()).toBe(1);
  });

  it('a failed Undo save brings the edit back: says so and puts the Undo back within reach', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const afterEdit = h.state.ws;
    await h.undo();
    expect(h.undid()).toBe(1);
    // The provider reloads the server copy after the failed save: the edit is back.
    await h.outside(afterEdit);
    expect(h.toasts).toContainEqual(['error', SWIM_EDIT_UNDO_NOT_SAVED_MESSAGE]);
    expect(h.visible()).toContain('Remove');
    expect(h.toasts.some(([, m]) => m === SWIM_EDIT_UNDO_CHANGED_MESSAGE)).toBe(false);
    // Pressing it again writes again.
    await h.undo();
    expect(h.writes).toHaveLength(3);
    expect(h.state.ws.meetEntryPlans).toEqual(ws.meetEntryPlans);
  });

  it('after a settled Undo, another workspace holding the edited arrays does not re-arm it', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const afterEdit = h.state.ws;
    await h.undo();
    await h.outside({ ...afterEdit, id: 'B' } as Workspace);
    expect(h.toasts.some(([, m]) => m === SWIM_EDIT_UNDO_NOT_SAVED_MESSAGE)).toBe(false);
    expect(h.visible()).toBe('');
  });

  it('while an Undo waits, another workspace that already holds the pre-edit values does not settle it', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    h.state.follow = false;
    await h.undo(); // pending
    await h.outside({ ...ws, id: 'B' } as Workspace); // B reads as the pre-edit lineup
    expect(h.undid()).toBe(0);
  });

  it('a later unrelated write ends the watch: the edit coming back afterwards is not read as a failed save', async () => {
    const ws = workspace('A', ['p1', 'p2'], ['p1', 'p2']);
    const h = await mount(ws);
    await h.edit(w => removePlannedEntry(w, 'p1'));
    const afterEdit = h.state.ws;
    await h.undo();
    await h.outside({ ...h.state.ws, meetEntryPlans: [] } as Workspace); // something else wrote
    await h.outside(afterEdit);
    expect(h.toasts.some(([, m]) => m === SWIM_EDIT_UNDO_NOT_SAVED_MESSAGE)).toBe(false);
  });
});

describe('TeamManagementView wiring', () => {
  it('uses the guarded hook, not a bare saved inverse', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../packages/manager/src/components/TeamManagementView.tsx'),
      'utf8'
    );
    expect(src).toContain('useSwimEditUndo(');
    expect(src).toContain('onClick={undoSwimEdit}');
    // The unguarded shape that caused the defect: an inverse in component state, written back as is.
    expect(src).not.toMatch(/setLastSwimEdit/);
    expect(src).not.toMatch(/onUpdate\(lastSwimEdit\.inverse\)/);
  });
});
