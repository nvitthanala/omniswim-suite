/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Assemble the what-if scoring pool from the three planes a workspace scores:
 * the loaded meet's result rows, recruit rows, and planned entries.
 *
 * Composition is not concatenation. Two rules apply to the whole pool, not to
 * whichever plane happens to be easiest to reach:
 *
 *   1. The roster gates — `deletedSwimmers` and `removeSeniors` — silence an
 *      athlete on EVERY plane (`passesRosterGates`).
 *   2. One athlete holds at most one entry per event; a more explicit plane
 *      supersedes a less explicit one (`collapseCrossPlaneDuplicates`).
 *
 * Test: npx tsx scripts/test_projection_roster_gates.mjs
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Gender,
  PlannedSwimEntry,
  RelayLegOverride,
  SwimmerResult,
  Workspace,
} from '../types';
import { relayEntryKey } from './relaySplits';
import { relayTemplateFromLeg } from './relayLegMatching';
import { computeVacateRelayLegNames } from './rosterLineupAudit';
import { mergeScoringSettings } from './scoringDefaults';
import { buildMeetEventLabelIndex, canonicalProgramEvent } from './eventIdentity';
import {
  canonicalSwimmerName,
  convertTimeToSeconds,
  convertToSCY,
  isGraduatingClassYear,
  isRelayResult,
  simulateRoster,
} from './utils';

/**
 * Remap an imported/planned/recruit row's event onto the loaded meet's real
 * event label so it competes inside the PDF field. No-op when the meet index is
 * empty (roster-only workspace) or the row's canonical event has no loaded meet
 * label (unmatched — keeps its canonical label exactly as today).
 */
type EventRemapper = (event: string) => string;

function makeEventRemapper(labelIndex: Map<string, string>): EventRemapper {
  if (labelIndex.size === 0) return (event: string) => event;
  return (event: string): string => {
    const canon = canonicalProgramEvent(event);
    if (!canon) return event;
    return labelIndex.get(canon) ?? event;
  };
}

export type WhatIfProjectionOptions = {
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
};

function planEntryActive(entry: PlannedSwimEntry, activeIds?: string[]): boolean {
  if (entry.active === false) return false;
  if (activeIds && activeIds.length > 0) return activeIds.includes(entry.id);
  return true;
}

/**
 * The two roster gates the projection applies to EVERY plane it scores.
 *
 * `simulateRoster` enforces both on the loaded meet's result rows. Recruits and
 * planned entries reach the scoring pool by a different path and used to bypass
 * both, which is why removing an athlete or dropping seniors could leave the
 * total unmoved: on a roster-built workspace (the HSU shape — every athlete is a
 * recruit row or a planned entry, none of them PDF rows) NEITHER gate touched a
 * single scoring row.
 *
 * An absent class year is not a senior. `isGraduatingClassYear` answers false for
 * undefined/blank, so an athlete whose year was never recorded is kept rather
 * than guessed at.
 */
/**
 * Shared removal gate: a tombstoned or (when removeSeniors is set) graduating
 * swimmer is filtered out. Exported so any other view that lists "who's on
 * the active roster" — e.g. the relay leg panel — applies the exact rule the
 * scoring projection does, rather than a hand-rolled copy that can drift
 * from it (this is what caused the "remove seniors" stale-total bug: two
 * gates, only one of which the projection actually applied).
 */
export function passesRosterGates(
  name: string,
  classYear: string | undefined,
  excluded: Set<string>,
  removeSeniors: boolean
): boolean {
  if (excluded.has(canonicalSwimmerName(name))) return false;
  if (removeSeniors && isGraduatingClassYear(classYear)) return false;
  return true;
}

/** Which plane a composed row came from. Higher wins a same-event collision. */
const PLANE_MEET = 0;
const PLANE_RECRUIT = 1;
const PLANE_PLAN = 2;

function entryIdentityKey(row: SwimmerResult, gender: Gender): string {
  const team = String(row.team ?? '').trim();
  const g = row.gender ?? gender;
  return `${team}|${g}|${canonicalSwimmerName(row.name)}|${row.event}`;
}

