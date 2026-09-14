/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Arbitrage card + optimizer tests.
 *
 * This file used to assert `Array.isArray(cards)` and
 * `indFirst.meetEntryPlans.length >= 0`. The second is true of every array in
 * JavaScript, and the first passed on an EMPTY list that `buildArbitrageCards`
 * returns from its "only one team in the field" early exit — so the card-building
 * path was never reached at all. Both fixtures below now distinguish the two
 * empties, which is the CLAUDE.md "absent ≠ empty" rule applied to this panel:
 * a card list that is empty because no point value can be stated must be
 * distinguishable from one that is empty because no swap gains anything.
 *
 * FIXED 2026-08-30. `optimizeWithArbitrage` used to compute `previousTotal` and
 * `projectedTotal` and return unconditionally, with no never-loses guard and no
 * `outcome`. It now shares `selectGuardedResult` with `optimizeRosterForTeam`.
 * The never-loses invariant is pinned in scripts/test_arbitrage_never_loses.mjs;
 * this file covers the cards and the result shape.
 *
 * Because of that guard, the optimizer may legitimately return the caller's own
 * lineup unchanged. Assertions below branch on `outcome` rather than assuming
 * something was applied — asserting `meetEntryPlans.length > 0` unconditionally
 * would fail whenever the guard correctly refuses, which is a real outcome and
 * not a defect.
 *
 * Run: npx tsx scripts/test_roster_arbitrage.mjs
 */
