/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Valid records for the storage tests, read from a frozen fixture
 * (tests/fixtures/extension-db/v1.json by default, v2.json for the R51, R53 and R54 fields).
 * Every call returns a fresh deep copy, so a test can break one field without touching the next test.
 */
import type { DbFixture } from './extensionDb';
import { readFixture } from './extensionDb';
import type { UserStore } from '../../apps/extension/src/storage/schema';
import type { StorageRepo } from '../../apps/extension/src/storage/repo';

export function fixtureRecords<T extends object = Record<string, unknown>>(store: UserStore | 'meta', version = 1): T[] {
  const fixture = readFixture(`v${version}.json`) as DbFixture;
  const records = fixture.stores[store];
  if (!records) throw new Error(`fixture v${version}.json has no ${store} records`);
  return JSON.parse(JSON.stringify(records)) as T[];
}

/** True when fixture `v<version>.json` has a (non-empty) list for `store`. A store added at a later version has none in v1. */
export function hasFixtureStore(store: UserStore | 'meta', version: number): boolean {
  const fixture = readFixture(`v${version}.json`) as DbFixture;
  return fixture.stores[store] !== undefined;
}

export function fixtureRecord<T extends object = Record<string, unknown>>(store: UserStore, index = 0, version = 1): T {
  const record = fixtureRecords<T>(store, version)[index];
  if (record === undefined) throw new Error(`fixture v${version}.json has no ${store}[${index}]`);
  return record;
}

/** `record` without the keys the repo sets on `put`. */
export function withoutRev<T extends object>(record: T): Omit<T, 'rev' | 'updatedAt'> {
  const { rev: _rev, updatedAt: _updatedAt, ...rest } = record as Record<string, unknown>;
  return rest as Omit<T, 'rev' | 'updatedAt'>;
}

/** Set `value` at a dotted path (array indexes as numbers) on a deep copy. */
export function setAt<T>(record: T, path: readonly (string | number)[], value: unknown): T {
  const copy = JSON.parse(JSON.stringify(record)) as Record<string | number, unknown>;
  let cursor: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path[path.length - 1] as string | number] = value;
  return copy as T;
}

/** Remove the key at `path` on a deep copy. */
export function removeAt<T>(record: T, path: readonly (string | number)[]): T {
  const copy = JSON.parse(JSON.stringify(record)) as Record<string | number, unknown>;
  let cursor: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  delete cursor[path[path.length - 1] as string | number];
  return copy as T;
}

/** Put every v1 fixture record (except `meta`) through the repo, so a test starts from realistic data. */
export async function seedFromFixture(repo: StorageRepo): Promise<void> {
  for (const store of ['rulePresets', 'sessionPresets', 'meets', 'tags', 'lineups', 'settings'] as const) {
    for (const record of fixtureRecords(store)) await repo.put(store, withoutRev(record) as never, 'new');
  }
  for (const record of fixtureRecords('swimmerHistory')) await repo.putCache('swimmerHistory', record as never);
  for (const record of fixtureRecords('rosters')) await repo.putCache('rosters', record as never);
}
