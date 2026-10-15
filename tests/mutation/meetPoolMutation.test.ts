/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `meetPool.ts` (plan item T6). The meet-wide
 * scorer pool is the 18-scorer cap of the NSISC meet: a wrong admission here is a
 * silent wrong total. Each case is worked by hand from the rule in the comment.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../../packages/core/src/types';
import {
  admitTieGroupToEventCap,
  admitTieGroupToMeetPool,
  getOrCreateMeetState,
  seedAbRelayLegsIntoPool,
  swimmerInPool,
  type TeamMeetState,
} from '../../packages/core/src/lib/meetPool';

const EVENT = 'Event 3 Men 100 Yard Freestyle';
const DIVE = 'Event 15 Men 1m Diving';

function settings(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return {
    scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11],
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 18,
    maxRelaysScoringPerTeam: 2,
    ...extra,
  };
}

function swim(name: string, time: string): SwimmerResult {
  return { id: name, name, time, team: 'Alpha', event: EVENT, gender: Gender.MEN } as SwimmerResult;
}

function names(set: Set<string>): string[] {
  return [...set].sort();
}

describe('admitTieGroupToMeetPool', () => {
  it('admits the fastest athletes first until the cap is full', () => {
    // Cap 2. Times 25.00, 24.00, 26.00: the 24.00 and 25.00 fit, the 26.00 does not.
    const pool = new Map<string, number>();
    const admitted = admitTieGroupToMeetPool(
      pool,
      [swim('Ann', '25.00'), swim('Bea', '24.00'), swim('Cy', '26.00')],
      EVENT,
      settings({ maxIndividualScorersPerTeam: 2 })
    );

    expect(names(admitted)).toEqual(['Ann', 'Bea']);
    expect([...pool.keys()].sort()).toEqual(['ann', 'bea']);
    expect([...pool.values()]).toEqual([1, 1]);
  });

  it('an athlete already in the pool is admitted when the pool is full', () => {
    // Cap 2, pool {x, y} full. x scores again (no new slot). z needs a slot: refused.
    const pool = new Map<string, number>([
      ['x', 1],
      ['y', 1],
    ]);
    const admitted = admitTieGroupToMeetPool(
      pool,
      [swim('Z', '24.00'), swim('X', '30.00')],
      EVENT,
      settings({ maxIndividualScorersPerTeam: 2 })
    );

    expect(names(admitted)).toEqual(['X']);
    expect(pool.size).toBe(2);
  });

  it('pool names are matched without case or spacing', () => {
    const pool = new Map<string, number>([['jane doe', 1]]);
    const admitted = admitTieGroupToMeetPool(
      pool,
      [swim('  JANE   Doe ', '30.00'), swim('Other', '24.00')],
      EVENT,
      settings({ maxIndividualScorersPerTeam: 1 })
    );

    expect(names(admitted)).toEqual(['  JANE   Doe ']);
    expect(pool.size).toBe(1);
  });

  it('equal times fall back to name order, and no time sorts last', () => {
    const pool = new Map<string, number>();
    const tied = admitTieGroupToMeetPool(
      pool,
      [swim('Beth', '25.00'), swim('Amy', '25.00')],
      EVENT,
      settings({ maxIndividualScorersPerTeam: 1 })
    );
    // Same time, one slot: Amy sorts before Beth.
    expect(names(tied)).toEqual(['Amy']);

    for (const noTime of ['NT', 'DQ', '', 'abc']) {
      const p = new Map<string, number>();
      const got = admitTieGroupToMeetPool(
        p,
        [swim('Aaron', noTime), swim('Zed', '40.00')],
        EVENT,
        settings({ maxIndividualScorersPerTeam: 1 })
      );
      // Zed has a time and Aaron does not: Zed takes the one slot although Aaron sorts first by name.
      expect(names(got)).toEqual(['Zed']);
    }
  });

  it('two rows of one athlete count once, at the athlete best time', () => {
    // Ann swims 30.00 and 24.00; Bea 25.00. One slot: Ann's 24.00 is the fastest, so Ann.
    const pool = new Map<string, number>();
    const admitted = admitTieGroupToMeetPool(
      pool,
      [swim('Ann', '30.00'), swim('Bea', '25.00'), swim('Ann', '24.00')],
      EVENT,
      settings({ maxIndividualScorersPerTeam: 1 })
    );

    expect(names(admitted)).toEqual(['Ann']);
    expect(pool.size).toBe(1);
  });

  it('an athlete with a slow row listed after a fast row is ranked by the fast one', () => {
    // Ann swims 24.00 then 30.00. Bea swims 25.00. One slot: Ann (24.00) beats Bea (25.00).
    const admitted = admitTieGroupToMeetPool(
      new Map(),
      [swim('Ann', '24.00'), swim('Bea', '25.00'), swim('Ann', '30.00')],
      EVENT,
      settings({ maxIndividualScorersPerTeam: 1 })
    );
    expect(names(admitted)).toEqual(['Ann']);
  });

  it('an athlete already in the pool keeps the weight they were admitted at', () => {
    // x entered the pool as a swimmer (weight 1). A later dive at weight 0.5 does not reweigh x.
    const pool = new Map<string, number>([['x', 1]]);
    admitTieGroupToMeetPool(
      pool,
      [{ ...swim('x', '300.00'), event: DIVE }],
      DIVE,
      settings({ maxIndividualScorersPerTeam: 2, diverScorerWeight: 0.5 })
    );
    expect(pool.get('x')).toBe(1);
  });

  it('the cap defaults to 18 and 999 or more is no cap', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      swim(`Swimmer ${String(i).padStart(2, '0')}`, `${20 + i}.00`)
    );
    const defaulted = admitTieGroupToMeetPool(
      new Map(),
      many,
      EVENT,
      settings({ maxIndividualScorersPerTeam: undefined as unknown as number })
    );
    expect(defaulted.size).toBe(18);
    // The 18 fastest: times 20.00 .. 37.00, so swimmers 00..17.
    expect(defaulted.has('Swimmer 17')).toBe(true);
    expect(defaulted.has('Swimmer 18')).toBe(false);

    expect(admitTieGroupToMeetPool(new Map(), many, EVENT, settings({ maxIndividualScorersPerTeam: 999 })).size).toBe(
      20
    );
  });

  it('a diver takes the diver weight of a slot, a swimmer a whole one', () => {
    // Cap 1, diver weight 1/3: three divers fit (1/3 x 3 = 1) and a fourth does not.
    const divers = ['D1', 'D2', 'D3', 'D4'].map((n, i) => ({ ...swim(n, `${300 + i}.00`), event: DIVE }));
    const s = settings({ maxIndividualScorersPerTeam: 1, diverScorerWeight: 1 / 3 });
    const pool = new Map<string, number>();
    const admitted = admitTieGroupToMeetPool(pool, divers, DIVE, s);
    expect(names(admitted)).toEqual(['D1', 'D2', 'D3']);
    expect([...pool.values()]).toEqual([1 / 3, 1 / 3, 1 / 3]);

    // The same weight does not apply to a swimming event: weight 1, so one swimmer fills cap 1.
    const swimmers = admitTieGroupToMeetPool(new Map(), [swim('S1', '25.00'), swim('S2', '26.00')], EVENT, s);
    expect(names(swimmers)).toEqual(['S1']);

    // A diving event with no diver weight set costs a whole slot.
    const noWeight = admitTieGroupToMeetPool(
      new Map(),
      divers,
      DIVE,
      settings({ maxIndividualScorersPerTeam: 1, diverScorerWeight: undefined })
    );
    expect(names(noWeight)).toEqual(['D1']);
  });

  it('allows for floating-point drift when weights fill the cap exactly', () => {
    // Three 0.1 weights add to 0.30000000000000004, which is above the cap 0.3 by rounding only.
    const divers = ['D1', 'D2', 'D3', 'D4'].map((n, i) => ({ ...swim(n, `${300 + i}.00`), event: DIVE }));
    const admitted = admitTieGroupToMeetPool(
      new Map(),
      divers,
      DIVE,
      settings({ maxIndividualScorersPerTeam: 0.3, diverScorerWeight: 0.1 })
    );
    expect(names(admitted)).toEqual(['D1', 'D2', 'D3']);
  });
});

