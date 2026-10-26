/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Legacy bridge (plans/2026-10-25/D2-ENGINE-API.md, 3.5).
 *
 * The fixed point: `mergeScoringSettings(toLegacyScoringSettings(P))` deep-equals the bridge output.
 * If it fails, the legacy merge changed something the preset did not ask for (a roster flip, a
 * PDF-column sniff, the NSISC conference lock).
 */
import { describe, expect, it } from 'vitest';

import { RulePresetError, requireComplete } from '@omniswim/engine';
import type {
  Cap,
  CompleteRulePreset,
  DivingPerEventScorerCap,
  DivingPointRule,
  EngineScorerAutoRules,
  PerEventScorerCap,
  RelayPointRule,
  RulePreset,
  Setting,
} from '@omniswim/engine';
import { LEGACY_UNLIMITED, toLegacyScoringSettings } from '@omniswim/engine/rules/legacyBridge';
import { runIndividualScoringForEvent } from '@omniswim/engine/lib/individualScoring';
import { mergeScoringSettings } from '@omniswim/engine/lib/scoringDefaults';
import { Gender } from '@omniswim/engine/types';
import type { ScoringSettings, SwimmerResult } from '@omniswim/engine/types';
import { canAcceptAnotherEntry } from '@omniswim/engine/lib/swimmerEntryLimits';
import { builtinPreset, completeNsisc, nsiscWithTestPoints, set } from './engineTestPresets';

