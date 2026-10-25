/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/core/src/lib/indexedAccess.ts`: the checked reads core uses where
 * `noUncheckedIndexedAccess` would otherwise force a `?? 0` or `?? ''`.
 *
 * They must raise on a broken invariant. A silent default on a time, a point or
 * a place would turn a broken lookup into a plausible wrong number.
 */
import { describe, expect, it } from 'vitest';

import { itemAt, recordAt, regexGroup } from '../packages/core/src/lib/indexedAccess';

describe('regexGroup', () => {
  it('returns a capture group that took part in the match', () => {
    const match = /^(\d+)-(\w+)$/.exec('12-ab');
    expect(regexGroup(match as RegExpExecArray, 1)).toBe('12');
    expect(regexGroup(match as RegExpExecArray, 2)).toBe('ab');
  });

  it('returns an empty group as an empty string, not as a failure', () => {
    const match = /^a(\d*)b$/.exec('ab');
    expect(regexGroup(match as RegExpExecArray, 1)).toBe('');
  });

  it('throws for an optional group that did not take part', () => {
    const match = /^a(\d)?b$/.exec('ab');
    expect(() => regexGroup(match as RegExpExecArray, 1)).toThrow(/capture group 1/);
  });
});

describe('itemAt', () => {
  it('returns the element, including a falsy one', () => {
    expect(itemAt([0, 1, 2], 0)).toBe(0);
    expect(itemAt(['', 'x'], 0)).toBe('');
    expect(itemAt([null, 1], 0)).toBeNull();
  });

  it('throws past either end of the array', () => {
    expect(() => itemAt([1, 2], 2)).toThrow(/index 2 is outside an array of length 2/);
    expect(() => itemAt([1, 2], -1)).toThrow(/index -1/);
    expect(() => itemAt([], 0)).toThrow(/length 0/);
  });
});

describe('recordAt', () => {
  it('returns a stored value, including 0 and null', () => {
    const record: Record<string, number | null> = { a: 0, b: null, c: 7 };
    expect(recordAt(record, 'a')).toBe(0);
    expect(recordAt(record, 'b')).toBeNull();
    expect(recordAt(record, 'c')).toBe(7);
  });

  it('throws for a key that holds nothing', () => {
    expect(() => recordAt<number>({ a: 1 }, 'b')).toThrow(/no value under key "b"/);
  });
});
