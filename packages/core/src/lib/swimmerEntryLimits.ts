/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 0: per-swimmer entry limit counting. Test: npx tsx scripts/test_entry_limits.mjs
 */

import { Gender, ScoringSettings, SwimmerResult } from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import { isRelayResult, normalizeSwimmerName } from './utils';
import { relayEntryKey } from './relaySplits';
import { relayTemplateFromLeg } from './relayLegMatching';

export type SwimmerEntryCounts = {
  individual: number;
  relayEvents: Set<string>;
  relayCount: number;
  total?: number; // individual + relayCount
};

export function countSwimmerEntries(
  results: SwimmerResult[],
  team: string,
  gender: Gender,
  name: string
): SwimmerEntryCounts {
  const nameKey = normalizeSwimmerName(name);
  const relayEvents = new Set<string>();
  let individual = 0;
  const indEvents = new Set<string>();

  for (const r of results) {
    if (r.gender != null && r.gender !== gender) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    if (normalizeSwimmerName(r.name) !== nameKey) continue;

    if (isRelayResult(r) && r.name !== r.team) {
      const key = relayEntryKey(relayTemplateFromLeg(results, r));
      relayEvents.add(key);
      continue;
    }
    if (!r.isRelay) {
      const ev = r.event?.trim();
      if (ev && !indEvents.has(ev)) {
        indEvents.add(ev);
        individual += 1;
      }
    }
  }

  return { individual, relayEvents, relayCount: relayEvents.size, total: individual + relayEvents.size };
}

export function swimmerExceedsEntryLimits(
  counts: SwimmerEntryCounts,
  settings: ScoringSettings
): { individualOver: boolean; relayOver: boolean; totalOver: boolean } {
  const merged = mergeScoringSettings(settings);
  const indCap = merged.maxIndividualEntriesPerSwimmer ?? 999;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 999;
  const totalCap = merged.maxTotalEntriesPerSwimmer ?? 999;
  const total = (counts.total ?? counts.individual + counts.relayCount);
  return {
    individualOver: counts.individual > indCap,
    relayOver: counts.relayCount > relayCap,
    totalOver: total > totalCap,
  };
}

export function formatEntryLimitLabel(
  counts: SwimmerEntryCounts,
  settings: ScoringSettings
): string {
  const merged = mergeScoringSettings(settings);
  const indCap = merged.maxIndividualEntriesPerSwimmer ?? 999;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 999;
  const totalCap = merged.maxTotalEntriesPerSwimmer ?? 999;
  const total = (counts.total ?? counts.individual + counts.relayCount);

  if (totalCap < 999) {
    return `${total}/${totalCap} total (${counts.individual} ind · ${counts.relayCount} relay)`;
  }
  return `${counts.individual}/${indCap} ind · ${counts.relayCount}/${relayCap} relay`;
}

/** Whether adding one more entry of the given event type would exceed caps. */
export function canAcceptAnotherEntry(
  counts: SwimmerEntryCounts,
  settings: ScoringSettings,
  event: string
): boolean {
  const merged = mergeScoringSettings(settings);
  const indCap = merged.maxIndividualEntriesPerSwimmer ?? 999;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 999;
  const totalCap = merged.maxTotalEntriesPerSwimmer ?? 999;
  const total = (counts.total ?? counts.individual + counts.relayCount);

  // Check total cap first (if set, it takes precedence)
  if (totalCap < 999 && total >= totalCap) return false;

  const isRelay = /\brelay\b/i.test(event);
  if (isRelay) return counts.relayCount < relayCap;
  return counts.individual < indCap;
}
