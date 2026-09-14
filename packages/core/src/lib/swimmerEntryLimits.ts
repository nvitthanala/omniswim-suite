/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 0: per-swimmer entry limit counting.
 *
 * Test: npx tsx scripts/test_entry_limits.mjs
 *       npx tsx scripts/test_entry_limits_aliases.mjs
 *       npx tsx scripts/test_entry_limits_prelims_finals.mjs
 *
 * WHAT AN ENTRY IS. One per distinct EVENT, per athlete — never one per swim.
 * Prelims and the final of one event are two swims of one entry; see
 * {@link entryCapKey}, which is the single place that rule is written down.
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
import { IDENTITY_ALIAS_RESOLVER, type AthleteAliasResolver } from './athleteAliases';

export type SwimmerEntryCounts = {
  individual: number;
  /**
   * The distinct relay EVENTS this athlete occupies — one member per relay entry
   * charged against the cap. Before 2026-09-02 these were `relayEntryKey` strings,
   * which embed the round; see {@link entryCapKey}.
   */
  relayEvents: Set<string>;
  relayCount: number;
  total?: number; // individual + relayCount
};

/**
 * Fallback key prefix for a row that carries no event name.
 *
 * It opens with a single leading SPACE, and that one character is load-bearing:
 * it makes the fallback distinct from every real key by CONSTRUCTION rather than
 * by luck. A real key is `event.trim()`, so it can never begin with whitespace,
 * whatever a meet chooses to call an event. Do not "tidy" the leading blank away
 * — `test_entry_limits_prelims_finals.mjs` block 6 fails if two unlabeled rows
 * can collide, but nothing catches a collision with a real event name.
 */
const UNLABELED_ENTRY_PREFIX = ' unlabeled|';

/**
 * The key one result row occupies against a per-swimmer entry cap.
 *
 * ONE ENTRY PER DISTINCT EVENT, REGARDLESS OF ROUND. A swimmer who swims prelims
 * and then swims the final of that same event used ONE meet entry: the entry is
 * the event, and prelims/finals are how that one entry is contested. The same
 * holds in the other direction — a prelims-only swim (missed the final) and a
 * timed-final-only swim are each one entry too. So the key must be the event and
 * nothing else; anything round-shaped in it splits one entry in two.
 *
 * WHY THIS FUNCTION EXISTS. The relay side used to key on `relayEntryKey`, which
 * is `team|event|roundSwam|rank|clock`. That key is right for what it was built
 * for — naming one physical relay SWIM so a leg override lands on the correct
 * heat — and wrong as a cap key, because a squad that swims a relay in prelims
 * and again in the final produces two rows whose round, rank and clock all
 * differ. Every leg swimmer was then charged two entries for one relay, and under
 * the NSISC cap of 7 that reads as an over-entered swimmer who is not. The
 * individual side already keyed on the event alone and was already correct.
 *
 * UNLABELED ROWS ARE COUNTED, NEVER DROPPED. A row with no event name is a data
 * defect. Skipping it would remove an entry from a competition-rule count with no
 * trace, which is the silent-empty failure this module exists to prevent, so it
 * falls back to the row id: it still costs one entry and can never merge with
 * another. An over-count is visible to the coach; an under-count is not.
 */
export function entryCapKey(r: Pick<SwimmerResult, 'id' | 'event'>): string {
  const ev = r.event?.trim();
  if (ev) return ev;
  return `${UNLABELED_ENTRY_PREFIX}${r.id}`;
}

/**
 * Count one athlete's distinct meet entries (individual events + relay entries).
 *
 * With a resolver, BOTH the queried `name` and each scanned row's name are
 * resolved before keying, so either spelling of a linked athlete returns the same
 * merged count. Individual and relay entries are both keyed by {@link entryCapKey}
 * — the event — so two spellings that appear as legs of the SAME relay entry still
 * count once, which is correct: one human occupies one relay slot however the leg
 * was spelled. That same key is what collapses a prelims row and a finals row for
 * one event into the single entry they are.
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
      relayEvents.add(entryCapKey(r));
      continue;
    }
    if (!r.isRelay) {
      const key = entryCapKey(r);
      if (!indEvents.has(key)) {
        indEvents.add(key);
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
