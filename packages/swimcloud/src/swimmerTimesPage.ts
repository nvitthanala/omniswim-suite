/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Swimmer times page parser (`/swimmer/{id}/times/`).
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractHrefs,
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
  SwimCloudEvent,
  SwimCloudMeetId,
  SwimCloudStroke,
  SwimCloudSwimmerId,
  SwimCloudTimeString,
} from './entities';
import { SWIMCLOUD_REAL_CAPTURE_CONFIDENCE, fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import {
  classTokens,
  readAttribute,
  readQueryParam,
  startTagOf,
} from './parseElements';
import { mapStroke, readTime } from './swimFields';
import {
  DATE_HEADERS,
  EVENT_LABEL_HEADERS,
  MEET_HEADERS,
  TIME_HEADERS,
  cellAt,
  findColumn,
  normalizeHeader,
  textAt,
} from './parseCells';

/* -------------------------------------------------------------------------- */
/* Swimmer times — the real `/swimmer/{id}/times/` personal-bests table        */
/* -------------------------------------------------------------------------- */

/**
 * One chip printed in a personal-best row's badge column, captured verbatim.
 *
 * The real capture prints four kinds in one column and does not say which kind
 * a given chip is: `NCAA B` and `WIN JRS` are qualifying standards, `X`
 * (`title="Extracted"`) is a statement about where SwimCloud got the time, and
 * `R` (`title="Leadoff"`) says the time is a relay leadoff split. Because the
 * page does not separate them, this type does not either — it carries the
 * visible code and the tooltip, and resolves neither.
 *
 * Resolving a code to a meaning is deliberately out of scope, for the reason
 * {@link SwimCloudCutStandardLabel} gives: a scraped badge is not a cut
 * decision, and `CLAUDE.md`'s provenance rules reserve that answer for the
 * cutline tables, which trace every value to an archived PDF.
 *
 * **`X` here is not the Hy-Tek exhibition marker.** {@link readTime} treats a
 * leading `X` on a *time token* as exhibition; this `X` is a separate chip in a
 * separate cell whose own tooltip reads `Extracted`. They are unrelated, and
 * this parser never maps one to the other.
 */
export interface SwimCloudSwimmerTimesTag {
  /** The visible short code, e.g. `'NCAA B'`, `'WIN JRS'`, `'X'`, `'R'`. */
  readonly code: string;
  /** The chip's `title` tooltip, e.g. `'Extracted'` for `'X'`. Absent when the markup carried none. */
  readonly title?: string;
}

/**
 * One row of the "Personal Bests" table: this swimmer's single fastest time in
 * one course-qualified event, and the swim that set it.
 *
 * **One row per event, not per swim.** The table is a bests list, so a swimmer
 * with 29 rows has swum 29 events, not attended 29 meets. Never compare a row
 * count here against a meet's entry count.
 */
export interface SwimCloudPersonalBestSwim {
  /**
   * A key unique to this swim and stable across captures.
   *
   * `{meetId}:swim:{swimCloudSwimId}` whenever the row's time link carried a
   * swim id — **the identical scheme {@link SwimCloudTeamMeetSwim.swimKey}
   * uses**, deliberately: the same swim reached from a team's swims list and
   * from the swimmer's own bests table produces the same key, so a caller
   * holding both can tell they are one swim rather than two.
   *
   * When that link was missing, this falls back to a composite of values the
   * row did print. Deterministic and built only from real data, but only as
   * stable as those values — a caller needing a true SwimCloud identity should
   * check {@link swimCloudSwimId} instead.
   */
  readonly swimKey: string;
  /** SwimCloud's own id for this swim, from `?id=` on the time cell's link. Absent when the row carried no such link. */
  readonly swimCloudSwimId?: string;
  /**
   * The event id this swim belongs to.
   *
   * `{meetId}:event:{eventRef}` when the time link named both — again the same
   * scheme {@link parseTeamMeetSwimsHtml} builds, so the two parsers agree on
   * what "the same event of the same meet" means. Without a link it falls back
   * to a capture-local `swimmer-times:event-label:{label}` key, whose prefix
   * says out loud that it is not meet-scoped and not a SwimCloud id.
   */
  readonly eventId: string;
  /** The `{n}` of `/results/{meetId}/event/{n}/`, kept as a string — see `SwimCloudResource`'s `meetEvent`. Absent when the row carried no time link. */
  readonly eventRef?: string;
  /**
   * The event exactly as the page prints it — `'50 Free SCY'`, `'200 IM LCM'`.
   *
   * **The course is inside this string**, which is what makes this table's
   * event labels a different shape from a swims list's (`'50 Y Free'`, course
   * letter in the middle) and from a meet heading's. The three are not
   * interchangeable and no reader here is shared between them.
   */
  readonly eventLabel: string;
  /**
   * Distance, in the unit {@link course} names. Derived from {@link eventLabel}
   * — see that field.
   */
  readonly distance?: number;
  /**
   * Course, **derived from the trailing token of {@link eventLabel}**, not read
   * from a column of its own. This page publishes no course field; `SCY` and
   * `LCM` are suffixes of the printed event name.
   *
   * A label this parser has not seen the shape of yields `'unknown'` plus a
   * warning — never a default. `50 Free SCY` and `50 Free LCM` are two separate
   * rows of this table and scoring one against the other's standard is exactly
   * the silently-wrong number the provenance rules exist to stop.
   */
  readonly course: SwimCloudCourseOrUnknown;
  /** Stroke, derived from {@link eventLabel}. `'unknown'` with a warning when the label names no stroke this parser recognizes. */
  readonly stroke: SwimCloudStroke;
  /** The meet this swim happened at, from the row's own links. Absent when the row carried neither link. */
  readonly swimCloudMeetId?: SwimCloudMeetId;
  /** The meet's name as printed on the row's `/results/{meetId}` link. */
  readonly meetName?: string;
  /** Absent when the time cell held anything other than a well-formed hundredths-precision time. */
  readonly time?: SwimCloudTimeString;
  /** The time cell's raw contents, kept whenever {@link time} could not be populated. */
  readonly rawTimeToken?: string;
  /**
   * The date **exactly as printed**, e.g. `'Mar 1, 2025'`. Never converted.
   *
   * This is the date of *this swim*, not of the meet: two rows of the real
   * capture name the same meet (338673) on `Mar 1, 2025` and `Feb 28, 2025`.
   * That makes it a different fact from the meet-scoped date range
   * {@link parseTeamMeetSwimsHtml} reads out of `<li id="meet-date">`, so it is
   * deliberately **not** passed through that reader — whose `DATE_SINGLE`
   * pattern would happily match this text and whose failure warning
   * (`unrecognized-meet-date`) would then describe a meet date this row never
   * printed. Kept verbatim rather than half-parsed into a `Date`, same rule as
   * {@link SwimCloudPersonalBest.date}.
   */
  readonly date?: string;
  /** Every chip printed on the row, in printed order. Empty on most rows — the column is optional per row, never assumed present. */
  readonly tags: readonly SwimCloudSwimmerTimesTag[];
  /**
   * SwimCloud's `season_id` for this swim, verbatim. Only the JSON endpoint
   * states it ({@link parseSwimmerFastestTimesJson}); the HTML table does not.
   */
  readonly seasonId?: string;
  /**
   * A diving row's judged score, e.g. `'318.05'`. Diving only, and never in
   * {@link time}: a score is higher-is-better and must not rank as a time.
   * Set by {@link parseSwimmerFastestTimesJson}; absent on every swim row.
   */
  readonly divingScore?: string;
  /**
   * True when a chip's tooltip reads `Leadoff`.
   *
   * Matched on `title="Leadoff"` and never on the visible `R`, exactly as
   * {@link readFlagsCell} does for a swims list. See
   * {@link SwimCloudResultFlags.relayLeadoff}: a leadoff split is not an
   * individual swim and must not be entered or scored as one, even though this
   * table lists it among the swimmer's bests.
   */
  readonly relayLeadoff: boolean;
  /**
   * `true` only when the fastest-times JSON row states `exhibition: true`
   * (strict: the JSON boolean `true`, nothing truthy). The swim was swum at a
   * meet but did not score there.
   *
   * **Absent for `exhibition: false` and for a row that omits the field.** The
   * HTML table has no such column, so an HTML-parsed row never carries it:
   * absent means "not known to be exhibition", never "known official". Set by
   * {@link parseSwimmerFastestTimesJson} on non-diving rows only.
   */
  readonly isExhibition?: true;
}

/** Which source answered for a {@link SwimCloudSwimmerTimesParse} field. */
export type SwimCloudSwimmerTimesFieldSource =
  /** The page's own `#swimmer-info` JSON block. */
  | 'swimmer-info-json'
  /** The capture URL. */
  | 'capture-url'
  /** {@link SwimCloudSwimmerTimesParseOptions}. */
  | 'caller-supplied';

export interface SwimCloudSwimmerTimesParseOptions {
  /**
   * Swimmer id, for a capture whose URL cannot be classified (a Wayback
   * snapshot, say) and whose `#swimmer-info` block was stripped.
   *
   * **Outranks both**, same rule as {@link SwimCloudTeamMeetSwimsParseOptions.gender}:
   * a caller asserting a fact outranks a parser reading one. A disagreement is
   * reported as `contradicted-page-declaration` rather than resolved silently.
   */
  readonly swimmerId?: SwimCloudSwimmerId;
}

/** What {@link parseSwimmerTimesHtml} extracts. */
export interface SwimCloudSwimmerTimesParse {
  readonly swimCloudSwimmerId: SwimCloudSwimmerId;
  /** Which of the three sources {@link swimCloudSwimmerId} came from. */
  readonly swimmerIdSource: SwimCloudSwimmerTimesFieldSource;
  /**
   * The swimmer's name **verbatim from `#swimmer-info`**, which prints it
   * family name first: `'Paulk, River J'`.
   *
   * See {@link parseSwimmerTimesHtml}'s "One name, one source" note for why
   * this order and not the `/swimmer/{id}/` page's `'River Paulk'`. Absent when
   * the JSON block was missing or unreadable — never reconstructed from the
   * page title, which prints the other order.
   */
  readonly name?: string;
  /**
   * Personal-best rows, in page order.
   *
   * An **empty array is a real, valid answer** — a swimmer with no recorded
   * times yet — and always arrives with a `zero-data-rows` warning. A missing
   * table is `ok: false` instead. Absent ≠ empty, as everywhere in this file.
   */
  readonly personalBests: readonly SwimCloudPersonalBestSwim[];
  /** Data rows seen, including any that failed to parse. */
  readonly rowCount: number;
}

/**
 * Parse a SwimCloud swimmer's times page (`/swimmer/{id}/times/`).
 *
 * **Real-capture-verified** as of 2026-09-09 — see the file header. Written
 * against a page SwimCloud actually served, archived as
 * `tests/fixtures/swimcloud-real-swimmer-times-1472365.html` (River Paulk,
 * Auburn; 29 real rows, trimmed to 9 in the fixture). That capture resolved
 * OQ-4.
 *
 * ## The real page shape
 *
 * One server-rendered `<table>` inside `#swimmer-profile-times`, under a
 * `PERSONAL BESTS` tab that is the default view — no click, no AJAX, no
 * tab-opening precondition. Columns are event, time, an **unlabelled** badge
 * column, meet, date. One row per course-qualified event.
 *
 * ## The sibling tab is not parsed and its shape is unknown
 *
 * `EVENT PROGRESSION` sits next to `PERSONAL BESTS` in the same card. Nothing
 * has captured it, it is rendered separately, and this function neither reads
 * it nor assumes anything about it. A capture taken with that tab active may
 * well not contain the table this function needs — in which case it reports
 * `expected-header-missing` rather than inventing an empty list.
 *
 * ## One name, one source
 *
 * Two pages print this swimmer's name in two different orders: the
 * `#swimmer-info` JSON here gives `Paulk, River J` (family name first), and
 * `/swimmer/{id}/`'s own `<h1>` gives `River Paulk`. **The JSON wins**, for
 * three reasons: it is on the page this function parses (the `<h1>` is not);
 * it is structured data with a labelled field rather than a display string;
 * and reading the `<h1>` order would mean deciding by heuristic which token is
 * the family name, which is precisely the guess that produces a wrong name.
 * No third normalized form is invented — `'River Paulk'` is not reconstructed
 * from `'Paulk, River J'`, because splitting a comma-separated name into given
 * and family parts is a guess for any swimmer with a two-word family name, and
 * this repo has no reason to make it. A caller that wants display order should
 * capture `/swimmer/{id}/` and read the heading there.
 *
 * ## What is deliberately not in the output
 *
 * - **`#swimmer-profile-times`'s `data-season-ids`.** The real capture carries
 *   `[30, 29, …, 18]`, matching the roster page's own season `<select>`. That
 *   is *consistent with* a site-wide season-id space and does not *prove* one,
 *   and no URL this package emits carries a `season_id` anyway (see
 *   `./crawlPlan.ts`'s header). Recording the list would invite treating it as
 *   proof.
 * - **The rest of `#swimmer-info`.** The block also holds `gender`, `city`,
 *   `state`, `gradhs`, `gradcollege`, `team_ids` and `photo`. None is read.
 *   `gender: "M"` in particular is a one-letter code from a single sample, and
 *   `SwimCloudTeamRosterQuery` records why this package refuses to decide an
 *   encoding from one of those. The fields are named here so a future need has
 *   a documented starting point rather than a rediscovery.
 * - **A `SwimCloudEvent` per row.** That type requires a gender, and this page
 *   states none for an event — the swimmer's own gender is not the event's.
 *   Distance, course and stroke are surfaced as flat derived fields instead.
 *
 * ## The derived fields are derived
 *
 * `distance`, `course` and `stroke` are **parsed out of the printed event
 * label**, not read from fields the page publishes. A label whose shape this
 * parser has not seen (`{distance} {stroke} {COURSE}`) raises
 * `unrecognized-event-label` and leaves those fields absent or `'unknown'`; it
 * never crashes, and it never falls back to yards.
 */
export function parseSwimmerTimesHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudSwimmerTimesParseOptions = {},
): SwimCloudParseResult<SwimCloudSwimmerTimesParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = swimmerIdFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a swimmer.`,
      warnings,
      confidence,
    );
  }

  const info = readSwimmerInfoJson(html, warnings);
  const resolved = resolveSwimmerId(options.swimmerId, info?.swimmerId, fromUrl.swimmerId, warnings);
  if (resolved === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No swimmer id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a swimmer page, the page carries no readable #swimmer-info block, and no swimmerId option was supplied.`,
      warnings,
      confidence,
    );
  }

  // One strip up front, as `parseTeamMeetSwimsHtml` does: every table lookup
  // below reads this, so a fixture's own explanatory comments — which quote real
  // markup, `title="Leadoff"` included — can never be read as page content.
  const cleaned = stripNonContent(html);

  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a swimmer times page is expected to contain the Personal Bests table.',
      warnings,
      confidence,
    );
  }

  const located = locateSwimmerTimesTable(tables);
  if (located === null) {
    return fail(
      context,
      'expected-header-missing',
      `None of the ${tables.length} table(s) carries all four of an event column (${EVENT_LABEL_HEADERS.join(', ')}), a time column (${TIME_HEADERS.join(', ')}), a meet column (${MEET_HEADERS.join(', ')}) and a date column (${DATE_HEADERS.join(', ')}), which is what identifies the Personal Bests table. A swimmer's home page carries a narrower "Latest Results" table (event, time, improvement, place) that is deliberately rejected here rather than parsed as if it were this one.`,
      warnings,
      confidence,
    );
  }

  const personalBests = readSwimmerTimesRows(located, warnings);

  if (located.dataRows.length === 0) {
    warnings.push({
      code: 'zero-data-rows',
      message:
        'The Personal Bests table was found and holds no data rows. This is a real "this swimmer has no recorded times" answer, not a missing table.',
    });
  } else if (personalBests.length === 0) {
    return fail(
      context,
      'no-rows-parsed',
      `The Personal Bests table held ${located.dataRows.length} data row(s) and none could be parsed.`,
      warnings,
      confidence,
    );
  }

  return succeed(
    context,
    {
      swimCloudSwimmerId: resolved.swimmerId,
      swimmerIdSource: resolved.source,
      ...(info?.name === undefined ? {} : { name: info.name }),
      personalBests,
      rowCount: located.dataRows.length,
    },
    warnings,
    confidence,
  );
}

