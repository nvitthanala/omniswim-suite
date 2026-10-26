/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Conversion of swim times to short-course yards, and the conversion factor lookup.
// Split out of `utils.ts`, which still re-exports every name from here.

import { Gender, type NcaaDivision, type ScyConversionProvenance } from '../types';
import {
  CONVERSION_FACTORS,
  NCAA_SCM_CONVERSION_TABLES,
  NCAA_SCM_DISTANCE_ROWS,
  type NcaaScmConversionRow,
  type NcaaScmConversionTable,
  type NcaaScmConversionTableId,
} from '../constants';
// Strict lookup only: an unmapped team is `null`, never the legacy D1 default.
// `data/teamDivisions` imports nothing from `lib/`, so this adds no cycle.
import { divisionForTeamOrNull } from '../data/teamDivisions';
// Dependency-free by design — see the module header there. Importing
// `cutlineUtils` here instead would create a cycle (it imports this file).
import { normalizeEventForCutline, stripRelaySplitSuffix } from './cutlineEventNames';
import { recordAt, regexGroup } from './indexedAccess';
// A leaf module (types + cutlineEventNames only), so no cycle.
import {
  eventNotSwumInCourse,
  EventNotSwumInCourseError,
  type EventNotSwumInCourse,
} from './courseEvents';
import { convertTimeToSeconds, formatSecondsToTime } from './timeFormat';

/* -------------------------------------------------------------------------- */
/* Course conversion (LCM/SCM → SCY)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The `CONVERSION_FACTORS` key for one exact spelling, trying only the
 * spellings that name the same event. `undefined` when the table does not
 * publish it — never a stand-in from a different event.
 */
function factorKeyForSpelling(label: string): string | undefined {
  if (CONVERSION_FACTORS[label]) return label;

  // "200 IM" and "200 Individual Medley" are the same event under two labels;
  // `normalizeEventLabel` emits the long form, most published tables use the short.
  if (/\bIM\b/.test(label)) {
    const long = label.replace(/\bIM\b/, 'Individual Medley');
    if (CONVERSION_FACTORS[long]) return long;
  }
  if (/individual medley/i.test(label)) {
    const short = label.replace(/individual medley/i, 'IM');
    if (CONVERSION_FACTORS[short]) return short;
  }

  // A 50 of a stroke shares the 100's factor — the only sanctioned substitution here.
  if (label.startsWith('50 ')) {
    const hundred = label.replace(/^50\s+/, '100 ');
    if (CONVERSION_FACTORS[hundred]) return hundred;
  }
  return undefined;
}

/**
 * The `CONVERSION_FACTORS` key whose factor converts `event`, or `null` when no
 * published factor covers it.
 *
 * Two passes. The label is tried as given first, exactly as before, so no label
 * that already converted changes factor. Only a label that misses is then
 * normalized with `normalizeEventForCutline` and tried again. That second pass
 * is what lets a SwimCloud label reach the table: SwimCloud writes
 * `"50 Free LCM"`, `"100 Back SCM"`, `"400 IM LCM"` — distance, abbreviated
 * stroke, course token — and the table is keyed `"50 Freestyle"`. Before
 * 2026-09-22 every such swim missed, and `convertedHistorySwims` skipped it
 * without a word, so no international recruit time was ever projected.
 *
 * Relays and diving still resolve to `null`: no relay or diving factor is
 * published, and normalizing cannot invent one.
 */
export function resolveConversionFactorKey(event: string): string | null {
  const base = stripRelaySplitSuffix(String(event ?? ''));
  if (!base) return null;
  const direct = factorKeyForSpelling(base);
  if (direct) return direct;
  if (/\brelay\b/i.test(base)) return null;
  const canonical = normalizeEventForCutline(base);
  if (!canonical || canonical === base) return null;
  return factorKeyForSpelling(canonical) ?? null;
}

