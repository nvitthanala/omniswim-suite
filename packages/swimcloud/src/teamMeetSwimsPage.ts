/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Team-in-meet swims list parser.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractHrefs,
  extractListItems,
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
  SwimCloudCourse,
  SwimCloudCourseOrUnknown,
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudGender,
  SwimCloudGenderOrUnknown,
  SwimCloudMeet,
  SwimCloudMeetFormat,
  SwimCloudMeetId,
  SwimCloudResult,
  SwimCloudResultFlags,
  SwimCloudRuleset,
  SwimCloudStroke,
  SwimCloudSwimmerId,
  SwimCloudTeam,
  SwimCloudTeamId,
} from './entities';
import { SWIMCLOUD_REAL_CAPTURE_CONFIDENCE, fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import {
  classTokens,
  elementTextById,
  firstHeadingText,
  readAttribute,
  readQueryParam,
  startTagOf,
} from './parseElements';
import {
  mapStroke,
  readFlagsCell,
  readOrdinalPlace,
  readPoints,
  readTime,
  swimmerIdFromCell,
  teamIdFromCell,
} from './swimFields';
import type { SwimCloudCutStandardLabel, SwimFlagsCell } from './swimFields';
import {
  NAME_HEADERS,
  SWIMS_EVENT_HEADERS,
  SWIMS_FLAGS_HEADERS,
  SWIMS_PLACE_HEADERS,
  SWIMS_POINTS_HEADERS,
  SWIMS_SCORE_HEADERS,
  SWIMS_TIME_HEADERS,
  TEAM_HEADERS,
  cellAt,
  columnFor,
  normalizeHeader,
  readHeaderColumns,
  subjectCellIndex,
  textAt,
} from './parseCells';
import type { SwimsHeaderColumn } from './parseCells';
import {
  meetScopeFromSourceUrl,
  missingMeetNameWarning,
  readActiveGenderWord,
  readMeetDateRange,
  readPrintedCourse,
} from './meetPageFields';

/* -------------------------------------------------------------------------- */
/* Team-in-meet swims list — the first real-capture-verified parser            */
/* -------------------------------------------------------------------------- */

/**
 * Caller-supplied facts a swims-list capture's markup cannot be trusted to
 * state. Every one is an assertion the caller makes, never a default this
 * parser reaches for on its own.
 */
export interface SwimCloudTeamMeetSwimsParseOptions {
  /** Meet id, for a capture whose URL cannot be classified (a Wayback snapshot, say). */
  readonly meetId?: SwimCloudMeetId;
  /** Team id, same reason. */
  readonly teamId?: SwimCloudTeamId;
  /**
   * The gender this page was filtered to.
   *
   * Normally unnecessary: the page's own gender dropdown prints `Men` or
   * `Women` on its active item, and that printed word is what this parser
   * reads. Supply this only for a capture missing the dropdown. It
   * **overrides** the printed word when both are present, because a caller
   * asserting a fact outranks a parser reading one.
   */
  readonly gender?: SwimCloudGender;
  /**
   * The meet's course, used only when the page does not print one.
   *
   * A real capture prints it (`<li id="meet-course">SCY</li>`), so this is a
   * fallback, not the primary source.
   */
  readonly meetCourse?: SwimCloudCourse;
  /** Meet format. Omitted means `'unknown'` — never `'dual'`. See {@link SwimCloudMeetResultsParseOptions}. */
  readonly meetFormat?: SwimCloudMeetFormat;
  /** Governing rulebook. Omitted means `'unknown'` — never `'NCAA'`. */
  readonly meetRuleset?: SwimCloudRuleset;
}

/**
 * One row of a swims list: one swim, with the event it was swum in, the entry
 * that swam it, and its result.
 *
 * The page has no event grouping — prelims and finals rows for one event sit
 * apart, sorted by SwimCloud points — so this is deliberately a flat row rather
 * than the event-grouped {@link SwimCloudParsedEvent}. The grouped view is still
 * available as {@link SwimCloudTeamMeetSwimsParse.events}.
 */
export interface SwimCloudTeamMeetSwim {
  /**
   * A key unique to this swim and stable across captures.
   *
   * `{meetId}:swim:{swimCloudSwimId}` whenever the row's time link carried a
   * swim id — which is every row of the real capture. This is what a caller
   * merging page 2 into page 1, or the women's list into the men's, dedupes on.
   *
   * When that link was missing (`missing-swim-link`), this falls back to a
   * composite of values the row *did* print. The fallback is deterministic and
   * built only from real data — it invents no id — but it is only as stable as
   * the values behind it, so a caller needing a true SwimCloud identity should
   * check {@link swimCloudSwimId} instead.
   */
  readonly swimKey: string;
  /** SwimCloud's own id for this swim, from `?id=` on the time cell's link. Absent when the row carried no such link. */
  readonly swimCloudSwimId?: string;
  /** The row's printed leading ordinal (`1`, `2`, …). Presentational; absent when the table has no ordinal column. */
  readonly rowOrdinal?: number;
  readonly event: SwimCloudEvent;
  readonly entry: SwimCloudEntry;
  readonly result: SwimCloudResult;
  /**
   * Convenience mirror of `result.flags?.relayLeadoff`, always a boolean.
   *
   * See {@link SwimCloudResultFlags.relayLeadoff}: a leadoff split is not an
   * individual swim and must not be scored or displayed as one.
   */
  readonly relayLeadoff: boolean;
  /** Cut-standard badges on the row, in printed order. Empty when the row had none. */
  readonly cutStandards: readonly SwimCloudCutStandardLabel[];
  /**
   * The **meet points** this swim earned, from a `Score` column.
   *
   * ## Read this before using `result.points` for scoring
   *
   * `result.points` is the `Pts` column, and `Pts` is SwimCloud's **power
   * index** — a 0-1000-ish rating of how fast a swim is — **not** the points it
   * scored at the meet. `meetScore` is the meet points. They are different
   * numbers and this is measured, not inferred:
   *
   * - The meet-root results card prints **both columns on one row**: `Score` 20
   *   and `Pts` 846, for a first-place 1000 Free.
   * - On the swims list every `Pts` value sits between 692 and 767 and descends
   *   monotonically down the page — the list is sorted by it. Meet points for
   *   thirty swims would be 20, 17, 16, …
   * - Henderson State's actual score for the meet is **1056** — printed twice,
   *   as the team's `Points scored` splash-stat and in the meet-root standings.
   *   The `Pts` column across all 8 pages sums to roughly twenty times that.
   *
   * So a caller must not feed `result.points` into a meet-scoring field. See
   * `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` for the conversion
   * that respects this.
   *
   * **Absent on the swims list**, which has no `Score` column at all — meet
   * points for an individual swim are simply not published on that page.
   * Absent means "the page did not say", never zero.
   */
  readonly meetScore?: number;
}

/**
 * The paginated-list position of a capture.
 *
 * Absent from {@link SwimCloudTeamMeetSwimsParse} entirely when the page carried
 * no `<ul class="c-pagination">`. That absence is the normal single-page case,
 * **not** a parse gap: SwimCloud omits the widget when everything fits on one
 * page, so a caller reads "no pagination" as "one page", never as "unknown page
 * count".
 */
export interface SwimCloudPagination {
  /** 1-based page this capture is of, from the widget's active item. */
  readonly currentPage: number;
  /** Highest page the widget offers. */
  readonly totalPages: number;
  /** The "Next page" link's href exactly as printed, e.g. `'?page=2'`. Absent on the last page. */
  readonly nextPageHref?: string;
}

/** What {@link parseTeamMeetSwimsHtml} extracts. */
export interface SwimCloudTeamMeetSwimsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** From `<h1 id="meet-name">`, falling back to the page's first heading. */
  readonly meetName?: string;
  readonly meet: SwimCloudMeet;
  /** From the capture URL, or {@link SwimCloudTeamMeetSwimsParseOptions.teamId}. Absent on a meet-root capture, which is scoped to no team. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** The team's printed name, from the page's own `/team/{id}` link. */
  readonly teamName?: string;
  /** Built **only** when team id, name and gender are all known. A half-known team is not a team. */
  readonly team?: SwimCloudTeam;
  /** The gender this page was filtered to, from the printed word on the gender dropdown's active item. */
  readonly gender: SwimCloudGenderOrUnknown;
  /**
   * The team's `Entries` splash-stat, when the page printed one.
   *
   * **Not** a swim count. A swim row exists per attempt, so prelims and finals
   * of one entry are two rows; the real capture shows 134 entries against 8
   * pages of 30 swims. Never compare this against
   * {@link SwimCloudTeamMeetSwimsParse.rowCount} to decide whether a capture is
   * complete.
   */
  readonly entryCount?: number;
  /** One per data row, in page order. */
  readonly swims: readonly SwimCloudTeamMeetSwim[];
  /** The distinct events the rows referenced, in first-seen order. */
  readonly events: readonly SwimCloudEvent[];
  /** Data rows seen, including any that failed to parse. */
  readonly rowCount: number;
  /** Absent when the page carried no pagination widget — see {@link SwimCloudPagination}. */
  readonly pagination?: SwimCloudPagination;
}

