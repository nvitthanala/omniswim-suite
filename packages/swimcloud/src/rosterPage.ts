/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Team roster page parser (`/team/{id}/roster/`).
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractRowCells,
  extractTableRows,
  findElementSpans,
  findTables,
  htmlToText,
  isHeaderRow,
  stripNonContent,
} from './html';
import { itemAt, regexGroup } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type { HtmlElementSpan } from './html';
import type {
  SwimCloudAthlete,
  SwimCloudClassYear,
  SwimCloudGender,
  SwimCloudTeam,
  SwimCloudTeamId,
} from './entities';
import { SWIMCLOUD_REAL_CAPTURE_CONFIDENCE, fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import {
  classTokens,
  firstHeadingText,
  readAttribute,
  startTagOf,
} from './parseElements';
import { mapGender, swimmerIdFromCell } from './swimFields';
import {
  CLASS_HEADERS,
  HOMETOWN_HEADERS,
  NAME_HEADERS,
  cellAt,
  findColumn,
  normalizeHeader,
  textAt,
} from './parseCells';

const CLASS_YEARS: Readonly<Record<string, SwimCloudClassYear>> = {
  fr: 'FR',
  freshman: 'FR',
  'fr 1': 'FR',
  so: 'SO',
  sophomore: 'SO',
  jr: 'JR',
  junior: 'JR',
  sr: 'SR',
  senior: 'SR',
  gr: 'GR',
  grad: 'GR',
  graduate: 'GR',
};

/* -------------------------------------------------------------------------- */
/* Team roster                                                                 */
/* -------------------------------------------------------------------------- */

/** Caller-supplied fallbacks for facts a roster capture's markup may not state. */
export interface SwimCloudRosterParseOptions {
  /**
   * The gender this roster was filtered to, used **only when the page itself
   * does not say**.
   *
   * The real capture does say: the roster card's heading prints
   * `Season 2025-2026 Men`, and the filter form marks the matching radio
   * `checked`. Where the page states a gender, the page wins and a disagreeing
   * option raises `contradicted-page-declaration` — labelling a men's roster
   * `Women` because a UI dropdown said so is exactly the silent, plausible
   * wrongness this package exists to prevent.
   *
   * Never inferred from athlete names. With neither source, the parse still
   * succeeds but no {@link SwimCloudTeam} is produced, because a team record
   * without a gender would violate the one-program-per-sponsored-gender rule.
   */
  readonly gender?: SwimCloudGender;
  /** Season label `YYYY-YYYY`, used only when the page's own heading does not carry one. Same page-wins rule as {@link gender}. */
  readonly season?: string;
  /** Team id, for captures whose URL cannot be classified (a Wayback snapshot, say). */
  readonly teamId?: SwimCloudTeamId;
}

/** Where a {@link SwimCloudRosterParse} field's value came from. */
export type SwimCloudRosterFieldSource =
  /** The page stated it — a heading, a title, or the filter form's checked control. */
  | 'page'
  /** The page did not state it and {@link SwimCloudRosterParseOptions} supplied it. */
  | 'caller-supplied';

/** What {@link parseTeamRosterHtml} extracts. */
export interface SwimCloudRosterParse {
  /** From the capture URL, or from {@link SwimCloudRosterParseOptions.teamId}. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** From the page `<title>` (`Roster - {team}`), falling back to an `<h1>`. */
  readonly teamName?: string;
  readonly gender?: SwimCloudGender;
  /** Season label, `YYYY-YYYY` only. A heading label of any other shape leaves this absent with an `unrecognized-season-label` warning. */
  readonly season?: string;
  /** Absent when {@link gender} is. See {@link SwimCloudRosterFieldSource}. */
  readonly genderSource?: SwimCloudRosterFieldSource;
  /** Absent when {@link season} is. See {@link SwimCloudRosterFieldSource}. */
  readonly seasonSource?: SwimCloudRosterFieldSource;
  /**
   * Built **only** when team id, name and gender are all known. Absent otherwise
   * — a half-known team is not a team.
   */
  readonly team?: SwimCloudTeam;
  /**
   * Roster rows, in page order.
   *
   * An empty array here always comes with a `zero-data-rows` warning: it means
   * the roster table existed and listed nobody (a wrong season filter, say),
   * which is a real answer. A missing table is `ok: false` instead.
   */
  readonly athletes: readonly SwimCloudAthlete[];
  /** Data rows seen, including any that failed to parse. */
  readonly rowCount: number;
}

/**
 * Parse a SwimCloud team-roster page (`/team/{id}/roster/`).
 *
 * **Real-capture-verified** as of 2026-09-09 — see the file header. Written
 * against two pages SwimCloud actually served, archived as
 * `tests/fixtures/swimcloud-real-team-roster-58-gender-{m,f}.html` (Henderson
 * State, 35 men and 16 women). Those captures resolved OQ-3.
 *
 * ## The real page shape
 *
 * One `<table>` per (season, gender), inside a `c-card` whose `<h2 class="c-title">`
 * reads `Season {label} {Men|Women}`. Columns are rank, name (linking
 * `/swimmer/{id}`), hometown, class. The table is located by that heading first
 * and by the "a table with a name column" scan second, so a page that adds
 * another table cannot displace it.
 *
 * ## What is deliberately not in the output
 *
 * - **The power index.** Every row ends in a fifth cell linking
 *   `/swimmer/{id}/score/?season_id=…` with a number like `727.45`. That is a
 *   computed power rating, not a roster fact and not a swim time. It is
 *   excluded on purpose, not missed; a field for it would need a stated use and
 *   a decision about whether the number is trustworthy, and it has neither.
 * - **The row's rank number.** The leading `1…35` cell is a position in the
 *   page's current sort (`?sort=name` or `?sort=perf`), not a property of the
 *   swimmer, so recording it would invite treating a sort artifact as a ranking.
 * - **A `season_id`.** The page's filter form publishes an id-to-label table
 *   (`29` → `2025-2026`, `30` → `2026-2027`, and so on downward). Nothing
 *   proves that numbering is stable or site-wide, so no id is stored, computed,
 *   or reversed out of a label anywhere. To fetch a roster, omit `season_id`
 *   and let the server serve its own current season — which is what both real
 *   captures show it doing.
 *
 * ## Gender and season
 *
 * Both come from the page when the page states them, and the caller's options
 * only fill a gap. The URL's `?gender=` value is deliberately **not** consulted:
 * `SwimCloudTeamRosterQuery` documents why that parameter's encoding is carried
 * verbatim and never interpreted, and the printed word answers the same question
 * without an assumption. The heading and the filter form's checked radio are
 * cross-checked against each other; on both real captures they agree, and a
 * future disagreement raises `contradicted-page-declaration` instead of being
 * resolved silently.
 */
/**
 * SwimCloud's own words when a team+gender+season combination has no roster.
 *
 * Taken verbatim from a real capture: `/team/10002824/roster/?gender=M`, the
 * men's roster of a school that fields only a women's programme. The page
 * returns HTTP 200 with the full chrome and this message where the table would
 * be. Matching on the site's rendered copy rather than on "the table is
 * missing" is what separates a real answer from a broken parse.
 */
const ROSTER_EMPTY_STATE = /no\s+rosters?\s+found/i;

export function parseTeamRosterHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudRosterParseOptions = {},
): SwimCloudParseResult<SwimCloudRosterParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const teamIdFromUrl = teamIdFromSourceUrl(context.sourceUrl);
  if (teamIdFromUrl.mismatch) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${teamIdFromUrl.mismatch} resource, not a team or team roster.`,
      warnings,
      confidence,
    );
  }
  const swimCloudTeamId = options.teamId ?? teamIdFromUrl.teamId;

  const cleaned = stripNonContent(html);
  const tables = findTables(cleaned);
  if (tables.length === 0) {
    // A missing table is only a failure if the page did not tell us why it is
    // missing. SwimCloud renders "No rosters found" when a school does not
    // field this gender -- University of West Florida's men's roster is the
    // case this was written against -- and reporting that as a parse error
    // makes a correct answer look like a bug, then hides the real signal in a
    // list of failures. `CLAUDE.md`: absent is not the same as empty, and an
    // unsponsored gender must render as unknown rather than as nothing.
    if (ROSTER_EMPTY_STATE.test(cleaned)) {
      warnings.push({
        code: 'no-roster-posted',
        message:
          'SwimCloud returned its "No rosters found" empty state, so this team publishes no roster for this gender and season. This is a real answer, not a missing table.',
      });
      return succeed(
        context,
        {
          ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
          athletes: [],
          rowCount: 0,
        },
        warnings,
        confidence,
      );
    }
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found, and the page did not render SwimCloud\'s "No rosters found" empty state either, so this is a genuine parse failure rather than an empty roster.',
      warnings,
      confidence,
    );
  }

  const located = locateRosterTable(cleaned, tables);
  if (located === null) {
    return fail(
      context,
      'expected-header-missing',
      `No table carried a name column (looked for ${NAME_HEADERS.join(', ')}).`,
      warnings,
      confidence,
    );
  }
  const { headerCells, dataRows, nameColumn } = located;

  const classColumn = findColumn(headerCells, CLASS_HEADERS);
  const hometownColumn = findColumn(headerCells, HOMETOWN_HEADERS);

  const athletes: SwimCloudAthlete[] = [];
  const heading = readRosterCardHeading(cleaned, warnings);
  const gender = resolveRosterGender(cleaned, heading.gender, options.gender, warnings);
  const season = resolveRosterSeason(heading.season, options.season, warnings);

  dataRows.forEach((cells, rowIndex) => {
    const name = textAt(cells, nameColumn);
    if (name.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Roster row has an empty name cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const swimmerId = swimmerIdFromCell(cellAt(cells, nameColumn));
    if (swimmerId === undefined) {
      warnings.push({
        code: 'missing-athlete-link',
        message: `Roster row for ${name} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
        rowIndex,
        raw: name,
      });
    }

    athletes.push({
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      name,
      ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
      ...readRosterClassYear(cells, classColumn, rowIndex, warnings),
      ...(gender.value === undefined ? {} : { gender: gender.value }),
      ...(season.value === undefined ? {} : { season: season.value }),
      ...readRosterHometown(cells, hometownColumn),
    });
  });

  if (dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message:
        'The roster table was found and holds no data rows. This is a real "nobody is listed" answer, not a missing table.',
    });
  } else if (athletes.length === 0) {
    return fail(
      context,
      'no-rows-parsed',
      `The roster table held ${dataRows.length} data row(s) and none could be parsed.`,
      warnings,
      confidence,
    );
  }

  const teamName = rosterTeamName(cleaned);
  const team = buildTeam(swimCloudTeamId, teamName, gender.value, season.value);

  return succeed(
    context,
    {
      ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
      ...(teamName === undefined ? {} : { teamName }),
      ...(gender.value === undefined ? {} : { gender: gender.value, genderSource: gender.source }),
      ...(season.value === undefined ? {} : { season: season.value, seasonSource: season.source }),
      ...(team === undefined ? {} : { team }),
      athletes,
      rowCount: dataRows.length,
    },
    warnings,
    confidence,
  );
}

