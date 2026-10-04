/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The files half of `MeetOperationsView`'s "meet" step: the empty-state prompt (no meet loaded
 * yet), the Meet Files card (load PDF / SwimCloud / link psych sheet), and
 * the cross-workspace meet-copy picker. Pure extraction from
 * `MeetOperationsView.tsx` — no behavior change.
 */

import type { RefObject } from 'react';
import { Plus, X, Download, FlaskConical } from 'lucide-react';
import { Button, EmptyState, useOpenTheoreticalMeet } from '@omniswim/ui';
import type { Workspace } from '@omniswim/core/types';

interface MeetOpsLoadStepProps {
  workspace: Workspace;
  pdfFormat: string;
  onPdfFormatChange: (format: string) => void;
  workspaceMeetSources: Workspace[];
  onCopyMeetFromWorkspace: (sourceId: string) => void;
  isParsingPdf: boolean;
  isParsingPsychPdf: boolean;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPsychFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCancelPdfParse: () => void;
  onCancelPsychPdfParse: () => void;
  onBrowseSwimCloudCaptures: () => void;
  meetFileInputRef: RefObject<HTMLInputElement | null>;
}

export function MeetOpsLoadStep({
  workspace,
  pdfFormat,
  onPdfFormatChange,
  workspaceMeetSources,
  onCopyMeetFromWorkspace,
  isParsingPdf,
  isParsingPsychPdf,
  onFileUpload,
  onPsychFileUpload,
  onCancelPdfParse,
  onCancelPsychPdfParse,
  onBrowseSwimCloudCaptures,
  meetFileInputRef,
}: MeetOpsLoadStepProps) {
  // Null when the host has no dialog to open: the button is then not drawn.
  const openTheoreticalMeet = useOpenTheoreticalMeet();
  return (
    <div className="space-y-6">
      {!workspace.loadedMeet ? (
        <EmptyState
          icon={<Plus size={24} />}
          eyebrow="Start here"
          title="Load a meet PDF to begin"
          description="Bring in the meet results first, then check the scoring rules and review team standings."
          actionLabel="Load meet PDF"
          onAction={() => meetFileInputRef.current?.click()}
          secondaryAction={
            openTheoreticalMeet ? (
              <Button variant="outline" onClick={openTheoreticalMeet} leadingIcon={<FlaskConical size={14} />}>
                Build theoretical meet
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <div className="surface-card rounded-xl p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="text-lg font-medium text-[var(--text-primary)]">Meet files</h3>
            <p className="text-xs text-theme-secondary">Load results and link a psych sheet for this meet.</p>
            {openTheoreticalMeet ? (
              <p className="mt-1 text-ui-caption text-theme-muted">No meet PDF? Build a theoretical meet from teams you crawled. It opens as a new workspace.</p>
            ) : null}
          </div>
          {isParsingPdf || isParsingPsychPdf ? (
            <div className="flex items-center gap-2">
              <span className="text-ui-caption text-theme-secondary">
                {isParsingPsychPdf ? 'Parsing psych PDF...' : 'Parsing meet PDF...'}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={isParsingPsychPdf ? onCancelPsychPdfParse : onCancelPdfParse}
                aria-label="Cancel PDF parsing"
                leadingIcon={<X size={12} />}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border border-theme-soft rounded-lg p-1">
              <label
                aria-label="Load meet results PDF"
                className="cursor-pointer flex items-center gap-1.5 px-3 py-1 btn-accent-outline rounded-md text-ui-caption font-medium transition-colors"
              >
                <Plus size={12} />
                <span>Load PDF</span>
                <input ref={meetFileInputRef} aria-label="Meet results PDF file" type="file" className="hidden" accept=".pdf" onChange={onFileUpload} />
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={onBrowseSwimCloudCaptures}
                aria-label="Add meet results from SwimCloud"
                title="Browse a meet capture the extension has fetched. Pasting a single page from the clipboard is still offered there when no capture exists yet."
                leadingIcon={<Download size={12} />}
              >
                Add from SwimCloud
              </Button>
              {/* With no meet loaded, the empty state above already offers this action. */}
              {openTheoreticalMeet && workspace.loadedMeet ? (
                <Button variant="outline" size="sm" onClick={openTheoreticalMeet} leadingIcon={<FlaskConical size={12} />}>
                  Build theoretical meet
                </Button>
              ) : null}
              <label
                aria-label="Link psych sheet PDF"
                className="cursor-pointer flex items-center gap-1.5 px-3 py-1 border border-theme-soft rounded-md text-ui-caption font-medium text-theme-secondary hover:text-[var(--text-primary)] transition-colors"
              >
                <Plus size={12} />
                <span>Link psych sheet</span>
                <input aria-label="Psych sheet PDF file" type="file" className="hidden" accept=".pdf" onChange={onPsychFileUpload} />
              </label>
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 text-ui-caption">
          <label className="flex items-center gap-2 text-theme-secondary">
            PDF column format
            <select value={pdfFormat} onChange={event => onPdfFormatChange(event.target.value)} aria-label="PDF column format" className="surface-overlay border border-theme-soft rounded-lg py-1.5 px-2">
              <option value="auto">Auto format</option><option value="regular">Regular list</option><option value="divided">Divided (2-Col)</option>
            </select>
          </label>
          <div className="rounded-lg border border-theme-soft surface-overlay p-3">
            <span className="text-theme-muted">Meet results</span>
            <p className="mt-1 text-[var(--text-primary)]">{workspace.loadedMeet?.pdfFilename ?? 'No meet PDF loaded'}</p>
          </div>
          <div className="rounded-lg border border-theme-soft surface-overlay p-3">
            <span className="text-theme-muted">Psych sheet</span>
            <p className="mt-1 text-[var(--text-primary)]">{workspace.loadedPsych?.pdfFilename ?? 'No psych sheet linked'}</p>
          </div>
        </div>
        {workspaceMeetSources.length > 0 ? (
          <div className="mt-4 border-t border-theme-soft pt-4">
            <label htmlFor="matrix-copy-meet-source" className="block text-ui-caption text-theme-secondary mb-1">Copy meet and psych sheet from another workspace</label>
            <p className="text-ui-caption text-theme-muted mb-2">
              Copies the meet results, psych sheet, official team scores, and conference. Replaces the meet loaded here. Does not copy scoring rules or roster plans.
            </p>
            <select
              defaultValue=""
              onChange={event => {
                if (event.target.value) onCopyMeetFromWorkspace(event.target.value);
                event.target.value = '';
              }}
              id="matrix-copy-meet-source"
              className="surface-overlay border border-theme-soft rounded-lg px-3 py-2 text-ui-caption text-[var(--text-primary)]"
            >
              <option value="">Choose a workspace…</option>
              {workspaceMeetSources.map(source => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
    </div>
  );
}
