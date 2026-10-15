/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Meet-results page parser for the synthetic-fixture page shape.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractRowCells,
  extractTableRows,
  findHeadings,
  findTables,
  htmlToText,
  isHeaderRow,
  stripElements,
} from './html';
import { itemAt, regexGroup } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type {
  SwimCloudCourse,
  SwimCloudCourseOrUnknown,
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudGenderOrUnknown,
  SwimCloudMeet,
  SwimCloudMeetFormat,
  SwimCloudMeetId,
  SwimCloudRelay,
  SwimCloudResult,
  SwimCloudRuleset,
  SwimCloudStroke,
} from './entities';
import { fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import { firstHeadingText } from './parseElements';
import {
  mapGender,
  mapStroke,
  readPoints,
  readTime,
  swimmerIdFromCell,
  teamIdFromCell,
} from './swimFields';
import {
  NAME_HEADERS,
  PLACE_HEADERS,
  POINTS_HEADERS,
  TEAM_HEADERS,
  TIME_HEADERS,
  cellAt,
  findColumn,
  normalizeHeader,
  textAt,
} from './parseCells';
import { missingMeetNameWarning } from './meetPageFields';
import { readRelayDesignator, readRelayLegs } from './relayLegs';

/** Place cells that mean "no place", rather than a place we failed to read. */
const NO_PLACE_TOKENS = new Set(['', '-', '--', '---', 'x', 'ex']);

/* -------------------------------------------------------------------------- */
/* Meet results                                                                */
/* -------------------------------------------------------------------------- */

/** Caller-supplied facts a results page's markup cannot be trusted to state. */
export interface SwimCloudMeetResultsParseOptions {
  /**
   * Meet id, for captures whose URL cannot be classified (a Wayback snapshot,
   * say). Required if the capture URL does not name a meet.
   */
  readonly meetId?: SwimCloudMeetId;
  /**
   * The meet's course.
   *
   * This is the **only** thing that can turn a "200 Meter Freestyle" label into
   * LCM or SCM. Supplying it is the caller asserting a fact; leaving it out
   * leaves every metric event `course: 'unknown'` with an
   * `ambiguous-metric-course` warning. Yard events do not need it.
   */
  readonly meetCourse?: SwimCloudCourse;
  /**
   * Meet format, which selects the point table
   * (`plans/2026-09-06/02-data-model-and-scoring.md` §3).
   *
   * SwimCloud is not known to publish this in a machine-readable way, so it is
   * a caller assertion. Omitted means `'unknown'` — never `'dual'`.
   */
  readonly meetFormat?: SwimCloudMeetFormat;
  /** Governing rulebook. Omitted means `'unknown'` — never `'NCAA'`. */
  readonly meetRuleset?: SwimCloudRuleset;
}

/** One event and everything read from its results table. */
export interface SwimCloudParsedEvent {
  readonly event: SwimCloudEvent;
  /** One entry per data row, in page order. */
  readonly entries: readonly SwimCloudEntry[];
  /** One result per data row, paired to {@link entries} by `entryId`. */
  readonly results: readonly SwimCloudResult[];
  /** Relay units, for relay events only. Empty for individual events. */
  readonly relays: readonly SwimCloudRelay[];
}

/** What {@link parseMeetResultsHtml} extracts. */
export interface SwimCloudMeetResultsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** From the page's first heading. */
  readonly meetName?: string;
  /**
   * The meet record.
   *
   * `format`, `ruleset` and `course` are `'unknown'` unless the caller asserted
   * them through {@link SwimCloudMeetResultsParseOptions}. They are never
   * inferred from the page.
   */
  readonly meet: SwimCloudMeet;
  readonly events: readonly SwimCloudParsedEvent[];
  /**
   * How many event headings the page carried.
   *
   * Compare against `events.length`: a shortfall means some event's table could
   * not be read, and each shortfall has a matching `unparsed-event` warning.
   * This field exists so a caller can detect a partial parse without diffing
   * warning codes — a partially-read meet must not look like a complete one.
   */
  readonly eventHeadingCount: number;
}

/**
 * Parse a SwimCloud meet-results page.
 *
 * **Synthetic-fixture-only** — see the file header. Never validated against a
 * page SwimCloud served.
 *
 * The page is read as a sequence of event headings (`Event 3 Women 200 Yard
 * Freestyle Relay`) each governing the next table. Sessions and heats are **not**
 * extracted: no evidence exists that SwimCloud's results view exposes them, and
 * emitting an empty session list would assert that we looked and found none.
 *
 * @deprecated Since 2026-09-08. A real capture proved this page shape does
 * not exist on SwimCloud (see this file's header). Its last user-reachable
 * call site, `packages/manager/src/components/RosterImportWizard.tsx`'s
 * `handleClipboardMeetResults`, was re-pointed the same day to
 * `parseTeamMeetSwimsHtml` — see
 * `plans/2026-09-08/04-parsers-and-fixtures.md`'s "Retired" section for the
 * three-step retirement plan this is step 2 of. Kept for one more round
 * (its table-reading and points/place-token edge cases are still exercised
 * only by this function's synthetic fixtures) before deletion alongside
 * `SwimCloudMeetResultsParse`, `SwimCloudParsedEvent`,
 * `swimCloudMeetResultsToSwimmerResults` and
 * `swimCloudMeetResultsToHistoricalSwims`.
 */
