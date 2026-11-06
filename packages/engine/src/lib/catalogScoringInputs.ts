/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Catalog-backed scoring inputs.
// Split out of `utils.ts`, which still re-exports every name from here.

import { Gender, SwimmerResult, Workspace } from '../types';
// A leaf module (types + cutlineEventNames only), so no cycle.
import { eventNotSwumInCourse } from './courseEvents';
import { mergeScoringSettings } from './scoringDefaults';
import { type CatalogEventTime, type CatalogTeamRoster } from './rosterCatalog';
// A leaf module (types + cutlineEventNames only), so no cycle. `rosterCatalog`
// itself imports this file, which is why its helpers are not used here.
import { isRankableSwimCloudStamp, swimEventIdentity } from './bestTimeEligibility';
import { formatSecondsToTime } from './timeFormat';
import { normalizeSwimmerName } from './swimmerNames';

// ===================== Catalog-backed scoring adapter =====================

/**
 * Map a catalog swimmer├ùevent combination into a `SwimmerResult` that drops
 * into the existing points pool. The result deliberately carries
 * `isRecruit: true` and a stable uuid-stable id so it's identical to the
 * injected-recruit path used by `prepareRecruitsForScoring` (`utils.ts:975`).
 *
 * Time is always the SCY-normalized clock because `calculatePoints` works in
 * SCY, but `timeText` keeps the original display value so chart tooltips and
 * audit logs stay readable.
 */
export function buildCatalogEntryResult(
  athleteName: string,
  team: string,
  time: CatalogEventTime,
  classYear?: string | null,
  defaultGender: Gender = Gender.MEN
): SwimmerResult {
  return {
    id: `catalog_${time.id}`,
    rank: 0,
    name: athleteName,
    classYear: classYear ?? 'UNKNOWN',
    team,
    time: formatSecondsToTime(time.timeSecondsScy),
    finalsTime: formatSecondsToTime(time.timeSecondsScy),
    prelimsTime: time.timeType === 'SCY' ? time.timeText : undefined,
    roundSwam: 'A Final',
    points: 0,
    event: time.event,
    gender: defaultGender,
    isRecruit: true,
  };
}

/**
 * The fastest time per event, folding labels of one event (`'50 Free'`,
 * `'50 Freestyle'`) together. A tie keeps the time seen first. Order follows
 * the first appearance of each event.
 */
function fastestCatalogTimePerEvent(times: CatalogEventTime[]): CatalogEventTime[] {
  const best = new Map<string, CatalogEventTime>();
  for (const t of times) {
    const identity = swimEventIdentity(t.event);
    const held = best.get(identity);
    if (!held || t.timeSecondsScy < held.timeSecondsScy) best.set(identity, t);
  }
  return [...best.values()];
}

/**
 * Orders one catalog athlete's eligible times, strongest event first. Gets one
 * time per event and returns the same times, reordered.
 *
 * The production order is `catalogEventOrderByStrength` (eventStrength.ts):
 * place in the loaded meet, then distance to the division cut, then raw
 * seconds. It is passed in, not imported, because this module sits below the
 * cut-table lookup (`cutlineUtils` imports this file).
 */
export type CatalogEventOrder = (
  athleteName: string,
  times: readonly CatalogEventTime[]
) => CatalogEventTime[];

export interface CategorizedScoringInputArgs {
  workspace: Workspace;
  gender: Gender;
  removeSeniors?: boolean;
  /** A catalog roster for the active team. Optional. */
  rosterCatalog?: CatalogTeamRoster;
  /** Max individual entries per swimmer (default: scoring preset or 3). */
  maxIndividualEntriesPerSwimmer?: number;
  /**
   * Which of an athlete's events fill the entry cap first. Every production
   * caller passes `catalogEventOrderByStrength(...)`. Absent, the order is raw
   * SCY seconds, which is only the last-resort rule: it always prefers the
   * shortest events.
   */
  eventOrder?: CatalogEventOrder;
}

