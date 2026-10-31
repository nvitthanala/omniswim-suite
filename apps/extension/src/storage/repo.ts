/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The storage repository (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.3).
 *
 * - Read-modify-write runs in one readwrite transaction that awaits only IndexedDB promises.
 * - `put` and `delete` are optimistic: a stale `rev` throws `StaleWriteError` and writes nothing.
 * - Every write transaction bumps `meta.changeRev`. The bus publishes after `tx.done`.
 * - A rev is never reused for a key. The invariant: `meta.changeRev` is at least every rev ever written or deleted.
 *   A row written in a transaction gets `rev = max(previous changeRev + 1, stored rev + 1)`. The transaction then commits
 *   `changeRev = max(previous changeRev + 1, every rev it wrote, the stored rev of every row it deleted)`. For rows written by this code the
 *   max is the plain +1. It matters for a row an older build wrote with a rev above `changeRev` (or with no `changeRev` at all): deleting it
 *   lifts `changeRev` to its rev, so a re-created row starts above it. A holder of an old rev can never match the new row.
 * - A snapshot lineup rejects any `put` after create.
 * - Records are validated before they are written (validate.ts). A missing cap, a `legacy`
 *   provenance and an empty cache row never reach IndexedDB.
 * - `{found:false}` stays distinct from a found record. `list` never invents a row.
 *
 * Only extension pages and the service worker may use this (D3 decision 0.2).
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { ChangeRevMovedError, InvalidRecordError, SnapshotImmutableError, StaleWriteError } from './errors';
import { readChangeRev } from './changeBus';
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

export { StaleWriteError, ChangeRevMovedError, NewerDatabaseError, InvalidRecordError, SnapshotImmutableError } from './errors';
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
  /**
   * Apply puts and deletes, across stores, in ONE readwrite transaction (D6 section 3). Every `expectedRev` is checked inside the
   * transaction. All or nothing: if any op is stale or invalid, nothing is written, and the error is the first op's. One `meta.changeRev`
   * bump and one notice cover the whole batch. Ops run in order. Two ops on one key are refused (the second would see the first's rev).
   * Returns one entry per op: the stored record for a put, `undefined` for a delete.
   * `expectedChangeRev` is a precondition on the whole database: read `changeRev()` before you read the inputs, pass it here, and the batch
   * writes nothing (`ChangeRevMovedError`) if ANY write has committed since, in any store.
   */
  putMany(ops: readonly PutManyOp[], options?: PutManyOptions): Promise<(ValueOf<EditedStore> | undefined)[]>;
  /** The current `meta.changeRev`: it grows by one on every committed write. 0 before the first write. */
  changeRev(): Promise<number>;
  /** A fetched-data cache row. No `rev`: a later fetch replaces the row. */
  putCache<S extends CacheStore>(store: S, record: ValueOf<S>): Promise<void>;
  /**
   * Delete every row of the given cache stores in ONE readwrite transaction. Returns the number of rows deleted. User stores are refused.
   * When it deleted at least one row it bumps `meta.changeRev` and announces the stores; with nothing to delete it writes nothing and announces nothing.
   */
  clearCache(stores: readonly CacheStore[]): Promise<number>;
}

export interface PutManyOptions {
  /** The `meta.changeRev` the caller read. A different value at the start of the transaction aborts the batch. */
  readonly expectedChangeRev?: number;
}

/**
 * One op of `putMany`: the same arguments as `put` and `delete`. A put with `expectedRev: 'new'` also means "the row must be absent": it aborts
 * the batch with `StaleWriteError` if a row exists under that key. That is the check an undo of a delete needs (a deleted row leaves no rev).
 */
export type PutManyOp = {
  [S in EditedStore]:
    | { readonly op: 'put'; readonly store: S; readonly record: Omit<ValueOf<S>, 'rev' | 'updatedAt'>; readonly expectedRev: Rev | 'new' }
    | { readonly op: 'delete'; readonly store: S; readonly key: KeyOf<S>; readonly expectedRev: Rev };
}[EditedStore];

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

/** The stored `meta.changeRev` inside `tx`; 0 when absent. */
async function currentChangeRev(tx: RawTx): Promise<number> {
  const row = (await tx.objectStore('meta').get('changeRev')) as MetaChangeRevRow | undefined;
  if (row !== undefined && (typeof row.value !== 'number' || !Number.isInteger(row.value) || row.value < 0)) {
    throw new Error(`meta.changeRev is not a count: ${JSON.stringify(row.value)}`);
  }
  return row?.value ?? 0;
}

/**
 * Commit `meta.changeRev` inside `tx` and return it: `max(stored + 1, atLeast)`. `atLeast` is the highest rev this transaction wrote or deleted,
 * so `changeRev` stays at or above every rev ever used (see the header). Pass nothing when no row with a rev was touched.
 */
async function bumpChangeRev(tx: RawTx, atLeast = 0): Promise<number> {
  const next = Math.max((await currentChangeRev(tx)) + 1, atLeast);
  await tx.objectStore('meta').put({ key: 'changeRev', value: next } satisfies MetaChangeRevRow);
  return next;
}

