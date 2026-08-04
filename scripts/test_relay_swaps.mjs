/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Relay-leg swap enumeration + theory-alternate auto-fill tests.
 * Run: npx tsx scripts/test_relay_swaps.mjs
 *
 * Engine note: the what-if scorer places relays by their stored rank (never by
 * time) and treats A/B-final relays as unconditionally eligible when
 * scorerAutoRules.includeRelayLegsInFinals is true (the NSISC default) — so on a
 * normal A/B field a relay-leg substitution is a zero-delta no-op. A leg fill
 * moves team points only when it flips an eligibility/completeness gate; the
 * fixtures below use scorerAutoRules.includeRelayLegsInFinals:false (a supported
 * setting) so a vacated non-scorer leg makes the relay ineligible until refilled,
 * which is the regime where a fill's DOUBLED relay points show up.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  rankRelayLegSwaps,
  applyRelayLegSwap,
} from '../packages/core/src/lib/crossCourseArbitrage.ts';
import {
  parseScoringTheory,
  applyScoringTheory,
  suggestRelayAlternatePromotions,
} from '../packages/core/src/lib/scoringTheory.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** Team total via the same pipeline rankRelayLegSwaps uses (apply->score + brute force). */
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

/** Roster regime whose A-final relays are gated on every leg being a scorer (doubled relays). */
const ELIG_SETTINGS = {
  scoringPoints: [9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'meet',
  scorerEligibilityMode: 'roster',
  scorerAutoRules: {
    abFinalTiers: ['A', 'B'],
    includeRelayLegsInFinals: false,
    distanceFinalRequired: true,
    distanceEventPattern: ['1000', '1650', '1500'],
  },
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 3,
  maxRelayEntriesPerSwimmer: 4,
};

function ind(id, name, team, event, time, rank) {
  return { id, rank, name, classYear: 'JR', team, time, points: 0, event, gender: MEN, isRelay: false, roundSwam: 'A Final' };
}

/** The 4 leg rows of one relay entry (shared team clock + relayNames). */
function relayLegs(idPrefix, team, event, rank, teamTime, legNames, splits) {
  const names = legNames.map(nm => ({ name: nm, year: 'JR' }));
  return legNames.map((nm, i) => ({
    id: `${idPrefix}-${i}`,
    rank,
    name: nm,
    classYear: 'JR',
    team,
    time: teamTime,
    finalsTime: teamTime,
    relayTeamTime: teamTime,
    relayLegSplit: splits[i],
    relayLegIndex: i,
    relayNames: names,
    points: 0,
    event,
    gender: MEN,
    isRelay: true,
    roundSwam: 'A Final',
  }));
}

function baseWorkspace(overrides = {}) {
  return {
    id: 'ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    scoringSettings: ELIG_SETTINGS,
    conference: undefined,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    ...overrides,
  };
}

// ============================================================================
// (a)+(b)+(c) free relay: refilling a vacated non-scorer leg flips eligibility;
// delta = DOUBLED relay points; enumeration === brute force; apply/inverse round-trip.
// ============================================================================
{
  const TEAM = 'Alpha';
  const ev = '200 Yard Freestyle Relay';
  const menResults = [
    ind('a1', 'Alpha One', TEAM, '50 Freestyle', '20.00', 2),
    ind('a2', 'Alpha Two', TEAM, '50 Freestyle', '20.50', 3),
    ind('a3', 'Alpha Three', TEAM, '50 Freestyle', '21.00', 4),
    ind('a5', 'Alpha Five', TEAM, '50 Freestyle', '20.20', 5),
    ind('b1', 'Beta One', 'Beta', '50 Freestyle', '19.90', 1),
    // Leg 3 is held by Alpha Four (marked a non-scorer below, with no individual swim).
    ...relayLegs('rel', TEAM, ev, 1, '1:22.00', ['Alpha One', 'Alpha Two', 'Alpha Three', 'Alpha Four'], ['20.5', '20.5', '20.5', '20.5']),
  ];
  const ws = baseWorkspace({
    menResults,
    athleteHistory: [
      { name: 'Alpha Five', team: TEAM, gender: MEN, event: '50 Freestyle', time: '20.20', timeType: 'SCY', source: 'paste' },
    ],
    // Alpha Four not a scorer -> leg 3 vacated -> relay ineligible (all-scorer gate).
    scorerRosterOverrides: [{ name: 'Alpha Four', team: TEAM, gender: MEN, isScorer: false }],
  });

  const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: MEN, settings: ELIG_SETTINGS });
  assert.equal(ranking.pointsMeaningful, true);
  // Only the vacated leg 3 is replaceable (healthy scorer legs are skipped no-ops);
  // it has exactly one resolvable candidate (Alpha Five).
  assert.equal(ranking.candidatesEvaluated, 1, 'only the replaceable leg is enumerated');
  assert.equal(ranking.swaps.length, 1, 'exactly one beneficial relay-leg swap');

  const swap = ranking.swaps[0];
  assert.equal(swap.inAthlete, 'Alpha Five');
  assert.equal(swap.outAthlete, 'Alpha Four');
  assert.equal(swap.legIndex, 3);
  assert.equal(swap.stroke, 'free');
  assert.equal(swap.legDistanceYards, 50);
  assert.equal(swap.inTime, '20.20', 'display time = incoming cross-course best');
  assert.equal(swap.clockLegTime, '20.5', 'clock held at the departed leg split');
  assert.equal(swap.baseTotal, teamTotalOf(ws, TEAM, MEN, ELIG_SETTINGS));
  // (b) doubled relay points: rank-1 place value (9) x relayMultiplier (2) = 18.
  assert.equal(swap.deltaPoints, 18, 'delta == scoringPoints[0] * relayMultiplier (doubled)');
  assert.equal(swap.newTotal - swap.baseTotal, 18);

  // (a) exactness: every surfaced swap's newTotal matches an INDEPENDENT brute-force
  // re-score of the same applied override on a fresh clone.
  for (const s of ranking.swaps) {
    const { patch } = applyRelayLegSwap(ws, s, { team: TEAM, gender: MEN });
    const brute = teamTotalOf({ ...ws, ...patch }, TEAM, MEN, ELIG_SETTINGS);
    assert.ok(Math.abs(brute - s.newTotal) < 1e-6, `brute-force newTotal matches (${s.inAthlete})`);
  }
  ok('free relay: non-scorer leg refill flips eligibility, delta = DOUBLED relay points, exact vs brute force');

  // (c) applyRelayLegSwap patch/inverse round-trip deep-equal + apply->score == newTotal.
  {
    const { patch, inverse, description } = applyRelayLegSwap(ws, swap, { team: TEAM, gender: MEN });
    const applied = { ...ws, ...patch };
    const scored = teamTotalOf(applied, TEAM, MEN, ELIG_SETTINGS);
    assert.ok(Math.abs(scored - swap.newTotal) < 1e-6, 'apply->score == newTotal');
    const roundTripped = { ...applied, ...inverse };
    for (const f of Object.keys(patch)) {
      assert.deepEqual(roundTripped[f], ws[f], `round-trip ${f}`);
    }
    const applOv = patch.relayLegOverrides.find(o => o.legIndex === 3);
    assert.ok(applOv && applOv.assigneeName === 'Alpha Five' && applOv.manualLegTime === '20.5');
    assert.ok(description.includes('Alpha Five') && description.includes('Alpha Four'));
    ok('applyRelayLegSwap: apply->score == newTotal, inverse round-trips relayLegOverrides deep-equal');
  }
}

