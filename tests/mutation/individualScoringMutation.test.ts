/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mutation-testing follow-up for `individualScoring.ts` (plan item T6). Each case
 * kills Stryker mutants that survived the suite as it stood on 2026-10-14 (see
 * docs/reference/MUTATION_RESULTS_2026-10-14.md).
 *
 * Every expected number is worked by hand from the NCAA individual 16-place
 * table (Rule 7-1-1), A final = places 1-8, B final = places 9-16:
 *
 *   place   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16
 *   points 20  17  16  15  14  13  12  11   9   7   6   5   4   3   2   1
 *
 * A tie shares the points of every place it spans, over the number of entries.
 * `runIndividualScoringForEvent` is called directly so each output row is seen.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../../packages/core/src/types';
import {
  isTimedFinalDistanceHeat,
  runIndividualScoringForEvent,
} from '../../packages/core/src/lib/individualScoring';
import { getOrCreateMeetState, type TeamMeetState } from '../../packages/core/src/lib/meetPool';

const NCAA_16 = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];
const FREE = 'Event 3 Men 100 Yard Freestyle';
const MILE = 'Event 20 Men 1650 Yard Freestyle';
const DIVE = 'Event 15 Men 1m Diving';

function settings(extra: Partial<ScoringSettings> = {}): ScoringSettings {
  return {
    scoringPoints: NCAA_16,
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    aFinalBracketSize: 8,
    ...extra,
  };
}

type RowOptions = Partial<SwimmerResult> & { round?: string };

/** One swim. `id` is `<name>|<round>|<rank>`, so one athlete can hold rows in two rounds. */
function row(name: string, team: string, rank: number | undefined, time: string, o: RowOptions = {}): SwimmerResult {
  const { round, ...rest } = o;
  const roundSwam = round ?? 'A Final';
  return {
    id: `${name}|${roundSwam}|${String(rank)}`,
    name,
    team,
    rank: rank as number,
    time,
    finalsTime: time,
    classYear: 'JR',
    event: FREE,
    roundSwam,
    points: 0,
    gender: Gender.MEN,
    ...rest,
  } as SwimmerResult;
}

function run(
  rows: SwimmerResult[],
  extra: Partial<ScoringSettings> = {},
  pool?: Map<string, TeamMeetState>
): SwimmerResult[] {
  return runIndividualScoringForEvent(rows, settings(extra), pool ?? new Map(), pool !== undefined, undefined);
}

/** Points by row id. */
function byId(out: SwimmerResult[]): Record<string, number | string> {
  return Object.fromEntries(out.map(r => [r.id, r.points]));
}

/** Points by athlete name (one row per name in the case). */
function byName(out: SwimmerResult[]): Record<string, number | string> {
  return Object.fromEntries(out.map(r => [r.name, r.points]));
}

describe('which event rows score as a timed-final distance heat', () => {
  it('needs a distance event and a timed-final round', () => {
    expect(isTimedFinalDistanceHeat(MILE, 'Finals')).toBe(true);
    expect(isTimedFinalDistanceHeat('Event 8 Women 1000 Yard Freestyle', 'Finals')).toBe(true);
    expect(isTimedFinalDistanceHeat('Event 8 Women 1500 Meter Freestyle', 'Finals')).toBe(true);
    expect(isTimedFinalDistanceHeat('Event 8 Women 800 Meter Freestyle', 'Finals')).toBe(true);
    expect(isTimedFinalDistanceHeat('Event 8 Women 10000 Meter Freestyle', 'Finals')).toBe(true);
    expect(isTimedFinalDistanceHeat('Event 8 Women Timed Final 400 Free', 'Finals')).toBe(true);
    expect(isTimedFinalDistanceHeat(MILE, 'A Final')).toBe(false);
    expect(isTimedFinalDistanceHeat(MILE, 'Preliminaries')).toBe(false);
    expect(isTimedFinalDistanceHeat(FREE, 'Finals')).toBe(false);
    expect(isTimedFinalDistanceHeat(undefined, 'Finals')).toBe(false);
  });

  it('a session scores as a timed final only when every row is a timed-final heat', () => {
    // Rank 1 is a DQ, rank 2 and rank 3 are clean. As a timed final the ladder skips the DQ, so
    // rank 2 takes the 1st-place 20. As a placed event rank 2 is 2nd place: 17.
    const placed = run([
      row('Dee', 'Alpha', 1, 'DQ', { event: MILE, round: 'Finals' }),
      row('Eve', 'Bravo', 2, '15:00.00', { event: MILE, round: 'Finals' }),
      row('Fay', 'Charlie', 3, '15:10.00', { event: MILE, round: 'A Final' }),
    ]);
    expect(byName(placed)).toEqual({ Dee: 0, Eve: 17, Fay: 16 });

    const timed = run([
      row('Dee', 'Alpha', 1, 'DQ', { event: MILE, round: 'Finals' }),
      row('Eve', 'Bravo', 2, '15:00.00', { event: MILE, round: 'Finals' }),
      row('Fay', 'Charlie', 3, '15:10.00', { event: MILE, round: 'Finals' }),
    ]);
    expect(byName(timed)).toEqual({ Dee: 0, Eve: 20, Fay: 17 });
  });

  it('an empty event scores nothing and does not throw', () => {
    expect(run([])).toEqual([]);
  });
});