/** A small seeded generator, so a failure names a seed and repeats. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

const CAPS: readonly Cap[] = [0, 1, 2, 7, 8, 18, 998, 'unlimited'];
const OVER: readonly ('holds-place' | 'removed-from-consideration')[] = ['holds-place', 'removed-from-consideration'];

const seen = new Set<string>();
const note = <T>(label: string, value: T): T => {
  seen.add(label);
  return value;
};

function genPoints(rng: Rng): number[] {
  const n = int(rng, 1, 20);
  return Array.from({ length: n }, () => int(rng, 0, 30));
}

function genAutoRules(rng: Rng): EngineScorerAutoRules {
  return {
    abFinalTiers: [...pick(rng, [['A'], ['A', 'B'], ['B'], []] as readonly (readonly ('A' | 'B')[])[])],
    includeRelayLegsInFinals: rng() < 0.5,
    distanceFinalRequired: rng() < 0.5,
    distanceEventPattern: pick(rng, [[], ['1000'], ['1000', '1650', '1500']]),
    splitTimedFinalMarksScorer: rng() < 0.5,
  };
}

function genPreset(rng: Rng): CompleteRulePreset {
  const relay: RelayPointRule =
    rng() < 0.5
      ? note('relay:table', { kind: 'table', points: genPoints(rng) })
      : note('relay:multiple', { kind: 'multiple-of-individual', multiplier: pick(rng, [1, 2, 3]) });
  const diving: DivingPointRule =
    rng() < 0.5 ? note('diving:same', { kind: 'same-as-individual' }) : note('diving:table', { kind: 'table', points: genPoints(rng) });
  const eligibility = pick(rng, ['roster', 'points_pool'] as const);
  note(`eligibility:${eligibility}`, 0);
  let autoRules: EngineScorerAutoRules | null;
  if (eligibility === 'roster') autoRules = note('auto:object', genAutoRules(rng));
  else autoRules = rng() < 0.5 ? note('auto:null', null) : note('auto:object', genAutoRules(rng));

  const overCap = pick(rng, OVER);
  const swimCap = pick(rng, CAPS);
  const perEvent: PerEventScorerCap =
    swimCap === 'unlimited' ? note('perEvent:unlimited', { cap: 'unlimited' }) : note('perEvent:numeric', { cap: swimCap, overCap });
  const divingKind = pick(rng, ['same', 'own-unlimited', 'own-numeric'] as const);
  let divingCap: DivingPerEventScorerCap;
  if (divingKind === 'same') divingCap = note('divingCap:same', { kind: 'same-as-swimming' });
  else if (divingKind === 'own-unlimited') divingCap = note('divingCap:own-unlimited', { kind: 'own', cap: 'unlimited' });
  else {
    const n = pick(rng, CAPS.filter((c): c is number => c !== 'unlimited'));
    // The same over-cap behavior as swimming: legacy holds only one (the conflict has its own test).
    divingCap = note('divingCap:own-numeric', { kind: 'own', cap: n, overCap });
  }

  const capOf = (label: string): Cap => {
    const c = pick(rng, CAPS);
    note(`cap:${String(c)}`, 0);
    note(`${label}:${c === 'unlimited' ? 'unlimited' : 'numeric'}`, 0);
    return c;
  };

  const base = builtinPreset('nsisc');
  const preset: RulePreset = {
    payloadVersion: 2,
    scoring: {
      ties: set('split' as const),
      individualPoints: set(genPoints(rng)),
      relayPoints: set(relay),
      divingPoints: set(diving),
      halfRateRelaySwimmer: set(rng() < 0.5),
      aFinalBracketSize: set(int(rng, 1, 16)),
      nonScorerPlacement: set(pick(rng, OVER)),
      abFinalsScorersOnly: set(rng() < 0.5),
      cFinal: set(rng() < 0.5 ? { kind: 'none' as const } : { kind: 'non-scorers' as const, size: int(rng, 1, 16) }),
    },
    scorers: {
      eligibility: set(eligibility),
      autoRules: set(autoRules),
      scoringTeamSize: set(capOf('teamSize')),
      scoringTeamScope: set(pick(rng, ['meet', 'event'] as const)),
      diverWeight: set({ numerator: 1, denominator: int(rng, 1, 6) }),
      perEventScorerCap: set(perEvent),
      divingPerEventScorerCap: set(divingCap),
      scoringRelaysPerTeamPerEvent: set(capOf('relaysPerEvent')),
      relayEligibleFromScorerPool: eligibility === 'roster' ? base.scorers.relayEligibleFromScorerPool : set(rng() < 0.5),
      relayLegsMustBeScorers: set(rng() < 0.5),
    },
    entries: {
      maxIndividualPerSwimmer: set(capOf('maxInd')),
      maxRelayPerSwimmer: set(capOf('maxRelay')),
      maxTotalPerSwimmer: set(capOf('maxTotal')),
      timeTrialsCount: set(rng() < 0.5),
      exhibitionCounts: set(rng() < 0.5),
      relayLegsAllowTimeTrials: set(rng() < 0.5),
    },
  };
  return requireComplete(preset);
}

/** One swim and one dive, each a lone winner for team T1, through the legacy individual scorer. */
function scoreSwimAndDive(bridged: ScoringSettings): void {
  const merged = mergeScoringSettings(bridged);
  const useMeetWidePool = merged.scorerCapScope === 'meet';
  const row = (event: string, time: string): SwimmerResult =>
    ({
      id: `A|${event}`,
      name: 'A',
      team: 'T1',
      rank: 1,
      time,
      finalsTime: time,
      classYear: 'JR',
      event,
      roundSwam: 'A Final',
      points: 0,
      gender: Gender.MEN,
    }) as SwimmerResult;
  runIndividualScoringForEvent([row('Event 3 Men 100 Yard Freestyle', '45.00')], merged, new Map(), useMeetWidePool, undefined);
  runIndividualScoringForEvent([row('Event 5 Men 1 Meter Diving', '350.00')], merged, new Map(), useMeetWidePool, undefined);
}

/** The bridge result, or the refusal. Any other error is a defect and propagates. */
function tryBridge(preset: CompleteRulePreset): { bridged: ScoringSettings } | { refused: RulePresetError } {
  try {
    return { bridged: toLegacyScoringSettings(preset) };
  } catch (e) {
    if (e instanceof RulePresetError && e.code === 'invalid') return { refused: e };
    throw e;
  }
}

/** The refusal rule, written without the bridge: a per-event cap below 1, or one beside a meet-wide pool. */
function expectRefused(preset: CompleteRulePreset): boolean {
  const value = <T>(s: Setting<T>): T => (s as Extract<Setting<T>, { state: 'set' }>).value;
  const swimming = value(preset.scorers.perEventScorerCap);
  const diving = value(preset.scorers.divingPerEventScorerCap);
  const swimNumeric = swimming.cap !== 'unlimited';
  const divingWritten = diving.kind === 'own' && (diving.cap !== 'unlimited' || swimNumeric);
  const zero =
    (swimming.cap !== 'unlimited' && swimming.cap < 1) ||
    (diving.kind === 'own' && diving.cap !== 'unlimited' && diving.cap < 1);
  const pool = value(preset.scorers.scoringTeamScope) === 'meet' && value(preset.scorers.scoringTeamSize) !== 'unlimited';
  return zero || ((swimNumeric || divingWritten) && pool);
}

