/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cut tags (plans/2026-10-25/D2-ENGINE-API.md, 3.9), with the estimated tag of README R61.
 *
 * A real SCY swim that clears a published standard gets `achieved`. A converted time that clears one
 * gets `estimated-achieved`. A converted time never gets `achieved`. When one swimmer has both for an
 * event, `foldEventCutTags` lets the real tag replace the estimated one.
 *
 * The judging stays in `lib/cutlineTags.ts` (`buildCutlineTag`). This file only decides which time and
 * course go in, and maps the verdict. Two guards matter:
 * - A converted time goes in as an SCY swim on the SCY event (the 400 Freestyle LCM is judged as the
 *   500 Freestyle SCY). It never goes in as LCM, which would bring back the unsourced gendered LCM
 *   factors in `constants.ts`.
 * - A swim whose division publishes its course (an NAIA SCM swim) is judged in that course, as a real
 *   swim. It is not converted and never estimated.
 */
import { legacySlotForTier } from '../cutlines';
import type { CutlineSeason, CutlineSourceRef, CutlineTier } from '../cutlines';
import { buildCutlineTag } from '../lib/cutlineTags';
import type { CutlineIndicativeComparison, CutlineNextTierGap, CutlineTagResult } from '../lib/cutlineTags';
import { cutlineTableCourseForSwim } from '../lib/cutlineUtils';
import type { ConversionBasis, MeetSwim, MeetSwimmer, MeetTeam } from '../model/meet';
import type { Hundredths, TimeValue } from '../model/primitives';
import { parseTimeText } from '../model/primitives';
import { scyEventKeyFor } from './convert';

export type { CutlineTier as CutTier } from '../cutlines';

export type CutGap = {
  readonly tier: CutlineTier;
  readonly standard: TimeValue;
  /** More than 0. */
  readonly gapHundredths: number;
  /** `floor(gap * 10000 / standard)`. */
  readonly gapBasisPoints: number;
  readonly source: CutlineSourceRef;
};

export type CutUnknownReason =
  | 'division_unknown'
  | 'program_discontinued'
  | 'gender_not_sponsored'
  /** The school's sponsorship list was never audited, so no answer is given (CLAUDE.md, rule 7). */
  | 'sponsorship_unaudited'
  | 'no_table_for_division'
  | 'event_not_in_table'
  | 'no_time'
  | 'conversion_unavailable'
  | 'user_inputted'
  | 'extracted_split'
  | 'program_unconfirmed'
  | 'event_not_swum_in_course';

type AchievedFields = {
  readonly tier: CutlineTier;
  /** `'A'`, `'B'`, or `null` for a tier with no legacy slot (D3 `Invited`). */
  readonly slot: 'A' | 'B' | null;
  /** The published standard that was cleared. Compare by time: list order is not strictness. */
  readonly standard: TimeValue;
  readonly marginHundredths: number;
  readonly source: CutlineSourceRef;
  /** The gap to the next tier up (R11); `null` at the strictest tier. */
  readonly nextTier: CutGap | null;
};

export type CutTag =
  /** A real SCY swim (or a swim in a course its division publishes) cleared a standard. */
  | ({ readonly kind: 'achieved' } & AchievedFields)
  /**
   * A converted time cleared a standard (R61). Render it as estimated, never as a cut. A real
   * `achieved` tag replaces it (`foldEventCutTags`).
   */
  | ({
      readonly kind: 'estimated-achieved';
      readonly basis: ConversionBasis;
      /** The converted yards time that was judged. */
      readonly convertedHundredths: Hundredths;
    } & AchievedFields)
  | { readonly kind: 'close'; readonly nearest: CutGap; readonly thresholdBasisPoints: number }
  | { readonly kind: 'none'; readonly nearest: CutGap | null }
  /**
   * A converted time exists and clears no standard (`indicative: null`), or the legacy comparison
   * (`cutTagFromLegacy`) judged a metric swim with a legacy factor. Never a cut, never an estimated tag.
   */
  | { readonly kind: 'converted'; readonly indicative: CutlineIndicativeComparison | null }
  | { readonly kind: 'not-applicable'; readonly reason: 'diving' }
  | { readonly kind: 'unknown'; readonly reason: CutUnknownReason; readonly detail: string };

export type CloseThreshold = { readonly basisPoints: number };