/**
 * Build a unified `SwimmerResult[]` ready to feed `calculatePoints` based on
 * the workspace's loaded meet + the (optional) catalog roster.
 *
 * Catalog swims are inserted as `isRecruit` rows already normalized to SCY, so
 * they slot beside the existing recruit injection pathway (rank-by-time, A
 * Final). The `maxIndividualEntriesPerSwimmer` cap is enforced here so the
 * recruiter's per-swimmer entry limit is honored when toggling additional
 * events on. Which events fill that cap is decided by `eventOrder`.
 */
export function buildCategorizedScoringInputs(
  args: CategorizedScoringInputArgs
): SwimmerResult[] {
  const pdfRows =
    args.gender === Gender.MEN
      ? args.workspace.menResults ?? []
      : args.workspace.womenResults ?? [];

  if (!args.rosterCatalog) return pdfRows;

  const merged = mergeScoringSettings(args.workspace.scoringSettings, {
    conference: args.workspace.conference,
  });
  const indCap =
    args.maxIndividualEntriesPerSwimmer ??
    merged.maxIndividualEntriesPerSwimmer ??
    999;

  // Match a swimmer's existing PDF row (if any) so we keep their class year.
  const pdfByName = new Map<string, SwimmerResult>();
  for (const r of pdfRows) {
    if (r.isRelay) continue;
    const key = normalizeSwimmerName(r.name);
    if (!pdfByName.has(key)) pdfByName.set(key, r);
  }

  const team = args.rosterCatalog.team;
  const rosterRows: SwimmerResult[] = [];
  for (const athlete of args.rosterCatalog.athletes) {
    if (athlete.gender !== (args.gender === Gender.WOMEN ? 'Women' : 'Men')) continue;
    // Cap to the swimmer's N strongest events, to keep within entry limits.
    // Only a result is scored: a self-reported time or an extracted split
    // (stamp `U`/`X`) is never an entry. Nor is an event its course does not
    // swim (a 1000 Free SCM): it has no SCY time. One row per event: the fastest.
    const oneTimePerEvent = fastestCatalogTimePerEvent(
      athlete.times
        .filter(t => t.isEligible)
        .filter(t => !t.event.toLowerCase().includes('relay'))
        .filter(t => isRankableSwimCloudStamp(t.swimcloudBadge))
        .filter(t => !eventNotSwumInCourse(t.event, t.timeType))
        // An unreadable time is stored as 0. Scored, it would be a "0.00" that
        // ranks first in every event.
        .filter(t => Number.isFinite(t.timeSecondsScy) && t.timeSecondsScy > 0)
    );
    const strongestFirst = args.eventOrder
      ? args.eventOrder(athlete.fullName, oneTimePerEvent)
      : [...oneTimePerEvent].sort((a, b) => a.timeSecondsScy - b.timeSecondsScy);
    if (strongestFirst.length !== oneTimePerEvent.length) {
      // An order that drops or invents a time would change the entries silently.
      throw new Error(
        `buildCategorizedScoringInputs: eventOrder returned ${strongestFirst.length} times for ${athlete.fullName}, expected ${oneTimePerEvent.length}`
      );
    }
    const eligibleTimes = strongestFirst.slice(0, indCap);

    const pdfMatch = pdfByName.get(normalizeSwimmerName(athlete.fullName));
    const classYear = athlete.classYear ?? pdfMatch?.classYear;

    for (const t of eligibleTimes) {
      rosterRows.push(
        buildCatalogEntryResult(
          athlete.fullName,
          team.name,
          t,
          classYear,
          args.gender
        )
      );
    }
  }

  // Merge without duplicating an event for a swimmer that already has a PDF row.
  // Keyed on the event identity: a catalog '50 Free' and a HyTek
  // 'Event 8 Men 50 Yard Freestyle' are one event, and matching the raw labels
  // let both rows score.
  const taken = new Set(
    rosterRows.map(r => `${normalizeSwimmerName(r.name)}|${swimEventIdentity(r.event)}`)
  );
  const pdfOnly = pdfRows.filter(r => {
    if (r.isRelay) return true;
    const key = `${normalizeSwimmerName(r.name)}|${swimEventIdentity(r.event)}`;
    return !taken.has(key);
  });

  return [...pdfOnly, ...rosterRows];
}