/**
 * Parse a SwimCloud results table of the shape every results page shares.
 *
 * **Real-capture-verified** — see the file header. Written against three pages
 * SwimCloud actually served, archived as `tests/fixtures/swimcloud-real-*.html`.
 *
 * ## Which page to give it
 *
 * The same row shape appears on three pages, and only one of them is complete:
 *
 * | Page | What its table holds |
 * | --- | --- |
 * | `/results/{meetId}/` | The whole meet's top 5 swims |
 * | `/results/{meetId}/team/{teamId}/` | That team's top 10 swims, sorted by improvement |
 * | `/results/{meetId}/team/{teamId}/swims/` | **That team's full list**, 30 rows a page |
 *
 * This function parses all three correctly. It cannot tell a caller that the
 * first two are partial, because their markup does not say so — which is why
 * those two pages have their own classifier kinds, and why the import UI, not
 * this parser, is where a user gets told to capture the `swims` page instead.
 *
 * ## What this page type cannot tell you
 *
 * **Disqualified and scratched swims are absent from it entirely.** The user who
 * captured the fixture confirmed from first-hand knowledge that DQs occurred at
 * that meet, and not one appears on the list. A caller must not read a complete
 * capture as a complete account of what happened — DQ and scratch data lives
 * only on `/results/{meetId}/event/{n}/`, which nothing here parses. Reporting
 * `confidence: 'real-capture-verified'` says these selectors match a page
 * SwimCloud served; it does not say the page holds every swim.
 *
 * Relays are likewise absent as relays. A relay's **leadoff** leg does appear,
 * and looks exactly like an individual swim except for one `title="Leadoff"`
 * badge — see {@link SwimCloudResultFlags.relayLeadoff}.
 */
