/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression: `optimizeWithArbitrage` must never lower a team total either.
 *
 * BUG (P0, found 2026-08-30 by the test-coverage audit):
 * `optimizeRosterForTeam` was given a never-loses guard, and
 * `optimizeWithArbitrage` — a SECOND entry point into the same optimizer stages,
 * behind the same "Optimize team" button in the Manager wizard — did not get one.
 * It computed `previousTotal`, computed `projectedTotal`, and returned
 * unconditionally. It never compared them, reported no `outcome` and no
 * `appliedStages`, so a caller could not tell a refusal from an improvement.
 *
 * Measured on the recruit-only fixture below, which is copied UNCHANGED from
 * scripts/test_optimizer_never_loses.mjs so the two entry points are compared on
 * identical input:
 *
 *   optimizeRosterForTeam  (GUARDED)          400.45 -> 400.45   outcome=unchanged
 *   optimizeWithArbitrage  (individual_first) 400.45 -> 380.45   LOWERED THE TOTAL
 *   optimizeWithArbitrage  (relay_first)      400.45 -> 380.45   LOWERED THE TOTAL
 *
 * Same workspace, same settings, same seconds. The guarded path refused the
 * losing candidate; the unguarded twin handed back a lineup worth 20 points less
 * and called it an optimization. Nothing threw, and a coach could act on it.
 *
 * WHY THIS FILE IS SEPARATE from test_optimizer_never_loses.mjs: that file pins
 * `optimizeRosterForTeam`, and the two entry points now differ in their
 * candidate generation (this one's lineup stage varies by `mode`) even though
 * they share one guard. Keeping them apart means a change to either stage names
 * the entry point it broke.
 *
 * WHAT WOULD FAIL IF THE GUARD WERE REMOVED: section 2's
 * `projectedTotal >= previousTotal`. Section 1 keeps that honest by proving the
 * fixture still produces a LOSING candidate — without it the whole file would
 * pass against a workspace where nothing could go wrong, which is the silent
 * empty-result failure mode.
 *
 * Absolute point values are deliberately NOT asserted. The scoring substrate
 * (whatIfProjection, the scorer pool) is under active change, and pinning 400.45
 * here would make this file fail for reasons that have nothing to do with the
 * guard. The invariants are what matter and they hold at any scoring level.
 *
 * Fixtures are hermetic and generated in-process. They must NOT read
 * data/omniswim.db or data/meets.json.
 *
 * Test: npx tsx scripts/test_arbitrage_never_loses.mjs
 */
import assert from 'node:assert/strict';
import {
  buildArbitrageCards,
  optimizeWithArbitrage,
} from '../packages/core/src/lib/rosterArbitrage.ts';
import {
  optimizeRosterForTeam,
  selectGuardedResult,
} from '../packages/core/src/lib/rosterOptimizer.ts';
import {
  NSISC_PRESET_SETTINGS,
  mergeScoringSettings,
} from '../packages/core/src/lib/scoringDefaults.ts';
import { ClassYear, Gender } from '../packages/core/src/types.ts';

const MODES = ['individual_first', 'relay_first'];

/** Deterministic time string: seconds -> "M:SS.hh" / "SS.hh". */
function secondsToTime(seconds) {
  const m = Math.floor(seconds / 60);
  const ss = (seconds - m * 60).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${ss}` : ss;
}

// ---------------------------------------------------------------------------
// Fixture 1 — recruit-only workspace, no meet loaded. Copied verbatim from
// scripts/test_optimizer_never_loses.mjs; do not "tidy" the numbers, they are
// what makes the losing candidate appear.
//
// 22 athletes on one team is deliberate: NSISC caps individual scorers at 18, so
// the scorers stage must turn 4 of them off, and `mergeScoringSettings` forces
// that 18 back on any NSISC workspace.
// ---------------------------------------------------------------------------
const LOSS_TEAM = 'Henderson State University';
const ROSTER_EVENTS = ['50 Freestyle', '100 Freestyle', '100 Backstroke'];

function buildRosterOnlyWorkspace() {
  const recruits = [];
  for (let i = 0; i < 22; i += 1) {
    ROSTER_EVENTS.forEach((event, e) => {
      recruits.push({
        id: `rec-${i}-${e}`,
        name: `Athlete ${String(i).padStart(2, '0')}`,
        team: LOSS_TEAM,
        event,
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
        team: LOSS_TEAM,
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
// Fixture 2 — a team that is genuinely under-entered. The optimizer MUST gain
// here: a guard that neuters real improvements is the same defect wearing a
// different hat, and a file that only ever observes refusals cannot tell a
// working guard from a function that returns its input.
//
// One Team A swimmer contests each event, but history says four of them are
// faster than the entered one in every event, and Team B's field is shallow
// enough that the places are there to take.
// ---------------------------------------------------------------------------
const GAIN_TEAM = 'Team A';
const GAIN_RIVAL = 'Team B';
const GAIN_EVENTS = ['50 Freestyle', '100 Freestyle', '200 Freestyle', '100 Butterfly'];

function buildUnderEnteredWorkspace() {
  const menResults = [];
  let id = 0;
  for (const [e, event] of GAIN_EVENTS.entries()) {
    const rows = [{ team: GAIN_TEAM, who: `A Swimmer ${e}`, seconds: 21 + e * 22 }];
    for (let k = 0; k < 6; k += 1) {
      rows.push({ team: GAIN_RIVAL, who: `B Swimmer ${k}`, seconds: 21 + e * 22 + 1.5 + k * 0.4 });
    }
    rows
      .sort((a, b) => a.seconds - b.seconds)
      .forEach((r, k) => {
        menResults.push({
          id: `pdf-${id++}`,
          rank: k + 1,
          name: r.who,
          classYear: ClassYear.SO,
          team: r.team,
          time: secondsToTime(r.seconds),
          finalsTime: secondsToTime(r.seconds),
          roundSwam: 'A Final',
          points: 0,
          event,
          gender: Gender.MEN,
          isRelay: false,
        });
      });
  }

  const athleteHistory = [];
  for (let i = 0; i < GAIN_EVENTS.length; i += 1) {
    for (const [e, event] of GAIN_EVENTS.entries()) {
      athleteHistory.push({
        name: `A Swimmer ${i}`,
        team: GAIN_TEAM,
        gender: Gender.MEN,
        event,
        time: secondsToTime(20.5 + e * 22 + i * 0.1),
        timeType: 'SCY',
        source: 'paste',
      });
    }
  }

  return {
    id: 'ws-under-entered',
    name: 'Under-entered team',
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

const lossSettings = mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' });
const gainSettings = lossSettings;

const report = [];

// ---------------------------------------------------------------------------
// 1. The fixture reproduces the defect, or this file proves nothing.
//
// `unguardedTotal` is what the pre-guard code returned: the fully chained
// scorers+events candidate, accepted or not. It must still be BELOW the starting
// total, otherwise section 2 is asserting against a workspace where no stage
// could lose and the guard is never exercised.
// ---------------------------------------------------------------------------
for (const mode of MODES) {
  const ws = buildRosterOnlyWorkspace();
  const res = optimizeWithArbitrage(ws, Gender.MEN, LOSS_TEAM, false, lossSettings, mode);

  assert.ok(
    Number.isFinite(res.previousTotal),
    `${mode}: previousTotal must be a real number, got ${res.previousTotal}`
  );
  assert.ok(
    res.previousTotal > 0,
    `${mode}: fixture must score before optimizing, got ${res.previousTotal}`
  );
  assert.ok(
    Number.isFinite(res.unguardedTotal),
    `${mode}: unguardedTotal must be reported as a real number, got ${res.unguardedTotal}`
  );
  assert.ok(
    res.unguardedTotal < res.previousTotal,
    `${mode}: fixture no longer reproduces the defect — unguarded ${res.unguardedTotal} ` +
      `is not below previous ${res.previousTotal}`
  );

  // ---------------------------------------------------------------------
  // 2. THE REGRESSION ASSERTION. Pre-fix this read 400.45 -> 380.45.
  // ---------------------------------------------------------------------
  assert.ok(
    Number.isFinite(res.projectedTotal),
    `${mode}: projectedTotal must be a real number, got ${res.projectedTotal}`
  );
  assert.ok(
    res.projectedTotal >= res.previousTotal,
    `${mode}: arbitrage optimizer lowered the team total: ` +
      `${res.previousTotal} -> ${res.projectedTotal}`
  );

  // 3. A refusal is distinguishable from an improvement, and hands the
  //    caller's own state back — not a half-applied hybrid carrying the
  //    overrides the losing candidate proposed.
  assert.equal(res.mode, mode, `${mode}: mode round-trips`);
  assert.ok(
    ['improved', 'unchanged'].includes(res.outcome),
    `${mode}: outcome must be set, got ${res.outcome}`
  );
  assert.equal(res.outcome, 'unchanged', `${mode}: the losing candidate must be refused`);
  assert.equal(res.appliedStages, 'none', `${mode}: a refusal applies no stage`);
  assert.equal(
    res.projectedTotal,
    res.previousTotal,
    `${mode}: unchanged must report projected === previous`
  );
  assert.deepEqual(
    res.overrides,
    buildRosterOnlyWorkspace().scorerRosterOverrides,
    `${mode}: a refusal must return the caller's overrides`
  );
  assert.deepEqual(
    res.meetEntryPlans,
    buildRosterOnlyWorkspace().meetEntryPlans,
    `${mode}: a refusal must return the caller's plans`
  );
  assert.deepEqual(
    res.activeEntryIds,
    buildRosterOnlyWorkspace().activeEntryIds,
    `${mode}: a refusal must return the caller's activeEntryIds`
  );

  // 4. The cards describe the lineup that was RETURNED, not the one that lost.
  //    Advice about a roster the coach does not have is worse than no advice.
  assert.deepEqual(
    res.cards,
    buildArbitrageCards(
      {
        ...buildRosterOnlyWorkspace(),
        scorerRosterOverrides: res.overrides,
        meetEntryPlans: res.meetEntryPlans,
        activeEntryIds: res.activeEntryIds,
      },
      Gender.MEN,
      LOSS_TEAM,
      lossSettings
    ),
    `${mode}: cards must be built from the returned state`
  );
  for (const card of res.cards) {
    assert.ok(
      Number.isFinite(card.arbitragePts),
      `${mode}: every card states a finite point value, got ${card.arbitragePts}`
    );
  }

  // 5. The optimizer does not mutate the workspace it was handed.
  assert.deepEqual(ws.scorerRosterOverrides, [], `${mode}: input overrides not mutated`);
  assert.deepEqual(
    ws.meetEntryPlans,
    buildRosterOnlyWorkspace().meetEntryPlans,
    `${mode}: input plans not mutated`
  );
  assert.deepEqual(ws.activeEntryIds, ['plan-keep-1'], `${mode}: input activeEntryIds not mutated`);

  report.push(
    `  recruit-only ${mode.padEnd(16)} ${res.previousTotal.toFixed(2)} -> ` +
      `${res.projectedTotal.toFixed(2)} (${res.outcome}, unguarded would have been ` +
      `${res.unguardedTotal.toFixed(2)})`
  );
}

