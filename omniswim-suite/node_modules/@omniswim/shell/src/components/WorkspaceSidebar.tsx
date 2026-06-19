import { useState, useRef, useEffect, useCallback } from 'react';
import {
  FileText,
  Plus,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  Camera,
  RotateCcw,
  Database,
  Loader2,
} from 'lucide-react';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { createSnapshot as createSnapshotApi, listSnapshots as listSnapshotsApi, restoreSnapshot as restoreSnapshotApi } from '@omniswim/core/api/snapshots';
import type { Snapshot } from '@omniswim/core/api/snapshots';
import { useToast } from '@omniswim/ui';
import DeleteConfirmationModal from '@omniswim/matrix/components/DeleteConfirmationModal';

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
  const [deletedWorkspaceBackup, setDeletedWorkspaceBackup] = useState<(typeof workspaces)[0] | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleRename = async (id: string) => {
    if (!editWorkspaceName.trim()) {
      setEditingWorkspaceId(null);
      return;
    }
    if (id === activeWorkspaceId) {
      await updateWorkspace({ name: editWorkspaceName.trim() });
    }
    setEditingWorkspaceId(null);
  };

  const confirmDelete = async () => {
    if (!workspaceToDelete) return;
    const backup = workspaces.find(w => w.id === workspaceToDelete);
    if (backup) setDeletedWorkspaceBackup(backup);
    await deleteWorkspace(workspaceToDelete);
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
            <h2 className="text-[10px] uppercase tracking-widest text-theme-muted font-bold px-2">Workspaces</h2>
          ) : null}
          <div className={`flex items-center gap-1 ${sidebarCollapsed ? 'w-full justify-center' : 'ml-auto'}`}>
            {!sidebarCollapsed ? (
              <button
                type="button"
                onClick={() => void createWorkspace()}
                className="p-1 theme-hover-row rounded text-theme-secondary hover:text-[var(--text-primary)]"
                title="New workspace"
              >
                <Plus size={14} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={toggleCollapsed}
              className="p-1.5 theme-hover-row rounded text-theme-secondary"
              aria-expanded={!sidebarCollapsed}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
        </div>

        {!sidebarCollapsed ? (
          <div className="p-3 flex flex-col gap-2 flex-1 overflow-y-auto min-h-0 custom-scrollbar">
            {workspaces.map(w => (
              <div key={w.id} className="relative group">
                <button
                  type="button"
                  onClick={() => setActiveWorkspaceId(w.id)}
                  className={`flex flex-col p-3 rounded-r-md border-l-4 transition-all w-full text-left ${
                    activeWorkspaceId === w.id
                      ? 'surface-card border-[var(--text-accent)]'
                      : 'surface-soft border-theme-soft theme-hover-row'
                  }`}
                >
                  {editingWorkspaceId === w.id ? (
                    <input
                      value={editWorkspaceName}
                      onChange={e => setEditWorkspaceName(e.target.value)}
                      onBlur={() => void handleRename(w.id)}
                      onKeyDown={e => e.key === 'Enter' && void handleRename(w.id)}
                      className="glass-input text-xs w-full"
                      autoFocus
                    />
                  ) : (
                    <span className="text-xs font-bold truncate pr-4">{w.name}</span>
                  )}
                  <span className="text-[9px] text-theme-muted mt-1 uppercase font-mono">
                    {new Date(w.createdAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    setWorkspaceToDelete(w.id);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--text-accent)]/15 text-theme-muted hover:text-[var(--text-accent)] rounded"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 p-2 flex-1">
            <button type="button" onClick={() => void createWorkspace()} className="p-2 theme-hover-row rounded" title="New">
              <Plus size={16} />
            </button>
            {workspaces.map(w => (
              <button
                key={w.id}
                type="button"
                onClick={() => setActiveWorkspaceId(w.id)}
                className={`w-9 h-9 rounded-md border flex items-center justify-center ${
                  activeWorkspaceId === w.id
                    ? 'border-[var(--text-accent)]/50 bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                    : 'border-theme-soft theme-hover-row'
                }`}
                title={w.name}
              >
                <FileText size={14} />
              </button>
            ))}
          </div>
        )}

        {/* Snapshots section */}
        {!sidebarCollapsed && activeWorkspaceId ? (
          <div className="shrink-0 border-t border-theme-soft">
            <div className="flex items-center justify-between p-2">
              <h3 className="text-[9px] uppercase tracking-widest text-theme-muted font-bold px-2 flex items-center gap-1.5">
                <Database size={10} />
                Snapshots
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateSnapshot(prev => !prev)}
                className="p-1 theme-hover-row rounded text-theme-secondary hover:text-[var(--text-primary)]"
                title="Take a workspace snapshot"
              >
                <Camera size={12} />
              </button>
            </div>

            {/* Create snapshot inline form */}
            {showCreateSnapshot && (
              <div className="px-3 pb-2">
                <div className="flex flex-col gap-1.5">
                  <input
                    value={snapshotLabel}
                    onChange={e => setSnapshotLabel(e.target.value)}
                    placeholder="Snapshot label (optional)"
                    className="glass-input text-[10px] w-full"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !isCreatingSnapshot) void handleCreateSnapshot();
                      if (e.key === 'Escape') setShowCreateSnapshot(false);
                    }}
                    autoFocus
                  />
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleCreateSnapshot()}
                      disabled={isCreatingSnapshot}
                      className="flex items-center gap-1 px-2 py-1 rounded btn-primary text-[9px] font-bold uppercase tracking-widest transition-all disabled:opacity-40"
                    >
                      {isCreatingSnapshot ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Camera size={10} />
                      )}
                      {isCreatingSnapshot ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowCreateSnapshot(false); setSnapshotLabel(''); }}
                      className="px-2 py-1 rounded border border-theme-soft text-[9px] font-bold uppercase tracking-widest text-theme-secondary hover:text-[var(--text-primary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {snapshotError && (
                  <p className="text-[8px] text-points-negative mt-1">{snapshotError}</p>
                )}
              </div>
            )}

            {/* Snapshot list */}
            <div className="max-h-32 overflow-y-auto custom-scrollbar px-3 pb-3 space-y-1">
              {isLoadingSnapshots ? (
                <div className="flex items-center justify-center py-3">
                  <Loader2 size={12} className="animate-spin text-theme-secondary" />
                </div>
              ) : snapshots.length > 0 ? (
                snapshots.slice(-10).reverse().map(snap => (
                  <div
                    key={snap.id}
                    className="flex items-center justify-between gap-2 p-1.5 rounded theme-hover-row group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] font-medium text-[var(--text-primary)] truncate">
                        {snap.label || `Snapshot ${new Date(snap.createdAt).toLocaleDateString()}`}
                      </p>
                      <p className="text-[8px] text-theme-muted">
                        {new Date(snap.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRestoreSnapshot(snap.id)}
                      disabled={restoringSnapshotId === snap.id}
                      className="p-1 opacity-0 group-hover:opacity-100 rounded theme-hover-row text-theme-secondary hover:text-[var(--text-accent)] disabled:opacity-40"
                      title="Restore this snapshot"
                    >
                      {restoringSnapshotId === snap.id ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <RotateCcw size={10} />
                      )}
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-[8px] text-theme-muted text-center py-2 italic">
                  {snapshotError || snapshots === null
                    ? 'Snapshots require SQLite backend'
                    : 'No snapshots yet'}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </aside>

      {workspaceToDelete && (
        <DeleteConfirmationModal
          workspaceName={workspaces.find(w => w.id === workspaceToDelete)?.name ?? 'Workspace'}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setWorkspaceToDelete(null)}
        />
      )}

      {deletedWorkspaceBackup && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 toast-undo px-6 py-3 rounded-full flex items-center gap-4">
          <span className="text-xs uppercase tracking-widest font-bold">Workspace Deleted</span>
          <button
            type="button"
            onClick={() => void restoreWorkspace(deletedWorkspaceBackup).then(() => setDeletedWorkspaceBackup(null))}
            className="bg-[var(--text-accent)] text-white px-3 py-1 rounded text-xs font-bold uppercase"
          >
            Undo
          </button>
        </div>
      )}
    </>
  );
}
