import React from 'react';
import { X, Trash2, AlertTriangle } from 'lucide-react';

interface Props {
  workspaceName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeleteConfirmationModal({ workspaceName, onConfirm, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm">
      <div className="surface-card border border-[var(--text-accent)]/20 rounded-lg max-w-md w-full mx-4 shadow-[0_0_40px_rgba(220,38,38,0.1)] p-6">
        <div className="flex justify-between items-start mb-6">
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-[var(--text-accent)]/15 text-[var(--text-accent)] flex items-center justify-center shrink-0 border border-[var(--text-accent)]/20">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Delete Workspace</h2>
              <p className="text-sm text-theme-secondary mt-1">
                Are you sure you want to delete <span className="text-[var(--text-primary)] font-mono">{workspaceName}</span>?
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="text-theme-muted hover:text-[var(--text-primary)] transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <p className="text-xs text-theme-secondary bg-[var(--text-accent)]/10 border border-[var(--text-accent)]/15 p-3 rounded mb-8">
          This operation will obliterate all swimmer results, recruit injections, and active scoring configurations within this workspace. You will have a brief window to undo this action.
        </p>

        <div className="flex justify-end gap-3 font-medium">
          <button onClick={onCancel} className="px-5 py-2 border border-theme-soft hover:bg-[var(--surface-strong)] rounded text-[var(--text-primary)] transition-colors">
            Cancel
          </button>
          <button 
            onClick={onConfirm}
            className="px-5 py-2 bg-[var(--text-accent)] hover:bg-[var(--text-accent)]/90 text-white rounded flex items-center gap-2 transition-colors shadow-lg shadow-[var(--text-accent)]/20"
          >
            <Trash2 size={16} />
            Obliterate Workspace
          </button>
        </div>
      </div>
    </div>
  );
}
