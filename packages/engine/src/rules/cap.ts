/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Caps (plans/2026-10-25/D2-ENGINE-API.md, 3.3).
 *
 * A cap is a whole number of 0 or more, or the word `'unlimited'`. A missing cap is never
 * unlimited: the legacy scorer reads an absent cap as 999 (`?? 999`), and this parser is the
 * boundary that stops it.
 */

/** `'unlimited'`, or an integer from 0 to 998. */
export type Cap = number | 'unlimited';

export type RulePresetErrorCode = 'missing' | 'invalid' | 'legacy_sentinel' | 'pending' | 'legacy_provenance';

export class RulePresetError extends Error {
  /** Dotted path of the field, e.g. `entries.maxTotalPerSwimmer`. */
  readonly path: string;
  readonly code: RulePresetErrorCode;
  /** Every path the error names. One entry, except `requireComplete`, which lists every pending path. */
  readonly paths: readonly string[];

  constructor(path: string, code: RulePresetErrorCode, message: string, paths?: readonly string[]) {
    super(message);
    this.name = 'RulePresetError';
    this.path = path;
    this.code = code;
    this.paths = paths ?? [path];
  }
}

/** The legacy scorer reads any cap at or above this as unlimited (`meetPool.ts:47`, F4). */
const LEGACY_UNLIMITED_FLOOR = 999;

/**
 * Read a cap from untrusted input.
 *
 * - `'unlimited'` gives `'unlimited'`.
 * - An integer 0 to 998 gives that number. `0` is a real cap.
 * - `undefined` throws `missing`.
 * - An integer of 999 or more throws `legacy_sentinel`: the legacy code would read it as unlimited,
 *   so a user cap of 1000 would silently mean no cap.
 * - Everything else throws `invalid`: `null`, `NaN`, a fraction, a negative, another string, a
 *   numeric string.
 */
export function parseCap(raw: unknown, path: string): Cap {
  if (raw === undefined) throw new RulePresetError(path, 'missing', `${path}: cap is missing`);
  if (raw === 'unlimited') return 'unlimited';
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw < 0) throw new RulePresetError(path, 'invalid', `${path}: cap ${raw} is negative`);
    if (raw >= LEGACY_UNLIMITED_FLOOR) {
      throw new RulePresetError(
        path,
        'legacy_sentinel',
        `${path}: cap ${raw} would read as unlimited in the legacy scorer (any cap of ${LEGACY_UNLIMITED_FLOOR} or more). Use "unlimited" to mean no cap.`
      );
    }
    return raw;
  }
  throw new RulePresetError(path, 'invalid', `${path}: ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)} is not a cap`);
}

/** True when `count` is within the cap (`count <= cap`). `'unlimited'` allows every count. */
export function capAllows(cap: Cap, count: number): boolean {
  return cap === 'unlimited' || count <= cap;
}
