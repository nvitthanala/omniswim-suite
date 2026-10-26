/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Roster state (R53, plans/2026-10-25/D3-STORAGE-AND-BUILD.md section 14).
 *
 * A roster has three states that must never blur:
 * - `not-loaded`: no record. The season was never fetched, or the fetch failed (nothing is written).
 * - `verified-empty`: a record with `verifiedEmpty: true`. SwimCloud was fetched and listed no swimmers.
 * - `members`: a record with at least one member.
 *
 * The validator guarantees that `memberIds` is empty if and only if `verifiedEmpty` is true, so
 * reading the record is enough. Storage cannot check the writer's claim that SwimCloud listed no
 * swimmers: a parser sets the mark only on positive evidence, never because it parsed nothing.
 */
import type { Gender } from '@omniswim/engine';
import type { StorageRepo } from './repo';
import type { RosterRecord, SwimCloudId } from './schema';

export type RosterState =
  | { readonly state: 'not-loaded' }
  | { readonly state: 'verified-empty'; readonly record: RosterRecord }
  | { readonly state: 'members'; readonly record: RosterRecord };

export interface RosterKey {
  readonly teamId: SwimCloudId;
  readonly seasonId: string;
  readonly gender: Gender;
}

/**
 * A verified-empty roster record: no members, the mark set, and the source and fetch time the caller
 * gives. Pass it to `putCache('rosters', ...)`, which validates it.
 */
export function verifiedEmptyRoster(input: Omit<RosterRecord, 'memberIds' | 'verifiedEmpty' | 'classYears'>): RosterRecord {
  return { ...input, memberIds: [], verifiedEmpty: true };
}

/** `verified-empty` or `members` for a stored record. Throws on a record the validator would have refused. */
export function classifyRoster(record: RosterRecord): 'verified-empty' | 'members' {
  const empty = record.memberIds.length === 0;
  if (empty !== (record.verifiedEmpty === true)) {
    throw new RangeError(
      `classifyRoster: roster ${record.teamId}/${record.seasonId}/${record.gender} has ${record.memberIds.length} members and verifiedEmpty ${String(record.verifiedEmpty)}`
    );
  }
  return empty ? 'verified-empty' : 'members';
}

export async function readRosterState(repo: StorageRepo, key: RosterKey): Promise<RosterState> {
  const found = await repo.get('rosters', [key.teamId, key.seasonId, key.gender]);
  if (!found.found) return { state: 'not-loaded' };
  return { state: classifyRoster(found.value), record: found.value };
}