describe('settings the legacy scorer accepts at score time', () => {
  const withCaps = (
    perEvent: PerEventScorerCap,
    diving: DivingPerEventScorerCap,
    teamSize: Cap,
    scope: 'meet' | 'event'
  ): CompleteRulePreset => {
    const preset = nsiscWithTestPoints();
    return requireComplete({
      ...preset,
      scorers: {
        ...preset.scorers,
        perEventScorerCap: set(perEvent),
        divingPerEventScorerCap: set(diving),
        scoringTeamSize: set(teamSize),
        scoringTeamScope: set(scope),
      },
    });
  };

  it('own unlimited diving with unlimited swimming and an 18-scorer meet pool scores a swim and a dive', () => {
    const bridged = toLegacyScoringSettings(withCaps({ cap: 'unlimited' }, { kind: 'own', cap: 'unlimited' }, 18, 'meet'));
    expect(bridged).not.toHaveProperty('divingMaxScorersPerTeamPerEvent');
    expect(() => scoreSwimAndDive(bridged)).not.toThrow();
  });

  it('refuses a per-event cap of 0, for swimming and for diving, with the path', () => {
    for (const [perEvent, diving, path] of [
      [{ cap: 0, overCap: 'holds-place' as const }, { kind: 'same-as-swimming' as const }, 'scorers.perEventScorerCap'],
      [{ cap: 'unlimited' as const }, { kind: 'own' as const, cap: 0, overCap: 'holds-place' as const }, 'scorers.divingPerEventScorerCap'],
    ] as const) {
      const refused = tryBridge(withCaps(perEvent, diving, 'unlimited', 'event'));
      expect('refused' in refused, path).toBe(true);
      if ('refused' in refused) {
        expect(refused.refused.code).toBe('invalid');
        expect(refused.refused.path).toBe(path);
      }
    }
  });

  it('refuses a numeric per-event cap under a meet-wide pool, with the path (the legacy scorer would throw)', () => {
    const swimming = tryBridge(withCaps({ cap: 4, overCap: 'holds-place' }, { kind: 'same-as-swimming' }, 18, 'meet'));
    expect('refused' in swimming).toBe(true);
    if ('refused' in swimming) expect(swimming.refused.path).toBe('scorers.perEventScorerCap');

    const diving = tryBridge(withCaps({ cap: 'unlimited' }, { kind: 'own', cap: 2, overCap: 'holds-place' }, 18, 'meet'));
    expect('refused' in diving).toBe(true);
    if ('refused' in diving) expect(diving.refused.path).toBe('scorers.divingPerEventScorerCap');
  });

  it('a numeric per-event cap with a per-event pool bridges and scores a swim and a dive', () => {
    for (const [perEvent, diving] of [
      [{ cap: 4, overCap: 'holds-place' as const }, { kind: 'same-as-swimming' as const }],
      [{ cap: 4, overCap: 'removed-from-consideration' as const }, { kind: 'own' as const, cap: 2, overCap: 'removed-from-consideration' as const }],
      [{ cap: 4, overCap: 'holds-place' as const }, { kind: 'own' as const, cap: 'unlimited' as const }],
      [{ cap: 'unlimited' as const }, { kind: 'own' as const, cap: 3, overCap: 'holds-place' as const }],
    ] as const) {
      for (const [teamSize, scope] of [['unlimited', 'meet'], [18, 'event'], ['unlimited', 'event']] as const) {
        const bridged = toLegacyScoringSettings(withCaps(perEvent, diving, teamSize, scope));
        expect(() => scoreSwimAndDive(bridged), JSON.stringify([perEvent, diving, teamSize, scope])).not.toThrow();
        expect(mergeScoringSettings(bridged)).toStrictEqual(bridged);
      }
    }
  });

  it('own unlimited diving beside a numeric swimming cap exempts dives with 999', () => {
    const bridged = toLegacyScoringSettings(withCaps({ cap: 4, overCap: 'holds-place' }, { kind: 'own', cap: 'unlimited' }, 'unlimited', 'event'));
    expect(bridged.maxIndividualScorersPerTeamPerEvent).toBe(4);
    expect(bridged.divingMaxScorersPerTeamPerEvent).toBe(LEGACY_UNLIMITED);
    expect(() => scoreSwimAndDive(bridged)).not.toThrow();
  });
});

