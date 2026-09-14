/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Relay optimization" section of CrossCourseArbitragePanel — relay
 * leg swaps plus alternate-promotion suggestions. Split out of the former
 * crossCourseArbitrageSections.tsx (see git history); this is the relay
 * family on its own. Pure extraction, no behavior change.
 */

import React from 'react';
import { Repeat } from 'lucide-react';
import {
  AthleteButton,
  Section,
  ShowAllToggle,
  StalePill,
  UndoLastSwapButton,
  type LastApplied,
} from './crossCourseArbitrageParts';
import { formatPoints, type RelaySwapGroup } from './crossCourseArbitrageView';
import type { RelayLegSwap, RelayLegSwapRanking } from '@omniswim/core/lib/crossCourseArbitrage';
import type { RelayAlternatePromotion } from '@omniswim/core/lib/scoringTheory';
import { relayStrokeForIndex } from '@omniswim/core/lib/relayLegMatching';

const RELAY_ALTERNATE_REASON_LABEL: Record<RelayAlternatePromotion['reason'], string> = {
  soft_removed: 'soft-removed',
  over_entry_cap: 'over entry cap',
  missing_from_roster: 'off roster',
};

/** One relay leg-swap row inside RelayOptimizationSection's list. */
function RelaySwapRow({
  group,
  canApplySwaps,
  onApplyRelaySwap,
  onJumpAthlete,
}: {
  group: RelaySwapGroup;
  canApplySwaps: boolean;
  onApplyRelaySwap: (swap: RelayLegSwap) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  const { best: swap, otherCandidates } = group;
  const hasOutAthlete = !!swap.outAthlete && swap.outAthlete !== '—';
  return (
    <li
      key={`${swap.relayEntryKey}|${swap.legIndex}`}
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-baseline gap-1.5">
          <span
            className="text-ui-caption font-semibold text-[var(--text-primary)] truncate"
            title={swap.relayEvent}
          >
            {swap.relayEvent}
          </span>
          <span className="text-ui-micro text-theme-muted shrink-0 whitespace-nowrap">
            leg {swap.legIndex + 1} · {swap.stroke} {swap.legDistanceYards}y
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
            {formatPoints(swap.deltaPoints)}
          </span>
          {canApplySwaps ? (
            <button
              type="button"
              onClick={() => onApplyRelaySwap(swap)}
              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
            >
              Apply
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 flex flex-wrap items-center gap-1">
        {hasOutAthlete ? (
          <AthleteButton
            name={swap.outAthlete}
            onJumpAthlete={onJumpAthlete}
            className="text-ui-micro max-w-[6rem]"
          />
        ) : (
          <span className="text-theme-muted">vacant</span>
        )}
        {swap.outTime ? <span>({swap.outTime})</span> : null}
        <span aria-hidden="true" className="text-theme-muted">
          →
        </span>
        <AthleteButton
          name={swap.inAthlete}
          onJumpAthlete={onJumpAthlete}
          className="text-ui-micro max-w-[6rem]"
        />
        <span>
          ({swap.inTime}
          {swap.inTimeConverted ? 'c' : ''})
        </span>
        {swap.inTimeStale ? <StalePill /> : null}
      </p>
      {otherCandidates > 0 ? (
        <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
          {otherCandidates} other candidate{otherCandidates === 1 ? '' : 's'} evaluated for this
          leg
        </p>
      ) : null}
    </li>
  );
}

/** One "promote alternate for primary" row inside RelayOptimizationSection. */
function RelayPromotionRow({
  promotion,
  canApplySwaps,
  onApplyRelayPromotion,
}: {
  promotion: RelayAlternatePromotion;
  canApplySwaps: boolean;
  onApplyRelayPromotion: (promotion: RelayAlternatePromotion) => void;
}) {
  const stroke = relayStrokeForIndex(promotion.relayEvent.toLowerCase(), promotion.legIndex);
  return (
    <li
      key={`${promotion.relayEntryKey}|${promotion.legIndex}`}
      className="flex items-center justify-between gap-2 rounded-lg border border-theme-soft surface-muted-bg px-3 py-2"
    >
      <span className="text-ui-caption text-theme-secondary truncate" title={promotion.description}>
        Leg {promotion.legIndex + 1} ({stroke}): promote{' '}
        <span className="text-[var(--text-primary)] font-semibold">{promotion.alternate}</span> for{' '}
        {promotion.primary} — {RELAY_ALTERNATE_REASON_LABEL[promotion.reason]}
      </span>
      {canApplySwaps ? (
        <button
          type="button"
          onClick={() => onApplyRelayPromotion(promotion)}
          className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold shrink-0"
        >
          Apply
        </button>
      ) : null}
    </li>
  );
}

/** Relay leg-swap list + "show all" + evaluated-count footer, or nothing if empty. */
function RelaySwapList({
  relayRanking,
  relaySwaps,
  shownRelaySwaps,
  relaySwapsExpanded,
  relaySwapsLimit,
  onToggleExpanded,
  canApplySwaps,
  onApplyRelaySwap,
  onJumpAthlete,
}: {
  relayRanking: RelayLegSwapRanking;
  relaySwaps: RelaySwapGroup[];
  shownRelaySwaps: RelaySwapGroup[];
  relaySwapsExpanded: boolean;
  relaySwapsLimit: number;
  onToggleExpanded: () => void;
  canApplySwaps: boolean;
  onApplyRelaySwap: (swap: RelayLegSwap) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  if (relaySwaps.length === 0) return null;
  return (
    <>
      <ul className="space-y-2">
        {shownRelaySwaps.map(group => (
          <RelaySwapRow
            key={`${group.best.relayEntryKey}|${group.best.legIndex}`}
            group={group}
            canApplySwaps={canApplySwaps}
            onApplyRelaySwap={onApplyRelaySwap}
            onJumpAthlete={onJumpAthlete}
          />
        ))}
      </ul>
      <ShowAllToggle
        shown={relaySwapsLimit}
        total={relaySwaps.length}
        expanded={relaySwapsExpanded}
        onToggle={onToggleExpanded}
      />
      <p className="text-ui-micro text-theme-muted mt-2.5">
        {relayRanking.candidatesEvaluated} candidate relay swap
        {relayRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
      </p>
    </>
  );
}

/** "Alternate promotions" sub-list, or nothing if there are none. */
function RelayPromotionList({
  relayPromotions,
  hasRelaySwapsAbove,
  canApplySwaps,
  onApplyRelayPromotion,
}: {
  relayPromotions: RelayAlternatePromotion[];
  hasRelaySwapsAbove: boolean;
  canApplySwaps: boolean;
  onApplyRelayPromotion: (promotion: RelayAlternatePromotion) => void;
}) {
  if (relayPromotions.length === 0) return null;
  return (
    <div className={hasRelaySwapsAbove ? 'mt-3' : ''}>
      <p className="text-ui-micro font-semibold uppercase tracking-wide text-theme-muted mb-1.5">
        Alternate promotions
      </p>
      <ul className="space-y-1.5">
        {relayPromotions.map(promotion => (
          <RelayPromotionRow
            key={`${promotion.relayEntryKey}|${promotion.legIndex}`}
            promotion={promotion}
            canApplySwaps={canApplySwaps}
            onApplyRelayPromotion={onApplyRelayPromotion}
          />
        ))}
      </ul>
    </div>
  );
}

export function RelayOptimizationSection({
  relayRanking,
  relaySwaps,
  shownRelaySwaps,
  relaySwapsExpanded,
  relaySwapsLimit,
  onToggleExpanded,
  relayPromotions,
  lastApplied,
  onUndo,
  canApplySwaps,
  onApplyRelaySwap,
  onApplyRelayPromotion,
  onJumpAthlete,
}: {
  relayRanking: RelayLegSwapRanking;
  relaySwaps: RelaySwapGroup[];
  shownRelaySwaps: RelaySwapGroup[];
  relaySwapsExpanded: boolean;
  relaySwapsLimit: number;
  onToggleExpanded: () => void;
  relayPromotions: RelayAlternatePromotion[];
  lastApplied: LastApplied;
  onUndo: () => void;
  canApplySwaps: boolean;
  onApplyRelaySwap: (swap: RelayLegSwap) => void;
  onApplyRelayPromotion: (promotion: RelayAlternatePromotion) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Relay optimization"
      icon={<Repeat size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={relayRanking.pointsMeaningful ? `(${relaySwaps.length})` : undefined}
    >
      <UndoLastSwapButton lastApplied={lastApplied} onUndo={onUndo} />
      {!relayRanking.pointsMeaningful ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {relayRanking.reason ?? 'Relay point deltas are not available for this team.'}
        </p>
      ) : relaySwaps.length === 0 && relayPromotions.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No beneficial relay substitutions — all relay legs are already scoring-eligible under
          current rules.
        </p>
      ) : (
        <>
          <RelaySwapList
            relayRanking={relayRanking}
            relaySwaps={relaySwaps}
            shownRelaySwaps={shownRelaySwaps}
            relaySwapsExpanded={relaySwapsExpanded}
            relaySwapsLimit={relaySwapsLimit}
            onToggleExpanded={onToggleExpanded}
            canApplySwaps={canApplySwaps}
            onApplyRelaySwap={onApplyRelaySwap}
            onJumpAthlete={onJumpAthlete}
          />
          <RelayPromotionList
            relayPromotions={relayPromotions}
            hasRelaySwapsAbove={relaySwaps.length > 0}
            canApplySwaps={canApplySwaps}
            onApplyRelayPromotion={onApplyRelayPromotion}
          />
        </>
      )}
    </Section>
  );
}