/**
 * Assemble the {@link SwimCloudTeamMeetSwimsParse} success payload from its
 * already-resolved parts. Split out of {@link parseTeamMeetSwimsHtml} purely
 * so the per-field "omit when absent" spreads, and the `team` object's own
 * three-way guard, don't count against that function's complexity; every
 * field and its absence rule is unchanged.
 */
function buildTeamMeetSwimsPayload(fields: {
  readonly meetId: SwimCloudMeetId;
  readonly meetName: string | undefined;
  readonly meet: SwimCloudMeet;
  readonly teamId: SwimCloudTeamId | undefined;
  readonly teamName: string | undefined;
  readonly gender: SwimCloudGenderOrUnknown;
  readonly entryCount: number | undefined;
  readonly swims: readonly SwimCloudTeamMeetSwim[];
  readonly events: readonly SwimCloudEvent[];
  readonly rowCount: number;
  readonly pagination: SwimCloudPagination | undefined;
}): SwimCloudTeamMeetSwimsParse {
  const team: SwimCloudTeam | undefined =
    fields.teamId !== undefined && fields.teamName !== undefined && fields.gender !== 'unknown'
      ? { swimCloudTeamId: fields.teamId, gender: fields.gender, name: fields.teamName }
      : undefined;

  return {
    swimCloudMeetId: fields.meetId,
    ...(fields.meetName === undefined ? {} : { meetName: fields.meetName }),
    meet: fields.meet,
    ...(fields.teamId === undefined ? {} : { swimCloudTeamId: fields.teamId }),
    ...(fields.teamName === undefined ? {} : { teamName: fields.teamName }),
    ...(team === undefined ? {} : { team }),
    gender: fields.gender,
    ...(fields.entryCount === undefined ? {} : { entryCount: fields.entryCount }),
    swims: fields.swims,
    events: fields.events,
    rowCount: fields.rowCount,
    ...(fields.pagination === undefined ? {} : { pagination: fields.pagination }),
  };
}

export function parseTeamMeetSwimsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudTeamMeetSwimsParseOptions = {},
): SwimCloudParseResult<SwimCloudTeamMeetSwimsParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = meetScopeFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a meet or a team within one.`,
      warnings,
      confidence,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  if (meetId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a meet page and no meetId option was supplied.`,
      warnings,
      confidence,
    );
  }
  const teamId = options.teamId ?? fromUrl.teamId;

  // One strip up front. Every non-table lookup below reads this rather than the
  // raw input, so a fixture's own explanatory comments — which quote real
  // markup, `title="Leadoff"` included — can never be read as page content.
  const cleaned = stripNonContent(html);

  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a results page is expected to contain at least one.',
      warnings,
      confidence,
    );
  }

  const located = locateSwimsTable(tables);
  if (located === null) {
    return fail(
      context,
      'expected-header-missing',
      `None of the ${tables.length} table(s) on the page has both an "Event" and a "Time" column, which is what identifies a results table on a SwimCloud results page.`,
      warnings,
      confidence,
    );
  }

  const gender = options.gender ?? readActiveGenderWord(cleaned);
  const meetName = elementTextById(cleaned, 'meet-name') ?? firstHeadingText(cleaned);
  const meetCourse = readPrintedCourse(cleaned) ?? options.meetCourse;
  const dates = readMeetDateRange(cleaned, warnings);
  const teamName = teamId === undefined ? undefined : teamNameForId(cleaned, teamId);
  const entryCount = readSplashStat(cleaned, 'entries');

  const rows = readSwimRows(located, {
    meetId,
    gender,
    meetCourse,
    fallbackTeamId: teamId,
    fallbackTeamName: teamName,
    warnings,
  });

  const events: SwimCloudEvent[] = [];
  for (const swim of rows.swims) {
    if (!events.some((event) => event.eventId === swim.event.eventId)) {
      events.push(swim.event);
    }
  }

  if (meetName === undefined) warnings.push(missingMeetNameWarning());
  const meet: SwimCloudMeet = {
    swimCloudMeetId: meetId,
    name: meetName ?? '',
    format: options.meetFormat ?? 'unknown',
    ruleset: options.meetRuleset ?? 'unknown',
    course: meetCourse ?? 'unknown',
    ...(dates.startDate === undefined ? {} : { startDate: dates.startDate }),
    ...(dates.endDate === undefined ? {} : { endDate: dates.endDate }),
  };

  const pagination = readPagination(cleaned, fromUrl.page);

  return succeed(
    context,
    buildTeamMeetSwimsPayload({
      meetId,
      meetName,
      meet,
      teamId,
      teamName,
      gender,
      entryCount,
      swims: rows.swims,
      events,
      rowCount: rows.rowCount,
      pagination,
    }),
    warnings,
    confidence,
  );
}