describe('fixed point: merge(bridge(P)) equals bridge(P)', () => {
  it('holds for the shipped NSISC preset with test-only points', () => {
    const bridged = toLegacyScoringSettings(completeNsisc());
    expect(mergeScoringSettings(bridged)).toStrictEqual(bridged);
  });

  it('holds for 200 generated presets, which together reach every branch', () => {
    const rng = mulberry32(20261025);
    let refusedCount = 0;
    let scoredCount = 0;
    for (let i = 0; i < 200; i++) {
      const preset = genPreset(rng);
      const result = tryBridge(preset);
      if ('refused' in result) {
        // Refused only for a reason the scorer would also refuse: a cap below 1, or a per-event cap
        // beside a meet-wide pool.
        expect(expectRefused(preset), `preset ${i}: ${result.refused.message}`).toBe(true);
        refusedCount++;
        continue;
      }
      expect(expectRefused(preset), `preset ${i} bridged but the scorer would refuse it`).toBe(false);
      expect(mergeScoringSettings(result.bridged), `preset ${i}`).toStrictEqual(result.bridged);
      expect(() => scoreSwimAndDive(result.bridged), `preset ${i} scores`).not.toThrow();
      scoredCount++;
    }
    expect(refusedCount).toBeGreaterThan(0);
    expect(scoredCount).toBeGreaterThan(50);
    for (const label of [
      'relay:table',
      'relay:multiple',
      'diving:same',
      'diving:table',
      'eligibility:roster',
      'eligibility:points_pool',
      'auto:object',
      'auto:null',
      'perEvent:unlimited',
      'perEvent:numeric',
      'divingCap:same',
      'divingCap:own-unlimited',
      'divingCap:own-numeric',
      'cap:0',
      'cap:1',
      'cap:998',
      'cap:unlimited',
      'maxTotal:unlimited',
      'maxTotal:numeric',
      'teamSize:unlimited',
      'teamSize:numeric',
    ]) {
      expect(seen.has(label), `the generator never reached ${label}`).toBe(true);
    }
  });

  it('never writes a key with the value undefined', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const result = tryBridge(genPreset(rng));
      if ('refused' in result) continue;
      for (const [key, value] of Object.entries(result.bridged)) expect(value, key).not.toBeUndefined();
    }
  });
});

