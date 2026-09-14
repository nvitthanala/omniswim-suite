/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression: "Optimize team" must never lower a team total.
 *
 * BUG (P0, pre-existing): `optimizeRosterForTeam` ran its stages, scored the
 * outcome, and returned it unconditionally — it computed `previousTotal` and
 * `projectedTotal` and never compared them. On the HSU 2026-27 Roster Plan
 * workspace (214 recruits, no meet loaded) clicking the primary action on the
 * wizard step titled "Find more points" took Henderson State men from
 * **1277.00 to 0.00**, with no warning and no undo path in the UI.
 *
 * Mechanism, for anyone tempted to "simplify" the guard away: on a workspace
 * with no PDF rows every recruit is ranked 1 in every event, so one event is
 * one tie group. Two all-or-nothing gates over that group each turned a
 * per-athlete eligibility question into a whole-event one — the roster gate
 * (fixed 2026-08-16) and the scorer-pool gate (fixed 2026-08-30) — and either
 * of them could take a stage's candidate to 0.
 *
 * BOTH ARE FIXED, and the guard still earns its place: this file proves it by
 * checking `unguardedTotal` on a live candidate that STILL loses points. A
 * stage can lower a total for ordinary reasons — benching an athlete forfeits
 * their share, and a swap can be worse than what it replaced — so "the stages
 * are safe now" is not a reason to drop the comparison.
 *
 * Fixtures here are hermetic and generated in-process. They must NOT read
 * data/omniswim.db or data/meets.json — the point is that CI fails when the
 * guard regresses, not when the user's workspace changes.
 *
 * Test: npx tsx scripts/test_optimizer_never_loses.mjs
 */
import assert from 'node:assert/strict';
import { optimizeRosterForTeam } from '../packages/core/src/lib/rosterOptimizer.ts';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { ClassYear, Gender } from '../packages/core/src/types.ts';

const TEAM = 'Henderson State University';
const RIVAL = 'Ouachita Baptist University';

