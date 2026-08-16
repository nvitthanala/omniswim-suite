/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 0: per-swimmer entry limit counting.
 *
 * Test: npx tsx scripts/test_entry_limits.mjs
 *       npx tsx scripts/test_entry_limits_aliases.mjs
 *
 * ALIAS RESOLUTION. `countSwimmerEntries` takes a trailing
 * `resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER`, the same convention
 * `buildScorerRosterLookup` (scorerRoster.ts) and `categorizeBestEvents`
 * (athleteHistory.ts) use. Pass `buildAliasResolver(workspace)` and two spellings
 * the user linked count as ONE athlete against ONE cap; omit it and behaviour is
 * byte-identical to an unaliased workspace.
 *
 * WHY THIS IS NOT COSMETIC. An entry cap is a competition rule (NSISC:
 * `maxTotalEntriesPerSwimmer: 7`); an over-entered swimmer's swims can be voided.
 * Counting "Olivér Pózvai" (3) and "Oliver Pozvai" (7) as two athletes reports
 * both compliant while the human is at 10 — the violation is invisible.
 *
 * AND IT MUST SHIP WITH THE ROSTER CHANGE. `TeamRosterPanel` and
 * `rosterLineupAudit` pass `row.name` from `buildScorerRosterLookup`. Once that
 * lookup is given a resolver, `row.name` is the CANONICAL spelling — so an
 * unresolved count here would scan only the canonical half (7 of 10) and still
 * report compliant. Making the roster alias-aware without this change does not
 * fix the cap bug; it relabels which half is counted and hides the violation more
 * thoroughly. Both sides of every name comparison below are resolved for exactly
 * this reason — a half-resolved comparison is worse than none.
 *
 * `swimmerExceedsEntryLimits`, `formatEntryLimitLabel` and `canAcceptAnotherEntry`
 * take a pre-computed `SwimmerEntryCounts` and never touch a name, so they need
 * no resolver: they inherit merged identity from whatever produced the counts.
 */

import { Gender, ScoringSettings, SwimmerResult } from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import { isRelayResult, normalizeSwimmerName } from './utils';
import { relayEntryKey } from './relaySplits';
import { relayTemplateFromLeg } from './relayLegMatching';
import { IDENTITY_ALIAS_RESOLVER, type AthleteAliasResolver } from './athleteAliases';

export type SwimmerEntryCounts = {
  individual: number;
  relayEvents: Set<string>;
  relayCount: number;
  total?: number; // individual + relayCount
};

/**
 * Count one athlete's distinct meet entries (individual events + relay entries).
 *
 * With a resolver, BOTH the queried `name` and each scanned row's name are
 * resolved before keying, so either spelling of a linked athlete returns the same
 * merged count. Relay entries are keyed by `relayEntryKey`, so two spellings that
 * appear as legs of the SAME relay entry still count once — which is correct: one
 * human occupies one relay slot however the leg was spelled.
 *
 * The key function stays `normalizeSwimmerName` (not `canonicalSwimmerName` and
 * not `aliasNameKey`) so the identity default is unchanged: nothing folds comma
 * order or diacritics unless a recorded link says so.
 */
export function countSwimmerEntries(
  results: SwimmerResult[],
  team: string,
  gender: Gender,
  name: string,
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER
): SwimmerEntryCounts {
  const nameKey = normalizeSwimmerName(resolver.resolveAthleteName(name, team, gender));
  const relayEvents = new Set<string>();
  let individual = 0;
  const indEvents = new Set<string>();

  for (const r of results) {
    if (r.gender != null && r.gender !== gender) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    // Resolve the ROW's name too. Rows reaching here already passed the team and
    // gender filters, so `team`/`gender` are the correct resolution scope.
    if (normalizeSwimmerName(resolver.resolveAthleteName(r.name, team, gender)) !== nameKey) continue;

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
