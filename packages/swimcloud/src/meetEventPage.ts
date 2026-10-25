/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-event results page parser (`/results/{meet}/event/{n}/`).
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  findElementSpans,
  findTables,
  htmlToText,
  stripNonContent,
} from './html';
import { regexGroup } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type {
  SwimCloudCourse,
  SwimCloudEvent,
  SwimCloudGender,
  SwimCloudGenderOrUnknown,
  SwimCloudMeet,
  SwimCloudMeetFormat,
  SwimCloudMeetId,
  SwimCloudRuleset,
  SwimCloudStroke,
} from './entities';
import { SWIMCLOUD_REAL_CAPTURE_CONFIDENCE, fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import {
  classTokens,
  elementTextById,
  firstHeadingText,
  startTagOf,
} from './parseElements';
import { mapGender, mapStroke } from './swimFields';
import { normalizeHeader } from './parseCells';
import { missingMeetNameWarning, readMeetDateRange, readPrintedCourse } from './meetPageFields';
import { readMeetEventIndex } from './meetEventIndex';
import type { SwimCloudMeetEventIndexEntry } from './meetEventIndex';
import { locateEventRoundTables, readEventRound } from './meetEventRounds';
import type { SwimCloudMeetEventRound } from './meetEventRounds';

/* ========================================================================== */
/* Per-event results page — the one page type that names the round             */
/* ========================================================================== */

/**
 * Caller-supplied facts a per-event results capture's markup may not state.
 *
 * Same discipline as {@link SwimCloudTeamMeetSwimsParseOptions}: every field is
 * an assertion the caller makes, never a default this parser reaches for.
 */
export interface SwimCloudMeetEventResultsParseOptions {
  /** Meet id, for a capture whose URL cannot be classified (a Wayback snapshot, say). */
  readonly meetId?: SwimCloudMeetId;
  /** SwimCloud's `/event/{n}/` reference, same reason. */
  readonly eventRef?: string;
  /**
   * The gender this event is for.
   *
   * Normally unnecessary — the page's own gender dropdown prints `Men` or
   * `Women` on its active item. **Never derived from the event id.** The real
   * capture's gender toggle on event 26 points at `event/100/` (Men) and
   * `event/400/` (Women), so event-id arithmetic would place this swim on the
   * wrong side of the meet. Supplied here it **overrides** the printed word, on
   * the same rule as everywhere else: a caller asserting a fact outranks a
   * parser reading one.
   */
  readonly gender?: SwimCloudGender;
  /** The meet's course, used only when the page does not print one in `<li id="meet-course">`. */
  readonly meetCourse?: SwimCloudCourse;
  /** Meet format. Omitted means `'unknown'` — never `'dual'`. */
  readonly meetFormat?: SwimCloudMeetFormat;
  /** Governing rulebook. Omitted means `'unknown'` — never `'NCAA'`. */
  readonly meetRuleset?: SwimCloudRuleset;
}

/** What {@link parseMeetEventResultsHtml} extracts. */
export interface SwimCloudMeetEventResultsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** SwimCloud's `/event/{n}/` reference this page is. A **results-page** id, not a round id — see {@link parseMeetEventResultsHtml}. */
  readonly eventRef: string;
  /** From `<h1 id="meet-name">`, falling back to the page's first heading. */
  readonly meetName?: string;
  readonly meet: SwimCloudMeet;
  /** The event, as this page names it. Its `eventId` matches the swims list's for the same `/event/{n}/` page. */
  readonly event: SwimCloudEvent;
  /** The printed event label from the page's own Event dropdown, e.g. `'100 Breast'`. Absent when the page carried no such dropdown. */
  readonly eventLabel?: string;
  /** From the printed word on the gender dropdown's active item — never from the event id. */
  readonly gender: SwimCloudGenderOrUnknown;
  /**
   * That same dropdown word, **verbatim** — `'Men'`, `'Women'`, `'Mixed'`.
   *
   * {@link gender} maps it, and the map has only two destinations plus
   * `'unknown'`. So a Mixed event and a page whose dropdown could not be read
   * both arrive as `'unknown'`, and a caller cannot tell "this event is
   * genuinely neither side of the meet" from "this page did not parse". They
   * deserve different words in front of a coach: the first is a fact about the
   * meet, the second is a fault.
   *
   * Absent when the page carried no gender dropdown at all.
   */
  readonly genderLabel?: string;
  /**
   * Every event of this meet, from the index the page prints for itself —
   * see {@link readMeetEventIndex}. This page is one of them.
   *
   * This is what makes an event-first crawl possible: one fetched event page
   * names all 57 events of the real meet, where collecting refs from all 42
   * per-team swims pages named only 51 and silently omitted every diving
   * event. Absent when the page carried no index, which is reported as
   * `event-index-absent` rather than returned as an empty list.
   */
  readonly eventIndex?: readonly SwimCloudMeetEventIndexEntry[];
  /** One per round table, in printed order (which is program order, not chronological order). */
  readonly rounds: readonly SwimCloudMeetEventRound[];
  /** Data rows seen across every round table, including any that failed to parse. */
  readonly rowCount: number;
}

