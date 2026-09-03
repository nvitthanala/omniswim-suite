/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A tie group must be a dead heat, and an arbitrage delta must land on the
 * scoring grid.
 *
 * THE BUG. `calculatePoints` re-derived a placement for every `isRecruit` row
 * through `prepareRecruitsForScoring`, which ranked each recruit ALONE against
 * the meet rows in its event. Two consequences, both of which put rows with
 * DIFFERENT times on the same rank:
 *
 *   1. It overwrote the placement `projectRanksInField` had already assigned.
 *      That pass ranks the whole what-if field — meet rows, plans and recruit
 *      rows together — so on a projected workspace every row arrives already
 *      placed. Re-deriving one recruit's place from a subset of the field
 *      discarded a correct answer for a wrong one.
 *   2. With no meet rows there are no comparators at all, so EVERY recruit came
 *      back rank 1 and an entire event scored as one N-way tie
 *      (plans/2026-08-14/12 §2 — diagnosed 2026-08-16, open until now).
 *
 * `scoreIndividualsInEvent` groups by event + round + rank and divides the place
 * ladder across the group, so a fabricated tie pays fractional points no scoring
 * table can award. Measured on data/meets.json before the fix:
 *
 *   Blank Workspace 1 men   14 fabricated ties   HSU 1128.5
 *   HSU 2026-27 Roster Plan 14 fabricated ties   HSU 1066.3686902422194
 *   OBU 2026-27 Roster      14 fabricated ties   OBU 1114.597072467762
 *
 * and an arbitrage card reading `Avery Henke +400 IM -100 Butterfly +8.667`,
 * where 8.667 is a third of a place ladder shared between three swimmers whose
 * times were 4:05.95, 4:07.75 and 4:09.18.
 *
 * WHAT IS ASSERTED. Sections 1-4 are hermetic and pin the placement rules
 * directly. Sections 5-6 read data/meets.json and assert PROPERTIES, not
 * snapshots, so editing a lineup cannot fail them: no scored tie group may hold
 * two different times, and every team total and every arbitrage delta must be a
 * multiple of 0.5 (place points are integers; only a real dead heat halves one).
 *
 * NOT COVERED. Sections 5-6 score each workspace AS SAVED. One regime is still
 * broken and is deliberately out of this test's reach: delete every planned
 * entry from a meet workspace that also holds recruits and the field stops being
 * projected, so a recruit is placed against the meet rows while those rows keep
 * their own places — a recruit placed 7th then shares a rank with the real 7th
 * finisher. See the STILL OPEN note on `prepareRecruitsForScoring`.
 *
 * Test: npx tsx scripts/test_recruit_placement_grid.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculatePoints,
  convertTimeToSeconds,
  isRelayResult,
  mergeScoringSettings,
  parseRankInt,
  prepareRecruitsForScoring,
} from '../packages/core/src/lib/utils.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import {
  rankAddOnly,
  rankDropOnly,
  rankExactSwaps,
} from '../packages/core/src/lib/crossCourseArbitrage.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';
const RIVAL = 'Ouachita Baptist University';
const EVENT = 'Event 8 Men 50 Yard Freestyle';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** Half-point grid, to floating-point epsilon. */
const onGrid = v => Math.abs(v * 2 - Math.round(v * 2)) < 1e-6;

const SETTINGS = mergeScoringSettings({
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 99,
  maxRelayEntriesPerSwimmer: 99,
  maxTotalEntriesPerSwimmer: 999,
});

let idc = 0;
function row(name, team, time, extra = {}) {
  return {
    id: `row${(idc += 1)}`,
    rank: 0,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event: EVENT,
    gender: MEN,
    ...extra,
  };
}

const recruitRow = (name, time, extra = {}) => row(name, TEAM, time, { isRecruit: true, ...extra });

