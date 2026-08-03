/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Scenario diff drill-down tests (saved lineup snapshot vs current lineup).
 * Run: node --import tsx scripts/test_scenario_diff.mjs
 */
import assert from 'node:assert/strict';
import { computeScenarioDiff } from '../packages/core/src/lib/scenarioDiff.ts';
import { requestScenarioDiff } from '../packages/core/src/lib/scenarioDiffClient.ts';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const EPS = 1e-6;

/** Simple predictable scoring: 5/3/1 for places 1-3, generic per-event scope. */
const SETTINGS = {
  scoringPoints: [5, 3, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

function result(id, name, team, event, time, extra = {}) {
  return {
    id,
    rank: 0,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event,
    gender: MEN,
    isRelay: false,
    ...extra,
  };
}

function relayLegs(idPrefix, team, event, teamTime, rank, names) {
  return names.map((name, i) =>
    result(`${idPrefix}_${i}`, name, team, event, teamTime, {
      rank,
      roundSwam: 'A Final',
      isRelay: true,
      finalsTime: teamTime,
      relayTeamTime: teamTime,
      relayLegIndex: i,
    })
  );
}

function baseWorkspace(overrides = {}) {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    scoringSettings: SETTINGS,
    conference: undefined,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
    ...overrides,
  };
}

/** Independent engine total for a team — exact same path the Lineup step scores through. */
function engineTeamTotal(ws, team) {
  const bundle = buildScoringBundle({
    workspace: ws,
    gender: MEN,
    removeSeniors: false,
    applyWhatIf: true,
    scorerRosterOverrides: ws.scorerRosterOverrides,
  });
  const t = bundle.sortedTeams.find(x => x.teamName === team);
  return t ? t.totalPoints : 0;
}

const A = 'A Final';

// "Then" (snapshot): Alice wins 100 Free (5), Bob wins 200 Free (5),
// HSU relay wins 200 Free Relay (5*2 = 10 team pts across 4 legs). Total 20.
const thenWs = baseWorkspace({
  menResults: [
    result('a1', 'Alice Adams', 'HSU', '100 Free', '50.00', { rank: 1, roundSwam: A }),
    result('b1', 'Bob Brown', 'HSU', '200 Free', '1:50.00', { rank: 1, roundSwam: A }),
    result('v1', 'Vic Rivers', 'RIV', '100 Free', '51.00', { rank: 2, roundSwam: A }),
    result('w1', 'Wes Rivers', 'RIV', '200 Free', '1:52.00', { rank: 2, roundSwam: A }),
    ...relayLegs('hr1', 'HSU', '200 Free Relay', '1:25.00', 1, [
      'Alice Adams',
      'Bob Brown',
      'Carl Cole',
      'Dan Drake',
    ]),
    ...relayLegs('rr1', 'RIV', '200 Free Relay', '1:26.00', 2, [
      'Vic Rivers',
      'Wes Rivers',
      'Xan Rivers',
      'Yul Rivers',
    ]),
  ],
});

// "Now" (current): Alice adds time and drops to 2nd (3), Bob's 200 Free is
// removed and he adds a 100 Back win (5), HSU relay slips to 2nd (3*2 = 6).
// Total 14 → delta -6.
const nowWs = baseWorkspace({
  menResults: [
    result('a1', 'Alice Adams', 'HSU', '100 Free', '52.00', { rank: 2, roundSwam: A }),
    result('b2', 'Bob Brown', 'HSU', '100 Back', '52.50', { rank: 1, roundSwam: A }),
    result('v1', 'Vic Rivers', 'RIV', '100 Free', '51.00', { rank: 1, roundSwam: A }),
    result('w1', 'Wes Rivers', 'RIV', '200 Free', '1:52.00', { rank: 1, roundSwam: A }),
    result('x1', 'Xan Rivers', 'RIV', '100 Back', '53.00', { rank: 2, roundSwam: A }),
    ...relayLegs('hr1', 'HSU', '200 Free Relay', '1:27.00', 2, [
      'Alice Adams',
      'Bob Brown',
      'Carl Cole',
      'Dan Drake',
    ]),
    ...relayLegs('rr1', 'RIV', '200 Free Relay', '1:26.00', 1, [
      'Vic Rivers',
      'Wes Rivers',
      'Xan Rivers',
      'Yul Rivers',
    ]),
  ],
});

const OPTS = { team: 'HSU', gender: MEN, settings: SETTINGS };

// --- totals reconcile exactly with the engine ---
{
  const diff = computeScenarioDiff(nowWs, thenWs, OPTS);
  const thenTotal = engineTeamTotal(thenWs, 'HSU');
  const nowTotal = engineTeamTotal(nowWs, 'HSU');
  assert.ok(Math.abs(diff.totals.then - thenTotal) < EPS, `then total ${diff.totals.then} vs engine ${thenTotal}`);
  assert.ok(Math.abs(diff.totals.now - nowTotal) < EPS, `now total ${diff.totals.now} vs engine ${nowTotal}`);
  assert.ok(Math.abs(diff.totals.delta - (nowTotal - thenTotal)) < EPS, 'delta = now - then');
  assert.ok(Math.abs(thenTotal - 20) < EPS, 'expected then total 20');
  assert.ok(Math.abs(nowTotal - 14) < EPS, 'expected now total 14');
  ok('totals match independently computed engine totals (20 → 14, Δ-6)');

  // Sums of per-swimmer and per-event deltas reconcile with the total delta.
  const swimmerSum = diff.swimmers.reduce((s, r) => s + r.deltaPoints, 0);
  const eventSum = diff.events.reduce((s, r) => s + r.delta, 0);
  assert.ok(Math.abs(swimmerSum - diff.totals.delta) < EPS, 'swimmer deltas sum to total delta');
  assert.ok(Math.abs(eventSum - diff.totals.delta) < EPS, 'event deltas sum to total delta');
  ok('per-swimmer and per-event deltas each sum to the total delta');

  // --- per-swimmer rows ---
  const alice = diff.swimmers.find(s => s.name === 'Alice Adams' && !s.isRelay);
  assert.ok(alice, 'Alice row present');
  assert.ok(Math.abs(alice.pointsThen - 5) < EPS && Math.abs(alice.pointsNow - 3) < EPS);
  assert.ok(Math.abs(alice.deltaPoints - -2) < EPS, 'Alice delta -2 (individual only, no relay bleed)');
  assert.equal(alice.eventsChanged.length, 1);
  assert.equal(alice.eventsChanged[0].event, '100 Free');
  assert.equal(alice.eventsChanged[0].timeThen, '50.00');
  assert.equal(alice.eventsChanged[0].timeNow, '52.00');
  assert.deepEqual(alice.eventsAdded, []);
  assert.deepEqual(alice.eventsRemoved, []);
  ok('time-changed entry reported on the swimmer with exact then/now times');

  const bob = diff.swimmers.find(s => s.name === 'Bob Brown' && !s.isRelay);
  assert.ok(bob, 'Bob row present');
  assert.deepEqual(bob.eventsRemoved, ['200 Free']);
  assert.deepEqual(bob.eventsAdded, ['100 Back']);
  assert.ok(Math.abs(bob.deltaPoints - 0) < EPS, 'Bob nets zero (5 dropped, 5 added)');
  ok('added/removed entries reported even when the swimmer nets zero delta');

  // --- relay attribution ---
  const relayRow = diff.swimmers.find(s => s.isRelay);
  assert.ok(relayRow, 'relay row present');
  assert.equal(relayRow.name, '200 Free Relay');
  assert.ok(Math.abs(relayRow.pointsThen - 10) < EPS && Math.abs(relayRow.pointsNow - 6) < EPS);
  assert.ok(Math.abs(relayRow.deltaPoints - -4) < EPS, 'relay delta -4 on the relay row');
  assert.equal(relayRow.eventsChanged.length, 1);
  assert.equal(relayRow.eventsChanged[0].timeThen, '1:25.00');
  assert.equal(relayRow.eventsChanged[0].timeNow, '1:27.00');
  // Relay legs Carl/Dan swam only the relay → they must not appear as individuals.
  assert.ok(!diff.swimmers.some(s => !s.isRelay && s.name === 'Carl Cole'), 'no individual row for Carl');
  assert.ok(!diff.swimmers.some(s => !s.isRelay && s.name === 'Dan Drake'), 'no individual row for Dan');
  ok('relay point change attributed to the relay row, never to leg swimmers');

  // --- per-event rows ---
  const byEvent = new Map(diff.events.map(e => [e.event, e]));
  const free100 = byEvent.get('100 Free');
  assert.ok(free100 && Math.abs(free100.delta - -2) < EPS && free100.swimmersChanged === 1);
  const free200 = byEvent.get('200 Free');
  assert.ok(free200 && Math.abs(free200.pointsThen - 5) < EPS && Math.abs(free200.pointsNow - 0) < EPS);
  assert.ok(Math.abs(free200.delta - -5) < EPS && free200.swimmersChanged === 1);
  const back100 = byEvent.get('100 Back');
  assert.ok(back100 && Math.abs(back100.delta - 5) < EPS && back100.swimmersChanged === 1);
  const relayEv = byEvent.get('200 Free Relay');
  assert.ok(relayEv && Math.abs(relayEv.delta - -4) < EPS && relayEv.swimmersChanged === 1);
  ok('per-event deltas exact: 100 Free -2, 200 Free -5, 100 Back +5, relay -4');

  // Events are delta-sorted (|delta| desc); swimmers top movers first.
  for (let i = 1; i < diff.events.length; i++) {
    assert.ok(Math.abs(diff.events[i - 1].delta) >= Math.abs(diff.events[i].delta) - EPS, 'events sorted');
  }
  for (let i = 1; i < diff.swimmers.length; i++) {
    assert.ok(
      Math.abs(diff.swimmers[i - 1].deltaPoints) >= Math.abs(diff.swimmers[i].deltaPoints) - EPS,
      'swimmers sorted'
    );
  }
  ok('rows sorted by |delta| descending');
}

// --- empty diff: identical workspaces → all zeros, no rows ---
{
  const diff = computeScenarioDiff(thenWs, thenWs, OPTS);
  assert.ok(Math.abs(diff.totals.delta) < EPS, 'zero total delta');
  assert.ok(Math.abs(diff.totals.then - diff.totals.now) < EPS);
  assert.equal(diff.swimmers.length, 0, 'no swimmer rows');
  assert.equal(diff.events.length, 0, 'no event rows');
  ok('identical workspaces produce an empty diff (no rows, zero deltas)');
}

// --- settings override applies to BOTH sides (apples-to-apples) ---
{
  const weirdSnap = { ...thenWs, scoringSettings: { ...SETTINGS, scoringPoints: [100, 50, 25] } };
  const diff = computeScenarioDiff(nowWs, weirdSnap, OPTS);
  assert.ok(Math.abs(diff.totals.then - 20) < EPS, 'snapshot rescored under current settings');
  ok('opts.settings overrides the snapshot workspace settings for a fair comparison');
}

// --- client helper sync fallback (no Worker in Node) resolves identically ---
{
  const viaClient = await requestScenarioDiff(nowWs, thenWs, OPTS);
  const direct = computeScenarioDiff(nowWs, thenWs, OPTS);
  assert.deepEqual(viaClient.totals, direct.totals, 'client totals match direct compute');
  assert.equal(viaClient.swimmers.length, direct.swimmers.length);
  assert.equal(viaClient.events.length, direct.events.length);
  ok('requestScenarioDiff sync fallback matches computeScenarioDiff');
}

console.log(`\nscenario diff: ${n} checks passed`);
