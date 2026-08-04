/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { FileCheck2, FileWarning } from 'lucide-react';
import { ClassYear, Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import RecruitForm, { type RecruitAthletePrefill } from './RecruitForm';
import RosterScoringSetup from './RosterScoringSetup';
import AthleteHistoryImportPanel from './AthleteHistoryImportPanel';
import ScoringTheoryPanel from './ScoringTheoryPanel';
import LoadMeetHereCard from './LoadMeetHereCard';

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
  onOpenImportWizard: () => void;
};

type AddAthletesMethod = 'one' | 'swimcloud' | 'roster';

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
  onOpenImportWizard,
}: Props) {
  const [classYearOverrides, setClassYearOverrides] = useState<Record<string, ClassYear>>({});
  const [addAthletesMethod, setAddAthletesMethod] = useState<AddAthletesMethod>('one');
  const hasMeet = Boolean(workspace.loadedMeet?.pdfFilename);
  const hasSource =
    (workspace.sourceMenResults?.length ?? 0) > 0 ||
    (workspace.sourceWomenResults?.length ?? 0) > 0 ||
    (workspace.menResults?.length ?? 0) > 0;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
      <div className="xl:col-span-7 flex flex-col gap-4 min-w-0">
        <section className="surface-card rounded-xl p-4 sm:p-5">
          <div className="mb-4">
            <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Add athletes</h4>
            <p className="text-ui-body text-theme-secondary mt-1 leading-relaxed">
              Choose the way you want to bring swimmers into this roster.
            </p>
          </div>

          <div
            role="group"
            className="grid grid-cols-1 sm:grid-cols-3 gap-2"
            aria-label="How would you like to add athletes?"
          >
            <button
              type="button"
              aria-pressed={addAthletesMethod === 'one'}
              onClick={() => setAddAthletesMethod('one')}
              className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                addAthletesMethod === 'one'
                  ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/10 text-[var(--text-primary)]'
                  : 'border-theme-soft surface-muted-bg text-theme-secondary theme-hover-row'
              }`}
            >
              <span className="block text-ui-label font-semibold">One athlete</span>
              <span className="block text-ui-caption mt-1">Add a single event and time</span>
            </button>
            <button
              type="button"
              aria-pressed={addAthletesMethod === 'swimcloud'}
              onClick={() => setAddAthletesMethod('swimcloud')}
              className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                addAthletesMethod === 'swimcloud'
                  ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/10 text-[var(--text-primary)]'
                  : 'border-theme-soft surface-muted-bg text-theme-secondary theme-hover-row'
              }`}
            >
              <span className="block text-ui-label font-semibold">From SwimCloud</span>
              <span className="block text-ui-caption mt-1">Import an athlete&apos;s best times</span>
            </button>
            <button
              type="button"
              aria-pressed={addAthletesMethod === 'roster'}
              onClick={() => {
                setAddAthletesMethod('roster');
                onOpenImportWizard();
              }}
              className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                addAthletesMethod === 'roster'
                  ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/10 text-[var(--text-primary)]'
                  : 'border-theme-soft surface-muted-bg text-theme-secondary theme-hover-row'
              }`}
            >
              <span className="block text-ui-label font-semibold">A whole roster</span>
              <span className="block text-ui-caption mt-1">Import a list of athletes</span>
            </button>
          </div>

          <div className="mt-5">
            {addAthletesMethod === 'one' ? (
              <>
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
                    <span className="text-[var(--text-accent)]">{recruitPrefill.name}</span> &mdash; choose a
                    new event and time, then inject.
                  </p>
                ) : null}
              </>
            ) : null}

            <div className={addAthletesMethod === 'swimcloud' ? undefined : 'hidden'}>
              <AthleteHistoryImportPanel
                workspace={workspace}
                gender={gender}
                team={selectedTeam}
                teams={teams}
                onTeamChange={onSelectTeam}
                onUpdate={onUpdate}
                importDisabled={!whatIfMode}
                onClassYearsChange={setClassYearOverrides}
              />
            </div>

            {addAthletesMethod === 'roster' ? (
              <div className="rounded-lg border border-theme-soft surface-muted-bg p-4">
                <p className="text-ui-body text-theme-secondary leading-relaxed">
                  Import a list of athletes with the roster import wizard.
                </p>
                <button
                  type="button"
                  onClick={onOpenImportWizard}
                  className="mt-3 px-3 py-2 text-ui-label font-semibold rounded-lg btn-primary transition-colors"
                >
                  Open roster import
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>

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
                  <>Upload a meet PDF in Matrix first &mdash; that becomes the frozen source for this roster.</>
                )}
              </p>
            </div>
          </div>

          {!whatIfMode ? (
            <p className="text-ui-caption rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 text-theme-secondary mb-4">
              Observe only &mdash; turn on What-if to edit imports, recruits, and scoring.
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

        <LoadMeetHereCard workspace={workspace} onUpdate={onUpdate} whatIfMode={whatIfMode} />

        <ScoringTheoryPanel
          workspace={workspace}
          gender={gender}
          team={selectedTeam}
          classYearOverrides={Object.keys(classYearOverrides).length > 0 ? classYearOverrides : undefined}
          onUpdate={onUpdate}
          applyDisabled={!whatIfMode}
        />
      </div>
    </div>
  );
}
