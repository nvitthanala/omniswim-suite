/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A non-scorer must cost only its own points — never the whole tie group.
 *
 * THE BUG (root cause of plans/2026-08-14/12, the P0 that took a 1277-point
 * projection to 0). `scoreIndividualsInEvent` gates a team's slice of a tie
 * group with
 *
 *     uniqueNames.every(n => rosterLookup.isScorer(n, team, gender))
 *
 * so ONE athlete off the scoring roster zeroed every teammate tied with them.
 *
 * Why it hid for so long: in PDF-shaped data a team almost never holds two
 * swimmers on a single placement, so the group is one athlete and `every`
 * reduces to the per-athlete test. It only detonated when ranks collapsed —
 * `prepareRecruitsForScoring` had no comparators on a roster-only workspace, so
 * every recruit row came back rank 1 and an entire event became ONE tie
 * group. Turning 14 of 32 athletes off then zeroed 12 of the 14 events they
 * entered, with zero exceptions.
 *
 * That collapse is fixed (2026-09-02, scripts/test_recruit_placement_grid.mjs),
 * so a real workspace no longer reaches this shape by accident. The fixture
 * below still builds it on purpose: a genuine dead heat produces the same shape,
 * and this test is about what the engine does once it has one.
 *
 * The optimizer guard (test_optimizer_never_loses.mjs) makes the BUTTON safe.
 * This test is about the engine underneath it, which the guard does not fix.
 *
 * Fixtures are hermetic and built in-process — they must NOT read
 * data/meets.json, or CI would fail when the user edits a lineup.
 *
 * Test: npx tsx scripts/test_tie_group_scoring.mjs
 */
import assert from 'node:assert/strict';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';
const RIVAL = 'Ouachita Baptist University';
const EVENT = 'Event 8 Men 50 Yard Freestyle';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/**
 * All rows share rank 1 — the collapsed-rank shape a roster-only workspace
 * produces, where the whole event is a single tie group.
 */
function swim(id, name, team, time) {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event: EVENT,
    gender: MEN,
    isRelay: false,
    isExhibition: false,
    isTimeTrial: false,
    roundSwam: 'A Final',
    relayNames: [],
  };
}

const ROWS = [
  swim('a', 'Alpha Scorer', TEAM, '20.10'),
  swim('b', 'Bravo Scorer', TEAM, '20.20'),
  swim('c', 'Charlie Benched', TEAM, '20.30'),
  swim('d', 'Delta Rival', RIVAL, '20.40'),
];

// `scorerEligibilityMode: 'roster'` is what makes overrides bite at all; the
// per-type caps are left wide so nothing else can zero a row and fake a pass.
const SETTINGS = mergeScoringSettings({
  scorerEligibilityMode: 'roster',
  maxIndividualScorersPerTeam: 999,
  maxTotalEntriesPerSwimmer: 999,
});

const OFF_THE_ROSTER = [
  { id: 'o1', gender: MEN, team: TEAM, name: 'Charlie Benched', isScorer: false },
];

const pointsFor = (rows, overrides) => {
  const scored = calculatePoints(rows, SETTINGS, { scorerRosterOverrides: overrides });
  const byName = {};
  for (const r of scored) byName[r.name] = (byName[r.name] ?? 0) + (r.points ?? 0);
  return byName;
};

// --- 1. baseline: everyone scores, nobody is benched ------------------------
const before = pointsFor(ROWS, []);
const groupTotal = Object.values(before).reduce((a, b) => a + b, 0);
assert.ok(groupTotal > 0, 'fixture must score something before anyone is benched');
for (const name of ['Alpha Scorer', 'Bravo Scorer', 'Charlie Benched', 'Delta Rival']) {
  assert.ok(before[name] > 0, `${name} should score in the baseline`);
}
ok(`baseline: all four rows tie at rank 1 and share ${groupTotal} points`);

// --- 2. THE REGRESSION: benching one teammate must not zero the others ------
const after = pointsFor(ROWS, OFF_THE_ROSTER);
assert.equal(after['Charlie Benched'], 0, 'the benched athlete must score 0');
assert.ok(
  after['Alpha Scorer'] > 0,
  'REGRESSION: a teammate tied with a non-scorer was zeroed — the every() gate is back'
);
assert.ok(
  after['Bravo Scorer'] > 0,
  'REGRESSION: a teammate tied with a non-scorer was zeroed — the every() gate is back'
);
ok('benching one athlete costs only that athlete');

// --- 3. the tie split itself does not move ---------------------------------
// Eligibility answers "does this athlete count for us", not "how did the event
// place". The per-swim share is set by the placement, so it must be identical
// before and after — if it shifted, the fix would be quietly re-awarding a
// benched athlete's points to their teammates.
assert.equal(
  after['Alpha Scorer'],
  before['Alpha Scorer'],
  'the tie share must be unchanged: eligibility is not a re-placement'
);
assert.equal(
  after['Delta Rival'],
  before['Delta Rival'],
  "a rival's points must not move when the other team benches someone"
);
ok('the tie share is unchanged — benched points are forfeited, not redistributed');

// --- 4. the team total falls by exactly the benched athlete's share ---------
const teamBefore = before['Alpha Scorer'] + before['Bravo Scorer'] + before['Charlie Benched'];
const teamAfter = after['Alpha Scorer'] + after['Bravo Scorer'] + after['Charlie Benched'];
assert.equal(
  teamAfter,
  teamBefore - before['Charlie Benched'],
  `benching one of three cost ${teamBefore - teamAfter} of ${teamBefore}; expected only ${before['Charlie Benched']}`
);
ok(`team total ${teamBefore} → ${teamAfter}, exactly one athlete's share`);

// --- 5. benching everyone still scores nothing ------------------------------
// The opposite failure would be a fix that ignores the roster entirely.
const allOff = pointsFor(
  ROWS,
  ['Alpha Scorer', 'Bravo Scorer', 'Charlie Benched'].map((name, i) => ({
    id: `x${i}`,
    gender: MEN,
    team: TEAM,
    name,
    isScorer: false,
  }))
);
assert.equal(allOff['Alpha Scorer'], 0);
assert.equal(allOff['Bravo Scorer'], 0);
assert.equal(allOff['Charlie Benched'], 0);
assert.ok(allOff['Delta Rival'] > 0, 'the rival still scores');
ok('benching the whole team still scores nothing — the roster is still honoured');

console.log(`\ntest_tie_group_scoring OK (${n} assertions)`);
