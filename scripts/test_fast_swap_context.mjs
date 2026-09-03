/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The incremental fast swap/drop/add context must actually ENGAGE, not just be
 * correct.
 *
 * WHY THIS TEST EXISTS. `buildFastSwapContext` fails CLOSED: every gate inside
 * it returns null, and every caller then falls back to a full re-score. A bug
 * in its modelling therefore never produces a wrong number — it produces the
 * right number several seconds later, which no correctness test can see. That
 * is exactly what happened: from 2026-07-20 to 2026-08-16 the context returned
 * null on the primary HSU/NSISC workspace and `rankExactSwaps` silently ran
 * 849 full re-scores (~6 s, ~7 ms/candidate), while the existing suite stayed
 * green because the fallback is correct.
 *
 * THE BUG IT GUARDS. `calculatePoints` awards placement points per ROW
 * (`members.forEach(r => ... points: each)` in scoreIndividualsInEvent) but
 * consumes scorer-pool weight per DISTINCT NAME (`uniqueNames`). The sweep that
 * reproduces the meet-wide pool awarded per name, so any placement where a team
 * holds more rows than distinct swimmers — an athlete carried as both a recruit
 * row and an active plan, a duplicate import, a prelims/finals pair landing on
 * one key — under-counted. The self-validation then rejected the context.
 *
 * Both cases below hold MORE ROWS THAN NAMES at a scoring placement. If the
 * sweep ever reverts to per-name awards, case 1 fails on the assertion that the
 * context is non-null.
 *
 * Test: npx tsx scripts/test_fast_swap_context.mjs
 */
import assert from 'node:assert/strict';
import { buildFastSwapContext, teamTotal } from '../packages/core/src/lib/arbitrage/shared.ts';
import { rankExactSwaps } from '../packages/core/src/lib/crossCourseArbitrage.ts';
import { buildWhatIfProjection } from '../packages/core/src/lib/whatIfProjection.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Alpha';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** Meet-wide scorer pool that BINDS — the regime the sweep exists to model. */
const POOL_SETTINGS = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  // 4 = enough pool weight to reach Alpha One's duplicated placement (50 Free
  // sorts fourth in meet order here), few enough that Alpha Five is blocked in
  // the last event — so both the scoring and the blocking branch are exercised.
  maxIndividualScorersPerTeam: 4,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'meet',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 3,
  maxRelayEntriesPerSwimmer: 4,
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

function hist(name, event, time) {
  return {
    name,
    team: TEAM,
    gender: MEN,
    event,
    time,
    timeType: 'SCY',
    source: 'paste',
    date: 'Feb 1, 2026',
    meetLabel: 'Fixture',
  };
}

function baseWorkspace(overrides = {}) {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    scoringSettings: POOL_SETTINGS,
    conference: undefined,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
    ...overrides,
  };
}

function recruit(id, name, event, time) {
  return { id, name, team: TEAM, gender: MEN, classYear: 'JR', event, time, timeType: 'SCY' };
}

function plan(id, name, event, time) {
  return {
    id,
    name,
    team: TEAM,
    gender: MEN,
    classYear: 'JR',
    event,
    time,
    timeType: 'SCY',
    source: 'optimizer',
    active: true,
  };
}

/**
 * THE SHAPE THAT BREAKS A PER-NAME SWEEP. Alpha One is carried as TWO recruit
 * rows for 50 Freestyle at the same time.
 *
 * Why it lands on ONE placement: `prepareRecruitsForScoring` places recruit rows
 * fastest first and shares a place on an exact time tie, so two rows at 20.10
 * receive the SAME rank. That placement then holds two rows and one distinct
 * name — `calculatePoints` pays both rows, the scorer pool charges one name.
 * (Before 2026-09-02 they collided for a different reason — each row was ranked
 * against the PDF comparators alone, so ANY two recruits sharing an insertion
 * slot tied, whatever their times. Equal times are the only cause now; see
 * scripts/test_recruit_placement_grid.mjs.)
 *
 * (A plain duplicated RESULT row does not reproduce it: projectRanksInField
 * assigns sequential ranks to equal times, splitting the pair across two
 * placements.)
 *
 * WHY TWO RECRUIT ROWS AND NOT recruit+plan. This fixture used to pair a recruit
 * row with an active optimizer plan — "the exact shape the live HSU workspace
 * holds for five men". That shape was the duplication bug itself: the projection
 * composed its three planes without reconciling them, so one athlete held two
 * entries in one event and scored twice. `buildWhatIfProjection` now collapses a
 * cross-plane duplicate down to the most explicit plane, and
 * `buildFastSwapContext` refuses to engage when it does (§4 below). Two rows on
 * ONE plane are deliberately left alone — that is a duplicate import, not a
 * lineup decision — so this fixture still holds more rows than names.
 */
