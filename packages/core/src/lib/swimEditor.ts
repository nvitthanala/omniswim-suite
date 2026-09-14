/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure, undo-able workspace-patch editor APIs. Every function returns
 * `{ patch, inverse, description }` — the same shape `applyExactSwap`
 * (crossCourseArbitrage.ts) produces — so the Manager UI can drive them through
 * one apply/undo machine: `applied = { ...workspace, ...patch }` and
 * `undone = { ...applied, ...inverse }` restores the workspace exactly (deep
 * equal), because each `inverse` stores the full prior value of every field the
 * `patch` touched. No mutation, no I/O.
 *
 * Three data planes are editable:
 *
 *   1. Planned entries (meetEntryPlans + activeEntryIds) — what-if lineup rows.
 *   2. Athlete-history rows (athleteHistory) — supplemental swims that feed the
 *      cross-course candidate-best table.
 *   3. Credited meet swims (menResults / womenResults rows for a real team).
 *
 * `removeProjectedSwim` sits across planes 1 and 3 plus the recruit list: given
 * a row id from the SCORED pool it works out which plane owns it and delegates.
 * Callers holding a scored row cannot make that call themselves — `isRecruit` is
 * true for a planned entry and a recruit row alike.
 *
 * plus `copyMeetIntoWorkspace` ("load this meet here"), which brings a source
 * workspace's frozen meet field + scoring config into a target so roster plans
 * and a scoring field can coexist.
 *
 * CREDITED-SWIM MECHANISM (why edit and remove differ):
 *   The raw PDF meet is frozen in sourceMenResults / sourceWomenResults and is
 *   NEVER touched here. menResults / womenResults are the *working* copy.
 *   - editCreditedSwim is non-destructive by design (like athleteHistory): it
 *     leaves the meet result row byte-for-byte intact and layers the edit as an
 *     active `replacesResultId` overlay plan. buildWhatIfResults' applyOverlayPlans
 *     already honors replacesResultId (it swaps the row's event/time/finalsTime in
 *     place) AND remaps the new event onto the loaded meet label in merged mode,
 *     so merged-mode scoring composes for free.
 *   - removeCreditedSwim filters the working results array by id — exactly the
 *     app's existing delete-credited-swim semantics (TeamManagementView.handleDeleteSwim
 *     and applyExactSwap's 'result' drop) — which is reversible via the inverse
 *     patch and still leaves the frozen source copy immutable.
 *
 * Test: npx tsx scripts/test_swim_editor.mjs
 */

import { v4 as uuidv4 } from 'uuid';
import { ClassYear, Gender, HistoricalSwim, PlannedSwimEntry, Workspace } from '../types';
import { normalizeEventLabel } from './athleteHistory';
import { cloneMeetResults, getSourceResults } from './meetSource';
import { normalizeSwimmerName } from './utils';
import { createPlannedEntry } from './whatIfProjection';

/** Forward patch + exact-restore inverse + human description (applyExactSwap shape). */
export type WorkspaceEditorPatch = {
  patch: Partial<Workspace>;
  inverse: Partial<Workspace>;
  description: string;
};

type TimeType = 'SCY' | 'LCM' | 'SCM';

function genderResultsField(gender: Gender): 'menResults' | 'womenResults' {
  return gender === Gender.MEN ? 'menResults' : 'womenResults';
}

// --- 1. planned entries -----------------------------------------------------

export type AddPlannedEntryInput = {
  name: string;
  team: string;
  gender: Gender;
  event: string;
  time: string;
  timeType?: TimeType;
  classYear?: ClassYear | string;
};

/**
 * Add a fresh active what-if plan (source 'manual'). Appended to meetEntryPlans;
 * when the workspace uses an explicit activeEntryIds allowlist (non-empty) the
 * new id is added so the plan reads as active there too. When activeEntryIds is
 * empty/absent, the plan's own `active: true` flag governs — untouched.
 */