/**
 * The swimmer id the capture URL names.
 *
 * Both swimmer-subject kinds are accepted. `swimmerTimes` is the page this
 * parser is for; the bare `swimmer` kind is accepted too so a capture whose
 * recorded URL is the profile root still reaches the table check, where the
 * failure message can say *which* table shape was found instead of rejecting on
 * a URL technicality. A URL naming any other resource is a real mismatch.
 */
function swimmerIdFromSourceUrl(sourceUrl: string): {
  swimmerId?: SwimCloudSwimmerId;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'swimmerTimes' || resource.kind === 'swimmer') {
    return { swimmerId: resource.swimmerId };
  }
  return { mismatch: resource.kind };
}

/**
 * Pick the swimmer id, in precedence order, and say out loud when two sources
 * disagree.
 *
 * Caller > page JSON > capture URL. The JSON outranks the URL because it is
 * inside the document SwimCloud served: a mis-recorded capture URL — a redirect
 * followed, the wrong tab's address pasted — cannot rename the subject, while
 * a wrong URL silently would.
 */
function resolveSwimmerId(
  fromOptions: SwimCloudSwimmerId | undefined,
  fromJson: SwimCloudSwimmerId | undefined,
  fromUrl: SwimCloudSwimmerId | undefined,
  warnings: SwimCloudParseWarning[],
): { swimmerId: SwimCloudSwimmerId; source: SwimCloudSwimmerTimesFieldSource } | undefined {
  if (fromJson !== undefined && fromUrl !== undefined && fromJson !== fromUrl) {
    warnings.push({
      code: 'contradicted-page-declaration',
      message: `The page's #swimmer-info block names swimmer ${fromJson} but the capture URL names swimmer ${fromUrl}. The page's own block wins; the disagreement is reported rather than resolved silently.`,
      raw: `swimmer-info=${fromJson} capture-url=${fromUrl}`,
    });
  }
  const fromPage = fromJson ?? fromUrl;
  if (fromOptions !== undefined) {
    if (fromPage !== undefined && fromPage !== fromOptions) {
      warnings.push({
        code: 'contradicted-page-declaration',
        message: `The caller supplied swimmer ${fromOptions} but the capture states swimmer ${fromPage}. The caller's assertion wins; the disagreement is reported rather than resolved silently.`,
        raw: `caller=${fromOptions} page=${fromPage}`,
      });
    }
    return { swimmerId: fromOptions, source: 'caller-supplied' };
  }
  if (fromJson !== undefined) {
    return { swimmerId: fromJson, source: 'swimmer-info-json' };
  }
  if (fromUrl !== undefined) {
    return { swimmerId: fromUrl, source: 'capture-url' };
  }
  return undefined;
}