/** One roster table, located and split into a header row and its data rows. */
interface LocatedRosterTable {
  /** {@link normalizeHeader}-normalized printed header labels. */
  readonly headerCells: readonly string[];
  /** Body rows, each already split into cell fragments. */
  readonly dataRows: readonly string[][];
  /** Index of the name column within {@link headerCells}. */
  readonly nameColumn: number;
}

/**
 * The roster table, preferring the one belonging to the page's own
 * `Season …` card.
 *
 * Both routes require a name column, so neither can pick up a sidebar table.
 * The card lookup exists because the real page carries its roster inside a
 * titled `c-card`, which is a stronger signal than table order and stays
 * correct if SwimCloud adds another table above it. The scan is the fallback
 * for a capture with no such card (the synthetic fixture, a trimmed snapshot).
 */
function locateRosterTable(
  cleaned: string,
  tables: readonly HtmlElementSpan[],
): LocatedRosterTable | null {
  const cardTable = locateSeasonCardTable(cleaned);
  const ordered = cardTable === null ? tables : [cardTable, ...tables];
  for (const table of ordered) {
    const rows = extractTableRows(table.html);
    if (rows.length === 0) {
      continue;
    }
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const headerCells = extractRowCells(itemAt(rows, headerIndex)).map((cell) =>
      normalizeHeader(htmlToText(cell)),
    );
    const nameColumn = findColumn(headerCells, NAME_HEADERS);
    if (nameColumn < 0) {
      continue;
    }
    return {
      headerCells,
      nameColumn,
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    };
  }
  return null;
}

