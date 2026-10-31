// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The tab host's sections (U-a): plans/2026-10-25/D6-DASHBOARD.md section 1.
 * Meets lists the saved lineups and snapshots by meet and opens a report for one; a record whose stored results cannot be parsed shows its error and
 * the page goes on. Settings writes the theme, the accent (`#rrggbb` only) and the rival for each meet to the store.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { groupByMeet, MeetsView, PresetsSlot, SettingsView } from '../apps/extension/src/dashboard/tabHost';
import { clearAccent, readRival, readThemeSettings, saveAccent, saveRival, saveTheme } from '../apps/extension/src/dashboard/settingsStore';
import { createMemoryChangeBus, createStorageRepo, openOmniDb, watchChanges } from '../apps/extension/src/storage';
import type { SettingsSubscribe } from '../apps/extension/src/dashboard/tabHost';
import { configCWorld, realSolveLp } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';
import { freshFactory, steppingClock } from './helpers/extensionDb';
import { saveSnapshot } from '../apps/extension/src/dashboard/snapshotSave';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let world: ConfigCWorld;
let root: Root | undefined;
let host: HTMLElement | undefined;
const clock = (): string => '2026-10-31T14:05:00.000Z';

beforeAll(async () => {
  world = await configCWorld();
  await saveSnapshot(world.snapshot, 'Dual meet snapshot', { repo: world.repo, solveLp: realSolveLp, now: clock, newId: () => 'snap-1' });
}, 120_000);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const q = (id: string): HTMLElement | null => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await act(async () => new Promise((r) => setTimeout(r, 20)));
};
async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  await settle();
}
async function change(el: HTMLElement | null, value: string): Promise<void> {
  const target = el as HTMLInputElement | HTMLSelectElement;
  const proto = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value);
    target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await settle();
}

describe('Meets', () => {
  it('says so when nothing is saved', async () => {
    const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'x' });
    await mount(React.createElement(MeetsView, { repo: createStorageRepo(db, { now: steppingClock() }) }));
    expect(q('meets-empty')).not.toBeNull();
    expect(q('record-open')).toBeNull();
    db.close();
  });

  it('lists a saved snapshot under its meet and opens the report and the entry CSV button', async () => {
    await mount(React.createElement(MeetsView, { repo: world.repo }));
    expect(host?.querySelectorAll('[data-testid="meet-group"]').length).toBe(1);
    const open = q('record-open');
    expect(open?.textContent).toContain('Dual meet snapshot');
    expect(q('record-view')).toBeNull();
    await act(async () => open?.click());
    await settle();
    expect(open?.getAttribute('aria-pressed')).toBe('true');
    const view = q('record-view');
    expect(view?.textContent).toContain('Dual meet snapshot');
    expect(view?.textContent).toContain('Snapshot');
    expect(q('record-error')).toBeNull();
    expect(view?.textContent, 'the report names the coach team').toContain('(you)');
    expect(view?.textContent).toMatch(/csv/i);
  });

  it('shows the error of a record whose results cannot be parsed, and keeps the list', async () => {
    const stored = await world.repo.get('lineups', 'snap-1');
    if (!stored.found) throw new Error('no snapshot to damage');
    // A stored record the validator would refuse today (older data, or a write from outside): the page must still show it.
    const damaged = { ...stored.value, lineupId: 'damaged', name: 'Damaged results', createdAt: '2026-10-30T00:00:00.000Z', results: { payloadVersion: 1, teams: 'not a list' } };
    const meetsRepo = { ...world.repo, list: async () => [stored.value, damaged] } as unknown as typeof world.repo;
    await mount(React.createElement(MeetsView, { repo: meetsRepo }));
    const buttons = [...(host?.querySelectorAll('[data-testid="record-open"]') ?? [])] as HTMLElement[];
    expect(buttons.map((b) => b.textContent)).toStrictEqual(['Dual meet snapshot', 'Damaged results']);
    await act(async () => buttons[1]?.click());
    await settle();
    expect(q('record-error')?.textContent).toMatch(/could not be read/);
    expect(q('record-error')?.getAttribute('role')).toBe('alert');
    expect(host?.querySelectorAll('[data-testid="record-open"]').length, 'the list is still there').toBe(2);
    await act(async () => buttons[0]?.click());
    await settle();
    expect(q('record-error')).toBeNull();
  });

  it('groups records by meet key, newest first, snapshots and lineups together', () => {
    const rec = (lineupId: string, meetKey: string, kind: 'lineup' | 'snapshot', createdAt: string) => ({ lineupId, meetKey, kind, createdAt, name: lineupId }) as never;
    const groups = groupByMeet([rec('a', 'm1', 'lineup', '2026-10-01T00:00:00Z'), rec('b', 'm2', 'snapshot', '2026-10-02T00:00:00Z'), rec('c', 'm1', 'snapshot', '2026-10-03T00:00:00Z')]);
    expect(groups.map((g) => [g.meetKey, g.records.map((r) => r.lineupId)])).toStrictEqual([['m1', ['c', 'a']], ['m2', ['b']]]);
  });
});

