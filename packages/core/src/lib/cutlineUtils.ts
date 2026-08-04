/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cutline lookups.
 *
 * The failure mode this file exists to prevent: a lookup that matches nothing
 * looks exactly like "the swimmer did not make the cut". `getCutlinesForSwim`
 * used to filter the D1-only `cutlines` array, so every Henderson State (D2)
 * athlete came back `achieved: null` forever, with no error. Every result now
 * carries a `status` that distinguishes *no table* and *event not in the table*
 * from a genuine miss.
 */

import {
  allCutlines,
  cutlineTierTimes,
  findCutlines,
  hasCutlineTable,
  isSwimCutline,
  latestSeasonForDivision,
  type CutlineCourse,
  type CutlineRecord,
  type CutlineSeason,
  type CutlineTier,
  type SwimCutline,
} from '../cutlines';
import { Gender, NcaaDivision } from '../types';
import { CONVERSION_FACTORS } from '../constants';
import { convertSwimToSCY, convertTimeToSeconds, formatSecondsToTime } from './utils';
import {
  courseOfRecordFromEventLabel,
  cutlineEventCategory,
  isDivingEvent,
  normalizeEventForCutline,
  type CourseOfRecordFromLabel,
  type CutlineEventCategory,
  type SwimCourseOfRecord,
} from './cutlineEventNames';

export type { CutlineCourse, CutlineSeason, CutlineTier, SwimCutline };

/**
 * Event-name normalization now lives in `./cutlineEventNames` so `lib/utils.ts`
 * can use it without an import cycle (this module imports `utils.ts`). Re-exported
 * here so every existing `from '.../cutlineUtils'` import keeps working.
 */
export {
  courseOfRecordFromEventLabel,
  cutlineEventCategory,
  isDivingEvent,
  normalizeEventForCutline,
};
export type { CourseOfRecordFromLabel, CutlineEventCategory, SwimCourseOfRecord };

/** Default course for lookups. Every NCAA table is short-course yards. */
export const DEFAULT_CUTLINE_COURSE: CutlineCourse = 'SCY';

/**
 * Why a lookup returned what it did.
 *
 * - `ok` — the event was found in a published table.
 * - `no_table_for_division` — we hold no table for this division/season at all.
 *   Nothing can be concluded about the swimmer.
 * - `event_not_in_table` — the table exists but does not publish this event
 *   (e.g. 1000 Freestyle in D1, any relay in NAIA).
 * - `not_a_timed_event` — the entry is not scored on a clock at all (diving is
 *   scored in points, against a dive-count-specific total). Comparing it to a
 *   swim standard is a category error, so no comparison is attempted. This is
 *   **not** "the division publishes nothing" — see {@link getDivingCutlines}.
 *
 * Only `ok` licenses the statement "did not achieve a cut".
 */
export type CutlineLookupStatus =
  | 'ok'
  | 'no_table_for_division'
  | 'event_not_in_table'
  | 'not_a_timed_event';

/** A published tier with its verbatim time and its derived seconds. */
export type CutlineTierValue = { tier: CutlineTier; time: string; seconds: number };

export type CutlineLookup = {
  status: CutlineLookupStatus;
  division: NcaaDivision;
  /** Season actually used, or `null` when the division has no published table. */
  season: CutlineSeason | null;
  course: CutlineCourse;
  /** The normalized event name that was searched for. */
  event: string;
  /**
   * Whether the event is timed at all. `diving` always comes back with
   * `status: 'not_a_timed_event'` and no tiers.
   */
  eventCategory: CutlineEventCategory;
  /** The published record, when one was found. */
  entry?: SwimCutline;
  /** Every published tier, strictest (fastest) first. Empty unless `status === 'ok'`. */
  tiers: CutlineTierValue[];
  /** @deprecated legacy flat row for the strict tier. Use `tiers` / `entry`. */
  aCut?: CutlineRecord;
  /** @deprecated legacy flat row for the permissive tier. Use `tiers` / `entry`. */
  bCut?: CutlineRecord;
  /** Legacy numeric strict cut in seconds. `0` means **absent**, not "zero seconds". */
  aCutSec: number;
  /** Legacy numeric permissive cut in seconds. `0` means **absent**. */
  bCutSec: number;
  /** D3's Invited selection cutline in seconds. `0` when the division publishes none. */
  invitedCutSec: number;
};

