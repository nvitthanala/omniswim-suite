/**
 * Seed the Ouachita Baptist University 2026-27 roster from a local data file.
 *
 * Parses oburoster202627.txt (multi-athlete SwimCloud paste), builds a
 * workspace named "OBU 2026-27 Roster", and upserts it into BOTH stores
 * (data/meets.json and data/omniswim.db) so it appears regardless of
 * OMNI_DB mode. Mirrors scripts/seed_hsu_roster.mjs.
 *
 * The source file lists 38 athletes, all with traditionally male first
 * names, matching a men's-team-only SwimCloud roster export — the same
 * shape as the HSU seed file. There is no women's-roster file yet, so this
 * script only imports Gender.MEN. OBU also sponsors a women's program
 * (packages/core/src/data/teamDivisions.ts); re-run this script with a
 * women's export and gender: Gender.WOMEN to add it.
 *
 * No scoring-theory file exists for OBU (unlike HSU's
 * possible_hsu_scoringteam2627.txt), so this seed does not mark scorers or
 * build a lineup — it only imports history + recruit rows. Class years are
 * left as whatever the parser defaults to; nothing here is guessed, per the
 * "never fabricate" rule in CLAUDE.md.
 *
 * Idempotent: re-running replaces the previously seeded workspace by name.
 *
 * Usage: npx tsx scripts/seed_obu_roster.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Gender } from '../packages/core/src/types.ts';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile.ts';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster.ts';
import { WorkspaceService } from '../packages/db/src/WorkspaceService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ROSTER_FILE = path.join(ROOT, 'oburoster202627.txt');
const MEETS_FILE = path.join(ROOT, 'data', 'meets.json');
const DB_FILE = path.join(ROOT, 'data', 'omniswim.db');

const TEAM = 'Ouachita Baptist University';
const WS_NAME = 'OBU 2026-27 Roster';
const DRY_RUN = process.argv.includes('--dry-run');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(ROSTER_FILE)) fail(`Missing ${ROSTER_FILE}`);

  // 1. Parse the multi-athlete roster paste.
  const rosterText = fs.readFileSync(ROSTER_FILE, 'utf-8');
  const parsed = parseSwimCloudMultiProfile(rosterText, { team: TEAM, gender: Gender.MEN });
  console.log(`Parsed ${parsed.athletes.length} athletes, ` +
    `${parsed.athletes.reduce((n, a) => n + a.swims.length, 0)} swims.`);
  for (const w of parsed.warnings) console.log(`  parse warning: ${w}`);

  // 2. Build a fresh workspace and import history + recruit rows.
  const workspace = {
    id: randomUUID(),
    name: WS_NAME,
    menResults: [],
    womenResults: [],
    recruits: [],
    createdAt: Date.now(),
    // OBU competes in the New South (NSISC) — same conference as HSU.
    conference: 'NSISC',
  };
  const allSwims = parsed.athletes.flatMap(a => a.swims);
  const importResult = importHistoryToRoster(workspace, allSwims, {
    team: TEAM,
    gender: Gender.MEN,
    sourceType: 'seed',
    sourceLabel: 'oburoster202627.txt seed',
  });
  if (importResult.noop) fail('Roster import produced no changes.');
  Object.assign(workspace, importResult.patch);
  console.log(`Import: ${importResult.summary.swimsMerged} swims merged, ` +
    `${importResult.summary.newRecruits} recruit rows, ` +
    `${importResult.summary.lineupEntriesAdded} lineup entries.`);

  // 3. Verification report.
  console.log('\n— Verification —');
  const plans = workspace.meetEntryPlans ?? [];
  const planless = parsed.athletes.filter(
    a => !plans.some(p => p.name === a.name) && !workspace.recruits.some(r => r.name === a.name)
  );
  console.log(`  athletes with roster presence: ${parsed.athletes.length - planless.length}/${parsed.athletes.length}` +
    (planless.length ? ` (missing: ${planless.map(a => a.name).join(', ')})` : ''));
  console.log(`  history swims retained: ${(workspace.athleteHistory ?? []).length}`);
  console.log(`  meet entry plans: ${plans.length}, recruits rows: ${workspace.recruits.length}`);

  if (DRY_RUN) {
    console.log('\nDry run — nothing written.');
    return;
  }

  // 4. Upsert into data/meets.json (by workspace name).
  const meets = fs.existsSync(MEETS_FILE)
    ? JSON.parse(fs.readFileSync(MEETS_FILE, 'utf-8'))
    : [];
  const jsonIdx = meets.findIndex(w => w.name === WS_NAME);
  if (jsonIdx >= 0) {
    workspace.id = meets[jsonIdx].id; // keep stable id on re-seed
    meets[jsonIdx] = workspace;
  } else {
    meets.push(workspace);
  }
  fs.writeFileSync(MEETS_FILE, JSON.stringify(meets, null, 2));
  console.log(`\nWrote workspace "${WS_NAME}" to data/meets.json (${meets.length} total).`);

  // 5. Upsert into SQLite.
  const service = new WorkspaceService(DB_FILE);
  try {
    const existing = service.listWorkspaces().find(w => w.name === WS_NAME);
    if (existing) {
      service.updateWorkspace(existing.id, { ...workspace, id: existing.id });
      console.log(`Updated workspace "${WS_NAME}" in data/omniswim.db.`);
    } else {
      service.createWorkspace(workspace);
      console.log(`Created workspace "${WS_NAME}" in data/omniswim.db.`);
    }
  } finally {
    service.close();
  }
}

main();
