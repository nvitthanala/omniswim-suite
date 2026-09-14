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
      title="Delete Workspace"
      description={
        <>
          Are you sure you want to delete{' '}
          <span className="text-[var(--text-primary)] font-mono">{workspaceName}</span>?
        </>
      }
      warning="This operation will obliterate all swimmer results, recruit injections, and active scoring configurations within this workspace. You will have a brief window to undo this action."
      confirmLabel={busy ? 'Deleting...' : 'Obliterate Workspace'}
      onConfirm={onConfirm}
      onCancel={onCancel}
      busy={busy}
    />
  );
}
