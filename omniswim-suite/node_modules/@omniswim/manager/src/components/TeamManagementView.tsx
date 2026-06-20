/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, UserMinus } from 'lucide-react';
import { Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import { Toolbar } from '@omniswim/ui';
import RecruitForm, { type RecruitAthletePrefill } from './RecruitForm';
import TeamRosterPanel from './TeamRosterPanel';
import IndRelayManagementView from './IndRelayManagementView';
import RosterScoringSetup from './RosterScoringSetup';
import type { TeamManagementViewId } from './TeamManagementSubTabs';

type Props = {
  view: TeamManagementViewId;
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  baselineByTeam: Map<string, number>;
  scoringSettings: ScoringSettings;
  whatIfMode: boolean;
  onWhatIfModeChange: (enabled: boolean) => void;
  removeSeniors: boolean;
  onRemoveSeniorsChange: (enabled: boolean) => void;
  onReloadScoring: () => void;
  onAddRecruit: (recruit: Recruit) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  onOpenImport: () => void;
  onOpenBatchOptimizer: () => void;
};

function CollapsibleSection({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-theme-soft first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 py-3 text-left theme-hover-row rounded"
      >
        {open ? <ChevronDown size={14} className="text-theme-muted shrink-0" /> : <ChevronRight size={14} className="text-theme-muted shrink-0" />}
        <span className="flex-1 min-w-0">
          <span className="block text-ui-label font-semibold text-[var(--text-primary)]">{title}</span>
          {subtitle ? <span className="block text-ui-caption text-theme-muted mt-0.5">{subtitle}</span> : null}
        </span>
      </button>
      {open ? <div className="pb-4 pl-6">{children}</div> : null}
    </div>
  );
}

export default function TeamManagementView({
  view,
  workspace,
  gender,
  scoringBundle,
  baselineByTeam,
  scoringSettings,
  whatIfMode,
  onWhatIfModeChange,
  removeSeniors,
  onRemoveSeniorsChange,
  onReloadScoring,
  onAddRecruit,
  onUpdate,
  onOpenImport,
  onOpenBatchOptimizer,
}: Props) {
  const projectedByTeam = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of scoringBundle.sortedTeams) {
      map.set(t.teamName, t.totalPoints);
    }
    return map;
  }, [scoringBundle.teamStyleSignature]);

  const teams = scoringBundle.sortedTeams.map(t => t.teamName);
  const [selectedTeam, setSelectedTeam] = useState<string>('');
  const [recruitPrefill, setRecruitPrefill] = useState<RecruitAthletePrefill | null>(null);

  const handleAthleteSelect = useCallback((athlete: RecruitAthletePrefill | null) => {
    setRecruitPrefill(athlete);
  }, []);

  const handleDeleteSwim = (swim: AthleteCreditedSwim) => {
    if (swim.isRecruit) {
      onUpdate({
        recruits: (workspace.recruits ?? []).filter(r => r.id !== swim.id),
      });
      return;
    }
    const field = gender === Gender.MEN ? 'menResults' : 'womenResults';
    const arr = workspace[field] ?? [];
    onUpdate({
      [field]: arr.filter(r => r.id !== swim.id),
    });
  };

  const whatIfToolbar = (
    <Toolbar className="panel panel-compact mb-4">
      <label className="flex items-center gap-2 cursor-pointer text-ui-caption text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={whatIfMode}
          onChange={e => onWhatIfModeChange(e.target.checked)}
          className="accent-[var(--text-accent)]"
        />
        What-if mode
      </label>
      {view === 'roster' ? (
        <button
          type="button"
          onClick={() => whatIfMode && onRemoveSeniorsChange(!removeSeniors)}
          disabled={!whatIfMode}
          className={`btn-secondary text-ui-caption flex items-center gap-1.5 disabled:opacity-40 ${
            removeSeniors ? 'border-[var(--text-accent)]/40 text-[var(--text-accent)]' : ''
          }`}
          title="Remove graduating seniors and simulate relay replacements"
        >
          <UserMinus size={12} />
          Exclude seniors
        </button>
      ) : null}
      <button type="button" onClick={onReloadScoring} className="btn-ghost text-ui-caption flex items-center gap-1.5">
        <RefreshCw size={12} />
        Reload scoring
      </button>
      {!whatIfMode ? (
        <span className="text-ui-caption text-theme-muted">Observe only — turn on What-if to edit</span>
      ) : null}
    </Toolbar>
  );

  if (view === 'ind-relay') {
    return (
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        {whatIfToolbar}
        <IndRelayManagementView
          workspace={workspace}
          gender={gender}
          scoringBundle={scoringBundle}
          whatIfMode={whatIfMode}
          removeSeniors={removeSeniors}
          onUpdate={onUpdate}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {whatIfToolbar}

      <div className="flex-1 min-h-0 flex flex-col panel p-0 overflow-hidden">
        <TeamRosterPanel
          results={scoringBundle.allResults}
          scoredResults={scoringBundle.allScored}
          settings={scoringSettings}
          gender={gender}
          overrides={workspace.scorerRosterOverrides ?? []}
          onChangeOverrides={next => onUpdate({ scorerRosterOverrides: next })}
          editable={whatIfMode}
          officialTeamScores={workspace.officialTeamScores}
          projectedByTeam={projectedByTeam}
          baselineByTeam={baselineByTeam}
          showTeamSidebar
          expanded
          selectedTeam={selectedTeam || undefined}
          onSelectTeam={setSelectedTeam}
          onDeleteSwim={whatIfMode ? handleDeleteSwim : undefined}
          onAthleteSelect={handleAthleteSelect}
          workspace={workspace}
          removeSeniors={removeSeniors}
          onWorkspaceUpdate={whatIfMode ? onUpdate : undefined}
          onOpenBatchOptimizer={onOpenBatchOptimizer}
        />
      </div>

      <div className="panel panel-compact">
        <h3 className="text-ui-label font-semibold text-[var(--text-primary)] mb-1">Tools</h3>
        <p className="text-ui-caption text-theme-muted mb-3">
          Scoring setup, entries, recruits, and SwimCloud import
        </p>

        <CollapsibleSection title="Scoring setup" subtitle="Conference preset and scorer caps">
          <RosterScoringSetup workspace={workspace} settings={scoringSettings} onSave={onUpdate} />
        </CollapsibleSection>

        <CollapsibleSection title="Meet entries" subtitle="How roster edits apply to the loaded meet">
          <label className="flex flex-col gap-1.5 max-w-sm">
            <span className="label-caps">Entry mode</span>
            <select
              value={workspace.entryPlanMode ?? 'overlay'}
              disabled={!whatIfMode}
              onChange={e => onUpdate({ entryPlanMode: e.target.value as 'overlay' | 'plan_sheet' })}
              className="glass-input-compact"
            >
              <option value="overlay">Edit loaded meet (overlay)</option>
              <option value="plan_sheet">Plan sheet</option>
            </select>
          </label>
        </CollapsibleSection>

        <CollapsibleSection title="Recruit injection" subtitle="Add a hypothetical swimmer to the roster">
          <RecruitForm
            gender={gender}
            teams={teams}
            defaultTeam={selectedTeam || teams[0]}
            athletePrefill={recruitPrefill}
            onSubmit={onAddRecruit}
            disabled={!whatIfMode}
            compact
          />
          {recruitPrefill ? (
            <p className="text-ui-caption text-theme-muted mt-2">
              Prefilled from <span className="text-[var(--text-accent)]">{recruitPrefill.name}</span>
            </p>
          ) : null}
        </CollapsibleSection>

        <CollapsibleSection title="Import history" subtitle="Paste SwimCloud bests or upload CSV">
          <p className="text-ui-caption text-theme-muted mb-3">
            Import athlete history into this workspace from SwimCloud paste or CSV.
          </p>
          <button type="button" onClick={onOpenImport} className="btn-secondary text-ui-caption" disabled={!whatIfMode}>
            Open import wizard
          </button>
        </CollapsibleSection>
      </div>
    </div>
  );
}
