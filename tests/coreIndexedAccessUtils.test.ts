/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the readers in `packages/core/src/lib/utils.ts` that moved from unchecked
 * indexes to `itemAt` / `regexGroup` / `recordAt` (R11 step 5). Each expectation is
 * the value the code returned before the change (checked against the pre-change file
 * on seeded random meets), so a helper that quietly substitutes a default fails here.
 */
import { describe, expect, it } from 'vitest';

import { Gender, type SwimmerResult, type TeamScore } from '../packages/core/src/types';
import {
  assignTeamLineStyles,
  calculatePoints,
  canonicalSwimmerName,
  convertTimeToSeconds,
  eventMeetSortKey,
  getTeamColors,
  parseEventNumber,
  parseRankInt,
  rgbColorDistance,
  simulateRoster,
} from '../packages/core/src/lib/utils';

const swim = (o: Partial<SwimmerResult>): SwimmerResult =>
  ({
    id: 'x',
    name: 'A',
    team: 'T',
    gender: Gender.WOMEN,
    event: 'Event 5 Women 100 Yard Freestyle',
    time: '50.00',
    classYear: 'FR',
    rank: 1,
    points: 0,
    roundSwam: 'Finals',
    ...o,
  }) as unknown as SwimmerResult;

const pointsById = (rows: SwimmerResult[]) => rows.map(r => [r.id, r.points]);

describe('scalar readers', () => {
  it('parses m:ss.ss and ss.ss, and keeps the NT/DQ/empty sentinels', () => {
    expect(convertTimeToSeconds('1:23.45')).toBeCloseTo(83.45, 10);
    expect(convertTimeToSeconds('59.99')).toBe(59.99);
    expect(convertTimeToSeconds('NT')).toBe(Infinity);
    expect(convertTimeToSeconds('DQ')).toBe(Infinity);
    expect(convertTimeToSeconds('')).toBe(Infinity);
    expect(convertTimeToSeconds('x')).toBeNaN();
  });

  it('reads the event number, rank and sort key from their capture groups', () => {
    expect(parseEventNumber('Event 13 Men 100 Yard Butterfly')).toBe(13);
    expect(parseEventNumber('100 Free')).toBeNull();
    expect(eventMeetSortKey('Event 7 Women 200 Yard Breaststroke')).toBe(7);
    expect(eventMeetSortKey('100 Free')).toBe(99999);
    expect(parseRankInt('2nd')).toBe(2);
    expect(parseRankInt('x')).toBeNull();
    expect(parseRankInt(0)).toBeNull();
  });

  it('reads 3-digit and 6-digit hex colors', () => {
    expect(rgbColorDistance('#abc', '#aabbcc')).toBe(0);
    expect(rgbColorDistance('#000', '#fff')).toBeCloseTo(441.6729559300637, 10);
    expect(rgbColorDistance('nope', '#fff')).toBe(999);
  });

  it('falls back to a hashed palette color for an unknown team', () => {
    expect(getTeamColors('Zzz Qqq College').primary).toBe('#FF4444');
    expect(getTeamColors('').primary).toBe('#FFD700');
  });
});

