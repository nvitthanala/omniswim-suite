/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reads the season picker off a SwimCloud team page.
 *
 * ## Why this exists
 *
 * A team roster page filters by `season_id`, a numeric id. The page prints the
 * id-to-label table itself, in the `<select name="season_id">` of its filter
 * form (`30` is `2026-2027`, `29` is `2025-2026`, and so on). Nothing proves
 * that table is stable over time or shared by every team. So this module never
 * computes, offsets or reverses an id from a label. It copies the id verbatim
 * from the option the page printed, and a caller resolves a season **per team,
 * from that team's own page**.
 *
 * ## Fail loudly
 *
 * A missing select, an unreadable label or a duplicate throws a
 * {@link TeamSeasonParseError}. There is no empty-list default: "this page has
 * no seasons" and "this parser found none" must never look the same, because
 * the second one silently becomes "no season to crawl".
 *
 * The first option, `----- All Seasons -----`, has an empty value and is not a
 * season. It is skipped by its empty value, not by its label.
 *
 * Pure: no network, no DOM, no clock.
 */

import { collapseWhitespace, decodeHtmlEntities, stripHtmlTags, stripNonContent } from './html';

declare const teamSeasonOptionBrand: unique symbol;

/**
 * One season a team's own page offers.
 *
 * Branded so a bare string, or an object written by hand, does not type-check
 * where a season is required. The only producer is {@link parseTeamSeasonOptions}.
 * The brand exists at compile time only. A value that crossed `JSON.stringify`
 * keeps its fields but loses the brand, and a consumer such as
 * `planTeamSeasonRoster` re-checks the shape at run time.
 */
export interface TeamSeasonOption {
  readonly [teamSeasonOptionBrand]: true;
  /** The option's `value`, verbatim. A string of digits. Never computed. */
  readonly seasonId: string;
  /** The option's text, for example `2025-2026`. */
  readonly label: string;
  /** `2025` for `2025-2026`. */
  readonly startYear: number;
  /** `2026` for `2025-2026`. Always `startYear + 1`. */
  readonly endYear: number;
  /** True when the page printed `selected` on this option (the server's current season). */
  readonly selected: boolean;
}

export type TeamSeasonParseErrorCode =
  /** No `<select name="season_id">` on the page. */
  | 'season-select-missing'
  /** More than one `<select name="season_id">`: which one is this team's is not decidable. */
  | 'season-select-ambiguous'
  /** The select holds no option other than the empty "All Seasons" one. */
  | 'no-season-options'
  /** An option has no `value` attribute at all. */
  | 'option-value-missing'
  /** An option value is not a string of digits, so it cannot be put in a URL as an id. */
  | 'season-id-invalid'
  /** An option label is not `YYYY-YYYY`, or its end year is not its start year plus one. */
  | 'season-label-invalid'
  /** Two options share a season id or a label. */
  | 'season-duplicate'
  /** More than one option is marked `selected`. */
  | 'season-selected-ambiguous';

/** Thrown by {@link parseTeamSeasonOptions}. Carries a code a caller can branch on. */
export class TeamSeasonParseError extends Error {
  readonly code: TeamSeasonParseErrorCode;

  constructor(code: TeamSeasonParseErrorCode, detail: string) {
    super(`parseTeamSeasonOptions: ${code}: ${detail}`);
    this.name = 'TeamSeasonParseError';
    this.code = code;
  }
}

// `\s` before `name`: `data-name="season_id"` must not match. Comments are
// removed before this runs (see parseTeamSeasonOptions).
const SEASON_SELECT = /<select\b[^>]*\sname\s*=\s*["']season_id["'][^>]*>([\s\S]*?)<\/select>/gi;
const OPTION = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
// One attribute: its name, and its quoted value when it has one. Walking the
// attributes in order consumes each quoted value whole, so `value=` written
// inside another attribute's text (`title=" value='5' "`) is never an attribute.
const ATTRIBUTE = /(?:^|\s)([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
const QUOTED_VALUE = /"[^"]*"|'[^']*'/g;
const SELECTED_ATTRIBUTE =/(?:^|\s)selected(?:\s|=|$)/i;
const SEASON_LABEL = /^(\d{4})-(\d{4})$/;
const SEASON_ID = /^[0-9]+$/;

interface RawOption {
  readonly value: string;
  readonly text: string;
  readonly selected: boolean;
}

/** The quoted `value` attribute, matched by exact name (`data-value` is a different attribute). */
function readValueAttribute(attributes: string): string | undefined {
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() !== 'value') continue;
    const quoted = match[2] ?? match[3];
    if (quoted !== undefined) return quoted;
  }
  return undefined;
}

