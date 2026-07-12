/**
 * Eligibility toggle scoring test.
 *
 * Verifies that toggling a swimmer's stored event eligibility on/off flows
 * into `calculatePoints` exactly: toggling a high-time event off drops the
 * swimmer from the scoring pool for that event; toggling it on restores
 * the original scoring impact.
 *
 * Run: npx tsx scripts/test_eligibility_toggle.mjs
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omniswim-toggle-'));

const { __resetRosterCatalogForTests, buildRosterCatalog } = await import(
  '../apps/shell/lib/rosterCatalogRepo.ts'
);
__resetRosterCatalogForTests();
const repo = buildRosterCatalog({
  dbBackend: 'json',
  dataDir: tmpDir,
  dbFile: path.join(tmpDir, 'omniswim.db'),
  backupDir: path.join(tmpDir, 'backups'),
});
await repo.init();

const { buildStoredSwim } = await import(
  '../packages/core/src/lib/rosterCatalog.ts'
);
const {
  buildCategorizedScoringInputs,
  calculatePoints,
} = await import('../packages/core/src/lib/utils.ts');
const { mergeScoringSettings } = await import(
  '../packages/core/src/lib/scoringDefaults.ts'
);
const { Gender } = await import('../packages/core/src/types.ts');

let failures = 0;
function expect(label, ok, extra) {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${extra ? ` ΓÇö ${extra}` : ''}`);
    failures++;
  }
}

const settings = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  diverScorerWeight: 1,
  relayEligibleFromScorerPool: false,
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};

const mergedSettings = mergeScoringSettings(settings);

const team = await repo.upsertTeam({
  name: 'Test College',
  gender: 'Men',
  division: 'D2',
});

// Two swimmers, each with one event. Star has D1-A-cut time, Bench has D2-B-cut time.
const star = await repo.upsertAthlete({
  teamId: team.id,
  fullName: 'Star Swimmer',
  nameKey: 'star swimmer',
  classYear: 'SR',
  gender: 'Men',
});
// 50 Free men: D1 A-cut 19.39 (per the cutlines fixture); let's beat it just shy.
const starSwim = buildStoredSwim({
  athleteId: star.id,
  event: '50 Freestyle',
  timeText: '19.50',
  timeType: 'SCY',
  source: 'manual',
  gender: Gender.MEN,
});
await repo.upsertTime({
  athleteId: star.id,
  event: starSwim.event,
  timeText: starSwim.timeText,
  timeSeconds: starSwim.timeSeconds,
  timeSecondsScy: starSwim.timeSecondsScy,
  timeType: starSwim.timeType,
  source: starSwim.source,
  swimcloudBadge: starSwim.swimcloudBadge,
  computedCut: starSwim.computedCut,
  meetLabel: starSwim.meetLabel,
  swimDate: starSwim.swimDate,
  isEligible: true,
});

const bench = await repo.upsertAthlete({
  teamId: team.id,
  fullName: 'Bench Swimmer',
  nameKey: 'bench swimmer',
  classYear: 'FR',
  gender: 'Men',
});
const benchSwim = buildStoredSwim({
  athleteId: bench.id,
  event: '50 Freestyle',
  timeText: '22.20',
  timeType: 'SCY',
  source: 'manual',
  gender: Gender.MEN,
});
await repo.upsertTime({
  athleteId: bench.id,
  event: benchSwim.event,
  timeText: benchSwim.timeText,
  timeSeconds: benchSwim.timeSeconds,
  timeSecondsScy: benchSwim.timeSecondsScy,
  timeType: benchSwim.timeType,
  source: benchSwim.source,
  swimcloudBadge: benchSwim.swimcloudBadge,
  computedCut: benchSwim.computedCut,
  meetLabel: benchSwim.meetLabel,
  swimDate: benchSwim.swimDate,
  isEligible: true,
});

const roster1 = await repo.getRoster(team.id);
const inputs1 = buildCategorizedScoringInputs({
  workspace: {
    id: 't1',
    name: 'T1',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
  },
  gender: Gender.MEN,
  rosterCatalog: roster1,
});
const scored1 = calculatePoints(inputs1, mergedSettings, {
  resultsForPdfHint: inputs1,
});
const total1 = scored1.reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
expect(
  'Initial scoring produces non-zero team total',
  total1 > 0,
  `total=${total1}`
);

// Toggle Star Swimmer OFF.
const roster1Times = roster1.athletes.find(a => a.id === star.id).times;
const starTimeId = roster1Times[0].id;
await repo.toggleEligibility(starTimeId, false);
const roster2 = await repo.getRoster(team.id);
const inputs2 = buildCategorizedScoringInputs({
  workspace: {
    id: 't1',
    name: 'T1',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
  },
  gender: Gender.MEN,
  rosterCatalog: roster2,
});
const scored2 = calculatePoints(inputs2, mergedSettings, {
  resultsForPdfHint: inputs2,
});
const total2 = scored2.reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
expect(
  'Toggling Star OFF reduces team total',
  total2 < total1,
  `before=${total1} after=${total2}`
);

// Toggle Star back ON ΓÇö total restores.
await repo.toggleEligibility(starTimeId, true);
const roster3 = await repo.getRoster(team.id);
const inputs3 = buildCategorizedScoringInputs({
  workspace: {
    id: 't1',
    name: 'T1',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
  },
  gender: Gender.MEN,
  rosterCatalog: roster3,
});
const scored3 = calculatePoints(inputs3, mergedSettings, {
  resultsForPdfHint: inputs3,
});
const total3 = scored3.reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
expect(
  'Toggling Star ON restores original total',
  Math.abs(total3 - total1) < 0.001,
  `before=${total1} after=${total3}`
);

// Toggle BOTH off ΓÇö should reduce (or zero) the team.
await repo.toggleEligibility(starTimeId, false);
const roster12 = await repo.getRoster(team.id);
const benchTimeId = roster12.athletes.find(a => a.id === bench.id).times[0].id;
await repo.toggleEligibility(benchTimeId, false);
const roster4 = await repo.getRoster(team.id);
const inputs4 = buildCategorizedScoringInputs({
  workspace: {
    id: 't1',
    name: 'T1',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
  },
  gender: Gender.MEN,
  rosterCatalog: roster4,
});
const scored4 = calculatePoints(inputs4, mergedSettings, {
  resultsForPdfHint: inputs4,
});
const total4 = scored4.reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
expect(
  'Toggling both swimmers off zeroes total',
  total4 === 0,
  `total4=${total4}`
);

await fsp.rm(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} eligibility_toggle assertion(s) failed.`);
  process.exit(1);
}

console.log('\nALL eligibility_toggle assertions passed.');
process.exit(0);
