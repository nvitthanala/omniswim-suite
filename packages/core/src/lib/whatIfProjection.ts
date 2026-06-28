/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 3a: assemble what-if scoring pool. Test: npm run lint
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
import {
  convertTimeToSeconds,
  convertToSCY,
  isRelayResult,
  normalizeSwimmerName,
  simulateRoster,
} from './utils';

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

function planToResult(entry: PlannedSwimEntry): SwimmerResult {
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
  activeIds?: string[]
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
        event: patch.event,
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
    if (!p.replacesResultId) out.push(planToResult(p));
  }

  return out;
}

function buildPlanSheetResults(
  plans: PlannedSwimEntry[],
  gender: Gender,
  teamFilter?: Set<string>,
  activeIds?: string[]
): SwimmerResult[] {
  return plans
    .filter(
      p =>
        p.gender === gender &&
        planEntryActive(p, activeIds) &&
        (!teamFilter || teamFilter.has(p.team))
    )
    .map(planToResult);
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

export function buildWhatIfResults({
  workspace,
  gender,
  removeSeniors,
}: WhatIfProjectionOptions): SwimmerResult[] {
  const menResults = workspace.menResults ?? [];
  const womenResults = workspace.womenResults ?? [];
  const currentResults = gender === Gender.MEN ? menResults : womenResults;

  const recruitResults: SwimmerResult[] = (workspace.recruits ?? [])
    .filter(r => r.gender === gender)
    .map(r => ({
      id: r.id,
      rank: 0,
      name: r.name,
      classYear: r.classYear,
      team: r.team,
      time: convertToSCY(r.time, r.event, r.gender, r.timeType),
      points: 0,
      event: r.event,
      isRecruit: true,
      gender: r.gender,
    }));

  const excluded = new Set(
    (workspace.deletedSwimmers ?? [])
      .filter(d => d.gender === gender)
      .map(d => normalizeSwimmerName(d.name))
  );

  const relayKeysForGender = new Set<string>();
  for (const row of currentResults.filter(x => x.isRelay)) {
    relayKeysForGender.add(relayEntryKey(relayTemplateFromLeg(currentResults, row)));
  }
  const relayOverrides: RelayLegOverride[] = (workspace.relayLegOverrides ?? []).filter(o =>
    relayKeysForGender.has(o.relayEntryKey)
  );

  let base = simulateRoster(
    currentResults,
    recruitResults,
    removeSeniors,
    excluded,
    relayOverrides
  );

  const plans = workspace.meetEntryPlans ?? [];
  const activeIds = workspace.activeEntryIds;
  const mode = workspace.entryPlanMode ?? 'overlay';

  if (mode === 'plan_sheet' && plans.length > 0) {
    const teamsInPlan = new Set(plans.filter(p => p.gender === gender).map(p => p.team));
    const relays = base.filter(r => isRelayResult(r));
    const pdfIndividuals = base.filter(
      r => !isRelayResult(r) && !teamsInPlan.has(String(r.team ?? '').trim())
    );
    const planIndividuals = buildPlanSheetResults(plans, gender, teamsInPlan, activeIds);
    base = [...pdfIndividuals, ...planIndividuals, ...relays];
  } else if (plans.length > 0) {
    base = applyOverlayPlans(base, plans, gender, activeIds);
  }

  const hasProjectedPlans = plans.some(
    p => p.gender === gender && (p.projectedRank != null || p.source === 'optimizer' || p.source === 'swimcloud')
  );
  if (hasProjectedPlans || mode === 'plan_sheet') {
    base = projectRanksInField(base);
  }

  return base;
}

export function createPlannedEntry(
  partial: Omit<PlannedSwimEntry, 'id'> & { id?: string }
): PlannedSwimEntry {
  return { id: partial.id ?? uuidv4(), ...partial };
}
