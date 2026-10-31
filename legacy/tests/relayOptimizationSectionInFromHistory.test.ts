// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `RelayOptimizationSection`'s swap rows show the "From history" badge for a
 * `RelayLegSwap` flagged `inFromHistory` (relayLegHistoryCandidates, R1 e,
 * commit cc89035f) and no badge otherwise. Written without JSX, matching
 * `tests/teamRosterRowEventLabel.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RelayLegSwap, RelayLegSwapRanking } from '@omniswim/core/lib/crossCourseArbitrage';
import { RelayOptimizationSection } from '../packages/manager/src/components/crossCourseArbitrageRelaySection';
import type { RelaySwapGroup } from '../packages/manager/src/components/crossCourseArbitrageView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function swap(overrides: Partial<RelayLegSwap>): RelayLegSwap {
  return {
    relayEntryKey: 'HSU|200 Free Relay|1|Finals|',
    relayEvent: '200 Free Relay',
    relayRank: 1,
    legIndex: 0,
    stroke: 'free',
    legDistanceYards: 50,
    outAthlete: 'Scott Doll',
    outTime: '22.10',
    inAthlete: 'Colton Bennett',
    inTime: '22.93',
    deltaPoints: 3,
    newTotal: 10,
    baseTotal: 7,
    ...overrides,
  };
}

function ranking(swaps: RelayLegSwap[]): RelayLegSwapRanking {
  return { pointsMeaningful: true, swaps, candidatesEvaluated: swaps.length };
}

function groupsOf(swaps: RelayLegSwap[]): RelaySwapGroup[] {
  return swaps.map(best => ({ best, otherCandidates: 0 }));
}

describe('RelayOptimizationSection inFromHistory badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(swaps: RelayLegSwap[]) {
    const groups = groupsOf(swaps);
    await act(async () => {
      root.render(
        createElement(RelayOptimizationSection, {
          relayRanking: ranking(swaps),
          relaySwaps: groups,
          shownRelaySwaps: groups,
          relaySwapsExpanded: false,
          relaySwapsLimit: 10,
          onToggleExpanded: () => undefined,
          relayPromotions: [],
          lastApplied: null,
          onUndo: () => undefined,
          canApplySwaps: true,
          onApplyRelaySwap: () => undefined,
          onApplyRelayPromotion: () => undefined,
        })
      );
    });
  }

  it('shows "From history" for a swap flagged inFromHistory', async () => {
    await render([swap({ inFromHistory: true })]);
    expect(container.textContent).toContain('From history');
  });

  it('shows no history badge for an ordinary swap', async () => {
    await render([swap({})]);
    expect(container.textContent).not.toContain('From history');
  });
});
