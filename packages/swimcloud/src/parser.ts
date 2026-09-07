/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud parser/normalizer — HTML in, typed entities out.
 *
 * # READ THIS BEFORE TRUSTING ANY OUTPUT OF THIS FILE
 *
 * **No function in this file has ever been run against real SwimCloud markup.**
 *
 * Network access to swimcloud.com is blocked in the environment this was
 * written in, and no human-captured fixture existed at the time. Every
 * extraction rule here was written against **hand-authored synthetic HTML**
 * (`tests/fixtures/swimcloud-synthetic-*.html`) built from the *structural
 * description* in `plans/2026-09-06/02-data-model-and-scoring.md`, not from a
 * page anybody has seen. That is why every result carries
 * `confidence: 'synthetic-fixture-only'` — see
 * {@link SwimCloudParseConfidence}. Treat the passing tests as evidence that the
 * *contract* holds, not that the *selectors* do.
 *
 * The intended sequence is: a human captures one real roster page and one real
 * meet-results page (Track A, `plans/2026-09-06/04-phasing.md` Phase 1), those
 * become fixtures, the rules here are corrected against them, and the confidence
 * marker gains a second value. Until then, anything this returns should be shown
 * to a human for confirmation before it reaches a workspace.
 *
 * # Contract
 *
 * - **Input is a raw HTML string.** Both access tracks can produce one without
 *   either dictating a parser to the other: Track A's content script has
 *   `document.documentElement.outerHTML`, Track B's Playwright has
 *   `page.content()` (`plans/2026-09-06/03-architecture.md` §1.3).
 * - **Extraction is string/regex only.** No DOM, no HTML-parser dependency —
 *   see the rationale in `./html.ts`.
 * - **Absent is never empty and never zero.** A structure that is missing
 *   produces `ok: false` with a failure code. A structure that is present and
 *   genuinely holds nothing produces `ok: true` with a `zero-data-rows`
 *   warning. These are different facts and callers must be able to tell them
 *   apart — silent empties are the top failure mode this repo guards against
 *   (`CLAUDE.md` § Data provenance, rule 4).
 * - **Nothing is inferred that the page did not say.** An ambiguous "Meter"
 *   event stays `course: 'unknown'`. An unparseable time is preserved verbatim
 *   in `rawTimeToken` and left out of `finalTime`. An unmapped class year is
 *   `'unknown'`.
 * - **Points are dropped on purpose.** A points column that is found is *not*
 *   read into the model; a `points-column-ignored` warning records that the
 *   column existed and was deliberately discarded. Points are derived from
 *   (place, DQ, exhibition, ties, resolved point table), never imported —
 *   `plans/2026-09-06/02-data-model-and-scoring.md` §2.
 */

import {
  collapseWhitespace,
  extractHrefs,
  extractListItems,
  extractRowCells,
  extractTableRows,
  findHeadings,
  findTables,
  htmlToText,
  isHeaderRow,
  stripElements,
} from './html';
import type {
  SwimCloudAthlete,
  SwimCloudCaptureTrack,
  SwimCloudClassYear,
  SwimCloudCourse,
  SwimCloudCourseOrUnknown,
  SwimCloudEntry,
  SwimCloudEvent,
  SwimCloudGender,
  SwimCloudGenderOrUnknown,
  SwimCloudMeet,
  SwimCloudMeetFormat,
  SwimCloudMeetId,
  SwimCloudProvenance,
  SwimCloudRelay,
  SwimCloudRelayLeg,
  SwimCloudResult,
  SwimCloudResultFlags,
  SwimCloudRuleset,
  SwimCloudStroke,
  SwimCloudSwimmerId,
  SwimCloudTeam,
  SwimCloudTeamId,
  SwimCloudTimeString,
} from './entities';
import { classifySwimCloudUrl } from './urlClassifier';

/* -------------------------------------------------------------------------- */
/* Confidence, warnings, failures                                              */
/* -------------------------------------------------------------------------- */

