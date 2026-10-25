/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `arbitrage/relayLegSwaps.ts` (plan item T6).
 * Each case kills Stryker mutants that survived the suite as it stood on
 * 2026-10-14 (see docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Fixture, hand-derived. Men's 4x50 free relay, three teams, one final, scored
 * by the place each relay holds in the meet (a relay place is worth twice an
 * individual place: 1st 40, 2nd 34, 3rd 32):
 *
 *   1st  Rival   1:39.50
 *   2nd  HSU     1:40.00  (four legs of 25.00: Ann, Bea, Cy, Dee)
 *   3rd  Other   1:41.00
 *
 * Roster mode, relay legs in finals NOT auto-eligible. Bea, Cy, Dee and Sam are
 * marked scorers by override. Ann Lee is deleted, so her leg is vacant. A relay
 * with a vacant leg has a leg that is no scorer, so it scores 0.
 *
 * Sam Roe (50 free, 24.00) takes the leg. Every leg is now a scorer, so the
 * relay scores its meet place, 2nd = 34. Sam's own 50 free (1st = 20) counts in
 * both totals, so base 20, new 54, gain 34.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type RelayLegOverride, type ScoringSettings, type SwimmerResult } from '../../packages/core/src/types';
import {
  applyRelayLegSwap,
  rankRelayLegSwaps,
  type RelayLegSwap,
} from '../../packages/core/src/lib/arbitrage/relayLegSwaps';
import { workspaceFixture } from '../helpers/typedFixtures';

const HSU = 'HSU';
const EVENT = 'Event 2 Men 4x50 Yard Freestyle Relay';
const FREE50 = 'Event 8 Men 50 Yard Freestyle';
const NAMES = ['Ann Lee', 'Bea Fox', 'Cy Ode', 'Dee Ray'];

const SETTINGS = {
  scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  scorerEligibilityMode: 'roster',
  scorerAutoRules: { abFinalTiers: ['A', 'B'], includeRelayLegsInFinals: false },
  usePdfPlacePoints: false,
} as unknown as ScoringSettings;

const SCORER_OVERRIDES = ['Bea Fox', 'Cy Ode', 'Dee Ray', 'Sam Roe'].map(name => ({
  name,
  team: 'HSU',
  gender: Gender.MEN,
  isScorer: true,
}));

function relayEntry(team: string, rank: number, clock: string, names: string[]): SwimmerResult[] {
  return names.map(
    (name, i) =>
      ({
        id: `${team}-leg${i}`,
        rank,
        name,
        classYear: 'JR',
        team,
        time: clock,
        finalsTime: clock,
        relayTeamTime: clock,
        relayLegSplit: '25.00',
        relayLegIndex: i,
        roundSwam: 'A Final',
        points: 0,
        event: EVENT,
        isRelay: true,
        gender: Gender.MEN,
        relayNames: names.map(n => ({ name: n, year: 'JR' })),
      }) as SwimmerResult
  );
}

function swim(id: string, name: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name,
    classYear: 'FR',
    team: HSU,
    time,
    finalsTime: time,
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    ...extra,
  } as SwimmerResult;
}

const SAM = swim('sam', 'Sam Roe', FREE50, '24.00');

function baseResults(extra: SwimmerResult[] = []): SwimmerResult[] {
  return [
    ...relayEntry('Rival', 1, '1:39.50', ['R One', 'R Two', 'R Three', 'R Four']),
    ...relayEntry('Other', 3, '1:41.00', ['O One', 'O Two', 'O Three', 'O Four']),
    ...relayEntry(HSU, 2, '1:40.00', NAMES),
    ...extra,
  ];
}

function rank(results: SwimmerResult[], ws: Parameters<typeof workspaceFixture>[0] = {}, settings = SETTINGS) {
  const workspace = workspaceFixture({
    id: 'ws-leg-swaps',
    name: 'leg swaps',
    menResults: results,
    womenResults: [],
    deletedSwimmers: [{ name: 'Ann Lee', gender: Gender.MEN }],
    scorerRosterOverrides: SCORER_OVERRIDES,
    scoringSettings: settings,
    ...ws,
  });
  return rankRelayLegSwaps(workspace, { team: HSU, gender: Gender.MEN, settings });
}

