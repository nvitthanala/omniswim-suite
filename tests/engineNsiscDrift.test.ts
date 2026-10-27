/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * NSISC drift (plans/2026-10-25/D2-ENGINE-API.md, section 4, "Drift test").
 *
 * Every `set` field of the built-in NSISC preset, mapped through the legacy bridge, must equal the
 * legacy `NSISC_PRESET_SETTINGS`, except four known differences. Each one is a place where the
 * user's rule and the legacy scorer disagree today, until P3 changes the legacy behavior on purpose,
 * with a failing test first, and updates the goldens:
 *
 *   entries.maxTotalPerSwimmer        8 against 7 (the legacy NSISC total)
 *   scoring.nonScorerPlacement        'removed-from-consideration' against holds place (F18)
 *   scorers.relayLegsMustBeScorers    true against not checked (F19)
 *   scorers.autoRules.splitTimedFinalMarksScorer   true against no such rule (R40)
 *
 * `abFinalsScorersOnly` and `cFinal` have no legacy field and stay outside the comparison.
 * `scorers.relayOverCap` has no legacy field either, but the legacy scorer always holds an over-cap relay's
 * place. The test-only completion of nsisc v1 states 'holds-place', which is legacy, so it adds no difference.
 * nsisc v3 states 'exhibition' (README R67), a fifth difference that has its own test.
 * A pending field drops out. When a pending field becomes `set`, the comparator for it applies.
 */
import { describe, expect, it } from 'vitest';

import { builtinRulePreset, requireComplete } from '@omniswim/engine';
import type { EngineScorerAutoRules, RulePreset, Setting } from '@omniswim/engine';
import { toLegacyScoringSettings } from '@omniswim/engine/rules/legacyBridge';
import { NSISC_PRESET_SETTINGS, entryCapPolicy, relayLegsAllowTimeTrials } from '@omniswim/engine/lib/scoringDefaults';
import type { ScoringSettings } from '@omniswim/engine/types';
import { nsiscWithTestPoints, set } from './engineTestPresets';

/** What legacy does today for the three behavior-only fields. Named so the exceptions are explicit. */
const LEGACY_NON_SCORER_PLACEMENT = 'holds-place'; // F18: individualScoring.ts:597-602
const LEGACY_RELAY_LEGS_MUST_BE_SCORERS = false; // F19: scorerRoster.ts:322 does not check legs
const LEGACY_SPLIT_TIMED_FINAL_MARKS_SCORER = false; // R40: no such field
const LEGACY_RELAY_OVER_CAP = 'holds-place'; // relayScoring.ts zeroes the relay and keeps its place (R67)

const EXPECTED_DIFFERENCES = [
  'entries.maxTotalPerSwimmer',
  'scoring.nonScorerPlacement',
  'scorers.autoRules.splitTimedFinalMarksScorer',
  'scorers.relayLegsMustBeScorers',
];

/** The legacy sentinel read as a cap: 999 or more is unlimited. */
const legacyCap = (n: number | undefined): number | 'unlimited' | undefined =>
  n === undefined ? undefined : n >= 999 ? 'unlimited' : n;

type Pair = { readonly bridged: unknown; readonly legacy: unknown };
type Comparator = (bridged: ScoringSettings, legacy: ScoringSettings, preset: RulePreset) => Pair;

const same = (key: keyof ScoringSettings): Comparator => (b, l) => ({ bridged: b[key], legacy: l[key] });

