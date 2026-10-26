/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The storage repository (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.3).
 *
 * - Read-modify-write runs in one readwrite transaction that awaits only IndexedDB promises.
 * - `put` and `delete` are optimistic: a stale `rev` throws `StaleWriteError` and writes nothing.
 * - Every write transaction bumps `meta.changeRev`. The bus publishes after `tx.done`.
 * - A snapshot lineup rejects any `put` after create.
 * - Records are validated before they are written (validate.ts). A missing cap, a `legacy`
 *   provenance and an empty cache row never reach IndexedDB.
 * - `{found:false}` stays distinct from a found record. `list` never invents a row.
 *
 * Only extension pages and the service worker may use this (D3 decision 0.2).
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { InvalidRecordError, SnapshotImmutableError, StaleWriteError } from './errors';
import type { ChangeBus } from './changeBus';
import { assertValidRecord } from './validate';
import { CACHE_STORES, STORE_DEFS } from './schema';
import type {
  CacheStore,
  EditedStore,
  IndexOf,
  IsoTime,
  KeyOf,
  LineupRecord,
  MetaChangeRevRow,
  OmniDbSchema,
  Rev,
  StoreName,
  UserStore,
  ValueOf,
} from './schema';

export { StaleWriteError, NewerDatabaseError, InvalidRecordError, SnapshotImmutableError } from './errors';
export { openOmniDb } from './open';
export type { OpenOmniDbOptions } from './open';

export type GetResult<S extends UserStore> = { found: false } | { found: true; value: ValueOf<S> };

export interface StorageRepo {
  get<S extends UserStore>(store: S, key: KeyOf<S>): Promise<GetResult<S>>;
  list<S extends UserStore>(store: S, query?: { index: IndexOf<S>; value: IDBValidKey }): Promise<ValueOf<S>[]>;
  /** Every row of each store, read in one readonly transaction (a consistent snapshot). Keys are the stores asked for, in order. */
  listMany<S extends UserStore>(stores: readonly S[]): Promise<{ [K in S]: ValueOf<K>[] }>;
  /**
   * Create (`expectedRev: 'new'`) or update (the `rev` the caller read). Returns the stored record.
   * `rev` and `updatedAt` are set here. On update `createdAt` is kept from the stored record.
   */
  put<S extends EditedStore>(store: S, record: Omit<ValueOf<S>, 'rev' | 'updatedAt'>, expectedRev: Rev | 'new'): Promise<ValueOf<S>>;
  delete<S extends EditedStore>(store: S, key: KeyOf<S>, expectedRev: Rev): Promise<void>;
  /** A fetched-data cache row. No `rev`: a later fetch replaces the row. */
  putCache<S extends CacheStore>(store: S, record: ValueOf<S>): Promise<void>;
}

export interface StorageRepoOptions {
  /** Publishes `{rev, stores, at}` after each commit. Without one, no notice is sent. */
  readonly bus?: ChangeBus;
  /** The clock for `updatedAt` and notices. Defaults to `new Date().toISOString()`. */
  readonly now?: () => IsoTime;
}

type Row = Record<string, unknown>;
type RawDb = IDBPDatabase<unknown>;
type RawTx = IDBPTransaction<unknown, string[], 'readwrite'>;

function keyOfRecord(store: StoreName, record: Row): IDBValidKey {
  const keyPath = STORE_DEFS[store].keyPath;
  return (Array.isArray(keyPath) ? keyPath.map(k => record[k as string]) : record[keyPath as string]) as IDBValidKey;
}

/** Abort a transaction that has written nothing, then throw. */
function abortWith(tx: RawTx, error: Error): never {
  tx.done.catch(() => undefined);
  tx.abort();
  throw error;
}

/** Bump `meta.changeRev` inside `tx` and return the new value. */
async function bumpChangeRev(tx: RawTx): Promise<number> {
  const meta = tx.objectStore('meta');
  const row = (await meta.get('changeRev')) as MetaChangeRevRow | undefined;
  if (row !== undefined && (typeof row.value !== 'number' || !Number.isInteger(row.value) || row.value < 0)) {
    throw new Error(`meta.changeRev is not a count: ${JSON.stringify(row.value)}`);
  }
  const next = (row?.value ?? 0) + 1;
  await meta.put({ key: 'changeRev', value: next } satisfies MetaChangeRevRow);
  return next;
}