/**
 * Comments only.
 *
 * {@link stripNonContent} would take `<script>` blocks with them, and the block
 * this parser wants *is* a script. Comments still go, so a fixture's own header
 * comment cannot be read as page data.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** What the page's `#swimmer-info` block states about its own subject. */
interface SwimmerInfo {
  readonly swimmerId?: SwimCloudSwimmerId;
  readonly name?: string;
}

/** A SwimCloud numeric id, as a string. Same shape the URL classifier requires. */
const EMBEDDED_NUMERIC_ID = /^[1-9][0-9]{0,17}$/;

/**
 * Read `<script id="swimmer-info" type="application/json">` — the page's own
 * structured statement of who it is about.
 *
 * Never throws. A missing block, unparseable JSON, or a field of an unexpected
 * type each produce an `unreadable-embedded-json` warning and an absent value,
 * so the caller falls back to the capture URL rather than to a guess.
 */
function readSwimmerInfoJson(html: string, warnings: SwimCloudParseWarning[]): SwimmerInfo | undefined {
  const commentless = html.replace(HTML_COMMENT, ' ');
  for (const span of findElementSpans(commentless, 'script')) {
    if (readAttribute(startTagOf(span.html), 'id') !== 'swimmer-info') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(span.inner) as unknown;
    } catch {
      warnings.push({
        code: 'unreadable-embedded-json',
        message:
          'The page\'s #swimmer-info block is not valid JSON. The swimmer id and name were not read from it.',
        raw: collapseWhitespace(span.inner).slice(0, 200),
      });
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      warnings.push({
        code: 'unreadable-embedded-json',
        message: 'The page\'s #swimmer-info block parsed to something other than a JSON object.',
        raw: collapseWhitespace(span.inner).slice(0, 200),
      });
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const rawId = record['id'];
    // Accepted as a number (what the real capture prints) or as an all-digit
    // string. Anything else is reported, never coerced — `Number(x)` on a
    // surprising value is how a wrong id gets a plausible look.
    const id =
      typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0
        ? String(rawId)
        : typeof rawId === 'string' && EMBEDDED_NUMERIC_ID.test(rawId.trim())
          ? rawId.trim()
          : undefined;
    if (rawId !== undefined && id === undefined) {
      warnings.push({
        code: 'unreadable-embedded-json',
        message: `The page's #swimmer-info block holds an "id" of ${JSON.stringify(rawId)}, which is not a positive integer id; no swimmer id was read from it.`,
        raw: String(rawId),
      });
    }
    const rawName = record['name'];
    const name =
      typeof rawName === 'string' && collapseWhitespace(rawName).length > 0
        ? collapseWhitespace(rawName)
        : undefined;
    return {
      ...(id === undefined ? {} : { swimmerId: id }),
      ...(name === undefined ? {} : { name }),
    };
  }
  return undefined;
}

