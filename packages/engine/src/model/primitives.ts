/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Primitives of the engine API (plans/2026-10-25/D2-ENGINE-API.md, 3.1).
 *
 * A time is integer hundredths plus the verbatim text (D2 decision 0.7). A missing time is
 * `null`, never `0`. Nothing in this file reads a clock or a random source.
 */

/** Same strings as the core enum `Gender` (`types.ts`). */
export type Gender = 'Men' | 'Women';
/** `HistoricalSwim.timeType`. */
export type Course = 'SCY' | 'SCM' | 'LCM';
export type { NcaaDivision } from '../types';
/** `YYYY-MM-DD`. */
export type IsoDate = string;
/** `Date#toISOString()` form: `YYYY-MM-DDTHH:MM:SS(.fff)Z`. */
export type IsoTime = string;
/** Integer, 0 or more. */
export type Hundredths = number;
export type TimeValue = { readonly text: string; readonly hundredths: Hundredths };
/** Canonical event name from `normalizeEventForCutline`. */
export type EventKey = string;
/** SwimCloud id as a string. */
export type SwimmerId = string;
export type TeamId = string;

// Minutes are optional. With minutes, seconds are two digits and below 60. Without, one or two
// digits and below 60. Hundredths are always two digits.
const TIME_WITH_MINUTES = /^(\d+):([0-5]\d)\.(\d{2})$/;
const TIME_SECONDS_ONLY = /^([0-5]?\d)\.(\d{2})$/;

/**
 * Parse a displayed time such as `57.57` or `1:57.57`.
 *
 * Returns `null` for the three texts that state no time: blank, `NT` and `DQ`. It never returns a
 * zero-hundredths time for those. Any other text that is not a time throws: an unreadable row must
 * raise, not become "no time" or a guess.
 */
export function parseTimeText(text: string): TimeValue | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (upper === 'NT' || upper === 'DQ') return null;

  const withMinutes = TIME_WITH_MINUTES.exec(trimmed);
  if (withMinutes) {
    const [, minutes, seconds, hundredths] = withMinutes as unknown as [string, string, string, string];
    return { text, hundredths: Number(minutes) * 6000 + Number(seconds) * 100 + Number(hundredths) };
  }
  const secondsOnly = TIME_SECONDS_ONLY.exec(trimmed);
  if (secondsOnly) {
    const [, seconds, hundredths] = secondsOnly as unknown as [string, string, string];
    return { text, hundredths: Number(seconds) * 100 + Number(hundredths) };
  }
  throw new RangeError(`parseTimeText: "${text}" is not a time, NT, DQ or blank`);
}

/** The display form of a time: `S.hh` below one minute, `M:SS.hh` from one minute. */
export function formatHundredths(h: Hundredths): string {
  if (!Number.isInteger(h) || h < 0) {
    throw new RangeError(`formatHundredths: ${String(h)} is not an integer of 0 or more`);
  }
  const total = Math.floor(h / 100);
  const hundredths = h % 100;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hh = String(hundredths).padStart(2, '0');
  if (minutes === 0) return `${seconds}.${hh}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${hh}`;
}
