/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Cross-course arbitrage engine tests.
 * Run: npx tsx scripts/test_cross_course_arbitrage.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildCrossCourseTable,
  buildCoverageGaps,
  rankExactSwaps,
  applyExactSwap,
  computeCrossCourseArbitrage,
  canonicalProgramEvent,
} from '../packages/core/src/lib/crossCourseArbitrage.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

/** Team total via the same pipeline rankExactSwaps uses (for apply→score checks). */
function teamTotalOf(ws, team, gender, settings) {
  const merged = mergeScoringSettings(settings ?? ws.scoringSettings, { conference: ws.conference });
  const rows = buildWhatIfResults({ workspace: ws, gender, removeSeniors: false });
  const scored = calculatePoints(rows, merged, {
    scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
    conferenceForMerge: ws.conference,
    resultsForPdfHint: [...(ws.menResults ?? []), ...(ws.womenResults ?? [])],
  });
  return scored
    .filter(r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null))
    .reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
}

/** Assert the incremental fast path reproduces the full re-score for every enumerated swap. */
function assertFastEqualsFull(ws, opts, label) {
  const full = rankExactSwaps(ws, { ...opts, forceFullRescore: true });
  const fast = rankExactSwaps(ws, opts);
  assert.equal(fast.swaps.length, full.swaps.length, `${label}: swap count`);
  assert.equal(fast.candidatesEvaluated, full.candidatesEvaluated, `${label}: candidates`);
  const key = s => `${s.athlete}|${s.addEvent}|${s.dropEvent}|${s.dropSource}`;
  const fm = new Map(full.swaps.map(s => [key(s), s]));
  for (const s of fast.swaps) {
    const f = fm.get(key(s));
    assert.ok(f, `${label}: fast swap ${key(s)} present in full`);
    assert.ok(Math.abs(s.deltaPoints - f.deltaPoints) < 1e-6, `${label}: deltaPoints ${key(s)}`);
    assert.ok(Math.abs(s.newTotal - f.newTotal) < 1e-6, `${label}: newTotal ${key(s)}`);
    assert.ok(Math.abs(s.baseTotal - f.baseTotal) < 1e-6, `${label}: baseTotal ${key(s)}`);
  }
  return { full, fast };
}

const MEN = Gender.MEN;

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
  maxIndividualEntriesPerSwimmer: 3,
  maxRelayEntriesPerSwimmer: 4,
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

// --- canonicalProgramEvent handles HyTek + normalized labels ---
{
  assert.equal(canonicalProgramEvent('Event 24 Men 100 Yard Backstroke'), '100 Backstroke');
  assert.equal(canonicalProgramEvent('Event 6 Men 200 Yard IM'), '200 Individual Medley');
  assert.equal(canonicalProgramEvent('100 Backstroke'), '100 Backstroke');
  assert.equal(canonicalProgramEvent('Event 11 Men 4x50 Yard Medley Relay'), null);
  assert.equal(canonicalProgramEvent('Event 9 Men 1 mtr Diving'), null);
  assert.equal(canonicalProgramEvent('100 Individual Medley'), null);
  ok('canonicalProgramEvent maps HyTek + normalized labels, rejects relay/diving/100 IM');
}

// --- converted-beats-actual flagging (Curtis-style) ---
{
  const ws = baseWorkspace({
    athleteHistory: [
      { name: 'Curtis Malone', team: 'HSU', gender: MEN, event: '100 Backstroke', time: '48.71', timeType: 'SCY', source: 'paste', date: 'Feb 1, 2026', meetLabel: 'SCY Meet' },
      { name: 'Curtis Malone', team: 'HSU', gender: MEN, event: '100 Backstroke', time: '57.29', timeType: 'LCM', source: 'paste', date: 'Jul 18, 2025', meetLabel: 'LCM Meet' },
    ],
  });
  const { rows } = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN });
  const back = rows.find(r => r.event === '100 Backstroke');
  assert.ok(back, '100 Back row exists');
  assert.ok(back.scyBest && Math.abs(back.scyBest.timeSec - 48.71) < 0.01);
  assert.ok(back.convertedBest && Math.abs(back.convertedBest.timeSec - 48.41) < 0.05);
  assert.equal(back.convertedBest.sourceCourse, 'LCM');
  assert.equal(back.convertedBest.sourceTime, '57.29');
  assert.equal(back.effectiveBest, 'converted');
  assert.ok(back.convertedWinsBy > 0, 'converted flagged as beating actual SCY');
  assert.ok(Math.abs(back.convertedWinsBy - 0.3) < 0.05);
  ok('converted LCM time flagged as beating actual SCY best (Curtis-style)');
}

