/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ClassYear, Gender, Recruit, ScoringSettings, Workspace } from '@omniswim/core/types';
import { type RecruitAthletePrefill } from './RecruitForm';
import RosterScoringSetup from './RosterScoringSetup';
import ScoringTheoryPanel from './ScoringTheoryPanel';
import LoadMeetHereCard from './LoadMeetHereCard';
import BaselineDiffPanel from './BaselineDiffPanel';
import WorkingCopyChangesPanel from './WorkingCopyChangesPanel';
import { AddAthletesSection, MeetCopyHeader, type AddAthletesMethod } from './RosterSourceStepParts';

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
        <AddAthletesSection
          method={addAthletesMethod}
          onSelectMethod={setAddAthletesMethod}
          workspace={workspace}
          gender={gender}
          teams={teams}
          selectedTeam={selectedTeam}
          onSelectTeam={onSelectTeam}
          scoringSettingsWhatIf={whatIfMode}
          recruitPrefill={recruitPrefill}
          onAddRecruit={onAddRecruit}
          onUpdate={onUpdate}
          onOpenImportWizard={onOpenImportWizard}
          onClassYearsChange={setClassYearOverrides}
        />
      </div>

      <div className="xl:col-span-5 flex flex-col gap-4 min-w-0">
        <section className="surface-card rounded-xl p-4 sm:p-5">
          <MeetCopyHeader hasMeet={hasMeet} hasSource={hasSource} pdfFilename={workspace.loadedMeet?.pdfFilename} />

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

        {hasSource ? (
          <BaselineDiffPanel
            workspace={workspace}
            gender={gender}
            team={selectedTeam}
            scoringSettings={scoringSettings}
          />
        ) : null}

        <WorkingCopyChangesPanel
          workspace={workspace}
          gender={gender}
          onUpdate={onUpdate}
          disabled={!whatIfMode}
        />

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
