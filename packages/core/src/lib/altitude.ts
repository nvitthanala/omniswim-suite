/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The NCAA altitude adjustment, applied to a time swum at altitude.
 *
 * ## When this applies, and when it must not
 *
 * The NCAA lets a time "achieved at an altitude of 3,000 feet or higher" be
 * adjusted by the chart in {@link NCAA_ALTITUDE_ADJUSTMENT_TABLE}: "Subtract
 * the time above from the actual time achieved ... This is the time to be used
 * on the entry form." This module is the one place that subtraction happens.
 *
 * Use it only for a source that states the elevation of the pool **and** gives
 * the time on the clock. Do not use it for:
 *
 * - **A SwimCloud `A` swim.** SwimCloud has already adjusted it, and its
 *   `profile_fastest_times` response publishes only the adjusted time
 *   (swimmer 1401610: 4:07.11 published, 4:12.11 swum). Adjusting again would
 *   take the NCAA figure off twice. {@link adjustSwimForAltitude} refuses a
 *   swim with `isAltitudeAdjusted: true`.
 * - **A swim whose elevation is unknown.** Nothing here guesses an elevation
 *   from a meet name, a team or a city. No elevation, no adjustment.
 *
 * ## How the chart is read
 *
 * Five rows, each for individual events and each pairing a yards distance with
 * a metres distance (100 y/m, 200 y/m, 500 y / 400 m, 1000 y / 800 m, 1650 y /
 * 1500 m). The rows are read literally:
 *
 * - The 50s are not in the chart, so a 50 gets no adjustment
 *   (`event_not_in_table`), never a zero.
 * - A 400-yard event (the 400 IM in yards) is not in the chart either. The
 *   metric 400 IM is: the row names "400 Meters (Individual Events)".
 * - Metres means either pool length. The chart does not name one.
 * - A relay uses "four times the appropriate figures", read as four times the
 *   figure for the relay's **leg** distance: a 400 relay takes 4 x the 100
 *   figure, an 800 free relay 4 x the 200 figure, and a 200 relay (50 legs)
 *   gets nothing because the 50 is not in the chart.
 *
 * Every subtraction is in integer hundredths, so no result drifts by a float
 * hundredth.
 */

import {
  NCAA_ALTITUDE_ADJUSTMENT_TABLE,
  type NcaaAltitudeAdjustmentTable,
  type NcaaAltitudeElevationClass,
  type NcaaAltitudeRow,
} from '../constants';
import type { HistoricalSwim } from '../types';
import { normalizeEventForCutline } from './cutlineEventNames';
import { convertTimeToSeconds, formatSecondsToTime, isDivingEvent } from './utils';

/** The course a time was swum in. Required: the chart's rows differ by course. */
export type AltitudeSwimCourse = 'SCY' | 'SCM' | 'LCM';

/**
 * The pool's elevation, as the source states it. Give the chart's column when
 * the source names it, or the elevation in whole feet.
 */
export type AltitudeElevation =
  | { elevationClass: NcaaAltitudeElevationClass }
  | { feet: number };

export type NcaaAltitudeAdjustmentInput = {
  /** Event label as recorded, e.g. `'400 Free LCM'`, `'500 Freestyle'`, `'400 Medley Relay'`. */
  event: string;
  /** The time on the clock, e.g. `'4:12.11'`. Throws when it is not a time. */
  time: string;
  course: AltitudeSwimCourse;
  elevation: AltitudeElevation;
};

/**
 * The result of {@link ncaaAltitudeAdjustment}.
 *
 * - `adjusted` — the chart applies. `adjustedTime` is the time to enter.
 *   `secondsSubtracted` can be `0` (class I, 100): that is the sheet's own
 *   printed `.0`, not an absence.
 * - `below_threshold` — the elevation is under 3,000 ft; the chart does not
 *   apply and the time stands.
 * - `event_not_in_table` — the chart prints no row for this event (the 50s, a
 *   400-yard event, a 25, a 200 relay, diving). The time stands. This is not a
 *   zero adjustment: the NCAA publishes nothing here.
 */
