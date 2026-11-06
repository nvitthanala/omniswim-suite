/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.1a: turn the pages of a finished fetch run into stored rosters (D7 section 4). Runs in the docked panel, an extension page and an
 * allowed writer of the `rosters` store (decision W). The pages came from the overlay as raw text; this file parses them again.
 *
 * - Each page is read with `readRosterFetch` against the target THIS panel asked for, never against what the page claims.
 * - `members` and `verified-empty` are written with `putCache('rosters', ...)`, which validates the record.
 * - A refused page writes nothing and keeps the earlier record for that team and season. The other pages of the run are still judged on
 *   their own: one team's unmapped Class word does not discard another team's roster (D7 U7 refuses "the whole roster", not the run).
 * - A run that did not finish never reaches this file (`fetchClient.ts`): a failed run writes nothing at all.
 */
import { readRosterFetch } from '@omniswim/swimcloud/browser';
import type { RosterFetchOutcome, RosterFetchRefusalCode } from '@omniswim/swimcloud/browser';
import { toSwimCloudId, verifiedEmptyRoster } from '../storage';
import type { RosterRecord, StorageRepo } from '../storage';
import type { PlannedRosterRequest } from './rosterPlan';
import type { DeliveredItem } from './fetchClient';

export type RosterSaveStatus =
  | { readonly kind: 'saved'; readonly seasonLabel: string; readonly members: number; readonly withClassYear: number }
  | { readonly kind: 'saved-empty'; readonly seasonLabel: string }
  | { readonly kind: 'refused'; readonly code: RosterFetchRefusalCode | 'wrong-content-type'; readonly detail: string }
  | { readonly kind: 'write-failed'; readonly detail: string };

export interface RosterSaveReport {
  readonly request: PlannedRosterRequest;
  readonly fetchedAt: string;
  readonly status: RosterSaveStatus;
}

const HTML_TYPE = /^text\/html\b/i;
const SWIMCLOUD_ORIGIN = 'https://www.swimcloud.com';

/** The record for a parsed page. `sourceUrl` is the URL that was requested. Throws (a `RangeError`) on an id the store would reject. */
export function rosterRecordFor(outcome: Exclude<RosterFetchOutcome, { kind: 'refused' }>, item: Pick<DeliveredItem<PlannedRosterRequest>, 'path' | 'fetchedAt'>): RosterRecord {
  const base = {
    teamId: toSwimCloudId(outcome.teamId),
    seasonId: outcome.seasonLabel,
    gender: outcome.gender,
    sourceUrl: `${SWIMCLOUD_ORIGIN}${item.path}`,
    fetchedAt: item.fetchedAt,
    parser: { name: outcome.parser.name, confidence: outcome.parser.confidence },
  };
  if (outcome.kind === 'verified-empty') return verifiedEmptyRoster(base);
  const classYears = outcome.classYears;
  return {
    ...base,
    memberIds: outcome.memberIds.map(toSwimCloudId),
    ...(classYears === undefined ? {} : { classYears: Object.fromEntries(Object.entries(classYears).map(([id, code]) => [toSwimCloudId(id), code])) }),
  };
}

/** Parse and store every page of a finished run. Never throws for page content or for a failed write; each page gets a report. */
export async function saveRosterRun(items: readonly DeliveredItem<PlannedRosterRequest>[], repo: Pick<StorageRepo, 'putCache'>): Promise<readonly RosterSaveReport[]> {
  const reports: RosterSaveReport[] = [];
  for (const item of items) {
    const { request } = item;
    const done = (status: RosterSaveStatus): void => { reports.push({ request, fetchedAt: item.fetchedAt, status }); };
    if (!HTML_TYPE.test(item.contentType)) { done({ kind: 'refused', code: 'wrong-content-type', detail: `The page came back as ${JSON.stringify(item.contentType)}, not HTML.` }); continue; }
    const outcome = readRosterFetch(item.body, {
      target: request.target,
      requestedPath: item.path,
      finalPath: item.finalPath,
      fetchedAt: item.fetchedAt,
      ...(request.expectedSeasonLabel === undefined ? {} : { expectedSeasonLabel: request.expectedSeasonLabel }),
    });
    if (outcome.kind === 'refused') { done({ kind: 'refused', code: outcome.code, detail: outcome.detail }); continue; }
    try {
      await repo.putCache('rosters', rosterRecordFor(outcome, item));
      done(outcome.kind === 'verified-empty'
        ? { kind: 'saved-empty', seasonLabel: outcome.seasonLabel }
        : { kind: 'saved', seasonLabel: outcome.seasonLabel, members: outcome.memberIds.length, withClassYear: Object.keys(outcome.classYears ?? {}).length });
    } catch (error) {
      done({ kind: 'write-failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return reports;
}
