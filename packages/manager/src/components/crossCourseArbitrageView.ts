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
  AddOnlyRanking,
  AddOnlyRow,
  CoverageGap,
  CrossCourseArbitrageResult,
  CrossCourseRow,
  DropOnlyRanking,
  DropOnlyRow,
  ExactSwap,
  RelayLegSwap,
  RelayLegSwapRanking,
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

/** `expanded ? list : list.slice(0, limit)` — the "show all" truncation every section applies. */
export function paginate<T>(list: T[], expanded: boolean, limit: number): T[] {
  return expanded ? list : list.slice(0, limit);
}

export type ArbitrageExpandedState = {
  edges: boolean;
  swaps: boolean;
  drops: boolean;
  adds: boolean;
  relaySwaps: boolean;
};

export type ArbitrageLimits = {
  edges: number;
  swaps: number;
  gaps: number;
  drops: number;
  adds: number;
  relaySwaps: number;
};

type ResultDerivedFields = {
  edges: CrossCourseRow[];
  swaps: SwapGroup[];
  gaps: CoverageGap[];
  dropRanking: DropOnlyRanking | undefined;
  drops: DropOnlyRow[];
  addRanking: AddOnlyRanking | undefined;
  adds: AddOnlyRow[];
};

/**
 * Everything that comes straight off the engine result, or the all-empty shape
 * when there's no result yet. A guard clause instead of five parallel `result ? … : []`
 * ternaries — same values, one branch point instead of five.
 */
function deriveResultFields(
  result: CrossCourseArbitrageResult | null,
  gapsLimit: number
): ResultDerivedFields {
  if (!result) {
    return { edges: [], swaps: [], gaps: [], dropRanking: undefined, drops: [], addRanking: undefined, adds: [] };
  }
  return {
    edges: courseEdges(result.table.rows),
    swaps: groupSwaps(result.swapRanking.swaps),
    gaps: result.gaps.slice(0, gapsLimit),
    dropRanking: result.dropRanking,
    drops: result.dropRanking?.drops ?? [],
    addRanking: result.addRanking,
    adds: result.addRanking?.adds ?? [],
  };
}

/**
 * Derives every list the panel renders (full + "shown" slice) from the raw engine
 * result plus the panel's expand/collapse and pagination-limit state. Pulled out
 * of the component so its `? :` / `??` branches live in a plain function
 * lizard/eslint can score on their own, not folded into the component's
 * render-function complexity.
 */
export function buildArbitrageViewModel(
  result: CrossCourseArbitrageResult | null,
  relayRanking: RelayLegSwapRanking | null,
  loading: boolean,
  expanded: ArbitrageExpandedState,
  limits: ArbitrageLimits
) {
  const { edges, swaps, gaps, dropRanking, drops, addRanking, adds } = deriveResultFields(
    result,
    limits.gaps
  );
  const effectiveRelayRanking: RelayLegSwapRanking = relayRanking ?? {
    pointsMeaningful: false,
    swaps: [],
    candidatesEvaluated: 0,
  };
  const relaySwaps = groupRelaySwaps(effectiveRelayRanking.swaps);

  return {
    edges,
    shownEdges: paginate(edges, expanded.edges, limits.edges),
    swaps,
    shownSwaps: paginate(swaps, expanded.swaps, limits.swaps),
    gaps,
    dropRanking,
    drops,
    shownDrops: paginate(drops, expanded.drops, limits.drops),
    addRanking,
    adds,
    shownAdds: paginate(adds, expanded.adds, limits.adds),
    effectiveRelayRanking,
    relaySwaps,
    shownRelaySwaps: paginate(relaySwaps, expanded.relaySwaps, limits.relaySwaps),
    showingInitialLoad: loading && !result,
  };
}
