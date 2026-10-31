// @vitest-environment happy-dom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import type { LineupRecord, StorageRepo } from '../apps/extension/src/storage';
import { createUndoStack } from '../apps/extension/src/storage';
import { DiffView, MeetsView, orderForDiff, SettingsView } from '../apps/extension/src/dashboard/tabHost';
import { saveLineup, saveSnapshot } from '../apps/extension/src/dashboard/snapshotSave';
import { configCWorld, realSolveLp } from './helpers/autoBuilderFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
async function render(a: LineupRecord, b: LineupRecord): Promise<HTMLElement> {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(React.createElement(DiffView, { earlier: a, later: b })));
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
  return host;
}

describe('snapshot comparison and undo', () => {
  it('shows absent team values accessibly, calls out stripped display data, and names a key mismatch', async () => {
    const world = await configCWorld();
    await saveSnapshot(world.snapshot, 'Earlier', { repo: world.repo, solveLp: realSolveLp, now: () => '2026-10-31T00:00:00.000Z', newId: () => 'uc-a' });
    const stored = await world.repo.get('lineups', 'uc-a');
    if (!stored.found) throw new Error('snapshot was not saved');
    const earlier = stored.value;
    const noEntries = { ...earlier, lineupId: 'uc-b', name: 'Later', payload: { ...earlier.payload, entries: [], display: undefined } } as LineupRecord;
    const view = await render(earlier, noEntries);
    expect(view.querySelector('[data-testid="diff-stripped-note"]')?.textContent).toMatch(/Time changes cannot be shown/);
    expect(view.querySelector('[aria-label="Absent"]')).not.toBeNull();
    const mismatch = { ...noEntries, meetKey: 'different-meet' };
    await act(async () => root?.render(React.createElement(DiffView, { earlier, later: mismatch })));
    expect(view.querySelector('[data-testid="diff-error"]')?.textContent).toContain('different meets');
    world.close();
  });

  it('shows empty, undone and changed elsewhere as distinct undo outcomes', async () => {
    const world = await configCWorld();
    const repo = world.repo;
    const stack = createUndoStack(repo);
    expect(await stack.undo()).toEqual({ status: 'empty' });
    await saveSnapshot(world.snapshot, 'Undo me', { repo, solveLp: realSolveLp, now: () => '2026-10-31T00:00:00.000Z', newId: () => 'uc-undo' });
    const saved = await repo.get('lineups', 'uc-undo');
    if (!saved.found) throw new Error('snapshot was not saved');
    stack.recordUndo({ changes: [{ before: { op: 'delete', store: 'lineups', key: saved.value.lineupId }, writtenRev: saved.value.rev }] });
    expect(await stack.undo()).toEqual({ status: 'undone' });
    await repo.put('lineups', { ...saved.value, rev: undefined, updatedAt: undefined } as never, 'new');
    const again = await repo.get('lineups', saved.value.lineupId);
    if (!again.found) throw new Error('snapshot was not re-saved');
    stack.recordUndo({ changes: [{ before: { op: 'delete', store: 'lineups', key: again.value.lineupId }, writtenRev: again.value.rev }] });
    await repo.delete('lineups', again.value.lineupId, again.value.rev);
    expect(await stack.undo()).toEqual({ status: 'changed elsewhere' });
    world.close();
  });

  it('saves a lineup and explains that it has no report or compare results', async () => {
    const world = await configCWorld();
    await saveLineup(world.snapshot, 'Entries only', { repo: world.repo, solveLp: realSolveLp, now: () => '2026-10-31T00:00:00.000Z', newId: () => 'uc-lineup' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root?.render(React.createElement(MeetsView, { repo: world.repo })));
    for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
    const button = host.querySelector('[data-testid="record-open"]');
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(host.querySelector('[data-testid="record-no-results"]')?.textContent).toBe('A saved lineup has no results. Save a snapshot to see its report and compare it.');
    expect(host.querySelectorAll('[data-testid="diff-pick"]').length).toBe(0);
    world.close();
  });

  it("keeps a saved lineup's tags and facts but never its results", async () => {
    const world = await configCWorld();
    await saveLineup(world.snapshot, "With tags", { repo: world.repo, solveLp: realSolveLp, now: () => "2026-10-31T00:00:00.000Z", newId: () => "uc-lineup-tags" });
    const stored = await world.repo.get("lineups", "uc-lineup-tags");
    if (!stored.found) throw new Error("the lineup was not saved");
    expect(stored.value.kind).toBe("lineup");
    expect(stored.value.results).toBeUndefined();
    expect(stored.value.tags).toBeDefined();
    expect(stored.value.facts).toBeDefined();
    world.close();
  });

  it("orders a comparison by save time, not by the order the coach picked", () => {
    const earlier = { lineupId: "a", createdAt: "2026-10-31T09:00:00.000Z" } as LineupRecord;
    const later = { lineupId: "b", createdAt: "2026-10-31T10:00:00.000Z" } as LineupRecord;
    expect(orderForDiff([later, earlier]).map((r) => r.lineupId)).toEqual(["a", "b"]);
    expect(orderForDiff([earlier, later]).map((r) => r.lineupId)).toEqual(["a", "b"]);
  });

  it('does not continue a settings refresh after the view unmounts', async () => {
    const world = await configCWorld();
    let finish: (records: LineupRecord[]) => void = () => undefined;
    const pending = new Promise<LineupRecord[]>((resolve) => { finish = resolve; });
    const get = vi.fn(world.repo.get.bind(world.repo));
    const repo = { ...world.repo, list: () => pending, get } as unknown as StorageRepo;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root?.render(React.createElement(SettingsView, { repo })));
    await act(async () => root?.unmount()); root = undefined;
    await act(async () => { finish([]); await pending; });
    expect(get).not.toHaveBeenCalled();
    world.close();
  });
});
