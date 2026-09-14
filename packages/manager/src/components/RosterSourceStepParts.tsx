/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Section components for RosterSourceStep — the "Add athletes" method picker
 * and the "Meet copy" status header. Split out so the step's top-level
 * return is a short sequence of sections instead of one long conditional
 * tree.
 */

import React from 'react';
import { FileCheck2, FileWarning } from 'lucide-react';
import { ClassYear, Gender, Recruit, Workspace } from '@omniswim/core/types';
import RecruitForm, { type RecruitAthletePrefill } from './RecruitForm';
import AthleteHistoryImportPanel from './AthleteHistoryImportPanel';

export type AddAthletesMethod = 'one' | 'swimcloud' | 'roster';

const METHOD_COPY: Record<AddAthletesMethod, { label: string; description: string }> = {
  one: { label: 'One athlete', description: 'Add a single event and time' },
  swimcloud: { label: 'From SwimCloud', description: "Import an athlete's best times" },
  roster: { label: 'A whole roster', description: 'Import a list of athletes' },
};

function MethodButton({
  method,
  active,
  onSelect,
}: {
  method: AddAthletesMethod;
  active: boolean;
  onSelect: () => void;
}) {
  const copy = METHOD_COPY[method];
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`rounded-lg border px-3 py-3 text-left transition-colors ${
        active
          ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/10 text-[var(--text-primary)]'
          : 'border-theme-soft surface-muted-bg text-theme-secondary theme-hover-row'
      }`}
    >
      <span className="block text-ui-label font-semibold">{copy.label}</span>
      <span className="block text-ui-caption mt-1">{copy.description}</span>
    </button>
  );
}

type AddAthletesSectionProps = {
  method: AddAthletesMethod;
  onSelectMethod: (method: AddAthletesMethod) => void;
  workspace: Workspace;
  gender: Gender;
  teams: string[];
  selectedTeam: string;
  onSelectTeam: (team: string) => void;
  scoringSettingsWhatIf: boolean;
  recruitPrefill: RecruitAthletePrefill | null;
  onAddRecruit: (recruit: Recruit) => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  onOpenImportWizard: () => void;
  onClassYearsChange: (overrides: Record<string, ClassYear>) => void;
};

/** The one-athlete / SwimCloud / whole-roster method picker and its selected panel. */
export function AddAthletesSection({
  method,
  onSelectMethod,
  workspace,
  gender,
  teams,
  selectedTeam,
  onSelectTeam,
  scoringSettingsWhatIf,
  recruitPrefill,
  onAddRecruit,
  onUpdate,
  onOpenImportWizard,
  onClassYearsChange,
}: AddAthletesSectionProps) {
  return (
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
        <MethodButton method="one" active={method === 'one'} onSelect={() => onSelectMethod('one')} />
        <MethodButton
          method="swimcloud"
          active={method === 'swimcloud'}
          onSelect={() => onSelectMethod('swimcloud')}
        />
        <MethodButton
          method="roster"
          active={method === 'roster'}
          onSelect={() => {
            onSelectMethod('roster');
            onOpenImportWizard();
          }}
        />
      </div>

      <div className="mt-5">
        {method === 'one' ? (
          <>
            <RecruitForm
              gender={gender}
              teams={teams}
              defaultTeam={selectedTeam || undefined}
              athletePrefill={recruitPrefill}
              onSubmit={onAddRecruit}
              disabled={!scoringSettingsWhatIf}
              compact
            />
            {recruitPrefill ? (
              <p className="text-ui-caption text-theme-secondary mt-3 leading-relaxed">
                Prefilling <span className="text-[var(--text-accent)]">{recruitPrefill.name}</span> &mdash;
                choose a new event and time, then inject.
              </p>
            ) : null}
          </>
        ) : null}

        <div className={method === 'swimcloud' ? undefined : 'hidden'}>
          <AthleteHistoryImportPanel
            workspace={workspace}
            gender={gender}
            team={selectedTeam}
            teams={teams}
            onTeamChange={onSelectTeam}
            onUpdate={onUpdate}
            importDisabled={!scoringSettingsWhatIf}
            onClassYearsChange={onClassYearsChange}
          />
        </div>

        {method === 'roster' ? (
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
  );
}

function MeetCopyStatusLine({ hasMeet, hasSource, pdfFilename }: { hasMeet: boolean; hasSource: boolean; pdfFilename?: string }) {
  if (!hasMeet) {
    return <>Upload a meet PDF in Matrix first &mdash; that becomes the frozen source for this roster.</>;
  }
  return (
    <>
      Using <span className="text-[var(--text-primary)] break-all">{pdfFilename}</span>
      {hasSource
        ? '. Baseline scores stay frozen while you edit the working roster.'
        : '. Source copy will backfill on the next save.'}
    </>
  );
}

export function MeetCopyHeader({
  hasMeet,
  hasSource,
  pdfFilename,
}: {
  hasMeet: boolean;
  hasSource: boolean;
  pdfFilename?: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          hasMeet ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]' : 'surface-muted-bg text-theme-muted'
        }`}
      >
        {hasMeet ? <FileCheck2 size={18} /> : <FileWarning size={18} />}
      </span>
      <div className="min-w-0">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Meet copy</h4>
        <p className="text-ui-body text-theme-secondary mt-1 leading-relaxed">
          <MeetCopyStatusLine hasMeet={hasMeet} hasSource={hasSource} pdfFilename={pdfFilename} />
        </p>
      </div>
    </div>
  );
}
