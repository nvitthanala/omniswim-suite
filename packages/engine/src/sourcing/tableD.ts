/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Table D preset types (plans/2026-10-25/D2-ENGINE-API.md, 3.10). Types only in P1: the built-in
 * Table D in `builtins.ts` needs them. The conversion functions and `SourcingSettings` arrive in P4.
 */
import type { EventKey } from '../model/primitives';
import type { Setting } from '../model/provenance';

export interface TableDRow {
  readonly lcmEventKey: EventKey;
  readonly scyEventKey: EventKey;
  readonly multiplierPermille: Setting<number>;
  readonly turnAdjustmentHundredths: Setting<number>;
}

export interface TableDPreset {
  readonly payloadVersion: 1;
  readonly rows: readonly TableDRow[];
  readonly rounding: Setting<'truncate' | 'round-half-up'>;
}