/**
 * True when `CONVERSION_FACTORS` covers this event, so a swim in it converts
 * from **either** metric course.
 *
 * Course-blind on purpose, and unchanged in meaning. Since 2026-09-24 an SCM
 * swim can convert without a `CONVERSION_FACTORS` key (the NCAA "All other
 * events" row covers a 100 IM or a 25), while an LCM swim still cannot. Ask
 * {@link hasConversionFactorForCourse} when the course is known.
 */
export function hasConversionFactor(event: string): boolean {
  return resolveConversionFactorKey(event) != null;
}

/** A canonical individual swim: a distance, then one of the five strokes. */
const INDIVIDUAL_SWIM_EVENT = /^(\d+) (?:Freestyle|Backstroke|Breaststroke|Butterfly|Individual Medley)$/;

/**
 * The canonical individual swim `event` names, or `null` for a relay, a dive,
 * or a label that names no stroke and distance.
 *
 * The distance must be a whole number of 25 m lengths: every race swum in a
 * 25 m pool is. That is arithmetic about the pool, not a list of events.
 */
function individualSwimEventForScm(event: string): string | null {
  const base = stripRelaySplitSuffix(String(event ?? ''));
  if (!base || /\brelay\b/i.test(base)) return null;
  const canonical = normalizeEventForCutline(base);
  const match = INDIVIDUAL_SWIM_EVENT.exec(canonical);
  if (!match) return null;
  // Group 1 of INDIVIDUAL_SWIM_EVENT (`(\d+)`) is mandatory.
  const distance = Number.parseInt(regexGroup(match, 1), 10);
  if (!(distance > 0) || distance % 25 !== 0) return null;
  return canonical;
}

/**
 * How an SCM swim reaches the NCAA SCM table.
 *
 * - `factor_table` — a `CONVERSION_FACTORS` key covers the event. The row is
 *   the one {@link ncaaScmConversionRow} gives it, exactly as before
 *   2026-09-24.
 * - `all_other_events` — no key covers the event, and it is an individual
 *   swim. The NCAA table's fourth row is headed "All other events", and it
 *   covers this event by that wording (user decision, 2026-09-24). Examples:
 *   the 100 IM and every 25.
 */
export type NcaaScmConversionCoverage = 'factor_table' | 'all_other_events';

export type NcaaScmConversionEvent = {
  /**
   * The `CONVERSION_FACTORS` key when `coverage` is `factor_table`. The
   * canonical event (`normalizeEventForCutline`) when it is
   * `all_other_events`: there is no key to name.
   */
  factorEvent: string;
  row: NcaaScmConversionRow;
  coverage: NcaaScmConversionCoverage;
};

/**
 * The NCAA SCM row an SCM swim in `event` converts with, or `null` when the
 * NCAA table covers nothing about it (a relay, a dive, a label with no stroke).
 *
 * `null` too for a yards distance freestyle event (500, 1000, 1650): no such
 * event is swum in SCM. The table's distance rows name the metric swim ("800
 * meters to 1000 yards"), so a "1000 Freestyle" recorded SCM is not covered
 * by any row. User decision, 2026-09-24; see `courseEvents.ts`.
 *
 * SCM only. No governing body publishes an LCM factor, so an LCM swim outside
 * `CONVERSION_FACTORS` stays unconverted: absent, not guessed.
 */
export function ncaaScmConversionEvent(event: string): NcaaScmConversionEvent | null {
  if (eventNotSwumInCourse(stripRelaySplitSuffix(String(event ?? '')), 'SCM')) return null;
  const key = resolveConversionFactorKey(event);
  if (key) return { factorEvent: key, row: ncaaScmConversionRow(key), coverage: 'factor_table' };
  const individual = individualSwimEventForScm(event);
  if (!individual) return null;
  return { factorEvent: individual, row: 'allOtherEvents', coverage: 'all_other_events' };
}

