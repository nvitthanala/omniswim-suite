/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P8 — after a re-crawl, tell a coach which swimmers improved.
 *
 * The browser extension can now re-fetch a swimmer's personal-bests page on
 * request, and the capture store overwrites the previous page when it does —
 * there is no "before" kept anywhere in the capture itself. Rather than teach
 * the capture store to snapshot a swimmer's prior parse (a store change, and
 * one more thing that can drift out of sync with what actually got imported),
 * this compares the *freshly converted* capture against what the workspace
 * already holds: `HistoricalSwim` rows with `source: 'swimcloud'` for that
 * swimmer. The workspace's own history *is* the "before" picture — it is
 * exactly what the last import wrote — so nothing needs to be kept twice.
 *
 * This module is deliberately downstream of `swimCloudImportBridge.ts`'s
 * converters, not of the SwimCloud parser's own types: both the "old" and
 * "new" sides it compares are `HistoricalSwim[]`, so it can reuse
 * `@omniswim/core`'s one answer to "may this swim be a best?"
 * (`isRankableSwim`) and "do these two swims compete for the same best?"
 * (`swimEventIdentity`) instead of re-deriving either rule against SwimCloud's
 * tag shape. An extracted split or a self-reported time never counts as a
 * "before" or an "after" here, for the same reason it never counts as a best
 * anywhere else in this app.
 */

import type { Gender, HistoricalSwim } from '@omniswim/core/types';
import { isRankableSwim, swimEventIdentity } from '@omniswim/core/lib/bestTimeEligibility';
import { canonicalSwimmerName, convertTimeToSeconds, foldDiacritics, isDivingEvent } from '@omniswim/core/lib/utils';

export type SwimCloudImprovementKind = 'new_event' | 'faster';

/** One event where a fresh capture beats what the workspace already held. */
export interface SwimCloudEventImprovement {
  /** `swimEventIdentity(event)`, folded — the key two labels of the same event share. */
  readonly eventIdentity: string;
  /** The event exactly as the new swim's row prints it, e.g. `'100 Back SCY'`. */
  readonly eventLabel: string;
  readonly course?: HistoricalSwim['timeType'];
  readonly kind: SwimCloudImprovementKind;
  /** True for a diving score, where a *larger* number is the improvement. */
  readonly isDiving: boolean;
  /** The new best, verbatim — a time string, or a diving score. */
  readonly newTime: string;
  /** Absent for `kind: 'new_event'` — there is nothing to have been slower than. */
  readonly oldTime?: string;
  /** Seconds gained, always positive. Swim events only (`isDiving: false`). */
  readonly deltaSeconds?: number;
  /** Points gained, always positive. Diving events only (`isDiving: true`). */
  readonly deltaScore?: number;
  /**
   * The new best is an altitude-adjusted time (`HistoricalSwim.isAltitudeAdjusted`).
   * Still a real improvement — the NCAA enters the adjusted time — carried
   * through only so a UI can mark it, same as everywhere else this flag travels.
   */
  readonly isAltitudeAdjusted?: true;
}

/** The rankable best per event+course, `mergeHistoryIndex`'s lane rule applied to one list. */
function bestRankableByEventCourse(swims: readonly HistoricalSwim[]): Map<string, HistoricalSwim> {
  const best = new Map<string, HistoricalSwim>();
  for (const swim of swims) {
    if (!isRankableSwim(swim)) continue;
    const key = eventCourseKey(swim);
    const held = best.get(key);
    if (!held || isBetterMark(swim, held)) best.set(key, swim);
  }
  return best;
}

function eventCourseKey(swim: HistoricalSwim): string {
  return `${swimEventIdentity(swim.event)}|${swim.timeType ?? 'unknown'}`;
}

/** A dive keeps the higher score; a swim keeps the lower time. Mirrors `athleteHistory.ts`'s `isBetterStoredMark`. */
function isBetterMark(candidate: HistoricalSwim, held: HistoricalSwim): boolean {
  if (isDivingEvent(candidate.event)) {
    const next = parseFloat(candidate.time);
    const prev = parseFloat(held.time);
    if (!Number.isFinite(next)) return false;
    return !Number.isFinite(prev) || next > prev;
  }
  return convertTimeToSeconds(candidate.time) < convertTimeToSeconds(held.time);
}