describe('placed events: rank decides the row', () => {
  it('scores each rank from the table, A final and B final, and 0 with no rank', () => {
    const out = run([
      row('A1', 'T1', 1, '20.00'),
      row('A2', 'T2', 2, '20.50'),
      row('A3', 'T3', 3, '21.00'),
      row('B1', 'T4', 1, '22.00', { round: 'B Final' }),
      row('N1', 'T5', undefined, '30.00'),
    ]);
    // A: 20, 17, 16. B in-heat 1 is 9th place: 9. No rank: no place.
    expect(byName(out)).toEqual({ A1: 20, A2: 17, A3: 16, B1: 9, N1: 0 });
  });

  it('a tie takes the mean of the places it spans, and the next rank is rank-based', () => {
    // Two at rank 2: (17 + 16) / 2 = 16.5. Rank 4 is 4th place: 15.
    const out = run([
      row('A1', 'T1', 1, '20.00'),
      row('A2', 'T2', 2, '20.50'),
      row('A3', 'T3', 2, '20.50'),
      row('A4', 'T4', 4, '21.00'),
    ]);
    expect(byName(out)).toEqual({ A1: 20, A2: 16.5, A3: 16.5, A4: 15 });
  });

  it('a disqualified row in a tie group is not in the divisor', () => {
    // X is a DQ written at rank 1 with Y. Only Y holds the place: 20, not (20 + 17) / 2.
    const out = run([row('X', 'T1', 1, 'DQ'), row('Y', 'T2', 1, '20.00')]);
    expect(out).toHaveLength(2);
    expect(byName(out)).toEqual({ X: 0, Y: 20 });
  });

  it('one exhibition row removes its whole tie group from the ladder', () => {
    // X (exhibition) and Y share rank 1: both 0. Rank 2 is still 2nd place: 17.
    const out = run([
      row('X', 'T1', 1, '20.00', { isExhibition: true }),
      row('Y', 'T2', 1, '20.00'),
      row('Z', 'T3', 2, '20.50'),
    ]);
    expect(byName(out)).toEqual({ X: 0, Y: 0, Z: 17 });
  });

  it('a time trial scores 0, but a Boys/Girls championship event scores', () => {
    const trial = run([
      row('X', 'T1', 1, '20.00', { isTimeTrial: true }),
      row('Y', 'T2', 1, '20.00'),
      row('Z', 'T3', 2, '20.50'),
    ]);
    // The group holding the time trial is removed together: X 0, Y 0. Z: 17.
    expect(byName(trial)).toEqual({ X: 0, Y: 0, Z: 17 });

    const boys = 'Event 9 Boys 100 Yard Freestyle';
    const champ = run([
      row('X', 'T1', 1, '20.00', { isTimeTrial: true, event: boys }),
      row('Z', 'T3', 2, '20.50', { event: boys }),
    ]);
    expect(byName(champ)).toEqual({ X: 20, Z: 17 });
  });

  it('an unscored round holds no points', () => {
    const out = run([row('C1', 'T1', 1, '20.00', { round: 'C Final' }), row('A1', 'T2', 1, '20.00')]);
    expect(byName(out)).toEqual({ C1: 0, A1: 20 });
  });

  it('a place past the table scores 0, and a tie spanning its end keeps the divisor', () => {
    // Rank 17 has no row. Two at rank 16: (1 + nothing) / 2 = 0.5 each.
    const past = run([row('P', 'T1', 17, '30.00')]);
    expect(byName(past)).toEqual({ P: 0 });
    const tail = run([row('P', 'T1', 16, '30.00'), row('Q', 'T2', 16, '30.00')]);
    expect(byName(tail)).toEqual({ P: 0.5, Q: 0.5 });
  });

  it('an unranked row is its own group, scored 0', () => {
    const out = run([row('N1', 'T1', undefined, '30.00'), row('N2', 'T2', undefined, '30.00')]);
    expect(byName(out)).toEqual({ N1: 0, N2: 0 });
    expect(out).toHaveLength(2);
  });
});

describe('the per-team cap on scorers in an event', () => {
  it('the best-placed swimmers of a team score, in place order whatever the row order', () => {
    // Cap 2. Alpha is 1st, 2nd and 3rd; Bravo is 4th. Rows arrive 3rd, 4th, 1st, 2nd.
    // Alpha: 20, 17, third over the cap: 0. Bravo keeps its own place, 4th: 15.
    const out = run(
      [
        row('A3', 'Alpha', 3, '21.00'),
        row('B1', 'Bravo', 4, '21.50'),
        row('A1', 'Alpha', 1, '20.00'),
        row('A2', 'Alpha', 2, '20.50'),
      ],
      { maxIndividualScorersPerTeam: 2 }
    );
    expect(byName(out)).toEqual({ A1: 20, A2: 17, A3: 0, B1: 15 });
  });

  it('a tie that straddles the cap gives the slot to the faster swimmer, the share unchanged', () => {
    // Cap 1. A1 24.00 and A2 25.00 tie for 1st: share (20 + 17) / 2 = 18.5. The slot goes to A1.
    // A2 forfeits the share (it is not handed to anyone). Bravo is 3rd: 16.
    const out = run(
      [row('A2', 'Alpha', 1, '25.00'), row('A1', 'Alpha', 1, '24.00'), row('B1', 'Bravo', 3, '26.00')],
      { maxIndividualScorersPerTeam: 1 }
    );
    expect(byName(out)).toEqual({ A1: 18.5, A2: 0, B1: 16 });
  });

  it('two groups of one tier at one rank are ordered by time for the cap', () => {
    // Rounds "A Final" and "Championship" are both tier A, so both rank 1 rows are 1st place.
    // Cap 1, one team: the 24.00 takes the slot (20) and the 25.00 is over the cap (0).
    const out = run(
      [
        row('Slow', 'Alpha', 1, '25.00', { round: 'A Final' }),
        row('Fast', 'Alpha', 1, '24.00', { round: 'Championship' }),
      ],
      { maxIndividualScorersPerTeam: 1 }
    );
    expect(byName(out)).toEqual({ Slow: 0, Fast: 20 });
  });

  it('a meet-wide pool carries the cap from one event to the next', () => {
    // Pool of 2 per team across the meet. Event 1: A1 and A2 enter the pool. Event 2: A3 is a
    // third name and is refused (0); A1 is already in the pool and scores (1st = 20).
    const pool = new Map<string, TeamMeetState>();
    const cap = { maxIndividualScorersPerTeam: 2, scorerCapScope: 'meet' as const };
    const first = run([row('A1', 'Alpha', 1, '20.00'), row('A2', 'Alpha', 2, '20.50')], cap, pool);
    expect(byName(first)).toEqual({ A1: 20, A2: 17 });

    const EVENT_2 = 'Event 5 Men 200 Yard Freestyle';
    const second = run(
      [
        row('A3', 'Alpha', 1, '1:40.00', { event: EVENT_2 }),
        row('A1', 'Alpha', 2, '1:41.00', { event: EVENT_2 }),
      ],
      cap,
      pool
    );
    expect(byName(second)).toEqual({ A3: 0, A1: 17 });
    expect([...getOrCreateMeetState(pool, 'Alpha', Gender.MEN).poolWeights.keys()].sort()).toEqual(['a1', 'a2']);
  });

  it('a prelim dive by a diver who dove the final scores nothing and spends no slot', () => {
    // Cap 2, team Alpha. D1: final 1st (20) and a prelim row at prelim rank 1. D3 prelim rank 2.
    // The D1 prelim row is blocked (0) and must not take a slot, so D3 still fits: 2nd place, 17.
    const out = run(
      [
        row('D1', 'Alpha', 1, '300.00', { event: DIVE, round: 'A Final' }),
        row('D1', 'Alpha', 1, '290.00', { event: DIVE, round: 'Preliminaries' }),
        row('D3', 'Alpha', 2, '280.00', { event: DIVE, round: 'Preliminaries' }),
      ],
      { maxIndividualScorersPerTeam: 2 }
    );
    expect(byId(out)).toEqual({
      'D1|A Final|1': 20,
      'D1|Preliminaries|1': 0,
      'D3|Preliminaries|2': 17,
    });
  });

  it('a prelim dive scores when the diver has no final dive in the event', () => {
    const out = run([row('D4', 'Alpha', 1, '300.00', { event: DIVE, round: 'Preliminaries' })]);
    expect(byName(out)).toEqual({ D4: 20 });
  });
});

