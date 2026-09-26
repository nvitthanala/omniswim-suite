/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s window chrome pieces that are pure render, no
 * state of their own: the capture picker row (select + refresh + forget/
 * confirm), the selected-capture status panel, and the "no captures yet"
 * empty state. Pure extraction from `SwimCloudCaptureBrowser.tsx` — no
 * behavior change. All state and handlers stay in the parent.
 */

import type { ReactNode, RefObject } from 'react';
import { AlertTriangle, ClipboardPaste, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from './Button';

interface CaptureListPickerProps {
  pickerRef: RefObject<HTMLSelectElement | null>;
  captureOptions: readonly { captureId: string; label: string } [] | null;
  selectedCaptureId: string | null;
  hasCaptureRows: boolean;
  isLoadingList: boolean;
  isParsing: boolean;
  onSelectChange: (captureId: string) => void;
  onRefresh: () => void;
  selectedCaptureLabel: string | null;
  confirmingForget: boolean;
  onRequestForget: () => void;
  onConfirmForget: () => void;
  onCancelForget: () => void;
}

/** The always-visible capture `<select>`, its refresh button, and the forget/confirm affordance. */
export function CaptureListPicker({
  pickerRef,
  captureOptions,
  selectedCaptureId,
  hasCaptureRows,
  isLoadingList,
  isParsing,
  onSelectChange,
  onRefresh,
  selectedCaptureLabel,
  confirmingForget,
  onRequestForget,
  onConfirmForget,
  onCancelForget,
}: CaptureListPickerProps) {
  return (
    <div className="flex items-center gap-2">
      <select
        ref={pickerRef}
        aria-label="SwimCloud capture"
        value={selectedCaptureId ?? ''}
        disabled={!hasCaptureRows || isParsing}
        onChange={event => onSelectChange(event.target.value)}
        className="glass-input flex-1 min-w-0 px-3 py-2 rounded-lg text-ui-body appearance-none disabled:opacity-40"
      >
        <option value="">{isLoadingList ? 'Loading captures…' : hasCaptureRows ? 'Choose a capture…' : 'No captures'}</option>
        {captureOptions?.map(option => (
          <option key={option.captureId} value={option.captureId}>
            {option.label}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        aria-label="Refresh capture list"
        title="Re-read the local capture store."
        className="p-2 shrink-0"
        leadingIcon={<RefreshCw size={16} />}
      />
      {selectedCaptureLabel !== null ? (
        confirmingForget ? (
          <span className="flex items-center gap-1 shrink-0">
            <Button
              variant="danger"
              size="sm"
              onClick={onConfirmForget}
              aria-label={`Confirm forgetting capture ${selectedCaptureLabel}`}
              className="px-2 py-1"
            >
              Confirm
            </Button>
            <Button variant="outline" size="sm" onClick={onCancelForget} aria-label="Keep this capture" className="px-2 py-1">
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="danger"
            size="sm"
            onClick={onRequestForget}
            aria-label={`Forget capture ${selectedCaptureLabel}`}
            title="Forget this capture (deletes its stored pages). The only way to make a final page re-fetchable."
            className="p-2 border-transparent bg-transparent shrink-0"
            leadingIcon={<Trash2 size={16} />}
          />
        )
      ) : null}
    </div>
  );
}

interface CaptureStatusPanelProps {
  isParsing: boolean;
  completenessText: string;
  scopeText: string;
  isPartial: boolean;
  notes: readonly string[];
}

/** The selected capture's status line, scope sentence, partial-crawl badge, and notes. */
export function CaptureStatusPanel({ isParsing, completenessText, scopeText, isPartial, notes }: CaptureStatusPanelProps) {
  return (
    <div className="space-y-1" aria-live="polite">
      <p className="text-ui-caption text-theme-secondary">{isParsing ? 'Parsing…' : completenessText}</p>
      {/* Rendered for every capture, including ones that record no scope.
          `every-planned-page-fetched` above is a claim about a plan, and
          the plan can be narrow — this line is the only thing separating
          a full crawl from a meet-results-only one. */}
      <p className="text-ui-caption text-theme-muted">{scopeText}</p>
      {isPartial ? (
        <span
          className="inline-flex items-center gap-1 text-ui-micro text-theme-muted border border-theme-soft rounded px-1.5 py-0.5 opacity-70"
          title="This capture is incomplete. There is no way to resume a crawl from this panel — reopen the meet in the browser extension and let it continue."
        >
          <AlertTriangle size={11} /> Resume in the extension
        </span>
      ) : null}
      {notes.length > 0 ? (
        <ul className="text-ui-micro text-theme-muted list-disc pl-4">
          {notes.map((note, index) => (
            <li key={`${index}-${note}`}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface NoCapturesEmptyStateProps {
  pasteFallback?: { readonly label: string; readonly hint?: string; readonly onPaste: () => void };
}

/** Shown once the list is known-empty: the "use the extension" line, plus the optional paste fallback. */
export function NoCapturesEmptyState({ pasteFallback }: NoCapturesEmptyStateProps) {
  return (
    <div className="space-y-2">
      <p className="text-ui-body text-theme-muted">
        No captures yet. Use the Omniswim SwimCloud Companion browser extension to crawl a meet or a team, then come
        back here.
      </p>
      {pasteFallback ? (
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={pasteFallback.onPaste}
            aria-label={pasteFallback.label}
            className="text-[var(--text-accent)] hover:underline"
            leadingIcon={<ClipboardPaste size={13} />}
          >
            {pasteFallback.label}
          </Button>
          {pasteFallback.hint !== undefined ? <p className="text-ui-micro text-theme-muted">{pasteFallback.hint}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The token/list error banner — at most one of the two ever shows. */
export function CaptureErrorBanner({ tokenError, listError }: { tokenError: string | null; listError: string | null }): ReactNode {
  if (tokenError !== null) {
    return <p className="text-ui-caption badge-warning px-3 py-2 rounded-lg">{tokenError}</p>;
  }
  if (listError !== null) {
    return <p className="text-ui-caption badge-warning px-3 py-2 rounded-lg">{listError}</p>;
  }
  return null;
}