function duplicateRowWorkspace(extra = {}) {
  return baseWorkspace({
    menResults: [
      result('a2', 'Alpha Two', TEAM, '100 Backstroke', '50.00', { rank: 1, roundSwam: 'A Final' }),
      result('a3', 'Alpha Three', TEAM, '100 Butterfly', '49.50', { rank: 1, roundSwam: 'A Final' }),
      result('a4', 'Alpha Four', TEAM, '200 Freestyle', '1:42.00', { rank: 2, roundSwam: 'A Final' }),
      result('b1', 'Beta One', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', '100 Backstroke', '51.00', { rank: 2, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '100 Butterfly', '50.10', { rank: 2, roundSwam: 'A Final' }),
      result('b4', 'Beta Four', 'Beta', '200 Freestyle', '1:41.00', { rank: 1, roundSwam: 'A Final' }),
      result('b5', 'Beta Five', 'Beta', '200 Backstroke', '1:50.00', { rank: 1, roundSwam: 'A Final' }),
      result('b6', 'Beta Six', 'Beta', '50 Freestyle', '20.90', { rank: 2, roundSwam: 'A Final' }),
      // 200 Backstroke sorts last: Alpha Five arrives with the pool already full.
      result('a5', 'Alpha Five', TEAM, '200 Backstroke', '1:49.00', { rank: 1, roundSwam: 'A Final' }),
    ],
    // Alpha One twice in 50 Free (two recruit rows, identical time).
    recruits: [
      recruit('r1', 'Alpha One', '50 Freestyle', '20.10'),
      recruit('r1b', 'Alpha One', '50 Freestyle', '20.10'),
    ],
    // Candidate add-events for the swap enumeration.
    athleteHistory: [
      hist('Alpha One', '50 Freestyle', '20.10'),
      hist('Alpha One', '100 Freestyle', '44.00'),
      hist('Alpha One', '100 Butterfly', '48.90'),
      hist('Alpha Two', '200 Backstroke', '1:47.00'),
      hist('Alpha Two', '100 Backstroke', '50.00'),
      hist('Alpha Three', '50 Freestyle', '20.30'),
      hist('Alpha Three', '100 Butterfly', '49.50'),
      hist('Alpha Four', '100 Freestyle', '45.50'),
      hist('Alpha Four', '200 Freestyle', '1:42.00'),
      hist('Alpha Five', '200 Backstroke', '1:49.00'),
      hist('Alpha Five', '100 Backstroke', '50.40'),
    ],
    ...extra,
  });
}

/** Same workspace with the duplicate reduced to a single row. */
function singleRowWorkspace() {
  return duplicateRowWorkspace({
    recruits: [recruit('r1', 'Alpha One', '50 Freestyle', '20.10')],
  });
}

// --- 1. the context ENGAGES on a duplicated-placement workspace -------------
{
  const ws = duplicateRowWorkspace();
  const merged = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  const hint = [...ws.menResults, ...ws.womenResults];

  // Preconditions: the cheap gates must all pass, so a null here can only come
  // from the sweep self-validation.
  assert.equal(merged.scorerCapScope, 'meet', 'meet-wide pool regime');
  assert.ok((merged.maxIndividualScorersPerTeam ?? 999) < 999, 'cap binds');
  assert.notEqual(merged.relayEligibleFromScorerPool, true, 'relay pool rule off');
  assert.equal(ws.entryPlanMode ?? 'overlay', 'overlay', 'overlay entry-plan mode');
  assert.equal(ws.scoringView ?? 'merged', 'merged', 'merged scoring view');

  const ctx = buildFastSwapContext(ws, TEAM, MEN, merged, hint);
  assert.ok(
    ctx != null,
    'buildFastSwapContext returned null on a duplicated-placement workspace — the ' +
      'sweep no longer reproduces calculatePoints. Most likely TeamScoreGroup went ' +
      'back to awarding points per distinct name instead of per row (ptsTotal).'
  );
  assert.equal(typeof ctx.newTotalFor, 'function');
  assert.equal(typeof ctx.dropOnlyTotalFor, 'function');
  assert.equal(typeof ctx.addOnlyTotalFor, 'function');
  ok('fast context engages when a team holds more rows than names at one placement');
}

// --- 2. engaged fast path is byte-identical to the full re-score ------------
{
  const ws = duplicateRowWorkspace();
  const fast = rankExactSwaps(ws, { team: TEAM, gender: MEN, settings: POOL_SETTINGS });
  const full = rankExactSwaps(ws, {
    team: TEAM,
    gender: MEN,
    settings: POOL_SETTINGS,
    forceFullRescore: true,
  });

  assert.equal(fast.pointsMeaningful, true, 'two scoring teams => meaningful');
  assert.ok(fast.candidatesEvaluated > 0, 'enumeration produced candidates');
  assert.equal(fast.candidatesEvaluated, full.candidatesEvaluated, 'same candidate count');
  assert.deepEqual(fast, full, 'fast path output identical to forceFullRescore');
  ok(`fast === forceFullRescore over ${fast.candidatesEvaluated} candidates (duplicated placement)`);
}

// --- 3. same equivalence without any duplicate row (regression floor) ------
{
  const ws = singleRowWorkspace();
  const merged = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  const ctx = buildFastSwapContext(ws, TEAM, MEN, merged, [...ws.menResults, ...ws.womenResults]);
  assert.ok(ctx != null, 'fast context engages on the de-duplicated workspace too');

  const fast = rankExactSwaps(ws, { team: TEAM, gender: MEN, settings: POOL_SETTINGS });
  const full = rankExactSwaps(ws, {
    team: TEAM,
    gender: MEN,
    settings: POOL_SETTINGS,
    forceFullRescore: true,
  });
  assert.deepEqual(fast, full, 'fast path output identical without duplicates');
  ok('one row per name at every placement: context engages and agrees');
}

// --- 4. the duplicate genuinely changes the team total ---------------------
// Guards the fixture itself: if a future change makes buildWhatIfResults or
// calculatePoints collapse duplicate rows, case 1 stops exercising ptsTotal and
// this assertion says so out loud rather than passing vacuously.
{
  const withDup = duplicateRowWorkspace();
  const withoutDup = singleRowWorkspace();
  const merged = mergeScoringSettings(POOL_SETTINGS, { conference: undefined });
  const baseA = teamTotal(withDup, MEN, TEAM, merged);
  const baseB = teamTotal(withoutDup, MEN, TEAM, merged);
  assert.notEqual(
    baseA,
    baseB,
    'the duplicate row must move the team total — otherwise case 1 is vacuous'
  );
  ok(`duplicate row moves the scored team total (${baseB} -> ${baseA}), so case 1 is live`);
}

// --- 5. a CROSS-plane duplicate makes the context fail closed --------------
// When a plan and a recruit row cover the same athlete in the same event, the
// projection keeps only the plan. The incremental model prices a drop as
// "subtract this row's points from its event group" and cannot see that the
// hidden recruit row resurfaces the moment the plan is dropped, so it would
// under-count every drop of a shadowing row. The context must refuse rather
// than answer, and the full re-score must still work.
{
  const ws = duplicateRowWorkspace({
    recruits: [recruit('r1', 'Alpha One', '50 Freestyle', '20.10')],
    meetEntryPlans: [plan('p1', 'Alpha One', '50 Freestyle', '20.10')],
    activeEntryIds: ['p1'],
  });
  const merged = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  const proj = buildWhatIfProjection({ workspace: ws, gender: MEN, removeSeniors: false });

  assert.equal(proj.collapsed.length, 1, 'the recruit row must be the one collapsed');
  assert.equal(proj.collapsed[0].id, 'r1', 'the PLAN wins the collision, not the recruit row');
  assert.ok(
    !proj.rows.some(r => r.id === 'r1'),
    'the shadowed recruit row must not reach the scoring pool'
  );

  const ctx = buildFastSwapContext(ws, TEAM, MEN, merged, [...ws.menResults, ...ws.womenResults]);
  assert.equal(
    ctx,
    null,
    'buildFastSwapContext must fail closed while a row for this team is shadowed'
  );

  // Failing closed must not fail the caller: the full re-score still answers.
  const full = rankExactSwaps(ws, {
    team: TEAM,
    gender: MEN,
    settings: POOL_SETTINGS,
    forceFullRescore: true,
  });
  const fallback = rankExactSwaps(ws, { team: TEAM, gender: MEN, settings: POOL_SETTINGS });
  assert.deepEqual(fallback, full, 'the fallback path must equal an explicit full re-score');
  ok('a shadowed row makes the context fail closed, and the fallback still answers');
}

console.log(`\n${n} assertions passed`);
