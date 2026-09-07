/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Section-level sub-components for CrossCourseArbitragePanel. Each function here
 * renders one collapsible `Section` (see crossCourseArbitrageParts) plus its list
 * body. Split out of the panel so each section's branching (empty state / not-
 * meaningful state / populated list) lives in its own named function instead of
 * one 527-line render tree — pure extraction, no behavior change.
 */

import React from 'react';
import { AlertTriangle, Gauge, Plus, Repeat, Repeat2, Undo2, Users } from 'lucide-react';
import {
  AthleteButton,
  Section,
  ShowAllToggle,
  StalePill,
  VerifyPill,
} from './crossCourseArbitrageParts';
import { formatMargin, formatPoints, type RelaySwapGroup, type SwapGroup } from './crossCourseArbitrageView';
import {
  type AddOnlyRow,
  type AddOnlyRanking,
  type CoverageGap,
  type CrossCourseRow,
  type DropOnlyRow,
  type DropOnlyRanking,
  type ExactSwap,
  type RelayLegSwap,
  type RelayLegSwapRanking,
  type SwapRanking,
} from '@omniswim/core/lib/crossCourseArbitrage';
import type { RelayAlternatePromotion } from '@omniswim/core/lib/scoringTheory';
import { relayStrokeForIndex } from '@omniswim/core/lib/relayLegMatching';

const DROP_SOURCE_LABEL: Record<ExactSwap['dropSource'], string> = {
  plan: 'planned',
  result: 'meet entry',
  recruit: 'recruit',
};

const RELAY_ALTERNATE_REASON_LABEL: Record<RelayAlternatePromotion['reason'], string> = {
  soft_removed: 'soft-removed',
  over_entry_cap: 'over entry cap',
  missing_from_roster: 'off roster',
};

type LastApplied = { inverse: unknown; description: string } | null;

/** Repeated "Undo: <description>" affordance shown at the top of every applyable section. */
function UndoLastSwapButton({
  lastApplied,
  onUndo,
}: {
  lastApplied: LastApplied;
  onUndo: () => void;
}) {
  if (!lastApplied) return null;
  return (
    <button
      type="button"
      onClick={onUndo}
      title={lastApplied.description}
      className="mb-3 flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft surface-muted-bg px-3 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
    >
      <Undo2 size={12} className="shrink-0" />
      <span className="truncate">Undo: {lastApplied.description}</span>
    </button>
  );
}

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

