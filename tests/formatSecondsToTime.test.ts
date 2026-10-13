/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `formatSecondsToTime` carries a rounded-up second into the minutes column
 * and renders a missing time as `NT`, never `0.00`.
 *
 * ## Why this test exists
 *
 * The old formatter rounded the seconds field with `toFixed(2)` after it had
 * split off the minutes. 59.996 read `60.00` and 119.996 read `1:60.00`. Both
 * are wrong. The carry must reach the minutes. A value that was already
 * correct must not change, so a sweep compares against a frozen copy of the
 * old formatter and allows a difference only where the old output had a
 * `60.00` seconds field.
 */
import { describe, expect, it } from 'vitest';
import { formatSecondsToTime } from '@omniswim/core/lib/utils';

/** Frozen copy of the formatter before the carry fix. */
function legacyFormat(seconds: number): string {
  if (seconds === Infinity) return 'NT';
  if (seconds < 60) return seconds.toFixed(2);
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, '0')}`;
}

describe('formatSecondsToTime', () => {
  it('carries a second that rounds up to 60 into the minutes', () => {
    expect(formatSecondsToTime(59.996)).toBe('1:00.00');
    expect(formatSecondsToTime(119.996)).toBe('2:00.00');
    expect(formatSecondsToTime(599.996)).toBe('10:00.00');
  });

  it('does not carry a second that rounds down', () => {
    expect(formatSecondsToTime(59.994)).toBe('59.99');
    expect(formatSecondsToTime(119.994)).toBe('1:59.99');
  });

  it('keeps exact minutes and zero', () => {
    expect(formatSecondsToTime(60)).toBe('1:00.00');
    expect(formatSecondsToTime(600.0)).toBe('10:00.00');
    expect(formatSecondsToTime(0)).toBe('0.00');
  });

  it('renders a missing time as NT, never 0.00', () => {
    for (const missing of [Number.NaN, null, undefined, Number.POSITIVE_INFINITY]) {
      const out = formatSecondsToTime(missing as unknown as number);
      expect(out).toBe('NT');
      expect(out).not.toBe(formatSecondsToTime(0));
    }
  });

  it('matches the old formatter everywhere except where it printed a 60.00 seconds field', () => {
    let carried = 0;
    for (let ms = 0; ms <= 4_000_000; ms += 1) {
      const seconds = ms / 1000;
      const before = legacyFormat(seconds);
      const after = formatSecondsToTime(seconds);
      if (before === after) continue;
      // The only allowed difference: the old output ended in ":60.00" or was "60.00".
      expect(before === '60.00' || before.endsWith(':60.00')).toBe(true);
      expect(after).toMatch(/^\d+:\d{2}\.\d{2}$/);
      expect(after.endsWith(':00.00')).toBe(true);
      carried += 1;
    }
    expect(carried).toBeGreaterThan(0);
  });
});
