/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The destructive-confirm dialog shape built twice, byte-for-byte, in
 * `packages/matrix/src/components/DeleteConfirmationModal.tsx` (deletes a
 * workspace) and `packages/matrix/src/components/SwimmerDeleteConfirmModal.tsx`
 * (removes one swimmer) — same icon-circle treatment, same header/close-button
 * row, same warning-paragraph classes, same Cancel/Confirm button pair with a
 * `Trash2` icon and card glow. See `plans/2026-09-10/04-MATRIX-DIAGNOSIS.md`
 * §4d. Both of those files now render this component instead of their own
 * markup, so their own exports and props are unchanged for their callers.
 *
 * `packages/manager/src/components/SwimmerDeleteConfirmModal.tsx` is a
 * genuinely different interaction (a two-choice "hide or remove permanently"
 * picker, not a single confirm/cancel) and is deliberately left alone —
 * converging it here would mean overriding away most of this component's
 * body, not reusing it.
 */
import type { ReactNode } from 'react';
import { X, Trash2, AlertTriangle } from 'lucide-react';

export interface ConfirmDeleteModalProps {
  title: ReactNode;
  /** The "Are you sure...?" line under the title. */
  description: ReactNode;
  /** The bordered warning paragraph explaining what the delete does. */
  warning: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** A delete is in flight — disables both buttons so a second click can't re-fire it. */
  busy?: boolean;
}

export function ConfirmDeleteModal({
  title,
  description,
  warning,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm">
      <div className="surface-card border border-[var(--text-accent)]/20 rounded-2xl max-w-md w-full mx-4 shadow-[0_0_40px_rgba(220,38,38,0.1)] p-6">
        <div className="flex justify-between items-start mb-6">
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-[var(--text-accent)]/15 text-[var(--text-accent)] flex items-center justify-center shrink-0 border border-[var(--text-accent)]/20">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">
                {title}
              </h2>
              <p className="text-sm text-theme-secondary mt-1">{description}</p>
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

        <p className="text-xs text-theme-secondary bg-[var(--text-accent)]/10 border border-[var(--text-accent)]/15 p-3 rounded-lg mb-8">
          {warning}
        </p>

        <div className="flex justify-end gap-3 font-medium">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-5 py-2 border border-theme-soft hover:bg-[var(--surface-strong)] rounded-lg text-[var(--text-primary)] transition-colors disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-5 py-2 bg-[var(--text-accent)] hover:bg-[var(--text-accent)]/90 text-white rounded-lg flex items-center gap-2 transition-colors shadow-lg shadow-[var(--text-accent)]/20 disabled:opacity-40"
          >
            <Trash2 size={16} />
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
