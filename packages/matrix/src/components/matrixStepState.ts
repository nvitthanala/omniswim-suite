/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Matrix workflow step ids and the rules for which one opens first.
 *
 * Phase 5 folded the old Score step into the first step and renamed Load to
 * Meet. A step id saved in `sessionStorage` before that change can still be
 * `load` or `score`. Both now mean the Meet step, so a stored value from an
 * older build lands on a real step instead of falling through to the default.
 */

export type MatrixStepId = 'meet' | 'standings' | 'analyze';

export const MATRIX_STEP_IDS: readonly MatrixStepId[] = ['meet', 'standings', 'analyze'];

/** The `sessionStorage` key that holds the step for one workspace. */
export function matrixStepStorageKey(workspaceId: string): string {
  return `matrix-step:${workspaceId}`;
}

/** Maps a stored value to a current step id, or null when it names no step. */
export function normalizeStoredMatrixStep(saved: string | null | undefined): MatrixStepId | null {
  if (saved === 'load' || saved === 'score') return 'meet';
  return MATRIX_STEP_IDS.find(id => id === saved) ?? null;
}

/**
 * The step a workspace opens on. A saved step wins. Without one, a workspace
 * that already has a meet opens on Standings and an empty one opens on Meet.
 */
export function resolveInitialMatrixStep(
  saved: string | null | undefined,
  hasLoadedMeet: boolean
): MatrixStepId {
  return normalizeStoredMatrixStep(saved) ?? (hasLoadedMeet ? 'standings' : 'meet');
}
