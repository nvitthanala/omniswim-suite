/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `MeetOperationsView`'s "load" step: the empty-state prompt (no meet loaded
 * yet), the Meet Files card (load PDF / SwimCloud / link psych sheet), and
 * the cross-workspace meet-copy picker. Pure extraction from
 * `MeetOperationsView.tsx` — no behavior change.
 */

import type { RefObject } from 'react';
import { Plus, X, Download } from 'lucide-react';
import { Button, EmptyState } from '@omniswim/ui';
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
  return (
    <div className="space-y-6">
      {!workspace.loadedMeet ? (
        <EmptyState
          icon={<Plus size={24} />}
          eyebrow="Start here"
          title="Load a meet PDF to begin"
          description="Bring in the meet results first, then set the scoring rules and review team standings."
          actionLabel="Load meet PDF"
          onAction={() => meetFileInputRef.current?.click()}
        />
      ) : null}
      <div className="surface-card rounded-xl p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Meet files</h3>
            <p className="text-xs text-theme-secondary">Load results and link a psych sheet for this meet.</p>
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
                className="cursor-pointer flex items-center gap-1.5 px-3 py-1 btn-accent-outline rounded-md text-[10px] uppercase font-medium transition-colors"
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
              <label
                aria-label="Link psych sheet PDF"
                className="cursor-pointer flex items-center gap-1.5 px-3 py-1 border border-theme-soft rounded-md text-[10px] uppercase font-medium text-theme-secondary hover:text-[var(--text-primary)] transition-colors"
              >
                <Plus size={12} />
                <span>Link Psych</span>
                <input aria-label="Psych sheet PDF file" type="file" className="hidden" accept=".pdf" onChange={onPsychFileUpload} />
              </label>
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 text-ui-caption">
          <label className="flex items-center gap-2 text-theme-secondary">
            PDF column format
            <select value={pdfFormat} onChange={event => onPdfFormatChange(event.target.value)} aria-label="PDF column format" className="surface-overlay border border-theme-soft rounded-lg py-1.5 px-2">
              <option value="auto">Auto Format</option><option value="regular">Regular List</option><option value="divided">Divided (2-Col)</option>
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
