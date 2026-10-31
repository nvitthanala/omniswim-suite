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
import { migrateRulePresetV1, migrateRulePresetV2 } from './rulePreset';
import type { RelayEntryRules, RelayOverCapRule, RulePreset, RulePresetV1, TieRule } from './rulePreset';
import type { Setting } from '../model/provenance';
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

/**
 * NCAA Rule 5-7-1-g, in the full rule book (README R72). The sha256 and url are copied from
 * `data/scoring_rules/sources/manifest.json` (id `ncaa-rulebook-2025-27`); `tests/engineBuiltinVersions.test.ts` matches them
 * and reads the quoted scope in `ncaa-rulebook-2025-27.txt`.
 */
const NCAA_RULEBOOK_5_7_1_G: Provenance = {
  kind: 'published',
  source: {
    sourceId: 'ncaa-rulebook-2025-27',
    manifest: 'data/scoring_rules/sources/manifest.json',
    sha256: '3c32eace52e1d9c01300cbf23ff0ea102fd5248ef2c4ae807246864fdedda9ea',
    url: 'https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/rules/PRXSW_RulesBook.pdf',
    publisher: 'NCAA',
    locator: 'Rule 5-7-1-g',
  },
};

const NO_RULE = 'No rule states this for a generic championship. NCAA Rule 7 publishes no pool, diver weight or entry limit.';
const BLOCKS = ['requireComplete', 'scoreMeet'] as const;

