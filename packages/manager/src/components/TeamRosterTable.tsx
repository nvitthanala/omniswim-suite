/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Roster table body for TeamRosterPanel — the windowed row list, split out
 * so the panel's own function body isn't where the per-row branching lives.
 * Takes the already-computed `rosterWindow` slice (virtualization stays a
 * parent-owned useMemo per PERFORMANCE_NOTES #2) and renders it.
 */
import type { Gender, ScoringSettings, SwimmerResult, Workspace } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import type { TeamLineupAudit } from '@omniswim/core/lib/rosterLineupAudit';
import type { buildAliasResolver } from '@omniswim/core/lib/athleteAliases';
import type { HistoricalSwim } from '@omniswim/core/types';
import TeamRosterRow from './TeamRosterRow';
import { buildRosterRowViewModel, describeStrongestEvents, isUniformSwimmerRoster } from './teamRosterView';

type RosterWindow = {
  rows: ScorerRosterRow[];
  start: number;
  topSpacer: number;
  bottomSpacer: number;
};

type Props = {
  teams: string[];
  selectedTeam: string;
  teamRows: ScorerRosterRow[];
  rosterWindow: RosterWindow;
  colSpan: number;
  editable: boolean;
  selectedAthleteKey: string | null;
  pointTotals: Map<string, number>;
  genderResults: SwimmerResult[];
  gender: Gender;
  aliasResolver: ReturnType<typeof buildAliasResolver>;
  settings: ScoringSettings;
  lineupAudit?: TeamLineupAudit;
  workspace?: Workspace;
  mergedAthleteHistory: HistoricalSwim[];
  onSelectRow: (row: ScorerRosterRow) => void;
  onSetScorer: (row: ScorerRosterRow, isScorer: boolean) => void;
};

export default function TeamRosterTable({
  teams,
  selectedTeam,
  teamRows,
  rosterWindow,
  colSpan,
  editable,
  selectedAthleteKey,
  pointTotals,
  genderResults,
  gender,
  aliasResolver,
  settings,
  lineupAudit,
  workspace,
  mergedAthleteHistory,
  onSelectRow,
  onSetScorer,
}: Props) {
  // Judged over the whole team, not the visible window, so scrolling cannot flip it.
  const hideSwimmerTag = isUniformSwimmerRoster(teamRows);
  return (
    <table className="w-full">
      <thead className="sticky top-0 surface-muted-bg z-[1]">
        <tr className="text-ui-caption text-theme-muted border-b border-theme-soft">
          <th className="text-left py-2.5 px-3 font-medium">Athlete</th>
          <th className="text-right py-2.5 px-3 font-medium w-20">Class</th>
          <th className="text-right py-2.5 px-3 font-medium w-24">Meet pts</th>
          {editable ? (
            <th className="text-center py-2.5 px-3 font-medium w-20">Scorer</th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {!selectedTeam || teamRows.length === 0 ? (
          <tr>
            <td colSpan={colSpan + 1} className="py-4 text-center text-ui-caption text-theme-muted italic">
              {teams.length ? 'No athletes for this team' : 'Upload results to populate teams'}
            </td>
          </tr>
        ) : (
          <>
            {rosterWindow.topSpacer > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={colSpan + 1} style={{ height: rosterWindow.topSpacer }} />
              </tr>
            ) : null}
            {rosterWindow.rows.map(row => {
              const viewModel = buildRosterRowViewModel(row, {
                genderResults,
                gender,
                aliasResolver,
                settings,
                lineupAudit,
                workspace,
                hasSelectedTeam: Boolean(selectedTeam),
                mergedAthleteHistory,
                pointTotals,
              });
              const isSelected = selectedAthleteKey === row.key;
              return (
                <TeamRosterRow
                  key={row.key}
                  row={row}
                  meetPts={viewModel.meetPts}
                  isSelected={isSelected}
                  profile={viewModel.profile}
                  describeProfile={describeStrongestEvents}
                  warningMessages={viewModel.warningMessages}
                  warningLabel={viewModel.warningLabel}
                  editable={editable}
                  hideSwimmerTag={hideSwimmerTag}
                  onSelect={() => onSelectRow(row)}
                  onSetScorer={isScorer => onSetScorer(row, isScorer)}
                />
              );
            })}
            {rosterWindow.bottomSpacer > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={colSpan + 1} style={{ height: rosterWindow.bottomSpacer }} />
              </tr>
            ) : null}
          </>
        )}
      </tbody>
    </table>
  );
}
