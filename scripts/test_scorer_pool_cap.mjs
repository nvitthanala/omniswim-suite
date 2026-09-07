/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The meet-wide scorer pool must cap per ATHLETE, not per tie group.
 *
 * THE BUG (the no-PDF remainder of plans/2026-08-14/12, fixed 2026-08-30).
 * `scoreIndividualsInEvent` gated a team's slice of a tie group with
 *
 *     uniqueNames.every(n => canAddSwimmerToPool(pool, n, event, settings))
 *
 * which got two things wrong at once:
 *
 *  1. ALL-OR-NOTHING. One athlete the 18-scorer pool could not take zeroed
 *     every teammate in that tie group — including teammates already IN the
 *     pool, already consuming a scorer slot.
 *  2. NO ACCUMULATION. `canAddSwimmerToPool` weighs one name against the pool
 *     as it stands, and nothing was added until the whole group passed. So N
 *     new names in one group each saw the same pre-group weight and all N
 *     passed: the pool admitted 31 athletes against a cap of 18.
 *
 * Both hid in PDF-shaped data, where a team almost never holds two swimmers on
 * one placement so the group is a single athlete and `every` reduces to the
 * per-athlete test. They detonate when ranks collapse — with no PDF rows
 * `prepareRecruitsForScoring` has no comparators, every recruit comes back
 * rank 1, and an entire event becomes ONE tie group.
 *
 * MEASURED on the two live roster-only workspaces before the fix: HSU men
 * scored in 9 of 14 events with 31 athletes in an 18 pool; OBU men scored in
 * 4 of 14. Whole events were zeroed by one athlete over the line, and the cap
 * the optimizer enforces was not the cap the engine applied.
 *
 * Fixtures are hermetic and built in-process — they must NOT read
 * data/meets.json, or CI would fail when the user edits a lineup.
 *
 * Test: npx tsx scripts/test_scorer_pool_cap.mjs
 */
import assert from 'node:assert/strict';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';
const RIVAL = 'Ouachita Baptist University';
const CAP = 18;

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/** No conference, so the NSISC lock does not fire and these values are the ones under test. */
const SETTINGS = mergeScoringSettings({
  ...NSISC_PRESET_SETTINGS,
  maxIndividualScorersPerTeam: CAP,
  scorerCapScope: 'meet',
  scorerEligibilityMode: 'roster',
  maxTotalEntriesPerSwimmer: 999,
});

const athlete = i => `Athlete ${String(i).padStart(2, '0')}`;

/** Every row is rank 1 — the collapsed-rank shape a roster-only workspace produces. */
function swim(event, name, team, seconds) {
  return {
    id: `${event}|${name}`,
    rank: 1,
    name,
    classYear: 'JR',
    team,
    time: seconds.toFixed(2),
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    isExhibition: false,
    isTimeTrial: false,
    roundSwam: 'A Final',
    relayNames: [],
  };
}

const score = (rows, overrides = []) =>
  calculatePoints(rows, SETTINGS, { scorerRosterOverrides: overrides, resultsForPdfHint: [] });

const teamTotal = (scored, team = TEAM) =>
  scored.filter(r => r.team === team).reduce((s, r) => s + (r.points ?? 0), 0);

const scorersOf = (scored, team = TEAM) =>
  new Set(scored.filter(r => r.team === team && (r.points ?? 0) > 0).map(r => r.name));

// ---------------------------------------------------------------------------
// 1. One event, 20 athletes, an 18-scorer pool.
//    The cap must bind at exactly 18 — and the two left out must be the two
//    SLOWEST, not whichever two happened to sit last in the input array.
// ---------------------------------------------------------------------------
{
  const ONE = '50 Freestyle';
  // Built slowest-first so an implementation that admits in row order fails.
  const rows = [];
  for (let i = 19; i >= 0; i--) rows.push(swim(ONE, athlete(i), TEAM, 20 + i * 0.1));

  const scored = score(rows);
  const scorers = scorersOf(scored);

  assert.equal(
    scorers.size,
    CAP,
    `an ${CAP}-scorer pool must admit exactly ${CAP} of 20 athletes, got ${scorers.size}`
  );
  ok(`the cap binds at exactly ${CAP} — no overshoot (was 31 on the live HSU roster)`);

  const expected = new Set(Array.from({ length: CAP }, (_, i) => athlete(i)));
  assert.deepEqual(
    [...scorers].sort(),
    [...expected].sort(),
    'the last scorer slots must go to the FASTEST athletes, not to input order'
  );
  ok('admission is fastest-first, so the result does not depend on row order');

  // Everyone admitted shares the placement equally; nobody is re-placed.
  const awarded = scored.filter(r => r.team === TEAM && (r.points ?? 0) > 0).map(r => r.points);
  assert.equal(new Set(awarded).size, 1, 'a tie group must pay every admitted member the same share');
  const share = awarded[0];
  assert.equal(
    Number(teamTotal(scored).toFixed(6)),
    Number((share * CAP).toFixed(6)),
    'team total must be exactly the admitted athletes’ shares'
  );
  ok(`each admitted athlete takes the same share (${share}); total = ${CAP} x share`);
}