export type NcaaAltitudeAdjustment =
  | {
      status: 'adjusted';
      /** Canonical event, e.g. `'400 Freestyle'`. */
      event: string;
      course: AltitudeSwimCourse;
      elevationClass: NcaaAltitudeElevationClass;
      row: NcaaAltitudeRow;
      /** `true` when the relay multiplier was applied. */
      relay: boolean;
      /** Seconds taken off, verbatim from the chart (times four for a relay). */
      secondsSubtracted: number;
      /** The time as swum. */
      actualTime: string;
      actualSeconds: number;
      /** The time to use for entry. */
      adjustedTime: string;
      adjustedSeconds: number;
      table: NcaaAltitudeAdjustmentTable['id'];
    }
  | { status: 'below_threshold'; feet: number; thresholdFeet: number }
  | { status: 'event_not_in_table'; event: string; course: AltitudeSwimCourse; reason: string };

/**
 * The chart column for an elevation in whole feet, or `null` below 3,000 ft.
 *
 * Throws on a negative, non-finite or fractional elevation. The chart prints
 * whole-foot bands (4,250 then 4,251), so a fractional elevation falls in no
 * printed band, and this module does not pick one.
 */
export function ncaaAltitudeElevationClass(feet: number): NcaaAltitudeElevationClass | null {
  if (!Number.isFinite(feet) || feet < 0 || !Number.isInteger(feet)) {
    throw new RangeError(
      `Elevation must be a whole, non-negative number of feet; got ${String(feet)}.`
    );
  }
  const { elevationClasses, thresholdFeet } = NCAA_ALTITUDE_ADJUSTMENT_TABLE;
  if (feet < thresholdFeet) return null;
  if (feet <= (elevationClasses.I.maxFeet as number)) return 'I';
  if (feet <= (elevationClasses.II.maxFeet as number)) return 'II';
  return 'III';
}

/** The chart row for one individual distance in one course, or `null` when none is printed. */
function altitudeRowFor(distance: number, course: AltitudeSwimCourse): NcaaAltitudeRow | null {
  if (distance === 100) return 'y100m100';
  if (distance === 200) return 'y200m200';
  if (course === 'SCY') {
    if (distance === 500) return 'y500m400';
    if (distance === 1000) return 'y1000m800';
    if (distance === 1650) return 'y1650m1500';
    return null;
  }
  if (distance === 400) return 'y500m400';
  if (distance === 800) return 'y1000m800';
  if (distance === 1500) return 'y1650m1500';
  return null;
}

const LEADING_DISTANCE = /^(\d+)\s/;

function resolveElevationClass(
  elevation: AltitudeElevation
): { elevationClass: NcaaAltitudeElevationClass } | { belowFeet: number } {
  if ('elevationClass' in elevation) {
    if (!(elevation.elevationClass in NCAA_ALTITUDE_ADJUSTMENT_TABLE.elevationClasses)) {
      throw new RangeError(`Unknown NCAA altitude class ${JSON.stringify(elevation.elevationClass)}.`);
    }
    return { elevationClass: elevation.elevationClass };
  }
  const elevationClass = ncaaAltitudeElevationClass(elevation.feet);
  return elevationClass ? { elevationClass } : { belowFeet: elevation.feet };
}

function notInTable(
  event: string,
  course: AltitudeSwimCourse,
  reason: string
): NcaaAltitudeAdjustment {
  return { status: 'event_not_in_table', event, course, reason };
}

/**
 * Adjust a time swum at altitude by the NCAA chart.
 *
 * For a source that knows the pool's elevation and gives the actual time. Never
 * for a time a source already adjusted — see the module header, and use
 * {@link adjustSwimForAltitude} for a `HistoricalSwim` so that case is refused.
 *
 * Throws when the time is not a time, when the elevation is malformed, or when
 * the adjustment would leave no time at all.
 */
