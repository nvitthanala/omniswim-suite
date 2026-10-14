/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the sites that changed when `noUncheckedIndexedAccess` went into
 * tsconfig.base.json (R11 step 6) and where absent input could differ:
 * relay-leg strokes for an index with no stroke, the class top-performer
 * accumulator, and the applet prefetcher for an id with no loader.
 *
 * A leg index with no stroke matches no event. It never receives a guessed stroke.
 */
import { describe, expect, it } from 'vitest';

import type { RelayLegCredit, SwimmerResult } from '../packages/core/src/types';
import {
  relayLegRequirements,
  relayStrokeForBoundedIndex,
  relayStrokeForIndex,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import { relayLegSlotOf } from '../packages/core/src/lib/relayLegCredits';
import { findDepartedLegSwim } from '../packages/core/src/lib/utils';
import { computeClassTopPerformers } from '../packages/matrix/src/components/teamCardView';
import { swimEventIdentity } from '../packages/core/src/lib/athleteHistory';
import { prefetchApplet } from '../apps/shell/src/lib/appletPrefetch';

const MEDLEY = '400 medley relay men';
const MEDLEY_LABEL = 'Event 20 Men 4x100 Yard Medley Relay';

describe('relayStrokeForIndex: an index with no stroke stays absent', () => {
  it('names the stroke for legs 0 to 3 of a medley, and free past leg 3', () => {
    expect([0, 1, 2, 3].map(i => relayStrokeForIndex(MEDLEY, i))).toStrictEqual(['back', 'breast', 'fly', 'free']);
    expect(relayStrokeForIndex(MEDLEY, 4)).toBe('free');
  });

  it('returns undefined for a negative or fractional medley index', () => {
    expect(relayStrokeForIndex(MEDLEY, -1)).toBeUndefined();
    expect(relayStrokeForIndex(MEDLEY, 1.5)).toBeUndefined();
  });

  it('a free relay is free for every index, as before', () => {
    expect(relayStrokeForIndex('400 free relay men', 0)).toBe('free');
    expect(relayStrokeForIndex('400 free relay men', -1)).toBe('free');
  });

  it('relayLegRequirements carries the absent stroke through', () => {
    expect(relayLegRequirements(MEDLEY_LABEL, -1).stroke).toBeUndefined();
    expect(relayLegRequirements(MEDLEY_LABEL, 0).stroke).toBe('back');
  });

  it('the bounded variant returns the same strokes and throws instead of returning undefined', () => {
    expect([0, 1, 2, 3, 4].map(i => relayStrokeForBoundedIndex(MEDLEY, i))).toStrictEqual([
      'back',
      'breast',
      'fly',
      'free',
      'free',
    ]);
    expect(() => relayStrokeForBoundedIndex(MEDLEY, -1)).toThrow(/relay leg index -1 has no stroke/);
  });
});

describe('relay leg lookups with an index that has no stroke', () => {
  it('the label an absent stroke builds matches none of the four stroke events', () => {
    // relayBuilder.isLegEvent compares swimEventIdentity of the swim and of `<distance> <stroke event>`.
    const absent = swimEventIdentity('100 undefined');
    for (const stroke of ['Backstroke', 'Breaststroke', 'Butterfly', 'Freestyle']) {
      expect(absent).not.toBe(swimEventIdentity(`100 ${stroke}`));
    }
  });

  const row = (event: string): SwimmerResult => ({ event, isRelay: false, time: '1:00.00' }) as SwimmerResult;

  it('swimmerMatchesRelayLeg is false for every swim', () => {
    for (const event of ['100 Backstroke', '100 Freestyle', '100 Fly', '100 Breaststroke']) {
      expect(swimmerMatchesRelayLeg(row(event), MEDLEY_LABEL, -1), event).toBe(false);
    }
    // Control: leg 0 still matches its stroke.
    expect(swimmerMatchesRelayLeg(row('100 Backstroke'), MEDLEY_LABEL, 0)).toBe(true);
  });

  it('findDepartedLegSwim finds nothing', () => {
    const results = [
      { name: 'Ann Lee', team: 'T', event: '100 Backstroke', isRelay: false, time: '55.00' },
    ] as unknown as SwimmerResult[];
    expect(findDepartedLegSwim(results, 'Ann Lee', MEDLEY_LABEL, 0, 'T')).toBe(results[0]);
    expect(findDepartedLegSwim(results, 'Ann Lee', MEDLEY_LABEL, -1, 'T')).toBeUndefined();
  });

  it('relayLegSlotOf gives no slot for a medley position below 1', () => {
    const credit = (legPosition: number) =>
      ({ legPosition, relayEventTitle: '400 Medley Relay Men', isLeadoff: false }) as unknown as RelayLegCredit;
    expect(relayLegSlotOf(credit(1))).toStrictEqual({ distance: 100, stroke: 'back', position: 1, start: 'flat' });
    expect(relayLegSlotOf(credit(4))).toStrictEqual({ distance: 100, stroke: 'free', position: 4, start: 'takeover' });
    expect(relayLegSlotOf(credit(0))).toBeNull();
    expect(relayLegSlotOf(credit(-2))).toBeNull();
  });
});

describe('computeClassTopPerformers accumulator', () => {
  const swim = (name: string, points: unknown) => ({ name, points }) as unknown as SwimmerResult;

  // Pins the existing behaviour: a swimmer whose rows hold no number is listed with 0.
  it('sums a swimmer over rows, ignores a non-number, sorts by points', () => {
    const out = computeClassTopPerformers([swim('A', 5), swim('B', 9), swim('A', 6), swim('C', 'x'), swim('A', undefined)]);
    expect(out).toStrictEqual([
      ['A', 11],
      ['B', 9],
      ['C', 0],
    ]);
  });

  it('a NaN running total restarts at zero, as it did before', () => {
    expect(computeClassTopPerformers([swim('A', Number.NaN), swim('A', 4)])).toStrictEqual([['A', 4]]);
  });
});

describe('prefetchApplet', () => {
  it('does nothing for an id with no loader', () => {
    expect(() => prefetchApplet('not-an-applet')).not.toThrow();
  });
});
