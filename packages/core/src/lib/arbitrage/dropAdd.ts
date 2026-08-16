/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drop-only / add-only analysis (and the pure patches that apply a row).
 *
 * Test: npx tsx scripts/test_drop_add_analysis.mjs
 */

import {
  Gender,
  PlannedSwimEntry,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '../../types';
import { mergeScoringSettings } from '../scoringDefaults';
import {
  canAcceptAnotherEntry,
  countSwimmerEntries,
  swimmerExceedsEntryLimits,
} from '../swimmerEntryLimits';
import { createPlannedEntry } from '../whatIfProjection';
import { convertTimeToSeconds, isRelayResult, normalizeSwimmerName } from '../utils';
import { buildCrossCourseTable } from './crossCourseTable';
import {
  buildEventTimeIndex,
  buildFastSwapContext,
  collectDroppableEntries,
  conversionConfidence,
  distinctIndividualResultTeams,
  effectiveBestIndex,
  fieldNotMeaningfulReason,
  scoreWorkspaceRows,
  sumTeamPoints,
  type CrossCourseTable,
  type DroppableEntry,
  type EntryConfidence,
  type EventTimeRef,
} from './shared';

// --- drop-only / add-only analysis ------------------------------------------
//
// Complements rankExactSwaps (1-for-1) with the two degenerate cases:
//
//   * rankDropOnly — the TRUE team delta of dropping ONE current entry alone.
//     Under place scoring a drop is never positive inside its own event, so a
//     positive delta always flags a structural problem: an over-entered swimmer
//     whose points the entry caps void (modeled below — the engine itself does
//     not void), or a meet-wide scorer-pool slot burned on a low-value entry.
//   * rankAddOnly — for swimmers still under their individual/total entry caps
//     (swimmerEntryLimits, incl. the NSISC total-7 cap), the TRUE delta of
//     adding their best available championship-program event without dropping
//     anything (open-slot gains).
//
// CAP-VOID MODEL. calculatePoints does not enforce per-swimmer entry caps —
// over-entry only surfaces in the lineup audit. Real NSISC-style rules void an
// over-entered swimmer's swims, so both rankings here score against an
// "effective" total: engine total minus the scored INDIVIDUAL points of every
// team athlete currently violating swimmerExceedsEntryLimits. (Relay shares
// are deliberately NOT voided — a real over-entry would jeopardize relays too,
// but relay point attribution is placement-based and shared; voiding legs
// would guess at re-swim outcomes. Documented limitation.) Each drop row keeps
// the pure engine delta (`scoredDelta`) and engine totals (`newTotal` /
// `baseTotal`, apply→re-score reproducible) alongside the effective
// `deltaPoints`; `voidedPointsRestored` is the modeled component.
//
// FAST PATH. Both rankings reuse the incremental context (buildFastSwapContext)
// with its structural self-validation, via dropOnlyTotalFor / addOnlyTotalFor.
// They additionally require that nobody is over cap at baseline — a violator's
// voided points can change through promotions/demotions in the touched event,
// which the overlay cannot see — and fall back to the full re-score otherwise
// (or per candidate whenever a gate trips). forceFullRescore mirrors the swap
// ranking's diagnostic hook.

/** One drop-only analysis row (positive effective deltas only). */
export type DropOnlyRow = {
  athlete: string;
  /** Canonical SCY program event of the dropped entry. */
  dropEvent: string;
  /** Id of the dropped entry (plan id / result row id / recruit id). */
  dropEntryId: string;
  /** Result-row id of the dropped entry (dropSource 'result'). */
  dropResultId?: string;
  /** Recruit-row id of the dropped entry (dropSource 'recruit'). */
  dropRecruitId?: string;
  /** Where the dropped entry came from — same semantics as ExactSwap. */
  dropSource: 'plan' | 'result' | 'recruit';
  /** Time as swum on the dropped entry (when known). */
  dropTime?: string;
  /**
   * Effective team delta of dropping this entry alone: pure engine re-score
   * delta plus any cap-void points the drop restores. Positive = the team
   * scores MORE with this entry gone.
   */
  deltaPoints: number;
  /** Pure engine re-score delta (newTotal − baseTotal), excluding void modeling. */
  scoredDelta: number;
  /** Modeled points restored by relieving an entry-cap violation (deltaPoints − scoredDelta, when > 0). */
  voidedPointsRestored?: number;
  /** True when the athlete currently exceeds an entry cap (this drop reduces the violation). */
  capRelief?: boolean;
  /** Engine team totals — applying the drop and re-scoring reproduces newTotal exactly. */
  newTotal: number;
  baseTotal: number;
};

export type DropOnlyRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  /** Positive effective deltas only, sorted descending. */
  drops: DropOnlyRow[];
  /** Number of droppable entries re-scored. */
  candidatesEvaluated: number;
};

