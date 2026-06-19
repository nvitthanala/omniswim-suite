import { readFileSync } from 'fs';
import { calculatePoints, mergeScoringSettings, isRelayResult } from '../packages/core/src/lib/utils.ts';

const parserOut = JSON.parse(readFileSync('tests/test_nsisc_output.json', 'utf8'));
const toResult = (a) => ({
  id: crypto.randomUUID(),
  rank: a.rank ? parseInt(String(a.rank), 10) || 0 : 0,
  name: a.name,
  classYear: a.year || 'UNKNOWN',
  team: a.team,
  time: a.finals_time || a.prelims_time || 'NT',
  finalsTime: a.finals_time,
  roundSwam: a.round_swam,
  points: 0,
  event: a.event,
  gender: a.gender === 'Women' ? 'Women' : 'Men',
  isRelay: Boolean(a.is_relay),
  relayTeamTime: a.relay_team_time,
});
const parsed = parserOut.map(toResult);
const indiv = parsed.filter((r) => !isRelayResult(r));

const meetSettings = mergeScoringSettings({
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 2,
  scorerCapScope: 'meet',
  scorerEligibilityMode: 'roster',
});
const eventSettings = mergeScoringSettings({
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 2,
  scorerCapScope: 'event',
  scorerEligibilityMode: 'roster',
});

function countByEvent(scored) {
  const m = new Map();
  for (const r of scored) {
    if (!isRelayResult(r) && r.points > 0) m.set(r.event, (m.get(r.event) || 0) + 1);
  }
  return m;
}

const meetScored = calculatePoints(indiv, meetSettings);
const eventScored = calculatePoints(indiv, eventSettings);
const meetEvents = countByEvent(meetScored);
const eventEvents = countByEvent(eventScored);

console.log('meet scope: positive indiv', meetScored.filter((r) => !isRelayResult(r) && r.points > 0).length);
console.log('meet scope: events with scorers', meetEvents.size);
console.log('event scope: positive indiv', eventScored.filter((r) => !isRelayResult(r) && r.points > 0).length);
console.log('event scope: events with scorers', eventEvents.size);
if (eventEvents.size < meetEvents.size * 0.5) {
  console.error('FAIL: event scope has far fewer scoring events than meet scope');
  process.exit(1);
}
console.log('OK');
