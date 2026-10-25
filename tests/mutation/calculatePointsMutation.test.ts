/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `calculatePoints.ts` (plan item T6). Each case
 * kills Stryker mutants that survived the suite as it stood on 2026-10-14 (see
 * docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Place values are the NCAA individual 16-place table (Rule 7-1-1) and the
 * doubled relay table (Rule 7):
 *
 *   place        1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16
 *   individual  20  17  16  15  14  13  12  11   9   7   6   5   4   3   2   1
 *   relay       40  34  32  30  28  26  24  22  18  14  12  10   8   6   4   2
 *
 * A tie shares the points of the places it spans over the number of entries.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../../packages/core/src/types';
import {
  buildMeetPlaceField,
  calculatePoints,
  chooseMeetEventLabels,
  prepareRecruitsForScoring,
} from '../../packages/core/src/lib/calculatePoints';

const NCAA_16 = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];
const E1 = 'Event 1 Men 100 Yard Freestyle';
const E2 = 'Event 2 Men 200 Yard Freestyle Relay';
const E3 = 'Event 3 Men 200 Yard Backstroke';

function settings(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return {
    scoringPoints: NCAA_16,
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    aFinalBracketSize: 8,
    scorerCapScope: 'event',
    scorerEligibilityMode: 'points_pool',
    usePdfPlacePoints: false,
    ...extra,
  };
}

function swim(
  id: string,
  team: string,
  event: string,
  rank: number | undefined,
  time: string,
  extra: Partial<SwimmerResult> = {}
): SwimmerResult {
  return {
    id,
    name: id,
    team,
    event,
    rank: rank as number,
    time,
    finalsTime: time,
    classYear: 'JR',
    roundSwam: 'A Final',
    points: 0,
    gender: Gender.MEN,
    ...extra,
  } as SwimmerResult;
}

function relay(team: string, event: string, rank: number, clock: string, legNames: string[]): SwimmerResult[] {
  return legNames.map((name, i) =>
    swim(`${team}-${name}`, team, event, rank, clock, {
      name,
      isRelay: true,
      relayLegIndex: i,
      relayTeamTime: clock,
      relayNames: legNames.map(n => ({ name: n, year: 'JR' })),
    })
  );
}

function pointsById(rows: SwimmerResult[]): Record<string, number | string> {
  return Object.fromEntries(rows.map(r => [r.id, r.points]));
}

