/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-course arbitrage engine. Extends the roster-arbitrage module family
 * (see rosterArbitrage.ts) with four read-only analyses over a workspace. This
 * file is the PUBLIC BARREL: every consumer imports from here, and the
 * implementation lives in lib/arbitrage/ split by concern.
 *
 *   1. buildCrossCourseTable — per swimmer x program event, actual SCY best vs
 *      best converted LCM/SCM (via convertSwimToSCY, which also remaps distance
 *      identity 400->500, 800->1000, 1500->1650), flagging rows where the
 *      converted time beats the actual SCY time.        [arbitrage/crossCourseTable]
 *   2. buildCoverageGaps — per program event, how thinly the team fields entries
 *      relative to the scoring depth / field size (uncontested-point spots).
 *                                                       [arbitrage/crossCourseTable]
 *   3. rankExactSwaps — exact team-points delta of swapping each candidate
 *      add-event in for each of an athlete's CURRENT individual entries —
 *      whether they come from an active plan, a loaded meet result row, or a
 *      recruit row — by fully re-scoring (same buildWhatIfResults +
 *      calculatePoints pattern as teamTotal in rosterArbitrage.ts). Skipped when
 *      the workspace has no meaningful scoring field (fewer than two distinct
 *      teams with individual results).                       [arbitrage/exactSwaps]
 *   4. rankDropOnly / rankAddOnly — the two degenerate cases (drop one entry
 *      alone, add one entry alone) under the cap-void model.   [arbitrage/dropAdd]
 *
 * rankRelayLegSwaps (arbitrage/relayLegSwaps) covers relay-leg substitutions,
 * and arbitrage/shared holds the machinery two or more of them use — the
 * history→SCY projection prefix, the recency window, the droppable-entry union
 * and the incremental fast-rescore context.
 *
 * computeCrossCourseArbitrage bundles the first four into one pure function so
 * the UI can run the whole computation off the main thread (see the
 * crossCourseArbitrage worker op in workers/scoringWorker.ts and the client in
 * lib/crossCourseArbitrageClient.ts).
 *
 * Test: npx tsx scripts/test_cross_course_arbitrage.mjs
 */

import { Gender, ScoringSettings, Workspace } from '../types';
import { buildCoverageGaps, buildCrossCourseTable, type CoverageGap } from './arbitrage/crossCourseTable';
import { rankExactSwaps, type SwapRanking } from './arbitrage/exactSwaps';
import {
  rankAddOnly,
  rankDropOnly,
  type AddOnlyRanking,
  type DropOnlyRanking,
} from './arbitrage/dropAdd';
import type { CrossCourseTable } from './arbitrage/shared';

/**
 * Canonical SCY program-event mapping now lives in eventIdentity.ts (neutral
 * module) so the scoring path can use it without importing this file. Re-exported
 * here for backward compatibility with existing imports.
 */
export { canonicalProgramEvent } from './eventIdentity';

// --- shared vocabulary (arbitrage/shared) -----------------------------------

export { CONVERSION_VERIFY_MARGIN, DEFAULT_RECENCY_MONTHS } from './arbitrage/shared';
export type {
  CrossCourseConvertedRef,
  CrossCourseRow,
  CrossCourseTable,
  CrossCourseTimeRef,
  EntryConfidence,
} from './arbitrage/shared';

// --- cross-course best-time table + coverage gaps ---------------------------

export { buildCoverageGaps, buildCrossCourseTable } from './arbitrage/crossCourseTable';
export type { CoverageGap } from './arbitrage/crossCourseTable';

// --- exact points-delta swap ranking ----------------------------------------

export { applyExactSwap, rankExactSwaps } from './arbitrage/exactSwaps';
export type { ExactSwap, SwapRanking } from './arbitrage/exactSwaps';

// --- drop-only / add-only analysis ------------------------------------------

export { applyEntryAdd, applyEntryDrop, rankAddOnly, rankDropOnly } from './arbitrage/dropAdd';
export type {
  AddOnlyOptions,
  AddOnlyRanking,
  AddOnlyRow,
  DropOnlyOptions,
  DropOnlyRanking,
  DropOnlyRow,
} from './arbitrage/dropAdd';

// --- relay-leg swap enumeration ---------------------------------------------

export { applyRelayLegSwap, rankRelayLegSwaps } from './arbitrage/relayLegSwaps';
export type {
  RelayLegSwap,
  RelayLegSwapOptions,
  RelayLegSwapRanking,
} from './arbitrage/relayLegSwaps';

// --- combined off-thread entry point ----------------------------------------

export type CrossCourseArbitrageOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  /**
   * Candidate/table bests prefer times dated within this many months of the
   * newest dated swim in the workspace history. Undated rows always count as
   * recent. An event with only older times keeps its best, flagged `stale`.
   * Default 24.
   */
  recencyMonths?: number;
};

export type CrossCourseArbitrageResult = {
  table: CrossCourseTable;
  gaps: CoverageGap[];
  swapRanking: SwapRanking;
  /** Drop-only analysis (over-entry / cap flags). Additive (2026-07 round). */
  dropRanking: DropOnlyRanking;
  /** Add-only analysis (open-slot gains for under-cap swimmers). Additive (2026-07 round). */
  addRanking: AddOnlyRanking;
};

/**
 * Single pure function returning all three analyses. Runs the cross-course table
 * and coverage gaps always; runs the expensive exact-swap enumeration only when
 * the scoring field is meaningful. Designed to run inside a Web Worker.
 */
export function computeCrossCourseArbitrage(
  workspace: Workspace,
  opts: CrossCourseArbitrageOptions
): CrossCourseArbitrageResult {
  const table = buildCrossCourseTable(workspace, {
    team: opts.team,
    gender: opts.gender,
    recencyMonths: opts.recencyMonths,
  });
  const gaps = buildCoverageGaps(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
  });
  const swapRanking = rankExactSwaps(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
    table,
    recencyMonths: opts.recencyMonths,
  });
  const dropRanking = rankDropOnly(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
  });
  const addRanking = rankAddOnly(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
    table,
    recencyMonths: opts.recencyMonths,
  });
  return { table, gaps, swapRanking, dropRanking, addRanking };
}
