/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 2: roster optimizer stages A/B/C. Test: npx tsx scripts/test_roster_optimizer.mjs
 */

import {
  Gender,
  PlannedSwimEntry,
  ScorerRosterOverride,
  ScoringSettings,
  Workspace,
} from '../types';
import {
  aggregateSwimmerMeetPoints,
  buildScorerRosterLookup,
  scorerRosterKey,
} from './scorerRoster';
import { mergeScoringSettings } from './scoringDefaults';
import { getAthleteProfile } from './athleteHistory';
import { buildWhatIfResults, createPlannedEntry } from './whatIfProjection';
import { calculatePoints } from './utils';

export type OptimizerStage = 'scorers' | 'events' | 'hypothetical' | 'all';

export type OptimizerResult = {
  overrides: ScorerRosterOverride[];
  meetEntryPlans: PlannedSwimEntry[];
  activeEntryIds: string[];
  projectedTotal: number;
  previousTotal: number;
};

function teamTotalForTeam(
  workspace: Workspace,
  gender: Gender,
  removeSeniors: boolean,
  settings: ScoringSettings,
  team: string,
  overrides: ScorerRosterOverride[],
  plans?: PlannedSwimEntry[],
  activeIds?: string[]
): number {
  const ws: Workspace = {
    ...workspace,
    scorerRosterOverrides: overrides,
    meetEntryPlans: plans ?? workspace.meetEntryPlans,
    activeEntryIds: activeIds ?? workspace.activeEntryIds,
  };
  const results = buildWhatIfResults({ workspace: ws, gender, removeSeniors });
  const scored = calculatePoints(results, settings, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
  });
  return scored
    .filter(r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null))
    .reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
}

/** Stage A: maximize scorer roster for one team. */
export function optimizeScorersForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  removeSeniors: boolean,
  settings: ScoringSettings
): ScorerRosterOverride[] {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  const results = buildWhatIfResults({ workspace, gender, removeSeniors });
  const scored = calculatePoints(results, merged, {
    scorerRosterOverrides: workspace.scorerRosterOverrides ?? [],
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])],
  });
  const lookup = buildScorerRosterLookup(results, merged, workspace.scorerRosterOverrides ?? [], gender);
  const teamRows = lookup.rows.filter(r => r.team === team);
  const points = aggregateSwimmerMeetPoints(scored, gender);

  const ranked = [...teamRows].sort((a, b) => {
    const pa = points.get(a.key) ?? 0;
    const pb = points.get(b.key) ?? 0;
    return pb - pa || a.name.localeCompare(b.name);
  });

  const cap = Math.min(merged.maxIndividualScorersPerTeam ?? 18, ranked.length);
  const selected = new Set(ranked.slice(0, cap).map(r => r.key));

  const overrides: ScorerRosterOverride[] = [...(workspace.scorerRosterOverrides ?? [])].filter(
    o => !(o.team === team && o.gender === gender)
  );

  for (const row of teamRows) {
    const want = selected.has(row.key);
    const auto = lookup.isScorer(row.name, row.team, row.gender);
    if (want !== auto) {
      overrides.push({
        name: row.name,
        team: row.team,
        gender: row.gender,
        isScorer: want,
      });
    }
  }

  // Local improvement: try flipping borderline athletes
  let best = teamTotalForTeam(workspace, gender, removeSeniors, merged, team, overrides);
  const borderline = ranked.slice(Math.max(0, cap - 3), cap + 3);
  for (const row of borderline) {
    const key = scorerRosterKey(row.team, row.gender, row.name);
    const cur = overrides.find(
      o => scorerRosterKey(o.team, o.gender, o.name) === key
    );
    const isOn = cur ? cur.isScorer : lookup.isScorer(row.name, row.team, row.gender);
    const trial = overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
    trial.push({ name: row.name, team: row.team, gender: row.gender, isScorer: !isOn });
    const t = teamTotalForTeam(workspace, gender, removeSeniors, merged, team, trial);
    if (t > best) {
      best = t;
      const rest = overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
      if (!isOn) {
        rest.push({ name: row.name, team: row.team, gender: row.gender, isScorer: true });
      }
      overrides.length = 0;
      overrides.push(...rest);
    }
  }

  return overrides;
}

