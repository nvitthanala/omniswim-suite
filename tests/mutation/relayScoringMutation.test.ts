/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `relayScoring.ts` (plan item T6). Each case
 * below kills a Stryker mutant that survived the suite as it stood on
 * 2026-10-14 (see docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Every number is worked by hand from the NCAA championship 16-place relay table
 * (Rule 7: the individual table 20, 17, 16, 15, ... doubled for relays):
 *
 *   place   1    2    3    4    5    6    7    8    9    10   11   12   13  14  15  16
 *   points  40   34   32   30   28   26   24   22   18   14   12   10   8   6   4   2
 *
 * An A final scores place `rank`; a B final rank r scores place 8 + r (9th-16th),
 * so B rank 1 is 18. A tie shares the points of every place it spans, divided by
 * the number of tied entries. Four legs share an entry's points, 1/4 each.
 * The rows are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../../packages/core/src/types';
import { calculatePoints } from '../../packages/core/src/lib/utils';
import { scoreRelaysInEvent } from '../../packages/core/src/lib/relayScoring';
import { getOrCreateMeetState, type TeamMeetState } from '../../packages/core/src/lib/meetPool';
import { normalizeSwimmerName } from '../../packages/core/src/lib/swimmerNames';
import {
  mergeScoringSettings,
  settingsForBuiltInScoringPreset,
} from '../../packages/core/src/lib/scoringDefaults';

const EVENT = 'Event 2 Men 200 Yard Freestyle Relay';
const OTHER_EVENT = 'Event 4 Men 400 Yard Freestyle Relay';

/** The championship preset with the per-team relay cap and eligibility pinned explicitly. */
function settings(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return {
    ...settingsForBuiltInScoringPreset('ncaa-championship-16'),
    maxRelaysScoringPerTeam: 2,
    scorerEligibilityMode: 'points_pool',
    ...extra,
  };
}

type EntryOptions = {
  legs?: number;
  round?: string;
  event?: string;
  /** Written to `time`, which the entry sort reads. Defaults to the clock. */
  time?: string;
  /** False leaves `relayNames` off the rows. */
  names?: boolean;
  /** False leaves `finalsTime` off the rows. */
  finalsTime?: boolean;
  perRow?: (i: number) => Partial<SwimmerResult>;
};

/** One relay entry as leg rows. Ids are `<team>-<tag>-<leg>`; names are `<team> <tag> Leg <n>`. */
function entry(
  team: string,
  tag: string,
  rank: number,
  clock: string,
  o: EntryOptions = {}
): SwimmerResult[] {
  const legCount = o.legs ?? 4;
  const names = Array.from({ length: legCount }, (_, i) => `${team} ${tag} Leg ${i + 1}`);
  return names.map((name, i) => {
    const row: SwimmerResult = {
      id: `${team}-${tag}-${i}`,
      rank,
      name,
      classYear: 'JR',
      team,
      time: o.time ?? clock,
      relayTeamTime: clock,
      roundSwam: o.round ?? 'A Final',
      points: 0,
      event: o.event ?? EVENT,
      gender: Gender.MEN,
      isRelay: true,
      relayLegIndex: i,
    };
    if (o.finalsTime !== false) row.finalsTime = clock;
    if (o.names !== false) row.relayNames = names.map(n => ({ name: n, year: 'JR' }));
    return { ...row, ...(o.perRow ? o.perRow(i) : {}) };
  });
}

function entryPoints(scored: SwimmerResult[], team: string, tag: string): number[] {
  return scored.filter(r => r.id.startsWith(`${team}-${tag}-`)).map(r => Number(r.points));
}

function entryTotal(scored: SwimmerResult[], team: string, tag: string): number {
  return entryPoints(scored, team, tag).reduce((a, b) => a + b, 0);
}

describe('relay entry order decides which entry takes a team relay slot', () => {
  it('a team cap of 2 keeps the two best-placed relays however the rows arrive', () => {
    // Alpha enters three relays, listed 3rd, 1st, 2nd. Cap 2 keeps the 1st and 2nd.
    // 1st = 40 (10 a leg), 2nd = 34 (8.5 a leg), 3rd takes no slot: 0.
    const rows = [
      ...entry('Alpha', 'C', 3, '1:22.00'),
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Alpha', 'B', 2, '1:21.00'),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
    expect(entryPoints(scored, 'Alpha', 'B')).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect(entryPoints(scored, 'Alpha', 'C')).toEqual([0, 0, 0, 0]);
  });

  it('rank outranks the clock when both could order the entries', () => {
    // Rank 2 carries the faster clock and arrives first. Rank 1 still takes the one slot:
    // 40 / 4 = 10 a leg. Rank 2 takes none: 0.
    const rows = [
      ...entry('Alpha', 'Second', 2, '1:19.00'),
      ...entry('Alpha', 'First', 1, '1:20.00'),
    ];
    const scored = calculatePoints(rows, settings({ maxRelaysScoringPerTeam: 1 }));

    expect(entryPoints(scored, 'Alpha', 'First')).toEqual([10, 10, 10, 10]);
    expect(entryPoints(scored, 'Alpha', 'Second')).toEqual([0, 0, 0, 0]);
  });

  it('on a dead heat the faster clock takes the slot', () => {
    // Both rank 1: the tie spans places 1 and 2, (40 + 34) / 2 = 37 an entry.
    // Cap 1 leaves one entry scoring; it is the 1:20.00, not the 1:21.00 listed first.
    // 37 / 4 = 9.25 a leg. The other entry forfeits its share: 0.
    const rows = [
      ...entry('Alpha', 'Slow', 1, '1:21.00'),
      ...entry('Alpha', 'Fast', 1, '1:20.00'),
    ];
    const scored = calculatePoints(rows, settings({ maxRelaysScoringPerTeam: 1 }));

    expect(entryPoints(scored, 'Alpha', 'Fast')).toEqual([9.25, 9.25, 9.25, 9.25]);
    expect(entryPoints(scored, 'Alpha', 'Slow')).toEqual([0, 0, 0, 0]);
  });

  it('an A final entry is placed before a B final entry', () => {
    // Cap 1. The B final entry (rank 1 = 9th place = 18) is listed first. The A final entry
    // (rank 3 = 32) is ordered ahead of it by round, so it takes the slot: 32 / 4 = 8 a leg.
    const rows = [
      ...entry('Alpha', 'B', 1, '1:25.00', { round: 'B Final' }),
      ...entry('Alpha', 'A', 3, '1:22.00', { round: 'A Final' }),
    ];
    const scored = calculatePoints(rows, settings({ maxRelaysScoringPerTeam: 1 }));

    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([8, 8, 8, 8]);
    expect(entryPoints(scored, 'Alpha', 'B')).toEqual([0, 0, 0, 0]);
  });
});

describe('an entry that holds no place', () => {
  it('an exhibition entry does not spend one of the team relay slots', () => {
    // Alpha: an exhibition entry at rank 1, then scoring entries at rank 2 and 3. Cap 2.
    // The exhibition entry holds no place, so rank 2 (34) and rank 3 (32) both score:
    // 8.5 and 8 a leg. Counting the exhibition entry would leave rank 3 with 0.
    const rows = [
      ...entry('Alpha', 'Ex', 1, '1:19.00', { perRow: () => ({ isExhibition: true }) }),
      ...entry('Alpha', 'Two', 2, '1:20.00'),
      ...entry('Alpha', 'Three', 3, '1:21.00'),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'Ex')).toEqual([0, 0, 0, 0]);
    expect(entryPoints(scored, 'Alpha', 'Two')).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect(entryPoints(scored, 'Alpha', 'Three')).toEqual([8, 8, 8, 8]);
  });

  it('an exhibition or disqualified entry does not sit in a rival tied-place divisor', () => {
    // Alpha takes 1st alone. Bravo (exhibition) and Charlie (DQ) are also written at rank 1,
    // but neither holds a place, so Alpha is not tied: 40 / 4 = 10 a leg, not (40 + 34) / 2.
    const rows = [
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Bravo', 'A', 1, '1:20.00', { perRow: () => ({ isExhibition: true }) }),
      ...entry('Charlie', 'A', 1, 'DQ'),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
    expect(entryTotal(scored, 'Bravo', 'A')).toBe(0);
    expect(entryTotal(scored, 'Charlie', 'A')).toBe(0);
  });

  it('one exhibition leg row removes the whole entry from scoring', () => {
    // Only the 3rd leg row carries the exhibition flag. The entry is an exhibition entry:
    // all four legs 0. Bravo's 2nd place is 34 / 4 = 8.5 a leg, unmoved.
    const rows = [
      ...entry('Alpha', 'A', 1, '1:20.00', { perRow: i => (i === 2 ? { isExhibition: true } : {}) }),
      ...entry('Bravo', 'A', 2, '1:21.00'),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([0, 0, 0, 0]);
    expect(entryPoints(scored, 'Bravo', 'A')).toEqual([8.5, 8.5, 8.5, 8.5]);
  });

  it('one time-trial leg row removes the whole entry from scoring', () => {
    const rows = [
      ...entry('Alpha', 'A', 1, '1:20.00', { perRow: i => (i === 1 ? { isTimeTrial: true } : {}) }),
      ...entry('Bravo', 'A', 2, '1:21.00'),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([0, 0, 0, 0]);
    expect(entryPoints(scored, 'Bravo', 'A')).toEqual([8.5, 8.5, 8.5, 8.5]);
  });
});

describe('entries are told apart by clock when no swimmers are named', () => {
  it('two rank-1 entries of one team with different clocks stay two entries', () => {
    // No relayNames, so the clock is all that separates them. Tied for 1st: (40 + 34) / 2 = 37
    // an entry, 37 / 4 = 9.25 a leg, 8 rows. Merged into one eight-row group they would
    // score 40 / 4 = 10 a row.
    const rows = [
      ...entry('Alpha', 'P', 1, '1:20.00', { names: false, finalsTime: false }),
      ...entry('Alpha', 'Q', 1, '1:21.00', { names: false, finalsTime: false }),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'P')).toEqual([9.25, 9.25, 9.25, 9.25]);
    expect(entryPoints(scored, 'Alpha', 'Q')).toEqual([9.25, 9.25, 9.25, 9.25]);
  });

  it('a finals clock stands in for a missing relay team clock', () => {
    const rows = [
      ...entry('Alpha', 'P', 1, '1:20.00', {
        names: false,
        perRow: () => ({ relayTeamTime: undefined, finalsTime: '1:20.00' }),
      }),
      ...entry('Alpha', 'Q', 1, '1:21.00', {
        names: false,
        perRow: () => ({ relayTeamTime: undefined, finalsTime: '1:21.00' }),
      }),
    ];
    const scored = calculatePoints(rows, settings());

    expect(entryPoints(scored, 'Alpha', 'P')).toEqual([9.25, 9.25, 9.25, 9.25]);
    expect(entryPoints(scored, 'Alpha', 'Q')).toEqual([9.25, 9.25, 9.25, 9.25]);
  });
});

describe('per-leg split of an entry that does not have four legs', () => {
  it('a three-leg entry divides its points by three, not four', () => {
    // halfRateRelaySwimmer is on in this preset. The comment on the divisor reads "each leg
    // earns 1/n of team relay points". n = 3, 1st = 40: 40 / 3 a leg, total 40.
    const rows = entry('Alpha', 'A', 1, '1:20.00', { legs: 3 });
    const scored = calculatePoints(rows, settings({ halfRateRelaySwimmer: true }));

    const legs = entryPoints(scored, 'Alpha', 'A');
    expect(legs).toHaveLength(3);
    for (const p of legs) expect(p).toBeCloseTo(40 / 3, 10);
    expect(entryTotal(scored, 'Alpha', 'A')).toBeCloseTo(40, 10);
  });
});

describe('scoreRelaysInEvent called directly', () => {
  const merged = mergeScoringSettings(settings());
  const run = (
    rows: SwimmerResult[],
    m: ScoringSettings = merged,
    states: Map<string, TeamMeetState> = new Map(),
    useMeetWidePool = false
  ) => scoreRelaysInEvent(rows, m, states, useMeetWidePool, undefined);

  it('returns one row per input row, ids kept, with 0 on every row that scores nothing', () => {
    // Alpha takes 1st (10 a leg). Bravo is an exhibition entry (no place). Foxtrot enters three
    // relays at 5th, 6th and 7th; the cap of 2 keeps 5th (28 / 4 = 7) and 6th (26 / 4 = 6.5).
    const rows = [
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Bravo', 'A', 2, '1:21.00', { perRow: () => ({ isExhibition: true }) }),
      ...entry('Foxtrot', 'A', 5, '1:25.00'),
      ...entry('Foxtrot', 'B', 6, '1:26.00'),
      ...entry('Foxtrot', 'C', 7, '1:27.00'),
    ];
    const out = run(rows);

    expect(out).toHaveLength(rows.length);
    expect(out.map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort());
    expect(entryPoints(out, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
    expect(entryPoints(out, 'Bravo', 'A')).toEqual([0, 0, 0, 0]);
    expect(entryPoints(out, 'Foxtrot', 'A')).toEqual([7, 7, 7, 7]);
    expect(entryPoints(out, 'Foxtrot', 'B')).toEqual([6.5, 6.5, 6.5, 6.5]);
    expect(entryPoints(out, 'Foxtrot', 'C')).toEqual([0, 0, 0, 0]);
  });

  it('whitespace around a team, event, round or clock does not split one entry', () => {
    // Four leg rows of one entry, each spelled with different padding. One entry, 1st:
    // 40 / 4 = 10 on every row.
    const rows = entry('Alpha', 'A', 1, '1:20.00');
    const padded = rows.map((r, i) => {
      if (i === 1) return { ...r, team: ' Alpha' };
      if (i === 2) return { ...r, event: `${EVENT} `, roundSwam: ' A Final' };
      if (i === 3) return { ...r, relayTeamTime: '1:20.00 ', roundSwam: 'A Final ' };
      return r;
    });
    const out = run(padded);

    expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
  });

  it('a team name that is blank is one team, Unknown, for the relay cap', () => {
    // Three entries whose team is "", " " and "  " share the team "Unknown". Cap 2: the 1st and
    // 2nd score (10 and 8.5 a leg), the 3rd is over the cap.
    const rows = [
      ...entry('', 'A', 1, '1:20.00'),
      ...entry(' ', 'B', 2, '1:21.00'),
      ...entry('  ', 'C', 3, '1:22.00'),
    ];
    const out = run(rows);

    expect(out.filter(r => r.id.includes('-A-')).map(r => r.points)).toEqual([10, 10, 10, 10]);
    expect(out.filter(r => r.id.includes('-B-')).map(r => r.points)).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect(out.filter(r => r.id.includes('-C-')).map(r => r.points)).toEqual([0, 0, 0, 0]);
  });

  it('padding on an event label does not buy a second relay slot', () => {
    // Same team, cap 1. Two entries whose event labels differ only by a trailing space share one
    // slot: 1st scores 10 a leg, 2nd 0.
    const rows = [
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Alpha', 'B', 2, '1:21.00', { event: `${EVENT} ` }),
    ];
    const out = run(rows, mergeScoringSettings(settings({ maxRelaysScoringPerTeam: 1 })));

    expect(entryPoints(out, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
    expect(entryPoints(out, 'Alpha', 'B')).toEqual([0, 0, 0, 0]);
  });

  it('the team relay cap counts each event separately', () => {
    // Cap 2. Alpha has two 200 relays (ranks 1, 2) and one 400 relay (rank 3). The 400 relay
    // is its first entry in that event, so it scores 32 / 4 = 8 a leg.
    const rows = [
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Alpha', 'B', 2, '1:21.00'),
      ...entry('Alpha', 'C', 3, '3:00.00', { event: OTHER_EVENT }),
    ];
    const out = run(rows);

    expect(entryPoints(out, 'Alpha', 'C')).toEqual([8, 8, 8, 8]);
  });

  it('a tie is counted per event and per round, and across padding on the label', () => {
    // Two events, both with a rank-1 entry from different teams: not a tie, 40 / 4 = 10 each.
    const separateEvents = run([
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Bravo', 'A', 1, '3:00.00', { event: OTHER_EVENT }),
    ]);
    expect(entryPoints(separateEvents, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
    expect(entryPoints(separateEvents, 'Bravo', 'A')).toEqual([10, 10, 10, 10]);

    // An A final rank 1 (40) and a B final rank 1 (18) are not a tie: 10 and 4.5 a leg.
    const separateRounds = run([
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Bravo', 'A', 1, '1:25.00', { round: 'B Final' }),
    ]);
    expect(entryPoints(separateRounds, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
    expect(entryPoints(separateRounds, 'Bravo', 'A')).toEqual([4.5, 4.5, 4.5, 4.5]);

    // The same event and round spelled with padding is still one tie: (40 + 34) / 2 = 37,
    // 37 / 4 = 9.25 a leg.
    const padded = run([
      ...entry('Alpha', 'A', 1, '1:20.00'),
      ...entry('Bravo', 'A', 1, '1:20.00', { event: `${EVENT} `, round: ' A Final' }),
    ]);
    expect(entryPoints(padded, 'Alpha', 'A')).toEqual([9.25, 9.25, 9.25, 9.25]);
    expect(entryPoints(padded, 'Bravo', 'A')).toEqual([9.25, 9.25, 9.25, 9.25]);
  });

  it('a relay that is over the cap keeps its rows, at 0', () => {
    const rows = [...entry('Alpha', 'A', 1, '1:20.00'), ...entry('Alpha', 'B', 2, '1:21.00')];
    const out = run(rows, mergeScoringSettings(settings({ maxRelaysScoringPerTeam: 1 })));

    expect(out).toHaveLength(8);
    const over = out.filter(r => r.id.startsWith('Alpha-B-'));
    expect(over).toHaveLength(4);
    for (const r of over) {
      expect(r.points).toBe(0);
      expect(r.name).toMatch(/^Alpha B Leg /);
    }
  });

  describe('roster mode', () => {
    const rosterSettings = mergeScoringSettings(settings({ scorerEligibilityMode: 'roster' }));
    // `Finals` is the timed-final label of a relay (a relay has no A or B heat). It is a
    // final, so its legs count as A/B final legs: eligible whatever the lookup says.
    // (T6 pinned the opposite, "every leg must be on the roster"; that zeroed every
    // NSISC relay on SwimCloud data, where the lookup never holds the entry row's name.)
    const finals = (): SwimmerResult[] => entry('Alpha', 'A', 1, '1:20.00', { round: 'Finals' });

    it('a timed-final relay scores whatever the roster lookup says', () => {
      const none = scoreRelaysInEvent(finals(), rosterSettings, new Map(), false, {
        isScorer: () => false,
        rows: [],
      });
      expect(none.map(r => r.points)).toEqual([10, 10, 10, 10]);
    });

    it('a relay in a round outside the counted tiers needs every leg on the roster', () => {
      // B Final is outside `abFinalTiers: ['A']`, so the entry goes through the leg check.
      const aOnly = mergeScoringSettings(
        settings({ scorerEligibilityMode: 'roster', scorerAutoRules: { abFinalTiers: ['A'] } })
      );
      const bFinal = (): SwimmerResult[] => entry('Alpha', 'A', 1, '1:20.00', { round: 'B Final' });
      const allIn = scoreRelaysInEvent(bFinal(), aOnly, new Map(), false, {
        isScorer: () => true,
        rows: [],
      });
      expect(allIn).toHaveLength(4);
      for (const r of allIn) expect(r.points).toBeGreaterThan(0);

      const oneOut = scoreRelaysInEvent(bFinal(), aOnly, new Map(), false, {
        isScorer: name => name !== 'Alpha A Leg 3',
        rows: [],
      });
      expect(oneOut).toHaveLength(4);
      expect(oneOut.map(r => r.points)).toEqual([0, 0, 0, 0]);
    });

    it('with no roster lookup there is no roster gate', () => {
      const out = scoreRelaysInEvent(finals(), rosterSettings, new Map(), false, undefined);
      expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
    });
  });

  describe('relay legs drawn from the meet-wide scorer pool', () => {
    const poolSettings = mergeScoringSettings(
      settings({ relayEligibleFromScorerPool: true, scorerEligibilityMode: 'points_pool' })
    );
    const poolWith = (names: string[]): Map<string, TeamMeetState> => {
      const states = new Map<string, TeamMeetState>();
      const state = getOrCreateMeetState(states, 'Alpha', Gender.MEN);
      for (const n of names) state.poolWeights.set(normalizeSwimmerName(n), 1);
      return states;
    };
    const legNames = (): string[] => entry('Alpha', 'A', 1, '1:20.00').map(r => r.name);

    it('scores when every leg is in the pool', () => {
      const out = run(entry('Alpha', 'A', 1, '1:20.00'), poolSettings, poolWith(legNames()), true);
      expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
    });

    it('scores nothing when one leg is not in the pool, and keeps its rows', () => {
      const out = run(
        entry('Alpha', 'A', 1, '1:20.00'),
        poolSettings,
        poolWith(legNames().slice(0, 3)),
        true
      );
      expect(out).toHaveLength(4);
      expect(out.map(r => r.points)).toEqual([0, 0, 0, 0]);
      expect(out.map(r => r.id)).toEqual(['Alpha-A-0', 'Alpha-A-1', 'Alpha-A-2', 'Alpha-A-3']);
    });

    it('a relay whose team is blank draws on the Unknown team pool, as individual swims do', () => {
      // Individual scoring files a blank team under "Unknown". The relay must read the same pool.
      const states = new Map<string, TeamMeetState>();
      const unknown = getOrCreateMeetState(states, 'Unknown', Gender.MEN);
      for (const n of legNames()) unknown.poolWeights.set(normalizeSwimmerName(n), 1);

      const emptyTeam = entry('Alpha', 'A', 1, '1:20.00', { perRow: () => ({ team: '' }) });
      expect(run(emptyTeam, poolSettings, states, true).map(r => r.points)).toEqual([10, 10, 10, 10]);

      const noTeam = entry('Alpha', 'A', 1, '1:20.00', {
        perRow: () => ({ team: undefined as unknown as string }),
      });
      expect(run(noTeam, poolSettings, states, true).map(r => r.points)).toEqual([10, 10, 10, 10]);
    });

    it('does not read the pool when the meet-wide pool is off', () => {
      const out = run(entry('Alpha', 'A', 1, '1:20.00'), poolSettings, new Map(), false);
      expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
    });

    it('does not read the pool when relay legs are not drawn from it', () => {
      const out = run(
        entry('Alpha', 'A', 1, '1:20.00'),
        mergeScoringSettings(settings({ relayEligibleFromScorerPool: false })),
        new Map(),
        true
      );
      expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
    });
  });
});

describe('relay legs drawn from the scorer pool, through calculatePoints', () => {
  // A meet-wide pool of 2 scorers per team; relay legs are seeded into it before the relay is
  // scored. Alpha's relay has four legs and nobody else is entered: the pool takes two, so two
  // legs are outside it. With relay legs drawn from the pool the relay scores 0.
  const poolRules: Partial<ScoringSettings> = {
    scorerCapScope: 'meet',
    maxIndividualScorersPerTeam: 2,
    relayEligibleFromScorerPool: true,
  };

  it('a relay with more legs than the pool has slots scores nothing', () => {
    const scored = calculatePoints(entry('Alpha', 'A', 1, '1:20.00'), settings(poolRules));
    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([0, 0, 0, 0]);
  });

  it('the same meet scores the relay when legs are not drawn from the pool', () => {
    // 1st = 40, four legs: 10 each.
    const scored = calculatePoints(
      entry('Alpha', 'A', 1, '1:20.00'),
      settings({ ...poolRules, relayEligibleFromScorerPool: false })
    );
    expect(entryPoints(scored, 'Alpha', 'A')).toEqual([10, 10, 10, 10]);
  });
});
