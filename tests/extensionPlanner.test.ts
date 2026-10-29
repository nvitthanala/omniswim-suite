import { describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { BUILTIN_SESSION_PRESETS } from '@omniswim/engine';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { readSessionLoadPreference, readSessionPreset, saveEditedSessionPreset, saveSessionLoadPreference, saveSessionPresetChoice } from '../apps/extension/src/storage/sessionPlanner';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import type { PanelUiActionMessage } from '../apps/extension/src/shared/panelProtocol';
import { freshFactory, steppingClock } from './helpers/extensionDb';
import type { ScorerTagStateMessage } from '../apps/extension/src/shared/panelProtocol';

async function fresh() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'planner-test' });
  return { db, repo: createStorageRepo(db, { now: steppingClock() }) };
}

describe('extension P5 planner first slice', () => {
  it('stores session choice and load preference by meet and restores them', async () => {
    const { db, repo } = await fresh();
    const ref = { kind: 'builtin' as const, id: 'nsisc-table-c', version: 1 };
    await saveSessionPresetChoice(repo, 'meet-a', ref);
    await saveSessionLoadPreference(repo, 'meet-a', { mode: 'respect', maxRacesPerSession: { state: 'set', value: 3, provenance: { kind: 'engine-neutral', reason: 'test value' } }, diving: { state: 'set', value: 'counts', provenance: { kind: 'engine-neutral', reason: 'test value' } } });
    await saveSessionPresetChoice(repo, 'meet-b', ref);
    expect((await readSessionPreset(repo, 'meet-a')).ref).toEqual(ref);
    expect(await readSessionLoadPreference(repo, 'meet-a')).toMatchObject({ mode: 'respect', maxRacesPerSession: { value: 3 }, diving: { value: 'counts' } });
    expect(await readSessionLoadPreference(repo, 'meet-b')).toMatchObject({ maxRacesPerSession: { value: 2 } });
    db.close();
  });

  it('editing a built-in saves and selects a user copy; invalid edits save nothing', async () => {
    const { db, repo } = await fresh();
    const ref = { kind: 'builtin' as const, id: 'nsisc-table-c', version: 1 };
    const base = structuredClone(BUILTIN_SESSION_PRESETS[0]!.preset);
    (base.events[0]!.format as { kind: string; session?: { day: number; slot: string } }).session = { day: 2, slot: 'morning' };
    const next = await saveEditedSessionPreset(repo, 'meet-a', ref, base, () => 'edited-copy');
    expect(next).toEqual({ kind: 'user', id: 'edited-copy' });
    const dashboardSaved = await readSessionPreset(repo, 'meet-a');
    expect(dashboardSaved.preset?.events[0]?.format).toEqual({ kind: 'timed-final', session: { day: 2, slot: 'morning' } });
    const win = new HappyWindow(); let root: unknown = null;
    const attach = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const shadow = attach.call(this, init); root = shadow; return shadow; };
    const table = win.document.createElement('table'); win.document.body.append(table);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    panel.setScorerState({ kind: 'scorer-tag-state', meetKey: 'meet-a', teams: [], swimmers: [], tags: [], warnings: [], sessionSchedule: { ref: dashboardSaved.ref, preset: dashboardSaved.preset } });
    const pageEditor = (root as { querySelector<T extends Element>(selector: string): T | null }).querySelector<HTMLTextAreaElement>('[aria-label="Edit meet schedule JSON"]')!;
    expect(pageEditor.value).toContain('"day": 2'); panel.disconnect();
    const invalid = structuredClone(base) as unknown as { events: { format: { session: { day: number } } }[] };
    invalid.events[0]!.format.session.day = 0;
    await expect(saveEditedSessionPreset(repo, 'meet-b', ref, invalid)).rejects.toThrow(/day/);
    expect(await repo.list('sessionPresets')).toHaveLength(1);
    expect((await readSessionPreset(repo, 'meet-b')).ref).toBeUndefined();
    db.close();
  });

  it('renders day-by-day races, a load violation and pending setting as visible text', () => {
    const win = new HappyWindow(); let closedRoot: unknown = null;
    const attach = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const root = attach.call(this, init); closedRoot = root; return root; };
    const table = win.document.createElement('table'); win.document.body.append(table);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    const state: ScorerTagStateMessage = { kind: 'scorer-tag-state', meetKey: 'm', teams: [], swimmers: [{ id: 's1', teamId: 't1', name: 'A Swimmer', gender: 'Women' }], tags: [], warnings: [], planner: { perSwimmer: [{ swimmerId: 's1', sessions: [{ session: { day: 2, slot: 'morning' }, races: 3, eventKeys: ['100 Freestyle'] }] }], violations: ['Session load: 3 races on day 2.', 'Pending setting: smallFieldSession.', 'Relay rule violation: s1 repeats on relays.', 'No schedule chosen; formats are unknown, relay repeats are unfiltered.'] } };
    panel.setScorerState(state);
    const root = closedRoot as { querySelector<T extends Element>(selectors: string): T | null };
    const details = root.querySelector<HTMLDetailsElement>('[data-osx-athlete-outlook]')!;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('Day 2, morning: 3 races');
    expect(details.textContent).toContain('Session load: 3 races');
    expect(details.textContent).toContain('Pending setting: smallFieldSession');
    expect(details.textContent).toContain('Relay rule violation');
    expect(details.textContent).toContain('formats are unknown');
    panel.disconnect();
  });

  it('page schedule edits travel to dashboard storage and the updated choice is shown after reload', async () => {
    const { db, repo } = await fresh();
    const ref = { kind: 'builtin' as const, id: 'nsisc-table-c', version: 1 };
    await saveSessionPresetChoice(repo, 'meet-page', ref);
    const selected = await readSessionPreset(repo, 'meet-page');
    const win = new HappyWindow(); let root: unknown = null;
    const attach = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const shadow = attach.call(this, init); root = shadow; return shadow; };
    const table = win.document.createElement('table'); win.document.body.append(table);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    const state: ScorerTagStateMessage = { kind: 'scorer-tag-state', meetKey: 'meet-page', teams: [], swimmers: [], tags: [], warnings: [], sessionSchedule: { ref, preset: selected.preset } };
    let edit: PanelUiActionMessage | undefined;
    panel.onScorerAction(action => { edit = action; }); panel.setScorerState(state);
    const shadow = root as { querySelector<T extends Element>(selector: string): T | null };
    const editor = shadow.querySelector<HTMLTextAreaElement>('[aria-label="Edit meet schedule JSON"]')!;
    const changed = structuredClone(selected.preset!);
    (changed.events[0]!.format as { session: { day: number; slot: string } }).session.day = 2;
    editor.value = JSON.stringify(changed);
    shadow.querySelector<HTMLButtonElement>('[data-osx-meet-schedule] button')!.click();
    expect(edit?.kind).toBe('session-preset-edit');
    if (edit?.kind !== 'session-preset-edit') throw new Error('No schedule edit was sent');
    const userRef = await saveEditedSessionPreset(repo, 'meet-page', ref, edit.preset, () => 'page-edited');
    panel.setScorerState({ ...state, sessionSchedule: { ref: userRef, preset: (await readSessionPreset(repo, 'meet-page')).preset } });
    const afterReload = await readSessionPreset(repo, 'meet-page');
    expect(afterReload.ref).toEqual(userRef);
    expect(afterReload.preset?.events[0]?.format).toMatchObject({ kind: 'timed-final', session: { day: 2 } });
    expect(shadow.querySelector<HTMLTextAreaElement>('[aria-label="Edit meet schedule JSON"]')?.value).toContain('"day": 2');
    panel.disconnect(); db.close();
  });

  it('page schedule parse errors are visible and do not create a preset', async () => {
    const { db, repo } = await fresh();
    const ref = { kind: 'builtin' as const, id: 'nsisc-table-c', version: 1 };
    const win = new HappyWindow(); let root: unknown = null;
    const attach = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const shadow = attach.call(this, init); root = shadow; return shadow; };
    const table = win.document.createElement('table'); win.document.body.append(table);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    let raw: unknown;
    panel.onScorerAction(action => { if (action.kind === 'session-preset-edit') raw = action.preset; });
    panel.setScorerState({ kind: 'scorer-tag-state', meetKey: 'm', teams: [], swimmers: [], tags: [], warnings: [], sessionSchedule: { ref, preset: BUILTIN_SESSION_PRESETS[0]!.preset } });
    const shadow = root as { querySelector<T extends Element>(selector: string): T | null };
    const editor = shadow.querySelector<HTMLTextAreaElement>('[aria-label="Edit meet schedule JSON"]')!;
    const invalid = structuredClone(BUILTIN_SESSION_PRESETS[0]!.preset) as unknown as { events: { format: { session: { day: number } } }[] };
    invalid.events[0]!.format.session.day = 0; editor.value = JSON.stringify(invalid);
    shadow.querySelector<HTMLButtonElement>('[data-osx-meet-schedule] button')!.click();
    await expect(saveEditedSessionPreset(repo, 'm', ref, raw)).rejects.toThrow(/day/);
    panel.setScorerState({ kind: 'scorer-tag-state', meetKey: 'm', teams: [], swimmers: [], tags: [], warnings: [], sessionSchedule: { ref, preset: BUILTIN_SESSION_PRESETS[0]!.preset, error: 'events[0].format.session.day: expected an integer of 1 or more' } });
    expect(shadow.querySelector('[data-osx-meet-schedule] [role="alert"]')?.textContent).toContain('expected an integer');
    expect(await repo.list('sessionPresets')).toHaveLength(0);
    panel.disconnect(); db.close();
  });
});
