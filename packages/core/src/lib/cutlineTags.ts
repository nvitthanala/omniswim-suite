/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Derived cut tags.
 *
 * A `CutlineTag` describes a cut a swim actually achieved. It is **always
 * derived** from the published tables in `packages/core/src/cutlines.ts` — there
 * is no way to hand-set one, no time literal in this file, and no label for a
 * tier a division does not publish (D1 has no A/B cut; its individual column is
 * a single `Standard`. NAIA prints `AUTOMATIC`/`PROVISIONAL`, not A/B).
 *
 * The point of this module is the distinction the UI has to render:
 *
 * | Reality                                   | `state`                 | UI |
 * | ----------------------------------------- | ----------------------- | -- |
 * | swim cleared a published standard         | `tagged`                | show the tag |
 * | judged against a real table, cleared none | `no_cut`                | show nothing |
 * | metric swim, converted time clears it     | `converted_estimate`    | show "indicative", visibly not a cut |
 * | metric swim, no published factor to convert | `conversion_unavailable` | show "unknown" |
 * | team's division is unknown                | `division_unknown`      | show "unknown" |
 * | no table held for that division/season    | `no_table_for_division` | show "unknown" |
 * | table exists but omits this event         | `event_not_in_table`    | show "unknown" |
 * | no usable time on the swim                | `no_time`               | show "unknown" |
 * | program was cut before the season         | `program_discontinued`  | show "unknown" |
 * | school fields no team of that gender      | `gender_not_sponsored`  | show "unknown" |
 *
 * Collapsing the bottom rows into "no cut" is the exact silent-empty failure
 * this round exists to eliminate. Use {@link cutlineTagRenderMode} to get the
 * four-way answer rather than testing `tag === null`.
 *
 * `converted_estimate` is the **course-eligibility** guard, and it is the reason
 * this module distinguishes two courses. User ruling (2026-07-25): *"no LCM data
 * for NCAA qualifications. Converted times are good for a 'loose' fit but you
 * need to record a yards swim under qualifying time to qualify or gain a
 * cutline."* Every NCAA table here is short-course yards, so an LCM or SCM swim
 * whose converted time beats a standard is informative and **not** a cut. It gets
 * its own state and its own render mode (`'indicative'`) so a UI can show the
 * loose fit while making it visibly not a badge — never `tagged`, and never
 * silently folded into `unknown`.
 *
 * `program_discontinued` is the anachronism guard. Lindenwood's last season was
 * 2023-2024; the newest D2 table we hold is 2026-2027. Judging that swim against
 * it would emit a confident badge for a standard the program never faced, so the
 * tag path refuses instead.
 *
 * `gender_not_sponsored` is the same refusal along the other axis. The
 * University of West Florida sponsors women's swimming & diving and no men's
 * team; its school-level status is nonetheless `active`, so before this state
 * existed a men's UWF swim was judged against the D2 men's table as though the
 * program were there to judge. Neither guard is a miss, and neither may render
 * as one.
 */

import {
  latestSeasonForDivision,
  type CutlineCourse,
  type CutlineGender,
  type CutlineSeason,
  type CutlineSourceRef,
  type CutlineTier,
  type SwimCutline,
} from '../cutlines';
import { Gender, NcaaDivision } from '../types';
import {
  programCompetedInSeason,
  programSponsorsGender,
  resolveTeamDivision,
  type SponsoredGender,
  type TeamDivisionOptions,
  type TeamProgramStatus,
  type TeamSeasonLabel,
} from '../data/teamDivisions';
import {
  courseOfRecordFromEventLabel,
  cutlineEventCategory,
  DEFAULT_CUTLINE_COURSE,
  getCutlinesForSwim,
  normalizeEventForCutline,
  nextStrictestTierNotAchieved,
  scyEquivalentForCutline,
  type CutlineLookup,
  type CutlineLookupStatus,
  type CutlineTierValue,
  type ScyEquivalentSwim,
  type SwimCourseOfRecord,
} from './cutlineUtils';
import { convertTimeToSeconds, formatSecondsToTime } from './utils';

/* -------------------------------------------------------------------------- */
/* The tag                                                                     */
/* -------------------------------------------------------------------------- */

export type CutlineTag = {
  /** The strictest published tier the swim cleared, under the source's own name. */
  tier: CutlineTier;
  division: NcaaDivision;
  season: CutlineSeason;
  course: CutlineCourse;
  gender: CutlineGender;
  /** Canonical event name the tag was resolved against. */
  event: string;
  /** Short display label, e.g. `D2 A CUT`, `D1 STANDARD`, `D3 INVITED`, `NAIA AUTO`. */
  label: string;
  /** Tooltip: governing body, division, season, tier and the published time. */
  title: string;
  /** The published standard the swim cleared, verbatim from the source. */
  standardTime: string;
  /** `standardTime` in seconds. Derived, never a source value. */
  standardSeconds: number;
  /** The swim's own time in seconds, as judged. */
  swimSeconds: number;
  /** Seconds under the standard. Always >= 0 for a tag that exists. */
  marginSeconds: number;
  /** Provenance URL of the PDF the standard came from. */
  sourceUrl: string;
  /** Full provenance block: source id, url, sha256, page. */
  source: CutlineSourceRef;
  /** The published record the tag was derived from. */
  entry: SwimCutline;
};

/* -------------------------------------------------------------------------- */
/* The result                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why a tag build ended where it did.
 *
 * The three {@link CutlineLookupStatus} values are passed through unchanged, so a
 * caller already switching on lookup status keeps working. `division_unknown`
 * and `no_time` are added because they are reachable here and are equally not
 * "the swimmer missed the cut".
 */