describe('Presets', () => {
  it('is a placeholder that points to where the choices are made today', async () => {
    await mount(React.createElement(PresetsSlot));
    expect(q('presets-slot')?.textContent).toMatch(/not built yet/);
  });
});

describe('Settings', () => {
  it('writes the theme and the accent and tells the app each time', async () => {
    let applied = 0;
    await mount(React.createElement(SettingsView, { repo: world.repo, onApplied: () => { applied += 1; } }));
    expect((q('theme-light') as HTMLInputElement).checked).toBe(true);
    await act(async () => q('theme-dark')?.click());
    await settle();
    expect((await readThemeSettings(world.repo)).preference).toBe('dark');
    expect((q('theme-dark') as HTMLInputElement).checked).toBe(true);
    await change(q('accent-input'), '#aa5500');
    expect((await readThemeSettings(world.repo)).accent).toBe('#aa5500');
    expect(q('settings-status')?.textContent).toBe('Accent: #aa5500.');
    await act(async () => q('accent-reset')?.click());
    await settle();
    expect((await readThemeSettings(world.repo)).accent).toBeUndefined();
    expect(applied).toBe(3);
  });

  it('stores the rival of a meet from the teams of its saved snapshot, and the default again for the first option', async () => {
    await mount(React.createElement(SettingsView, { repo: world.repo }));
    const select = q('rival-select') as HTMLSelectElement;
    const options = [...select.options];
    expect(options[0]?.value).toBe('');
    const rival = options.find((o) => o.value !== '' && o.value !== world.ownTeamId);
    if (!rival) throw new Error('no other team to choose');
    await change(select, rival.value);
    expect(await readRival(world.repo, world.meetKey)).toStrictEqual({ kind: 'team', teamId: rival.value });
    await change(q('rival-select'), '');
    expect(await readRival(world.repo, world.meetKey)).toBeUndefined();
  });
});

describe('Settings follows another context', () => {
  it('refreshes the theme, the accent and the rival when a second repo changes them, and stops listening on unmount', async () => {
    const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'x' });
    const bus = createMemoryChangeBus();
    const mine = createStorageRepo(db, { now: steppingClock(), bus });
    const other = createStorageRepo(db, { now: steppingClock(), bus });
    // The same wiring main.tsx has: `watchChanges` over the shared bus, reported to the view.
    let listeners = 0;
    const subscribe: SettingsSubscribe = (listener) => {
      let stopped = false;
      let stop: (() => void) | undefined;
      listeners += 1;
      void watchChanges(db, bus, (change) => { if (change.stores === 'unknown' || change.stores.includes('settings')) listener(); }).then((watch) => {
        stop = watch.stop;
        if (stopped) stop();
      });
      return () => { stopped = true; stop?.(); listeners -= 1; };
    };
    // One saved snapshot, so the view lists the meet and its rival choice.
    const saved = await world.repo.get('lineups', 'snap-1');
    if (!saved.found) throw new Error('no snapshot to copy');
    const { rev: _rev, updatedAt: _updatedAt, ...record } = saved.value;
    await mine.put('lineups', record, 'new');
    await mount(React.createElement(SettingsView, { repo: mine, subscribe }));
    const rivalSelect = q('rival-select') as HTMLSelectElement;
    expect(rivalSelect.value).toBe('');
    const rivalTeam = [...rivalSelect.options].find((o) => o.value !== '' && o.value !== world.ownTeamId)?.value;
    if (rivalTeam === undefined) throw new Error('no other team');
    expect((q('theme-light') as HTMLInputElement).checked).toBe(true);
    expect((q('theme-dark') as HTMLInputElement).checked).toBe(false);
    expect(q('accent-reset')).not.toBeNull();
    expect((q('accent-reset') as HTMLButtonElement).disabled).toBe(true);

    // Another context writes. The view is not touched.
    await saveTheme(other, 'dark');
    await saveAccent(other, '#12ab34');
    await settle();
    expect((q('theme-dark') as HTMLInputElement).checked).toBe(true);
    expect((q('theme-light') as HTMLInputElement).checked).toBe(false);
    expect((q('accent-input') as HTMLInputElement).value).toBe('#12ab34');
    expect((q('accent-reset') as HTMLButtonElement).disabled).toBe(false);
    await clearAccent(other);
    await settle();
    expect((q('accent-reset') as HTMLButtonElement).disabled).toBe(true);
    await saveRival(other, world.meetKey, { kind: 'team', teamId: rivalTeam as never });
    await settle();
    expect((q('rival-select') as HTMLSelectElement).value).toBe(rivalTeam);

    await act(async () => root?.unmount());
    root = undefined;
    expect(listeners, 'the view stopped listening').toBe(0);
    db.close();
  });
});

