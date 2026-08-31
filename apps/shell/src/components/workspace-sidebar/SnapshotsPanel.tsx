import { Camera, Database, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@omniswim/ui';
import type { Snapshot } from '@omniswim/core/api/snapshots';

interface SnapshotsPanelProps {
  showCreateSnapshot: boolean;
  onToggleCreate: () => void;
  snapshotLabel: string;
  onLabelChange: (label: string) => void;
  isCreatingSnapshot: boolean;
  onCreate: () => void;
  onCancelCreate: () => void;
  onDismissCreate: () => void;
  snapshotError: string | null;
  isLoadingSnapshots: boolean;
  snapshots: Snapshot[];
  restoringSnapshotId: string | null;
  onRestore: (id: string) => void;
}

/**
 * The active workspace's snapshots section: header + take-snapshot toggle,
 * the inline create form, and the list of existing snapshots with restore.
 */
export function SnapshotsPanel({
  showCreateSnapshot,
  onToggleCreate,
  snapshotLabel,
  onLabelChange,
  isCreatingSnapshot,
  onCreate,
  onCancelCreate,
  onDismissCreate,
  snapshotError,
  isLoadingSnapshots,
  snapshots,
  restoringSnapshotId,
  onRestore,
}: SnapshotsPanelProps) {
  return (
    <div className="shrink-0 border-t border-theme-soft">
      <div className="flex items-center justify-between p-2">
        <h3 className="text-ui-micro uppercase tracking-widest text-theme-muted font-bold px-2 flex items-center gap-1.5">
          <Database size={10} />
          Snapshots
        </h3>
        <button
          type="button"
          onClick={onToggleCreate}
          className="p-1 theme-hover-row rounded text-theme-secondary hover:text-[var(--text-primary)]"
          title="Take a workspace snapshot"
          aria-label="Take a workspace snapshot"
          aria-expanded={showCreateSnapshot}
        >
          <Camera size={12} />
        </button>
      </div>

      {showCreateSnapshot ? (
        <CreateSnapshotForm
          snapshotLabel={snapshotLabel}
          onLabelChange={onLabelChange}
          isCreatingSnapshot={isCreatingSnapshot}
          onCreate={onCreate}
          onCancelCreate={onCancelCreate}
          onDismissCreate={onDismissCreate}
          snapshotError={snapshotError}
        />
      ) : null}

      <SnapshotList
        isLoadingSnapshots={isLoadingSnapshots}
        snapshots={snapshots}
        snapshotError={snapshotError}
        restoringSnapshotId={restoringSnapshotId}
        onRestore={onRestore}
      />
    </div>
  );
}

interface CreateSnapshotFormProps {
  snapshotLabel: string;
  onLabelChange: (label: string) => void;
  isCreatingSnapshot: boolean;
  onCreate: () => void;
  onCancelCreate: () => void;
  onDismissCreate: () => void;
  snapshotError: string | null;
}

function CreateSnapshotForm({
  snapshotLabel,
  onLabelChange,
  isCreatingSnapshot,
  onCreate,
  onCancelCreate,
  onDismissCreate,
  snapshotError,
}: CreateSnapshotFormProps) {
  return (
    <div className="px-3 pb-2">
      <div className="flex flex-col gap-1.5">
        <input
          value={snapshotLabel}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder="Snapshot label (optional)"
          className="glass-input text-ui-micro w-full"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isCreatingSnapshot) onCreate();
            if (e.key === 'Escape') onDismissCreate();
          }}
          autoFocus
        />
        <div className="flex gap-1.5">
          <Button type="button" onClick={onCreate} disabled={isCreatingSnapshot} size="sm" className="uppercase tracking-widest">
            {isCreatingSnapshot ? <Loader2 size={10} className="animate-spin" /> : <Camera size={10} />}
            {isCreatingSnapshot ? 'Saving...' : 'Save'}
          </Button>
          <Button type="button" onClick={onCancelCreate} variant="outline" size="sm" className="uppercase tracking-widest">
            Cancel
          </Button>
        </div>
      </div>
      {snapshotError ? <p className="text-ui-micro text-points-negative mt-1">{snapshotError}</p> : null}
    </div>
  );
}

interface SnapshotListProps {
  isLoadingSnapshots: boolean;
  snapshots: Snapshot[];
  snapshotError: string | null;
  restoringSnapshotId: string | null;
  onRestore: (id: string) => void;
}

function SnapshotList({ isLoadingSnapshots, snapshots, snapshotError, restoringSnapshotId, onRestore }: SnapshotListProps) {
  if (isLoadingSnapshots) {
    return (
      <div className="max-h-32 overflow-y-auto custom-scrollbar px-3 pb-3 space-y-1">
        <div className="flex items-center justify-center py-3">
          <Loader2 size={12} className="animate-spin text-theme-secondary" />
        </div>
      </div>
    );
  }
  if (snapshots.length === 0) {
    return (
      <div className="max-h-32 overflow-y-auto custom-scrollbar px-3 pb-3 space-y-1">
        <p className="text-ui-micro text-theme-muted text-center py-2 italic">
          {snapshotError ? 'Snapshots require SQLite backend' : 'No snapshots yet'}
        </p>
      </div>
    );
  }
  return (
    <div className="max-h-32 overflow-y-auto custom-scrollbar px-3 pb-3 space-y-1">
      {snapshots
        .slice(-10)
        .reverse()
        .map((snap) => (
          <SnapshotRow key={snap.id} snapshot={snap} restoringSnapshotId={restoringSnapshotId} onRestore={onRestore} />
        ))}
    </div>
  );
}

function SnapshotRow({
  snapshot: snap,
  restoringSnapshotId,
  onRestore,
}: {
  snapshot: Snapshot;
  restoringSnapshotId: string | null;
  onRestore: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 p-1.5 rounded theme-hover-row group">
      <div className="flex-1 min-w-0">
        <p className="text-ui-micro font-medium text-[var(--text-primary)] truncate">
          {snap.label || `Snapshot ${new Date(snap.createdAt).toLocaleDateString()}`}
        </p>
        <p className="text-ui-micro text-theme-muted">{new Date(snap.createdAt).toLocaleString()}</p>
      </div>
      <button
        type="button"
        onClick={() => onRestore(snap.id)}
        disabled={restoringSnapshotId === snap.id}
        className="p-1 opacity-0 group-hover:opacity-100 rounded theme-hover-row text-theme-secondary hover:text-[var(--text-accent)] disabled:opacity-40"
        title="Restore this snapshot"
        aria-label={`Restore snapshot ${snap.label || new Date(snap.createdAt).toLocaleString()}`}
      >
        {restoringSnapshotId === snap.id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
      </button>
    </div>
  );
}