describe('the per-event cap in a placed event: more orderings and the pool flag', () => {
  it('a per-event cap does not touch the meet-wide pool', () => {
    const states = new Map<string, TeamMeetState>();
    runIndividualScoringForEvent(
      [row('A1', 'Alpha', 1, '20.00'), row('A2', 'Alpha', 2, '20.50')],
      settings({ maxIndividualScorersPerTeam: 2 }),
      states,
      false,
      undefined
    );
    expect(getOrCreateMeetState(states, 'Alpha', Gender.MEN).poolWeights.size).toBe(0);

    const none = new Map<string, TeamMeetState>();
    runIndividualScoringForEvent([row('A1', 'Alpha', 1, '20.00')], settings(), none, false, undefined);
    expect(getOrCreateMeetState(none, 'Alpha', Gender.MEN).poolWeights.size).toBe(0);
  });

  it('a blank or missing team is the pool team Unknown', () => {
    for (const team of ['', '  ', undefined as unknown as string]) {
      const states = new Map<string, TeamMeetState>();
      getOrCreateMeetState(states, 'Unknown', Gender.MEN).poolWeights.set('x', 1);
      const out = runIndividualScoringForEvent(
        [row('S', team, 1, '20.00')],
        settings({ maxIndividualScorersPerTeam: 1, scorerCapScope: 'meet' }),
        states,
        true,
        undefined
      );
      // Unknown already holds its one scorer, x, so S is refused.
      expect(byName(out)).toEqual({ S: 0 });
    }
  });

  it('a blank cell in the place table scores nothing for that place', () => {
    // [20, blank, 16]: 2nd place has no value; 1st and 3rd keep theirs.
    const out = run(
      [row('P1', 'T1', 1, '20.00'), row('P2', 'T2', 2, '20.50'), row('P3', 'T3', 3, '21.00')],
      { scoringPoints: [20, null as unknown as number, 16] }
    );
    expect(byName(out)).toEqual({ P1: 20, P2: 0, P3: 16 });
  });

  it('a B final swimmer is placed after an A final swimmer whatever the row order', () => {
    // Cap 1, Alpha. B-final in-heat 1 (9th place, 9) is listed first; A final 3rd (16) second.
    // The A group is processed first, so A takes the slot: 16, and the B row is over: 0.
    const out = run(
      [row('Bf', 'Alpha', 1, '22.00', { round: 'B Final' }), row('Af', 'Alpha', 3, '21.00')],
      { maxIndividualScorersPerTeam: 1 }
    );
    expect(byName(out)).toEqual({ Bf: 0, Af: 16 });
  });

  it('rank outranks time when ordering swimmers for the cap', () => {
    // Cap 1. The swimmer ranked 2nd has the faster clock and is listed first.
    // Rank decides: 1st scores 20, 2nd is over the cap.
    const out = run(
      [row('Second', 'Alpha', 2, '20.00'), row('First', 'Alpha', 1, '20.50')],
      { maxIndividualScorersPerTeam: 1 }
    );
    expect(byName(out)).toEqual({ Second: 0, First: 20 });
  });
});

