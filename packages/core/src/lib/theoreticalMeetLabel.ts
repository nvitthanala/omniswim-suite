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

import type { LoadedMeetMeta, SwimmerResult, TheoreticalRemovedEvent } from '../types';

/** The text that marks a workspace as a theoretical meet. */
export const THEORETICAL_MEET_LABEL = 'Theoretical meet (seeded from crawled teams)';

/** True when the workspace's loaded meet is a theoretical meet. Reads `loadedMeet.meetLabel` only. */
export function isTheoreticalMeet(workspace: { readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel'> | null } | null | undefined): boolean {
  return workspace?.loadedMeet?.meetLabel === THEORETICAL_MEET_LABEL;
}

/**
 * The events the user removed from lineups when the meet was built.
 *
 * - `undefined`: not a theoretical meet, or one built before the list was kept.
 *   Nothing is known, and a reader must not say "none were removed".
 * - `[]`: the build recorded no removal.
 * - Otherwise: each removed (swimmer, event), in the order the build report held them.
 */
export function theoreticalRemovedEvents(
  workspace:
    | { readonly loadedMeet?: Pick<LoadedMeetMeta, 'meetLabel' | 'theoreticalRemovedEvents'> | null }
    | null
    | undefined
): readonly TheoreticalRemovedEvent[] | undefined {
  if (!isTheoreticalMeet(workspace)) return undefined;
  const list = workspace?.loadedMeet?.theoreticalRemovedEvents;
  return Array.isArray(list) ? list : undefined;
}

/**
 * The id prefix of every relay leg row a theoretical meet writes (`tmresrelay|{workspaceId}|...|leg{n}`).
 * The builder (`theoreticalRelayLegRowId`) and {@link isTheoreticalRelayLegRowId} share it.
 */
export const THEORETICAL_RELAY_LEG_ROW_ID_PREFIX = 'tmresrelay|';

/**
 * True when a row id is the id of a theoretical meet's relay leg row. Nobody swam such a relay, so no
 * leg time on the row is a measured split.
 */
export function isTheoreticalRelayLegRowId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(THEORETICAL_RELAY_LEG_ROW_ID_PREFIX);
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
