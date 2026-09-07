import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { createSnapshot as createSnapshotApi, listSnapshots as listSnapshotsApi, restoreSnapshot as restoreSnapshotApi } from '@omniswim/core/api/snapshots';
import type { Snapshot } from '@omniswim/core/api/snapshots';
import { useToast } from '@omniswim/ui';
import DeleteConfirmationModal from '@omniswim/matrix/components/DeleteConfirmationModal';
import { ExpandedWorkspaceList, CollapsedWorkspaceList } from './workspace-sidebar/WorkspaceListItems';
import { SnapshotsPanel } from './workspace-sidebar/SnapshotsPanel';
import { UndoSnackbar } from './workspace-sidebar/UndoSnackbar';

export default function WorkspaceSidebar() {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    createWorkspace,
    deleteWorkspace,
    restoreWorkspace,
    updateWorkspace,
    refreshWorkspaces,
  } = useSuiteWorkspace();

  const toast = useToast();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('omni-sidebar-collapsed') === 'true';
  });
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editWorkspaceName, setEditWorkspaceName] = useState('');
  const [workspaceToDelete, setWorkspaceToDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletedWorkspaceBackup, setDeletedWorkspaceBackup] = useState<(typeof workspaces)[0] | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    },
    []
  );

  // Snapshots state
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [showCreateSnapshot, setShowCreateSnapshot] = useState(false);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(null);

  // Load snapshots when active workspace changes
  const loadSnapshots = useCallback(async () => {
    if (!activeWorkspaceId) {
      setSnapshots([]);
      return;
    }
    setIsLoadingSnapshots(true);
    setSnapshotError(null);
    try {
      const list = await listSnapshotsApi(activeWorkspaceId);
      setSnapshots(list);
    } catch {
      // JSON backend returns error — ignore, snapshots simply unavailable
      setSnapshots([]);
    } finally {
      setIsLoadingSnapshots(false);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const handleCreateSnapshot = useCallback(async () => {
    if (!activeWorkspaceId) return;
    setIsCreatingSnapshot(true);
    const label = snapshotLabel.trim() || `snapshot-${Date.now()}`;
    try {
      await createSnapshotApi(activeWorkspaceId, label);
      toast.push('success', `Snapshot "${label}" created`);
      setSnapshotLabel('');
      setShowCreateSnapshot(false);
      void loadSnapshots();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create snapshot';
      setSnapshotError(msg);
      toast.push('error', msg);
    } finally {
      setIsCreatingSnapshot(false);
    }
  }, [activeWorkspaceId, snapshotLabel, loadSnapshots, toast]);

  const handleRestoreSnapshot = useCallback(async (snapshotId: string) => {
    setRestoringSnapshotId(snapshotId);
    try {
      const restored = await restoreSnapshotApi(snapshotId);
      toast.push('success', `Restored snapshot — "${restored.name}"`);
      // Refresh workspace list to include restored data
      void refreshWorkspaces();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to restore snapshot';
      toast.push('error', msg);
    } finally {
      setRestoringSnapshotId(null);
    }
  }, [toast, refreshWorkspaces]);

  const toggleCollapsed = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      window.localStorage.setItem('omni-sidebar-collapsed', String(next));
      return next;
    });
  };

  const handleCreateWorkspace = async () => {
    const workspace = await createWorkspace();
    toast.push('success', `Workspace "${workspace.name}" ready`);
  };

  const handleRename = async (id: string) => {
    if (!editWorkspaceName.trim()) {
      setEditingWorkspaceId(null);
      return;
    }
    const nextName = editWorkspaceName.trim();
    if (id === activeWorkspaceId) {
      await updateWorkspace({ name: nextName });
      toast.push('success', `Workspace renamed to "${nextName}"`);
    }
    setEditingWorkspaceId(null);
  };

  const confirmDelete = async () => {
    // The modal stays mounted for the whole round trip, so without this guard a
    // second click fires a second DELETE for the same workspace.
    if (!workspaceToDelete || isDeleting) return;
    const id = workspaceToDelete;
    const backup = workspaces.find(w => w.id === id);
    setIsDeleting(true);
    try {
      await deleteWorkspace(id);
    } catch {
      // deleteWorkspace already surfaced the message through onNotify. The
      // workspace still exists, so offer no undo for a delete that never
      // happened.
      setIsDeleting(false);
      setWorkspaceToDelete(null);
      return;
    }
    setIsDeleting(false);
    if (backup) setDeletedWorkspaceBackup(backup);
    toast.push('success', 'Workspace deleted');
    setWorkspaceToDelete(null);
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    undoTimeoutRef.current = setTimeout(() => setDeletedWorkspaceBackup(null), 15000);
  };

  return (
    <>
      <aside
        className={`workspace-sidebar flex flex-col shrink-0 ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{ width: sidebarCollapsed ? '3rem' : '16rem' }}
      >
        <div className="flex items-center justify-between border-b border-theme-soft p-2 shrink-0">
          {!sidebarCollapsed ? (
            <h2 className="text-ui-micro uppercase tracking-widest text-theme-muted font-bold px-2">Workspaces</h2>
          ) : null}
          <div className={`flex items-center gap-1 ${sidebarCollapsed ? 'w-full justify-center' : 'ml-auto'}`}>
            {!sidebarCollapsed ? (
              <button
                type="button"
                onClick={() => void handleCreateWorkspace()}
                className="p-1 theme-hover-row rounded text-theme-secondary hover:text-[var(--text-primary)]"
                title="New workspace"
                aria-label="New workspace"
              >
                <Plus size={14} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={toggleCollapsed}
              className="p-1.5 theme-hover-row rounded text-theme-secondary"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? 'Expand workspace sidebar' : 'Collapse workspace sidebar'}
              title={sidebarCollapsed ? 'Expand workspace sidebar' : 'Collapse workspace sidebar'}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
        </div>

        {!sidebarCollapsed ? (
          <ExpandedWorkspaceList
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            editingWorkspaceId={editingWorkspaceId}
            editWorkspaceName={editWorkspaceName}
            onSelect={setActiveWorkspaceId}
            onEditNameChange={setEditWorkspaceName}
            onRenameCommit={(id) => void handleRename(id)}
            onDeleteRequest={setWorkspaceToDelete}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 p-2 flex-1">
            <button type="button" onClick={() => void handleCreateWorkspace()} className="p-2 theme-hover-row rounded" title="New">
              <Plus size={16} />
            </button>
            <CollapsedWorkspaceList workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onSelect={setActiveWorkspaceId} />
          </div>
        )}

        {!sidebarCollapsed && activeWorkspaceId ? (
          <SnapshotsPanel
            showCreateSnapshot={showCreateSnapshot}
            onToggleCreate={() => setShowCreateSnapshot((prev) => !prev)}
            snapshotLabel={snapshotLabel}
            onLabelChange={setSnapshotLabel}
            isCreatingSnapshot={isCreatingSnapshot}
            onCreate={() => void handleCreateSnapshot()}
            onCancelCreate={() => {
              setShowCreateSnapshot(false);
              setSnapshotLabel('');
            }}
            onDismissCreate={() => setShowCreateSnapshot(false)}
            snapshotError={snapshotError}
            isLoadingSnapshots={isLoadingSnapshots}
            snapshots={snapshots}
            restoringSnapshotId={restoringSnapshotId}
            onRestore={(id) => void handleRestoreSnapshot(id)}
          />
        ) : null}
      </aside>

      {workspaceToDelete && (
        <DeleteConfirmationModal
          workspaceName={workspaces.find(w => w.id === workspaceToDelete)?.name ?? 'Workspace'}
          busy={isDeleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!isDeleting) setWorkspaceToDelete(null);
          }}
        />
      )}

      {deletedWorkspaceBackup && (
        <UndoSnackbar
          onUndo={() => void restoreWorkspace(deletedWorkspaceBackup).then(
            () => {
              toast.push('success', `Workspace "${deletedWorkspaceBackup.name}" restored`);
              setDeletedWorkspaceBackup(null);
            },
            // restoreWorkspace reports the failure itself; keep the toast up
            // so the undo is still available to retry.
            () => undefined
          )}
        />
      )}
    </>
  );
}
