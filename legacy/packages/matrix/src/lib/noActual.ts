/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C7-UI: which projection entries have no actual result yet.
 *
 * Core carries "no actual" as `actual: null`, `overUnder: null` and
 * `hasActual: false` (see `PrelimsOverUnderEntry`). These helpers only read
 * that flag so a screen can draw a visible marker instead of a 0 or a blank.
 * They compute no points.
 */
import type { SwimmerResult } from '@omniswim/core/types';
import {
  entryKey,
  prelimsOuForResult,
  prelimsOuOverUnderForDisplay,
  type PrelimsOverUnderEntry,
} from '@omniswim/core/lib/prelimsProjection';
import { isRelayResult } from '@omniswim/core/lib/utils';

type OuLookup = Map<string, PrelimsOverUnderEntry>;

/** The accessible and visible words for a missing actual. */
export const NO_ACTUAL_LABEL = 'No result yet';

/**
 * True when this row's entry has an expected value but no actual, and the row
 * itself shows no credited points that would stand in for one. A relay leg is
 * never marked: the relay's team row carries the entry.
 */
export function rowHasNoActual(r: SwimmerResult, lookup: OuLookup): boolean {
  const entry = prelimsOuForResult(r, lookup);
  if (!entry || entry.hasActual) return false;
  return prelimsOuOverUnderForDisplay(r, lookup) === undefined;
}

/**
 * How many distinct entries in a group of rows have no actual. One entry key is
 * counted once, so a prelims row and a finals row of one swim count once.
 * Mirrors the rows `sumPrelimsOuForSwimmers` sums, so the count and the sum
 * describe the same set.
 */
export function countGroupEntriesWithoutActual(
  swimmers: readonly SwimmerResult[],
  lookup: OuLookup,
  options?: { includeRelay?: boolean }
): number {
  const includeRelay = options?.includeRelay ?? true;
  const seen = new Set<string>();
  let missing = 0;
  for (const res of swimmers) {
    if (isRelayResult(res) && !includeRelay) continue;
    const entry = prelimsOuForResult(res, lookup);
    if (!entry) continue;
    const key = entryKey(res);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!entry.hasActual) missing += 1;
  }
  return missing;
}

/**
 * The events (raw event names) where `teamName` has an entry with no actual.
 * Lookup keys read `event|team|swimmer`, the same split
 * `buildMomentumSeriesForTeam` uses.
 */
export function eventsWithoutActual(lookup: OuLookup | undefined, teamName: string): Set<string> {
  const out = new Set<string>();
  if (!lookup) return out;
  const team = teamName.trim();
  for (const [key, entry] of lookup) {
    if (entry.hasActual) continue;
    const parts = key.split('|');
    if ((parts[1] ?? '').trim() !== team) continue;
    if (parts[0]) out.add(parts[0]);
  }
  return out;
}

/** "3 entries have no result yet" / "1 entry has no result yet". */
export function noActualCountSentence(count: number): string {
  return count === 1 ? `1 entry has no result yet` : `${count} entries have no result yet`;
}
