/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The committed simulator fixtures name swimmers "T48-S01" (sanitized). The storage layer takes only SwimCloud ids, numbers written as
 * text (`^[1-9][0-9]*$`), as the live page has them. `withNumericSwimmerIds` renames each swimmer id to such a number, everywhere it
 * appears, so a test can store tags and lineups for a fixture swimmer. The rename is one-to-one: nothing else in the snapshot changes.
 * Imports no runtime code, so a Playwright spec can load it.
 */
import type { SimSnapshot } from '../../apps/extension/src/shared/bridgeSchema';

/** "T48-S01" becomes "148001": a leading 1, the team id, then the swimmer number padded to three digits. */
export function numericSwimmerId(id: string): string | null {
  const m = /^T(\d+)-S(\d+)$/.exec(id);
  return m === null ? null : `1${m[1]}${(m[2] as string).padStart(3, '0')}`;
}

export function withNumericSwimmerIds(snapshot: SimSnapshot): SimSnapshot {
  const text = JSON.stringify(snapshot).replace(/"(T\d+-S\d+)"/g, (whole, id: string) => `"${numericSwimmerId(id) as string}"`);
  return JSON.parse(text) as SimSnapshot;
}
