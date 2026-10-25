/**
 * Schema v9: key the id-keyed child tables on `(workspace_id, id)`.
 *
 * Until v9 each of these tables declared `id TEXT PRIMARY KEY`, so a row id had to
 * be unique across the whole store. A row id is only meaningful inside its workspace
 * (the parser and the UI mint them per workspace, and a copy of a workspace carries
 * the same ids). Creating a copy while the original existed hit the store-wide key
 * and returned a 500.
 *
 * Neither database can alter a primary key in place. SQLite rebuilds the table
 * (create, copy, drop, rename) in one transaction. PostgreSQL drops the old key and
 * adds the new one in one transaction under an advisory lock.
 *
 * SQLite writes a `VACUUM INTO` copy of the file first and refuses to run without one.
 * PostgreSQL makes NO automatic dump: take a `pg_dump` before upgrading (README, "Back up
 * and restore"). Both are gated on the table's real key, not on `meta.schema_version`: an unstamped
 * or half-stamped file is handled, and a second call is a no-op. Neither swallows an
 * error. A rebuild that fails rolls back and throws, and the caller does not stamp
 * the new version, so a retry starts from the old, intact table.
 *
 * Nothing reads the child tables' `id` column (reads select `data` by `workspace_id`),
 * so no read path changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** The six tables whose rows carry an `id`. `gender` is true where the table has that column. */
export const ID_KEYED_CHILD_TABLES = [
  { table: 'meet_results', gender: true },
  { table: 'source_meet_results', gender: true },
  { table: 'psych_results', gender: true },
  { table: 'recruits', gender: false },
  { table: 'meet_entry_plans', gender: false },
  { table: 'athlete_aliases', gender: false },
] as const;

type PkColumn = { name: string; pk: number };

/** True when `table` exists and its primary key is the single column `id`. */
function sqliteKeyedOnIdAlone(db: DatabaseSync, table: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as PkColumn[];
  const keyed = cols.filter(c => Number(c.pk) > 0);
  return keyed.length === 1 && keyed[0]?.name === 'id';
}

function sqliteCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

/** `code` on the error thrown when a v8 file holds rows the v9 key cannot carry. */
export const CHILD_KEY_MIGRATION_BLOCKED_CODE = 'CHILD_KEY_MIGRATION_BLOCKED';
/** `code` on the error thrown when the pre-migration copy cannot be written. */
export const CHILD_KEY_MIGRATION_BACKUP_FAILED_CODE = 'CHILD_KEY_MIGRATION_BACKUP_FAILED';

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Find rows the rebuild would have to drop or could not copy, WITHOUT changing anything:
 * rows whose workspace no longer exists (`PRAGMA foreign_key_check`, which the new table's
 * foreign key would refuse), and rows with a NULL id (the v8 key allowed one; v9 forbids it).
 * Returns one entry per problem, naming the table, the count and up to 5 workspace ids.
 */