/**
 * True when a swim in `event`, recorded in `course`, can be stated in SCY.
 *
 * - `SCY` — always: the time is already yards. (A 400 Freestyle recorded SCY
 *   names no yards event, but nothing is converted; `isRankableSwim` keeps it
 *   out of every ranking.)
 * - `SCM` — when the NCAA SCM table covers the event, including through its
 *   "All other events" row (see {@link ncaaScmConversionEvent}). Never for a
 *   500, 1000 or 1650 Freestyle: no such event is swum in SCM.
 * - `LCM` — only when `CONVERSION_FACTORS` covers the event.
 *
 * A relay in a metric course is `false`: no relay factor is published. The
 * converters pass a relay through unchanged, and callers handle that first.
 */
export function hasConversionFactorForCourse(
  event: string,
  course: 'SCY' | 'SCM' | 'LCM'
): boolean {
  if (course === 'SCY') return true;
  if (/\brelay\b/i.test(String(event ?? ''))) return false;
  if (course === 'SCM') return ncaaScmConversionEvent(event) != null;
  return resolveConversionFactorKey(event) != null;
}

/**
 * What decides the SCM table for a conversion. Every field is optional, and a
 * call with no options is the old call shape.
 *
 * LCM conversion ignores both fields: no governing body publishes an LCM
 * factor, so there is no per-division LCM table to pick.
 */
export type ScyConversionOptions = {
  /**
   * The division whose NCAA SCM table applies. Wins over `team`. Pass `null`
   * when the caller already knows the division is unknown.
   */
  division?: NcaaDivision | null;
  /**
   * A team whose **current** division picks the SCM table. Resolved strictly
   * with `divisionForTeamOrNull`, so an unmapped or discontinued program is
   * unknown — never the legacy D1 default.
   */
  team?: string | null;
  /**
   * The season of the swim, `YYYY-YYYY`, for a `team` that changed division
   * (UWF). Without it such a team is unknown and takes the Rules Book table.
   */
  season?: string;
};

/**
 * Why a conversion used the SCM table it did.
 *
 * - `division_table` — the division publishes this table (D1; D2, whose sheet
 *   prints the Rules Book table).
 * - `division_publishes_none` — the division is known but prints no factor
 *   (D3, NAIA), so the Rules Book table applies.
 * - `division_unknown` — no division was supplied or the team did not resolve,
 *   so the Rules Book table applies. Never D1.
 */
export type ScmConversionTableReason =
  | 'division_table'
  | 'division_publishes_none'
  | 'division_unknown';

export type ScmConversionTableChoice = {
  table: NcaaScmConversionTable;
  /** The division the choice was made for. `null` when unknown. */
  division: NcaaDivision | null;
  reason: ScmConversionTableReason;
};

/** The default SCM table: the one the NCAA Rules Book, Appendix A-2 prints. */
const RULES_BOOK_SCM_TABLE = NCAA_SCM_CONVERSION_TABLES['ncaa-rules-book-a2-2026-27'];

/**
 * The NCAA SCM→SCY table for a division, and why.
 *
 * D1 publishes its own table. Every other case — D2, D3, NAIA and unknown —
 * uses the Rules Book table, and `reason` says which case it was. An unknown
 * division is never treated as D1.
 */
export function scmConversionTableFor(
  division: NcaaDivision | null | undefined
): ScmConversionTableChoice {
  switch (division) {
    case 'D1':
      return {
        table: NCAA_SCM_CONVERSION_TABLES['ncaa-d1-2025-26'],
        division,
        reason: 'division_table',
      };
    case 'D2':
      return { table: RULES_BOOK_SCM_TABLE, division, reason: 'division_table' };
    case 'D3':
    case 'NAIA':
      return { table: RULES_BOOK_SCM_TABLE, division, reason: 'division_publishes_none' };
    default:
      return { table: RULES_BOOK_SCM_TABLE, division: null, reason: 'division_unknown' };
  }
}

/** Which NCAA SCM row a `CONVERSION_FACTORS` key takes. */
export function ncaaScmConversionRow(factorEvent: string): NcaaScmConversionRow {
  return NCAA_SCM_DISTANCE_ROWS[factorEvent] ?? 'allOtherEvents';
}

