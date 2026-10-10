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
  legacySlotForTier,
  type CutlineCourse,
  type CutlineRecord,
  type CutlineSeason,
  type CutlineTier,
  type SwimCutline,
} from '../cutlines';
import { Gender, NcaaDivision } from '../types';
import { CONVERSION_FACTORS } from '../constants';
import {
  convertSwimToSCYDetailed,
  convertTimeToSeconds,
  formatSecondsToTime,
  ncaaScmConversionEvent,
  type ScyConversionBasis,
  type ScyConversionOptions,
} from './utils';
import { eventNotSwumInCourse } from './courseEvents';
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
  /**
   * Every published tier, in the source's printed order. Not guaranteed to be
   * speed order (D3 Invited is slower than B in two events); use
   * {@link strictestTierMet}. Empty unless `status === 'ok'`.
   */
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
   * For an SCM swim only the NCAA "All other events" row covers (a 100 IM, a
   * 25), there is no key: this is the canonical event, and `basis.row` is
   * `'allOtherEvents'`.
   */
  factorEvent: string;
  /** The course the swim was recorded in. Never `'SCY'` for a converted result. */
  swimCourse: SwimCourseOfRecord;
  /**
   * How the time reached yards: the factor, and for SCM the NCAA table and why
   * it was chosen. `method: 'identity'` for an SCY swim. Optional only so the
   * type stays additive; {@link scyEquivalentForCutline} always sets it.
   */
  basis?: ScyConversionBasis;
};

/**
 * The `CONVERSION_FACTORS` key for a canonical cutline event, or `null`.
 *
 * `null` is load-bearing. `convertToSCY` used to fall back to the **50
 * Freestyle** factor for any event it did not recognise, which on e.g. a 400
 * Medley Relay silently manufactured a 30-second "conversion". It now throws
 * when no factor is published (`convertTimeWithBasis` in `utils.ts`). This
 * function is the check made before that call: it only answers for events the
 * factor table actually publishes, so a caller can refuse instead of catching.
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
 * honest answer, never an estimate. `null` too for an SCM swim in a yards
 * distance freestyle event (500, 1000, 1650): no such event is swum in SCM
 * (`courseEvents.ts`). Delegates the arithmetic to the single
 * existing implementation (`convertSwimToSCYDetailed` in `lib/utils`); there is
 * deliberately no second conversion in this codebase.
 *
 * `options` picks the NCAA SCM table (`{ division }` or `{ team }`). Pass the
 * division whose standards the converted time will be judged against. Without
 * it an SCM swim takes the Rules Book table, and `basis` says so.
 */
export function scyEquivalentForCutline(
  event: string,
  swimSeconds: number,
  gender: Gender | string,
  swimCourse: SwimCourseOfRecord,
  options?: ScyConversionOptions
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
      basis: { method: 'identity', reason: 'recorded_in_scy' },
    };
  }
  // An event the swim's course does not swim is never converted. The factor
  // table holds a "1000 Freestyle" key for the yards slot, so this must come
  // before the key lookup below.
  if (eventNotSwumInCourse(canonical, swimCourse)) return null;
  // An SCM swim with no factor-table key still converts when the NCAA "All
  // other events" row covers it (user decision, 2026-09-24). LCM has no such
  // row, so an LCM swim outside the table stays unconverted.
  const factorEvent =
    conversionFactorEventKey(canonical) ??
    (swimCourse === 'SCM' ? ncaaScmConversionEvent(canonical)?.factorEvent ?? null : null);
  if (!factorEvent) return null;
  const g = genderKey(gender) === 'Women' ? Gender.WOMEN : Gender.MEN;
  const converted = convertSwimToSCYDetailed(
    factorEvent,
    formatSecondsToTime(swimSeconds),
    g,
    swimCourse,
    options
  );
  const seconds = convertTimeToSeconds(converted.time);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    event: normalizeEventForCutline(converted.event),
    time: converted.time,
    seconds,
    factorEvent,
    swimCourse,
    basis: converted.basis,
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
 * The answer is the *slowest* standard the swim still failed to reach; that is
 * simultaneously "the tier immediately above the one achieved" (every stricter
 * tier is further away) and "the tier it came closest to earning" when nothing
 * was achieved. It selects on seconds, never on list position, because D3 does
 * publish a tier out of speed order.
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
 * `division` is required. It defaulted to `'D1'`, which silently measured
 * every swim whose division a caller had not resolved against the D1 table —
 * the precise thing `CLAUDE.md`'s "Unknown division != D1" rule forbids. A
 * caller that does not know the division resolves it and handles the null.
 *
 * @param season Defaults to the newest season published for `division` — not to
 *   a hardcoded season, because different divisions publish on different cycles
 *   (D1 is on 2025-2026 here; D2/D3/NAIA on 2026-2027).
 */