export type CutlineTagState =
  | 'tagged'
  | 'no_cut'
  | 'division_unknown'
  | 'no_table_for_division'
  | 'event_not_in_table'
  | 'no_time'
  | 'program_discontinued'
  | 'gender_not_sponsored'
  /** Diving is scored in points, not time — swim standards are a category error here. */
  | 'not_applicable'
  /**
   * The swim was recorded in metres and its **converted** yards equivalent clears
   * a published standard. Informative, never a cut: the standard is a yards
   * standard and only a yards swim earns it. Carries {@link CutlineTagResultBase.indicative}.
   */
  | 'converted_estimate'
  /**
   * The swim was recorded in metres and no published conversion factor covers it
   * (relays have none), or the label says "meters" without stating the pool
   * length. Not a miss — we could not put it on the same scale at all.
   */
  | 'conversion_unavailable';

/**
 * A converted-time comparison that deliberately falls short of being a cut.
 *
 * Everything here is derived: `convertedTime` comes from the single published
 * conversion-factor table via `convertSwimToSCY`, and `standardTime` is verbatim
 * from the NCAA/NAIA PDF. No number in this object is estimated.
 */
export type CutlineIndicativeComparison = {
  /** Course the swim was actually recorded in. Never `'SCY'`. */
  swimCourse: Exclude<SwimCourseOfRecord, 'SCY'>;
  /** Course of the table it was compared against (always `'SCY'` today). */
  tableCourse: CutlineCourse;
  /** The strictest tier the **converted** time would have cleared. */
  tier: CutlineTier;
  /** What that tier would have been called, e.g. `D2 A CUT`. */
  tierLabel: string;
  /**
   * Display label that must not read as an achieved cut, e.g.
   * `D2 A CUT (CONVERTED)`. A UI may restyle it, but must not drop the qualifier.
   */
  label: string;
  /** The swim as recorded, formatted. */
  recordedTime: string;
  /** Yards equivalent, from the published conversion factor. */
  convertedTime: string;
  /** {@link CutlineIndicativeComparison.convertedTime} in seconds. */
  convertedSeconds: number;
  /** The `CONVERSION_FACTORS` key that produced the conversion. Provenance. */
  factorEvent: string;
  /** Canonical event the converted swim was judged against. */
  event: string;
  /** The published standard, verbatim from the source. */
  standardTime: string;
  standardSeconds: number;
  /** Seconds the converted time is under the standard. Always > 0. */
  marginSeconds: number;
  sourceUrl: string;
  source: CutlineSourceRef;
  entry: SwimCutline;
};

/* -------------------------------------------------------------------------- */
/* Near-miss margin                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How far a swim fell short of the next standard it did not reach.
 *
 * This is **derived data, not a published value**: pure subtraction between one
 * real swim time and one published standard. The standard itself is carried
 * verbatim in {@link CutlineNextTierGap.standardTime} so a UI can show the basis
 * rather than a bare number.
 *
 * Which tier it points at:
 *
 * | Result state | Tier reported |
 * | --- | --- |
 * | `tagged` | the next tier **up** from the one achieved |
 * | `no_cut` | the easiest tier published — the one they came closest to |
 * | `converted_estimate` | same rule, measured on the converted yards time |
 *
 * **Absent, never zero.** The field is `null` when the swim already cleared the
 * strictest published tier, when there is no table, when the event is not
 * published, when the event is not timed (diving), and on every refusal state. A
 * `0` here would read as "exactly on the standard", which is a different and
 * much stronger claim.
 *
 * There is deliberately **no** "is this close?" threshold in core. What counts
 * as a near miss is a presentation decision; this module only reports the
 * distance.
 */
export type CutlineNextTierGap = {
  /** The unreached tier, under the source's own name. */
  tier: CutlineTier;
  /** Badge-style label for that tier, e.g. `D2 A CUT`, `D2 PROVISIONAL`. */
  label: string;
  /** Long form of the tier name for prose, e.g. `A`, `provisional`, `Invited`. */
  tierName: string;
  /** The published standard, verbatim from the source. Never computed. */
  standardTime: string;
  /** {@link CutlineNextTierGap.standardTime} in seconds. Derived. */
  standardSeconds: number;
  /**
   * The seconds actually compared. Equals the swim's own time, except on
   * `converted_estimate`, where it is the converted yards equivalent.
   */
  judgedSeconds: number;
  /**
   * Seconds the swim is short by. Always `> 0`.
   *
   * Rounded to hundredths (the precision every source publishes at) except when
   * rounding would collapse a real gap to `0`, in which case the exact
   * difference is kept — see the absent-never-zero rule above.
   */
  shortBySeconds: number;
  /** Canonical event the comparison was made in. */
  event: string;
  /** Provenance URL of the PDF the standard came from. */
  sourceUrl: string;
  /** Full provenance block for the standard. */
  source: CutlineSourceRef;
};

/**
 * The swimming & diving program a swim is attributed to.
 *
 * Supplied automatically by {@link buildCutlineTagForTeam} from the team
 * registry; pass it explicitly to {@link buildCutlineTag} when you resolved the
 * school yourself. Its job is to stop a swim being judged against a program that
 * was not there to swim it — either because the program no longer exists, or
 * because the school never fielded one for that gender.
 */