// ---------------------------------------------------------------------------
// 2. THE REGRESSION. An event containing ONE athlete the pool cannot take must
//    still score for the teammates who are already in it.
//
//    Under the old gate this event scored 0.00 — the mechanism that put 5 of
//    HSU's 14 events and 10 of OBU's 14 at zero.
// ---------------------------------------------------------------------------
const MANY = ['50 Freestyle', '100 Freestyle', '100 Backstroke', '100 Butterfly'];

/** The athlete who turns up only in event 3, after the pool is already full. */
const LATE_ARRIVAL = athlete(22);

/**
 * The live HSU shape, in miniature. `sortEventsByMeetOrder` leaves these names
 * in the order given, so the meet-wide pool fills in the order the events are
 * pushed here — which is what lets the third event contain an athlete the pool
 * has no room for.
 *
 * Pre-fix this scored: event 1 admitted all 20 (the pool overshot to 20 against
 * a cap of 18), and event 3 then hit `LATE_ARRIVAL`, failed `every`, and
 * returned 0.00 for all 17 pooled teammates in it.
 */
function buildMultiEvent() {
  const rows = [];
  // 1. More entrants than the pool can hold, so it must turn someone away.
  for (let i = 0; i < 20; i++) rows.push(swim(MANY[0], athlete(i), TEAM, 20 + i * 0.1));
  // 2. Everyone here is already pooled.
  for (let i = 0; i < 18; i++) rows.push(swim(MANY[1], athlete(i), TEAM, 45 + i * 0.1));
  // 3. 17 pooled teammates + ONE athlete who has not appeared before and cannot
  //    fit. This is the event the old gate blanked.
  for (let i = 0; i < 17; i++) rows.push(swim(MANY[2], athlete(i), TEAM, 50 + i * 0.1));
  rows.push(swim(MANY[2], LATE_ARRIVAL, TEAM, 59.9));
  for (let i = 0; i < 16; i++) rows.push(swim(MANY[3], athlete(i), TEAM, 55 + i * 0.1));
  // A rival contests everything, so the team is never scoring unopposed.
  for (const [e, event] of MANY.entries()) {
    for (let i = 0; i < 3; i++) rows.push(swim(event, `Rival ${i}`, RIVAL, 21 + e * 25 + i * 0.1));
  }
  return rows;
}

{
  const rows = buildMultiEvent();
  const scored = score(rows);
  const scorers = scorersOf(scored);

  const teamPtsFor = ev =>
    scored.filter(r => r.team === TEAM && r.event === ev).reduce((s, r) => s + (r.points ?? 0), 0);

  // The fixture only proves something if the pool really does refuse the late
  // arrival. Without this the assertion below could pass on a workspace where
  // nobody was ever turned away — the silent-empty failure mode.
  assert.ok(
    !scorers.has(LATE_ARRIVAL),
    `fixture broken: ${LATE_ARRIVAL} was admitted, so no athlete is over the line`
  );
  assert.ok(
    scored.some(r => r.team === TEAM && r.event === MANY[2] && r.name !== LATE_ARRIVAL),
    `fixture broken: ${MANY[2]} must hold pooled teammates alongside ${LATE_ARRIVAL}`
  );

  assert.ok(
    teamPtsFor(MANY[2]) > 0,
    `REGRESSION: one athlete the pool could not take zeroed the whole event ` +
      `(${MANY[2]} scored ${teamPtsFor(MANY[2])}) — the every() pool gate is back`
  );
  ok(`an un-poolable athlete (${LATE_ARRIVAL}) no longer zeroes the teammates tied with them`);

  // Generalised: no event may be blanked while a pooled scorer competes in it.
  for (const ev of MANY) {
    const entrants = new Set(
      scored.filter(r => r.team === TEAM && r.event === ev).map(r => r.name)
    );
    if (![...entrants].some(x => scorers.has(x))) continue;
    assert.ok(teamPtsFor(ev) > 0, `${ev} was blanked despite containing a pooled scorer`);
  }
  ok('no event is blanked while one of the team’s pooled scorers is in it');

  assert.equal(
    scorers.size,
    CAP,
    `meet-wide the pool must still hold exactly ${CAP}, got ${scorers.size}`
  );
  ok(`the cap still holds meet-wide across ${MANY.length} events`);

  // The athlete the pool refused takes 0 everywhere — the roster is still honoured.
  const refused = scored.filter(r => r.team === TEAM && !scorers.has(r.name));
  assert.ok(refused.length > 0, 'fixture must actually refuse somebody, or it proves nothing');
  assert.ok(
    refused.every(r => (r.points ?? 0) === 0),
    'an athlete outside the pool must score nothing'
  );
  ok('athletes outside the pool score nothing — the cap is not being ignored');
}

