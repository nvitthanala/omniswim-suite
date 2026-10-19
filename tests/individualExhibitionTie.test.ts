/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * User decision E2 (2026-10-16): an exhibition swim in a tied A/B-final group
 * scores nothing, and ONLY that swim. Every other swimmer in the group earns what
 * they would earn if the exhibition swimmer were absent. Before, one exhibition
 * row zeroed the whole tie group.
 *
 * The tie rule is the one rule (`tiedPlaceShare`, user decision U1): add the
 * points of the places the tie spans, divide by the number of SCORING entries.
 * Every scoring entry is ranked as if the exhibition entries were absent, so
 * the next scorer moves up (see `rankAsIfExhibitionAbsent`).
 *
 * Table used (NCAA 16-place, Rule 7-1-1): 20 17 16 15 14 13 12 11 | 9 7 6 5 4 3 2 1.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../packages/core/src/types';
import { runIndividualScoringForEvent } from '../packages/core/src/lib/individualScoring';
import { calculatePoints } from '../packages/core/src/lib/calculatePoints';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';

const NCAA_16 = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];
const FREE = 'Event 3 Men 100 Yard Freestyle';
const MILE = 'Event 20 Men 1650 Yard Freestyle';

const settings: ScoringSettings = {
  scoringPoints: NCAA_16,
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
};

type Opts = Partial<SwimmerResult> & { round?: string };

