/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exact-swap ranking: the exact team-points delta of swapping each candidate
 * add-event in for each of an athlete's CURRENT individual entries — whether
 * they come from an active plan, a loaded meet result row, or a recruit row —
 * by fully re-scoring (same buildWhatIfResults + calculatePoints pattern as
 * teamTotal in rosterArbitrage.ts), with an incremental fast path. Skipped when
 * the workspace has no meaningful scoring field (fewer than two distinct teams
 * with individual results).
 *
 * Test: npx tsx scripts/test_cross_course_arbitrage.mjs
 */

import { Gender, PlannedSwimEntry, ScoringSettings, Workspace } from '../../types';
import { mergeScoringSettings } from '../scoringDefaults';
import { createPlannedEntry } from '../whatIfProjection';
import { convertTimeToSeconds } from '../utils';
import { buildCrossCourseTable } from './crossCourseTable';
import {
  buildEventTimeIndex,
  buildFastSwapContext,
  collectDroppableEntries,
  conversionConfidence,
  distinctIndividualResultTeams,
  effectiveBestIndex,
  fieldNotMeaningfulReason,
  teamTotal,
  type CrossCourseTable,
  type DroppableEntry,
  type EntryConfidence,
  type EventTimeRef,
} from './shared';

export type ExactSwap = {
  athlete: string;
  addEvent: string;
  /** SCY-converted best time used for the added entry. */
  addTime: string;
  /** True when addTime is older than the recency window (only stale times existed). */
  addTimeStale?: boolean;
  dropEvent: string;
  /** Plan-entry id of the dropped entry (dropSource 'plan'). */
  dropEntryId?: string;
  /** Result-row id of the dropped entry (dropSource 'result'). */
  dropResultId?: string;
  /** Recruit-row id of the dropped entry (dropSource 'recruit'). */
  dropRecruitId?: string;
  /** Where the dropped current entry came from: an active plan, a loaded result row, or a recruit row. */
  dropSource: 'plan' | 'result' | 'recruit';
  /** Time as swum on the dropped current entry (when known). */
  dropTime?: string;
  /** True when addTime came from a converted LCM/SCM swim (not swum SCY). */
  addTimeConverted?: boolean;
  /**
   * 'verify' when the swap's outcome hinges on a converted time whose nearest
   * field time is within CONVERSION_VERIFY_MARGIN (~1%) of it — the placement
   * (and therefore the delta) sits inside conversion-factor noise. Additive
   * tag only; never changes ranking or filtering.
   */
  confidence?: EntryConfidence;
  deltaPoints: number;
  newTotal: number;
  baseTotal: number;
};

export type SwapRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  swaps: ExactSwap[];
  /** Number of (athlete x add-event x drop-entry) combinations re-scored. */
  candidatesEvaluated: number;
};

/**
 * Build the modified-workspace clone that simulates one 1-for-1 swap: drop
 * `drop` (a plan/result/recruit entry) and add `newEntry` (the overlay plan for
 * the candidate add-event). Identical semantics to the delete-credited-swim +
 * add-plan simulation. Used by the full re-score path (and as the fallback for
 * the incremental fast path).
 */
function buildSwapWorkspace(
  workspace: Workspace,
  drop: DroppableEntry,
  newEntry: PlannedSwimEntry,
  field: 'menResults' | 'womenResults'
): Workspace {
  const basePlans = workspace.meetEntryPlans ?? [];
  const baseActiveIds = workspace.activeEntryIds;
  const hasActiveIds = !!baseActiveIds && baseActiveIds.length > 0;
  const baseResults = workspace[field] ?? [];
  const baseRecruits = workspace.recruits ?? [];

  if (drop.source === 'plan') {
    const modPlans = basePlans
      .map(p => (p.id === drop.id ? { ...p, active: false } : p))
      .concat(newEntry);
    const modActiveIds = hasActiveIds
      ? [...baseActiveIds!.filter(id => id !== drop.id), newEntry.id]
      : baseActiveIds;
    return { ...workspace, meetEntryPlans: modPlans, activeEntryIds: modActiveIds };
  }
  if (drop.source === 'result') {
    const modActiveIds = hasActiveIds ? [...baseActiveIds!, newEntry.id] : baseActiveIds;
    return {
      ...workspace,
      [field]: baseResults.filter(r => r.id !== drop.id),
      meetEntryPlans: [...basePlans, newEntry],
      activeEntryIds: modActiveIds,
    };
  }
  const modActiveIds = hasActiveIds ? [...baseActiveIds!, newEntry.id] : baseActiveIds;
  return {
    ...workspace,
    recruits: baseRecruits.filter(r => r.id !== drop.id),
    meetEntryPlans: [...basePlans, newEntry],
    activeEntryIds: modActiveIds,
  };
}

