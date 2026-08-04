/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { X, Trash2, EyeOff, AlertTriangle } from 'lucide-react';
import { Gender } from '@omniswim/core/types';

interface Props {
  swimmerName: string;
  gender: Gender;
  /** Soft remove: hide from the What-if projection only (source rows kept). */
  onHide: () => void;
  /** Permanent: strip the athlete's individual rows from the workspace roster. */
  onRemove: () => void;
  onCancel: () => void;
}

export default function SwimmerDeleteConfirmModal({
  swimmerName,
  gender,
  onHide,
  onRemove,
  onCancel,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm">
      <div
        className="surface-card border border-[var(--text-accent)]/20 rounded-xl max-w-md w-full mx-4 p-6"
        style={{ boxShadow: 'var(--ui-shadow-lg)' }}
      >
        <div className="flex justify-between items-start mb-5">
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-[var(--text-accent)]/15 text-[var(--text-accent)] flex items-center justify-center shrink-0 border border-[var(--text-accent)]/20">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h2 className="text-heading-2">Remove swimmer</h2>
              <p className="text-ui-body text-theme-secondary mt-1">
                How should{' '}
                <span className="text-[var(--text-primary)] font-mono">{swimmerName}</span> be
                removed from <span className="text-[var(--text-primary)]">{gender}</span>?
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

        <div className="space-y-3 mb-6">
          <button
            type="button"
            onClick={onHide}
            className="w-full text-left rounded-lg border border-theme-soft hover:border-[var(--text-accent)]/50 hover:bg-[var(--surface-strong)] p-3.5 transition-colors"
          >
            <div className="flex items-center gap-2 text-[var(--text-primary)] font-medium mb-1">
              <EyeOff size={15} className="text-[var(--text-accent)]" />
              Hide from What-if projection
            </div>
            <p className="text-ui-caption text-theme-secondary leading-relaxed">
              Excludes them from projected scores and vacates their relay legs. The meet
              record and roster are untouched — turn off What-if or Restore to bring them back.
            </p>
          </button>

          <button
            type="button"
            onClick={onRemove}
            className="w-full text-left rounded-lg border border-rose-400/40 hover:border-rose-400/70 hover:bg-rose-400/10 p-3.5 transition-colors"
          >
            <div className="flex items-center gap-2 text-rose-400 font-medium mb-1">
              <Trash2 size={15} />
              Remove from workspace permanently
            </div>
            <p className="text-ui-caption text-theme-secondary leading-relaxed">
              Strips their individual swims, entries, and history from the working roster so
              they leave baseline too. Relay legs are vacated. The frozen source PDF is kept, so
              Restore can rebuild them this session.
            </p>
          </button>
        </div>

        <div className="flex justify-end font-medium">
          <button
            type="button"
            onClick={onCancel}
            className="px-5 py-2 border border-theme-soft hover:bg-[var(--surface-strong)] rounded-lg text-[var(--text-primary)] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
