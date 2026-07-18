/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import {
  buildTeamLineupAudit,
  suggestQuickFillForVacantLeg,
  type LineupChecklistItem,
} from '@omniswim/core/lib/rosterLineupAudit';
import { useToast } from '@omniswim/ui';
import TeamRosterPanel from './TeamRosterPanel';
import LineupComplianceChecklist from './LineupComplianceChecklist';

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
  onAthleteSelect?: (athlete: { name: string; team: string; classYear: string } | null) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  onOpenRelays?: () => void;
  jumpAthleteName?: string | null;
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
  onAthleteSelect,
  onRequestDeleteSwimmer,
  onOpenRelays,
  jumpAthleteName,
  onJumpAthleteHandled,
}: Props) {
  const toast = useToast();

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
        <div className="lg:col-span-8 flex flex-col min-h-0 min-w-0 order-2 lg:order-1">
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
            onAthleteSelect={onAthleteSelect}
            onRequestDeleteSwimmer={onRequestDeleteSwimmer}
            workspace={workspace}
            removeSeniors={removeSeniors}
            onWorkspaceUpdate={onUpdate}
            jumpAthleteName={jumpAthleteName}
            onJumpAthleteHandled={onJumpAthleteHandled}
          />
        </div>
        <div className="order-1 lg:order-2 lg:col-span-4">
          <LineupComplianceChecklist
            audit={audit}
            onJumpAthlete={name => {
              onAthleteSelect?.({ name, team: selectedTeam, classYear: '' });
            }}
            onFixItem={whatIfMode ? handleFixItem : undefined}
            onOpenRelays={onOpenRelays}
          />
        </div>
      </div>
    </div>
  );
}