function readOption(attributes: string, inner: string): RawOption {
  const rawValue = readValueAttribute(attributes);
  if (rawValue === undefined) {
    throw new TeamSeasonParseError(
      'option-value-missing',
      `an <option> has no value attribute: ${JSON.stringify(attributes.trim())}.`,
    );
  }
  const value = decodeHtmlEntities(rawValue);
  const text = collapseWhitespace(decodeHtmlEntities(stripHtmlTags(inner)));
  // Quoted attribute values are blanked first so text inside one
  // (`data-x="a selected b"`) is never read as the boolean attribute.
  const selected = SELECTED_ATTRIBUTE.test(attributes.replace(QUOTED_VALUE, '""'));
  return { value, text, selected };
}

function toSeasonOption(raw: RawOption): TeamSeasonOption {
  if (!SEASON_ID.test(raw.value)) {
    throw new TeamSeasonParseError(
      'season-id-invalid',
      `option value ${JSON.stringify(raw.value)} (label ${JSON.stringify(raw.text)}) is not a string of digits.`,
    );
  }
  const label = SEASON_LABEL.exec(raw.text);
  if (label === null) {
    throw new TeamSeasonParseError(
      'season-label-invalid',
      `option label ${JSON.stringify(raw.text)} (value ${JSON.stringify(raw.value)}) is not YYYY-YYYY.`,
    );
  }
  const startYear = Number(label[1]);
  const endYear = Number(label[2]);
  if (endYear !== startYear + 1) {
    throw new TeamSeasonParseError(
      'season-label-invalid',
      `option label ${JSON.stringify(raw.text)} does not span consecutive years.`,
    );
  }
  return {
    seasonId: raw.value,
    label: raw.text,
    startYear,
    endYear,
    selected: raw.selected,
  } as TeamSeasonOption;
}

/**
 * The seasons a team page offers, in the order the page lists them.
 *
 * Reads `<select name="season_id">`, ignoring HTML comments and `data-name` look-alikes. Skips the option whose value is empty
 * (`----- All Seasons -----`). Throws {@link TeamSeasonParseError} on anything
 * it cannot read exactly; see that type's codes.
 */
export function parseTeamSeasonOptions(html: string): readonly TeamSeasonOption[] {
  // A commented-out <option> or <select> is not on the page.
  const selects = [...stripNonContent(html).matchAll(SEASON_SELECT)];
  if (selects.length === 0) {
    throw new TeamSeasonParseError('season-select-missing', 'the page has no <select name="season_id">.');
  }
  if (selects.length > 1) {
    throw new TeamSeasonParseError(
      'season-select-ambiguous',
      `the page has ${selects.length} <select name="season_id"> elements.`,
    );
  }

  const options: TeamSeasonOption[] = [];
  for (const match of selects[0][1].matchAll(OPTION)) {
    const raw = readOption(match[1], match[2]);
    if (raw.value === '') continue;
    options.push(toSeasonOption(raw));
  }
  if (options.length === 0) {
    throw new TeamSeasonParseError(
      'no-season-options',
      'the season select holds no option except the empty "All Seasons" one.',
    );
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const option of options) {
    if (ids.has(option.seasonId) || labels.has(option.label)) {
      throw new TeamSeasonParseError(
        'season-duplicate',
        `season id ${option.seasonId} or label ${option.label} appears more than once.`,
      );
    }
    ids.add(option.seasonId);
    labels.add(option.label);
  }
  if (options.filter((option) => option.selected).length > 1) {
    throw new TeamSeasonParseError('season-selected-ambiguous', 'more than one season option is selected.');
  }
  return options;
}

/**
 * The option with exactly this label, or `undefined`.
 *
 * `undefined` is "this team's page does not offer that season". It is not an
 * error and it is never replaced with a nearby or computed season.
 */
export function resolveSeasonOption(
  options: readonly TeamSeasonOption[],
  label: string,
): TeamSeasonOption | undefined {
  return options.find((option) => option.label === label);
}

/**
 * True when `value` has every field of a {@link TeamSeasonOption}, with a digit
 * id and a label that agrees with its years.
 *
 * A run-time check for callers that cannot rely on the compile-time brand
 * (plain JS, or a value that went through JSON). It proves the shape, not that
 * the page printed it.
 */
export function hasTeamSeasonOptionShape(value: unknown): value is TeamSeasonOption {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seasonId !== 'string' || !SEASON_ID.test(v.seasonId)) return false;
  if (typeof v.label !== 'string' || typeof v.selected !== 'boolean') return false;
  if (typeof v.startYear !== 'number' || typeof v.endYear !== 'number') return false;
  const label = SEASON_LABEL.exec(v.label);
  return label !== null && Number(label[1]) === v.startYear && Number(label[2]) === v.endYear && v.endYear === v.startYear + 1;
}
