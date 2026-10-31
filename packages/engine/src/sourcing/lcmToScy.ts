/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The LCM to SCY conversion (plans/2026-10-25/D2-ENGINE-API.md, 3.13).
 *
 * `SCY = truncate((LCM - turn) / divisor)` to the hundredth of a second. One row per event, with an
 * integer divisor and an integer turn. The values are fitted to the outputs of a third-party converter
 * (README R58). The converter publishes no factors, so every value here is `tool-derived`, never
 * `published`. Table D (`tableD.ts`) is not used: the user ruled it incorrect (R58).
 *
 * All arithmetic is integer. A float seconds value would let `53.4199999` truncate to `53.41`.
 */
import type { EventKey, Hundredths } from '../model/primitives';
import type { Provenance, Setting } from '../model/provenance';

/** The divisor is stored times this scale: 1.11 is 111000, 0.8925 is 89250. */
export const LCM_SCY_DIVISOR_SCALE = 100000;

export interface LcmToScyRow {
  readonly lcmEventKey: EventKey;
  /** The yards event that takes the time. It differs for the distance freestyles (400 to 500). */
  readonly scyEventKey: EventKey;
  /** Divisor times `LCM_SCY_DIVISOR_SCALE`. */
  readonly divisorScaled: Setting<number>;
  /** Seconds taken off the LCM time before the divide, in hundredths. 0 for a distance freestyle. */
  readonly turnHundredths: Setting<number>;
}

export interface LcmToScyPreset {
  readonly payloadVersion: 1;
  readonly rows: readonly LcmToScyRow[];
  /** Only `'truncate'` replays the converter exactly (README R59 permits rounding; not built). */
  readonly rounding: Setting<'truncate'>;
}

/** Whether a conversion converted a swim by itself or a relay split (R60, R62). */
export type LcmToScyAppliedTo = 'individual-swim' | 'relay-split';

export type LcmToScyBasis = {
  readonly method: 'lcm_scy_tool_derived';
  readonly lcmEventKey: EventKey;
  readonly scyEventKey: EventKey;
  readonly divisorScaled: number;
  readonly turnHundredths: number;
  /** The provenance of the divisor. A `tool-derived` record, never `published`. */
  readonly provenance: Provenance;
  /**
   * `'relay-split'`: the converter has no split data. The user confirmed applying the individual
   * event's divisor and turn to a split (R62).
   */
  readonly appliedTo: LcmToScyAppliedTo;
};

export type LcmToScyAbsentReason =
  /** No row for the event: an LCM 500, an LCM 100 IM, a relay, a dive. Never factor 1.0. */
  | 'no_row_for_event'
  /** The row, or the rounding, is `pending`. A conversion that needs a pending value refuses. */
  | 'setting_pending'
  /** The turn leaves no time: `(LCM - turn)` is 0 or less. */
  | 'result_not_positive';

export type LcmToScyResult =
  | { readonly kind: 'converted'; readonly hundredths: Hundredths; readonly basis: LcmToScyBasis }
  | { readonly kind: 'absent'; readonly reason: LcmToScyAbsentReason };

/**
 * Convert an LCM time of `lcmHundredths` in `lcmEventKey` to yards, or say why not.
 *
 * Throws `RangeError` for a time that is not a positive integer: a missing time is `null` upstream
 * and never reaches here, so a bad number is a caller bug. The event match is exact: the caller
 * passes a canonical `EventKey`.
 */
export function convertLcmToScy(
  preset: LcmToScyPreset,
  lcmEventKey: EventKey,
  lcmHundredths: Hundredths,
  appliedTo: LcmToScyAppliedTo = 'individual-swim'
): LcmToScyResult {
  if (!Number.isInteger(lcmHundredths) || lcmHundredths <= 0) {
    throw new RangeError(`convertLcmToScy: ${String(lcmHundredths)} is not a positive integer of hundredths`);
  }
  const row = preset.rows.find(r => r.lcmEventKey === lcmEventKey);
  if (!row) return { kind: 'absent', reason: 'no_row_for_event' };
  if (row.divisorScaled.state !== 'set' || row.turnHundredths.state !== 'set' || preset.rounding.state !== 'set') {
    return { kind: 'absent', reason: 'setting_pending' };
  }
  const divisorScaled = row.divisorScaled.value;
  const turnHundredths = row.turnHundredths.value;
  if (!Number.isInteger(divisorScaled) || divisorScaled <= 0 || !Number.isInteger(turnHundredths) || turnHundredths < 0) {
    throw new RangeError(`convertLcmToScy: row ${lcmEventKey} holds a divisor or turn that is not a whole number`);
  }
  const net = lcmHundredths - turnHundredths;
  if (net <= 0) return { kind: 'absent', reason: 'result_not_positive' };
  // floor(net / divisor) in hundredths, with the divisor scaled: floor(net * SCALE / divisorScaled).
  const numerator = net * LCM_SCY_DIVISOR_SCALE;
  const hundredths = (numerator - (numerator % divisorScaled)) / divisorScaled;
  if (hundredths <= 0) return { kind: 'absent', reason: 'result_not_positive' };
  return {
    kind: 'converted',
    hundredths,
    basis: {
      method: 'lcm_scy_tool_derived',
      lcmEventKey: row.lcmEventKey,
      scyEventKey: row.scyEventKey,
      divisorScaled,
      turnHundredths,
      provenance: row.divisorScaled.provenance,
      appliedTo,
    },
  };
}