/* -------------------------------------------------------------------------- */
/* Course of record — a cut is earned in a course, not in a conversion         */
/* -------------------------------------------------------------------------- */

/**
 * The yards-equivalent of a metric swim, for an **indicative** comparison only.
 *
 * User ruling (2026-07-25): "no LCM data for NCAA qualifications. Converted
 * times are good for a 'loose' fit but you need to record a yards swim under
 * qualifying time to qualify or gain a cutline." So nothing derived from this
 * type may ever produce an achieved-cut tag — see `converted_estimate` in
 * `cutlineTags.ts`.
 */
export type ScyEquivalentSwim = {
  /**
   * Canonical event the converted time should be judged against. Metric distance
   * freestyle changes event identity as well as time (400 m → the 500 y slot,
   * 800 → 1000, 1500 → 1650); `convertSwimToSCY` owns that remap.
   */
  event: string;
  /** Converted time, formatted as a swim time. */
  time: string;
  /** {@link ScyEquivalentSwim.time} in seconds. */
  seconds: number;
  /**
   * The `CONVERSION_FACTORS` key that produced it. Provenance, so a caller can
   * see which published factor was applied rather than trusting a number.
   */
  factorEvent: string;
  /** The course the swim was recorded in. Never `'SCY'` for a converted result. */
  swimCourse: SwimCourseOfRecord;
};

/**
 * The `CONVERSION_FACTORS` key for a canonical cutline event, or `null`.
 *
 * `null` is load-bearing. `convertToSCY` falls back to the **50 Freestyle**
 * factor for any event it does not recognise, which on e.g. a 400 Medley Relay
 * would silently manufacture a 30-second "conversion". Callers must refuse
 * instead, so this function only answers for events the factor table actually
 * publishes.
 *
 * Two spelling gaps are bridged, both verified against `constants.ts`:
 * - the factor table uses the meet-sheet short form `200 IM` / `400 IM`, the
 *   cutline tables the long form `200 Individual Medley`;
 * - `convertToSCY` itself maps a missing `50 <stroke>` onto the published
 *   `100 <stroke>` factor, so those are accepted here too.
 */
export function conversionFactorEventKey(canonicalEvent: string): string | null {
  const e = String(canonicalEvent ?? '').trim();
  if (!e) return null;
  // No relay conversion factor is published. Absent, not approximated.
  if (/\brelay\b/i.test(e)) return null;
  if (isDivingEvent(e)) return null;
  const key = e.replace(/\bIndividual Medley\b/i, 'IM');
  if (CONVERSION_FACTORS[key]) return key;
  if (/^50\s+/.test(key) && CONVERSION_FACTORS[key.replace(/^50\s+/, '100 ')]) return key;
  return null;
}

/**
 * Convert a metric swim to its yards equivalent for an indicative comparison.
 *
 * Returns `null` when no published conversion factor covers the event — the
 * honest answer, never an estimate. Delegates the arithmetic to the single
 * existing implementation (`convertSwimToSCY` → `convertToSCY` in `lib/utils`);
 * there is deliberately no second conversion in this codebase.
 */
