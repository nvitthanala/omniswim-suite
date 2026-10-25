/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Header mapping and table-column helpers shared by the SwimCloud page parsers.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import { collapseWhitespace, extractRowCells, htmlToText } from './html';
import { itemAt } from './indexed';
import { readAttribute } from './parseElements';
import { swimmerIdFromCell } from './swimFields';

/* -------------------------------------------------------------------------- */
/* Header mapping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Columns are located by their **printed header label**, not by position and not
 * by CSS class.
 *
 * A label is what a human sees and is the thing least likely to change silently
 * when a site restyles; a column index is the thing most likely to. Anything
 * that cannot be located by label is reported as a missing header, never
 * guessed at by position.
 */
export function normalizeHeader(label: string): string {
  return collapseWhitespace(label.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

export function findColumn(headers: readonly string[], synonyms: readonly string[]): number {
  for (const [index, header] of headers.entries()) {
    if (synonyms.includes(header)) {
      return index;
    }
  }
  return -1;
}

export const NAME_HEADERS = ['name', 'athlete', 'swimmer'] as const;

export const CLASS_HEADERS = ['class', 'yr', 'year', 'class year', 'grade'] as const;

export const HOMETOWN_HEADERS = ['hometown', 'home town', 'hometown high school'] as const;

export const TEAM_HEADERS = ['team', 'school', 'club'] as const;

export const PLACE_HEADERS = ['place', 'pl', 'pos', 'rank'] as const;

export const TIME_HEADERS = ['time', 'finals', 'finals time', 'final time', 'result', 'score'] as const;

export const POINTS_HEADERS = ['points', 'pts', 'score points', 'team points'] as const;

export function cellAt(cells: readonly string[], index: number): string {
  if (index < 0 || index >= cells.length) {
    return '';
  }
  return itemAt(cells, index);
}

export function textAt(cells: readonly string[], index: number): string {
  return htmlToText(cellAt(cells, index));
}

export const EVENT_LABEL_HEADERS = ['event', 'race'] as const;

export const DATE_HEADERS = ['date', 'swam'] as const;

export const MEET_HEADERS = ['meet', 'competition'] as const;

/* ---- Header columns, colspan-aware ----------------------------------------- */

/** One header cell, and the body columns it covers. */
export interface SwimsHeaderColumn {
  /** {@link normalizeHeader}-normalized printed label. */
  readonly label: string;
  /** 0-based index of the first body cell this header covers. */
  readonly start: number;
  /** How many body cells it covers — its `colspan`, or 1. */
  readonly span: number;
}

/** Same set, same order, as `extractRowCells`'s own splitter, so index `n` here is cell `n` there. */
const CELL_START_TAG = /<(?:td|th)\b[^>]*>/gi;

/**
 * Header cells with the body columns each one covers.
 *
 * **`colspan` is not optional detail here.** Every real results table opens with
 * `<th colspan="2">Name</th>` spanning the row-ordinal column and the athlete
 * column, so a header row has seven cells against a body row's eight. Pairing
 * them by position — the obvious implementation — puts `Event` over the athlete
 * name and shifts every column after it by one, silently, with no parse error to
 * show for it.
 */
export function readHeaderColumns(headerRowHtml: string): SwimsHeaderColumn[] {
  const cells = extractRowCells(headerRowHtml);
  const spans: number[] = [];
  CELL_START_TAG.lastIndex = 0;
  for (
    let match = CELL_START_TAG.exec(headerRowHtml);
    match !== null;
    match = CELL_START_TAG.exec(headerRowHtml)
  ) {
    const raw = readAttribute(match[0], 'colspan');
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    spans.push(Number.isInteger(parsed) && parsed > 0 ? parsed : 1);
  }
  CELL_START_TAG.lastIndex = 0;

  const columns: SwimsHeaderColumn[] = [];
  let start = 0;
  cells.forEach((cell, index) => {
    const span = spans[index] ?? 1;
    columns.push({ label: normalizeHeader(htmlToText(cell)), start, span });
    start += span;
  });
  return columns;
}

export function columnFor(
  columns: readonly SwimsHeaderColumn[],
  synonyms: readonly string[],
): SwimsHeaderColumn | undefined {
  return columns.find((column) => synonyms.includes(column.label));
}

/**
 * Header labels for the swims table.
 *
 * Deliberately **not** the file's existing {@link TIME_HEADERS}, which lists
 * `score` as a synonym for a time column. On a real meet-root results table both
 * `Time` and `Score` are present and mean different things — `Score` is the
 * meet points the swim earned. Reusing the looser list would let a restyle that
 * reorders those two columns bind a time field to a score.
 */
export const SWIMS_EVENT_HEADERS = ['event'] as const;

export const SWIMS_TIME_HEADERS = ['time'] as const;

export const SWIMS_PLACE_HEADERS = ['place'] as const;

export const SWIMS_FLAGS_HEADERS = ['flags'] as const;

/**
 * The `Pts` column — SwimCloud's **power index**, not meet points.
 *
 * `'pts avg'` is deliberately absent: the `High point` card prints that as an
 * average over a swimmer's meet, and matching it here would read one table's
 * average into another table's per-swim field.
 */
export const SWIMS_POINTS_HEADERS = ['pts', 'points'] as const;

/**
 * The `Score` column — the meet points the swim actually earned.
 *
 * A different quantity from {@link SWIMS_POINTS_HEADERS}, and the real capture
 * proves it rather than merely suggesting it: the meet-root results card carries
 * **both** columns on the same row, reading `Score` 20 and `Pts` 846 for one
 * first-place 1000 Free. See {@link SwimCloudTeamMeetSwim.meetScore}.
 */
export const SWIMS_SCORE_HEADERS = ['score'] as const;

/**
 * Which cell inside a spanned `Name` header actually holds the athlete.
 *
 * The athlete's cell is the one carrying the `/swimmer/{id}/` link. Falling back
 * to the **last** cell of the span rather than the first is what keeps a row's
 * printed ordinal (`1`, `2`, …) out of the athlete-name field on a capture whose
 * athlete happens to have no profile link.
 */
export function subjectCellIndex(cells: readonly string[], column: SwimsHeaderColumn): number {
  const end = Math.min(column.start + column.span, cells.length);
  for (let index = column.start; index < end; index += 1) {
    const cell = cells[index];
    if (cell !== undefined && swimmerIdFromCell(cell) !== undefined) {
      return index;
    }
  }
  return Math.max(column.start, end - 1);
}
