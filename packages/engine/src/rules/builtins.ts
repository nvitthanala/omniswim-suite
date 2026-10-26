/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Built-in rule presets (plans/2026-10-25/D2-ENGINE-API.md, 3.12 and 4).
 *
 * Built-ins are code. A caller addresses one by `{kind: 'builtin', id, version}`; none is seeded
 * into storage. `tests/engineBuiltinVersions.test.ts` pins the sha256 of each (id, version): changing
 * content without raising `version` fails.
 *
 * ## Provenance rules (CLAUDE.md, data provenance)
 * Every value traces to a primary source or to a user statement with its record. A value nobody
 * stated is `pending`. Nothing is estimated, interpolated or borrowed from the legacy scorer's
 * defaults. A missing limit is never `'unlimited'`.
 *
 * ## NSISC v1: pending fields
 * `scoring.individualPoints`, `scoring.relayPoints` and `scoring.divingPoints` are pending. SwimCloud
 * holds the NSISC table (R15), but recon found no archived source, so a value copied from
 * `SCORING_POINTS`, from SwimCloud's `scoring16` or from `data/meets.json` would be a guess. A
 * "yes, use it" from the user, with the capture archived under `data/`, becomes v2.
 * `scorers.relayEligibleFromScorerPool` stores "not applicable under roster eligibility" as pending.
 * `pendingPaths` skips it, and the legacy bridge writes the inert generic value.
 */
import { settingsForBuiltInScoringPreset } from '../lib/scoringDefaults';
import type { RulePreset } from './rulePreset';
import { pending, readmeRow, recorded, setting, userPlan } from './builtinSupport';
import type { Builtin } from './builtinSupport';
import type { Provenance } from '../model/provenance';

export type { Builtin } from './builtinSupport';

/* -------------------------------------------------------------------------- */
/* generic v1                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * NCAA Rule 7, the source of the generic tables. The sha256 and url are copied from
 * `data/scoring_rules/sources/manifest.json`; `tests/engineBuiltinVersions.test.ts` matches them.
 */
const NCAA_RULE7: Provenance = {
  kind: 'published',
  source: {
    sourceId: 'ncaa-rule7-scoring',
    manifest: 'data/scoring_rules/sources/manifest.json',
    sha256: '5b98f8f69470606ea179b053b86d7fb4451f61a874c0fff5d8d18b369d6bb92e',
    url: 'https://meets.swimdna.org/media/ncaascoring.pdf',
    publisher: 'NCAA',
    locator: 'Rule 7-6-4',
  },
};

const NO_RULE = 'No rule states this for a generic championship. NCAA Rule 7 publishes no pool, diver weight or entry limit.';
const BLOCKS = ['requireComplete', 'scoreMeet'] as const;

