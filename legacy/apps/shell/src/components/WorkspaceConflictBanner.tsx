import { useState } from 'react';
import { Button } from '@omniswim/ui';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';

/**
 * Shown while the active workspace's last save was refused because it changed somewhere
 * else (another tab, user, or script). Autosave is paused and the user's edits are still
 * on screen; Reload is the only way out, and the only thing that discards those edits.
 * The wording is fixed by the P3 decision.
 */
export default function WorkspaceConflictBanner() {
  const { activeWorkspaceId, versionConflictIds, reloadWorkspace } = useSuiteWorkspace();
  const [reloading, setReloading] = useState(false);

  if (!activeWorkspaceId || !versionConflictIds.includes(activeWorkspaceId)) return null;

  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await reloadWorkspace(activeWorkspaceId);
    } finally {
      setReloading(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid="workspace-conflict-banner"
      className="px-6 py-2 flex flex-wrap items-center gap-3 bg-[var(--toast-bg)] border-b border-[var(--toast-border)] text-[var(--toast-text)] text-ui-caption"
    >
      <span className="min-w-0 flex-1">
        This workspace changed in another tab. Reload to see the latest version. Your changes in this tab since the
        last save are not saved.
      </span>
      <Button size="sm" onClick={() => void reload()} disabled={reloading}>
        Reload
      </Button>
    </div>
  );
}