/** `pct` is a percent: 1 means 1.0%, 100 basis points. Throws unless `pct >= 0` with at most 2 decimals. */
export function closeThresholdFromPercent(pct: number): CloseThreshold {
  const basisPoints = Math.round(pct * 100);
  if (!Number.isFinite(pct) || pct < 0 || Math.abs(pct * 100 - basisPoints) > 1e-9) {
    throw new RangeError(`closeThresholdFromPercent: ${String(pct)} is not a percent of 0 or more with at most 2 decimals`);
  }
  return { basisPoints };
}

function standardOf(text: string): TimeValue {
  const time = parseTimeText(text);
  if (time === null) throw new RangeError(`cutTag: standard "${text}" is not a time`);
  return time;
}

/** Hundredths of a legacy seconds value. The legacy seconds come from `n / 100`, so this is exact. */
function hundredthsOf(seconds: number): number {
  return Math.round(seconds * 100);
}

function gapFor(next: CutlineNextTierGap, swimHundredths: number): CutGap {
  const standard = standardOf(next.standardTime);
  const gapHundredths = swimHundredths - standard.hundredths;
  if (gapHundredths <= 0) throw new RangeError(`cutTag: next tier ${next.tier} is not slower than the swim`);
  return {
    tier: next.tier,
    standard,
    gapHundredths,
    gapBasisPoints: Math.floor((gapHundredths * 10000) / standard.hundredths),
    source: next.source,
  };
}

function achievedFields(r: Extract<CutlineTagResult, { state: 'tagged' }>): AchievedFields {
  const standard = standardOf(r.tag.standardTime);
  const swimHundredths = hundredthsOf(r.tag.swimSeconds);
  return {
    tier: r.tag.tier,
    slot: legacySlotForTier(r.tag.tier),
    standard,
    marginHundredths: standard.hundredths - swimHundredths,
    source: r.tag.source,
    nextTier: r.nextTier ? gapFor(r.nextTier, swimHundredths) : null,
  };
}

/** Every legacy state that maps to `unknown`, under its own name. */
type UnknownState = Extract<CutlineTagResult['state'], CutUnknownReason>;

/**
 * Map a legacy verdict. Exhaustive over `CutlineTagState`. `converted_estimate` maps to `converted`:
 * the legacy comparison used the unsourced gendered LCM factors, so it never earns an estimated tag.
 */
export function cutTagFromLegacy(r: CutlineTagResult, t: CloseThreshold): CutTag {
  switch (r.state) {
    case 'tagged':
      return { kind: 'achieved', ...achievedFields(r) };
    case 'no_cut': {
      if (r.swimSeconds === null || r.nextTier === null) return { kind: 'none', nearest: null };
      const nearest = gapFor(r.nextTier, hundredthsOf(r.swimSeconds));
      // Integers only: a float ratio reads a swim exactly 1.0% off as not close.
      return nearest.gapHundredths * 10000 <= t.basisPoints * nearest.standard.hundredths
        ? { kind: 'close', nearest, thresholdBasisPoints: t.basisPoints }
        : { kind: 'none', nearest };
    }
    case 'converted_estimate':
      return { kind: 'converted', indicative: r.indicative };
    case 'not_applicable':
      return { kind: 'not-applicable', reason: 'diving' };
    case 'division_unknown':
    case 'no_table_for_division':
    case 'event_not_in_table':
    case 'no_time':
    case 'program_discontinued':
    case 'gender_not_sponsored':
    case 'conversion_unavailable':
    case 'user_inputted':
    case 'extracted_split':
    case 'program_unconfirmed':
    case 'event_not_swum_in_course': {
      const reason: UnknownState = r.state;
      return { kind: 'unknown', reason, detail: r.reason };
    }
    default: {
      const never: never = r;
      throw new Error(`cutTagFromLegacy: unhandled state ${JSON.stringify(never)}`);
    }
  }
}

const unknown = (reason: CutUnknownReason, detail: string): CutTag => ({ kind: 'unknown', reason, detail });

/**
 * The cut tag for one swim.
 *
 * Order: an unknown division, then the swim's flags, then its yards statement. An unknown division is
 * never D1. A discontinued program, an unsponsored gender and an unaudited sponsorship are unknown,
 * never `none`. A `not-convertible` statement is unknown, never `none`.
 */