/**
 * How much the extraction rules that produced a result have actually been
 * checked.
 *
 * Currently a single-member union on purpose: there is exactly one honest value
 * today, and making it a union means adding the second one (once a real capture
 * exists) is a type change every call site sees, rather than a silent
 * loosening.
 */
export type SwimCloudParseConfidence = 'synthetic-fixture-only';

/**
 * The only confidence any parser in this file can currently report.
 *
 * `'synthetic-fixture-only'` means: these selectors have been exercised against
 * hand-authored HTML that a human guessed at, and never against a page
 * SwimCloud served.
 */
export const SWIMCLOUD_PARSE_CONFIDENCE: SwimCloudParseConfidence = 'synthetic-fixture-only';

/** Something the parser noticed and did not silently swallow. */
export type SwimCloudParseWarningCode =
  /** The expected table was found, with a header row and no data rows. */
  | 'zero-data-rows'
  /** A points column was present and was deliberately discarded. */
  | 'points-column-ignored'
  /** A data row could not be turned into an entity and was skipped. */
  | 'unparsed-row'
  /** An event heading was found but its table could not be read; the event is absent from the output. */
  | 'unparsed-event'
  /** A time cell held something that is neither a time nor a known marker. Preserved verbatim. */
  | 'unrecognized-time-token'
  /** A place cell held something that is neither an integer nor a known "no place" marker. */
  | 'unrecognized-place-token'
  /** The event label said "Meter", which is ambiguous between LCM and SCM. Course left unknown. */
  | 'ambiguous-metric-course'
  /** The event label carried no course unit at all and no meet-level course was supplied. */
  | 'missing-course-declaration'
  /** A class-year cell held a value outside the known vocabulary. Recorded as `'unknown'`. */
  | 'unmapped-class-year'
  /** An event's gender word is outside `Men`/`Women` (e.g. `Mixed`). Recorded as `'unknown'`. */
  | 'unmapped-gender'
  /** An event label's stroke could not be identified. Recorded as `'unknown'`. */
  | 'unmapped-stroke'
  /** A roster/results row named an athlete with no `/swimmer/{id}/` link. */
  | 'missing-athlete-link'
  /** A relay row listed no legs. Expected if SwimCloud does not publish them at all. */
  | 'relay-legs-absent'
  /** A row's event label said "Yard" but an explicit course column disagreed. The label wins; the disagreement is surfaced rather than silently resolved either way. */
  | 'course-column-contradicts-label'
  /** A diving event's result column holds a judged score, not a time; not stored as `finalTime`. */
  | 'diving-score-not-a-time';

/** One non-fatal observation, with enough context to find the row it came from. */
export interface SwimCloudParseWarning {
  readonly code: SwimCloudParseWarningCode;
  readonly message: string;
  /** 0-based index of the data row within its table, when row-scoped. */
  readonly rowIndex?: number;
  /** The event this warning belongs to, when event-scoped. */
  readonly eventId?: string;
  /** The offending text, verbatim. Present whenever something was rejected. */
  readonly raw?: string;
}

/** Why a parse produced nothing usable. Always loud, never an empty success. */
export type SwimCloudParseFailureCode =
  /** The input string was empty or whitespace. */
  | 'empty-input'
  /** The capture URL names a different resource than the parser was asked for, or no id could be resolved. */
  | 'source-url-mismatch'
  /** No table at all was found where one was required. */
  | 'expected-table-missing'
  /** A table was found but its header row lacks a column this parser requires. */
  | 'expected-header-missing'
  /** Data rows existed and every one of them failed to parse. */
  | 'no-rows-parsed'
  /** Event headings existed and not one of their tables could be read. */
  | 'no-events-parsed';

export interface SwimCloudParseFailure {
  readonly code: SwimCloudParseFailureCode;
  readonly message: string;
}

