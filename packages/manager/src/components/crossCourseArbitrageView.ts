/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for CrossCourseArbitragePanel — formatting and the
 * grouping the panel applies to the engine's output before rendering.
 *
 * Split out of the panel because none of this touches React, and the grouping
 * in particular carries real logic: the engine emits one row per candidate
 * pairing, and collapsing those into "one row per decision" is a rule worth
 * testing directly rather than through the DOM.
 */

import type {
  CrossCourseRow,
  ExactSwap,
  RelayLegSwap,
} from '@omniswim/core/lib/crossCourseArbitrage';

export function formatMargin(sec: number): string {
  return `+${sec.toFixed(2)}s`;
}

export function formatPoints(pts: number): string {
  const abs = Math.abs(pts).toFixed(1);
  return pts >= 0 ? `+${abs} pts` : `-${abs} pts`;
}

/** Rows where a converted LCM/SCM best beats the actual SCY best, fastest edge first. */
export function courseEdges(rows: CrossCourseRow[]): CrossCourseRow[] {
  return rows
    .filter(r => typeof r.convertedWinsBy === 'number' && r.convertedWinsBy > 0)
    .sort((a, b) => (b.convertedWinsBy ?? 0) - (a.convertedWinsBy ?? 0));
}

export type SwapGroup = { best: ExactSwap; otherDrops: number };

/**
 * The engine returns one row per (add, drop) pair; several drops often tie for the same
 * add. Group by athlete+addEvent keeping the best row (input is already sorted by delta
 * desc) so the list reads as "put X in event E" with alternates counted.
 */
export function groupSwaps(swaps: ExactSwap[]): SwapGroup[] {
  const groups = new Map<string, SwapGroup>();
  for (const swap of swaps) {
    const key = `${swap.athlete}|${swap.addEvent}`;
    const existing = groups.get(key);
    if (existing) existing.otherDrops += 1;
    else groups.set(key, { best: swap, otherDrops: 0 });
  }
  return [...groups.values()];
}

export type RelaySwapGroup = { best: RelayLegSwap; otherCandidates: number };

/**
 * The engine returns one row per (relay entry, leg, candidate) combination; a leg can
 * only take one substitution, so group by relayEntryKey+legIndex keeping the best
 * candidate (input is already sorted by delta desc) — same rationale as groupSwaps
 * above, just keyed on the leg instead of the athlete.
 */
export function groupRelaySwaps(swaps: RelayLegSwap[]): RelaySwapGroup[] {
  const groups = new Map<string, RelaySwapGroup>();
  for (const swap of swaps) {
    const key = `${swap.relayEntryKey}|${swap.legIndex}`;
    const existing = groups.get(key);
    if (existing) existing.otherCandidates += 1;
    else groups.set(key, { best: swap, otherCandidates: 0 });
  }
  return [...groups.values()];
}