describe('over-the-place-cap ordering and what holds no place', () => {
  const cap1 = { maxIndividualScorersPerTeamPerEvent: 1 } as const;

  it('the cap is applied in place order, not row order', () => {
    // Cap 1, Alpha. Rows listed 5th, 1st, 3rd. 1st takes the slot: 20; the rest are over: 0.
    const out = run(
      [row('A5', 'Alpha', 5, '22.00'), row('A1', 'Alpha', 1, '20.00'), row('A3', 'Alpha', 3, '21.00')],
      cap1
    );
    expect(byName(out)).toEqual({ A5: 0, A1: 20, A3: 0 });
  });

  it('an A final place is taken before a B final place', () => {
    // A final 3rd (16) is placed ahead of B-final in-heat 1: Af scores, Bf is over the cap.
    const out = run(
      [row('Bf', 'Alpha', 1, '22.00', { round: 'B Final' }), row('Af', 'Alpha', 3, '21.00')],
      cap1
    );
    expect(byName(out)).toEqual({ Bf: 0, Af: 16 });
  });

  it('with equal rank and tier the faster swimmer takes the slot, before name order', () => {
    // "A Final" and "Championship" are both tier A and both rank 1, in different groups.
    // Zed is faster than Aaa. Cap 1: Zed takes it (20). Aaa, first by name, is over: 0.
    const out = run(
      [
        row('Aaa', 'Alpha', 1, '25.00', { round: 'A Final' }),
        row('Zed', 'Alpha', 1, '24.00', { round: 'Championship' }),
      ],
      cap1
    );
    expect(byName(out)).toEqual({ Aaa: 0, Zed: 20 });
  });

  it('a finalist who also swam a scoring prelim is one contestant', () => {
    // 1650: prelims score in a distance event. Cap 1. S1 is 1st in the final (20) and has a
    // prelim row at prelim rank 2 (2nd place: 17). One athlete, one slot: neither row is over.
    const out = run(
      [
        row('S1', 'Alpha', 1, '15:00.00', { event: MILE, round: 'A Final' }),
        row('S1', 'Alpha', 2, '15:10.00', { event: MILE, round: 'Preliminaries' }),
      ],
      cap1
    );
    expect(byId(out)).toEqual({ 'S1|A Final|1': 20, 'S1|Preliminaries|2': 17 });
  });

  it('removal: a blocked prelim dive holds no place and does not move other teams up', () => {
    // Cap 1, removed-from-consideration. Alpha D1 is 1st in the final, D2 is 2nd (over the cap, so
    // removed). D2 also has a prelim row at prelim rank 1; it is blocked (D2 has a final dive) and
    // holds no place, so it is not removed and Bravo's D3, prelim rank 2, is still 2nd: 17.
    const out = run(
      [
        row('D1', 'Alpha', 1, '300.00', { event: DIVE, round: 'A Final' }),
        row('D2', 'Alpha', 2, '290.00', { event: DIVE, round: 'A Final' }),
        row('D2', 'Alpha', 1, '250.00', { event: DIVE, round: 'Preliminaries' }),
        row('D3', 'Bravo', 2, '240.00', { event: DIVE, round: 'Preliminaries' }),
      ],
      { ...cap1, overCapPlaceBehavior: 'removed-from-consideration' }
    );
    expect(byId(out)['D3|Preliminaries|2']).toBe(17);
    // Not asserted: D2's own prelim row. Once D2's final row is removed, scoring no longer sees a
    // final dive for D2, so the prelim row scores 20. That reads as a defect (an over-cap diver
    // earns prelim points); it is reported in MUTATION_RESULTS_2026-10-14.md, not pinned here.
    expect(byId(out)['D1|A Final|1']).toBe(20);
    expect(byId(out)['D2|A Final|2']).toBe(0);
  });

  it('two spellings of one blank team share one cap', () => {
    const out = run([row('S1', '', 1, '20.00'), row('S2', ' ', 2, '20.50')], cap1);
    expect(byName(out)).toEqual({ S1: 20, S2: 0 });
  });
});

