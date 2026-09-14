/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Pure view-model helpers for IndRelayManagementView — grouping scored relay
 * leg rows into per-relay-entry RelayGroup records.
 */

import type { Gender, SwimmerResult } from '@omniswim/core/types';
import { relayTemplateFromLeg, stableRelayEntryKey } from '@omniswim/core/lib/relayLegMatching';
import { isRelayResult } from '@omniswim/core/lib/utils';

export type RelayGroup = {
  key: string;
  template: SwimmerResult;
  event: string;
  roundSwam: string;
  rank: number;
  teamTotal: string;
  legs: SwimmerResult[];
  teamSplits?: SwimmerResult['relayTeamSplits'];
};

function belongsToTeamAndGender(r: SwimmerResult, gender: Gender, team: string): boolean {
  return r.gender === gender && String(r.team ?? '').trim() === team;
}

function isRelayLegRow(r: SwimmerResult): boolean {
  return isRelayResult(r) && r.name !== r.team;
}

function seedRelayGroup(key: string, r: SwimmerResult, originalResults: SwimmerResult[]): RelayGroup {
  const template = relayTemplateFromLeg(originalResults, r);
  return {
    key,
    template,
    event: r.event,
    roundSwam: r.roundSwam?.trim() || '—',
    rank: r.rank,
    teamTotal: r.relayTeamTime || r.finalsTime || r.time,
    legs: [],
    teamSplits: r.relayTeamSplits,
  };
}

function groupRelayLegRows(rows: SwimmerResult[], originalResults: SwimmerResult[]): Map<string, RelayGroup> {
  const map = new Map<string, RelayGroup>();
  for (const r of rows) {
    const key = stableRelayEntryKey(originalResults, r);
    if (!map.has(key)) {
      map.set(key, seedRelayGroup(key, r, originalResults));
    }
    map.get(key)!.legs.push(r);
  }
  return map;
}

function sortRelayGroupLegs(group: RelayGroup): RelayGroup {
  return {
    ...group,
    legs: [...group.legs].sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0)),
  };
}

function compareRelayGroups(a: RelayGroup, b: RelayGroup): number {
  return a.event.localeCompare(b.event) || a.roundSwam.localeCompare(b.roundSwam);
}

/** Group one team/gender's scored relay leg rows (from ScoringBundle.allScored)
 * into per-relay-entry RelayGroup records, legs sorted by leg index and groups
 * sorted by event then round. */
export function buildRelayGroups(params: {
  allScored: SwimmerResult[];
  originalResults: SwimmerResult[];
  gender: Gender;
  team: string;
}): RelayGroup[] {
  const { allScored, originalResults, gender, team } = params;
  const rows = allScored.filter(r => belongsToTeamAndGender(r, gender, team) && isRelayLegRow(r));
  const map = groupRelayLegRows(rows, originalResults);
  return [...map.values()].map(sortRelayGroupLegs).sort(compareRelayGroups);
}
