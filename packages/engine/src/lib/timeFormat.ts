/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Time parsing and formatting: clock strings to seconds, seconds to clock strings, and the class-year drop projection.
// Split out of `utils.ts`, which still re-exports every name from here.

import { itemAt } from './indexedAccess';

/**
 * Pure string→seconds parse. Memoized: the same time strings are parsed
 * thousands of times inside scoring/sort comparators (calculatePoints groups,
 * relay grouping, TeamCard rows), so a bounded cache avoids repeated split/parseFloat.
 */
const timeToSecondsCache = new Map<string, number>();

const TIME_CACHE_LIMIT = 20000;

export function convertTimeToSeconds(timeStr: string): number {
  if (!timeStr || timeStr === 'NT' || timeStr === 'DQ') return Infinity;
  const cached = timeToSecondsCache.get(timeStr);
  if (cached !== undefined) return cached;
  const parts = timeStr.split(':');
  // `split` returns at least one part, and `parts.length === 2` proves index 1.
  const value =
    parts.length === 2
      ? parseFloat(itemAt(parts, 0)) * 60 + parseFloat(itemAt(parts, 1))
      : parseFloat(itemAt(parts, 0));
  if (timeToSecondsCache.size >= TIME_CACHE_LIMIT) timeToSecondsCache.clear();
  timeToSecondsCache.set(timeStr, value);
  return value;
}

/**
 * A time in seconds as `s.ss` or `m:ss.ss`, rounded to the hundredth with
 * `toFixed(2)`.
 *
 * - A time with no value (`Infinity`, `NaN`, `null`, `undefined`) renders as
 *   `NT`, the same sentinel `convertTimeToSeconds` maps back to `Infinity`.
 *   It never renders as `0.00`: a real zero-second time is a different thing
 *   from a missing one.
 * - A time that rounds up to a whole minute carries into the minutes column:
 *   59.996 reads `1:00.00` (not `60.00`) and 119.996 reads `2:00.00` (not
 *   `1:60.00`).
 */
export function formatSecondsToTime(seconds: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'NT';
  if (seconds < 60) {
    const rounded = seconds.toFixed(2);
    // 59.996 rounds up to 60.00: carry one minute.
    return rounded === '60.00' ? '1:00.00' : rounded;
  }
  let mins = Math.floor(seconds / 60);
  let secs = (seconds % 60).toFixed(2);
  if (secs === '60.00') {
    mins += 1;
    secs = '0.00';
  }
  return `${mins}:${secs.padStart(5, '0')}`;
}

export function calculateProjectedTime(timeSec: number, classYear: string, overallDropPercent = -1.0): number {
  let yearsRemaining = 0;
  if (classYear === 'FR') yearsRemaining = 3;
  if (classYear === 'SO') yearsRemaining = 2;
  if (classYear === 'JR') yearsRemaining = 1;
  if (classYear === 'HS') yearsRemaining = 4;

  if (yearsRemaining === 0) return timeSec;

  // Apply a drop of overallDropPercent% over the 4 years, mathematically prorated.
  const dropFraction = (overallDropPercent / 100) * (yearsRemaining / 4);
  return timeSec * (1 + dropFraction);
}
