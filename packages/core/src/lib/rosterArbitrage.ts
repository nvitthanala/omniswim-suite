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
import { buildWhatIfResults, createPlannedEntry } from './whatIfProjection';
import { buildScorerRosterLookup } from './scorerRoster';
import { calculatePoints, convertTimeToSeconds } from './utils';
import {
  optimizeEventLineupForTeam,
  optimizeScorersForTeam,
  type OptimizerResult,
} from './rosterOptimizer';

export type ArbitrageMode = 'individual_first' | 'relay_first';

export type ArbitrageCard = {
  athleteName: string;
  team: string;
  preferredEvent: string;
  alternateEvent: string;
  preferredDelta: number;
  alternateDelta: number;
  /** Points gained by choosing preferred over alternate (arbitrage). */
  arbitragePts: number;
  explanation: string;
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
 * Build coach-facing arbitrage cards: for each athlete, compare marginal value of
 * their best event vs next-best within the entry cap.
 */
export function buildArbitrageCards(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): ArbitrageCard[] {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  const results = buildWhatIfResults({ workspace, gender, removeSeniors: false });
  const lookup = buildScorerRosterLookup(
    results,
    merged,
    workspace.scorerRosterOverrides ?? [],
    gender
  );
  const athletes = lookup.rows.filter(r => r.team === team);
  const cards: ArbitrageCard[] = [];

  for (const athlete of athletes) {
    const profile = getAthleteProfile(workspace, team, gender, athlete.name, merged);
    const ranked = Object.entries(profile.bestByEvent).sort((a, b) => a[1].timeSec - b[1].timeSec);
    if (ranked.length < 2) continue;

    const [evA, bestA] = ranked[0];
    const [evB, bestB] = ranked[1];

    // Approximate marginal value by time gap relative to field median in those events
    // (lightweight heuristic — not a full re-score per swap).
    const fieldA = results.filter(r => r.event === evA && !r.isRelay);
    const fieldB = results.filter(r => r.event === evB && !r.isRelay);
    const median = (rows: typeof fieldA) => {
      if (!rows.length) return bestA.timeSec;
      const secs = rows.map(r => convertTimeToSeconds(r.time)).sort((a, b) => a - b);
      return secs[Math.floor(secs.length / 2)] ?? bestA.timeSec;
    };
    const gapA = Math.max(0, median(fieldA) - bestA.timeSec);
    const gapB = Math.max(0, median(fieldB) - bestB.timeSec);
    // Scale gaps into rough point units (faster than median → higher value).
    const preferredDelta = Number((gapA * 2).toFixed(1));
    const alternateDelta = Number((gapB * 2).toFixed(1));
    const arbitragePts = Number((preferredDelta - alternateDelta).toFixed(1));
    if (arbitragePts <= 0) continue;

    cards.push({
      athleteName: athlete.name,
      team,
      preferredEvent: evA,
      alternateEvent: evB,
      preferredDelta,
      alternateDelta,
      arbitragePts,
      explanation: `${athlete.name} in ${evA} (~+${preferredDelta} pts) vs ${evB} (~+${alternateDelta} pts) — arbitrage +${arbitragePts}`,
    });
  }

  return cards.sort((a, b) => b.arbitragePts - a.arbitragePts).slice(0, 12);
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