describe('PDF place-points mode', () => {
  const pdf = (extra: Partial<ScoringSettings> = {}) => settings({ usePdfPlacePoints: true, ...extra });

  it('each row takes its own printed points, and 0 when it has none that count', () => {
    const rows = [
      swim('p20', 'T1', E1, 1, '20.00', { pdfPoints: 20 }),
      swim('p0', 'T2', E1, 2, '20.10', { pdfPoints: 0 }),
      swim('pNone', 'T3', E1, 3, '20.20'),
      swim('pNeg', 'T4', E1, 4, '20.30', { pdfPoints: -1 }),
      swim('pNaN', 'T5', E1, 5, '20.40', { pdfPoints: Number.NaN }),
      swim('pFrac', 'T6', E1, 6, '20.50', { pdfPoints: 2.5 }),
      swim('pExh', 'T7', E1, 7, '20.60', { pdfPoints: 9, isExhibition: true }),
      swim('pTt', 'T8', E1, 8, '20.70', { pdfPoints: 9, isTimeTrial: true }),
      swim('pBoysTt', 'T9', 'Event 9 Boys 100 Yard Freestyle', 9, '20.80', { pdfPoints: 9, isTimeTrial: true }),
    ];
    const out = calculatePoints(rows, pdf());
    expect(pointsById(out)).toEqual({
      p20: 20,
      p0: 0,
      pNone: 0,
      pNeg: 0,
      pNaN: 0,
      pFrac: 2.5,
      pExh: 0,
      pTt: 0,
      pBoysTt: 9,
    });
  });

  it('an event past the meet maximum prints no points, from the setting or the call option', () => {
    const rows = [
      swim('in', 'T1', 'Event 42 Men 100 Yard Freestyle', 1, '20.00', { pdfPoints: 9 }),
      swim('out', 'T2', 'Event 43 Men 100 Yard Freestyle', 1, '20.00', { pdfPoints: 9 }),
    ];
    expect(pointsById(calculatePoints(rows, pdf({ scoredEventNumberMax: 42 })))).toEqual({ in: 9, out: 0 });
    // The option wins over the setting, both ways.
    expect(
      pointsById(calculatePoints(rows, pdf({ scoredEventNumberMax: 50 }), { scoredEventNumberMax: 42 }))
    ).toEqual({ in: 9, out: 0 });
    expect(
      pointsById(calculatePoints(rows, pdf({ scoredEventNumberMax: 42 }), { scoredEventNumberMax: 50 }))
    ).toEqual({ in: 9, out: 9 });
  });

  it('lists meet rows by round, then rank, then time; unranked rows follow ranked ones', () => {
    const rows = [
      swim('pre', 'T1', E1, 1, '21.00', { roundSwam: 'Preliminaries' }),
      swim('b1', 'T2', E1, 1, '22.00', { roundSwam: 'B Final' }),
      swim('a2', 'T3', E1, 2, '23.00'),
      swim('a1', 'T4', E1, 1, '24.00'),
      swim('uB', 'T5', E1, undefined, '20.00'),
      swim('uA', 'T6', E1, undefined, '19.50'),
    ];
    const out = calculatePoints(rows, pdf());
    // A final: rank 1, rank 2, then unranked by time (19.50, 20.00). Then B final, then prelims.
    expect(out.map(r => r.id)).toEqual(['a1', 'a2', 'uA', 'uB', 'b1', 'pre']);
  });

  it('puts recruits among the meet rows by time, scores them 0 with rank 0, meet rows first on a tie', () => {
    const rows = [
      swim('m1', 'T1', E1, 1, '24.00', { pdfPoints: 20 }),
      swim('m2', 'T2', E1, 2, '25.00', { pdfPoints: 17 }),
      swim('m3', 'T3', E1, 3, '26.00', { pdfPoints: 16 }),
      swim('rLate', 'T4', E1, 5, '99.00', { isRecruit: true }),
      swim('rMid', 'T5', E1, 5, '24.50', { isRecruit: true }),
      swim('rTie', 'T6', E1, 5, '26.00', { isRecruit: true }),
    ];
    const out = calculatePoints(rows, pdf());
    // Recruits by time: rMid 24.50, rTie 26.00, rLate 99.00. m1 (24.00) goes before rMid; m2 (25.00)
    // and m3 (26.00, equal to rTie, so first) go before rTie; rLate is last.
    expect(out.map(r => r.id)).toEqual(['m1', 'rMid', 'm2', 'm3', 'rTie', 'rLate']);
    expect(pointsById(out)).toEqual({ m1: 20, rMid: 0, m2: 17, m3: 16, rTie: 0, rLate: 0 });
    expect(out.filter(r => r.id.startsWith('r')).map(r => r.rank)).toEqual([0, 0, 0]);
  });

  it('is on when 8 or more of the meet rows carry points, and off with 7', () => {
    const build = (withPoints: number): SwimmerResult[] =>
      Array.from({ length: 10 }, (_, i) =>
        swim(`r${i + 1}`, `T${i + 1}`, E1, i + 1, `2${i}.00`, i < withPoints ? { pdfPoints: 3 } : {})
      );
    const auto = settings({ usePdfPlacePoints: 'auto' });
    // 8 of 10 rows carry points: the printed 3 is used, rank 1 is 3 (not 20).
    expect(calculatePoints(build(8), auto).find(r => r.id === 'r1')?.points).toBe(3);
    // 7 of 10: not enough. Place points apply: rank 1 = 20.
    expect(calculatePoints(build(7), auto).find(r => r.id === 'r1')?.points).toBe(20);
    expect(calculatePoints(build(7), auto).find(r => r.id === 'r2')?.points).toBe(17);
  });

  it('a hint that carries points turns the mode on for rows that have none', () => {
    const rows = [swim('r1', 'T1', E1, 1, '20.00'), swim('r2', 'T2', E1, 2, '21.00')];
    const hint = Array.from({ length: 8 }, (_, i) => swim(`h${i}`, 'T9', E3, i + 1, `3${i}.00`, { pdfPoints: 1 }));
    const auto = settings({ usePdfPlacePoints: 'auto' });
    // With the hint, the mode is PDF: these rows print nothing, so 0.
    expect(pointsById(calculatePoints(rows, auto, { resultsForPdfHint: hint }))).toEqual({ r1: 0, r2: 0 });
    // Without it, place points: 20 and 17.
    expect(pointsById(calculatePoints(rows, auto))).toEqual({ r1: 20, r2: 17 });
  });
});