export function scyEquivalentForCutline(
  event: string,
  swimSeconds: number,
  gender: Gender | string,
  swimCourse: SwimCourseOfRecord
): ScyEquivalentSwim | null {
  if (!Number.isFinite(swimSeconds) || swimSeconds <= 0) return null;
  const canonical = normalizeEventForCutline(event);
  if (swimCourse === 'SCY') {
    return {
      event: canonical,
      time: formatSecondsToTime(swimSeconds),
      seconds: swimSeconds,
      factorEvent: canonical,
      swimCourse,
    };
  }
  const factorEvent = conversionFactorEventKey(canonical);
  if (!factorEvent) return null;
  const g = genderKey(gender) === 'Women' ? Gender.WOMEN : Gender.MEN;
  const converted = convertSwimToSCY(
    factorEvent,
    formatSecondsToTime(swimSeconds),
    g,
    swimCourse
  );
  const seconds = convertTimeToSeconds(converted.time);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    event: normalizeEventForCutline(converted.event),
    time: converted.time,
    seconds,
    factorEvent,
    swimCourse,
  };
}

function genderKey(gender: Gender | string): 'Men' | 'Women' {
  return gender === Gender.WOMEN || gender === 'Women' ? 'Women' : 'Men';
}

function toSeconds(time: string): number {
  const sec = convertTimeToSeconds(time);
  return Number.isFinite(sec) ? sec : 0;
}

/**
 * The strictest published tier the swim did **not** clear — i.e. the next one up
 * from whatever it did clear, and on a total miss the easiest tier published.
 *
 * `tiers` arrives strictest-first, so the answer is the *slowest* standard the
 * swim still failed to reach; that is simultaneously "the tier immediately above
 * the one achieved" (every stricter tier is further away) and "the tier it came
 * closest to earning" when nothing was achieved. Selecting on seconds rather
 * than on list position keeps it correct if a division ever publishes its tiers
 * in another order.
 *
 * `null` — never a zero-second gap — when every published tier was cleared, when
 * the list is empty, or when the time is unusable. A caller that needs "how far
 * off were they" must be able to tell *absent* from *on the standard exactly*.
 */
export function nextStrictestTierNotAchieved(
  tiers: readonly CutlineTierValue[],
  judgedSeconds: number
): CutlineTierValue | null {
  if (!Number.isFinite(judgedSeconds) || judgedSeconds <= 0) return null;
  let best: CutlineTierValue | null = null;
  for (const tier of tiers) {
    // `seconds > 0` filters the absent-reads-as-zero legacy slots; `>` (not `>=`)
    // keeps a swim exactly on a standard counted as having achieved it.
    if (tier.seconds > 0 && judgedSeconds > tier.seconds) {
      if (!best || tier.seconds > best.seconds) best = tier;
    }
  }
  return best;
}

