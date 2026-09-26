/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Removed from roster" list under TeamRosterPanel's roster table — split out
 * of the panel body so this branch of markup isn't inline in that function.
 */
import { Undo2 } from 'lucide-react';
import type { Gender, Workspace } from '@omniswim/core/types';
import { normalizeSwimmerName } from '@omniswim/core/lib/utils';
import { restoreSwimmerToWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';
import { Button } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  gender: Gender;
  editable: boolean;
  onWorkspaceUpdate?: (patch: Partial<Workspace>) => void;
};

export default function RemovedSwimmersSection({ workspace, gender, editable, onWorkspaceUpdate }: Props) {
  const deleted = (workspace.deletedSwimmers ?? []).filter(d => d.gender === gender);
  if (!deleted.length) return null;

  return (
    <div className="mt-3 border border-theme-soft rounded-xl p-3.5 surface-muted-bg">
      <h5 className="text-ui-caption font-semibold text-theme-secondary mb-2">Removed from roster</h5>
      <ul className="space-y-2">
        {deleted.map(d => (
          <li
            key={`${d.gender}|${normalizeSwimmerName(d.name)}`}
            className="flex items-center justify-between gap-3 text-ui-body"
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="text-[var(--text-primary)] truncate min-w-0" title={d.name}>
                {d.name}
              </span>
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded-full text-ui-caption font-medium ${
                  d.mode === 'removed'
                    ? 'border border-rose-400/40 text-rose-400'
                    : 'border border-theme-soft text-theme-secondary'
                }`}
                title={
                  d.mode === 'removed'
                    ? 'Permanently removed from the working roster (source PDF kept)'
                    : 'Hidden from the What-if projection only'
                }
              >
                {d.mode === 'removed' ? 'Removed' : 'Hidden'}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!editable || !onWorkspaceUpdate}
              title={editable && onWorkspaceUpdate ? undefined : 'Enable What-if to restore'}
              className="text-[var(--text-accent)] hover:underline shrink-0 disabled:no-underline"
              onClick={() =>
                editable && onWorkspaceUpdate?.(restoreSwimmerToWorkspace(workspace, { name: d.name, gender }))
              }
              leadingIcon={<Undo2 size={12} />}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
