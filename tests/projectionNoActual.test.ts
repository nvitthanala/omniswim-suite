/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C7 (2026-10-12). "No actual yet" used to read as 0 points in the prelims and
 * psych over/under, in the momentum chart, and a missing best time used to sort
 * as the fastest. One case per site; each turns red when its fix is reverted.
 *
 *  - prelimsProjection ~263  entry with no baseline row  -> actual/overUnder null, hasActual false
 *  - prelimsProjection ~399  a team with no actual       -> momentum line absent (null), not 0
 *  - prelimsProjection ~418  deprecated chart builder    -> absent team is null
 *  - prelimsProjection ~107  seed rank past the table    -> null from the OrNull reader
 *  - psychProjection  ~216/218  entry with no baseline   -> null
 *  - eventStrength    ~129      missing time             -> sorts last, not first
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult } from '../packages/core/src/types';
import {
  buildMeetMomentumChartData,
  buildMeetMomentumChartDataFromLookup,
  buildMomentumSeriesForTeam,
  buildPrelimsOverUnderByEntryKey,
  countPrelimsEntriesWithoutActual,
  entryKey,
  pointsForPrelimsSeedRank,
  pointsForPrelimsSeedRankOrNull,
  prelimsOuOverUnderForDisplay,
  sumPrelimsOuForSwimmers,
  sumPrelimsOuForTeam,
} from '../packages/core/src/lib/prelimsProjection';
import { buildPsychOverUnderByEntryKey } from '../packages/core/src/lib/psychProjection';
import { rankEventsByQuality } from '../packages/core/src/lib/eventStrength';
import { settingsForBuiltInScoringPreset } from '../packages/core/src/lib/scoringDefaults';

const EVENT = 'Event 5 Men 100 Yard Backstroke';

const row = (name: string, team: string, points: number, over: Partial<SwimmerResult> = {}): SwimmerResult =>
  ({
    id: `${team}-${name}`,
    rank: 1,
    name,
    classYear: 'JR',
    team,
    time: '50.00',
    points,
    event: EVENT,
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...over,
  }) as SwimmerResult;

describe('prelims over/under: an entry with no actual is null, not 0', () => {
  // Alpha Ann has a baseline row (earned 9); Alpha Bea has none (not scored yet).
  const expected = [row('Ann', 'Alpha U', 17), row('Bea', 'Alpha U', 16), row('Cy', 'Beta U', 15)];
  const baseline = [row('Ann', 'Alpha U', 9), row('Cy', 'Beta U', 15)];
  const lookup = buildPrelimsOverUnderByEntryKey(baseline, expected);

  it('an entry with a baseline row has an actual and an over/under', () => {
    expect(lookup.get(entryKey(row('Ann', 'Alpha U', 0)))).toEqual({
      expected: 17,
      actual: 9,
      overUnder: -8,
      hasActual: true,
    });
  });

  it('an entry with no baseline row has actual null, overUnder null, hasActual false (it was -expected)', () => {
    expect(lookup.get(entryKey(row('Bea', 'Alpha U', 0)))).toEqual({
      expected: 16,
      actual: null,
      overUnder: null,
      hasActual: false,
    });
  });

  it('a real 0 actual stays 0 and is an under', () => {
    const zero = buildPrelimsOverUnderByEntryKey([row('Bea', 'Alpha U', 0)], [row('Bea', 'Alpha U', 16)]);
    expect(zero.get(entryKey(row('Bea', 'Alpha U', 0)))).toEqual({ expected: 16, actual: 0, overUnder: -16, hasActual: true });
  });

  it('the team and swimmer sums skip the entry with no actual instead of adding -expected', () => {
    expect(sumPrelimsOuForTeam('Alpha U', lookup)).toBe(-8); // not -24
    expect(sumPrelimsOuForSwimmers([row('Ann', 'Alpha U', 9), row('Bea', 'Alpha U', 0)], lookup)).toBe(-8);
  });

  it('the entries with no actual are counted, per team and overall', () => {
    expect(countPrelimsEntriesWithoutActual(lookup)).toBe(1);
    expect(countPrelimsEntriesWithoutActual(lookup, 'Alpha U')).toBe(1);
    expect(countPrelimsEntriesWithoutActual(lookup, 'Beta U')).toBe(0);
  });

  it('a row display value is undefined for an entry with no actual, not -expected', () => {
    expect(prelimsOuOverUnderForDisplay(row('Bea', 'Alpha U', 0), lookup)).toBeUndefined();
    expect(prelimsOuOverUnderForDisplay(row('Ann', 'Alpha U', 9), lookup)).toBe(-8);
  });

  it('the momentum series gets no delta from an entry with no actual', () => {
    const series = buildMomentumSeriesForTeam('Alpha U', lookup, [EVENT]);
    expect(series).toHaveLength(1);
    expect(series[0]!.delta).toBe(-8);
  });
});