/**
 * One athlete may hold at most one entry per event.
 *
 * The three planes are assembled independently — meet result rows, recruit rows,
 * planned entries — and nothing reconciled them, so an athlete present on two
 * planes for the same event was entered twice and SCORED twice. That is never a
 * legal meet state, and it is what made changing an athlete's event read as a
 * duplication rather than a move: the new entry stacked on top of the old one
 * instead of superseding it. Two live paths reach it without any user error —
 * `importHistoryToRoster` compares a canonical event label against the loaded
 * meet's own label when it checks for an existing entry, so the labels differ,
 * the check misses, and `makeEventRemapper` then lands the plan back on the very
 * meet row it was meant to skip; and `optimizeEventLineupForTeam` writes a plan
 * for every athlete's primary events without clearing the recruit rows that
 * already cover them.
 *
 * PRECEDENCE is by plane, most explicit first. A planned entry is the user's
 * stated lineup decision, a recruit row is an imported projection, and a meet
 * result row is the field as loaded. This is the rule `replacesResultId` already
 * encodes for an edit made through the pencil; extending it to identity means a
 * plan that arrived from an import supersedes the same way an explicit one does.
 *
 * SCOPE: only ACROSS planes. Two rows on one plane are the same kind of
 * statement made twice — a duplicate import, a double-add, or (for meet rows) a
 * second published swim this function has no business discarding. Silently
 * picking one of them would hide a data defect instead of surfacing it; the
 * lineup audit's duplicate-athlete scan is where that belongs. A row is dropped
 * here only when a MORE EXPLICIT statement of the same entry exists.
 *
 * Relays are never collapsed: a relay row's identity is the entry, not the one
 * swimmer whose leg it carries.
 */
function collapseCrossPlaneDuplicates(
  rows: SwimmerResult[],
  gender: Gender,
  recruitIds: ReadonlySet<string>,
  planIds: ReadonlySet<string>
): { rows: SwimmerResult[]; collapsed: SwimmerResult[] } {
  if (recruitIds.size === 0 && planIds.size === 0) return { rows, collapsed: [] };

  const planeOf = (row: SwimmerResult): number => {
    if (planIds.has(row.id)) return PLANE_PLAN;
    if (recruitIds.has(row.id)) return PLANE_RECRUIT;
    return PLANE_MEET;
  };

  // Highest plane present per identity. Same-plane rows share the winning plane
  // and all survive; only a strictly lower plane is displaced.
  const topPlane = new Map<string, number>();
  for (const row of rows) {
    if (isRelayResult(row)) continue;
    const key = entryIdentityKey(row, gender);
    const plane = planeOf(row);
    const held = topPlane.get(key);
    if (held === undefined || plane > held) topPlane.set(key, plane);
  }

  const kept: SwimmerResult[] = [];
  const collapsed: SwimmerResult[] = [];
  for (const row of rows) {
    if (isRelayResult(row)) {
      kept.push(row);
      continue;
    }
    const top = topPlane.get(entryIdentityKey(row, gender));
    if (top === undefined || planeOf(row) >= top) kept.push(row);
    else collapsed.push(row);
  }
  return { rows: kept, collapsed };
}

export function planToResult(entry: PlannedSwimEntry): SwimmerResult {
  const time = convertToSCY(
    entry.time,
    entry.event,
    entry.gender,
    entry.timeType ?? 'SCY'
  );
  return {
    id: entry.id,
    rank: entry.projectedRank ?? 0,
    name: entry.name,
    classYear: entry.classYear ?? 'UNKNOWN',
    team: entry.team,
    time,
    finalsTime: time,
    roundSwam: entry.projectedRound,
    points: 0,
    event: entry.event,
    gender: entry.gender,
    isRecruit: entry.source === 'manual' || entry.source === 'swimcloud' || entry.source === 'optimizer',
  };
}

