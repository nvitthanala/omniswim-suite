/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The what-if projection scores THREE planes. Every rule must reach all three.
 *
 * Reported 2026-08-30, verbatim: "when i would remove swimmers or seniors, the
 * meet wouldn't recalculate, changing events would also cause duplications of
 * swimmers." Both halves are one defect in `buildWhatIfProjection`: it composed
 * meet result rows, recruit rows and planned entries by concatenation and never
 * reconciled them.
 *
 *   1. THE GATES REACHED ONE PLANE. `simulateRoster` applies `deletedSwimmers`
 *      and `removeSeniors` to the loaded meet's rows. Recruits were appended
 *      AFTER that filter and plans were overlaid after that, so neither gate
 *      touched either. On the primary HSU workspace — built by import, so every
 *      athlete is a recruit row or a planned entry and none of them is a PDF row
 *      — "Drop seniors" moved no row at all, and a removed athlete kept scoring
 *      from the plane the removal did not reach. Nothing threw; the total simply
 *      did not move, which reads as "it didn't recalculate".
 *
 *   2. NOTHING RECONCILED THE PLANES. One athlete could hold an entry for the
 *      same event on two planes at once and SCORE TWICE. That is never a legal
 *      meet state, and it is why changing an event read as a duplication rather
 *      than a move — the new entry stacked on the old one. The shape is not
 *      hypothetical: `scripts/test_fast_swap_context.mjs` used to describe
 *      recruit-plus-plan as "the exact shape the live HSU workspace holds for
 *      five men", and `optimizeEventLineupForTeam` manufactures it on every run
 *      by planning events the athlete's recruit rows already cover. Measured on
 *      the meet fixture in `test_optimizer_never_loses.mjs`: the optimizer
 *      reported 272.00 -> 484.00, and every one of those 212 points came from
 *      entering four swimmers twice in four events.
 *
 * A third defect sat on top of both: `planToResult` stamps `isRecruit: true` on
 * a planned entry as well as a recruit row, and the drawer's delete handler read
 * that flag to decide which array to filter. Deleting a plan-backed swim
 * filtered `workspace.recruits` by a plan id, removed nothing, and reported
 * success. `removeProjectedSwim` dispatches on where the id lives instead.
 *
 * Fixtures are hermetic and built in-process — they must NOT read
 * data/meets.json, or CI would fail when the user edits a lineup.
 *
 * Test: npx tsx scripts/test_projection_roster_gates.mjs
 */
import assert from 'node:assert/strict';
import {
  buildWhatIfProjection,
  buildWhatIfResults,
} from '../packages/core/src/lib/whatIfProjection.ts';
import {
  removeAthleteFromWorkspace,
  softRemoveSwimmerFromWorkspace,
} from '../packages/core/src/lib/swimmerSoftRemove.ts';
import {
  editCreditedSwim,
  removePlannedEntry,
  removeProjectedSwim,
  updatePlannedEntry,
} from '../packages/core/src/lib/swimEditor.ts';
import { calculatePoints } from '../packages/core/src/lib/utils.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults.ts';
import { Gender } from '../packages/core/src/types.ts';

const MEN = Gender.MEN;
const TEAM = 'Henderson State University';
const RIVAL = 'Ouachita Baptist University';

let n = 0;
const ok = msg => {
  n += 1;
  console.log(`  ok ${n} — ${msg}`);
};

/** No conference, so no preset lock overrides the values under test. */
const SETTINGS = mergeScoringSettings({
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  aFinalBracketSize: 8,
  maxIndividualScorersPerTeam: 999,
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
  maxTotalEntriesPerSwimmer: 999,
  scorerEligibilityMode: 'points_pool',
});

const meetRow = (id, name, event, time, classYear = 'JR', team = TEAM) => ({
  id,
  rank: 0,
  name,
  classYear,
  team,
  time,
  finalsTime: time,
  roundSwam: 'A Final',
  points: 0,
  event,
  gender: MEN,
  isRelay: false,
});

