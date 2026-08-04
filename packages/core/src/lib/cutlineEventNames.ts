/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Event-label normalization for cutline lookups.
 *
 * Split out of `cutlineUtils.ts` so that `lib/utils.ts` can use the normalizer
 * without an import cycle: `cutlineUtils.ts` imports `utils.ts` (for
 * `convertTimeToSeconds`), so `utils.ts` cannot import `cutlineUtils.ts` back.
 * `relaySplitQualificationCutEvent` in `utils.ts` needs the normalized event
 * name, so the shared half lives here instead of being duplicated.
 *
 * **This module must stay dependency-free.** It is the bottom of the import
 * graph for both `utils.ts` and `cutlineUtils.ts`.
 *
 * `cutlineUtils.ts` re-exports everything here, so existing import sites keep
 * working unchanged.
 */

/**
 * What a scoreboard event is measured in.
 *
 * `diving` events carry a judged point total, not a time. They must never reach
 * a seconds comparison — the number in the "time" column of a diving row is
 * points, and treating 285.60 points as 4:45.60 produces confident nonsense.
 */
export type CutlineEventCategory = 'swim' | 'diving';

/**
 * The HyTek meet-program prefix: `Event 8 Men 50 Yard Freestyle`.
 *
 * Two separate tokens because the entry number is optional in some exports
 * ("Men 50 Yard Freestyle") while the gender token is not.
 */
const HYTEK_EVENT_NUMBER = /^event\s+\d{1,3}\b\s*/i;
/** `Mixed` appears on time-trial heats; `Boys`/`Girls` on high-school exports. */
const HYTEK_GENDER_TOKEN = /^(?:men|women|boys|girls|mixed)\b\s*/i;
/** A time-trial swim is the same event; whether it *counts* is a rules question. */
const TIME_TRIAL_SUFFIX = /\s*\btime\s+trials?\b\s*$/i;
/** Course words. Deliberately excludes a bare `m`, which collides with too much. */
const COURSE_WORDS = /\b(?:yards?|met(?:er|re)s?|mtrs?)\b/gi;
/** `4x50`, `4 x 100`, `4X200` — legs and the distance of one leg. */
const RELAY_LEGS = /\b(\d{1,2})\s*[x×*]\s*(\d{2,4})\b/i;

/**
 * Canonical name of a diving event, matching the published tables
 * (`1-Meter Diving`, `3-Meter Diving`, `Platform Diving`).
 *
 * Returns `null` when the label is not a diving event at all.
 */
function canonicalDivingEvent(e: string): string | null {
  if (!/\bdiv(?:e|es|ing)\b/i.test(e)) return null;
  if (/\bplatform\b/i.test(e) || /\b10\s*(?:m|mtrs?|met(?:er|re)s?)\b/i.test(e)) {
    return 'Platform Diving';
  }
  // "3 mtr", "3M", "3-Meter", "3 Metre" — the board height, in metres.
  const board = e.match(/\b([13])\s*-?\s*(?:m|mtrs?|met(?:er|re)s?)\b/i);
  if (board) return `${board[1]}-Meter Diving`;
  // A diving row we cannot pin to a board is still diving, and still not a swim.
  return 'Diving';
}

/**
 * Fold the many published spellings onto one canonical event name.
 *
 * Handles the short forms the D3 sheet uses ("100 Back", "200 IM", "200 FR"),
 * the comma-grouped distances the D1 sheet uses ("1,650 Freestyle"), the course
 * suffixes our own meet data carries, and the HyTek meet-result form that
 * `data/meets.json` is full of:
 *
 *     Event 8 Men 50 Yard Freestyle              -> 50 Freestyle
 *     Event 15 Men 400 Yard IM                   -> 400 Individual Medley
 *     Event 100 Men 100 Yard Breaststroke Time Trial -> 100 Breaststroke
 *     Event 18 Women 3 mtr Diving                -> 3-Meter Diving
 *
 * **Relays are labelled by leg, the tables by total distance.** `4x200 Yard
 * Freestyle Relay` is the published `800 Freestyle Relay`. The total is derived
 * (legs × leg distance), not looked up in a hardcoded list, so an unusual relay
 * cannot silently resolve to the wrong published row.
 */