export function parseMeetResultsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetResultsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetResultsParse> {
  const warnings: SwimCloudParseWarning[] = [];

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.');
  }

  const fromUrl = meetIdFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a meet.`,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  if (meetId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a meet and no meetId option was supplied.`,
    );
  }

  const tables = findTables(html);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a results page is expected to contain at least one.',
    );
  }

  const headings = findHeadings(html);
  const eventHeadings = headings
    .map((heading) => ({ heading, parsed: parseEventHeading(heading.text) }))
    .filter((candidate): candidate is { heading: (typeof headings)[number]; parsed: ParsedEventHeading } =>
      candidate.parsed !== null,
    );

  if (eventHeadings.length === 0) {
    return fail(
      context,
      'expected-header-missing',
      'No heading matched the expected "Event {n} {Gender} {Distance} {Unit} {Stroke}" shape.',
    );
  }

  const parsedEvents: SwimCloudParsedEvent[] = [];

  for (const table of tables) {
    // Each table belongs to the last event heading that precedes it.
    let owner: (typeof eventHeadings)[number] | undefined;
    for (const candidate of eventHeadings) {
      if (candidate.heading.start < table.start) {
        owner = candidate;
      }
    }
    if (owner === undefined) {
      continue;
    }
    const ownerRef = owner.parsed.eventRef;
    // A second table under the same heading is not modelled; only the first is
    // read, and the extra is reported rather than silently merged.
    if (parsedEvents.some((parsed) => parsed.event.eventRef === ownerRef)) {
      warnings.push({
        code: 'unparsed-event',
        message: `A second table follows event heading ${JSON.stringify(owner.heading.text)}; only the first table of an event is read.`,
        raw: owner.heading.text,
      });
      continue;
    }

    const built = buildEvent(meetId, owner.parsed, options, warnings);
    const parsed = parseEventTable(table.html, built, warnings);
    if (parsed === null) {
      warnings.push({
        code: 'unparsed-event',
        message: `Results table for ${JSON.stringify(owner.heading.text)} lacks the columns required to read it; the event is absent from the output.`,
        eventId: built.eventId,
        raw: owner.heading.text,
      });
      continue;
    }
    parsedEvents.push(parsed);
  }

  if (parsedEvents.length === 0) {
    return fail(
      context,
      'no-events-parsed',
      `${eventHeadings.length} event heading(s) were found and none of their tables could be read.`,
      warnings,
    );
  }

  const meetName = firstHeadingText(html);
  if (meetName === undefined) warnings.push(missingMeetNameWarning());
  const meet: SwimCloudMeet = {
    swimCloudMeetId: meetId,
    name: meetName ?? '',
    format: options.meetFormat ?? 'unknown',
    ruleset: options.meetRuleset ?? 'unknown',
    course: options.meetCourse ?? 'unknown',
  };

  return succeed(
    context,
    {
      swimCloudMeetId: meetId,
      ...(meetName === undefined ? {} : { meetName }),
      meet,
      events: parsedEvents,
      eventHeadingCount: eventHeadings.length,
    },
    warnings,
  );
}

function meetIdFromSourceUrl(sourceUrl: string): { meetId?: SwimCloudMeetId; mismatch?: string } {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'meet' || resource.kind === 'meetEvent') {
    return { meetId: resource.meetId };
  }
  return { mismatch: resource.kind };
}

/* -------------------------------------------------------------------------- */
/* Event headings                                                              */
/* -------------------------------------------------------------------------- */

interface ParsedEventHeading {
  readonly label: string;
  /** Always present: the heading pattern requires an event reference to match at all. */
  readonly eventRef: string;
  readonly gender: SwimCloudGenderOrUnknown;
  readonly genderWord?: string;
  readonly distance?: number;
  readonly unit: 'yard' | 'metric' | 'none';
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
}

const EVENT_HEADING = /^event\s+(\S+)\s+(.*)$/i;

/**
 * Parse an event heading such as `Event 3 Women 200 Yard Freestyle Relay`.
 *
 * Returns `null` for a heading that is not an event heading — the page title,
 * a section label — so those are skipped rather than turned into an event with
 * unknown everything.
 */