function buildGeneric(): RulePresetV1 {
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

function buildNsisc(): RulePresetV1 {
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

/**
 * NSISC v2 records the user's confirmed points while inheriting every other v1 setting.
 *
 * Source: the user's statement (plans/2026-10-25/README.md R45). Cross-check, not a source: the
 * 2026 NSISC results PDF in data/meets.json (workspace 1) shows relay-leg quarter credits of
 * 10, 8.5, 8 and 7.5 (40, 34, 32, 30 divided by 4), and a 12th-place tie in the men's 200 IM that
 * split 5 and 4 as 4.5 each. SwimCloud's "16 place scoring" preset is a parity reference only.
 */
function buildNsiscV2(): RulePresetV1 {
  const v1 = buildNsisc();
  const provenance = recorded(
    '2026-10-26',
    'plans/2026-10-25/README.md:69',
    'Individual and diving: 20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1. Relays: double (40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2). Ties split.'
  );
  return {
    ...v1,
    scoring: {
      ...v1.scoring,
      individualPoints: setting([20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1], provenance),
      divingPoints: setting({ kind: 'table', points: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1] }, provenance),
      relayPoints: setting({ kind: 'table', points: [40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2] }, provenance),
    },
  };
}

/**
 * NSISC v4 is v2's body with the total entry cap the user corrected to 7 (README R73, line 97; R4's 8 was
 * wrong). `exhibitionCounts` keeps its value, true, and now cites README R75 (line 99): entry limits count
 * every entry, exhibition included. v2 and v3 stay frozen at 8.
 */
function buildNsiscV4(): RulePresetV1 {
  const v2 = buildNsiscV2();
  return {
    ...v2,
    entries: {
      ...v2.entries,
      maxTotalPerSwimmer: setting(
        7,
        recorded('2026-10-27', 'plans/2026-10-25/README.md:97', '7 total events per swimmer, individuals and relays together.')
      ),
      exhibitionCounts: setting(
        true,
        recorded(
          '2026-10-27',
          'plans/2026-10-25/README.md:99',
          'Entry limits (per-swimmer individual, relay and total) count every entry, whether the swimmer is a scorer, a non-scorer or exhibition.'
        )
      ),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * ## Payload versions of the shipped built-ins
 * `RulePreset` is payload version 3. It added `scoring.ties` (version 2) and `scorers.relayOverCap`
 * (version 3). The shipped versions keep their frozen version 1 shaped bodies, whose pinned hashes did not
 * change (`frozen`). A saved reference to `{nsisc, 2}` resolves to the same values as before. `preset` is
 * that body moved to version 3, and the only additions are `scoring.ties` and `scorers.relayOverCap`:
 * - `nsisc` v3: `relayOverCap: 'exhibition'`. The user's statement (README R67, line 91) is that a relay
 *   entered beyond the scoring-relay limit is tagged exhibition. Every other value is v2's, so `frozen` is
 *   v2's body and the two share a hash. The new hash is in the `rule3|` pins.
 * - `nsisc` v4: v3 with `entries.maxTotalPerSwimmer` 7 (README R73) and `exhibitionCounts` citing R75. Its
 *   body is new, so all three of its hashes are new.
 * - `nsisc` v5: v4 plus `entries.nonScoringRelaysAllowed` false, from README R42 (line 59). Its `frozen` body is v4's, so
 *   the two share the `rule|` and `rule2|` hashes, as v3 shares v2's. `relaySwimmerOncePerEvent` stays absent: no archived
 *   NSISC source says NCAA relay rules govern NSISC relays.
 * - `generic` v2: v1 plus `entries.relaySwimmerOncePerEvent` true, from NCAA Rule 5-7-1-g in the archived rule book
 *   (`ncaa-rulebook-2025-27`). `frozen` is v1's body. Every other setting is v1's, still pending.
 * - `nsisc` v2: `ties: 'split'`. The user's statement of the points (README R45, line 69) ends "Ties split."
 *   The legacy scorer split ties for this preset before the setting existed, so scoring is unchanged.
 * - `nsisc` v1: `ties` pending. Its points are pending too, and R45 was stated for the confirmed points of v2.
 * - `generic` v1: `ties` pending. NCAA Rule 7 as archived states no tie rule for these tables, and no other
 *   source exists.
 * - `relayOverCap` is pending in `nsisc` v1, `nsisc` v2 and `generic` v1. A shipped version's scoring does not
 *   change, and `scoreMeet` does not score a pending setting.
 * `tests/engineBuiltinVersions.test.ts` pins all three: the frozen hash, the version 2 view and the version 3 view.
 */
export interface RuleBuiltin extends Builtin<RulePreset> {
  /**
   * The version 1 shaped body of the values (no `ties`, no `relayOverCap`). For `nsisc` v1, `nsisc` v2 and
   * `generic` v1 it is the payload as first shipped, and its sha256 is the pin that was set before the ties
   * setting. For `nsisc` v3 it is v2's body. For `nsisc` v4 it is its own body, which never shipped as payload
   * version 1.
   */
  readonly frozen: RulePresetV1;
}

const TIES_PENDING_NSISC_V1 =
  'NSISC v1 predates the ties setting, and its points are still pending. The user stated "Ties split" with the confirmed points in v2 (README R45).';
const TIES_PENDING_GENERIC =
  'No source states a tie rule for the generic NCAA championship tables. Rule 7 as archived has none, and the user has not stated one.';
const TIES_BLOCKS = ['requireComplete', 'scoreMeet'] as const;

const RELAY_OVER_CAP_PENDING =
  'This version shipped before the relayOverCap setting existed, and its scoring is unchanged. The user stated the treatment of a relay over the scoring-relay limit in README R67 (plans/2026-10-25/README.md:91); NSISC v3 holds it. Set it here only in a new version.';
const RELAY_OVER_CAP_PENDING_GENERIC =
  'No source states what happens to a relay over the scoring-relay limit for the generic NCAA championship tables. README R67 (plans/2026-10-25/README.md:91) is the user\'s statement for NSISC (see NSISC v3), and the user has not stated one for these tables.';

function tiesOf(frozen: RulePresetV1, tie: Setting<TieRule>, relayOverCap: Setting<RelayOverCapRule>): RulePreset {
  return migrateRulePresetV2(migrateRulePresetV1(frozen, tie), relayOverCap);
}

const NSISC_V2_TIES: Setting<TieRule> = setting(
  'split',
  recorded('2026-10-26', 'plans/2026-10-25/README.md:69', 'Ties split.')
);

/**
 * README R67, line 91: "A relay entered beyond the scoring-relay limit is tagged exhibition." The user's own
 * words are not in the repo, so this cites the row that paraphrases them. `tests/engineBuiltinVersions.test.ts`
 * checks that the line holds this wording. Read as "removed from the places like an exhibition entry"
 * (D2-ENGINE-API.md section 9, P3.relay-overcap).
 */
const NSISC_V3_RELAY_OVER_CAP: Setting<RelayOverCapRule> = setting(
  'exhibition',
  recorded('2026-10-27', 'plans/2026-10-25/README.md:91', 'A relay entered beyond the scoring-relay limit is tagged exhibition.')
);

/**
 * README R42, line 59: "NSISC has no non-scoring relays: a team enters only relays that score. For NSISC a 3rd relay is
 * an entry violation." `false` reports a relay beyond `scorers.scoringRelaysPerTeamPerEvent` (D2 section 9, item 23).
 */
const NSISC_V5_NON_SCORING_RELAYS: Setting<boolean> = setting(
  false,
  readmeRow('59', 'NSISC has no non-scoring relays: a team enters only relays that score.')
);

/**
 * NCAA Rule 5-7-1-g, text lines 2886-2887 of the archived rule book: "In a timed final of a relay, a swimmer is limited to
 * participating in only one of the team's relays (i.e., A relay or B relay, etc.)." The rule is about a timed final, and
 * the model has no rounds, so the engine checks every relay event (D2 section 9, item 23).
 */
const GENERIC_V2_RELAY_ONCE: Setting<boolean> = setting(true, NCAA_RULEBOOK_5_7_1_G);

function builtin(
  id: string,
  version: number,
  label: string,
  frozen: RulePresetV1,
  tie: Setting<TieRule>,
  relayOverCap: Setting<RelayOverCapRule>,
  relayEntryRules: RelayEntryRules = {}
): RuleBuiltin {
  const base = tiesOf(frozen, tie, relayOverCap);
  // `frozen` is the version 1 body and holds neither relay entry rule: a key is added to `preset` only when named.
  return { id, version, label, frozen, preset: { ...base, entries: { ...base.entries, ...relayEntryRules } } };
}

/** `'nsisc'` v1 to v5, plus `'generic'` v1 and v2. */
export const BUILTIN_RULE_PRESETS: readonly RuleBuiltin[] = [
  builtin('nsisc', 1, 'NSISC', buildNsisc(), pending(TIES_PENDING_NSISC_V1, TIES_BLOCKS), pending(RELAY_OVER_CAP_PENDING, TIES_BLOCKS)),
  builtin('nsisc', 2, 'NSISC', buildNsiscV2(), NSISC_V2_TIES, pending(RELAY_OVER_CAP_PENDING, TIES_BLOCKS)),
  builtin('nsisc', 3, 'NSISC', buildNsiscV2(), NSISC_V2_TIES, NSISC_V3_RELAY_OVER_CAP),
  builtin('nsisc', 4, 'NSISC', buildNsiscV4(), NSISC_V2_TIES, NSISC_V3_RELAY_OVER_CAP),
  builtin('nsisc', 5, 'NSISC', buildNsiscV4(), NSISC_V2_TIES, NSISC_V3_RELAY_OVER_CAP, { nonScoringRelaysAllowed: NSISC_V5_NON_SCORING_RELAYS }),
  builtin('generic', 1, 'Generic NCAA championship', buildGeneric(), pending(TIES_PENDING_GENERIC, TIES_BLOCKS), pending(RELAY_OVER_CAP_PENDING_GENERIC, TIES_BLOCKS)),
  builtin(
    'generic',
    2,
    'Generic NCAA championship',
    buildGeneric(),
    pending(TIES_PENDING_GENERIC, TIES_BLOCKS),
    pending(RELAY_OVER_CAP_PENDING_GENERIC, TIES_BLOCKS),
    { relaySwimmerOncePerEvent: GENERIC_V2_RELAY_ONCE }
  ),
];

/** The built-in with this id and version, or `undefined`. Never a fallback to another id or version. */
export function builtinRulePreset(id: string, version: number): RulePreset | undefined {
  return BUILTIN_RULE_PRESETS.find(b => b.id === id && b.version === version)?.preset;
}