/** Success half of {@link SwimCloudParseResult}. */
export interface SwimCloudParseSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly provenance: SwimCloudProvenance;
  readonly confidence: SwimCloudParseConfidence;
  readonly warnings: readonly SwimCloudParseWarning[];
}

/** Failure half of {@link SwimCloudParseResult}. */
export interface SwimCloudParseFailureResult {
  readonly ok: false;
  readonly failure: SwimCloudParseFailure;
  readonly provenance: SwimCloudProvenance;
  readonly confidence: SwimCloudParseConfidence;
  readonly warnings: readonly SwimCloudParseWarning[];
}

/**
 * Every parser returns this.
 *
 * Discriminated on `ok` so a caller cannot read `data` without having handled
 * the failure case — the type system enforcing the "absent ≠ empty" rule that
 * a nullable return would leave to discipline.
 */
export type SwimCloudParseResult<T> = SwimCloudParseSuccess<T> | SwimCloudParseFailureResult;

/** What the caller knows about the capture. Supplied, never invented here. */
export interface SwimCloudParseContext {
  /** The URL the HTML was captured from. */
  readonly sourceUrl: string;
  /** ISO-8601 instant of capture. The parser has no clock of its own. */
  readonly retrievedAt: string;
  /** Which access track produced the capture. */
  readonly track: SwimCloudCaptureTrack;
  /** SHA-256 of the raw HTML, if the caller computed one. */
  readonly sha256?: string;
}

function provenanceOf(context: SwimCloudParseContext): SwimCloudProvenance {
  return {
    sourceUrl: context.sourceUrl,
    retrievedAt: context.retrievedAt,
    track: context.track,
    ...(context.sha256 === undefined ? {} : { sha256: context.sha256 }),
  };
}

function fail(
  context: SwimCloudParseContext,
  code: SwimCloudParseFailureCode,
  message: string,
  warnings: readonly SwimCloudParseWarning[] = [],
): SwimCloudParseFailureResult {
  return {
    ok: false,
    failure: { code, message },
    provenance: provenanceOf(context),
    confidence: SWIMCLOUD_PARSE_CONFIDENCE,
    warnings,
  };
}