/** The Personal Bests table, located and split into its columns and data rows. */
interface LocatedSwimmerTimesTable {
  readonly event: number;
  readonly time: number;
  readonly meet: number;
  readonly date: number;
  /**
   * Columns no header label claimed — where the badge chips live.
   *
   * The real page's badge column has an **empty** `<th>`, so it cannot be found
   * by printed label the way every other column in this file is. It is found by
   * elimination instead of by a hardcoded index, so a page that adds a column
   * before it does not shift the chips into the wrong cell.
   */
  readonly tagColumns: readonly number[];
  readonly dataRows: readonly string[][];
}

/**
 * The first table carrying all four of Event, Time, Meet and Date.
 *
 * All four are required on purpose. The swimmer **home** page ships a narrower
 * "Latest Results" table — event, time, improvement, place, for one selected
 * meet — that would satisfy a looser Event+Time test and is a different fact
 * entirely (one meet's swims, not career bests). Requiring the Meet and Date
 * columns makes this parser refuse that table loudly instead of returning
 * plausible rows from the wrong shape.
 */
function locateSwimmerTimesTable(
  tables: readonly HtmlElementSpan[],
): LocatedSwimmerTimesTable | null {
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
    const event = findColumn(headers, EVENT_LABEL_HEADERS);
    const time = findColumn(headers, TIME_HEADERS);
    const meet = findColumn(headers, MEET_HEADERS);
    const date = findColumn(headers, DATE_HEADERS);
    if (event < 0 || time < 0 || meet < 0 || date < 0) {
      continue;
    }
    const claimed = new Set([event, time, meet, date]);
    const tagColumns: number[] = [];
    for (let index = 0; index < headers.length; index += 1) {
      if (!claimed.has(index)) {
        tagColumns.push(index);
      }
    }
    return {
      event,
      time,
      meet,
      date,
      tagColumns,
      dataRows: rows
        .slice(headerIndex + 1)
        .filter((row) => !isHeaderRow(row))
        .map((row) => extractRowCells(row)),
    };
  }
  return null;
}

