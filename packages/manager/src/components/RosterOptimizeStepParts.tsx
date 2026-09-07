/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Section components for RosterOptimizeStep — the team/strategy controls row
 * and the point-arbitrage preview. Split out so the panel's top-level return
 * is two sections instead of one long conditional tree.
 */

import React from 'react';
import { Sparkles, Users } from 'lucide-react';
import type { ArbitrageCard, ArbitrageCardsResult, ArbitrageMode } from '@omniswim/core/lib/rosterArbitrage';
import { ArbitrageCardList } from './RosterOptimizeStep';

type OptimizerControlsProps = {
  team: string;
  teams: string[];
  onSelectTeam: (team: string) => void;
  mode: ArbitrageMode;
  onModeChange: (mode: ArbitrageMode) => void;
  whatIfMode: boolean;
  onApplyTeam: () => void;
  onApplyLegacy: () => void;
  onApplyAll: () => void;
};

export function OptimizerControls({
  team,
  teams,
  onSelectTeam,
  mode,
  onModeChange,
  whatIfMode,
  onApplyTeam,
  onApplyLegacy,
  onApplyAll,
}: OptimizerControlsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
      <label className="lg:col-span-4 flex flex-col gap-1.5 min-w-0">
        <span className="text-ui-caption text-theme-muted flex items-center gap-1.5">
          <Users size={14} /> Team to optimize
        </span>
        <select
          value={team}
          onChange={e => onSelectTeam(e.target.value)}
          className="glass-input w-full rounded-lg px-3 py-2.5 text-ui-body"
        >
          <option value="">Select a team…</option>
          {teams.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="lg:col-span-3 flex flex-col gap-1.5 min-w-0">
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
      <div className="lg:col-span-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!whatIfMode || !team}
          onClick={onApplyTeam}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg btn-primary text-ui-label font-semibold disabled:opacity-40"
        >
          <Sparkles size={14} />
          Optimize team
        </button>
        <button
          type="button"
          disabled={!whatIfMode || !team}
          onClick={onApplyLegacy}
          className="px-4 py-2.5 rounded-lg border border-theme-soft text-ui-label text-[var(--text-primary)] theme-hover-row disabled:opacity-40"
          title="Classic greedy optimizer"
        >
          Classic
        </button>
        <button
          type="button"
          disabled={!whatIfMode}
          onClick={onApplyAll}
          className="px-4 py-2.5 rounded-lg border border-theme-soft text-ui-label text-[var(--text-primary)] theme-hover-row disabled:opacity-40"
        >
          All teams
        </button>
      </div>
    </div>
  );
}

type ScanPromptProps = {
  team: string;
  scanning: boolean;
  onScan: () => void;
};

function ScanPrompt({ team, scanning, onScan }: ScanPromptProps) {
  return (
    <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
      <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
        Scanning every event swap re-scores the meet once per candidate, so it runs on
        request rather than on open.
      </p>
      <button
        type="button"
        onClick={onScan}
        disabled={!team || scanning}
        className="mt-4 px-4 py-2 text-ui-label font-semibold rounded-lg btn-primary transition-colors disabled:opacity-60"
      >
        {scanning ? 'Scanning…' : 'Find point opportunities'}
      </button>
      {!team ? <p className="text-ui-caption text-theme-muted mt-2">Choose a team first.</p> : null}
    </div>
  );
}

type ArbitragePreviewSectionProps = {
  team: string;
  scanning: boolean;
  onScan: () => void;
  displayCards: ArbitrageCard[];
  cards: ArbitrageCard[];
  preview: ArbitrageCardsResult | null;
};

/** The scan prompt (nothing scanned yet) or the resulting arbitrage card list. */
export function ArbitragePreviewSection({
  team,
  scanning,
  onScan,
  displayCards,
  cards,
  preview,
}: ArbitragePreviewSectionProps) {
  const showScanPrompt = displayCards.length === 0 && !preview && cards.length === 0;
  return (
    <div>
      <h4 className="text-ui-label font-semibold text-[var(--text-primary)] mb-3">
        Point arbitrage
        {team ? <span className="font-normal text-theme-secondary"> · {team}</span> : null}
      </h4>
      {showScanPrompt ? (
        <ScanPrompt team={team} scanning={scanning} onScan={onScan} />
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
