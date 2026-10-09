/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one text that marks a workspace as a theoretical meet, and the check that reads it.
 *
 * This module has no imports beyond a type, so the shell (to gate its banner) and Metrics (to skip
 * seed times as comparison times) can use it without loading the manager bundle. The manager's
 * `theoreticalMeetWorkspace.ts` re-exports these names, so existing imports keep working.
 */

import type { LoadedMeetMeta, SwimmerResult } from '../types';

/** The text that marks a workspace as a theoretical meet. */
export const THEORETICAL_MEET_LABEL = 'Theoretical meet (seeded from crawled teams)';

/** True when the workspace's loaded meet is a theoretical meet. Reads `loadedMeet.meetLabel` only. */
export function isTheoreticalMeet(workspace: { readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel'> | null } | null | undefined): boolean {
  return workspace?.loadedMeet?.meetLabel === THEORETICAL_MEET_LABEL;
}

/**
 * Whether a row of this workspace is an estimated relay. In a theoretical meet nobody swam any relay, so
 * every relay row is one: its team time is the sum of four swimmers' individual bests. False for a row of
 * any other workspace.
 */
export function isEstimatedRelayRow(
  workspace: { readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel'> | null } | null | undefined,
  row: Pick<SwimmerResult, 'isRelay' | 'event'>
): boolean {
  return isTheoreticalMeet(workspace) && (row.isRelay === true || /\brelay\b/i.test(row.event ?? ''));
}
