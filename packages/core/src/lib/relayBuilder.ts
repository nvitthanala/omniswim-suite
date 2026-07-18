/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Compare known PDF relay splits vs calculated splits from individual bests / history.
 */

import { Gender, SwimmerResult, Workspace } from '../types';
import { getAthleteProfile } from './athleteHistory';
import { mergeScoringSettings } from './scoringDefaults';
import {
  relayLegRequirements,
  suggestBestRelayLegFill,
  upsertRelayLegOverride,
  stableRelayEntryKey,
  relayTemplateFromLeg,
} from './relayLegMatching';
import { convertTimeToSeconds, isRelayResult, normalizeSwimmerName } from './utils';
import { displayTimeForRelayLeg } from './relaySplits';

export type RelaySplitComparison = {
  legIndex: number;
  swimmerName: string;
  knownSplit: string | null;
  calculatedSplit: string | null;
  deltaSec: number | null;
  source: 'pdf' | 'history' | 'lineup' | 'none';
};

function findCalculatedSplit(
  workspace: Workspace,
  team: string,
  gender: Gender,
  name: string,
  relayEvent: string,
  legIndex: number
): { time: string; source: 'history' | 'lineup' } | null {
  const req = relayLegRequirements(relayEvent, legIndex);
  const settings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const profile = getAthleteProfile(workspace, team, gender, name, settings);
  const matchEvent = Object.keys(profile.bestByEvent).find(ev => {
    const lower = ev.toLowerCase();
    return (
      lower.includes(String(req.legDistanceYards)) &&
      req.keywords.some(kw => lower.includes(kw))
    );
  });
  if (matchEvent && profile.bestByEvent[matchEvent]) {
    return { time: profile.bestByEvent[matchEvent].time, source: 'history' };
  }
  const plan = (workspace.meetEntryPlans ?? []).find(
    p =>
      p.team === team &&
      p.gender === gender &&
      normalizeSwimmerName(p.name) === normalizeSwimmerName(name) &&
      req.keywords.some(kw => p.event.toLowerCase().includes(kw)) &&
      p.event.includes(String(req.legDistanceYards))
  );
  if (plan) return { time: plan.time, source: 'lineup' };
  return null;
}

export function compareRelayLegSplits(
  workspace: Workspace,
  gender: Gender,
  legs: SwimmerResult[],
  relayEvent: string,
  team: string
): RelaySplitComparison[] {
  return [0, 1, 2, 3].map(legIndex => {
    const leg = legs.find(l => (l.relayLegIndex ?? -1) === legIndex) ?? legs[legIndex];
    const known =
      leg && !leg.relayLegVacant
        ? displayTimeForRelayLeg(leg) || leg.relayLegSplit || null
        : null;
    const name = leg && !leg.relayLegVacant ? leg.name : '';
    const calc =
      name && team
        ? findCalculatedSplit(workspace, team, gender, name, relayEvent, legIndex)
        : null;
    let deltaSec: number | null = null;
    if (known && calc) {
      deltaSec = convertTimeToSeconds(calc.time) - convertTimeToSeconds(known);
    }
    return {
      legIndex,
      swimmerName: name || '—',
      knownSplit: known,
      calculatedSplit: calc?.time ?? null,
      deltaSec,
      source: known ? 'pdf' : calc?.source ?? 'none',
    };
  });
}

/**
 * Propose relay leg fills from active individual lineup (meetEntryPlans) first,
 * then fall back to fastest eligible roster swimmers.
 */
export function buildRelaysFromIndividualLineup(
  workspace: Workspace,
  gender: Gender,
  team: string,
  activeSwimmers: SwimmerResult[],
  relayLegs: SwimmerResult[]
): NonNullable<Workspace['relayLegOverrides']> {
  const plans = (workspace.meetEntryPlans ?? []).filter(
    p => p.team === team && p.gender === gender && p.active !== false
  );
  const planAsSwimmers: SwimmerResult[] = plans.map(p => ({
    id: p.id,
    rank: 0,
    name: p.name,
    classYear: p.classYear ?? 'UNKNOWN',
    team: p.team,
    time: p.time,
    points: 0,
    event: p.event,
    gender: p.gender,
  }));
  const pool = [...planAsSwimmers, ...activeSwimmers];
  const teamRelayLegs = relayLegs.filter(
    r => isRelayResult(r) && String(r.team ?? '').trim() === team
  );

  let overrides = [...(workspace.relayLegOverrides ?? [])];
  const byRelay = new Map<string, SwimmerResult[]>();
  for (const leg of teamRelayLegs) {
    const key = stableRelayEntryKey(teamRelayLegs, leg);
    const list = byRelay.get(key) ?? [];
    list.push(leg);
    byRelay.set(key, list);
  }

  const exclude = new Set<string>();
  for (const [, legs] of byRelay) {
    const template = relayTemplateFromLeg(teamRelayLegs, legs[0]);
    const assigned = new Set(
      legs
        .filter(l => !l.relayLegVacant && l.name)
        .map(l => normalizeSwimmerName(l.name))
    );
    for (let legIndex = 0; legIndex < 4; legIndex++) {
      const leg = legs.find(l => (l.relayLegIndex ?? -1) === legIndex) ?? legs[legIndex];
      if (leg && !leg.relayLegVacant) continue;
      const suggestion = suggestBestRelayLegFill(pool, template, legIndex, assigned, exclude);
      if (!suggestion) continue;
      assigned.add(normalizeSwimmerName(suggestion.swimmer.name));
      overrides = upsertRelayLegOverride(overrides, suggestion.override);
    }
  }
  return overrides;
}