// --- distance remap flows into table (400 Free LCM -> 500 Free slot) ---
{
  const ws = baseWorkspace({
    athleteHistory: [
      { name: 'Dist Guy', team: 'HSU', gender: MEN, event: '400 Freestyle', time: '4:14.81', timeType: 'LCM', source: 'paste' },
    ],
  });
  const { rows } = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN });
  const row = rows.find(r => r.event === '500 Freestyle');
  assert.ok(row, '400 Free LCM lands in 500 Free SCY slot');
  assert.equal(row.convertedBest.sourceEvent, '400 Freestyle');
  assert.equal(row.convertedBest.sourceCourse, 'LCM');
  assert.equal(row.effectiveBest, 'converted');
  assert.equal(rows.find(r => r.event === '400 Freestyle'), undefined, 'no raw 400 Free slot');
  ok('distance remap (400 LCM -> 500 SCY) flows into cross-course table');
}

// --- pointsMeaningful=false on single-team workspace; enumeration skipped ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b1', 'Solo A', 'Alpha', '100 Backstroke', '47.00'),
      result('b2', 'Solo B', 'Alpha', '200 Backstroke', '1:50.00'),
    ],
    meetEntryPlans: [
      { id: 'p-solo', name: 'Solo A', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['p-solo'],
    athleteHistory: [
      { name: 'Solo A', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '51.00', timeType: 'LCM', source: 'paste' },
      { name: 'Solo A', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
    ],
  });
  const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.equal(ranking.pointsMeaningful, false);
  assert.ok(ranking.reason && /only/i.test(ranking.reason));
  assert.equal(ranking.swaps.length, 0);
  assert.equal(ranking.candidatesEvaluated, 0, 'enumeration skipped entirely');

  // Cross-course table still works regardless of scoring field.
  const bundle = computeCrossCourseArbitrage(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.ok(bundle.table.rows.length >= 2, 'table built despite meaningless field');
  assert.equal(bundle.swapRanking.pointsMeaningful, false);
  ok('single-team workspace -> pointsMeaningful=false, swaps skipped, table still built');
}

// --- pointsMeaningful=false when results empty ---
{
  const ws = baseWorkspace({
    athleteHistory: [
      { name: 'Plan Only', team: 'HSU', gender: MEN, event: '100 Backstroke', time: '51.00', timeType: 'LCM', source: 'paste' },
    ],
  });
  const ranking = rankExactSwaps(ws, { team: 'HSU', gender: MEN, settings: SETTINGS });
  assert.equal(ranking.pointsMeaningful, false);
  assert.ok(/no men/i.test(ranking.reason));
  ok('empty results -> pointsMeaningful=false with guided reason');
}

// --- exact swap delta on a hand-computable two-team fixture ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00'),
      result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00'),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50'),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00'),
    ],
    meetEntryPlans: [
      { id: 'a1-200bk', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['a1-200bk'],
    athleteHistory: [
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '51.00', timeType: 'LCM', source: 'paste' },
    ],
  });

  const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  assert.equal(ranking.candidatesEvaluated, 1, 'exactly one candidate x drop combination');
  assert.equal(ranking.swaps.length, 1);
  const swap = ranking.swaps[0];
  assert.equal(swap.athlete, 'Alpha One');
  assert.equal(swap.addEvent, '100 Backstroke');
  assert.equal(swap.dropEvent, '200 Backstroke');
  assert.equal(swap.dropEntryId, 'a1-200bk');
  assert.equal(swap.dropSource, 'plan');
  // Baseline Alpha = 3 (200Bk 2nd) + 3 (50Fr 2nd) = 6; after swap = 5 (100Bk 1st) + 3 = 8 -> +2.
  assert.equal(swap.baseTotal, 6);
  assert.equal(swap.newTotal, 8);
  assert.equal(swap.deltaPoints, 2);
  ok('exact swap delta computed by full re-score matches hand calculation (+2)');
}

