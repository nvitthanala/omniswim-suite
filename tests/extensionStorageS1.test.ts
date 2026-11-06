/**
 * Slice S1 (D6 amendments 2, 4, 5): `putMany` with `expectedRev: 'new'` is the "row must be absent" check, so Undo can invert a delete;
 * `clearCache` and the import notify the change bus.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryChangeBus,
  createStorageRepo,
  createUndoStack,
  exportData,
  importData,
  openOmniDb,
  StaleWriteError,
  toSwimCloudId,
  watchChanges,
} from '../apps/extension/src/storage';
import type { ChangeNotice, MissedChange, OmniDbSchema } from '../apps/extension/src/storage';
import { clearFetchedSwimCloudData } from '../apps/extension/src/dashboard/settingsStore';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { seedFromFixture } from './helpers/extensionRecords';
import type { IDBPDatabase } from 'idb';

async function fresh(bus = createMemoryChangeBus()) {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('s1') });
  return { db, bus, repo: createStorageRepo(db, { now: steppingClock(), bus }) };
}
const TEAM = toSwimCloudId('58');
const tag = (id: string, role: 'scorer' | 'non-scorer' = 'scorer') => ({ meetKey: 'meet-1', teamId: TEAM, swimmerId: toSwimCloudId(id), role });
const key = (id: string): [string, typeof TEAM, ReturnType<typeof toSwimCloudId>] => ['meet-1', TEAM, toSwimCloudId(id)];
const roles = async (repo: Awaited<ReturnType<typeof fresh>>['repo']): Promise<Record<string, string>> =>
  Object.fromEntries((await repo.list('tags')).map((t) => [t.swimmerId, t.role]));

describe('putMany expectedRev "new" is the absent check', () => {
  it('refuses a batch when the row exists, with StaleWriteError, and writes nothing else', async () => {
    const { db, repo } = await fresh();
    await repo.put('tags', tag('1'), 'new');
    const rev = await repo.changeRev();
    await expect(repo.putMany([
      { op: 'put', store: 'tags', record: tag('2'), expectedRev: 'new' },
      { op: 'put', store: 'tags', record: tag('1', 'non-scorer'), expectedRev: 'new' },
    ])).rejects.toBeInstanceOf(StaleWriteError);
    expect(await roles(repo)).toEqual({ '1': 'scorer' });
    expect(await repo.changeRev()).toBe(rev);
    db.close();
  });
});

describe('Undo of a delete', () => {
  it('re-creates a deleted tag (createdAt kept), and one undo covers a create, an update and a delete together', async () => {
    const { db, repo } = await fresh();
    const gone = await repo.put('tags', tag('1'), 'new');
    const kept = await repo.put('tags', tag('2'), 'new');
    const stack = createUndoStack(repo);
    // One batch: delete tag 1, update tag 2, create tag 3.
    const [, updated, created] = await repo.putMany([
      { op: 'delete', store: 'tags', key: key('1'), expectedRev: gone.rev },
      { op: 'put', store: 'tags', record: tag('2', 'non-scorer'), expectedRev: kept.rev },
      { op: 'put', store: 'tags', record: tag('3'), expectedRev: 'new' },
    ]);
    stack.recordUndo({
      changes: [
        { before: { op: 'put', store: 'tags', record: gone }, writtenRev: 'absent' },
        { before: { op: 'put', store: 'tags', record: kept }, writtenRev: updated!.rev },
        { before: { op: 'delete', store: 'tags', key: key('3') }, writtenRev: created!.rev },
      ],
    });
    expect(await roles(repo)).toEqual({ '2': 'non-scorer', '3': 'scorer' });
    expect(await stack.undo()).toEqual({ status: 'undone' });
    expect(await roles(repo)).toEqual({ '1': 'scorer', '2': 'scorer' });
    expect(stack.size).toBe(0);
    db.close();
  });

  it('refuses the whole undo when the deleted tag was re-created elsewhere, and writes nothing', async () => {
    const { db, repo } = await fresh();
    const gone = await repo.put('tags', tag('1'), 'new');
    const other = await repo.put('tags', tag('2'), 'new');
    const stack = createUndoStack(repo);
    await repo.putMany([
      { op: 'delete', store: 'tags', key: key('1'), expectedRev: gone.rev },
      { op: 'put', store: 'tags', record: tag('2', 'non-scorer'), expectedRev: other.rev },
    ]);
    const updated = (await repo.get('tags', key('2'))) as { found: true; value: { rev: number } };
    stack.recordUndo({
      changes: [
        { before: { op: 'put', store: 'tags', record: gone }, writtenRev: 'absent' },
        { before: { op: 'put', store: 'tags', record: other }, writtenRev: updated.value.rev },
      ],
    });
    // Another context re-makes tag 1, with a different role.
    await repo.put('tags', tag('1', 'non-scorer'), 'new');
    const rev = await repo.changeRev();
    expect(await stack.undo()).toEqual({ status: 'changed elsewhere' });
    expect(await roles(repo)).toEqual({ '1': 'non-scorer', '2': 'non-scorer' });
    expect(await repo.changeRev()).toBe(rev);
    expect(stack.size, 'a refused undo stays on the stack').toBe(1);
    db.close();
  });
});

describe('Import and Clear cache announce on the change bus', () => {
  const watch = async (db: IDBPDatabase<OmniDbSchema>, bus: ReturnType<typeof createMemoryChangeBus>) => {
    const seen: (ChangeNotice | MissedChange)[] = [];
    await watchChanges(db, bus, (change) => seen.push(change));
    return seen;
  };
  const exportSettings = async (theme: 'dark' | 'light') => {
    const source = await fresh();
    await source.repo.put('settings', { key: 'theme', value: theme }, 'new');
    const file = await exportData(source.repo, { stores: ['settings'], includeSwimCloudData: false, includeSettings: true, extensionVersion: 'test' });
    source.db.close();
    return file;
  };

  it('an import that replaces settings reaches a second context watching the same bus', async () => {
    const mine = await fresh();
    await mine.repo.put('settings', { key: 'theme', value: 'light' }, 'new');
    const secondContext = await watch(mine.db, mine.bus);
    const file = await exportSettings('dark');
    const report = await importData(mine.db, file, { fileName: 'backup.json', onConflict: 'replace', bus: mine.bus });
    expect(report.replaced).toHaveLength(1);
    expect(secondContext).toHaveLength(1);
    expect(secondContext[0]).toMatchObject({ stores: ['settings'] });
    expect(((await mine.repo.get('settings', 'theme')) as { found: true; value: { value: string } }).value.value).toBe('dark');
    mine.db.close();
  });

  it('Clear cache bumps changeRev once and names both cache stores, and a clear of nothing announces nothing', async () => {
    const mine = await fresh();
    await seedFromFixture(mine.repo);
    const secondContext = await watch(mine.db, mine.bus);
    const before = await mine.repo.changeRev();
    const deleted = await clearFetchedSwimCloudData(mine.db, { bus: mine.bus });
    expect(deleted).toBeGreaterThan(0);
    expect(await mine.repo.changeRev()).toBe(before + 1);
    expect(secondContext).toHaveLength(1);
    expect(secondContext[0]).toMatchObject({ rev: before + 1, stores: ['swimmerHistory', 'rosters'] });
    expect(await mine.repo.list('swimmerHistory')).toEqual([]);
    expect(await mine.repo.list('tags')).not.toEqual([]);
    // Nothing left to delete.
    expect(await clearFetchedSwimCloudData(mine.db, { bus: mine.bus })).toBe(0);
    expect(await mine.repo.changeRev()).toBe(before + 1);
    expect(secondContext).toHaveLength(1);
    mine.db.close();
  });

  it('clearCache refuses a user store', async () => {
    const { db, repo } = await fresh();
    await expect(repo.clearCache(['tags' as never])).rejects.toThrow(/not a cache store/);
    db.close();
  });
});

describe('a rev is never reused for a key (the review finding on S1)', () => {
  it('a delete and re-create gives a rev that no earlier life of the key held, over many cycles', async () => {
    const { db, repo } = await fresh();
    const held = new Set<number>();
    let row = await repo.put('tags', tag('1'), 'new');
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(held.has(row.rev), `cycle ${cycle}: rev ${row.rev} was held before`).toBe(false);
      held.add(row.rev);
      row = await repo.put('tags', tag('1', 'non-scorer'), row.rev);
      expect(held.has(row.rev), `cycle ${cycle}: updated rev ${row.rev} was held before`).toBe(false);
      held.add(row.rev);
      await repo.delete('tags', key('1'), row.rev);
      row = await repo.put('tags', tag('1'), 'new');
    }
    expect([...held].every((r) => r < row.rev), 'every earlier rev is below the live one').toBe(true);
    expect(row.rev).toBeLessThanOrEqual(await repo.changeRev());
    db.close();
  });

  it('a stale put or delete with the old rev is refused after the row was deleted and re-created, and writes nothing', async () => {
    const { db, repo } = await fresh();
    const first = await repo.put('tags', tag('1'), 'new');
    await repo.delete('tags', key('1'), first.rev);
    const again = await repo.put('tags', tag('1', 'non-scorer'), 'new');
    expect(again.rev).not.toBe(first.rev);
    const rev = await repo.changeRev();
    await expect(repo.put('tags', tag('1'), first.rev)).rejects.toBeInstanceOf(StaleWriteError);
    await expect(repo.delete('tags', key('1'), first.rev)).rejects.toBeInstanceOf(StaleWriteError);
    await expect(repo.putMany([{ op: 'delete', store: 'tags', key: key('1'), expectedRev: first.rev }])).rejects.toBeInstanceOf(StaleWriteError);
    expect(await roles(repo)).toEqual({ '1': 'non-scorer' });
    expect(await repo.changeRev()).toBe(rev);
    db.close();
  });

  it('an undo that deletes a tag it created refuses when another context deleted and re-created that tag', async () => {
    const { db, repo } = await fresh();
    const stack = createUndoStack(repo);
    // "Accept" creates tag 1 and records the way back: delete it at the rev it got.
    const [created] = await repo.putMany([{ op: 'put', store: 'tags', record: tag('1'), expectedRev: 'new' }]);
    stack.recordUndo({ changes: [{ before: { op: 'delete', store: 'tags', key: key('1') }, writtenRev: created!.rev }] });
    // Another context deletes it and makes it again.
    await repo.delete('tags', key('1'), created!.rev);
    await repo.put('tags', tag('1', 'non-scorer'), 'new');
    const rev = await repo.changeRev();
    expect(await stack.undo()).toEqual({ status: 'changed elsewhere' });
    expect(await roles(repo)).toEqual({ '1': 'non-scorer' });
    expect(await repo.changeRev()).toBe(rev);
    db.close();
  });

  it('an import creates rows above every rev the key held, and replaces above the stored rev', async () => {
    const mine = await fresh();
    const first = await mine.repo.put('tags', tag('1'), 'new');
    await mine.repo.delete('tags', key('1'), first.rev);
    const source = await fresh();
    await source.repo.put('tags', tag('1', 'non-scorer'), 'new');
    const file = await exportData(source.repo, { stores: ['tags'], includeSwimCloudData: false, includeSettings: false, extensionVersion: 'test' });
    source.db.close();
    await importData(mine.db, file, { fileName: 'b.json', onConflict: 'skip' });
    const imported = (await mine.repo.get('tags', key('1'))) as { found: true; value: { rev: number } };
    expect(imported.value.rev).toBeGreaterThan(first.rev);
    await expect(mine.repo.put('tags', tag('1'), first.rev)).rejects.toBeInstanceOf(StaleWriteError);
    mine.db.close();
  });

  it('a row stored before this rule (any small rev) still reads and updates, and its next rev is above its own', async () => {
    const { db, repo } = await fresh();
    // As an older build wrote it: rev 7 with changeRev still 0.
    await (db as unknown as IDBPDatabase<unknown>).put('tags', { ...tag('9'), rev: 7, updatedAt: '2026-10-01T00:00:00.000Z' });
    const read = await repo.get('tags', key('9'));
    expect(read).toMatchObject({ found: true, value: { rev: 7 } });
    const next = await repo.put('tags', tag('9', 'non-scorer'), 7);
    expect(next.rev).toBe(8);
    db.close();
  });

  it('putMany follows the same rule: a batch delete and a batch re-create never reuse a rev', async () => {
    const { db, repo } = await fresh();
    const [first] = await repo.putMany([{ op: 'put', store: 'tags', record: tag('1'), expectedRev: 'new' }]);
    await repo.putMany([{ op: 'delete', store: 'tags', key: key('1'), expectedRev: first!.rev }]);
    const [again] = await repo.putMany([{ op: 'put', store: 'tags', record: tag('1', 'non-scorer'), expectedRev: 'new' }]);
    expect(again!.rev).toBeGreaterThan(first!.rev);
    await expect(repo.putMany([{ op: 'delete', store: 'tags', key: key('1'), expectedRev: first!.rev }])).rejects.toBeInstanceOf(StaleWriteError);
    expect(await roles(repo)).toEqual({ '1': 'non-scorer' });
    db.close();
  });

  it('an import replace goes above a stored rev that is itself above the changeRev (a row an older build wrote)', async () => {
    const mine = await fresh();
    await (mine.db as unknown as IDBPDatabase<unknown>).put('tags', { ...tag('9'), rev: 50, updatedAt: '2026-10-01T00:00:00.000Z' });
    const source = await fresh();
    await source.repo.put('tags', tag('9', 'non-scorer'), 'new');
    const file = await exportData(source.repo, { stores: ['tags'], includeSwimCloudData: false, includeSettings: false, extensionVersion: 'test' });
    source.db.close();
    await importData(mine.db, file, { fileName: 'b.json', onConflict: 'replace' });
    expect(await mine.repo.get('tags', key('9'))).toMatchObject({ found: true, value: { rev: 51, role: 'non-scorer' } });
    expect(await mine.repo.changeRev(), 'changeRev is lifted to the highest rev written').toBe(51);
    mine.db.close();
  });

  describe('changeRev stays at or above every rev ever written or deleted (round 2)', () => {
    /** A row an older build wrote: rev 2, and no changeRev row at all. */
    async function legacy() {
      const ctx = await fresh();
      await (ctx.db as unknown as IDBPDatabase<unknown>).put('tags', { ...tag('5'), rev: 2, updatedAt: '2026-10-01T00:00:00.000Z' });
      expect(await ctx.repo.changeRev()).toBe(0);
      return ctx;
    }

    it('a delete of the legacy row lifts changeRev to its rev, so the re-created row is above it and a stale rev-2 put is refused', async () => {
      const { db, repo } = await legacy();
      await repo.delete('tags', key('5'), 2);
      expect(await repo.changeRev()).toBe(2);
      const again = await repo.put('tags', tag('5', 'non-scorer'), 'new');
      expect(again.rev).toBeGreaterThan(2);
      await expect(repo.put('tags', tag('5'), 2)).rejects.toBeInstanceOf(StaleWriteError);
      await expect(repo.delete('tags', key('5'), 2)).rejects.toBeInstanceOf(StaleWriteError);
      expect(await roles(repo)).toEqual({ '5': 'non-scorer' });
      db.close();
    });

    it('the same holds for a putMany delete', async () => {
      const { db, repo } = await legacy();
      await repo.putMany([{ op: 'delete', store: 'tags', key: key('5'), expectedRev: 2 }]);
      expect(await repo.changeRev()).toBe(2);
      const [again] = await repo.putMany([{ op: 'put', store: 'tags', record: tag('5', 'non-scorer'), expectedRev: 'new' }]);
      expect(again!.rev).toBeGreaterThan(2);
      await expect(repo.putMany([{ op: 'put', store: 'tags', record: tag('5'), expectedRev: 2 }])).rejects.toBeInstanceOf(StaleWriteError);
      expect(await roles(repo)).toEqual({ '5': 'non-scorer' });
      db.close();
    });

    it('the same holds when an import creates the row after the delete', async () => {
      const { db, repo } = await legacy();
      await repo.delete('tags', key('5'), 2);
      const source = await fresh();
      await source.repo.put('tags', tag('5', 'non-scorer'), 'new');
      const file = await exportData(source.repo, { stores: ['tags'], includeSwimCloudData: false, includeSettings: false, extensionVersion: 'test' });
      source.db.close();
      await importData(db, file, { fileName: 'b.json', onConflict: 'skip' });
      const imported = (await repo.get('tags', key('5'))) as { found: true; value: { rev: number } };
      expect(imported.value.rev).toBeGreaterThan(2);
      await expect(repo.put('tags', tag('5'), 2)).rejects.toBeInstanceOf(StaleWriteError);
      db.close();
    });

    it('a put that raises a legacy row above changeRev lifts changeRev to the new rev', async () => {
      const { db, repo } = await legacy();
      const updated = await repo.put('tags', tag('5', 'non-scorer'), 2);
      expect(updated.rev).toBe(3);
      expect(await repo.changeRev()).toBe(3);
      db.close();
    });
  });
});
