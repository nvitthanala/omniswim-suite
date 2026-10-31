/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud writes a time as decimal seconds: `"118.85"`, or the number `181.02999999999997` where
 * the page summed four legs as floats. `parseTimeText` (engine) reads `M:SS.hh` and refuses `118.85`.
 * This reader turns SwimCloud seconds into hundredths without a guess:
 *
 * - It rounds to the nearest hundredth, never floors, so float noise cannot lose a hundredth.
 * - It refuses a value that is not within 1e-6 of a whole hundredth. A time with a third decimal is
 *   data this adapter does not understand, and rounding it would score a time nobody swam.
 * - It refuses zero, a negative, blank and non-numeric text. There is no "no time" here: a missing
 *   time is a missing field, which the caller handles before it reads.
 */
import type { Hundredths } from '@omniswim/engine';
import { AdapterError } from './simulatorTypes';

const TOLERANCE = 1e-6;
const DECIMAL = /^\d+(\.\d+)?$/;

export function parseSwimCloudHundredths(raw: string | number, path: string): Hundredths {
  let seconds: number;
  if (typeof raw === 'number') {
    seconds = raw;
  } else if (DECIMAL.test(raw.trim())) {
    seconds = Number(raw.trim());
  } else {
    throw new AdapterError('invalid_time', path, `"${raw}" is not decimal seconds`);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new AdapterError('invalid_time', path, `${String(raw)} is not a positive number of seconds`);
  }
  const scaled = seconds * 100;
  const hundredths = Math.round(scaled);
  if (Math.abs(scaled - hundredths) > TOLERANCE) {
    throw new AdapterError('invalid_time', path, `${String(raw)} is not a whole number of hundredths`);
  }
  return hundredths;
}
