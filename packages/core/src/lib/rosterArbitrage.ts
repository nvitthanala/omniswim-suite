/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Point-arbitrage helpers for roster optimization display.
 * Extends (does not replace) rosterOptimizer.ts.
 */

import {
  Gender,
  PlannedSwimEntry,
  ScoringSettings,
  Workspace,
} from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import { getAthleteProfile } from './athleteHistory';
import { rankExactSwaps } from './crossCourseArbitrage';
import { buildWhatIfResults, createPlannedEntry } from './whatIfProjection';
import { buildScorerRosterLookup } from './scorerRoster';
import { calculatePoints, normalizeSwimmerName } from './utils';
import {
  optimizeEventLineupForTeam,
  optimizeScorersForTeam,
  type OptimizerResult,
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

export type ArbitrageOptimizeResult = OptimizerResult & {
  mode: ArbitrageMode;
  cards: ArbitrageCard[];
};

function teamTotal(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings,
  overrides = workspace.scorerRosterOverrides ?? [],
  plans = workspace.meetEntryPlans,
  activeIds = workspace.activeEntryIds
): number {
  const ws: Workspace = {
    ...workspace,
    scorerRosterOverrides: overrides,
    meetEntryPlans: plans ?? workspace.meetEntryPlans,
    activeEntryIds: activeIds ?? workspace.activeEntryIds,
  };
  const results = buildWhatIfResults({ workspace: ws, gender, removeSeniors: false });
  const scored = calculatePoints(results, settings, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
  });
  return scored
    .filter(r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null))
    .reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
}

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
 * Optimize with explicit individual-first or relay-first bias, attaching arbitrage cards.
 * Reuses existing scorer + event lineup stages; does not replace rosterOptimizer API.
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
  const previousTotal = teamTotal(workspace, gender, team, merged);

  const overrides = optimizeScorersForTeam(workspace, gender, team, removeSeniors, merged);
  const wsWithScorers = { ...workspace, scorerRosterOverrides: overrides };

  let plans: PlannedSwimEntry[];
  let activeEntryIds: string[];

  if (mode === 'relay_first') {
    // Prefer relay events from profiles first, then fill remaining individual slots.
    const lookup = buildScorerRosterLookup(
      buildWhatIfResults({ workspace: wsWithScorers, gender, removeSeniors: false }),
      merged,
      overrides,
      gender
    );
    const teamAthletes = lookup.rows.filter(r => r.team === team);
    const existing = [...(workspace.meetEntryPlans ?? [])];
    const rest = existing.filter(p => !(p.team === team && p.gender === gender));
    plans = [...rest];
    activeEntryIds = [];
    const indCap = merged.maxIndividualEntriesPerSwimmer ?? 3;
    const relayCap = merged.maxRelayEntriesPerSwimmer ?? 4;

    for (const athlete of teamAthletes) {
      const profile = getAthleteProfile(wsWithScorers, team, gender, athlete.name, merged);
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
  } else {
    const ev = optimizeEventLineupForTeam(wsWithScorers, gender, team, merged);
    plans = ev.plans;
    activeEntryIds = ev.activeEntryIds;
  }

  const projectedTotal = teamTotal(
    workspace,
    gender,
    team,
    merged,
    overrides,
    plans,
    activeEntryIds
  );
  const cards = buildArbitrageCards(
    { ...workspace, scorerRosterOverrides: overrides, meetEntryPlans: plans, activeEntryIds },
    gender,
    team,
    merged
  );

  return {
    mode,
    overrides,
    meetEntryPlans: plans,
    activeEntryIds,
    projectedTotal,
    previousTotal,
    cards,
  };
}
