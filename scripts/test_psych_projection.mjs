/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Gender } from '../packages/core/src/types.ts';
import {
  buildPsychExpectedRows,
  buildPsychOverUnderByEntryKey,
  buildPsychProjectedBundle,
  hasPsychData,
  psychClock,
  resolvePsychRanksForEvent,
} from '../packages/core/src/lib/psychProjection.ts';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine.ts';
import { calculatePoints, mergeScoringSettings } from '../packages/core/src/lib/utils.ts';

const settings = mergeScoringSettings({});
const event = 'Event 1 Men 100 Yard Freestyle';

const psychRows = [
  {
    id: 'p1',
    rank: 4,
    name: 'Alice',
    classYear: 'SR',
    team: 'Team A',
    time: '49.00',
    roundSwam: 'Psych Sheet',
    isPsychSheet: true,
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: false,
  },
  {
    id: 'p2',
    rank: 1,
    name: 'Bob',
    classYear: 'JR',
    team: 'Team B',
    time: '48.00',
    roundSwam: 'Psych Sheet',
    isPsychSheet: true,
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: false,
  },
];

if (!hasPsychData(psychRows)) {
  console.error('FAIL: expected hasPsychData true');
  process.exit(1);
}

const ranks = resolvePsychRanksForEvent(psychRows);
if (ranks.get(`${event}|Team A|alice`) !== 4) {
  console.error('FAIL: Alice psych rank should be 4', ranks);
  process.exit(1);
}

const expected = buildPsychExpectedRows(psychRows, settings);
const aliceExpected = expected.find(r => r.name === 'Alice');
if (!aliceExpected || aliceExpected.points !== 15) {
  console.error('FAIL: Alice psych expected should be 15 pts, got', aliceExpected?.points);
  process.exit(1);
}

const finals = {
  id: 'fin',
  rank: 1,
  name: 'Alice',
  classYear: 'SR',
  team: 'Team A',
  time: '50.00',
  prelimsTime: '49.50',
  finalsTime: '50.00',
  roundSwam: 'A Final',
  points: 0,
  event,
  gender: Gender.MEN,
  isRelay: false,
};
const baseline = calculatePoints([finals], settings);
const psychOu = buildPsychOverUnderByEntryKey(baseline, expected);
const aliceOu = psychOu.get(`${event}|Team A|alice`);
if (!aliceOu || aliceOu.overUnder !== 5) {
  console.error('FAIL: Alice psych O/U should be +5', aliceOu);
  process.exit(1);
}

// Relay psych rows skipped
const relayPsych = {
  id: 'rp',
  rank: 1,
  name: 'Relay Team',
  classYear: 'JR',
  team: 'Team R',
  time: '1:20.00',
  roundSwam: 'Psych Sheet',
  isPsychSheet: true,
  points: 0,
  event: 'Event 5 Men 200 Yard Freestyle Relay',
  gender: Gender.MEN,
  isRelay: true,
};
const relayExpected = buildPsychExpectedRows([relayPsych], settings);
if (relayExpected.length !== 0) {
  console.error('FAIL: relay psych entries should be excluded');
  process.exit(1);
}

const workspace = {
  id: 'psych-test',
  name: 'Test',
  menResults: [finals],
  womenResults: [],
  psychMenResults: psychRows,
  psychWomenResults: [],
  scoringSettings: settings,
};

const snapshot = buildScoringSnapshot(workspace, Gender.MEN, false);
if (!snapshot.psychProjected) {
  console.error('FAIL: scoring snapshot should include psychProjected');
  process.exit(1);
}

const bundle = buildPsychProjectedBundle({ workspace, gender: Gender.MEN });
const teamA = bundle.sortedTeams.find(t => t.teamName === 'Team A');
if (!teamA || teamA.totalPoints !== 15) {
  console.error('FAIL: Team A psych anchor should be 15', teamA?.totalPoints);
  process.exit(1);
}

if (psychClock({ time: '49.00', isRelay: false }) !== '49.00') {
  console.error('FAIL: psychClock');
  process.exit(1);
}

// Psych abbrev team aligns to meet full name for O/U keys
const psychAbbrev = [
  {
    id: 'pa',
    rank: 2,
    name: 'Alice',
    classYear: 'SR',
    team: 'UWF',
    time: '49.00',
    roundSwam: 'Psych Sheet',
    isPsychSheet: true,
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: false,
  },
];
const meetFullTeam = {
  id: 'fin2',
  rank: 1,
  name: 'Alice',
  classYear: 'SR',
  team: 'University of West Florida',
  time: '50.00',
  finalsTime: '50.00',
  roundSwam: 'A Final',
  points: 0,
  event,
  gender: Gender.MEN,
  isRelay: false,
};
const abbrevExpected = buildPsychExpectedRows(psychAbbrev, settings);
const abbrevBaseline = calculatePoints([meetFullTeam], settings);
const abbrevOu = buildPsychOverUnderByEntryKey(abbrevBaseline, abbrevExpected);
const abbrevKey = `${event}|University of West Florida|alice`;
if (!abbrevOu.has(abbrevKey)) {
  console.error('FAIL: psych abbrev team should align to meet team for O/U', [...abbrevOu.keys()]);
  process.exit(1);
}

console.log('OK psych projection tests passed');