export type DropOnlyOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  /** Test/diagnostic hook: disable the incremental fast path (full re-score). */
  forceFullRescore?: boolean;
};

/** One add-only (open-slot) analysis row (positive deltas only). */
export type AddOnlyRow = {
  athlete: string;
  /** Canonical SCY program event being added. */
  addEvent: string;
  /** SCY-converted best time used for the added entry. */
  addTime: string;
  /** True when addTime is older than the recency window (only stale times existed). */
  addTimeStale?: boolean;
  /** True when addTime came from a converted LCM/SCM swim (not swum SCY). */
  addTimeConverted?: boolean;
  /** 'verify' when the projected gain sits inside conversion-factor noise (see ExactSwap.confidence). */
  confidence?: EntryConfidence;
  /** Class year carried onto the created plan entry (when known). */
  classYear?: string;
  deltaPoints: number;
  /** Engine team totals — applying the add and re-scoring reproduces newTotal exactly. */
  newTotal: number;
  baseTotal: number;
};

export type AddOnlyRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  /** Positive deltas only, sorted descending. */
  adds: AddOnlyRow[];
  /** Number of (athlete × open add-event) combinations re-scored. */
  candidatesEvaluated: number;
};

export type AddOnlyOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  table?: CrossCourseTable;
  recencyMonths?: number;
  /** Test/diagnostic hook: disable the incremental fast path (full re-score). */
  forceFullRescore?: boolean;
};

/** Per-team cap-void summary over one scored row set (see CAP-VOID MODEL above). */
type CapVoidSummary = {
  /** Total voided individual points across all violating team athletes. */
  total: number;
  /** Voided individual points per violating athlete (normalized-name key). */
  byAthlete: Map<string, number>;
  /** Every team athlete currently violating an entry cap (even at 0 points). */
  overCapKeys: Set<string>;
};

function computeCapVoids(
  scored: SwimmerResult[],
  team: string,
  gender: Gender,
  settings: ScoringSettings
): CapVoidSummary {
  const teamRows = scored.filter(
    r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null)
  );
  const display = new Map<string, string>();
  for (const r of teamRows) {
    if (isRelayResult(r) && r.name === r.team) continue;
    const name = String(r.name ?? '').trim();
    if (!name || name === '—') continue;
    const k = normalizeSwimmerName(r.name);
    if (!display.has(k)) display.set(k, r.name);
  }

  const byAthlete = new Map<string, number>();
  const overCapKeys = new Set<string>();
  let total = 0;
  for (const [key, name] of display) {
    const counts = countSwimmerEntries(teamRows, team, gender, name);
    const over = swimmerExceedsEntryLimits(counts, settings);
    if (!over.individualOver && !over.relayOver && !over.totalOver) continue;
    overCapKeys.add(key);
    let pts = 0;
    for (const r of teamRows) {
      if (isRelayResult(r)) continue;
      if (normalizeSwimmerName(r.name) !== key) continue;
      pts += typeof r.points === 'number' ? r.points : 0;
    }
    if (pts > 0) {
      byAthlete.set(key, pts);
      total += pts;
    }
  }
  return { total: Number(total.toFixed(3)), byAthlete, overCapKeys };
}

/**
 * Forward/inverse patch that removes ONE entry by source — the exact drop half
 * of applyExactSwap ('plan' → remove the plan (+active-id), 'result' → filter
 * the row, 'recruit' → filter the recruit). Shared by the enumeration (so
 * ranked totals are reproducible by construction) and by applyEntryDrop.
 */