/**
 * Exact team-points delta of each 1-for-1 swap: add a candidate program event
 * (using the athlete's SCY-converted best) in place of one of the athlete's
 * CURRENT individual entries — whether that entry came from an active plan, a
 * loaded meet result row, or a recruit row. Uses an incremental fast path that
 * re-scores only the two touched events (see buildFastSwapContext) and falls
 * back to a full re-score whenever the regime or a candidate is not provably
 * safe. Beneficial swaps only, sorted descending. Skips the enumeration
 * entirely when the scoring field is not meaningful (fewer than two distinct
 * teams with individual results).
 */
export function rankExactSwaps(
  workspace: Workspace,
  opts: {
    team: string;
    gender: Gender;
    settings?: ScoringSettings;
    table?: CrossCourseTable;
    recencyMonths?: number;
    /** Test/diagnostic hook: disable the incremental fast path (full re-score). */
    forceFullRescore?: boolean;
  }
): SwapRanking {
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
      swaps: [],
      candidatesEvaluated: 0,
    };
  }

  const table =
    opts.table ??
    buildCrossCourseTable(workspace, { team, gender, recencyMonths: opts.recencyMonths });
  const bestIndex = effectiveBestIndex(table);

  const droppableByAthlete = collectDroppableEntries(workspace, team, gender);

  // Invariants hoisted out of the inner loop.
  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';

  const baseTotal = teamTotal(workspace, gender, team, merged);
  const baseTotalRounded = Number(baseTotal.toFixed(3));

  // Incremental fast scorer (null => unsupported regime; score fully instead).
  const hint = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const fastCtx = opts.forceFullRescore
    ? null
    : buildFastSwapContext(workspace, team, gender, merged, hint);

  // De-dup identical (athlete, addEvent, dropEvent) outcomes, keeping the best delta.
  const bestByKey = new Map<string, ExactSwap>();
  let candidatesEvaluated = 0;

  for (const [athleteKey, { byEvent }] of droppableByAthlete) {
    const bests = bestIndex.get(athleteKey);
    if (!bests || byEvent.size === 0) continue;

    // Candidate add-events: the athlete's cross-course bests they are NOT already entered in.
    const enteredEvents = byEvent; // keyed by canonical program event
    const candidateEvents = [...bests.keys()].filter(ev => !enteredEvents.has(ev));
    if (candidateEvents.length === 0) continue;

    for (const addEvent of candidateEvents) {
      const best = bests.get(addEvent)!;
      for (const drop of byEvent.values()) {
        if (addEvent === drop.event) continue; // never swap an event for itself
        candidatesEvaluated += 1;

        // The added entry is the same across drop sources (best-per-event pool).
        const newEntry = createPlannedEntry({
          name: drop.name,
          team,
          gender,
          classYear: drop.classYear,
          event: addEvent,
          time: best.time,
          timeType: 'SCY',
          source: 'optimizer',
          active: true,
        });

        // Incremental fast scorer when available/safe; otherwise a full
        // re-score of the delete-credited-swim + add-plan simulation.
        let newTotal = fastCtx ? fastCtx.newTotalFor(drop, newEntry, addEvent) : null;
        if (newTotal == null) {
          const modWs = buildSwapWorkspace(workspace, drop, newEntry, field);
          newTotal = teamTotal(modWs, gender, team, merged);
        }
        const deltaPoints = Number((newTotal - baseTotal).toFixed(3));
        if (deltaPoints <= 0) continue;

        const dedupKey = `${athleteKey}|${addEvent}|${drop.event}`;
        const swap: ExactSwap = {
          athlete: drop.name,
          addEvent,
          addTime: best.time,
          addTimeStale: best.stale ? true : undefined,
          dropEvent: drop.event,
          dropEntryId: drop.id,
          dropResultId: drop.source === 'result' ? drop.id : undefined,
          dropRecruitId: drop.source === 'recruit' ? drop.id : undefined,
          dropSource: drop.source,
          dropTime: drop.time,
          addTimeConverted: best.converted ? true : undefined,
          deltaPoints,
          newTotal: Number(newTotal.toFixed(3)),
          baseTotal: baseTotalRounded,
        };
        const prior = bestByKey.get(dedupKey);
        if (!prior || swap.deltaPoints > prior.deltaPoints) bestByKey.set(dedupKey, swap);
      }
    }
  }

  const swaps = [...bestByKey.values()].sort((a, b) => b.deltaPoints - a.deltaPoints);

  // Conversion confidence bands: additive tagging only, AFTER ranking, so sort
  // and filter behavior are byte-identical to before.
  let timeIndex: Map<string, EventTimeRef[]> | null = null;
  for (const s of swaps) {
    if (!s.addTimeConverted) continue;
    if (!timeIndex) timeIndex = buildEventTimeIndex(workspace, gender);
    const conf = conversionConfidence(
      timeIndex,
      s.addEvent,
      s.athlete,
      convertTimeToSeconds(s.addTime)
    );
    if (conf) s.confidence = conf;
  }

  return { pointsMeaningful: true, swaps, candidatesEvaluated };
}

