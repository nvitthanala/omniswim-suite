/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Legacy bridge (plans/2026-10-25/D2-ENGINE-API.md, 3.5). Reached at
 * `@omniswim/engine/rules/legacyBridge`, not from the package root, so the legacy
 * `ScoringSettings` type stays out of the extension's types.
 *
 * Turns a complete rule preset into the `ScoringSettings` the legacy scorer reads. The legacy
 * scorer keeps its `999` sentinel and its fallbacks (D2 decision 0.5); this file is the one place
 * the sentinel is written.
 *
 * ## Fixed point
 * `mergeScoringSettings(toLegacyScoringSettings(P))` deep-equals `toLegacyScoringSettings(P)`.
 * `mergeScoringSettings` spreads `GENERIC_TOP16_SETTINGS` first, so every key the generic preset
 * defines is written here, with the preset's own value. It flips a preset to roster mode when the
 * numbers look like NSISC (`scoringDefaults.ts:634-641`), so `scorerEligibilityMode` is always
 * explicit. It sniffs the PDF place-points column when `usePdfPlacePoints` is `'auto'`, so that is
 * always `false`. This bridge never passes a conference, so the NSISC lock (`:780-789`) never
 * applies and an NSISC-shaped preset may set a total of 8.
 *
 * No key is ever written with the value `undefined`: an absent field is an absent key.
 */
import type { ScoringSettings } from '../types';
import type { Setting } from '../model/provenance';
import { RulePresetError } from './cap';
import type { Cap } from './cap';
import type { CompleteRulePreset, PerEventScorerCap } from './rulePreset';

/** The legacy scorer reads any cap of this value or more as unlimited (F4). */
export const LEGACY_UNLIMITED = 999;

function capNumber(cap: Cap): number {
  return cap === 'unlimited' ? LEGACY_UNLIMITED : cap;
}

function valueOf<T>(setting: Setting<T>, path: string): T {
  if (setting.state !== 'set') {
    throw new RulePresetError(path, 'pending', `${path}: pending; the bridge needs a complete preset`);
  }
  return setting.value;
}

/**
 * Map a complete preset to legacy settings. Throws `RulePresetError` `invalid` for a preset the
 * legacy settings cannot express: a swimming cap and a diving cap that are both numeric with
 * different over-cap behavior (legacy has one `overCapPlaceBehavior`).
 */