export function addPlannedEntry(
  workspace: Workspace,
  input: AddPlannedEntryInput
): WorkspaceEditorPatch {
  const entry = createPlannedEntry({
    name: input.name,
    team: String(input.team ?? '').trim(),
    gender: input.gender,
    classYear: input.classYear,
    event: input.event,
    time: input.time,
    timeType: input.timeType ?? 'SCY',
    source: 'manual',
    active: true,
  });

  const basePlans = workspace.meetEntryPlans ?? [];
  const patch: Partial<Workspace> = { meetEntryPlans: [...basePlans, entry] };
  const inverse: Partial<Workspace> = { meetEntryPlans: basePlans };

  const baseActiveIds = workspace.activeEntryIds;
  if (baseActiveIds && baseActiveIds.length > 0) {
    patch.activeEntryIds = [...baseActiveIds, entry.id];
    inverse.activeEntryIds = baseActiveIds;
  }

  return { patch, inverse, description: `Add ${input.name}: ${input.event} (${input.time})` };
}

export type UpdatePlannedEntryChanges = {
  event?: string;
  time?: string;
  timeType?: TimeType;
  active?: boolean;
};

/**
 * Patch an existing plan's event/time/timeType/active. Toggling `active` also
 * syncs activeEntryIds membership when the workspace uses that allowlist, so both
 * activity signals (the `active` flag and the allowlist) stay consistent.
 */
export function updatePlannedEntry(
  workspace: Workspace,
  planId: string,
  changes: UpdatePlannedEntryChanges
): WorkspaceEditorPatch {
  const basePlans = workspace.meetEntryPlans ?? [];
  const target = basePlans.find(p => p.id === planId);
  if (!target) throw new Error(`updatePlannedEntry: no plan with id ${planId}`);

  const applied: Partial<PlannedSwimEntry> = {};
  if (changes.event !== undefined) applied.event = changes.event;
  if (changes.time !== undefined) applied.time = changes.time;
  if (changes.timeType !== undefined) applied.timeType = changes.timeType;
  if (changes.active !== undefined) applied.active = changes.active;

  const patch: Partial<Workspace> = {
    meetEntryPlans: basePlans.map(p => (p.id === planId ? { ...p, ...applied } : p)),
  };
  const inverse: Partial<Workspace> = { meetEntryPlans: basePlans };

  const baseActiveIds = workspace.activeEntryIds;
  if (changes.active !== undefined && baseActiveIds && baseActiveIds.length > 0) {
    const has = baseActiveIds.includes(planId);
    if (changes.active && !has) {
      patch.activeEntryIds = [...baseActiveIds, planId];
      inverse.activeEntryIds = baseActiveIds;
    } else if (!changes.active && has) {
      patch.activeEntryIds = baseActiveIds.filter(id => id !== planId);
      inverse.activeEntryIds = baseActiveIds;
    }
  }

  return { patch, inverse, description: `Update entry (${target.name} ${target.event})` };
}

/** Remove a plan (and drop its id from activeEntryIds when that allowlist is used). */
export function removePlannedEntry(workspace: Workspace, planId: string): WorkspaceEditorPatch {
  const basePlans = workspace.meetEntryPlans ?? [];
  const target = basePlans.find(p => p.id === planId);

  const patch: Partial<Workspace> = { meetEntryPlans: basePlans.filter(p => p.id !== planId) };
  const inverse: Partial<Workspace> = { meetEntryPlans: basePlans };

  const baseActiveIds = workspace.activeEntryIds;
  if (baseActiveIds && baseActiveIds.length > 0 && baseActiveIds.includes(planId)) {
    patch.activeEntryIds = baseActiveIds.filter(id => id !== planId);
    inverse.activeEntryIds = baseActiveIds;
  }

  return {
    patch,
    inverse,
    description: target ? `Remove entry (${target.name} ${target.event})` : `Remove entry ${planId}`,
  };
}

// --- 2. athlete-history rows ------------------------------------------------

