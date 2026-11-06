/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Meet source copy helpers — frozen PDF baseline vs working roster results.
 */

import { Gender, SwimmerResult, Workspace } from '../types';

/** Deep-clone results so source and working copies do not share object identity. */
export function cloneMeetResults(results: SwimmerResult[] | undefined): SwimmerResult[] {
  if (!results?.length) return [];
  return results.map(r => ({ ...r }));
}

/**
 * Baseline / official meet results for a gender.
 * Falls back to working results when source has not been captured yet (legacy workspaces).
 */
export function getSourceResults(workspace: Workspace, gender: Gender): SwimmerResult[] {
  if (gender === Gender.MEN) {
    return workspace.sourceMenResults ?? workspace.menResults ?? [];
  }
  return workspace.sourceWomenResults ?? workspace.womenResults ?? [];
}

/**
 * Backfill missing source copies from working results (idempotent, no-op when present).
 * Call on load/hydrate so baseline scoring stays stable for unedited meets.
 */
export function withSourceResultsBackfill(workspace: Workspace): Workspace {
  const needsMen = workspace.sourceMenResults == null && (workspace.menResults?.length ?? 0) > 0;
  const needsWomen =
    workspace.sourceWomenResults == null && (workspace.womenResults?.length ?? 0) > 0;
  if (!needsMen && !needsWomen) return workspace;
  return {
    ...workspace,
    ...(needsMen ? { sourceMenResults: cloneMeetResults(workspace.menResults) } : {}),
    ...(needsWomen ? { sourceWomenResults: cloneMeetResults(workspace.womenResults) } : {}),
  };
}

/** Patch fields to set both source and working results from a fresh PDF parse. */
export function meetCopyFromParsed(men: SwimmerResult[], women: SwimmerResult[]): Partial<Workspace> {
  return {
    menResults: cloneMeetResults(men),
    womenResults: cloneMeetResults(women),
    sourceMenResults: cloneMeetResults(men),
    sourceWomenResults: cloneMeetResults(women),
  };
}