/** One comparator per path. A path with no legacy field is in EXCLUDED. */
const COMPARATORS: Readonly<Record<string, Comparator>> = {
  'scoring.individualPoints': same('scoringPoints'),
  'scoring.relayPoints': (b, l) => ({
    bridged: [b.relayMultiplier, b.relayPoints],
    legacy: [l.relayMultiplier, l.relayPoints],
  }),
  // Legacy has no diving table: diving scores with the individual table (no `divingPoints` key).
  'scoring.divingPoints': (b, l) => ({ bridged: b.divingPoints, legacy: l.divingPoints }),
  'scoring.halfRateRelaySwimmer': same('halfRateRelaySwimmer'),
  'scoring.aFinalBracketSize': same('aFinalBracketSize'),
  'scoring.nonScorerPlacement': (_b, _l, p) => ({
    bridged: (p.scoring.nonScorerPlacement as Extract<Setting<string>, { state: 'set' }>).value,
    legacy: LEGACY_NON_SCORER_PLACEMENT,
  }),
  // The legacy scorer has no tie field: it always splits a tie. `'split'` is that behavior.
  'scoring.ties': (_b, _l, p) => ({
    bridged: (p.scoring.ties as Extract<Setting<string>, { state: 'set' }>).value,
    legacy: 'split',
  }),
  'scorers.eligibility': same('scorerEligibilityMode'),
  'scorers.autoRules.abFinalTiers': (b, l) => ({ bridged: b.scorerAutoRules?.abFinalTiers, legacy: l.scorerAutoRules?.abFinalTiers }),
  'scorers.autoRules.includeRelayLegsInFinals': (b, l) => ({
    bridged: b.scorerAutoRules?.includeRelayLegsInFinals,
    legacy: l.scorerAutoRules?.includeRelayLegsInFinals,
  }),
  'scorers.autoRules.distanceFinalRequired': (b, l) => ({
    bridged: b.scorerAutoRules?.distanceFinalRequired,
    legacy: l.scorerAutoRules?.distanceFinalRequired,
  }),
  'scorers.autoRules.distanceEventPattern': (b, l) => ({
    bridged: b.scorerAutoRules?.distanceEventPattern,
    legacy: l.scorerAutoRules?.distanceEventPattern,
  }),
  'scorers.autoRules.splitTimedFinalMarksScorer': (_b, _l, p) => ({
    bridged: ((p.scorers.autoRules as Extract<Setting<EngineScorerAutoRules | null>, { state: 'set' }>).value as EngineScorerAutoRules)
      .splitTimedFinalMarksScorer,
    legacy: LEGACY_SPLIT_TIMED_FINAL_MARKS_SCORER,
  }),
  'scorers.scoringTeamSize': (b, l) => ({ bridged: legacyCap(b.maxIndividualScorersPerTeam), legacy: legacyCap(l.maxIndividualScorersPerTeam) }),
  'scorers.scoringTeamScope': same('scorerCapScope'),
  'scorers.diverWeight': same('diverScorerWeight'),
  // Unlimited writes no key; legacy NSISC has none either.
  'scorers.perEventScorerCap': (b, l) => ({
    bridged: [b.maxIndividualScorersPerTeamPerEvent, b.overCapPlaceBehavior],
    legacy: [l.maxIndividualScorersPerTeamPerEvent, l.overCapPlaceBehavior],
  }),
  'scorers.divingPerEventScorerCap': (b, l) => ({ bridged: b.divingMaxScorersPerTeamPerEvent, legacy: l.divingMaxScorersPerTeamPerEvent }),
  'scorers.scoringRelaysPerTeamPerEvent': (b, l) => ({ bridged: legacyCap(b.maxRelaysScoringPerTeam), legacy: legacyCap(l.maxRelaysScoringPerTeam) }),
  // The legacy scorer holds an over-cap relay's place (relayScoring.ts) and has no field for the treatment.
  'scorers.relayOverCap': (_b, _l, p) => ({
    bridged: (p.scorers.relayOverCap as Extract<Setting<string>, { state: 'set' }>).value,
    legacy: LEGACY_RELAY_OVER_CAP,
  }),
  'scorers.relayEligibleFromScorerPool': same('relayEligibleFromScorerPool'),
  'scorers.relayLegsMustBeScorers': (_b, _l, p) => ({
    bridged: (p.scorers.relayLegsMustBeScorers as Extract<Setting<boolean>, { state: 'set' }>).value,
    legacy: LEGACY_RELAY_LEGS_MUST_BE_SCORERS,
  }),
  'entries.maxIndividualPerSwimmer': (b, l) => ({
    bridged: legacyCap(b.maxIndividualEntriesPerSwimmer),
    legacy: legacyCap(l.maxIndividualEntriesPerSwimmer),
  }),
  'entries.maxRelayPerSwimmer': (b, l) => ({ bridged: legacyCap(b.maxRelayEntriesPerSwimmer), legacy: legacyCap(l.maxRelayEntriesPerSwimmer) }),
  'entries.maxTotalPerSwimmer': (b, l) => ({ bridged: legacyCap(b.maxTotalEntriesPerSwimmer), legacy: legacyCap(l.maxTotalEntriesPerSwimmer) }),
  // Absent in legacy NSISC means the written default, so both sides go through the legacy readers.
  'entries.timeTrialsCount': (b, l) => ({ bridged: entryCapPolicy(b).countsTimeTrials, legacy: entryCapPolicy(l).countsTimeTrials }),
  'entries.exhibitionCounts': (b, l) => ({ bridged: entryCapPolicy(b).countsExhibition, legacy: entryCapPolicy(l).countsExhibition }),
  'entries.relayLegsAllowTimeTrials': (b, l) => ({ bridged: relayLegsAllowTimeTrials(b), legacy: relayLegsAllowTimeTrials(l) }),
};

/** No legacy field. */
const EXCLUDED = ['scoring.abFinalsScorersOnly', 'scoring.cFinal'];

/** Every setting path of a preset, with `scorers.autoRules` expanded to its keys. */
function settingPaths(p: RulePreset): string[] {
  const out: string[] = [];
  for (const section of ['scoring', 'scorers', 'entries'] as const) {
    for (const key of Object.keys(p[section])) {
      const path = `${section}.${key}`;
      if (path === 'scorers.autoRules') {
        const rules = p.scorers.autoRules;
        if (rules.state === 'set' && rules.value !== null) {
          for (const k of Object.keys(rules.value)) out.push(`${path}.${k}`);
        } else {
          out.push(path);
        }
      } else {
        out.push(path);
      }
    }
  }
  return out.sort();
}

function settingOf(p: RulePreset, path: string): Setting<unknown> {
  const [section, key] = path.split('.') as ['scoring' | 'scorers' | 'entries', string];
  return (p[section] as Readonly<Record<string, Setting<unknown>>>)[key] as Setting<unknown>;
}