/**
 * The NCAA SCM procedure, steps (b) and (c): multiply "carrying the
 * calculation out to five decimal places", then "drop, without rounding, all
 * units smaller than a hundredth of a second".
 *
 * Integer arithmetic on purpose. `54.49 × 0.906` is `49.36794`; a float
 * product can land a hair under an exact hundredth and a naive floor would then
 * lose a hundredth the procedure keeps. Rounding once at the fifth decimal
 * removes only float noise; the truncation happens after it.
 *
 * Non-finite input (`NT`, `DQ`) passes through as the plain product, which
 * `formatSecondsToTime` renders as before.
 */
export function ncaaScmConvertedSeconds(seconds: number, factor: number): number {
  const product = seconds * factor;
  if (!Number.isFinite(product)) return product;
  const hundredThousandths = Math.round(product * 100_000);
  return Math.floor(hundredThousandths / 1000) / 100;
}

/**
 * How a time reached SCY.
 *
 * - `identity` — no factor was applied. `reason` says why: the swim was
 *   recorded in SCY, it is a relay (no relay factor is published, so the time
 *   is returned as recorded), or the course was not one of SCY/SCM/LCM (legacy
 *   rows; the time is only reformatted, as it always was).
 * - `lcm_factor_table` — the gendered LCM factor in `CONVERSION_FACTORS`
 *   (Colorado Time Systems; indicative only). Rounded to hundredths.
 * - `ncaa_scm_table` — an official NCAA SCM table, chosen by division.
 *   Truncated to hundredths, as the NCAA procedure requires. `factorEvent` is
 *   the `CONVERSION_FACTORS` key when one covers the event; for an event only
 *   the "All other events" row covers (a 100 IM, a 25) it is the canonical
 *   event, and `row` is `'allOtherEvents'`. See {@link ncaaScmConversionEvent}.
 */
export type ScyConversionBasis =
  | {
      method: 'identity';
      reason: 'recorded_in_scy' | 'relay_not_converted' | 'course_not_recognized';
    }
  | { method: 'lcm_factor_table'; factor: number; factorEvent: string }
  | {
      method: 'ncaa_scm_table';
      factor: number;
      factorEvent: string;
      row: NcaaScmConversionRow;
      tableId: NcaaScmConversionTableId;
      /** The division the table was chosen for. `null` when unknown. */
      division: NcaaDivision | null;
      reason: ScmConversionTableReason;
    };

/** A swim stated in SCY, with the basis of the statement. */
export type ScyConversion = {
  /** SCY program event label. See {@link convertSwimToSCY}. */
  event: string;
  /** SCY time. For a converted swim this is an estimate, not a yards swim. */
  time: string;
  /** The course the swim was recorded in. */
  sourceCourse: 'SCY' | 'SCM' | 'LCM';
  basis: ScyConversionBasis;
};

/** Bounded cache: `divisionForTeamOrNull` is pure over a static registry. */
const conversionDivisionCache = new Map<string, NcaaDivision | null>();

const CONVERSION_DIVISION_CACHE_LIMIT = 2000;

function conversionDivision(options: ScyConversionOptions | undefined): NcaaDivision | null {
  if (!options) return null;
  if (options.division !== undefined) return options.division;
  const team = String(options.team ?? '').trim();
  if (!team) return null;
  const season = options.season;
  const cacheKey = season === undefined ? team : `${team}|${season}`;
  const cached = conversionDivisionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const division = divisionForTeamOrNull(team, season === undefined ? undefined : { season });
  if (conversionDivisionCache.size >= CONVERSION_DIVISION_CACHE_LIMIT) {
    conversionDivisionCache.clear();
  }
  conversionDivisionCache.set(cacheKey, division);
  return division;
}

