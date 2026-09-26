/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wraps the roster table in either the plain-card layout or the team-sidebar
 * grid layout, plus the athlete drawer sibling both share. Split out of
 * TeamRosterPanel so that branch isn't in the panel's own function body.
 */
import type { ReactNode } from 'react';
import TeamRosterSidebar from './TeamRosterSidebar';

type Props = {
  useSidebar: boolean;
  expanded: boolean;
  rosterTable: ReactNode;
  drawer: ReactNode;
  teams: string[];
  memberCounts: Map<string, number>;
  projectedByTeam: Map<string, number>;
  officialLookup: Map<string, number | undefined>;
  selectedTeam: string;
  onSelectTeam: (team: string) => void;
};

export default function TeamRosterLayoutShell({
  useSidebar,
  expanded,
  rosterTable,
  drawer,
  teams,
  memberCounts,
  projectedByTeam,
  officialLookup,
  selectedTeam,
  onSelectTeam,
}: Props) {
  if (!useSidebar) {
    return (
      <>
        <div className={`surface-card rounded-xl p-4 sm:p-5 ${expanded ? 'flex flex-col flex-1 min-h-0' : ''}`}>
          {rosterTable}
        </div>
        {drawer}
      </>
    );
  }

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-12 gap-4 ${expanded ? 'flex-1 min-h-0' : ''}`}>
      <TeamRosterSidebar
        teams={teams}
        memberCounts={memberCounts}
        projectedByTeam={projectedByTeam}
        officialLookup={officialLookup}
        selectedTeam={selectedTeam}
        expanded={expanded}
        onSelectTeam={onSelectTeam}
      />
      <div
        className={`lg:col-span-9 surface-card rounded-xl p-4 sm:p-5 flex flex-col min-h-0 ${
          expanded ? 'lg:h-full' : ''
        }`}
      >
        {rosterTable}
      </div>
      {drawer}
    </div>
  );
}
