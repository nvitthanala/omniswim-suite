/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fixes from the architect audit of P1.storage (2026-10-26). Each test failed before its fix.
 */
import { describe, expect, it, vi } from 'vitest';
import { IDBDatabase } from 'fake-indexeddb';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { MIGRATIONS } from '../apps/extension/src/storage/migrations';
import type { Migration } from '../apps/extension/src/storage/migrations';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { createMemoryChangeBus, watchChanges } from '../apps/extension/src/storage/changeBus';
import type { ChangeNotice, MissedChange } from '../apps/extension/src/storage/changeBus';
import { exportData, importData } from '../apps/extension/src/storage/exportImport';
import { assertValidRecord, validateRecord } from '../apps/extension/src/storage/validate';
import { InvalidRecordError, ImportValidationError } from '../apps/extension/src/storage/errors';
import type { MeetRecord } from '../apps/extension/src/storage/schema';
import { buildOldDb, freshFactory, readFixture, steppingClock } from './helpers/extensionDb';
import type { DbFixture } from './helpers/extensionDb';
import { fixtureRecord, setAt, seedFromFixture, withoutRev } from './helpers/extensionRecords';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('audit 1: a broken migration never yields an open database', () => {
  const lateStep: Migration = {
    to: 2,
    up: async (db, tx) => {
      await tx.objectStore('settings').put({ key: 'theme', value: 'dark', rev: 1, updatedAt: '2026-10-27T00:00:00.000Z' });
      // The upgrade transaction can finish while this timer runs. The store below is then never created.
      await tick();
      db.createObjectStore('late');
    },
  };

  it('a migration that awaits a timer makes openOmniDb reject, and every later open rejects too', async () => {
    const factory = freshFactory();
    const chain = [...MIGRATIONS, lateStep];
    await expect(openOmniDb({ factory, version: 2, migrations: chain, now: steppingClock() })).rejects.toThrow();
    // The database is now at version 2 with meta.db at 1. It is never repaired and never deleted, so it never opens.
    await expect(openOmniDb({ factory, version: 2, migrations: chain })).rejects.toThrow(/schemaVersion/);
  });

  it('an open requires meta.db.schemaVersion to equal the database version', async () => {
    const factory = freshFactory();
    const fixture = readFixture('v1.json') as DbFixture;
    const withoutMeta: DbFixture = { ...fixture, stores: { ...fixture.stores, meta: [] } };
    await buildOldDb(factory, 1, MIGRATIONS, withoutMeta);
    await expect(openOmniDb({ factory })).rejects.toThrow(/meta\.db/);

    const other = freshFactory();
    const stale = { ...fixture, stores: { ...fixture.stores, meta: [{ ...(fixture.stores.meta?.[1] as object), schemaVersion: 7 }] } };
    await buildOldDb(other, 1, MIGRATIONS, stale as DbFixture);
    await expect(openOmniDb({ factory: other })).rejects.toThrow(/schemaVersion/);
  });
});

describe('audit 2: a late or lost notice is recovered', () => {
  async function setup() {
    const factory = freshFactory();
    const writerDb = await openOmniDb({ factory });
    const watcherDb = await openOmniDb({ factory });
    // The writer has no bus, so the test decides which notices arrive and when.
    const writer = createStorageRepo(writerDb, { now: steppingClock() });
    const bus = createMemoryChangeBus();
    const reported: (ChangeNotice | MissedChange)[] = [];
    const watch = await watchChanges(watcherDb, bus, c => reported.push(c));
    return { writer, bus, reported, watch, close: () => (writerDb.close(), watcherDb.close()) };
  }
  const notice = (rev: number, store: 'meets' | 'settings'): ChangeNotice => ({ rev, stores: [store], at: '2026-10-27T00:00:00.000Z' });

  it('reorder: the newer notice arrives first, so the older change is reported as missed', async () => {
    const { bus, reported, watch, close } = await setup();
    await bus.publish(notice(2, 'settings'));
    await bus.publish(notice(1, 'meets'));
    expect(reported).toEqual([{ rev: 1, stores: 'unknown', at: null }, notice(2, 'settings')]);
    expect(watch.lastSeenRev()).toBe(2);
    close();
  });

  it('a lost notice followed by a later notice reports the gap, once', async () => {
    const { bus, reported, close } = await setup();
    await bus.publish(notice(1, 'meets'));
    await bus.publish(notice(3, 'settings'));
    await bus.publish(notice(3, 'settings'));
    expect(reported).toEqual([notice(1, 'meets'), { rev: 2, stores: 'unknown', at: null }, notice(3, 'settings')]);
    close();
  });

  it('consecutive notices report no gap', async () => {
    const { bus, reported, close } = await setup();
    await bus.publish(notice(1, 'meets'));
    await bus.publish(notice(2, 'settings'));
    expect(reported).toEqual([notice(1, 'meets'), notice(2, 'settings')]);
    close();
  });
});

