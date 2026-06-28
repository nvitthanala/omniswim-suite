import { readFileSync } from 'fs';
import { optimizeRosterForTeam } from '../packages/core/src/lib/rosterOptimizer.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const settings = mergeScoringSettings(ws.scoringSettings, { conference: 'NSISC' });

const team = 'Ouachita Baptist University';
const result = optimizeRosterForTeam(ws, Gender.MEN, team, false, settings, 'scorers');

console.assert(Array.isArray(result.overrides), 'overrides array');
console.assert(typeof result.projectedTotal === 'number', 'projected total');
console.log(
  'optimizer',
  team,
  'projected',
  result.projectedTotal.toFixed(1),
  'was',
  result.previousTotal.toFixed(1),
  'override deltas',
  result.overrides.length
);
console.log('roster optimizer tests passed');
