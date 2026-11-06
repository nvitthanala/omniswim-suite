/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/metrics` formats a time the way core does, and shows a missing
 * time as a marker, never as `0.00`.
 *
 * ## Why this test exists
 *
 * The local `formatTime` used to truncate (5.678 read `5.67`) and to return
 * `"0.00"` for null or NaN. A zero-second time is a real, plausible value, so
 * a missing time that read `0.00` could not be told from one. CLAUDE.md
 * (data provenance, rule 4): absent is not empty.
 */
import { describe, expect, it } from 'vitest';
import { formatSecondsToTime } from '@omniswim/core/lib/utils';
import { formatTime, MISSING_TIME_MARKER } from '../packages/metrics/src/lib/utils';

describe('metrics formatTime', () => {
  it('renders a missing or unusable time as the marker, never 0.00', () => {
    expect(MISSING_TIME_MARKER).toBe('—');
    for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatTime(missing)).toBe(MISSING_TIME_MARKER);
    }
    expect(MISSING_TIME_MARKER).not.toBe('0.00');
  });

  it('keeps a real zero as 0.00', () => {
    expect(formatTime(0)).toBe('0.00');
  });

  it('rounds to the hundredth instead of truncating', () => {
    expect(formatTime(5.678)).toBe('5.68'); // truncation gave 5.67
    expect(formatTime(5.674)).toBe('5.67');
    expect(formatTime(61.996)).toBe('1:02.00'); // truncation gave 1:01.99
  });

  it('carries a time that rounds up to a whole minute', () => {
    expect(formatTime(59.996)).toBe('1:00.00');
    expect(formatTime(119.996)).toBe('2:00.00');
  });

  it('agrees with core formatSecondsToTime away from the carry', () => {
    for (const seconds of [0.5, 21.37, 47.83, 59.99, 60, 61.5, 112.45, 1005.25, 3599.99]) {
      expect(formatTime(seconds)).toBe(formatSecondsToTime(seconds));
    }
  });
});
