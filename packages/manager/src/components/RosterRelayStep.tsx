/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Roster wizard Relays step — wraps Ind/Relay management.
 */

import React from 'react';
import { FileWarning } from 'lucide-react';
import { Gender, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { EmptyState } from '@omniswim/ui';
import IndRelayManagementView from './IndRelayManagementView';
import TeamPickerEmptyState from './TeamPickerEmptyState';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  whatIfMode: boolean;
  removeSeniors: boolean;
  selectedTeam: string;
  onUpdate: (patch: Partial<Workspace>) => void;
};

export default function RosterRelayStep({
  workspace,
  gender,
  scoringBundle,
  whatIfMode,
  removeSeniors,
  selectedTeam,
  onUpdate,
}: Props) {
  // "Nothing to work with" is no scoreable TEAM, not no meet PDF. A workspace
  // can be recruit-driven -- SwimCloud imports and planned entries with no meet
  // loaded -- and still have a full roster to build, which is the HSU planning
  // workflow. Keying this off menResults blocked that path entirely.
  const hasRoster = scoringBundle.sortedTeams.length > 0;

  if (!hasRoster) {
    return (
      <EmptyState
        icon={<FileWarning size={28} />}
        eyebrow="Relays"
        title="Bring in swimmers first"
        description="Load a meet or import swimmers on the Athletes step to build this relay plan."
      />
    );
  }

  if (!selectedTeam) {
    return (
      <TeamPickerEmptyState
        eyebrow="Relays"
        title="Choose a team for relays"
        description="Use the team bar above to pick the team whose relay legs you want to assign and review."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {!whatIfMode ? (
        <p className="text-ui-caption text-theme-secondary rounded-xl border border-theme-soft surface-muted-bg px-4 py-2.5 shrink-0">
          Observe only — enable What-if to edit relay assignments.
        </p>
      ) : null}
      <IndRelayManagementView
        workspace={workspace}
        gender={gender}
        scoringBundle={scoringBundle}
        whatIfMode={whatIfMode}
        removeSeniors={removeSeniors}
        onUpdate={onUpdate}
        selectedTeam={selectedTeam || undefined}
        hideTeamPicker
      />
    </div>
  );
}