/**
 * Parse `/results/{meetId}/event/{n}/` — the only SwimCloud page type that
 * names which **round** a swim was contested in.
 *
 * **Real-capture-verified**, against exactly one page: the 2026-09-10 capture
 * of `/results/356467/event/26/` ("100 Breast Men Finals"), archived as
 * `tests/fixtures/swimcloud-real-meet-event-356467-event26.html` with the
 * page-shape findings in its own header comment. Read that before trusting any
 * of this against a page shape it does not cover.
 *
 * ## Why this page exists in the pipeline
 *
 * The team swims list (`parseTeamMeetSwimsHtml`) has no round or session column
 * at all, so a swimmer who made finals appears twice with nothing to tell the
 * two rows apart — and each row's `Place` is that *round's* placement, not the
 * event's. `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` had to
 * exclude every such pair outright. This page resolves them: it holds every
 * round of one event as its own `<div class="o-table-group"><table>` block with
 * a `<caption>` naming the round, and its A/B Final tables carry the real meet
 * `Score`.
 *
 * ## What one page does and does not cover
 *
 * - **One `/event/{n}/` id is a results page, not a round and not a labelled
 *   event.** Three "100 Y Breast" swims by one swimmer on the real swims list
 *   split across `event/26/` and `event/100/`. This page holds two of them; the
 *   third is on a page with no "Finals" suffix, at an id above the meet's
 *   numbered program (1–42), which matches `packages/core`'s already-documented
 *   finding that HyTek numbers post-meet time-trial sessions above the program
 *   (`isOutsideScoredProgram` / `scoredEventNumberMax`). Fetching every unique
 *   event id a swims list references is what covers a meet; one page is not
 *   assumed to hold every swim of its printed event label.
 * - **No diving event has been captured.** `Score` on a diving page could
 *   plausibly be the judged score rather than meet points, and storing a judged
 *   300.15 as meet points would silently multiply a team's score. So a diving
 *   event's `Score` column is read, reported as `'diving-score-column-unverified'`,
 *   and **not** stored in `meetScore`. Nothing about a diving row's markup is
 *   invented here.
 * - **No DQ, scratch or single-round timed-final table has been seen on this
 *   page type.** A time cell holding `DQ`/`NS`/`SCR` goes through the same
 *   {@link readTime} path every other page uses; a table with no caption raises
 *   `'missing-round-caption'` and is never renamed to `'Finals'` on a guess.
 * - **Relays.** The captured page is an individual event. A relay event's page
 *   is unseen; a `title="Leadoff"` badge is still read if one appears, rather
 *   than assumed absent.
 */
/**
 * Build the per-event page's single {@link SwimCloudEvent} and push its
 * `unrecognized-event-label` / `missing-course-declaration` warnings.
 * Extracted from {@link parseMeetEventResultsHtml} purely to keep that
 * function's own complexity down; both warnings and every field's absence
 * rule are unchanged.
 */
function buildMeetEventResultsEvent(
  meetId: SwimCloudMeetId,
  eventRef: string,
  eventId: string,
  eventLabel: string | undefined,
  meetCourse: SwimCloudCourse | undefined,
  gender: SwimCloudGenderOrUnknown,
  warnings: SwimCloudParseWarning[],
): { readonly event: SwimCloudEvent; readonly parsedLabel: ReturnType<typeof readEventPageEventLabel> } {
  const parsedLabel = readEventPageEventLabel(eventLabel ?? '');
  const event: SwimCloudEvent = {
    eventId,
    swimCloudMeetId: meetId,
    eventRef,
    label: eventLabel ?? '',
    kind: parsedLabel.isRelay ? 'relay' : 'individual',
    course: meetCourse ?? 'unknown',
    gender,
    ...(parsedLabel.distance === undefined ? {} : { distance: parsedLabel.distance }),
    stroke: parsedLabel.stroke,
  };

  if (!parsedLabel.matchedShape) {
    warnings.push({
      code: 'unrecognized-event-label',
      message: `Event dropdown label ${JSON.stringify(eventLabel ?? '')} does not match the expected "{distance} {stroke}" shape this page type prints; distance was not read from it.`,
      eventId,
      raw: eventLabel ?? '',
    });
  }
  if (meetCourse === undefined) {
    // The event label on this page type carries no course letter — the course
    // is a page-level fact (`<li id="meet-course">SCY</li>`). With neither that
    // element nor a caller-supplied course, the course stays unknown; it is
    // never defaulted to yards.
    warnings.push({
      code: 'missing-course-declaration',
      message:
        'The page printed no <li id="meet-course"> and no meetCourse option was supplied; the event\'s course is recorded as "unknown" rather than assumed.',
      eventId,
    });
  }

  return { event, parsedLabel };
}