/**
 * A Personal Bests event cell: `{distance} {stroke} {COURSE}`.
 *
 * `50 Free SCY`, `1000 Free SCY`, `200 IM LCM`. The course is the **trailing**
 * token — a different shape from the swims list's `{distance} {letter}
 * {stroke}` (`50 Y Free`), which is why {@link SWIMS_EVENT_LABEL} is not reused
 * here and neither pattern is generalized to cover both.
 */
const SWIMMER_TIMES_EVENT_LABEL = /^(\d{1,4})\s+(.+?)\s+([A-Za-z]{3})$/;

/**
 * The three-letter course codes this table prints.
 *
 * `SCY` and `LCM` are confirmed by the real capture — both appear, on separate
 * rows for the same stroke and distance. `SCM` is accepted on the same two
 * grounds {@link COURSE_LETTERS} records: it is the third member of
 * {@link SwimCloudCourse}, and it is the sport's universal abbreviation. Any
 * other trailing token is `'unknown'` with a warning and is never defaulted to
 * yards.
 */
const SWIMMER_TIMES_COURSE_TOKENS: Readonly<Record<string, SwimCloudCourse>> = {
  scy: 'SCY',
  lcm: 'LCM',
  scm: 'SCM',
};

interface ParsedSwimmerTimesEventLabel {
  readonly distance?: number;
  readonly course: SwimCloudCourseOrUnknown;
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
  /** The trailing course token as printed, when the label matched the expected shape. */
  readonly courseToken?: string;
  /** False when the label did not match `{distance} {stroke} {COURSE}` at all. */
  readonly matchedShape: boolean;
}

