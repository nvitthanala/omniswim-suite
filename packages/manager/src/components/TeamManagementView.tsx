/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { RefreshCw, UserMinus } from 'lucide-react';
import { Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import type { RecruitAthletePrefill } from './RecruitForm';
import RosterWizardShell, { type RosterWizardStepId } from './RosterWizardShell';
import RosterSourceStep from './RosterSourceStep';
import RosterLineupStep from './RosterLineupStep';
import RosterRelayStep from './RosterRelayStep';
import RosterOptimizeStep from './RosterOptimizeStep';

type Props = {
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
  onRequestDeleteSwimmer?: (name: string) => void;
};

export default function TeamManagementView({
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
  onRequestDeleteSwimmer,
}: Props) {
  const projectedByTeam = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of scoringBundle.sortedTeams) {
      map.set(t.teamName, t.totalPoints);
    }
    return map;
  }, [scoringBundle.teamStyleSignature]);

  const teams = useMemo(() => {
    return [...scoringBundle.sortedTeams.map(t => t.teamName)].sort((a, b) => a.localeCompare(b));
  }, [scoringBundle.teamStyleSignature]);
  const [selectedTeam, setSelectedTeam] = useState<string>('');
  const [recruitPrefill, setRecruitPrefill] = useState<RecruitAthletePrefill | null>(null);
  const [rosterStep, setRosterStep] = useState<RosterWizardStepId>('source');
  const [jumpAthleteName, setJumpAthleteName] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTeam) return;
    if (teams.includes(selectedTeam)) return;
    setSelectedTeam('');
  }, [teams, selectedTeam, gender]);

  const handleAthleteSelect = useCallback((athlete: RecruitAthletePrefill | null) => {
    setRecruitPrefill(athlete);
    if (athlete?.name) {
      setJumpAthleteName(athlete.name);
    }
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
      <label className="flex items-center gap-2 cursor-pointer surface-overlay border border-theme-soft rounded-lg px-3 py-2">
        <input
          type="checkbox"
          checked={whatIfMode}
          onChange={e => onWhatIfModeChange(e.target.checked)}
          className="accent-[var(--text-accent)]"
        />
        <span className="text-ui-label font-medium text-[var(--text-primary)] whitespace-nowrap">
          What-if
        </span>
      </label>
      <button
        type="button"
        onClick={() => whatIfMode && onRemoveSeniorsChange(!removeSeniors)}
        disabled={!whatIfMode}
        className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-ui-label transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${
          removeSeniors
            ? 'bg-[var(--text-accent)]/20 border-[var(--text-accent)]/40 text-[var(--text-accent)]'
            : 'surface-muted-bg border-theme-soft text-theme-secondary hover:text-[var(--text-primary)]'
        }`}
        title="Remove graduating seniors and simulate relay replacements"
      >
        <UserMinus size={14} />
        Drop seniors
      </button>
      <button
        type="button"
        onClick={onReloadScoring}
        className="flex items-center gap-2 px-3 py-2 btn-accent-outline rounded-lg text-ui-label font-medium whitespace-nowrap"
        title="Recalculate projected scores"
      >
        <RefreshCw size={14} />
        Recalc
      </button>
    </div>
  );

  return (
    <RosterWizardShell step={rosterStep} onStepChange={setRosterStep} toolbar={whatIfControls}>
      {rosterStep === 'source' ? (
        <RosterSourceStep
          workspace={workspace}
          gender={gender}
          teams={teams}
          selectedTeam={selectedTeam}
          onSelectTeam={setSelectedTeam}
          scoringSettings={scoringSettings}
          whatIfMode={whatIfMode}
          recruitPrefill={recruitPrefill}
          onAddRecruit={onAddRecruit}
          onUpdate={onUpdate}
        />
      ) : null}
      {rosterStep === 'lineup' ? (
        <RosterLineupStep
          workspace={workspace}
          gender={gender}
          scoringBundle={scoringBundle}
          scoringSettings={scoringSettings}
          baselineByTeam={baselineByTeam}
          projectedByTeam={projectedByTeam}
          whatIfMode={whatIfMode}
          removeSeniors={removeSeniors}
          selectedTeam={selectedTeam}
          onSelectTeam={setSelectedTeam}
          onUpdate={onUpdate}
          onDeleteSwim={whatIfMode ? handleDeleteSwim : undefined}
          onAthleteSelect={handleAthleteSelect}
          onRequestDeleteSwimmer={onRequestDeleteSwimmer}
          onOpenRelays={() => setRosterStep('relays')}
          jumpAthleteName={jumpAthleteName}
          onJumpAthleteHandled={() => setJumpAthleteName(null)}
        />
      ) : null}
      {rosterStep === 'relays' ? (
        <RosterRelayStep
          workspace={workspace}
          gender={gender}
          scoringBundle={scoringBundle}
          whatIfMode={whatIfMode}
          removeSeniors={removeSeniors}
          selectedTeam={selectedTeam}
          teams={teams}
          onSelectTeam={setSelectedTeam}
          onUpdate={onUpdate}
        />
      ) : null}
      {rosterStep === 'optimize' ? (
        <RosterOptimizeStep
          workspace={workspace}
          gender={gender}
          scoringSettings={scoringSettings}
          whatIfMode={whatIfMode}
          removeSeniors={removeSeniors}
          selectedTeam={selectedTeam}
          teams={teams}
          onSelectTeam={setSelectedTeam}
          onUpdate={onUpdate}
        />
      ) : null}
    </RosterWizardShell>
  );
}
