/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FileWarning, Sparkles, Users } from 'lucide-react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { optimizeRosterForTeam, optimizeRosterAllTeams } from '@omniswim/core/lib/rosterOptimizer';
import {
  buildArbitrageCardsResult,
  type ArbitrageCardsResult,
  optimizeWithArbitrage,
  type ArbitrageCard,
  type ArbitrageMode,
} from '@omniswim/core/lib/rosterArbitrage';
import { EmptyState, useToast } from '@omniswim/ui';
import TeamPickerEmptyState from './TeamPickerEmptyState';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringSettings: ScoringSettings;
  whatIfMode: boolean;
  removeSeniors: boolean;
  selectedTeam: string;
  teams: string[];
  onSelectTeam: (team: string) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
};

function ArbitrageCardList({
  cards,
  pointsMeaningful = true,
  reason,
}: {
  cards: ArbitrageCard[];
  pointsMeaningful?: boolean;
  reason?: string;
}) {
  // "We cannot compute a point value here" and "we computed one and found no
  // gains" are different answers. Showing the same empty state for both reads as
  // the second, which is the more reassuring and the wrong one.
  if (!pointsMeaningful) {
    return (
      <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
        <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
          Point values need a scored field to place against.
          {reason ? ` ${reason}` : ' Load a meet with at least two scoring teams.'}
        </p>
        <p className="text-ui-caption text-theme-muted mt-2 max-w-md mx-auto">
          Event swaps can still be made by hand on the Lineup step — only the points
          they would be worth cannot be stated yet.
        </p>
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
        <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
          No swap gains points for this team — every athlete is already in the events
          that score most for them.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {cards.map(c => (
        <li
          key={`${c.athleteName}|${c.preferredEvent}|${c.alternateEvent}`}
          className="rounded-xl border border-theme-soft surface-muted-bg p-4 min-w-0"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-ui-label font-semibold text-[var(--text-primary)] truncate min-w-0">
              {c.athleteName}
            </p>
            <span className="text-ui-label font-mono text-[var(--text-accent)] shrink-0">
              +{c.arbitragePts}
            </span>
          </div>
          <p className="text-ui-body text-theme-secondary mt-2 leading-relaxed break-words">
            Swim <span className="text-[var(--text-primary)]">{c.preferredEvent}</span>
            {c.addTime ? ` (${c.addTime})` : ''} instead of{' '}
            <span className="text-[var(--text-primary)]">{c.alternateEvent}</span>.
          </p>
          {c.addTimeConverted || c.needsVerify ? (
            <p className="text-ui-caption text-theme-muted mt-1.5 break-words">
              {c.addTimeConverted ? 'Entry time is converted from a metric swim' : null}
              {c.addTimeConverted && c.needsVerify ? ' — ' : null}
              {c.needsVerify
                ? 'placing sits inside conversion-factor noise, so verify before acting'
                : null}
              .
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function RosterOptimizeStep({
  workspace,
  gender,
  scoringSettings,
  whatIfMode,
  removeSeniors,
  selectedTeam,
  teams,
  onSelectTeam,
  onUpdate,
}: Props) {
  const toast = useToast();
  const [mode, setMode] = useState<ArbitrageMode>('individual_first');
  const [cards, setCards] = useState<ArbitrageCard[]>([]);
  const team = selectedTeam && teams.includes(selectedTeam) ? selectedTeam : '';
  // "Nothing to work with" is no scoreable TEAM, not no meet PDF. A workspace
  // can be recruit-driven -- SwimCloud imports and planned entries with no meet
  // loaded -- and still have a full roster to build, which is the HSU planning
  // workflow. Keying this off menResults blocked that path entirely.
  const hasRoster = teams.length > 0;

  // Computed on request, never during render.
  //
  // `buildArbitrageCardsResult` re-scores the field once per candidate swap — 849
  // candidates at ~7 ms each on the NSISC meet. Running that in a `useMemo` froze
  // the main thread for 8.3 s in a single task (measured), so opening this step
  // locked the UI. Correct numbers are not worth a frozen tab; the button makes
  // the cost explicit and keeps the step instant to open.
  const [preview, setPreview] = useState<ArbitrageCardsResult | null>(null);
  const [scanning, setScanning] = useState(false);

  // A stale scan is worse than none — it would describe a roster that no longer exists.
  useEffect(() => {
    setPreview(null);
  }, [workspace, gender, team, scoringSettings]);

  const runScan = () => {
    if (!team) return;
    setScanning(true);
    // Yield a frame so the "Scanning…" state paints before the blocking work starts.
    window.setTimeout(() => {
      try {
        setPreview(buildArbitrageCardsResult(workspace, gender, team, scoringSettings));
      } finally {
        setScanning(false);
      }
    }, 0);
  };

  const displayCards = cards.length > 0 ? cards : preview?.cards ?? [];

  const applyTeam = () => {
    if (!whatIfMode || !team) return;
    const result = optimizeWithArbitrage(
      workspace,
      gender,
      team,
      removeSeniors,
      scoringSettings,
      mode
    );
    onUpdate({
      scorerRosterOverrides: result.overrides,
      meetEntryPlans: result.meetEntryPlans,
      activeEntryIds: result.activeEntryIds,
    });
    setCards(result.cards);
    const delta = result.projectedTotal - result.previousTotal;
    toast.push(
      'success',
      `${team}: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts (${mode.replace('_', ' ')})`
    );
  };

  const applyLegacy = () => {
    if (!whatIfMode || !team) return;
    const result = optimizeRosterForTeam(workspace, gender, team, removeSeniors, scoringSettings);
    // "Found nothing better" is not success. The optimiser now refuses to apply a
    // result that would lower the team total — on a recruit-driven workspace the
    // unguarded run took 1277 points to 0 — so the toast must distinguish the two
    // rather than reporting a win for a no-op.
    if (result.outcome === 'unchanged') {
      toast.push(
        'info',
        `${team}: already the best lineup found — nothing changed (${result.previousTotal.toFixed(1)} pts).`
      );
      return;
    }
    onUpdate({
      scorerRosterOverrides: result.overrides,
      meetEntryPlans: result.meetEntryPlans,
      activeEntryIds: result.activeEntryIds,
    });
    const gain = result.projectedTotal - result.previousTotal;
    toast.push(
      'success',
      `${team}: +${gain.toFixed(1)} pts → ${result.projectedTotal.toFixed(1)} (${result.appliedStages?.replace('+', ' + ') ?? 'optimised'})`
    );
  };

  const applyAll = () => {
    if (!whatIfMode) return;
    const result = optimizeRosterAllTeams(workspace, gender, removeSeniors, scoringSettings);
    // Same rule as applyLegacy. The all-teams path guards on the aggregate, because
    // per-team gains can cancel once chained — measured +307 and +18 individually
    // netting to +16 across the meet.
    if (result.outcome === 'unchanged') {
      toast.push('info', 'No lineup change improved the field — nothing was applied.');
      return;
    }
    onUpdate({
      scorerRosterOverrides: result.overrides,
      meetEntryPlans: result.meetEntryPlans,
      activeEntryIds: result.activeEntryIds,
    });
    const gain = result.projectedTotal - result.previousTotal;
    toast.push('success', `All teams: +${gain.toFixed(1)} pts across the field`);
  };

  if (!hasRoster) {
    return (
      <EmptyState
        icon={<FileWarning size={28} />}
        eyebrow="Optimize"
        title="Bring in swimmers first"
        description="Load a meet or import swimmers on the Source step to build this optimization."
      />
    );
  }

  if (!selectedTeam) {
    return (
      <TeamPickerEmptyState
        eyebrow="Optimize"
        title="Choose a team to optimize"
        description="Select a team to review its point opportunities and optimize its entries."
        teams={teams}
        onSelectTeam={onSelectTeam}
      />
    );
  }

  return (
    <div className="surface-card rounded-xl p-4 sm:p-5 flex flex-col gap-5">
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
            onChange={e => setMode(e.target.value as ArbitrageMode)}
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
            onClick={applyTeam}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg btn-primary text-ui-label font-semibold disabled:opacity-40"
          >
            <Sparkles size={14} />
            Optimize team
          </button>
          <button
            type="button"
            disabled={!whatIfMode || !team}
            onClick={applyLegacy}
            className="px-4 py-2.5 rounded-lg border border-theme-soft text-ui-label text-[var(--text-primary)] theme-hover-row disabled:opacity-40"
            title="Classic greedy optimizer"
          >
            Classic
          </button>
          <button
            type="button"
            disabled={!whatIfMode}
            onClick={applyAll}
            className="px-4 py-2.5 rounded-lg border border-theme-soft text-ui-label text-[var(--text-primary)] theme-hover-row disabled:opacity-40"
          >
            All teams
          </button>
        </div>
      </div>

      {!whatIfMode ? (
        <p className="text-ui-caption rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 text-theme-secondary">
          Enable What-if to apply optimizer changes.
        </p>
      ) : null}

      <div>
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)] mb-3">
          Point arbitrage
          {team ? (
            <span className="font-normal text-theme-secondary"> · {team}</span>
          ) : null}
        </h4>
        {displayCards.length === 0 && !preview && cards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
            <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
              Scanning every event swap re-scores the meet once per candidate, so it
              runs on request rather than on open.
            </p>
            <button
              type="button"
              onClick={runScan}
              disabled={!team || scanning}
              className="mt-4 px-4 py-2 text-ui-label font-semibold rounded-lg btn-primary transition-colors disabled:opacity-60"
            >
              {scanning ? 'Scanning…' : 'Find point opportunities'}
            </button>
            {!team ? (
              <p className="text-ui-caption text-theme-muted mt-2">Choose a team first.</p>
            ) : null}
          </div>
        ) : (
          <ArbitrageCardList
            cards={displayCards}
            pointsMeaningful={cards.length > 0 ? true : preview?.pointsMeaningful ?? true}
            reason={preview?.reason}
          />
        )}
      </div>
    </div>
  );
}
