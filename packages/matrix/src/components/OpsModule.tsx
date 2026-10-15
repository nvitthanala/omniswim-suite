/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, ClipboardPaste, ExternalLink, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Gender, Workspace } from '@omniswim/core/types';
import { presetIdForConference } from '@omniswim/core/lib/scoringDefaults';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import {
  useToast,
  WizardShell,
  SwimCloudCaptureBrowser,
  type WizardStep,
} from '@omniswim/ui';
import MeetOperationsView from './MeetOperationsView';
import SwimmerDeleteConfirmModal from './SwimmerDeleteConfirmModal';
import { SwimCloudImportDiagnosticsPanel } from './SwimCloudImportDiagnosticsPanel';
import { PdfImportNoticePanel } from './PdfImportNoticePanel';
import { type MatrixStepId } from './matrixStepState';
import { hasRosterEdits, type OpsImportContext } from './opsModuleHelpers';
import { usePdfMeetImport } from './usePdfMeetImport';
import { usePsychPdfImport } from './usePsychPdfImport';
import { useSwimCloudMeetImport } from './useSwimCloudMeetImport';
import { useCopyMeetFromWorkspace, useMatrixStep, useSwimmerDeleteFlow } from './useOpsMeetActions';

interface Props {
  workspace: Workspace;
  gender: Gender;
  onUpdate: (updated: Partial<Workspace>) => void | Promise<void>;
}

const MATRIX_STEPS: WizardStep<MatrixStepId>[] = [
  { id: 'meet', label: 'Meet', title: 'Bring in the meet', hint: 'Load results, link a psych sheet and check the scoring rules.', icon: <ClipboardPaste size={16} /> },
  { id: 'standings', label: 'Standings', title: 'See where teams land', hint: 'Review the projected team order and the swims behind each total.', icon: <Trophy size={16} /> },
  { id: 'analyze', label: 'Analyze', title: 'Explain the result', hint: 'Trace score changes, momentum, and differences from prelims.', icon: <Activity size={16} /> },
];

