/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Schema migrations (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.5).
 *
 * `up` runs inside the versionchange transaction. It awaits only IndexedDB requests on `tx`, is a
 * pure transform (no network, no `chrome.*`, no clock, no random source) and is never caught here:
 * a failed upgrade aborts and the old data survives. Never call `deleteDatabase` to recover.
 * The `meta.db` row is written by `openOmniDb` after the chain, so `up` stays pure.
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { DB_VERSION } from './schema';

export interface Migration {
  readonly to: number;
  readonly up: (db: IDBPDatabase<unknown>, tx: IDBPTransaction<unknown, string[], 'versionchange'>) => Promise<void> | void;
}

/**
 * The v1 layout, frozen. `STORE_DEFS` in schema.ts describes the current layout and changed at v2
 * (it gained `classYearOverrides`); this table must not. A test compares a fresh database to `STORE_DEFS`.
 */
const V1_STORES: readonly { readonly name: string; readonly keyPath: string | string[]; readonly indexes: readonly (readonly [string, string])[] }[] = [
  { name: 'meta', keyPath: 'key', indexes: [] },
  { name: 'settings', keyPath: 'key', indexes: [] },
  { name: 'rulePresets', keyPath: 'id', indexes: [['byName', 'name']] },
  { name: 'sessionPresets', keyPath: 'id', indexes: [['byName', 'name']] },
  { name: 'meets', keyPath: 'meetKey', indexes: [['byUpdatedAt', 'updatedAt']] },
  { name: 'tags', keyPath: ['meetKey', 'teamId', 'swimmerId'], indexes: [['byMeet', 'meetKey']] },
  { name: 'lineups', keyPath: 'lineupId', indexes: [['byMeet', 'meetKey'], ['byUpdatedAt', 'updatedAt']] },
  { name: 'swimmerHistory', keyPath: 'swimmerId', indexes: [['byFetchedAt', 'fetchedAt']] },
  { name: 'rosters', keyPath: ['teamId', 'seasonId', 'gender'], indexes: [['byFetchedAt', 'fetchedAt']] },
];

export function createV1Stores(db: IDBPDatabase<unknown>): void {
  for (const def of V1_STORES) {
    const store = db.createObjectStore(def.name, { keyPath: def.keyPath });
    for (const [indexName, keyPath] of def.indexes) store.createIndex(indexName, keyPath);
  }
}

/**
 * v2 (R51): the `classYearOverrides` store, keyed by swimmer and season. It adds a store and changes no
 * existing record. R53's `verifiedEmpty` and R54's `status` are optional fields: no v1 record has either,
 * and none gains a meaning (every v1 roster has members and every v1 meet has teams), so no record is rewritten.
 */
const V2_STORES: readonly { readonly name: string; readonly keyPath: string | string[]; readonly indexes: readonly (readonly [string, string])[] }[] = [
  { name: 'classYearOverrides', keyPath: ['swimmerId', 'seasonId'], indexes: [['bySeason', 'seasonId']] },
];

export function createV2Stores(db: IDBPDatabase<unknown>): void {
  for (const def of V2_STORES) {
    const store = db.createObjectStore(def.name, { keyPath: def.keyPath });
    for (const [indexName, keyPath] of def.indexes) store.createIndex(indexName, keyPath);
  }
}

export const MIGRATIONS: readonly Migration[] = [
  { to: 1, up: createV1Stores },
  { to: 2, up: createV2Stores },
];

/**
 * Throws unless `migrations` run `to` 1, 2, ... `version` with no gap, repeat or extra step.
 * A skipped version would leave a database that says it is at N and lacks N's stores.
 */
export function assertMigrationChain(migrations: readonly Migration[], version: number = DB_VERSION): void {
  const tos = migrations.map(m => m.to);
  const want = Array.from({ length: version }, (_, i) => i + 1);
  if (tos.length !== want.length || tos.some((to, i) => to !== want[i])) {
    throw new RangeError(`Migration chain [${tos.join(', ')}] does not run 1..${version} in order.`);
  }
}
