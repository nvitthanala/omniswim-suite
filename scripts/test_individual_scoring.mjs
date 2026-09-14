/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Individual scoring, meet-wide vs per-event scorer-pool scope, against the
 * real NSISC parsed output. Previously one loose ratio check
 * (`eventEvents.size < meetEvents.size * 0.5`) — a smoke ratio, not an
 * invariant; meet-scope and event-scope scoring could both be badly wrong
 * and still sit within 2x of each other
 * (docs/reference/TEST_COVERAGE_AUDIT.md, "Pushover"). Hardened 2026-09-14
 * with exact pins against this real, committed data plus the actual
 * directional invariant the two scopes must obey.
 */
import assert from 'node:assert/strict';
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

const meetPositive = meetScored.filter((r) => !isRelayResult(r) && r.points > 0).length;
const eventPositive = eventScored.filter((r) => !isRelayResult(r) && r.points > 0).length;

console.log('meet scope: positive indiv', meetPositive);
console.log('meet scope: events with scorers', meetEvents.size);
console.log('event scope: positive indiv', eventPositive);
console.log('event scope: events with scorers', eventEvents.size);

assert.ok(indiv.length > 0, 'the real NSISC output parses real individual rows');

// The directional invariant, not a ratio: a meet-wide 18-scorer pool is a
// SHARED budget across every event a team swims, so it can only score fewer
// or equal individual rows than the same cap applied fresh per event — an
// event-scope pass never runs out of budget early the way a meet-wide pool
// can. If event-scope ever scores FEWER rows than meet-scope, the two caps
// have been swapped or the pool accounting is backwards.
assert.ok(
  eventPositive >= meetPositive,
  `event scope (${eventPositive}) must score at least as many individual rows as meet scope (${meetPositive})`
);
assert.ok(
  eventEvents.size >= meetEvents.size,
  `event scope must reach at least as many distinct scoring events (${eventEvents.size}) as meet scope (${meetEvents.size})`
);

// Exact pins against this real, committed workspace — a regression here
// means a real scoring number moved, not a plausible reshuffling.
assert.equal(meetPositive, 394, 'meet-scope positive individual rows, pinned to the committed NSISC data');
assert.equal(eventPositive, 415, 'event-scope positive individual rows, pinned to the committed NSISC data');
assert.equal(meetEvents.size, 34, 'meet-scope distinct scoring events, pinned to the committed NSISC data');
assert.equal(eventEvents.size, 34, 'event-scope distinct scoring events, pinned to the committed NSISC data');

console.log('OK — test_individual_scoring assertions passed');