// --- 1. a row that already carries a placement keeps it ---------------------
// projectRanksInField placed these three against the full field. Re-deriving
// the placement is what put two different times on one rank.
{
  const placed = [
    recruitRow('Alpha', '20.10', { rank: 4, roundSwam: 'A Final' }),
    recruitRow('Bravo', '20.50', { rank: 9, roundSwam: 'B Final' }),
    recruitRow('Charlie', '21.00', { rank: 17, roundSwam: 'Preliminaries' }),
  ];
  const prepared = prepareRecruitsForScoring([], placed);
  assert.deepEqual(
    prepared.map(r => [r.rank, r.roundSwam]),
    [
      [4, 'A Final'],
      [9, 'B Final'],
      [17, 'Preliminaries'],
    ],
    'a placed recruit row keeps its rank AND its round'
  );
  ok('an already-placed recruit row is passed through untouched');
}

// --- 2. unplaced recruits are placed against EACH OTHER ---------------------
// The roster-only regime: no meet rows, so no comparators. Every one of these
// used to come back rank 1, and the event scored as one five-way tie.
{
  const recruits = [
    recruitRow('Slowest', '22.00'),
    recruitRow('Fastest', '20.00'),
    recruitRow('Middle', '21.00'),
  ];
  const prepared = prepareRecruitsForScoring([], recruits);
  const byName = Object.fromEntries(prepared.map(r => [r.name, r.rank]));
  assert.deepEqual(
    byName,
    { Slowest: 3, Fastest: 1, Middle: 2 },
    'with no comparators the recruits are still placed 1..N in time order'
  );
  assert.equal(
    new Set(prepared.map(r => r.rank)).size,
    prepared.length,
    'three different times must occupy three different places'
  );
  ok('recruits with no comparators get distinct places, not all rank 1');
}

// --- 3. an exact time tie still shares a place ------------------------------
// The fix must not over-correct: equal times ARE a dead heat and must split.
{
  const recruits = [
    recruitRow('DeadHeatA', '20.10'),
    recruitRow('DeadHeatB', '20.10'),
    recruitRow('Third', '20.90'),
  ];
  const prepared = prepareRecruitsForScoring([], recruits);
  const byName = Object.fromEntries(prepared.map(r => [r.name, r.rank]));
  assert.deepEqual(
    byName,
    { DeadHeatA: 1, DeadHeatB: 1, Third: 3 },
    'equal times share a place; the next distinct time takes the place after both'
  );
  ok('an exact time tie still shares one place (1, 1, 3)');
}

// --- 4. the fabricated split is gone from the scored output -----------------
// This is the number the user saw. On the old logic all three rows came back
// rank 1, one tie group, each paid (20+17+16)/3 = 17.666... — a third of a
// place ladder, on a scale whose entries are integers.
{
  const recruits = [
    recruitRow('First', '20.00'),
    recruitRow('Second', '20.50'),
    recruitRow('Third', '21.00'),
  ];
  const scored = calculatePoints(recruits, SETTINGS);
  const pts = Object.fromEntries(scored.map(r => [r.name, r.points]));
  assert.deepEqual(
    pts,
    { First: 20, Second: 17, Third: 16 },
    'three distinct times take three distinct places and three whole point values'
  );
  for (const r of scored) {
    assert.ok(onGrid(r.points), `${r.name} scored ${r.points}, which is not on the 0.5 grid`);
  }
  ok('a roster-only event pays 20/17/16, not 17.667 three times');
}

// --- 5. no scored tie group holds two different times (live workspaces) -----
// The invariant the bug violated, asserted as a property so a lineup edit
// cannot fail it. A genuine dead heat (equal times) is allowed and expected.
const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const workspaces = Object.values(meets);
assert.ok(workspaces.length > 0, 'data/meets.json must hold at least one workspace');

/** The exact key scoreIndividualsInEvent groups a tie on. */
const tieKey = r => {
  const rk = parseRankInt(r.rank) ?? 0;
  const ev = String(r.event ?? '').trim();
  const round = (r.roundSwam || '').trim();
  return rk > 0
    ? `${ev}|${round}|${rk}`
    : `${ev}|${round}|T|${convertTimeToSeconds(r.time)}|${r.name}`;
};