function parseEventHeading(text: string): ParsedEventHeading | null {
  const match = EVENT_HEADING.exec(text);
  if (match === null) {
    return null;
  }
  const eventRef = regexGroup(match, 1);
  const rest = regexGroup(match, 2);
  const lower = rest.toLowerCase();

  const genderMatch = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(rest);
  const genderWord = genderMatch === null ? undefined : genderMatch[1];
  const gender = mapGender(genderWord);

  const distanceMatch = /\b(\d{1,4})\b/.exec(rest);
  const distance =
    distanceMatch === null ? undefined : Number.parseInt(regexGroup(distanceMatch, 1), 10);

  const unit: ParsedEventHeading['unit'] = /\byards?\b/.test(lower)
    ? 'yard'
    : /\bmet(?:er|re)s?\b|\bmtr\b/.test(lower)
      ? 'metric'
      : 'none';

  const isRelay = /\brelay\b/.test(lower);

  return {
    label: text,
    eventRef,
    gender,
    ...(genderWord === undefined ? {} : { genderWord }),
    ...(distance === undefined ? {} : { distance }),
    unit,
    stroke: mapStroke(lower, isRelay),
    isRelay,
  };
}

function buildEvent(
  meetId: SwimCloudMeetId,
  heading: ParsedEventHeading,
  options: SwimCloudMeetResultsParseOptions,
  warnings: SwimCloudParseWarning[],
): SwimCloudEvent {
  // Deterministic and capture-local: re-parsing the same HTML yields the same
  // ids, so a re-import updates rather than duplicates. These are not SwimCloud
  // ids and must never be presented as such.
  const eventId = `${meetId}:event:${heading.eventRef}`;

  let course: SwimCloudCourseOrUnknown;
  if (heading.unit === 'yard') {
    course = 'SCY';
  } else if (heading.unit === 'metric') {
    if (options.meetCourse === undefined) {
      course = 'unknown';
      warnings.push({
        code: 'ambiguous-metric-course',
        message: `Event ${JSON.stringify(heading.label)} is metric, which is ambiguous between LCM and SCM. No meet-level course was supplied, so the course is left unknown rather than guessed.`,
        eventId,
        raw: heading.label,
      });
    } else {
      course = options.meetCourse;
    }
  } else if (options.meetCourse === undefined) {
    course = 'unknown';
    warnings.push({
      code: 'missing-course-declaration',
      message: `Event ${JSON.stringify(heading.label)} names no course unit and no meet-level course was supplied.`,
      eventId,
      raw: heading.label,
    });
  } else {
    course = options.meetCourse;
  }

  if (heading.stroke === 'unknown') {
    warnings.push({
      code: 'unmapped-stroke',
      message: `Stroke could not be identified in ${JSON.stringify(heading.label)}; recorded as unknown.`,
      eventId,
      raw: heading.label,
    });
  }
  if (heading.gender === 'unknown') {
    warnings.push({
      code: 'unmapped-gender',
      message: `Gender ${JSON.stringify(heading.genderWord ?? '')} in ${JSON.stringify(heading.label)} is outside Men/Women; recorded as unknown.`,
      eventId,
      raw: heading.label,
    });
  }

  return {
    eventId,
    swimCloudMeetId: meetId,
    ...(heading.eventRef === undefined ? {} : { eventRef: heading.eventRef }),
    label: heading.label,
    kind: heading.isRelay ? 'relay' : 'individual',
    course,
    gender: heading.gender,
    ...(heading.distance === undefined ? {} : { distance: heading.distance }),
    stroke: heading.stroke,
  };
}

/* -------------------------------------------------------------------------- */
/* Results tables                                                              */
/* -------------------------------------------------------------------------- */