export function normalizeEventForCutline(event: string): string {
  let e = event.replace(/\s+/g, ' ').trim();
  e = e.replace(/(?<=\d),(?=\d)/g, '');
  e = e.replace(/\b(SCY|LCM|SCM)\b/gi, '').trim();

  // HyTek: strip the program's own scaffolding before anything else reads the
  // distance, or "Event 100 Men 100 Yard Breaststroke" parses its entry number
  // as a distance.
  e = e.replace(HYTEK_EVENT_NUMBER, '').replace(HYTEK_GENDER_TOKEN, '').trim();
  e = e.replace(TIME_TRIAL_SUFFIX, '').trim();

  // Diving before the course words are stripped — "3 mtr" *is* the board.
  const diving = canonicalDivingEvent(e);
  if (diving) return diving;

  const legs = e.match(RELAY_LEGS);
  if (legs) {
    const total = Number(legs[1]) * Number(legs[2]);
    e = `${e.slice(0, legs.index)}${total}${e.slice((legs.index ?? 0) + legs[0].length)}`;
    e = e.replace(/\s+/g, ' ').trim();
    // "4x50 Free" with the word Relay omitted is still a relay.
    if (!/\brelay\b/i.test(e)) e = `${e} Relay`;
  }

  e = e.replace(COURSE_WORDS, ' ').replace(/\s+/g, ' ').trim();

  if (!/relay/i.test(e)) {
    e = e.replace(/\b(\d+)\s*FR\b/i, '$1 Freestyle Relay');
    e = e.replace(/\b(\d+)\s*MR\b/i, '$1 Medley Relay');
  }
  if (/\bfly\b/i.test(e) && !/butterfly/i.test(e)) {
    e = e.replace(/\bfly\b/i, 'Butterfly');
  }
  if (/\bback\b/i.test(e) && !/backstroke/i.test(e)) {
    e = e.replace(/\bback\b/i, 'Backstroke');
  }
  if (/\bbreast\b/i.test(e) && !/breaststroke/i.test(e)) {
    e = e.replace(/\bbreast\b/i, 'Breaststroke');
  }
  if (/\bfree\b/i.test(e) && !/freestyle/i.test(e)) {
    e = e.replace(/\bfree\b/i, 'Freestyle');
  }
  if (/\bIM\b/.test(e) && !/individual medley/i.test(e)) {
    e = e.replace(/\bIM\b/, 'Individual Medley');
  }
  return e.replace(/\s+/g, ' ').trim();
}

/**
 * Whether an event label — raw or already normalized — names a diving event.
 *
 * Callers rendering a cut badge should treat `true` as "not applicable" rather
 * than as a miss: the published diving standards are point totals tied to a dive
 * count, and no time comparison against them is meaningful.
 */
export function isDivingEvent(event: string): boolean {
  return canonicalDivingEvent(event.replace(/\s+/g, ' ').trim()) !== null;
}

/** `'diving'` for any diving board event, `'swim'` for everything else. */
export function cutlineEventCategory(event: string): CutlineEventCategory {
  return isDivingEvent(event) ? 'diving' : 'swim';
}

/**
 * The course a swim was actually **recorded** in.
 *
 * This is the domain of `HistoricalSwim.timeType`, and it is a different axis
 * from `CutlineCourse`, which says what course a *published table* is stated in.
 * Keeping the two apart is the whole point: a cut is earned in a course, and a
 * converted time is not a swim.
 */
export type SwimCourseOfRecord = 'SCY' | 'LCM' | 'SCM';

/** Metric label whose pool length the source never states. See below. */
export type CourseOfRecordFromLabel = SwimCourseOfRecord | 'METRIC_UNSPECIFIED';

/** `Yard`/`Yards` anywhere in the label. */
const YARDS_WORD = /\byards?\b/i;
/** `Meter`/`Metre`/`Meters`/`Mtr` — metres, but *not* which pool length. */
const METRIC_WORD = /\bmet(?:er|re)s?\b|\bmtrs?\b/i;
/** An explicit course code the importer wrote into the label. */
const EXPLICIT_COURSE_CODE = /\b(SCY|LCM|SCM)\b/i;

/**
 * Read the course of record off an event label, when the label states one.
 *
 * `null` means the label is silent — the caller decides the default (for meet
 * results in this repo that is SCY; see `buildCutlineTag`).
 *
 * `'METRIC_UNSPECIFIED'` is returned for `50 Meter Freestyle`: the label proves
 * the swim was **not** yards, but "meters" does not say whether the pool was 25 m
 * or 50 m, and the LCM and SCM conversion factors differ materially (0.870 vs
 * 0.906 for men's 50 Freestyle). Picking one would be fabricating the pool
 * length, so we report the ambiguity instead and let the caller supply
 * `HistoricalSwim.timeType`.
 *
 * Diving labels are excluded outright — `Event 18 Women 3 mtr Diving` is a board
 * height in metres, not a course.
 */
export function courseOfRecordFromEventLabel(event: string): CourseOfRecordFromLabel | null {
  const e = String(event ?? '').replace(/\s+/g, ' ').trim();
  if (!e) return null;
  if (isDivingEvent(e)) return null;

  const code = e.match(EXPLICIT_COURSE_CODE);
  if (code) return code[1].toUpperCase() as SwimCourseOfRecord;

  if (YARDS_WORD.test(e)) return 'SCY';
  if (METRIC_WORD.test(e)) return 'METRIC_UNSPECIFIED';
  return null;
}