/**
 * Reference to a history row. Prefer `{ id }` for rows the editor created;
 * legacy rows (no id) are matched by content — supply at least `name` + `event`
 * (optionally team/gender/time/timeType to disambiguate). First match wins.
 */
export type HistorySwimRef = {
  id?: string;
  name?: string;
  team?: string;
  gender?: Gender;
  event?: string;
  time?: string;
  timeType?: TimeType;
};

function historyRowMatches(row: HistoricalSwim, ref: HistorySwimRef): boolean {
  if (ref.id != null) return row.id === ref.id;
  if (ref.name != null && normalizeSwimmerName(row.name) !== normalizeSwimmerName(ref.name)) {
    return false;
  }
  if (ref.team != null && String(row.team ?? '').trim() !== String(ref.team).trim()) return false;
  if (ref.gender != null && row.gender !== ref.gender) return false;
  if (ref.event != null && normalizeEventLabel(row.event) !== normalizeEventLabel(ref.event)) {
    return false;
  }
  if (ref.timeType != null && (row.timeType ?? 'SCY') !== ref.timeType) return false;
  if (ref.time != null && row.time !== ref.time) return false;
  // A non-id ref must carry at least one identifying field, else it matches all.
  return ref.name != null || ref.event != null;
}

export type AddHistorySwimInput = {
  name: string;
  team: string;
  gender: Gender;
  event: string;
  time: string;
  timeType: TimeType;
  meet?: string;
  date?: string;
};

/**
 * Append a supplemental history swim (source 'manual') with a stable id. Event
 * label normalized via normalizeEventLabel. Feeds buildCrossCourseTable's
 * candidate bests.
 */
export function addHistorySwim(
  workspace: Workspace,
  input: AddHistorySwimInput
): WorkspaceEditorPatch {
  const base = workspace.athleteHistory ?? [];
  const row: HistoricalSwim = {
    id: uuidv4(),
    name: input.name,
    team: String(input.team ?? '').trim(),
    gender: input.gender,
    event: normalizeEventLabel(input.event),
    time: input.time,
    timeType: input.timeType,
    date: input.date,
    meetLabel: input.meet,
    source: 'manual',
  };
  return {
    patch: { athleteHistory: [...base, row] },
    inverse: { athleteHistory: base },
    description: `Add history swim ${input.name}: ${row.event} ${input.time}`,
  };
}

export type UpdateHistorySwimChanges = {
  name?: string;
  team?: string;
  event?: string;
  time?: string;
  timeType?: TimeType;
  meet?: string;
  date?: string;
};

/** Patch the first history row matching `rowRef` (event label re-normalized). */
export function updateHistorySwim(
  workspace: Workspace,
  rowRef: HistorySwimRef,
  changes: UpdateHistorySwimChanges
): WorkspaceEditorPatch {
  const base = workspace.athleteHistory ?? [];
  const idx = base.findIndex(r => historyRowMatches(r, rowRef));
  if (idx < 0) throw new Error('updateHistorySwim: no history row matched rowRef');

  const applied: Partial<HistoricalSwim> = {};
  if (changes.name !== undefined) applied.name = changes.name;
  if (changes.team !== undefined) applied.team = String(changes.team).trim();
  if (changes.event !== undefined) applied.event = normalizeEventLabel(changes.event);
  if (changes.time !== undefined) applied.time = changes.time;
  if (changes.timeType !== undefined) applied.timeType = changes.timeType;
  if (changes.meet !== undefined) applied.meetLabel = changes.meet;
  if (changes.date !== undefined) applied.date = changes.date;

  const target = base[idx];
  return {
    patch: { athleteHistory: base.map((r, i) => (i === idx ? { ...r, ...applied } : r)) },
    inverse: { athleteHistory: base },
    description: `Update history swim ${target.name}: ${target.event}`,
  };
}

