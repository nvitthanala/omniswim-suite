import { readFileSync } from 'fs';
import { calculatePoints, mergeScoringSettings, relayEntryGroupKey } from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';

const parserOut = JSON.parse(readFileSync('tests/test_nsisc_output.json', 'utf8'));
const toResult = (a) => ({
  id: crypto.randomUUID(),
  rank: a.rank ? parseInt(a.rank, 10) || 0 : 0,
  name: a.name,
  classYear: a.year || 'UNKNOWN',
  team: a.team,
  time: a.finals_time || a.prelims_time || 'NT',
  finalsTime: a.finals_time,
  roundSwam: a.round_swam,
  points: 0,
  event: a.event,
  gender: a.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
  isRelay: Boolean(a.is_relay),
  relayTeamTime: a.relay_team_time,
});
const parsed = parserOut.map(toResult);
const wsSettings = JSON.parse(readFileSync('data/meets.json', 'utf8'))[0].scoringSettings;
const merged = mergeScoringSettings(wsSettings, { conference: 'NSISC' });
const allScored = calculatePoints(parsed, merged);
const relays = allScored.filter((r) => r.isRelay);
const groups = new Map();
for (const r of parsed.filter((x) => x.isRelay)) {
  const k = relayEntryGroupKey(r);
  groups.set(k, (groups.get(k) || 0) + 1);
}
const sizes = [...groups.values()];
console.log('relay entry group sizes', [...new Set(sizes)].sort());
console.log('Parsed PDF shape -> TS:', relays.length, 'pos', relays.filter((r) => r.points > 0).length);
const units = new Set(
  relays.filter((r) => r.points > 0).map((r) => relayEntryGroupKey(r))
);
console.log('scoring relay entries (TS)', units.size);

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const men = (ws.menResults || []).filter((r) => r.isRelay && String(r.event || '').includes('Event 2'));
const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
const scored = calculatePoints(men, settings, { scorerRosterOverrides: ws.scorerRosterOverrides || [] });
const pts = scored.map((r) => r.points);
console.log('merge+conference roster mode:', settings.scorerEligibilityMode);
console.log('relay pool rule would be:', settings.relayEligibleFromScorerPool && settings.scorerEligibilityMode !== 'roster');
console.log('Event 2 men relay legs:', pts.length, 'positive', pts.filter((p) => p > 0).length, 'sample', pts.slice(0, 8));
const legPts = scored.filter((r) => r.points > 0).map((r) => r.points);
if (legPts.length >= 4) {
  console.log('per-leg pts (first 4)', legPts.slice(0, 4), 'sum', legPts.slice(0, 4).reduce((a, b) => a + b, 0));
}

const settingsNoMerge = { ...ws.scoringSettings };
const scored2 = calculatePoints(men, settingsNoMerge);
const pts2 = scored2.map((r) => r.points);
console.log('raw workspace settings (no merge):', settingsNoMerge.scorerEligibilityMode);
console.log('Event 2 positive:', pts2.filter((p) => p > 0).length);
