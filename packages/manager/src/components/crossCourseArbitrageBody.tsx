/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Top-level result body for CrossCourseArbitragePanel: picks between the loading
 * spinner, nothing (no result yet), and the six-section result view, then renders
 * all six sections. Split out of the panel so the loading/empty/populated switch
 * — and the long list of section props — don't add to the panel component's own
 * complexity count.
 */

import React from 'react';
import { LoadingSpinner } from '@omniswim/ui';
import type { Workspace } from '@omniswim/core/types';
import type {
  AddOnlyRow,
  CrossCourseArbitrageResult,
  DropOnlyRow,
  ExactSwap,
  RelayLegSwap,
} from '@omniswim/core/lib/crossCourseArbitrage';
import type { RelayAlternatePromotion } from '@omniswim/core/lib/scoringTheory';
import type { ArbitrageExpandedState, buildArbitrageViewModel } from './crossCourseArbitrageView';
import {
  ConvertedTimeUpgradesSection,
  CoverageGapsSection,
  DropFlagsSection,
  LineupOptimizationSection,
  OpenSlotAddsSection,
  RelayOptimizationSection,
} from './crossCourseArbitrageSections';

type ViewModel = ReturnType<typeof buildArbitrageViewModel>;

type ExpandedSetters = {
  setEdgesExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  setSwapsExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  setDropsExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  setAddsExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  setRelaySwapsExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
};

type ArbitrageHandlers = {
  onApplySwap: (swap: ExactSwap) => void;
  onApplyDrop: (drop: DropOnlyRow) => void;
  onApplyAdd: (add: AddOnlyRow) => void;
  onApplyRelaySwap: (swap: RelayLegSwap) => void;
  onApplyRelayPromotion: (promotion: RelayAlternatePromotion) => void;
  onUndo: () => void;
};

export function ArbitrageResultBody({
  result,
  viewModel,
  expanded,
  limits,
  setters,
  handlers,
  lastApplied,
  canApplySwaps,
  relayPromotions,
  onJumpAthlete,
}: {
  result: CrossCourseArbitrageResult | null;
  viewModel: ViewModel;
  expanded: ArbitrageExpandedState;
  limits: { edges: number; swaps: number; drops: number; adds: number; relaySwaps: number };
  setters: ExpandedSetters;
  handlers: ArbitrageHandlers;
  lastApplied: { inverse: Partial<Workspace>; description: string } | null;
  canApplySwaps: boolean;
  relayPromotions: RelayAlternatePromotion[];
  onJumpAthlete?: (name: string) => void;
}) {
  if (viewModel.showingInitialLoad) {
    return (
      <div className="min-h-[140px]">
        <LoadingSpinner label="Computing arbitrage…" />
      </div>
    );
  }
  if (!result) return null;

  return (
    <div>
      <LineupOptimizationSection
        swapRanking={result.swapRanking}
        swaps={viewModel.swaps}
        shownSwaps={viewModel.shownSwaps}
        swapsExpanded={expanded.swaps}
        swapsLimit={limits.swaps}
        onToggleExpanded={() => setters.setSwapsExpanded(v => !v)}
        lastApplied={lastApplied}
        onUndo={handlers.onUndo}
        canApplySwaps={canApplySwaps}
        onApplySwap={handlers.onApplySwap}
        onJumpAthlete={onJumpAthlete}
      />

      <DropFlagsSection
        dropRanking={viewModel.dropRanking}
        drops={viewModel.drops}
        shownDrops={viewModel.shownDrops}
        dropsExpanded={expanded.drops}
        dropsLimit={limits.drops}
        onToggleExpanded={() => setters.setDropsExpanded(v => !v)}
        lastApplied={lastApplied}
        onUndo={handlers.onUndo}
        canApplySwaps={canApplySwaps}
        onApplyDrop={handlers.onApplyDrop}
        onJumpAthlete={onJumpAthlete}
      />

      <OpenSlotAddsSection
        addRanking={viewModel.addRanking}
        adds={viewModel.adds}
        shownAdds={viewModel.shownAdds}
        addsExpanded={expanded.adds}
        addsLimit={limits.adds}
        onToggleExpanded={() => setters.setAddsExpanded(v => !v)}
        lastApplied={lastApplied}
        onUndo={handlers.onUndo}
        canApplySwaps={canApplySwaps}
        onApplyAdd={handlers.onApplyAdd}
        onJumpAthlete={onJumpAthlete}
      />

      <RelayOptimizationSection
        relayRanking={viewModel.effectiveRelayRanking}
        relaySwaps={viewModel.relaySwaps}
        shownRelaySwaps={viewModel.shownRelaySwaps}
        relaySwapsExpanded={expanded.relaySwaps}
        relaySwapsLimit={limits.relaySwaps}
        onToggleExpanded={() => setters.setRelaySwapsExpanded(v => !v)}
        relayPromotions={relayPromotions}
        lastApplied={lastApplied}
        onUndo={handlers.onUndo}
        canApplySwaps={canApplySwaps}
        onApplyRelaySwap={handlers.onApplyRelaySwap}
        onApplyRelayPromotion={handlers.onApplyRelayPromotion}
        onJumpAthlete={onJumpAthlete}
      />

      <ConvertedTimeUpgradesSection
        edges={viewModel.edges}
        shownEdges={viewModel.shownEdges}
        edgesExpanded={expanded.edges}
        edgesLimit={limits.edges}
        onToggleExpanded={() => setters.setEdgesExpanded(v => !v)}
        onJumpAthlete={onJumpAthlete}
      />

      <CoverageGapsSection gaps={viewModel.gaps} />
    </div>
  );
}