/** `Season 2025-2026 Men` — the roster card's own heading, as the real page prints it. */
const ROSTER_SEASON_HEADING = /^season\b\s*(.*)$/i;

/** A season label this parser will record. Anything else is reported, not reshaped. */
const SEASON_LABEL = /^\d{4}-\d{4}$/;

/** The `<h2 class="c-title">` of the roster card, when the page has one. */
function findSeasonCardHeading(cleaned: string): HtmlElementSpan | undefined {
  return findElementSpans(cleaned, 'h2').find(
    (h) =>
      classTokens(startTagOf(h.html)).includes('c-title') &&
      ROSTER_SEASON_HEADING.test(htmlToText(h.inner).trim()),
  );
}

/** The nearest table starting after the roster card's heading. */
function locateSeasonCardTable(cleaned: string): HtmlElementSpan | null {
  const heading = findSeasonCardHeading(cleaned);
  if (heading === undefined) {
    return null;
  }
  const after = findTables(cleaned).filter((t) => t.start > heading.start);
  if (after.length === 0) {
    return null;
  }
  return after.reduce((closest, t) => (t.start < closest.start ? t : closest));
}

/**
 * The season label and gender word the roster card's heading prints.
 *
 * The heading is one string carrying both facts — `Season 2025-2026 Men`. The
 * trailing gender word is taken off first, and what remains is the season
 * label. A label outside `YYYY-YYYY` is **not** reshaped into one: it is
 * reported with the raw text and the season is left absent, the same rule
 * {@link readMeetDateRange} follows for an unrecognized meet date.
 */
