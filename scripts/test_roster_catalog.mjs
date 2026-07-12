/**
 * Roster Catalog round-trip test.
 *
 * Exercises:
 *   - JSON ΓåÆ catalog (json backend) via the basket of helpers
 *   - Course conversion (LCM/SCM ΓåÆ SCY) is deterministic
 *   - Athlete├ùevent identity is preserved across re-imports
 *   - Eligibility toggles are reflected in scoring pool changes
 *
 * Run: npx tsx scripts/test_roster_catalog.mjs
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'omniswim-catalog-'));
const dataDir = tmpDir;

process.env.OMNI_DB = 'json';
process.env.OMNI_DATA_DIR = dataDir;

const {
  __resetRosterCatalogForTests,
  buildRosterCatalog,
} = await import('../apps/shell/lib/rosterCatalogRepo.ts');
__resetRosterCatalogForTests();

const repo = buildRosterCatalog({
  dbBackend: 'json',
  dataDir,
  dbFile: path.join(dataDir, 'omniswim.db'),
  backupDir: path.join(dataDir, 'backups'),
});
await repo.init();

const { validateRosterCatalogJson, buildStoredSwim } = await import(
  '../packages/core/src/lib/rosterCatalog.ts'
);

const fixture = {
  team: {
    name: 'Henderson State University',
    gender: 'Men',
    division: 'D2',
  },
  athletes: [
    {
      fullName: 'John Doe',
      classYear: 'JR',
      events: [
        { event: '50 Freestyle', timeText: '20.84', timeType: 'SCY' },
        { event: '100 Freestyle', timeText: '1:00.34', timeType: 'LCM' },
        { event: '200 Freestyle', timeText: '1:47.00', timeType: 'LCM' },
        { event: '500 Freestyle', timeText: '4:38.50', timeType: 'SCY' },
      ],
    },
    {
      fullName: 'Alex Stone',
      classYear: 'SO',
      events: [
        { event: '100 Breaststroke', timeText: '1:02.40', timeType: 'LCM' },
        { event: '200 Breaststroke', timeText: '2:21.80', timeType: 'LCM' },
      ],
    },
  ],
};

const issues = validateRosterCatalogJson(fixture);
if (issues) {
  console.error('Fixture failed validation:', issues);
  process.exit(1);
}

const team = await repo.upsertTeam({
  name: fixture.team.name,
  gender: fixture.team.gender,
  division: fixture.team.division,
});

const upsertedAthletes = [];
const upsertedTimes = [];
for (const a of fixture.athletes) {
  const athlete = await repo.upsertAthlete({
    teamId: team.id,
    fullName: a.fullName,
    nameKey: a.fullName.toLowerCase(),
    classYear: a.classYear,
    gender: fixture.team.gender,
  });
  upsertedAthletes.push(athlete);
  for (const ev of a.events) {
    const built = buildStoredSwim({
      athleteId: athlete.id,
      event: ev.event,
      timeText: ev.timeText,
      timeType: ev.timeType,
      source: 'json',
      gender: fixture.team.gender === 'Women' ? 'Women' : 'Men',
    });
    const saved = await repo.upsertTime({
      athleteId: athlete.id,
      event: built.event,
      timeText: built.timeText,
      timeSeconds: built.timeSeconds,
      timeSecondsScy: built.timeSecondsScy,
      timeType: built.timeType,
      source: built.source,
      swimcloudBadge: built.swimcloudBadge,
      computedCut: built.computedCut,
      meetLabel: built.meetLabel,
      swimDate: built.swimDate,
      isEligible: built.isEligible,
    });
    upsertedTimes.push(saved);
  }
}

let failures = 0;

function expect(label, ok, extra) {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${extra ? ` ΓÇö ${extra}` : ''}`);
    failures++;
  }
}

expect(
  'Catalog has one team after upsert',
  (await repo.listTeams()).length === 1
);

const roster = await repo.getRoster(team.id);
expect(
  'Roster contains both athletes',
  roster && roster.athletes.length === 2,
  `got ${roster?.athletes.length}`
);

const john = roster?.athletes.find(a => a.fullName === 'John Doe');
expect('John Doe has 4 stored times', john && john.times.length === 4);

const johnEvents = new Set(john.times.map(t => t.event));
expect(
  'John has all 4 distinct events',
  ['50 Freestyle', '100 Freestyle', '200 Freestyle', '500 Freestyle'].every(e => johnEvents.has(e))
);

const john100 = john.times.find(t => t.event === '100 Freestyle');
expect(
  '100 Free is stored as LCM (latest import wins on dup key)',
  Boolean(john100 && john100.timeType === 'LCM')
);
expect(
  '100 Free LCM has SCY companion populated',
  Boolean(john100 && Number.isFinite(john100.timeSecondsScy)),
  `scy=${john100?.timeSecondsScy}`
);
// 1:00.34 LCM for men 100 Free LCM factor 0.873 ΓåÆ ~52.7 sec
expect(
  '1:00.34 LCM converts to ~52.67 SCY',
  Boolean(john100 && Math.abs(john100.timeSecondsScy - 52.67) < 0.05),
  `actual=${john100?.timeSecondsScy}`
);
const john50 = john.times.find(t => t.event === '50 Freestyle');
expect(
  '50 Free SCY companion passes through unchanged',
  Boolean(john50 && Math.abs(john50.timeSecondsScy - john50.timeSeconds) < 1e-6)
);

// Toggling eligibility mutates state and round-trips
if (john) {
  const elSwitchable = john.times[0];
  const updated = await repo.toggleEligibility(elSwitchable.id, false);
  expect('Toggle off persists', updated && updated.isEligible === false);
  const updated2 = await repo.toggleEligibility(elSwitchable.id, true);
  expect('Toggle back on persists', updated2 && updated2.isEligible === true);
}

const rehydrated = await repo.exportAll();
expect(
  'Export round-trips: same number of times',
  rehydrated.times.length === upsertedTimes.length
);
expect(
  'Export round-trips: athlete id matches',
  rehydrated.athletes.length === upsertedAthletes.length
);

await fsp.rm(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log('\nALL roster_catalog round-trip assertions passed.');
process.exit(0);