function entryDropPatch(
  workspace: Workspace,
  source: 'plan' | 'result' | 'recruit',
  id: string,
  field: 'menResults' | 'womenResults'
): { patch: Partial<Workspace>; inverse: Partial<Workspace> } {
  const patch: Partial<Workspace> = {};
  const inverse: Partial<Workspace> = {};
  if (source === 'result') {
    const baseResults = workspace[field] ?? [];
    patch[field] = baseResults.filter(r => r.id !== id);
    inverse[field] = baseResults;
    return { patch, inverse };
  }
  if (source === 'recruit') {
    const baseRecruits = workspace.recruits ?? [];
    patch.recruits = baseRecruits.filter(r => r.id !== id);
    inverse.recruits = baseRecruits;
    return { patch, inverse };
  }
  const basePlans = workspace.meetEntryPlans ?? [];
  patch.meetEntryPlans = basePlans.filter(p => p.id !== id);
  inverse.meetEntryPlans = basePlans;
  const baseActiveIds = workspace.activeEntryIds;
  if (baseActiveIds && baseActiveIds.length > 0) {
    patch.activeEntryIds = baseActiveIds.filter(x => x !== id);
    inverse.activeEntryIds = baseActiveIds;
  }
  return { patch, inverse };
}

/**
 * Forward/inverse patch that appends ONE active plan entry — the exact add half
 * of applyExactSwap. Shared by the enumeration and applyEntryAdd.
 */
function entryAddPatch(
  workspace: Workspace,
  newEntry: PlannedSwimEntry
): { patch: Partial<Workspace>; inverse: Partial<Workspace> } {
  const basePlans = workspace.meetEntryPlans ?? [];
  const baseActiveIds = workspace.activeEntryIds;
  const patch: Partial<Workspace> = { meetEntryPlans: [...basePlans, newEntry] };
  const inverse: Partial<Workspace> = { meetEntryPlans: basePlans };
  if (baseActiveIds && baseActiveIds.length > 0) {
    patch.activeEntryIds = [...baseActiveIds, newEntry.id];
    inverse.activeEntryIds = baseActiveIds;
  }
  return { patch, inverse };
}

/**
 * TRUE team delta of dropping each current individual entry ALONE (no add).
 * Droppable union and drop semantics are identical to rankExactSwaps /
 * applyExactSwap (active plans / meet result rows / recruit rows, one per
 * athlete×event, plan > result > recruit). Deltas are effective totals under
 * the cap-void model (see module comment) — positive rows flag over-entry /
 * cap problems (and genuine meet-pool relief). Positive only, sorted
 * descending. Incremental fast path with full-re-score fallback.
 */
export function rankDropOnly(workspace: Workspace, opts: DropOnlyOptions): DropOnlyRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const teamsWithResults = distinctIndividualResultTeams(results, gender);
  if (teamsWithResults.size < 2) {
    return {
      pointsMeaningful: false,
      reason: fieldNotMeaningfulReason(teamsWithResults, gender),
      drops: [],
      candidatesEvaluated: 0,
    };
  }

  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';
  const droppableByAthlete = collectDroppableEntries(workspace, team, gender);

  const scoredBase = scoreWorkspaceRows(workspace, gender, merged);
  const baseTotal = sumTeamPoints(scoredBase, team, gender);
  const baseTotalRounded = Number(baseTotal.toFixed(3));
  const baseVoids = computeCapVoids(scoredBase, team, gender, merged);
  const baseEffective = baseTotal - baseVoids.total;

  // Fast overlay is only void-safe when nobody is over cap at baseline (a
  // violator's voided points can shift with promotions in the touched event).
  const hint = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const fastCtx =
    opts.forceFullRescore || baseVoids.total > 0
      ? null
      : buildFastSwapContext(workspace, team, gender, merged, hint);

  const rows: DropOnlyRow[] = [];
  let candidatesEvaluated = 0;

  for (const { byEvent } of droppableByAthlete.values()) {
    for (const drop of byEvent.values()) {
      candidatesEvaluated += 1;
      const athleteKey = normalizeSwimmerName(drop.name);
      const capRelief = baseVoids.overCapKeys.has(athleteKey);

      let newTotal = fastCtx ? fastCtx.dropOnlyTotalFor(drop) : null;
      let newEffective: number;
      if (newTotal == null) {
        const modWs: Workspace = {
          ...workspace,
          ...entryDropPatch(workspace, drop.source, drop.id, field).patch,
        };
        const scoredMod = scoreWorkspaceRows(modWs, gender, merged);
        newTotal = sumTeamPoints(scoredMod, team, gender);
        newEffective = newTotal - computeCapVoids(scoredMod, team, gender, merged).total;
      } else {
        // fastCtx only exists when baseVoids.total === 0, and dropping cannot
        // create a new violation — effective total equals the engine total.
        newEffective = newTotal;
      }

      const scoredDelta = Number((newTotal - baseTotal).toFixed(3));
      const deltaPoints = Number((newEffective - baseEffective).toFixed(3));
      if (deltaPoints <= 0) continue;
      const voidRestored = Number((deltaPoints - scoredDelta).toFixed(3));

      rows.push({
        athlete: drop.name,
        dropEvent: drop.event,
        dropEntryId: drop.id,
        dropResultId: drop.source === 'result' ? drop.id : undefined,
        dropRecruitId: drop.source === 'recruit' ? drop.id : undefined,
        dropSource: drop.source,
        dropTime: drop.time,
        deltaPoints,
        scoredDelta,
        voidedPointsRestored: voidRestored > 0 ? voidRestored : undefined,
        capRelief: capRelief ? true : undefined,
        newTotal: Number(newTotal.toFixed(3)),
        baseTotal: baseTotalRounded,
      });
    }
  }

  rows.sort((a, b) => b.deltaPoints - a.deltaPoints);
  return { pointsMeaningful: true, drops: rows, candidatesEvaluated };
}

