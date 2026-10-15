/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Place-point tables: the draft a settings screen edits, the check that turns a
 * draft into stored settings, and the two zod checks that guard a stored table.
 *
 * THE CONTRACT (user decision U5, 2026-10-12)
 *
 *   - A STORED table is `number[]`. `ScoringSettings` is unchanged. A stored table
 *     never holds a blank, so the engine never reads one.
 *   - A BLANK cell exists only in a UI draft ({@link PlaceDraft}). A coach who
 *     grows a table, or switches a relay or diving table on, sees blank cells to
 *     fill in; a seed of 0 would read as a published "0 points" nobody entered.
 *   - {@link finalizeScoringDraft} is the only way a draft becomes settings. It
 *     refuses while any cell is blank and names each blank, so "blank cell blocks
 *     save" is decided here once and not re-implemented per screen.
 *   - A table that is already stored loads exactly as stored. A stored 0 is a 0:
 *     nothing here turns a 0 into a blank, and nothing rewrites stored data.
 *
 * Past the END of a stored table the engine reads "no row", which
 * `placePointAt` / `tiedPlaceShare` in `utils.ts` return as `null`, never as 0.
 */
import { z } from 'zod';
import type { ScoringSettings } from '../types';
import { itemAt } from './indexedAccess';

/** A place-point table being edited. `null` is a cell the user has not filled in. Place 1 first. */
export type PlaceDraft = (number | null)[];

/** The three tables a {@link ScoringSettingsDraft} lets a screen leave blank. */
export type PlaceTableName = 'scoringPoints' | 'relayPoints' | 'divingPoints';

/** {@link ScoringSettings} with its three place tables as drafts. Nothing else differs. */
export type ScoringSettingsDraft = Omit<ScoringSettings, PlaceTableName> & {
  scoringPoints: PlaceDraft;
  relayPoints?: PlaceDraft;
  divingPoints?: PlaceDraft;
};

/** One blank cell. `place` is 1-based, matching the "Place N" a screen shows. */
export interface BlankPlace {
  table: PlaceTableName;
  place: number;
}

export type FinalizeScoringDraftResult =
  | { ok: true; settings: ScoringSettings }
  | { ok: false; blanks: BlankPlace[] };

const PLACE_TABLES: readonly PlaceTableName[] = ['scoringPoints', 'relayPoints', 'divingPoints'];

/** A cell a user has not filled in: `null`, `undefined`, or a number that is not finite. */
function isBlank(cell: number | null | undefined): boolean {
  return typeof cell !== 'number' || !Number.isFinite(cell);
}

/**
 * Turn a settings draft into stored settings, or name every blank cell.
 *
 * Returns `{ ok: false, blanks }` while any cell of any table is blank, in table
 * order then place order. Returns `{ ok: true, settings }` otherwise, with every
 * table as a plain `number[]`. Values are copied as entered: no clamping, no
 * sorting, no rule is applied here. An optional table with no cells at all is
 * "not enabled" and is left out of the settings.
 */
export function finalizeScoringDraft(draft: ScoringSettingsDraft): FinalizeScoringDraftResult {
  const blanks: BlankPlace[] = [];
  for (const table of PLACE_TABLES) {
    const cells = draft[table];
    if (!cells) continue;
    cells.forEach((cell, i) => {
      if (isBlank(cell)) blanks.push({ table, place: i + 1 });
    });
  }
  if (blanks.length > 0) return { ok: false, blanks };

  const { scoringPoints, relayPoints, divingPoints, ...rest } = draft;
  const settings: ScoringSettings = { ...rest, scoringPoints: [...(scoringPoints as number[])] };
  if (relayPoints && relayPoints.length > 0) settings.relayPoints = [...(relayPoints as number[])];
  if (divingPoints && divingPoints.length > 0) settings.divingPoints = [...(divingPoints as number[])];
  return { ok: true, settings };
}

/** True for +Infinity and -Infinity. Zod 4 reports these as a type failure, not `not_finite`. */
function isInfinite(value: unknown): boolean {
  return value === Infinity || value === -Infinity;
}

/**
 * A place-value table, as a scoring RULE SET (a preset) may be written.
 *
 * Rejects an empty table, a non-finite or negative value, and a table that goes
 * *up* as places get worse. None of those is a competition rule; accepting one
 * produces a plausible team total nobody can trace to a published table.
 *
 * Moved here from `apps/shell/lib/routes/scoringPresetRoutes.ts` unchanged.
 */
export function pointsTableSchema(field: string) {
  return z
    .array(
      // Zod 4 has no `.finite()`: `z.number()` refuses ±Infinity with a type issue,
      // so the Zod 3 "finite" message is attached to that issue. Other type
      // failures keep the default text, as before.
      z.number({
        error: iss =>
          isInfinite(iss.input) ? `${field}: every place value must be a finite number.` : undefined,
      })
    )
    .min(1, `${field} must list at least one place value.`)
    .superRefine((places, ctx) => {
      places.forEach((value, i) => {
        if (value < 0) {
          ctx.addIssue({
            code: 'custom',
            path: [i],
            message: `${field}: place ${i + 1} is ${value}; place values cannot be negative.`,
          });
        }
      });
      for (let i = 1; i < places.length; i += 1) {
        if (itemAt(places, i) > itemAt(places, i - 1)) {
          ctx.addIssue({
            code: 'custom',
            path: [i],
            message:
              `${field}: place ${i + 1} is worth ${places[i]} but place ${i} is worth ` +
              `${places[i - 1]}. A place table must not increase as places get worse.`,
          });
        }
      }
    });
}

/**
 * The light check a STORED workspace's place tables pass on every save: finite
 * numbers, none negative, none null, at least one entry.
 *
 * It does NOT apply the non-increasing rule {@link pointsTableSchema} applies to a
 * preset. A workspace saved before that rule existed, or one a coach edited to a
 * table that rises, must still save: this check refuses a blank or a non-number
 * and nothing else, so a legacy table is never locked out of its own workspace.
 */
export function storedPlaceTableSchema(field: string) {
  return z
    .array(
      z
        .number({
          // Zod 4 has no `invalid_type_error` and no `.finite()`: `z.number()` itself
          // refuses ±Infinity and NaN with an `invalid_type` issue. This keeps the
          // three Zod 3 messages: a missing value reads as the default, an infinite
          // value as "finite", anything else that is not a number as "blank".
          error: iss => {
            if (iss.input === undefined) return undefined;
            return isInfinite(iss.input)
              ? `${field}: every place value must be a finite number.`
              : `${field}: every place value must be a number, not blank.`;
          },
        })
        .nonnegative(`${field}: place values cannot be negative.`)
    )
    .min(1, `${field} must list at least one place value.`);
}
