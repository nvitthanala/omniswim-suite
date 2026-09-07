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
  splitMultiProfileBlocks,
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

// --- three-line profile headers: hometown + club must not become athletes -----
// Regression for the OBU 2026-27 export, where a `name / hometown / club` header
// split one swimmer into two or three blocks and filed real swims under a club.
// Every header line below is copied verbatim from `oburoster202627.txt`.
{
  const CHROME = ['PERSONAL BESTS', 'EVENT PROGRESSION', 'Course', 'Season', 'Sort by'];
  const paste = [
    'Mikhail Lymar',
    'Volgograd, RUS',            // 3-letter country code, not a 2-letter US state
    'Bison Aquatic Club',        // club line shaped exactly like a person name
    'Mikhail Lymar on Instagram', // social-handle line, also name-shaped
    ...CHROME,
    HDR,
    '50 Free SCY\t22.77\tX\tNT LAC Fall Classic\tNov 9, 2025\t',
    '100 Free SCY\t49.46\t\tNT COR Senior CUP\tMar 2, 2025\t',
    '',
    'Owen Green',
    'Benton, AR',
    'Arkansas Dolphins',         // no club keyword at all — only structure catches it
    ...CHROME,
    HDR,
    '500 Free SCY\t4:39.75\t\tSpeedo Sectionals\tMar 6, 2026\t',
    '',
    'Stefan DUCA-MIRCEA',
    'HUN',                       // hometown reduced to a bare country code
    'Ouachita Baptist University',
    ...CHROME,
    HDR,
    '100 Breast SCY\t1:03.21\t\tNT COR Classic\tDec 1, 2023\t',
  ].join('\n');

  const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });
  assert.deepEqual(
    res.athletes.map(a => a.name),
    ['Mikhail Lymar', 'Owen Green', 'Stefan DUCA-MIRCEA'],
    'three real athletes, no club/hometown/social phantoms'
  );
  assert.deepEqual(res.athletes.map(a => a.swims.length), [2, 1, 1], 'swims land on their own swimmer');
  assert.deepEqual(
    res.warnings.filter(w => /No swims parsed/.test(w)),
    [],
    'no zero-swim phantom blocks'
  );
  assert.equal(detectSwimCloudPasteFormat(paste), 'multi_profile', 'detector agrees with the parser');

  // Splitter contract: nothing is invented and nothing vanishes.
  const { blocks, orphanLines } = splitMultiProfileBlocks(paste);
  assert.equal(blocks.length, 3);
  assert.deepEqual(orphanLines, []);
  assert.deepEqual(blocks[1].absorbed, ['Arkansas Dolphins'], 'mascot club recorded, not dropped');
  assert.ok(blocks.every(b => b.hasDataRow));
}

// --- true positives: the new exclusions must not swallow a real name ---------
{
  for (const name of [
    'Tyler Bell',
    'Stefan DUCA-MIRCEA',
    'Máté Hosszú',
    'Ruben Rivera Ayala',
    'Alan Alejan Gonzalez Mujica',
    'Coi Call',
    'Owen McCall',
    'Sparky Sparks',
  ]) {
    const paste = [name, HDR, '50 Free SCY\t21.00\t\tMeet\tFeb 1, 2026\t'].join('\n');
    const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });
    assert.deepEqual(res.athletes.map(a => a.name), [name], `"${name}" is still a name line`);
    assert.equal(res.athletes[0].swims.length, 1, `"${name}" keeps his swim`);
  }
}

// --- a diver is absent, not empty -------------------------------------------
// Carson Powers on the OBU roster has five diving SCORES and zero times. A diving
// score is not a competition time; it must never be imported as one, and his
// absence must stay loud rather than reading as a parse failure.
{
  const paste = [
    'Carson Powers',
    'Oviedo, FL',
    'Ouachita Baptist University',
    'PERSONAL BESTS',
    HDR,
    '1 M Diving 6 Dives\t469.55\t\tOBU vs.DSU\tNov 8, 2025\t',
    '3 M Diving 11 Dives\t484.05\t\tNew South Championships\tFeb 23, 2024\t',
  ].join('\n');

  const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });
  assert.equal(res.athletes.length, 0, 'a diver yields no swims');
  assert.ok(
    res.warnings.some(w => /No swims parsed for "Carson Powers"/.test(w)),
    'and says so out loud'
  );
  assert.ok(!JSON.stringify(res.athletes).includes('469.55'), 'diving score never becomes a time');
}

console.log('multi-profile import tests passed');
