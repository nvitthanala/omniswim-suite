/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 5.3: the storage repo (optimistic writes, change bus) and D3 5.4 (absent is not empty at the
 * repo boundary). T-E7 (snapshot) is in extensionStorageExport.test.ts with the other T-E tests.
 */
import { describe, expect, it } from 'vitest';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import type { StorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { CHANGE_NOTICE_KEY, createChromeChangeBus, createMemoryChangeBus, readChangeRev, watchChanges } from '../apps/extension/src/storage/changeBus';
import type { ChangeNotice, ChromeStorageLike, EventSource, MissedChange } from '../apps/extension/src/storage/changeBus';
import { InvalidRecordError, StaleWriteError } from '../apps/extension/src/storage/errors';
import type { MeetRecord } from '../apps/extension/src/storage/schema';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';
import { fixtureRecord, withoutRev } from './helpers/extensionRecords';

async function setup(bus = createMemoryChangeBus()) {
  const factory = freshFactory();
  const db = await openOmniDb({ factory, now: steppingClock(), newId: sequentialIds() });
  const notices: ChangeNotice[] = [];
  bus.subscribe(n => notices.push(n));
  const repo = createStorageRepo(db, { bus, now: steppingClock() });
  return { factory, db, repo, bus, notices };
}

const meetInput = () => withoutRev(fixtureRecord<MeetRecord>('meets', 0));

describe('extension storage repo (D3 5.3)', () => {
  it('get returns {found:false} for a missing key, distinct from a found record', async () => {
    const { repo, db } = await setup();
    expect(await repo.get('meets', 'nope')).toEqual({ found: false });
    expect(await repo.get('settings', 'flyoverAllowanceSec')).toEqual({ found: false });
    await repo.put('meets', meetInput(), 'new');
    const got = await repo.get('meets', 'm-1');
    expect(got.found).toBe(true);
    db.close();
  });

  it('put new sets rev 1 and updatedAt; put update adds 1 and keeps createdAt', async () => {
    const { repo, db } = await setup();
    const created = await repo.put('meets', meetInput(), 'new');
    expect(created.rev).toBe(1);
    expect(created.updatedAt).toBe('2026-10-27T00:00:00.000Z');
    expect(created.createdAt).toBe('2026-10-26T12:00:00.000Z');

    const updated = await repo.put('meets', { ...withoutRev(created), name: 'Renamed', createdAt: '2030-01-01T00:00:00.000Z' }, 1);
    expect(updated.rev).toBe(2);
    expect(updated.name).toBe('Renamed');
    expect(updated.createdAt).toBe('2026-10-26T12:00:00.000Z');
    expect(updated.updatedAt).toBe('2026-10-27T00:00:01.000Z');
    expect(await repo.get('meets', 'm-1')).toEqual({ found: true, value: updated });
    db.close();
  });

  it("put 'new' over an existing key and a stale rev both throw StaleWriteError and write nothing", async () => {
    const { repo, db, notices } = await setup();
    await repo.put('meets', meetInput(), 'new');
    const revBefore = await readChangeRev(db);
    const noticesBefore = notices.length;

    await expect(repo.put('meets', meetInput(), 'new')).rejects.toBeInstanceOf(StaleWriteError);
    await expect(repo.put('meets', { ...meetInput(), name: 'X' }, 5)).rejects.toBeInstanceOf(StaleWriteError);
    await expect(repo.put('meets', { ...meetInput(), meetKey: 'missing', name: 'X' }, 1)).rejects.toBeInstanceOf(StaleWriteError);
    await expect(repo.delete('meets', 'm-1', 9)).rejects.toBeInstanceOf(StaleWriteError);
    await expect(repo.delete('meets', 'missing', 1)).rejects.toBeInstanceOf(StaleWriteError);

    const stored = await repo.get('meets', 'm-1');
    expect(stored.found && stored.value.name).toBe('Fixture Championship');
    // A lost write bumps nothing and tells nobody.
    expect(await readChangeRev(db)).toBe(revBefore);
    expect(notices).toHaveLength(noticesBefore);
    db.close();
  });

  it('two connections: the one holding an old rev loses (read-modify-write is one transaction)', async () => {
    const { factory, db, repo } = await setup();
    const other = await openOmniDb({ factory });
    const otherRepo = createStorageRepo(other, { now: steppingClock() });
    const created = await repo.put('meets', meetInput(), 'new');
    await otherRepo.put('meets', { ...withoutRev(created), name: 'From tab B' }, created.rev);
    await expect(repo.put('meets', { ...withoutRev(created), name: 'From tab A' }, created.rev)).rejects.toBeInstanceOf(StaleWriteError);
    const final = await repo.get('meets', 'm-1');
    expect(final.found && final.value.name).toBe('From tab B');
    other.close();
    db.close();
  });

  it('concurrent puts of the same new key: exactly one wins', async () => {
    const { repo, db } = await setup();
    const results = await Promise.allSettled([repo.put('meets', meetInput(), 'new'), repo.put('meets', { ...meetInput(), name: 'B' }, 'new')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await repo.list('meets')).length).toBe(1);
    db.close();
  });

  it('delete removes the record and bumps changeRev', async () => {
    const { repo, db } = await setup();
    const created = await repo.put('meets', meetInput(), 'new');
    await repo.delete('meets', 'm-1', created.rev);
    expect(await repo.get('meets', 'm-1')).toEqual({ found: false });
    expect(await readChangeRev(db)).toBe(2);
    db.close();
  });

  it('list reads a store, and an index by value; an empty store is [] not an error', async () => {
    const { repo, db } = await setup();
    expect(await repo.list('lineups')).toEqual([]);
    const l1 = withoutRev(fixtureRecord<Record<string, unknown>>('lineups', 0));
    await repo.put('lineups', l1 as never, 'new');
    await repo.put('lineups', { ...l1, lineupId: 'l-9', meetKey: 'm-9', payload: { ...(l1.payload as object), meetKey: 'm-9' } } as never, 'new');
    expect((await repo.list('lineups')).map(l => l.lineupId)).toEqual(['l-1', 'l-9']);
    expect((await repo.list('lineups', { index: 'byMeet', value: 'm-9' })).map(l => l.lineupId)).toEqual(['l-9']);
    expect(await repo.list('lineups', { index: 'byMeet', value: 'm-none' })).toEqual([]);
    db.close();
  });

  it('every write transaction bumps changeRev; a notice follows only after the commit', async () => {
    const bus = createMemoryChangeBus();
    const { factory, db, repo } = await setup(bus);
    const reader = await openOmniDb({ factory });
    const checks: Promise<{ noticeRev: number; seenRev: number; found: boolean }>[] = [];
    bus.subscribe(n => {
      // At notice time the write must already be committed: a second connection reads it and a changeRev at least n.rev.
      checks.push(
        (async () => {
          const row = await reader.get('meets', 'm-1');
          return { noticeRev: n.rev, seenRev: await readChangeRev(reader), found: row !== undefined };
        })()
      );
    });
    const created = await repo.put('meets', meetInput(), 'new');
    await repo.put('meets', { ...withoutRev(created), name: 'B' }, created.rev);
    await repo.putCache('rosters', fixtureRecord('rosters') as never);
    const seen = await Promise.all(checks);
    expect(await readChangeRev(db)).toBe(3);
    expect(seen.map(c => c.noticeRev)).toEqual([1, 2, 3]);
    for (const c of seen) {
      expect(c.found).toBe(true);
      expect(c.seenRev).toBeGreaterThanOrEqual(c.noticeRev);
    }
    reader.close();
    db.close();
  });

  it('notices carry rev, stores and at', async () => {
    const { repo, db, notices } = await setup();
    await repo.put('meets', meetInput(), 'new');
    await repo.putCache('swimmerHistory', fixtureRecord('swimmerHistory') as never);
    expect(notices).toEqual([
      { rev: 1, stores: ['meets'], at: '2026-10-27T00:00:00.000Z' },
      { rev: 2, stores: ['swimmerHistory'], at: '2026-10-27T00:00:01.000Z' },
    ]);
    db.close();
  });

  it('a failing bus does not undo or hide a committed write', async () => {
    const factory = freshFactory();
    const db = await openOmniDb({ factory });
    const repo = createStorageRepo(db, { bus: { publish: () => Promise.reject(new Error('context invalidated')), subscribe: () => () => undefined } });
    await expect(repo.put('meets', meetInput(), 'new')).resolves.toMatchObject({ rev: 1 });
    expect((await repo.get('meets', 'm-1')).found).toBe(true);
    db.close();
  });

  describe('invalid records never reach the database', () => {
    const missingCap = (): never => {
      const r = withoutRev(fixtureRecord<Record<string, unknown>>('rulePresets', 0)) as { payload: { entries: { maxTotalPerSwimmer: Record<string, unknown> } } };
      delete r.payload.entries.maxTotalPerSwimmer.value;
      return r as never;
    };
    const cases: [string, (r: StorageRepo) => Promise<unknown>][] = [
      ['put with a missing cap', r => r.put('rulePresets', missingCap(), 'new')],
      ['putCache with an empty history', r => r.putCache('swimmerHistory', { ...fixtureRecord<Record<string, unknown>>('swimmerHistory'), payload: {} } as never)],
      ['putCache with an empty roster', r => r.putCache('rosters', { ...fixtureRecord<Record<string, unknown>>('rosters'), memberIds: [] } as never)],
    ];
    for (const [label, run] of cases) {
      it(label, async () => {
        const { repo, db, notices } = await setup();
        await expect(run(repo)).rejects.toBeInstanceOf(InvalidRecordError);
        expect(await readChangeRev(db)).toBe(0);
        expect(notices).toHaveLength(0);
        for (const store of ['rulePresets', 'swimmerHistory', 'rosters'] as const) expect(await repo.list(store)).toEqual([]);
        db.close();
      });
    }
    it('putCache refuses an edited store', async () => {
      const { repo, db } = await setup();
      await expect(repo.putCache('meets' as never, fixtureRecord('meets') as never)).rejects.toBeInstanceOf(RangeError);
      db.close();
    });
  });
});

describe('change bus', () => {
  it('chrome bus: publishes under osx:change and delivers only local-area, well-formed notices', () => {
    const written: Record<string, unknown>[] = [];
    const listeners: ((c: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
    const storage: ChromeStorageLike = {
      local: { set: items => (written.push(items), Promise.resolve()) },
      onChanged: { addListener: cb => void listeners.push(cb), removeListener: cb => void listeners.splice(listeners.indexOf(cb), 1) },
    };
    const bus = createChromeChangeBus(storage);
    const got: ChangeNotice[] = [];
    const stop = bus.subscribe(n => got.push(n));
    const notice: ChangeNotice = { rev: 3, stores: ['meets'], at: '2026-10-27T00:00:00.000Z' };
    void bus.publish(notice);
    expect(written).toEqual([{ [CHANGE_NOTICE_KEY]: notice }]);
    listeners[0]?.({ [CHANGE_NOTICE_KEY]: { newValue: notice } }, 'local');
    listeners[0]?.({ [CHANGE_NOTICE_KEY]: { newValue: notice } }, 'sync');
    listeners[0]?.({ other: { newValue: notice } }, 'local');
    listeners[0]?.({ [CHANGE_NOTICE_KEY]: { newValue: { rev: 'x' } } }, 'local');
    expect(got).toEqual([notice]);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it('watchChanges reports a notice once, and recovers a lost notice on focus', async () => {
    const bus = createMemoryChangeBus();
    const lossy = { publish: () => Promise.resolve(), subscribe: bus.subscribe };
    const factory = freshFactory();
    const writerDb = await openOmniDb({ factory });
    const watcherDb = await openOmniDb({ factory });
    const writer = createStorageRepo(writerDb, { bus: lossy, now: steppingClock() });
    const reported: (ChangeNotice | MissedChange)[] = [];
    const listeners = new Map<string, () => void>();
    const target: EventSource = {
      addEventListener: (type, l) => void listeners.set(type, l),
      removeEventListener: type => void listeners.delete(type),
    };
    const watch = await watchChanges(watcherDb, bus, c => reported.push(c), { targets: [target] });

    // A write whose notice is lost: the bus publishes nowhere.
    await writer.put('meets', meetInput(), 'new');
    expect(reported).toEqual([]);
    listeners.get('focus')?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reported).toEqual([{ rev: 1, stores: 'unknown', at: null }]);
    expect(watch.lastSeenRev()).toBe(1);

    // A real notice with an older or equal rev is not reported twice.
    await bus.publish({ rev: 1, stores: ['meets'], at: '2026-10-27T00:00:00.000Z' });
    await bus.publish({ rev: 2, stores: ['tags'], at: '2026-10-27T00:00:01.000Z' });
    expect(reported).toHaveLength(2);
    expect(reported[1]).toMatchObject({ rev: 2, stores: ['tags'] });

    watch.stop();
    expect(listeners.size).toBe(0);
    watcherDb.close();
    writerDb.close();
  });
});