/**
 * The team's printed name, from the page's own bare `/team/{id}/` link.
 *
 * Bare links only. A meet-scoped `/results/{meetId}/team/{teamId}/` link carries
 * the same team id but is used for other things — on the real capture the gender
 * dropdown links to exactly that URL with the link text `Men`, which is how a
 * looser rule would name the team "Men".
 */
function teamNameForId(html: string, teamId: SwimCloudTeamId): string | undefined {
  for (const anchor of findElementSpans(html, 'a')) {
    const href = readAttribute(startTagOf(anchor.html), 'href');
    if (href === undefined) {
      continue;
    }
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'team') {
      continue;
    }
    if (classification.resource.teamId !== teamId) {
      continue;
    }
    const text = htmlToText(anchor.inner);
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

/** One `c-splash-stats` value, looked up by its printed label. Only a whole number is accepted. */
function readSplashStat(html: string, label: string): number | undefined {
  for (const item of extractListItems(html)) {
    const divs = findElementSpans(item, 'div');
    const labelDiv = divs.find((div) =>
      classTokens(startTagOf(div.html)).includes('c-splash-stats__label'),
    );
    if (labelDiv === undefined || htmlToText(labelDiv.inner).trim().toLowerCase() !== label) {
      continue;
    }
    const valueDiv = divs.find((div) =>
      classTokens(startTagOf(div.html)).includes('c-splash-stats__value'),
    );
    if (valueDiv === undefined) {
      return undefined;
    }
    const text = htmlToText(valueDiv.inner).trim();
    return /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
  }
  return undefined;
}

/**
 * The `<ul class="c-pagination">` widget, when the page has one.
 *
 * Returns `undefined` for a page with no widget. That is the single-page case,
 * not an error: SwimCloud omits the widget entirely when everything fits.
 *
 * `currentPage` comes from the widget's own active item. When the widget carries
 * no active marker it falls back to the capture URL's `?page=`, and then to 1 —
 * page 1 being the page a `page`-less URL serves, which the real capture
 * confirms (no `page` parameter, active item `1`).
 */
function readPagination(html: string, pageFromUrl: string | undefined): SwimCloudPagination | undefined {
  const widget = findElementSpans(html, 'ul').find((list) =>
    classTokens(startTagOf(list.html)).includes('c-pagination'),
  );
  if (widget === undefined) {
    return undefined;
  }

  let activePage: number | undefined;
  let totalPages = 0;
  let nextPageHref: string | undefined;

  for (const item of extractListItems(widget.inner)) {
    const actions = [...findElementSpans(item, 'button'), ...findElementSpans(item, 'a')];
    for (const action of actions) {
      const startTag = startTagOf(action.html);
      const text = htmlToText(action.inner).trim();
      const printed = /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
      if (printed !== undefined) {
        totalPages = Math.max(totalPages, printed);
        if (classTokens(startTag).includes('c-pagination__action--active')) {
          activePage = printed;
        }
      }
      const href = readAttribute(startTag, 'href');
      if (href === undefined) {
        continue;
      }
      const page = readQueryParam(href, 'page');
      if (page !== undefined && /^\d+$/.test(page)) {
        totalPages = Math.max(totalPages, Number.parseInt(page, 10));
      }
      if (readAttribute(startTag, 'aria-label')?.trim().toLowerCase() === 'next page') {
        nextPageHref = href;
      }
    }
  }

  if (totalPages === 0) {
    return undefined;
  }

  const fromUrl =
    pageFromUrl !== undefined && /^\d+$/.test(pageFromUrl) ? Number.parseInt(pageFromUrl, 10) : undefined;
  return {
    currentPage: activePage ?? fromUrl ?? 1,
    totalPages,
    ...(nextPageHref === undefined ? {} : { nextPageHref }),
  };
}

/** A results table, located and with its columns already resolved. */
interface LocatedSwimsTable {
  readonly name: SwimsHeaderColumn;
  readonly event: SwimsHeaderColumn;
  readonly time: SwimsHeaderColumn;
  readonly place?: SwimsHeaderColumn;
  readonly points?: SwimsHeaderColumn;
  readonly score?: SwimsHeaderColumn;
  readonly flags?: SwimsHeaderColumn;
  readonly team?: SwimsHeaderColumn;
  readonly dataRows: readonly (readonly string[])[];
}

/**
 * The first table on the page that is a results table.
 *
 * Identified by carrying `Name`, `Event` and `Time` columns together. That
 * combination is what separates the results card from the other tables a real
 * page ships — a `Teams` standings card (`Team`/`Score`) and a `High point`
 * card (`Name`/`Gold`/`Silver`/`Bronze`/`Score`/`Pts Avg`) both fail it, which
 * is the point: neither holds swims.
 *
 * `Place` and `Pts` are **not** required. The meet-root card prints `Score`
 * where the team pages print `Place`, and a table without a place column yields
 * rows with no place — absent, never zero.
 */
function locateSwimsTable(tables: readonly HtmlElementSpan[]): LocatedSwimsTable | null {
  for (const table of tables) {
    const rows = extractTableRows(table.html);
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const columns = readHeaderColumns(itemAt(rows, headerIndex));
    const name = columnFor(columns, NAME_HEADERS);
    const event = columnFor(columns, SWIMS_EVENT_HEADERS);
    const time = columnFor(columns, SWIMS_TIME_HEADERS);
    if (name === undefined || event === undefined || time === undefined) {
      continue;
    }
    const place = columnFor(columns, SWIMS_PLACE_HEADERS);
    const points = columnFor(columns, SWIMS_POINTS_HEADERS);
    const score = columnFor(columns, SWIMS_SCORE_HEADERS);
    const flags = columnFor(columns, SWIMS_FLAGS_HEADERS);
    const team = columnFor(columns, TEAM_HEADERS);
    return {
      name,
      event,
      time,
      ...(place === undefined ? {} : { place }),
      ...(points === undefined ? {} : { points }),
      ...(score === undefined ? {} : { score }),
      ...(flags === undefined ? {} : { flags }),
      ...(team === undefined ? {} : { team }),
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    };
  }
  return null;
}

/* ---- Event label, course letter -------------------------------------------- */

/**
 * A swims-list event cell: `{distance} {course letter} {stroke}`.
 *
 * `100 Y Breast`, `1650 Y Free`, `200 Y IM`. No `Event {n}` prefix ever appears
 * — the event *number* lives in the row's time link, not in this text.
 */
const SWIMS_EVENT_LABEL = /^(\d{1,4})\s+([A-Za-z])\s+(.+)$/;

/**
 * SwimCloud's one-letter course codes.
 *
 * `Y` is confirmed by the real capture: every label on it reads `… Y …` and the
 * page's own `<li id="meet-course">` says `SCY`. `L` and `S` are **not** in that
 * capture. They are mapped anyway on two grounds, both recorded rather than
 * assumed: `entities.ts`'s {@link SwimCloudEvent.course} comment documents a
 * 2024-era scraper finding that SwimCloud appends exactly an `L`/`S`/`Y` course
 * suffix to event ids, and the letters are the sport's universal abbreviations.
 *
 * Any other letter is `'unknown'` with an `unrecognized-course-token` warning.
 * It is never defaulted to yards — a metric time scored against a yard cut is
 * precisely the silently-wrong number this repo's provenance rules exist to
 * stop.
 */
const COURSE_LETTERS: Readonly<Record<string, SwimCloudCourse>> = {
  y: 'SCY',
  l: 'LCM',
  s: 'SCM',
};

interface ParsedSwimsEventLabel {
  readonly distance?: number;
  readonly course: SwimCloudCourseOrUnknown;
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
  /** The course letter as printed, when the label matched the expected shape. */
  readonly courseLetter?: string;
  /** False when the label did not match `{distance} {letter} {stroke}` at all. */
  readonly matchedShape: boolean;
}

/**
 * Read distance, course and stroke out of a swims-list event cell.
 *
 * Pure — it raises nothing and warns nothing, so the caller can build the event
 * id first and then attribute any warning to it.
 */
function readSwimsEventLabel(label: string): ParsedSwimsEventLabel {
  const lower = label.toLowerCase();
  const isRelay = /\brelay\b/.test(lower);
  const match = SWIMS_EVENT_LABEL.exec(label.trim());

  if (match === null) {
    // Keep whatever can still be read honestly, and let the caller say out loud
    // that the shape was not the expected one.
    const loose = /\b(\d{1,4})\b/.exec(label);
    return {
      ...(loose === null ? {} : { distance: Number.parseInt(regexGroup(loose, 1), 10) }),
      course: 'unknown',
      stroke: mapStroke(lower, isRelay),
      isRelay,
      matchedShape: false,
    };
  }

  const courseLetter = regexGroup(match, 2);
  const course = COURSE_LETTERS[courseLetter.toLowerCase()] ?? 'unknown';
  return {
    distance: Number.parseInt(regexGroup(match, 1), 10),
    course,
    stroke: mapStroke(lower, isRelay),
    isRelay,
    courseLetter,
    matchedShape: true,
  };
}

/* ---- Row-level readers ------------------------------------------------------ */

/** What a row's time cell links to: the event it belongs to, and the swim's own id. */
interface SwimLink {
  readonly eventRef: string;
  readonly swimId?: string;
}

/**
 * Read the event reference and swim id out of a row's time link.
 *
 * The link is `/results/{meetId}/event/{eventRef}/?id={swimId}#time{swimId}`. It
 * is the **only** place a row states which event it belongs to: the printed
 * label cannot say, and on the real capture two rows both reading `100 Y Breast`
 * point at event `26` and event `100`.
 *
 * A link naming a different meet is ignored rather than trusted, so a stray
 * cross-meet link cannot attach a swim to the wrong meet.
 */
function readSwimLink(cellHtml: string, meetId: SwimCloudMeetId): SwimLink | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetEvent') {
      continue;
    }
    if (classification.resource.meetId !== meetId) {
      continue;
    }
    const id = readQueryParam(href, 'id');
    return {
      eventRef: classification.resource.eventRef,
      ...(id !== undefined && /^\d+$/.test(id) ? { swimId: id } : {}),
    };
  }
  return undefined;
}

