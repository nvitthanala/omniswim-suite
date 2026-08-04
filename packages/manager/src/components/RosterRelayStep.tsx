/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Roster wizard Relays step — wraps Ind/Relay management.
 */

import React from 'react';
import { Gender, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import IndRelayManagementView from './IndRelayManagementView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  whatIfMode: boolean;
  removeSeniors: boolean;
  selectedTeam: string;
  teams: string[];
  onSelectTeam: (team: string) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
};

export default function RosterRelayStep({
  workspace,
  gender,
  scoringBundle,
  whatIfMode,
  removeSeniors,
  selectedTeam,
  teams,
  onSelectTeam,
  onUpdate,
}: Props) {
  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="surface-card rounded-xl p-4 sm:p-5 shrink-0 space-y-3">
        <p className="text-ui-body text-theme-secondary leading-relaxed max-w-3xl">
          Fill vacant relay legs flagged in Lineup before optimizing. Non-scorers cannot occupy
          relay legs — assign a scorer or rebuild from the individual lineup.
        </p>
        <label className="flex flex-col gap-1.5 max-w-md">
          <span className="text-ui-caption text-theme-muted">Team</span>
          <select
            value={selectedTeam}
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
        {!whatIfMode ? (
          <p className="text-ui-caption text-theme-secondary rounded-lg border border-theme-soft surface-muted-bg px-3 py-2">
            Observe only — enable What-if to edit relay assignments.
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
        selectedTeam={selectedTeam || undefined}
        onSelectTeam={onSelectTeam}
        hideTeamPicker
      />
    </div>
  );
}