// --- apply an exact swap to a workspace -------------------------------------

/**
 * Pure workspace patch that enacts one {@link ExactSwap}: add an optimizer plan
 * for `addEvent`/`addTime` (active, appended to meetEntryPlans + activeEntryIds,
 * respecting the empty-activeIds regime), and drop the current entry by source
 * ('plan' → remove the plan; 'result' → filter the men/women result row;
 * 'recruit' → filter the recruit row). Returns the forward `patch`, an `inverse`
 * patch that exactly restores every touched field (round-trips), and a human
 * `description`. No mutation, no I/O.
 */
export function applyExactSwap(
  workspace: Workspace,
  swap: ExactSwap,
  opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const team = opts.team.trim();
  const gender = opts.gender;
  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';

  const newEntry = createPlannedEntry({
    name: swap.athlete,
    team,
    gender,
    event: swap.addEvent,
    time: swap.addTime,
    timeType: 'SCY',
    source: 'optimizer',
    active: true,
  });

  const basePlans = workspace.meetEntryPlans ?? [];
  const baseActiveIds = workspace.activeEntryIds;
  const hasActiveIds = !!baseActiveIds && baseActiveIds.length > 0;

  // Id of the row/entry being dropped (the additive per-source ids, falling back
  // to the shared dropEntryId that enumeration always populates).
  const dropId =
    swap.dropSource === 'plan'
      ? swap.dropEntryId
      : swap.dropSource === 'result'
        ? swap.dropResultId ?? swap.dropEntryId
        : swap.dropRecruitId ?? swap.dropEntryId;

  const patch: Partial<Workspace> = {};
  const inverse: Partial<Workspace> = {};

  // Drop side (result/recruit rows filtered by id; the prior array is stored for undo).
  if (swap.dropSource === 'result') {
    const baseResults = workspace[field] ?? [];
    patch[field] = baseResults.filter(r => r.id !== dropId);
    inverse[field] = baseResults;
  } else if (swap.dropSource === 'recruit') {
    const baseRecruits = workspace.recruits ?? [];
    patch.recruits = baseRecruits.filter(r => r.id !== dropId);
    inverse.recruits = baseRecruits;
  }

  // Plans: drop the plan (plan source) and always append the added entry.
  const plansAfterDrop =
    swap.dropSource === 'plan' ? basePlans.filter(p => p.id !== dropId) : basePlans;
  patch.meetEntryPlans = [...plansAfterDrop, newEntry];
  inverse.meetEntryPlans = basePlans;

  // Active ids only when the workspace uses an explicit active-id allowlist.
  if (hasActiveIds) {
    const withoutDrop =
      swap.dropSource === 'plan' ? baseActiveIds!.filter(id => id !== dropId) : baseActiveIds!;
    patch.activeEntryIds = [...withoutDrop, newEntry.id];
    inverse.activeEntryIds = baseActiveIds!;
  }

  const description = `${swap.athlete}: +${swap.addEvent} (${swap.addTime}), −${swap.dropEvent} (${swap.dropSource})`;

  return { patch, inverse, description };
}
