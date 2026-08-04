/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Multi-profile SwimCloud paste + SCY remap + class-year override tests.
 */
import assert from 'node:assert/strict';
import {
  detectSwimCloudPasteFormat,
  parseSwimCloudPasteDetailed,
  isChampionshipProgramEvent,
} from '../packages/core/src/lib/athleteHistory.ts';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile.ts';
import { convertSwimToSCY, foldDiacritics, normalizeSwimmerName } from '../packages/core/src/lib/utils.ts';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster.ts';
import { ClassYear, Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';

const TEAM = 'Henderson State University';
const HDR = 'Event\tTime\t\tMeet\tDate\tStamp Link';

// Synthetic 3-athlete paste: diacritic names, an embedded header row per block,
// an SCM-only swimmer, distance-metric events, and junk events.
const PASTE = [
  'Máté Hosszú',
  HDR,
  '50 Free SCY\t20.50\tX\tMeet A\tFeb 1, 2026\t',
  '100 Free SCY\t45.00\t\tMeet A\tFeb 1, 2026\t',
  '400 Free LCM\t4:00.00\t\tMeet B\tJul 1, 2025\t',
  '1500 Free LCM\t16:00.00\t\tMeet B\tJul 1, 2025\t',
  '25 Free SCY\t10.00\t\tMeet A\tFeb 1, 2026\t',
  '100 IM SCY\t52.00\t\tMeet A\tFeb 1, 2026\t',
  '',
  'Olivér Pózvai',
  HDR,
  '50 Free SCM\t23.00\t\tMeet C\tMar 1, 2026\t',
  '100 Back SCM\t58.00\t\tMeet C\tMar 1, 2026\t',
  '',
  'Benedek BONA',
  HDR,
  '200 Free SCY\t1:40.00\t\tMeet A\tFeb 1, 2026\t',
].join('\n');

// --- detection ---
{
  assert.equal(detectSwimCloudPasteFormat(PASTE), 'multi_profile');
  // Single-swimmer paste still detects as personal_bests (no regression).
  const single = ['Solo Swimmer', HDR, '50 Free SCY\t21.00\t\tMeet\tFeb 1, 2026\t'].join('\n');
  assert.equal(detectSwimCloudPasteFormat(single), 'personal_bests');
}

// --- block split incl. embedded header + diacritic names ---
{
  const res = parseSwimCloudMultiProfile(PASTE, { team: TEAM, gender: Gender.MEN });
  assert.equal(res.athletes.length, 3);
  assert.deepEqual(
    res.athletes.map(a => a.name),
    ['Máté Hosszú', 'Olivér Pózvai', 'Benedek BONA']
  );
  const mate = res.athletes[0];
  // 6 rows parsed, header skipped (not counted as a swim).
  assert.equal(mate.swims.length, 6);
  assert.ok(!mate.swims.some(s => /event/i.test(s.event)), 'header row must not become a swim');
  // Original event labels/times/timeType retained (non-destructive).
  const orig400 = mate.swims.find(s => s.event === '400 Freestyle');
  assert.ok(orig400 && orig400.time === '4:00.00' && orig400.timeType === 'LCM');
}

// --- routing through parseSwimCloudPasteDetailed ---
{
  const detailed = parseSwimCloudPasteDetailed(PASTE, { team: TEAM, gender: Gender.MEN });
  assert.equal(detailed.format, 'multi_profile');
  assert.equal(detailed.swims.length, 9); // 6 + 2 + 1
  assert.ok(detailed.warnings.some(w => /3 athlete/.test(w)));
}

// --- convertSwimToSCY distance remap ---
{
  assert.equal(convertSwimToSCY('400 Freestyle', '4:00.00', Gender.MEN, 'LCM').event, '500 Freestyle');
  assert.equal(convertSwimToSCY('800 Freestyle', '8:00.00', Gender.MEN, 'LCM').event, '1000 Freestyle');
  assert.equal(convertSwimToSCY('1500 Freestyle', '16:00.00', Gender.MEN, 'LCM').event, '1650 Freestyle');
  assert.equal(convertSwimToSCY('1500 Freestyle', '16:00.00', Gender.WOMEN, 'SCM').event, '1650 Freestyle');
  // Non-distance events keep their label.
  assert.equal(convertSwimToSCY('100 Backstroke', '58.00', Gender.MEN, 'SCM').event, '100 Backstroke');
  // SCY passthrough unchanged.
  const scy = convertSwimToSCY('200 Freestyle', '1:40.00', Gender.MEN, 'SCY');
  assert.deepEqual(scy, { event: '200 Freestyle', time: '1:40.00' });
  // Relay labels never remapped.
  assert.equal(convertSwimToSCY('400 Freestyle Relay', '3:00.00', Gender.MEN, 'LCM').event, '400 Freestyle Relay');
}

// --- program-event filter ---
{
  assert.ok(isChampionshipProgramEvent('500 Freestyle'));
  assert.ok(isChampionshipProgramEvent('200 IM'));
  assert.ok(isChampionshipProgramEvent('400 Medley Relay'));
  assert.ok(!isChampionshipProgramEvent('25 Freestyle'));
  assert.ok(!isChampionshipProgramEvent('100 Individual Medley'));
  assert.ok(!isChampionshipProgramEvent('400 Freestyle')); // metric distance, not an SCY program event
  assert.ok(!isChampionshipProgramEvent('1 mtr Diving'));
}

function baseWorkspace() {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
  };
}

