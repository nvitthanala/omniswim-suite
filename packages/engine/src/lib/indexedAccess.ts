/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three checked reads for places where the caller has already proved a value exists.
 *
 * `noUncheckedIndexedAccess` types `match[1]`, `list[i]` and `record[key]` as
 * `T | undefined`. Most reads in core are provably in range: a capture group that
 * is not optional, an index a loop bound or `findIndex` produced, a key that came
 * from `Object.keys` of the same record. Writing `?? 0` or `?? ''` there would
 * hide a broken invariant behind a plausible number or an empty string, which is
 * the failure mode this repo cares about most. These helpers raise instead, so a
 * pattern edit or a bad index fails loudly at the read.
 *
 * Do not use them for an optional group (`(...)?`), an index that may be out of
 * range, or a record key a caller supplied. Test `=== undefined` there and decide
 * what "absent" means. An absent value is not a zero and not an empty string.
 *
 * A function call is typed `T` whether or not the flag is on, so these helpers are
 * safe to land before the flag reaches this package's tsconfig.
 */

/**
 * Capture group `index` of a `RegExpMatchArray` whose pattern always fills it.
 *
 * Throws when the group did not take part in the match. That cannot happen for a
 * mandatory group, so a throw means the pattern and the reader disagree.
 */
export function regexGroup(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(
      `Indexed-read invariant broken: capture group ${index} did not take part in the match of ${JSON.stringify(match[0])}.`
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
      `Indexed-read invariant broken: index ${index} is outside an array of length ${items.length}.`
    );
  }
  return value;
}

/**
 * Value stored under `key` in a record the caller has already shown holds it (a key
 * taken from `Object.keys` of the same record, or one the function just assigned).
 *
 * Throws when the key has no value. `null` and `0` are values and pass through.
 */
export function recordAt<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) {
    throw new Error(`Indexed-read invariant broken: no value under key ${JSON.stringify(key)}.`);
  }
  return value;
}