describe('rankRelayLegSwaps with nothing to rank', () => {
  it("names the team and gender when the team fields no relay: men's", () => {
    const ws = workspaceFixture({ id: 'w', name: 'w', menResults: [], womenResults: [] });
    expect(rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: SETTINGS })).toEqual({
      pointsMeaningful: false,
      reason: "No men's relay entries for HSU to substitute legs on.",
      swaps: [],
      candidatesEvaluated: 0,
    });
  });

  it("names the women's pool and falls back on 'this team' for a blank team", () => {
    const ws = workspaceFixture({ id: 'w', name: 'w', menResults: baseResults(), womenResults: [] });
    expect(rankRelayLegSwaps(ws, { team: '', gender: Gender.WOMEN, settings: SETTINGS })).toEqual({
      pointsMeaningful: false,
      reason: "No women's relay entries for this team to substitute legs on.",
      swaps: [],
      candidatesEvaluated: 0,
    });
  });

  it('a relay row of another gender is not an entry', () => {
    const rows = relayEntry(HSU, 1, '1:40.00', NAMES).map(r => ({ ...r, gender: Gender.WOMEN }));
    const ws = workspaceFixture({ id: 'w', name: 'w', menResults: rows, womenResults: [] });
    const out = rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: SETTINGS });
    expect(out.pointsMeaningful).toBe(false);
  });

  it('a relay row of another team is not an entry', () => {
    const rows = relayEntry('Rival', 1, '1:40.00', NAMES);
    const ws = workspaceFixture({ id: 'w', name: 'w', menResults: rows, womenResults: [] });
    expect(rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: SETTINGS }).pointsMeaningful).toBe(false);
  });
});