function row(name: string, team: string, rank: number, time: string, o: Opts = {}): SwimmerResult {
  const { round, ...rest } = o;
  const roundSwam = round ?? 'A Final';
  return {
    id: `${name}|${roundSwam}|${rank}`,
    name,
    team,
    rank,
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

const run = (rows: SwimmerResult[]) =>
  runIndividualScoringForEvent(rows, settings, new Map(), false, undefined);
const byName = (out: SwimmerResult[]) => Object.fromEntries(out.map(r => [r.name, r.points]));

describe('E2: an exhibition swim in a tie group costs only its own points', () => {
  it('golden: A (scoring) tied for 1st with X (exhibition) scores 20, X scores 0', () => {
    const out = run([row('A', 'T1', 1, '20.00'), row('X', 'T2', 1, '20.00', { isExhibition: true })]);
    expect(out).toHaveLength(2);
    expect(byName(out)).toEqual({ A: 20, X: 0 });
  });

  it('the order of the rows does not matter (Python read only the first row)', () => {
    const a = row('A', 'T1', 1, '20.00');
    const x = row('X', 'T2', 1, '20.00', { isExhibition: true });
    expect(byName(run([a, x]))).toEqual({ A: 20, X: 0 });
    expect(byName(run([x, a]))).toEqual({ A: 20, X: 0 });
  });

  it('a three-way tie for 2nd with one exhibition: the two scorers split 2nd and 3rd', () => {
    const out = run([
      row('W', 'T1', 1, '19.50'),
      row('A', 'T2', 2, '20.00'),
      row('B', 'T3', 2, '20.00'),
      row('X', 'T4', 2, '20.00', { isExhibition: true }),
      row('N', 'T5', 4, '20.60'),
    ]);
    // (17 + 16) / 2, not (17 + 16 + 15) / 3 and not 0. Rank 4 keeps 4th place: 15.
    expect(byName(out)).toEqual({ W: 20, A: 16.5, B: 16.5, X: 0, N: 15 });
  });

  it('the scorers earn what they would earn if the exhibition swimmer were absent', () => {
    // Printed ranks as a meet prints them: X is 3rd with A and B, so C is 6th. Without X: A and B tie
    // for 3rd, C is 5th.
    const field = [
      row('W1', 'T0', 1, '19.00'),
      row('W2', 'T0b', 2, '19.50'),
      row('A', 'T1', 3, '20.00'),
      row('B', 'T2', 3, '20.00'),
      row('C', 'T3', 6, '20.40'),
    ];
    const exhibition = row('X', 'T4', 3, '20.00', { isExhibition: true });
    const withX = byName(run([exhibition, ...field]));
    expect(withX['X']).toBe(0);
    // 3rd and 4th tied is (16 + 15) / 2. The next entry is 5th, not 6th: 14.
    expect(withX).toEqual({ W1: 20, W2: 17, A: 15.5, B: 15.5, C: 14, X: 0 });
  });

  it('places after an exhibition entry move up: the same places the timed-final scorer gives', () => {
    // Two exhibition entries ahead of Z: Z is first among the scoring entries.
    const out = run([
      row('X1', 'T1', 1, '20.00', { isExhibition: true }),
      row('X2', 'T2', 1, '20.00', { isExhibition: true }),
      row('Z', 'T3', 2, '20.50'),
    ]);
    expect(byName(out)).toEqual({ X1: 0, X2: 0, Z: 20 });
    // One exhibition entry in a tie for 2nd: N, printed 5th, is 4th.
    const tie = run([
      row('W1', 'T1', 1, '19.50'),
      row('B2', 'T2', 2, '20.00'),
      row('X2', 'T3', 2, '20.00', { isExhibition: true }),
      row('C2', 'T4', 2, '20.00'),
      row('N5', 'T5', 5, '20.60'),
    ]);
    expect(byName(tie)).toEqual({ W1: 20, B2: 16.5, X2: 0, C2: 16.5, N5: 15 });
    // The same field on the timed-final scorer: a ladder over the scoring entries.
    const timed = run(
      [
        row('Z', 'T3', 2, '15:20.00', { event: MILE, round: 'Finals' }),
        row('X1', 'T1', 1, '15:00.00', { event: MILE, round: 'Finals', isExhibition: true }),
        row('X2', 'T2', 1, '15:00.00', { event: MILE, round: 'Finals', isExhibition: true }),
      ]
    );
    expect(byName(timed)).toEqual(byName(run([row('Z', 'T3', 2, '20.50'), row('X1', 'T1', 1, '20.00', { isExhibition: true }), row('X2', 'T2', 1, '20.00', { isExhibition: true })])));
  });

  it('the source rank comes back on every row, and only exhibition entries leave', () => {
    const rows = [
      row('D', 'T1', 1, 'DQ'),
      row('X', 'T2', 2, '20.00', { isExhibition: true }),
      row('B', 'T3', 3, '20.50'),
    ];
    const out = run(rows);
    // A disqualified row still holds the printed place it holds with no exhibition entry: B is 2nd.
    expect(byName(out)).toEqual({ D: 0, X: 0, B: 17 });
    expect(out.map(r => [r.name, r.rank]).sort()).toEqual([['B', 3], ['D', 1], ['X', 2]]);
  });

  it('a row past a gap in the printed ranks moves up by the exhibition entries only', () => {
    // An unprojected recruit sits at A-Final rank 12 behind eight finishers. With X removed it is
    // 11th (6 points), not the dense 8th (11 points), so it cannot pass the B final.
    const rows = [
      row('F1', 'T1', 1, '20.00'),
      row('F2', 'T2', 2, '20.10'),
      row('X', 'T3', 3, '20.20', { isExhibition: true }),
      row('F4', 'T4', 4, '20.30'),
      row('F5', 'T5', 5, '20.40'),
      row('F6', 'T6', 6, '20.50'),
      row('F7', 'T7', 7, '20.60'),
      row('F8', 'T8', 8, '20.70'),
      row('R', 'T9', 12, '21.50'),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => row(`G${i}`, `U${i}`, i, `21.${i}0`, { round: 'B Final' })),
    ];
    const out = run(rows);
    expect(byName(out)).toMatchObject({ F1: 20, F2: 17, X: 0, F4: 16, F5: 15, F6: 14, F7: 13, F8: 12, R: 6 });
    // The B final is a separate tier: ranks 1 to 8 there are places 9 to 16.
    expect(byName(out)).toMatchObject({ G1: 9, G2: 7, G3: 6, G4: 5, G5: 4, G6: 3, G7: 2, G8: 1 });
    expect(out.find(r => r.name === 'R')?.rank).toBe(12);
  });

  it('a disqualified row ahead holds its place: DQ 1st, X 2nd, S 3rd scores 17', () => {
    const out = run([
      row('D', 'T1', 1, 'DQ'),
      row('X', 'T2', 2, '20.00', { isExhibition: true }),
      row('S', 'T3', 3, '20.50'),
    ]);
    expect(byName(out)).toEqual({ D: 0, X: 0, S: 17 });
  });

  it('a disqualified row in a tie still counts as ahead of the next printed rank', () => {
    const out = run([
      row('P', 'T1', 1, '20.00'),
      row('D', 'T2', 1, 'DQ'),
      row('X', 'T3', 1, '20.00', { isExhibition: true }),
      row('S', 'T4', 2, '20.50'),
    ]);
    expect(byName(out)).toEqual({ P: 20, D: 0, X: 0, S: 16 });
  });

  it('roster mode still applies the per-event cap, per swimmer', () => {
    const rosterSettings: ScoringSettings = {
      ...settings,
      scorerEligibilityMode: 'roster',
      maxIndividualScorersPerTeam: 1,
      scorerCapScope: 'event',
    };
    const lookup = { isScorer: () => true, rows: [] };
    const out = runIndividualScoringForEvent(
      [row('A1', 'T1', 1, '20.00'), row('A2', 'T1', 2, '20.50')],
      rosterSettings,
      new Map(),
      false,
      lookup
    );
    expect(byName(out)).toEqual({ A1: 20, A2: 0 });
  });

  it('an exhibition entry in the A final does not move the B final', () => {
    const out = run([
      row('X', 'T1', 1, '20.00', { isExhibition: true }),
      row('A2', 'T2', 2, '20.50'),
      row('B1', 'T3', 1, '21.00', { round: 'B Final' }),
      row('B2', 'T4', 2, '21.10', { round: 'B Final' }),
    ]);
    // A2 is the A final's first scorer (20). B final places 9 and 10 are untouched.
    expect(byName(out)).toEqual({ X: 0, A2: 20, B1: 9, B2: 7 });
  });

  it('a B-final tie works the same way: 9th place is worth 9', () => {
    const out = run([
      row('B1', 'T1', 1, '21.00', { round: 'B Final' }),
      row('BX', 'T2', 1, '21.00', { round: 'B Final', isExhibition: true }),
    ]);
    expect(byName(out)).toEqual({ B1: 9, BX: 0 });
  });

  it('a group of only exhibition swims scores 0 for every row', () => {
    const out = run([
      row('X1', 'T1', 1, '20.00', { isExhibition: true }),
      row('X2', 'T2', 1, '20.00', { isExhibition: true }),
      row('Z', 'T3', 3, '20.50'),
    ]);
    // Z is the only scoring entry, so Z is first.
    expect(byName(out)).toEqual({ X1: 0, X2: 0, Z: 20 });
  });

  it('each row is emitted once', () => {
    const rows = [
      row('A', 'T1', 1, '20.00'),
      row('X', 'T2', 1, '20.00', { isExhibition: true }),
      row('D', 'T3', 1, 'DQ'),
    ];
    const out = run(rows);
    expect(out.map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort());
  });

  it('agrees with the timed-final distance scorer for the same field', () => {
    // Timed final: the exhibition swim is out of the field, so the scorer takes 1st.
    const timed = run([
      row('A', 'T1', 1, '15:00.00', { event: MILE, round: 'Finals' }),
      row('X', 'T2', 1, '15:00.00', { event: MILE, round: 'Finals', isExhibition: true }),
    ]);
    expect(byName(timed)).toEqual({ A: 20, X: 0 });
  });

  it('flows through calculatePoints: the same rows, the whole engine', () => {
    const merged = mergeScoringSettings({
      maxIndividualScorersPerTeam: 999,
      maxTotalEntriesPerSwimmer: 999,
    });
    const scored = calculatePoints(
      [
        row('A', 'Alpha', 1, '20.00', { relayNames: [], isRelay: false, isExhibition: false, isTimeTrial: false }),
        row('X', 'Bravo', 1, '20.00', { relayNames: [], isRelay: false, isExhibition: true, isTimeTrial: false }),
      ],
      merged
    );
    const pts = Object.fromEntries(scored.map(r => [r.name, r.points]));
    expect(pts['X']).toBe(0);
    expect(pts['A']).toBe(merged.scoringPoints[0]);
  });
});