describe('timed-final distance events', () => {
  const mile = (name: string, team: string, rank: number | undefined, time: string, o: RowOptions = {}) =>
    row(name, team, rank, time, { event: MILE, round: 'Finals', ...o });

  it('the ladder follows finish order and skips swimmers who earn no points', () => {
    // Rank 1 is a DQ, rank 2 is exhibition, rank 3 is a time trial: none holds a ladder place.
    // Rank 4 is the first scoring finisher: 20. Rank 5: 17.
    const out = run([
      mile('Dq', 'T1', 1, 'DQ'),
      mile('Ex', 'T2', 2, '15:01.00', { isExhibition: true }),
      mile('Tt', 'T3', 3, '15:02.00', { isTimeTrial: true }),
      mile('Win', 'T4', 4, '15:03.00'),
      mile('Next', 'T5', 5, '15:04.00'),
    ]);
    expect(out).toHaveLength(5);
    expect(byName(out)).toEqual({ Dq: 0, Ex: 0, Tt: 0, Win: 20, Next: 17 });
  });

  it('a tie splits the places it spans and the next finisher takes the place after', () => {
    // Ranks 1, 2, 2, 4: 20, then (17 + 16) / 2 = 16.5 each, then 4th place: 15.
    const out = run([
      mile('A1', 'T1', 1, '15:00.00'),
      mile('A2', 'T2', 2, '15:01.00'),
      mile('A3', 'T3', 2, '15:01.00'),
      mile('A4', 'T4', 4, '15:02.00'),
    ]);
    expect(byName(out)).toEqual({ A1: 20, A2: 16.5, A3: 16.5, A4: 15 });
  });

  it('finishers with no rank follow the ranked ones, in time order', () => {
    // Ranks 1 and 2 take 20 and 17. Two unranked swims follow: 18:00.00 first (3rd place, 16),
    // then 19:00.00 (4th place, 15).
    const out = run([
      mile('Late', 'T4', undefined, '19:00.00'),
      mile('R2', 'T2', 2, '15:01.00'),
      mile('Early', 'T3', undefined, '18:00.00'),
      mile('R1', 'T1', 1, '15:00.00'),
    ]);
    expect(byName(out)).toEqual({ R1: 20, R2: 17, Early: 16, Late: 15 });
  });

  it('a team at its per-event cap scores nothing and holds no ladder place', () => {
    // Cap 2. Alpha is 1st, 2nd and 3rd; Bravo is 4th. Alpha's third swimmer scores 0 and does not
    // use up the 3rd-place value, so Bravo takes it: 16.
    const rows = [
      mile('A1', 'Alpha', 1, '15:00.00'),
      mile('A2', 'Alpha', 2, '15:01.00'),
      mile('A3', 'Alpha', 3, '15:02.00'),
      mile('B1', 'Bravo', 4, '15:03.00'),
    ];
    expect(byName(run(rows, { maxIndividualScorersPerTeam: 2 }))).toEqual({ A1: 20, A2: 17, A3: 0, B1: 16 });
  });

  it('the meet-wide pool gives the same ladder and fills across events', () => {
    const pool = new Map<string, TeamMeetState>();
    const rows = [
      mile('A1', 'Alpha', 1, '15:00.00'),
      mile('A2', 'Alpha', 2, '15:01.00'),
      mile('A3', 'Alpha', 3, '15:02.00'),
      mile('B1', 'Bravo', 4, '15:03.00'),
    ];
    const out = run(rows, { maxIndividualScorersPerTeam: 2, scorerCapScope: 'meet' }, pool);
    expect(byName(out)).toEqual({ A1: 20, A2: 17, A3: 0, B1: 16 });
    expect([...getOrCreateMeetState(pool, 'Alpha', Gender.MEN).poolWeights.keys()].sort()).toEqual(['a1', 'a2']);
  });

  it('a tie between same-team swimmers under the cap pays the fastest and spends both places', () => {
    // Cap 1. A1 (15:00.00) and A2 (15:00.10) tie for 1st: share (20 + 17) / 2 = 18.5. Only A1 is
    // admitted. The tie group used places 1 and 2, so the next finisher is 3rd place: 16.
    const out = run(
      [
        mile('A2', 'Alpha', 1, '15:00.10'),
        mile('A1', 'Alpha', 1, '15:00.00'),
        mile('B1', 'Bravo', 3, '15:05.00'),
      ],
      { maxIndividualScorersPerTeam: 1 }
    );
    expect(byName(out)).toEqual({ A1: 18.5, A2: 0, B1: 16 });
  });

  it('finish order is the rank, not the clock', () => {
    // Rank 1 carries the slower clock. The ladder follows rank: 20 to rank 1, 17 to rank 2.
    const out = run([mile('R2', 'T2', 2, '15:00.00'), mile('R1', 'T1', 1, '15:05.00')]);
    expect(byName(out)).toEqual({ R1: 20, R2: 17 });
  });

  it('a per-event cap leaves the meet-wide pool alone', () => {
    const states = new Map<string, TeamMeetState>();
    runIndividualScoringForEvent(
      [mile('A1', 'Alpha', 1, '15:00.00')],
      settings({ maxIndividualScorersPerTeam: 2 }),
      states,
      false,
      undefined
    );
    expect(getOrCreateMeetState(states, 'Alpha', Gender.MEN).poolWeights.size).toBe(0);
    const none = new Map<string, TeamMeetState>();
    runIndividualScoringForEvent([mile('A1', 'Alpha', 1, '15:00.00')], settings(), none, false, undefined);
    expect(getOrCreateMeetState(none, 'Alpha', Gender.MEN).poolWeights.size).toBe(0);
  });

  it('a blank team is the pool team Unknown', () => {
    for (const team of ['', '  ', undefined as unknown as string]) {
      const states = new Map<string, TeamMeetState>();
      getOrCreateMeetState(states, 'Unknown', Gender.MEN).poolWeights.set('x', 1);
      const out = runIndividualScoringForEvent(
        [mile('S', team, 1, '15:00.00')],
        settings({ maxIndividualScorersPerTeam: 1, scorerCapScope: 'meet' }),
        states,
        true,
        undefined
      );
      expect(byName(out)).toEqual({ S: 0 });
    }
  });

  it('a seventeenth finisher has no row in a 16-place table', () => {
    const rows = Array.from({ length: 17 }, (_, i) =>
      mile(`S${String(i + 1).padStart(2, '0')}`, `T${i + 1}`, i + 1, `15:${String(i).padStart(2, '0')}.00`)
    );
    const out = byName(run(rows));
    expect(out['S01']).toBe(20);
    expect(out['S16']).toBe(1);
    expect(out['S17']).toBe(0);
  });

  it('a diving table of its own applies to a diving event', () => {
    // Timed-final heat with a diving event is not a distance heat; check the placed path reads
    // divingPoints: [9, 4, 3]. Rank 1 = 9, rank 3 = 3, rank 4 has no row: 0.
    const out = run(
      [
        row('D1', 'T1', 1, '300.00', { event: DIVE }),
        row('D3', 'T3', 3, '280.00', { event: DIVE }),
        row('D4', 'T4', 4, '270.00', { event: DIVE }),
      ],
      { divingPoints: [9, 4, 3] }
    );
    expect(byName(out)).toEqual({ D1: 9, D3: 3, D4: 0 });
  });
});