function buildGeneric(): RulePreset {
  // The 16-competitor championship tables, generated from NCAA_FORMAT_RULESETS['championship-16']
  // (ncaaScoringRules.ts, Rule 7-6-4) through the legacy preset. The A-final bracket comes from the
  // same ruleset through `bracketForFinals`. Nothing is typed here.
  const legacy = settingsForBuiltInScoringPreset('ncaa-championship-16');
  const relay = legacy.relayPoints;
  const bracket = legacy.aFinalBracketSize;
  if (relay === undefined || bracket === undefined) {
    throw new Error('ncaa-championship-16 must carry a relay table and an A-final bracket size');
  }
  return {
    payloadVersion: 1,
    scoring: {
      individualPoints: setting([...legacy.scoringPoints], NCAA_RULE7),
      relayPoints: setting({ kind: 'table', points: [...relay] }, NCAA_RULE7),
      divingPoints: pending(NO_RULE, BLOCKS),
      halfRateRelaySwimmer: pending(NO_RULE, BLOCKS),
      aFinalBracketSize: setting(bracket, NCAA_RULE7),
      nonScorerPlacement: pending(NO_RULE, BLOCKS),
      abFinalsScorersOnly: pending(NO_RULE, BLOCKS),
      cFinal: pending(NO_RULE, BLOCKS),
    },
    scorers: {
      eligibility: pending(NO_RULE, BLOCKS),
      autoRules: pending(NO_RULE, BLOCKS),
      scoringTeamSize: pending(NO_RULE, BLOCKS),
      scoringTeamScope: pending(NO_RULE, BLOCKS),
      diverWeight: pending(NO_RULE, BLOCKS),
      perEventScorerCap: pending(NO_RULE, BLOCKS),
      divingPerEventScorerCap: pending(NO_RULE, BLOCKS),
      scoringRelaysPerTeamPerEvent: pending(NO_RULE, BLOCKS),
      relayEligibleFromScorerPool: pending(NO_RULE, BLOCKS),
      relayLegsMustBeScorers: pending(NO_RULE, BLOCKS),
    },
    entries: {
      maxIndividualPerSwimmer: pending(NO_RULE, BLOCKS),
      maxRelayPerSwimmer: pending(NO_RULE, BLOCKS),
      maxTotalPerSwimmer: pending(NO_RULE, BLOCKS),
      timeTrialsCount: pending(NO_RULE, BLOCKS),
      exhibitionCounts: pending(NO_RULE, BLOCKS),
      relayLegsAllowTimeTrials: pending(NO_RULE, BLOCKS),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* nsisc v1                                                                   */
/* -------------------------------------------------------------------------- */

const POINTS_BLOCKS = ['requireComplete', 'scoreMeet', 'toLegacyScoringSettings'] as const;

function buildNsisc(): RulePreset {
  return {
    payloadVersion: 1,
    scoring: {
      individualPoints: pending(
        "SwimCloud's NSISC per-place values (recon Q17). R15 states 16 places.",
        POINTS_BLOCKS
      ),
      relayPoints: pending("SwimCloud's NSISC relay per-place values (recon Q17).", POINTS_BLOCKS),
      divingPoints: pending("SwimCloud's NSISC diving per-place values (recon Q17).", POINTS_BLOCKS),
      halfRateRelaySwimmer: setting(
        true,
        readmeRow('51', "Each relay swimmer gets 1/4 of the relay's points in their own point total")
      ),
      aFinalBracketSize: setting(8, readmeRow('43', '8 swimmers.')),
      nonScorerPlacement: setting(
        'removed-from-consideration',
        readmeRow('58', 'A non-scorer is removed from the places, and the scorers behind move up, as with an exhibition swimmer.')
      ),
      abFinalsScorersOnly: setting(true, readmeRow('60', 'In NSISC, the A and B finals hold scorers only.')),
      cFinal: setting(
        { kind: 'non-scorers', size: 8 },
        readmeRow('61', 'The 8 fastest non-scorers from prelims swim a C final in the evening.')
      ),
    },
    scorers: {
      eligibility: setting('roster', readmeRow('32', 'Only scoring-team swimmers score')),
      // The roster wins over placement (R40), so a coach tag overrides every automatic mark.
      // `distanceFinalRequired` blocks only a prelims swim, and a split timed final has none.
      autoRules: setting(
        {
          abFinalTiers: ['A', 'B'],
          includeRelayLegsInFinals: true,
          distanceFinalRequired: true,
          distanceEventPattern: ['1000', '1650', '1500'],
          splitTimedFinalMarksScorer: true,
        },
        readmeRow('38,55,56,57', 'A swimmer who made an A or B final is marked as a scorer.')
      ),
      scoringTeamSize: setting(18, readmeRow('41,45', '18.')),
      scoringTeamScope: setting(
        'meet',
        userPlan('21', 'Total roster scoring headcount limitation (total number of team members allowed on scoring team)')
      ),
      diverWeight: setting({ numerator: 1, denominator: 3 }, userPlan('22', 'divers are ⅓ of rull roster limit')),
      perEventScorerCap: setting(
        { cap: 'unlimited' },
        readmeRow('32', 'No limit on how many swimmers from one team score in an event')
      ),
      // R27 says diving follows the swimming rule. The spec's table prints `{cap:'unlimited'}` here,
      // which is not a valid `DivingPerEventScorerCap`. `same-as-swimming` is the reading that matches
      // R27 and keeps the drift test at four differences (`own` + unlimited bridges to 999, legacy absent).
      divingPerEventScorerCap: setting(
        { kind: 'same-as-swimming' },
        readmeRow('44', 'Same rule as swimming: no limit on how many divers from one team score in an event.')
      ),
      scoringRelaysPerTeamPerEvent: setting(
        2,
        readmeRow('42,59', '2 per team per relay event (the A and B relays).')
      ),
      relayEligibleFromScorerPool: pending(
        "Not applicable under 'roster' eligibility. Set only if eligibility becomes 'points_pool'.",
        ['scorers.eligibility is points_pool']
      ),
      relayLegsMustBeScorers: setting(true, readmeRow('54', 'A relay scores only if all four legs are on the scoring team.')),
    },
    entries: {
      maxIndividualPerSwimmer: setting(
        'unlimited',
        userPlan('24', 'you can cut it any way you would like, usually 4I/4R, 3I/5R')
      ),
      maxRelayPerSwimmer: setting(
        'unlimited',
        userPlan('24', 'you can cut it any way you would like, usually 4I/4R, 3I/5R')
      ),
      maxTotalPerSwimmer: setting(8, userPlan('24', 'nsisc caps at 8 total')),
      timeTrialsCount: setting(
        false,
        recorded(
          '2026-09-21',
          'packages/engine/src/lib/scoringDefaults.ts:85',
          "These are the user's rulings (2026-09-21 for time trials, 2026-10-01 for"
        )
      ),
      exhibitionCounts: setting(
        true,
        recorded(
          '2026-10-01',
          'packages/engine/src/lib/scoringDefaults.ts:85-86',
          "These are the user's rulings (2026-09-21 for time trials, 2026-10-01 for exhibition)"
        )
      ),
      // Decision D9 was an open question on 2026-10-10 (IMPROVEMENT_PLAN_2026-10-10.md:575). The
      // user's answer is recorded in the state file below, on 2026-10-12 (commit ef8118ca).
      relayLegsAllowTimeTrials: setting(
        false,
        recorded(
          '2026-10-12',
          'docs/reference/IMPROVEMENT_PLAN_2026-10-10_STATE.json:154',
          'Time trials do not fill relay legs by default'
        )
      ),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** `'nsisc'` v1 and `'generic'` v1. */
export const BUILTIN_RULE_PRESETS: readonly Builtin<RulePreset>[] = [
  { id: 'nsisc', version: 1, label: 'NSISC', preset: buildNsisc() },
  { id: 'generic', version: 1, label: 'Generic NCAA championship', preset: buildGeneric() },
];

/** The built-in with this id and version, or `undefined`. Never a fallback to another id or version. */
export function builtinRulePreset(id: string, version: number): RulePreset | undefined {
  return BUILTIN_RULE_PRESETS.find(b => b.id === id && b.version === version)?.preset;
}
