import { readFileSync } from 'fs';
import {
  calculatePoints,
  mergeScoringSettings,
  looksLikeInstitutionTeamName,
  isScoringSwimResult,
  isFinalsRound,
} from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';
import { loadLocalMeets, noteLocalOnlySkipped } from './lib/localMeets.mjs';

const TEAM = 'Henderson State University';

/**
 * The Henderson men total must equal the published 1056, and the swimmer who was
 * disqualified in the 200 breaststroke final must score nothing. Runs over any
 * list of NSISC men's rows, so one assertion set covers both sources below.
 */
function checkHendersonMenAndDq(men, settings, scorerRosterOverrides) {
  const scored = calculatePoints(men, settings, { scorerRosterOverrides });

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
  // A row that is not found is not a row that scored 0. Without this, a lookup that
  // matched nothing would pass the check below (undefined ?? 0 is 0).
  if (!eberhard200) {
    console.error('FAIL: the Mark Eberhard 200 Yard Breaststroke row was not found');
    process.exit(1);
  }
  if ((eberhard200?.points ?? 0) !== 0) {
    console.error('FAIL: DQ swimmer should have 0 points');
    process.exit(1);
  }
}

// Part 1a reads the real NSISC workspace in data/meets.json (untracked), so it is
// local-only.
const meets = loadLocalMeets();
if (meets === null) {
  noteLocalOnlySkipped('test_dq_scoring.mjs', 'part 1a, the Henderson men total and the Eberhard DQ check over the local workspace');
} else {
  const ws = meets.find(m => m.conference === 'NSISC');
  const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  checkHendersonMenAndDq(ws.menResults ?? [], settings, ws.scorerRosterOverrides);
}

// Part 1b: the same two assertions over the committed parser output for the same
// PDF (tests/test_nsisc_output.json), scored with the committed NSISC preset.
// Nothing local is read, so CI runs it.
{
  const parsed = JSON.parse(readFileSync('tests/test_nsisc_output.json', 'utf8'));
  const men = parsed
    .filter(a => a.gender !== 'Women')
    .map(a => ({
      id: crypto.randomUUID(),
      rank: a.rank ? parseInt(a.rank, 10) || 0 : 0,
      name: a.name,
      classYear: a.year || 'UNKNOWN',
      team: a.team,
      time: a.finals_time || a.prelims_time || 'NT',
      finalsTime: a.finals_time,
      prelimsTime: a.prelims_time,
      roundSwam: a.round_swam,
      points: 0,
      event: a.event,
      gender: Gender.MEN,
      isRelay: Boolean(a.is_relay),
      relayTeamTime: a.relay_team_time,
    }));
  console.log('[committed parser output: tests/test_nsisc_output.json]');
  checkHendersonMenAndDq(men, mergeScoringSettings({}, { conference: 'NSISC' }), undefined);
}

// Part 2 uses only literals.
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