/** Remove the first history row matching `rowRef`. */
export function removeHistorySwim(
  workspace: Workspace,
  rowRef: HistorySwimRef
): WorkspaceEditorPatch {
  const base = workspace.athleteHistory ?? [];
  const idx = base.findIndex(r => historyRowMatches(r, rowRef));
  if (idx < 0) throw new Error('removeHistorySwim: no history row matched rowRef');
  const target = base[idx];
  return {
    patch: { athleteHistory: base.filter((_, i) => i !== idx) },
    inverse: { athleteHistory: base },
    description: `Remove history swim ${target.name}: ${target.event}`,
  };
}

// --- 3. credited meet swims -------------------------------------------------

export type EditCreditedSwimChanges = { time?: string; event?: string };

/**
 * Non-destructively edit a credited meet swim. The meet result row itself is
 * left untouched (raw PDF stays immutable); the edit is layered as an active
 * `replacesResultId` overlay plan that buildWhatIfResults swaps in at scoring
 * time — and remaps onto the loaded meet's event label in merged mode. Undo
 * removes the plan (inverse restores meetEntryPlans / activeEntryIds).
 *
 * Note: repeated edits of the same row stack as multiple replace plans; the
 * last one wins in applyOverlayPlans. The UI can supersede via removePlannedEntry.
 */
export function editCreditedSwim(
  workspace: Workspace,
  gender: Gender,
  resultRowId: string,
  changes: EditCreditedSwimChanges
): WorkspaceEditorPatch {
  const field = genderResultsField(gender);
  const results = workspace[field] ?? [];
  const row = results.find(r => r.id === resultRowId);
  if (!row) throw new Error(`editCreditedSwim: no result row ${resultRowId} in ${field}`);

  const entry = createPlannedEntry({
    name: row.name,
    team: String(row.team ?? '').trim(),
    gender,
    classYear: row.classYear,
    event: changes.event ?? row.event,
    time: changes.time ?? row.time,
    timeType: 'SCY',
    source: 'manual',
    active: true,
    replacesResultId: resultRowId,
  });

  const basePlans = workspace.meetEntryPlans ?? [];
  const patch: Partial<Workspace> = { meetEntryPlans: [...basePlans, entry] };
  const inverse: Partial<Workspace> = { meetEntryPlans: basePlans };

  const baseActiveIds = workspace.activeEntryIds;
  if (baseActiveIds && baseActiveIds.length > 0) {
    patch.activeEntryIds = [...baseActiveIds, entry.id];
    inverse.activeEntryIds = baseActiveIds;
  }

  return { patch, inverse, description: `Edit credited swim ${row.name}: ${row.event}` };
}

/**
 * Non-destructively remove a credited meet swim by filtering the working results
 * array (menResults / womenResults) — identical to the app's existing
 * delete-credited-swim semantics and to applyExactSwap's 'result' drop. The
 * frozen source copy (sourceMenResults / sourceWomenResults) is left intact;
 * undo restores the full prior working array from the inverse patch.
 */
export function removeCreditedSwim(
  workspace: Workspace,
  gender: Gender,
  resultRowId: string
): WorkspaceEditorPatch {
  const field = genderResultsField(gender);
  const results = workspace[field] ?? [];
  const row = results.find(r => r.id === resultRowId);
  return {
    patch: { [field]: results.filter(r => r.id !== resultRowId) },
    inverse: { [field]: results },
    description: `Remove credited swim ${row?.name ?? resultRowId}`,
  };
}

/**
 * Remove ONE projected swim by the row id the scored pool shows, whichever plane
 * that row actually came from.
 *
 * `buildWhatIfResults` composes three planes into one array of `SwimmerResult`s,
 * and `planToResult` stamps `isRecruit: true` on a planned entry as well as on a
 * recruit row. A caller holding a scored row therefore CANNOT tell a plan from a
 * recruit by looking at it — and the UI's delete handler, which read `isRecruit`
 * and filtered `workspace.recruits` by id, silently did nothing when the row was
 * a plan: the filter dropped no element, the patch was a no-op, and the toast
 * still said the swim had been removed. That is the "remove did not recalculate"
 * report.
 *
 * Dispatch is by WHERE THE ID LIVES, which is unambiguous:
 *   meetEntryPlans → removePlannedEntry (also drops it from activeEntryIds)
 *   recruits       → filter the recruit out
 *   men/womenResults → removeCreditedSwim (frozen source copy untouched)
 *
 * Raises when the id belongs to none of them rather than returning an empty
 * patch: a delete that quietly removes nothing is the failure this function
 * exists to end.
 */
