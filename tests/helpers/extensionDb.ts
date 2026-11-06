/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test helpers for the extension's IndexedDB layer (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.1).
 *
 * Each test gets a fresh `IDBFactory` from fake-indexeddb, so no database leaks between tests.
 * idb's proxies check `instanceof` against the global `IDBRequest`, `IDBDatabase` and friends, so
 * this file installs those classes on `globalThis`. It does NOT install `indexedDB`: production
 * code must take the factory from the caller, and a missing factory should fail the test.
 */
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrap } from 'idb';
import type { IDBPDatabase } from 'idb';
import { DB_NAME } from '../../apps/extension/src/storage/schema';
import type { OmniDbSchema } from '../../apps/extension/src/storage/schema';
import type { Migration } from '../../apps/extension/src/storage/migrations';

const GLOBALS = { IDBCursor, IDBCursorWithValue, IDBDatabase, IDBIndex, IDBKeyRange, IDBObjectStore, IDBOpenDBRequest, IDBRequest, IDBTransaction };
for (const [name, value] of Object.entries(GLOBALS)) {
  Object.defineProperty(globalThis, name, { value, enumerable: false, configurable: true, writable: true });
}

/** A new, empty IndexedDB. */
export function freshFactory(): IDBFactory {
  return new IDBFactory() as unknown as IDBFactory;
}

/** A clock that returns `2026-10-27T00:00:00.000Z`, then one second later, and so on. */
export function steppingClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 27, 0, 0, n++)).toISOString();
}

/** `id-1`, `id-2`, ... */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'extension-db');

export interface DbFixture {
  readonly schemaVersion: number;
  readonly stores: Readonly<Record<string, readonly unknown[]>>;
}

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

export interface DbDump {
  readonly version: number;
  readonly stores: Record<
    string,
    {
      readonly keyPath: string | readonly string[] | null;
      readonly indexes: Record<string, { readonly keyPath: string | readonly string[]; readonly unique: boolean; readonly multiEntry: boolean }>;
      readonly records: unknown[];
    }
  >;
}

/** Version, every store with its key path and indexes, and every record in key order. */
export async function dumpDb(db: IDBPDatabase<unknown> | IDBPDatabase<OmniDbSchema>): Promise<DbDump> {
  const raw = db as unknown as IDBPDatabase<unknown>;
  const names = [...raw.objectStoreNames].sort();
  const tx = raw.transaction(names, 'readonly');
  const stores: DbDump['stores'] = {};
  for (const name of names) {
    const store = tx.objectStore(name);
    const indexes: DbDump['stores'][string]['indexes'] = {};
    for (const indexName of [...store.indexNames].sort()) {
      const index = store.index(indexName);
      indexes[indexName] = { keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
    }
    stores[name] = { keyPath: store.keyPath, indexes, records: await store.getAll() };
  }
  await tx.done;
  return { version: raw.version, stores };
}

/**
 * Build a database at `version` the way an old build would have: run `migrations` up to `version`
 * with no `meta` bookkeeping, then put every fixture record raw. Closes the connection.
 */
export async function buildOldDb(
  factory: IDBFactory,
  version: number,
  migrations: readonly Migration[],
  fixture: DbFixture
): Promise<void> {
  const request = factory.open(DB_NAME, version);
  const opened = wrap(request);
  request.addEventListener('upgradeneeded', () => {
    const db = wrap(request.result) as unknown as IDBPDatabase<unknown>;
    const tx = wrap(request.transaction!) as never;
    void (async () => {
      for (const m of migrations) if (m.to <= version) await m.up(db, tx);
      for (const [store, records] of Object.entries(fixture.stores)) {
        const os = (tx as { objectStore(n: string): { put(v: unknown): Promise<unknown> } }).objectStore(store);
        for (const record of records) await os.put(record);
      }
    })();
  });
  const db = (await opened) as unknown as IDBPDatabase<unknown>;
  db.close();
}
