/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bulk form of core's `setCreditedSwimProgramStatus`, for the athlete drawer's
 * "Confirm all N swims" button. One patch and one Undo for the whole set.
 *
 * Core flips one row per call. This folds the calls over a working copy so each
 * sees the rows the earlier ones changed. Every call touches the same results
 * array, so the last patch is the full forward patch and the first inverse is
 * the exact prior array.
 */
import type { Gender, Workspace } from '@omniswim/core/types';
import { setCreditedSwimProgramStatus, type WorkspaceEditorPatch } from '@omniswim/core/lib/swimEditor';

export function setCreditedSwimsProgramStatus(
  workspace: Workspace,
  gender: Gender,
  rowIds: readonly string[],
  status: 'program' | 'unconfirmed'
): WorkspaceEditorPatch {
  if (rowIds.length === 0) throw new Error('setCreditedSwimsProgramStatus: no swims given.');
  let current = workspace;
  let first: WorkspaceEditorPatch | null = null;
  let last: WorkspaceEditorPatch | null = null;
  for (const id of rowIds) {
    const step = setCreditedSwimProgramStatus(current, gender, id, status);
    first ??= step;
    last = step;
    current = { ...current, ...step.patch };
  }
  const n = rowIds.length;
  return {
    patch: last!.patch,
    inverse: first!.inverse,
    description:
      n === 1
        ? first!.description
        : `Mark ${n} swims as ${status === 'program' ? 'program swims' : 'unconfirmed'}`,
  };
}