const recruitRow = (id, name, event, time, classYear = 'JR') => ({
  id,
  name,
  team: TEAM,
  gender: MEN,
  classYear,
  event,
  time,
  timeType: 'SCY',
});

const planRow = (id, name, event, time, classYear = 'JR', extra = {}) => ({
  id,
  name,
  team: TEAM,
  gender: MEN,
  classYear,
  event,
  time,
  timeType: 'SCY',
  source: 'manual',
  active: true,
  ...extra,
});

const workspace = (o = {}) => ({
  id: 'gates-ws',
  name: 'Projection roster gates',
  createdAt: 1,
  menResults: [],
  womenResults: [],
  recruits: [],
  meetEntryPlans: [],
  activeEntryIds: [],
  athleteHistory: [],
  deletedSwimmers: [],
  scorerRosterOverrides: [],
  relayLegOverrides: [],
  athleteAliases: [],
  ...o,
});

const project = ws => buildWhatIfResults({ workspace: ws, gender: MEN, removeSeniors: false });
const projectNoSeniors = ws =>
  buildWhatIfResults({ workspace: ws, gender: MEN, removeSeniors: true });

const teamTotal = (ws, removeSeniors = false) => {
  const rows = buildWhatIfResults({ workspace: ws, gender: MEN, removeSeniors });
  const scored = calculatePoints(rows, SETTINGS, {
    resultsForPdfHint: [...(ws.menResults ?? []), ...(ws.womenResults ?? [])],
  });
  return scored
    .filter(r => String(r.team ?? '').trim() === TEAM)
    .reduce((s, r) => s + (r.points ?? 0), 0);
};

const label = rows => rows.map(r => `${r.name}|${r.event}`).sort();
const apply = (ws, result) => ({ ...ws, ...result.patch });

// ===========================================================================
// 1. REMOVING A SWIMMER REACHES EVERY PLANE
//
// The tombstone in `deletedSwimmers` is the removal. It must silence the
// athlete wherever their rows live — not only in the meet results, which on a
// roster-built workspace is the one place they DON'T live.
// ===========================================================================
{
  const ws = workspace({
    menResults: [meetRow('m1', 'Pdf Athlete', '50 Freestyle', '21.00')],
    recruits: [recruitRow('r1', 'Recruit Athlete', '50 Freestyle', '21.50')],
    meetEntryPlans: [planRow('p1', 'Plan Athlete', '50 Freestyle', '22.00')],
  });

  assert.deepEqual(
    label(project(ws)),
    ['Pdf Athlete|50 Freestyle', 'Plan Athlete|50 Freestyle', 'Recruit Athlete|50 Freestyle'],
    'fixture must start with one athlete on each of the three planes'
  );

  for (const name of ['Pdf Athlete', 'Recruit Athlete', 'Plan Athlete']) {
    const hidden = apply(ws, { patch: softRemoveSwimmerFromWorkspace(ws, { name, gender: MEN }) });
    const rows = project(hidden);
    assert.ok(
      !rows.some(r => r.name === name),
      `soft-removing ${name} left them scoring — the tombstone did not reach their plane`
    );
    assert.equal(rows.length, 2, `soft-removing ${name} must drop exactly one row`);
  }
  ok('a soft removal silences the athlete on all three planes, not just the meet rows');

  // The tombstone alone has to be enough. softRemoveSwimmerFromWorkspace also
  // strips the recruit/plan rows in the same patch, which MASKED this bug in the
  // UI — until an import or the optimizer put them back under the tombstone.
  const tombstoneOnly = {
    ...ws,
    deletedSwimmers: [
      { name: 'Recruit Athlete', gender: MEN, mode: 'hidden' },
      { name: 'Plan Athlete', gender: MEN, mode: 'hidden' },
    ],
  };
  assert.deepEqual(
    label(project(tombstoneOnly)),
    ['Pdf Athlete|50 Freestyle'],
    'a tombstone with the rows still present must still silence them'
  );
  ok('the tombstone alone silences a recruit row and a planned entry');

  // Name form must not matter: the roster stores "Last, First" in places.
  const commaForm = {
    ...ws,
    deletedSwimmers: [{ name: 'Athlete, Recruit', gender: MEN, mode: 'hidden' }],
  };
  assert.ok(
    !project(commaForm).some(r => r.name === 'Recruit Athlete'),
    'a "Last, First" tombstone must match the recruit row'
  );
  ok('the tombstone matches across "Last, First" and "First Last" spellings');

  // Not vacuous: the removal has to move the number the coach reads.
  const before = teamTotal(ws);
  const after = teamTotal(
    apply(ws, {
      patch: softRemoveSwimmerFromWorkspace(ws, { name: 'Recruit Athlete', gender: MEN }),
    })
  );
  assert.ok(before > 0, 'fixture must score before anything is removed');
  assert.ok(after < before, `removing a scoring athlete must lower the total: ${before} -> ${after}`);
  ok(`removing a recruit-backed athlete recalculates the total (${before} -> ${after})`);
}