// ============================================================================
// (e) medley relay stroke-correctness: only the correct-stroke swimmer is offered
// for a leg — a backstroker is never suggested onto the breast leg.
// ============================================================================
{
  const TEAM = 'Alpha';
  const ev = '200 Yard Medley Relay';
  const menResults = [
    ind('m0', 'Backer Prime', TEAM, '50 Backstroke', '23.0', 1),
    ind('m2', 'Flyer Prime', TEAM, '50 Butterfly', '22.5', 1),
    ind('m3', 'Freer Prime', TEAM, '50 Freestyle', '20.5', 2),
    // Candidates not on the relay: a backstroker and a breaststroker.
    ind('c-back', 'Backer Sub', TEAM, '50 Backstroke', '23.5', 3),
    ind('c-breast', 'Breaster Sub', TEAM, '50 Breaststroke', '25.5', 1),
    ind('b1', 'Beta One', 'Beta', '50 Freestyle', '19.9', 1),
    // Legs [back, breast, fly, free]; the breast holder (Breaster Prime) has no swim.
    ...relayLegs('mr', TEAM, ev, 1, '1:32.00', ['Backer Prime', 'Breaster Prime', 'Flyer Prime', 'Freer Prime'], ['23.0', '25.0', '22.5', '20.5']),
  ];
  const ws = baseWorkspace({
    menResults,
    // Breaster Prime not a scorer -> breast leg vacated -> relay ineligible until refilled.
    scorerRosterOverrides: [{ name: 'Breaster Prime', team: TEAM, gender: MEN, isScorer: false }],
  });

  const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: MEN, settings: ELIG_SETTINGS });
  const breastSwaps = ranking.swaps.filter(s => s.legIndex === 1);
  assert.ok(breastSwaps.length >= 1, 'breast leg gets a beneficial fill');
  assert.ok(breastSwaps.every(s => s.stroke === 'breast'));
  assert.ok(breastSwaps.some(s => s.inAthlete === 'Breaster Sub'), 'breaststroker offered on the breast leg');
  assert.ok(breastSwaps.every(s => s.deltaPoints > 0));
  assert.ok(
    !ranking.swaps.some(s => s.inAthlete === 'Backer Sub'),
    'backstroker never suggested (stroke filter excludes them from the breast leg)'
  );
  // Only the vacated breast leg is enumerated. The pool holds BOTH a backstroker and
  // a breaststroker, yet exactly ONE candidate is evaluated — the stroke filter drops
  // the backstroker from the breast leg (else candidatesEvaluated would be 2).
  assert.equal(ranking.candidatesEvaluated, 1, 'stroke filter excludes the backstroker from the breast leg');
  ok('medley relay: stroke-correct candidate only (backstroker excluded from breast leg)');
}