/**
 * Read distance, course and stroke out of a Personal Bests event label.
 *
 * Pure — it raises nothing and warns nothing, so the caller can build the event
 * id first and then attribute any warning to it. Same division of labour as
 * {@link readSwimsEventLabel}.
 */
function readSwimmerTimesEventLabel(label: string): ParsedSwimmerTimesEventLabel {
  const trimmed = label.trim();
  const lower = trimmed.toLowerCase();
  const isRelay = /\brelay\b/.test(lower);
  const match = SWIMMER_TIMES_EVENT_LABEL.exec(trimmed);

  if (match === null) {
    // Keep whatever can still be read honestly, and let the caller say out loud
    // that the shape was not the expected one.
    const loose = /\b(\d{1,4})\b/.exec(trimmed);
    return {
      ...(loose === null ? {} : { distance: Number.parseInt(regexGroup(loose, 1), 10) }),
      course: 'unknown',
      stroke: mapStroke(lower, isRelay),
      isRelay,
      matchedShape: false,
    };
  }

  const courseToken = regexGroup(match, 3);
  return {
    distance: Number.parseInt(regexGroup(match, 1), 10),
    course: SWIMMER_TIMES_COURSE_TOKENS[courseToken.toLowerCase()] ?? 'unknown',
    // Only the stroke portion, so a course token can never be mistaken for a
    // stroke word by a future addition to `mapStroke`'s vocabulary.
    stroke: mapStroke(regexGroup(match, 2).toLowerCase(), isRelay),
    isRelay,
    courseToken,
    matchedShape: true,
  };
}

/** What a Personal Bests row's time link states: the meet, the event, the swim. */
interface SwimmerTimesRowLink {
  readonly meetId: SwimCloudMeetId;
  readonly eventRef: string;
  readonly swimId?: string;
}

/**
 * Read meet, event and swim ids out of a row's time link
 * (`/results/{meetId}/event/{n}/?id={swimId}#time{swimId}`).
 *
 * Unlike {@link readSwimLink}, this cannot filter by an expected meet id: a
 * bests table spans a whole career, so every row names a different meet and the
 * link is the only place the row states which.
 */
function readSwimmerTimesRowLink(cellHtml: string): SwimmerTimesRowLink | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetEvent') {
      continue;
    }
    const id = readQueryParam(href, 'id');
    return {
      meetId: classification.resource.meetId,
      eventRef: classification.resource.eventRef,
      ...(id !== undefined && /^\d+$/.test(id) ? { swimId: id } : {}),
    };
  }
  return undefined;
}

