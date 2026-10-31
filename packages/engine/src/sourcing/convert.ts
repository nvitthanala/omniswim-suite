/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Course conversion for the planner (plans/2026-10-25/D2-ENGINE-API.md, 3.10).
 *
 * Order of sources (README R10, R60):
 * 1. SwimCloud's own converted time.
 * 2. SCM: the NCAA Table A factors already in `lib/scyConversion.ts` (published).
 * 3. LCM: the tool-derived preset (`lcmToScy.ts`). No preset (`null`) means no LCM conversion.
 *
 * Every converted time carries `estimated: true`. No conversion is ever Table D (R58), and no
 * conversion is ever factor 1.0: a swim nothing converts is `not-convertible`.
 */
import { Gender as LegacyGender } from '../types';
import { eventNotSwumInCourse, COURSE_DISTANCE_PAIRS } from '../lib/courseEvents';
import { normalizeEventForCutline } from '../lib/cutlineEventNames';
import { scyConversionOutcome } from '../lib/scyConversion';
import type { ConversionBasis, DivisionRef, MeetSwim, RelaySplit, ScyStatement } from '../model/meet';
import type { Course, EventKey, Gender, TimeValue } from '../model/primitives';
import { formatHundredths, parseTimeText } from '../model/primitives';
import { convertLcmToScy } from './lcmToScy';
import type { LcmToScyPreset } from './lcmToScy';

/** The conversion slice of D2 3.10 `SourcingSettings`, which extends this with the window and flyover (P4). */
export interface ConversionSettings {
  /** Per meet (F1.2). `false`: every non-SCY swim is `conversions_excluded`. */
  readonly includeConvertedSwims: boolean;
  /** `null`: no LCM conversion. There is no Table D field (R58). */
  readonly lcmToScy: LcmToScyPreset | null;
}

export type ConvertedScy = Extract<ScyStatement, { kind: 'converted' }>;

const NOT_CONVERTIBLE = (reason: Extract<ScyStatement, { kind: 'not-convertible' }>['reason']): ScyStatement => ({
  kind: 'not-convertible',
  reason,
});

/**
 * The yards event a time in `eventKey`, swum in `course`, competes in: the 400, 800 and 1500
 * Freestyle map to the 500, 1000 and 1650. Every other event keeps its key. A key is exact and
 * canonical: nothing is guessed.
 */
export function scyEventKeyFor(eventKey: EventKey, course: Course): EventKey {
  if (course === 'SCY') return eventKey;
  const canonical = normalizeEventForCutline(eventKey);
  const pair = COURSE_DISTANCE_PAIRS.find(p => p.scmEvent === canonical);
  return pair ? pair.yardsEvent : canonical;
}

function divisionOf(division: DivisionRef): 'unknown' | Extract<DivisionRef, { state: 'known' }>['division'] {
  return division.state === 'known' ? division.division : 'unknown';
}

/** The legacy converter's enum. There is no default: a gender the model does not name throws. */
function legacyGender(gender: Gender): LegacyGender {
  if (gender === 'Men') return LegacyGender.MEN;
  if (gender === 'Women') return LegacyGender.WOMEN;
  throw new RangeError(`scyStatementFor: ${String(gender)} is not a gender`);
}

type Input = {
  readonly eventKey: EventKey;
  readonly course: Course;
  readonly time: TimeValue | null;
  readonly swimcloudScy: TimeValue | null;
  readonly gender: Gender;
  readonly appliedTo: 'individual-swim' | 'relay-split';
};

