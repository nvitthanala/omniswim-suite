/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Events that do not exist in a course.
 *
 * Yards and short-course metres swim different distances for the three
 * distance freestyle events. The yards program swims the 500, 1000 and 1650.
 * The short-course metres program swims the 400, 800 and 1500 in their place.
 * Every archived qualifying sheet that names both courses prints this pairing
 * (see {@link COURSE_DISTANCE_PAIRS} for the exact words and pages):
 *
 * - The NCAA "Short-Course Conversion Factors" table converts "a metric time
 *   achieved in a 25-meter racing course" to "a 25-yard racing course". Its
 *   distance rows read "400 meters to 500 yards", "800 meters to 1000 yards"
 *   and "1500 meters to 1650 yards" (D2 2026-27 men's and women's sheets, page
 *   2; the D1 2025-26 sheet, page 3, prints the same rows with commas).
 * - The NAIA 2026-27 sheet labels its rows "500/400 FREESTYLE" and "1650/1500
 *   FREESTYLE" under the columns YARDS and METERS. The loader reads METERS as
 *   SCM by a recorded user decision (`NAIA_2026_27_METERS_AS_SCM`).
 * - The NAIA 2020-21 sheet prints the same two labels under the columns Yards
 *   and SCM. It is archived as course evidence only.
 *
 * So a freestyle swim at a yards distance recorded in SCM, or at a metres
 * distance recorded in SCY, names an event that course does not swim. User
 * decision (2026-09-24): "there is no such event, the 1000 is never swum in
 * SCM." Such a swim is flagged. It is never converted: before this module an
 * SCM "1000 Freestyle" took the "800 meters to 1000 yards" factor (1.143 on
 * the Rules Book table), a factor the NCAA prints for an 800 m swim only.
 *
 * What this module does **not** decide, because no archived source states it:
 *
 * - **LCM.** No archived sheet lists the long-course events. The NCAA accepts
 *   no 50 m times for selection, and the NAIA metric column is read as SCM. An
 *   LCM swim is never flagged here. A 1000 Freestyle LCM still converts with
 *   the indicative `CONVERSION_FACTORS` row, as before.
 * - **Any other event** (a 100 IM in LCM, a 50 of stroke in LCM, a 25). The
 *   championship lists name the events a governing body contests, not every
 *   event that exists in a course. They cannot prove a negative.
 * - **A swim whose course is not recorded.** No `timeType`, and a label that
 *   states no course or says only "meters", is never flagged.
 *
 * A negative needs a source (`CLAUDE.md`, "Data provenance"). Add a pair or a
 * course here only with an archived source that states it.
 *
 * This module sits at the bottom of the import graph (types and the
 * dependency-free event-name normalizer only), so `bestTimeEligibility.ts`
 * and `utils.ts` both import it without a cycle.
 */

import type { HistoricalSwim } from '../types';
import {
  courseOfRecordFromEventLabel,
  normalizeEventForCutline,
  type SwimCourseOfRecord,
} from './cutlineEventNames';

/* -------------------------------------------------------------------------- */
/* The sourced pairing                                                         */
/* -------------------------------------------------------------------------- */

/** One place an archived sheet prints a pair, verbatim. */
export type CourseDistanceSourceDocument = {
  /** `id` in `data/cutlines/sources/manifest.json` (holds url + sha256). */
  manifestId: string;
  /** Archived PDF filename under `data/cutlines/sources/`. */
  filename: string;
  /** 1-based PDF page. */
  page: number;
  /**
   * `Conversions` — the NCAA SCM-to-SCY conversion table. `Events` — the
   * event column of a sheet that prints a yards and a metres column.
   */
  section: 'Conversions' | 'Events';
  /** The label the sheet prints for this pair, verbatim. */
  printed: string;
};

export type CourseDistancePairId = 'free-500y-400m' | 'free-1000y-800m' | 'free-1650y-1500m';

/** One distance freestyle event, as each course swims it. */
export type CourseDistancePair = {
  id: CourseDistancePairId;
  /** The canonical event the yards (SCY) program swims. */
  yardsEvent: string;
  /** The canonical event the short-course metres (SCM) program swims in its place. */
  scmEvent: string;
  /** Every archived sheet that prints the pair. The first one is quoted in reasons. */
  sources: readonly CourseDistanceSourceDocument[];
};