export function getCutlinesForSwim(
  gender: Gender | string,
  event: string,
  division: NcaaDivision,
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

/**
 * The course of the published table a swim is judged against when the caller
 * names none.
 *
 * A standard belongs to the course it is published in. So a metric swim is
 * judged in its own course when its division publishes a standard for that
 * event in that course: today that is an NAIA short-course metres swim, read
 * against the NAIA 2026-27 column the loader reads as SCM
 * (`NAIA_2026_27_METERS_AS_SCM`). Every other swim goes to the yards table,
 * where a metric swim can reach at best a converted estimate.
 *
 * `SCY` for an unknown division, a yards swim, a metric label with no pool
 * length (`METRIC_UNSPECIFIED`), diving, and any metric event the division
 * does not publish in that course. No LCM table is held anywhere, so an LCM
 * swim always gets `SCY`.
 */
export function cutlineTableCourseForSwim(
  gender: Gender | string,
  event: string,
  division: NcaaDivision | null | undefined,
  swimCourse: SwimCourseOfRecord | 'METRIC_UNSPECIFIED',
  season?: CutlineSeason
): CutlineCourse {
  if (!division) return DEFAULT_CUTLINE_COURSE;
  if (swimCourse === DEFAULT_CUTLINE_COURSE || swimCourse === 'METRIC_UNSPECIFIED') {
    return DEFAULT_CUTLINE_COURSE;
  }
  const ownCourse = getCutlinesForSwim(gender, event, division, season, swimCourse);
  return ownCourse.status === 'ok' ? swimCourse : DEFAULT_CUTLINE_COURSE;
}

/**
 * The legacy two-tier cut (`computedCut`) a swim earned **in its own
 * course**, or `null` when no table in that course applies to it.
 *
 * - An SCY swim is judged against its division's yards table, as always.
 * - A metric swim is judged only when its division publishes the event in
 *   that course ({@link cutlineTableCourseForSwim}). Today that is an NAIA
 *   SCM swim, against the NAIA column read as SCM
 *   (`NAIA_2026_27_METERS_AS_SCM`).
 * - Every other metric swim gets `null`. Its converted time is an estimate,
 *   and an estimate never earns a cut (`converted_estimate` in
 *   `cutlineTags.ts`).
 *
 * `seconds` is the swim as recorded. It is never a converted time.
 *
 * `null` covers "no table in this course" and "missed every tier" alike, as
 * `computedCut` always has. A caller that must tell them apart uses
 * `buildCutlineTag`.
 */
export function computedCutInOwnCourse(args: {
  seconds: number;
  gender: Gender | string;
  event: string;
  division: NcaaDivision;
  swimCourse: SwimCourseOfRecord;
}): 'A' | 'B' | null {
  const { seconds, gender, event, division, swimCourse } = args;
  const tableCourse = cutlineTableCourseForSwim(gender, event, division, swimCourse);
  if (tableCourse !== swimCourse) return null;
  return compareTimeToCutline(seconds, gender, event, division, undefined, tableCourse).achieved;
}

export type CutlineComparison = {
  /** Legacy two-tier verdict. `A` = met the strict tier, `B` = met the permissive one. */
  achieved: 'A' | 'B' | null;
  /**
   * The honest label of the fastest published tier met, chosen by comparing
   * times ({@link strictestTierMet}), e.g. `Standard`, `Invited`, `Provisional`.
   * It can be set while `achieved` is `null`: a D3 swim that clears Invited but
   * not the faster B standard in the events where Invited is printed slower.
   */
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
  division: NcaaDivision,
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
  // The label is the fastest published standard the swim cleared, chosen by
  // comparing times. List position says nothing: the archived D3 sheet prints
  // Invited slower than B in two events (see `strictestTierMet`).
  const met = strictestTierMet(lookup.tiers, timeSec);
  // The legacy two-slot verdict is a direct comparison against the slot's own
  // time, never inferred from which tier happened to match. Meeting `Invited`
  // says nothing about `B`: a swim between the two in those events cleared
  // Invited and not B, so it earns the label and no legacy cut.
  const achieved = legacyCutAchieved(lookup.tiers, timeSec);
  return { ...base, achieved, tier: met ? met.tier : null };
}

/**
 * The fastest published tier a time cleared, or `null` when it cleared none.
 *
 * Chosen by comparing seconds, not by position in `tiers`: a division is not
 * guaranteed to publish its tiers in speed order. D3 lists `A, Invited, B`, and
 * its Women's 100 Butterfly (B 55.79, Invited 55.83) and 400 IM (B 4:28.70,
 * Invited 4:28.76) put Invited slower than B. Reading the list as strictest
 * first called a 55.80 "B" that is slower than the 55.79 B standard.
 *
 * A tier whose time is absent (`seconds <= 0`) never matches. A tie keeps the
 * published order, so a label does not flip between two equal standards. The
 * time must be finite and positive, or the answer is `null`, never a tier.
 */
export function strictestTierMet(
  tiers: readonly CutlineTierValue[],
  seconds: number
): CutlineTierValue | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  let best: CutlineTierValue | null = null;
  for (const tier of tiers) {
    if (!(tier.seconds > 0) || seconds > tier.seconds) continue;
    if (!best || tier.seconds < best.seconds) best = tier;
  }
  return best;
}

