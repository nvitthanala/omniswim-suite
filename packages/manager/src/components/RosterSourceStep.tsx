/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { FileCheck2, FileWarning, Link2 } from 'lucide-react';
import { Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import RecruitForm, { type RecruitAthletePrefill } from './RecruitForm';
import RosterScoringSetup from './RosterScoringSetup';
import AthleteHistoryImportPanel from './AthleteHistoryImportPanel';

type Props = {
  workspace: Workspace;
  gender: Gender;
  teams: string[];
  selectedTeam: string;
  onSelectTeam: (team: string) => void;
  scoringSettings: ScoringSettings;
  whatIfMode: boolean;
  recruitPrefill: RecruitAthletePrefill | null;
  onAddRecruit: (recruit: Recruit) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
};

export default function RosterSourceStep({
  workspace,
  gender,
  teams,
  selectedTeam,
  onSelectTeam,
  scoringSettings,
  whatIfMode,
  recruitPrefill,
  onAddRecruit,
  onUpdate,
}: Props) {
  const hasMeet = Boolean(workspace.loadedMeet?.pdfFilename);
  const hasSource =
    (workspace.sourceMenResults?.length ?? 0) > 0 ||
    (workspace.sourceWomenResults?.length ?? 0) > 0 ||
    (workspace.menResults?.length ?? 0) > 0;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
      <div className="xl:col-span-5 flex flex-col gap-4 min-w-0">
        <section className="surface-card rounded-xl p-4 sm:p-5">
          <div className="flex items-start gap-3 mb-4">
            <span
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                hasMeet
                  ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                  : 'surface-muted-bg text-theme-muted'
              }`}
            >
              {hasMeet ? <FileCheck2 size={18} /> : <FileWarning size={18} />}
            </span>
            <div className="min-w-0">
              <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Meet copy</h4>
              <p className="text-ui-body text-theme-secondary mt-1 leading-relaxed">
                {hasMeet ? (
                  <>
                    Using{' '}
                    <span className="text-[var(--text-primary)] break-all">
                      {workspace.loadedMeet?.pdfFilename}
                    </span>
                    {hasSource
                      ? '. Baseline scores stay frozen while you edit the working roster.'
                      : '. Source copy will backfill on the next save.'}
                  </>
                ) : (
                  <>Upload a meet PDF in Matrix first — that becomes the frozen source for this roster.</>
                )}
              </p>
            </div>
          </div>

          {!whatIfMode ? (
            <p className="text-ui-caption rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 text-theme-secondary mb-4">
              Observe only — turn on What-if to edit imports, recruits, and scoring.
            </p>
          ) : null}

          <RosterScoringSetup workspace={workspace} settings={scoringSettings} onSave={onUpdate} />

          <div className="mt-4">
            <label className="block text-ui-caption text-theme-muted mb-1.5">Entry mode</label>
            <select
              value={workspace.entryPlanMode ?? 'overlay'}
              disabled={!whatIfMode}
              onChange={e => onUpdate({ entryPlanMode: e.target.value as 'overlay' | 'plan_sheet' })}
              className="glass-input w-full rounded-lg px-3 py-2 text-ui-body disabled:opacity-50"
            >
              <option value="overlay">Edit loaded meet (overlay)</option>
              <option value="plan_sheet">Plan sheet (replace team individuals)</option>
            </select>
          </div>
        </section>

        <section className="surface-card rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-1">
            <Link2 size={16} className="text-[var(--text-accent)] shrink-0" />
            <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Add a recruit</h4>
          </div>
          <p className="text-ui-body text-theme-secondary mb-4 leading-relaxed">
            Inject one event/time for a new or existing athlete. Prefer SwimCloud import when you have
            multiple bests.
          </p>
          <RecruitForm
            gender={gender}
            teams={teams}
            defaultTeam={selectedTeam || undefined}
            athletePrefill={recruitPrefill}
            onSubmit={onAddRecruit}
            disabled={!whatIfMode}
            compact
          />
          {recruitPrefill ? (
            <p className="text-ui-caption text-theme-secondary mt-3 leading-relaxed">
              Prefilling{' '}
              <span className="text-[var(--text-accent)]">{recruitPrefill.name}</span> — choose a new
              event and time, then inject.
            </p>
          ) : null}
        </section>
      </div>

      <div className="xl:col-span-7 min-w-0">
        <AthleteHistoryImportPanel
          workspace={workspace}
          gender={gender}
          team={selectedTeam}
          teams={teams}
          onTeamChange={onSelectTeam}
          onUpdate={onUpdate}
          importDisabled={!whatIfMode}
        />
      </div>
    </div>
  );
}
