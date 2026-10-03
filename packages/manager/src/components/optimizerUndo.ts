/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-shot Undo for an applied optimizer run: the record, its safety check, and the wording.
 *
 * The optimizer owns three workspace arrays (`scorerRosterOverrides`, `meetEntryPlans`,
 * `activeEntryIds`). Undo writes the three arrays from BEFORE the run back. If the coach edited
 * the lineup after the run, that write would silently throw those edits away. So each run records
 * a fingerprint of the three arrays as the run left them. Undo compares the live arrays to that
 * fingerprint and only writes back without asking when they still match.
 */

import type { Workspace } from '@omniswim/core/types';

/** The three optimizer-owned arrays, with absent read as empty (the same reading the diff uses). */
export type OptimizerOwnedArrays = {
  overrides: NonNullable<Workspace['scorerRosterOverrides']>;
  plans: NonNullable<Workspace['meetEntryPlans']>;
  activeIds: NonNullable<Workspace['activeEntryIds']>;
};

/** The armed Undo of the single most recent applied run. */
export type OptimizerUndo = {
  label: string;
  /** Pre-run arrays, as a workspace patch. */
  patch: Partial<Workspace>;
  /** Fingerprint of the arrays right after the run was applied. */
  appliedFingerprint: string;
  /** Workspace the run was applied to. Undo never crosses workspaces. */
  workspaceId: string;
};

export const UNDO_CHANGED_MESSAGE = 'Lineup changed since the run. Undo would discard later edits.';

/** JSON with object keys sorted, so equal content gives an equal string whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Content fingerprint of the three optimizer-owned arrays. Array order counts; key order does not. */
export function fingerprintOptimizerArrays(arrays: OptimizerOwnedArrays): string {
  return canonical([arrays.overrides, arrays.plans, arrays.activeIds]);
}

/** The three arrays as a workspace or patch holds them right now. */
export function optimizerArraysOf(source: Pick<Workspace, 'scorerRosterOverrides' | 'meetEntryPlans' | 'activeEntryIds'>): OptimizerOwnedArrays {
  return {
    overrides: source.scorerRosterOverrides ?? [],
    plans: source.meetEntryPlans ?? [],
    activeIds: source.activeEntryIds ?? [],
  };
}

/**
 * Build the Undo record for a run. `before` is the pre-run state; `applied` is the patch that was
 * written (the post-run arrays).
 */
export function buildOptimizerUndo(args: {
  label: string;
  workspaceId: string;
  before: OptimizerOwnedArrays;
  applied: Pick<Workspace, 'scorerRosterOverrides' | 'meetEntryPlans' | 'activeEntryIds'>;
}): OptimizerUndo {
  return {
    label: args.label,
    workspaceId: args.workspaceId,
    patch: {
      scorerRosterOverrides: args.before.overrides,
      meetEntryPlans: args.before.plans,
      activeEntryIds: args.before.activeIds,
    },
    appliedFingerprint: fingerprintOptimizerArrays(optimizerArraysOf(args.applied)),
  };
}

/** True when the live arrays are exactly what the run left, so Undo cannot discard later edits. */
export function optimizerUndoIsClean(undo: OptimizerUndo, current: OptimizerOwnedArrays): boolean {
  return fingerprintOptimizerArrays(current) === undo.appliedFingerprint;
}