/**
 * TRUE team delta of adding each open championship-program event (athlete's
 * recency-weighted, SCY-converted best from athleteHistory — the exact same
 * candidate machinery as rankExactSwaps) WITHOUT dropping anything, for
 * swimmers still under their entry caps (canAcceptAnotherEntry over the scored
 * what-if rows: individual cap AND the total cap, e.g. NSISC total-7). Each
 * row applies as one active optimizer plan (applyEntryAdd). Positive only,
 * sorted descending; converted-time rows are confidence-tagged.
 */
export function rankAddOnly(workspace: Workspace, opts: AddOnlyOptions): AddOnlyRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const teamsWithResults = distinctIndividualResultTeams(results, gender);
  if (teamsWithResults.size < 2) {
    return {
      pointsMeaningful: false,
      reason: fieldNotMeaningfulReason(teamsWithResults, gender),
      adds: [],
      candidatesEvaluated: 0,
    };
  }

  const table =
    opts.table ??
    buildCrossCourseTable(workspace, { team, gender, recencyMonths: opts.recencyMonths });
  const bestIndex = effectiveBestIndex(table);
  const displayByKey = new Map<string, string>();
  for (const row of table.rows) {
    const k = normalizeSwimmerName(row.athlete);
    if (!displayByKey.has(k)) displayByKey.set(k, row.athlete);
  }

  const droppableByAthlete = collectDroppableEntries(workspace, team, gender);

  const scoredBase = scoreWorkspaceRows(workspace, gender, merged);
  const baseTotal = sumTeamPoints(scoredBase, team, gender);
  const baseTotalRounded = Number(baseTotal.toFixed(3));
  const baseVoids = computeCapVoids(scoredBase, team, gender, merged);
  const baseEffective = baseTotal - baseVoids.total;
  const teamRows = scoredBase.filter(
    r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null)
  );

  const hint = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const fastCtx =
    opts.forceFullRescore || baseVoids.total > 0
      ? null
      : buildFastSwapContext(workspace, team, gender, merged, hint);

  const rows: AddOnlyRow[] = [];
  let candidatesEvaluated = 0;

  for (const [athleteKey, bests] of bestIndex) {
    const display = displayByKey.get(athleteKey);
    if (!display) continue;

    const dropInfo = droppableByAthlete.get(athleteKey);
    const entered = dropInfo?.byEvent ?? new Map<string, DroppableEntry>();
    const openEvents = [...bests.keys()].filter(ev => !entered.has(ev));
    if (openEvents.length === 0) continue;

    // Entry caps over the CURRENT scored what-if rows (plans + results +
    // recruits + relay legs) — an at-cap swimmer gets no add suggestions.
    const counts = countSwimmerEntries(teamRows, team, gender, display);
    if (!canAcceptAnotherEntry(counts, merged, openEvents[0])) continue;

    let classYear: string | undefined;
    if (dropInfo) {
      for (const e of dropInfo.byEvent.values()) {
        if (e.classYear) {
          classYear = e.classYear;
          break;
        }
      }
    }

    for (const addEvent of openEvents) {
      const best = bests.get(addEvent)!;
      candidatesEvaluated += 1;

      const newEntry = createPlannedEntry({
        name: display,
        team,
        gender,
        classYear,
        event: addEvent,
        time: best.time,
        timeType: 'SCY',
        source: 'optimizer',
        active: true,
      });

      let newTotal = fastCtx ? fastCtx.addOnlyTotalFor(newEntry) : null;
      let newEffective: number;
      if (newTotal == null) {
        const modWs: Workspace = { ...workspace, ...entryAddPatch(workspace, newEntry).patch };
        const scoredMod = scoreWorkspaceRows(modWs, gender, merged);
        newTotal = sumTeamPoints(scoredMod, team, gender);
        newEffective = newTotal - computeCapVoids(scoredMod, team, gender, merged).total;
      } else {
        // fastCtx only exists when baseVoids.total === 0; the add is cap-gated,
        // so it cannot create a violation — effective equals engine.
        newEffective = newTotal;
      }

      const deltaPoints = Number((newEffective - baseEffective).toFixed(3));
      if (deltaPoints <= 0) continue;

      rows.push({
        athlete: display,
        addEvent,
        addTime: best.time,
        addTimeStale: best.stale ? true : undefined,
        addTimeConverted: best.converted ? true : undefined,
        classYear,
        deltaPoints,
        newTotal: Number(newTotal.toFixed(3)),
        baseTotal: baseTotalRounded,
      });
    }
  }

  rows.sort((a, b) => b.deltaPoints - a.deltaPoints);

  // Conversion confidence bands (additive tagging only, after ranking).
  let timeIndex: Map<string, EventTimeRef[]> | null = null;
  for (const r of rows) {
    if (!r.addTimeConverted) continue;
    if (!timeIndex) timeIndex = buildEventTimeIndex(workspace, gender);
    const conf = conversionConfidence(timeIndex, r.addEvent, r.athlete, convertTimeToSeconds(r.addTime));
    if (conf) r.confidence = conf;
  }

  return { pointsMeaningful: true, adds: rows, candidatesEvaluated };
}