export function createStorageRepo(db: IDBPDatabase<OmniDbSchema>, opts: StorageRepoOptions = {}): StorageRepo {
  const raw = db as unknown as RawDb;
  const clock = opts.now ?? (() => new Date().toISOString());

  /** After commit only. A bus failure must not undo or hide a committed write. */
  async function announce(rev: number, store: StoreName, at: IsoTime): Promise<void> {
    if (!opts.bus) return;
    try {
      await opts.bus.publish({ rev, stores: [store], at });
    } catch {
      // A lost notice is not data loss: other surfaces compare changeRev on focus (D3 5.3).
    }
  }

  return {
    async get(store, key) {
      const value = (await raw.get(store, key as IDBValidKey)) as ValueOf<typeof store> | undefined;
      return value === undefined ? { found: false } : { found: true, value };
    },

    async list(store, query) {
      if (query) return (await raw.getAllFromIndex(store, query.index as string, query.value)) as never;
      return (await raw.getAll(store)) as never;
    },

    async listMany(stores) {
      const out: Record<string, unknown[]> = {};
      if (stores.length === 0) return out as never; // IndexedDB refuses a transaction over no stores.
      const tx = raw.transaction([...stores], 'readonly');
      for (const store of stores) out[store] = await tx.objectStore(store).getAll();
      await tx.done;
      return out as never;
    },

    async put(store, record, expectedRev) {
      const now = clock();
      const base = record as unknown as Row;
      // Validate before any transaction. rev and updatedAt are final or placeholders of equal validity.
      assertValidRecord(store, { ...base, rev: 1, updatedAt: now });

      const tx = raw.transaction([store, 'meta'], 'readwrite') as unknown as RawTx;
      const os = tx.objectStore(store);
      const key = keyOfRecord(store, base);
      const existing = (await os.get(key)) as Row | undefined;

      if (expectedRev === 'new') {
        if (existing !== undefined) abortWith(tx, new StaleWriteError(store, key));
      } else if (existing === undefined) {
        abortWith(tx, new StaleWriteError(store, key));
      }
      if (store === 'lineups' && existing !== undefined) {
        const stored = existing as unknown as LineupRecord;
        if (stored.kind === 'snapshot') abortWith(tx, new SnapshotImmutableError(stored.lineupId));
        if ((base as unknown as LineupRecord).kind !== stored.kind) {
          abortWith(tx, new InvalidRecordError(store, [{ path: '$.kind', message: 'a lineup cannot become a snapshot; create the snapshot instead' }]));
        }
      }
      if (existing !== undefined && existing.rev !== expectedRev) abortWith(tx, new StaleWriteError(store, key));

      const next: Row = { ...base, rev: existing === undefined ? 1 : (existing.rev as number) + 1, updatedAt: now };
      if (existing !== undefined && 'createdAt' in existing) next.createdAt = existing.createdAt;
      await os.put(next);
      const changeRev = await bumpChangeRev(tx);
      await tx.done;
      await announce(changeRev, store, now);
      return next as never;
    },

    async delete(store, key, expectedRev) {
      const now = clock();
      const tx = raw.transaction([store, 'meta'], 'readwrite') as unknown as RawTx;
      const os = tx.objectStore(store);
      const existing = (await os.get(key as IDBValidKey)) as Row | undefined;
      if (existing === undefined || existing.rev !== expectedRev) abortWith(tx, new StaleWriteError(store, key));
      await os.delete(key as IDBValidKey);
      const changeRev = await bumpChangeRev(tx);
      await tx.done;
      await announce(changeRev, store, now);
    },

    async putCache(store, record) {
      if (!CACHE_STORES.includes(store)) throw new RangeError(`putCache: ${store} is not a cache store`);
      assertValidRecord(store, record);
      const now = clock();
      const tx = raw.transaction([store, 'meta'], 'readwrite') as unknown as RawTx;
      await tx.objectStore(store).put(record);
      const changeRev = await bumpChangeRev(tx);
      await tx.done;
      await announce(changeRev, store, now);
    },
  };
}