describe('rankRelayLegSwaps on a deleted leg holder', () => {
  it('ranks the one swim that can take the leg, with an exact points delta', () => {
    const ranking = rank(baseResults([SAM]));
    expect(ranking.pointsMeaningful).toBe(true);
    expect(ranking.reason).toBeUndefined();
    expect(ranking.candidatesEvaluated).toBe(1);
    expect(ranking.swaps).toHaveLength(1);
    const swap = ranking.swaps[0]!;
    expect(swap).toMatchObject({
      relayEvent: EVENT,
      relayRank: 2,
      roundSwam: 'A Final',
      legIndex: 0,
      stroke: 'free',
      legDistanceYards: 50,
      outAthlete: 'Ann Lee',
      outTime: '25.00',
      inAthlete: 'Sam Roe',
      inTime: '24.00',
      clockLegTime: '25.00',
      // Sam's own 50 free (1st = 20) is in both totals: base 20, new 20 + 34.
      deltaPoints: 34,
      newTotal: 54,
      baseTotal: 20,
    });
    expect('outTimeEstimate' in swap).toBe(false);
    expect('inFromHistory' in swap).toBe(false);
    expect('inFromTimeTrial' in swap).toBe(false);
    expect(swap.inTimeConverted).toBeUndefined();
    expect(swap.inTimeStale).toBeUndefined();
    expect(swap.inTimeExtractedSplit).toBeUndefined();
  });

  it('holds the clock at the departed swimmer own 50 free when there is one', () => {
    // Ann swam the 50 free in 25.50, so that is the clock the relay holds.
    const ann = swim('ann50', 'Ann Lee', FREE50, '25.50');
    const swap = rank(baseResults([SAM, ann])).swaps[0]!;
    expect(swap.clockLegTime).toBe('25.50');
  });

  it('offers no swap for a leg whose holder is not deleted or vacated', () => {
    const ranking = rank(baseResults([SAM]), {
      deletedSwimmers: [],
      scorerRosterOverrides: [
        ...SCORER_OVERRIDES,
        { name: 'Ann Lee', team: HSU, gender: Gender.MEN, isScorer: true },
      ],
    });
    expect(ranking.pointsMeaningful).toBe(true);
    expect(ranking.swaps).toEqual([]);
    expect(ranking.candidatesEvaluated).toBe(0);
  });

  it('skips a candidate who is deleted, already on the relay, or a woman', () => {
    const extras = [
      SAM,
      swim('del', 'Del Gone', FREE50, '23.00'),
      swim('bea', 'Bea Fox', FREE50, '24.50'),
      swim('wom', 'Wen Ito', FREE50, '23.50', { gender: Gender.WOMEN }),
    ];
    const ranking = rank(baseResults(extras), {
      deletedSwimmers: [
        { name: 'Ann Lee', gender: Gender.MEN },
        { name: 'Del Gone', gender: Gender.MEN },
      ],
    });
    expect(ranking.candidatesEvaluated).toBe(1);
    expect(ranking.swaps.map(s => s.inAthlete)).toEqual(['Sam Roe']);
  });

  it('skips a swim of another team and a swim at another distance', () => {
    const extras = [
      SAM,
      swim('riv', 'Rex Out', FREE50, '23.00', { team: 'Rival' }),
      swim('hundred', 'Hal Dist', 'Event 9 Men 100 Yard Freestyle', '50.00'),
    ];
    const ranking = rank(baseResults(extras));
    expect(ranking.candidatesEvaluated).toBe(1);
    expect(ranking.swaps.map(s => s.inAthlete)).toEqual(['Sam Roe']);
  });

  it('a recruit can take the leg, with a gender-matched pool', () => {
    const ranking = rank(baseResults(), {
      scorerRosterOverrides: [
        ...SCORER_OVERRIDES,
        { name: 'Rae New', team: HSU, gender: Gender.MEN, isScorer: true },
        { name: 'Rue Wom', team: HSU, gender: Gender.WOMEN, isScorer: true },
        { name: 'Ren Away', team: HSU, gender: Gender.MEN, isScorer: true },
      ],
      recruits: [
        {
          id: 'rec1',
          name: 'Rae New',
          team: HSU,
          event: FREE50,
          time: '24.20',
          gender: Gender.MEN,
          classYear: 'FR',
          timeType: 'SCY',
        } as never,
        {
          id: 'rec2',
          name: 'Rue Wom',
          team: HSU,
          event: FREE50,
          time: '23.00',
          gender: Gender.WOMEN,
          classYear: 'FR',
          timeType: 'SCY',
        } as never,
        {
          id: 'rec3',
          name: 'Ren Away',
          team: 'Rival',
          event: FREE50,
          time: '23.00',
          gender: Gender.MEN,
          classYear: 'FR',
          timeType: 'SCY',
        } as never,
      ],
    });
    expect(ranking.swaps.map(s => [s.inAthlete, s.inTime])).toEqual([['Rae New', '24.20']]);
    expect(ranking.candidatesEvaluated).toBe(1);
  });

  it('with a roster, only a scorer is offered', () => {
    const results = baseResults([SAM, swim('tom', 'Tom Low', FREE50, '24.10', { roundSwam: 'Preliminaries' })]);
    const ranking = rank(results);
    // Sam is marked a scorer by override; Tom has no scorer flag (prelims only).
    expect(ranking.swaps.map(s => s.inAthlete)).toEqual(['Sam Roe']);
    expect(ranking.candidatesEvaluated).toBe(1);
  });

  it('refuses a candidate already at the per-swimmer relay cap, but not one on that relay event', () => {
    const capped = { ...SETTINGS, maxRelayEntriesPerSwimmer: 1 } as ScoringSettings;
    // Sam already swims the 400 free relay B; the 4x50 is a second relay event. Cap is 1: refused.
    const otherRelay = relayEntry(HSU, 4, '3:40.00', ['Sam Roe', 'X One', 'X Two', 'X Three']).map(r => ({
      ...r,
      event: 'Event 4 Men 4x100 Yard Freestyle Relay',
    }));
    const refused = rank(baseResults([SAM, ...otherRelay]), {}, capped);
    expect(refused.swaps.map(s => s.inAthlete)).not.toContain('Sam Roe');
    // With no other relay entry, the cap is not reached.
    const allowed = rank(baseResults([SAM]), {}, capped);
    expect(allowed.swaps.map(s => s.inAthlete)).toEqual(['Sam Roe']);
  });

  it('refuses a candidate at the total-entry cap even when the relay cap is open', () => {
    const capped = { ...SETTINGS, maxTotalEntriesPerSwimmer: 1 } as ScoringSettings;
    // Sam has one individual entry already (the 50 free) and the cap is 1 in total.
    const refused = rank(baseResults([SAM]), {}, capped);
    expect(refused.swaps).toEqual([]);
    expect(refused.candidatesEvaluated).toBe(0);
  });
});