import assert from 'node:assert/strict';
import { Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import {
  buildArbitrageCards,
  buildArbitrageCardsResult,
  optimizeWithArbitrage,
  relayFirstLineupForTeam,
} from '../packages/core/src/lib/rosterArbitrage.ts';

const MEN = Gender.MEN;
const EVENTS = ['50 Freestyle', '100 Freestyle', '200 Freestyle'];

/** Deterministic seconds -> "M:SS.hh" / "SS.hh". */
function secondsToTime(seconds) {
  const m = Math.floor(seconds / 60);
  const ss = (seconds - m * 60).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${ss}` : ss;
}

// ---------------------------------------------------------------------------
// Fixture 1 — one team only. The field cannot produce a point delta, so the
// panel must say WHY rather than render an empty list that reads as
// "no opportunities found".
// ---------------------------------------------------------------------------
function buildSingleTeamWorkspace() {
  const row = (id, name, time, event, rank) => ({
    id,
    rank,
    name,
    classYear: 'JR',
    team: 'Team A',
    time,
    points: 0,
    event,
    gender: MEN,
  });
  return {
    id: 'w-single',
    name: 'single team',
    createdAt: 1,
    menResults: [
      row('1', 'Fast, A', '19.50', '50 Freestyle', 1),
      row('2', 'Fast, A', '43.00', '100 Freestyle', 1),
      row('3', 'Other, B', '20.20', '50 Freestyle', 2),
    ],
    womenResults: [],
    recruits: [],
    athleteHistory: [
      {
        name: 'Fast, A',
        team: 'Team A',
        gender: MEN,
        event: '200 Freestyle',
        time: '1:36.00',
        source: 'paste',
      },
    ],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides: [],
    meetEntryPlans: [],
    activeEntryIds: [],
  };
}

// ---------------------------------------------------------------------------
// Fixture 2 — two teams contesting every event, so point deltas ARE statable
// and the real card path runs instead of the early exit.
// ---------------------------------------------------------------------------
function buildTwoTeamWorkspace() {
  const menResults = [];
  let id = 0;
  for (const [e, event] of EVENTS.entries()) {
    const field = [];
    for (let k = 0; k < 4; k += 1) field.push({ team: 'Team A', k });
    for (let k = 0; k < 4; k += 1) field.push({ team: 'Team B', k });
    field
      .map((entry, k) => ({
        ...entry,
        seconds: 21 + e * 23 + k * 0.4 + (entry.team === 'Team B' ? 0.15 : 0),
      }))
      .sort((a, b) => a.seconds - b.seconds)
      .forEach((entry, k) => {
        menResults.push({
          id: `pdf-${id++}`,
          rank: k + 1,
          name: `${entry.team === 'Team A' ? 'A' : 'B'} Swimmer ${entry.k}`,
          classYear: 'SO',
          team: entry.team,
          time: secondsToTime(entry.seconds),
          finalsTime: secondsToTime(entry.seconds),
          roundSwam: 'A Final',
          points: 0,
          event,
          gender: MEN,
          isRelay: false,
        });
      });
  }

  // History the meet does not know about — the raw material for a swap.
  const athleteHistory = [];
  for (let k = 0; k < 4; k += 1) {
    for (const [e, event] of EVENTS.entries()) {
      athleteHistory.push({
        name: `A Swimmer ${k}`,
        team: 'Team A',
        gender: MEN,
        event,
        time: secondsToTime(20.2 + e * 23 + k * 0.2),
        timeType: 'SCY',
        source: 'paste',
      });
    }
  }

  return {
    id: 'w-two',
    name: 'two teams',
    createdAt: 1,
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

// --- 1. One team => no statable point value, and the caller is told why -----
{
  const ws = buildSingleTeamWorkspace();
  const res = buildArbitrageCardsResult(ws, MEN, 'Team A', NSISC_PRESET_SETTINGS);

  assert.equal(res.pointsMeaningful, false, 'a single-team field cannot state point deltas');
  assert.deepEqual(res.cards, [], 'and therefore offers no cards');
  assert.equal(typeof res.reason, 'string', 'the empty list must carry a reason, not just be empty');
  assert.ok(res.reason.length > 0, 'the reason must actually say something');

  // The thin wrapper drops the reason, so an empty array from it is ambiguous by
  // construction. Pin that so a caller reaching for it knows to use the *Result form.
  assert.deepEqual(
    buildArbitrageCards(ws, MEN, 'Team A', NSISC_PRESET_SETTINGS),
    [],
    'buildArbitrageCards returns only the list'
  );
}

// --- 2. Two teams => the point value IS statable and no reason is given -----
// This is what separates a real empty from the early exit above.
{
  const ws = buildTwoTeamWorkspace();
  const res = buildArbitrageCardsResult(ws, MEN, 'Team A', NSISC_PRESET_SETTINGS);

  assert.equal(res.pointsMeaningful, true, 'two scoring teams => point deltas are statable');
  assert.equal(res.reason, undefined, 'a statable field must not carry a "cannot state" reason');
  assert.ok(Array.isArray(res.cards), 'cards is a list');
  for (const card of res.cards) {
    // `arbitragePts`, not `deltaPoints` — `deltaPoints` is the field name on the
    // raw swap from `rankExactSwaps`, and an ArbitrageCard does not carry it.
    // Reading the wrong name made this loop assert `Number.isFinite(undefined)`,
    // which only passed because the list happened to be empty.
    assert.ok(
      Number.isFinite(card.arbitragePts),
      `every card states a finite point delta, got ${card.arbitragePts}`
    );
  }
}

// --- 3. The optimizer returns real numbers, not NaN, and honours its mode ---
// `typeof x === 'number'` would accept NaN, which is exactly what a broken
// scoring path produces, so every total is checked with Number.isFinite.
{
  for (const mode of ['individual_first', 'relay_first']) {
    const ws = buildTwoTeamWorkspace();
    const res = optimizeWithArbitrage(ws, MEN, 'Team A', false, NSISC_PRESET_SETTINGS, mode);

    assert.equal(res.mode, mode, `${mode}: mode round-trips`);
    assert.ok(Number.isFinite(res.previousTotal), `${mode}: previousTotal is a real number`);
    assert.ok(Number.isFinite(res.projectedTotal), `${mode}: projectedTotal is a real number`);
    assert.ok(res.previousTotal > 0, `${mode}: fixture must score before optimizing`);

    // The guard makes "nothing beat the current lineup" a real answer, so the
    // shape check has to branch on which answer came back.
    assert.ok(Array.isArray(res.meetEntryPlans), `${mode}: meetEntryPlans is a list`);
    assert.ok(
      ['improved', 'unchanged'].includes(res.outcome),
      `${mode}: outcome must be set, got ${res.outcome}`
    );
    if (res.outcome === 'improved') {
      assert.ok(
        res.meetEntryPlans.length > 0,
        `${mode}: an applied lineup must actually contain entries`
      );
      assert.ok(
        res.projectedTotal > res.previousTotal,
        `${mode}: improved must report a strict gain`
      );
    } else {
      assert.deepEqual(
        res.meetEntryPlans,
        ws.meetEntryPlans,
        `${mode}: a refused optimization returns the caller's own plans`
      );
      assert.equal(
        res.projectedTotal,
        res.previousTotal,
        `${mode}: unchanged must report projected === previous`
      );
    }
    assert.ok(
      res.projectedTotal >= res.previousTotal,
      `${mode}: the optimizer must never lower the team total: ` +
        `${res.previousTotal} -> ${res.projectedTotal}`
    );
    // Every active id must name a plan that exists — a dangling id silently
    // drops a swimmer from the lineup.
    const planIds = new Set(res.meetEntryPlans.map(p => p.id));
    for (const activeId of res.activeEntryIds ?? []) {
      assert.ok(planIds.has(activeId), `${mode}: activeEntryIds references a missing plan ${activeId}`);
    }

    // The caller's workspace must come back untouched.
    assert.deepEqual(ws.meetEntryPlans, [], `${mode}: input plans not mutated`);
    assert.deepEqual(ws.scorerRosterOverrides, [], `${mode}: input overrides not mutated`);
    assert.deepEqual(ws.activeEntryIds, [], `${mode}: input activeEntryIds not mutated`);
  }
}

