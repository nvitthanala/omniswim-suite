/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A review step before a meet-entry export, shown ONLY when
 * `validateEntriesForExport` finds something — the common, clean case never
 * sees this modal at all. See `packages/core/src/lib/entryExport.ts` for
 * what each issue type means and why it exists.
 */

import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Modal } from '@omniswim/ui';
import type { EntryExportIssue } from '@omniswim/core/lib/entryExport';

type Props = {
  issues: EntryExportIssue[];
  onExportAnyway: () => void;
  onCancel: () => void;
};

export default function ExportReviewModal({ issues, onExportAnyway, onCancel }: Props) {
  return (
    <Modal
      onClose={onCancel}
      ariaLabel="Review before export"
      className="border border-[var(--text-accent)]/20 rounded-xl max-w-lg w-full mx-4 p-6 max-h-[80vh] flex flex-col"
      style={{ boxShadow: 'var(--ui-shadow-lg)' }}
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-amber-400/15 text-amber-400 flex items-center justify-center shrink-0 border border-amber-400/20">
            <AlertTriangle size={20} />
          </div>
          <div>
            <h2 className="text-heading-2">Review before export</h2>
            <p className="text-ui-body text-theme-secondary mt-1">
              {issues.length} {issues.length === 1 ? 'entry needs' : 'entries need'} a second look
              before this export — none of these are fixed automatically.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-theme-muted hover:text-[var(--text-primary)] transition-colors"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>

      <ul className="space-y-2 overflow-y-auto custom-scrollbar mb-6 -mr-2 pr-2">
        {issues.map((issue, i) => (
          <li
            key={`${issue.entryId}|${issue.type}|${i}`}
            className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 text-ui-caption text-[var(--text-primary)] leading-relaxed break-words"
          >
            {issue.message}
          </li>
        ))}
      </ul>

      <div className="flex justify-end gap-3 font-medium">
        <button
          type="button"
          onClick={onCancel}
          className="px-5 py-2 border border-theme-soft hover:bg-[var(--surface-strong)] rounded-lg text-[var(--text-primary)] transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onExportAnyway}
          className="px-5 py-2 border border-amber-400/40 hover:border-amber-400/70 hover:bg-amber-400/10 rounded-lg text-amber-400 transition-colors"
        >
          Export anyway
        </button>
      </div>
    </Modal>
  );
}
