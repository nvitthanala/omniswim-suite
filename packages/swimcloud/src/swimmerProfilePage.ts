/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Swimmer profile parser for the synthetic-fixture page shape.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractRowCells,
  extractTableRows,
  findTables,
  htmlToText,
  isHeaderRow,
} from './html';
import { itemAt, regexGroup } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type {
  SwimCloudCourse,
  SwimCloudCourseOrUnknown,
  SwimCloudEvent,
  SwimCloudGender,
  SwimCloudMeetId,
  SwimCloudStroke,
  SwimCloudSwimmerId,
  SwimCloudTimeString,
} from './entities';
import { fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import { firstHeadingText } from './parseElements';
import { mapStroke, readTime } from './swimFields';
import {
  DATE_HEADERS,
  EVENT_LABEL_HEADERS,
  MEET_HEADERS,
  TIME_HEADERS,
  findColumn,
  normalizeHeader,
  textAt,
} from './parseCells';

/* -------------------------------------------------------------------------- */
/* Swimmer profile / personal bests                                           */
/* -------------------------------------------------------------------------- */

/**
 * One personal-best row from a swimmer's profile page.
 *
 * **This is the guessed shape, not the real one.** The 2026-09-09 capture of
 * `/swimmer/{id}/times/` settled the table's *shape*: the real Personal Bests
 * table is the default tab (no click needed, contrary to the prior-art research
 * in `plans/2026-09-06/04-phasing.md` open question 2), and it carries **no
 * course column** — the course is a suffix of the event label.
 *
 * **Corrected 2026-09-20 — that capture did not show the table is
 * server-rendered, and this comment previously said it did.** The fixture's own
 * header records that it was taken "via the browser extension (Track A,
 * clipboard)", which copies the *rendered DOM* after the page's JavaScript has
 * run. A `fetch` of the same URL returns a 15-17 KB shell with zero `<table>`
 * elements that loads `/media/webpack/swimmerProfileTimes/index.*.js` — proven
 * across all 73 successfully-fetched bodies in the archived capture. The
 * mistaken inference is what justified a fetch-based crawl pass that could
 * never parse a row; see `SWIMCLOUD_DOM_RENDERED_PASSES` in `./crawlPlan.ts`.
 * This type models a course column and a bare event label, so it describes a
 * table SwimCloud does not serve. Use {@link SwimCloudPersonalBestSwim} and
 * {@link parseSwimmerTimesHtml} for the real page.
 *
 * The sibling "EVENT PROGRESSION" tab remains uncaptured and its markup
 * unknown; nothing in this file parses it or assumes its shape.
 */
export interface SwimCloudPersonalBest {
  /** Event exactly as printed, e.g. `'200 Free'` or `'200 Yard Freestyle'`. */
  readonly label: string;
  readonly course: SwimCloudCourseOrUnknown;
  readonly stroke: SwimCloudStroke;
  readonly distance?: number;
  /** Absent when the time cell held anything other than a well-formed hundredths-precision time. */
  readonly time?: SwimCloudTimeString;
  /** The cell's raw contents, kept whenever {@link time} could not be populated. */
  readonly rawTimeToken?: string;
  /** As printed. Never parsed into a Date — a partial/ambiguous date string is not this parser's business to interpret. */
  readonly date?: string;
  /** Meet name as printed, when the row names one. */
  readonly meetName?: string;
}

export interface SwimCloudSwimmerProfileParseOptions {
  /** Swimmer id, for captures whose URL cannot be classified (a Wayback snapshot, say). */
  readonly swimmerId?: SwimCloudSwimmerId;
  /**
   * The swimmer's program gender. Never inferred from the page or the name —
   * same discipline as {@link SwimCloudRosterParseOptions.gender}.
   */
  readonly gender?: SwimCloudGender;
  /**
   * Default course for a row whose event label carries no explicit unit (a
   * bare `'200 Free'` rather than `'200 Yard Free'`). SwimCloud's own course
   * convention for this table is unverified; supplying this is a caller
   * assertion, same shape as {@link SwimCloudMeetResultsParseOptions.meetCourse}.
   */
  readonly defaultCourse?: SwimCloudCourse;
}

export interface SwimCloudSwimmerProfileParse {
  readonly swimCloudSwimmerId: SwimCloudSwimmerId;
  /** From the page's first heading. */
  readonly name?: string;
  readonly gender?: SwimCloudGender;
  /**
   * Personal-best rows, in page order.
   *
   * An empty array here always comes with a `zero-data-rows` warning — the
   * table existed and listed nothing, a real (if unusual) answer. A missing
   * table is `ok: false`, per this file's absent-is-never-empty rule.
   */
  readonly personalBests: readonly SwimCloudPersonalBest[];
  readonly rowCount: number;
}

const COURSE_HEADERS = ['course', 'pool'] as const;

/**
 * Distance/unit/stroke out of a personal-best row's event label — the same
 * job {@link parseEventHeading} does for a meet heading, but without an
 * "Event {n}" prefix or a gender word to strip first.
 */
function parsePersonalBestEventLabel(label: string): {
  readonly distance?: number;
  readonly unit: 'yard' | 'metric' | 'none';
  readonly stroke: SwimCloudStroke;
} {
  const lower = label.toLowerCase();
  const distanceMatch = /\b(\d{1,4})\b/.exec(label);
  const distance =
    distanceMatch === null ? undefined : Number.parseInt(regexGroup(distanceMatch, 1), 10);
  const unit: 'yard' | 'metric' | 'none' = /\byards?\b/.test(lower)
    ? 'yard'
    : /\bmet(?:er|re)s?\b|\bmtr\b/.test(lower)
      ? 'metric'
      : 'none';
  const isRelay = /\brelay\b/.test(lower);
  return {
    ...(distance === undefined ? {} : { distance }),
    unit,
    stroke: mapStroke(lower, isRelay),
  };
}

/**
 * Parse a SwimCloud swimmer-profile page's personal-bests table.
 *
 * **Synthetic-fixture-only** — see this file's header. Additionally
 * unverified whether the underlying table is ever present without a
 * tab-click first; see {@link SwimCloudPersonalBest}'s doc comment.
 *
 * Locates the first table whose header row carries both an event column and
 * a time column, then reads rows by header label — same discipline as
 * {@link parseTeamRosterHtml} and {@link parseMeetResultsHtml}: columns
 * located by printed label, never by position.
 *
 * @deprecated Since 2026-09-09. Real captures proved both of its assumptions
 * wrong: `/swimmer/{id}/` carries a narrower "Latest Results" panel rather than
 * a bests table, and the real bests table (on `/swimmer/{id}/times/`) has no
 * course column. Use {@link parseSwimmerTimesHtml}. No longer called from
 * `packages/manager/src/components/RosterImportWizard.tsx`; kept for one round
 * per `plans/2026-09-08/04-parsers-and-fixtures.md`'s "Retired" section.
 */
export function parseSwimmerProfileHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudSwimmerProfileParseOptions = {},
): SwimCloudParseResult<SwimCloudSwimmerProfileParse> {
  const warnings: SwimCloudParseWarning[] = [];

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.');
  }

  const classification = classifySwimCloudUrl(context.sourceUrl);
  let swimmerIdFromUrl: SwimCloudSwimmerId | undefined;
  if (classification.outcome === 'fetchable') {
    if (classification.resource.kind === 'swimmer') {
      swimmerIdFromUrl = classification.resource.swimmerId;
    } else {
      return fail(
        context,
        'source-url-mismatch',
        `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${classification.resource.kind} resource, not a swimmer.`,
      );
    }
  }
  const swimCloudSwimmerId = options.swimmerId ?? swimmerIdFromUrl;
  if (swimCloudSwimmerId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No swimmer id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a swimmer and no swimmerId option was supplied.`,
    );
  }

  const tables = findTables(html);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a personal-bests table is expected. If the swimmer page loads times behind a tab, that tab may need to be opened before capturing — see SwimCloudPersonalBest\'s doc comment.',
    );
  }

  let headerCells: string[] | null = null;
  let dataRows: string[][] = [];
  let eventColumn = -1;
  let timeColumn = -1;
  let courseColumn = -1;
  let dateColumn = -1;
  let meetColumn = -1;

  for (const table of tables) {
    const rows = extractTableRows(table.html);
    if (rows.length === 0) {
      continue;
    }
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const headers = extractRowCells(itemAt(rows, headerIndex)).map((cell) => normalizeHeader(htmlToText(cell)));
    const candidateEvent = findColumn(headers, EVENT_LABEL_HEADERS);
    const candidateTime = findColumn(headers, TIME_HEADERS);
    if (candidateEvent < 0 || candidateTime < 0) {
      continue;
    }
    headerCells = headers;
    eventColumn = candidateEvent;
    timeColumn = candidateTime;
    courseColumn = findColumn(headers, COURSE_HEADERS);
    dateColumn = findColumn(headers, DATE_HEADERS);
    meetColumn = findColumn(headers, MEET_HEADERS);
    dataRows = rows
      .slice(headerIndex + 1)
      .filter((row) => !isHeaderRow(row))
      .map((row) => extractRowCells(row));
    break;
  }

  if (headerCells === null) {
    return fail(
      context,
      'expected-header-missing',
      `No table carried both an event column (${EVENT_LABEL_HEADERS.join(', ')}) and a time column (${TIME_HEADERS.join(', ')}).`,
    );
  }

  const personalBests: SwimCloudPersonalBest[] = [];
  dataRows.forEach((cells, rowIndex) => {
    const label = textAt(cells, eventColumn);
    if (label.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Personal-best row has an empty event cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const { distance, unit, stroke } = parsePersonalBestEventLabel(label);

    let course: SwimCloudCourseOrUnknown;
    if (unit === 'yard') {
      course = 'SCY';
      // "Yard" in the label is about as unambiguous a signal as this domain
      // has, so it still wins — but an explicit course column that disagrees
      // is a real anomaly (stale markup, a copy-pasted row) worth a human's
      // attention, not something to resolve silently either direction.
      if (courseColumn >= 0) {
        const rawCourseCell = textAt(cells, courseColumn);
        if (rawCourseCell.length > 0 && normalizeHeader(rawCourseCell) !== 'scy') {
          warnings.push({
            code: 'course-column-contradicts-label',
            message: `Row for ${JSON.stringify(label)} names a yard event, but its course column reads ${JSON.stringify(rawCourseCell)}. Recorded as SCY (the label); the column is preserved here for review, not silently trusted over the label.`,
            rowIndex,
            raw: rawCourseCell,
          });
        }
      }
    } else if (courseColumn >= 0 && textAt(cells, courseColumn).length > 0) {
      const raw = normalizeHeader(textAt(cells, courseColumn));
      course = raw === 'scy' ? 'SCY' : raw === 'scm' ? 'SCM' : raw === 'lcm' ? 'LCM' : 'unknown';
      if (course === 'unknown') {
        warnings.push({
          code: 'ambiguous-metric-course',
          message: `Course cell ${JSON.stringify(textAt(cells, courseColumn))} on row for ${JSON.stringify(label)} did not match a known course; recorded as unknown.`,
          rowIndex,
          raw: textAt(cells, courseColumn),
        });
      }
    } else if (unit === 'metric') {
      if (options.defaultCourse === undefined) {
        course = 'unknown';
        warnings.push({
          code: 'ambiguous-metric-course',
          message: `Row for ${JSON.stringify(label)} is metric with no course column and no defaultCourse supplied; recorded as unknown.`,
          rowIndex,
          raw: label,
        });
      } else {
        course = options.defaultCourse;
      }
    } else if (options.defaultCourse === undefined) {
      course = 'unknown';
      warnings.push({
        code: 'missing-course-declaration',
        message: `Row for ${JSON.stringify(label)} names no course unit, no course column, and no defaultCourse was supplied.`,
        rowIndex,
        raw: label,
      });
    } else {
      course = options.defaultCourse;
    }

    if (stroke === 'unknown') {
      warnings.push({
        code: 'unmapped-stroke',
        message: `Stroke could not be identified in ${JSON.stringify(label)}; recorded as unknown.`,
        rowIndex,
        raw: label,
      });
    }

    const time = readTime(textAt(cells, timeColumn), fakeEventFor(label, stroke), rowIndex, warnings);
    const date = dateColumn >= 0 ? textAt(cells, dateColumn) : '';
    const meetName = meetColumn >= 0 ? textAt(cells, meetColumn) : '';

    personalBests.push({
      label,
      course,
      stroke,
      ...(distance === undefined ? {} : { distance }),
      ...(time.finalTime === undefined ? {} : { time: time.finalTime }),
      ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
      ...(date.length === 0 ? {} : { date }),
      ...(meetName.length === 0 ? {} : { meetName }),
    });
  });

  if (dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message: 'The personal-bests table was found and holds no data rows.',
    });
  } else if (personalBests.length === 0) {
    return fail(
      context,
      'no-rows-parsed',
      `The personal-bests table held ${dataRows.length} data row(s) and none could be parsed.`,
      warnings,
    );
  }

  const name = firstHeadingText(html);

  return succeed(
    context,
    {
      swimCloudSwimmerId,
      ...(name === undefined ? {} : { name }),
      ...(options.gender === undefined ? {} : { gender: options.gender }),
      personalBests,
      rowCount: dataRows.length,
    },
    warnings,
  );
}

/**
 * `readTime` takes a {@link SwimCloudEvent} only to read its `stroke` (for the
 * diving-score-is-not-a-time branch) and its `eventId` (to scope warnings). A
 * personal-bests row has neither a real event id nor, usually, a diving flag
 * worth the same branch — this builds the minimal stand-in `readTime` needs
 * without duplicating its ~40 lines of marker/exhibition logic for a second
 * table shape.
 */
function fakeEventFor(label: string, stroke: SwimCloudStroke): SwimCloudEvent {
  return {
    eventId: `personal-best:${label}`,
    swimCloudMeetId: 'personal-best' as SwimCloudMeetId,
    label,
    kind: 'individual',
    course: 'unknown',
    gender: 'unknown',
    stroke,
  };
}
