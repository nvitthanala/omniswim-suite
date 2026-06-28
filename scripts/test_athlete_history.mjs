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

const history = buildHistoryFromWorkspace(ws);
console.assert(history.length > 0, 'history from PDF');

const rosterPaste = parseSwimCloudPaste(
  'Landon Dehn\t200 Freestyle\t1:56.47\nJane Doe\t100 Breaststroke\t1:05.00',
  'Ouachita Baptist University',
  Gender.MEN
);
console.assert(Array.isArray(rosterPaste) && rosterPaste.length >= 1, 'roster paste parser');

const merged = mergeHistoryIndex(history.slice(0, 100), rosterPaste);
console.assert(merged.length >= history.slice(0, 100).length, 'merge keeps rows');

if (history[0]) {
  const h = history[0];
  const profile = categorizeBestEvents(merged, h.team, h.gender, h.name, settings);
  console.assert(profile.primaryEvents.length <= 3, 'primary events capped');
}

const blaiseFixture = readFileSync(
  'tests/fixtures/swimcloud/blaise_vera_personal_bests.txt',
  'utf8'
);

console.assert(detectSwimCloudPasteFormat(blaiseFixture) === 'personal_bests', 'format detection');
console.assert(extractSwimmerNameFromPaste(blaiseFixture) === 'Blaise Vera', 'name extraction');

const blaiseResult = parseSwimCloudPasteDetailed(blaiseFixture, {
  team: 'University of Pittsburgh',
  gender: Gender.MEN,
  division: 'D1',
});
console.assert(blaiseResult.swims.length === 15, `expected 15 swims, got ${blaiseResult.swims.length}`);

const fly50 = blaiseResult.swims.find(s => s.time === '20.65');
console.assert(fly50?.swimcloudBadge === 'extracted', '50 fly X badge');

const free100b = blaiseResult.swims.find(s => s.time === '42.04');
console.assert(free100b?.swimcloudBadge === 'd1_b', '100 free B badge');

const fly100 = blaiseResult.swims.find(s => s.time === '45.29');
console.assert(fly100?.swimcloudBadge === 'd1_b', '100 fly D1-B badge');

const free200u = blaiseResult.swims.find(s => s.time === '1:40.38');
console.assert(free200u?.swimcloudBadge === 'user_input', '200 free U badge');

const free50 = blaiseResult.swims.find(s => s.event === '50 Freestyle' && s.time === '19.03');
console.assert(free50?.swimcloudBadge === 'd1_b', '50 free D1-B stamp');
console.assert(free50?.computedCut === 'A', '50 free 19.03 computed A cut');

const lcmRow = blaiseResult.swims.find(s => s.time === '50.10');
console.assert(lcmRow?.timeType === 'LCM', 'LCM timeType');
console.assert(Boolean(lcmRow?.meetLabel?.includes('Pittsburgh')), 'empty badge col meet');

const cutCheck = compareTimeToCutline(
  convertTimeToSeconds(convertToSCY('19.03', '50 Freestyle', Gender.MEN, 'SCY')),
  Gender.MEN,
  '50 Freestyle',
  'D1'
);
console.assert(cutCheck.achieved === 'A', 'cutline utils A for 19.03');

console.assert(divisionForTeam('University of Pittsburgh') === 'D1', 'pitt D1');
console.assert(divisionForTeam('Ouachita Baptist University') === 'D2', 'obu D2');

const empty = parseSwimCloudPasteDetailed('', { team: 'X', gender: Gender.MEN });
console.assert(empty.swims.length === 0 && empty.warnings.length > 0, 'empty paste warning');

console.log('athlete history tests passed');