function applyOverlayPlans(
  results: SwimmerResult[],
  plans: PlannedSwimEntry[],
  gender: Gender,
  activeIds?: string[],
  remapEvent: EventRemapper = e => e
): SwimmerResult[] {
  const genderPlans = plans.filter(p => p.gender === gender && planEntryActive(p, activeIds));
  const replaceMap = new Map<string, PlannedSwimEntry>();
  for (const p of genderPlans) {
    if (p.replacesResultId) replaceMap.set(p.replacesResultId, p);
  }

  const out: SwimmerResult[] = [];
  const replaced = new Set<string>();

  for (const r of results) {
    const patch = replaceMap.get(r.id);
    if (patch) {
      replaced.add(r.id);
      const time = convertToSCY(patch.time, patch.event, patch.gender, patch.timeType ?? 'SCY');
      out.push({
        ...r,
        event: remapEvent(patch.event),
        time,
        finalsTime: time,
        rank: patch.projectedRank ?? r.rank,
        roundSwam: patch.projectedRound ?? r.roundSwam,
      });
      continue;
    }
    out.push(r);
  }

  for (const p of genderPlans) {
    if (p.replacesResultId && replaced.has(p.replacesResultId)) continue;
    if (!p.replacesResultId) out.push(remapResultEvent(planToResult(p), remapEvent));
  }

  return out;
}

/** planToResult with its event remapped onto the loaded meet label (if any). */
function remapResultEvent(row: SwimmerResult, remapEvent: EventRemapper): SwimmerResult {
  const event = remapEvent(row.event);
  return event === row.event ? row : { ...row, event };
}

function buildPlanSheetResults(
  plans: PlannedSwimEntry[],
  gender: Gender,
  teamFilter?: Set<string>,
  activeIds?: string[],
  remapEvent: EventRemapper = e => e
): SwimmerResult[] {
  return plans
    .filter(
      p =>
        p.gender === gender &&
        planEntryActive(p, activeIds) &&
        (!teamFilter || teamFilter.has(p.team))
    )
    .map(p => remapResultEvent(planToResult(p), remapEvent));
}

/** Re-rank individuals in each event by time (field-relative projection). */
export function projectRanksInField(results: SwimmerResult[]): SwimmerResult[] {
  const byEvent = new Map<string, SwimmerResult[]>();
  for (const r of results) {
    if (isRelayResult(r)) continue;
    if (!byEvent.has(r.event)) byEvent.set(r.event, []);
    byEvent.get(r.event)!.push(r);
  }

  const rankUpdates = new Map<string, { rank: number; roundSwam?: string }>();
  for (const [, rows] of byEvent) {
    const sorted = [...rows].sort(
      (a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time)
    );
    sorted.forEach((r, i) => {
      const rank = i + 1;
      const roundSwam = rank <= 8 ? 'A Final' : rank <= 16 ? 'B Final' : 'Preliminaries';
      rankUpdates.set(r.id, { rank, roundSwam });
    });
  }

  return results.map(r => {
    const upd = rankUpdates.get(r.id);
    if (!upd) return r;
    return { ...r, rank: upd.rank, roundSwam: upd.roundSwam };
  });
}

/**
 * The composed what-if pool, plus the rows cross-plane reconciliation removed.
 *
 * `collapsed` exists so an incremental consumer can tell that a row it is about
 * to model a DROP for is shadowing another row that would resurface — see
 * `buildFastSwapContext`, which fails closed on a non-empty `collapsed`.
 */
export type WhatIfProjection = {
  rows: SwimmerResult[];
  collapsed: SwimmerResult[];
};

/** The composed pool only. Unchanged signature; every existing caller is unaffected. */
export function buildWhatIfResults(options: WhatIfProjectionOptions): SwimmerResult[] {
  return buildWhatIfProjection(options).rows;
}

