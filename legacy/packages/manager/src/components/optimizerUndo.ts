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
 *
 * The fingerprint also covers `relayLegOverrides`, which the run does not write. A relay leg fill
 * made after the run can name a swimmer the run made a scorer. Undo would flip that swimmer back to
 * non-scorer and keep the fill, and a relay with a non-scorer on it can score nothing. So a fill
 * made after the run expires the Undo, the same as an edit to the three arrays.
 */

import type { Workspace } from '@omniswim/core/types';

/** The three optimizer-owned arrays, with absent read as empty (the same reading the diff uses). */
export type OptimizerOwnedArrays = {
  overrides: NonNullable<Workspace['scorerRosterOverrides']>;
  plans: NonNullable<Workspace['meetEntryPlans']>;
  activeIds: NonNullable<Workspace['activeEntryIds']>;
  /** Not written by a run. Read only to tell whether a leg was filled since. Absent reads as empty. */
  relayOverrides?: NonNullable<Workspace['relayLegOverrides']>;
};

/** The armed Undo of the single most recent applied run. */
export type OptimizerUndo = {
  label: string;
  /** Pre-run arrays, as a workspace patch. */
  patch: Partial<Workspace>;
  /** Fingerprint of the arrays right after the run was applied. */
  appliedFingerprint: string;
  /** The relay leg fills the run was applied over. Undo does not write them. */
  relayOverrides: NonNullable<Workspace['relayLegOverrides']>;
  /** Workspace the run was applied to. Undo never crosses workspaces. */
  workspaceId: string;
};

export const UNDO_CHANGED_MESSAGE = 'Lineup changed since the run. Undo would discard later edits.';

/**
 * The lineup arrays equal the arrays from before the run. Two things can cause that: the apply's
 * save failed and the provider reloaded the server copy, or the coach edited the lineup back by
 * hand. The step cannot tell them apart, so the wording is true in both cases.
 */
export const APPLY_NOT_SAVED_MESSAGE =
  'The lineup is back to how it was before the run. If you did not undo it, the apply was not saved.';

/** The save of an Undo did not go through, so the optimized lineup came back. */
export const UNDO_NOT_SAVED_MESSAGE =
  'The undo was not saved. The optimized lineup is back. Press Undo to try again.';

/** JSON with object keys sorted, so equal content gives an equal string whatever the key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Content fingerprint of the three optimizer-owned arrays and the relay leg fills. Array order
 * counts; key order does not. Absent relay fills read as empty.
 */
export function fingerprintOptimizerArrays(arrays: OptimizerOwnedArrays): string {
  return canonical([arrays.overrides, arrays.plans, arrays.activeIds, arrays.relayOverrides ?? []]);
}

/** The arrays (and relay fills) as a workspace or patch holds them right now. */
export function optimizerArraysOf(
  source: Pick<Workspace, 'scorerRosterOverrides' | 'meetEntryPlans' | 'activeEntryIds'> &
    Partial<Pick<Workspace, 'relayLegOverrides'>>
): OptimizerOwnedArrays {
  return {
    overrides: source.scorerRosterOverrides ?? [],
    plans: source.meetEntryPlans ?? [],
    activeIds: source.activeEntryIds ?? [],
    relayOverrides: source.relayLegOverrides ?? [],
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
  // The run does not write relay fills, so the ones present before it are the ones it left.
  const relayOverrides = args.before.relayOverrides ?? [];
  return {
    label: args.label,
    workspaceId: args.workspaceId,
    patch: {
      scorerRosterOverrides: args.before.overrides,
      meetEntryPlans: args.before.plans,
      activeEntryIds: args.before.activeIds,
    },
    appliedFingerprint: fingerprintOptimizerArrays({ ...optimizerArraysOf(args.applied), relayOverrides }),
    relayOverrides,
  };
}

/** True when the live arrays are exactly what the run left, so Undo cannot discard later edits. */
export function optimizerUndoIsClean(undo: OptimizerUndo, current: OptimizerOwnedArrays): boolean {
  return fingerprintOptimizerArrays(current) === undo.appliedFingerprint;
}

/** True when the live arrays equal what Undo writes back (the pre-run arrays). */
export function optimizerUndoTargetReached(undo: OptimizerUndo, current: OptimizerOwnedArrays): boolean {
  return (
    fingerprintOptimizerArrays(current) ===
    fingerprintOptimizerArrays({ ...optimizerArraysOf(undo.patch), relayOverrides: undo.relayOverrides })
  );
}

export type OptimizerUndoState = 'clean' | 'apply_not_saved' | 'changed';

/**
 * What the live arrays say about an armed Undo.
 * - clean: still exactly what the run left.
 * - apply_not_saved: exactly the pre-run arrays. Either the apply's save failed and the provider
 *   reloaded the server copy, or the coach edited the lineup back by hand. There is nothing to undo.
 * - changed: anything else. The coach edited after the run.
 */
export function optimizerUndoState(undo: OptimizerUndo, current: OptimizerOwnedArrays): OptimizerUndoState {
  if (optimizerUndoIsClean(undo, current)) return 'clean';
  if (optimizerUndoTargetReached(undo, current)) return 'apply_not_saved';
  return 'changed';
}