// --- (a) athlete whose ONLY entries are result rows still gets swaps (dropSource 'result') ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00', { rank: 1, roundSwam: 'A Final' }),
      result('a1-200bk-res', 'Alpha One', 'Alpha', '200 Backstroke', '1:55.00', { rank: 2, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
    ],
    // No plans, no recruits — Alpha One's only current entry is the 200 Back result row.
    athleteHistory: [
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
    ],
  });

  const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  assert.equal(ranking.candidatesEvaluated, 1, 'one candidate x one result-row drop');
  assert.equal(ranking.swaps.length, 1);
  const swap = ranking.swaps[0];
  assert.equal(swap.athlete, 'Alpha One');
  assert.equal(swap.addEvent, '100 Backstroke');
  assert.equal(swap.dropEvent, '200 Backstroke');
  assert.equal(swap.dropSource, 'result');
  assert.equal(swap.dropEntryId, 'a1-200bk-res');
  assert.equal(swap.dropTime, '1:55.00');
  // Base Alpha = 3 (200Bk 2nd) + 3 (50Fr 2nd) = 6; after dropping the 200Bk result row
  // and adding 100Bk 46.00 (1st) = 5 + 3 = 8 -> +2.
  assert.equal(swap.baseTotal, 6);
  assert.equal(swap.newTotal, 8);
  assert.equal(swap.deltaPoints, 2);
  ok('result-only athlete gets a swap by dropping a loaded result row (dropSource result, +2)');
}

// --- (b) recruit-row drop works (dropSource 'recruit') ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
    ],
    recruits: [
      { id: 'a1-rec', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'FR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY' },
    ],
    athleteHistory: [
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
    ],
  });

  const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  assert.equal(ranking.candidatesEvaluated, 1, 'one candidate x one recruit-row drop');
  assert.equal(ranking.swaps.length, 1);
  const swap = ranking.swaps[0];
  assert.equal(swap.athlete, 'Alpha One');
  assert.equal(swap.addEvent, '100 Backstroke');
  assert.equal(swap.dropEvent, '200 Backstroke');
  assert.equal(swap.dropSource, 'recruit');
  assert.equal(swap.dropEntryId, 'a1-rec');
  // Base Alpha = 3 (recruit 200Bk 2nd) + 3 (50Fr 2nd) = 6; after swap = 5 (100Bk 1st) + 3 = 8 -> +2.
  assert.equal(swap.baseTotal, 6);
  assert.equal(swap.newTotal, 8);
  assert.equal(swap.deltaPoints, 2);
  ok('recruit-row drop produces a swap (dropSource recruit, +2)');
}

// --- (c) plan preferred over a duplicate result row for the same event ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00', { rank: 1, roundSwam: 'A Final' }),
      result('a1-200bk-res', 'Alpha One', 'Alpha', '200 Backstroke', '1:55.00', { rank: 2, roundSwam: 'A Final' }),
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
    ],
    // Alpha One has BOTH a 200 Back result row and a 200 Back plan -> same event, two sources.
    meetEntryPlans: [
      { id: 'a1-plan-200bk', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Backstroke', time: '1:56.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['a1-plan-200bk'],
    athleteHistory: [
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
    ],
  });

  const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  // 200 Back appears from both the result row and the plan, but is collapsed to a single
  // droppable entry (plan preferred) -> exactly one candidate x drop combination.
  assert.equal(ranking.candidatesEvaluated, 1, 'duplicate event collapsed to one drop (no double count)');
  assert.equal(ranking.swaps.length, 1);
  const swap = ranking.swaps[0];
  assert.equal(swap.athlete, 'Alpha One');
  assert.equal(swap.addEvent, '100 Backstroke');
  assert.equal(swap.dropEvent, '200 Backstroke');
  assert.equal(swap.dropSource, 'plan', 'plan preferred over the duplicate result row');
  assert.equal(swap.dropEntryId, 'a1-plan-200bk');
  assert.ok(swap.deltaPoints > 0, 'beneficial swap surfaced');
  ok('duplicate event (result + plan) collapses to a single plan drop (no double count)');
}