describe('admitTieGroupToEventCap', () => {
  const group = [swim('Cy', '26.00'), swim('Ann', '24.00'), swim('Bea', '25.00')];

  it('admits the fastest names that still fit under the per-event cap', () => {
    // Cap 3, 1 used: 2 places left, the 24.00 and the 25.00.
    expect(names(admitTieGroupToEventCap(group, 1, 3))).toEqual(['Ann', 'Bea']);
    // Cap 3, none used: all three fit.
    expect(names(admitTieGroupToEventCap(group, 0, 3))).toEqual(['Ann', 'Bea', 'Cy']);
  });

  it('admits nobody when the team is at or over the cap', () => {
    expect(admitTieGroupToEventCap(group, 3, 3).size).toBe(0);
    expect(admitTieGroupToEventCap(group, 5, 3).size).toBe(0);
    expect(admitTieGroupToEventCap(group, 0, 0).size).toBe(0);
  });
});

describe('getOrCreateMeetState and swimmerInPool', () => {
  it('one state per team and gender, the team trimmed', () => {
    const states = new Map<string, TeamMeetState>();
    const a = getOrCreateMeetState(states, 'Alpha', Gender.MEN);
    expect(getOrCreateMeetState(states, ' Alpha ', Gender.MEN)).toBe(a);
    expect(getOrCreateMeetState(states, 'Alpha', Gender.WOMEN)).not.toBe(a);
    expect(getOrCreateMeetState(states, 'Bravo', Gender.MEN)).not.toBe(a);
    const none = getOrCreateMeetState(states, 'Alpha', undefined);
    expect(none).not.toBe(a);
    expect(getOrCreateMeetState(states, 'Alpha', undefined)).toBe(none);
    expect(states.size).toBe(4);
    expect(a.poolWeights.size).toBe(0);
  });

  it('a name is in the pool when its normalized key is', () => {
    const pool = new Map<string, number>([['jane doe', 1]]);
    expect(swimmerInPool(pool, 'Jane Doe')).toBe(true);
    expect(swimmerInPool(pool, '  jane   DOE ')).toBe(true);
    expect(swimmerInPool(pool, 'Jane Roe')).toBe(false);
  });
});