/**
 * Assemble the {@link SwimCloudMeetEventResultsParse} success payload from
 * its already-resolved parts. Split out of {@link parseMeetEventResultsHtml}
 * purely so the per-field "omit when absent" spreads don't count against
 * that function's complexity; every field and its absence rule is unchanged.
 */
function buildMeetEventResultsPayload(fields: {
  readonly meetId: SwimCloudMeetId;
  readonly eventRef: string;
  readonly meetName: string | undefined;
  readonly meet: SwimCloudMeet;
  readonly event: SwimCloudEvent;
  readonly eventLabel: string | undefined;
  readonly gender: SwimCloudGenderOrUnknown;
  readonly genderLabel: string | undefined;
  readonly eventIndex: readonly SwimCloudMeetEventIndexEntry[];
  readonly rounds: readonly SwimCloudMeetEventRound[];
  readonly rowCount: number;
}): SwimCloudMeetEventResultsParse {
  return {
    swimCloudMeetId: fields.meetId,
    eventRef: fields.eventRef,
    ...(fields.meetName === undefined ? {} : { meetName: fields.meetName }),
    meet: fields.meet,
    event: fields.event,
    ...(fields.eventLabel === undefined ? {} : { eventLabel: fields.eventLabel }),
    gender: fields.gender,
    ...(fields.genderLabel === undefined ? {} : { genderLabel: fields.genderLabel }),
    ...(fields.eventIndex.length === 0 ? {} : { eventIndex: fields.eventIndex }),
    rounds: fields.rounds,
    rowCount: fields.rowCount,
  };
}

export function parseMeetEventResultsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetEventResultsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetEventResultsParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = eventScopeFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a /results/{meetId}/event/{n}/ page.`,
      warnings,
      confidence,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  const eventRef = options.eventRef ?? fromUrl.eventRef;
  if (meetId === undefined || eventRef === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id and event reference could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a per-event results page and no meetId/eventRef options were supplied.`,
      warnings,
      confidence,
    );
  }

  // One strip up front, same rule as the swims-list parser: every non-table
  // lookup below reads this rather than the raw input, so the fixture's own
  // header comment — which quotes real markup, `title="Exhibition"` included —
  // can never be read as page content.
  const cleaned = stripNonContent(html);

  const tables = findTables(cleaned);
  if (tables.length === 0) {
    return fail(
      context,
      'expected-table-missing',
      'No <table> element was found; a per-event results page is expected to contain one per round.',
      warnings,
      confidence,
    );
  }

  const located = locateEventRoundTables(tables);
  if (located.length === 0) {
    return fail(
      context,
      'expected-header-missing',
      `None of the ${tables.length} table(s) on the page has both a "Name" and a "Time" column, which is what identifies a round's results table on a per-event results page.`,
      warnings,
      confidence,
    );
  }

  const gender = options.gender ?? readEventPageGender(cleaned);
  // Read separately from `gender`, and deliberately not derived from it: the
  // mapping is lossy in exactly the case that matters. See `genderLabel`.
  const genderLabel = readDropdownActiveText(cleaned, 'gender');
  const eventLabel = readDropdownActiveText(cleaned, 'event');
  const meetName = elementTextById(cleaned, 'meet-name') ?? firstHeadingText(cleaned);
  const meetCourse = readPrintedCourse(cleaned) ?? options.meetCourse;
  const dates = readMeetDateRange(cleaned, warnings);

  // Read from the RAW html, not from `cleaned`: the index lives outside the round
  // tables and nothing about it needs stripping. readMeetEventIndex strips
  // comments and scripts itself.
  const eventIndex = readMeetEventIndex(html, meetId);
  if (eventIndex.length === 0) {
    warnings.push({
      code: 'event-index-absent',
      message:
        'This per-event page prints no js-event-item event index, so it cannot enumerate the rest of the meet. All 51 stored pages of the real capture print one, so a page without it is an unseen page shape rather than a meet with no events.',
    });
  }

  const eventId = `${meetId}:event:${eventRef}`;
  const { event } = buildMeetEventResultsEvent(meetId, eventRef, eventId, eventLabel, meetCourse, gender, warnings);

  const rounds: SwimCloudMeetEventRound[] = [];
  let rowCount = 0;
  for (const table of located) {
    const round = readEventRound(table, { meetId, eventId, event, warnings });
    rounds.push(round);
    rowCount += round.rowCount;
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

  return succeed(
    context,
    buildMeetEventResultsPayload({
      meetId,
      eventRef,
      meetName,
      meet,
      event,
      eventLabel,
      gender,
      genderLabel,
      eventIndex,
      rounds,
      rowCount,
    }),
    warnings,
    confidence,
  );
}