/* ---- The row loop ----------------------------------------------------------- */

interface SwimRowsContext {
  readonly meetId: SwimCloudMeetId;
  readonly gender: SwimCloudGenderOrUnknown;
  readonly meetCourse?: SwimCloudCourse;
  readonly fallbackTeamId?: SwimCloudTeamId;
  readonly fallbackTeamName?: string;
  readonly warnings: SwimCloudParseWarning[];
}

/**
 * Build one row's {@link SwimCloudEvent} and push its label/course warnings.
 * Extracted from {@link readSwimRows} purely to keep that function's own
 * complexity down; the three-way `unrecognized-event-label` /
 * `unrecognized-course-token` / `course-column-contradicts-label` chain and
 * every field's absence rule are unchanged.
 */
function buildSwimRowEvent(
  ctx: SwimRowsContext,
  eventLabel: string,
  link: SwimLink | undefined,
  eventId: string,
  parsedLabel: ParsedSwimsEventLabel,
  rowIndex: number,
): SwimCloudEvent {
  const course: SwimCloudCourseOrUnknown =
    parsedLabel.course !== 'unknown' ? parsedLabel.course : (ctx.meetCourse ?? 'unknown');

  const event: SwimCloudEvent = {
    eventId,
    swimCloudMeetId: ctx.meetId,
    ...(link === undefined ? {} : { eventRef: link.eventRef }),
    label: eventLabel,
    kind: parsedLabel.isRelay ? 'relay' : 'individual',
    course,
    gender: ctx.gender,
    ...(parsedLabel.distance === undefined ? {} : { distance: parsedLabel.distance }),
    stroke: parsedLabel.stroke,
  };

  if (!parsedLabel.matchedShape) {
    ctx.warnings.push({
      code: 'unrecognized-event-label',
      message: `Event cell ${JSON.stringify(eventLabel)} does not match the expected "{distance} {course letter} {stroke}" shape; distance and course were not read from it.`,
      eventId,
      rowIndex,
      raw: eventLabel,
    });
  } else if (parsedLabel.course === 'unknown') {
    ctx.warnings.push({
      code: 'unrecognized-course-token',
      message: `Course letter ${JSON.stringify(parsedLabel.courseLetter ?? '')} in ${JSON.stringify(eventLabel)} is outside Y/L/S; course recorded as ${JSON.stringify(course)} rather than assumed.`,
      eventId,
      rowIndex,
      raw: eventLabel,
    });
  } else if (ctx.meetCourse !== undefined && parsedLabel.course !== ctx.meetCourse) {
    ctx.warnings.push({
      code: 'course-column-contradicts-label',
      message: `Event ${JSON.stringify(eventLabel)} is ${parsedLabel.course} by its course letter, but the page declares the meet as ${ctx.meetCourse}. The label wins; the disagreement is reported rather than resolved silently.`,
      eventId,
      rowIndex,
      raw: eventLabel,
    });
  }

  return event;
}

