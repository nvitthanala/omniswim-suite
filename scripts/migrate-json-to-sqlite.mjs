/**
 * Migrate <data dir>/meets.json → <data dir>/omniswim.db (SQLite).
 *
 * The data dir is the repo's `data/` folder unless `OMNI_DATA_DIR` is set
 * (same resolution as apps/shell/server.ts). The resolved paths are printed
 * before anything is written.
 *
 * Refuses to run while a server answers on http://127.0.0.1:${PORT||OMNI_PORT||3000}
 * (see scripts/lib/dataDir.mjs). `--force` skips that check AND overwrites an
 * existing DB, so use it only when no server holds the store.
 *
 * Usage:
 *   npx tsx scripts/migrate-json-to-sqlite.mjs            # migrate, keep JSON
 *   npx tsx scripts/migrate-json-to-sqlite.mjs --force    # overwrite existing DB
 *   OMNI_DATA_DIR=/tmp/copy npx tsx scripts/migrate-json-to-sqlite.mjs   # throwaway dir
 *
 * Run with `npx tsx` (not plain node) so the `@omniswim/*` TS sources resolve.
 * After migration the server can read SQLite by setting OMNI_DB=sqlite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir, assertNoServerHoldsStore } from './lib/dataDir.mjs';
import { WorkspaceService } from '../packages/db/src/WorkspaceService.ts';

const DATA_DIR = resolveDataDir();
const MEETS_FILE = path.join(DATA_DIR, 'meets.json');
const DB_FILE = path.join(DATA_DIR, 'omniswim.db');

const force = process.argv.includes('--force');

async function main() {
  console.log(`Target data dir: ${DATA_DIR}`);
  console.log(`  meets.json: ${MEETS_FILE}`);
  console.log(`  sqlite:     ${DB_FILE}`);
  if (!fs.existsSync(MEETS_FILE)) {
    console.error(`No meets.json found at ${MEETS_FILE}. Nothing to migrate.`);
    process.exit(1);
  }
  await assertNoServerHoldsStore({
    force,
    what: DATA_DIR,
    fail: msg => {
      console.error(`ERROR: ${msg}`);
      process.exit(1);
    },
  });
  if (fs.existsSync(DB_FILE) && !force) {
    console.error(`Database already exists at ${DB_FILE}. Re-run with --force to overwrite.`);
    process.exit(1);
  }
  if (fs.existsSync(DB_FILE) && force) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${DB_FILE}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  const workspaces = JSON.parse(fs.readFileSync(MEETS_FILE, 'utf-8'));
  if (!Array.isArray(workspaces)) {
    console.error('meets.json is not an array of workspaces.');
    process.exit(1);
  }

  const service = new WorkspaceService(DB_FILE);
  service.replaceAll(workspaces);

  const roundTrip = service.exportAll();
  service.close();

  console.log(`Migrated ${workspaces.length} workspace(s) → ${DB_FILE}`);
  console.log(`Round-trip read back ${roundTrip.length} workspace(s).`);

  if (roundTrip.length !== workspaces.length) {
    console.error('WARNING: workspace count mismatch after round-trip!');
    process.exit(2);
  }
  console.log('Round-trip count OK. JSON file left intact as a backup.');
}

await main();
