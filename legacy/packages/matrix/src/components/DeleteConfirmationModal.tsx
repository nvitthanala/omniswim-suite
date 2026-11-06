import React from 'react';
import { ConfirmDeleteModal } from '@omniswim/ui';

interface Props {
  workspaceName: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional: a delete is in flight — keeps a second click from re-firing it. */
  busy?: boolean;
}

export default function DeleteConfirmationModal({ workspaceName, onConfirm, onCancel, busy = false }: Props) {
  return (
    <ConfirmDeleteModal
      title="Delete workspace"
      description={
        <>
          Are you sure you want to delete{' '}
          <span className="text-[var(--text-primary)] font-mono">{workspaceName}</span>?
        </>
      }
      warning="This removes all swimmer results, recruits and scoring settings in this workspace. You can undo it for a short time."
      confirmLabel={busy ? 'Deleting...' : 'Delete workspace'}
      onConfirm={onConfirm}
      onCancel={onCancel}
      busy={busy}
    />
  );
}
