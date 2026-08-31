/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Point-arbitrage helpers for roster optimization display.
 * Extends (does not replace) rosterOptimizer.ts.
 */

import {
  Gender,
  PlannedSwimEntry,
  ScorerRosterOverride,
  ScoringSettings,
  Workspace,
} from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import { getAthleteProfile } from './athleteHistory';
import { rankExactSwaps } from './crossCourseArbitrage';
import { buildWhatIfResults, createPlannedEntry } from './whatIfProjection';
import { buildScorerRosterLookup } from './scorerRoster';
import { normalizeSwimmerName } from './utils';
import {
  optimizeEventLineupForTeam,
  optimizeScorersForTeam,
  selectGuardedResult,
  teamTotalForTeam,
  type GuardedOptimizerResult,
  type OptimizerCandidate,
} from './rosterOptimizer';

export type ArbitrageMode = 'individual_first' | 'relay_first';

export type ArbitrageCard = {
  athleteName: string;
  team: string;
  /** Event to move this athlete INTO. */
  preferredEvent: string;
  /** Event they currently occupy, which the swap gives up. */
  alternateEvent: string;
  /**
   * @deprecated Kept so existing consumers keep compiling. Both were derived from
   * a time gap scaled by an arbitrary constant and never carried point units;
   * `arbitragePts` is now the only real number on this card. Always 0.
   */
  preferredDelta: number;
  /** @deprecated See {@link ArbitrageCard.preferredDelta}. Always 0. */
  alternateDelta: number;
  /**
   * Points the team gains by making this swap — a genuine difference of two
   * scored team totals, produced by `rankExactSwaps`, not an estimate.
   */
  arbitragePts: number;
  /** The athlete's best time in `preferredEvent`, SCY. */
  addTime?: string;
  /** True when `addTime` came from a converted LCM/SCM swim rather than a yards swim. */
  addTimeConverted?: boolean;
  /** Set when the swap's outcome sits inside conversion-factor noise — verify before acting. */
  needsVerify?: boolean;
  explanation: string;
};

export type ArbitrageCardsResult = {
  cards: ArbitrageCard[];
  /**
   * False when the loaded field cannot produce a point value at all — fewer than
   * two scoring teams, so there is nothing to place against. `reason` explains it.
   */
  pointsMeaningful: boolean;
  reason?: string;
};

/**
 * Guarded, like every other optimizer entry point — see {@link selectGuardedResult}.
 * `outcome`, `appliedStages` and `unguardedTotal` are always present, so a caller
 * can tell "gained N" from "found nothing better" instead of reporting a win for
 * a no-op.
 */
export type ArbitrageOptimizeResult = GuardedOptimizerResult & {
  mode: ArbitrageMode;
  cards: ArbitrageCard[];
};

/**
 * Coach-facing arbitrage cards: which single entry swap gains this team the most
 * points, and how many.
 *
 * This is a presentation layer over {@link rankExactSwaps}. It used to compute its
 * own number — the athlete's gap to the field median in seconds, multiplied by 2
 * and labelled "pts". That is not a unit conversion: a 1650 swimmer 29 s clear of
 * the median scored "+58.7" on a scale whose maximum is 20, and the inflation grew
 * with event length, so distance events always outranked sprints for a reason
 * unrelated to scoring.
 *
 * `rankExactSwaps` already answers the real question — it applies each candidate
 * swap and re-scores the field, so `deltaPoints` is a genuine difference of two
 * team totals. It also knows when the answer is meaningless (a field with fewer
 * than two scoring teams) and says so via `pointsMeaningful`, rather than
 * returning a confident number. Delegating gets all of that, and stops this file
 * being a second, cruder implementation of a solved problem.
 */
