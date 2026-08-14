/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { FileWarning, Sparkles, Users } from 'lucide-react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { optimizeRosterForTeam, optimizeRosterAllTeams } from '@omniswim/core/lib/rosterOptimizer';
import {
  buildArbitrageCards,
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

function ArbitrageCardList({ cards }: { cards: ArbitrageCard[] }) {
  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-soft px-4 py-8 text-center">
        <p className="text-ui-body text-theme-secondary leading-relaxed max-w-md mx-auto">
          No clear trade-offs yet. Import SwimCloud times or load a meet, then pick a team to see
          where points can be gained by event swaps.
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
            Prefer <span className="text-[var(--text-primary)]">{c.preferredEvent}</span>
            {c.preferredDelta ? ` (~+${c.preferredDelta})` : ''} over{' '}
            <span className="text-[var(--text-primary)]">{c.alternateEvent}</span>
            {c.alternateDelta ? ` (~+${c.alternateDelta})` : ''}.
          </p>
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

  const previewCards = useMemo(() => {
    if (!team) return [];
    return buildArbitrageCards(workspace, gender, team, scoringSettings);
  }, [workspace, gender, team, scoringSettings]);

  const displayCards = cards.length > 0 ? cards : previewCards;

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
    onUpdate({
      scorerRosterOverrides: result.overrides,
      meetEntryPlans: result.meetEntryPlans,
      activeEntryIds: result.activeEntryIds,
    });
    toast.push('success', `Best roster applied for ${team}`);
  };

  const applyAll = () => {
    if (!whatIfMode) return;
    const result = optimizeRosterAllTeams(workspace, gender, removeSeniors, scoringSettings);
    onUpdate({
      scorerRosterOverrides: result.overrides,
      meetEntryPlans: result.meetEntryPlans,
      activeEntryIds: result.activeEntryIds,
    });
    toast.push('success', 'Best roster applied for all teams');
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
        <ArbitrageCardList cards={displayCards} />
      </div>
    </div>
  );
}
