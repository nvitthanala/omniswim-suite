/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Opens the OmniSwim database (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.1, 5.3 and 5.5).
 *
 * idb's `openDB` calls the global `indexedDB`, so a test cannot hand it a fresh `IDBFactory`.
 * This file wraps `factory.open(...)` with idb's `wrap` and adds the same three listeners
 * (`upgradeneeded`, `blocked`, `versionchange`) by hand.
 *
 * Two traps it handles:
 * - An async upgrade that rejects does not abort the versionchange transaction by itself, because
 *   nobody awaits that promise. The chain runs as one promise; on rejection this file aborts the
 *   transaction and rethrows the migration's own error.
 * - `meta.db` is written after the chain with `now` and `newId` from the caller, so a migration
 *   stays pure and a test gets a stable dump.
 */
import { wrap } from 'idb';
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import { DatabaseInconsistentError, NewerDatabaseError } from './errors';
import { assertMigrationChain, MIGRATIONS } from './migrations';
import type { Migration } from './migrations';
import { DB_NAME, DB_VERSION } from './schema';
import type { IsoTime, MetaDbRow, OmniDbSchema } from './schema';

export interface OpenOmniDbOptions {
  /** Defaults to the global `indexedDB`. A test passes `new IDBFactory()` from fake-indexeddb. */
  readonly factory?: IDBFactory;
  /** Defaults to `MIGRATIONS`. Steps above `version` are ignored. */
  readonly migrations?: readonly Migration[];
  /** Defaults to `DB_VERSION`. */
  readonly version?: number;
  /** Another tab wants to upgrade. This connection is already closed when this runs. */
  readonly onVersionChange?: () => void;
  /** This open waits for other tabs to close their connections (show "close other OmniSwim tabs"). */
  readonly onBlocked?: () => void;
  /** The clock for `meta.db`. Defaults to `new Date().toISOString()`. */
  readonly now?: () => IsoTime;
  /** The id source for `meta.db.installId`. Defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
}

export async function openOmniDb(opts: OpenOmniDbOptions = {}): Promise<IDBPDatabase<OmniDbSchema>> {
  const factory = opts.factory ?? indexedDB;
  const version = opts.version ?? DB_VERSION;
  const migrations = (opts.migrations ?? MIGRATIONS).filter(m => m.to <= version);
  assertMigrationChain(migrations, version);
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => crypto.randomUUID());

  const request = factory.open(DB_NAME, version);
  const openPromise = wrap(request);
  let migrationFailure: { readonly error: unknown } | undefined;
  // Settles when the migration chain (and its failure handling) is done. Opening does not wait for it by itself.
  let chainDone: Promise<void> = Promise.resolve();

  request.addEventListener('upgradeneeded', event => {
    const nativeTx = request.transaction;
    if (!nativeTx) throw new Error('openOmniDb: upgradeneeded without a transaction');
    const db = wrap(request.result) as unknown as IDBPDatabase<unknown>;
    const tx = wrap(nativeTx) as unknown as IDBPTransaction<unknown, string[], 'versionchange'>;
    // idb makes `tx.done` when it wraps a transaction. An abort rejects it, and nobody else reads it.
    tx.done.catch(() => undefined);
    const oldVersion = event.oldVersion;
    const newVersion = event.newVersion ?? version;
    const run = async (): Promise<void> => {
      for (const m of migrations) {
        if (m.to > oldVersion && m.to <= newVersion) await m.up(db, tx);
      }
      const meta = tx.objectStore('meta');
      const existing = (await meta.get('db')) as MetaDbRow | undefined;
      const at = now();
      const entry = { from: oldVersion, to: newVersion, at };
      const row: MetaDbRow = existing
        ? { ...existing, schemaVersion: newVersion, migrationLog: [...existing.migrationLog, entry] }
        : { key: 'db', schemaVersion: newVersion, createdAt: at, installId: newId(), migrationLog: [entry] };
      await meta.put(row);
    };
    chainDone = run().catch((error: unknown) => {
      migrationFailure = { error };
      try {
        nativeTx.abort();
      } catch {
        // The transaction already finished or aborted. The failure is kept in `migrationFailure`.
      }
    });
  });

  request.addEventListener('blocked', () => opts.onBlocked?.());

  let db: IDBPDatabase<OmniDbSchema>;
  try {
    db = (await openPromise) as unknown as IDBPDatabase<OmniDbSchema>;
  } catch (error) {
    if (migrationFailure) throw migrationFailure.error;
    if (error instanceof Error && error.name === 'VersionError') throw new NewerDatabaseError();
    throw error;
  }
  // A step that awaits something other than IndexedDB can let the upgrade transaction finish early. The open then
  // succeeds at the new version with a half-built schema, so wait for the chain before trusting the database.
  await chainDone;
  if (migrationFailure) {
    db.close();
    throw migrationFailure.error;
  }
  await requireConsistentMeta(db);
  db.addEventListener('versionchange', () => {
    db.close();
    opts.onVersionChange?.();
  });
  return db;
}

/**
 * `meta.db.schemaVersion` must equal the database version. A mismatch means an upgrade did not finish. The
 * database is never repaired or deleted (D3 5.5), so every later open fails the same way.
 */
async function requireConsistentMeta(db: IDBPDatabase<OmniDbSchema>): Promise<void> {
  let row: MetaDbRow | undefined;
  try {
    row = (await db.get('meta', 'db')) as MetaDbRow | undefined;
  } catch (error) {
    db.close();
    throw new DatabaseInconsistentError(`The meta.db row cannot be read at version ${db.version}: ${String(error)}`);
  }
  if (row === undefined || row.schemaVersion !== db.version) {
    db.close();
    throw new DatabaseInconsistentError(
      `meta.db.schemaVersion is ${row === undefined ? 'missing' : String(row.schemaVersion)} but the database is at version ${db.version}. An upgrade did not finish.`
    );
  }
}
