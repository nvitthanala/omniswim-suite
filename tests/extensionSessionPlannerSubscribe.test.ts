// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The session planner follows the change bus (slice F3). A write another context makes to the session presets or to the per-meet schedule
 * choice and load preference reaches the open Plan tab without a remount. A schedule the coach is editing is kept. After unmount nothing listens
 * and nothing is read.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUILTIN_SESSION_PRESETS } from '@omniswim/engine';
import { SessionPlannerEditor } from '../apps/extension/src/dashboard/sessionPlannerEditor';
import type { PlannerSubscribe } from '../apps/extension/src/dashboard/sessionPlannerEditor';
import { meetKeyForSnapshot } from '../apps/extension/src/dashboard/meetKey';
import { createMemoryChangeBus, createStorageRepo, openOmniDb, readSessionLoadPreference, readSessionPreset, saveEditedSessionPreset, saveSessionLoadPreference, saveSessionPresetChoice, watchChanges } from '../apps/extension/src/storage';
import type { StorageRepo } from '../apps/extension/src/storage';
import { configCWorld } from './helpers/autoBuilderFixtures';
import type { ConfigCWorld } from './helpers/autoBuilderFixtures';
import { freshFactory, steppingClock } from './helpers/extensionDb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Counts the state setter calls the planner makes while `counting` is on. React drops a setter called after unmount without a word,
// so only a count can show that none was made.
const setterCalls = vi.hoisted(() => ({ counting: false, late: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = ((initial: unknown) => {
    const [value, set] = (actual.useState as (i: unknown) => [unknown, (v: unknown) => void])(initial);
    return [value, (v: unknown) => { if (setterCalls.counting) setterCalls.late += 1; set(v); }];
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

let world: ConfigCWorld;
let root: Root | undefined;
let host: HTMLElement | undefined;
const builtin = { kind: 'builtin' as const, id: 'nsisc-table-c', version: 1 };

beforeAll(async () => { world = await configCWorld(); }, 120_000);

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await act(async () => new Promise((r) => setTimeout(r, 20)));
};
const presetSelect = (): HTMLSelectElement => host!.querySelector<HTMLSelectElement>('select[aria-label="Choose session preset"]')!;
const modeSelect = (): HTMLSelectElement => host!.querySelector<HTMLSelectElement>('fieldset select')!;
const eventCount = (): number => host!.querySelectorAll('ol > li').length;

async function setup() {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: () => 'planner-sub' });
  const bus = createMemoryChangeBus();
  const mine = createStorageRepo(db, { now: steppingClock(), bus });
  const other = createStorageRepo(db, { now: steppingClock(), bus });
  let stops = 0;
  const listeners = new Set<() => void>();
  // The wiring main.tsx has: `watchChanges` over the shared bus, narrowed to the stores the planner reads.
  const subscribe: PlannerSubscribe = (listener) => {
    let stopped = false;
    let stop: (() => void) | undefined;
    listeners.add(listener);
    void watchChanges(db, bus, (change) => {
      if (change.stores === 'unknown' || change.stores.some((s) => s === 'sessionPresets' || s === 'settings' || s === 'meets')) listener();
    }).then((watch) => { stop = watch.stop; if (stopped) stop(); });
    return () => { stopped = true; stop?.(); stops += 1; listeners.delete(listener); };
  };
  return { db, mine, other, subscribe, listeners, stopCount: () => stops, meetKey: meetKeyForSnapshot(world.snapshot) };
}

async function mount(repoForMeet: () => Promise<StorageRepo>, subscribe: PlannerSubscribe): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(React.createElement(SessionPlannerEditor, { snapshot: world.snapshot, repoForMeet, subscribe })));
  await settle();
}