export function cutTagForSwim(swim: MeetSwim, swimmer: MeetSwimmer, team: MeetTeam, t: CloseThreshold): CutTag {
  const ref = team.division;
  if (ref.state === 'unknown') {
    const reason: CutUnknownReason = ref.reason === 'unmapped_team' ? 'division_unknown' : ref.reason;
    return unknown(reason, `The team's division is unknown (${ref.reason}).`);
  }
  if (swim.flags.userInputted) return unknown('user_inputted', 'The time was typed in, not taken from a meet result.');
  if (swim.flags.extractedSplit) return unknown('extracted_split', 'The time is an extracted split, not a swum race.');
  if (swim.flags.programUnconfirmed) return unknown('program_unconfirmed', 'The swim is not confirmed as a program swim.');
  // A season with no held table comes back from the legacy lookup as `no_table_for_division`. The list
  // of held seasons lives there only, so a new season needs no change here.
  const season = ref.season as CutlineSeason;
  const statement = swim.scy;
  if (statement.kind === 'not-convertible') {
    return unknown(
      statement.reason === 'event_not_swum_in_course' ? 'event_not_swum_in_course' : 'conversion_unavailable',
      `The swim has no yards time (${statement.reason}).`
    );
  }

  // A swim whose division publishes the swim's own course is judged there, as a real swim.
  if (swim.recordedCourse !== 'SCY') {
    const own = cutlineTableCourseForSwim(swimmer.gender, swim.eventKey, ref.division, swim.recordedCourse, season);
    if (own === swim.recordedCourse) {
      return cutTagFromLegacy(
        buildCutlineTag({
          timeSec: swim.recordedTime === null ? null : swim.recordedTime.hundredths / 100,
          gender: swimmer.gender,
          event: swim.eventKey,
          division: ref.division,
          season,
          swimCourse: swim.recordedCourse,
          tableCourse: own,
        }),
        t
      );
    }
  }

  if (statement.kind === 'recorded-scy') {
    return cutTagFromLegacy(
      buildCutlineTag({
        timeSec: swim.recordedTime === null ? null : swim.recordedTime.hundredths / 100,
        gender: swimmer.gender,
        event: swim.eventKey,
        division: ref.division,
        season,
        swimCourse: 'SCY',
      }),
      t
    );
  }

  // A converted time, judged as an SCY swim on the SCY event.
  const result = buildCutlineTag({
    timeSec: statement.hundredths / 100,
    gender: swimmer.gender,
    event: scyEventKeyFor(swim.eventKey, swim.recordedCourse),
    division: ref.division,
    season,
    swimCourse: 'SCY',
  });
  if (result.state === 'tagged') {
    return {
      kind: 'estimated-achieved',
      basis: statement.basis,
      convertedHundredths: statement.hundredths,
      ...achievedFields(result),
    };
  }
  if (result.state === 'no_cut') return { kind: 'converted', indicative: null };
  // A guard verdict (no table, event not in table, diving): the same as for a real swim.
  return cutTagFromLegacy(result, t);
}

/**
 * Fold the tags of one swimmer in one event (README R61). Pass tags for a single swimmer and a single
 * event: the function cannot check that.
 *
 * - A real `achieved` tag replaces an `estimated-achieved` tag of the same or a weaker standard.
 * - **Not decided by R61:** a real tag at a weaker standard than an estimated one. The fold keeps
 *   both, real first, and chooses neither. The caller shows both or asks the user.
 * - With no `achieved` tag, the strictest `estimated-achieved` tag stands.
 * - With neither, one tag stands: the first of `close`, `none`, `converted`, `unknown`,
 *   `not-applicable`. A real swim that missed does not remove an estimated tag.
 * - No tags give `[]`: absent, never `none`.
 *
 * Strictness is the standard's time (smaller is stricter), never the tier name.
 */
export function foldEventCutTags(tags: readonly CutTag[]): readonly CutTag[] {
  type Achieved = Extract<CutTag, { kind: 'achieved' | 'estimated-achieved' }>;
  const strictest = (kind: Achieved['kind']): Achieved | null => {
    let best: Achieved | null = null;
    for (const tag of tags) {
      if (tag.kind !== kind) continue;
      if (best === null || tag.standard.hundredths < best.standard.hundredths) best = tag;
    }
    return best;
  };
  const real = strictest('achieved');
  const estimated = strictest('estimated-achieved');
  if (real !== null) {
    return estimated !== null && estimated.standard.hundredths < real.standard.hundredths ? [real, estimated] : [real];
  }
  if (estimated !== null) return [estimated];
  for (const kind of ['close', 'none', 'converted', 'unknown', 'not-applicable'] as const) {
    const found = tags.find(tag => tag.kind === kind);
    if (found) return [found];
  }
  return [];
}
