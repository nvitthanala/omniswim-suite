/**
 * Migrate data/meets.json → PostgreSQL (DATABASE_URL required).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-json-to-postgres.mjs
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-json-to-postgres.mjs --force
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgWorkspaceService } from '../packages/db/src/PgWorkspaceService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const MEETS_FILE = path.join(PROJECT_ROOT, 'data', 'meets.json');
const force = process.argv.includes('--force');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  if (!fs.existsSync(MEETS_FILE)) {
    console.error(`No meets.json at ${MEETS_FILE}`);
    process.exit(1);
  }

  const workspaces = JSON.parse(fs.readFileSync(MEETS_FILE, 'utf-8'));
  if (!Array.isArray(workspaces)) {
    console.error('meets.json is not an array.');
    process.exit(1);
  }

  const service = new PgWorkspaceService({ connectionString });
  await service.init();
  const existing = await service.count();
  if (existing > 0 && !force) {
    console.error(`Postgres already has ${existing} workspace(s). Re-run with --force.`);
    await service.close();
    process.exit(1);
  }
  if (force && existing > 0) {
    await service.replaceAll([]);
  }

  await service.replaceAll(workspaces);
  const roundTrip = await service.exportAll();
  await service.close();

  console.log(`Migrated ${workspaces.length} workspace(s) to PostgreSQL.`);
  console.log(`Round-trip read back ${roundTrip.length} workspace(s).`);
  if (roundTrip.length !== workspaces.length) process.exit(2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