describe('bridge content', () => {
  it('writes the 999 sentinel for unlimited and nowhere else', () => {
    const preset = completeNsisc();
    const bridged = toLegacyScoringSettings(preset);
    expect(LEGACY_UNLIMITED).toBe(999);
    expect(bridged.maxIndividualEntriesPerSwimmer).toBe(999);
    expect(bridged.maxRelayEntriesPerSwimmer).toBe(999);
    expect(bridged.maxTotalEntriesPerSwimmer).toBe(8);
    expect(bridged.maxIndividualScorersPerTeam).toBe(18);
  });

  it('writes an explicit eligibility mode and turns the PDF column sniff off', () => {
    const bridged = toLegacyScoringSettings(completeNsisc());
    expect(bridged.scorerEligibilityMode).toBe('roster');
    expect(bridged.usePdfPlacePoints).toBe(false);
    expect(bridged.diverEventPattern).toStrictEqual(['DIVING', 'DIVE']);
  });

  it('writes all twelve generic keys', () => {
    const bridged = toLegacyScoringSettings(completeNsisc());
    for (const key of [
      'scoringPoints',
      'relayMultiplier',
      'halfRateRelaySwimmer',
      'maxIndividualScorersPerTeam',
      'maxRelaysScoringPerTeam',
      'aFinalBracketSize',
      'scorerCapScope',
      'diverScorerWeight',
      'relayEligibleFromScorerPool',
      'diverEventPattern',
      'maxIndividualEntriesPerSwimmer',
      'maxRelayEntriesPerSwimmer',
    ]) {
      expect(bridged, key).toHaveProperty(key);
    }
  });

  it('drops splitTimedFinalMarksScorer, which legacy has no field for', () => {
    const bridged = toLegacyScoringSettings(completeNsisc());
    expect(bridged.scorerAutoRules).toStrictEqual({
      abFinalTiers: ['A', 'B'],
      includeRelayLegsInFinals: true,
      distanceFinalRequired: true,
      distanceEventPattern: ['1000', '1650', '1500'],
    });
  });

  it('emits relayEligibleFromScorerPool false under roster, where the preset keeps it pending', () => {
    const preset = nsiscWithTestPoints();
    expect(preset.scorers.relayEligibleFromScorerPool.state).toBe('pending');
    expect(toLegacyScoringSettings(requireComplete(preset)).relayEligibleFromScorerPool).toBe(false);
  });

  it('refuses a points_pool preset that leaves relayEligibleFromScorerPool pending', () => {
    const preset = nsiscWithTestPoints();
    const poolPreset: RulePreset = {
      ...preset,
      scorers: { ...preset.scorers, eligibility: set('points_pool' as const), relayLegsMustBeScorers: set(true) },
    };
    expect(() => requireComplete(poolPreset)).toThrow(RulePresetError);
  });

  it('refuses roster with null auto rules', () => {
    const preset = nsiscWithTestPoints();
    const broken = requireComplete({ ...preset, scorers: { ...preset.scorers, autoRules: set(null) } });
    expect(() => toLegacyScoringSettings(broken)).toThrow(RulePresetError);
  });

  it('refuses auto rules with a missing key instead of filling one', () => {
    const preset = nsiscWithTestPoints();
    const rules = (preset.scorers.autoRules as Extract<Setting<EngineScorerAutoRules | null>, { state: 'set' }>).value as EngineScorerAutoRules;
    for (const key of ['abFinalTiers', 'includeRelayLegsInFinals', 'distanceFinalRequired', 'distanceEventPattern'] as const) {
      const { [key]: _removed, ...partial } = rules;
      const incomplete = requireComplete({ ...preset, scorers: { ...preset.scorers, autoRules: set(partial as EngineScorerAutoRules) } });
      try {
        toLegacyScoringSettings(incomplete);
      } catch (e) {
        expect(e, key).toBeInstanceOf(RulePresetError);
        expect((e as RulePresetError).code, key).toBe('invalid');
        expect((e as RulePresetError).path, key).toBe('scorers.autoRules');
        continue;
      }
      throw new Error(`expected the bridge to refuse auto rules without ${key}`);
    }
  });

  it('refuses numeric swimming and diving caps with different over-cap behavior', () => {
    const preset = nsiscWithTestPoints();
    const conflict = requireComplete({
      ...preset,
      scorers: {
        ...preset.scorers,
        scoringTeamScope: set('event' as const),
        perEventScorerCap: set({ cap: 3, overCap: 'holds-place' as const }),
        divingPerEventScorerCap: set({ kind: 'own' as const, cap: 2, overCap: 'removed-from-consideration' as const }),
      },
    });
    try {
      toLegacyScoringSettings(conflict);
    } catch (e) {
      expect(e).toBeInstanceOf(RulePresetError);
      expect((e as RulePresetError).code).toBe('invalid');
      expect((e as RulePresetError).path).toBe('scorers.divingPerEventScorerCap');
      return;
    }
    throw new Error('expected the bridge to throw');
  });

  it('writes the numeric caps and their over-cap behavior', () => {
    const preset = nsiscWithTestPoints();
    const capped = requireComplete({
      ...preset,
      scorers: {
        ...preset.scorers,
        scoringTeamScope: set('event' as const),
        perEventScorerCap: set({ cap: 3, overCap: 'removed-from-consideration' as const }),
        divingPerEventScorerCap: set({ kind: 'own' as const, cap: 2, overCap: 'removed-from-consideration' as const }),
      },
    });
    const bridged = toLegacyScoringSettings(capped);
    expect(bridged.maxIndividualScorersPerTeamPerEvent).toBe(3);
    expect(bridged.divingMaxScorersPerTeamPerEvent).toBe(2);
    expect(bridged.overCapPlaceBehavior).toBe('removed-from-consideration');
  });
});

describe('the 8-entry total (NSISC shape, no conference passed)', () => {
  const counts = (total: number) => ({
    individual: Math.min(total, 4),
    relayEvents: new Set<string>(),
    relayCount: Math.max(total - 4, 0),
    total,
  });

  it('bridged settings allow an 8th entry', () => {
    const bridged = toLegacyScoringSettings(completeNsisc());
    expect(canAcceptAnotherEntry(counts(7), bridged, '100 Freestyle')).toBe(true);
    expect(canAcceptAnotherEntry(counts(8), bridged, '100 Freestyle')).toBe(false);
  });

  it('the legacy NSISC conference lock reads the same preset as 7', () => {
    const bridged = toLegacyScoringSettings(completeNsisc());
    const locked = mergeScoringSettings(bridged, { conference: 'NSISC' });
    expect(locked.maxTotalEntriesPerSwimmer).toBe(7);
    expect(canAcceptAnotherEntry(counts(7), locked, '100 Freestyle')).toBe(false);
  });
});
