/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { RefreshCw, Undo2, UserMinus } from 'lucide-react';
import { Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import { editCreditedSwim, removeCreditedSwim } from '@omniswim/core/lib/swimEditor';
import {
  ATHLETE_JUMP_EVENT,
  consumePendingAthleteJump,
  type AthleteJumpDetail,
} from '@omniswim/core/lib/athleteJumpSignal';
import { useToast } from '@omniswim/ui';
import type { RecruitAthletePrefill } from './RecruitForm';
import type { EditCreditedSwimValues } from './AthleteCreditedSwimsPanel';
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
  const toast = useToast();
  const [lastSwimEdit, setLastSwimEdit] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);

  // Compose-ref (BUG 3.2): build each credited-swim patch against the freshest
  // workspace (prop composed forward with applied patches) so rapid successive
  // deletes/edits don't clobber one another via a stale full-array replacement.
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

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
  const [jumpAthleteKey, setJumpAthleteKey] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTeam) return;
    if (teams.includes(selectedTeam)) return;
    setSelectedTeam('');
  }, [teams, selectedTeam, gender]);

  const handleAthleteSelect = useCallback((athlete: RecruitAthletePrefill | null) => {
    setRecruitPrefill(athlete);
    if (athlete?.name) {
      setJumpAthleteName(athlete.name);
      setJumpAthleteKey(null);
    }
  }, []);

  // Checklist / arbitrage jump: carry the roster key when known so the roster panel
  // can match by key first (BUG 1 hardening) and fall back to canonical name.
  const handleJumpAthlete = useCallback(
    (name: string, key?: string) => {
      setRecruitPrefill({ name, team: selectedTeam, classYear: '' });
      setJumpAthleteName(name);
      setJumpAthleteKey(key ?? null);
    },
    [selectedTeam]
  );

  const handleJumpHandled = useCallback(() => {
    setJumpAthleteName(null);
    setJumpAthleteKey(null);
  }, []);

  // Cross-applet jump (shell command palette → athleteJumpSignal). Pick up the
  // stored request on mount and listen for live events while mounted.
  const pendingJumpRef = useRef<AthleteJumpDetail | null>(null);
  const [jumpSignalTick, setJumpSignalTick] = useState(0);
  useEffect(() => {
    const pending = consumePendingAthleteJump();
    if (pending) {
      pendingJumpRef.current = pending;
      setJumpSignalTick(t => t + 1);
    }
    const onJump = (e: Event) => {
      consumePendingAthleteJump(); // clear storage so it can't replay on a later mount
      const detail = (e as CustomEvent<AthleteJumpDetail>).detail;
      if (detail?.name) {
        pendingJumpRef.current = detail;
        setJumpSignalTick(t => t + 1);
      }
    };
    window.addEventListener(ATHLETE_JUMP_EVENT, onJump);
    return () => window.removeEventListener(ATHLETE_JUMP_EVENT, onJump);
  }, []);

  // Consume only once the scored team list exists and gender has propagated —
  // TeamRosterPanel resolves the jump against teamRows and treats a miss as a
  // hard "could not open" (clears selection + toasts), so firing early would
  // misreport every palette jump on a cold mount.
  useEffect(() => {
    const detail = pendingJumpRef.current;
    if (!detail || teams.length === 0) return;
    if (detail.gender && detail.gender !== gender) return;
    pendingJumpRef.current = null;
    if (detail.team && teams.includes(detail.team)) setSelectedTeam(detail.team);
    setRosterStep('lineup');
    setRecruitPrefill({ name: detail.name, team: detail.team ?? '', classYear: '' });
    setJumpAthleteName(detail.name);
    setJumpAthleteKey(null);
  }, [jumpSignalTick, teams, gender]);

  const applySwimPatch = (
    build: (ws: Workspace) => { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string }
  ) => {
    const result = build(workspaceRef.current);
    workspaceRef.current = { ...workspaceRef.current, ...result.patch };
    onUpdate(result.patch);
    setLastSwimEdit({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  const handleDeleteSwim = (swim: AthleteCreditedSwim) => {
    if (swim.isRecruit) {
      applySwimPatch(ws => {
        const baseRecruits = ws.recruits ?? [];
        return {
          patch: { recruits: baseRecruits.filter(r => r.id !== swim.id) },
          inverse: { recruits: baseRecruits },
          description: `Remove recruit entry (${swim.event})`,
        };
      });
      return;
    }
    applySwimPatch(ws => removeCreditedSwim(ws, gender, swim.id));
  };

  const handleEditSwim = (swim: AthleteCreditedSwim, changes: EditCreditedSwimValues) => {
    applySwimPatch(ws => editCreditedSwim(ws, gender, swim.id, changes));
  };

  const handleUndoSwimEdit = () => {
    if (!lastSwimEdit) return;
    workspaceRef.current = { ...workspaceRef.current, ...lastSwimEdit.inverse };
    onUpdate(lastSwimEdit.inverse);
    toast.push('success', `Undid: ${lastSwimEdit.description}`);
    setLastSwimEdit(null);
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
      {lastSwimEdit ? (
        <button
          type="button"
          onClick={handleUndoSwimEdit}
          title={lastSwimEdit.description}
          className="flex items-center gap-1.5 px-3 py-2 border border-theme-soft rounded-lg text-ui-label text-theme-secondary hover:text-[var(--text-primary)] transition-colors whitespace-nowrap max-w-[16rem] truncate"
        >
          <Undo2 size={14} className="shrink-0" />
          <span className="truncate">Undo: {lastSwimEdit.description}</span>
        </button>
      ) : null}
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
          onEditSwim={whatIfMode ? handleEditSwim : undefined}
          onAthleteSelect={handleAthleteSelect}
          onRequestDeleteSwimmer={onRequestDeleteSwimmer}
          onOpenRelays={() => setRosterStep('relays')}
          jumpAthleteName={jumpAthleteName}
          jumpAthleteKey={jumpAthleteKey}
          onJumpAthlete={handleJumpAthlete}
          onJumpAthleteHandled={handleJumpHandled}
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