// ---------------------------------------------------------------------------
// 3. Benching an athlete must never lower a TEAMMATE.
//
//    This is the invariant the old gate broke, stated without reference to any
//    particular total: eligibility is a per-athlete question, so one athlete's
//    answer cannot move another athlete's points.
// ---------------------------------------------------------------------------
{
  const rows = buildMultiEvent();
  const before = score(rows);
  const pointsByRow = s => new Map(s.map(r => [r.id, r.points ?? 0]));
  const beforePts = pointsByRow(before);
  const benched = [...scorersOf(before)][0];

  const after = score(rows, [{ name: benched, team: TEAM, gender: MEN, isScorer: false }]);
  const afterPts = pointsByRow(after);

  for (const r of after) {
    if (r.team === TEAM && r.name === benched) {
      assert.equal(r.points ?? 0, 0, 'the benched athlete must score 0');
      continue;
    }
    if (r.team !== TEAM) continue;
    assert.ok(
      (afterPts.get(r.id) ?? 0) >= (beforePts.get(r.id) ?? 0),
      `benching ${benched} lowered teammate ${r.name} in ${r.event}: ` +
        `${beforePts.get(r.id)} -> ${afterPts.get(r.id)}`
    );
  }
  ok(`benching ${benched} never lowered a teammate's points`);

  // A rival's points are set by the placement and must not move either way.
  for (const r of after.filter(x => x.team === RIVAL)) {
    assert.equal(
      afterPts.get(r.id),
      beforePts.get(r.id),
      `a rival's points moved when ${TEAM} benched someone`
    );
  }
  ok('a rival’s points do not move when the other team benches someone');

  // Benching the whole team still scores nothing — the opposite failure mode,
  // a "fix" that stops consulting the roster at all.
  const allOff = score(
    rows,
    [...new Set(rows.filter(r => r.team === TEAM).map(r => r.name))].map(name => ({
      name,
      team: TEAM,
      gender: MEN,
      isScorer: false,
    }))
  );
  assert.equal(teamTotal(allOff), 0, 'benching every athlete must score nothing');
  assert.ok(teamTotal(allOff, RIVAL) > 0, 'the rival still scores');
  ok('benching the whole team still scores nothing — the roster is still honoured');
}

// ---------------------------------------------------------------------------
// 4. Determinism within a tie group. A tie group has no intrinsic order, so
//    reordering the rows inside one must not change who the pool admits.
//
//    Scoped deliberately to row order WITHIN each event: the events themselves
//    are kept in their original sequence because the meet-wide pool fills
//    chronologically, so event order is a real input (the meet program), not an
//    artifact. `sortEventsByMeetOrder` breaking a tie by row-insertion order is
//    a separate, pre-existing sensitivity and is not what this fix is about.
// ---------------------------------------------------------------------------
{
  const rows = buildMultiEvent();
  const a = score(rows);

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.event)) groups.set(r.event, []);
    groups.get(r.event).push(r);
  }
  const rowShuffled = [...groups.values()].flatMap(g => [...g].reverse());
  const b = score(rowShuffled);

  assert.equal(
    Number(teamTotal(a).toFixed(6)),
    Number(teamTotal(b).toFixed(6)),
    'reversing the rows inside each tie group changed the team total'
  );
  assert.deepEqual(
    [...scorersOf(a)].sort(),
    [...scorersOf(b)].sort(),
    'the admitted set must not depend on row order inside a tie group'
  );
  ok(`row order inside a tie group does not change the answer (total ${teamTotal(a).toFixed(2)})`);
}

console.log(`\ntest_scorer_pool_cap OK (${n} assertions)`);
