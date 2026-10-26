/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test-only helpers for the engine rule preset tests. Nothing here ships. The completions fill the
 * three NSISC points fields the built-in leaves pending, so a test can run the bridge; they are
 * read out of the legacy NSISC constants, they are never written into a built-in.
 */
import { BUILTIN_RULE_PRESETS, requireComplete } from '@omniswim/engine';
import type { CompleteRulePreset, Provenance, RulePreset, Setting } from '@omniswim/engine';
import { NSISC_PRESET_SETTINGS } from '@omniswim/engine/lib/scoringDefaults';

export const TEST_PROVENANCE: Provenance = {
  kind: 'user-stated',
  statedOn: '2026-10-25',
  wording: 'test-only value',
  where: 'tests/engineTestPresets.ts:1',
  verbatim: false,
};

export function set<T>(value: T): Setting<T> {
  return { state: 'set', value, provenance: TEST_PROVENANCE };
}

export function builtinPreset(id: string): RulePreset {
  const found = BUILTIN_RULE_PRESETS.find(b => b.id === id);
  if (!found) throw new Error(`built-in rule preset "${id}" is missing`);
  return found.preset;
}

/**
 * The shipped NSISC preset with its three pending points settings, and its pending tie rule (v1),
 * filled from the legacy NSISC constants and the legacy scorer's behavior (it splits ties). A setting the built-in already holds is left alone, so the day a built-in sets one of
 * them the tests that use this helper cover it.
 */
export function nsiscWithTestPoints(): RulePreset {
  const base = builtinPreset('nsisc');
  return {
    ...base,
    scoring: {
      ...base.scoring,
      ties: base.scoring.ties.state === 'set' ? base.scoring.ties : set('split' as const),
      individualPoints:
        base.scoring.individualPoints.state === 'set' ? base.scoring.individualPoints : set([...NSISC_PRESET_SETTINGS.scoringPoints]),
      relayPoints:
        base.scoring.relayPoints.state === 'set'
          ? base.scoring.relayPoints
          : set({ kind: 'multiple-of-individual' as const, multiplier: NSISC_PRESET_SETTINGS.relayMultiplier }),
      divingPoints:
        base.scoring.divingPoints.state === 'set' ? base.scoring.divingPoints : set({ kind: 'same-as-individual' as const }),
    },
  };
}

export function completeNsisc(): CompleteRulePreset {
  return requireComplete(nsiscWithTestPoints());
}