function succeed<T>(
  context: SwimCloudParseContext,
  data: T,
  warnings: readonly SwimCloudParseWarning[],
): SwimCloudParseSuccess<T> {
  return {
    ok: true,
    data,
    provenance: provenanceOf(context),
    confidence: SWIMCLOUD_PARSE_CONFIDENCE,
    warnings,
  };
}

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
function normalizeHeader(label: string): string {
  return collapseWhitespace(label.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

function findColumn(headers: readonly string[], synonyms: readonly string[]): number {
  for (let index = 0; index < headers.length; index += 1) {
    if (synonyms.includes(headers[index])) {
      return index;
    }
  }
  return -1;
}

const NAME_HEADERS = ['name', 'athlete', 'swimmer'] as const;
const CLASS_HEADERS = ['class', 'yr', 'year', 'class year', 'grade'] as const;
const HOMETOWN_HEADERS = ['hometown', 'home town', 'hometown high school'] as const;
const TEAM_HEADERS = ['team', 'school', 'club'] as const;
const PLACE_HEADERS = ['place', 'pl', 'pos', 'rank'] as const;
const TIME_HEADERS = ['time', 'finals', 'finals time', 'final time', 'result', 'score'] as const;
const POINTS_HEADERS = ['points', 'pts', 'score points', 'team points'] as const;

function cellAt(cells: readonly string[], index: number): string {
  if (index < 0 || index >= cells.length) {
    return '';
  }
  return cells[index];
}

function textAt(cells: readonly string[], index: number): string {
  return htmlToText(cellAt(cells, index));
}

/* -------------------------------------------------------------------------- */
/* Value vocabularies                                                          */
/* -------------------------------------------------------------------------- */

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

/**
 * A swim time as printed: optional hour and minute groups, then seconds to
 * hundredths. `52.10`, `1:56.47`, `1:02:33.44`.
 *
 * Hundredths are required. A value printed to tenths or to thousandths is not a
 * time this parser will accept, because accepting it would mean deciding how to
 * pad or truncate it, and that is a fabricated digit in a competition value.
 */
const TIME_TOKEN = /^(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}$/;

/** Trailing time on a relay-leg line, e.g. `Landon Dehn 23.41`. */
const TRAILING_TIME = /(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}\s*$/;

/**
 * Non-time markers with a meaning clear enough to map onto a flag.
 *
 * **Unverified** that SwimCloud prints these tokens at all — they are the
 * Hy-Tek/Meet-Manager conventions the sport uses everywhere. A token outside
 * this map is *not* guessed at: it is preserved in
 * {@link SwimCloudResult.rawTimeToken} and reported as
 * `unrecognized-time-token`.
 */
const RESULT_MARKERS: Readonly<Record<string, SwimCloudResultFlags>> = {
  dq: { disqualified: true },
  ns: { noShow: true },
  scr: { scratched: true },
  // Declared False Start: the athlete did not swim. Treated as a scratch, which
  // is the state it shares — deliberately not folded into `disqualified`, since
  // Rule 7 treats a DQ and a non-swim differently.
  dfs: { scratched: true },
};

/** Place cells that mean "no place", rather than a place we failed to read. */
const NO_PLACE_TOKENS = new Set(['', '-', '--', '---', 'x', 'ex']);

/* -------------------------------------------------------------------------- */
/* Team roster                                                                 */
/* -------------------------------------------------------------------------- */

/** Caller-supplied facts a roster page's markup cannot be trusted to state. */
export interface SwimCloudRosterParseOptions {
  /**
   * The gender this roster was filtered to.
   *
   * Supplied by the caller because the roster URL's `gender` query parameter has
   * an **unverified** encoding and the page body may not restate it. Never
   * inferred from athlete names. Without it the parse still succeeds, but no
   * {@link SwimCloudTeam} is produced, because a team record without a gender
   * would violate the one-program-per-sponsored-gender rule.
   */
  readonly gender?: SwimCloudGender;
  /** Season label `YYYY-YYYY` the roster belongs to. */
  readonly season?: string;
  /** Team id, for captures whose URL cannot be classified (a Wayback snapshot, say). */
  readonly teamId?: SwimCloudTeamId;
}

/** What {@link parseTeamRosterHtml} extracts. */
export interface SwimCloudRosterParse {
  /** From the capture URL, or from {@link SwimCloudRosterParseOptions.teamId}. */
  readonly swimCloudTeamId?: SwimCloudTeamId;
  /** From the page's first heading. */
  readonly teamName?: string;
  readonly gender?: SwimCloudGender;
  readonly season?: string;
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
 * Parse a SwimCloud team-roster page.
 *
 * **Synthetic-fixture-only** — see the file header. Never validated against a
 * page SwimCloud served.
 *
 * Locates the first table whose header row carries a name column, then reads
 * rows by header label. An athlete's SwimCloud id comes from the row's
 * `/swimmer/{id}/` link (classified through {@link classifySwimCloudUrl}), not
 * from the printed name.
 */
export function parseTeamRosterHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudRosterParseOptions = {},
): SwimCloudParseResult<SwimCloudRosterParse> {
  const warnings: SwimCloudParseWarning[] = [];

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.');
  }

  const teamIdFromUrl = teamIdFromSourceUrl(context.sourceUrl);
  if (teamIdFromUrl.mismatch) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${teamIdFromUrl.mismatch} resource, not a team or team roster.`,
    );
  }
  const swimCloudTeamId = options.teamId ?? teamIdFromUrl.teamId;

  const tables = findTables(html);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a roster page is expected to contain one.',
    );
  }

  let headerCells: string[] | null = null;
  let dataRows: string[][] = [];
  let nameColumn = -1;

  for (const table of tables) {
    const rows = extractTableRows(table.html);
    if (rows.length === 0) {
      continue;
    }
    const headerIndex = rows.findIndex((row) => isHeaderRow(row));
    if (headerIndex < 0) {
      continue;
    }
    const headers = extractRowCells(rows[headerIndex]).map((cell) => normalizeHeader(htmlToText(cell)));
    const candidate = findColumn(headers, NAME_HEADERS);
    if (candidate < 0) {
      continue;
    }
    headerCells = headers;
    nameColumn = candidate;
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
      `No table carried a name column (looked for ${NAME_HEADERS.join(', ')}).`,
    );
  }

  const classColumn = findColumn(headerCells, CLASS_HEADERS);
  const hometownColumn = findColumn(headerCells, HOMETOWN_HEADERS);

  const athletes: SwimCloudAthlete[] = [];
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

    let classYear: SwimCloudClassYear | undefined;
    if (classColumn >= 0) {
      const rawClass = textAt(cells, classColumn);
      if (rawClass.length > 0) {
        const mapped = CLASS_YEARS[normalizeHeader(rawClass)];
        if (mapped === undefined) {
          classYear = 'unknown';
          warnings.push({
            code: 'unmapped-class-year',
            message: `Class year ${JSON.stringify(rawClass)} is outside the known vocabulary; recorded as unknown.`,
            rowIndex,
            raw: rawClass,
          });
        } else {
          classYear = mapped;
        }
      }
    }

    const hometown = hometownColumn >= 0 ? textAt(cells, hometownColumn) : '';

    athletes.push({
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      name,
      ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
      ...(classYear === undefined ? {} : { classYear }),
      ...(options.gender === undefined ? {} : { gender: options.gender }),
      ...(options.season === undefined ? {} : { season: options.season }),
      ...(hometown.length === 0 ? {} : { hometown }),
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
    );
  }

  const teamName = firstHeadingText(html);
  const team = buildTeam(swimCloudTeamId, teamName, options);

  return succeed(
    context,
    {
      ...(swimCloudTeamId === undefined ? {} : { swimCloudTeamId }),
      ...(teamName === undefined ? {} : { teamName }),
      ...(options.gender === undefined ? {} : { gender: options.gender }),
      ...(options.season === undefined ? {} : { season: options.season }),
      ...(team === undefined ? {} : { team }),
      athletes,
      rowCount: dataRows.length,
    },
    warnings,
  );
}

function buildTeam(
  teamId: SwimCloudTeamId | undefined,
  teamName: string | undefined,
  options: SwimCloudRosterParseOptions,
): SwimCloudTeam | undefined {
  if (teamId === undefined || teamName === undefined || options.gender === undefined) {
    return undefined;
  }
  return {
    swimCloudTeamId: teamId,
    gender: options.gender,
    name: teamName,
    ...(options.season === undefined ? {} : { season: options.season }),
  };
}

function firstHeadingText(html: string): string | undefined {
  const headings = findHeadings(html);
  for (const heading of headings) {
    if (heading.level === 1 && heading.text.length > 0) {
      return heading.text;
    }
  }
  return undefined;
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

function swimmerIdFromCell(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome === 'fetchable' && classification.resource.kind === 'swimmer') {
      return classification.resource.swimmerId;
    }
  }
  return undefined;
}

function teamIdFromCell(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome === 'fetchable' && classification.resource.kind === 'team') {
      return classification.resource.teamId;
    }
  }
  return undefined;
}

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
  const eventRef = match[1];
  const rest = match[2];
  const lower = rest.toLowerCase();

  const genderMatch = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(rest);
  const genderWord = genderMatch === null ? undefined : genderMatch[1];
  const gender = mapGender(genderWord);

  const distanceMatch = /\b(\d{1,4})\b/.exec(rest);
  const distance = distanceMatch === null ? undefined : Number.parseInt(distanceMatch[1], 10);

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

function mapGender(word: string | undefined): SwimCloudGenderOrUnknown {
  if (word === undefined) {
    return 'unknown';
  }
  const lower = word.toLowerCase();
  if (lower === 'men' || lower === 'mens') {
    return 'Men';
  }
  if (lower === 'women' || lower === 'womens') {
    return 'Women';
  }
  // `Mixed`, `Boys`, `Girls` have no home in the two-value program vocabulary
  // this repo uses. They are reported as unknown rather than forced into one.
  return 'unknown';
}

function mapStroke(lowerLabel: string, isRelay: boolean): SwimCloudStroke {
  if (/\bdiving\b|\bdiver\b|\bdive\b/.test(lowerLabel)) {
    return 'Diving';
  }
  if (isRelay) {
    if (/\bmedley\b/.test(lowerLabel)) {
      return 'Medley Relay';
    }
    if (/\bfree(style)?\b/.test(lowerLabel)) {
      return 'Freestyle Relay';
    }
    return 'unknown';
  }
  if (/\bindividual medley\b|\bim\b/.test(lowerLabel)) {
    return 'Individual Medley';
  }
  if (/\bbutterfly\b|\bfly\b/.test(lowerLabel)) {
    return 'Butterfly';
  }
  if (/\bbackstroke\b|\bback\b/.test(lowerLabel)) {
    return 'Backstroke';
  }
  if (/\bbreaststroke\b|\bbreast\b/.test(lowerLabel)) {
    return 'Breaststroke';
  }
  if (/\bfreestyle\b|\bfree\b/.test(lowerLabel)) {
    return 'Freestyle';
  }
  return 'unknown';
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
  const headers = extractRowCells(rows[headerIndex]).map((cell) => normalizeHeader(htmlToText(cell)));

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

  if (pointsColumn >= 0) {
    warnings.push({
      code: 'points-column-ignored',
      message:
        'A points column was found and deliberately discarded. Points are derived from place, DQ status, exhibition flag, ties and the resolved point table — never imported.',
      eventId: event.eventId,
    });
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

    let relayId: string | undefined;
    let teamName: string | undefined;
    if (event.kind === 'relay') {
      relayId = `${event.eventId}:relay:${rowIndex}`;
      const designator = readRelayDesignator(subjectText);
      const legs = readRelayLegs(subjectHtml);
      if (legs.length === 0) {
        warnings.push({
          code: 'relay-legs-absent',
          message: `Relay row for ${JSON.stringify(subjectText)} lists no legs. If SwimCloud does not publish relay leg splits at all, this is the permanent, expected state — see plans/2026-09-06/04-phasing.md open question 4.`,
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

interface ReadTime {
  readonly finalTime?: string;
  readonly rawTimeToken?: string;
  readonly flags?: SwimCloudResultFlags;
}

function readTime(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): ReadTime {
  const token = raw.trim();
  if (token.length === 0) {
    return {};
  }

  // A leading `X` marks an exhibition swim in Hy-Tek-derived output. Unverified
  // for SwimCloud specifically; recognized here, and the flag is what excludes
  // the swim before scoring places rather than after.
  const exhibition = /^x/i.test(token) && TIME_TOKEN.test(token.slice(1));
  const body = exhibition ? token.slice(1) : token;

  if (event.stroke === 'Diving') {
    // A diving column holds a judged score, not a time. Storing it in a time
    // field would put a non-time into a field everything downstream reads as a
    // time.
    warnings.push({
      code: 'diving-score-not-a-time',
      message: `Diving result ${JSON.stringify(token)} is a judged score, not a time; preserved verbatim and not stored as finalTime.`,
      eventId: event.eventId,
      rowIndex,
      raw: token,
    });
    return {
      rawTimeToken: token,
      ...(exhibition ? { flags: { exhibition: true } } : {}),
    };
  }

  if (TIME_TOKEN.test(body)) {
    return {
      finalTime: body,
      ...(exhibition ? { flags: { exhibition: true } } : {}),
    };
  }

  const marker = RESULT_MARKERS[body.toLowerCase()];
  if (marker !== undefined) {
    return {
      rawTimeToken: token,
      flags: exhibition ? { ...marker, exhibition: true } : marker,
    };
  }

  warnings.push({
    code: 'unrecognized-time-token',
    message: `Time cell ${JSON.stringify(token)} is neither a time nor a known marker (${Object.keys(RESULT_MARKERS).join(', ').toUpperCase()}); preserved verbatim, no time recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return { rawTimeToken: token };
}

const RELAY_DESIGNATOR = /^(.*?)\s*['‘’"“”]\s*([A-Za-z])\s*['‘’"“”]?\s*$/;

function readRelayDesignator(text: string): { teamName: string; designator: string } | undefined {
  const match = RELAY_DESIGNATOR.exec(text);
  if (match === null) {
    return undefined;
  }
  const teamName = match[1].trim();
  if (teamName.length === 0) {
    return undefined;
  }
  return { teamName, designator: match[2].toUpperCase() };
}

/**
 * Read relay legs from a `<ol>`/`<ul>` inside the relay's subject cell.
 *
 * **The structure this reads is invented.** Whether SwimCloud publishes relay
 * legs at all — let alone as a list — is open question 4 in
 * `plans/2026-09-06/04-phasing.md`. An empty result is the expected outcome
 * until that is answered, and a `relay-legs-absent` warning says so out loud.
 *
 * A leg's split is read only when the line ends in a well-formed time. Splits
 * are never reconstructed by subtracting cumulative times: that arithmetic would
 * manufacture a competition value the page never published.
 */
function readRelayLegs(subjectHtml: string): SwimCloudRelayLeg[] {
  const items = extractListItems(subjectHtml);
  const legs: SwimCloudRelayLeg[] = [];
  items.forEach((item, index) => {
    const text = htmlToText(item);
    if (text.length === 0) {
      return;
    }
    const timeMatch = TRAILING_TIME.exec(text);
    const splitTime = timeMatch === null ? undefined : timeMatch[0].trim();
    const athleteName =
      timeMatch === null ? text : collapseWhitespace(text.slice(0, timeMatch.index));
    const swimmerId = swimmerIdFromCell(item);
    legs.push({
      order: index + 1,
      ...(swimmerId === undefined ? {} : { swimCloudSwimmerId: swimmerId }),
      ...(athleteName.length === 0 ? {} : { athleteName }),
      ...(splitTime === undefined ? {} : { splitTime }),
    });
  });
  return legs;
}

/* -------------------------------------------------------------------------- */
/* Swimmer profile / personal bests                                           */
/* -------------------------------------------------------------------------- */

/**
 * One personal-best row from a swimmer's profile page.
 *
 * **Unverified whether this table exists in a captured page's HTML at all.**
 * Prior-art research (`plans/2026-09-06/04-phasing.md` open question 2 /
 * `02-data-model-and-scoring.md` §1) found that SwimCloud's swimmer-page times
 * view sits behind a tab ("EVENT PROGRESSION") that at least one prior scraper
 * needed a full browser interaction to expose — meaning the data may not be
 * present in `document.documentElement.outerHTML` unless a human has already
 * clicked that tab before Track A's "Copy for Omniswim" button is pressed.
 * That's a fact about *when* to capture, not a defect in this parser: if the
 * tab hasn't been opened, this function correctly reports
 * `expected-table-missing` rather than inventing an empty list.
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

const EVENT_LABEL_HEADERS = ['event', 'race'] as const;
const DATE_HEADERS = ['date', 'swam'] as const;
const MEET_HEADERS = ['meet', 'competition'] as const;
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
  const distance = distanceMatch === null ? undefined : Number.parseInt(distanceMatch[1], 10);
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
    const headers = extractRowCells(rows[headerIndex]).map((cell) => normalizeHeader(htmlToText(cell)));
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