describe('score dispatch across events', () => {
  it('a meet-wide pool of 2 carries across events; a per-event cap restarts each event', () => {
    const rows = [
      swim('A1', 'Alpha', E1, 1, '20.00'),
      swim('A2', 'Alpha', E1, 2, '20.50'),
      swim('A3', 'Alpha', E3, 1, '1:50.00'),
      swim('A1b', 'Alpha', E3, 2, '1:51.00', { name: 'A1' }),
    ];
    // Pool of 2 across the meet: A1 and A2 fill it in event 1. In event 3 A3 is refused (0)
    // and A1 is already in the pool: 2nd = 17.
    const meet = calculatePoints(
      rows,
      settings({ maxIndividualScorersPerTeam: 2, scorerCapScope: 'meet' })
    );
    expect(pointsById(meet)).toEqual({ A1: 20, A2: 17, A3: 0, A1b: 17 });

    // Per-event cap of 2: each event restarts. Event 1: A1, A2 score. Event 3: A3 (1st) and A1 (2nd).
    const perEvent = calculatePoints(
      rows,
      settings({ maxIndividualScorersPerTeam: 2, scorerCapScope: 'event' })
    );
    expect(pointsById(perEvent)).toEqual({ A1: 20, A2: 17, A3: 20, A1b: 17 });

    // Per-event cap of 1: the second swimmer of each event is over.
    const one = calculatePoints(
      rows,
      settings({ maxIndividualScorersPerTeam: 1, scorerCapScope: 'event' })
    );
    expect(pointsById(one)).toEqual({ A1: 20, A2: 0, A3: 20, A1b: 0 });
  });

  it('events are scored in meet order, whatever order the rows arrive in', () => {
    // Pool of 1. Event 1 is first in the meet: its swimmer takes the slot, so event 3 is refused.
    const rows = [swim('Late', 'Alpha', E3, 1, '1:50.00'), swim('Early', 'Alpha', E1, 1, '20.00')];
    const out = calculatePoints(rows, settings({ maxIndividualScorersPerTeam: 1, scorerCapScope: 'meet' }));
    expect(pointsById(out)).toEqual({ Late: 0, Early: 20 });
  });

  it('a relay entered under a scorer pool scores only when every leg is in the pool', () => {
    const legs = ['L1', 'L2', 'L3', 'L4'];
    const pool = {
      scorerCapScope: 'meet' as const,
      relayEligibleFromScorerPool: true,
    };
    // 1st relay place = 40, four legs: 10 each. Pool of 4: all four legs fit.
    const roomy = calculatePoints(relay('Alpha', E2, 1, '1:20.00', legs), settings({ ...pool, maxIndividualScorersPerTeam: 4 }));
    expect(roomy.map(r => r.points)).toEqual([10, 10, 10, 10]);
    // Pool of 3: the fourth leg is outside it, so the relay scores nothing.
    const tight = calculatePoints(relay('Alpha', E2, 1, '1:20.00', legs), settings({ ...pool, maxIndividualScorersPerTeam: 3 }));
    expect(tight.map(r => r.points)).toEqual([0, 0, 0, 0]);
  });

  it('relay legs are seeded into the pool after that event individuals, before its relays', () => {
    const legs = ['L1', 'L2', 'L3', 'L4'];
    const pool = { scorerCapScope: 'meet' as const, relayEligibleFromScorerPool: true };
    // Pool of 5. Event 1: A1 takes one slot. Event 2 relay: the four legs take the other four.
    // The relay scores: 40 / 4 = 10 each.
    const fits = calculatePoints(
      [swim('A1', 'Alpha', E1, 1, '20.00'), ...relay('Alpha', E2, 1, '1:20.00', legs)],
      settings({ ...pool, maxIndividualScorersPerTeam: 5 })
    );
    expect(pointsById(fits)).toMatchObject({ A1: 20, 'Alpha-L1': 10, 'Alpha-L4': 10 });

    // Pool of 4: A1 plus only three legs fit, so the relay is blocked.
    const blocked = calculatePoints(
      [swim('A1', 'Alpha', E1, 1, '20.00'), ...relay('Alpha', E2, 1, '1:20.00', legs)],
      settings({ ...pool, maxIndividualScorersPerTeam: 4 })
    );
    expect(pointsById(blocked)).toMatchObject({ A1: 20, 'Alpha-L1': 0, 'Alpha-L4': 0 });

    // The relay is the earlier event: its legs fill the pool of 4, so the later individual is refused.
    const relayFirst = calculatePoints(
      [
        ...relay('Alpha', 'Event 1 Men 200 Yard Freestyle Relay', 1, '1:20.00', legs),
        swim('A1', 'Alpha', E3, 1, '1:50.00'),
      ],
      settings({ ...pool, maxIndividualScorersPerTeam: 4 })
    );
    expect(pointsById(relayFirst)).toMatchObject({ A1: 0, 'Alpha-L1': 10 });
  });

  it('with no meet-wide pool the relay is not gated by the pool even when the flag is on', () => {
    const out = calculatePoints(
      relay('Alpha', E2, 1, '1:20.00', ['L1', 'L2', 'L3', 'L4']),
      settings({ relayEligibleFromScorerPool: true, scorerCapScope: 'event', maxIndividualScorersPerTeam: 2 })
    );
    expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
  });

  it('roster mode turns the relay pool rule off', () => {
    // A/B final relays are always roster-eligible, so the four legs score even in a pool of 2.
    const out = calculatePoints(
      relay('Alpha', E2, 1, '1:20.00', ['L1', 'L2', 'L3', 'L4']),
      settings({
        relayEligibleFromScorerPool: true,
        scorerEligibilityMode: 'roster',
        scorerCapScope: 'meet',
        maxIndividualScorersPerTeam: 2,
      })
    );
    expect(out.map(r => r.points)).toEqual([10, 10, 10, 10]);
  });

  it('a relay cap alone keeps relays and individuals scoring in meet order', () => {
    const rows = [
      ...relay('Alpha', E2, 1, '1:20.00', ['L1', 'L2', 'L3', 'L4']),
      ...relay('Alpha', E2, 2, '1:21.00', ['M1', 'M2', 'M3', 'M4']),
      ...relay('Alpha', E2, 3, '1:22.00', ['N1', 'N2', 'N3', 'N4']),
    ];
    // Cap 2: relays at 1st (40) and 2nd (34); the third is over: 0.
    const out = calculatePoints(rows, settings({ maxRelaysScoringPerTeam: 2 }));
    expect(pointsById(out)).toMatchObject({
      'Alpha-L1': 10,
      'Alpha-M1': 8.5,
      'Alpha-N1': 0,
    });
  });
});