/** Stage B: pick active primary events per athlete from history + PDF. */
export function optimizeEventLineupForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): { plans: PlannedSwimEntry[]; activeEntryIds: string[] } {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  const lookup = buildScorerRosterLookup(
    buildWhatIfResults({ workspace, gender, removeSeniors: false }),
    merged,
    workspace.scorerRosterOverrides ?? [],
    gender
  );
  const teamAthletes = lookup.rows.filter(r => r.team === team);
  const existing = [...(workspace.meetEntryPlans ?? [])];
  const rest = existing.filter(p => !(p.team === team && p.gender === gender));
  const plans: PlannedSwimEntry[] = [...rest];
  const activeEntryIds: string[] = [];

  for (const athlete of teamAthletes) {
    const profile = getAthleteProfile(workspace, team, gender, athlete.name, merged);
    for (const event of profile.primaryEvents) {
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
    }
  }

  return { plans, activeEntryIds };
}

export function optimizeRosterForTeam(
  workspace: Workspace,
  gender: Gender,
  team: string,
  removeSeniors: boolean,
  settings: ScoringSettings,
  stages: OptimizerStage = 'all'
): OptimizerResult {
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });
  const previousTotal = teamTotalForTeam(
    workspace,
    gender,
    removeSeniors,
    merged,
    team,
    workspace.scorerRosterOverrides ?? []
  );

  let overrides = [...(workspace.scorerRosterOverrides ?? [])];
  let plans = [...(workspace.meetEntryPlans ?? [])];
  let activeIds = [...(workspace.activeEntryIds ?? [])];

  if (stages === 'scorers' || stages === 'all') {
    overrides = optimizeScorersForTeam(workspace, gender, team, removeSeniors, merged);
  }

  if (stages === 'events' || stages === 'all') {
    const wsWithScorers = { ...workspace, scorerRosterOverrides: overrides };
    const ev = optimizeEventLineupForTeam(wsWithScorers, gender, team, merged);
    plans = ev.plans;
    activeIds = ev.activeEntryIds;
  }

  if (stages === 'hypothetical' || stages === 'all') {
    /* rank projection runs inside buildWhatIfResults when plans present */
  }

  const projectedTotal = teamTotalForTeam(
    { ...workspace, scorerRosterOverrides: overrides, meetEntryPlans: plans, activeEntryIds: activeIds },
    gender,
    removeSeniors,
    merged,
    team,
    overrides,
    plans,
    activeIds
  );

  return { overrides, meetEntryPlans: plans, activeEntryIds: activeIds, projectedTotal, previousTotal };
}

export function optimizeRosterAllTeams(
  workspace: Workspace,
  gender: Gender,
  removeSeniors: boolean,
  settings: ScoringSettings,
  stages: OptimizerStage = 'all'
): OptimizerResult {
  const results = buildWhatIfResults({ workspace, gender, removeSeniors });
  const teams = [
    ...new Set(
      results
        .filter(r => !r.isRelay || r.name !== r.team)
        .map(r => String(r.team ?? '').trim())
        .filter(Boolean)
    ),
  ].sort();

  let overrides = [...(workspace.scorerRosterOverrides ?? [])];
  let plans = [...(workspace.meetEntryPlans ?? [])];
  let activeIds = [...(workspace.activeEntryIds ?? [])];
  let previousTotal = 0;
  let projectedTotal = 0;
  const merged = mergeScoringSettings(settings, { conference: workspace.conference });

  for (const team of teams) {
    const sub = optimizeRosterForTeam(
      { ...workspace, scorerRosterOverrides: overrides, meetEntryPlans: plans, activeEntryIds: activeIds },
      gender,
      team,
      removeSeniors,
      merged,
      stages
    );
    overrides = sub.overrides;
    plans = sub.meetEntryPlans;
    activeIds = sub.activeEntryIds;
    previousTotal += sub.previousTotal;
    projectedTotal += sub.projectedTotal;
  }

  return { overrides, meetEntryPlans: plans, activeEntryIds: activeIds, projectedTotal, previousTotal };
}