export type CutlineTagProgram = {
  /** Display name, used in the refusal reason. */
  team: string;
  status: TeamProgramStatus;
  /** Final season the program competed, for `status: 'discontinued'`. */
  lastActiveSeason?: TeamSeasonLabel;
  /**
   * Genders the school sponsors swimming & diving in, when recorded. Absent
   * means unrecorded and never refuses — see `programSponsorsGender`.
   */
  sponsoredGenders?: readonly SponsoredGender[];
};

/** Fields present on every result, tagged or not. */
type CutlineTagResultBase = {
  /** `null` when the caller could not supply one (unknown team). */
  division: NcaaDivision | null;
  /** `null` when no table was found for the division. */
  season: CutlineSeason | null;
  /**
   * Course of the **published table** that was consulted. Every NCAA table is
   * `SCY`; `METRIC_UNSPECIFIED` is the NAIA metric column.
   *
   * @deprecated Ambiguous name — it never meant the swim's own course. Use
   * {@link CutlineTagResultBase.tableCourse} (identical value) and
   * {@link CutlineTagResultBase.swimCourse}. Kept for existing callers.
   */
  course: CutlineCourse;
  /** Course of the published table that was consulted. Same value as `course`. */
  tableCourse: CutlineCourse;
  /**
   * Course the swim was actually **recorded** in — the axis that decides whether
   * a cut can be earned at all.
   *
   * `'METRIC_UNSPECIFIED'` means the event label said "meters" but never said
   * which pool length, so no conversion factor can be chosen honestly.
   */
  swimCourse: SwimCourseOfRecord | 'METRIC_UNSPECIFIED';
  /**
   * Present (and non-null) only on `state: 'converted_estimate'` — the loose fit
   * the converted time achieved, which is explicitly not a cut.
   */
  indicative?: CutlineIndicativeComparison | null;
  gender: CutlineGender;
  /** Canonical event name that was searched for. */
  event: string;
  /** The swim time in seconds, or `null` when it was missing/unparseable. */
  swimSeconds: number | null;
  /**
   * The underlying lookup status, or `null` when no lookup was attempted
   * (unknown division, unusable time).
   */
  lookupStatus: CutlineLookupStatus | null;
  /** Plain-English explanation, suitable for a tooltip on a non-tagged swim. */
  reason: string;
  /** The program the swim was attributed to, when the caller supplied one. */
  program?: CutlineTagProgram | null;
  /**
   * Distance to the next published tier the swim did not reach, or `null`.
   *
   * Populated on `tagged`, `no_cut` and `converted_estimate`; `null` on every
   * other state, and `null` on a swim that already cleared the strictest tier.
   * **Absent, never zero** — see {@link CutlineNextTierGap}.
   *
   * Present-and-null rather than optional: a swim that made every cut and a swim
   * we could not judge are both "no margin to report", and neither may render as
   * a zero-second gap.
   */
  nextTier: CutlineNextTierGap | null;
};

export type CutlineTagResult = CutlineTagResultBase &
  (
    | { state: 'tagged'; tag: CutlineTag }
    | { state: 'converted_estimate'; tag: null; indicative: CutlineIndicativeComparison }
    | {
        state: Exclude<CutlineTagState, 'tagged' | 'converted_estimate'>;
        tag: null;
      }
  );

/**
 * The four states a UI must render, collapsed from {@link CutlineTagState}.
 *
 * - `tag` — render the badge. The swim earned this cut.
 * - `no_cut` — render nothing; this is a real, judged miss.
 * - `indicative` — render a visibly-not-a-cut affordance. A metric swim's
 *   converted yards equivalent clears the standard: useful as a loose fit, but
 *   the cut is only earned by a yards swim. Details are in
 *   {@link CutlineTagResultBase.indicative}. It is deliberately **not**
 *   `unknown` — we judged this swim precisely; the answer is "not eligible",
 *   not "we don't know" — and deliberately not `tag`.
 * - `unknown` — render an "unknown" affordance. We could not judge this swim,
 *   and rendering it as a miss would be a lie.
 */
export type CutlineTagRenderMode = 'tag' | 'no_cut' | 'unknown' | 'indicative';

export function cutlineTagRenderMode(result: CutlineTagResult): CutlineTagRenderMode {
  if (result.state === 'tagged') return 'tag';
  if (result.state === 'no_cut') return 'no_cut';
  if (result.state === 'converted_estimate') return 'indicative';
  return 'unknown';
}

/**
 * True when the swim was judged against a real published table **and** the
 * verdict settles whether a cut was achieved.
 *
 * `converted_estimate` is false here on purpose: a converted time neither earns
 * the cut nor proves the swimmer cannot make it in yards.
 */
export function isCutlineTagConclusive(result: CutlineTagResult): boolean {
  return result.state === 'tagged' || result.state === 'no_cut';
}

/** The `reason` string, for callers that want a tooltip without switching on state. */
export function describeCutlineTagResult(result: CutlineTagResult): string {
  return result.state === 'tagged' ? result.tag.title : result.reason;
}

/* -------------------------------------------------------------------------- */
/* Labelling — division-aware, never inventing a tier a source does not print  */
/* -------------------------------------------------------------------------- */

/** `NCAA D2`, `NCAA D1`, `NAIA`. */
export function governingBodyLabel(division: NcaaDivision): string {
  return division === 'NAIA' ? 'NAIA' : `NCAA ${division}`;
}

function courseLabel(course: CutlineCourse): string {
  switch (course) {
    case 'SCY':
      return 'yards';
    case 'SCM':
      return 'short-course metres';
    case 'LCM':
      return 'long-course metres';
    case 'METRIC_UNSPECIFIED':
      return 'metres';
  }
}