/** The time half of a conversion, with its basis. Throws when no factor is published. */
function convertTimeWithBasis(
  timeStr: string,
  event: string,
  gender: Gender,
  type: 'LCM' | 'SCM' | 'SCY',
  options: ScyConversionOptions | undefined
): { time: string; basis: ScyConversionBasis } {
  if (type === 'SCY') return { time: timeStr, basis: { method: 'identity', reason: 'recorded_in_scy' } };

  const seconds = convertTimeToSeconds(timeStr);
  const baseEvent = stripRelaySplitSuffix(event);

  // No published factor means the swim cannot be expressed in SCY. Substituting
  // another event's factor (this used to silently borrow 50 Freestyle's) invents a
  // competition time that looks real — the exact failure this codebase forbids.
  // Raise instead, so a missing factor is added from a source rather than guessed.
  const noFactor = () =>
    new Error(
      `No published ${type}→SCY conversion factor for "${baseEvent}". ` +
        `Add the event to CONVERSION_FACTORS from a primary source rather than converting it with another event's factor.`
    );

  if (type === 'SCM') {
    // A yards distance (500, 1000, 1650 Freestyle) is not swum in SCM. It is
    // refused by name, never converted: the "800 meters to 1000 yards" row is
    // for an 800 m swim. See courseEvents.ts.
    const mismatch = eventNotSwumInCourse(baseEvent, 'SCM');
    if (mismatch) throw new EventNotSwumInCourseError(mismatch);
    // The NCAA table covers every individual event: three distance rows, then
    // "All other events". A 100 IM or a 25 takes that last row by its wording.
    const scm = ncaaScmConversionEvent(baseEvent);
    if (!scm) throw noFactor();
    const choice = scmConversionTableFor(conversionDivision(options));
    const factor = choice.table.factors[scm.row];
    return {
      time: formatSecondsToTime(ncaaScmConvertedSeconds(seconds, factor)),
      basis: {
        method: 'ncaa_scm_table',
        factor,
        factorEvent: scm.factorEvent,
        row: scm.row,
        tableId: choice.table.id,
        division: choice.division,
        reason: choice.reason,
      },
    };
  }

  if (type === 'LCM') {
    // No governing body publishes an LCM factor. `CONVERSION_FACTORS` holds an
    // indicative one per event, and an event it does not hold stays absent.
    const factorEvent = resolveConversionFactorKey(baseEvent);
    if (!factorEvent) throw noFactor();
    // `resolveConversionFactorKey` only returns a key `CONVERSION_FACTORS` holds.
    const factors = recordAt(CONVERSION_FACTORS, factorEvent);
    const factor = gender === Gender.MEN ? factors.men_lcm : factors.women_lcm;
    return {
      time: formatSecondsToTime(seconds * factor),
      basis: { method: 'lcm_factor_table', factor, factorEvent },
    };
  }

  // Not a course the type allows. Kept exactly as before: it still raises for
  // an event with no factor, and otherwise the time is reformatted with no
  // factor, now said out loud in the basis.
  if (!resolveConversionFactorKey(baseEvent)) throw noFactor();
  return {
    time: formatSecondsToTime(seconds),
    basis: { method: 'identity', reason: 'course_not_recognized' },
  };
}

/**
 * A swim's time stated in SCY.
 *
 * - SCY returns the time untouched.
 * - LCM multiplies by the gendered `CONVERSION_FACTORS` factor and rounds to
 *   hundredths (unchanged).
 * - SCM multiplies by the NCAA table for the division in `options` and
 *   **truncates** to hundredths, as the NCAA procedure requires. With no
 *   division (no options, an unmapped team, `division: null`) the Rules Book
 *   table applies — see {@link scmConversionTableFor}. Use
 *   {@link convertSwimToSCYDetailed} when the caller must show which table.
 *   An individual event with no `CONVERSION_FACTORS` key (a 100 IM, a 25)
 *   takes the table's "All other events" row — see {@link ncaaScmConversionEvent}.
 *
 * Throws when no published factor covers the event: every LCM event outside
 * `CONVERSION_FACTORS`, and every SCM relay, dive or unreadable label. Throws
 * {@link EventNotSwumInCourseError} for a 500, 1000 or 1650 Freestyle recorded
 * SCM: no such event is swum in SCM, so it is never converted. Use
 * {@link scyConversionOutcome} to get either refusal as a value.
 */
