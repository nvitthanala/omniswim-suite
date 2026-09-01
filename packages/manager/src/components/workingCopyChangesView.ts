/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for WorkingCopyChangesPanel — none of this touches
 * React.
 */

import type { Gender, Workspace } from '@omniswim/core/types';
import type { RevertibleChange } from '@omniswim/core/lib/workingCopyChanges';
import { restoreSwimmerToWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';

export function changeRowKey(change: RevertibleChange): string {
  return change.kind === 'recruit' ? `recruit:${change.id}` : `removal:${change.name}`;
}

export function canRevertChange(change: RevertibleChange): boolean {
  return change.kind === 'recruit' || change.fullyRestorable;
}

/**
 * An athlete can have several recruit rows (one per event), so the name alone
 * repeats — include the detail so each button is distinguishable to a screen
 * reader, not just visually by position.
 */
export function changeRowAriaLabel(change: RevertibleChange): string {
  return change.kind === 'recruit'
    ? `Revert recruit ${change.label} — ${change.detail}`
    : `Revert removal of ${change.label}`;
}

export function changeRowButtonText(change: RevertibleChange): string {
  return change.kind === 'removal' && !change.fullyRestorable ? 'Restore (rows unavailable)' : 'Revert';
}

/** The patch that reverting `change` applies to the workspace. */
export function revertChangePatch(workspace: Workspace, gender: Gender, change: RevertibleChange): Partial<Workspace> {
  if (change.kind === 'recruit') {
    return { recruits: (workspace.recruits ?? []).filter(r => r.id !== change.id) };
  }
  return restoreSwimmerToWorkspace(workspace, { name: change.name, gender });
}