describe('applyRelayLegSwap', () => {
  const swap: RelayLegSwap = {
    relayEntryKey: `${HSU}|${EVENT}|A Final|3|1:40.00`,
    relayEvent: EVENT,
    relayRank: 3,
    legIndex: 1,
    stroke: 'free',
    legDistanceYards: 50,
    outAthlete: 'Bea Fox',
    outTime: '25.00',
    inAthlete: 'Sam Roe',
    inTime: '24.00',
    clockLegTime: '25.00',
    deltaPoints: 2,
    newTotal: 34,
    baseTotal: 32,
  };
  const opts = { team: HSU, gender: Gender.MEN };

  it('upserts one override that carries the held clock and says what changed', () => {
    const ws = workspaceFixture({ id: 'w', name: 'w', relayLegOverrides: [] });
    const { patch, inverse, description } = applyRelayLegSwap(ws, swap, opts);
    expect(patch.relayLegOverrides).toEqual([
      {
        relayEntryKey: swap.relayEntryKey,
        legIndex: 1,
        assigneeName: 'Sam Roe',
        manualLegTime: '25.00',
        source: 'manual',
      },
    ]);
    expect(inverse).toEqual({ relayLegOverrides: [] });
    expect(description).toBe(`${EVENT} leg 2 (free): +Sam Roe (24.00), −Bea Fox`);
  });

  it('carries no manual leg time when the swap holds no clock', () => {
    const ws = workspaceFixture({ id: 'w', name: 'w', relayLegOverrides: [] });
    const { patch } = applyRelayLegSwap(ws, { ...swap, clockLegTime: undefined }, opts);
    const only = patch.relayLegOverrides?.[0] as RelayLegOverride;
    expect('manualLegTime' in only).toBe(false);
    expect(only.source).toBe('manual');
  });

  it('replaces the prior override of the same leg and keeps the others, and the inverse restores all', () => {
    const prior: RelayLegOverride[] = [
      { relayEntryKey: swap.relayEntryKey, legIndex: 1, assigneeName: 'Old Name', source: 'manual' },
      { relayEntryKey: swap.relayEntryKey, legIndex: 2, assigneeName: 'Keep Me', source: 'manual' },
    ];
    const ws = workspaceFixture({ id: 'w', name: 'w', relayLegOverrides: prior });
    const { patch, inverse } = applyRelayLegSwap(ws, swap, opts);
    const byLeg = [...(patch.relayLegOverrides ?? [])].sort((a, b) => a.legIndex - b.legIndex);
    expect(byLeg.map(o => [o.legIndex, o.assigneeName])).toEqual([
      [1, 'Sam Roe'],
      [2, 'Keep Me'],
    ]);
    expect(patch.relayLegOverrides).toHaveLength(2);
    expect(inverse.relayLegOverrides).toBe(prior);
    expect(prior.map(o => o.assigneeName)).toEqual(['Old Name', 'Keep Me']);
  });

  it('names a vacant or dash leg as "vacant leg"', () => {
    const ws = workspaceFixture({ id: 'w', name: 'w' });
    expect(applyRelayLegSwap(ws, { ...swap, outAthlete: '' }, opts).description).toBe(
      `${EVENT} leg 2 (free): +Sam Roe (24.00), −vacant leg`
    );
    expect(applyRelayLegSwap(ws, { ...swap, outAthlete: '—' }, opts).description).toBe(
      `${EVENT} leg 2 (free): +Sam Roe (24.00), −vacant leg`
    );
    expect(applyRelayLegSwap(ws, swap, opts).patch.relayLegOverrides).toHaveLength(1);
  });
});

describe('second pass: other relay entries of the same team do not leak into an entry', () => {
  it('rows of another event, place or round are not legs of the entry', () => {
    // HSU also fields three other relays with the same leg-0 position and a slower 29.00 split:
    // another event, the same event at another place, the same event and place in another round.
    // Each has its own swimmers, none deleted. None may change the one swap Ann Lee's leg gives.
    const other = (id: string, extra: Partial<SwimmerResult>, names: string[]) =>
      relayEntry(HSU, 2, '1:40.00', names).map(
        (r, i) => ({ ...r, id: `${id}-${i}`, relayLegSplit: '29.00', ...extra }) as SwimmerResult
      );
    const extras = [
      ...other('medley', { event: 'Event 4 Men 4x50 Yard Medley Relay' }, ['M One', 'M Two', 'M Three', 'M Four']),
      ...other('fifth', { rank: 5 }, ['F One', 'F Two', 'F Three', 'F Four']),
      ...other('prelim', { roundSwam: 'Preliminaries' }, ['P One', 'P Two', 'P Three', 'P Four']),
    ];
    const alone = rank(baseResults([SAM])).swaps;
    const crowded = rank(baseResults([SAM, ...extras])).swaps;
    const pick = (s: RelayLegSwap[]) =>
      s.filter(x => x.relayEvent === EVENT && x.relayRank === 2 && x.roundSwam === 'A Final');
    expect(pick(alone)).toHaveLength(1);
    expect(pick(crowded)).toEqual(pick(alone));
    expect(pick(crowded)[0]).toMatchObject({ outTime: '25.00', deltaPoints: 34, newTotal: 54, baseTotal: 20 });
  });
});
