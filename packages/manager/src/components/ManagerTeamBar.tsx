/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one team control for the Manager wizard. It sits under the step tabs and
 * is the only place that writes the selected team (`onSelectTeam`). Every step
 * reads the team from here; none of them renders its own team select.
 */

import React, { useId } from 'react';
import { TeamSelect } from '@omniswim/ui';

type Props = {
  /** Scoreable teams, in display order. */
  teams: string[];
  selectedTeam: string;
  onSelectTeam: (team: string) => void;
};

export default function ManagerTeamBar({ teams, selectedTeam, onSelectTeam }: Props) {
  const selectId = useId();
  return (
    <div
      role="group"
      aria-label="Team for this roster"
      className="surface-card rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <label htmlFor={selectId} className="text-ui-label font-semibold text-[var(--text-primary)]">
        Team
      </label>
      <TeamSelect
        id={selectId}
        teams={teams}
        value={selectedTeam}
        onChange={event => onSelectTeam(event.target.value)}
        disabled={teams.length === 0}
        emptyTeamsLabel="No teams yet"
        className="glass-input min-w-[14rem] max-w-full rounded-lg px-3 py-2 text-ui-body disabled:opacity-50"
      />
      <span className="text-ui-caption text-theme-muted">
        {teams.length === 0
          ? 'Add athletes or load a meet to get a team.'
          : 'Every step below works on this team.'}
      </span>
    </div>
  );
}
