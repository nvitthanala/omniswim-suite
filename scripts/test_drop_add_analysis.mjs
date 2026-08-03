/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Drop-only / add-only analysis + conversion confidence band tests.
 * Run: node --import tsx scripts/test_drop_add_analysis.mjs
 */
import assert from 'node:assert/strict';
import {
  rankDropOnly,
  rankAddOnly,
  applyEntryDrop,
  applyEntryAdd,
  rankExactSwaps,
  computeCrossCourseArbitrage,
  CONVERSION_VERIFY_MARGIN,
} from '../packages/core/src/lib/crossCourseArbitrage.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** Team total via the exact pipeline the rankings use (brute-force reference). */
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

function plan(id, name, team, event, time) {
  return {
    id,
    name,
    team,
    gender: MEN,
    classYear: 'JR',
    event,
    time,
    timeType: 'SCY',
    source: 'optimizer',
    active: true,
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
    scoringSettings: {},
    conference: undefined,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
    ...overrides,
  };
}

const BASE_SETTINGS = {
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

/** Compare a drop/add ranking computed fast vs forceFullRescore. */
function assertRankingFastEqualsFull(fn, ws, opts, listKey, keyOf, label) {
  const fast = fn(ws, opts);
  const full = fn(ws, { ...opts, forceFullRescore: true });
  assert.equal(fast[listKey].length, full[listKey].length, `${label}: row count`);
  assert.equal(fast.candidatesEvaluated, full.candidatesEvaluated, `${label}: candidates`);
  const fm = new Map(full[listKey].map(r => [keyOf(r), r]));
  for (const r of fast[listKey]) {
    const f = fm.get(keyOf(r));
    assert.ok(f, `${label}: fast row ${keyOf(r)} present in full`);
    assert.ok(Math.abs(r.deltaPoints - f.deltaPoints) < 1e-6, `${label}: deltaPoints ${keyOf(r)}`);
    assert.ok(Math.abs(r.newTotal - f.newTotal) < 1e-6, `${label}: newTotal ${keyOf(r)}`);
  }
  return { fast, full };
}

// --- 1. drop-only deltas equal brute-force full re-score deltas (meet pool) ---
{
  // Meet-wide scorer pool of 1: Alpha One's 50 Free entry burns the only pool
  // slot on 3 pts, blocking Alpha Two's 5-pt 100 Fly. Dropping it alone gains +2.
  const POOL_SETTINGS = {
    ...BASE_SETTINGS,
    maxIndividualScorersPerTeam: 1,
    scorerCapScope: 'meet',
    scorerEligibilityMode: 'points_pool',
  };
  const ws = baseWorkspace({
    scoringSettings: POOL_SETTINGS,
    menResults: [
      result('b1', 'Beta One', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', '100 Butterfly', '49.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '200 Freestyle', '1:40.00', { rank: 1, roundSwam: 'A Final' }),
      result('b4', 'Beta Four', 'Beta', '200 Freestyle', '1:41.00', { rank: 2, roundSwam: 'A Final' }),
      result('b5', 'Beta Five', 'Beta', '200 Freestyle', '1:42.00', { rank: 3, roundSwam: 'A Final' }),
      result('a9', 'Alpha Nine', 'Alpha', '200 Freestyle', '2:10.00', { rank: 4, roundSwam: 'A Final' }),
    ],
    meetEntryPlans: [
      plan('pA', 'Alpha One', 'Alpha', '50 Freestyle', '21.00'),
      plan('pB', 'Alpha Two', 'Alpha', '100 Butterfly', '48.00'),
    ],
    activeEntryIds: ['pA', 'pB'],
  });

  const ranking = rankDropOnly(ws, { team: 'Alpha', gender: MEN, settings: POOL_SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  assert.equal(ranking.candidatesEvaluated, 3, 'three droppable entries evaluated');

  // Brute force every droppable: drop patch -> full re-score.
  const baseTotal = teamTotalOf(ws, 'Alpha', MEN, POOL_SETTINGS);
  const brute = new Map();
  for (const [key, applied] of [
    ['Alpha One|50 Freestyle', { ...ws, meetEntryPlans: ws.meetEntryPlans.filter(p => p.id !== 'pA'), activeEntryIds: ['pB'] }],
    ['Alpha Two|100 Butterfly', { ...ws, meetEntryPlans: ws.meetEntryPlans.filter(p => p.id !== 'pB'), activeEntryIds: ['pA'] }],
    ['Alpha Nine|200 Freestyle', { ...ws, menResults: ws.menResults.filter(r => r.id !== 'a9') }],
  ]) {
    brute.set(key, Number((teamTotalOf(applied, 'Alpha', MEN, POOL_SETTINGS) - baseTotal).toFixed(3)));
  }

  // Every surfaced row's delta equals the brute-force delta; every non-surfaced
  // droppable brute-forces to <= 0.
  const surfaced = new Set(ranking.drops.map(d => `${d.athlete}|${d.dropEvent}`));
  for (const d of ranking.drops) {
    const b = brute.get(`${d.athlete}|${d.dropEvent}`);
    assert.ok(b != null, `brute-force entry for ${d.athlete}`);
    assert.ok(Math.abs(d.deltaPoints - b) < 1e-6, `drop delta equals brute force (${d.athlete}): ${d.deltaPoints} vs ${b}`);
    assert.ok(Math.abs(d.scoredDelta - b) < 1e-6, 'no cap-void modeling here: scoredDelta == brute force');
  }
  for (const [key, b] of brute) {
    if (!surfaced.has(key)) assert.ok(b <= 1e-9, `non-surfaced droppable ${key} is non-positive (${b})`);
  }

  // The meet-pool relief drop is surfaced with the hand-computed +2.
  assert.equal(ranking.drops.length, 1, 'exactly one positive drop');
  const d = ranking.drops[0];
  assert.equal(d.athlete, 'Alpha One');
  assert.equal(d.dropEvent, '50 Freestyle');
  assert.equal(d.dropSource, 'plan');
  assert.equal(d.dropEntryId, 'pA');
  assert.equal(d.deltaPoints, 2);
  assert.equal(d.capRelief, undefined, 'pool relief, not cap relief');

  // Fast === full.
  assertRankingFastEqualsFull(
    rankDropOnly, ws, { team: 'Alpha', gender: MEN, settings: POOL_SETTINGS },
    'drops', r => `${r.athlete}|${r.dropEvent}|${r.dropSource}`, 'drop-only meet-pool'
  );

  // Apply -> score matches newTotal; inverse round-trips (dropSource 'plan').
  const { patch, inverse, description } = applyEntryDrop(ws, d, { team: 'Alpha', gender: MEN });
  const applied = { ...ws, ...patch };
  assert.ok(Math.abs(teamTotalOf(applied, 'Alpha', MEN, POOL_SETTINGS) - d.newTotal) < 1e-6, 'apply->score == newTotal');
  const roundTripped = { ...applied, ...inverse };
  for (const f of Object.keys(patch)) {
    assert.deepEqual(roundTripped[f], ws[f], `round-trip ${f} (plan)`);
  }
  assert.ok(description.includes('Alpha One') && description.includes('−50 Freestyle'), 'description');
  ok('drop-only deltas equal brute-force full re-score; meet-pool relief drop +2; fast === full; plan round-trip');
}

// --- 2. over-cap void case yields positive drop deltas (result rows) ---
{
  // NSISC-style total cap of 2: Over Guy holds 3 scoring entries (3+5+5 = 13),
  // so ALL his points are voided until an entry is dropped.
  const CAP_SETTINGS = {
    ...BASE_SETTINGS,
    maxIndividualEntriesPerSwimmer: 999,
    maxTotalEntriesPerSwimmer: 2,
  };
  const ws = baseWorkspace({
    scoringSettings: CAP_SETTINGS,
    menResults: [
      result('b1', 'Beta One', 'Beta', '50 Freestyle', '20.00', { rank: 1, roundSwam: 'A Final' }),
      result('og-50', 'Over Guy', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
      result('og-100', 'Over Guy', 'Alpha', '100 Freestyle', '44.00', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', '100 Freestyle', '46.00', { rank: 2, roundSwam: 'A Final' }),
      result('og-bk', 'Over Guy', 'Alpha', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '100 Backstroke', '49.00', { rank: 2, roundSwam: 'A Final' }),
      result('b4', 'Beta Four', 'Beta', '100 Butterfly', '49.00', { rank: 1, roundSwam: 'A Final' }),
      result('cg', 'Clean Guy', 'Alpha', '100 Butterfly', '50.00', { rank: 2, roundSwam: 'A Final' }),
    ],
  });

  const ranking = rankDropOnly(ws, { team: 'Alpha', gender: MEN, settings: CAP_SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  assert.equal(ranking.candidatesEvaluated, 4, 'four droppable entries evaluated');
  assert.equal(ranking.drops.length, 3, "all three of Over Guy's drops are positive; Clean Guy's is not");

  // Best drop is the weakest entry (50 Free, 3 pts): +13 voided restored - 3 lost = +10.
  const best = ranking.drops[0];
  assert.equal(best.athlete, 'Over Guy');
  assert.equal(best.dropEvent, '50 Freestyle');
  assert.equal(best.dropSource, 'result');
  assert.equal(best.dropEntryId, 'og-50');
  assert.equal(best.deltaPoints, 10);
  assert.equal(best.scoredDelta, -3, 'pure engine delta is negative');
  assert.equal(best.voidedPointsRestored, 13);
  assert.equal(best.capRelief, true);
  for (const d of ranking.drops) {
    assert.equal(d.athlete, 'Over Guy');
    assert.equal(d.capRelief, true);
    assert.equal(d.voidedPointsRestored, 13);
  }
  assert.deepEqual(ranking.drops.map(d => d.deltaPoints), [10, 8, 8], 'sorted descending');

  // Engine totals stay apply-verifiable: apply -> full re-score == newTotal.
  const { patch, inverse } = applyEntryDrop(ws, best, { team: 'Alpha', gender: MEN });
  const applied = { ...ws, ...patch };
  assert.ok(Math.abs(teamTotalOf(applied, 'Alpha', MEN, CAP_SETTINGS) - best.newTotal) < 1e-6, 'apply->score == newTotal (result)');
  const roundTripped = { ...applied, ...inverse };
  for (const f of Object.keys(patch)) {
    assert.deepEqual(roundTripped[f], ws[f], `round-trip ${f} (result)`);
  }
  ok('over-cap void: all three drops positive (+10/+8/+8), capRelief + voidedPointsRestored, result round-trip');
}

// --- 3. over-cap void with recruit rows (dropSource recruit + round-trip) ---
{
  const CAP_SETTINGS = {
    ...BASE_SETTINGS,
    maxIndividualEntriesPerSwimmer: 999,
    maxTotalEntriesPerSwimmer: 2,
  };
  const recruit = (id, event, time) => ({
    id, name: 'Rec Guy', team: 'Alpha', gender: MEN, classYear: 'FR', event, time, timeType: 'SCY',
  });
  const ws = baseWorkspace({
    scoringSettings: CAP_SETTINGS,
    menResults: [
      result('b1', 'Beta One', 'Beta', '50 Freestyle', '20.00', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', '100 Freestyle', '44.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
      result('b4', 'Beta Four', 'Beta', '100 Butterfly', '49.00', { rank: 1, roundSwam: 'A Final' }),
      result('cg', 'Clean Guy', 'Alpha', '100 Butterfly', '50.00', { rank: 2, roundSwam: 'A Final' }),
    ],
    recruits: [
      recruit('rg-50', '50 Freestyle', '21.00'),
      recruit('rg-100', '100 Freestyle', '45.00'),
      recruit('rg-bk', '100 Backstroke', '48.00'),
    ],
  });

  // Rec Guy scores 3 in each event (2nd behind the Beta row) = 9, all voided (3 > cap 2).
  const ranking = rankDropOnly(ws, { team: 'Alpha', gender: MEN, settings: CAP_SETTINGS });
  const recDrops = ranking.drops.filter(d => d.dropSource === 'recruit');
  assert.equal(recDrops.length, 3, 'all three recruit drops positive');
  for (const d of recDrops) {
    assert.equal(d.athlete, 'Rec Guy');
    assert.equal(d.capRelief, true);
    assert.equal(d.deltaPoints, 6, 'restore 9 voided, lose 3 scored = +6');
    assert.equal(d.scoredDelta, -3);
    assert.equal(d.voidedPointsRestored, 9);
    assert.ok(d.dropRecruitId, 'dropRecruitId populated');
  }

  const d = recDrops[0];
  const { patch, inverse } = applyEntryDrop(ws, d, { team: 'Alpha', gender: MEN });
  const applied = { ...ws, ...patch };
  assert.ok(Math.abs(teamTotalOf(applied, 'Alpha', MEN, CAP_SETTINGS) - d.newTotal) < 1e-6, 'apply->score == newTotal (recruit)');
  const roundTripped = { ...applied, ...inverse };
  for (const f of Object.keys(patch)) {
    assert.deepEqual(roundTripped[f], ws[f], `round-trip ${f} (recruit)`);
  }
  ok('over-cap void via recruit rows: +6 each, recruit round-trip verified');
}

// --- 4. add-only respects entry caps; delta equals brute force; fast === full ---
{
  const ws = baseWorkspace({
    scoringSettings: BASE_SETTINGS,
    menResults: [
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
      result('b2', 'Beta Two', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
    ],
    meetEntryPlans: [
      // Cap Guy is at the individual cap (3): NO adds despite a strong 100 Back best.
      plan('c-200fr', 'Cap Guy', 'Alpha', '200 Freestyle', '1:40.00'),
      plan('c-500fr', 'Cap Guy', 'Alpha', '500 Freestyle', '4:30.00'),
      plan('c-200fl', 'Cap Guy', 'Alpha', '200 Butterfly', '1:50.00'),
    ],
    activeEntryIds: ['c-200fr', 'c-500fr', 'c-200fl'],
    athleteHistory: [
      { name: 'Cap Guy', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
      { name: 'Cap Guy', team: 'Alpha', gender: MEN, event: '200 Freestyle', time: '1:40.00', timeType: 'SCY', source: 'paste' },
      { name: 'Free Guy', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha Two', team: 'Alpha', gender: MEN, event: '100 Butterfly', time: '48.00', timeType: 'SCY', source: 'paste' },
      { name: 'Alpha Two', team: 'Alpha', gender: MEN, event: '50 Freestyle', time: '21.00', timeType: 'SCY', source: 'paste' },
    ],
  });

  const ranking = rankAddOnly(ws, { team: 'Alpha', gender: MEN, settings: BASE_SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  assert.ok(ranking.adds.length >= 2, 'Free Guy 100 Back + Alpha Two 100 Fly adds surfaced');
  assert.ok(!ranking.adds.some(a => a.athlete === 'Cap Guy'), 'at-cap swimmer gets no add suggestions');

  const fg = ranking.adds.find(a => a.athlete === 'Free Guy' && a.addEvent === '100 Backstroke');
  assert.ok(fg, 'Free Guy open-slot add surfaced');
  assert.equal(fg.deltaPoints, 5, '46.00 wins the 100 Back field (+5), nothing dropped');

  // Delta equals brute force: apply patch -> full re-score.
  const baseTotal = teamTotalOf(ws, 'Alpha', MEN, BASE_SETTINGS);
  for (const a of ranking.adds) {
    const { patch, inverse } = applyEntryAdd(ws, a, { team: 'Alpha', gender: MEN });
    const applied = { ...ws, ...patch };
    const scored = teamTotalOf(applied, 'Alpha', MEN, BASE_SETTINGS);
    assert.ok(Math.abs(scored - a.newTotal) < 1e-6, `apply->score == newTotal (${a.athlete} ${a.addEvent})`);
    assert.ok(Math.abs(scored - baseTotal - a.deltaPoints) < 1e-6, `delta equals brute force (${a.athlete} ${a.addEvent})`);
    const roundTripped = { ...applied, ...inverse };
    for (const f of Object.keys(patch)) {
      assert.deepEqual(roundTripped[f], ws[f], `add round-trip ${f} (${a.athlete})`);
    }
  }

  // Fast === full.
  assertRankingFastEqualsFull(
    rankAddOnly, ws, { team: 'Alpha', gender: MEN, settings: BASE_SETTINGS },
    'adds', r => `${r.athlete}|${r.addEvent}`, 'add-only'
  );

  // Total-cap variant (NSISC-style): with maxTotalEntriesPerSwimmer 1, Alpha Two
  // (already holding one meet entry) gets NO adds; Free Guy (0 entries) still does.
  const TOTAL1 = { ...BASE_SETTINGS, maxTotalEntriesPerSwimmer: 1 };
  const capped = rankAddOnly(ws, { team: 'Alpha', gender: MEN, settings: TOTAL1 });
  assert.ok(!capped.adds.some(a => a.athlete === 'Alpha Two'), 'swimmer at total cap gets no add suggestions');
  assert.ok(capped.adds.some(a => a.athlete === 'Free Guy'), 'under-total-cap swimmer still gets adds');
  ok('add-only: caps respected (ind + total), deltas equal brute force, fast === full, round-trips');
}

// --- 5. conversion confidence bands: near-margin tagged, clear-margin not ---
{
  const ws = baseWorkspace({
    scoringSettings: BASE_SETTINGS,
    menResults: [
      // 100 Back field time 49.30 — Conv Guy's LCM 58.00 converts to 49.01 (margin 0.29 < 1%).
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '49.30', { rank: 1, roundSwam: 'A Final' }),
      // 100 Fly field time 54.00 — Conv Guy's LCM 56.00 converts to ~49.17 (margin ~4.8s, clear).
      result('b2', 'Beta Two', 'Beta', '100 Butterfly', '54.00', { rank: 1, roundSwam: 'A Final' }),
      result('b3', 'Beta Three', 'Beta', '50 Freestyle', '20.50', { rank: 1, roundSwam: 'A Final' }),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 2, roundSwam: 'A Final' }),
      result('b4', 'Beta Four', 'Beta', '200 Freestyle', '1:40.00', { rank: 1, roundSwam: 'A Final' }),
    ],
    meetEntryPlans: [plan('cv-200', 'Conv Guy', 'Alpha', '200 Freestyle', '1:43.00')],
    activeEntryIds: ['cv-200'],
    athleteHistory: [
      { name: 'Conv Guy', team: 'Alpha', gender: MEN, event: '200 Freestyle', time: '1:43.00', timeType: 'SCY', source: 'paste' },
      { name: 'Conv Guy', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '58.00', timeType: 'LCM', source: 'paste' },
      { name: 'Conv Guy', team: 'Alpha', gender: MEN, event: '100 Butterfly', time: '56.00', timeType: 'LCM', source: 'paste' },
    ],
  });

  assert.ok(CONVERSION_VERIFY_MARGIN > 0 && CONVERSION_VERIFY_MARGIN <= 0.02, 'margin is ~1%');

  // Add-only rows.
  const adds = rankAddOnly(ws, { team: 'Alpha', gender: MEN, settings: BASE_SETTINGS });
  const back = adds.adds.find(a => a.athlete === 'Conv Guy' && a.addEvent === '100 Backstroke');
  const fly = adds.adds.find(a => a.athlete === 'Conv Guy' && a.addEvent === '100 Butterfly');
  assert.ok(back && fly, 'both converted adds surfaced');
  assert.equal(back.addTimeConverted, true);
  assert.equal(back.confidence, 'verify', 'near-margin converted add tagged verify');
  assert.equal(fly.addTimeConverted, true);
  assert.equal(fly.confidence, undefined, 'clear-margin converted add NOT tagged');

  // Swap rows (existing rankExactSwaps) get the same additive tagging.
  const swaps = rankExactSwaps(ws, { team: 'Alpha', gender: MEN, settings: BASE_SETTINGS });
  const swapBack = swaps.swaps.find(s => s.athlete === 'Conv Guy' && s.addEvent === '100 Backstroke');
  const swapFly = swaps.swaps.find(s => s.athlete === 'Conv Guy' && s.addEvent === '100 Butterfly');
  assert.ok(swapBack && swapFly, 'both converted swaps surfaced');
  assert.equal(swapBack.addTimeConverted, true);
  assert.equal(swapBack.confidence, 'verify', 'near-margin converted swap tagged verify');
  assert.equal(swapFly.confidence, undefined, 'clear-margin converted swap NOT tagged');
  ok('conversion confidence: near-margin (0.29s on 49.01) tagged verify; clear margin untagged; swaps + adds');
}

// --- 6. bundle carries dropRanking + addRanking (worker pass-through shape) ---
{
  const ws = baseWorkspace({
    scoringSettings: BASE_SETTINGS,
    menResults: [
      result('b1', 'Beta One', 'Beta', '100 Backstroke', '47.00', { rank: 1, roundSwam: 'A Final' }),
      result('a2', 'Alpha Two', 'Alpha', '50 Freestyle', '21.00', { rank: 1, roundSwam: 'A Final' }),
    ],
    athleteHistory: [
      { name: 'Free Guy', team: 'Alpha', gender: MEN, event: '100 Backstroke', time: '46.00', timeType: 'SCY', source: 'paste' },
    ],
  });
  const bundle = computeCrossCourseArbitrage(ws, { team: 'Alpha', gender: MEN, settings: BASE_SETTINGS });
  assert.ok(bundle.dropRanking && Array.isArray(bundle.dropRanking.drops), 'dropRanking present');
  assert.ok(bundle.addRanking && Array.isArray(bundle.addRanking.adds), 'addRanking present');
  assert.equal(bundle.dropRanking.pointsMeaningful, true);
  assert.equal(bundle.addRanking.pointsMeaningful, true);
  ok('computeCrossCourseArbitrage bundle includes dropRanking + addRanking');
}

console.log(`\ndrop/add analysis tests passed (${n} groups)`);
