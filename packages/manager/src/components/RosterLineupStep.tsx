/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import {
  buildTeamLineupAudit,
  suggestQuickFillForVacantLeg,
  type LineupChecklistItem,
} from '@omniswim/core/lib/rosterLineupAudit';
import { SegmentedControl, useToast } from '@omniswim/ui';
import TeamRosterPanel from './TeamRosterPanel';
import DuplicateAthletesPanel from './DuplicateAthletesPanel';
import type { EditCreditedSwimValues } from './AthleteCreditedSwimsPanel';
import LineupComplianceChecklist from './LineupComplianceChecklist';
import CrossCourseArbitragePanel from './CrossCourseArbitragePanel';
import ScenarioSnapshotsPanel from './ScenarioSnapshotsPanel';

type SidePanelTab = 'checklist' | 'arbitrage' | 'scenarios';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  scoringSettings: ScoringSettings;
  baselineByTeam: Map<string, number>;
  projectedByTeam: Map<string, number>;
  whatIfMode: boolean;
  removeSeniors: boolean;
  selectedTeam: string;
  onSelectTeam: (team: string) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
  onEditSwim?: (swim: AthleteCreditedSwim, changes: EditCreditedSwimValues) => void;
  onAthleteSelect?: (athlete: { name: string; team: string; classYear: string } | null) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  onOpenRelays?: () => void;
  jumpAthleteName?: string | null;
  jumpAthleteKey?: string | null;
  /** Jump from checklist/arbitrage: carries the athlete's roster key when known. */
  onJumpAthlete?: (name: string, key?: string) => void;
  onJumpAthleteHandled?: () => void;
};

export default function RosterLineupStep({
  workspace,
  gender,
  scoringBundle,
  scoringSettings,
  baselineByTeam,
  projectedByTeam,
  whatIfMode,
  removeSeniors,
  selectedTeam,
  onSelectTeam,
  onUpdate,
  onDeleteSwim,
  onEditSwim,
  onAthleteSelect,
  onRequestDeleteSwimmer,
  onOpenRelays,
  jumpAthleteName,
  jumpAthleteKey,
  onJumpAthlete,
  onJumpAthleteHandled,
}: Props) {
  const toast = useToast();
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>('checklist');

  const audit = useMemo(() => {
    if (!selectedTeam) {
      return {
        athleteIssues: new Map(),
        checklistItems: [] as LineupChecklistItem[],
        vacantRelayLegCount: 0,
      };
    }
    return buildTeamLineupAudit({
      workspace,
      gender,
      team: selectedTeam,
      settings: scoringSettings,
      allResults: scoringBundle.allResults,
      allScored: scoringBundle.allScored,
      removeSeniors,
    });
  }, [
    workspace,
    gender,
    selectedTeam,
    scoringSettings,
    scoringBundle.allResults,
    scoringBundle.allScored,
    removeSeniors,
  ]);

  const handleFixItem = (item: LineupChecklistItem) => {
    if (!whatIfMode || !selectedTeam) return;
    if (item.relayEntryKey == null || item.legIndex == null) {
      onOpenRelays?.();
      return;
    }
    const suggestion = suggestQuickFillForVacantLeg(
      workspace,
      gender,
      selectedTeam,
      item.relayEntryKey,
      item.legIndex,
      scoringBundle.allResults.filter(r => !r.isRelay)
    );
    if (!suggestion) {
      toast.push(
        'info',
        'No eligible scorer found to fill this leg — open Relays to assign manually.'
      );
      onOpenRelays?.();
      return;
    }
    onUpdate({ relayLegOverrides: suggestion.overrides });
    toast.push('success', suggestion.message);
  };

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {!whatIfMode ? (
        <p className="text-ui-caption rounded-xl border border-theme-soft surface-muted-bg px-4 py-2.5 text-theme-secondary shrink-0">
          Observe only — enable What-if to toggle scorers, edit entries, or remove athletes.
        </p>
      ) : (
        <p className="text-ui-body text-theme-secondary shrink-0 leading-relaxed">
          Select a team and athlete. Edit scorers and individual entries together. Non-scorers are
          removed from relay legs automatically — fill gaps on Relays. Watch the checklist for
          over-limit, empty lineup, and vacant relay warnings.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0 items-start">
        <div className="lg:col-span-9 flex flex-col min-h-0 min-w-0 order-2 lg:order-1">
          <DuplicateAthletesPanel
            workspace={workspace}
            gender={gender}
            team={selectedTeam || undefined}
            onUpdate={onUpdate}
            editable={whatIfMode}
          />
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
            showTeamSidebar={false}
            teamPickerMode="dropdown"
            editorMode="unified"
            lineupAudit={audit}
            expanded
            selectedTeam={selectedTeam || undefined}
            onSelectTeam={onSelectTeam}
            onDeleteSwim={onDeleteSwim}
            onEditSwim={onEditSwim}
            onAthleteSelect={onAthleteSelect}
            onRequestDeleteSwimmer={onRequestDeleteSwimmer}
            workspace={workspace}
            removeSeniors={removeSeniors}
            onWorkspaceUpdate={onUpdate}
            jumpAthleteName={jumpAthleteName}
            jumpAthleteKey={jumpAthleteKey}
            onJumpAthleteHandled={onJumpAthleteHandled}
          />
        </div>
        <div className="order-1 lg:order-2 lg:col-span-3 flex flex-col gap-3 min-w-0">
          <SegmentedControl
            ariaLabel="Lineup side panel"
            value={sidePanelTab}
            onChange={setSidePanelTab}
            options={[
              {
                value: 'checklist',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    Checklist
                    {audit.checklistItems.length > 0 ? (
                      <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-amber-400/20 text-amber-400 text-ui-micro font-mono normal-case tracking-normal">
                        {audit.checklistItems.length}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              { value: 'arbitrage', label: 'Arbitrage' },
              { value: 'scenarios', label: 'Scenarios' },
            ]}
          />
          {sidePanelTab === 'checklist' ? (
            <LineupComplianceChecklist
              audit={audit}
              onJumpAthlete={(name, key) => {
                if (onJumpAthlete) onJumpAthlete(name, key);
                else onAthleteSelect?.({ name, team: selectedTeam, classYear: '' });
              }}
              onFixItem={whatIfMode ? handleFixItem : undefined}
              onOpenRelays={onOpenRelays}
            />
          ) : null}
          {sidePanelTab === 'arbitrage' ? (
            <CrossCourseArbitragePanel
              workspace={workspace}
              gender={gender}
              team={selectedTeam}
              settings={scoringSettings}
              onJumpAthlete={name =>
                onJumpAthlete
                  ? onJumpAthlete(name)
                  : onAthleteSelect?.({ name, team: selectedTeam, classYear: '' })
              }
              onUpdate={onUpdate}
              canApply={whatIfMode}
            />
          ) : null}
          {sidePanelTab === 'scenarios' ? (
            <ScenarioSnapshotsPanel
              workspace={workspace}
              team={selectedTeam}
              projectedTotal={selectedTeam ? projectedByTeam.get(selectedTeam) : undefined}
              onUpdate={onUpdate}
              editable={whatIfMode}
              gender={gender}
              scoringSettings={scoringSettings}
              removeSeniors={removeSeniors}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