/**
 * Push the `missing-swim-link` warning for a swims-list row, if any.
 * Extracted from {@link readSwimRows} for the same reason as
 * {@link buildSwimRowEvent}; both messages are unchanged.
 */
function pushSwimRowLinkWarning(
  link: SwimLink | undefined,
  athleteName: string,
  meetId: SwimCloudMeetId,
  eventId: string,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): void {
  if (link === undefined) {
    warnings.push({
      code: 'missing-swim-link',
      message: `Time cell for ${JSON.stringify(athleteName)} carries no /results/${meetId}/event/{n}/ link; the swim has no SwimCloud swim id or event reference, and a composite key derived from the row's own values is used instead.`,
      eventId,
      rowIndex,
    });
  } else if (link.swimId === undefined) {
    warnings.push({
      code: 'missing-swim-link',
      message: `Time cell for ${JSON.stringify(athleteName)} links to event ${link.eventRef} but carries no "?id=" swim id; a composite key derived from the row's own values is used instead.`,
      eventId,
      rowIndex,
    });
  }
}

/** The place/time/points/score/flags readers for one swims-list row. */
interface SwimRowMeasurements {
  readonly place: number | undefined;
  readonly time: ReturnType<typeof readTime>;
  readonly points: ReturnType<typeof readPoints> | Record<string, never>;
  readonly score: ReturnType<typeof readPoints> | Record<string, never>;
  readonly flagsCell: SwimFlagsCell;
}