/** The paths where the bridged preset and legacy NSISC settings disagree. */
function differences(preset: RulePreset): string[] {
  const bridged = toLegacyScoringSettings(requireComplete(preset));
  const out: string[] = [];
  for (const path of settingPaths(preset)) {
    if (EXCLUDED.includes(path)) continue;
    // `scorers.autoRules.<key>` follows the state of `scorers.autoRules`.
    const owner = path.startsWith('scorers.autoRules.') ? 'scorers.autoRules' : path;
    if (settingOf(preset, owner).state !== 'set') continue;
    const comparator = COMPARATORS[path];
    if (!comparator) throw new Error(`no comparator for ${path}`);
    const { bridged: b, legacy: l } = comparator(bridged, NSISC_PRESET_SETTINGS, preset);
    try {
      expect(b).toStrictEqual(l);
    } catch {
      out.push(path);
    }
  }
  return out.sort();
}

describe('NSISC built-in against the legacy NSISC settings', () => {
  it('has a comparator or an exclusion for every setting path, and no extra', () => {
    const paths = settingPaths(nsiscWithTestPoints());
    expect(paths.filter(p => !COMPARATORS[p] && !EXCLUDED.includes(p))).toStrictEqual([]);
    const known = new Set(paths);
    expect(Object.keys(COMPARATORS).filter(p => !known.has(p))).toStrictEqual([]);
    expect(EXCLUDED.filter(p => !known.has(p))).toStrictEqual([]);
  });

  it('differs in exactly the four known places', () => {
    expect(differences(nsiscWithTestPoints())).toStrictEqual([...EXPECTED_DIFFERENCES].sort());
  });

  it("nsisc v3 adds one difference to nsisc v2: the user's 'exhibition' against legacy's held place (R67)", () => {
    // v2 and v3 share every value but relayOverCap. v2's own points differ from the legacy shape (an explicit
    // relay table against a multiplier); that is not new here. v2 gets the legacy 'holds-place' to be complete.
    const v2 = builtinRulePreset('nsisc', 2)!;
    const v2Complete: RulePreset = { ...v2, scorers: { ...v2.scorers, relayOverCap: set('holds-place' as const) } };
    const v3 = builtinRulePreset('nsisc', 3)!;
    expect(differences(v2Complete)).not.toContain('scorers.relayOverCap');
    expect(differences(v3)).toStrictEqual([...differences(v2Complete), 'scorers.relayOverCap'].sort());
  });

  it('is complete once the test-only points are filled', () => {
    expect(() => requireComplete(nsiscWithTestPoints())).not.toThrow();
  });

  it('a change to one set field shows up as a fifth difference', () => {
    const base = nsiscWithTestPoints();
    const changes: [string, RulePreset][] = [
      ['scorers.scoringTeamSize', { ...base, scorers: { ...base.scorers, scoringTeamSize: set(17) } }],
      ['scoring.aFinalBracketSize', { ...base, scoring: { ...base.scoring, aFinalBracketSize: set(6) } }],
      ['scorers.scoringRelaysPerTeamPerEvent', { ...base, scorers: { ...base.scorers, scoringRelaysPerTeamPerEvent: set(3) } }],
      ['entries.maxIndividualPerSwimmer', { ...base, entries: { ...base.entries, maxIndividualPerSwimmer: set(5) } }],
      ['entries.timeTrialsCount', { ...base, entries: { ...base.entries, timeTrialsCount: set(true) } }],
      ['entries.relayLegsAllowTimeTrials', { ...base, entries: { ...base.entries, relayLegsAllowTimeTrials: set(true) } }],
      [
        'scorers.perEventScorerCap',
        {
          ...base,
          // A numeric per-event cap cannot sit beside the NSISC meet-wide pool: the legacy scorer
          // refuses it, and so does the bridge. This case moves the pool to per-event scope too,
          // which is a second difference.
          scorers: { ...base.scorers, scoringTeamScope: set('event' as const), perEventScorerCap: set({ cap: 4, overCap: 'holds-place' as const }) },
        },
      ],
    ];
    const alsoDiffers: Record<string, string[]> = { 'scorers.perEventScorerCap': ['scorers.scoringTeamScope'] };
    for (const [path, changed] of changes) {
      expect(differences(changed), path).toStrictEqual([...EXPECTED_DIFFERENCES, path, ...(alsoDiffers[path] ?? [])].sort());
    }
  });

  it('the shipped NSISC preset pins the four values that differ', () => {
    const p = nsiscWithTestPoints();
    const value = (path: string) => (settingOf(p, path) as Extract<Setting<unknown>, { state: 'set' }>).value;
    expect(value('entries.maxTotalPerSwimmer')).toBe(8);
    expect(NSISC_PRESET_SETTINGS.maxTotalEntriesPerSwimmer).toBe(7);
    expect(value('scoring.nonScorerPlacement')).toBe('removed-from-consideration');
    expect(value('scorers.relayLegsMustBeScorers')).toBe(true);
    expect((value('scorers.autoRules') as EngineScorerAutoRules).splitTimedFinalMarksScorer).toBe(true);
  });
});
