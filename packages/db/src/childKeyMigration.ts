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
 * Both are gated on the table's real key, not on `meta.schema_version`: an unstamped
 * or half-stamped file is handled, and a second call is a no-op. Neither swallows an
 * error. A rebuild that fails rolls back and throws, and the caller does not stamp
 * the new version, so a retry starts from the old, intact table.
 *
 * Nothing reads the child tables' `id` column (reads select `data` by `workspace_id`),
 * so no read path changes.
 */
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

/**
 * Rebuild every id-keyed child table that is still keyed on `id` alone. Returns the
 * names it rebuilt (empty when the file is already on the v9 key). Throws, with the
 * transaction rolled back, if any step fails or a copy loses a row.
 */
export function migrateSqliteChildKeys(db: DatabaseSync): string[] {
  if (!ID_KEYED_CHILD_TABLES.some(t => sqliteKeyedOnIdAlone(db, t.table))) return [];
  const rebuilt: string[] = [];
  // IMMEDIATE: take the write lock first, so a second process opening the same file
  // waits and then finds nothing left to do (re-checked per table below).
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
