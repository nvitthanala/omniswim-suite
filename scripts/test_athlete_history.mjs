import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import {
  buildHistoryFromWorkspace,
  categorizeBestEvents,
  detectSwimCloudPasteFormat,
  extractSwimmerNameFromPaste,
  mergeHistoryIndex,
  parseSwimCloudPaste,
  parseSwimCloudPasteDetailed,
} from '../packages/core/src/lib/athleteHistory.ts';
import { compareTimeToCutline } from '../packages/core/src/lib/cutlineUtils.ts';
import { divisionForTeam } from '../packages/core/src/data/teamDivisions.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { convertTimeToSeconds, convertToSCY } from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });

// Was: `history.length > 0` / `rosterPaste.length >= 1` /
// `merged.length >= history.slice(0, 100).length` / a positional, arbitrary
// `history[0]` primary-events check that could (and did, measured
// 2026-09-14) land on an athlete with ZERO qualifying swims in the sliced
// window, making `<= 3` trivially true either way
// (docs/reference/TEST_COVERAGE_AUDIT.md, "Weak": "the loose half proves
// little"). Hardened with exact pins against this real, committed data, and
// a real, specific, known athlete (Landon Dehn, a real Ouachita Baptist
// swimmer used elsewhere in this repo's tests) instead of an arbitrary
// positional pick.
const history = buildHistoryFromWorkspace(ws);
assert.equal(history.length, 646, 'history row count pinned to the committed NSISC data');

const rosterPaste = parseSwimCloudPaste(
  'Landon Dehn\t200 Freestyle\t1:56.47\nJane Doe\t100 Breaststroke\t1:05.00',
  'Ouachita Baptist University',
  Gender.MEN
);
assert.equal(rosterPaste.length, 2, 'roster paste parses exactly the 2 pasted rows');

const historySlice = history.slice(0, 100);
const merged = mergeHistoryIndex(historySlice, rosterPaste);
assert.equal(merged.length, historySlice.length + rosterPaste.length, 'merge adds exactly the 2 new pasted rows, no silent drop or duplication');

// Landon Dehn's pasted 200 Freestyle is guaranteed present in `merged`
// regardless of how the 100-row history slice above happened to land, so
// this profile check can assert a real, non-empty, exact result rather than
// an upper bound alone.
//
// His NSISC 50 Free (`Event 8 Men 50 Yard Freestyle`, 21.58) also sits in the
// 100-row slice. Until 2026-09-24 a HyTek label never reached a profile
// (plans/2026-09-22/01 P14 item a), so this check read only the pasted swim.
// The meet swim now ranks beside it, under the label it was recorded with.
const landonProfile = categorizeBestEvents(merged, 'Ouachita Baptist University', Gender.MEN, 'Landon Dehn', settings);
assert.deepEqual(
  [...landonProfile.primaryEvents].sort(),
  ['200 Freestyle', 'Event 8 Men 50 Yard Freestyle'],
  'Landon Dehn\'s primary events are the pasted 200 Free and his NSISC 50 Free'
);
assert.equal(landonProfile.bestByEvent['200 Freestyle']?.time, '1:56.47', 'best time for the primary event matches the pasted swim exactly');
assert.equal(
  landonProfile.bestByEvent['Event 8 Men 50 Yard Freestyle']?.time,
  '21.58',
  'the loaded-meet 50 Free ranks under its HyTek label'
);

const blaiseFixture = readFileSync(
  'tests/fixtures/swimcloud/blaise_vera_personal_bests.txt',
  'utf8'
);

assert.equal(detectSwimCloudPasteFormat(blaiseFixture), 'personal_bests', 'format detection');
assert.equal(extractSwimmerNameFromPaste(blaiseFixture), 'Blaise Vera', 'name extraction');

const blaiseResult = parseSwimCloudPasteDetailed(blaiseFixture, {
  team: 'University of Pittsburgh',
  gender: Gender.MEN,
  division: 'D1',
});
assert.equal(blaiseResult.swims.length, 15, `expected 15 swims, got ${blaiseResult.swims.length}`);

const fly50 = blaiseResult.swims.find(s => s.time === '20.65');
assert.equal(fly50?.swimcloudBadge, 'extracted', '50 fly X badge');

const free100b = blaiseResult.swims.find(s => s.time === '42.04');
assert.equal(free100b?.swimcloudBadge, 'd1_b', '100 free B badge');

const fly100 = blaiseResult.swims.find(s => s.time === '45.29');
assert.equal(fly100?.swimcloudBadge, 'd1_b', '100 fly D1-B badge');

const free200u = blaiseResult.swims.find(s => s.time === '1:40.38');
assert.equal(free200u?.swimcloudBadge, 'user_input', '200 free U badge');

const free50 = blaiseResult.swims.find(s => s.event === '50 Freestyle' && s.time === '19.03');
assert.equal(free50?.swimcloudBadge, 'd1_b', '50 free D1-B stamp');
assert.equal(free50?.computedCut, 'A', '50 free 19.03 computed A cut');

const lcmRow = blaiseResult.swims.find(s => s.time === '50.10');
assert.equal(lcmRow?.timeType, 'LCM', 'LCM timeType');
assert.ok(Boolean(lcmRow?.meetLabel?.includes('Pittsburgh')), 'empty badge col meet');

const cutCheck = compareTimeToCutline(
  convertTimeToSeconds(convertToSCY('19.03', '50 Freestyle', Gender.MEN, 'SCY')),
  Gender.MEN,
  '50 Freestyle',
  'D1'
);
assert.equal(cutCheck.achieved, 'A', 'cutline utils A for 19.03');

assert.equal(divisionForTeam('University of Pittsburgh'), 'D1', 'pitt D1');
assert.equal(divisionForTeam('Ouachita Baptist University'), 'D2', 'obu D2');

const empty = parseSwimCloudPasteDetailed('', { team: 'X', gender: Gender.MEN });
assert.ok(empty.swims.length === 0 && empty.warnings.length > 0, 'empty paste warning');

console.log('athlete history tests passed');