// --- 4. relay_first must not double-count a linked alias -------------------
// `relayFirstLineupForTeam` used to call `buildScorerRosterLookup` without an
// alias resolver, while `optimizeEventLineupForTeam` (the individual_first
// sibling) passed `buildAliasResolver(workspace)`. Without it, two spellings
// of one real athlete surfaced as two separate roster rows, and the loop
// that builds relay+individual entries ran once per row — the same human's
// swims got planned twice, past their entry cap, under two different names.
{
  const canonical = 'Alex Aliased';
  const aliasSpelling = 'Alexander Aliased';
  const events = ['50 Freestyle', '100 Freestyle', '200 Freestyle'];

  const recruitRow = (id, name, event, seconds) => ({
    id,
    name,
    team: 'Team A',
    event,
    time: secondsToTime(seconds),
    gender: MEN,
    classYear: 'FR',
    timeType: 'SCY',
  });

  // Both spellings hold recruit rows for the same three events — this is what
  // makes each spelling its own roster row before the fix.
  const recruits = [
    recruitRow('r1', canonical, events[0], 21.0),
    recruitRow('r2', canonical, events[1], 45.0),
    recruitRow('r3', canonical, events[2], 100.0),
    recruitRow('r4', aliasSpelling, events[0], 21.0),
    recruitRow('r5', aliasSpelling, events[1], 45.0),
    recruitRow('r6', aliasSpelling, events[2], 100.0),
  ];

  // athleteHistory is what getAthleteProfile actually reads for best times —
  // it already resolves aliases internally, so both spellings see the same
  // events regardless of which name queries it. That is exactly why the bug
  // is silent: the profile looks identical either way, so calling it twice
  // (once per spelling) just plans the same swims twice.
  const athleteHistory = events.flatMap((event, i) => [
    { name: canonical, team: 'Team A', gender: MEN, event, time: secondsToTime(21 + i * 24), timeType: 'SCY', source: 'paste' },
    { name: aliasSpelling, team: 'Team A', gender: MEN, event, time: secondsToTime(21 + i * 24), timeType: 'SCY', source: 'paste' },
  ]);

  const ws = {
    id: 'w-alias',
    name: 'alias duplication',
    createdAt: 1,
    menResults: [],
    womenResults: [],
    recruits,
    athleteHistory,
    athleteAliases: [
      {
        id: 'link-1',
        gender: MEN,
        team: 'Team A',
        canonicalName: canonical,
        aliasName: aliasSpelling,
        source: 'manual',
        createdAt: '2026-08-15T00:00:00.000Z',
      },
    ],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    scorerRosterOverrides: [],
    meetEntryPlans: [],
    activeEntryIds: [],
  };

  const { plans } = relayFirstLineupForTeam(ws, MEN, 'Team A', NSISC_PRESET_SETTINGS);
  const forAthlete = plans.filter(p => p.name === canonical || p.name === aliasSpelling);
  const indCap = NSISC_PRESET_SETTINGS.maxIndividualEntriesPerSwimmer ?? 3;

  assert.equal(
    plans.filter(p => p.name === aliasSpelling).length,
    0,
    'the alias spelling must never hold a planned entry — everything resolves to the canonical name'
  );
  assert.ok(
    forAthlete.length <= indCap,
    `one real athlete must not exceed the individual cap of ${indCap} once merged, got ${forAthlete.length}`
  );
  // With three history events and no relay legs, the pre-fix bug planned all
  // three events under BOTH spellings — six entries for one person.
  assert.ok(
    forAthlete.length < 2 * indCap,
    `REGRESSION: alias split the athlete across two spellings and doubled their entries (${forAthlete.length})`
  );

  const uniqueEvents = new Set(forAthlete.map(p => p.event));
  assert.equal(
    uniqueEvents.size,
    forAthlete.length,
    'no event is planned twice for the merged athlete'
  );
}

console.log('roster arbitrage tests passed');
