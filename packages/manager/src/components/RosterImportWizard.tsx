/**
 * Enhanced SwimCloud paste import with format detection and merge preview.
 *
 * The wizard is a composition: `useRosterImportState` holds the state and the
 * `useRoster*` hooks beside this file each own one concern (parse, clipboard,
 * capture browser, commit, alias linking). The step bodies are
 * `RosterImportPasteStep`, `RosterImportPreviewStep` and
 * `RosterImportFooterActions`.
 */
import { X } from 'lucide-react';
import { Gender, Workspace } from '@omniswim/core/types';
import { detectSwimCloudPasteFormat } from '@omniswim/core/lib/athleteHistory';
import {
  Button,
  Modal,
  useToast,
  SwimCloudCaptureBrowser,
} from '@omniswim/ui';
import SwimCloudReplaceConfirmModal from './SwimCloudReplaceConfirmModal';
import RosterQueueBanner from './RosterQueueBanner';
import RosterImportPasteStep from './RosterImportPasteStep';
import RosterImportPreviewStep from './RosterImportPreviewStep';
import RosterImportFooterActions from './RosterImportFooterActions';
import { rosterCaptureCoverage } from '../lib/rosterQueueImport';
import { useRosterImportState } from './useRosterImportState';
import { useRosterImportParse } from './useRosterImportParse';
import { useRosterClipboardImport } from './useRosterClipboardImport';
import { useRosterCaptureBrowserImport } from './useRosterCaptureBrowserImport';
import { useRosterImportCommit } from './useRosterImportCommit';
import { useRosterAliasLinking } from './useRosterAliasLinking';

type Props = {
  workspace: Workspace;
  gender: Gender;
  onClose: () => void;
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>;
};

export default function RosterImportWizard({ workspace, gender, onClose, onUpdate }: Props) {
  const toast = useToast();
  const s = useRosterImportState(workspace, gender);
  const deps = { s, workspace, gender, toast };
  const { handleParse, handleFile } = useRosterImportParse(deps);
  const { handleClipboardImport } = useRosterClipboardImport(deps);
  const { handleCaptureBrowserRosterImport } = useRosterCaptureBrowserImport(deps);
  const commit = useRosterImportCommit(deps, onClose, onUpdate);
  const alias = useRosterAliasLinking(deps, onUpdate);
  const { team, mode, paste, step, preview, importMode } = s;

  const detectedFormat =
    mode === 'paste' && paste.trim() ? detectSwimCloudPasteFormat(paste) : null;

  return (
    <>
      {/* Its own separate FloatingWindow overlay, positioned independently of
          the wizard's own dialog below — a sibling, never nested inside it. */}
      {s.showCaptureRosterPanel ? (
        <SwimCloudCaptureBrowser
          mode="roster-history"
          team={team.trim()}
          genderLabel={gender === Gender.MEN ? 'Men' : 'Women'}
          rosterCoverage={(roster, swimmerTimes) => rosterCaptureCoverage(roster.athletes, swimmerTimes)}
          onImportRoster={selection => handleCaptureBrowserRosterImport(selection)}
          onClose={() => s.setShowCaptureRosterPanel(false)}
          pasteFallback={{
            label: 'or paste a single swimmer instead',
            hint: 'Reads one SwimCloud roster, or one swimmer’s Times page, from the clipboard ("Copy for Omniswim" on that page first).',
            onPaste: () => void handleClipboardImport(),
          }}
        />
      ) : null}
      <Modal
        onClose={onClose}
        ariaLabel="Import roster / history"
        blur={false}
        className="border border-theme w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl"
        style={{ boxShadow: 'var(--ui-shadow-lg)' }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-soft">
          <div>
            <h3 className="text-ui-label font-bold">Import roster / history</h3>
            <p className="text-ui-caption text-theme-muted mt-1">
              Paste SwimCloud Personal Bests or roster table text
            </p>
          </div>
          <Button variant="ghost" size="md" onClick={onClose} className="p-2" aria-label="Close" leadingIcon={<X size={18} />} />
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {s.rosterQueue ? (
            <RosterQueueBanner
              rosterQueue={s.rosterQueue}
              isImportingFromClipboard={s.isImportingFromClipboard}
              team={team}
              onCaptureNext={() => void handleClipboardImport()}
              onClear={() => s.setRosterQueue(null)}
            />
          ) : null}
          {step === 'paste' ? (
            <RosterImportPasteStep
              mode={mode}
              onSetMode={s.setMode}
              showReference={s.showReference}
              onToggleReference={() => s.setShowReference(v => !v)}
              onShowCaptureRosterPanel={() => s.setShowCaptureRosterPanel(true)}
              team={team}
              teams={s.teams}
              onSetTeam={s.setTeam}
              gender={gender}
              paste={paste}
              onSetPaste={s.setPaste}
              fileInputRef={s.fileInputRef}
              onFile={handleFile}
              detectedFormat={detectedFormat}
            />
          ) : (
            <RosterImportPreviewStep
              format={s.format}
              preview={preview}
              warnings={s.warnings}
              unreadStampSummary={s.unreadStampSummary}
              team={team}
              importMode={importMode}
              onSetImportMode={s.setImportMode}
              replacePreview={commit.replacePreview}
              improvementsComputed={s.improvementsComputed}
              improvements={s.improvements}
              showImprovements={s.showImprovements}
              onToggleImprovements={() => s.setShowImprovements(v => !v)}
              swimmerActions={alias.swimmerActions}
              aliasSuggestions={alias.aliasSuggestions}
              dismissedAliasKeys={s.dismissedAliasKeys}
              onLinkAlias={alias.handleLinkAlias}
              onDismissAlias={alias.handleDismissAlias}
              lastAliasLink={s.lastAliasLink}
              onUndoAliasLink={alias.handleUndoAliasLink}
            />
          )}
        </div>

        <RosterImportFooterActions
          step={step}
          onBack={() => s.setStep('paste')}
          onClose={onClose}
          onParse={handleParse}
          pasteEmpty={!paste.trim()}
          onMerge={() => void commit.handleMerge()}
          previewEmpty={preview.length === 0}
          isReplaceMode={importMode === 'replace'}
        />
      </Modal>
      {commit.showReplaceConfirm && commit.replacePreview ? (
        <SwimCloudReplaceConfirmModal
          preview={commit.replacePreview}
          busy={commit.replaceBusy}
          onCancel={() => commit.setShowReplaceConfirm(false)}
          onConfirm={() => void commit.handleConfirmReplace()}
        />
      ) : null}
    </>
  );
}
