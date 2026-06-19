import { readFileSync } from 'fs';
import {
  calculatePoints,
  mergeScoringSettings,
  looksLikeInstitutionTeamName,
  isScoringSwimResult,
  isFinalsRound,
} from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets.find(m => m.conference === 'NSISC');
const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
const men = ws.menResults ?? [];
const TEAM = 'Henderson State University';

const scored = calculatePoints(men, settings, { scorerRosterOverrides: ws.scorerRosterOverrides });

let total = 0;
for (const r of scored) {
  const tName = String(r.name ?? '').trim().toLowerCase();
  const tTeam = String(r.team ?? '').trim().toLowerCase();
  if (tName && tTeam === tName && !looksLikeInstitutionTeamName(r.team)) continue;
  if (r.team !== TEAM) continue;
  total += typeof r.points === 'number' ? r.points : 0;
}

const eberhard200 = scored.find(
  r => r.team === TEAM && r.name === 'Mark Eberhard' && (r.event || '').includes('200 Yard Breaststroke') && !(r.event || '').includes('Time Trial')
);

console.log('Henderson men total:', total.toFixed(2));
console.log('Eberhard 200 breast pts:', eberhard200?.points ?? 'n/a');

if (Math.abs(total - 1056) > 0.01) {
  console.error('FAIL: expected 1056, got', total);
  process.exit(1);
}
if ((eberhard200?.points ?? 0) !== 0) {
  console.error('FAIL: DQ swimmer should have 0 points');
  process.exit(1);
}

// Finals DQ excluded from tie split; prelims SCR does not block via isScoringSwimResult
const tieFixture = [
  {
    id: '1',
    rank: 1,
    name: 'DQ Swimmer',
    classYear: 'SR',
    team: 'Team A',
    time: 'DQ',
    finalsTime: 'DQ',
    prelimsTime: '1:00.00',
    roundSwam: 'A Final',
    points: 0,
    event: 'Event 1 Men 100 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
  {
    id: '2',
    rank: 1,
    name: 'Winner',
    classYear: 'SR',
    team: 'Team B',
    time: '48.00',
    finalsTime: '48.00',
    roundSwam: 'A Final',
    points: 0,
    event: 'Event 1 Men 100 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
  {
    id: '3',
    rank: 5,
    name: 'Prelim Scratch',
    classYear: 'FR',
    team: 'Team A',
    time: 'SCR',
    prelimsTime: 'SCR',
    roundSwam: 'Prelims',
    points: 0,
    event: 'Event 2 Men 1000 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
];

if (!isFinalsRound('A Final') || isFinalsRound('Prelims')) {
  console.error('FAIL: isFinalsRound');
  process.exit(1);
}
if (isScoringSwimResult(tieFixture[0]) || !isScoringSwimResult(tieFixture[1])) {
  console.error('FAIL: finals DQ / legal finisher eligibility');
  process.exit(1);
}
if (!isScoringSwimResult(tieFixture[2])) {
  console.error('FAIL: prelims SCR should not be blocked by finals-only rule');
  process.exit(1);
}

const tieScored = calculatePoints(tieFixture, mergeScoringSettings({}));
const dqPts = tieScored.find(r => r.name === 'DQ Swimmer')?.points ?? -1;
const winPts = tieScored.find(r => r.name === 'Winner')?.points ?? -1;
if (dqPts !== 0 || winPts !== 20) {
  console.error('FAIL: tie split expected 0 and 20, got', dqPts, winPts);
  process.exit(1);
}

console.log('OK');