export function convertToSCY(
  timeStr: string,
  event: string,
  gender: Gender,
  type: 'LCM' | 'SCM' | 'SCY',
  options?: ScyConversionOptions
): string {
  if (type === 'SCY') return timeStr;
  return convertTimeWithBasis(timeStr, event, gender, type, options).time;
}

/** Freestyle metric distances map to their SCY program-event distance (400→500, 800→1000, 1500→1650). */
function remapMetricFreestyleEvent(event: string): string {
  const e = event.trim();
  if (/relay/i.test(e)) return event;
  if (!/free/i.test(e)) return event;
  if (/^400(\D|$)/.test(e)) return e.replace(/^400/, '500');
  if (/^800(\D|$)/.test(e)) return e.replace(/^800/, '1000');
  if (/^1500(\D|$)/.test(e)) return e.replace(/^1500/, '1650');
  return event;
}

/** SwimCloud's own label shape: `"50 Free LCM"` — distance first, course token last. */
const SWIMCLOUD_METRIC_LABEL = /^(\d+\s.*?)\s+(?:LCM|SCM)$/i;

/**
 * The SCY program-event label for a converted swim.
 *
 * Three label families reach here, and each keeps its own shape so a converted
 * swim lands on the same label an actual SCY swim of that event carries from
 * the same source:
 *
 * 1. A label the factor table knows as spelled (`"400 Freestyle"`, `"200 IM"`)
 *    keeps the pre-2026-09-22 behaviour: only the distance remap.
 * 2. A SwimCloud label (`"400 Free LCM"`) swaps its course token for `SCY`
 *    (`"500 Free SCY"`). SwimCloud's real SCY swims are imported as
 *    `"50 Free SCY"`, and the best-time folds in `categorizeBestEvents` and
 *    `importHistoryToRoster` key on the label. A converted swim labelled
 *    `"50 Freestyle"` would sit beside the swimmer's `"50 Free SCY"` as a
 *    second, phantom event and could take a second entry slot.
 * 3. Anything else that only resolved through normalization (a HyTek label, a
 *    bare abbreviation) takes the canonical label, e.g. `"500 Freestyle"`.
 */
function scyProgramEventLabel(event: string): string {
  const base = stripRelaySplitSuffix(event);
  if (factorKeyForSpelling(base)) return remapMetricFreestyleEvent(event);
  const swimCloud = base.match(SWIMCLOUD_METRIC_LABEL);
  if (swimCloud) return remapMetricFreestyleEvent(`${swimCloud[1]} SCY`);
  return remapMetricFreestyleEvent(normalizeEventForCutline(base));
}

/**
 * SCY-equivalent event *and* time for a swim. Unlike {@link convertToSCY} (time only),
 * this also remaps distance-event identity so a 400 Free (LCM/SCM) competes in the 500
 * Free SCY slot (800→1000, 1500→1650). Non-metric swims are returned unchanged. See
 * `scyProgramEventLabel` for the label each input shape comes back with.
 *
 * Relays pass through untouched. No governing body publishes a relay conversion
 * factor, and a relay is not one stroke over one distance — a 400 Medley Relay is
 * four different strokes. Every caller in this package already special-cases relays
 * to passthrough before calling here; doing it once, here, keeps the primitive from
 * being the odd one out (it used to convert relays with the 50 Freestyle factor).
 *
 * `options` picks the NCAA SCM table; see {@link convertToSCY}.
 */
export function convertSwimToSCY(
  event: string,
  time: string,
  gender: Gender,
  timeType: 'SCY' | 'SCM' | 'LCM',
  options?: ScyConversionOptions
): { event: string; time: string } {
  if (timeType === 'SCY') return { event, time };
  if (/\brelay\b/i.test(event)) return { event, time };
  const scyTime = convertToSCY(time, event, gender, timeType, options);
  return { event: scyProgramEventLabel(event), time: scyTime };
}