describe('seedAbRelayLegsIntoPool', () => {
  const leg = (name: string, extra: Partial<SwimmerResult> = {}): SwimmerResult =>
    ({
      id: name,
      name,
      time: '25.00',
      team: 'Alpha',
      event: 'Event 2 Men 200 Yard Freestyle Relay',
      roundSwam: 'A Final',
      gender: Gender.MEN,
      isRelay: true,
      ...extra,
    }) as SwimmerResult;

  it('adds the legs of an A or B final relay to the team pool', () => {
    const states = new Map<string, TeamMeetState>();
    seedAbRelayLegsIntoPool([leg('Ann'), leg('Bea', { roundSwam: 'B Final' })], settings(), states);

    const pool = getOrCreateMeetState(states, 'Alpha', Gender.MEN).poolWeights;
    expect([...pool.keys()].sort()).toEqual(['ann', 'bea']);
  });

  it('leaves out timed-final, prelim and C final legs, and non-relay rows', () => {
    const states = new Map<string, TeamMeetState>();
    seedAbRelayLegsIntoPool(
      [
        leg('Fin', { roundSwam: 'Finals' }),
        leg('Pre', { roundSwam: 'Preliminaries' }),
        leg('Cee', { roundSwam: 'C Final' }),
        leg('Solo', { isRelay: false, event: EVENT }),
      ],
      settings(),
      states
    );

    expect(states.size).toBe(0);
  });

  it('seeds nothing when the preset does not count relay legs in finals', () => {
    const states = new Map<string, TeamMeetState>();
    seedAbRelayLegsIntoPool(
      [leg('Ann')],
      settings({
        scorerAutoRules: { abFinalTiers: ['A', 'B'], includeRelayLegsInFinals: false },
      }),
      states
    );
    expect(states.size).toBe(0);
  });

  it('stops at the cap, in row order, and files a blank team under Unknown', () => {
    // Cap 2, four legs: the first two are seeded.
    const states = new Map<string, TeamMeetState>();
    seedAbRelayLegsIntoPool(
      [leg('L1'), leg('L2'), leg('L3'), leg('L4')],
      settings({ maxIndividualScorersPerTeam: 2 }),
      states
    );
    expect([...getOrCreateMeetState(states, 'Alpha', Gender.MEN).poolWeights.keys()]).toEqual(['l1', 'l2']);

    const blank = new Map<string, TeamMeetState>();
    seedAbRelayLegsIntoPool([leg('Ann', { team: '  ' }), leg('Bea', { team: undefined as unknown as string })], settings(), blank);
    expect([...getOrCreateMeetState(blank, 'Unknown', Gender.MEN).poolWeights.keys()].sort()).toEqual(['ann', 'bea']);
  });

  it('a leg already in the pool takes no new slot', () => {
    const states = new Map<string, TeamMeetState>();
    getOrCreateMeetState(states, 'Alpha', Gender.MEN).poolWeights.set('ann', 1);
    seedAbRelayLegsIntoPool(
      [leg('Ann'), leg('Bea'), leg('Cy')],
      settings({ maxIndividualScorersPerTeam: 2 }),
      states
    );
    // Pool had ann; Bea takes the second slot; Cy is refused.
    expect([...getOrCreateMeetState(states, 'Alpha', Gender.MEN).poolWeights.keys()].sort()).toEqual(['ann', 'bea']);
  });
});