describe('recruit placement', () => {
  const meet = (): SwimmerResult[] => [
    swim('m1', 'T1', E1, 1, '20.00'),
    swim('m2', 'T2', E1, 2, '21.00'),
    swim('m3', 'T3', E1, 3, '22.00'),
  ];
  const recruit = (id: string, time: string, extra: Partial<SwimmerResult> = {}) =>
    swim(id, 'Rec', E1, 0, time, { isRecruit: true, ...extra });

  it('with no recruits there is nothing to place', () => {
    expect(prepareRecruitsForScoring(meet(), [])).toEqual([]);
  });

  it('a recruit that already carries a place keeps its row exactly', () => {
    const placed = [recruit('r1', '20.50', { rank: 5, roundSwam: 'B Final' })];
    const out = prepareRecruitsForScoring(meet(), placed);
    expect(out).toBe(placed);
    expect(out[0]?.rank).toBe(5);
    expect(out[0]?.roundSwam).toBe('B Final');
  });

  it('places a recruit against the meet field: one more than the swims strictly faster', () => {
    // Field 20.00, 20.50 (recruit), 21.00, 22.00: the recruit is 2nd.
    const out = prepareRecruitsForScoring(meet(), [recruit('r1', '20.50')]);
    expect(out[0]).toMatchObject({ id: 'r1', rank: 2, roundSwam: 'A Final' });
  });

  it('an exact time tie shares the place, with the meet swim or another recruit', () => {
    const out = prepareRecruitsForScoring(meet(), [
      recruit('tieMeet', '20.00'),
      recruit('tieA', '21.50'),
      recruit('tieB', '21.50'),
    ]);
    // Field: 20.00 (m1), 20.00 (tieMeet) -> both 1st. 21.00 -> 3rd. 21.50, 21.50 -> both 4th. 22.00 -> 6th.
    expect(out.map(r => [r.id, r.rank])).toEqual([
      ['tieMeet', 1],
      ['tieA', 4],
      ['tieB', 4],
    ]);
  });

  it('recruits with no time rank behind everyone and tie one another', () => {
    const out = prepareRecruitsForScoring(meet(), [recruit('nt1', 'NT'), recruit('nt2', 'NT')]);
    // Field: three timed swims, then two NT: places 1, 2, 3, 4, 4.
    expect(out.map(r => r.rank)).toEqual([4, 4]);
  });

  it('only individual swims of the same event and gender in a scored round are in the field', () => {
    const noise: SwimmerResult[] = [
      ...meet(),
      // A relay row, another event, another gender, a prelim, a C final: none is a comparator.
      swim('relay', 'T9', E1, 1, '10.00', { isRelay: true }),
      swim('other', 'T9', E3, 1, '10.00'),
      swim('women', 'T9', E1, 1, '10.00', { gender: Gender.WOMEN }),
      swim('pre', 'T9', E1, 1, '10.00', { roundSwam: 'Preliminaries' }),
      swim('cfinal', 'T9', E1, 1, '10.00', { roundSwam: 'C Final' }),
      // Not excluded: no gender recorded, and a timed final.
      swim('nogender', 'T9', E1, 1, '23.00', { gender: undefined }),
      swim('timed', 'T9', E1, 1, '24.00', { roundSwam: 'Finals' }),
    ];
    // Comparators: 20, 21, 22, 23, 24. A recruit at 24.50 has five swims strictly faster: 6th.
    // Each excluded 10.00 row would have pushed this to 7th or later.
    const out = prepareRecruitsForScoring(noise, [recruit('r1', '24.50')]);
    expect(out[0]?.rank).toBe(6);
  });

  it('places recruits of different events and genders in separate fields, in input order', () => {
    const out = prepareRecruitsForScoring(meet(), [
      recruit('men', '20.50'),
      swim('women', 'Rec', E1, 0, '19.00', { isRecruit: true, gender: Gender.WOMEN }),
      swim('back', 'Rec', E3, 0, '1:00.00', { isRecruit: true }),
    ]);
    // men: 2nd of the men's field. women: alone (no women's comparator): 1st. back: alone: 1st.
    expect(out.map(r => [r.id, r.rank])).toEqual([
      ['men', 2],
      ['women', 1],
      ['back', 1],
    ]);
  });

  it('recruits sharing no comparators are placed against each other, not all 1st', () => {
    const out = prepareRecruitsForScoring([], [
      recruit('slow', '22.00'),
      recruit('fast', '20.00'),
      recruit('mid', '21.00'),
    ]);
    expect(out.map(r => [r.id, r.rank])).toEqual([
      ['slow', 3],
      ['fast', 1],
      ['mid', 2],
    ]);
  });

  it('a placed recruit and an unplaced one in one event: only the unplaced one is re-placed', () => {
    const out = prepareRecruitsForScoring(meet(), [
      recruit('keep', '20.00', { rank: 7 }),
      recruit('new', '20.50'),
    ]);
    expect(out.map(r => [r.id, r.rank])).toEqual([
      ['keep', 7],
      ['new', 2],
    ]);
  });

  it('through calculatePoints a recruit is scored from its place and listed by time', () => {
    const rows = [
      swim('m1', 'T1', E1, 1, '20.00'),
      swim('m3', 'T3', E1, 3, '22.00'),
      recruit('rec', '21.00'),
    ];
    const out = calculatePoints(rows, settings());
    // The recruit is placed 2nd of three (20.00, 21.00, 22.00): 17. m3 keeps its meet rank 3: 16.
    expect(out.map(r => r.id)).toEqual(['m1', 'rec', 'm3']);
    expect(pointsById(out)).toEqual({ m1: 20, rec: 17, m3: 16 });
    // At an equal time the meet swim is listed first.
    const tie = calculatePoints(
      [swim('m1', 'T1', E1, 1, '20.00'), recruit('rec', '20.00')],
      settings()
    );
    expect(tie.map(r => r.id)).toEqual(['m1', 'rec']);
  });
});

