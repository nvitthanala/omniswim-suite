/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the points on each leg row of a scored relay, and the team total they
 * add to. `scoreRelaysInEvent` writes `teamPoints / legCount` on every leg row
 * of an entry. Before this file, changing that to the full `teamPoints` on each
 * row passed every relay test, so nothing guarded the per-swimmer split.
 *
 * Every expected number below is worked by hand from the NCAA championship
 * 16-place relay table (Rule 7: the individual table 20, 17, 16, 15, ... doubled
 * for relays):
 *
 *   place   1    2    3    4    5    6    7    8    9    10   11   12   13  14  15  16
 *   points  40   34   32   30   28   26   24   22   18   14   12   10   8   6   4   2
 *
 * The arithmetic is in the comment on each case. The rows are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../packages/core/src/types';
import { calculatePoints } from '../packages/core/src/lib/utils';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';

const EVENT = 'Event 2 Men 200 Yard Freestyle Relay';
const SETTINGS = settingsForBuiltInScoringPreset('ncaa-championship-16');

/** One relay entry as four leg rows, the way the HyTek parser stores it. */
function relayEntry(
  team: string,
  rank: number,
  clock: string,
  extra: Partial<SwimmerResult> = {}
): SwimmerResult[] {
  const legs = [0, 1, 2, 3].map(i => `${team} Leg ${i + 1}`);
  return legs.map((name, i) => ({
    id: `${team}-relay-${i}`,
    rank,
    name,
    classYear: 'JR',
    team,
    time: clock,
    finalsTime: clock,
    relayTeamTime: clock,
    roundSwam: 'A Final',
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
    ...extra,
  })) as SwimmerResult[];
}

function score(rows: SwimmerResult[], settings: ScoringSettings = SETTINGS): SwimmerResult[] {
  return calculatePoints(rows, settings);
}

function legPoints(scored: SwimmerResult[], team: string): number[] {
  return scored.filter(r => r.team === team).map(r => Number(r.points));
}

function teamTotal(scored: SwimmerResult[], team: string): number {
  return legPoints(scored, team).reduce((a, b) => a + b, 0);
}

describe('relay points on each leg row', () => {
  it('a plain relay placing 1st gives each of its 4 legs a quarter of 40', () => {
    // 1st place = 40. Four legs: 40 / 4 = 10 on each row. Team total 4 x 10 = 40.
    // 2nd place = 34: 34 / 4 = 8.5 on each row. Team total 4 x 8.5 = 34.
    const scored = score([...relayEntry('Alpha', 1, '1:20.00'), ...relayEntry('Bravo', 2, '1:21.00')]);

    expect(legPoints(scored, 'Alpha')).toEqual([10, 10, 10, 10]);
    expect(teamTotal(scored, 'Alpha')).toBe(40);
    expect(legPoints(scored, 'Bravo')).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect(teamTotal(scored, 'Bravo')).toBe(34);
  });

  it('a 2-way tie for 2nd splits places 2 and 3, then divides across the legs', () => {
    // Tied for 2nd span places 2 and 3: (34 + 32) / 2 tied entries = 33 per entry.
    // Four legs: 33 / 4 = 8.25 on each row. Team total 4 x 8.25 = 33.
    // The event pays 40 + 33 + 33 = 106 = 40 + 34 + 32, so no point is created or lost.
    const scored = score([
      ...relayEntry('Alpha', 1, '1:20.00'),
      ...relayEntry('Bravo', 2, '1:21.00'),
      ...relayEntry('Charlie', 2, '1:21.00'),
    ]);

    expect(legPoints(scored, 'Alpha')).toEqual([10, 10, 10, 10]);
    expect(legPoints(scored, 'Bravo')).toEqual([8.25, 8.25, 8.25, 8.25]);
    expect(legPoints(scored, 'Charlie')).toEqual([8.25, 8.25, 8.25, 8.25]);
    expect(teamTotal(scored, 'Bravo')).toBe(33);
    expect(teamTotal(scored, 'Charlie')).toBe(33);
    expect(teamTotal(scored, 'Alpha') + teamTotal(scored, 'Bravo') + teamTotal(scored, 'Charlie')).toBe(106);
  });

  it('an exhibition entry scores 0 on every leg and takes no place from the next entry', () => {
    // Exhibition rank 2: 0 on each leg row. It holds no place, so Bravo at rank 3
    // still reads the 3rd place row: 32 / 4 = 8 on each row, team total 32.
    const scored = score([
      ...relayEntry('Alpha', 1, '1:20.00'),
      ...relayEntry('Exhibit', 2, '1:20.50', { isExhibition: true }),
      ...relayEntry('Bravo', 3, '1:21.00'),
    ]);

    expect(legPoints(scored, 'Exhibit')).toEqual([0, 0, 0, 0]);
    expect(legPoints(scored, 'Alpha')).toEqual([10, 10, 10, 10]);
    expect(legPoints(scored, 'Bravo')).toEqual([8, 8, 8, 8]);
    expect(teamTotal(scored, 'Bravo')).toBe(32);
  });

  it('a disqualified relay with a rank still scores 0 on every leg', () => {
    // A `DQ` clock is not a finish, so the entry scores nothing even with a rank.
    const scored = score([
      ...relayEntry('Alpha', 1, '1:20.00'),
      ...relayEntry('Delta', 2, 'DQ'),
    ]);

    expect(legPoints(scored, 'Delta')).toEqual([0, 0, 0, 0]);
    expect(teamTotal(scored, 'Alpha')).toBe(40);
  });
});

describe('relay points per leg row when halfRateRelaySwimmer is off', () => {
  // Every built-in preset sets halfRateRelaySwimmer true, which replaces the
  // plain team points / leg rows split. These cases turn it off so that split
  // is the one under test.
  const PLAIN: ScoringSettings = { ...SETTINGS, halfRateRelaySwimmer: false };

  /** A fifth row on the entry, e.g. an alternate credited on the same relay. */
  function withFifthRow(rows: SwimmerResult[]): SwimmerResult[] {
    const last = rows[rows.length - 1]!;
    return [...rows, { ...last, id: `${last.team}-relay-4`, name: `${last.team} Leg 5`, relayLegIndex: 4 }];
  }

  it('a 4-leg relay placing 1st gives each leg row 40 / 4', () => {
    // 1st place = 40. 40 / 4 legs = 10 on each row. Team total 40.
    const scored = score(relayEntry('Alpha', 1, '1:20.00'), PLAIN);

    expect(legPoints(scored, 'Alpha')).toEqual([10, 10, 10, 10]);
    expect(teamTotal(scored, 'Alpha')).toBe(40);
  });

  it('a 5-row entry splits the team points over 5 rows, not 4', () => {
    // 1st place = 40. Plain split: 40 / 5 rows = 8 on each row. Team total 5 x 8 = 40.
    const scored = score(withFifthRow(relayEntry('Alpha', 1, '1:20.00')), PLAIN);

    expect(legPoints(scored, 'Alpha')).toEqual([8, 8, 8, 8, 8]);
    expect(teamTotal(scored, 'Alpha')).toBe(40);
  });

  it('with the half rate on, a 5-row entry still gives each row 40 / 4', () => {
    // halfRateRelaySwimmer: each row earns a quarter of the team points whatever
    // the row count. 40 / 4 = 10 on each of 5 rows.
    const scored = score(withFifthRow(relayEntry('Alpha', 1, '1:20.00')));

    expect(legPoints(scored, 'Alpha')).toEqual([10, 10, 10, 10, 10]);
  });
});
