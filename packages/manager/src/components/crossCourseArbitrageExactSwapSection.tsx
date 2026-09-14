/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Lineup optimization" section of CrossCourseArbitragePanel — exact
 * 1-for-1 event swaps. Split out of the former crossCourseArbitrageSections.tsx
 * (see git history), which had grown to 848 lines across four unrelated
 * section families sharing one file; this is the exact-swap family on its
 * own. Pure extraction, no behavior change.
 */

import React from 'react';
import { Repeat2 } from 'lucide-react';
import {
  AthleteButton,
  DROP_SOURCE_LABEL,
  Section,
  ShowAllToggle,
  StalePill,
  UndoLastSwapButton,
  VerifyPill,
  type LastApplied,
} from './crossCourseArbitrageParts';
import { formatPoints, type SwapGroup } from './crossCourseArbitrageView';
import type { ExactSwap, SwapRanking } from '@omniswim/core/lib/crossCourseArbitrage';

/** One "add event / drop event" row inside LineupOptimizationSection's list. */
function SwapRow({
  group,
  canApplySwaps,
  onApplySwap,
  onJumpAthlete,
}: {
  group: SwapGroup;
  canApplySwaps: boolean;
  onApplySwap: (swap: ExactSwap) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  const { best: swap, otherDrops } = group;
  return (
    <li
      key={`${swap.athlete}|${swap.addEvent}`}
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <AthleteButton
          name={swap.athlete}
          onJumpAthlete={onJumpAthlete}
          className="text-ui-caption max-w-[8rem]"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
            {formatPoints(swap.deltaPoints)}
          </span>
          {canApplySwaps ? (
            <button
              type="button"
              onClick={() => onApplySwap(swap)}
              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
            >
              Apply
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
        +{swap.addEvent} ({swap.addTime}
        {swap.addTimeConverted ? 'c' : ''})
        {swap.addTimeStale ? (
          <>
            {' '}
            <StalePill />
          </>
        ) : null}
        {swap.confidence === 'verify' ? (
          <>
            {' '}
            <VerifyPill />
          </>
        ) : null}{' '}
        · −{swap.dropEvent}
        {swap.dropTime ? ` (${swap.dropTime})` : ''}
      </p>
      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
        drops a {DROP_SOURCE_LABEL[swap.dropSource]} entry
        {otherDrops > 0 ? ` · ${otherDrops} other drop option${otherDrops === 1 ? '' : 's'}` : ''}
      </p>
    </li>
  );
}

export function LineupOptimizationSection({
  swapRanking,
  swaps,
  shownSwaps,
  swapsExpanded,
  swapsLimit,
  onToggleExpanded,
  lastApplied,
  onUndo,
  canApplySwaps,
  onApplySwap,
  onJumpAthlete,
}: {
  swapRanking: SwapRanking;
  swaps: SwapGroup[];
  shownSwaps: SwapGroup[];
  swapsExpanded: boolean;
  swapsLimit: number;
  onToggleExpanded: () => void;
  lastApplied: LastApplied;
  onUndo: () => void;
  canApplySwaps: boolean;
  onApplySwap: (swap: ExactSwap) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Lineup optimization"
      icon={<Repeat2 size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={swapRanking.pointsMeaningful ? `(${swaps.length})` : undefined}
    >
      <UndoLastSwapButton lastApplied={lastApplied} onUndo={onUndo} />
      {!swapRanking.pointsMeaningful ? (
        <div>
          <p className="text-ui-caption text-theme-secondary leading-relaxed">
            {swapRanking.reason ?? 'Point deltas are not available for this team.'}
          </p>
          <p className="text-ui-micro text-theme-muted mt-1.5 leading-relaxed">
            Rankings activate once a meet PDF with a scoring field is loaded.
          </p>
        </div>
      ) : swaps.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          Lineup looks optimal — no event swap scores more points than the current entries.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownSwaps.map(group => (
              <SwapRow
                key={`${group.best.athlete}|${group.best.addEvent}`}
                group={group}
                canApplySwaps={canApplySwaps}
                onApplySwap={onApplySwap}
                onJumpAthlete={onJumpAthlete}
              />
            ))}
          </ul>
          <ShowAllToggle
            shown={swapsLimit}
            total={swaps.length}
            expanded={swapsExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5">
            {swapRanking.candidatesEvaluated} candidate swap
            {swapRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
          </p>
        </>
      )}
    </Section>
  );
}