/**
 * The legacy two-slot cut for a time: `A` when it clears the strict slot's own
 * time, else `B` when it clears the permissive slot's own time, else `null`.
 * Each slot is read through {@link legacySlotForTier}; a tier with no slot
 * (`Invited`) never contributes. The slots are compared separately, so no
 * order between tiers is assumed.
 */
function legacyCutAchieved(
  tiers: readonly CutlineTierValue[],
  seconds: number
): 'A' | 'B' | null {
  const clears = (slot: 'A' | 'B') =>
    tiers.some(t => legacySlotForTier(t.tier) === slot && t.seconds > 0 && seconds <= t.seconds);
  if (clears('A')) return 'A';
  if (clears('B')) return 'B';
  return null;
}

/**
 * ## `division` is required, and was not always
 *
 * These two took `division?: NcaaDivision` and passed it straight into
 * {@link compareTimeToCutline}, which defaulted it to `'D1'`. So
 * `isACut(sec, gender, event)` — the natural way to call it — compared a swim
 * against the D1 table whatever division the swimmer actually swims in.
 *
 * `CLAUDE.md` states the rule this broke: "Unknown division != D1. An unmapped
 * team surfaces as unknown rather than quietly scoring against the wrong
 * table." A D2 swimmer measured against D1 standards reads as having missed
 * cuts they in fact made, which is a plausible, wrong answer of exactly the
 * kind this repo exists to refuse.
 *
 * Nothing inside this repo called them without a division, so no shipped
 * number was wrong. Requiring it makes that a fact the compiler enforces
 * rather than a habit five call sites happened to keep. A caller that does not
 * know the division must resolve it (`divisionForTeamOrNull`) and handle the
 * null, not pass a guess.
 */
export function isACut(
  timeSec: number,
  gender: Gender | string,
  event: string,
  division: NcaaDivision
): boolean {
  return compareTimeToCutline(timeSec, gender, event, division).achieved === 'A';
}

/** See {@link isACut} on why `division` is required. */
export function isBCut(
  timeSec: number,
  gender: Gender | string,
  event: string,
  division: NcaaDivision
): boolean {
  return compareTimeToCutline(timeSec, gender, event, division).achieved === 'B';
}