// --- coverage gap counts + uncontested ranking ---
{
  const ws = baseWorkspace({
    menResults: [
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00'),
      result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00'),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50'),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00'),
    ],
    meetEntryPlans: [
      { id: 'a1-200bk', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['a1-200bk'],
  });
  const gaps = buildCoverageGaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  assert.equal(gaps.length, 14, 'one gap per program event');
  const byEvent = Object.fromEntries(gaps.map(g => [g.event, g]));

  assert.equal(byEvent['50 Freestyle'].fieldSize, 2);
  assert.equal(byEvent['50 Freestyle'].countTeamEntries, 1);
  assert.equal(byEvent['50 Freestyle'].openSlots, 1);
  assert.equal(byEvent['50 Freestyle'].capPerSwimmer, 3);

  // 200 Back: field is Beta only (1); Alpha entry is a plan (counts as team entry, not field).
  assert.equal(byEvent['200 Backstroke'].fieldSize, 1);
  assert.equal(byEvent['200 Backstroke'].countTeamEntries, 1);

  // 100 Back: field Beta only, Alpha not entered.
  assert.equal(byEvent['100 Backstroke'].countTeamEntries, 0);

  // Wholly un-entered event outranks a contested one.
  assert.ok(byEvent['100 Butterfly'].fieldSize === 0);
  assert.ok(byEvent['100 Butterfly'].gapScore > byEvent['50 Freestyle'].gapScore);
  assert.equal(gaps[0].gapScore, gaps.reduce((m, g) => Math.max(m, g.gapScore), 0));
  ok('coverage gaps count team/field entries and rank uncontested events highest');
}

// --- cap respect: at-cap athlete only produces 1-for-1 replacements ---
{
  const ws = baseWorkspace({
    menResults: [
      // Two-team field so points are meaningful.
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00'),
      result('b2', 'Beta Two', 'Beta', '100 Butterfly', '49.00'),
      result('a9', 'Alpha Nine', 'Alpha', '50 Freestyle', '30.00'),
    ],
    meetEntryPlans: [
      { id: 'c-50fr', name: 'Cap Guy', team: 'Alpha', gender: MEN, classYear: 'JR', event: '50 Freestyle', time: '20.00', timeType: 'SCY', source: 'optimizer', active: true },
      { id: 'c-100fr', name: 'Cap Guy', team: 'Alpha', gender: MEN, classYear: 'JR', event: '100 Freestyle', time: '44.00', timeType: 'SCY', source: 'optimizer', active: true },
      { id: 'c-200fr', name: 'Cap Guy', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Freestyle', time: '1:38.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['c-50fr', 'c-100fr', 'c-200fr'],
    athleteHistory: [
      // Cap Guy already entered in 50/100/200 Free (at cap 3); has a strong 100 Back too.
      { name: 'Cap Guy', team: 'Alpha', gender: MEN, event: '50 Freestyle', time: '20.00', timeType: 'SCY', source: 'paste' },
      { name: 'Cap Guy', team: 'Alpha', gender: MEN, event: '100 Freestyle', time: '44.00', timeType: 'SCY', source: 'paste' },
      { name: 'Cap Guy', team: 'Alpha', gender: MEN, event: '200 Freestyle', time: '1:38.00', timeType: 'SCY', source: 'paste' },
      { name: 'Cap Guy', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
    ],
  });
  const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
  // 1 candidate add-event (100 Back) x 3 active entries = 3 combinations evaluated.
  assert.equal(ranking.candidatesEvaluated, 3);
  assert.ok(ranking.swaps.length >= 1, 'at least one beneficial swap');
  const dropIds = new Set(['c-50fr', 'c-100fr', 'c-200fr']);
  for (const s of ranking.swaps) {
    assert.ok(s.dropEntryId && dropIds.has(s.dropEntryId), 'every swap drops an existing entry (1-for-1, cap respected)');
    assert.equal(s.addEvent, '100 Backstroke');
    assert.notEqual(s.addEvent, s.dropEvent);
  }
  ok('at-cap athlete swaps are strictly 1-for-1 replacements (cap never exceeded)');
}

// --- ITEM 1 (a): fast incremental re-score === full re-score on synthetic fixtures ---
{
  // No-cap regime (fast path degenerates to "all eligible score").
  const wsA = baseWorkspace({
    menResults: [
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('b4', 'Beta Four', 'Beta', '100 Butterfly', '49.00', { rank: 1, roundSwam: 'A Final' }),
      result('a-fly', 'Alpha One', 'Alpha', '100 Butterfly', '50.00', { rank: 2, roundSwam: 'A Final' }),
      result('a-50', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
    ],
    meetEntryPlans: [
      { id: 'a1-200bk', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'optimizer', active: true },
      { id: 'a3-100fr', name: 'Alpha Three', team: 'Alpha', gender: MEN, classYear: 'SO', event: '100 Freestyle', time: '46.00', timeType: 'SCY', source: 'optimizer', active: true },
    ],
    activeEntryIds: ['a1-200bk', 'a3-100fr'],
    athleteHistory: [
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.50', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Butterfly', time: '48.90', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha Two', team: 'Alpha', gender: MEN, event: '50 Freestyle', time: '21.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha Two', team: 'Alpha', gender: MEN, event: '100 Freestyle', time: '45.50', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha Three', team: 'Alpha', gender: MEN, event: '100 Freestyle', time: '46.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha Three', team: 'Alpha', gender: MEN, event: '50 Freestyle', time: '20.40', timeType: 'SCY', source: 'paste' },
    ],
  });
  const r1 = assertFastEqualsFull(wsA, { team: 'Alpha', gender: MEN, settings: SETTINGS }, 'no-cap');
  assert.ok(r1.fast.candidatesEvaluated >= 3, 'multiple candidates enumerated (no-cap)');
  assert.ok(r1.fast.swaps.length >= 1, 'at least one beneficial swap (no-cap)');

  // Meet-wide scorer pool that BINDS (cap 2 across the meet) — exercises the pool sweep.
  const POOL_SETTINGS = {
    ...SETTINGS,
    scoringPoints: [5, 3, 1],
    maxIndividualScorersPerTeam: 2,
    scorerCapScope: 'meet',
    scorerEligibilityMode: 'points_pool',
  };
  const r2 = assertFastEqualsFull(wsA, { team: 'Alpha', gender: MEN, settings: POOL_SETTINGS }, 'meet-pool');
  assert.ok(r2.fast.candidatesEvaluated >= 3, 'multiple candidates enumerated (meet-pool)');
  ok(`fast incremental re-score === full re-score on synthetic fixtures (no-cap + binding meet pool)`);
}

// --- ITEM 1 (b): fast === full on the realistic merged NSISC workspace ---
{
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync('data/meets.json', 'utf8'));
  } catch {
    raw = null;
  }
  const plan = Array.isArray(raw)
    ? raw.find(w => (w.meetEntryPlans ?? []).length > 0 && (w.athleteHistory ?? []).length > 0)
    : null;
  const res = Array.isArray(raw)
    ? raw.find(w => w.loadedMeet?.pdfFilename === '2026_NSISC_Championships_Final_Results.pdf')
    : null;

  if (!plan || !res) {
    console.log('  skip 12 - realistic merged workspace (data/meets.json lacks the roster-plan + NSISC-results workspaces)');
  } else {
    const ws = {
      ...plan,
      menResults: res.menResults,
      womenResults: res.womenResults,
      sourceMenResults: res.sourceMenResults,
      sourceWomenResults: res.sourceWomenResults,
      loadedMeet: res.loadedMeet,
      officialTeamScores: res.officialTeamScores,
    };
    const team = 'Henderson State University';
    const t0 = performance.now();
    const full = rankExactSwaps(ws, { team, gender: MEN, forceFullRescore: true });
    const t1 = performance.now();
    const fast = rankExactSwaps(ws, { team, gender: MEN });
    const t2 = performance.now();

    assert.ok(full.candidatesEvaluated >= 40, 'realistic workspace enumerates many candidates');
    assert.equal(fast.candidatesEvaluated, full.candidatesEvaluated, 'same candidate count');
    assert.equal(fast.swaps.length, full.swaps.length, 'same surfaced swap count');

    // Compare at least 40 evenly-sampled surfaced swaps (all of them here) fast === full.
    const key = s => `${s.athlete}|${s.addEvent}|${s.dropEvent}|${s.dropSource}`;
    const fm = new Map(full.swaps.map(s => [key(s), s]));
    const total = fast.swaps.length;
    const sampleCount = Math.min(total, Math.max(40, total));
    const step = Math.max(1, Math.floor(total / sampleCount));
    let checked = 0;
    for (let i = 0; i < total; i += step) {
      const s = fast.swaps[i];
      const f = fm.get(key(s));
      assert.ok(f, `sampled swap present in full: ${key(s)}`);
      assert.ok(Math.abs(s.deltaPoints - f.deltaPoints) < 1e-6, `delta ${key(s)}`);
      assert.ok(Math.abs(s.newTotal - f.newTotal) < 1e-6, `newTotal ${key(s)}`);
      checked++;
    }
    assert.ok(checked >= 40 || checked === total, `checked ${checked} sampled candidates`);
    const speedup = (t1 - t0) / Math.max(1e-6, t2 - t1);
    console.log(
      `  (timing) MEN: full ${(t1 - t0).toFixed(0)}ms -> fast ${(t2 - t1).toFixed(0)}ms over ${full.candidatesEvaluated} candidates (${speedup.toFixed(1)}x)`
    );
    ok(`fast === full on realistic merged NSISC workspace (${checked} candidates sampled)`);
  }
}

// --- ITEM 2: applyExactSwap patch/inverse round-trip + apply->score matches newTotal ---
{
  // Build a fixture with one droppable of each source for the same athlete-family.
  function fixtureFor(dropSource) {
    const common = {
      menResults: [
        result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
        result('b2', 'Beta Two', 'Beta', '200 Backstroke', '1:50.00', { rank: 1, roundSwam: 'A Final' }),
        result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
        result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      ],
      athleteHistory: [
        { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'paste' },
        { name: 'Alpha One', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
      ],
    };
    if (dropSource === 'plan') {
      return baseWorkspace({
        ...common,
        meetEntryPlans: [
          { id: 'a1-200bk', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'JR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY', source: 'optimizer', active: true },
        ],
        activeEntryIds: ['a1-200bk'],
      });
    }
    if (dropSource === 'result') {
      return baseWorkspace({
        ...common,
        menResults: [
          ...common.menResults,
          result('a1-200bk-res', 'Alpha One', 'Alpha', '200 Backstroke', '1:55.00', { rank: 2, roundSwam: 'A Final' }),
        ],
      });
    }
    return baseWorkspace({
      ...common,
      recruits: [
        { id: 'a1-rec', name: 'Alpha One', team: 'Alpha', gender: MEN, classYear: 'FR', event: '200 Backstroke', time: '1:55.00', timeType: 'SCY' },
      ],
    });
  }

  for (const dropSource of ['plan', 'result', 'recruit']) {
    const ws = fixtureFor(dropSource);
    const ranking = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: SETTINGS });
    const swap = ranking.swaps.find(s => s.dropSource === dropSource);
    assert.ok(swap, `swap surfaced for dropSource ${dropSource}`);

    const { patch, inverse, description } = applyExactSwap(ws, swap, { team: 'Alpha', gender: MEN });

    // apply -> score matches the swap's predicted newTotal.
    const applied = { ...ws, ...patch };
    const scored = teamTotalOf(applied, 'Alpha', MEN, SETTINGS);
    assert.ok(Math.abs(scored - swap.newTotal) < 1e-6, `apply->score == newTotal (${dropSource}): ${scored} vs ${swap.newTotal}`);

    // inverse round-trips deep-equal on every touched field.
    const roundTripped = { ...applied, ...inverse };
    for (const f of Object.keys(patch)) {
      assert.deepEqual(roundTripped[f], ws[f], `round-trip ${f} (${dropSource})`);
    }

    // description shape.
    assert.ok(description.includes('Alpha One') && description.includes(`(${dropSource})`), `description (${dropSource})`);
    assert.ok(description.includes(`+${swap.addEvent}`) && description.includes(`−${swap.dropEvent}`), `description events (${dropSource})`);
  }
  ok('applyExactSwap: apply->score == newTotal, inverse round-trips, all three drop sources');
}

// --- ITEM 3: recency weighting of candidate bests ---
{
  const anchorRecent = 'Feb 20, 2026';
  const staleDate = 'Mar 1, 2019';

  // (1) stale-only event keeps its best but flags it stale.
  {
    const ws = baseWorkspace({
      athleteHistory: [
        // Newest dated swim in workspace = 2026 (anchor), a different event.
        { name: 'Camden Mask', team: 'HSU', gender: MEN, event: '200 Backstroke', time: '1:48.00', timeType: 'SCY', source: 'paste', date: anchorRecent },
        // 200 Free has ONLY a stale 2019 time.
        { name: 'Camden Mask', team: 'HSU', gender: MEN, event: '200 Freestyle', time: '1:38.00', timeType: 'SCY', source: 'paste', date: staleDate },
      ],
    });
    const { rows } = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN });
    const free = rows.find(r => r.event === '200 Freestyle');
    assert.ok(free && free.scyBest, 'stale-only 200 Free best still kept');
    assert.equal(free.scyBest.stale, true, 'stale-only best flagged stale');
    const back = rows.find(r => r.event === '200 Backstroke');
    assert.ok(back && !back.scyBest.stale, 'recent best not flagged stale');
  }

  // (2) a recent time beats a faster stale time (recency wins).
  {
    const ws = baseWorkspace({
      athleteHistory: [
        { name: 'Camden Mask', team: 'HSU', gender: MEN, event: '200 Freestyle', time: '1:38.00', timeType: 'SCY', source: 'paste', date: staleDate }, // faster but stale
        { name: 'Camden Mask', team: 'HSU', gender: MEN, event: '200 Freestyle', time: '1:41.00', timeType: 'SCY', source: 'paste', date: anchorRecent }, // slower but recent
      ],
    });
    const { rows } = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN });
    const free = rows.find(r => r.event === '200 Freestyle');
    assert.ok(free && Math.abs(free.scyBest.timeSec - 101.0) < 0.01, 'recent 1:41.00 chosen over faster stale 1:38.00');
    assert.ok(!free.scyBest.stale, 'recent-chosen best not stale');
  }

  // (3) undated rows always count as recent.
  {
    const ws = baseWorkspace({
      athleteHistory: [
        { name: 'Camden Mask', team: 'HSU', gender: MEN, event: '200 Backstroke', time: '1:48.00', timeType: 'SCY', source: 'paste', date: anchorRecent },
        { name: 'Camden Mask', team: 'HSU', gender: MEN, event: '200 Freestyle', time: '1:37.00', timeType: 'SCY', source: 'paste' }, // undated
      ],
    });
    const { rows } = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN });
    const free = rows.find(r => r.event === '200 Freestyle');
    assert.ok(free && !free.scyBest.stale, 'undated best treated as recent (not stale)');
  }

  // (4) anchor is the newest swim in the data, not wall-clock: an all-old file still surfaces its own recent bests.
  {
    const ws = baseWorkspace({
      athleteHistory: [
        // Newest swim in this (old) file is 2015; window is relative to that.
        { name: 'Old Timer', team: 'HSU', gender: MEN, event: '100 Freestyle', time: '44.00', timeType: 'SCY', source: 'paste', date: 'Jan 10, 2015' },
        // A 2013 swim is within 24 months of the 2015 anchor -> recent.
        { name: 'Old Timer', team: 'HSU', gender: MEN, event: '100 Backstroke', time: '48.00', timeType: 'SCY', source: 'paste', date: 'Jan 10, 2013' },
      ],
    });
    const { rows } = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN });
    const back = rows.find(r => r.event === '100 Backstroke');
    assert.ok(back && !back.scyBest.stale, '2013 swim within 24mo of 2015 anchor is recent (anchor-on-data)');

    // Tightening the window to 6 months makes the 2013 swim stale relative to the 2015 anchor.
    const tight = buildCrossCourseTable(ws, { team: 'HSU', gender: MEN, recencyMonths: 6 });
    const backTight = tight.rows.find(r => r.event === '100 Backstroke');
    assert.equal(backTight.scyBest.stale, true, '2013 swim stale under a 6-month window');
  }
  ok('recency: stale-only flagged, recent-beats-stale, undated recent, anchor-on-newest-swim');
}

console.log(`\ncross-course arbitrage tests passed (${n} groups)`);