describe('audit 3: validateRecord on a name that is not a user store', () => {
  it('returns an issue for meta and for an unknown name, and put refuses meta', async () => {
    for (const name of ['meta', 'nope', 'toString', '__proto__']) {
      const issues = validateRecord(name as never, { key: 'db' });
      expect(issues, name).toHaveLength(1);
      expect(() => assertValidRecord(name as never, { key: 'db' }), name).toThrow(InvalidRecordError);
    }
    const db = await openOmniDb({ factory: freshFactory() });
    const repo = createStorageRepo(db);
    await expect(repo.put('meta' as never, { key: 'db' } as never, 'new')).rejects.toBeInstanceOf(InvalidRecordError);
    db.close();
  });
});

describe('audit 4: the export header is a strict ISO instant', () => {
  it('rejects a header whose exportedAt is not a real instant, with ImportValidationError', async () => {
    const db = await openOmniDb({ factory: freshFactory() });
    const repo = createStorageRepo(db, { now: steppingClock() });
    await repo.put('meets', withoutRev(fixtureRecord<MeetRecord>('meets', 0)), 'new');
    const good = JSON.parse(JSON.stringify(await exportData(repo, { stores: ['meets'], includeSwimCloudData: false, includeSettings: false, extensionVersion: '0.1.0' })));
    const target = await openOmniDb({ factory: freshFactory() });
    for (const bad of ['2026-13-45T00:00:00Z', '2026-02-30T00:00:00.000Z', '2026-10-28T00:00:00', '2026-10-28T24:00:00Z', '2026-10-28T00:00:60Z', 'yesterday']) {
      const error = await importData(target, { ...good, exportedAt: bad }, { fileName: 'f.json', onConflict: 'keep-both' }).catch(e => e as unknown);
      expect(error, bad).toBeInstanceOf(ImportValidationError);
      expect((error as ImportValidationError).issues.map(i => i.path), bad).toEqual(['exportedAt']);
    }
    // A real instant still imports.
    await expect(importData(target, good, { fileName: 'f.json', onConflict: 'keep-both' })).resolves.toMatchObject({ written: { meets: 1 } });
    target.close();
    db.close();
  });
});

describe('audit 5: an export reads all its stores in one transaction', () => {
  it('listMany opens one readonly transaction, and exportData uses it instead of per-store list', async () => {
    const db = await openOmniDb({ factory: freshFactory() });
    const repo = createStorageRepo(db, { now: steppingClock() });
    await seedFromFixture(repo);
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    try {
      const many = await repo.listMany(['meets', 'tags', 'lineups']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(Object.keys(many)).toEqual(['meets', 'tags', 'lineups']);
      expect(many.meets).toHaveLength(2);
      spy.mockClear();
      const listSpy = vi.spyOn(repo, 'list');
      const file = await exportData(repo, { stores: ['meets', 'tags', 'lineups'], includeSwimCloudData: true, includeSettings: false, extensionVersion: '0.1.0' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(listSpy).not.toHaveBeenCalled();
      expect(Object.keys(file.stores)).toEqual(['meets', 'tags', 'lineups']);
      // No stores asked for: IndexedDB refuses a transaction over none, so the repo must not open one.
      expect(await repo.listMany([])).toEqual({});
    } finally {
      spy.mockRestore();
    }
    db.close();
  });
});

describe('audit 6: lineup entries use the SwimCloud id rule', () => {
  it('rejects 0123 as an entry teamId or swimmerId and as a relay leg swimmerId', () => {
    const lineup = fixtureRecord('lineups', 0);
    expect(validateRecord('lineups', lineup)).toEqual([]);
    const cases: [string, (string | number)[]][] = [
      ['individual teamId', ['payload', 'entries', 0, 'teamId']],
      ['individual swimmerId', ['payload', 'entries', 0, 'swimmerId']],
      ['relay teamId', ['payload', 'entries', 1, 'teamId']],
      ['relay leg swimmerId', ['payload', 'entries', 1, 'legs', 2, 'swimmerId']],
    ];
    for (const [label, where] of cases) {
      for (const id of ['0123', '12a', 123]) {
        const issues = validateRecord('lineups', setAt(lineup, where, id));
        expect(issues.map(i => i.path), `${label} ${String(id)}`).toEqual([`$.${where.join('.').replace(/\.(\d+)/g, '[$1]')}`]);
      }
    }
  });
});