/** The meet id a row's meet-name link carries. */
function meetIdFromCell(cellHtml: string): SwimCloudMeetId | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome === 'fetchable' && classification.resource.kind === 'meet') {
      return classification.resource.meetId;
    }
  }
  return undefined;
}

/** What the badge column(s) of one row carry. */
interface SwimmerTimesTagCells {
  readonly tags: SwimCloudSwimmerTimesTag[];
  readonly relayLeadoff: boolean;
}

/**
 * Read a row's chips.
 *
 * Every `c-label` span is captured, whatever its modifier class — the real page
 * prints `c-label--energized` for `NCAA B` and `c-label--neutral` for `X` and
 * `R`, so filtering on one modifier (as {@link readFlagsCell} does for a swims
 * list's `c-label--royal` cut badges) would silently drop most of them.
 *
 * `relayLeadoff` is matched on `title="Leadoff"` and nothing else, never on the
 * visible `R` — same rule and same reason as {@link readFlagsCell}.
 */
function readSwimmerTimesTagCells(cellHtmls: readonly string[]): SwimmerTimesTagCells {
  const tags: SwimCloudSwimmerTimesTag[] = [];
  let relayLeadoff = false;

  for (const cellHtml of cellHtmls) {
    for (const span of findElementSpans(cellHtml, 'span')) {
      const startTag = startTagOf(span.html);
      if (!classTokens(startTag).includes('c-label')) {
        continue;
      }
      const title = readAttribute(startTag, 'title');
      if (title !== undefined && title.trim().toLowerCase() === 'leadoff') {
        relayLeadoff = true;
      }
      const code = htmlToText(span.inner);
      if (code.length > 0) {
        tags.push({ code, ...(title === undefined ? {} : { title }) });
      }
    }
  }

  return { tags, relayLeadoff };
}

/**
 * `readTime` takes a {@link SwimCloudEvent} to read its `stroke` (the
 * diving-score-is-not-a-time branch) and its `eventId` (to scope warnings).
 *
 * This builds the minimal stand-in it needs, carrying the row's **real** event
 * id so a warning points at the event the page named rather than at a
 * capture-local placeholder. It is deliberately not returned to callers: a
 * `SwimCloudEvent` must state a gender, and this page states none for an event.
 */
function swimmerTimesRowEvent(
  eventId: string,
  meetId: SwimCloudMeetId | undefined,
  label: string,
  parsed: ParsedSwimmerTimesEventLabel,
): SwimCloudEvent {
  return {
    eventId,
    swimCloudMeetId: meetId ?? ('swimmer-times' as SwimCloudMeetId),
    label,
    kind: parsed.isRelay ? 'relay' : 'individual',
    course: parsed.course,
    gender: 'unknown',
    ...(parsed.distance === undefined ? {} : { distance: parsed.distance }),
    stroke: parsed.stroke,
  };
}

/**
 * Every non-time warning a personal-best row can raise: the meet-id
 * disagreement between the time link and the meet-name link, the event
 * label's shape/course/stroke, and a missing swim link. Extracted from
 * {@link readSwimmerTimesRows} so that function's own branching stays under
 * the complexity ceiling; behaviour, codes and messages are unchanged.
 */
function pushSwimmerTimesRowWarnings(
  eventLabel: string,
  parsed: ParsedSwimmerTimesEventLabel,
  link: SwimmerTimesRowLink | undefined,
  meetLinkId: SwimCloudMeetId | undefined,
  eventId: string,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): void {
  if (link !== undefined && meetLinkId !== undefined && link.meetId !== meetLinkId) {
    warnings.push({
      code: 'contradicted-page-declaration',
      message: `Row for ${JSON.stringify(eventLabel)} links its time to meet ${link.meetId} and its meet name to meet ${meetLinkId}. The time link wins, because it is the link that also names the event and the swim; the disagreement is reported rather than resolved silently.`,
      eventId,
      rowIndex,
      raw: `time-link=${link.meetId} meet-link=${meetLinkId}`,
    });
  }

  if (!parsed.matchedShape) {
    warnings.push({
      code: 'unrecognized-event-label',
      message: `Event cell ${JSON.stringify(eventLabel)} does not match the expected "{distance} {stroke} {COURSE}" shape; course was not read from it and is recorded as unknown.`,
      eventId,
      rowIndex,
      raw: eventLabel,
    });
  } else if (parsed.course === 'unknown') {
    warnings.push({
      code: 'unrecognized-course-token',
      message: `Course token ${JSON.stringify(parsed.courseToken ?? '')} in ${JSON.stringify(eventLabel)} is outside SCY/SCM/LCM; course recorded as unknown rather than assumed.`,
      eventId,
      rowIndex,
      raw: eventLabel,
    });
  }

  if (parsed.stroke === 'unknown') {
    warnings.push({
      code: 'unmapped-stroke',
      message: `Stroke could not be identified in ${JSON.stringify(eventLabel)}; recorded as unknown.`,
      eventId,
      rowIndex,
      raw: eventLabel,
    });
  }

  if (link === undefined) {
    warnings.push({
      code: 'missing-swim-link',
      message: `Time cell for ${JSON.stringify(eventLabel)} carries no /results/{meetId}/event/{n}/ link; the swim has no SwimCloud swim id, meet id or event reference, and a composite key derived from the row's own values is used instead.`,
      eventId,
      rowIndex,
    });
  } else if (link.swimId === undefined) {
    warnings.push({
      code: 'missing-swim-link',
      message: `Time cell for ${JSON.stringify(eventLabel)} links to event ${link.eventRef} of meet ${link.meetId} but carries no "?id=" swim id; a composite key derived from the row's own values is used instead.`,
      eventId,
      rowIndex,
    });
  }
}