function sqliteBlockers(db: DatabaseSync, tables: readonly string[]): string[] {
  const problems: string[] = [];
  const idList = (rows: Array<{ workspace_id: string }>) => rows.map(r => JSON.stringify(r.workspace_id)).join(', ');
  for (const table of tables) {
    const orphans = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
    if (orphans.length > 0) {
      const ids = db
        .prepare(
          `SELECT DISTINCT workspace_id FROM ${table}
            WHERE workspace_id NOT IN (SELECT id FROM workspaces) ORDER BY workspace_id LIMIT 5`
        )
        .all() as Array<{ workspace_id: string }>;
      problems.push(
        `${table}: ${orphans.length} row(s) belong to a workspace that does not exist ` +
          `(workspace_id: ${idList(ids)}). ` +
          `Delete them with: DELETE FROM ${table} WHERE workspace_id NOT IN (SELECT id FROM workspaces)`
      );
    }
    const nulls = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id IS NULL`).get() as { n: number }).n
    );
    if (nulls > 0) {
      const ids = db
        .prepare(`SELECT DISTINCT workspace_id FROM ${table} WHERE id IS NULL ORDER BY workspace_id LIMIT 5`)
        .all() as Array<{ workspace_id: string }>;
      problems.push(
        `${table}: ${nulls} row(s) have a NULL id (workspace_id: ${idList(ids)}). ` +
          `Delete them with: DELETE FROM ${table} WHERE id IS NULL`
      );
    }
  }
  return problems;
}

/** `<dir>/<name>-pre-v9-<UTC stamp>[-n]<ext>` beside the database file; never an existing file. */
function preMigrationCopyPath(dbFile: string, now: Date): string {
  const ext = path.extname(dbFile);
  const stem = path.basename(dbFile, ext);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = path.join(path.dirname(dbFile), `${stem}-pre-v9-${stamp}`);
  let candidate = `${base}${ext}`;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}${ext}`;
  return candidate;
}

export interface SqliteChildKeyMigrationOptions {
  /** Where to write the pre-migration copy. Default: beside the database file. Tests use it. */
  readonly backupPath?: string;
  /** Clock for the copy's name. Default: now. */
  readonly now?: Date;
}

/**
 * Rebuild every id-keyed child table that is still keyed on `id` alone. Returns the
 * names it rebuilt (empty when the file is already on the v9 key).
 *
 * Order, and why:
 *  1. Refuse, changing nothing, if a row cannot be carried (orphan or NULL id). Rows are
 *     never dropped silently.
 *  2. Write a `VACUUM INTO` copy of the whole database beside it, outside any transaction.
 *     If that cannot be written the migration stops: a migration with no way back is not run.
 *     An in-memory database has no file and gets no copy.
 *  3. Rebuild in one `BEGIN IMMEDIATE` transaction with a row-count check per table. A
 *     failure rolls back and throws, and the caller does not stamp the new version.
 */
export function migrateSqliteChildKeys(
  db: DatabaseSync,
  options: SqliteChildKeyMigrationOptions = {}
): string[] {
  const pending = ID_KEYED_CHILD_TABLES.filter(t => sqliteKeyedOnIdAlone(db, t.table));
  if (pending.length === 0) return [];

  const problems = sqliteBlockers(
    db,
    pending.map(t => t.table)
  );
  if (problems.length > 0) {
    throw codedError(
      CHILD_KEY_MIGRATION_BLOCKED_CODE,
      `Schema v9 migration refused. No rows were changed or dropped.\n  ${problems.join('\n  ')}\n` +
        `Restore a backup from data/backups, or delete the rows named above by hand, then start again.`
    );
  }

  const main = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(
    r => r.name === 'main'
  );
  const dbFile = main?.file ?? '';
  const copy =
    options.backupPath ?? (dbFile === '' ? null : preMigrationCopyPath(dbFile, options.now ?? new Date()));
  if (copy !== null) {
    try {
      db.prepare('VACUUM INTO ?').run(copy);
      if (!fs.existsSync(copy)) throw new Error('the copy was not created');
    } catch (err) {
      try {
        fs.rmSync(copy, { force: true });
      } catch {
        /* nothing useful to add */
      }
      throw codedError(
        CHILD_KEY_MIGRATION_BACKUP_FAILED_CODE,
        `Schema v9 migration needs a backup copy of the database first, and could not write ${copy}: ` +
          `${err instanceof Error ? err.message : String(err)}. Nothing was changed. ` +
          `Free disk space or fix the folder permissions, then start again.`
      );
    }
  }

  const rebuilt: string[] = [];
  // IMMEDIATE takes the write lock first. node:sqlite sets no busy timeout, so a second
  // process holding or opening the same file gets SQLITE_BUSY at once; the constructor
  // closes the handle and throws, and the server exits through `decideSqliteStartupFailure`.
  // The per-table re-check below covers a file another process migrated after the check above.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { table, gender } of ID_KEYED_CHILD_TABLES) {
      if (!sqliteKeyedOnIdAlone(db, table)) continue;
      const next = `${table}__v9`;
      const cols = gender
        ? 'id, workspace_id, gender, position, data'
        : 'id, workspace_id, position, data';
      db.exec(`DROP TABLE IF EXISTS ${next}`);
      db.exec(`CREATE TABLE ${next} (
  id           TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
${gender ? '  gender       TEXT NOT NULL,\n' : ''}  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
)`);
      db.exec(`INSERT INTO ${next}(${cols}) SELECT ${cols} FROM ${table}`);
      const before = sqliteCount(db, table);
      const after = sqliteCount(db, next);
      if (before !== after) {
        throw new Error(
          `Schema v9 migration: copying ${table} kept ${after} of ${before} rows. Nothing was changed.`
        );
      }
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${next} RENAME TO ${table}`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_ws ON ${table}(workspace_id)`);
      rebuilt.push(table);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rebuilt;
}

/** The slice of a `pg` client this migration uses. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Same contract as {@link migrateSqliteChildKeys}, for PostgreSQL. */
export async function migratePgChildKeys(client: PgQueryable): Promise<string[]> {
  const rebuilt: string[] = [];
  await client.query('BEGIN');
  try {
    // Held to the end of this transaction: a second `init` waits here, then finds the new key.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('omniswim_child_key_v9'))");
    for (const { table } of ID_KEYED_CHILD_TABLES) {
      const res = await client.query(
        `SELECT c.conname AS name, array_length(c.conkey, 1) AS width
           FROM pg_constraint c
          WHERE c.conrelid = to_regclass($1) AND c.contype = 'p'`,
        [table]
      );
      const key = res.rows[0];
      if (!key || Number(key.width) !== 1) continue;
      if (rebuilt.length === 0) {
        console.warn(
          'Schema v9: re-keying the PostgreSQL child tables to (workspace_id, id). ' +
            'This is one transaction and keeps every row, but nothing here makes a dump. ' +
            'Take a pg_dump BEFORE upgrading a database you cannot afford to lose.'
        );
      }
      const name = String(key.name).replace(/"/g, '""');
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${name}"`);
      await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (workspace_id, id)`);
      rebuilt.push(table);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return rebuilt;
}