function readRosterCardHeading(
  cleaned: string,
  warnings: SwimCloudParseWarning[],
): { season?: string; gender?: SwimCloudGender } {
  const heading = findSeasonCardHeading(cleaned);
  if (heading === undefined) {
    return {};
  }
  const match = ROSTER_SEASON_HEADING.exec(htmlToText(heading.inner).trim());
  if (match === null) {
    return {};
  }

  let rest = regexGroup(match, 1).trim();
  let gender: SwimCloudGender | undefined;
  const trailing = /\s*(men|women|mens|womens|mixed|boys|girls)$/i.exec(rest);
  if (trailing !== null) {
    const mapped = mapGender(trailing[1]);
    if (mapped !== 'unknown') {
      gender = mapped;
    }
    rest = rest.slice(0, trailing.index).trim();
  }

  if (rest.length === 0) {
    return gender === undefined ? {} : { gender };
  }
  if (!SEASON_LABEL.test(rest)) {
    warnings.push({
      code: 'unrecognized-season-label',
      message: `Roster heading season label ${JSON.stringify(rest)} is not the YYYY-YYYY shape; no season recorded.`,
      raw: rest,
    });
    return gender === undefined ? {} : { gender };
  }
  return { season: rest, ...(gender === undefined ? {} : { gender }) };
}