export function buildWhatIfProjection({
  workspace,
  gender,
  removeSeniors,
}: WhatIfProjectionOptions): WhatIfProjection {
  const menResults = workspace.menResults ?? [];
  const womenResults = workspace.womenResults ?? [];
  const currentResults = gender === Gender.MEN ? menResults : womenResults;

  const scoringView = workspace.scoringView ?? 'merged';
  const pdfOnly = scoringView === 'pdf_only';

  // Merged mode remaps imported/planned/recruit rows onto the loaded meet's real
  // event labels. Empty index (roster-only workspace) => remap is a no-op, so the
  // roster-plan-only workspace behaves exactly as before.
  const labelIndex = pdfOnly ? new Map<string, string>() : buildMeetEventLabelIndex(currentResults);
  const remapEvent = makeEventRemapper(labelIndex);

  const excluded = new Set(
    (workspace.deletedSwimmers ?? [])
      .filter(d => d.gender === gender)
      .map(d => canonicalSwimmerName(d.name))
  );

  const recruitResults: SwimmerResult[] = pdfOnly
    ? []
    : (workspace.recruits ?? [])
        .filter(
          r =>
            r.gender === gender && passesRosterGates(r.name, r.classYear, excluded, removeSeniors)
        )
        .map(r => ({
          id: r.id,
          rank: 0,
          name: r.name,
          classYear: r.classYear,
          team: r.team,
          time: convertToSCY(r.time, r.event, r.gender, r.timeType),
          points: 0,
          event: remapEvent(r.event),
          isRecruit: true,
          gender: r.gender,
        }));

  const relayKeysForGender = new Set<string>();
  for (const row of currentResults.filter(x => x.isRelay)) {
    relayKeysForGender.add(relayEntryKey(relayTemplateFromLeg(currentResults, row)));
  }
  const relayOverrides: RelayLegOverride[] = (workspace.relayLegOverrides ?? []).filter(o =>
    relayKeysForGender.has(o.relayEntryKey)
  );

  const vacateRelayLegs = computeVacateRelayLegNames(
    currentResults,
    gender,
    mergeScoringSettings(workspace.scoringSettings),
    workspace.scorerRosterOverrides ?? []
  );

  let base = simulateRoster(
    currentResults,
    recruitResults,
    removeSeniors,
    excluded,
    relayOverrides,
    vacateRelayLegs
  );

  // pdf_only: exclude meet entry plans + recruits from scoring entirely. The
  // deletions / relay overrides / vacate-leg adjustments above are PDF-native and
  // still apply. No plan overlay, no plan-driven rank projection.
  //
  // A plan for a removed athlete, or for a senior while "Drop seniors" is on, is
  // gated here for the same reason the recruit rows above are: the plan plane is
  // a scoring plane, and a gate that reaches only the PDF rows is not a gate.
  const plans = pdfOnly
    ? []
    : (workspace.meetEntryPlans ?? []).filter(p =>
        passesRosterGates(p.name, p.classYear, excluded, removeSeniors)
      );
  const activeIds = workspace.activeEntryIds;
  const mode = workspace.entryPlanMode ?? 'overlay';

  if (mode === 'plan_sheet' && plans.length > 0) {
    const teamsInPlan = new Set(plans.filter(p => p.gender === gender).map(p => p.team));
    const relays = base.filter(r => isRelayResult(r));
    const pdfIndividuals = base.filter(
      r => !isRelayResult(r) && !teamsInPlan.has(String(r.team ?? '').trim())
    );
    const planIndividuals = buildPlanSheetResults(plans, gender, teamsInPlan, activeIds, remapEvent);
    base = [...pdfIndividuals, ...planIndividuals, ...relays];
  } else if (plans.length > 0) {
    base = applyOverlayPlans(base, plans, gender, activeIds, remapEvent);
  }

  // Reconcile the planes BEFORE ranks are projected: a phantom second entry for
  // one athlete would otherwise push every slower entrant in that event down a
  // place, so the duplication corrupted the field order as well as the total.
  const reconciled = collapseCrossPlaneDuplicates(
    base,
    gender,
    new Set(recruitResults.map(r => r.id)),
    new Set(plans.filter(p => p.gender === gender).map(p => p.id))
  );
  base = reconciled.rows;

  const hasProjectedPlans = plans.some(
    p => p.gender === gender && (p.projectedRank != null || p.source === 'optimizer' || p.source === 'swimcloud')
  );
  if (!pdfOnly && (hasProjectedPlans || mode === 'plan_sheet')) {
    base = projectRanksInField(base);
  }

  return { rows: base, collapsed: reconciled.collapsed };
}

export function createPlannedEntry(
  partial: Omit<PlannedSwimEntry, 'id'> & { id?: string }
): PlannedSwimEntry {
  return { id: partial.id ?? uuidv4(), ...partial };
}
