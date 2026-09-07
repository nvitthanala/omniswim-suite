import { FileText, Trash2 } from 'lucide-react';
import type { Workspace } from '@omniswim/core/types';

interface ExpandedWorkspaceListProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  editingWorkspaceId: string | null;
  editWorkspaceName: string;
  onSelect: (id: string) => void;
  onEditNameChange: (name: string) => void;
  onRenameCommit: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}

/**
 * The full workspace list shown when the sidebar is expanded: one row per
 * workspace with select, inline rename, and delete affordances.
 */
export function ExpandedWorkspaceList({
  workspaces,
  activeWorkspaceId,
  editingWorkspaceId,
  editWorkspaceName,
  onSelect,
  onEditNameChange,
  onRenameCommit,
  onDeleteRequest,
}: ExpandedWorkspaceListProps) {
  return (
    <div className="p-3 flex flex-col gap-2 flex-1 overflow-y-auto min-h-0 custom-scrollbar">
      {workspaces.map((w) => (
        <ExpandedWorkspaceRow
          key={w.id}
          workspace={w}
          isActive={activeWorkspaceId === w.id}
          isEditing={editingWorkspaceId === w.id}
          editName={editWorkspaceName}
          onSelect={onSelect}
          onEditNameChange={onEditNameChange}
          onRenameCommit={onRenameCommit}
          onDeleteRequest={onDeleteRequest}
        />
      ))}
    </div>
  );
}

interface ExpandedWorkspaceRowProps {
  workspace: Workspace;
  isActive: boolean;
  isEditing: boolean;
  editName: string;
  onSelect: (id: string) => void;
  onEditNameChange: (name: string) => void;
  onRenameCommit: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}

function ExpandedWorkspaceRow({
  workspace: w,
  isActive,
  isEditing,
  editName,
  onSelect,
  onEditNameChange,
  onRenameCommit,
  onDeleteRequest,
}: ExpandedWorkspaceRowProps) {
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={() => onSelect(w.id)}
        className={`flex flex-col p-3 rounded-r-md border-l-4 transition-all w-full text-left ${
          isActive ? 'surface-card border-[var(--text-accent)]' : 'surface-soft border-theme-soft theme-hover-row'
        }`}
      >
        {isEditing ? (
          <input
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
            onBlur={() => onRenameCommit(w.id)}
            onKeyDown={(e) => e.key === 'Enter' && onRenameCommit(w.id)}
            className="glass-input text-xs w-full"
            autoFocus
          />
        ) : (
          <span className="text-xs font-bold truncate pr-4">{w.name}</span>
        )}
        {/* Which workspace holds which meet was invisible here: the row
            showed only a creation date, so the one holding the
            championship results looked identical to an empty one. */}
        <span className="text-ui-micro text-theme-muted mt-1 truncate w-full" title={w.loadedMeet?.pdfFilename ?? undefined}>
          {w.loadedMeet?.pdfFilename ?? 'No meet loaded'}
        </span>
        <span className="text-ui-micro text-theme-muted mt-0.5 uppercase font-mono">
          {new Date(w.createdAt).toLocaleDateString()}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteRequest(w.id);
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--text-accent)]/15 text-theme-muted hover:text-[var(--text-accent)] rounded"
        aria-label={`Delete workspace ${w.name}`}
        title={`Delete workspace ${w.name}`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

interface CollapsedWorkspaceListProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSelect: (id: string) => void;
}

/** The icon-only workspace list shown when the sidebar is collapsed. */
export function CollapsedWorkspaceList({ workspaces, activeWorkspaceId, onSelect }: CollapsedWorkspaceListProps) {
  return (
    <>
      {workspaces.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => onSelect(w.id)}
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
    </>
  );
}