describe('meet event labels', () => {
  const rowOf = (event: string): SwimmerResult => swim(`row-${event}`, 'T1', event, 1, '20.00');

  it('picks the label with the most rows', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => rowOf('Event 939 Boys 100 Yard Breaststroke')),
      ...Array.from({ length: 2 }, () => rowOf('Event 26 Men 100 Yard Breaststroke')),
    ];
    expect(chooseMeetEventLabels(rows, () => 'bs').get('bs')).toBe('Event 939 Boys 100 Yard Breaststroke');
  });

  it('on equal counts picks the lowest event number, in either row order', () => {
    const a = rowOf('Event 26 Men 100 Yard Breaststroke');
    const b = rowOf('Event 939 Boys 100 Yard Breaststroke');
    expect(chooseMeetEventLabels([a, b], () => 'bs').get('bs')).toBe('Event 26 Men 100 Yard Breaststroke');
    expect(chooseMeetEventLabels([b, a], () => 'bs').get('bs')).toBe('Event 26 Men 100 Yard Breaststroke');
  });

  it('on equal counts and numbers picks the smallest label, in either row order', () => {
    const women = rowOf('Event 7 Women 50 Yard Freestyle');
    const men = rowOf('Event 7 Men 50 Yard Freestyle');
    expect(chooseMeetEventLabels([women, men], () => 'free').get('free')).toBe('Event 7 Men 50 Yard Freestyle');
    expect(chooseMeetEventLabels([men, women], () => 'free').get('free')).toBe('Event 7 Men 50 Yard Freestyle');
  });

  it('a row with no key is left out, and an unnumbered label ranks after a numbered one', () => {
    const rows = [rowOf('50 Yard Freestyle'), rowOf('Event 8 Men 50 Yard Freestyle'), rowOf('skip me')];
    const map = chooseMeetEventLabels(rows, r => (r.event === 'skip me' ? null : 'free'));
    expect([...map.keys()]).toEqual(['free']);
    expect(map.get('free')).toBe('Event 8 Men 50 Yard Freestyle');
    expect(chooseMeetEventLabels(undefined, () => 'x').size).toBe(0);
  });

  it('keeps one label per key', () => {
    const rows = [rowOf('Event 1 Men 50 Yard Freestyle'), rowOf('Event 2 Men 100 Yard Freestyle')];
    const map = chooseMeetEventLabels(rows, r => r.event);
    expect(map.size).toBe(2);
  });
});

