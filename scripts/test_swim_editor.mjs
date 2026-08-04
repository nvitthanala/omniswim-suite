/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Swim editor (pure workspace-patch) tests.
 * Run: npx tsx scripts/test_swim_editor.mjs
 */
import assert from 'node:assert/strict';
import {
  addPlannedEntry,
  updatePlannedEntry,
  removePlannedEntry,
  addHistorySwim,
  updateHistorySwim,
  removeHistorySwim,
  editCreditedSwim,
  removeCreditedSwim,
  copyMeetIntoWorkspace,
} from '../packages/core/src/lib/swimEditor.ts';
import { buildCrossCourseTable } from '../packages/core/src/lib/crossCourseArbitrage.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const WOMEN = Gender.WOMEN;

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} - ${msg}`);
};

/** Predictable scoring: 9/4/3/2/1 for places 1-5, per-event scope, no pooling. */
const SETTINGS = {
  scoringPoints: [9, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: false,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 3,
  maxRelayEntriesPerSwimmer: 4,
};

function wresult(id, name, team, event, time, rank, extra = {}) {
  return {
    id,
    rank,
    name,
    classYear: 'JR',
    team,
    time,
    points: 0,
    event,
    gender: WOMEN,
    isRelay: false,
    roundSwam: 'A Final',
    ...extra,
  };
}

function baseWorkspace(overrides = {}) {
  return {
    id: 'ws',
    name: 'Editor Test',
    createdAt: 1000,
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

/** Two-team women's meet (HSU 13, RIV 13 baseline). */
function meetWorkspace(overrides = {}) {
  return baseWorkspace({
    womenResults: [
      wresult('a1', 'Alice', 'HSU', 'Event 1 Women 50 Yard Freestyle', '23.00', 1),
      wresult('c1', 'Cindy', 'RIV', 'Event 1 Women 50 Yard Freestyle', '24.00', 2),
      wresult('b1', 'Bella', 'RIV', 'Event 3 Women 100 Yard Freestyle', '50.00', 1),
      wresult('d1', 'Dana', 'HSU', 'Event 3 Women 100 Yard Freestyle', '52.00', 2),
    ],
    ...overrides,
  });
}

function teamTotal(ws, team, gender) {
  const merged = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
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

/** Apply a patch then its inverse and assert the workspace is byte-for-byte restored. */
function assertRoundTrip(ws, ep, label) {
  const applied = { ...ws, ...ep.patch };
  const undone = { ...applied, ...ep.inverse };
  assert.deepStrictEqual(undone, ws, `${label}: inverse round-trips`);
  // Sanity: the patch actually changed something.
  assert.notDeepStrictEqual(applied, ws, `${label}: patch changed the workspace`);
}

// --- round-trips: planned entries -------------------------------------------
{
  const ws = baseWorkspace();
  assertRoundTrip(ws, addPlannedEntry(ws, {
    name: 'New Guy', team: 'HSU', gender: MEN, event: '100 Freestyle', time: '45.00',
  }), 'addPlannedEntry');

  const wsWithPlan = baseWorkspace({
    meetEntryPlans: [{
      id: 'p1', name: 'Plan A', team: 'HSU', gender: MEN, classYear: 'JR',
      event: '100 Freestyle', time: '46.00', timeType: 'SCY', source: 'manual', active: true,
    }],
  });
  assertRoundTrip(wsWithPlan, updatePlannedEntry(wsWithPlan, 'p1', { time: '44.50', event: '200 Freestyle' }), 'updatePlannedEntry');
  assertRoundTrip(wsWithPlan, updatePlannedEntry(wsWithPlan, 'p1', { active: false }), 'updatePlannedEntry(active)');
  assertRoundTrip(wsWithPlan, removePlannedEntry(wsWithPlan, 'p1'), 'removePlannedEntry');
  ok('planned-entry add/update/remove patches round-trip');
}

// --- round-trips: activeEntryIds allowlist regime ---------------------------
{
  const ws = baseWorkspace({
    meetEntryPlans: [{
      id: 'p1', name: 'Plan A', team: 'HSU', gender: MEN, classYear: 'JR',
      event: '100 Freestyle', time: '46.00', timeType: 'SCY', source: 'manual', active: true,
    }],
    activeEntryIds: ['p1'],
  });
  const add = addPlannedEntry(ws, { name: 'B', team: 'HSU', gender: MEN, event: '50 Freestyle', time: '20.0' });
  assert.equal(add.patch.activeEntryIds.length, 2, 'new plan id appended to allowlist');
  assertRoundTrip(ws, add, 'addPlannedEntry(allowlist)');
  assertRoundTrip(ws, removePlannedEntry(ws, 'p1'), 'removePlannedEntry(allowlist)');
  assertRoundTrip(ws, updatePlannedEntry(ws, 'p1', { active: false }), 'updatePlannedEntry(active off, allowlist)');
  ok('activeEntryIds allowlist is kept in sync and round-trips');
}

// --- round-trips: history + credited ----------------------------------------
{
  const ws = baseWorkspace({
    athleteHistory: [
      { id: 'h1', name: 'Alice', team: 'HSU', gender: WOMEN, event: '100 Freestyle', time: '52.00', timeType: 'SCY', source: 'manual' },
    ],
  });
  assertRoundTrip(ws, addHistorySwim(ws, {
    name: 'Alice', team: 'HSU', gender: WOMEN, event: '50 Free', time: '23.00', timeType: 'SCY',
  }), 'addHistorySwim');
  assertRoundTrip(ws, updateHistorySwim(ws, { id: 'h1' }, { time: '49.00' }), 'updateHistorySwim');
  assertRoundTrip(ws, removeHistorySwim(ws, { id: 'h1' }), 'removeHistorySwim');

  const meet = meetWorkspace();
  assertRoundTrip(meet, editCreditedSwim(meet, WOMEN, 'a1', { event: '100 Freestyle' }), 'editCreditedSwim');
  assertRoundTrip(meet, removeCreditedSwim(meet, WOMEN, 'a1'), 'removeCreditedSwim');
  ok('history + credited-swim patches round-trip');
}

// --- credited-swim edit/remove change merged team total ---------------------
{
  const meet = meetWorkspace();
  assert.equal(teamTotal(meet, 'HSU', WOMEN), 13, 'baseline HSU total');
  assert.equal(teamTotal(meet, 'RIV', WOMEN), 13, 'baseline RIV total');

  const removed = { ...meet, ...removeCreditedSwim(meet, WOMEN, 'a1').patch };
  assert.equal(teamTotal(removed, 'HSU', WOMEN), 4, 'removing Alice 50 Free drops HSU 13 -> 4');

  // Move Alice's credited 50 Free onto the 100 Free (merged remap onto real label);
  // she ties Bella at rank 1 -> (9+4)/2 = 6.5 each, so HSU 13 -> 10.5.
  const edited = { ...meet, ...editCreditedSwim(meet, WOMEN, 'a1', { event: '100 Freestyle' }).patch };
  const editedTotal = teamTotal(edited, 'HSU', WOMEN);
  assert.notEqual(editedTotal, 13, 'edit changes HSU total');
  assert.ok(Math.abs(editedTotal - 10.5) < 1e-9, `edit moves HSU to 10.5 (got ${editedTotal})`);
  // Raw meet row is untouched (non-destructive) — a1 still present in womenResults.
  assert.ok(edited.womenResults.some(r => r.id === 'a1'), 'edit leaves the raw meet row intact');
  ok('credited-swim edit/remove change merged team total as expected');
}

// --- history edit/add changes cross-course candidate best -------------------
{
  const ws = baseWorkspace({
    athleteHistory: [
      { id: 'h1', name: 'Alice', team: 'HSU', gender: WOMEN, event: '100 Freestyle', time: '52.00', timeType: 'SCY', source: 'manual' },
    ],
  });
  const before = buildCrossCourseTable(ws, { team: 'HSU', gender: WOMEN });
  const row0 = before.rows.find(r => r.event === '100 Freestyle');
  assert.ok(row0 && Math.abs(row0.scyBest.timeSec - 52.0) < 0.01, 'baseline 100 Free best 52.00');
  assert.equal(before.rows.find(r => r.event === '50 Freestyle'), undefined, 'no 50 Free row yet');

  // Add a brand-new 50 Free history swim -> a new table row appears.
  const added = { ...ws, ...addHistorySwim(ws, {
    name: 'Alice', team: 'HSU', gender: WOMEN, event: '50 Free', time: '23.10', timeType: 'SCY',
  }).patch };
  const addedTable = buildCrossCourseTable(added, { team: 'HSU', gender: WOMEN });
  const fifty = addedTable.rows.find(r => r.event === '50 Freestyle');
  assert.ok(fifty && Math.abs(fifty.scyBest.timeSec - 23.1) < 0.01, 'added 50 Free surfaces in table');

  // Edit the 100 Free swim faster -> the candidate best changes.
  const edited = { ...ws, ...updateHistorySwim(ws, { id: 'h1' }, { time: '49.00' }).patch };
  const editedTable = buildCrossCourseTable(edited, { team: 'HSU', gender: WOMEN });
  const row1 = editedTable.rows.find(r => r.event === '100 Freestyle');
  assert.ok(row1 && Math.abs(row1.scyBest.timeSec - 49.0) < 0.01, 'edited 100 Free best now 49.00');
  ok('history add/edit change buildCrossCourseTable output');
}

// --- copyMeetIntoWorkspace: scorable target + overwrite warning -------------
{
  const source = meetWorkspace();
  // Target carries roster-plan work (men) but no meet field of its own.
  const target = baseWorkspace({
    name: 'Roster Target',
    meetEntryPlans: [{
      id: 'tp1', name: 'Tgt Guy', team: 'TGT', gender: MEN, classYear: 'JR',
      event: '100 Freestyle', time: '45.00', timeType: 'SCY', source: 'manual', active: true,
    }],
    recruits: [{ id: 'tr1', name: 'Rec', team: 'TGT', event: '50 Freestyle', time: '20.0', gender: MEN, classYear: 'HS', timeType: 'SCY' }],
    athleteHistory: [{ id: 'th1', name: 'Hist', team: 'TGT', gender: MEN, event: '100 Freestyle', time: '46.0', timeType: 'SCY', source: 'manual' }],
  });

  const { patch, warnings } = copyMeetIntoWorkspace(source, target);
  assert.equal(warnings.length, 0, 'no warnings when target has no results');
  // Roster-plan fields are NOT part of the patch.
  for (const k of ['meetEntryPlans', 'recruits', 'athleteHistory', 'deletedSwimmers', 'scorerRosterOverrides']) {
    assert.ok(!(k in patch), `patch does not copy roster-plan field ${k}`);
  }
  assert.ok(patch.sourceWomenResults && patch.sourceWomenResults.length === 4, 'frozen source copy carried over');
  assert.notEqual(patch.womenResults, patch.sourceWomenResults, 'working and source arrays are distinct');

  const applied = { ...target, ...patch };
  assert.equal(teamTotal(applied, 'HSU', WOMEN), 13, 'copied meet scores HSU 13 in target');
  assert.equal(teamTotal(applied, 'RIV', WOMEN), 13, 'copied meet scores RIV 13 in target');
  // Target roster plan is preserved and untouched.
  assert.deepStrictEqual(applied.meetEntryPlans, target.meetEntryPlans, 'target roster plans preserved');

  // Overwrite warning when the target already has a loaded meet.
  const busyTarget = meetWorkspace({ name: 'Busy Target' });
  const res2 = copyMeetIntoWorkspace(source, busyTarget);
  assert.ok(res2.warnings.some(w => /replaces them/i.test(w)), 'overwrite warning present');
  ok('copyMeetIntoWorkspace yields a scorable target and warns on overwrite');
}

console.log(`\n${n} checks passed`);