export default function OpsModule({ workspace, gender, onUpdate }: Props) {
  const toast = useToast();
  const { workspaces } = useSuiteWorkspace();
  const [searchQuery, setSearchQuery] = useState('');
  const [removeSeniors, _setRemoveSeniors] = useState(false);
  const [pdfFormat, setPdfFormat] = useState('auto');
  const [suggestedPresetId, setSuggestedPresetId] = useState<string | null>(() =>
    presetIdForConference(workspace.conference)
  );
  const [whatIfMode, _setWhatIfMode] = useState(false);
  const { step, setStep } = useMatrixStep(workspace);
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);

  const scoring = useWorkspaceScoring({
    workspace,
    gender,
    removeSeniors,
    scoringRefreshKey,
  });

  const importCtx: OpsImportContext = {
    workspace,
    onUpdate,
    toast,
    bumpScoringRefresh: () => setScoringRefreshKey(k => k + 1),
    setSuggestedPresetId,
  };
  const pdfImport = usePdfMeetImport(importCtx, pdfFormat);
  const psychImport = usePsychPdfImport(importCtx, pdfFormat);
  const swimCloud = useSwimCloudMeetImport(importCtx);
  const deleteFlow = useSwimmerDeleteFlow(workspace, gender, onUpdate);
  const copyMeetFromWorkspace = useCopyMeetFromWorkspace(importCtx, workspaces);

  const { pdfImportNotice, setPdfImportNotice } = pdfImport;
  const { importDiagnostics, setImportDiagnostics } = swimCloud;
  const { swimmerDeleteCandidate, setSwimmerDeleteCandidate } = deleteFlow;
  const rosterDirty = hasRosterEdits(workspace);

  return (
    <>
      {pdfImportNotice ? (
        <div className="mb-3">
          <PdfImportNoticePanel notice={pdfImportNotice} onDismiss={() => setPdfImportNotice(null)} />
        </div>
      ) : null}
      {importDiagnostics ? (
        <div className="mb-3">
          <SwimCloudImportDiagnosticsPanel
            skipped={importDiagnostics.skipped}
            warnings={importDiagnostics.warnings}
            rawWarnings={importDiagnostics.rawWarnings}
            onDismiss={() => setImportDiagnostics(null)}
          />
        </div>
      ) : null}
      <WizardShell
        steps={MATRIX_STEPS}
        eyebrow="Meet workflow"
        ariaLabel="Meet workflow steps"
        step={step}
        onStepChange={setStep}
        toolbar={<>
          {rosterDirty ? (
            <Link
              to="/manager"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-ui-micro font-bold rounded-md border border-[var(--text-accent)]/30 text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
            >
              Edit roster in Manager
              <ExternalLink size={12} />
            </Link>
          ) : null}
        </>}
      >
        <AnimatePresence mode="wait">
          <motion.div
          key={step}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          <MeetOperationsView
            activeStep={step}
            workspace={workspace}
            workspaceMeetSources={workspaces.filter(candidate => candidate.id !== workspace.id)}
            onCopyMeetFromWorkspace={copyMeetFromWorkspace}
            gender={gender}
            scoringBundle={scoring.projected}
            baselineBundle={scoring.baseline}
            prelimsProjectedBundle={scoring.prelimsProjected}
            psychProjectedBundle={scoring.psychProjected}
            baselineByTeam={scoring.baselineByTeam}
            prelimsByTeam={scoring.prelimsByTeam}
            psychByTeam={scoring.psychByTeam}
            prelimsWithoutExpectationByTeam={scoring.prelimsWithoutExpectationByTeam}
            psychWithoutExpectationByTeam={scoring.psychWithoutExpectationByTeam}
            prelimsDeltaTimeline={scoring.prelimsDeltaTimeline}
            psychDeltaTimeline={scoring.psychDeltaTimeline}
            showPrelimsPerformance={scoring.showPrelimsPerformance}
            showPsychPerformance={scoring.showPsychPerformance}
            prelimsOuByEntry={scoring.prelimsOuByEntry}
            psychOuByEntry={scoring.psychOuByEntry}
            scoringSettings={scoring.scoringSettings}
            suggestedPresetId={suggestedPresetId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            whatIfMode={whatIfMode}
            isParsingPdf={pdfImport.isParsingPdf}
            isParsingPsychPdf={psychImport.isParsingPsychPdf}
            pdfFormat={pdfFormat}
            onPdfFormatChange={setPdfFormat}
            onFileUpload={pdfImport.handleFileUpload}
            onBrowseSwimCloudCaptures={() => swimCloud.setShowSwimCloudCaptureBrowser(true)}
            onPsychFileUpload={psychImport.handlePsychFileUpload}
            onCancelPdfParse={pdfImport.cancelPdfParse}
            onCancelPsychPdfParse={psychImport.cancelPsychPdfParse}
            onUpdate={onUpdate}
            onRequestDeleteSwimmer={
              whatIfMode ? name => setSwimmerDeleteCandidate({ name }) : undefined
            }
            onSaveScoringSettings={sets => void onUpdate({ scoringSettings: sets })}
            onClearSuggestedPreset={() => setSuggestedPresetId(null)}
            scoringRefreshKey={scoringRefreshKey}
          />
          </motion.div>
        </AnimatePresence>
      </WizardShell>
      {swimmerDeleteCandidate && (
        <SwimmerDeleteConfirmModal
          swimmerName={swimmerDeleteCandidate.name}
          gender={gender}
          onConfirm={deleteFlow.confirmDeleteSwimmer}
          onCancel={() => setSwimmerDeleteCandidate(null)}
        />
      )}
      {swimCloud.showSwimCloudCaptureBrowser && (
        <SwimCloudCaptureBrowser
          mode="meet-results"
          onClose={() => swimCloud.setShowSwimCloudCaptureBrowser(false)}
          onImportMeetResults={swimCloud.handleSwimCloudBrowserImport}
          pasteFallback={{
            label: 'or paste a single page instead',
            hint: 'Reads one SwimCloud meet-results page from the clipboard ("Copy for Omniswim" on that page first).',
            onPaste: () => void swimCloud.handleSwimCloudImport(),
          }}
        />
      )}
    </>
  );
}
