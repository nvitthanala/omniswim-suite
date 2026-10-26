/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D3 5.5, T-M1 to T-M6: versions and migrations of the extension's IndexedDB.
 * Each test gets a fresh fake-indexeddb factory (tests/helpers/extensionDb.ts).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { assertMigrationChain, MIGRATIONS } from '../apps/extension/src/storage/migrations';
import type { Migration } from '../apps/extension/src/storage/migrations';
import { NewerDatabaseError } from '../apps/extension/src/storage/errors';
import { DB_NAME, DB_VERSION, STORE_DEFS, STORE_NAMES } from '../apps/extension/src/storage/schema';
import { buildOldDb, dumpDb, FIXTURE_DIR, freshFactory, readFixture, sequentialIds, steppingClock } from './helpers/extensionDb';
import type { DbDump, DbFixture } from './helpers/extensionDb';

const versions = Array.from({ length: DB_VERSION }, (_, i) => i + 1);

describe('extension storage migrations (D3 5.5)', () => {
  it('T-M1: MIGRATIONS run to 1..DB_VERSION in order, with no gap', () => {
    expect(MIGRATIONS.map(m => m.to)).toEqual(versions);
    expect(() => assertMigrationChain(MIGRATIONS)).not.toThrow();
  });

  it('T-M1: a chain that skips, repeats or stops short is refused, and so is an open with one', async () => {
    const up = (): void => undefined;
    expect(() => assertMigrationChain([{ to: 1, up }, { to: 3, up }], 3)).toThrow(/does not run 1\.\.3/);
    expect(() => assertMigrationChain([{ to: 1, up }, { to: 1, up }], 2)).toThrow();
    expect(() => assertMigrationChain([{ to: 1, up }], 2)).toThrow();
    await expect(openOmniDb({ factory: freshFactory(), version: 3, migrations: [{ to: 1, up }, { to: 3, up }] })).rejects.toThrow(RangeError);
  });

  it('T-M2: every version has a fixture whose sha256 matches FROZEN.json, and the counts agree', () => {
    const frozen = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'FROZEN.json'), 'utf8')) as { fixtures: Record<string, string> };
    const shipped = readdirSync(FIXTURE_DIR).filter(f => /^v\d+\.json$/.test(f)).sort();
    expect(shipped).toEqual(versions.map(v => `v${v}.json`));
    expect(Object.keys(frozen.fixtures).sort()).toEqual(shipped);
    for (const file of shipped) {
      // LF-normalized: a Windows checkout with CRLF must hash like a Linux one.
      const text = readFileSync(path.join(FIXTURE_DIR, file), 'utf8').replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(text).digest('hex'), `${file} was edited after it shipped`).toBe(frozen.fixtures[file]);
    }
  });

  it.each(versions)('T-M3: a v%i database, opened by the current code, dumps to its expected-current.json', async v => {
    const factory = freshFactory();
    const fixture = readFixture(`v${v}.json`) as DbFixture;
    expect(fixture.schemaVersion).toBe(v);
    await buildOldDb(factory, v, MIGRATIONS, fixture);
    const db = await openOmniDb({ factory, now: steppingClock(), newId: sequentialIds() });
    try {
      expect(db.version).toBe(DB_VERSION);
      const expected = readFixture(`v${v}.expected-current.json`) as DbDump;
      expect(await dumpDb(db)).toEqual(expected);
    } finally {
      db.close();
    }
  });

  it('a fresh database has exactly the STORE_DEFS layout and a meta.db row written once', async () => {
    const factory = freshFactory();
    const db = await openOmniDb({ factory, now: steppingClock(), newId: sequentialIds('install') });
    const dump = await dumpDb(db);
    expect(Object.keys(dump.stores).sort()).toEqual([...STORE_NAMES].sort());
    for (const name of STORE_NAMES) {
      const def = STORE_DEFS[name];
      expect(dump.stores[name]?.keyPath, name).toEqual(def.keyPath);
      expect(Object.keys(dump.stores[name]?.indexes ?? {}).sort(), name).toEqual(Object.keys(def.indexes).sort());
      for (const [indexName, keyPath] of Object.entries(def.indexes)) {
        expect(dump.stores[name]?.indexes[indexName], `${name}.${indexName}`).toEqual({ keyPath, unique: false, multiEntry: false });
      }
    }
    expect(dump.stores.meta?.records).toEqual([
      {
        key: 'db',
        schemaVersion: DB_VERSION,
        createdAt: '2026-10-27T00:00:00.000Z',
        installId: 'install-1',
        migrationLog: [{ from: 0, to: DB_VERSION, at: '2026-10-27T00:00:00.000Z' }],
      },
    ]);
    // Defaults and presets are never written at install (D3 5.2, 5.8).
    for (const name of STORE_NAMES) if (name !== 'meta') expect(dump.stores[name]?.records, name).toEqual([]);
    db.close();
    // Reopening at the same version runs no upgrade, so meta.db is unchanged.
    const again = await openOmniDb({ factory, now: steppingClock(), newId: sequentialIds('other') });
    expect((await dumpDb(again)).stores.meta?.records).toEqual(dump.stores.meta?.records);
    again.close();
  });

  it('T-M4: a database newer than DB_VERSION rejects with NewerDatabaseError, and its data survives', async () => {
    const factory = freshFactory();
    const up2: Migration = {
      to: DB_VERSION + 1,
      up: (_db, tx) => {
        void tx.objectStore('settings').put({ key: 'theme', value: 'dark', rev: 1, updatedAt: '2026-10-27T00:00:00.000Z' });
      },
    };
    const newer = await openOmniDb({ factory, version: DB_VERSION + 1, migrations: [...MIGRATIONS, up2], now: steppingClock(), newId: sequentialIds() });
    newer.close();

    await expect(openOmniDb({ factory })).rejects.toBeInstanceOf(NewerDatabaseError);

    // A test-only newer reopen sees the data: the failed open deleted and changed nothing.
    const reopened = await openOmniDb({ factory, version: DB_VERSION + 1, migrations: [...MIGRATIONS, up2] });
    expect(reopened.version).toBe(DB_VERSION + 1);
    expect(await reopened.get('settings', 'theme')).toEqual({ key: 'theme', value: 'dark', rev: 1, updatedAt: '2026-10-27T00:00:00.000Z' });
    reopened.close();
  });

  it('T-M5: a second connection that upgrades is not blocked, because the first closes on versionchange', async () => {
    const factory = freshFactory();
    let aNotified = 0;
    const a = await openOmniDb({ factory, onVersionChange: () => void (aNotified += 1) });
    const up2: Migration = {
      to: DB_VERSION + 1,
      up: db => {
        db.createObjectStore('testStore');
      },
    };
    const b = openOmniDb({ factory, version: DB_VERSION + 1, migrations: [...MIGRATIONS, up2] });
    // Without the `versionchange` handler, B waits on A forever. Fail in 2 s, not at the test timeout.
    const outcome = await Promise.race([b.then(() => 'opened' as const), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2000))]);
    expect(outcome).toBe('opened');
    expect(aNotified).toBe(1);
    expect([...(await b).objectStoreNames]).toContain('testStore');
    (await b).close();
    a.close();
  });

  it('T-M6: a throwing migration leaves the database at its old version with its data unchanged', async () => {
    const factory = freshFactory();
    const fixture = readFixture('v1.json') as DbFixture;
    await buildOldDb(factory, 1, MIGRATIONS, fixture);
    const boom = new Error('migration exploded');
    const bad: Migration = {
      to: 2,
      up: async (db, tx) => {
        db.createObjectStore('extraStore');
        // A write that would be committed if the failure did not abort the transaction.
        await tx.objectStore('settings').put({ key: 'theme', value: 'light', rev: 99, updatedAt: '2026-01-01T00:00:00.000Z' });
        await tx.objectStore('meta').delete('changeRev');
        throw boom;
      },
    };
    await expect(openOmniDb({ factory, version: 2, migrations: [...MIGRATIONS, bad], now: steppingClock(), newId: sequentialIds() })).rejects.toBe(boom);

    const db = await openOmniDb({ factory });
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames]).not.toContain('extraStore');
    expect(await dumpDb(db)).toEqual(readFixture('v1.expected-current.json'));
    db.close();
  });

  it('opens the DB_NAME database, never another', async () => {
    const factory = freshFactory();
    (await openOmniDb({ factory })).close();
    const names = (await (factory as unknown as { databases(): Promise<{ name: string }[]> }).databases()).map(d => d.name);
    expect(names).toEqual([DB_NAME]);
  });
});