export function buildArbitrageCardsResult(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): ArbitrageCardsResult {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  const ranking = rankExactSwaps(workspace, { team, gender, settings: merged });

  // No scoreable field means no point value can be stated. Say why rather than
  // rendering an empty panel that looks like "no opportunities found".
  if (!ranking.pointsMeaningful) {
    return { cards: [], pointsMeaningful: false, reason: ranking.reason };
  }

  // One card per athlete — their best available swap. `rankExactSwaps` returns
  // every (athlete × add × drop) combination, so without this a single swimmer
  // with six droppable entries fills the whole panel and hides the rest of the team.
  const bestPerAthlete = new Map<string, (typeof ranking.swaps)[number]>();
  for (const s of ranking.swaps) {
    if (s.deltaPoints <= 0) continue;
    const key = normalizeSwimmerName(s.athlete);
    const prev = bestPerAthlete.get(key);
    if (!prev || s.deltaPoints > prev.deltaPoints) bestPerAthlete.set(key, s);
  }

  const cards = [...bestPerAthlete.values()]
    .sort((a, b) => b.deltaPoints - a.deltaPoints)
    .slice(0, 12)
    .map(s => ({
      athleteName: s.athlete,
      team,
      preferredEvent: s.addEvent,
      alternateEvent: s.dropEvent,
      preferredDelta: 0,
      alternateDelta: 0,
      arbitragePts: Number(s.deltaPoints.toFixed(1)),
      addTime: s.addTime,
      addTimeConverted: s.addTimeConverted,
      needsVerify: s.confidence === 'verify',
      explanation:
        `${s.athlete}: swim ${s.addEvent} instead of ${s.dropEvent} — ` +
        `${s.deltaPoints.toFixed(1)} points to ${team} ` +
        `(${s.baseTotal.toFixed(1)} → ${s.newTotal.toFixed(1)})`,
    }));

  return { cards, pointsMeaningful: true };
}

/** Cards only. Prefer {@link buildArbitrageCardsResult} so the empty case can explain itself. */
export function buildArbitrageCards(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): ArbitrageCard[] {
  return buildArbitrageCardsResult(workspace, gender, team, settings).cards;
}

/**
 * Relay-first lineup stage: fill each athlete's relay slots from their profile
 * first, then spend what is left of their individual cap.
 *
 * Same contract as {@link optimizeEventLineupForTeam} — it reads the scorer set
 * and the existing plans off the workspace it is given, so the caller controls
 * whether it runs against the current roster or a proposed one by choosing which
 * workspace to hand it.
 */
function relayFirstLineupForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): { plans: PlannedSwimEntry[]; activeEntryIds: string[] } {
  const overrides = workspace.scorerRosterOverrides ?? [];
  const lookup = buildScorerRosterLookup(
    buildWhatIfResults({ workspace, gender, removeSeniors: false }),
    settings,
    overrides,
    gender
  );
  const teamAthletes = lookup.rows.filter(r => r.team === team);
  const existing = [...(workspace.meetEntryPlans ?? [])];
  const plans: PlannedSwimEntry[] = existing.filter(
    p => !(p.team === team && p.gender === gender)
  );
  const activeEntryIds: string[] = [];
  const indCap = settings.maxIndividualEntriesPerSwimmer ?? 3;
  const relayCap = settings.maxRelayEntriesPerSwimmer ?? 4;

  for (const athlete of teamAthletes) {
    const profile = getAthleteProfile(workspace, team, gender, athlete.name, settings);
    let relayLeft = relayCap;
    let indLeft = indCap;
    for (const event of profile.relayEvents) {
      if (relayLeft <= 0) break;
      const best = profile.bestByEvent[event];
      const entry = createPlannedEntry({
        name: athlete.name,
        team,
        gender,
        classYear: athlete.classYear,
        event,
        time: best?.time ?? 'NT',
        source: 'optimizer',
        active: true,
      });
      plans.push(entry);
      activeEntryIds.push(entry.id);
      relayLeft -= 1;
    }
    for (const event of profile.primaryEvents) {
      if (indLeft <= 0) break;
      if (/\brelay\b/i.test(event)) continue;
      const best = profile.bestByEvent[event];
      const entry = createPlannedEntry({
        name: athlete.name,
        team,
        gender,
        classYear: athlete.classYear,
        event,
        time: best?.time ?? 'NT',
        source: 'optimizer',
        active: true,
      });
      plans.push(entry);
      activeEntryIds.push(entry.id);
      indLeft -= 1;
    }
  }

  return { plans, activeEntryIds };
}