// ===========================================================================
// 2. "DROP SENIORS" REACHES EVERY PLANE
// ===========================================================================
{
  const ws = workspace({
    menResults: [
      meetRow('m1', 'Pdf Senior', '50 Freestyle', '21.00', 'SR'),
      meetRow('m2', 'Pdf Junior', '50 Freestyle', '21.10', 'JR'),
    ],
    recruits: [
      recruitRow('r1', 'Recruit Senior', '50 Freestyle', '21.20', 'SR'),
      recruitRow('r2', 'Recruit Grad', '50 Freestyle', '21.25', 'GR'),
      recruitRow('r3', 'Recruit Sophomore', '50 Freestyle', '21.30', 'SO'),
    ],
    meetEntryPlans: [
      planRow('p1', 'Plan Senior', '50 Freestyle', '21.40', 'SR'),
      planRow('p2', 'Plan Freshman', '50 Freestyle', '21.50', 'FR'),
    ],
  });

  assert.equal(project(ws).length, 7, 'fixture holds seven entrants with the toggle off');

  const kept = label(projectNoSeniors(ws));
  assert.deepEqual(
    kept,
    [
      'Pdf Junior|50 Freestyle',
      'Plan Freshman|50 Freestyle',
      'Recruit Sophomore|50 Freestyle',
    ],
    'Drop seniors must remove the senior and grad rows on every plane'
  );
  ok('Drop seniors reaches recruit rows and planned entries, not only the meet rows');

  // GR counts as graduating on every plane, the same as SR — isGraduatingClassYear
  // is the one test, so the planes cannot drift apart again.
  assert.ok(!kept.some(x => x.startsWith('Recruit Grad')), 'a grad-year recruit is graduating too');
  ok('a grad-year (GR) recruit is dropped alongside the seniors');

  // Absent is not senior. An athlete whose year was never recorded is kept.
  const unknownYear = workspace({
    recruits: [{ ...recruitRow('r9', 'No Year Recorded', '50 Freestyle', '21.00'), classYear: undefined }],
    meetEntryPlans: [{ ...planRow('p9', 'No Year Planned', '50 Freestyle', '21.10'), classYear: undefined }],
  });
  assert.deepEqual(
    label(projectNoSeniors(unknownYear)),
    ['No Year Planned|50 Freestyle', 'No Year Recorded|50 Freestyle'],
    'an unrecorded class year must not be guessed at as SR'
  );
  ok('an unrecorded class year is kept — absent is not senior');

  const before = teamTotal(ws, false);
  const after = teamTotal(ws, true);
  assert.ok(after < before, `Drop seniors must move the total: ${before} -> ${after}`);
  ok(`Drop seniors recalculates the total (${before} -> ${after})`);
}