describe('where a time would place in a meet', () => {
  const FREE50 = 'Event 8 Men 50 Yard Freestyle';
  const field = (): SwimmerResult[] => [
    swim('a', 'T1', FREE50, 1, '20.00', { name: 'Ann' }),
    swim('b', 'T2', FREE50, 2, '21.00', { name: 'Bea' }),
    swim('c', 'T3', FREE50, 3, '22.00', { name: 'Cy' }),
  ];

  it('is null when there is no scored individual field', () => {
    expect(buildMeetPlaceField(undefined, Gender.MEN)).toBeNull();
    expect(buildMeetPlaceField([], Gender.MEN)).toBeNull();
    // Only prelims: the round is not scored, so there is no field.
    expect(
      buildMeetPlaceField(
        [swim('p', 'T1', FREE50, 1, '20.00', { roundSwam: 'Preliminaries' })],
        Gender.MEN
      )
    ).toBeNull();
    // Only relays, time trials and diving: none can place a time.
    expect(
      buildMeetPlaceField(
        [
          swim('r', 'T1', E2, 1, '1:20.00', { isRelay: true }),
          swim('t', 'T1', FREE50, 1, '20.00', { isTimeTrial: true }),
          swim('d', 'T1', 'Event 15 Men 1m Diving', 1, '300.00'),
        ],
        Gender.MEN
      )
    ).toBeNull();
    // Another gender only.
    expect(buildMeetPlaceField(field(), Gender.WOMEN)).toBeNull();
  });

  it('places a time one behind the swims strictly faster than it', () => {
    const f = buildMeetPlaceField(field(), Gender.MEN);
    expect(f).not.toBeNull();
    expect(f?.placeFor(FREE50, 19.5)).toEqual({ place: 1, fieldSize: 3, meetEvent: FREE50 });
    expect(f?.placeFor(FREE50, 20.5)).toEqual({ place: 2, fieldSize: 3, meetEvent: FREE50 });
    expect(f?.placeFor(FREE50, 21.5)?.place).toBe(3);
    expect(f?.placeFor(FREE50, 30)?.place).toBe(4);
    // An exact tie shares the place of the swim it equals.
    expect(f?.placeFor(FREE50, 21)?.place).toBe(2);
    expect(f?.placeFor(FREE50, 20)?.place).toBe(1);
  });

  it('matches the event by identity, so a short label finds the meet label', () => {
    const f = buildMeetPlaceField(field(), Gender.MEN);
    expect(f?.placeFor('50 Free', 20.5)).toEqual({ place: 2, fieldSize: 3, meetEvent: FREE50 });
    expect(f?.events.size).toBe(1);
    expect(f?.placeFor('100 Yard Backstroke', 20.5)).toBeNull();
  });

  it('is null for a time that is not usable', () => {
    const f = buildMeetPlaceField(field(), Gender.MEN);
    expect(f?.placeFor(FREE50, 0)).toBeNull();
    expect(f?.placeFor(FREE50, -1)).toBeNull();
    expect(f?.placeFor(FREE50, Number.NaN)).toBeNull();
    expect(f?.placeFor(FREE50, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('leaves the swimmer own rows out of the field, and is null when that empties it', () => {
    const f = buildMeetPlaceField(field(), Gender.MEN);
    // Without Ann (20.00): field 21.00, 22.00. A 20.50 is now 1st of 2.
    expect(f?.placeFor(FREE50, 20.5, r => r.name === 'Ann')).toEqual({
      place: 1,
      fieldSize: 2,
      meetEvent: FREE50,
    });
    expect(f?.placeFor(FREE50, 20.5, () => true)).toBeNull();
  });

  it('ignores another gender, a metric course, and rows of a scored round only', () => {
    const rows = [
      ...field(),
      swim('w', 'T9', FREE50, 1, '10.00', { gender: Gender.WOMEN }),
      swim('c', 'T9', FREE50, 1, '10.00', { roundSwam: 'C Final' }),
      swim('m', 'T9', 'Event 9 Men 100 Meter Freestyle', 1, '50.00'),
    ];
    const f = buildMeetPlaceField(rows, Gender.MEN);
    expect(f?.placeFor(FREE50, 20.5)?.fieldSize).toBe(3);
    // The metric-course event holds no SCY field.
    expect(f?.placeFor('Event 9 Men 100 Meter Freestyle', 50)).toBeNull();
  });
});

describe('second pass: survivors of the first mutation run', () => {
  const rowOf = (event: string): SwimmerResult => swim(`row-${event}`, 'T1', event, 1, '20.00');

  it('a recruit with no recorded gender is placed against the meet rows of every gender', () => {
    const meetRows = [
      swim('m1', 'T1', E1, 1, '20.00'),
      swim('m2', 'T2', E1, 2, '21.00'),
      swim('w1', 'T3', E1, 3, '19.00', { gender: Gender.WOMEN }),
    ];
    const rec = swim('rec', 'Rec', E1, 0, '30.00', { isRecruit: true, gender: undefined });
    // Three comparators (20.00, 21.00 and the women's 19.00) are strictly faster: 4th.
    expect(prepareRecruitsForScoring(meetRows, [rec])[0]?.rank).toBe(4);
  });

  it('a larger label with a higher event number beats a smaller label with a lower number', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => swim(`big${i}`, 'T1', 'Event 939 Boys 100 Yard Breaststroke', 1, '20.00')),
      rowOf('Event 26 Men 100 Yard Breaststroke'),
    ];
    // Labels are met larger first, so the smaller, lower-numbered label arrives second.
    expect(chooseMeetEventLabels(rows, () => 'bs').get('bs')).toBe('Event 939 Boys 100 Yard Breaststroke');
  });

  it('on one event number the label with more rows wins, not the smaller label', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => swim(`w${i}`, 'T1', 'Event 7 Women 50 Yard Freestyle', 1, '20.00')),
      rowOf('Event 7 Men 50 Yard Freestyle'),
    ];
    // Both labels are event 7. "Men" sorts before "Women", but "Women" has three rows to one.
    expect(chooseMeetEventLabels(rows, () => 'free').get('free')).toBe('Event 7 Women 50 Yard Freestyle');
  });

  it('a lower event number beats a smaller label text: Event 9 comes before Event 10', () => {
    const nine = rowOf('Event 9 Men 50 Yard Freestyle');
    const ten = rowOf('Event 10 Men 50 Yard Freestyle');
    // As text, "Event 10 ..." sorts before "Event 9 ...". As a number, 9 is lower.
    expect(chooseMeetEventLabels([nine, ten], () => 'free').get('free')).toBe('Event 9 Men 50 Yard Freestyle');
    expect(chooseMeetEventLabels([ten, nine], () => 'free').get('free')).toBe('Event 9 Men 50 Yard Freestyle');
  });

  it('lists scored rows by round, then rank, then time; recruits fall between them by time', () => {
    const rows = [
      swim('pre', 'T1', E1, 1, '18.00', { roundSwam: 'Preliminaries' }),
      swim('b1', 'T2', E1, 1, '19.00', { roundSwam: 'B Final' }),
      swim('a3x', 'T3', E1, 3, '23.00'),
      // Rank 2 swims faster than rank 1: the rank decides, not the time.
      swim('a2', 'T4', E1, 2, '19.90'),
      swim('a3y', 'T5', E1, 3, '22.00'),
      swim('a1', 'T6', E1, 1, '20.00'),
      // Two recruits, slower first in the input.
      swim('r40', 'Rec', E1, 0, '40.00', { isRecruit: true }),
      swim('r30', 'Rec', E1, 0, '30.00', { isRecruit: true }),
    ];
    const out = calculatePoints(rows, settings());
    // A final by rank: a1 (1), a2 (2), then rank 3 by time: a3y 22.00, a3x 23.00. B final, then prelim.
    // Recruits by time: r30 then r40. The loop takes meet rows while their time is at most the
    // recruit's. a1 (20.00), a2 (19.90), a3y (22.00), a3x (23.00), b1 (19.00) and pre (18.00) are
    // all at most 30.00, so all six come before r30.
    expect(out.map(r => r.id)).toEqual(['a1', 'a2', 'a3y', 'a3x', 'b1', 'pre', 'r30', 'r40']);
  });

  it('a recruit slots in once the meet rows at or under its time are listed', () => {
    const rows = [
      swim('a1', 'T1', E1, 1, '20.00'),
      swim('a2', 'T2', E1, 2, '25.00'),
      swim('a3', 'T3', E1, 3, '30.00'),
      swim('rMid', 'Rec', E1, 0, '26.00', { isRecruit: true }),
    ];
    // a1 (20.00) and a2 (25.00) are at most 26.00; a3 (30.00) is not.
    expect(calculatePoints(rows, settings()).map(r => r.id)).toEqual(['a1', 'a2', 'rMid', 'a3']);
  });

  it('with the relay-pool flag off, relay legs take no scorer slot in a meet-wide pool', () => {
    const legs = ['L1', 'L2', 'L3', 'L4'];
    // Pool of 4, flag unset. The relay is the earlier event; if its legs were seeded into the pool
    // they would fill all four slots and refuse the later individual. They are not: A1 scores 20
    // (1st, individual table) and the relay scores 40 / 4 = 10 per leg.
    const out = calculatePoints(
      [
        ...relay('Alpha', 'Event 1 Men 200 Yard Freestyle Relay', 1, '1:20.00', legs),
        swim('A1', 'Alpha', E3, 1, '1:50.00'),
      ],
      settings({ scorerCapScope: 'meet', maxIndividualScorersPerTeam: 4 })
    );
    expect(pointsById(out)).toMatchObject({ A1: 20, 'Alpha-L1': 10, 'Alpha-L4': 10 });
  });

  it('the conference passed with the call overrides generic caps (NSISC: 18 scorers, meet wide)', () => {
    const rows = [
      swim('s1', 'T1', E1, 1, '20.00'),
      swim('s2', 'T1', E1, 2, '21.00'),
      swim('s3', 'T1', E1, 3, '22.00'),
    ];
    const generic = settings({ maxIndividualScorersPerTeam: 2, scorerCapScope: 'event' });
    // Cap 2 per event: ranks 1 and 2 score 20 + 17; rank 3 is over the cap.
    expect(pointsById(calculatePoints(rows, generic))).toEqual({ s1: 20, s2: 17, s3: 0 });
    // The NSISC rule is 18 scorers across the meet, so all three score: 20 + 17 + 16.
    expect(pointsById(calculatePoints(rows, generic, { conferenceForMerge: 'NSISC' }))).toEqual({
      s1: 20,
      s2: 17,
      s3: 16,
    });
  });
});