export function ncaaAltitudeAdjustment(input: NcaaAltitudeAdjustmentInput): NcaaAltitudeAdjustment {
  const { course } = input;
  if (course !== 'SCY' && course !== 'SCM' && course !== 'LCM') {
    throw new RangeError(`Unknown course ${JSON.stringify(course)}; the altitude chart needs SCY, SCM or LCM.`);
  }
  const elevation = resolveElevationClass(input.elevation);
  if ('belowFeet' in elevation) {
    return {
      status: 'below_threshold',
      feet: elevation.belowFeet,
      thresholdFeet: NCAA_ALTITUDE_ADJUSTMENT_TABLE.thresholdFeet,
    };
  }

  const event = normalizeEventForCutline(input.event);
  if (isDivingEvent(input.event) || isDivingEvent(event)) {
    return notInTable(event, course, 'Diving is scored in points; the altitude chart adjusts times only.');
  }
  const distanceMatch = LEADING_DISTANCE.exec(event);
  if (!distanceMatch) {
    return notInTable(event, course, `"${input.event}" states no distance the altitude chart can be read by.`);
  }
  const distance = Number.parseInt(distanceMatch[1], 10);
  const relay = /\brelay\b/i.test(event);
  // A relay is four legs. "Four times the appropriate figures" is read as four
  // times the figure for one leg's distance; see the module header.
  const legDistance = relay ? distance / 4 : distance;
  const row = Number.isInteger(legDistance) ? altitudeRowFor(legDistance, course) : null;
  if (!row) {
    const what = relay ? `a ${legDistance} ${course} relay leg` : `a ${distance} ${course} event`;
    return notInTable(event, course, `The NCAA altitude chart prints no figure for ${what}.`);
  }

  const actualSeconds = convertTimeToSeconds(String(input.time ?? '').trim());
  if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) {
    throw new Error(`"${input.time}" is not a swim time; it cannot be adjusted for altitude.`);
  }

  const figure = NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds[row][elevation.elevationClass];
  const multiplier = relay ? NCAA_ALTITUDE_ADJUSTMENT_TABLE.relayMultiplier : 1;
  const subtractedHundredths = Math.round(figure * 100) * multiplier;
  const adjustedHundredths = Math.round(actualSeconds * 100) - subtractedHundredths;
  if (adjustedHundredths <= 0) {
    throw new Error(
      `Adjusting ${input.time} for ${event} by ${subtractedHundredths / 100}s leaves no time; the input is not a real swim.`
    );
  }
  const adjustedSeconds = adjustedHundredths / 100;
  return {
    status: 'adjusted',
    event,
    course,
    elevationClass: elevation.elevationClass,
    row,
    relay,
    secondsSubtracted: subtractedHundredths / 100,
    actualTime: formatSecondsToTime(actualSeconds),
    actualSeconds,
    adjustedTime: formatSecondsToTime(adjustedSeconds),
    adjustedSeconds,
    table: NCAA_ALTITUDE_ADJUSTMENT_TABLE.id,
  };
}

/**
 * {@link ncaaAltitudeAdjustment} for a stored swim, with the double-adjustment
 * guard. Throws when the swim is already altitude-adjusted
 * (`isAltitudeAdjusted: true`) or states no course.
 */
export function adjustSwimForAltitude(
  swim: Pick<HistoricalSwim, 'event' | 'time' | 'timeType' | 'isAltitudeAdjusted'>,
  elevation: AltitudeElevation
): NcaaAltitudeAdjustment {
  if (swim.isAltitudeAdjusted === true) {
    throw new Error(
      `${swim.event} ${swim.time} is already altitude-adjusted; applying the NCAA chart again would subtract it twice.`
    );
  }
  if (!swim.timeType) {
    throw new Error(
      `${swim.event} ${swim.time} states no course; the altitude chart's rows differ by course, so none is assumed.`
    );
  }
  return ncaaAltitudeAdjustment({
    event: swim.event,
    time: swim.time,
    course: swim.timeType,
    elevation,
  });
}
