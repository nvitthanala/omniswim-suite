import { useEffect, useRef } from 'react';
import { FileText, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@omniswim/ui';
import type { Workspace } from '@omniswim/core/types';

interface ExpandedWorkspaceListProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  editingWorkspaceId: string | null;
  editWorkspaceName: string;
  onSelect: (id: string) => void;
  onEditNameChange: (name: string) => void;
  onRenameStart: (id: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
  onDeleteRequest: (id: string) => void;
}

/**
 * The full workspace list shown when the sidebar is expanded: one row per
 * workspace with select, inline rename, and delete affordances.
 *
 * Rename is offered on the active row only. The save call renames the open
 * workspace, so a rename button on another row would do nothing.
 */
export function ExpandedWorkspaceList({
  workspaces,
  activeWorkspaceId,
  editingWorkspaceId,
  editWorkspaceName,
  onSelect,
  onEditNameChange,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
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
          onRenameStart={onRenameStart}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
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
  onRenameStart: (id: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
  onDeleteRequest: (id: string) => void;
}

/**
 * The inline rename field. Enter saves, Escape cancels, and leaving the field
 * saves. The `settled` guard stops one edit from committing twice, for example
 * Enter followed by the blur that fires as the field unmounts.
 */
function WorkspaceNameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  onKeyboardDone,
}: {
  value: string;
  onChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onKeyboardDone: () => void;
}) {
  const settledRef = useRef(false);
  const settle = (action: () => void) => {
    if (settledRef.current) return;
    settledRef.current = true;
    action();
  };
  return (
    <input
      value={value}
      aria-label="Workspace name"
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => settle(onCommit)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onKeyboardDone();
          settle(onCommit);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onKeyboardDone();
          settle(onCancel);
        }
      }}
      className="glass-input text-xs w-full"
      autoFocus
    />
  );
}

function ExpandedWorkspaceRow({
  workspace: w,
  isActive,
  isEditing,
  editName,
  onSelect,
  onEditNameChange,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDeleteRequest,
}: ExpandedWorkspaceRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Set when Enter or Escape ends the edit, so focus goes back to the rename
  // button. A click elsewhere ends the edit too, and must keep its own focus.
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (isEditing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    rowRef.current?.querySelector<HTMLButtonElement>('[data-rename-trigger]')?.focus();
  }, [isEditing]);

  const rowClassName = `flex flex-col p-3 rounded-r-md border-l-4 transition-colors w-full text-left ${
    isActive ? 'surface-card border-[var(--text-accent)]' : 'surface-soft border-theme-soft theme-hover-row'
  }`;
  // Which workspace holds which meet was invisible here: the row showed only a
  // creation date, so the one holding the championship results looked
  // identical to an empty one.
  const meta = (
    <>
      <span className="text-ui-micro text-theme-muted mt-1 truncate w-full" title={w.loadedMeet?.pdfFilename ?? undefined}>
        {w.loadedMeet?.pdfFilename ?? 'No meet loaded'}
      </span>
      <span className="text-ui-micro text-theme-muted mt-0.5 uppercase font-mono">
        {new Date(w.createdAt).toLocaleDateString()}
      </span>
    </>
  );

  return (
    <div ref={rowRef} className="relative group">
      {isEditing ? (
        // Not a button: an input inside a button is invalid HTML and Firefox
        // does not give it clicks or the space key.
        <div className={rowClassName}>
          <WorkspaceNameInput
            value={editName}
            onChange={onEditNameChange}
            onCommit={() => onRenameCommit(w.id)}
            onCancel={onRenameCancel}
            onKeyboardDone={() => {
              restoreFocusRef.current = true;
            }}
          />
          {meta}
        </div>
      ) : (
        <button type="button" onClick={() => onSelect(w.id)} className={rowClassName}>
          <span className={`text-xs font-bold truncate ${isActive ? 'pr-14' : 'pr-4'}`}>{w.name}</span>
          {meta}
        </button>
      )}
      {isActive && !isEditing ? (
        <Button
          variant="ghost"
          size="sm"
          data-rename-trigger=""
          onClick={(e) => {
            e.stopPropagation();
            onRenameStart(w.id);
          }}
          className="absolute right-9 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 border-transparent bg-transparent text-theme-muted hover:text-[var(--text-accent)]"
          aria-label={`Rename workspace ${w.name}`}
          title={`Rename workspace ${w.name}`}
          leadingIcon={<Pencil size={12} />}
        />
      ) : null}
      <Button
        variant="danger"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteRequest(w.id);
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 border-transparent bg-transparent hover:bg-[var(--text-accent)]/15 text-theme-muted hover:text-[var(--text-accent)]"
        aria-label={`Delete workspace ${w.name}`}
        title={`Delete workspace ${w.name}`}
        leadingIcon={<Trash2 size={12} />}
      />
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
        <Button
          key={w.id}
          variant="ghost"
          size="sm"
          onClick={() => onSelect(w.id)}
          className={`w-9 h-9 p-0 rounded-md border ${
            activeWorkspaceId === w.id
              ? 'border-[var(--text-accent)]/50 bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
              : 'border-theme-soft'
          }`}
          title={w.name}
          aria-label={w.name}
          leadingIcon={<FileText size={14} />}
        />
      ))}
    </>
  );
}