/**
 * Optimize with explicit individual-first or relay-first bias, attaching arbitrage cards.
 * Reuses existing scorer + event lineup stages; does not replace rosterOptimizer API.
 *
 * THE GUARD APPLIES HERE TOO. This function used to compute `previousTotal`,
 * compute `projectedTotal`, and return unconditionally — it never compared them.
 * It is the same defect `optimizeRosterForTeam` was fixed for, in a second entry
 * point behind the same "Optimize team" button. Measured on the recruit-only
 * fixture in scripts/test_arbitrage_never_loses.mjs, both modes took a team from
 * **400.45 to 380.45** while the guarded sibling held 400.45 on identical input.
 *
 * It now enumerates the same three COMPLETE candidate states its sibling does —
 * scorers alone, the lineup stage alone, and the two chained — scores each with
 * the SAME {@link teamTotalForTeam} the sibling uses, and defers to the shared
 * {@link selectGuardedResult}. Only the lineup stage differs by mode, which is
 * why the guard is shared and the candidate generation is not.
 *
 * Enumerating rather than only guarding the chained result matters for the same
 * reason it does in `optimizeRosterForTeam`: the scorers stage can lose points on
 * its own and only pay off once the lineup stage runs after it, and on a
 * recruit-only roster the lineup stage alone can beat both. Guarding the chain
 * only would make this button refuse in cases where a real gain exists.
 *
 * Cards are built from the state actually RETURNED, not from the candidate that
 * lost. A refused optimization that still described the rejected lineup would be
 * advice about a roster the coach does not have.
 */
export function optimizeWithArbitrage(
  workspace: Workspace,
  gender: Gender,
  team: string,
  removeSeniors: boolean,
  settings: ScoringSettings,
  mode: ArbitrageMode = 'individual_first'
): ArbitrageOptimizeResult {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });

  // The caller's own state, which is what gets handed back if nothing wins.
  const baseOverrides = [...(workspace.scorerRosterOverrides ?? [])];
  const basePlans = [...(workspace.meetEntryPlans ?? [])];
  const baseActiveIds = [...(workspace.activeEntryIds ?? [])];

  const score = (
    overrides: ScorerRosterOverride[],
    plans: PlannedSwimEntry[],
    activeIds: string[]
  ): number =>
    teamTotalForTeam(workspace, gender, removeSeniors, merged, team, overrides, plans, activeIds);

  const previousTotal = score(baseOverrides, basePlans, baseActiveIds);

  const lineupForWorkspace = (ws: Workspace) =>
    mode === 'relay_first'
      ? relayFirstLineupForTeam(ws, gender, team, merged)
      : optimizeEventLineupForTeam(ws, gender, team, merged);

  const scorerOverrides = optimizeScorersForTeam(workspace, gender, team, removeSeniors, merged);

  const candidates: OptimizerCandidate[] = [];

  candidates.push({
    appliedStages: 'scorers',
    overrides: scorerOverrides,
    plans: basePlans,
    activeIds: baseActiveIds,
    total: score(scorerOverrides, basePlans, baseActiveIds),
  });

  // The lineup stage against the scorer set the workspace ALREADY has, not the
  // one stage A just proposed — this is the candidate that saves a recruit-only
  // roster when stage A is the thing destroying it.
  const evOnly = lineupForWorkspace(workspace);
  candidates.push({
    appliedStages: 'events',
    overrides: baseOverrides,
    plans: evOnly.plans,
    activeIds: evOnly.activeEntryIds,
    total: score(baseOverrides, evOnly.plans, evOnly.activeEntryIds),
  });

  const evChained = lineupForWorkspace({
    ...workspace,
    scorerRosterOverrides: scorerOverrides,
  });
  const chained: OptimizerCandidate = {
    appliedStages: 'scorers+events',
    overrides: scorerOverrides,
    plans: evChained.plans,
    activeIds: evChained.activeEntryIds,
    total: score(scorerOverrides, evChained.plans, evChained.activeEntryIds),
  };
  candidates.push(chained);

  const guarded = selectGuardedResult(
    {
      overrides: baseOverrides,
      plans: basePlans,
      activeIds: baseActiveIds,
      total: previousTotal,
    },
    candidates,
    // What the pre-guard code returned: the fully chained stage result.
    chained.total
  );

  const cards = buildArbitrageCards(
    {
      ...workspace,
      scorerRosterOverrides: guarded.overrides,
      meetEntryPlans: guarded.meetEntryPlans,
      activeEntryIds: guarded.activeEntryIds,
    },
    gender,
    team,
    merged
  );

  return { ...guarded, mode, cards };
}