describe('momentum chart rows: a team with no actual has no line', () => {
  const expected = [row('Ann', 'Alpha U', 17), row('Bea', 'Beta U', 16)];
  const baseline = [row('Ann', 'Alpha U', 9)]; // Beta has no baseline row at all
  const lookup = buildPrelimsOverUnderByEntryKey(baseline, expected);

  it('Alpha has a cumulative; Beta is null, not a flat 0 that reads as "on expectation"', () => {
    const rows = buildMeetMomentumChartDataFromLookup(['Alpha U', 'Beta U'], lookup, [EVENT]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['Alpha U']).toBe(-8);
    expect(rows[0]!['Beta U']).toBeNull();
  });

  it('a team with a real 0 cumulative keeps 0', () => {
    const exact = buildPrelimsOverUnderByEntryKey([row('Ann', 'Alpha U', 17)], [row('Ann', 'Alpha U', 17)]);
    expect(buildMeetMomentumChartDataFromLookup(['Alpha U'], exact, [EVENT])[0]!['Alpha U']).toBe(0);
  });

  it('the deprecated timeline builder reads a team a point does not name as null', () => {
    const rows = buildMeetMomentumChartData(
      [{ name: 'E5', fullEvent: EVENT, baselineDelta: { 'Alpha U': 3 }, projectedDelta: {} } as never],
      ['Alpha U', 'Beta U']
    );
    expect(rows[0]!['Alpha U']).toBe(3);
    expect(rows[0]!['Beta U']).toBeNull();
  });
});

describe('seed rank past the end of the place-point table', () => {
  const dual = settingsForBuiltInScoringPreset('ncaa-dual-six-lanes-or-more') as ScoringSettings; // 9-4-3-2-1-0, A bracket 6

  it('OrNull: a place the table scores 0 is 0; a place it has no row for is null', () => {
    expect(pointsForPrelimsSeedRankOrNull(1, EVENT, dual)).toBe(9);
    expect(pointsForPrelimsSeedRankOrNull(6, EVENT, dual)).toBe(0);
    expect(pointsForPrelimsSeedRankOrNull(7, EVENT, dual)).toBeNull(); // B final 1st: past the 6-place table
  });

  it('the number reader keeps its contract and reads the silent place as 0', () => {
    expect(pointsForPrelimsSeedRank(7, EVENT, dual)).toBe(0);
    expect(pointsForPrelimsSeedRank(1, EVENT, dual)).toBe(9);
  });
});

describe('psych over/under: an entry with no actual is null, not 0', () => {
  const psychExpected = [row('Ann', 'Alpha U', 17, { isPsychSheet: true }), row('Bea', 'Alpha U', 16, { isPsychSheet: true })];

  it('no baseline row for the entry or for its event: null, with hasActual false', () => {
    const lookup = buildPsychOverUnderByEntryKey([], psychExpected);
    const bea = lookup.get(entryKey(row('Bea', 'Alpha U', 0)));
    expect(bea).toEqual({ expected: 16, actual: null, overUnder: null, hasActual: false });
  });

  it('an entry with a baseline row has numbers', () => {
    const lookup = buildPsychOverUnderByEntryKey([row('Ann', 'Alpha U', 9)], psychExpected);
    expect(lookup.get(entryKey(row('Ann', 'Alpha U', 0)))).toEqual({
      expected: 17,
      actual: 9,
      overUnder: -8,
      hasActual: true,
    });
  });
});

describe('event strength: an event with no time sorts last', () => {
  const best = {
    '100 Free': { timeSec: 48.5 },
    '200 Free': { timeSec: undefined as unknown as number },
    '50 Free': { timeSec: 22.1 },
    '500 Free': { timeSec: Number.NaN },
  };

  it('with no division (unmapped team) the missing times are last, not first', () => {
    const r = rankEventsByQuality(best, Gender.MEN, 'Unmapped Academy', null);
    expect(r.unranked.slice(0, 2)).toEqual(['50 Free', '100 Free']);
    expect(new Set(r.unranked.slice(2))).toEqual(new Set(['200 Free', '500 Free']));
  });

  it('a mapped team: an event with a time but no published standard sorts ahead of an event with no time', () => {
    // '100 Freestyle' has no time. '25 Freestyle' has a time and no D2 standard, so both are
    // unranked. By name '100 Freestyle' comes first; by time it must come last.
    const mapped = {
      '50 Freestyle': { timeSec: 22.9 },
      '100 Freestyle': { timeSec: undefined as unknown as number },
      '25 Freestyle': { timeSec: 11.9 },
    };
    const r = rankEventsByQuality(mapped, Gender.MEN, 'Henderson State University');
    expect(r.division).toBe('D2');
    expect(r.ranked).toEqual(['50 Freestyle']);
    expect(r.unranked).toEqual(['25 Freestyle', '100 Freestyle']);
  });
});