export function toLegacyScoringSettings(p: CompleteRulePreset): ScoringSettings {
  const individualPoints = valueOf(p.scoring.individualPoints, 'scoring.individualPoints');
  const relayRule = valueOf(p.scoring.relayPoints, 'scoring.relayPoints');
  const divingRule = valueOf(p.scoring.divingPoints, 'scoring.divingPoints');
  const eligibility = valueOf(p.scorers.eligibility, 'scorers.eligibility');
  const autoRules = valueOf(p.scorers.autoRules, 'scorers.autoRules');
  const weight = valueOf(p.scorers.diverWeight, 'scorers.diverWeight');
  const swimmingCap: PerEventScorerCap = valueOf(p.scorers.perEventScorerCap, 'scorers.perEventScorerCap');
  const divingCap = valueOf(p.scorers.divingPerEventScorerCap, 'scorers.divingPerEventScorerCap');

  const out: ScoringSettings = {
    scoringPoints: [...individualPoints],
    // A table rule ignores the multiplier (types.ts, `relayPoints`), so the value is inert; 2 is the generic one.
    relayMultiplier: relayRule.kind === 'multiple-of-individual' ? relayRule.multiplier : 2,
    halfRateRelaySwimmer: valueOf(p.scoring.halfRateRelaySwimmer, 'scoring.halfRateRelaySwimmer'),
    maxIndividualScorersPerTeam: capNumber(valueOf(p.scorers.scoringTeamSize, 'scorers.scoringTeamSize')),
    maxRelaysScoringPerTeam: capNumber(valueOf(p.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent')),
    aFinalBracketSize: valueOf(p.scoring.aFinalBracketSize, 'scoring.aFinalBracketSize'),
    scorerCapScope: valueOf(p.scorers.scoringTeamScope, 'scorers.scoringTeamScope'),
    diverScorerWeight: weight.numerator / weight.denominator,
    // Legacy ignores this under 'roster' (calculatePoints.ts:410, relayScoring.ts:190). The preset
    // stores it pending there (not applicable), and the bridge writes the inert generic value.
    relayEligibleFromScorerPool: relayEligibleFromScorerPool(p, eligibility),
    diverEventPattern: ['DIVING', 'DIVE'],
    maxIndividualEntriesPerSwimmer: capNumber(valueOf(p.entries.maxIndividualPerSwimmer, 'entries.maxIndividualPerSwimmer')),
    maxRelayEntriesPerSwimmer: capNumber(valueOf(p.entries.maxRelayPerSwimmer, 'entries.maxRelayPerSwimmer')),
    maxTotalEntriesPerSwimmer: capNumber(valueOf(p.entries.maxTotalPerSwimmer, 'entries.maxTotalPerSwimmer')),
    entryCapCountsTimeTrials: valueOf(p.entries.timeTrialsCount, 'entries.timeTrialsCount'),
    entryCapCountsExhibition: valueOf(p.entries.exhibitionCounts, 'entries.exhibitionCounts'),
    relayLegsAllowTimeTrials: valueOf(p.entries.relayLegsAllowTimeTrials, 'entries.relayLegsAllowTimeTrials'),
    usePdfPlacePoints: false,
    scorerEligibilityMode: eligibility,
  };

  if (relayRule.kind === 'table') out.relayPoints = [...relayRule.points];
  if (divingRule.kind === 'table') out.divingPoints = [...divingRule.points];

  if (autoRules !== null) {
    // `splitTimedFinalMarksScorer` has no legacy field and is not written.
    // Each of the four keys must be present. Legacy reads an absent key as its own default, so
    // filling one here (`[]` for the tiers, say) would change the rule without saying so.
    const { abFinalTiers, includeRelayLegsInFinals, distanceFinalRequired, distanceEventPattern } = autoRules;
    if (
      abFinalTiers === undefined ||
      includeRelayLegsInFinals === undefined ||
      distanceFinalRequired === undefined ||
      distanceEventPattern === undefined
    ) {
      throw new RulePresetError(
        'scorers.autoRules',
        'invalid',
        'scorers.autoRules: abFinalTiers, includeRelayLegsInFinals, distanceFinalRequired and distanceEventPattern must all be set; the bridge does not fill a missing one'
      );
    }
    out.scorerAutoRules = {
      abFinalTiers: [...abFinalTiers],
      includeRelayLegsInFinals,
      distanceFinalRequired,
      distanceEventPattern: [...distanceEventPattern],
    };
  } else if (eligibility === 'roster') {
    throw new RulePresetError(
      'scorers.autoRules',
      'invalid',
      'scorers.autoRules: eligibility "roster" needs auto rules; the legacy merge would fill the defaults silently'
    );
  }

  // The legacy pool test (individualScoring.ts, resolveTeamPlaceCap): 'meet' scope and a size below 999.
  const meetWidePool = out.scorerCapScope === 'meet' && (out.maxIndividualScorersPerTeam ?? LEGACY_UNLIMITED) < LEGACY_UNLIMITED;
  applyPerEventCaps(out, swimmingCap, divingCap, meetWidePool);
  return out;
}

function relayEligibleFromScorerPool(p: CompleteRulePreset, eligibility: 'roster' | 'points_pool'): boolean {
  const setting = p.scorers.relayEligibleFromScorerPool;
  if (setting.state === 'set') return setting.value;
  if (eligibility === 'roster') return false;
  throw new RulePresetError(
    'scorers.relayEligibleFromScorerPool',
    'pending',
    'scorers.relayEligibleFromScorerPool: pending under "points_pool"; the bridge needs a complete preset'
  );
}

/**
 * Per-event caps. Swimming `'unlimited'` writes nothing. A numeric swimming cap writes the cap and
 * its over-cap behavior. Diving `same-as-swimming` writes nothing. Diving `own` writes its number.
 * Diving `own` and unlimited writes nothing when swimming is unlimited too, and 999 when swimming
 * has a cap, because 999 is the only way legacy exempts dives from the swimming cap.
 *
 * The legacy scorer refuses three shapes at score time (`individualScoring.ts`,
 * `resolveTeamPlaceCap`), so the bridge refuses them first, with the path:
 * - a per-event cap below 1 (legacy: "must be a positive integer");
 * - any per-event cap written beside a meet-wide scorer pool (`scorerCapScope 'meet'` and a numeric
 *   team size). Legacy declines to guess whether an over-cap swimmer spends a pool slot, and no
 *   other form of the cap is accepted, so there is nothing to bridge to;
 * - two numeric caps with different over-cap behavior (legacy holds one `overCapPlaceBehavior`).
 */
function applyPerEventCaps(
  out: ScoringSettings,
  swimming: PerEventScorerCap,
  diving: { readonly kind: 'same-as-swimming' } | ({ readonly kind: 'own' } & PerEventScorerCap),
  meetWidePool: boolean
): void {
  const refuse = (path: string, why: string): never => {
    throw new RulePresetError(path, 'invalid', `${path}: ${why}`);
  };
  const belowOne = 'a per-event cap below 1 is refused by the legacy scorer; use a positive number, or unlimited';
  const poolClash =
    'a per-event cap beside a meet-wide scorer pool is refused by the legacy scorer, which cannot say whether an over-cap swimmer spends a pool slot';

  let overCap: 'holds-place' | 'removed-from-consideration' | null = null;
  if (swimming.cap !== 'unlimited') {
    if (swimming.cap < 1) refuse('scorers.perEventScorerCap', belowOne);
    if (meetWidePool) refuse('scorers.perEventScorerCap', poolClash);
    out.maxIndividualScorersPerTeamPerEvent = swimming.cap;
    overCap = swimming.overCap;
  }
  if (diving.kind === 'own') {
    if (diving.cap === 'unlimited') {
      if (swimming.cap !== 'unlimited') out.divingMaxScorersPerTeamPerEvent = LEGACY_UNLIMITED;
    } else {
      if (diving.cap < 1) refuse('scorers.divingPerEventScorerCap', belowOne);
      if (meetWidePool) refuse('scorers.divingPerEventScorerCap', poolClash);
      out.divingMaxScorersPerTeamPerEvent = diving.cap;
      if (overCap !== null && overCap !== diving.overCap) {
        refuse(
          'scorers.divingPerEventScorerCap',
          'the swimming and diving caps name different over-cap behavior, and the legacy settings hold only one'
        );
      }
      overCap = diving.overCap;
    }
  }
  if (overCap !== null) out.overCapPlaceBehavior = overCap;
}