// ============================================================================
// theory-alternate persistence: applyScoringTheory stores resolved alternates on
// the RelayLegOverride.
// ============================================================================
{
  const TEAM = 'Henderson State University';
  const THEORY = ['Scoring team relays', '', '800 FR', 'A River, Beni, Curtis, Colton/Hunter/Alan'].join('\n');
  const relayRow = (id, rank, time) => ({
    id, rank, name: TEAM, classYear: '', team: TEAM, time, relayTeamTime: time,
    points: 0, event: '800 Yard Freestyle Relay', gender: MEN, isRelay: true, roundSwam: 'A Final',
  });
  const ws = baseWorkspace({
    conference: 'NSISC',
    menResults: [
      ind('r1', 'River Paulk', TEAM, '200 Freestyle', '1:38.00', 1),
      ind('r2', 'Colton Bennett', TEAM, '200 Freestyle', '1:39.00', 1),
      ind('r3', 'Hunter Rytting', TEAM, '200 Freestyle', '1:39.50', 1),
      ind('r4', 'Alan Gonzalez', TEAM, '200 Freestyle', '1:40.00', 1),
      relayRow('rel1', 1, '6:40.00'),
    ],
    athleteHistory: [
      { name: 'Benedek BONA', team: TEAM, gender: MEN, event: '200 Freestyle', time: '1:40.00', timeType: 'SCY', source: 'paste' },
    ],
  });
  const result = applyScoringTheory(ws, parseScoringTheory(THEORY), { team: TEAM, gender: MEN });
  const anchor = (result.patch.relayLegOverrides ?? []).find(o => o.legIndex === 3);
  assert.ok(anchor, 'anchor leg override created');
  assert.equal(anchor.assigneeName, 'Colton Bennett', 'primary = first listed');
  assert.deepEqual(anchor.alternates, ['Hunter Rytting', 'Alan Gonzalez'], 'alternates persisted (roster-resolved)');
  ok('applyScoringTheory persists roster-resolved alternates on the leg override');
}

