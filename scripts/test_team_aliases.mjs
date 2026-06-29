/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  expandTeamAbbrev,
  matchMeetTeamName,
  teamAcronym,
} from '../packages/core/src/data/teamAliases.ts';
import { alignPsychResultsToMeetTeams } from '../packages/core/src/lib/psychProjection.ts';

const meetTeams = [
  'Henderson State University',
  'Delta State University',
  'Ouachita Baptist University',
  'University of West Florida',
];

const checks = [
  ['HSU', 'Henderson State University'],
  ['DSU', 'Delta State University'],
  ['OUAC', 'Ouachita Baptist University'],
  ['UWF', 'University of West Florida'],
  ['Henderson State', 'Henderson State University'],
];

for (const [abbrev, expected] of checks) {
  const got = matchMeetTeamName(abbrev, meetTeams);
  if (got !== expected) {
    console.error(`FAIL matchMeetTeamName(${abbrev}) => ${got}, expected ${expected}`);
    process.exit(1);
  }
}

if (teamAcronym('Henderson State University') !== 'HSU') {
  console.error('FAIL teamAcronym Henderson State University');
  process.exit(1);
}

if (expandTeamAbbrev('hsu') !== 'Henderson State University') {
  console.error('FAIL expandTeamAbbrev hsu');
  process.exit(1);
}

const psychRows = [
  {
    id: 'p1',
    rank: 1,
    name: 'Test Swimmer',
    classYear: 'SR',
    team: 'HSU',
    time: '50.00',
    points: 0,
    event: 'Event 1 Women 50 Yard Freestyle',
    gender: 'Women',
    isRelay: false,
    isPsychSheet: true,
    roundSwam: 'Psych Sheet',
  },
];
const aligned = alignPsychResultsToMeetTeams(psychRows, [{ team: 'Henderson State University' }]);
if (aligned[0].team !== 'Henderson State University') {
  console.error('FAIL alignPsychResultsToMeetTeams HSU', aligned[0].team);
  process.exit(1);
}

console.log('OK team alias tests passed');
