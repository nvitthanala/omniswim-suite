/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reading a swimmer's class year (R51, plans/2026-10-25/D3-STORAGE-AND-BUILD.md section 14).
 *
 * Two places hold a class year, and they stay apart:
 * - the user's override: `classYearOverrides`, key [swimmerId, seasonId], user data with rev and updatedAt;
 * - the sourced value: `RosterRecord.classYears`, as SwimCloud showed it, with the roster's sourceUrl and fetchedAt.
 *
 * A read gives the override if there is one, else the sourced value with its source, else `absent`.
 * `absent` is never a default class year: nothing here returns 'FR', null or ''.
 */
import type { Gender } from '@omniswim/engine';
import type { StorageRepo } from './repo';
import type { ClassYearCode, ClassYearOverrideRecord, IsoTime, RosterRecord, SwimCloudId } from './schema';

export type ResolvedClassYear =
  /** The user set it. It wins over SwimCloud. `rev` and `updatedAt` say which edit. */
  | { readonly state: 'user'; readonly classYear: ClassYearCode; readonly rev: number; readonly updatedAt: IsoTime }
  /** SwimCloud showed it. The source is the roster that carried it. */
  | { readonly state: 'sourced'; readonly classYear: ClassYearCode; readonly sourceUrl: string; readonly fetchedAt: IsoTime }
  /** No override and no sourced value. */
  | { readonly state: 'absent' };

export interface ClassYearInput {
  readonly swimmerId: SwimCloudId;
  readonly seasonId: string;
  /** The stored override for this swimmer and season, if any. */
  readonly override?: ClassYearOverrideRecord;
  /** The stored roster of the swimmer's team for this season, if any. */
  readonly roster?: RosterRecord;
}

/**
 * Pure. Throws `RangeError` when `override` is for another swimmer or season, or `roster` is for another
 * season: returning their value would answer a question nobody asked.
 */
export function resolveClassYear(input: ClassYearInput): ResolvedClassYear {
  const { swimmerId, seasonId, override, roster } = input;
  if (override !== undefined && (override.swimmerId !== swimmerId || override.seasonId !== seasonId)) {
    throw new RangeError(`resolveClassYear: override is for ${override.swimmerId}/${override.seasonId}, not ${swimmerId}/${seasonId}`);
  }
  if (roster !== undefined && roster.seasonId !== seasonId) {
    throw new RangeError(`resolveClassYear: roster is for season ${roster.seasonId}, not ${seasonId}`);
  }
  if (override !== undefined) return { state: 'user', classYear: override.classYear, rev: override.rev, updatedAt: override.updatedAt };
  const sourced = roster?.classYears !== undefined && Object.hasOwn(roster.classYears, swimmerId) ? roster.classYears[swimmerId] : undefined;
  if (roster !== undefined && sourced !== undefined) {
    return { state: 'sourced', classYear: sourced, sourceUrl: roster.sourceUrl, fetchedAt: roster.fetchedAt };
  }
  return { state: 'absent' };
}

export interface ClassYearQuery {
  readonly swimmerId: SwimCloudId;
  readonly seasonId: string;
  /** The swimmer's team, to find the roster that may carry the sourced value. */
  readonly teamId: SwimCloudId;
  readonly gender: Gender;
}

/** Reads the override and the roster from storage and resolves them. */
export async function readClassYear(repo: StorageRepo, query: ClassYearQuery): Promise<ResolvedClassYear> {
  const { swimmerId, seasonId, teamId, gender } = query;
  const [override, roster] = await Promise.all([repo.get('classYearOverrides', [swimmerId, seasonId]), repo.get('rosters', [teamId, seasonId, gender])]);
  return resolveClassYear({
    swimmerId,
    seasonId,
    ...(override.found ? { override: override.value } : {}),
    ...(roster.found ? { roster: roster.value } : {}),
  });
}
