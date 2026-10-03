/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Title row, optimizer/reset actions, score summary and (dropdown mode) team
 * select for TeamRosterPanel's roster table — split out of the panel body.
 */
import { Users, RotateCcw, Sparkles } from 'lucide-react';
import { Button, TeamSelect } from '@omniswim/ui';
import ProjectedActualScore from './ProjectedActualScore';

type Props = {
  selectedTeam: string;
  genderLabel: string;
  editable: boolean;
  /** Open the Optimize step. Omit to hide the link. */
  onOpenOptimize?: () => void;
  onResetTeam: () => void;
  maxIndividualScorersPerTeam: number;
  selectedActual: number | undefined;
  selectedBaseline: number | undefined;
  selectedProjected: number;
  eventThrough?: number;
  useDropdown: boolean;
  teams: string[];
  controlledTeam?: string;
  onSelectTeam: (team: string) => void;
};

export default function TeamRosterHeader({
  selectedTeam,
  genderLabel,
  editable,
  onOpenOptimize,
  onResetTeam,
  maxIndividualScorersPerTeam,
  selectedActual,
  selectedBaseline,
  selectedProjected,
  eventThrough,
  useDropdown,
  teams,
  controlledTeam,
  onSelectTeam,
}: Props) {
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-3">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2 min-w-0">
          <Users size={16} className="shrink-0 text-[var(--text-accent)]" />
          <span className="truncate" title={selectedTeam || 'Team roster'}>
            {selectedTeam || 'Team roster'}
          </span>
          <span className="text-theme-muted font-normal shrink-0">{genderLabel}</span>
        </h4>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 shrink-0">
          {onOpenOptimize ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenOptimize}
              disabled={!selectedTeam}
              className="text-[var(--text-accent)] hover:underline whitespace-nowrap"
              title="Open the Optimize step for this team"
              leadingIcon={<Sparkles size={12} />}
            >
              Optimize this lineup
            </Button>
          ) : null}
          {editable ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetTeam}
              className="text-theme-secondary hover:text-[var(--text-accent)] whitespace-nowrap"
              title="Revert manual edits for this team"
              leadingIcon={<RotateCcw size={12} />}
            >
              Reset team
            </Button>
          ) : null}
        </div>
      </div>

      {selectedTeam ? (
        <ProjectedActualScore
          actual={selectedActual}
          baseline={selectedBaseline}
          projected={selectedProjected}
          eventThrough={eventThrough}
        />
      ) : null}

      <p className="text-ui-body text-theme-secondary my-3 leading-relaxed">
        Click an athlete to edit scorers, individual entries, and see relay status.
        {editable ? ` Toggle scorers for the ${maxIndividualScorersPerTeam}-scorer cap.` : ' Enable What-if to edit scorers.'}
        {' '}
        <kbd className="px-1 rounded border border-theme-soft bg-[var(--surface-muted)] text-ui-micro font-mono">
          ↑↓
        </kbd>{' '}
        to navigate.
      </p>
      {useDropdown ? (
        <label className="block mb-3">
          <span className="block text-ui-caption text-theme-muted mb-1.5">Team</span>
          <TeamSelect
            teams={teams}
            className="glass-input w-full rounded-lg px-3 py-2 text-ui-body"
            value={selectedTeam}
            onChange={e => onSelectTeam(e.target.value)}
            disabled={!teams.length}
            emptyTeamsLabel="No teams in matrix"
            showPlaceholder={!controlledTeam || !teams.includes(controlledTeam)}
          />
        </label>
      ) : null}
    </>
  );
}