/**
 * Pure workspace patch that enacts one {@link DropOnlyRow}: remove the entry by
 * source — the exact same drop-by-source semantics as applyExactSwap, with no
 * added entry. Same {patch, inverse, description} contract; the inverse
 * restores every touched field exactly (round-trips). No mutation, no I/O.
 */
export function applyEntryDrop(
  workspace: Workspace,
  drop: DropOnlyRow,
  opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const gender = opts.gender;
  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';
  const dropId =
    drop.dropSource === 'plan'
      ? drop.dropEntryId
      : drop.dropSource === 'result'
        ? drop.dropResultId ?? drop.dropEntryId
        : drop.dropRecruitId ?? drop.dropEntryId;
  const { patch, inverse } = entryDropPatch(workspace, drop.dropSource, dropId, field);
  const description = `${drop.athlete}: −${drop.dropEvent}${
    drop.dropTime ? ` (${drop.dropTime})` : ''
  } — dropped ${drop.dropSource} entry`;
  return { patch, inverse, description };
}

/**
 * Pure workspace patch that enacts one {@link AddOnlyRow}: append one ACTIVE
 * optimizer plan for the open event (same add semantics as applyExactSwap,
 * with no drop). Same {patch, inverse, description} contract; the inverse
 * restores every touched field exactly (round-trips). No mutation, no I/O.
 */
export function applyEntryAdd(
  workspace: Workspace,
  add: AddOnlyRow,
  opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const newEntry = createPlannedEntry({
    name: add.athlete,
    team: opts.team.trim(),
    gender: opts.gender,
    classYear: add.classYear,
    event: add.addEvent,
    time: add.addTime,
    timeType: 'SCY',
    source: 'optimizer',
    active: true,
  });
  const { patch, inverse } = entryAddPatch(workspace, newEntry);
  const description = `${add.athlete}: +${add.addEvent} (${add.addTime}) — open-slot add`;
  return { patch, inverse, description };
}