/**
 * {@link convertSwimToSCY}, plus the basis of the conversion: which factor,
 * which NCAA table and why. Same event and time as `convertSwimToSCY` for the
 * same arguments. Throws when no published factor covers the event, and
 * {@link EventNotSwumInCourseError} for an event SCM does not swim.
 */
export function convertSwimToSCYDetailed(
  event: string,
  time: string,
  gender: Gender,
  timeType: 'SCY' | 'SCM' | 'LCM',
  options?: ScyConversionOptions
): ScyConversion {
  if (timeType === 'SCY') {
    return {
      event,
      time,
      sourceCourse: 'SCY',
      basis: { method: 'identity', reason: 'recorded_in_scy' },
    };
  }
  if (/\brelay\b/i.test(event)) {
    return {
      event,
      time,
      sourceCourse: timeType,
      basis: { method: 'identity', reason: 'relay_not_converted' },
    };
  }
  const converted = convertTimeWithBasis(time, event, gender, timeType, options);
  return {
    event: scyProgramEventLabel(event),
    time: converted.time,
    sourceCourse: timeType,
    basis: converted.basis,
  };
}

/**
 * What {@link scyConversionOutcome} found. Only `converted` carries a time.
 *
 * - `converted` — the swim is stated in SCY: `conversion` is exactly what
 *   {@link convertSwimToSCYDetailed} returns (an SCY swim and a relay come
 *   back unchanged, with an `identity` basis).
 * - `event_not_swum_in_course` — the event does not exist in the recorded
 *   course: a 500, 1000 or 1650 Freestyle recorded SCM, or a 400, 800 or
 *   1500 Freestyle recorded SCY. Absent: never converted, never a time. See
 *   `courseEvents.ts` for the sources.
 * - `no_published_factor` — a metric swim no published factor covers (an LCM
 *   100 IM, a dive, a label with no stroke). Absent, as before.
 */
export type ScyConversionOutcome =
  | { status: 'converted'; conversion: ScyConversion }
  | { status: 'event_not_swum_in_course'; mismatch: EventNotSwumInCourse }
  | { status: 'no_published_factor'; event: string; sourceCourse: 'LCM' | 'SCM' };

/**
 * A swim stated in SCY, or the reason it cannot be. Never throws on either
 * refusal: this is the explicit-outcome form of
 * {@link convertSwimToSCYDetailed}, with the same arguments.
 *
 * Checks the recorded course of `timeType` only. A caller holding a stored row
 * whose `timeType` may be absent resolves the course first (see
 * `recordedCourseOfSwim`).
 */
export function scyConversionOutcome(
  event: string,
  time: string,
  gender: Gender,
  timeType: 'SCY' | 'SCM' | 'LCM',
  options?: ScyConversionOptions
): ScyConversionOutcome {
  const relay = /\brelay\b/i.test(event);
  if (!relay) {
    const mismatch = eventNotSwumInCourse(stripRelaySplitSuffix(event), timeType);
    if (mismatch) return { status: 'event_not_swum_in_course', mismatch };
    if (timeType !== 'SCY' && !hasConversionFactorForCourse(event, timeType)) {
      return { status: 'no_published_factor', event, sourceCourse: timeType };
    }
  }
  return {
    status: 'converted',
    conversion: convertSwimToSCYDetailed(event, time, gender, timeType, options),
  };
}

/**
 * The {@link ScyConversionProvenance} a row must carry when its time came out
 * of `conversion`, or `undefined` when no factor was applied (an SCY swim, a
 * relay passed through, a course the converter did not recognise).
 *
 * `recorded` is the swim as recorded: the same event and time that were passed
 * to {@link convertSwimToSCYDetailed}.
 */
export function scyConversionProvenance(
  recorded: { event: string; time: string },
  conversion: ScyConversion
): ScyConversionProvenance | undefined {
  if (conversion.sourceCourse === 'SCY') return undefined;
  if (conversion.basis.method === 'identity') return undefined;
  return {
    sourceCourse: conversion.sourceCourse,
    sourceEvent: recorded.event,
    sourceTime: recorded.time,
    scyTime: conversion.time,
    basis: conversion.basis,
  };
}