function parseEventTable(
  tableHtml: string,
  event: SwimCloudEvent,
  warnings: SwimCloudParseWarning[],
): SwimCloudParsedEvent | null {
  const rows = extractTableRows(tableHtml);
  const headerIndex = rows.findIndex((row) => isHeaderRow(row));
  if (headerIndex < 0) {
    return null;
  }
  const headers = extractRowCells(itemAt(rows, headerIndex)).map((cell) => normalizeHeader(htmlToText(cell)));

  const placeColumn = findColumn(headers, PLACE_HEADERS);
  const nameColumn = findColumn(headers, NAME_HEADERS);
  const teamColumn = findColumn(headers, TEAM_HEADERS);
  const timeColumn = findColumn(headers, TIME_HEADERS);
  const pointsColumn = findColumn(headers, POINTS_HEADERS);

  if (timeColumn < 0) {
    return null;
  }
  const subjectColumn = event.kind === 'relay' ? teamColumn : nameColumn;
  if (subjectColumn < 0) {
    return null;
  }


  const dataRows = rows
    .slice(headerIndex + 1)
    .filter((row) => !isHeaderRow(row))
    .map((row) => extractRowCells(row));

  const entries: SwimCloudEntry[] = [];
  const results: SwimCloudResult[] = [];
  const relays: SwimCloudRelay[] = [];

  dataRows.forEach((cells, rowIndex) => {
    const entryId = `${event.eventId}:entry:${rowIndex}`;
    const subjectHtml = cellAt(cells, subjectColumn);
    const subjectText = htmlToText(stripElements(subjectHtml, ['ol', 'ul']));
    if (subjectText.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Result row has an empty subject cell and was skipped.',
        eventId: event.eventId,
        rowIndex,
      });
      return;
    }

    const teamId =
      teamColumn >= 0 ? teamIdFromCell(cellAt(cells, teamColumn)) : teamIdFromCell(subjectHtml);
    const place = readPlace(textAt(cells, placeColumn), event, rowIndex, warnings);
    const time = readTime(textAt(cells, timeColumn), event, rowIndex, warnings);
    const points = pointsColumn >= 0 ? readPoints(textAt(cells, pointsColumn), event, rowIndex, warnings) : {};

    let relayId: string | undefined;
    let teamName: string | undefined;
    if (event.kind === 'relay') {
      relayId = `${event.eventId}:relay:${rowIndex}`;
      const designator = readRelayDesignator(subjectText);
      const legs = readRelayLegs(subjectHtml);
      if (legs.length === 0) {
        warnings.push({
          code: 'relay-legs-absent',
          message: `Relay row for ${JSON.stringify(subjectText)} lists no legs. SwimCloud does publish them — a per-event results page carries them in a hidden table behind its own "Show names" toggle — so this row is genuinely missing them rather than expected to lack them.`,
          eventId: event.eventId,
          rowIndex,
          raw: subjectText,
        });
      }
      teamName = designator === undefined ? subjectText : designator.teamName;
      relays.push({
        relayId,
        eventId: event.eventId,
        ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
        teamName,
        ...(designator === undefined ? {} : { designator: designator.designator }),
        legs,
      });
    } else if (teamColumn >= 0) {
      // Individual event: the subject column is the athlete's name, not the
      // team — the team's printed name lives in its own column, same one
      // teamIdFromCell already reads for the id.
      const rawTeamName = textAt(cells, teamColumn);
      teamName = rawTeamName.length === 0 ? undefined : rawTeamName;
    }

    const swimmerId = event.kind === 'relay' ? undefined : swimmerIdFromCell(subjectHtml);
    if (event.kind === 'individual' && swimmerId === undefined) {
      warnings.push({
        code: 'missing-athlete-link',
        message: `Result row for ${subjectText} carries no /swimmer/{id}/ link; the athlete has no SwimCloud id from this capture.`,
        eventId: event.eventId,
        rowIndex,
        raw: subjectText,
      });
    }

    entries.push({
      entryId,
      eventId: event.eventId,
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      ...(event.kind === 'individual' ? { athleteName: subjectText } : {}),
      ...(relayId === undefined ? {} : { relayId }),
      ...(teamId === undefined ? {} : { swimCloudTeamId: teamId }),
      ...(teamName === undefined ? {} : { teamName }),
    });

    results.push({
      resultId: `${event.eventId}:result:${rowIndex}`,
      entryId,
      eventId: event.eventId,
      ...(place === undefined ? {} : { place }),
      ...(points.points === undefined ? {} : { points: points.points }),
      ...(points.rawPointsToken === undefined ? {} : { rawPointsToken: points.rawPointsToken }),
      ...(time.finalTime === undefined ? {} : { finalTime: time.finalTime }),
      ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
      ...(time.flags === undefined ? {} : { flags: time.flags }),
    });
  });

  if (dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message: `Results table for ${JSON.stringify(event.label)} was found and holds no data rows. This is a real "nobody swam / nothing posted yet" answer, not a missing table.`,
      eventId: event.eventId,
    });
  }

  return { event, entries, results, relays };
}

function readPlace(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): number | undefined {
  const token = raw.trim();
  if (NO_PLACE_TOKENS.has(token.toLowerCase())) {
    return undefined;
  }
  if (/^\d+$/.test(token)) {
    const value = Number.parseInt(token, 10);
    if (value > 0) {
      return value;
    }
    // "0" is numeric but not a valid place (places start at 1). Falls through
    // to the same warning below as a non-numeric token, rather than silently
    // becoming "no place" with no audit trail — a real "no place" always
    // comes from NO_PLACE_TOKENS above, never from a printed zero.
  }
  warnings.push({
    code: 'unrecognized-place-token',
    message: `Place cell ${JSON.stringify(token)} is neither a valid place (an integer of 1 or more) nor a known "no place" marker; no place recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return undefined;
}