/** Deterministic time string: seconds -> "M:SS.hh" / "SS.hh". */
function secondsToTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${ss}` : ss;
}

// ---------------------------------------------------------------------------
// Fixture 1 — recruit-only workspace, no meet loaded. The shape that went to 0.
//
// 22 athletes on one team is deliberate: NSISC caps individual scorers at 18, so
// the scorers stage must turn 4 of them off, and `mergeScoringSettings` forces
// that 18 back on any NSISC workspace — a fixture that lowered the cap instead
// would not reproduce the bug.
// ---------------------------------------------------------------------------
const ROSTER_EVENTS = ['50 Freestyle', '100 Freestyle', '100 Backstroke'];

function buildRosterOnlyWorkspace() {
  const recruits = [];
  for (let i = 0; i < 22; i++) {
    ROSTER_EVENTS.forEach((event, e) => {
      recruits.push({
        id: `rec-${i}-${e}`,
        name: `Athlete ${String(i).padStart(2, '0')}`,
        team: TEAM,
        event,
        // Spread times so rank order is stable and every athlete is distinct.
        time: secondsToTime(21 + e * 25 + i * 0.31),
        gender: Gender.MEN,
        classYear: ClassYear.FR,
        timeType: 'SCY',
      });
    });
  }
  return {
    id: 'ws-roster-only',
    name: 'Roster Plan (no meet)',
    createdAt: 1,
    conference: 'NSISC',
    menResults: [],
    womenResults: [],
    recruits,
    athleteHistory: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides: [],
    meetEntryPlans: [
      {
        id: 'plan-keep-1',
        name: 'Athlete 00',
        team: TEAM,
        gender: Gender.MEN,
        classYear: ClassYear.FR,
        event: '200 Freestyle',
        time: '1:42.00',
        source: 'manual',
        active: true,
      },
    ],
    activeEntryIds: ['plan-keep-1'],
  };
}

// ---------------------------------------------------------------------------
// Fixture 2 — meet loaded. The optimizer genuinely gains here and must keep
// doing so: a guard that neuters real improvements is the same defect wearing a
// different hat.
// ---------------------------------------------------------------------------
const MEET_EVENTS = ['50 Freestyle', '100 Freestyle', '200 Freestyle', '100 Butterfly'];

function buildMeetWorkspace() {
  const menResults = [];
  let id = 0;
  for (const [e, event] of MEET_EVENTS.entries()) {
    // Both teams contest every event, so the whole program is enterable and the
    // field is deep enough that an added swim has to earn its place.
    //
    // INTERLEAVED, and that is load-bearing. `seconds` below is a function of
    // the index in THIS array, so pushing all of HSU and then all of OBU handed
    // HSU places 1-4 of 8 in every event — a clean sweep. Stage B could then
    // improve nothing by placement, and the only "gain" the optimizer could
    // report was the phantom one it used to get from entering each athlete
    // twice (272.00 -> 484.00 on this fixture before the projection reconciled
    // its planes). Alternating the two teams gives HSU the odd places, so a
    // faster history time has somewhere real to move.
    const field = [];
    for (let i = 0; i < 4; i++) {
      field.push({ team: TEAM, i });
      field.push({ team: RIVAL, i });
    }
    field
      .map((entry, k) => ({
        ...entry,
        seconds: 21 + e * 22 + k * 0.4 + (entry.team === RIVAL ? 0.15 : 0),
      }))
      .sort((a, b) => a.seconds - b.seconds)
      .forEach((entry, k) => {
        menResults.push({
          id: `pdf-${id++}`,
          rank: k + 1,
          name: `${entry.team === TEAM ? 'Hsu' : 'Obu'} Swimmer ${entry.i}`,
          classYear: ClassYear.SO,
          team: entry.team,
          time: secondsToTime(entry.seconds),
          finalsTime: secondsToTime(entry.seconds),
          roundSwam: 'A Final',
          points: 0,
          event,
          gender: Gender.MEN,
        });
      });
  }

  // History the meet does not know about: every HSU athlete is faster than the
  // time the meet has for them, and faster than the OBU swimmer placed directly
  // above them. Stage B is what surfaces these, and the gain is a real change of
  // places — HSU moves from the odd places to a sweep.
  const athleteHistory = [];
  for (let i = 0; i < 4; i++) {
    for (const [e, event] of MEET_EVENTS.entries()) {
      athleteHistory.push({
        name: `Hsu Swimmer ${i}`,
        team: TEAM,
        gender: Gender.MEN,
        event,
        time: secondsToTime(20.4 + e * 22 + i * 0.2),
        timeType: 'SCY',
        source: 'paste',
      });
    }
  }

  return {
    id: 'ws-meet',
    name: 'Meet Workspace',
    createdAt: 1,
    conference: 'NSISC',
    menResults,
    womenResults: [],
    recruits: [],
    athleteHistory,
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides: [],
    meetEntryPlans: [],
    activeEntryIds: [],
  };
}

const rosterWs = buildRosterOnlyWorkspace();
const rosterSettings = mergeScoringSettings(rosterWs.scoringSettings, { conference: 'NSISC' });
const rosterResult = optimizeRosterForTeam(rosterWs, Gender.MEN, TEAM, false, rosterSettings, 'all');

const meetWs = buildMeetWorkspace();
const meetSettings = mergeScoringSettings(meetWs.scoringSettings, { conference: 'NSISC' });
const meetResult = optimizeRosterForTeam(meetWs, Gender.MEN, TEAM, false, meetSettings, 'all');

// --- 1. The fixture actually reproduces the bug, or it proves nothing ---
// Without this the whole file can pass against a workspace that never scored in
// the first place — the "silent empty result" failure mode. previousTotal must
// be a real, positive projection, and the UNGUARDED chain must still destroy it.
assert.ok(
  rosterResult.previousTotal > 0,
  `roster fixture must score before optimizing, got ${rosterResult.previousTotal}`
);
assert.equal(typeof rosterResult.unguardedTotal, 'number', 'unguardedTotal is reported');
assert.ok(
  rosterResult.unguardedTotal < rosterResult.previousTotal,
  `fixture no longer reproduces the defect: unguarded ${rosterResult.unguardedTotal} ` +
    `is not below previous ${rosterResult.previousTotal}`
);

// --- 2. A recruit-only workspace never comes back worse ---
assert.ok(
  rosterResult.projectedTotal >= rosterResult.previousTotal,
  `optimizer lowered the team total: ${rosterResult.previousTotal} -> ${rosterResult.projectedTotal}`
);

// --- 3. "Changed nothing" is distinguishable from "improved" ---
assert.ok(
  ['improved', 'unchanged'].includes(rosterResult.outcome),
  `outcome must be set, got ${rosterResult.outcome}`
);
if (rosterResult.outcome === 'unchanged') {
  assert.equal(
    rosterResult.projectedTotal,
    rosterResult.previousTotal,
    'unchanged must report projected === previous'
  );
  assert.equal(rosterResult.appliedStages, 'none', 'unchanged must apply no stage');
} else {
  assert.ok(
    rosterResult.projectedTotal > rosterResult.previousTotal,
    'improved must report a strict gain'
  );
  assert.notEqual(rosterResult.appliedStages, 'none', 'improved must name the stage it applied');
}

// --- 4. When the guard trips, the caller's state comes back untouched ---
// Not a half-applied hybrid: the overrides the scorers stage proposed must not
// leak out alongside the original plans.
const guardedWs = buildRosterOnlyWorkspace();
// 'events' in isolation is the stage that still produces a losing candidate on
// this workspace, so it is the one refusal guaranteed to happen — which is what
// makes it the right probe for what a refusal hands back.
//
// It used to be 'scorers', because the scorers stage destroyed this workspace:
// it wrote 4 OFF overrides against an engine that had never capped the roster,
// and one non-poolable athlete then zeroed every teammate in the event. Since
// the scorer pool started admitting per athlete (2026-08-30) that stage neither
// gains nor loses here — it ties at previousTotal — so probing with it would
// assert nothing. The guard is unchanged; only which candidate exercises it is.
const held = optimizeRosterForTeam(guardedWs, Gender.MEN, TEAM, false, rosterSettings, 'events');
assert.equal(held.outcome, 'unchanged', 'the losing stage must be refused');
assert.equal(held.appliedStages, 'none');
assert.equal(held.projectedTotal, held.previousTotal);
assert.deepEqual(
  held.overrides,
  guardedWs.scorerRosterOverrides,
  'refused result must return the original overrides'
);
assert.deepEqual(
  held.meetEntryPlans,
  guardedWs.meetEntryPlans,
  'refused result must return the original plans'
);
assert.deepEqual(
  held.activeEntryIds,
  guardedWs.activeEntryIds,
  'refused result must return the original activeEntryIds'
);
assert.ok(
  held.unguardedTotal < held.previousTotal,
  'the refused candidate is the one that would have lowered the total'
);

// --- 5. A workspace with a meet loaded still gains ---
assert.ok(
  meetResult.previousTotal > 0,
  `meet fixture must score before optimizing, got ${meetResult.previousTotal}`
);
assert.equal(meetResult.outcome, 'improved', 'the guard must not neuter a real improvement');
assert.ok(
  meetResult.projectedTotal > meetResult.previousTotal,
  `meet workspace must gain: ${meetResult.previousTotal} -> ${meetResult.projectedTotal}`
);
assert.notEqual(meetResult.appliedStages, 'none');
assert.notDeepEqual(
  meetResult.meetEntryPlans,
  meetWs.meetEntryPlans,
  'an improved result must actually change something'
);

// --- 6. Every stage selector is guarded, not just 'all' ---
for (const ws of [rosterWs, meetWs]) {
  const settings = ws === rosterWs ? rosterSettings : meetSettings;
  for (const stage of ['scorers', 'events', 'hypothetical', 'all']) {
    const r = optimizeRosterForTeam(ws, Gender.MEN, TEAM, false, settings, stage);
    assert.ok(
      r.projectedTotal >= r.previousTotal,
      `${ws.id} stage '${stage}' lowered the total: ${r.previousTotal} -> ${r.projectedTotal}`
    );
    assert.ok(['improved', 'unchanged'].includes(r.outcome), `${ws.id} '${stage}' outcome missing`);
    if (r.outcome === 'unchanged') {
      assert.deepEqual(r.overrides, ws.scorerRosterOverrides ?? [], `${ws.id} '${stage}' overrides`);
      assert.deepEqual(r.meetEntryPlans, ws.meetEntryPlans ?? [], `${ws.id} '${stage}' plans`);
      assert.deepEqual(r.activeEntryIds, ws.activeEntryIds ?? [], `${ws.id} '${stage}' activeEntryIds`);
    }
  }
}

// --- 7. The optimizer does not mutate the workspace it was handed ---
assert.deepEqual(rosterWs.meetEntryPlans, buildRosterOnlyWorkspace().meetEntryPlans);
assert.deepEqual(rosterWs.scorerRosterOverrides, []);
assert.deepEqual(rosterWs.activeEntryIds, ['plan-keep-1']);

console.log(
  `  roster-only: ${rosterResult.previousTotal.toFixed(2)} -> ${rosterResult.projectedTotal.toFixed(2)}` +
    ` (${rosterResult.outcome}, unguarded would have been ${rosterResult.unguardedTotal.toFixed(2)})`
);
console.log(
  `  meet loaded: ${meetResult.previousTotal.toFixed(2)} -> ${meetResult.projectedTotal.toFixed(2)}` +
    ` (${meetResult.outcome} via ${meetResult.appliedStages})`
);
console.log('optimizer never loses: all assertions passed');