const D2_MEN = { manifestId: 'ncaa-d2-men-2026-27', filename: '2026-27D2MSW_QualStandards.pdf', page: 2 } as const;
const D2_WOMEN = { manifestId: 'ncaa-d2-women-2026-27', filename: '2026-27D2WSW_QualStandards.pdf', page: 2 } as const;
const D1 = { manifestId: 'ncaa-d1-2025-26', filename: '2025-26D1XSW_QUALSTANDARDS.pdf', page: 3 } as const;
const NAIA_2026_27 = {
  manifestId: 'naia-2026-27',
  filename: '2026-27-SD-Qualifying-Standards-wo-Relays.pdf',
  page: 1,
} as const;
const NAIA_2020_21 = {
  manifestId: 'naia-2020-21-course-evidence',
  filename: '2020-21-NAIA-SD-Qualifying-Standards.pdf',
  page: 1,
} as const;

/**
 * The three distance freestyle pairs, transcribed on 2026-09-25 from the
 * archived PDFs and checked against `pdftotext -layout` output.
 * `tests/courseEventMismatch.test.ts` snapshots every label and re-reads the
 * PDFs when `pdftotext` is installed.
 *
 * The NAIA contests no 1000 or 800, so the 1000/800 pair rests on the NCAA
 * sheets alone.
 */
export const COURSE_DISTANCE_PAIRS: readonly CourseDistancePair[] = Object.freeze([
  Object.freeze({
    id: 'free-500y-400m',
    yardsEvent: '500 Freestyle',
    scmEvent: '400 Freestyle',
    sources: Object.freeze([
      { ...D2_MEN, section: 'Conversions', printed: '400 meters to 500 yards' },
      { ...D2_WOMEN, section: 'Conversions', printed: '400 meters to 500 yards' },
      { ...D1, section: 'Conversions', printed: '400 meters to 500 yards' },
      { ...NAIA_2026_27, section: 'Events', printed: '500/400 FREESTYLE' },
      { ...NAIA_2020_21, section: 'Events', printed: '500/400 FREESTYLE' },
    ] satisfies CourseDistanceSourceDocument[]),
  }),
  Object.freeze({
    id: 'free-1000y-800m',
    yardsEvent: '1000 Freestyle',
    scmEvent: '800 Freestyle',
    sources: Object.freeze([
      { ...D2_MEN, section: 'Conversions', printed: '800 meters to 1000 yards' },
      { ...D2_WOMEN, section: 'Conversions', printed: '800 meters to 1000 yards' },
      { ...D1, section: 'Conversions', printed: '800 meters to 1,000 yards' },
    ] satisfies CourseDistanceSourceDocument[]),
  }),
  Object.freeze({
    id: 'free-1650y-1500m',
    yardsEvent: '1650 Freestyle',
    scmEvent: '1500 Freestyle',
    sources: Object.freeze([
      { ...D2_MEN, section: 'Conversions', printed: '1500 meters to 1650 yards' },
      { ...D2_WOMEN, section: 'Conversions', printed: '1500 meters to 1650 yards' },
      { ...D1, section: 'Conversions', printed: '1,500 meters to 1,650 yards' },
      { ...NAIA_2026_27, section: 'Events', printed: '1650/1500 FREESTYLE' },
      { ...NAIA_2020_21, section: 'Events', printed: '1650/1500 FREESTYLE' },
    ] satisfies CourseDistanceSourceDocument[]),
  }),
] satisfies CourseDistancePair[]);

/* -------------------------------------------------------------------------- */
/* The check                                                                   */
/* -------------------------------------------------------------------------- */

/** The courses a sourced pair speaks for. LCM is not one of them. */
export type CourseWithSourcedEvents = 'SCY' | 'SCM';

/** A swim's event does not exist in the course it is recorded in. */
export type EventNotSwumInCourse = {
  /** The event as recorded, in canonical form, e.g. `1000 Freestyle`. */
  event: string;
  /** The course the swim is recorded in. */
  course: CourseWithSourcedEvents;
  /** The event this course swims in its place, e.g. `800 Freestyle` for a 1000 in SCM. */
  courseEvent: string;
  /** The sourced pair that says so. */
  pair: CourseDistancePair;
  /** Plain-English explanation, for a tooltip or an import warning. */
  reason: string;
};

const COURSE_NAME: Record<CourseWithSourcedEvents, string> = {
  SCY: 'short-course yards',
  SCM: 'short-course metres',
};