/**
 * The checks and the write of one `put`, inside `tx`. Aborts `tx` and throws on a stale rev or a snapshot edit.
 * `writeRev` is the `changeRev` this transaction commits. The row's rev is `max(writeRev, stored rev + 1)`: never 1 again for a re-created key.
 */
async function applyPut(tx: RawTx, store: StoreName, base: Row, expectedRev: Rev | 'new', now: IsoTime, writeRev: number): Promise<Row> {
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

  const next: Row = { ...base, rev: Math.max(writeRev, existing === undefined ? 1 : (existing.rev as number) + 1), updatedAt: now };
  if (existing !== undefined && 'createdAt' in existing) next.createdAt = existing.createdAt;
  await os.put(next);
  return next;
}

/** The checks and the write of one `delete`, inside `tx`. Returns the rev of the row it deleted: the caller lifts `changeRev` to at least that. */
async function applyDelete(tx: RawTx, store: StoreName, key: IDBValidKey, expectedRev: Rev): Promise<number> {
  const os = tx.objectStore(store);
  const existing = (await os.get(key)) as Row | undefined;
  if (existing === undefined || existing.rev !== expectedRev) abortWith(tx, new StaleWriteError(store, key));
  await os.delete(key);
  return existing.rev as number;
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
      // The row's rev comes from the changeRev this transaction will commit. A stale rev aborts `tx`, which discards everything.
      const next = await applyPut(tx, store, base, expectedRev, now, (await currentChangeRev(tx)) + 1);
      const changeRev = await bumpChangeRev(tx, next.rev as number);
      await tx.done;
      await announce(changeRev, store, now);
      return next as never;
    },

    async delete(store, key, expectedRev) {
      const now = clock();
      const tx = raw.transaction([store, 'meta'], 'readwrite') as unknown as RawTx;
      const deletedRev = await applyDelete(tx, store, key as IDBValidKey, expectedRev);
      const changeRev = await bumpChangeRev(tx, deletedRev);
      await tx.done;
      await announce(changeRev, store, now);
    },

    changeRev: () => readChangeRev(db),

    async putMany(ops, options = {}) {
      if (ops.length === 0) return [];
      const now = clock();
      const seen = new Set<string>();
      for (const op of ops) {
        if (op.op === 'put') assertValidRecord(op.store, { ...(op.record as unknown as Row), rev: 1, updatedAt: now });
        const key = op.op === 'put' ? keyOfRecord(op.store, op.record as unknown as Row) : (op.key as IDBValidKey);
        const id = JSON.stringify([op.store, key]);
        if (seen.has(id)) throw new RangeError(`putMany: two ops on one key (${id})`);
        seen.add(id);
      }
      const stores = [...new Set(ops.map((op) => op.store as StoreName))];
      const tx = raw.transaction([...stores, 'meta'], 'readwrite') as unknown as RawTx;
      const out: (ValueOf<EditedStore> | undefined)[] = [];
      let changeRev: number;
      try {
        if (options.expectedChangeRev !== undefined) {
          const row = (await tx.objectStore('meta').get('changeRev')) as MetaChangeRevRow | undefined;
          const actual = row?.value ?? 0;
          if (actual !== options.expectedChangeRev) abortWith(tx, new ChangeRevMovedError(options.expectedChangeRev, actual));
        }
        const writeRev = (await currentChangeRev(tx)) + 1;
        let highest = 0;
        for (const op of ops) {
          if (op.op === 'put') {
            const stored = await applyPut(tx, op.store, op.record as unknown as Row, op.expectedRev, now, writeRev);
            highest = Math.max(highest, stored.rev as number);
            out.push(stored as never);
          } else {
            highest = Math.max(highest, await applyDelete(tx, op.store, op.key as IDBValidKey, op.expectedRev));
            out.push(undefined);
          }
        }
        changeRev = await bumpChangeRev(tx, highest);
      } catch (cause) {
        // A stale rev already aborted `tx`. Any other throw must abort it too, or the ops written so far would commit.
        try { tx.abort(); } catch { /* already aborted */ }
        tx.done.catch(() => undefined);
        throw cause;
      }
      await tx.done;
      if (opts.bus) {
        try { await opts.bus.publish({ rev: changeRev, stores, at: now }); } catch { /* a lost notice is not data loss */ }
      }
      return out;
    },

    async clearCache(stores) {
      for (const store of stores) if (!CACHE_STORES.includes(store)) throw new RangeError(`clearCache: ${store} is not a cache store`);
      const unique = [...new Set(stores)];
      if (unique.length === 0) return 0;
      const now = clock();
      const tx = raw.transaction([...unique, 'meta'], 'readwrite') as unknown as RawTx;
      let deleted = 0;
      let changeRev: number | undefined;
      try {
        for (const store of unique) {
          const os = tx.objectStore(store);
          deleted += await os.count();
          await os.clear();
        }
        if (deleted > 0) changeRev = await bumpChangeRev(tx);
      } catch (cause) {
        try { tx.abort(); } catch { /* already aborted */ }
        tx.done.catch(() => undefined);
        throw cause;
      }
      await tx.done;
      if (changeRev !== undefined && opts.bus) {
        try { await opts.bus.publish({ rev: changeRev, stores: unique, at: now }); } catch { /* a lost notice is not data loss */ }
      }
      return deleted;
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