/**
 * Build one {@link SwimCloudPersonalBestSwim} from an already-parsed row.
 * Extracted from {@link readSwimmerTimesRows} so the omitted-when-absent
 * spreads (one ternary per optional field) don't count against that
 * function's complexity; the fields and their absence rules are unchanged.
 */
function buildSwimmerTimesPersonalBest(
  cells: readonly string[],
  table: LocatedSwimmerTimesTable,
  eventId: string,
  meetId: SwimCloudMeetId | undefined,
  eventLabel: string,
  parsed: ParsedSwimmerTimesEventLabel,
  link: SwimmerTimesRowLink | undefined,
  time: ReturnType<typeof readTime>,
  meetCellHtml: string,
  rowIndex: number,
): SwimCloudPersonalBestSwim {
  const swimKey =
    link?.swimId === undefined
      ? `${eventId}:swim:${time.finalTime ?? time.rawTimeToken ?? `row${rowIndex}`}`
      : `${link.meetId}:swim:${link.swimId}`;

  const meetName = htmlToText(meetCellHtml);
  const date = textAt(cells, table.date);
  const chips = readSwimmerTimesTagCells(table.tagColumns.map((column) => cellAt(cells, column)));

  return {
    swimKey,
    ...(link?.swimId === undefined ? {} : { swimCloudSwimId: link.swimId }),
    eventId,
    ...(link === undefined ? {} : { eventRef: link.eventRef }),
    eventLabel,
    ...(parsed.distance === undefined ? {} : { distance: parsed.distance }),
    course: parsed.course,
    stroke: parsed.stroke,
    ...(meetId === undefined ? {} : { swimCloudMeetId: meetId }),
    ...(meetName.length === 0 ? {} : { meetName }),
    ...(time.finalTime === undefined ? {} : { time: time.finalTime }),
    ...(time.rawTimeToken === undefined ? {} : { rawTimeToken: time.rawTimeToken }),
    ...(date.length === 0 ? {} : { date }),
    tags: chips.tags,
    relayLeadoff: chips.relayLeadoff,
  };
}

function readSwimmerTimesRows(
  table: LocatedSwimmerTimesTable,
  warnings: SwimCloudParseWarning[],
): SwimCloudPersonalBestSwim[] {
  const personalBests: SwimCloudPersonalBestSwim[] = [];

  table.dataRows.forEach((cells, rowIndex) => {
    const eventLabel = textAt(cells, table.event);
    if (eventLabel.length === 0) {
      warnings.push({
        code: 'unparsed-row',
        message: 'Personal-best row has an empty event cell and was skipped.',
        rowIndex,
      });
      return;
    }

    const timeCellHtml = cellAt(cells, table.time);
    const link = readSwimmerTimesRowLink(timeCellHtml);
    const meetCellHtml = cellAt(cells, table.meet);
    const meetLinkId = meetIdFromCell(meetCellHtml);
    const parsed = readSwimmerTimesEventLabel(eventLabel);

    // The time link is authoritative for ids: it is the one that also names the
    // event and the swim, so taking the meet from anywhere else could attach a
    // swim id to a meet it does not belong to.
    const meetId = link?.meetId ?? meetLinkId;

    const eventId =
      link === undefined
        ? `swimmer-times:event-label:${normalizeHeader(eventLabel)}`
        : `${link.meetId}:event:${link.eventRef}`;

    pushSwimmerTimesRowWarnings(eventLabel, parsed, link, meetLinkId, eventId, rowIndex, warnings);

    const time = readTime(
      htmlToText(timeCellHtml),
      swimmerTimesRowEvent(eventId, meetId, eventLabel, parsed),
      rowIndex,
      warnings,
    );

    personalBests.push(
      buildSwimmerTimesPersonalBest(cells, table, eventId, meetId, eventLabel, parsed, link, time, meetCellHtml, rowIndex),
    );
  });

  return personalBests;
}