function mismatchReason(
  event: string,
  course: CourseWithSourcedEvents,
  courseEvent: string,
  pair: CourseDistancePair
): string {
  const quoted = pair.sources[0];
  return (
    `There is no ${event} in ${COURSE_NAME[course]}. That course swims the ${courseEvent} in its place ` +
    `(NCAA conversion table: "${quoted.printed}"). Check the event and course of this swim. ` +
    `It is not converted, not ranked and not judged against a standard.`
  );
}

/**
 * The course-event mismatch for `event` recorded in `course`, or `null` when
 * the sources say nothing against it.
 *
 * `null` for every LCM swim, every relay, every event outside the three
 * distance freestyle pairs, and an unknown or unstated course. See the module
 * header for why each of those is out of scope.
 */
export function eventNotSwumInCourse(
  event: string,
  course: SwimCourseOfRecord | 'METRIC_UNSPECIFIED' | null | undefined
): EventNotSwumInCourse | null {
  if (course !== 'SCY' && course !== 'SCM') return null;
  // Exact canonical names only. "400 Freestyle Relay" and "800 Freestyle
  // Relay" are real yards events, and an exact match never mistakes one for
  // the individual 400 or 800.
  const canonical = normalizeEventForCutline(String(event ?? ''));
  for (const pair of COURSE_DISTANCE_PAIRS) {
    if (course === 'SCM' && canonical === pair.yardsEvent) {
      return {
        event: canonical,
        course,
        courseEvent: pair.scmEvent,
        pair,
        reason: mismatchReason(canonical, course, pair.scmEvent, pair),
      };
    }
    if (course === 'SCY' && canonical === pair.scmEvent) {
      return {
        event: canonical,
        course,
        courseEvent: pair.yardsEvent,
        pair,
        reason: mismatchReason(canonical, course, pair.yardsEvent, pair),
      };
    }
  }
  return null;
}

/** The fields that say what a stored swim was, and in which course. */
export type RecordedSwim = Pick<HistoricalSwim, 'event'> & Partial<Pick<HistoricalSwim, 'timeType'>>;

/**
 * The course a stored swim was recorded in: its `timeType` when set, else the
 * course its label states (`"1000 Free SCM"`, `"Event 12 Men 1000 Yard
 * Freestyle"`), else `null`.
 *
 * Deliberately not the `?? 'SCY'` default the converters use. A course nobody
 * recorded cannot prove that an event does not exist in it.
 */
export function recordedCourseOfSwim(swim: RecordedSwim): SwimCourseOfRecord | null {
  if (swim.timeType) return swim.timeType;
  const labelled = courseOfRecordFromEventLabel(swim.event);
  return labelled === 'SCY' || labelled === 'SCM' || labelled === 'LCM' ? labelled : null;
}

/**
 * {@link eventNotSwumInCourse} for a stored row: a `HistoricalSwim`, a
 * `Recruit`, a `PlannedSwimEntry` or a catalog time. The course is
 * {@link recordedCourseOfSwim}.
 */
export function swimEventNotSwumInCourse(swim: RecordedSwim): EventNotSwumInCourse | null {
  return eventNotSwumInCourse(swim.event, recordedCourseOfSwim(swim));
}

/** A stored row, with the mismatch that keeps it out of every ranking. */
export type SwimNotSwumInCourse<T extends RecordedSwim> = {
  swim: T;
  mismatch: EventNotSwumInCourse;
};

/** Every row in `swims` whose event does not exist in its recorded course, in input order. */
export function findSwimsNotSwumInCourse<T extends RecordedSwim>(
  swims: readonly T[]
): SwimNotSwumInCourse<T>[] {
  const out: SwimNotSwumInCourse<T>[] = [];
  for (const swim of swims) {
    const mismatch = swimEventNotSwumInCourse(swim);
    if (mismatch) out.push({ swim, mismatch });
  }
  return out;
}

/**
 * Raised by the throwing converters (`convertToSCY`, `convertSwimToSCY`,
 * `convertSwimToSCYDetailed`) for an event that does not exist in the course
 * it is recorded in. It is never a conversion with another event's factor.
 * Use `scyConversionOutcome` for the same answer as a value.
 */
export class EventNotSwumInCourseError extends Error {
  readonly mismatch: EventNotSwumInCourse;

  constructor(mismatch: EventNotSwumInCourse) {
    super(mismatch.reason);
    this.name = 'EventNotSwumInCourseError';
    this.mismatch = mismatch;
  }
}