describe('session planner follows another context', () => {
  it('shows a schedule choice, a user preset and a load preference written through a second repo', async () => {
    const s = await setup();
    await mount(async () => s.mine, s.subscribe);
    expect(presetSelect().value).toBe('');
    expect(modeSelect().value).toBe('respect');
    const optionsBefore = presetSelect().options.length;
    expect(eventCount()).toBe(0);

    await saveSessionPresetChoice(s.other, s.meetKey, builtin);
    await settle();
    expect(presetSelect().value).toBe(JSON.stringify(builtin));
    expect(eventCount(), 'the chosen schedule is listed').toBe(BUILTIN_SESSION_PRESETS.find((b) => b.id === builtin.id)!.preset.events.length);

    await saveSessionLoadPreference(s.other, s.meetKey, { mode: 'off' });
    await settle();
    expect(modeSelect().value).toBe('off');

    await saveEditedSessionPreset(s.other, 'some-other-meet', builtin, structuredClone(BUILTIN_SESSION_PRESETS.find((b) => b.id === builtin.id)!.preset), () => 'copy-1');
    await settle();
    expect(presetSelect().options.length, 'a user preset saved elsewhere is offered').toBe(optionsBefore + 1);
    s.db.close();
  });

  it('keeps a schedule the coach is editing when a refresh arrives', async () => {
    const s = await setup();
    await saveSessionPresetChoice(s.mine, s.meetKey, builtin);
    await mount(async () => s.mine, s.subscribe);
    const full = eventCount();
    expect(full).toBeGreaterThan(1);
    const remove = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Remove event')!;
    await act(async () => remove.click());
    expect(eventCount(), 'the draft has one event fewer').toBe(full - 1);

    await saveSessionLoadPreference(s.other, s.meetKey, { mode: 'off' });
    await settle();
    expect(modeSelect().value, 'the refresh did run').toBe('off');
    expect(eventCount(), 'the draft survived it').toBe(full - 1);
    s.db.close();
  });

  it('stops listening on unmount and sets no state when a read finishes afterwards', async () => {
    const s = await setup();
    let release: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    let reads = 0;
    const repoForMeet = async (): Promise<StorageRepo> => { reads += 1; await gate; return s.mine; };
    await mount(repoForMeet, s.subscribe);
    expect(s.listeners.size).toBe(1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // A refresh is under way when the tab goes away.
      gate = new Promise<void>((resolve) => { release = resolve; });
      await saveSessionPresetChoice(s.other, s.meetKey, builtin);
      await settle();
      const readsInFlight = reads;
      expect(readsInFlight, 'the change started a read').toBeGreaterThan(1);
      await act(async () => root?.unmount());
      root = undefined;
      expect(s.stopCount(), 'it unsubscribed').toBe(1);
      expect(s.listeners.size).toBe(0);
      release();
      await settle();
      expect(host!.innerHTML, 'nothing was rendered after unmount').toBe('');
      // A stray notice after unmount reads nothing.
      await saveSessionLoadPreference(s.other, s.meetKey, { mode: 'off' });
      await settle();
      expect(reads).toBe(readsInFlight);
      expect(errors).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
    s.db.close();
  });
});

async function changeValue(el: Element | null, value: string): Promise<void> {
  const target = el as HTMLInputElement | HTMLSelectElement;
  const proto = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value);
    target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const button = (label: string): HTMLButtonElement | undefined => [...host!.querySelectorAll('button')].find((b) => b.textContent === label);
const plannerError = (): string | null => host!.querySelector('[data-testid="planner-error"]')?.textContent ?? null;
const dayInput = (): HTMLInputElement => host!.querySelector<HTMLInputElement>('input[aria-label="session day"]')!;

describe('session planner draft and writes', () => {
  it('keeps an edit made while a schedule save is pending', async () => {
    const s = await setup();
    await saveSessionPresetChoice(s.mine, s.meetKey, builtin);
    let release: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    await mount(async () => { await gate; return s.mine; }, s.subscribe);
    const full = eventCount();
    await act(async () => button('Remove event')!.click());
    gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => button('Save schedule')!.click());
    await act(async () => button('Remove event')!.click());
    expect(eventCount(), 'two events removed on screen').toBe(full - 2);
    release();
    await settle();
    expect(eventCount(), 'the newer edit was not replaced by the saved readback').toBe(full - 2);
    expect(host!.textContent).toContain('Changes you made while it saved are not saved yet.');
    expect(button('Discard changes'), 'the draft is still held').toBeDefined();
    s.db.close();
  });

  it('after a failed save keeps the draft, says it is not saved, and lets the coach discard it or save again', async () => {
    const s = await setup();
    await saveSessionPresetChoice(s.mine, s.meetKey, builtin);
    await mount(async () => s.mine, s.subscribe);
    const stored = dayInput().value;
    await changeValue(dayInput(), '0');
    await act(async () => button('Save schedule')!.click());
    await settle();
    expect(plannerError()).toMatch(/^Schedule not saved: /);
    expect(host!.querySelector('[data-testid="planner-discard"]')).not.toBeNull();
    // A remote change refreshes the rest of the view but leaves the draft.
    await saveSessionLoadPreference(s.other, s.meetKey, { mode: 'off' });
    await settle();
    expect(modeSelect().value).toBe('off');
    expect(dayInput().value, 'the draft is still on screen').toBe('0');
    // Discard ends the draft, reloads the stored schedule and clears the message.
    await act(async () => button('Discard changes')!.click());
    await settle();
    expect(dayInput().value).toBe(stored);
    expect(plannerError()).toBeNull();
    expect(host!.querySelector('[data-testid="planner-discard"]')).toBeNull();
    // A later successful save also ends a draft.
    await changeValue(dayInput(), '2');
    expect(host!.querySelector('[data-testid="planner-discard"]')).not.toBeNull();
    await act(async () => button('Save schedule')!.click());
    await settle();
    expect(plannerError()).toBeNull();
    expect(host!.textContent).toContain('Schedule saved.');
    expect(host!.querySelector('[data-testid="planner-discard"]')).toBeNull();
    s.db.close();
  });

  // Either order: meet A's actions finish while B's read is in flight (a stale read bump would drop it), or B's read finishes while A's
  // preference write is in flight (a count shared across meets would hold back B's preference).
  it.each(['meet A first', 'meet B first'] as const)('a save started on one meet does not change the view after it switched to another meet (%s)', async (order) => {
    const s = await setup();
    // The same root re-renders with a new date window: a new meet, the same component (main.tsx mounts it without a key).
    const snapshotB = { ...world.snapshot, settings: { ...world.snapshot.settings, startDate: '2001-01-01' } };
    const meetB = meetKeyForSnapshot(snapshotB);
    expect(meetB).not.toBe(s.meetKey);
    await saveSessionPresetChoice(s.mine, s.meetKey, builtin);
    await saveSessionLoadPreference(s.mine, meetB, { mode: 'off' });
    let release: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    const repoForMeet = async (): Promise<StorageRepo> => { await gate; return s.mine; };
    // No change bus here: a notice from meet A's writes would start a fresh read for meet B and hide a stale result.
    const quiet: PlannerSubscribe = () => () => undefined;
    await mount(repoForMeet, quiet);
    expect(presetSelect().value).toBe(JSON.stringify(builtin));
    expect(modeSelect().value).toBe('respect');

    // On meet A: a schedule save and a load-preference write, both held.
    await act(async () => button('Remove event')!.click());
    gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => button('Save schedule')!.click());
    await changeValue(modeSelect(), 'prefer');
    // The view switches to meet B while both are pending. B's own read waits on a second gate.
    const releaseA = release;
    gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => root?.render(React.createElement(SessionPlannerEditor, { snapshot: snapshotB, repoForMeet, subscribe: quiet })));
    const releaseB = release;
    for (const open of order === 'meet A first' ? [releaseA, releaseB] : [releaseB, releaseA]) { open(); await settle(); }

    expect(presetSelect().value, "meet B has no schedule choice; A's saved copy is not shown").toBe('');
    expect(eventCount()).toBe(0);
    expect(modeSelect().value, "meet B's own stored preference").toBe('off');
    expect(host!.textContent).not.toContain('saved');
    // Both writes for meet A still landed.
    expect((await readSessionPreset(s.mine, s.meetKey)).ref).not.toStrictEqual(builtin);
    expect((await readSessionLoadPreference(s.mine, s.meetKey)).mode).toBe('prefer');
    s.db.close();
  });

  it('sets no state when a pick, a schedule save or a load-preference save finishes after unmount', async () => {
    const s = await setup();
    await saveSessionPresetChoice(s.mine, s.meetKey, builtin);
    let release: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    setterCalls.counting = false; setterCalls.late = 0;
    try {
      await mount(async () => { await gate; return s.mine; }, s.subscribe);
      await act(async () => button('Remove event')!.click());
      gate = new Promise<void>((resolve) => { release = resolve; });
      await act(async () => button('Save schedule')!.click());
      await changeValue(modeSelect(), 'off');
      await changeValue(presetSelect(), '');
      await changeValue(presetSelect(), JSON.stringify(builtin));
      await act(async () => root?.unmount());
      root = undefined;
      setterCalls.counting = true;
      release();
      await settle();
      expect(setterCalls.late, 'state setters called after unmount').toBe(0);
    } finally { setterCalls.counting = false; }
    s.db.close();
  });
});
