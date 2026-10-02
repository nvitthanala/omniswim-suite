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
  type ScyConversionProvenance,
} from '../types';
import { relayEntryKey } from './relaySplits';
import { relayTemplateFromLeg } from './relayLegMatching';
import {
  buildAliasResolver,
  IDENTITY_ALIAS_RESOLVER,
  type AthleteAliasResolver,
} from './athleteAliases';
import { computeVacateRelayLegNames } from './rosterLineupAudit';
import { relayLegHistoryCandidates } from './relayLegHistoryCandidates';
import { mergeScoringSettings } from './scoringDefaults';
import { buildMeetEventLabelIndex, canonicalProgramEvent } from './eventIdentity';
import { swimEventNotSwumInCourse } from './courseEvents';
import {
  canonicalSwimmerName,
  convertSwimToSCYDetailed,
  convertTimeToSeconds,
  convertToSCY,
  isGraduatingClassYear,
  isRelayResult,
  scyConversionProvenance,
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
 * A stored recruit row or plan can be scored: its event exists in the course
 * it is recorded in. A hand-entered "1000 Freestyle" recorded SCM has no SCY
 * time (no such event is swum in SCM), so it never enters the projection, and
 * a plan like it never patches a meet row. The row stays stored; the lineup
 * audit lists it (`event_not_swum_in_course`). See courseEvents.ts.
 */
function isScorableStoredRow(row: { event: string; timeType?: 'SCY' | 'SCM' | 'LCM' }): boolean {
  return swimEventNotSwumInCourse(row) === null;
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

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** Which plane a composed row came from. Higher wins a same-event collision. */
const PLANE_MEET = 0;
const PLANE_RECRUIT = 1;
const PLANE_PLAN = 2;

/**
 * The identity of one entry: team, gender, athlete, event.
 *
 * The athlete is the name AFTER the alias resolver, scoped the way the scoring
 * engine scopes it (`buildScoringBundle` resolves with the bundle's gender and
 * the row's team). Without that, a recruit row under an alias spelling and a
 * meet row under the canonical spelling are two entries here, both survive the
 * collapse, and the engine then renames both to one name and scores the swimmer
 * twice in one event. See `athleteAliases.ts`: the resolver is opt-in.
 */
function entryIdentityKey(
  row: SwimmerResult,
  gender: Gender,
  resolver: AthleteAliasResolver
): string {
  const team = String(row.team ?? '').trim();
  const g = row.gender ?? gender;
  const athlete = resolver.resolveAthleteName(String(row.name ?? ''), row.team, gender);
  return `${team}|${g}|${canonicalSwimmerName(athlete)}|${row.event}`;
}

/** Seconds a row swam; a time that does not parse is the slowest possible. */
function swimSeconds(row: SwimmerResult): number {
  const seconds = convertTimeToSeconds(String(row.finalsTime || row.time || ''));
  return Number.isNaN(seconds) ? Infinity : seconds;
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
 * SAME-PLANE DUPLICATES. Two RECRUIT rows, or two PLAN rows, for one athlete
 * and event are the same kind of statement made twice — a duplicate import, a
 * double-add, or one linked athlete entered under both spellings. Both used to
 * survive and the athlete scored twice (see aliasSplitAthleteScoredOnce.test.ts).
 * On those two planes the row with the FASTER time stands (the first one on a
 * tie, or when a time does not parse); the other is reported in `collapsed`.
 *
 * PENCIL EDITS. A meet row a `replacesResultId` plan rewrote (`patchedMeetIds`) holds
 * its entry. A plan-built row for the same athlete and event collapses into it: the
 * explicit edit stands, and the athlete scores once.
 *
 * MEET rows are never collapsed against each other. A prelims row and a finals
 * row for one athlete and event legitimately share a name there, and a second
 * published swim is not this function's to discard; the lineup audit's
 * duplicate-athlete scan is where a meet-plane defect belongs. A meet row a plan
 * rewrote in place (`patchedMeetIds`) keeps that protection: two pencil edits,
 * one to the prelims row and one to the finals row, are two swims.
 *
 * Relays are never collapsed: a relay row's identity is the entry, not the one
 * swimmer whose leg it carries.
 *
 * `planIds` answers "which rows carry plan-sourced content", NOT "which rows were
 * built by `planToResult`". Those two are not the same set — see
 * `applyOverlayPlans`, which rewrites a meet row's content from a plan while
 * keeping the row's meet id. The caller must include such a row here or the
 * collapse reads a coach's edit as an untouched meet row.
 */
function collapseCrossPlaneDuplicates(
  rows: SwimmerResult[],
  gender: Gender,
  recruitIds: ReadonlySet<string>,
  planIds: ReadonlySet<string>,
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER,
  patchedMeetIds: ReadonlySet<string> = EMPTY_ID_SET
): { rows: SwimmerResult[]; collapsed: SwimmerResult[] } {
  if (recruitIds.size === 0 && planIds.size === 0) return { rows, collapsed: [] };

  // `planIds` may hold a MEET row's id — a row a plan rewrote in place. Content,
  // not provenance of the id, decides the plane.
  const planeOf = (row: SwimmerResult): number => {
    if (planIds.has(row.id)) return PLANE_PLAN;
    if (recruitIds.has(row.id)) return PLANE_RECRUIT;
    return PLANE_MEET;
  };
  // A row the same-plane pass may drop: a recruit row or a plan-built row, never a
  // meet row and never a meet row a plan rewrote in place.
  const sameplaneCollapsible = (row: SwimmerResult): boolean =>
    !isRelayResult(row) && planeOf(row) !== PLANE_MEET && !patchedMeetIds.has(row.id);

  // Highest plane present per identity. Only a strictly lower plane is displaced
  // by it; rows that share the winning plane are settled by the same-plane pass.
  const topPlane = new Map<string, number>();
  for (const row of rows) {
    if (isRelayResult(row)) continue;
    const key = entryIdentityKey(row, gender, resolver);
    const plane = planeOf(row);
    const held = topPlane.get(key);
    if (held === undefined || plane > held) topPlane.set(key, plane);
  }

  // The identities a pencil edit holds. A `replacesResultId` plan rewrites a meet
  // row in place, so that row IS the user's explicit statement of the entry. A
  // second, plan-built row for the same athlete and event (an import or the
  // optimizer wrote it without knowing about the edit) is the same entry stated
  // again, and the faster-time rule below would let it stand BESIDE the edit: the
  // athlete would score twice. The edit stands and the plan-built row collapses.
  const pencilEditedKeys = new Set<string>();
  for (const row of rows) {
    if (isRelayResult(row) || !patchedMeetIds.has(row.id)) continue;
    pencilEditedKeys.add(entryIdentityKey(row, gender, resolver));
  }

  // Same-plane pass, recruit and plan planes only: the fastest row of each
  // identity at its winning plane is the one that stands.
  const standing = new Map<string, SwimmerResult>();
  for (const row of rows) {
    if (!sameplaneCollapsible(row)) continue;
    const key = entryIdentityKey(row, gender, resolver);
    if (planeOf(row) !== topPlane.get(key)) continue;
    const held = standing.get(key);
    if (!held || swimSeconds(row) < swimSeconds(held)) standing.set(key, row);
  }

  const kept: SwimmerResult[] = [];
  const collapsed: SwimmerResult[] = [];
  for (const row of rows) {
    if (isRelayResult(row)) {
      kept.push(row);
      continue;
    }
    const key = entryIdentityKey(row, gender, resolver);
    // Every non-relay row has a top plane: the first loop recorded one per identity.
    if (planeOf(row) < (topPlane.get(key) as number)) {
      collapsed.push(row);
      continue;
    }
    // At the winning plane. Meet rows, and meet rows a plan rewrote, all stay,
    // except that a plan-built row yields to the pencil edit that holds its entry.
    if (sameplaneCollapsible(row) && pencilEditedKeys.has(key)) {
      collapsed.push(row);
      continue;
    }
    const winner = standing.get(key);
    if (!sameplaneCollapsible(row) || winner === undefined || winner === row) kept.push(row);
    else collapsed.push(row);
  }
  return { rows: kept, collapsed };
}

/**
 * The SCY time a recruit row or planned entry scores on, and where it came from.
 *
 * `time` is exactly what `convertToSCY` returned before `convertedFrom`
 * existed, so no score changes. `convertedFrom` keeps the projected row marked
 * as an estimate: carried over when the row already holds a converted SCY time
 * (an `importHistoryToRoster` row), derived here when the row stores the
 * recorded metric time and is converted on read.
 *
 * `course` is passed by the caller, not read here, so each plane keeps the
 * defaulting it always had (a plan defaults to SCY; a recruit row passes its
 * `timeType` as stored).
 */
function scoredTimeOf(
  row: {
    event: string;
    time: string;
    gender: Gender;
    team: string;
    convertedFrom?: ScyConversionProvenance;
  },
  course: 'SCY' | 'LCM' | 'SCM'
): { time: string; convertedFrom?: ScyConversionProvenance } {
  // An SCM row converts with the NCAA table of the row's team's division.
  const time = convertToSCY(row.time, row.event, row.gender, course, { team: row.team });
  if (course !== 'LCM' && course !== 'SCM') {
    // Kept only while the row still holds the time the conversion produced; a
    // time edited after import is the coach's own and is not an estimate.
    const from = row.convertedFrom;
    const stillConverted = from && String(from.scyTime).trim() === String(row.time).trim();
    return stillConverted ? { time, convertedFrom: from } : { time };
  }
  const convertedFrom = scyConversionProvenance(
    { event: row.event, time: row.time },
    convertSwimToSCYDetailed(row.event, row.time, row.gender, course, { team: row.team })
  );
  return convertedFrom ? { time, convertedFrom } : { time };
}

export function planToResult(entry: PlannedSwimEntry): SwimmerResult {
  const { time, convertedFrom } = scoredTimeOf(entry, entry.timeType ?? 'SCY');
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
    ...(convertedFrom ? { convertedFrom } : {}),
  };
}

/**
 * The overlaid pool, plus the ids of the rows a plan REWROTE in place.
 *
 * A `replacesResultId` plan — what the pencil edit writes — does not add a row.
 * It patches the meet row it names and leaves the row's `id` alone. The id has to
 * stay: `removeProjectedSwim` dispatches on which array an id lives in, so
 * deleting the row the coach sees must reach the meet swim, not the plan behind
 * it (removing the plan would restore the old time rather than drop the swim).
 *
 * That leaves the row's id and the row's content pointing at different planes,
 * which is exactly the question `collapseCrossPlaneDuplicates` asks. `patchedIds`
 * is the answer it cannot get from the row itself.
 */
type OverlayedPlans = {
  rows: SwimmerResult[];
  /** Meet-row ids whose content a plan rewrote — plan-plane rows under a meet id. */
  patchedIds: Set<string>;
};

function applyOverlayPlans(
  results: SwimmerResult[],
  plans: PlannedSwimEntry[],
  gender: Gender,
  activeIds?: string[],
  remapEvent: EventRemapper = e => e
): OverlayedPlans {
  const genderPlans = plans.filter(p => p.gender === gender && planEntryActive(p, activeIds));
  const replaceMap = new Map<string, PlannedSwimEntry>();
  for (const p of genderPlans) {
    if (p.replacesResultId) replaceMap.set(p.replacesResultId, p);
  }

  const out: SwimmerResult[] = [];
  const replaced = new Set<string>();
  const patchedIds = new Set<string>();

  for (const r of results) {
    const patch = replaceMap.get(r.id);
    if (patch) {
      replaced.add(r.id);
      patchedIds.add(r.id);
      const { time, convertedFrom } = scoredTimeOf(patch, patch.timeType ?? 'SCY');
      out.push({
        ...r,
        event: remapEvent(patch.event),
        time,
        finalsTime: time,
        rank: patch.projectedRank ?? r.rank,
        roundSwam: patch.projectedRound ?? r.roundSwam,
        ...(convertedFrom ? { convertedFrom } : {}),
      });
      continue;
    }
    out.push(r);
  }

  for (const p of genderPlans) {
    if (p.replacesResultId && replaced.has(p.replacesResultId)) continue;
    if (!p.replacesResultId) out.push(remapResultEvent(planToResult(p), remapEvent));
  }

  return { rows: out, patchedIds };
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
            r.gender === gender &&
            passesRosterGates(r.name, r.classYear, excluded, removeSeniors) &&
            isScorableStoredRow(r)
        )
        .map(r => {
          const { time, convertedFrom } = scoredTimeOf(r, r.timeType);
          return {
            id: r.id,
            rank: 0,
            name: r.name,
            classYear: r.classYear,
            team: r.team,
            time,
            points: 0,
            event: remapEvent(r.event),
            isRecruit: true,
            gender: r.gender,
            ...(convertedFrom ? { convertedFrom } : {}),
          };
        });

  const relayKeysForGender = new Set<string>();
  for (const row of currentResults.filter(x => x.isRelay)) {
    relayKeysForGender.add(relayEntryKey(relayTemplateFromLeg(currentResults, row)));
  }
  const relayOverrides: RelayLegOverride[] = (workspace.relayLegOverrides ?? []).filter(o =>
    relayKeysForGender.has(o.relayEntryKey)
  );

  // Built once: the vacate step and the cross-plane collapse both read raw
  // workspace rows, before the engine collapses alias spellings onto the
  // canonical name. Without the resolver, a swimmer marked a non-scorer under
  // their canonical spelling is not recognised on a relay leg printed under an
  // alias, so the leg is not vacated and this projection keeps a relay a
  // non-scorer cannot legally swim.
  const aliasResolver = buildAliasResolver(workspace);

  const vacateRelayLegs = computeVacateRelayLegNames(
    currentResults,
    gender,
    // Merged the way `buildScoringBundle` merges: with the workspace conference
    // and the PDF hint. A workspace that stores `scoringSettings: {}` and gets
    // roster mode only from its conference would otherwise vacate nothing here
    // while the engine scores in roster mode.
    mergeScoringSettings(workspace.scoringSettings, {
      conference: workspace.conference,
      resultsForPdfHint: [...menResults, ...womenResults],
    }),
    workspace.scorerRosterOverrides ?? [],
    aliasResolver
  );

  // History swims may fill a leg an override names (R1 e,
  // relayLegHistoryCandidates.ts). They matter only when an override exists,
  // and are not PDF-native, so pdf_only leaves them out like the recruits.
  const relayLegOnlyPool =
    pdfOnly || relayOverrides.length === 0
      ? []
      : relayLegHistoryCandidates(
          workspace,
          [
            ...currentResults.filter(
              r =>
                !isRelayResult(r) && passesRosterGates(r.name, r.classYear, excluded, removeSeniors)
            ),
            ...recruitResults,
          ],
          gender
        );

  let base = simulateRoster(
    currentResults,
    recruitResults,
    removeSeniors,
    excluded,
    relayOverrides,
    vacateRelayLegs,
    relayLegOnlyPool
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
    : (workspace.meetEntryPlans ?? []).filter(
        p => passesRosterGates(p.name, p.classYear, excluded, removeSeniors) && isScorableStoredRow(p)
      );
  const activeIds = workspace.activeEntryIds;
  const mode = workspace.entryPlanMode ?? 'overlay';

  // Meet rows a `replacesResultId` plan rewrote in place. They keep their meet
  // id, so nothing on the row itself says its content is now plan-sourced.
  let planPatchedIds: ReadonlySet<string> = EMPTY_ID_SET;

  if (mode === 'plan_sheet' && plans.length > 0) {
    const teamsInPlan = new Set(plans.filter(p => p.gender === gender).map(p => p.team));
    const relays = base.filter(r => isRelayResult(r));
    const pdfIndividuals = base.filter(
      r => !isRelayResult(r) && !teamsInPlan.has(String(r.team ?? '').trim())
    );
    const planIndividuals = buildPlanSheetResults(plans, gender, teamsInPlan, activeIds, remapEvent);
    base = [...pdfIndividuals, ...planIndividuals, ...relays];
  } else if (plans.length > 0) {
    const overlayed = applyOverlayPlans(base, plans, gender, activeIds, remapEvent);
    base = overlayed.rows;
    planPatchedIds = overlayed.patchedIds;
  }

  // The plan plane is every row whose CONTENT a plan states — the rows
  // `planToResult` built AND the meet rows a `replacesResultId` plan rewrote.
  // Leaving the second group out let a stale recruit row, which is a less
  // explicit statement, supersede a coach's edit and score in its place.
  const planIds = new Set(plans.filter(p => p.gender === gender).map(p => p.id));
  for (const id of planPatchedIds) planIds.add(id);

  // Reconcile the planes BEFORE ranks are projected: a phantom second entry for
  // one athlete would otherwise push every slower entrant in that event down a
  // place, so the duplication corrupted the field order as well as the total.
  const reconciled = collapseCrossPlaneDuplicates(
    base,
    gender,
    new Set(recruitResults.map(r => r.id)),
    planIds,
    aliasResolver,
    planPatchedIds
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