/* ---- Per-event page: page-level facts --------------------------------------- */

function eventScopeFromSourceUrl(sourceUrl: string): {
  meetId?: SwimCloudMeetId;
  eventRef?: string;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'meetEvent') {
    return { meetId: resource.meetId, eventRef: resource.eventRef };
  }
  return { mismatch: resource.kind };
}

/**
 * The text of the active item in the dropdown menu introduced by a given
 * subheader (`Event`, `Gender`).
 *
 * A per-event page carries two dropdowns and **its gender items link to no
 * `?gender=` parameter at all** — on the real capture the Men/Women toggle for
 * one labelled event points at `/event/100/` and `/event/400/`. So
 * {@link readActiveGenderWord}, which requires a `?gender=`-bearing link to
 * identify a gender item, answers `'unknown'` here and cannot be reused.
 *
 * The menus are told apart by their own printed `dropdown-subheader` item
 * instead — the page labelling its own control, which is the same class of fact
 * a column header is. The **innermost** matching `<ul>` wins: the page nests
 * both menus inside one outer list, so an outer list contains every
 * subheader and would match all of them.
 */
function readDropdownActiveText(html: string, subheader: string): string | undefined {
  const wanted = normalizeHeader(subheader);
  let best: { inner: string; length: number } | undefined;

  for (const list of findElementSpans(html, 'ul')) {
    const items = findElementSpans(list.inner, 'li');
    const introduces = items.some(
      (item) =>
        classTokens(startTagOf(item.html)).includes('dropdown-subheader') &&
        normalizeHeader(htmlToText(item.inner)) === wanted,
    );
    if (!introduces) continue;
    if (best === undefined || list.inner.length < best.length) {
      best = { inner: list.inner, length: list.inner.length };
    }
  }

  if (best === undefined) {
    return undefined;
  }
  for (const item of findElementSpans(best.inner, 'li')) {
    const tokens = classTokens(startTagOf(item.html));
    if (!tokens.includes('active') || tokens.includes('dropdown-subheader')) continue;
    const text = htmlToText(item.inner);
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * The gender a per-event page is for, from the printed word on its Gender
 * dropdown's active item.
 *
 * **Never from the event id.** See
 * {@link SwimCloudMeetEventResultsParseOptions.gender}: the real capture's own
 * toggle proves that arithmetic wrong.
 */
function readEventPageGender(html: string): SwimCloudGenderOrUnknown {
  const text = readDropdownActiveText(html, 'gender');
  if (text === undefined) {
    return 'unknown';
  }
  const word = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(text);
  return mapGender(word === null ? undefined : word[1]);
}

/**
 * A per-event page's event label: `{distance} {stroke}`, e.g. `100 Breast`.
 *
 * **No course letter**, unlike the swims list's `100 Y Breast` — this page
 * prints the course once, page-level, as `<li id="meet-course">`. So
 * {@link readSwimsEventLabel} is deliberately not reused: its
 * `{distance} {letter} {stroke}` shape would fail on every label this page
 * prints and fire a warning on a page that is perfectly well-formed.
 */
const EVENT_PAGE_EVENT_LABEL = /^(\d{1,4})\s+(.+)$/;

interface ParsedEventPageLabel {
  readonly distance?: number;
  readonly stroke: SwimCloudStroke;
  readonly isRelay: boolean;
  /** False when the label did not match `{distance} {stroke}` at all. */
  readonly matchedShape: boolean;
}

function readEventPageEventLabel(label: string): ParsedEventPageLabel {
  const lower = label.toLowerCase();
  const isRelay = /\brelay\b/.test(lower);
  // A diving event is named by its board, not by a distance: "1M Diving",
  // "3M Diving", "Platform Diving". None of those is malformed and none has a
  // distance to read, so reporting unrecognized-event-label on them warned
  // about a perfectly well-formed label. Four of meet 356467 events are
  // diving, so that was four review-severity notes per import saying nothing.
  //
  // distance stays ABSENT rather than taking the board size. A 1M board is not
  // a 1-metre swim, and putting it in a distance field would make it sortable
  // and comparable against one.
  if (/\bdiving\b|\bdive\b|\bdives\b/.test(lower)) {
    return { stroke: mapStroke(lower, isRelay), isRelay, matchedShape: true };
  }

  const match = EVENT_PAGE_EVENT_LABEL.exec(label.trim());
  if (match === null) {
    return { stroke: mapStroke(lower, isRelay), isRelay, matchedShape: false };
  }
  return {
    distance: Number.parseInt(regexGroup(match, 1), 10),
    stroke: mapStroke(lower, isRelay),
    isRelay,
    matchedShape: true,
  };
}