// ===========================================================================
// 3. ONE ATHLETE, ONE ENTRY PER EVENT — CHANGING AN EVENT MOVES, NOT DUPLICATES
// ===========================================================================
{
  // (a) recruit + plan on the same event: the plan is the explicit decision.
  const both = workspace({
    recruits: [recruitRow('r1', 'Alan Gonzalez', '50 Freestyle', '21.00')],
    meetEntryPlans: [planRow('p1', 'Alan Gonzalez', '50 Freestyle', '20.50')],
  });
  const proj = buildWhatIfProjection({ workspace: both, gender: MEN, removeSeniors: false });
  assert.equal(proj.rows.length, 1, 'one athlete may hold only one entry in one event');
  assert.equal(proj.rows[0].id, 'p1', 'the planned entry supersedes the recruit row');
  assert.deepEqual(
    proj.collapsed.map(r => r.id),
    ['r1'],
    'the superseded row must be reported, not silently vanish'
  );
  ok('a recruit row and a planned entry for one event collapse to the planned entry');

  // (b) meet row + plan on the same event, through the merged-mode remap. This
  //     is the live import path: the plan carries the canonical label, the meet
  //     carries its own, and the remap lands them on the same event.
  const merged = workspace({
    menResults: [meetRow('m1', 'Alan Gonzalez', 'Men 50 Yard Freestyle', '21.00')],
    meetEntryPlans: [planRow('p1', 'Alan Gonzalez', '50 Freestyle', '20.50')],
  });
  const mergedRows = project(merged);
  assert.equal(
    mergedRows.length,
    1,
    'a plan remapped onto the loaded meet label must supersede the meet row, not join it'
  );
  assert.equal(mergedRows[0].event, 'Men 50 Yard Freestyle', 'and it competes under the meet label');
  assert.equal(mergedRows[0].time, '20.50', 'with the planned time');
  ok('a plan remapped onto the meet label supersedes the meet row rather than doubling it');

  // (c) THE REPORTED REPRO. An athlete carried as a recruit row; the user
  //     changes their event by planning the new one. Before: two rows in two
  //     events. After: the athlete swims exactly one event.
  const moved = workspace({
    recruits: [recruitRow('r1', 'Alan Gonzalez', '50 Freestyle', '21.00')],
    meetEntryPlans: [planRow('p1', 'Alan Gonzalez', '50 Freestyle', '21.00')],
  });
  const changed = apply(moved, updatePlannedEntry(moved, 'p1', { event: '100 Freestyle' }));
  const changedRows = project(changed);
  assert.equal(
    changedRows.filter(r => r.name === 'Alan Gonzalez').length,
    2,
    'the athlete is now in two DIFFERENT events, which is legal — one entry each'
  );
  for (const event of ['50 Freestyle', '100 Freestyle']) {
    assert.equal(
      changedRows.filter(r => r.name === 'Alan Gonzalez' && r.event === event).length,
      1,
      `${event} must hold exactly one entry for this athlete`
    );
  }
  ok('changing a planned event never leaves two entries for one athlete in one event');

  // (d) A duplicate must not corrupt the field order either. The collapse runs
  //     before ranks are projected, so a phantom entry cannot push a rival down.
  const field = workspace({
    recruits: [
      recruitRow('r1', 'Alan Gonzalez', '50 Freestyle', '20.00'),
      { ...recruitRow('rv', 'Rival Swimmer', '50 Freestyle', '20.60'), team: RIVAL },
    ],
    meetEntryPlans: [
      planRow('p1', 'Alan Gonzalez', '50 Freestyle', '20.10', 'JR', { source: 'optimizer' }),
    ],
  });
  const ranked = project(field);
  const rival = ranked.find(r => r.name === 'Rival Swimmer');
  assert.equal(ranked.length, 2, 'the collapsed field holds one entry per athlete');
  assert.equal(rival.rank, 2, `a phantom second entry must not push the rival to ${rival.rank}`);
  ok('the collapse runs before rank projection, so a duplicate cannot displace a rival');

  // (e) SCOPE. Two rows on ONE plane are a duplicate import, not a lineup
  //     decision — the projection leaves them alone and the duplicate-athlete
  //     audit is what surfaces them. Guarding this keeps the collapse from
  //     quietly widening into "drop any row that looks like another one".
  const samePlane = workspace({
    recruits: [
      recruitRow('r1', 'Alan Gonzalez', '50 Freestyle', '21.00'),
      recruitRow('r2', 'Alan Gonzalez', '50 Freestyle', '21.00'),
    ],
  });
  assert.equal(project(samePlane).length, 2, 'two recruit rows are left for the audit to report');
  ok('same-plane duplicates are left intact — only a more explicit plane displaces a row');

  // (f) Different athletes and different events never collide.
  const distinct = workspace({
    recruits: [recruitRow('r1', 'Alan Gonzalez', '50 Freestyle', '21.00')],
    meetEntryPlans: [
      planRow('p1', 'Alan Gonzalez', '100 Freestyle', '46.00'),
      planRow('p2', 'Other Swimmer', '50 Freestyle', '21.00'),
    ],
  });
  assert.equal(project(distinct).length, 3, 'distinct athlete/event pairs must all survive');
  ok('the collapse keys on athlete AND event — nothing else is touched');

  // (g) AN EDITED MEET ROW CARRIES THE PLAN'S PRECEDENCE.
  //
  //     `editCreditedSwim` layers a pencil edit as a `replacesResultId` overlay
  //     plan, and `applyOverlayPlans` rewrites the meet row's event/time IN PLACE
  //     while KEEPING the row's id — deliberately, because `removeProjectedSwim`
  //     dispatches on where the id lives and a delete of the row the coach sees
  //     must remove the meet swim, not the plan behind it.
  //
  //     `planeOf` read that id and still called the row a meet row, so a stale
  //     recruit row — a LESS explicit statement — displaced the coach's edit and
  //     scored in its place. Nothing threw and nothing on screen said the edit
  //     had not taken; the old time simply kept scoring.
  const editedVsRecruit = workspace({
    menResults: [meetRow('m1', 'Alan Gonzalez', 'Men 100 Yard Freestyle', '50.00')],
    recruits: [recruitRow('r1', 'Alan Gonzalez', '100 Freestyle', '51.00')],
  });

  // Baseline, before any edit: a recruit row IS more explicit than a loaded meet
  // row, so it supersedes. That part was always right.
  const beforeEdit = buildWhatIfProjection({
    workspace: editedVsRecruit,
    gender: MEN,
    removeSeniors: false,
  });
  assert.deepEqual(
    beforeEdit.rows.map(r => r.id),
    ['r1'],
    'untouched, the recruit row supersedes the meet row'
  );

  const edited = apply(
    editedVsRecruit,
    editCreditedSwim(editedVsRecruit, MEN, 'm1', { time: '49.00' })
  );
  const afterEdit = buildWhatIfProjection({ workspace: edited, gender: MEN, removeSeniors: false });

  assert.equal(afterEdit.rows.length, 1, 'the athlete still holds exactly one entry in the event');
  assert.equal(afterEdit.rows[0].time, '49.00', "the coach's edited time is the one that scores");
  assert.equal(
    afterEdit.rows[0].event,
    'Men 100 Yard Freestyle',
    'and it competes under the loaded meet label'
  );
  assert.equal(
    afterEdit.rows[0].id,
    'm1',
    'the row keeps the meet id removeProjectedSwim dispatches on'
  );
  assert.deepEqual(
    afterEdit.collapsed.map(r => r.id),
    ['r1'],
    'the recruit row is the row that gets superseded, and it is reported'
  );
  ok('a pencil-edited meet row outranks a stale recruit row instead of vanishing');

  // A pencil edit and the equivalent standalone plan are the same statement made
  // two ways, so they must compose the same pool.
  const plannedInstead = workspace({
    menResults: [meetRow('m1', 'Alan Gonzalez', 'Men 100 Yard Freestyle', '50.00')],
    recruits: [recruitRow('r1', 'Alan Gonzalez', '100 Freestyle', '51.00')],
    meetEntryPlans: [planRow('p1', 'Alan Gonzalez', '100 Freestyle', '49.00')],
  });
  const plannedRows = project(plannedInstead);
  assert.equal(plannedRows.length, 1, 'the standalone plan composes one entry too');
  assert.equal(plannedRows[0].time, afterEdit.rows[0].time, 'same surviving time as the pencil edit');
  assert.equal(
    plannedRows[0].event,
    afterEdit.rows[0].event,
    'same surviving event as the pencil edit'
  );
  ok('a pencil edit and the equivalent standalone plan compose the same pool');

  // The id has to stay `m1`. Deleting the row the coach sees removes the meet
  // swim; deleting the plan behind it would restore the old time instead.
  const deletedEdit = apply(edited, removeProjectedSwim(edited, MEN, 'm1'));
  assert.deepEqual(
    project(deletedEdit).map(r => r.id),
    ['r1'],
    'deleting the edited row removes the meet swim and lets the recruit row resurface'
  );
  ok('the edited row is still deletable by the id the pool shows');

  // Two plan-plane statements for one athlete in one event are two lineup
  // decisions in conflict, and the projection has no basis to prefer either.
  // Same-plane rows both survive — the rule case (e) states, applied to a row
  // whose content came from a plan. The collapse never picks a winner.
  const conflicting = {
    ...edited,
    meetEntryPlans: [
      ...edited.meetEntryPlans,
      planRow('p2', 'Alan Gonzalez', '100 Freestyle', '48.00'),
    ],
  };
  const conflictRows = project(conflicting);
  assert.equal(conflictRows.length, 2, 'two plan-plane statements both survive');
  assert.deepEqual(
    conflictRows.map(r => r.time).sort(),
    ['48.00', '49.00'],
    'neither plan silently wins — the recruit row is all that collapses'
  );
  ok('two conflicting plan-plane entries are both kept rather than one picked');
}