function secondsForTier(tiers: CutlineTierValue[], ...wanted: CutlineTier[]): number {
  for (const tier of wanted) {
    const hit = tiers.find(t => t.tier === tier);
    if (hit) return hit.seconds;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Lookup                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Find the published standards for one swim.
 *
 * @param season Defaults to the newest season published for `division` — not to
 *   a hardcoded season, because different divisions publish on different cycles
 *   (D1 is on 2025-2026 here; D2/D3/NAIA on 2026-2027).
 */
export function getCutlinesForSwim(
  gender: Gender | string,
  event: string,
  division: NcaaDivision = 'D1',
  season?: CutlineSeason,
  course: CutlineCourse = DEFAULT_CUTLINE_COURSE
): CutlineLookup {
  const g = genderKey(gender);
  const cleanEvent = normalizeEventForCutline(event);
  const resolvedSeason = season ?? latestSeasonForDivision(division);

  const eventCategory = cutlineEventCategory(cleanEvent);

  const empty = {
    division,
    season: resolvedSeason,
    course,
    event: cleanEvent,
    eventCategory,
    tiers: [] as CutlineTierValue[],
    aCutSec: 0,
    bCutSec: 0,
    invitedCutSec: 0,
  };

  // Diving is judged in points against a dive-count-specific total. It has no
  // seconds to compare, so it short-circuits ahead of the table lookup — the
  // honest answer is "not a timed event", never "no standard published".
  if (eventCategory === 'diving') {
    return { ...empty, status: 'not_a_timed_event' };
  }

  if (!resolvedSeason || !hasCutlineTable(division, resolvedSeason)) {
    return { ...empty, status: 'no_table_for_division' };
  }

  const matches = findCutlines({
    division,
    season: resolvedSeason,
    gender: g,
    course,
    event: cleanEvent,
  }).filter(isSwimCutline);

  const entry = matches[0];
  if (!entry) {
    return { ...empty, status: 'event_not_in_table' };
  }

  const tiers: CutlineTierValue[] = cutlineTierTimes(entry).map(t => ({
    ...t,
    seconds: toSeconds(t.time),
  }));

  const aCutSec = secondsForTier(tiers, 'A', 'Standard', 'Qualifying');
  const bCutSec = secondsForTier(tiers, 'B', 'Provisional');
  const invitedCutSec = secondsForTier(tiers, 'Invited');

  const legacy = allCutlines().filter(
    row =>
      row.division === division &&
      row.season === resolvedSeason &&
      row.course === course &&
      row.gender === g &&
      row.event.toUpperCase() === cleanEvent.toUpperCase()
  );

  return {
    status: 'ok',
    division,
    season: resolvedSeason,
    course,
    event: cleanEvent,
    eventCategory,
    entry,
    tiers,
    aCut: legacy.find(r => r.standard === 'A'),
    bCut: legacy.find(r => r.standard === 'B'),
    aCutSec,
    bCutSec,
    invitedCutSec,
  };
}

export type CutlineComparison = {
  /** Legacy two-tier verdict. `A` = met the strict tier, `B` = met the permissive one. */
  achieved: 'A' | 'B' | null;
  /** The honest label of the strictest tier met, e.g. `Standard`, `Invited`, `Provisional`. */
  tier: CutlineTier | null;
  status: CutlineLookupStatus;
  /** `diving` always comes back `achieved: null` with `status: 'not_a_timed_event'`. */
  eventCategory: CutlineEventCategory;
  aCutSec: number;
  bCutSec: number;
  invitedCutSec: number;
  season: CutlineSeason | null;
  division: NcaaDivision;
  entry?: SwimCutline;
};

/**
 * Compare a time against the published standards.
 *
 * `achieved: null` with `status !== 'ok'` means **we have no standard to judge
 * against**, which is not the same as the swimmer missing the cut. Callers that
 * render a badge should check `status` before rendering "no cut".
 */
export function compareTimeToCutline(
  timeSec: number,
  gender: Gender | string,
  event: string,
  division: NcaaDivision = 'D1',
  season?: CutlineSeason,
  course: CutlineCourse = DEFAULT_CUTLINE_COURSE
): CutlineComparison {
  const lookup = getCutlinesForSwim(gender, event, division, season, course);
  const base = {
    status: lookup.status,
    eventCategory: lookup.eventCategory,
    aCutSec: lookup.aCutSec,
    bCutSec: lookup.bCutSec,
    invitedCutSec: lookup.invitedCutSec,
    season: lookup.season,
    division: lookup.division,
    entry: lookup.entry,
  };
  if (!timeSec || timeSec <= 0 || !Number.isFinite(timeSec) || lookup.status !== 'ok') {
    return { ...base, achieved: null, tier: null };
  }
  // `tiers` is ordered strictest first, so the first tier met is the best one.
  const met = lookup.tiers.find(t => t.seconds > 0 && timeSec <= t.seconds);
  if (!met) return { ...base, achieved: null, tier: null };
  const achieved: 'A' | 'B' =
    met.tier === 'A' || met.tier === 'Standard' || met.tier === 'Qualifying' ? 'A' : 'B';
  return { ...base, achieved, tier: met.tier };
}

export function isACut(
  timeSec: number,
  gender: Gender | string,
  event: string,
  division?: NcaaDivision
): boolean {
  return compareTimeToCutline(timeSec, gender, event, division).achieved === 'A';
}

export function isBCut(
  timeSec: number,
  gender: Gender | string,
  event: string,
  division?: NcaaDivision
): boolean {
  return compareTimeToCutline(timeSec, gender, event, division).achieved === 'B';
}
