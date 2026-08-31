/**
 * Report-only run: project an NSISC scoring lineup for the "OBU 2026-27
 * Roster" workspace (seeded by scripts/seed_obu_roster.mjs) using the
 * existing roster optimizer. No meet is loaded for this workspace, so the
 * optimizer scores off real personal-best times via the what-if projection
 * path — the same mechanism the app uses for a coach's own unplayed roster.
 *
 * Read-only: does not write data/meets.json or data/omniswim.db. Prints the
 * projected team total and the per-event lineup the optimizer picked.
 *
 * Usage: npx tsx scripts/run_obu_scoring.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeRosterForTeam } from '../packages/core/src/lib/rosterOptimizer.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { Gender } from '../packages/core/src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MEETS_FILE = path.join(ROOT, 'data', 'meets.json');

const TEAM = 'Ouachita Baptist University';
const WS_NAME = 'OBU 2026-27 Roster';

const meets = JSON.parse(fs.readFileSync(MEETS_FILE, 'utf-8'));
const ws = meets.find(w => w.name === WS_NAME);
if (!ws) {
  console.error(`ERROR: workspace "${WS_NAME}" not found in data/meets.json. Run scripts/seed_obu_roster.mjs first.`);
  process.exit(1);
}

const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
const result = optimizeRosterForTeam(ws, Gender.MEN, TEAM, false, settings, 'all');

console.log(`Workspace: ${WS_NAME}`);
console.log(`Team: ${TEAM} (NSISC scoring settings)`);
console.log(`Outcome: ${result.outcome} (stages applied: ${result.appliedStages})`);
console.log(`Previous projected total: ${result.previousTotal.toFixed(1)}`);
console.log(`Optimized projected total: ${result.projectedTotal.toFixed(1)}`);
console.log(`Scorer overrides: ${result.overrides.length}`);

// The optimizer's winning stage was scorer selection, not explicit lineup
// entries — this workspace uses "roster mode" (usesScorerRoster), where
// per-swimmer scoring is computed live from athleteHistory best times, not
// from static meetEntryPlans rows. Run the same what-if projection the app
// uses, with the optimizer's chosen scorer flags applied, to get the actual
// scored rows (event, time, points) rather than just a team total.
// `buildWhatIfResults` projects the rows; it does NOT score them — every row
// comes back with points 0. Reporting its output directly printed an empty
// lineup under a non-zero team total, which reads as "no lineup found" rather
// than "this script forgot to score". Run the same `calculatePoints` the
// optimizer scored with, through the same merge, so the printed lineup and the
// printed total come from one computation.
const scoredWs = { ...ws, scorerRosterOverrides: result.overrides };
const projected = buildWhatIfResults({ workspace: scoredWs, gender: Gender.MEN, removeSeniors: false });
const scored = calculatePoints(projected, settings, {
  scorerRosterOverrides: result.overrides,
  conferenceForMerge: ws.conference,
  resultsForPdfHint: [...(ws.menResults ?? []), ...(ws.womenResults ?? [])],
});
const scoring = scored.filter(r => (r.points ?? 0) > 0);
const teamSum = scoring
  .filter(r => r.team === TEAM)
  .reduce((sum, r) => sum + (r.points ?? 0), 0);
console.log(`Scored rows with points > 0: ${scoring.length} (team-total check: ${teamSum.toFixed(1)})`);

const byEvent = new Map();
for (const r of scoring.filter(r => r.team === TEAM)) {
  const list = byEvent.get(r.event) ?? [];
  list.push(r);
  byEvent.set(r.event, list);
}
console.log('\n— Projected scoring lineup (by event, points > 0) —');
for (const [event, rows] of [...byEvent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${event}:`);
  for (const r of rows.sort((a, b) => (b.points ?? 0) - (a.points ?? 0))) {
    console.log(`    ${r.name} — ${r.time ?? 'no time'} — ${r.points} pts (rank ${r.rank ?? '?'})`);
  }
}