/**
 * Read the place/time/points/score/flags cells of one swims-list row.
 * Extracted from {@link readSwimRows} purely to keep that function's own
 * complexity down; which columns are optional, and how each reader is
 * called, is unchanged.
 */
function readSwimRowMeasurements(
  cells: readonly string[],
  table: LocatedSwimsTable,
  event: SwimCloudEvent,
  timeCellHtml: string,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): SwimRowMeasurements {
  const place =
    table.place === undefined
      ? undefined
      : readOrdinalPlace(textAt(cells, table.place.start), event, rowIndex, warnings);
  const time = readTime(htmlToText(timeCellHtml), event, rowIndex, warnings);
  const points =
    table.points === undefined ? {} : readPoints(textAt(cells, table.points.start), event, rowIndex, warnings);
  // The Score column, when the table has one. Read with the same reader as
  // Pts — both are plain non-negative numbers — but kept in its own field,
  // because they measure different things. See SwimCloudTeamMeetSwim.meetScore.
  const score =
    table.score === undefined ? {} : readPoints(textAt(cells, table.score.start), event, rowIndex, warnings);
  const flagsCell = readFlagsCell(table.flags === undefined ? '' : cellAt(cells, table.flags.start));

  return { place, time, points, score, flagsCell };
}

/** The athlete/team facts a swims-list row's `entry` is built from. */
interface SwimRowAthlete {
  readonly swimmerId: SwimCloudSwimmerId | undefined;
  readonly teamId: SwimCloudTeamId | undefined;
  readonly teamName: string | undefined;
}

/**
 * Resolve a row's swimmer id and team, and push `missing-athlete-link` when
 * the athlete cell carries no `/swimmer/{id}/` link. Extracted from
 * {@link readSwimRows} for the same reason as {@link buildSwimRowEvent}.
 */