// ===========================================================================
// 4. DELETING A PROJECTED SWIM HITS THE PLANE THE ROW CAME FROM
// ===========================================================================
{
  const ws = workspace({
    menResults: [meetRow('m1', 'Pdf Athlete', '50 Freestyle', '21.00')],
    recruits: [recruitRow('r1', 'Recruit Athlete', '100 Freestyle', '46.00')],
    meetEntryPlans: [planRow('p1', 'Plan Athlete', '200 Freestyle', '1:42.00')],
    activeEntryIds: ['p1'],
  });

  // The bug: a plan row and a recruit row are BOTH `isRecruit: true` in the
  // scored pool, so a handler branching on that flag filtered the wrong array.
  const rows = project(ws);
  const planRowScored = rows.find(r => r.id === 'p1');
  const recruitRowScored = rows.find(r => r.id === 'r1');
  assert.equal(planRowScored.isRecruit, true, 'a planned entry is flagged isRecruit in the pool');
  assert.equal(recruitRowScored.isRecruit, true, 'so is a recruit row — the flag cannot disambiguate');

  const droppedPlan = apply(ws, removeProjectedSwim(ws, MEN, 'p1'));
  assert.ok(
    !project(droppedPlan).some(r => r.id === 'p1'),
    'removing a plan-backed swim must actually remove it'
  );
  assert.deepEqual(droppedPlan.activeEntryIds, [], 'and drop it from the activeEntryIds allowlist');
  assert.deepEqual(droppedPlan.recruits, ws.recruits, 'without touching the recruit rows');
  ok('removing a plan-backed credited swim removes the plan (was a silent no-op)');

  const droppedRecruit = apply(ws, removeProjectedSwim(ws, MEN, 'r1'));
  assert.ok(!project(droppedRecruit).some(r => r.id === 'r1'), 'a recruit row is removed by id');
  assert.deepEqual(droppedRecruit.meetEntryPlans, ws.meetEntryPlans, 'without touching the plans');
  ok('removing a recruit-backed credited swim removes the recruit row');

  const droppedMeet = apply(ws, removeProjectedSwim(ws, MEN, 'm1'));
  assert.ok(!project(droppedMeet).some(r => r.id === 'm1'), 'a meet row is removed from the working copy');
  assert.deepEqual(
    droppedMeet.sourceMenResults,
    ws.sourceMenResults,
    'the frozen source copy is never touched'
  );
  ok('removing a meet-backed credited swim filters the working results only');

  // An id that names nothing must raise. A delete that quietly removes nothing
  // is the failure this function exists to end.
  assert.throws(
    () => removeProjectedSwim(ws, MEN, 'no-such-id'),
    /not a planned entry, a recruit, or a menResults row/,
    'an unknown id must raise rather than return an empty patch'
  );
  ok('an unknown row id raises instead of returning a patch that removes nothing');

  // Undo must restore the workspace exactly — same contract as every other
  // swimEditor function.
  for (const id of ['p1', 'r1', 'm1']) {
    const result = removeProjectedSwim(ws, MEN, id);
    const undone = { ...apply(ws, result), ...result.inverse };
    assert.deepEqual(undone.meetEntryPlans, ws.meetEntryPlans, `${id}: plans restored`);
    assert.deepEqual(undone.recruits, ws.recruits, `${id}: recruits restored`);
    assert.deepEqual(undone.menResults, ws.menResults, `${id}: menResults restored`);
    assert.deepEqual(undone.activeEntryIds, ws.activeEntryIds, `${id}: activeEntryIds restored`);
    assert.ok(result.description.length > 0, `${id}: carries a description for the undo chip`);
  }
  ok('every removeProjectedSwim patch round-trips through its inverse');

  // The plan branch is the existing editor function, not a second mechanism.
  assert.deepEqual(
    removeProjectedSwim(ws, MEN, 'p1').patch,
    removePlannedEntry(ws, 'p1').patch,
    'the plan branch must be removePlannedEntry, not a parallel implementation'
  );
  ok('the plan branch delegates to removePlannedEntry');
}

// ===========================================================================
// 5. A PERMANENT REMOVAL STILL CLEARS EVERY PLANE
// ===========================================================================
{
  const ws = workspace({
    menResults: [meetRow('m1', 'Curtis Malone', '50 Freestyle', '21.00')],
    recruits: [recruitRow('r1', 'Curtis Malone', '100 Freestyle', '46.00')],
    meetEntryPlans: [planRow('p1', 'Curtis Malone', '200 Freestyle', '1:42.00')],
    activeEntryIds: ['p1'],
  });
  assert.equal(project(ws).length, 3, 'the athlete starts with a row on each plane');

  const result = removeAthleteFromWorkspace(ws, { name: 'Curtis Malone', gender: MEN });
  const removed = apply(ws, result);
  assert.deepEqual(project(removed), [], 'a permanent removal leaves the athlete nowhere');
  assert.deepEqual(
    removed.sourceMenResults,
    ws.sourceMenResults,
    'and never touches the frozen source copy'
  );

  const undone = { ...removed, ...result.inverse };
  assert.equal(project(undone).length, 3, 'the inverse restores all three planes');
  ok('a permanent removal clears all three planes and its inverse restores them');
}

console.log(`\ntest_projection_roster_gates OK (${n} assertions)`);
