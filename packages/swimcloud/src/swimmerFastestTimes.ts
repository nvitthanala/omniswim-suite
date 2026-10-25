/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Swimmer fastest-times JSON parser (`/api/swimmers/{id}/profile_fastest_times/`).
// Split out of `parser.ts`, which still re-exports every name it exported before.

import { collapseWhitespace } from './html';
import { regexGroup } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type {
  SwimCloudCourse,
  SwimCloudMeetId,
  SwimCloudStroke,
  SwimCloudTimeString,
} from './entities';
import { SWIMCLOUD_REAL_CAPTURE_CONFIDENCE, fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import { normalizeHeader } from './parseCells';
import type { SwimCloudPersonalBestSwim, SwimCloudSwimmerTimesParse, SwimCloudSwimmerTimesTag } from './swimmerTimesPage';

/* -------------------------------------------------------------------------- */
/* Swimmer fastest times — `/api/swimmers/{id}/profile_fastest_times/` JSON    */
/* -------------------------------------------------------------------------- */

/**
 * SDIF stroke codes, as the endpoint prints them in `eventstroke`.
 *
 * Cross-checked against real data, not only the SDIF table: in
 * `tests/fixtures/profile_fastest_times-1330318.json`, stroke `2` 50 Y is the
 * 22.53 New South leadoff this repo already records as Avery Henke's 50 Back,
 * and stroke `5` appears only at 100/200/400 — the IM distances. A code outside
 * this table is reported and the row skipped, never mapped by guess.
 */
const FASTEST_TIMES_STROKES: Readonly<Record<string, { readonly stroke: SwimCloudStroke; readonly label: string }>> = {
  '1': { stroke: 'Freestyle', label: 'Free' },
  '2': { stroke: 'Backstroke', label: 'Back' },
  '3': { stroke: 'Breaststroke', label: 'Breast' },
  '4': { stroke: 'Butterfly', label: 'Fly' },
  '5': { stroke: 'Individual Medley', label: 'IM' },
};

/** SDIF course codes in `eventcourse`. Same printed suffixes the HTML table uses. */
const FASTEST_TIMES_COURSES: Readonly<Record<string, SwimCloudCourse>> = {
  Y: 'SCY',
  S: 'SCM',
  L: 'LCM',
};

/** `eventtime` is plain seconds with hundredths: `'20.99'`, `'1095.50'`. */
const FASTEST_TIMES_SECONDS = /^(\d{1,5})\.(\d{2})$/;

/**
 * `url` on a row: `/results/{meetId}/event/{n}/?id={swimId}#time{swimId}`.
 *
 * A "User Inputted" row (flag `U`) prints a non-numeric event ref (`1100M`)
 * and no `?id=`, only the `#time{swimId}` fragment. Seen live on 2026-09-22
 * (swimmer 2352628), so both forms are read.
 */
const FASTEST_TIMES_ROW_URL = /^\/results\/(\d+)\/event\/([^/?#]+)\/(?:\?id=(\d+))?(?:#time(\d+))?/;

/**
 * Stroke code `H` is diving, seen live on 2026-09-22 (swimmer 2508045):
 * distance 1 or 3 is the board in metres, and `eventtime` is the judged score.
 * The course codes on those rows (`B`, `6`) are not SDIF course codes and are
 * not interpreted.
 */
const FASTEST_TIMES_DIVING_STROKE = 'H';

/**
 * `'101.29'` → `'1:41.29'`, in integer arithmetic on the digits. Never through
 * a float, so no time is ever off by a hundredth. Undefined for any other shape.
 */
function fastestTimesSecondsToTime(raw: string): SwimCloudTimeString | undefined {
  const match = FASTEST_TIMES_SECONDS.exec(raw);
  if (match === null) return undefined;
  const whole = Number.parseInt(regexGroup(match, 1), 10);
  const hundredths = regexGroup(match, 2);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${hundredths}`;
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}.${hundredths}`;
  return `${seconds}.${hundredths}`;
}

function jsonString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readFastestTimesFlags(value: unknown): { tags: SwimCloudSwimmerTimesTag[]; relayLeadoff: boolean } {
  const tags: SwimCloudSwimmerTimesTag[] = [];
  let relayLeadoff = false;
  if (!Array.isArray(value)) return { tags, relayLeadoff };
  for (const flag of value) {
    if (typeof flag !== 'object' || flag === null) continue;
    const record = flag as Record<string, unknown>;
    const code = typeof record['label'] === 'string' ? record['label'].trim() : '';
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    if (code.length === 0) continue;
    tags.push({ code, ...(title.length === 0 ? {} : { title }) });
    // Same rule as the HTML table: the tooltip decides, never the visible `R`.
    if (title === 'Leadoff') relayLeadoff = true;
  }
  return { tags, relayLeadoff };
}

/**
 * Build one diving {@link SwimCloudPersonalBestSwim} from a
 * `profile_fastest_times` row whose stroke code is `H` (diving). Extracted
 * from {@link parseSwimmerFastestTimesJson}'s row loop so that loop's own
 * branching stays under the complexity ceiling; the shape, the
 * `diving-score-not-a-time` warning and every field's absence rule are
 * unchanged.
 *
 * Same treatment as the HTML path's `diving-score-not-a-time`: the row is
 * kept, the score is not a time, and the importer skips it as no-time.
 * `1 mtr Diving`, the label the meet data already uses (data/meets.json),
 * so a diver's bests and meet results name the event the same way.
 */
function buildFastestTimesDivingRow(
  row: Record<string, unknown>,
  rowIndex: number,
  distance: number,
  warnings: SwimCloudParseWarning[],
): SwimCloudPersonalBestSwim {
  const eventLabel = `${distance} mtr Diving`;
  const rawScore = jsonString(row['eventtime']) ?? '';
  warnings.push({
    code: 'diving-score-not-a-time',
    message: `${eventLabel} ${JSON.stringify(rawScore)} is a judged score, not a time; recorded as divingScore.`,
    rowIndex,
    raw: rawScore,
  });
  const urlMatch = FASTEST_TIMES_ROW_URL.exec(jsonString(row['url']) ?? '');
  const meetId = (urlMatch?.[1] ?? jsonString(row['meet_id'])) as SwimCloudMeetId | undefined;
  const swimId = urlMatch?.[3] ?? urlMatch?.[4];
  const eventId =
    meetId !== undefined && urlMatch?.[2] !== undefined
      ? `${meetId}:event:${urlMatch[2]}`
      : `swimmer-times:event-label:${normalizeHeader(eventLabel)}`;
  const seasonId = jsonString(row['season_id']);
  const meetName = typeof row['name'] === 'string' ? collapseWhitespace(row['name']) : '';
  const date = typeof row['dateofswim'] === 'string' ? row['dateofswim'].trim() : '';
  return {
    swimKey:
      swimId !== undefined && meetId !== undefined
        ? `${meetId}:swim:${swimId}`
        : `${eventId}:swim:${jsonString(row['id']) ?? `row${rowIndex}`}`,
    ...(swimId === undefined ? {} : { swimCloudSwimId: swimId }),
    eventId,
    ...(urlMatch?.[2] === undefined ? {} : { eventRef: urlMatch[2] }),
    eventLabel,
    distance,
    course: 'unknown',
    stroke: 'Diving',
    ...(meetId === undefined ? {} : { swimCloudMeetId: meetId }),
    ...(meetName.length === 0 ? {} : { meetName }),
    ...(rawScore.length === 0 ? {} : { rawTimeToken: rawScore }),
    ...(/^\d{1,4}\.\d{1,2}$/.test(rawScore) ? { divingScore: rawScore } : {}),
    ...(date.length === 0 ? {} : { date }),
    tags: readFastestTimesFlags(row['flags']).tags,
    ...(seasonId === undefined ? {} : { seasonId }),
    relayLeadoff: false,
  };
}

/**
 * Build one non-diving {@link SwimCloudPersonalBestSwim} from a
 * `profile_fastest_times` row whose stroke/course/distance codes all
 * resolved. Extracted from {@link parseSwimmerFastestTimesJson}'s row loop
 * for the same reason as {@link buildFastestTimesDivingRow}; the
 * `unrecognized-time-token` warning and every field's absence rule are
 * unchanged.
 */
/**
 * Push the `unrecognized-time-token` warning for a regular fastest-times row
 * whose time could not be read, if any. Split out of
 * {@link buildFastestTimesRegularRow} purely to keep that function's own
 * complexity down; the code, message and conditions are unchanged.
 */
function pushFastestTimesRegularRowWarning(
  time: SwimCloudTimeString | undefined,
  legal: boolean,
  rawTime: string,
  eventLabel: string,
  eventId: string,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): void {
  if (time !== undefined) return;
  warnings.push({
    code: 'unrecognized-time-token',
    message: legal
      ? `Time ${JSON.stringify(rawTime)} for ${eventLabel} is not plain seconds; no time recorded.`
      : `The ${eventLabel} swim is marked not legal; no time recorded.`,
    eventId,
    rowIndex,
    raw: rawTime,
  });
}

/**
 * Assemble the final {@link SwimCloudPersonalBestSwim} object for a regular
 * fastest-times row from its already-resolved fields. Split out of
 * {@link buildFastestTimesRegularRow} purely so the per-field "omit when
 * absent" spreads don't count against that function's complexity; every
 * field and its absence rule is unchanged.
 */
function assembleFastestTimesRegularRow(fields: {
  readonly swimKey: string;
  readonly swimId: string | undefined;
  readonly eventId: string;
  readonly eventRef: string | undefined;
  readonly eventLabel: string;
  readonly distance: number;
  readonly course: SwimCloudCourse;
  readonly stroke: SwimCloudStroke;
  readonly meetId: SwimCloudMeetId | undefined;
  readonly meetName: string;
  readonly time: SwimCloudTimeString | undefined;
  readonly rawTime: string;
  readonly date: string;
  readonly tags: readonly SwimCloudSwimmerTimesTag[];
  readonly seasonId: string | undefined;
  readonly relayLeadoff: boolean;
  readonly isExhibition: boolean;
}): SwimCloudPersonalBestSwim {
  return {
    swimKey: fields.swimKey,
    ...(fields.swimId === undefined ? {} : { swimCloudSwimId: fields.swimId }),
    eventId: fields.eventId,
    ...(fields.eventRef === undefined ? {} : { eventRef: fields.eventRef }),
    eventLabel: fields.eventLabel,
    distance: fields.distance,
    course: fields.course,
    stroke: fields.stroke,
    ...(fields.meetId === undefined ? {} : { swimCloudMeetId: fields.meetId }),
    ...(fields.meetName.length === 0 ? {} : { meetName: fields.meetName }),
    ...(fields.time === undefined ? {} : { time: fields.time }),
    ...(fields.time === undefined && fields.rawTime.length > 0 ? { rawTimeToken: fields.rawTime } : {}),
    ...(fields.date.length === 0 ? {} : { date: fields.date }),
    tags: fields.tags,
    ...(fields.seasonId === undefined ? {} : { seasonId: fields.seasonId }),
    relayLeadoff: fields.relayLeadoff,
    ...(fields.isExhibition ? { isExhibition: true as const } : {}),
  };
}

function buildFastestTimesRegularRow(
  row: Record<string, unknown>,
  rowIndex: number,
  strokeInfo: { readonly stroke: SwimCloudStroke; readonly label: string },
  course: SwimCloudCourse,
  distance: number,
  warnings: SwimCloudParseWarning[],
): SwimCloudPersonalBestSwim {
  const eventLabel = `${distance} ${strokeInfo.label} ${course}`;

  const urlMatch = FASTEST_TIMES_ROW_URL.exec(jsonString(row['url']) ?? '');
  const meetId = (urlMatch?.[1] ?? jsonString(row['meet_id'])) as SwimCloudMeetId | undefined;
  const eventRef = urlMatch?.[2];
  const swimId = urlMatch?.[3] ?? urlMatch?.[4];
  const eventId =
    meetId !== undefined && eventRef !== undefined
      ? `${meetId}:event:${eventRef}`
      : `swimmer-times:event-label:${normalizeHeader(eventLabel)}`;

  const rawTime = jsonString(row['eventtime']) ?? '';
  const legal = row['legal'] !== false;
  const time = legal ? fastestTimesSecondsToTime(rawTime) : undefined;
  pushFastestTimesRegularRowWarning(time, legal, rawTime, eventLabel, eventId, rowIndex, warnings);

  const swimKey =
    swimId !== undefined && meetId !== undefined
      ? `${meetId}:swim:${swimId}`
      : `${eventId}:swim:${jsonString(row['id']) ?? `row${rowIndex}`}`;
  const meetName = typeof row['name'] === 'string' ? collapseWhitespace(row['name']) : '';
  const date = typeof row['dateofswim'] === 'string' ? row['dateofswim'].trim() : '';
  const seasonId = jsonString(row['season_id']);
  const flags = readFastestTimesFlags(row['flags']);

  return assembleFastestTimesRegularRow({
    swimKey,
    swimId,
    eventId,
    eventRef,
    eventLabel,
    distance,
    course,
    stroke: strokeInfo.stroke,
    meetId,
    meetName,
    time,
    rawTime,
    date,
    tags: flags.tags,
    seasonId,
    relayLeadoff: flags.relayLeadoff,
    // Strict: only the JSON boolean `true`. `false`, a missing field or any
    // other value leaves it absent (never written false).
    isExhibition: row['exhibition'] === true,
  });
}

/**
 * Parse SwimCloud's `profile_fastest_times` JSON — the request the swimmer
 * times page makes to fill its Personal Bests table — into the same
 * {@link SwimCloudSwimmerTimesParse} {@link parseSwimmerTimesHtml} produces.
 *
 * **Real-capture-verified** against
 * `tests/fixtures/profile_fastest_times-1330318.json`, saved from a logged-in
 * browser on 2026-09-22.
 *
 * ## Same output, so the import path does not fork
 *
 * Event labels are rebuilt in the table's own `{distance} {stroke} {COURSE}`
 * form (`'50 Free SCY'`), so a swim imported through either path lands on the
 * same event string. The swim key uses the row URL's `?id=`, as the HTML parser
 * does, so the same swim reached from a meet's swims list keys the same.
 *
 * ## What differs from the HTML table
 *
 * - **No swimmer name.** The response names meets, not the swimmer. `name` is
 *   absent; the roster import supplies it through an id join.
 * - **Dates are ISO** (`'2026-02-18'`), verbatim from `dateofswim`.
 * - **`seasonId`** is recorded per swim.
 *
 * ## What is refused
 *
 * A row whose stroke or course code is outside the SDIF tables above, or whose
 * time is not plain seconds, keeps no time and raises a warning. A row marked
 * `legal: false` keeps no time either: a disqualified swim is not a best.
 */
export function parseSwimmerFastestTimesJson(
  body: string,
  context: SwimCloudParseContext,
): SwimCloudParseResult<SwimCloudSwimmerTimesParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(body).length === 0) {
    return fail(context, 'empty-input', 'The captured response is empty.', warnings, confidence);
  }

  const classification = classifySwimCloudUrl(context.sourceUrl);
  const swimmerId =
    classification.outcome === 'fetchable' && classification.resource.kind === 'swimmerFastestTimes'
      ? classification.resource.swimmerId
      : undefined;
  if (swimmerId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} is not a /api/swimmers/{id}/profile_fastest_times/ URL.`,
      warnings,
      confidence,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return fail(
      context,
      'unreadable-json',
      `The response for swimmer ${swimmerId} is not JSON. SwimCloud may have served a challenge or error page instead.`,
      warnings,
      confidence,
    );
  }
  if (!Array.isArray(parsed)) {
    return fail(
      context,
      'unreadable-json',
      `The response for swimmer ${swimmerId} is JSON but not an array of swims.`,
      warnings,
      confidence,
    );
  }

  const personalBests: SwimCloudPersonalBestSwim[] = [];
  parsed.forEach((item, rowIndex) => {
    if (typeof item !== 'object' || item === null) {
      warnings.push({ code: 'unparsed-row', message: 'A swim in the response is not an object; skipped.', rowIndex });
      return;
    }
    const row = item as Record<string, unknown>;

    const rowSwimmer = jsonString(row['swimmer_id']);
    if (rowSwimmer !== undefined && rowSwimmer !== swimmerId) {
      warnings.push({
        code: 'contradicted-page-declaration',
        message: `A swim in swimmer ${swimmerId}'s response names swimmer ${rowSwimmer}; skipped.`,
        rowIndex,
        raw: rowSwimmer,
      });
      return;
    }

    const strokeCode = jsonString(row['eventstroke']) ?? '';
    const courseCode = jsonString(row['eventcourse']) ?? '';
    const distanceText = jsonString(row['eventdistance']) ?? '';
    const distance = /^[1-9]\d{0,3}$/.test(distanceText) ? Number.parseInt(distanceText, 10) : undefined;
    if (strokeCode === FASTEST_TIMES_DIVING_STROKE && distance !== undefined) {
      personalBests.push(buildFastestTimesDivingRow(row, rowIndex, distance, warnings));
      return;
    }
    const strokeInfo = FASTEST_TIMES_STROKES[strokeCode];
    const course = FASTEST_TIMES_COURSES[courseCode];
    if (strokeInfo === undefined || course === undefined || distance === undefined) {
      warnings.push({
        code: 'unrecognized-event-label',
        message: `Swim with stroke ${JSON.stringify(strokeCode)}, distance ${JSON.stringify(distanceText)}, course ${JSON.stringify(courseCode)} is outside the known codes; skipped rather than guessed.`,
        rowIndex,
        raw: `${strokeCode}|${distanceText}|${courseCode}`,
      });
      return;
    }
    personalBests.push(
      buildFastestTimesRegularRow(row, rowIndex, strokeInfo, course, distance, warnings),
    );
  });

  if (parsed.length === 0) {
    warnings.push({ code: 'zero-data-rows', message: `Swimmer ${swimmerId} has no recorded times.` });
  }

  return succeed(
    context,
    {
      swimCloudSwimmerId: swimmerId,
      swimmerIdSource: 'capture-url',
      personalBests,
      rowCount: parsed.length,
    },
    warnings,
    confidence,
  );
}