describe('scoring paths', () => {
  it('splits tied individual places', () => {
    const rows = [
      swim({ id: 'a', name: 'A', team: 'T1', rank: 1, time: '50.00' }),
      swim({ id: 'b', name: 'B', team: 'T2', rank: 2, time: '50.10' }),
      swim({ id: 'c', name: 'C', team: 'T3', rank: 2, time: '50.10' }),
      swim({ id: 'd', name: 'D', team: 'T1', rank: 4, time: '51.00' }),
    ];
    expect(pointsById(calculatePoints(rows))).toEqual([
      ['a', 20],
      ['b', 16.5],
      ['c', 16.5],
      ['d', 15],
    ]);
  });

  it('scores a timed-final distance event by rank groups', () => {
    const ev = 'Event 9 Women 1650 Yard Freestyle';
    const rows = [
      swim({ id: 'a', name: 'A', team: 'T1', event: ev, rank: 1, time: '16:00.00' }),
      swim({ id: 'b', name: 'B', team: 'T2', event: ev, rank: 2, time: '16:10.00' }),
      swim({ id: 'c', name: 'C', team: 'T1', event: ev, rank: 3, time: '16:20.00' }),
    ];
    expect(pointsById(calculatePoints(rows))).toEqual([
      ['a', 20],
      ['b', 17],
      ['c', 16],
    ]);
  });

  it('awards timed-final places in rank order whatever the input order', () => {
    const ev = 'Event 9 Women 1650 Yard Freestyle';
    const rows = [
      swim({ id: 'c', name: 'C', team: 'T1', event: ev, rank: 3, time: '16:20.00' }),
      swim({ id: 'b', name: 'B', team: 'T2', event: ev, rank: 2, time: '16:10.00' }),
      swim({ id: 'a', name: 'A', team: 'T1', event: ev, rank: 1, time: '16:00.00' }),
    ];
    const byId = new Map(calculatePoints(rows).map(r => [r.id, r.points]));
    expect([byId.get('a'), byId.get('b'), byId.get('c')]).toEqual([20, 17, 16]);
  });

  it('places a recruit among the meet rows by time', () => {
    const rows = [
      swim({ id: 'a', name: 'A', team: 'T1', rank: 1, time: '50.00' }),
      swim({ id: 'b', name: 'B', team: 'T2', rank: 2, time: '50.10' }),
      swim({ id: 'rec', name: 'Rec', team: 'T9', rank: 0, time: '50.05', isRecruit: true }),
    ];
    const out = calculatePoints(rows);
    const rec = out.find(r => r.id === 'rec');
    expect(rec?.rank).toBe(2);
    expect(rec?.points).toBe(17);
  });

  it('splits tied relay entries and keeps each leg row', () => {
    const relay: SwimmerResult[] = [];
    for (const [team, rank] of [
      ['T1', 1],
      ['T2', 2],
      ['T3', 2],
    ] as const) {
      const names = [0, 1, 2, 3].map(i => ({ name: `${team} s${i}`, year: 'FR' }));
      names.forEach((n, leg) =>
        relay.push(
          swim({
            id: `${team}${leg}`,
            name: n.name,
            team,
            event: 'Event 1 Women 200 Yard Freestyle Relay',
            time: '1:40.00',
            rank,
            isRelay: true,
            relayNames: names,
            relayLegIndex: leg,
            relayLegSplit: '25.00',
          })
        )
      );
    }
    const scored = calculatePoints(relay);
    expect(scored).toHaveLength(12);
    expect(scored.filter(r => r.team === 'T1').every(r => r.points === 10)).toBe(true);
    expect(scored.filter(r => r.team !== 'T1').every(r => r.points === 8.25)).toBe(true);

    // Dropping one leg holder vacates that leg and adds the 3-second penalty.
    const sim = simulateRoster(relay, [], false, new Set([canonicalSwimmerName('T1 s2')]));
    const t1 = sim.filter(r => r.team === 'T1');
    expect(t1.map(r => [r.name, r.time, r.relayMissingLeg?.reason])).toEqual([
      ['T1 s0', '1:43.00', undefined],
      ['T1 s1', '1:43.00', undefined],
      ['—', '1:43.00', 'vacant'],
      ['T1 s3', '1:43.00', undefined],
    ]);
  });
});

describe('assignTeamLineStyles', () => {
  const mk = (teamName: string, color: string, totalPoints: number) =>
    ({ teamName, totalPoints, color }) as unknown as TeamScore;

  it('gives a similar-color pair of two a secondary color and no dash', () => {
    const out = assignTeamLineStyles([mk('Alpha', '#112233', 10), mk('Beta', '#112234', 30), mk('Gamma', '#FF0000', 5)]);
    expect(out.map(t => [t.teamName, t.lineColor, t.strokeDasharray])).toEqual([
      ['Alpha', '#7160fb', undefined],
      ['Beta', '#316195', undefined],
      ['Gamma', '#ff0000', undefined],
    ]);
  });

  it('dashes a similar-color group of three', () => {
    const out = assignTeamLineStyles([mk('Alpha', '#112233', 10), mk('Beta', '#112234', 30), mk('Gamma', '#112235', 5)]);
    expect(out.map(t => [t.teamName, t.lineColor, t.strokeDasharray])).toEqual([
      ['Alpha', '#7160fb', '6 4'],
      ['Beta', '#316195', undefined],
      ['Gamma', '#306096', '2 3'],
    ]);
  });
});