// ---------------------------------------------------------------------------
// 6. Both entry points measure the SAME starting total on the same input.
//
// The guard compares two numbers, so it is only as sound as the agreement
// between them. `optimizeWithArbitrage` used to score with a private copy of the
// team-total function that ignored `removeSeniors`; both now call
// `teamTotalForTeam`. If these two ever disagree, one of the buttons is guarding
// against a baseline the other does not recognise.
// ---------------------------------------------------------------------------
{
  const guarded = optimizeRosterForTeam(
    buildRosterOnlyWorkspace(),
    Gender.MEN,
    LOSS_TEAM,
    false,
    lossSettings,
    'all'
  );
  const arb = optimizeWithArbitrage(
    buildRosterOnlyWorkspace(),
    Gender.MEN,
    LOSS_TEAM,
    false,
    lossSettings,
    'individual_first'
  );
  assert.equal(
    arb.previousTotal,
    guarded.previousTotal,
    'both optimizer entry points must measure the same starting total'
  );
  assert.ok(
    arb.projectedTotal >= guarded.previousTotal,
    'the arbitrage path must not end below where the guarded sibling starts'
  );
}

// ---------------------------------------------------------------------------
// 7. A real improvement still lands. Both modes, unconditionally.
// ---------------------------------------------------------------------------
for (const mode of MODES) {
  const ws = buildUnderEnteredWorkspace();
  const res = optimizeWithArbitrage(ws, Gender.MEN, GAIN_TEAM, false, gainSettings, mode);

  assert.ok(
    res.previousTotal > 0,
    `${mode}: gain fixture must score before optimizing, got ${res.previousTotal}`
  );
  assert.equal(
    res.outcome,
    'improved',
    `${mode}: the guard must not neuter a real improvement ` +
      `(${res.previousTotal} -> ${res.projectedTotal})`
  );
  assert.ok(
    res.projectedTotal > res.previousTotal,
    `${mode}: improved must report a strict gain, got ${res.previousTotal} -> ${res.projectedTotal}`
  );
  assert.notEqual(res.appliedStages, 'none', `${mode}: improved must name the stage it applied`);
  assert.ok(
    res.meetEntryPlans.length > 0,
    `${mode}: an applied lineup must actually contain entries`
  );
  assert.notDeepEqual(
    res.meetEntryPlans,
    ws.meetEntryPlans,
    `${mode}: an improved result must actually change something`
  );

  // Every active id must name a plan that exists — a dangling id silently drops
  // a swimmer from the lineup.
  const planIds = new Set(res.meetEntryPlans.map(p => p.id));
  for (const activeId of res.activeEntryIds ?? []) {
    assert.ok(planIds.has(activeId), `${mode}: activeEntryIds references a missing plan ${activeId}`);
  }

  assert.deepEqual(ws.meetEntryPlans, [], `${mode}: gain fixture input plans not mutated`);
  assert.deepEqual(ws.scorerRosterOverrides, [], `${mode}: gain fixture input overrides not mutated`);

  report.push(
    `  under-entered ${mode.padEnd(15)} ${res.previousTotal.toFixed(2)} -> ` +
      `${res.projectedTotal.toFixed(2)} (${res.outcome} via ${res.appliedStages})`
  );
}