export function removeProjectedSwim(
  workspace: Workspace,
  gender: Gender,
  rowId: string
): WorkspaceEditorPatch {
  const plans = workspace.meetEntryPlans ?? [];
  if (plans.some(p => p.id === rowId)) return removePlannedEntry(workspace, rowId);

  const recruits = workspace.recruits ?? [];
  const recruit = recruits.find(r => r.id === rowId);
  if (recruit) {
    return {
      patch: { recruits: recruits.filter(r => r.id !== rowId) },
      inverse: { recruits },
      description: `Remove recruit entry (${recruit.name}: ${recruit.event})`,
    };
  }

  const field = genderResultsField(gender);
  if ((workspace[field] ?? []).some(r => r.id === rowId)) {
    return removeCreditedSwim(workspace, gender, rowId);
  }

  throw new Error(
    `removeProjectedSwim: id ${rowId} is not a planned entry, a recruit, or a ${field} row`
  );
}

// --- 4. load this meet here -------------------------------------------------

export type CopyMeetResult = {
  patch: Partial<Workspace>;
  description: string;
  warnings: string[];
};

/**
 * "Load this meet here": copy the source workspace's frozen meet field (its
 * source*Results, falling back to working results) plus the meet-level fields
 * scoring needs into the target, so the target's roster plans/recruits/history
 * can compete against a real scoring field.
 *
 * Copies: menResults, womenResults, sourceMenResults, sourceWomenResults (relay
 * lineup rows travel inside these), and — when present on the source — conference,
 * scoringSettings, officialTeamScores, loadedMeet. Deliberately does NOT copy any
 * roster-plan field (meetEntryPlans, recruits, athleteHistory, deletedSwimmers,
 * scorer/relay overrides), so the target keeps its own roster work.
 *
 * Warnings (the UI confirms before applying): the target already having loaded
 * meet results (the patch replaces them), and the source having none to copy.
 * No inverse — the caller snapshots the target if it wants undo.
 */
export function copyMeetIntoWorkspace(
  sourceWorkspace: Workspace,
  targetWorkspace: Workspace
): CopyMeetResult {
  const men = cloneMeetResults(getSourceResults(sourceWorkspace, Gender.MEN));
  const women = cloneMeetResults(getSourceResults(sourceWorkspace, Gender.WOMEN));

  const patch: Partial<Workspace> = {
    menResults: men,
    womenResults: women,
    sourceMenResults: cloneMeetResults(men),
    sourceWomenResults: cloneMeetResults(women),
  };
  if (sourceWorkspace.conference !== undefined) patch.conference = sourceWorkspace.conference;
  if (sourceWorkspace.scoringSettings !== undefined) {
    patch.scoringSettings = sourceWorkspace.scoringSettings;
  }
  if (sourceWorkspace.officialTeamScores !== undefined) {
    patch.officialTeamScores = sourceWorkspace.officialTeamScores;
  }
  if (sourceWorkspace.loadedMeet !== undefined) patch.loadedMeet = sourceWorkspace.loadedMeet;

  const warnings: string[] = [];
  const targetRows = (targetWorkspace.menResults?.length ?? 0) + (targetWorkspace.womenResults?.length ?? 0);
  if (targetRows > 0) {
    warnings.push(
      `Target workspace already has ${targetRows} loaded meet result row(s); loading this meet replaces them.`
    );
  }
  if (men.length + women.length === 0) {
    warnings.push('Source workspace has no meet results to copy.');
  }

  return {
    patch,
    description: `Load meet from "${sourceWorkspace.name}" into "${targetWorkspace.name}"`,
    warnings,
  };
}
