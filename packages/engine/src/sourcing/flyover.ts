/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The flyover allowance and the split value (plans/2026-10-25/D7-DATA-SOURCING.md section 5, F1.3a;
 * D2 3.10; README R14, R62, R93).
 *
 * The flyover is a number of seconds the user sets, "to subtract a little bit of time due to the
 * momentum gained and reaction on the exchange of the entering swimmer" (R14, R62). It has no
 * default. `unset` is a state of its own: it gives no estimate. It never reads as 0 seconds.
 *
 * The flyover applies in one place only: a flat-start time projected onto relay leg 2 to 4
 * (`estimateFlyingLeg`). A relay split already includes the exchange, converted or not, so the
 * flyover is never subtracted from one (D2 3.13). `splitScyValue` therefore takes no flyover.
 */
import type { DivisionRef, MeetSwim, RelaySplit } from '../model/meet';
import type { EventKey, Gender, Hundredths } from '../model/primitives';
// A cycle with `model/results` (which imports this file) that is safe: both sides only call at run
// time. The rankable test and the SCY value stay single-sourced there (invariant 8).
import { isRankable, scyValue } from '../model/results';
import { scyStatementForSplit } from './convert';
import type { ConversionSettings } from './convert';

export type FlyoverSetting = { readonly state: 'unset' } | { readonly state: 'set'; readonly hundredths: number };

/** What `scoreMeet` and the auto-builder read: the conversion settings plus the flyover. */
export interface SourcingSettings extends ConversionSettings {
  readonly flyover: FlyoverSetting;
}

/**
 * `flyoverAllowanceSec` (D3) to a setting. `undefined` is `unset`. Throws `RangeError` for a number
 * that is negative, not finite, or has more than two decimals: a coach types x.xx seconds, and a
 * value that cannot be hundredths exactly is a typo, not something to round.
 */
export function flyoverFromSeconds(sec: number | undefined): FlyoverSetting {
  if (sec === undefined) return { state: 'unset' };
  if (typeof sec !== 'number' || !Number.isFinite(sec)) throw new RangeError(`flyoverFromSeconds: ${String(sec)} is not a finite number`);
  if (sec < 0) throw new RangeError(`flyoverFromSeconds: ${String(sec)} is negative`);
  // Compare through the rounded hundredths, not `Number.isInteger(sec * 100)`: 0.29 * 100 is 28.999999999999996.
  const hundredths = Math.round(sec * 100);
  if (hundredths / 100 !== sec || !Number.isSafeInteger(hundredths)) {
    throw new RangeError(`flyoverFromSeconds: ${String(sec)} is not a whole number of hundredths of a second`);
  }
  // `+ 0` turns -0 into 0.
  return { state: 'set', hundredths: hundredths + 0 };
}

/** The allowance in hundredths, or `null` when the user has not set one. Throws for a `set` value that is not hundredths. */
function allowanceOf(f: FlyoverSetting): Hundredths | null {
  if (f.state === 'unset') return null;
  if (!Number.isSafeInteger(f.hundredths) || f.hundredths < 0) {
    throw new RangeError(`estimateFlyingLeg: ${String(f.hundredths)} is not a non-negative integer of hundredths`);
  }
  return f.hundredths;
}

/**
 * The flying-start time of a relay leg 2 to 4 projected from a flat-start swim: the swim's yards time
 * minus the flyover. `null` (no estimate, never 0) when:
 * - the flyover is `unset`;
 * - the swim is not rankable (an extracted split, a typed-in time or an unconfirmed program swim,
 *   invariant 8);
 * - the swim is not in the leg's exact event (`flat.eventKey !== legEventKey`, invariant 13);
 * - the swim has no yards time (NT, or not convertible);
 * - the result would be 0 or less.
 *
 * With a flyover of 0 the estimate equals the flat time and is still an estimate. `usedConverted`
 * says the flat time is a converted one (`flat.scy.kind === 'converted'`): the caller shows both
 * the recorded and the converted time. The caller picks the swim; the fastest rankable swim of the
 * leg event is the option the auto-builder offers.
 */
export function estimateFlyingLeg(
  flat: MeetSwim,
  legEventKey: EventKey,
  f: FlyoverSetting
): { readonly hundredths: number; readonly usedConverted: boolean } | null {
  const allowance = allowanceOf(f);
  if (allowance === null) return null;
  if (!isRankable(flat)) return null;
  if (flat.eventKey !== legEventKey) return null;
  const value = scyValue(flat);
  if (value === null) return null;
  const hundredths = value - allowance;
  if (hundredths <= 0) return null;
  return { hundredths, usedConverted: flat.scy.kind === 'converted' };
}

/**
 * The yards value of one relay split, in hundredths, or `null` when it has none (README R62).
 * - A SCY split is its own time, whatever its `legEventKey` says. Nothing else touches it.
 * - A split in another course converts through `scyStatementForSplit`: the individual divisor and
 *   turn for the leg's stroke and distance. `null` when that has no conversion (course unknown,
 *   conversions switched off, no preset, no published factor).
 * `gender` is the relay's. A flying-start split already includes the exchange, so no flyover is
 * subtracted here or by any caller.
 */
export function splitScyValue(split: RelaySplit, division: DivisionRef, gender: Gender, s: ConversionSettings): Hundredths | null {
  if (split.course === 'SCY') return split.split.hundredths;
  const statement = scyStatementForSplit(split, division, gender, s);
  return statement.kind === 'converted' ? statement.hundredths : null;
}
