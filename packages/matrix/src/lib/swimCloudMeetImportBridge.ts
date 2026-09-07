/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Converts `@omniswim/swimcloud`'s `SwimCloudMeetResultsParse` into this
 * app's own `SwimmerResult[]` shape — the same shape `/api/parse-pdf`
 * produces — so a SwimCloud meet-results capture can become a "loaded meet"
 * in Matrix (`OpsModule.tsx`'s `handleFileUpload`) exactly like a PDF upload
 * does, feeding the same live scoring pipeline.
 *
 * Lives here, in `packages/matrix`, not `packages/core` or `packages/swimcloud`
 * — same reasoning as `packages/manager/src/lib/swimCloudImportBridge.ts`:
 * `packages/core` shouldn't need to know SwimCloud exists, and
 * `packages/swimcloud` shouldn't need to know this app's `SwimmerResult`
 * shape exists. This module is the one place allowed to know both.
 *
 * ## Points: trusted here, unlike the Manager-side bridge
 *
 * `HistoricalSwim` (the Manager-side bridge's target) has no points field at
 * all, so that bridge never had to decide whether to trust SwimCloud's
 * printed points. `SwimmerResult` does have one, twice over: `points` (what
 * gets displayed/summed) and `pdfPoints` (a source's own points, which — when
 * present and `usePdfPlacePoints` is on — *overrides* whatever the app would
 * otherwise compute from rank and a point table;
 * `packages/core/src/lib/scoringDefaults.ts`). The user confirmed directly
 * (2026-09-07) that SwimCloud's printed points are trustworthy, so this
 * bridge populates `pdfPoints` from `SwimCloudResult.points` and expects its
 * caller to turn `usePdfPlacePoints` on — the exact same trust mechanism a
 * PDF upload already uses, not a new one invented for SwimCloud.
 *
 * ## Rank, for a row with no place
 *
 * `SwimmerResult.rank` is a required `number`. `packages/core`'s own
 * `calculatePoints` already defends against a messy rank with
 * `parseRankInt(a.rank) ?? 9999` — sorts-last, never scores. This bridge
 * uses that same sentinel explicitly for a DQ/no-show/exhibition row with no
 * real place, rather than inventing a different convention.
 *
 * ## Time, for a non-finishing row
 *
 * Mirrors `backend/pdf_parser.py`'s own convention exactly: the marker
 * (`DQ`, `NS`, `SCR`, …) goes directly into the `time` field, verbatim — not
 * a separate flag column the rest of the app doesn't expect.
 *
 * ## Relays are included here — unlike the Manager-side bridge, which excludes them
 *
 * `HistoricalSwim` has no concept of a relay leg's split being a *different
 * kind of fact* from an individual swim, so the Manager bridge excludes relay
 * events outright (a leg's split isn't a valid individual time). `SwimmerResult`
 * is not that shape — it already has first-class relay fields (`isRelay`,
 * `relayNames`, `relayLegSplit`, …) because a loaded meet is expected to
 * contain relays. So here, a relay event becomes one `SwimmerResult` row per
 * relay (team-level: name is the team, time/points/rank are the relay's own),
 * with `relayNames` populated from its legs when SwimCloud published them.
 */

import { Gender } from '@omniswim/core/types';
import type { SwimmerResult } from '@omniswim/core/types';
import type { SwimCloudEvent } from '@omniswim/swimcloud/entities';
import type { SwimCloudMeetResultsParse } from '@omniswim/swimcloud/parser';

export type SwimCloudMeetImportSkipReason =
  /** The event's gender could not be determined from its heading — never guessed which side of the meet it belongs to. */
  | 'unknown-gender'
  /** No team name was captured for this entry at all. */
  | 'no-team-name'
  /** An individual entry has no athlete name (a relay's own "name" is its team, not an individual — see the file header). */
  | 'no-athlete-name';

export interface SwimCloudMeetImportSkip {
  readonly reason: SwimCloudMeetImportSkipReason;
  readonly eventLabel: string;
  readonly subject?: string;
}

export interface SwimCloudMeetImportResult {
  readonly men: readonly SwimmerResult[];
  readonly women: readonly SwimmerResult[];
  readonly skipped: readonly SwimCloudMeetImportSkip[];
}

/** Matches `parseRankInt(...) ?? 9999`'s existing fallback in `packages/core/src/lib/utils.ts` — the app's own scoring code already treats this as "unrankable, sorts last, never scores." Not a new convention. */
const UNRANKED_SENTINEL = 9999;

function mapGender(g: SwimCloudEvent['gender']): Gender | undefined {
  if (g === 'Men') return Gender.MEN;
  if (g === 'Women') return Gender.WOMEN;
  return undefined;
}

/** `backend/pdf_parser.py`'s own convention: a non-finishing marker lives directly in the time field, verbatim. `'NT'` (No Time) is HyTek's own marker for a row with neither a time nor a recognized marker — a defensive default, not expected to actually fire for a row that reached this point. */
function timeOrMarker(finalTime: string | undefined, rawTimeToken: string | undefined): string {
  return finalTime ?? rawTimeToken ?? 'NT';
}

export function swimCloudMeetResultsToSwimmerResults(parse: SwimCloudMeetResultsParse): SwimCloudMeetImportResult {
  const men: SwimmerResult[] = [];
  const women: SwimmerResult[] = [];
  const skipped: SwimCloudMeetImportSkip[] = [];

  for (const parsedEvent of parse.events) {
    const gender = mapGender(parsedEvent.event.gender);
    if (gender === undefined) {
      skipped.push({ reason: 'unknown-gender', eventLabel: parsedEvent.event.label });
      continue;
    }
    const bucket = gender === Gender.MEN ? men : women;
    const isRelay = parsedEvent.event.kind === 'relay';

    for (const entry of parsedEvent.entries) {
      const result = parsedEvent.results.find(r => r.entryId === entry.entryId);
      const time = timeOrMarker(result?.finalTime, result?.rawTimeToken);
      const rank = result?.place ?? UNRANKED_SENTINEL;
      const points = result?.points ?? 0;

      if (isRelay) {
        const relay = parsedEvent.relays.find(r => r.relayId === entry.relayId);
        const teamName = relay?.teamName ?? entry.teamName;
        if (teamName === undefined) {
          skipped.push({ reason: 'no-team-name', eventLabel: parsedEvent.event.label });
          continue;
        }
        bucket.push({
          id: entry.entryId,
          rank,
          name: teamName,
          classYear: 'unknown',
          team: teamName,
          time,
          points,
          event: parsedEvent.event.label,
          gender,
          isRelay: true,
          ...(relay !== undefined && relay.legs.length > 0
            ? { relayNames: relay.legs.map(leg => ({ name: leg.athleteName ?? '', year: '' })) }
            : {}),
          ...(result?.flags?.exhibition === true ? { isExhibition: true } : {}),
          ...(result?.points !== undefined ? { pdfPoints: result.points } : {}),
        });
      } else {
        const name = entry.athleteName;
        if (name === undefined) {
          skipped.push({ reason: 'no-athlete-name', eventLabel: parsedEvent.event.label });
          continue;
        }
        const team = entry.teamName;
        if (team === undefined) {
          skipped.push({ reason: 'no-team-name', eventLabel: parsedEvent.event.label, subject: name });
          continue;
        }
        bucket.push({
          id: entry.entryId,
          rank,
          name,
          classYear: 'unknown',
          team,
          time,
          points,
          event: parsedEvent.event.label,
          gender,
          ...(result?.flags?.exhibition === true ? { isExhibition: true } : {}),
          ...(result?.points !== undefined ? { pdfPoints: result.points } : {}),
        });
      }
    }
  }

  return { men, women, skipped };
}