describe('the per-team place cap in a dual-meet event', () => {
  const rows = (): SwimmerResult[] => [
    row('A1', 'Alpha', 1, '20.00'),
    row('B1', 'Bravo', 2, '20.50'),
    row('A2', 'Alpha', 3, '21.00'),
    row('A3', 'Alpha', 4, '21.50'),
    row('A4', 'Alpha', 5, '22.00'),
    row('B2', 'Bravo', 6, '22.50'),
  ];

  it('holds-place: the over-cap swimmer keeps the place and scores 0', () => {
    // Cap 3 per team. Alpha: 1st (20), 3rd (16), 4th (15), and its fourth swimmer is 5th: 0 but
    // the place is held, so Bravo's second swimmer is still 6th: 13.
    const out = run(rows(), { maxIndividualScorersPerTeamPerEvent: 3 });
    expect(out).toHaveLength(6);
    expect(byName(out)).toEqual({ A1: 20, B1: 17, A2: 16, A3: 15, A4: 0, B2: 13 });
  });

  it('removed-from-consideration: the places behind close up and ranks are restored in the output', () => {
    // Alpha's fourth swimmer (5th) is dropped, so Bravo's second moves up to 5th: 14.
    const out = run(rows(), {
      maxIndividualScorersPerTeamPerEvent: 3,
      overCapPlaceBehavior: 'removed-from-consideration',
    });
    expect(out).toHaveLength(6);
    expect(byName(out)).toEqual({ A1: 20, B1: 17, A2: 16, A3: 15, A4: 0, B2: 14 });
    // The rank on every row is the one the meet recorded, not the shifted one.
    expect(Object.fromEntries(out.map(r => [r.name, r.rank]))).toEqual({
      A1: 1,
      B1: 2,
      A2: 3,
      A3: 4,
      A4: 5,
      B2: 6,
    });
    // The removed row is listed last.
    expect(out[out.length - 1]?.name).toBe('A4');
  });

  it('removal advances only swimmers behind the removed one, and a tie-mate keeps its place', () => {
    // Cap 1, Alpha has 1st and 2nd. Alpha's 2nd (A2) is removed. Bravo's B1 is tied for 2nd with it:
    // nobody finished ahead of B1 among the removed, so B1 keeps rank 2 and the full 2nd place: 17.
    // B2 was 4th; one contestant removed ahead of it, so it moves to 3rd: 16.
    const out = run(
      [
        row('A1', 'Alpha', 1, '20.00'),
        row('A2', 'Alpha', 2, '20.50'),
        row('B1', 'Bravo', 2, '20.50'),
        row('B2', 'Bravo', 4, '21.00'),
      ],
      { maxIndividualScorersPerTeamPerEvent: 1, overCapPlaceBehavior: 'removed-from-consideration' }
    );
    // Bravo's B2 is also over its own cap of 1: it is removed, not moved.
    expect(byName(out)).toEqual({ A1: 20, A2: 0, B1: 17, B2: 0 });
  });

  it('removal never crosses a round: a B final is not promoted into the A final', () => {
    // Cap 1. Alpha's second A-final swimmer (A2, 2nd) is removed. The B final is a separate round:
    // Bravo's B-final swimmer (in-heat 1, 9th place = 9) keeps 9; it is not moved into the A final.
    const out = run(
      [
        row('A1', 'Alpha', 1, '20.00'),
        row('A2', 'Alpha', 2, '20.50'),
        row('B1', 'Bravo', 3, '20.60'),
        row('C1', 'Charlie', 1, '21.00', { round: 'B Final' }),
      ],
      { maxIndividualScorersPerTeamPerEvent: 1, overCapPlaceBehavior: 'removed-from-consideration' }
    );
    // A final: A1 20, A2 removed (0), B1 moves from 3rd to 2nd: 17. B final untouched: C1 = 9.
    expect(byName(out)).toEqual({ A1: 20, A2: 0, B1: 17, C1: 9 });
  });

  it('a swimmer who holds no place does not use one of the cap slots', () => {
    // Cap 2. Alpha: a DQ, an exhibition swim, a time trial, a C-final swim, and a swim with no rank
    // are all outside the cap. A2 and A3 then both fit: 2nd (17) and 3rd (16).
    const out = run(
      [
        row('Dq', 'Alpha', 1, 'DQ'),
        row('Ex', 'Alpha', 1, '20.00', { isExhibition: true, id: 'ex' }),
        row('Tt', 'Alpha', 1, '20.00', { isTimeTrial: true, id: 'tt' }),
        row('Cc', 'Alpha', 1, '20.00', { round: 'C Final' }),
        row('Nr', 'Alpha', undefined, '20.00'),
        row('A2', 'Alpha', 2, '20.50'),
        row('A3', 'Alpha', 3, '20.60'),
      ],
      { maxIndividualScorersPerTeamPerEvent: 2 }
    );
    expect(byName(out)).toMatchObject({ A2: 17, A3: 16 });
  });

  it('a championship-event time trial does hold a place', () => {
    // Cap 1 in a Boys event. The flagged swim is an ordinary final there, so it takes Alpha's slot.
    const boys = 'Event 9 Boys 100 Yard Freestyle';
    const out = run(
      [
        row('T1', 'Alpha', 1, '20.00', { isTimeTrial: true, event: boys }),
        row('T2', 'Alpha', 2, '20.50', { event: boys }),
      ],
      { maxIndividualScorersPerTeamPerEvent: 1 }
    );
    expect(byName(out)).toEqual({ T1: 20, T2: 0 });
  });

  it('a prelim dive by a diver who also dove the final holds no place, so it is no extra contestant', () => {
    // Cap 2, Alpha divers D1 (final 1st + prelim) and D2 (final 2nd) and D3 (final 3rd).
    // D1's prelim row does not hold a place. D3 is the third contestant: over the cap, 0.
    const out = run(
      [
        row('D1', 'Alpha', 1, '300.00', { event: DIVE, round: 'A Final' }),
        row('D2', 'Alpha', 2, '290.00', { event: DIVE, round: 'A Final' }),
        row('D3', 'Alpha', 3, '280.00', { event: DIVE, round: 'A Final' }),
      ],
      { maxIndividualScorersPerTeamPerEvent: 2 }
    );
    expect(byName(out)).toEqual({ D1: 20, D2: 17, D3: 0 });
  });

  it('counts a diver once when the diver has a prelim and a final row', () => {
    // Cap 2. D1 has a prelim and a final row (prelim rank 2 — no final dive blocks it here since
    // the prelim is a different diver row). D2 and D3 each one row. D1 spends one slot.
    const out = run(
      [
        row('D1', 'Alpha', 1, '300.00', { event: DIVE, round: 'A Final' }),
        row('D1', 'Alpha', 4, '250.00', { event: DIVE, round: 'Preliminaries' }),
        row('D2', 'Alpha', 2, '290.00', { event: DIVE, round: 'A Final' }),
      ],
      { maxIndividualScorersPerTeamPerEvent: 2 }
    );
    // D1 (1st) and D2 (2nd) both score; D1's prelim row is blocked by its own final dive: 0.
    expect(byId(out)).toEqual({ 'D1|A Final|1': 20, 'D1|Preliminaries|4': 0, 'D2|A Final|2': 17 });
  });

  it('equal ranks and times fall back to name order for who is over the cap', () => {
    // Cap 1, two Alpha swimmers tied at rank 1 with equal times: Amy comes before Beth.
    const out = run(
      [row('Beth', 'Alpha', 1, '20.00'), row('Amy', 'Alpha', 1, '20.00')],
      { maxIndividualScorersPerTeamPerEvent: 1 }
    );
    expect(byName(out)).toEqual({ Amy: 18.5, Beth: 0 });
  });

  it('diving has its own cap when the preset names one', () => {
    // Swimming cap 1, diving cap 2: two Alpha divers both score; two Alpha swimmers do not.
    const diving = run(
      [row('D1', 'Alpha', 1, '300.00', { event: DIVE }), row('D2', 'Alpha', 2, '290.00', { event: DIVE })],
      { maxIndividualScorersPerTeamPerEvent: 1, divingMaxScorersPerTeamPerEvent: 2 }
    );
    expect(byName(diving)).toEqual({ D1: 20, D2: 17 });

    const swimming = run([row('S1', 'Alpha', 1, '20.00'), row('S2', 'Alpha', 2, '20.50')], {
      maxIndividualScorersPerTeamPerEvent: 1,
      divingMaxScorersPerTeamPerEvent: 2,
    });
    expect(byName(swimming)).toEqual({ S1: 20, S2: 0 });

    // With no diving cap named, the swimming cap applies to diving too.
    const shared = run(
      [row('D1', 'Alpha', 1, '300.00', { event: DIVE }), row('D2', 'Alpha', 2, '290.00', { event: DIVE })],
      { maxIndividualScorersPerTeamPerEvent: 1 }
    );
    expect(byName(shared)).toEqual({ D1: 20, D2: 0 });
  });

  it('a cap of 1 is valid; a cap that is not a positive whole number is refused', () => {
    expect(() => run([row('A1', 'Alpha', 1, '20.00')], { maxIndividualScorersPerTeamPerEvent: 1 })).not.toThrow();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => run([row('A1', 'Alpha', 1, '20.00')], { maxIndividualScorersPerTeamPerEvent: bad })).toThrow(
        /maxIndividualScorersPerTeamPerEvent must be a positive integer/
      );
    }
    let message = '';
    try {
      run([row('A1', 'Alpha', 1, '20.00')], { maxIndividualScorersPerTeamPerEvent: 0 });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('NCAA Rule 7-1-1 reads "with only the best three contestants from each team');
    expect(message).toContain('scoring". Got 0. Omit the field for no cap.');
  });

  it('a diving cap that is not valid is refused for a diving event', () => {
    expect(() =>
      run([row('D1', 'Alpha', 1, '300.00', { event: DIVE })], { divingMaxScorersPerTeamPerEvent: 0 })
    ).toThrow(/divingMaxScorersPerTeamPerEvent must be a positive integer/);
  });

  it('a place cap with a meet-wide scorer pool is refused, and only that combination', () => {
    const one = [row('A1', 'Alpha', 1, '20.00')];
    let message = '';
    try {
      run(one, {
        maxIndividualScorersPerTeamPerEvent: 3,
        maxIndividualScorersPerTeam: 5,
        scorerCapScope: 'meet',
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('maxIndividualScorersPerTeamPerEvent (3)');
    expect(message).toContain('with a meet-wide scorer pool (maxIndividualScorersPerTeam=5');
    expect(message).toContain("scorerCapScope='meet'). Those two rules");
    expect(message).toContain('pool slot, and the NCAA rulebook settles neither. Use one or the other.');

    // A meet-scope pool with no numeric cap is not a pool.
    expect(() =>
      run(one, {
        maxIndividualScorersPerTeamPerEvent: 3,
        maxIndividualScorersPerTeam: 999,
        scorerCapScope: 'meet',
      })
    ).not.toThrow();
    // A cap on scorers with an event-scope pool is not meet-wide.
    expect(() =>
      run(one, {
        maxIndividualScorersPerTeamPerEvent: 3,
        maxIndividualScorersPerTeam: 5,
        scorerCapScope: 'event',
      })
    ).not.toThrow();
  });
});

describe('roster-gated scoring and rows that are not scored', () => {
  it('a swimmer off the scoring roster scores 0, and a whole group off it adds no rows twice', () => {
    const rows = [row('On', 'Alpha', 1, '20.00'), row('Off', 'Bravo', 2, '20.50')];
    const out = runIndividualScoringForEvent(
      rows,
      settings({ scorerEligibilityMode: 'roster' }),
      new Map(),
      false,
      { isScorer: name => name === 'On', rows: [] }
    );
    expect(out).toHaveLength(2);
    expect(byName(out)).toEqual({ On: 20, Off: 0 });

    // One roster swimmer in a tie of two: the share is still split by 2 (they did tie); only the
    // roster swimmer is paid: (20 + 17) / 2 = 18.5.
    const tied = runIndividualScoringForEvent(
      [row('On', 'Alpha', 1, '20.00'), row('Off', 'Alpha', 1, '20.00')],
      settings({ scorerEligibilityMode: 'roster' }),
      new Map(),
      false,
      { isScorer: name => name === 'On', rows: [] }
    );
    expect(tied).toHaveLength(2);
    expect(byName(tied)).toEqual({ On: 18.5, Off: 0 });
  });

  it('with no roster lookup the roster mode does not filter', () => {
    const out = runIndividualScoringForEvent(
      [row('Off', 'Bravo', 1, '20.00')],
      settings({ scorerEligibilityMode: 'roster' }),
      new Map(),
      false,
      undefined
    );
    expect(byName(out)).toEqual({ Off: 20 });
  });

  it('a blank team is the team Unknown for the cap', () => {
    // Cap 1. Two swimmers with "" and " " as team share the team Unknown: the first scores.
    const out = run([row('S1', '', 1, '20.00'), row('S2', ' ', 2, '20.50')], { maxIndividualScorersPerTeam: 1 });
    expect(byName(out)).toEqual({ S1: 20, S2: 0 });
  });

  it('whitespace on an event or round label does not split a tie group', () => {
    const out = run([
      row('A1', 'T1', 1, '20.00', { event: FREE, round: 'A Final' }),
      row('A2', 'T2', 1, '20.00', { event: `${FREE} `, round: ' A Final' }),
    ]);
    // One group of two at rank 1: (20 + 17) / 2 = 18.5 each.
    expect(byName(out)).toEqual({ A1: 18.5, A2: 18.5 });
  });
});

describe('second pass: survivors of the first mutation run', () => {
  const cap = (extra: Partial<ScoringSettings> = {}) => ({ maxIndividualScorersPerTeamPerEvent: 3, ...extra });

  it('blocked prelim dives hold no place, so a prelim-only diver is still inside the cap', () => {
    // Cap 3, Alpha. D1 and D2 dove the final (1st: 20, 2nd: 17) and also have prelim rows, which
    // score nothing and hold no place. D4 dove only the prelims, at prelim rank 3: that is the
    // team's 3rd contestant, inside the cap, and scores 3rd place: 16.
    const out = run(
      [
        row('D1', 'Alpha', 1, '300.00', { event: DIVE }),
        row('D1', 'Alpha', 1, '290.00', { event: DIVE, round: 'Preliminaries' }),
        row('D2', 'Alpha', 2, '280.00', { event: DIVE }),
        row('D2', 'Alpha', 2, '270.00', { event: DIVE, round: 'Preliminaries' }),
        row('D4', 'Alpha', 3, '260.00', { event: DIVE, round: 'Preliminaries' }),
      ],
      cap()
    );
    expect(byId(out)).toEqual({
      'D1|A Final|1': 20,
      'D1|Preliminaries|1': 0,
      'D2|A Final|2': 17,
      'D2|Preliminaries|2': 0,
      'D4|Preliminaries|3': 16,
    });
  });

  it('a prelim-only diver does hold a place: the 3rd contestant is over a cap of 2', () => {
    // Cap 2. D1 (final 1st) and D2 (final 2nd) fill the cap. D4 dove only the prelims, at prelim
    // rank 1: the team's 3rd contestant, over the cap: 0 (not the 20 a 1st would score).
    const out = run(
      [
        row('D1', 'Alpha', 1, '300.00', { event: DIVE }),
        row('D2', 'Alpha', 2, '280.00', { event: DIVE }),
        row('D4', 'Alpha', 1, '260.00', { event: DIVE, round: 'Preliminaries' }),
      ],
      cap({ maxIndividualScorersPerTeamPerEvent: 2 })
    );
    expect(byName(out)).toEqual({ D1: 20, D2: 17, D4: 0 });
  });

  it('removal: every removed rank ahead of a row moves it up, not only the last one', () => {
    // Cap 1, removed-from-consideration. Alpha keeps 1st (20); its 2nd and 3rd are removed.
    // Bravo was 4th with two places removed ahead of it: 2nd, 17.
    const out = run(
      [
        row('A1', 'Alpha', 1, '20.00'),
        row('A2', 'Alpha', 2, '20.10'),
        row('A3', 'Alpha', 3, '20.20'),
        row('B1', 'Bravo', 4, '20.30'),
      ],
      { maxIndividualScorersPerTeamPerEvent: 1, overCapPlaceBehavior: 'removed-from-consideration' }
    );
    expect(byName(out)).toEqual({ A1: 20, A2: 0, A3: 0, B1: 17 });
  });

  it('a row with no rank holds no place under the cap', () => {
    // Cap 3, Alpha: A final 1st (20) and 2nd (17), an unranked A-final row (no place, 0), and a
    // B final in-heat 1st (9th place: 9). The unranked row is no contestant, so the B swimmer is
    // the 3rd contestant, inside the cap.
    const out = run(
      [
        row('A1', 'Alpha', 1, '20.00'),
        row('A2', 'Alpha', 2, '20.50'),
        row('Au', 'Alpha', undefined, '21.00'),
        row('B1', 'Alpha', 1, '22.00', { round: 'B Final' }),
      ],
      cap()
    );
    expect(byName(out)).toEqual({ A1: 20, A2: 17, Au: 0, B1: 9 });
  });

  it('a round label with trailing whitespace is the same round for a tie', () => {
    const out = run([
      row('X', 'T1', 1, '20.00', { round: 'A Final' }),
      row('Y', 'T2', 1, '20.00', { round: 'A Final ' }),
    ]);
    // One group of two at rank 1: (20 + 17) / 2 = 18.5 each.
    expect(byName(out)).toEqual({ X: 18.5, Y: 18.5 });
  });

  it('timed final: swimmers with rank 0 take the next places in time order, one each', () => {
    const m = (name: string, team: string, rank: number, time: string) =>
      row(name, team, rank, time, { event: MILE, round: 'Finals' });
    const out = run([m('Z', 'T3', 1, '15:00.00'), m('X', 'T1', 0, '15:10.00'), m('Y', 'T2', 0, '15:20.00')]);
    // Z is 1st: 20. X and Y have no printed place; they follow by time, one place each:
    // 2nd (17) and 3rd (16). They are not one tie group, which would pay (17 + 16) / 2 each.
    expect(byName(out)).toEqual({ Z: 20, X: 17, Y: 16 });
  });
});
