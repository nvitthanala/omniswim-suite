/**
 * Persistence parity test — SQLite vs PostgreSQL.
 * Run: npx tsx scripts/test_persistence_parity.mjs
 *
 * The two WorkspaceService implementations share `workspacePersistence.ts` for
 * assembly but hand-write their own SQL. Nothing forces the two SQL bodies to
 * stay in step, so a child table or workspace column added on one side can be
 * silently dropped on the other — data loss that no typecheck catches.
 *
 * This asserts, from the real source, that both services and both schemas cover
 * every entry in CHILD_TABLES and every column in workspaceRowValues(). It needs
 * no database, so it runs everywhere `npm test` runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { CHILD_TABLES, workspaceRowValues } from '../packages/db/src/workspacePersistence.ts';
import { CREATE_TABLES_SQL } from '../packages/db/src/schema.ts';
import { CREATE_PG_TABLES_SQL } from '../packages/db/src/pgSchema.ts';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(scriptsDir, '..', 'packages', 'db', 'src');

/** Every column the shared row-builder emits; the INSERTs must carry all of them. */
const WORKSPACE_COLUMNS = Object.keys(
  workspaceRowValues({ id: 'x', name: 'n', createdAt: 0 }, 0)
);

const read = f => fs.readFileSync(path.join(srcDir, f), 'utf8');

/** Pull the column list out of `INSERT INTO workspaces (a, b, c)`. */
function insertColumns(src) {
  const m = src.match(/INSERT INTO workspaces\s*\(([^)]*)\)/);
  assert.ok(m, 'no INSERT INTO workspaces found');
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Pull the `VALUES (...)` list that follows the workspaces INSERT. */
function insertPlaceholders(src) {
  const m = src.match(/INSERT INTO workspaces\s*\([^)]*\)\s*VALUES\s*\(([^)]*)\)/);
  assert.ok(m, 'no VALUES clause found for workspaces INSERT');
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Pull the quoted table names out of the `for (const table of [...])` delete sweep. */
function deleteSweepTables(src) {
  const m = src.match(/for \(const table of \[([\s\S]*?)\]\)/);
  assert.ok(m, 'no delete-sweep table list found');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function checkService(label, file) {
  const src = read(file);

  // 1. Workspace-level columns: every key from workspaceRowValues must be written.
  const cols = insertColumns(src);
  for (const col of WORKSPACE_COLUMNS) {
    assert.ok(cols.includes(col), `${label}: workspaces INSERT is missing column '${col}'`);
    assert.ok(
      src.includes(`vals.${col}`),
      `${label}: workspaces INSERT never passes vals.${col}`
    );
  }

  // 2. Placeholder count must match the column count (catches an unshifted $N list).
  const placeholders = insertPlaceholders(src);
  assert.strictEqual(
    placeholders.length,
    cols.length,
    `${label}: ${cols.length} columns but ${placeholders.length} placeholders`
  );

  // 3. Upsert must refresh every mutable column, or an edit silently keeps the old value.
  const upsert = src.slice(src.indexOf('DO UPDATE SET'));
  for (const col of WORKSPACE_COLUMNS) {
    if (col === 'id') continue;
    assert.ok(
      new RegExp(`\\b${col}\\s*=`).test(upsert),
      `${label}: DO UPDATE SET never refreshes '${col}'`
    );
  }

  // 4. Child tables: cleared before rewrite, and written back. The write is either
  // a literal `INSERT INTO <table>(` or a prepared-statement helper taking the
  // table name — SQLite uses both idioms, Postgres only the first.
  const swept = deleteSweepTables(src);
  for (const table of CHILD_TABLES) {
    assert.ok(swept.includes(table), `${label}: delete sweep is missing '${table}'`);
    assert.ok(
      new RegExp(`INSERT INTO ${table}\\(|\\('${table}'\\)`).test(src),
      `${label}: nothing writes to ${table} — rows would be deleted and never restored`
    );
  }
}

function checkSchema(label, sql) {
  for (const table of CHILD_TABLES) {
    assert.ok(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(sql),
      `${label}: no CREATE TABLE for '${table}'`
    );
  }
  // The workspaces table must declare every column, either inline or via an ALTER
  // migration for databases created before the column existed.
  const workspacesDdl = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS workspaces')
  );
  for (const col of WORKSPACE_COLUMNS) {
    assert.ok(
      new RegExp(`\\b${col}\\b`).test(workspacesDdl),
      `${label}: workspaces schema is missing column '${col}'`
    );
  }
}

try {
  checkService('SQLite', 'WorkspaceService.ts');
  checkService('Postgres', 'PgWorkspaceService.ts');

  // The Postgres read path names its child tables explicitly; SQLite hands
  // `childData` straight to assembleWorkspace, so only Postgres can drift here.
  const pgSrc = read('PgWorkspaceService.ts');
  const readList = pgSrc.match(/const tables = \[([\s\S]*?)\] as const/);
  assert.ok(readList, 'Postgres: no read-path table list found');
  const readTables = [...readList[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  for (const table of CHILD_TABLES) {
    assert.ok(
      readTables.includes(table),
      `Postgres: read path omits '${table}' — saved rows would never load back`
    );
  }

  checkSchema('SQLite', CREATE_TABLES_SQL);
  checkSchema('Postgres', CREATE_PG_TABLES_SQL);

  console.log(
    `Persistence parity test PASSED (${CHILD_TABLES.length} child tables, ${WORKSPACE_COLUMNS.length} workspace columns)`
  );
} catch (err) {
  console.error('Persistence parity test FAILED:', err.message);
  process.exit(1);
}
