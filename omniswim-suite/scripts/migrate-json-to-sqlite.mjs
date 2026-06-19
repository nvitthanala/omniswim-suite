/**
 * Migrate data/meets.json → data/omniswim.db (SQLite).
 *
 * Usage:
 *   npx tsx scripts/migrate-json-to-sqlite.mjs            # migrate, keep JSON
 *   npx tsx scripts/migrate-json-to-sqlite.mjs --force    # overwrite existing DB
 *
 * Run with `npx tsx` (not plain node) so the `@omniswim/*` TS sources resolve.
 * After migration the server can read SQLite by setting OMNI_DB=sqlite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../packages/db/src/WorkspaceService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const MEETS_FILE = path.join(DATA_DIR, 'meets.json');
const DB_FILE = path.join(DATA_DIR, 'omniswim.db');

const force = process.argv.includes('--force');

function main() {
  if (!fs.existsSync(MEETS_FILE)) {
    console.error(`No meets.json found at ${MEETS_FILE}. Nothing to migrate.`);
    process.exit(1);
  }
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

main();