/**
 * Compare one swimmer's freshly converted capture against what the workspace
 * already stores for them.
 *
 * Reports only what counts as an improvement: a new event the old list never
 * had a rankable best in, or a rankable best that got faster (more points, for
 * a dive). A slower time and an unchanged time are both real facts but neither
 * is an improvement, so neither is reported — a coach asked "who improved,"
 * not "what changed."
 *
 * Course is part of the identity, same as `mergeHistoryIndex`: a `50 Free SCY`
 * and a `50 Free LCM` are different events, not two readings of one.
 */
export function diffSwimCloudPersonalBests(
  oldSwims: readonly HistoricalSwim[],
  newSwims: readonly HistoricalSwim[],
): readonly SwimCloudEventImprovement[] {
  const oldBest = bestRankableByEventCourse(oldSwims);
  const improvements: SwimCloudEventImprovement[] = [];

  for (const swim of bestRankableByEventCourse(newSwims).values()) {
    const old = oldBest.get(eventCourseKey(swim));
    const diving = isDivingEvent(swim.event);

    if (!old) {
      improvements.push({
        eventIdentity: swimEventIdentity(swim.event),
        eventLabel: swim.event,
        ...(swim.timeType ? { course: swim.timeType } : {}),
        kind: 'new_event',
        isDiving: diving,
        newTime: swim.time,
        ...(swim.isAltitudeAdjusted ? { isAltitudeAdjusted: true as const } : {}),
      });
      continue;
    }

    if (diving) {
      const oldScore = parseFloat(old.time);
      const newScore = parseFloat(swim.time);
      if (!Number.isFinite(oldScore) || !Number.isFinite(newScore) || newScore <= oldScore) continue;
      improvements.push({
        eventIdentity: swimEventIdentity(swim.event),
        eventLabel: swim.event,
        ...(swim.timeType ? { course: swim.timeType } : {}),
        kind: 'faster',
        isDiving: true,
        newTime: swim.time,
        oldTime: old.time,
        deltaScore: newScore - oldScore,
        ...(swim.isAltitudeAdjusted ? { isAltitudeAdjusted: true as const } : {}),
      });
      continue;
    }

    const oldSeconds = convertTimeToSeconds(old.time);
    const newSeconds = convertTimeToSeconds(swim.time);
    if (!Number.isFinite(oldSeconds) || !Number.isFinite(newSeconds) || newSeconds >= oldSeconds) continue;
    improvements.push({
      eventIdentity: swimEventIdentity(swim.event),
      eventLabel: swim.event,
      ...(swim.timeType ? { course: swim.timeType } : {}),
      kind: 'faster',
      isDiving: false,
      newTime: swim.time,
      oldTime: old.time,
      deltaSeconds: oldSeconds - newSeconds,
      ...(swim.isAltitudeAdjusted ? { isAltitudeAdjusted: true as const } : {}),
    });
  }

  return improvements;
}

/**
 * The subset of a workspace's stored history that is "this swimmer's own
 * SwimCloud-sourced bests" — the "before" side of {@link diffSwimCloudPersonalBests}.
 *
 * Name matching folds through `canonicalSwimmerName`, the same fold
 * `rosterQueueEntryMatches` uses, and for the same reason: one converter
 * writes a swimmer's name in roster order (`'River Paulk'`), another in
 * `/times/`'s `#swimmer-info` order (`'Paulk, River J'`), and this lookup must
 * find the workspace's stored rows regardless of which order wrote them.
 */
export function existingSwimCloudHistoryFor(
  existingHistory: readonly HistoricalSwim[],
  name: string,
  team: string,
  gender: Gender,
): readonly HistoricalSwim[] {
  const key = foldDiacritics(canonicalSwimmerName(name));
  return existingHistory.filter(
    swim =>
      swim.source === 'swimcloud' &&
      String(swim.team ?? '').trim() === team &&
      swim.gender === gender &&
      foldDiacritics(canonicalSwimmerName(swim.name)) === key,
  );
}

/** One swimmer's improvements, named for display — never empty (a caller filters out swimmers with none). */
export interface SwimCloudSwimmerImprovements {
  readonly name: string;
  readonly improvements: readonly SwimCloudEventImprovement[];
}