// --- import: SCM conversion, junk exclusion, distance remap, class-year override ---
{
  const parsed = parseSwimCloudMultiProfile(PASTE, { team: TEAM, gender: Gender.MEN });
  const preview = parsed.athletes.flatMap(a => a.swims);

  const result = importHistoryToRoster(baseWorkspace(), preview, {
    team: TEAM,
    gender: Gender.MEN,
    // diacritic-insensitive key (ascii) must still match "Máté Hosszú".
    classYearOverrides: { 'mate hosszu': ClassYear.SR },
  });
  assert.equal(result.noop, false);
  const recruits = result.patch.recruits ?? [];

  const mateRecruits = recruits.filter(
    r => normalizeSwimmerName(r.name) === normalizeSwimmerName('Máté Hosszú')
  );
  assert.ok(mateRecruits.length > 0, 'Máté should have recruit entries');
  // Class-year override applied to Máté.
  assert.ok(mateRecruits.every(r => r.classYear === ClassYear.SR), 'override → SR');
  // Distance remap: 400 Free LCM became a 500 Freestyle candidate; no phantom 400/1500.
  assert.ok(mateRecruits.some(r => r.event === '500 Freestyle'), '400 LCM → 500 Free slot');
  assert.ok(!mateRecruits.some(r => r.event === '400 Freestyle'), 'no phantom 400 Free');
  assert.ok(!mateRecruits.some(r => r.event === '1500 Freestyle'), 'no phantom 1500 Free');
  // Junk events never selected as lineup entries.
  assert.ok(!recruits.some(r => r.event === '25 Freestyle'));
  assert.ok(!recruits.some(r => r.event === '100 Individual Medley'));

  // Other swimmers keep their parsed default class year (HS), not the override.
  const beniRecruits = recruits.filter(
    r => normalizeSwimmerName(r.name) === normalizeSwimmerName('Benedek BONA')
  );
  assert.ok(beniRecruits.length > 0);
  assert.ok(beniRecruits.every(r => r.classYear === ClassYear.HS), 'no override → default HS');

  // SCM-only swimmer produces SCY-converted candidates (time differs from raw SCM).
  const oliver = recruits.filter(
    r => normalizeSwimmerName(r.name) === normalizeSwimmerName('Olivér Pózvai')
  );
  assert.ok(oliver.length > 0);
  const oliver50 = oliver.find(r => r.event === '50 Freestyle');
  assert.ok(oliver50 && oliver50.timeType === 'SCY');
  assert.ok(oliver50.time !== '23.00', 'SCM time converted to SCY');
}

// --- foldDiacritics helper ---
{
  assert.equal(foldDiacritics('Máté Hosszú'), 'Mate Hosszu');
  assert.equal(foldDiacritics('Olivér Pózvai'), 'Oliver Pozvai');
}

// --- warnings: name with zero rows, rows before any name ---
{
  const junk = ['Ghost Name', '', 'Real Person', HDR, '50 Free SCY\t21.00\t\tM\tFeb 1, 2026\t'].join('\n');
  const res = parseSwimCloudMultiProfile(junk, { team: TEAM, gender: Gender.MEN });
  assert.equal(res.athletes.length, 1);
  assert.ok(res.warnings.some(w => /Ghost Name/.test(w)));

  const orphan = ['50 Free SCY\t21.00\t\tM\tFeb 1, 2026\t', 'Real Person', HDR, '100 Free SCY\t46.00\t\tM\tFeb 1, 2026\t'].join('\n');
  const res2 = parseSwimCloudMultiProfile(orphan, { team: TEAM, gender: Gender.MEN });
  assert.ok(res2.warnings.some(w => /before any swimmer name/i.test(w)));
  assert.equal(res2.athletes.length, 1);
}

console.log('multi-profile import tests passed');