/**
 * The gender printed on the filter form's checked radio — the page's second,
 * independent statement of the same fact.
 *
 * The **label's printed word** is read, never the input's `value`. `value="M"`
 * next to the word `Men` is suggestive but is still an encoding nobody has been
 * told, which is the same reason `SwimCloudTeamRosterQuery` carries `gender`
 * verbatim without interpreting it.
 */
function readCheckedGenderLabel(cleaned: string): SwimCloudGender | undefined {
  for (const label of findElementSpans(cleaned, 'label')) {
    if (!hasCheckedGenderInput(label.inner)) {
      continue;
    }
    const mapped = mapGender(/^\s*(men|women|mens|womens)\b/i.exec(htmlToText(label.inner))?.[1]);
    if (mapped !== 'unknown') {
      return mapped;
    }
  }
  return undefined;
}

const INPUT_TAG = /<input\b[^>]*>/gi;

function hasCheckedGenderInput(fragment: string): boolean {
  INPUT_TAG.lastIndex = 0;
  for (let match = INPUT_TAG.exec(fragment); match !== null; match = INPUT_TAG.exec(fragment)) {
    const tag = match[0];
    if (readAttribute(tag, 'name') !== 'gender') {
      continue;
    }
    // `checked=""` and a bare `checked` are the same assertion; only the first
    // has a value for `readAttribute` to find.
    if (readAttribute(tag, 'checked') !== undefined || /\schecked(?=[\s/>])/i.test(tag)) {
      INPUT_TAG.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/** One page-versus-page or page-versus-caller disagreement, surfaced rather than resolved silently. */
function warnContradiction(
  warnings: SwimCloudParseWarning[],
  field: string,
  winner: string,
  loser: string,
  loserSource: string,
): void {
  warnings.push({
    code: 'contradicted-page-declaration',
    message: `The page's roster heading says the ${field} is ${JSON.stringify(winner)}; ${loserSource} says ${JSON.stringify(loser)}. The heading wins.`,
    raw: `${winner} vs ${loser}`,
  });
}

/** The page's heading wins; the filter form and the caller's option are cross-checks. */
function resolveRosterGender(
  cleaned: string,
  fromHeading: SwimCloudGender | undefined,
  fromOptions: SwimCloudGender | undefined,
  warnings: SwimCloudParseWarning[],
): { value?: SwimCloudGender; source?: SwimCloudRosterFieldSource } {
  const fromForm = readCheckedGenderLabel(cleaned);
  if (fromHeading !== undefined && fromForm !== undefined && fromHeading !== fromForm) {
    warnContradiction(warnings, 'gender', fromHeading, fromForm, "the filter form's checked control");
  }
  const fromPage = fromHeading ?? fromForm;
  if (fromPage !== undefined) {
    if (fromOptions !== undefined && fromOptions !== fromPage) {
      warnContradiction(warnings, 'gender', fromPage, fromOptions, 'the caller-supplied option');
    }
    return { value: fromPage, source: 'page' };
  }
  return fromOptions === undefined ? {} : { value: fromOptions, source: 'caller-supplied' };
}

/** Same page-wins rule as {@link resolveRosterGender}. */
function resolveRosterSeason(
  fromHeading: string | undefined,
  fromOptions: string | undefined,
  warnings: SwimCloudParseWarning[],
): { value?: string; source?: SwimCloudRosterFieldSource } {
  if (fromHeading !== undefined) {
    if (fromOptions !== undefined && fromOptions !== fromHeading) {
      warnContradiction(warnings, 'season', fromHeading, fromOptions, 'the caller-supplied option');
    }
    return { value: fromHeading, source: 'page' };
  }
  return fromOptions === undefined ? {} : { value: fromOptions, source: 'caller-supplied' };
}

function readRosterClassYear(
  cells: readonly string[],
  classColumn: number,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): { classYear?: SwimCloudClassYear } {
  if (classColumn < 0) {
    return {};
  }
  const rawClass = textAt(cells, classColumn);
  if (rawClass.length === 0) {
    // No class cell is a real "the page did not say", never a defaulted year.
    return {};
  }
  // SwimCloud prints a dash when it has no class year for an athlete. That is
  // the same statement as an empty cell -- "the page did not say" -- so it is
  // treated identically and not reported as an unknown vocabulary word. Covers
  // the hyphen, the non-breaking hyphen, and the en and em dashes, because the
  // real capture that prompted this used U+2013 rather than a plain '-'.
  if (/^[-‐‑‒–—―]+$/.test(rawClass)) {
    return {};
  }
  const mapped = CLASS_YEARS[normalizeHeader(rawClass)];
  if (mapped !== undefined) {
    return { classYear: mapped };
  }
  warnings.push({
    code: 'unmapped-class-year',
    message: `Class year ${JSON.stringify(rawClass)} is outside the known vocabulary; recorded as unknown.`,
    rowIndex,
    raw: rawClass,
  });
  return { classYear: 'unknown' };
}

/** A hometown cell holding a bare country code and no city — `MEX`, `USA`, `HUN`, `LTU` on the real capture. */
const BARE_COUNTRY_CODE = /^[A-Z]{3}$/;

/** See {@link SwimCloudAthlete.hometownCountryCode} for why these are two fields. */
function readRosterHometown(
  cells: readonly string[],
  hometownColumn: number,
): { hometown?: string; hometownCountryCode?: string } {
  if (hometownColumn < 0) {
    return {};
  }
  const text = textAt(cells, hometownColumn);
  if (text.length === 0) {
    return {};
  }
  if (BARE_COUNTRY_CODE.test(text)) {
    return { hometownCountryCode: text };
  }
  return { hometown: text };
}

function buildTeam(
  teamId: SwimCloudTeamId | undefined,
  teamName: string | undefined,
  gender: SwimCloudGender | undefined,
  season: string | undefined,
): SwimCloudTeam | undefined {
  if (teamId === undefined || teamName === undefined || gender === undefined) {
    return undefined;
  }
  return {
    swimCloudTeamId: teamId,
    gender,
    name: teamName,
    ...(season === undefined ? {} : { season }),
  };
}

/** `Roster - Henderson State University`, the only place the real roster page names the team. */
const ROSTER_TITLE = /^roster\s*-\s*(.+)$/i;

/**
 * The team's name.
 *
 * The real roster page carries no `<h1>` and no bare `/team/{id}/` link with the
 * team's name on it — its nav links to `/team/58/` under the word `Home`, which
 * is how a link-based rule would name the team "Home". The `<title>` is the one
 * place the name appears, as `Roster - {team}`; the prefix is stripped only when
 * it is exactly there, so a title of some other shape is used whole rather than
 * cut at a guessed separator. An `<h1>` is the fallback, for a capture whose
 * `<head>` was trimmed away.
 */
function rosterTeamName(cleaned: string): string | undefined {
  const title = findElementSpans(cleaned, 'title')[0];
  if (title !== undefined) {
    const text = htmlToText(title.inner);
    const match = ROSTER_TITLE.exec(text);
    const name = (match === null ? text : regexGroup(match, 1)).trim();
    if (name.length > 0) {
      return name;
    }
  }
  return firstHeadingText(cleaned);
}

function teamIdFromSourceUrl(sourceUrl: string): {
  teamId?: SwimCloudTeamId;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'team' || resource.kind === 'teamRoster' || resource.kind === 'teamResults') {
    return { teamId: resource.teamId };
  }
  return { mismatch: resource.kind };
}
