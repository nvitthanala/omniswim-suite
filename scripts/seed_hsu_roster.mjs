/**
 * Seed the HSU 2026-27 roster plan from local data files.
 *
 * Parses hsuroster26-27.txt (multi-athlete SwimCloud paste) and
 * possible_hsu_scoringteam2627.txt (scoring theory), builds a workspace named
 * "HSU 2026-27 Roster Plan", and upserts it into BOTH stores (data/meets.json
 * and data/omniswim.db) so it appears regardless of OMNI_DB mode.
 *
 * Idempotent: re-running replaces the previously seeded workspace by name.
 * Requires the two txt files at repo root (they are local-only, not committed).
 *
 * Usage: npx tsx scripts/seed_hsu_roster.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Gender, ClassYear } from '../packages/core/src/types.ts';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile.ts';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster.ts';
import { parseScoringTheory, applyScoringTheory } from '../packages/core/src/lib/scoringTheory.ts';
import { convertSwimToSCY } from '../packages/core/src/lib/utils.ts';
import { WorkspaceService } from '../packages/db/src/WorkspaceService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ROSTER_FILE = path.join(ROOT, 'hsuroster26-27.txt');
const THEORY_FILE = path.join(ROOT, 'possible_hsu_scoringteam2627.txt');
const MEETS_FILE = path.join(ROOT, 'data', 'meets.json');
const DB_FILE = path.join(ROOT, 'data', 'omniswim.db');

const TEAM = 'Henderson State University';
const WS_NAME = 'HSU 2026-27 Roster Plan';
const DRY_RUN = process.argv.includes('--dry-run');

const CLASS_YEAR_OVERRIDES = {
  'Alex Tarkovács': ClassYear.FR,
  'River Paulk': ClassYear.JR,
  'Máté Hosszú': ClassYear.FR,
  'Noel Kis': ClassYear.FR,
  'Benedek BONA': ClassYear.FR,
  'Fabio Capocci': ClassYear.FR,
  'Curtis Malone': ClassYear.FR,
};

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(ROSTER_FILE)) fail(`Missing ${ROSTER_FILE}`);
  if (!fs.existsSync(THEORY_FILE)) fail(`Missing ${THEORY_FILE}`);

  // 1. Parse the multi-athlete roster paste.
  const rosterText = fs.readFileSync(ROSTER_FILE, 'utf-8');
  const parsed = parseSwimCloudMultiProfile(rosterText, { team: TEAM, gender: Gender.MEN });
  console.log(`Parsed ${parsed.athletes.length} athletes, ` +
    `${parsed.athletes.reduce((n, a) => n + a.swims.length, 0)} swims.`);
  for (const w of parsed.warnings) console.log(`  parse warning: ${w}`);

  // 2. Build a fresh workspace and import all swims (history + recruits + lineup).
  const workspace = {
    id: randomUUID(),
    name: WS_NAME,
    menResults: [],
    womenResults: [],
    recruits: [],
    createdAt: Date.now(),
    // HSU competes in the New South (NSISC); enables roster-mode scorer marking.
    conference: 'NSISC',
  };
  const allSwims = parsed.athletes.flatMap(a => a.swims);
  const importResult = importHistoryToRoster(workspace, allSwims, {
    team: TEAM,
    gender: Gender.MEN,
    sourceType: 'seed',
    sourceLabel: 'hsuroster26-27.txt seed',
    classYearOverrides: CLASS_YEAR_OVERRIDES,
  });
  if (importResult.noop) fail('Roster import produced no changes.');
  Object.assign(workspace, importResult.patch);
  console.log(`Import: ${importResult.summary.swimsMerged} swims merged, ` +
    `${importResult.summary.newRecruits} recruit rows, ` +
    `${importResult.summary.lineupEntriesAdded} lineup entries.`);

  // 3. Parse + apply the scoring theory.
  const theory = parseScoringTheory(fs.readFileSync(THEORY_FILE, 'utf-8'));
  for (const w of theory.warnings) console.log(`  theory parse warning: ${w}`);
  const applied = applyScoringTheory(workspace, theory, {
    team: TEAM,
    gender: Gender.MEN,
    classYearOverrides: CLASS_YEAR_OVERRIDES,
  });
  Object.assign(workspace, applied.patch);
  console.log(`Theory: ${applied.summary.scorersMarked} scorers, ` +
    `${applied.summary.entriesAdded} entries, ` +
    `${applied.summary.relayLegsAssigned} relay legs.`);
  for (const w of applied.warnings) console.log(`  theory apply warning: ${w}`);
  for (const s of applied.summary.resolvedSwimmers) {
    if (!s.matched) console.log(`  UNRESOLVED theory name: ${s.rawName}`);
  }

  // 4. Verification report.
  console.log('\n— Verification —');
  const recruitYears = new Map();
  for (const r of workspace.recruits) {
    if (!recruitYears.has(r.name)) recruitYears.set(r.name, r.classYear);
  }
  for (const [name, expected] of Object.entries(CLASS_YEAR_OVERRIDES)) {
    const actual = recruitYears.get(name);
    const ok = actual === expected;
    console.log(`  class year ${name}: ${actual ?? 'MISSING'} (expected ${expected}) ${ok ? 'OK' : 'MISMATCH'}`);
  }
  const nonTarget = [...recruitYears.entries()].filter(
    ([n]) => !(n in CLASS_YEAR_OVERRIDES)
  );
  const nonHs = nonTarget.filter(([, y]) => y !== ClassYear.HS);
  console.log(`  other swimmers: ${nonTarget.length} untouched by overrides` +
    (nonHs.length ? ` (WARNING: ${nonHs.length} not default)` : ''));

  // Conversion spot checks: SCM/LCM-only Europeans must have SCY-event entries.
  const spotChecks = [
    ['Benedek BONA', '400 Freestyle LCM 3:58.84', '500 Freestyle', convertSwimToSCY('400 Freestyle', '3:58.84', Gender.MEN, 'LCM')],
    ['Noel Kis', '50 Freestyle SCM 22.10', '50 Freestyle', convertSwimToSCY('50 Freestyle', '22.10', Gender.MEN, 'SCM')],
    ['Fabio Capocci', '100 Backstroke SCM 54.44', '100 Backstroke', convertSwimToSCY('100 Backstroke', '54.44', Gender.MEN, 'SCM')],
  ];
  for (const [who, src, expectEvent, conv] of spotChecks) {
    const ok = conv.event === expectEvent;
    console.log(`  convert ${who} ${src} → ${conv.event} ${conv.time} ${ok ? 'OK' : 'MISMATCH'}`);
  }
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

  // 5. Upsert into data/meets.json (by workspace name).
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

  // 6. Upsert into SQLite.
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
