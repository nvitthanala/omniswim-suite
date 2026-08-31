interface UndoSnackbarProps {
  onUndo: () => void;
}

/** The "Workspace Deleted" undo snackbar shown for 15s after a delete. */
export function UndoSnackbar({ onUndo }: UndoSnackbarProps) {
  return (
    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 toast-undo px-6 py-3 rounded-full flex items-center gap-4">
      <span className="text-xs uppercase tracking-widest font-bold">Workspace Deleted</span>
      <button type="button" onClick={onUndo} className="bg-[var(--text-accent)] text-white px-3 py-1 rounded text-xs font-bold uppercase">
        Undo
      </button>
    </div>
  );
}
