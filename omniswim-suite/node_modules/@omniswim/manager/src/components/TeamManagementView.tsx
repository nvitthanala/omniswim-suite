/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState, useCallback } from 'react';
import { RefreshCw, UserMinus } from 'lucide-react';
import { Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import RecruitForm, { type RecruitAthletePrefill } from './RecruitForm';
import TeamRosterPanel from './TeamRosterPanel';
import IndRelayManagementView from './IndRelayManagementView';
import RosterScoringSetup from './RosterScoringSetup';
import AthleteHistoryImportPanel from './AthleteHistoryImportPanel';
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
};

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

  const whatIfControls = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 cursor-pointer surface-overlay border border-theme-soft rounded px-3 py-1.5">
        <input
          type="checkbox"
          checked={whatIfMode}
          onChange={e => onWhatIfModeChange(e.target.checked)}
          className="accent-[var(--text-accent)]"
        />
        <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-primary)]">
          What-if mode
        </span>
      </label>
      {view === 'roster' ? (
        <button
          type="button"
          onClick={() => whatIfMode && onRemoveSeniorsChange(!removeSeniors)}
          disabled={!whatIfMode}
          className={`flex items-center gap-2 px-3 py-1.5 border rounded text-[10px] uppercase font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            removeSeniors
              ? 'bg-[var(--text-accent)]/20 border-[var(--text-accent)]/40 text-[var(--text-accent)]'
              : 'surface-muted-bg border-theme-soft text-theme-secondary hover:text-[var(--text-primary)]'
          }`}
          title="Remove graduating seniors and simulate relay replacements"
        >
          <UserMinus size={12} />
          <span>- Class of SR</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={onReloadScoring}
        className="flex items-center gap-2 px-3 py-1.5 btn-accent-outline rounded text-[10px] font-bold uppercase tracking-widest"
        title="Recalculate projected scores from current data and settings"
      >
        <RefreshCw size={12} />
        Reload scoring
      </button>
    </div>
  );

  if (view === 'ind-relay') {
    return (
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <div className="surface-card rounded-lg p-4 shrink-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-accent)] uppercase tracking-widest">
                Individual & Relay Management
              </h3>
              <p className="text-[10px] text-theme-secondary mt-1 max-w-2xl leading-relaxed">
                Relay split inspector — leg splits, segment ladders, and team cumulative times per relay
                entry.
              </p>
            </div>
            {whatIfControls}
          </div>
          {!whatIfMode ? (
            <p className="text-[10px] text-theme-secondary mt-3">
              Observe only — enable What-if mode to plan edits that affect projected scores.
            </p>
          ) : null}
        </div>
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
      <div className="surface-card rounded-lg p-4 shrink-0">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-accent)] uppercase tracking-widest">
                Roster & What-if Controls
              </h3>
              <p className="text-[10px] text-theme-secondary mt-1 max-w-2xl leading-relaxed">
                Manage rosters and what-if edits below. Projected scores sync to Meet Charts/Tables.
              </p>
            </div>
            {whatIfControls}
          </div>

        {!whatIfMode ? (
          <p className="text-[10px] text-theme-secondary mb-2">
            Observe only — enable What-if mode to edit roster, recruits, and senior removal.
          </p>
        ) : null}

        {workspace.loadedMeet?.pdfFilename ? (
          <p className="text-[9px] text-theme-secondary mb-2">
            Recruits saved with this workspace · loaded:{' '}
            <span className="text-[var(--text-accent)]">{workspace.loadedMeet.pdfFilename}</span>
          </p>
        ) : null}

        <RosterScoringSetup
          workspace={workspace}
          settings={scoringSettings}
          onSave={onUpdate}
        />

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label className="text-[9px] text-theme-secondary uppercase">Entry mode</label>
          <select
            value={workspace.entryPlanMode ?? 'overlay'}
            disabled={!whatIfMode}
            onChange={e =>
              onUpdate({ entryPlanMode: e.target.value as 'overlay' | 'plan_sheet' })
            }
            className="text-[10px] surface-muted-bg border border-theme-soft rounded px-2 py-1"
          >
            <option value="overlay">Edit loaded meet (overlay)</option>
            <option value="plan_sheet">Plan sheet</option>
          </select>
        </div>

        <div className="max-w-xl w-full">
          <h4 className="text-[9px] font-medium text-theme-secondary uppercase tracking-widest mb-2">
            Recruit injection
          </h4>
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
            <p className="text-[9px] text-theme-secondary mt-2">
              Prefilled from{' '}
              <span className="text-[var(--text-accent)]">{recruitPrefill.name}</span> — pick a new event
              and time, then inject.
            </p>
          ) : null}
        </div>
      </div>

      <AthleteHistoryImportPanel
        workspace={workspace}
        gender={gender}
        team={selectedTeam || teams[0] || ''}
        onUpdate={onUpdate}
        importDisabled={!whatIfMode}
      />

      <div className="flex-1 min-h-0 flex flex-col">
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
        />
      </div>
    </div>
  );
}
