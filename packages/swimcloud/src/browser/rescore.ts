/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One call for the overlay: snapshot in, engine results and parity out.
 *
 *   adaptSimulatorSnapshot -> requireComplete(SwimCloud preset) -> scoreMeet -> parityReport
 *
 * The preset is built from the snapshot's own SwimCloud settings, so a mismatch means the adapter or
 * the engine is wrong, or SwimCloud changed its page. It is not a rule choice by the user.
 */
import { requireComplete, scoreMeet } from '@omniswim/engine';
import type { ConversionSettings, Results } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from './adapt';
import type { AdaptOptions, AdaptedSimulator } from './adapt';
import { parityReport } from './parity';
import type { ParityReport } from './parity';
import type { SimulatorSnapshotInput } from './simulatorTypes';

/** The simulator scores yards only, and converts nothing. */
export const SIMULATOR_SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };

export type RescoreOutcome =
  | { readonly kind: 'not_loaded'; readonly missing: readonly ('swimmers' | 'swims' | 'splashes')[] }
  /** The page's `pointSystem` has no table here, so the preset is not complete. Nothing is scored. */
  | { readonly kind: 'preset_incomplete'; readonly adapted: AdaptedSimulator; readonly pending: readonly string[] }
  | { readonly kind: 'scored'; readonly adapted: AdaptedSimulator; readonly results: Results; readonly parity: ParityReport };

export function rescoreSimulator(snapshot: SimulatorSnapshotInput, opts: AdaptOptions): RescoreOutcome {
  const outcome = adaptSimulatorSnapshot(snapshot, opts);
  if (outcome.kind === 'not_loaded') return outcome;
  const { adapted } = outcome;
  if (!adapted.preset.complete) return { kind: 'preset_incomplete', adapted, pending: adapted.preset.pending };
  const results = scoreMeet(adapted.model, adapted.lineup, [], requireComplete(adapted.preset.preset), SIMULATOR_SOURCING);
  return { kind: 'scored', adapted, results, parity: parityReport(adapted, results) };
}