for (const ws of workspaces) {
  const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  for (const gender of [Gender.MEN, Gender.WOMEN]) {
    const rows = buildWhatIfResults({ workspace: ws, gender, removeSeniors: false });
    if (rows.length === 0) continue;
    const scored = calculatePoints(rows, settings, {
      scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
      conferenceForMerge: ws.conference,
      resultsForPdfHint: [...(ws.menResults ?? []), ...(ws.womenResults ?? [])],
    });

    const groups = new Map();
    for (const r of scored) {
      if (isRelayResult(r)) continue;
      const k = tieKey(r);
      const held = groups.get(k);
      if (held) held.push(r);
      else groups.set(k, [r]);
    }
    for (const [k, g] of groups) {
      if (g.length < 2) continue;
      const times = new Set(g.map(r => convertTimeToSeconds(r.time)));
      assert.equal(
        times.size,
        1,
        `${ws.name} / ${gender}: "${k}" holds ${g.length} rows on one placement with ` +
          `${times.size} different times (${g.map(r => `${r.name} ${r.time}`).join(', ')}). ` +
          'That is a fabricated dead heat; the place ladder is being split across it.'
      );
    }

    const totals = new Map();
    for (const r of scored) {
      const t = String(r.team ?? '').trim();
      totals.set(t, (totals.get(t) ?? 0) + (Number(r.points) || 0));
    }
    for (const [team, pts] of totals) {
      assert.ok(
        onGrid(pts),
        `${ws.name} / ${gender}: ${team} totals ${pts}, which is not a multiple of 0.5`
      );
    }
    ok(`${ws.name} / ${gender}: ${groups.size} placements, every team total on the grid`);
  }
}

// --- 6. every arbitrage delta lands on the grid (live workspaces) -----------
// The user-facing acceptance: a card's number is a real team-total delta, and a
// team total is a sum of place points, so the difference is a multiple of 0.5.
for (const ws of workspaces) {
  const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
  const teams = new Set();
  for (const r of [...(ws.menResults ?? []), ...(ws.womenResults ?? [])])
    teams.add(String(r.team ?? '').trim());
  for (const r of ws.recruits ?? []) teams.add(String(r.team ?? '').trim());
  for (const p of ws.meetEntryPlans ?? []) teams.add(String(p.team ?? '').trim());
  teams.delete('');

  for (const gender of [Gender.MEN, Gender.WOMEN]) {
    for (const team of teams) {
      const opts = { team, gender, settings };
      const checked = [];
      const swaps = rankExactSwaps(ws, opts);
      if (swaps.pointsMeaningful) {
        for (const s of swaps.swaps)
          checked.push([s.deltaPoints, `swap ${s.athlete} +${s.addEvent} -${s.dropEvent}`]);
      }
      const drops = rankDropOnly(ws, opts);
      if (drops.pointsMeaningful) {
        for (const d of drops.drops) checked.push([d.deltaPoints, `drop ${d.athlete} -${d.dropEvent}`]);
      }
      const adds = rankAddOnly(ws, opts);
      if (adds.pointsMeaningful) {
        for (const a of adds.adds) checked.push([a.deltaPoints, `add ${a.athlete} +${a.addEvent}`]);
      }
      if (checked.length === 0) continue;
      for (const [delta, label] of checked) {
        assert.ok(
          onGrid(delta),
          `${ws.name} / ${gender} / ${team}: ${label} claims ${delta} points, which is not a ` +
            'multiple of 0.5. Place points are integers; only a real dead heat produces a half.'
        );
      }
      ok(`${ws.name} / ${gender} / ${team}: ${checked.length} arbitrage deltas, all on the grid`);
    }
  }
}

console.log(`\n${n} assertions passed`);