function statementFor(input: Input, division: DivisionRef, s: ConversionSettings): ScyStatement {
  const { eventKey, course, time, swimcloudScy, gender, appliedTo } = input;
  // 1. An event the course does not swim, before anything else (invariant 16).
  if (eventNotSwumInCourse(eventKey, course)) return NOT_CONVERTIBLE('event_not_swum_in_course');
  // 2. A recorded SCY swim is not converted.
  if (course === 'SCY') return { kind: 'recorded-scy' };
  // 3. The meet leaves converted swims out.
  if (!s.includeConvertedSwims) return NOT_CONVERTIBLE('conversions_excluded');
  // No time, nothing to convert. NT never becomes a time.
  if (time === null) return NOT_CONVERTIBLE('no_conversion_available');
  if (!Number.isInteger(time.hundredths) || time.hundredths <= 0) {
    throw new RangeError(`scyStatementFor: ${String(time.hundredths)} is not a positive integer of hundredths`);
  }

  // 4. SwimCloud's own conversion (R10).
  if (swimcloudScy !== null) {
    if (!Number.isInteger(swimcloudScy.hundredths) || swimcloudScy.hundredths <= 0) {
      throw new RangeError(`scyStatementFor: SwimCloud time ${String(swimcloudScy.hundredths)} is not a positive integer`);
    }
    return {
      kind: 'converted',
      hundredths: swimcloudScy.hundredths,
      basis: { method: 'swimcloud', displayedText: swimcloudScy.text },
      estimated: true,
    };
  }

  // Only an individual swim converts (R60). No relay factor is published or fitted.
  if (/\brelay\b/i.test(eventKey)) return NOT_CONVERTIBLE('no_conversion_available');

  // 5. SCM: the NCAA table chosen by division (Table A, truncating).
  if (course === 'SCM') {
    const d = divisionOf(division);
    const outcome = scyConversionOutcome(eventKey, formatHundredths(time.hundredths), legacyGender(gender), 'SCM', {
      division: d === 'unknown' ? null : d,
    });
    if (outcome.status === 'event_not_swum_in_course') return NOT_CONVERTIBLE('event_not_swum_in_course');
    if (outcome.status === 'no_published_factor') return NOT_CONVERTIBLE('no_conversion_available');
    const { basis } = outcome.conversion;
    if (basis.method !== 'ncaa_scm_table') return NOT_CONVERTIBLE('no_conversion_available');
    const converted = parseTimeText(outcome.conversion.time);
    if (converted === null) throw new RangeError(`scyStatementFor: converter returned "${outcome.conversion.time}"`);
    const model: ConversionBasis = {
      method: 'ncaa_scm_table',
      tableId: basis.tableId,
      factor: basis.factor,
      division: basis.division,
      reason: basis.reason,
      ...(appliedTo === 'relay-split' ? { appliedTo: 'relay-split' as const } : {}),
    };
    return { kind: 'converted', hundredths: converted.hundredths, basis: model, estimated: true };
  }

  // 6. LCM: the tool-derived preset.
  if (s.lcmToScy === null) return NOT_CONVERTIBLE('no_conversion_available');
  const lcm = convertLcmToScy(s.lcmToScy, normalizeEventForCutline(eventKey), time.hundredths, appliedTo);
  if (lcm.kind === 'absent') return NOT_CONVERTIBLE('no_conversion_available');
  return { kind: 'converted', hundredths: lcm.hundredths, basis: lcm.basis, estimated: true };
}

/**
 * The yards statement for one swim, in the order of README R10 and R60. `swimcloudScy` is the
 * converted time SwimCloud shows for it, or `null` when SwimCloud shows none.
 *
 * `gender` is the swimmer's (`MeetSwimmer.gender`) and is required. It reaches the legacy converter
 * as is; no code supplies a default. Throws `RangeError` for a time that is not a positive integer
 * of hundredths, or for a value that is not a gender.
 */
export function scyStatementFor(
  swim: Pick<MeetSwim, 'eventKey' | 'recordedCourse' | 'recordedTime'>,
  swimcloudScy: TimeValue | null,
  division: DivisionRef,
  gender: Gender,
  s: ConversionSettings
): ScyStatement {
  return statementFor(
    {
      eventKey: swim.eventKey,
      course: swim.recordedCourse,
      time: swim.recordedTime,
      swimcloudScy,
      gender,
      appliedTo: 'individual-swim',
    },
    division,
    s
  );
}

/**
 * The yards statement for one relay split (README R60, confirmed by the user in R62).
 *
 * The converter has no split data, so a split converts with the individual divisor and turn for the
 * leg's stroke and distance (R62). A flying-start split already includes the exchange: this function
 * never applies a flyover, and P4's flyover must never be subtracted from a converted split (D2 3.13). The basis says `appliedTo:
 * 'relay-split'`. A split with no `legEventKey`, no `course`, or a leg that has no row is
 * `not-convertible`: the course is never assumed SCY. SwimCloud shows no conversion for a split, so
 * step 1 of the order does not apply. `gender` is the relay's (`MeetEvent.gender`), required.
 */
export function scyStatementForSplit(
  split: Pick<RelaySplit, 'legEventKey' | 'course' | 'split'>,
  division: DivisionRef,
  gender: Gender,
  s: ConversionSettings
): ScyStatement {
  if (split.legEventKey === null || split.course === null) return NOT_CONVERTIBLE('no_conversion_available');
  return statementFor(
    { eventKey: split.legEventKey, course: split.course, time: split.split, swimcloudScy: null, gender, appliedTo: 'relay-split' },
    division,
    s
  );
}