/**
 * What one division calls one tier.
 *
 * `short` goes on the badge, `long` into the tooltip sentence. NAIA gets its own
 * wording because its sheet publishes `AUTOMATIC`/`PROVISIONAL`; calling those
 * "A" and "B" would be putting NCAA vocabulary on an NAIA standard.
 */
export function cutlineTierNaming(
  division: NcaaDivision,
  tier: CutlineTier
): { short: string; long: string } {
  if (division === 'NAIA') {
    if (tier === 'A') return { short: 'AUTO', long: 'automatic' };
    if (tier === 'B') return { short: 'PROV', long: 'provisional' };
  }
  switch (tier) {
    case 'A':
      return { short: 'A CUT', long: 'A' };
    case 'B':
      return { short: 'B CUT', long: 'B' };
    case 'Invited':
      return { short: 'INVITED', long: 'Invited' };
    case 'Standard':
      return { short: 'STANDARD', long: 'qualifying' };
    case 'Qualifying':
      return { short: 'QUALIFYING', long: 'qualifying' };
    case 'Provisional':
      return { short: 'PROVISIONAL', long: 'provisional' };
  }
}

function buildLabel(division: NcaaDivision, tier: CutlineTier): string {
  return `${division} ${cutlineTierNaming(division, tier).short}`;
}

