/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Section components for RosterOptimizeStep — the team/strategy controls row
 * and the point-arbitrage preview. Split out so the panel's top-level return
 * is two sections instead of one long conditional tree.
 */

import React from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { ArbitrageCard, ArbitrageCardsResult, ArbitrageMode } from '@omniswim/core/lib/rosterArbitrage';
import { Button, Disclosure } from '@omniswim/ui';
import { ArbitrageCardList } from './RosterOptimizeStep';
import { describeOptimizeRun, type OptimizeRunState } from './optimizeRunView';

type OptimizerControlsProps = {
  team: string;
  mode: ArbitrageMode;
  onModeChange: (mode: ArbitrageMode) => void;
  whatIfMode: boolean;
  onApplyTeam: () => void;
  onApplyLegacy: () => void;
  /** Opens the "All teams" dialog. */
  onOpenAllTeams: () => void;
  /** An optimizer run is in flight. Both run buttons wait for it. */
  busy?: boolean;
};

export function OptimizerControls({
  team,
  mode,
  onModeChange,
  whatIfMode,
  onApplyTeam,
  onApplyLegacy,
  onOpenAllTeams,
  busy = false,
}: OptimizerControlsProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
        <label className="lg:col-span-4 flex flex-col gap-1.5 min-w-0">
          <span className="text-ui-caption text-theme-muted">Strategy</span>
          <select
            value={mode}
            disabled={!whatIfMode}
            onChange={e => onModeChange(e.target.value as ArbitrageMode)}
            className="glass-input w-full rounded-lg px-3 py-2.5 text-ui-body disabled:opacity-50"
          >
            <option value="individual_first">Individuals first, then relays</option>
            <option value="relay_first">Relays first, then individuals</option>
          </select>
        </label>
        <div className="lg:col-span-8 flex flex-wrap gap-2">
          <Button
            data-optimizer-focus
            disabled={!whatIfMode || !team || busy}
            onClick={onApplyTeam}
            leadingIcon={<Sparkles size={14} />}
          >
            Optimize team
          </Button>
          <Button
            variant="outline"
            disabled={!whatIfMode || busy}
            onClick={onOpenAllTeams}
            title={
              whatIfMode
                ? 'Optimize every team in the field, with a preview before it applies'
                : 'Enable What-if to optimize'
            }
          >
            All teams…
          </Button>
        </div>
      </div>
      <Disclosure title="More options">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={!whatIfMode || !team || busy}
            onClick={onApplyLegacy}
            title="Ranks scorers, then fills events, in one greedy pass"
          >
            Quick optimize (greedy)
          </Button>
          <p className="text-ui-caption text-theme-secondary min-w-0 flex-1">
            One greedy pass for this team: ranks scorers, then fills events. It ignores the
            Strategy setting.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

type OptimizeRunStatusProps = {
  run: OptimizeRunState;
  onCancel: () => void;
};

/**
 * What the coach sees while an optimizer run is in flight: plain-word progress and a Cancel. The
 * region is polite-live so a screen reader hears "Optimizing 3 of 12 teams" as it advances.
 */
export function OptimizeRunStatus({ run, onCancel }: OptimizeRunStatusProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 flex flex-wrap items-center gap-3"
    >
      <RefreshCw size={14} className="animate-spin text-[var(--text-accent)] shrink-0" aria-hidden="true" />
      <span className="text-ui-body text-theme-secondary min-w-0 flex-1 break-words">
        {describeOptimizeRun(run)}
      </span>
      <Button variant="outline" size="sm" onClick={onCancel}>
        Cancel run
      </Button>
    </div>
  );
}

type ScanPromptProps = {
  team: string;
  scanning: boolean;
  /** Another optimizer run is in flight, so a scan would compete with it. */
  busy?: boolean;
  onScan: () => void;
};

function ScanPrompt({ team, scanning, busy = false, onScan }: ScanPromptProps) {
  return (
    <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
      <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
        Scanning every event swap re-scores the meet once per candidate, so it runs on
        request rather than on open.
      </p>
      <Button variant="primary" size="md" onClick={onScan} disabled={!team || scanning || busy} className="mt-4">
        {scanning ? 'Scanning…' : 'Find point opportunities'}
      </Button>
      {!team ? <p className="text-ui-caption text-theme-muted mt-2">Choose a team in the team bar above first.</p> : null}
    </div>
  );
}

type ArbitragePreviewSectionProps = {
  team: string;
  scanning: boolean;
  busy?: boolean;
  onScan: () => void;
  displayCards: ArbitrageCard[];
  cards: ArbitrageCard[];
  preview: ArbitrageCardsResult | null;
};

/** The scan prompt (nothing scanned yet) or the resulting arbitrage card list. */
export function ArbitragePreviewSection({
  team,
  scanning,
  busy = false,
  onScan,
  displayCards,
  cards,
  preview,
}: ArbitragePreviewSectionProps) {
  const showScanPrompt = displayCards.length === 0 && !preview && cards.length === 0;
  return (
    <div>
      <h4 className="text-ui-label font-semibold text-[var(--text-primary)] mb-3">
        Point opportunities
        {team ? <span className="font-normal text-theme-secondary"> · {team}</span> : null}
      </h4>
      {showScanPrompt ? (
        <ScanPrompt team={team} scanning={scanning} busy={busy} onScan={onScan} />
      ) : (
        <ArbitrageCardList
          cards={displayCards}
          pointsMeaningful={cards.length > 0 ? true : preview?.pointsMeaningful ?? true}
          reason={preview?.reason}
        />
      )}
    </div>
  );
}