function resolveSwimRowAthlete(
  nameCellHtml: string,
  teamCellHtml: string,
  athleteName: string,
  ctx: SwimRowsContext,
  eventId: string,
  rowIndex: number,
): SwimRowAthlete {
  const swimmerId = swimmerIdFromCell(nameCellHtml);
  if (swimmerId === undefined) {
    ctx.warnings.push({
      code: 'missing-athlete-link',
      message: `Results row for ${athleteName} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
      eventId,
      rowIndex,
      raw: athleteName,
    });
  }

  const rowTeamName = htmlToText(teamCellHtml);
  const teamId = teamIdFromCell(teamCellHtml) ?? ctx.fallbackTeamId;
  const teamName = rowTeamName.length > 0 ? rowTeamName : ctx.fallbackTeamName;

  return { swimmerId, teamId, teamName };
}

/**
 * Assemble one {@link SwimCloudTeamMeetSwim} from a row's already-resolved
 * parts. Extracted from {@link readSwimRows} purely so the per-field
 * "omit when absent" spreads don't count against that function's
 * complexity; every field and its absence rule is unchanged.
 */
function assembleSwimRow(fields: {
  readonly eventId: string;
  readonly meetId: SwimCloudMeetId;
  readonly link: SwimLink | undefined;
  readonly athlete: SwimRowAthlete;
  readonly athleteName: string;
  readonly event: SwimCloudEvent;
  readonly measurements: SwimRowMeasurements;
  readonly rowOrdinal: number | undefined;
  readonly rowIndex: number;
}): SwimCloudTeamMeetSwim {
  const { eventId, meetId, link, athlete, athleteName, event, measurements, rowOrdinal, rowIndex } = fields;
  const { place, time, points, score, flagsCell } = measurements;

  const swimKey =
    link?.swimId === undefined
      ? `${eventId}:swim:${athlete.swimmerId ?? `row${rowIndex}`}:${time.finalTime ?? time.rawTimeToken ?? `row${rowIndex}`}`
      : `${meetId}:swim:${link.swimId}`;

  const flags: SwimCloudResultFlags | undefined =
    time.flags === undefined && !flagsCell.relayLeadoff
      ? undefined
      : { ...(time.flags ?? {}), ...(flagsCell.relayLeadoff ? { relayLeadoff: true } : {}) };

  const entry: SwimCloudEntry = {
    entryId: `${swimKey}:entry`,
    eventId,
    ...(athlete.swimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimmerId }),
    athleteName,
    ...(athlete.teamId === undefined ? {} : { swimCloudTeamId: athlete.teamId }),
    ...(athlete.teamName === undefined ? {} : { teamName: athlete.teamName }),
  };

  const result: SwimCloudResult = {
    resultId: `${swimKey}:result`,
    entryId: entry.entryId,
    eventId,
    ...(place === undefined ? {} : { place }),
    ...(points.points === undefined ? {} : { points: points.points }),
    ...(points.rawPointsToken === undefined ? {} : { rawPointsToken: points.rawPointsToken }),
    ...(time.finalTime === undefined ? {} : { finalTime: time.finalTime }),
    ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
    ...(flags === undefined ? {} : { flags }),
  };

  return {
    swimKey,
    ...(link?.swimId === undefined ? {} : { swimCloudSwimId: link.swimId }),
    ...(rowOrdinal === undefined ? {} : { rowOrdinal }),
    event,
    entry,
    result,
    relayLeadoff: flagsCell.relayLeadoff,
    cutStandards: flagsCell.cutStandards,
    ...(score.points === undefined ? {} : { meetScore: score.points }),
  };
}

function readSwimRows(
  table: LocatedSwimsTable,
  ctx: SwimRowsContext,
): { swims: SwimCloudTeamMeetSwim[]; rowCount: number } {
  const swims: SwimCloudTeamMeetSwim[] = [];

  table.dataRows.forEach((cells, rowIndex) => {
    const nameIndex = subjectCellIndex(cells, table.name);
    const nameCellHtml = cellAt(cells, nameIndex);
    const athleteName = htmlToText(nameCellHtml);
    if (athleteName.length === 0) {
      ctx.warnings.push({
        code: 'unparsed-row',
        message: 'Results row has an empty athlete cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const eventLabel = htmlToText(cellAt(cells, table.event.start));
    const timeCellHtml = cellAt(cells, table.time.start);
    const link = readSwimLink(timeCellHtml, ctx.meetId);
    const parsedLabel = readSwimsEventLabel(eventLabel);

    // The event id keys off the page's own event reference whenever there is
    // one. The label fallback is deterministic and capture-local; it is not a
    // SwimCloud id and is never presented as one.
    const eventId =
      link === undefined
        ? `${ctx.meetId}:event-label:${normalizeHeader(eventLabel)}`
        : `${ctx.meetId}:event:${link.eventRef}`;

    const event = buildSwimRowEvent(ctx, eventLabel, link, eventId, parsedLabel, rowIndex);
    pushSwimRowLinkWarning(link, athleteName, ctx.meetId, eventId, rowIndex, ctx.warnings);

    const measurements = readSwimRowMeasurements(cells, table, event, timeCellHtml, rowIndex, ctx.warnings);
    const athlete = resolveSwimRowAthlete(nameCellHtml, table.team === undefined ? '' : cellAt(cells, table.team.start), athleteName, ctx, eventId, rowIndex);

    // The printed ordinal only exists when the Name header spans the column
    // before it. Read from that leading cell, never from the row's position:
    // page 2 of a list starts at 31, not at 1.
    const ordinalText =
      table.name.span > 1 && nameIndex !== table.name.start
        ? textAt(cells, table.name.start)
        : '';
    const rowOrdinal = /^\d+$/.test(ordinalText) ? Number.parseInt(ordinalText, 10) : undefined;

    swims.push(
      assembleSwimRow({
        eventId,
        meetId: ctx.meetId,
        link,
        athlete,
        athleteName,
        event,
        measurements,
        rowOrdinal,
        rowIndex,
      }),
    );
  });

  if (table.dataRows.length === 0) {
    ctx.warnings.push({
      code: 'zero-data-rows',
      message:
        'The results table was found and holds no data rows. This is a real "nothing posted for this team and gender" answer, not a missing table.',
    });
  }

  return { swims, rowCount: table.dataRows.length };
}