// ---------------------------------------------------------------------------
// 8. The shared guard itself, on synthetic candidates.
//
// Sections 1-7 run the guard through the scoring engine, so what they can assert
// moves when the engine moves. This section pins the decision rule directly and
// deterministically: strict improvement wins, a tie is refused as churn, and a
// refusal returns the base state by identity rather than a rebuilt copy.
// ---------------------------------------------------------------------------
{
  const base = {
    overrides: [{ name: 'Keep Me', team: 'T', gender: Gender.MEN, isScorer: true }],
    plans: [{ id: 'p0' }],
    activeIds: ['p0'],
    total: 100,
  };
  const candidate = (appliedStages, total) => ({
    appliedStages,
    overrides: [],
    plans: [{ id: `${appliedStages}-plan` }],
    activeIds: [`${appliedStages}-plan`],
    total,
  });

  // Picks the highest strict improvement, not merely the first or the last.
  const best = selectGuardedResult(
    base,
    [candidate('scorers', 130), candidate('scorers+events', 180), candidate('events', 150)],
    180
  );
  assert.equal(best.outcome, 'improved', 'a strictly better candidate is accepted');
  assert.equal(best.appliedStages, 'scorers+events', 'the highest-scoring candidate wins');
  assert.equal(best.projectedTotal, 180);
  assert.equal(best.previousTotal, 100);
  assert.equal(best.unguardedTotal, 180, 'unguardedTotal is reported verbatim');

  // A loss is refused, and the base state comes back untouched.
  const lost = selectGuardedResult(base, [candidate('scorers+events', 80)], 80);
  assert.equal(lost.outcome, 'unchanged', 'a losing candidate is refused');
  assert.equal(lost.appliedStages, 'none');
  assert.equal(lost.projectedTotal, 100);
  assert.equal(lost.previousTotal, 100);
  assert.equal(lost.unguardedTotal, 80, 'the refused total is still reported for diagnosis');
  assert.equal(lost.overrides, base.overrides, 'a refusal returns the caller\'s overrides');
  assert.equal(lost.meetEntryPlans, base.plans, 'a refusal returns the caller\'s plans');
  assert.equal(lost.activeEntryIds, base.activeIds, 'a refusal returns the caller\'s activeEntryIds');

  // An exact tie is churn, not an improvement: changing a coach's lineup has a
  // cost even when the number does not move.
  const tied = selectGuardedResult(base, [candidate('events', 100)], 100);
  assert.equal(tied.outcome, 'unchanged', 'an equal-scoring reshuffle is refused as churn');
  assert.equal(tied.appliedStages, 'none');

  // Float dust is not a gain either.
  const dust = selectGuardedResult(base, [candidate('events', 100 + 1e-9)], 100 + 1e-9);
  assert.equal(dust.outcome, 'unchanged', 'a sub-epsilon gain is refused');

  // No candidates at all is a refusal, never a crash.
  const none = selectGuardedResult(base, [], 100);
  assert.equal(none.outcome, 'unchanged', 'an empty candidate list is a refusal');
  assert.equal(none.appliedStages, 'none');
}

for (const line of report) console.log(line);
console.log('arbitrage never loses: all assertions passed');
