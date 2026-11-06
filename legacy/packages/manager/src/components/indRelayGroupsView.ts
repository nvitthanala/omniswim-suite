/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Pure view-model helpers for IndRelayManagementView — grouping scored relay
 * leg rows into per-relay-entry RelayGroup records.
 */

import type { Gender, SwimmerResult } from '@omniswim/core/types';
import {
  relayOverrideRefusal,
  resolveRelayEntryForLeg,
  type RelayEntryResolution,
  type RelayOverrideRefusal,
} from '@omniswim/core/lib/relayLegMatching';
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
  /**
   * Set when the relay of these legs cannot be told from its tied sibling (one
   * team's two relays with the same place and time, and no swimmer left that
   * names one). `key` then names no stored override, and every write for the
   * group is refused (`relayGroupWriteRefusal`). Absent on an ordinary relay.
   */
  refusal?: RelayOverrideRefusal;
};

/**
 * `null` when overrides may be written for `group`, else the reason they may
 * not. The screen's writers (drag, autofill, manual time, clear) ask this first
 * and write nothing when it is not `null`.
 */
export function relayGroupWriteRefusal(group: Pick<RelayGroup, 'refusal'>): RelayOverrideRefusal | null {
  return group.refusal ?? null;
}

function belongsToTeamAndGender(r: SwimmerResult, gender: Gender, team: string): boolean {
  return r.gender === gender && String(r.team ?? '').trim() === team;
}

function isRelayLegRow(r: SwimmerResult): boolean {
  return isRelayResult(r) && r.name !== r.team;
}

function seedRelayGroup(key: string, r: SwimmerResult, resolution: RelayEntryResolution): RelayGroup {
  const refusal = relayOverrideRefusal(resolution);
  return {
    key,
    // An unresolved leg is its own template: no original row is this relay's.
    template: resolution.status === 'resolved' ? resolution.template : r,
    ...(refusal === null ? {} : { refusal }),
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
    const resolution = resolveRelayEntryForLeg(originalResults, r);
    const key = resolution.status === 'resolved' ? resolution.entryKey : resolution.groupKey;
    let group = map.get(key);
    if (!group) {
      group = seedRelayGroup(key, r, resolution);
      map.set(key, group);
    }
    group.legs.push(r);
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
