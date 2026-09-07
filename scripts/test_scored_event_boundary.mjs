/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A meet scores its program, not everything printed in the results PDF.
 *
 * HyTek numbers post-meet extra sessions above the program — time trials, record
 * attempts, exhibition swims — and leaves them out of the published team totals.
 * The engine recognised them by the string "TIME TRIAL" in the event name, which
 * works only while the meet host bothers to type it. The 2026 NSISC results
 * print "Event 938 Women 100 Yard Breaststroke" and "Event 939 Boys 100 Yard
 * Breaststroke" after the time trials with no such suffix and one entrant each,
 * so the engine handed each a win: 20 points from nothing, to Delta State, in
 * both genders. The meet's own team rankings run "Through Event 42".
 *
 * `ScoringSettings.scoredEventNumberMax` carries that boundary. This test proves
 * the defect still reproduces without it, so it cannot pass vacuously, then that
 * the boundary closes it without touching anything inside the program.
 *
 * Test: npx tsx scripts/test_scored_event_boundary.mjs
 */
import assert from 'node:assert/strict';
import {
  calculatePoints,
  isOutsideScoredProgram,
  parseEventNumber,
} from '../packages/core/src/lib/utils.ts';

/** Plain 16-deep table, no caps — this test is about the event gate only. */
const SETTINGS = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  scorerEligibilityMode: 'points_pool',
};

let n = 0;
const row = (event, name, team, rank, time) => ({
  id: `r${++n}`,
  event,
  name,
  team,
  rank,
  time,
  finalsTime: time,
  prelimsTime: 'NT',
  roundSwam: 'A Final',
  gender: 'Women',
  classYear: 'SR',
  isRelay: false,
  isExhibition: false,
  isTimeTrial: false,
  points: 0,
});

const results = [
  // Inside the program.
  row('Event 25 Women 100 Yard Breaststroke', 'Kiera Cloete', 'Delta State University', 2, '1:03.53'),
  row('Event 25 Women 100 Yard Breaststroke', 'Rival Swimmer', 'Ouachita Baptist University', 1, '1:02.90'),
  // Past it. One entrant, so it is worth a full win if the engine scores it.
  row('Event 938 Women 100 Yard Breaststroke', 'Kiera Cloete', 'Delta State University', 1, '1:05.16'),
  // No event number at all — a canonical/what-if label. Must keep scoring.
  row('100 Yard Butterfly', 'Kiera Cloete', 'Delta State University', 1, '58.00'),
];

const totals = scored => {
  const by = {};
  for (const r of scored) by[r.team] = (by[r.team] ?? 0) + (r.points ?? 0);
  return by;
};
const pointsFor = (scored, event) =>
  scored.filter(r => r.event === event).reduce((s, r) => s + (r.points ?? 0), 0);

// --- Label parsing -----------------------------------------------------------
assert.equal(parseEventNumber('Event 13 Men 100 Yard Butterfly'), 13);
assert.equal(parseEventNumber('Event 938 Women 100 Yard Breaststroke'), 938);
assert.equal(parseEventNumber('100 Yard Butterfly'), null, 'canonical labels carry no number');
assert.equal(parseEventNumber(undefined), null);

assert.equal(isOutsideScoredProgram('Event 938 Women 100 Yard Breaststroke', 42), true);
assert.equal(isOutsideScoredProgram('Event 42 Men 4x100 Yard Freestyle Relay', 42), false, 'the boundary is inclusive');
assert.equal(isOutsideScoredProgram('Event 938 Women 100 Yard Breaststroke', undefined), false, 'no boundary published, nothing excluded');
assert.equal(isOutsideScoredProgram('100 Yard Butterfly', 42), false, 'an unnumbered label is never excluded');

// --- The defect still reproduces without the boundary -------------------------
const unbounded = calculatePoints(results, SETTINGS, {});
assert.equal(
  pointsFor(unbounded, 'Event 938 Women 100 Yard Breaststroke'),
  20,
  'fixture no longer reproduces the defect: event 938 must win outright when no boundary is given'
);

// --- The boundary closes it --------------------------------------------------
const bounded = calculatePoints(results, SETTINGS, { scoredEventNumberMax: 42 });
assert.equal(
  pointsFor(bounded, 'Event 938 Women 100 Yard Breaststroke'),
  0,
  'event past the meet program must score nothing'
);
assert.equal(
  pointsFor(bounded, 'Event 25 Women 100 Yard Breaststroke'),
  37,
  'events inside the program are untouched (20 + 17)'
);
assert.equal(
  pointsFor(bounded, '100 Yard Butterfly'),
  20,
  'an unnumbered label still scores — zeroing these would empty every projection'
);

const before = totals(unbounded);
const after = totals(bounded);
assert.equal(before['Delta State University'] - after['Delta State University'], 20, 'exactly the phantom win comes off');
assert.equal(after['Ouachita Baptist University'], before['Ouachita Baptist University'], 'no other team moves');

// The setting is equivalent to the option, so a persisted workspace value works.
const viaSettings = calculatePoints(results, { ...SETTINGS, scoredEventNumberMax: 42 }, {});
assert.deepEqual(totals(viaSettings), after, 'settings and option must agree');

console.log('PASS  scored event boundary: events past "Through Event N" earn no team points');