// ============================================================================
// (d) alternate promotion triggers on a soft-removed primary; patch round-trips.
// ============================================================================
{
  const TEAM = 'Henderson State University';
  const relayRow = (id, rank, time) => ({
    id, rank, name: TEAM, classYear: '', team: TEAM, time, relayTeamTime: time,
    points: 0, event: '800 Yard Freestyle Relay', gender: MEN, isRelay: true, roundSwam: 'A Final',
  });
  const results = [
    ind('r1', 'River Paulk', TEAM, '200 Freestyle', '1:38.00', 1),
    ind('r2', 'Colton Bennett', TEAM, '200 Freestyle', '1:39.00', 2),
    ind('r3', 'Hunter Rytting', TEAM, '200 Freestyle', '1:39.50', 3),
    ind('r4', 'Alan Gonzalez', TEAM, '200 Freestyle', '1:40.00', 4),
    relayRow('rel1', 1, '6:40.00'),
  ];
  const key = relayEntryKey(results.find(r => r.isRelay));
  const override = {
    relayEntryKey: key,
    legIndex: 3,
    assigneeName: 'Colton Bennett',
    source: 'manual',
    alternates: ['Hunter Rytting', 'Alan Gonzalez'],
  };
  const ws = baseWorkspace({
    conference: 'NSISC',
    menResults: results,
    relayLegOverrides: [override],
    deletedSwimmers: [{ name: 'Colton Bennett', gender: MEN }],
  });

  const suggestions = suggestRelayAlternatePromotions(ws, { team: TEAM, gender: MEN });
  assert.equal(suggestions.length, 1, 'one promotion suggested');
  const sug = suggestions[0];
  assert.equal(sug.primary, 'Colton Bennett');
  assert.equal(sug.alternate, 'Hunter Rytting', 'first AVAILABLE alternate promoted');
  assert.equal(sug.reason, 'soft_removed');
  assert.equal(sug.legIndex, 3);
  assert.ok(sug.description.includes('Hunter Rytting') && sug.description.includes('Colton Bennett'));

  const applied = { ...ws, ...sug.patch };
  const applOv = applied.relayLegOverrides.find(o => o.legIndex === 3);
  assert.equal(applOv.assigneeName, 'Hunter Rytting');
  assert.deepEqual(applOv.alternates, ['Hunter Rytting', 'Alan Gonzalez'], 'alternates preserved');
  const roundTripped = { ...applied, ...sug.inverse };
  assert.deepEqual(roundTripped.relayLegOverrides, ws.relayLegOverrides, 'inverse round-trips relayLegOverrides');

  // No trigger when the primary is available.
  const wsOk = baseWorkspace({ conference: 'NSISC', menResults: results, relayLegOverrides: [override], deletedSwimmers: [] });
  assert.equal(suggestRelayAlternatePromotions(wsOk, { team: TEAM, gender: MEN }).length, 0, 'no promotion when primary available');
  ok('alternate promotion triggers on soft-removed primary, promotes first available alternate, patch round-trips');
}

// ============================================================================
// realistic merged NSISC workspace (skipped when data/meets.json lacks it) + timing.
// ============================================================================
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
    console.log('  skip - realistic merged workspace (data/meets.json lacks roster-plan + NSISC-results workspaces)');
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
    const ranking = rankRelayLegSwaps(ws, { team, gender: MEN });
    const t1 = performance.now();

    // Every surfaced swap must match an independent brute-force re-score.
    for (const s of ranking.swaps) {
      const { patch } = applyRelayLegSwap(ws, s, { team, gender: MEN });
      const brute = teamTotalOf({ ...ws, ...patch }, team, MEN);
      assert.ok(Math.abs(brute - s.newTotal) < 1e-6, `realistic brute-force matches (${s.inAthlete} L${s.legIndex + 1})`);
    }
    console.log(
      `  (timing) MEN relay-leg swaps: ${(t1 - t0).toFixed(0)}ms over ${ranking.candidatesEvaluated} candidates -> ${ranking.swaps.length} beneficial`
    );
    if (ranking.swaps[0]) {
      const s = ranking.swaps[0];
      console.log(`  (top) ${s.relayEvent} leg ${s.legIndex + 1} ${s.stroke}: +${s.inAthlete} for ${s.outAthlete} = +${s.deltaPoints}`);
    }
    ok(`realistic NSISC workspace: ${ranking.swaps.length} beneficial relay-leg swaps, exact vs brute force`);
  }
}

console.log(`\nrelay-leg swap tests passed (${n} groups)`);