/** One over-entry/cap-blocked drop row inside DropFlagsSection's list. */
function DropRow({
  drop,
  canApplySwaps,
  onApplyDrop,
  onJumpAthlete,
}: {
  drop: DropOnlyRow;
  canApplySwaps: boolean;
  onApplyDrop: (drop: DropOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <li
      key={`${drop.dropSource}|${drop.dropEntryId}`}
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <AthleteButton
          name={drop.athlete}
          onJumpAthlete={onJumpAthlete}
          className="text-ui-caption max-w-[8rem]"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
            {formatPoints(drop.deltaPoints)}
          </span>
          {canApplySwaps ? (
            <button
              type="button"
              onClick={() => onApplyDrop(drop)}
              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
            >
              Apply
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
        −{drop.dropEvent}
        {drop.dropTime ? ` (${drop.dropTime})` : ''} · {DROP_SOURCE_LABEL[drop.dropSource]} entry
      </p>
      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
        {drop.capRelief
          ? `over entry cap — dropping restores ${(drop.voidedPointsRestored ?? 0).toFixed(1)} voided pts`
          : 'frees a team scoring slot for higher-value entries'}
      </p>
    </li>
  );
}

export function DropFlagsSection({
  dropRanking,
  drops,
  shownDrops,
  dropsExpanded,
  dropsLimit,
  onToggleExpanded,
  lastApplied,
  onUndo,
  canApplySwaps,
  onApplyDrop,
  onJumpAthlete,
}: {
  dropRanking: DropOnlyRanking | undefined;
  drops: DropOnlyRow[];
  shownDrops: DropOnlyRow[];
  dropsExpanded: boolean;
  dropsLimit: number;
  onToggleExpanded: () => void;
  lastApplied: LastApplied;
  onUndo: () => void;
  canApplySwaps: boolean;
  onApplyDrop: (drop: DropOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Drop flags"
      icon={<AlertTriangle size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={dropRanking?.pointsMeaningful ? `(${drops.length})` : undefined}
    >
      <UndoLastSwapButton lastApplied={lastApplied} onUndo={onUndo} />
      {!dropRanking || !dropRanking.pointsMeaningful ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {dropRanking?.reason ?? 'Drop deltas are not available for this team.'}
        </p>
      ) : drops.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No entry would score more by being dropped — no over-entered swimmers or cap-blocked
          points detected for this team.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownDrops.map(drop => (
              <DropRow
                key={`${drop.dropSource}|${drop.dropEntryId}`}
                drop={drop}
                canApplySwaps={canApplySwaps}
                onApplyDrop={onApplyDrop}
                onJumpAthlete={onJumpAthlete}
              />
            ))}
          </ul>
          <ShowAllToggle
            shown={dropsLimit}
            total={drops.length}
            expanded={dropsExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5">
            {dropRanking.candidatesEvaluated} droppable entr
            {dropRanking.candidatesEvaluated === 1 ? 'y' : 'ies'} evaluated.
          </p>
        </>
      )}
    </Section>
  );
}

/** One open-slot add row inside OpenSlotAddsSection's list. */
function AddRow({
  add,
  canApplySwaps,
  onApplyAdd,
  onJumpAthlete,
}: {
  add: AddOnlyRow;
  canApplySwaps: boolean;
  onApplyAdd: (add: AddOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <li
      key={`${add.athlete}|${add.addEvent}`}
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <AthleteButton
          name={add.athlete}
          onJumpAthlete={onJumpAthlete}
          className="text-ui-caption max-w-[8rem]"
        />
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-ui-caption font-mono tabular-nums text-points-positive">
            {formatPoints(add.deltaPoints)}
          </span>
          {canApplySwaps ? (
            <button
              type="button"
              onClick={() => onApplyAdd(add)}
              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold"
            >
              Apply
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
        +{add.addEvent} ({add.addTime}
        {add.addTimeConverted ? 'c' : ''})
        {add.addTimeStale ? (
          <>
            {' '}
            <StalePill />
          </>
        ) : null}
        {add.confidence === 'verify' ? (
          <>
            {' '}
            <VerifyPill />
          </>
        ) : null}
      </p>
      <p className="text-ui-micro text-theme-muted mt-0.5 truncate">
        adds without dropping anything — swimmer has entry room under the caps
      </p>
    </li>
  );
}

export function OpenSlotAddsSection({
  addRanking,
  adds,
  shownAdds,
  addsExpanded,
  addsLimit,
  onToggleExpanded,
  lastApplied,
  onUndo,
  canApplySwaps,
  onApplyAdd,
  onJumpAthlete,
}: {
  addRanking: AddOnlyRanking | undefined;
  adds: AddOnlyRow[];
  shownAdds: AddOnlyRow[];
  addsExpanded: boolean;
  addsLimit: number;
  onToggleExpanded: () => void;
  lastApplied: LastApplied;
  onUndo: () => void;
  canApplySwaps: boolean;
  onApplyAdd: (add: AddOnlyRow) => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Open-slot adds"
      icon={<Plus size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={addRanking?.pointsMeaningful ? `(${adds.length})` : undefined}
    >
      <UndoLastSwapButton lastApplied={lastApplied} onUndo={onUndo} />
      {!addRanking || !addRanking.pointsMeaningful ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          {addRanking?.reason ?? 'Add deltas are not available for this team.'}
        </p>
      ) : adds.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No open-slot addition scores points — every swimmer with entry room is already placed
          where they can score.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownAdds.map(add => (
              <AddRow
                key={`${add.athlete}|${add.addEvent}`}
                add={add}
                canApplySwaps={canApplySwaps}
                onApplyAdd={onApplyAdd}
                onJumpAthlete={onJumpAthlete}
              />
            ))}
          </ul>
          <ShowAllToggle
            shown={addsLimit}
            total={adds.length}
            expanded={addsExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5">
            {addRanking.candidatesEvaluated} open-slot add
            {addRanking.candidatesEvaluated === 1 ? '' : 's'} evaluated.
          </p>
        </>
      )}
    </Section>
  );
}

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

export function ConvertedTimeUpgradesSection({
  edges,
  shownEdges,
  edgesExpanded,
  edgesLimit,
  onToggleExpanded,
  onJumpAthlete,
}: {
  edges: CrossCourseRow[];
  shownEdges: CrossCourseRow[];
  edgesExpanded: boolean;
  edgesLimit: number;
  onToggleExpanded: () => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Converted-time upgrades"
      icon={<Gauge size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={`(${edges.length})`}
    >
      {edges.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No LCM/SCM swim converts faster than an actual SCY best — conversion adds no new
          candidates for this team.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownEdges.map(row => (
              <li
                key={`${row.athlete}|${row.event}`}
                className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-baseline gap-1.5">
                    <AthleteButton
                      name={row.athlete}
                      onJumpAthlete={onJumpAthlete}
                      className="text-ui-caption max-w-[8rem]"
                    />
                    <span className="text-ui-caption text-theme-muted truncate">{row.event}</span>
                    {row.scyBest?.stale || row.convertedBest?.stale ? <StalePill /> : null}
                  </div>
                  <span className="text-ui-caption font-mono tabular-nums text-[var(--text-accent)] shrink-0">
                    {formatMargin(row.convertedWinsBy ?? 0)}
                  </span>
                </div>
                {row.scyBest && row.convertedBest ? (
                  <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
                    {row.scyBest.time} vs {row.convertedBest.time}c · {row.convertedBest.sourceCourse}{' '}
                    {row.convertedBest.sourceTime}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <ShowAllToggle
            shown={edgesLimit}
            total={edges.length}
            expanded={edgesExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5 leading-relaxed">
            Converted times are estimates from standard factors and already feed the swap
            candidates above.
          </p>
        </>
      )}
    </Section>
  );
}

export function CoverageGapsSection({ gaps }: { gaps: CoverageGap[] }) {
  return (
    <Section
      title="Coverage gaps"
      icon={<Users size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={`(${gaps.length})`}
    >
      {gaps.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No coverage gaps for this team.
        </p>
      ) : (
        <ul className="space-y-2">
          {gaps.map((gap: CoverageGap) => (
            <li
              key={gap.event}
              className={`rounded-lg border px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                gap.countTeamEntries === 0
                  ? 'border-[var(--text-accent)]/30 bg-[var(--text-accent)]/5'
                  : 'border-theme-soft surface-muted-bg'
              }`}
            >
              <span
                className={`text-ui-caption truncate ${
                  gap.countTeamEntries === 0
                    ? 'text-[var(--text-primary)] font-medium'
                    : 'text-theme-secondary'
                }`}
              >
                {gap.event}
              </span>
              <span
                className={`text-ui-caption font-mono tabular-nums shrink-0 ${
                  gap.countTeamEntries === 0 ? 'text-[var(--text-accent)]' : 'text-theme-muted'
                }`}
              >
                {gap.countTeamEntries} entered · {gap.openSlots} open
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
