/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two checked reads for places where a parser already knows an index exists.
 *
 * `noUncheckedIndexedAccess` types `match[1]` and `cells[i]` as `T | undefined`.
 * Most reads in this package are provably in range: a capture group that is not
 * optional, or an index that came from `findIndex`. Writing `?? ''` there would
 * hide a broken invariant behind an empty string. These helpers raise instead,
 * so a pattern edit or a bad index fails loudly at the read, not as a blank
 * field further downstream.
 *
 * Do not use them for an optional group (`(…)?`) or for an index that may be out
 * of range. Test `=== undefined` there and decide what absent means.
 */

/**
 * Capture group `index` of a `RegExpExecArray` or `matchAll` result whose pattern always fills it.
 *
 * Throws when the group did not take part in the match. That cannot happen for a
 * mandatory group, so a throw means the pattern and the reader disagree.
 */
export function regexGroup(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(
      `SwimCloud parser invariant broken: capture group ${index} did not take part in the match of ${JSON.stringify(match[0])}.`,
    );
  }
  return value;
}

/**
 * Element `index` of an array the caller has already bounded (a loop bound, a
 * `findIndex` result, a length check).
 *
 * Throws when the index is outside the array.
 */
export function itemAt<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(
      `SwimCloud parser invariant broken: index ${index} is outside an array of length ${items.length}.`,
    );
  }
  return value;
}