function buildTitle(
  division: NcaaDivision,
  season: CutlineSeason,
  course: CutlineCourse,
  tier: CutlineTier,
  standardTime: string
): string {
  const { long } = cutlineTierNaming(division, tier);
  const base = `${governingBodyLabel(division)} ${season} ${long} standard — ${standardTime}`;
  return course === DEFAULT_CUTLINE_COURSE ? base : `${base} (${courseLabel(course)})`;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

export type CutlineTagInput = {
  /** Time in seconds. Supply this or {@link CutlineTagInput.time}. */
  timeSec?: number | null;
  /** Time as entered, in `SS.hh` or `M:SS.hh` form. Parsed if `timeSec` is absent. */
  time?: string | null;
  gender: Gender | string;
  event: string;
  /**
   * `null` is a first-class input: it is what
   * `divisionForTeamOrNull` returns for an unmapped team, and it yields
   * `state: 'division_unknown'` rather than a default division.
   */
  division: NcaaDivision | null | undefined;
  /** Defaults to the newest season published for `division`. */
  season?: CutlineSeason;
  /**
   * Course of the **published table to look up**. Defaults to `SCY` — every NCAA
   * table is short-course yards. Use `METRIC_UNSPECIFIED` for the NAIA metric
   * column.
   *
   * @deprecated Ambiguous name: it is the table's course, never the swim's. Use
   * {@link CutlineTagInput.tableCourse} together with
   * {@link CutlineTagInput.swimCourse} so the difference is legible at the call
   * site. Still honoured when `tableCourse` is absent.
   */
  course?: CutlineCourse;
  /** Course of the **published table to look up**. Defaults to `SCY`. */
  tableCourse?: CutlineCourse;
  /**
   * Course the swim was actually **recorded** in — `HistoricalSwim.timeType`.
   *
   * This is the eligibility axis, not the lookup axis. Only an `SCY` swim can
   * earn an NCAA cut; an `LCM`/`SCM` swim gets `state: 'converted_estimate'` at
   * best.
   *
   * Omit it and the course is read off the event label
   * (`courseOfRecordFromEventLabel`); a label that states nothing defaults to
   * `SCY`, because `SwimmerResult` has no course field at all and every meet
   * result in `data/meets.json` is short-course yards. Pass it explicitly
   * whenever you have `HistoricalSwim.timeType` — a label reading "50 Meter
   * Freestyle" proves the swim was metric but not which pool.
   *
   * `'METRIC_UNSPECIFIED'` is accepted so a caller that knows only "this was
   * metric" can say so and get `conversion_unavailable`, instead of the value
   * being dropped and the swim silently judged as yards. This is a widening of
   * the previously-accepted `SwimCourseOfRecord`; every existing caller still
   * type-checks.
   */
  swimCourse?: SwimCourseOfRecord | 'METRIC_UNSPECIFIED';
  /**
   * The program this swim belongs to. When it names a discontinued program that
   * had already stopped competing before the season being compared against, the
   * result is `state: 'program_discontinued'` and no badge is emitted.
   */
  program?: CutlineTagProgram | null;
};

function normalizeGender(gender: Gender | string): CutlineGender {
  return gender === Gender.WOMEN || gender === 'Women' ? 'Women' : 'Men';
}

/** Hundredths — the precision every source publishes at. */
function roundToHundredths(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/**
 * Build the near-miss margin for a completed lookup, or `null`.
 *
 * `null` covers every case where there is nothing honest to report: the lookup
 * did not reach a real table, the event is not timed, the time is unusable, or
 * the swim already cleared the strictest published tier. It never reports `0`.
 */
function buildNextTierGap(
  lookup: CutlineLookup,
  division: NcaaDivision,
  judgedSeconds: number
): CutlineNextTierGap | null {
  if (lookup.status !== 'ok' || !lookup.entry) return null;
  const target: CutlineTierValue | null = nextStrictestTierNotAchieved(
    lookup.tiers,
    judgedSeconds
  );
  if (!target) return null;
  const exact = judgedSeconds - target.seconds;
  const rounded = roundToHundredths(exact);
  return {
    tier: target.tier,
    label: buildLabel(division, target.tier),
    tierName: cutlineTierNaming(division, target.tier).long,
    standardTime: target.time,
    standardSeconds: target.seconds,
    judgedSeconds,
    // Rounding must not manufacture "exactly on the standard" out of a real gap.
    shortBySeconds: rounded > 0 ? rounded : exact,
    event: lookup.event,
    sourceUrl: lookup.entry.source.url,
    source: lookup.entry.source,
  };
}

/**
 * The course this swim was recorded in.
 *
 * Order: an explicit `swimCourse` (i.e. `HistoricalSwim.timeType`) wins; then
 * whatever the event label states; then `SCY`.
 *
 * The `SCY` default is not an assumption about swimming in general — it is a
 * fact about this repo's data. `SwimmerResult` (meet results) has **no** course
 * field, and every event label in `data/meets.json` is short-course yards. A
 * source that can be metric (`HistoricalSwim`) does carry `timeType`, and
 * callers must thread it.
 */
function resolveSwimCourse(input: CutlineTagInput): SwimCourseOfRecord | 'METRIC_UNSPECIFIED' {
  if (input.swimCourse) return input.swimCourse;
  const labelled = courseOfRecordFromEventLabel(input.event);
  if (labelled) return labelled;
  return 'SCY';
}

function resolveSeconds(input: CutlineTagInput): number | null {
  if (typeof input.timeSec === 'number' && Number.isFinite(input.timeSec) && input.timeSec > 0) {
    return input.timeSec;
  }
  if (typeof input.time === 'string' && input.time.trim()) {
    // convertTimeToSeconds returns Infinity for NT/DQ — absent, not zero.
    const sec = convertTimeToSeconds(input.time.trim());
    if (Number.isFinite(sec) && sec > 0) return sec;
  }
  return null;
}

/**
 * Build the tag for one swim, or explain why there is none.
 *
 * Never returns a bare `null`: the result always carries a `state` so the caller
 * can tell a genuine miss from an unjudgeable swim.
 */
/**
 * The season a swim would be judged against, before any table lookup.
 *
 * Mirrors what `getCutlinesForSwim` will resolve, so the anachronism check and
 * the lookup agree on which season is at stake. `null` when there is no division
 * to pick a season for, or the division publishes nothing here.
 */
function seasonUnderComparison(
  division: NcaaDivision | null,
  season: CutlineSeason | undefined
): CutlineSeason | null {
  if (season) return season;
  return division ? latestSeasonForDivision(division) : null;
}

function programDiscontinuedReason(
  program: CutlineTagProgram,
  season: CutlineSeason | null
): string {
  const ended = program.lastActiveSeason
    ? ` after ${program.lastActiveSeason}`
    : ' (final season not recorded)';
  const against = season
    ? `no ${season} standard applies`
    : 'no qualifying table held here covers a season it competed in';
  return `${program.team} discontinued swimming & diving${ended}; ${against}.`;
}

function genderNotSponsoredReason(
  program: CutlineTagProgram,
  gender: CutlineGender
): string {
  const sponsored = (program.sponsoredGenders ?? []).map(g => `${g.toLowerCase()}’s`);
  const instead = sponsored.length
    ? `it sponsors ${sponsored.join(' and ')} only`
    : 'it sponsors neither';
  return `${program.team} does not sponsor ${gender.toLowerCase()}’s swimming & diving — ${instead}, so there is no program for this swim to be judged against.`;
}

export function buildCutlineTag(input: CutlineTagInput): CutlineTagResult {
  const gender = normalizeGender(input.gender);
  // `tableCourse` is the new, unambiguous name; `course` is the legacy field and
  // still wins nothing over it. Both are reported back so old readers keep working.
  const tableCourse = input.tableCourse ?? input.course ?? DEFAULT_CUTLINE_COURSE;
  const swimCourse = resolveSwimCourse(input);
  const courseFields = { course: tableCourse, tableCourse, swimCourse };
  const division = input.division ?? null;
  const swimSeconds = resolveSeconds(input);
  const program = input.program ?? null;

  // Anachronism guard, ahead of everything else: a program that no longer
  // exists cannot be measured against a season it never swam, and saying so is
  // more useful than "division unknown".
  if (program) {
    const comparisonSeason = seasonUnderComparison(division, input.season);
    if (!programCompetedInSeason(program, comparisonSeason ?? '')) {
      return {
        state: 'program_discontinued',
        tag: null,
        division,
        season: comparisonSeason,
        ...courseFields,
        gender,
        event: input.event,
        swimSeconds,
        lookupStatus: null,
        reason: programDiscontinuedReason(program, comparisonSeason),
        program,
        nextTier: null,
      };
    }

    // The same refusal along the gender axis. A school can be unambiguously
    // active and still field no team for this swim's gender — UWF sponsors
    // women's swimming & diving only — and the men's table has nothing to say
    // about a men's program that does not exist.
    if (!programSponsorsGender(program, gender)) {
      return {
        state: 'gender_not_sponsored',
        tag: null,
        division,
        season: comparisonSeason,
        ...courseFields,
        gender,
        event: input.event,
        swimSeconds,
        lookupStatus: null,
        reason: genderNotSponsoredReason(program, gender),
        program,
        nextTier: null,
      };
    }
  }

  if (!division) {
    return {
      state: 'division_unknown',
      tag: null,
      division: null,
      season: null,
      ...courseFields,
      gender,
      event: input.event,
      swimSeconds,
      lookupStatus: null,
      reason:
        "This team's division is not known, so there is no table to judge this swim against.",
      program,
      nextTier: null,
    };
  }

  if (swimSeconds === null) {
    return {
      state: 'no_time',
      tag: null,
      division,
      season: null,
      ...courseFields,
      gender,
      event: input.event,
      swimSeconds: null,
      lookupStatus: null,
      reason: 'No usable time on this swim, so no standard can be applied.',
      program,
      nextTier: null,
    };
  }

  /*
   * Course eligibility.
   *
   * A cut belongs to the course it was published in. `tableCourse` says which
   * table we are reading; `swimCourse` says which pool the swim happened in.
   * When they are the same, nothing below changes and the swim is judged
   * directly — that is every existing caller, because `swimCourse` defaults to
   * SCY and `tableCourse` defaults to SCY.
   *
   * When a metric swim meets a yards table, we convert **for information only**.
   * The converted time can reach `converted_estimate`; it can never reach
   * `tagged`. Diving is left to the normal path so it still answers
   * `not_applicable` rather than a conversion complaint.
   */
  const convertingToYards =
    tableCourse === DEFAULT_CUTLINE_COURSE &&
    swimCourse !== 'SCY' &&
    cutlineEventCategory(input.event) === 'swim';

  let converted: ScyEquivalentSwim | null = null;
  if (convertingToYards) {
    if (swimCourse === 'METRIC_UNSPECIFIED') {
      // The label proves the swim was not yards but not which pool length, and
      // the LCM and SCM factors differ materially. Refuse rather than pick one.
      return {
        state: 'conversion_unavailable',
        tag: null,
        division,
        season: seasonUnderComparison(division, input.season),
        ...courseFields,
        gender,
        event: normalizeEventForCutline(input.event),
        swimSeconds,
        lookupStatus: null,
        reason: `"${input.event}" is recorded in metres but does not state the pool length, so there is no published factor to convert it to yards. Record the swim's course (LCM or SCM) for an indicative comparison.`,
        program,
        nextTier: null,
      };
    }
    converted = scyEquivalentForCutline(input.event, swimSeconds, gender, swimCourse);
    if (!converted) {
      return {
        state: 'conversion_unavailable',
        tag: null,
        division,
        season: seasonUnderComparison(division, input.season),
        ...courseFields,
        gender,
        event: normalizeEventForCutline(input.event),
        swimSeconds,
        lookupStatus: null,
        reason: `No published yards conversion factor covers ${normalizeEventForCutline(
          input.event
        )}, so this ${swimCourse} swim cannot be compared to the ${governingBodyLabel(
          division
        )} yards table.`,
        program,
        nextTier: null,
      };
    }
  }

  // The event to look up, and the seconds to judge, both follow the conversion.
  // A metric 400 Freestyle competes in the yards 500 Freestyle slot.
  const lookupEvent = converted ? converted.event : input.event;
  const judgedSeconds = converted ? converted.seconds : swimSeconds;

  const lookup = getCutlinesForSwim(gender, lookupEvent, division, input.season, tableCourse);
  const base: CutlineTagResultBase = {
    division,
    season: lookup.season,
    ...courseFields,
    gender,
    event: lookup.event,
    swimSeconds,
    lookupStatus: lookup.status,
    reason: '',
    program,
    // One computation serves all three judged outcomes: on `tagged` the slowest
    // unreached tier *is* the next tier up, on `no_cut` it is the easiest tier
    // published, and on `converted_estimate` it is the same question asked of the
    // converted time (`judgedSeconds` already follows the conversion). Returns
    // `null`, never `0`, when every tier was cleared or no table was reached.
    nextTier: buildNextTierGap(lookup, division, judgedSeconds),
  };

  if (lookup.status === 'no_table_for_division') {
    return {
      ...base,
      state: 'no_table_for_division',
      tag: null,
      reason: `No published qualifying table is held for ${governingBodyLabel(division)}${
        input.season ? ` ${input.season}` : ''
      }.`,
    };
  }

  // Diving must be caught before the event lookup verdicts: a points total is not
  // a slow time, and reporting it as "no standard cleared" would be inaccurate.
  if (lookup.status === 'not_a_timed_event') {
    return {
      ...base,
      state: 'not_applicable',
      tag: null,
      reason: `${lookup.event} is scored in points, not time — swim standards do not apply.`,
    };
  }

  if (lookup.status === 'event_not_in_table') {
    return {
      ...base,
      state: 'event_not_in_table',
      tag: null,
      reason: `${governingBodyLabel(division)} ${lookup.season ?? ''} does not publish a standard for ${
        lookup.event
      }.`.replace(/\s+/g, ' '),
    };
  }

  // `tiers` is ordered strictest first, so the first cleared tier is the best.
  const met = lookup.tiers.find(t => t.seconds > 0 && judgedSeconds <= t.seconds);
  const season = lookup.season;
  if (!met || !lookup.entry || !season) {
    // A metric swim that misses even on its converted time is a genuine miss —
    // the user's ruling only bars a converted time from *earning* a cut.
    const how = converted
      ? ` on its converted yards equivalent ${converted.time} (${converted.swimCourse} ${formatSecondsToTime(
          swimSeconds
        )})`
      : '';
    return {
      ...base,
      state: 'no_cut',
      tag: null,
      reason: `Judged against ${governingBodyLabel(division)} ${
        season ?? ''
      }${how} — no standard cleared.`.replace(/\s+/g, ' '),
    };
  }

  if (converted) {
    // The converted time clears a published standard. Report exactly that, and
    // refuse the badge: the standard is a yards standard.
    const { long } = cutlineTierNaming(division, met.tier);
    const tierLabel = buildLabel(division, met.tier);
    const indicative: CutlineIndicativeComparison = {
      swimCourse: converted.swimCourse as Exclude<SwimCourseOfRecord, 'SCY'>,
      tableCourse,
      tier: met.tier,
      tierLabel,
      label: `${tierLabel} (CONVERTED)`,
      recordedTime: formatSecondsToTime(swimSeconds),
      convertedTime: converted.time,
      convertedSeconds: converted.seconds,
      factorEvent: converted.factorEvent,
      event: lookup.event,
      standardTime: met.time,
      standardSeconds: met.seconds,
      marginSeconds: Math.round((met.seconds - converted.seconds) * 100) / 100,
      sourceUrl: lookup.entry.source.url,
      source: lookup.entry.source,
      entry: lookup.entry,
    };
    return {
      ...base,
      state: 'converted_estimate',
      tag: null,
      indicative,
      reason:
        `This ${converted.swimCourse} swim (${indicative.recordedTime}) converts to ${converted.time} yards, ` +
        `which would clear the ${governingBodyLabel(division)} ${season} ${long} standard of ${met.time}. ` +
        `Indicative only: a cut must be recorded in short-course yards, so a yards swim under ${met.time} is required to earn it.`,
    };
  }

  const tag: CutlineTag = {
    tier: met.tier,
    division,
    season,
    // `CutlineTag.course` is the table's course. A tag only exists when the swim
    // was eligible for that table, so there is no second course to carry here.
    course: tableCourse,
    gender,
    event: lookup.event,
    label: buildLabel(division, met.tier),
    title: buildTitle(division, season, tableCourse, met.tier, met.time),
    standardTime: met.time,
    standardSeconds: met.seconds,
    swimSeconds,
    marginSeconds: Math.round((met.seconds - swimSeconds) * 100) / 100,
    sourceUrl: lookup.entry.source.url,
    source: lookup.entry.source,
    entry: lookup.entry,
  };

  return { ...base, state: 'tagged', tag };
}

export type CutlineTagForTeamInput = Omit<CutlineTagInput, 'division'> & {
  team: string;
  /** Passed through to `resolveTeamDivision`, e.g. workspace division overrides. */
  teamOptions?: TeamDivisionOptions;
  /**
   * Explicit division that wins over the team lookup. Pass the athlete's own
   * division in a mixed-division meet.
   */
  division?: NcaaDivision | null;
};

/**
 * Build a tag from a team name, resolving the division strictly.
 *
 * An unmapped team yields `state: 'division_unknown'` — it is never scored
 * against a defaulted table. A team whose swimming & diving program has been
 * discontinued yields `state: 'program_discontinued'`, even when the caller
 * supplied an explicit `division`: the school being D1 on paper does not make a
 * 2026-2027 standard applicable to a program that stopped competing in
 * 2023-2024. A swim whose gender the school does not sponsor yields
 * `state: 'gender_not_sponsored'` on the same terms — an explicit `division`
 * says which table would apply, not that UWF fields a men's team.
 */
export function buildCutlineTagForTeam(input: CutlineTagForTeamInput): CutlineTagResult {
  const { team, teamOptions, division, program, ...rest } = input;
  const resolved = resolveProgramForTeam(team, teamOptions, program);
  return buildCutlineTag({
    ...rest,
    division: division ?? resolved.division,
    program: resolved.program,
  });
}

/**
 * Team → `{ division, program }`, shared by the individual and relay entry
 * points so both refuse a discontinued or unsponsored program identically.
 */
function resolveProgramForTeam(
  team: string,
  teamOptions: TeamDivisionOptions | undefined,
  program: CutlineTagProgram | null | undefined
): { division: NcaaDivision | null; program: CutlineTagProgram | null } {
  const resolution = resolveTeamDivision(team, teamOptions);
  const resolvedProgram: CutlineTagProgram | null =
    program ??
    (resolution.entry
      ? {
          team: resolution.canonicalTeam ?? resolution.team,
          status: resolution.status,
          ...(resolution.lastActiveSeason
            ? { lastActiveSeason: resolution.lastActiveSeason }
            : {}),
          ...(resolution.sponsoredGenders
            ? { sponsoredGenders: resolution.sponsoredGenders }
            : {}),
        }
      : null);
  return { division: resolution.division, program: resolvedProgram };
}

/* -------------------------------------------------------------------------- */
/* Relay rows carry two verdicts, not one                                      */
/* -------------------------------------------------------------------------- */

/**
 * The relay-leg input, minus the single-swim time/event fields it replaces.
 *
 * A relay leg row is two facts at once and the caller must not be made to pick
 * one: the **relay team** either made the relay standard or it did not, and —
 * for an eligible leg only — the **split** either made an individual standard or
 * it did not. Both can be true; both can be false; they are independent.
 *
 * The eligibility rule itself is deliberately **not** implemented here.
 * `relaySplitQualificationCutEvent(res)` lives in `lib/utils.ts`, which imports
 * from this side of the graph, so importing it back would create a cycle. The
 * caller runs it and passes the answer in as
 * {@link RelaySwimTagInput.legQualificationEvent}. There is exactly one
 * implementation of that rule and this module is not a second one.
 */
export type RelaySwimTagInput = Omit<CutlineTagInput, 'time' | 'timeSec' | 'event'> & {
  /**
   * The relay event as recorded, e.g. `Event 20 Men 4x100 Yard Medley Relay`.
   * Normalized internally (`4x100 … Medley Relay` → `400 Medley Relay`).
   */
  relayEvent: string;
  /**
   * The relay **team** time — `SwimmerResult.relayTeamTime ?? finalsTime ?? time`.
   * The caller resolves that fallback chain; this module does not guess which
   * field holds the team clock. Absent yields `state: 'no_time'` on the relay
   * verdict, never a zero.
   */
  relayTeamTime?: string | null;
  /** The relay team time in seconds, if the caller already parsed it. Wins over the string. */
  relayTeamTimeSec?: number | null;
  /**
   * The individual event this leg is eligible for, from
   * `relaySplitQualificationCutEvent(res)` — e.g. `100 Backstroke` for the
   * backstroke leadoff of a 400 medley relay. `null`/omitted means "not
   * eligible", and yields `legQualification: null`.
   */
  legQualificationEvent?: string | null;
  /** This leg's split — `SwimmerResult.relayLegSplit`. */
  legSplit?: string | null;
  /** This leg's split in seconds, if already parsed. Wins over the string. */
  legSplitSec?: number | null;
};

/**
 * Both verdicts for one relay row. Independently addressable, independently
 * `null`-able — neither may overwrite the other.
 */
export type RelaySwimTagResults = {
  /**
   * The relay **team** time judged against the relay standard. Always present:
   * even an unjudgeable relay comes back with a `state` explaining why.
   *
   * D2 relays publish a provisional standard only — the NCAA prints `N/A` in the
   * qualifying column — so a D2 relay can reach `Provisional` and nothing
   * stricter. No A tier is synthesized for it, and `nextTier` on a D2 relay that
   * makes provisional is `null` rather than a manufactured gap to a tier that
   * does not exist.
   */
  relay: CutlineTagResult;
  /**
   * This leg's split judged against an individual standard, or `null` when the
   * leg is not eligible: a non-backstroke leg, a relay whose leadoff has no
   * published individual standard (the 200 medley relay leadoff would need a 50
   * Backstroke standard, which no table held here publishes), or no split
   * recorded on the row.
   *
   * `null` means "this question does not apply to this row" — it is not a miss
   * and must not render as one.
   */
  legQualification: CutlineTagResult | null;
};

function firstUsableTime(
  seconds: number | null | undefined,
  time: string | null | undefined
): { timeSec?: number | null; time?: string | null } | null {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return { timeSec: seconds };
  }
  if (typeof time === 'string' && time.trim()) return { time: time.trim() };
  return null;
}

/**
 * Build both verdicts for a relay row.
 *
 * The bug this replaces: a caller that had to choose one event name for the row
 * chose the leg's individual event on the leadoff, so the leadoff swimmer's row
 * silently lost the fact that the relay made the cut. Nothing here chooses.
 *
 * The relay verdict is judged on the **team** time against the normalized relay
 * event; the leg verdict on the **split** against the individual event the
 * caller supplied. Neither is derived from the other, and a failure on one side
 * (no team time, no split, unpublished event) leaves the other side untouched.
 */
export function buildRelaySwimTags(input: RelaySwimTagInput): RelaySwimTagResults {
  const {
    relayEvent,
    relayTeamTime,
    relayTeamTimeSec,
    legQualificationEvent,
    legSplit,
    legSplitSec,
    ...rest
  } = input;

  const relayTime = firstUsableTime(relayTeamTimeSec, relayTeamTime);
  const relay = buildCutlineTag({
    ...rest,
    event: relayEvent,
    // No usable team time is `no_time`, which is what an absent clock means.
    ...(relayTime ?? { timeSec: null }),
  });

  const legEvent = String(legQualificationEvent ?? '').trim();
  if (!legEvent) return { relay, legQualification: null };

  const legTime = firstUsableTime(legSplitSec, legSplit);
  // An eligible leg with no split recorded is still "not applicable": there is
  // no leg time to judge, and reporting `no_time` here would imply the row was
  // supposed to carry an individual verdict.
  if (!legTime) return { relay, legQualification: null };

  /*
   * Course of record has to be carried across by hand. The leg is judged under
   * an individual event name (`100 Backstroke`) that no longer contains the
   * relay label's course words, so without this a metric relay's leadoff would
   * fall through to the SCY default and be badged as a yards cut.
   */
  const legSwimCourse = rest.swimCourse ?? courseOfRecordFromEventLabel(relayEvent) ?? undefined;

  return {
    relay,
    legQualification: buildCutlineTag({
      ...rest,
      event: legEvent,
      ...(legSwimCourse ? { swimCourse: legSwimCourse } : {}),
      ...legTime,
    }),
  };
}

export type RelaySwimTagsForTeamInput = Omit<RelaySwimTagInput, 'division'> & {
  team: string;
  /** Passed through to `resolveTeamDivision`, e.g. workspace division overrides. */
  teamOptions?: TeamDivisionOptions;
  /** Explicit division that wins over the team lookup. */
  division?: NcaaDivision | null;
};

/**
 * {@link buildRelaySwimTags} with the division and program resolved from a team
 * name, on exactly the terms {@link buildCutlineTagForTeam} uses — so a
 * discontinued or unsponsored program refuses on both verdicts rather than one.
 */
export function buildRelaySwimTagsForTeam(
  input: RelaySwimTagsForTeamInput
): RelaySwimTagResults {
  const { team, teamOptions, division, program, ...rest } = input;
  const resolved = resolveProgramForTeam(team, teamOptions, program);
  return buildRelaySwimTags({
    ...rest,
    division: division ?? resolved.division,
    program: resolved.program,
  });
}
