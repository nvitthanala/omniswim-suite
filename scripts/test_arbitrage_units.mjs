/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Arbitrage cards must state real points, or state nothing.
 *
 * The bug: `buildArbitrageCards` computed the athlete's gap to the field median
 * in SECONDS, multiplied it by 2, and labelled the result "pts". A 1650 swimmer
 * 29 s clear of the median scored "+58.7" on a scale whose maximum is 20, and
 * because the error grew with event length, distance events always outranked
 * sprints for a reason unrelated to scoring.
 *
 * A card's number is now `ExactSwap.deltaPoints` from `rankExactSwaps` — a real
 * difference of two scored team totals.
 *
 * NOTE ON THE BOUND. It is tempting to assert `delta <= max(SCORING_POINTS)`.
 * That is wrong: it bounds ONE SWIM's points, not a TEAM-TOTAL delta. Moving a
 * swimmer out of an event promotes every teammate behind them, so a legitimate
 * swap can move a team total by more than any single event awards. The assertion
 * that actually holds is internal consistency — the claimed delta must equal
 * `newTotal - baseTotal`, and applying the swap must reproduce it.
 *
 * Test: npx tsx scripts/test_arbitrage_units.mjs
 */
import assert from 'node:assert/strict';
import {
  buildArbitrageCards,
  buildArbitrageCardsResult,
} from '../packages/core/src/lib/rosterArbitrage.ts';
import { rankExactSwaps, applyExactSwap } from '../packages/core/src/lib/crossCourseArbitrage.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const TEAM = 'Henderson State University';
const RIVAL = 'Ouachita Baptist University';
const settings = mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' });

let idc = 0;
function row(name, team, event, time, extra = {}) {
  return {
    id: `r${(idc += 1)}`,
    rank: 0,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event,
    gender: Gender.MEN,
    ...extra,
  };
}

/** Two scoring teams, so a point value is statable. */
function scoreableWorkspace() {
  return {
    id: 'ws',
    name: 'ws',
    createdAt: 1,
    conference: 'NSISC',
    scoringSettings: NSISC_PRESET_SETTINGS,
    menResults: [
      // Our athlete is mediocre in the 50 and strong in the 500.
      row('Distance, Dana', TEAM, '50 Freestyle', '24.00'),
      row('Sprint, Sam', TEAM, '50 Freestyle', '20.10'),
      row('Rival, Ricky', RIVAL, '50 Freestyle', '20.50'),
      row('Rival, Robin', RIVAL, '50 Freestyle', '21.00'),
      row('Rival, Rowan', RIVAL, '500 Freestyle', '4:50.00'),
      row('Rival, Reese', RIVAL, '500 Freestyle', '5:00.00'),
    ],
    womenResults: [],
    sourceMenResults: [
      row('X', TEAM, '50 Freestyle', '24.00'),
      row('Y', TEAM, '500 Freestyle', '4:50.00'),
    ],
    sourceWomenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    athleteHistory: [
      // Dana's real strength: a 500 that would win, vs a 50 that scores little.
      { name: 'Distance, Dana', team: TEAM, gender: Gender.MEN, event: '500 Freestyle', time: '4:30.00', timeType: 'SCY', source: 'swimcloud' },
      { name: 'Distance, Dana', team: TEAM, gender: Gender.MEN, event: '50 Freestyle', time: '24.00', timeType: 'SCY', source: 'swimcloud' },
    ],
  };
}

const teamTotal = (ws, team) => {
  const res = buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
  const scored = calculatePoints(res, settings, {
    scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
    conferenceForMerge: ws.conference,
    resultsForPdfHint: [...(ws.menResults ?? []), ...(ws.womenResults ?? [])],
  });
  return scored
    .filter(r => String(r.team ?? '').trim() === team)
    .reduce((a, r) => a + (typeof r.points === 'number' ? r.points : 0), 0);
};

// --- 1. Every card's delta is reproducible by applying the swap -------------
{
  const ws = scoreableWorkspace();
  const ranking = rankExactSwaps(ws, { team: TEAM, gender: Gender.MEN, settings });
  assert.ok(ranking.pointsMeaningful, 'two scoring teams => points are statable');

  const positive = ranking.swaps.filter(s => s.deltaPoints > 0);
  assert.ok(positive.length > 0, 'the fixture should offer at least one gaining swap');

  for (const s of positive.slice(0, 3)) {
    // The swap's own bookkeeping must be self-consistent...
    assert.ok(
      Math.abs(s.deltaPoints - (s.newTotal - s.baseTotal)) < 0.05,
      `deltaPoints must equal newTotal - baseTotal for ${s.athlete}`
    );
    // ...and must survive being applied for real.
    const before = teamTotal(ws, TEAM);
    const { patch } = applyExactSwap(ws, s, { team: TEAM, gender: Gender.MEN });
    const after = teamTotal({ ...ws, ...patch }, TEAM);
    assert.ok(
      Math.abs(after - before - s.deltaPoints) < 0.05,
      `applying ${s.athlete} ${s.addEvent}<-${s.dropEvent} should move the total by ${s.deltaPoints}, moved ${(after - before).toFixed(2)}`
    );
  }
}

// --- 2. No number is invented when the field cannot support one ------------
{
  // A roster-only workspace: no individual results, so nothing to place against.
  const ws = {
    ...scoreableWorkspace(),
    menResults: [],
    sourceMenResults: [],
  };
  const res = buildArbitrageCardsResult(ws, Gender.MEN, TEAM, settings);
  assert.equal(res.pointsMeaningful, false, 'no field => no statable point value');
  assert.deepEqual(res.cards, [], 'and therefore no cards');
  assert.ok(res.reason && res.reason.length > 0, 'the caller is told WHY, not just given nothing');
}

// --- 3. One card per athlete ------------------------------------------------
{
  const ws = scoreableWorkspace();
  const cards = buildArbitrageCards(ws, Gender.MEN, TEAM, settings);
  const names = cards.map(c => c.athleteName);
  assert.equal(
    new Set(names).size,
    names.length,
    'rankExactSwaps returns every add/drop combination; the panel shows each athlete once'
  );
}

// --- 4. The discarded heuristic cannot come back ----------------------------
{
  const ws = scoreableWorkspace();
  const cards = buildArbitrageCards(ws, Gender.MEN, TEAM, settings);
  for (const c of cards) {
    // The old code set these from a scaled time gap. They carry no unit and are
    // retained only for compatibility; a non-zero value means the heuristic returned.
    assert.equal(c.preferredDelta, 0, 'preferredDelta is retired, not repopulated');
    assert.equal(c.alternateDelta, 0, 'alternateDelta is retired, not repopulated');
    assert.ok(Number.isFinite(c.arbitragePts), 'the one real number is finite');
    // A time gap doubled would be wildly out of scale for these small fixtures.
    assert.ok(
      Math.abs(c.arbitragePts) < 200,
      `a team-total delta of ${c.arbitragePts} on a 6-row fixture indicates a unit error`
    );
  }
}

console.log('arbitrage units: all assertions passed');
