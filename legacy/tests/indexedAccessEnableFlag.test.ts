/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the sites that changed when `noUncheckedIndexedAccess` went into
 * tsconfig.base.json (R11 step 6) and where absent input could differ:
 * relay-leg strokes for an index with no stroke, the class top-performer
 * accumulator, and the applet prefetcher for an id with no loader.
 *
 * A leg index that names no leg throws (decision E20, 2026-10-16). It never receives a guessed stroke.
 */
import { describe, expect, it } from 'vitest';

import type { RelayLegCredit, SwimmerResult } from '../../packages/core/src/types';
import {
  InvalidRelayLegIndexError,
  isValidRelayLegIndex,
  relayLegRequirements,
  relayStrokeForBoundedIndex,
  relayStrokeForIndex,
  swimmerMatchesRelayLeg,
} from '../../packages/core/src/lib/relayLegMatching';
import { relayLegSlotOf } from '../../packages/core/src/lib/relayLegCredits';
import { findDepartedLegSwim } from '../../packages/core/src/lib/utils';
import { computeClassTopPerformers } from '../packages/matrix/src/components/teamCardView';
import { prefetchApplet } from '../apps/shell/src/lib/appletPrefetch';

const MEDLEY = '400 medley relay men';
const MEDLEY_LABEL = 'Event 20 Men 4x100 Yard Medley Relay';

describe('relayStrokeForIndex: an index that names no leg throws (decision E20)', () => {
  it('names the stroke for legs 0 to 3 of a medley', () => {
    expect([0, 1, 2, 3].map(i => relayStrokeForIndex(MEDLEY, i))).toStrictEqual(['back', 'breast', 'fly', 'free']);
  });

  it('throws InvalidRelayLegIndexError for a negative, fractional, non-finite or fifth-leg medley index', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4, 7]) {
      expect(() => relayStrokeForIndex(MEDLEY, bad), String(bad)).toThrow(InvalidRelayLegIndexError);
    }
  });

  it('the error names the event and the index', () => {
    try {
      relayStrokeForIndex(MEDLEY, -1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRelayLegIndexError);
      expect(error).toBeInstanceOf(Error);
      const named = error as InvalidRelayLegIndexError;
      expect(named.name).toBe('InvalidRelayLegIndexError');
      expect(named.legIndex).toBe(-1);
      expect(named.eventLower).toBe(MEDLEY);
      expect(named.message).toContain('-1');
    }
  });

  it('a free relay is free for every whole-number index, and throws for a negative or fractional one', () => {
    expect(relayStrokeForIndex('400 free relay men', 0)).toBe('free');
    expect(relayStrokeForIndex('400 free relay men', 3)).toBe('free');
    expect(() => relayStrokeForIndex('400 free relay men', -1)).toThrow(InvalidRelayLegIndexError);
    expect(() => relayStrokeForIndex('400 free relay men', 0.5)).toThrow(InvalidRelayLegIndexError);
  });

  it('isValidRelayLegIndex agrees with relayStrokeForIndex', () => {
    for (const event of [MEDLEY, '400 free relay men']) {
      for (const index of [-1, 0, 1, 2, 3, 4, 1.5, Number.NaN]) {
        let throws = false;
        try {
          relayStrokeForIndex(event, index);
        } catch (error) {
          throws = error instanceof InvalidRelayLegIndexError;
        }
        expect(isValidRelayLegIndex(event, index), `${event} ${String(index)}`).toBe(!throws);
      }
    }
  });

  it('relayLegRequirements throws for a bad index and carries the stroke for a good one', () => {
    expect(() => relayLegRequirements(MEDLEY_LABEL, -1)).toThrow(InvalidRelayLegIndexError);
    expect(relayLegRequirements(MEDLEY_LABEL, 0).stroke).toBe('back');
  });

  it('the bounded variant returns the same strokes and throws the same error', () => {
    expect([0, 1, 2, 3].map(i => relayStrokeForBoundedIndex(MEDLEY, i))).toStrictEqual([
      'back',
      'breast',
      'fly',
      'free',
    ]);
    expect(() => relayStrokeForBoundedIndex(MEDLEY, -1)).toThrow(InvalidRelayLegIndexError);
    expect(() => relayStrokeForBoundedIndex(MEDLEY, 4)).toThrow(/relay leg index 4/i);
  });
});

describe('relay leg lookups with an index that names no leg', () => {
  const row = (event: string): SwimmerResult => ({ event, isRelay: false, time: '1:00.00' }) as SwimmerResult;

  it('swimmerMatchesRelayLeg throws, never "false for every swim"', () => {
    expect(() => swimmerMatchesRelayLeg(row('100 Backstroke'), MEDLEY_LABEL, -1)).toThrow(InvalidRelayLegIndexError);
    // Control: leg 0 still matches its stroke.
    expect(swimmerMatchesRelayLeg(row('100 Backstroke'), MEDLEY_LABEL, 0)).toBe(true);
  });

  it('findDepartedLegSwim throws for a bad index and finds the swim for a good one', () => {
    const results = [
      { name: 'Ann Lee', team: 'T', event: '100 Backstroke', isRelay: false, time: '55.00' },
    ] as unknown as SwimmerResult[];
    expect(findDepartedLegSwim(results, 'Ann Lee', MEDLEY_LABEL, 0, 'T')).toBe(results[0]);
    expect(() => findDepartedLegSwim(results, 'Ann Lee', MEDLEY_LABEL, -1, 'T')).toThrow(InvalidRelayLegIndexError);
  });

  it('relayLegSlotOf (stored positions) gives no slot for a position that names no leg', () => {
    const credit = (legPosition: number, relayEventTitle = '400 Medley Relay Men') =>
      ({ legPosition, relayEventTitle, isLeadoff: false }) as unknown as RelayLegCredit;
    expect(relayLegSlotOf(credit(1))).toStrictEqual({ distance: 100, stroke: 'back', position: 1, start: 'flat' });
    expect(relayLegSlotOf(credit(4))).toStrictEqual({ distance: 100, stroke: 'free', position: 4, start: 'takeover' });
    for (const bad of [0, -2, 5, 1.5, Number.NaN]) {
      expect(relayLegSlotOf(credit(bad)), String(bad)).toBeNull();
      expect(relayLegSlotOf(credit(bad, '200 Free Relay Men')), `free ${String(bad)}`).toBeNull();
    }
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
