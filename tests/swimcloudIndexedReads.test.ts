/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/swimcloud/src/indexed.ts`: the two checked reads the parsers use
 * where `noUncheckedIndexedAccess` would otherwise force a `?? ''`.
 *
 * They must raise on a broken invariant. A silent empty string here would turn
 * a changed page pattern into a blank field, not an error.
 */
import { describe, expect, it } from 'vitest';

import { itemAt, regexGroup } from '../packages/swimcloud/src/indexed';

describe('regexGroup', () => {
  it('returns a capture group that took part in the match', () => {
    const match = /^(\d+)-(\w+)$/.exec('12-ab');
    expect(match).not.toBeNull();
    expect(regexGroup(match as RegExpExecArray, 1)).toBe('12');
    expect(regexGroup(match as RegExpExecArray, 2)).toBe('ab');
  });

  it('returns an empty group as an empty string, not as a failure', () => {
    const match = /^a(\d*)b$/.exec('ab');
    expect(regexGroup(match as RegExpExecArray, 1)).toBe('');
  });

  it('throws when the group did not take part in the match', () => {
    const match = /^(a)|(b)$/.exec('b');
    expect(() => regexGroup(match as RegExpExecArray, 1)).toThrow(/capture group 1 did not take part/);
  });

  it('throws for a group number the pattern does not have', () => {
    const match = /^(a)$/.exec('a');
    expect(() => regexGroup(match as RegExpExecArray, 4)).toThrow(/capture group 4/);
  });

  it('accepts a matchAll result', () => {
    const [first] = [...'k=1'.matchAll(/(\w)=(\d)/g)];
    expect(regexGroup(first as RegExpMatchArray, 2)).toBe('1');
  });
});

describe('itemAt', () => {
  it('returns the element at an in-range index', () => {
    expect(itemAt(['a', 'b', 'c'], 2)).toBe('c');
  });

  it('returns an empty string element', () => {
    expect(itemAt(['', 'x'], 0)).toBe('');
  });

  it('throws past the end and before the start', () => {
    expect(() => itemAt(['a'], 1)).toThrow(/index 1 is outside an array of length 1/);
    expect(() => itemAt(['a'], -1)).toThrow(/index -1/);
  });
});
