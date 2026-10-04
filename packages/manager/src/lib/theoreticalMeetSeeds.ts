/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase B4, part 1: turn several crawled teams into psych-sheet rows for a
 * theoretical meet. Pure functions only. No React, no fetch, no storage.
 *
 * Design: `docs/reference/SWIMCLOUD_MULTI_TEAM_CRAWL_PLAN.md`, "Phase B4 design
 * (decided 2026-10-04)". Every rule below is a user decision from that section.
 *
 * ## The rules
 *
 * 1. **Seed = all-time best, in the meet's course.** The roster season picks
 *    WHO is on the team. It never filters times. A seed counts only when the
 *    swim's recorded course equals the meet course. A swim with no recorded
 *    course is never used (it is not assumed to be yards). No conversion
 *    between courses is applied to a seed, ever.
 * 2. **Absent is not zero.** An event with no seed gets no row. An athlete with
 *    no captured times page is reported as `athletesWithNoTimes`. A times page
 *    that did not parse is `athletesWithTimesParseFailed`. A captured page with
 *    nothing usable is reported with its reason. An empty roster must be
 *    stated as `no_rosters_found`. Nothing is dropped without a trace.
 * 3. **Entries follow the scoring rules.** The events come from the existing
 *    selector, {@link categorizeBestEvents} (strength order: place in a loaded
 *    meet, then distance to the division cut, then raw seconds), and the caps
 *    come from {@link canAcceptAnotherEntry}. That is the same pair the roster
 *    optimizer uses (`addAthleteEventPlans` in `rosterOptimizer.ts`), on the
 *    same merged settings (`mergeScoringSettings` with the conference). This
 *    file holds no second selector and no second cap counter.
 * 4. **One swimmer, one team.** The same SwimCloud swimmer id on two rosters
 *    enters for the first team given. The other team reports it as
 *    `duplicateAcrossTeams`. Two names that match, with no shared id, are not
 *    merged across teams.
 * 5. **One name, one swimmer, on one team.** Psych scoring keys an entry on
 *    event, team and normalized name (`entryKey` in `prelimsProjection.ts`), so
 *    two athletes of one name on one team would collapse into one entry. The
 *    builder throws `name-collision-in-team` instead of merging or choosing.
 * 6. **Fail loudly.** Bad input throws {@link TheoreticalMeetError}.
 *
 * ## Only SCY meets are built (decision D1, 2026-10-04)
 *
 * `categorizeBestEvents` ranks events on SCY seconds against the SCY division
 * cut tables. A metric swim can only enter that ranking as a conversion
 * estimate. For an LCM or SCM meet there is no in-course ranking that uses no
 * conversion and no cut, so the builder refuses those courses
 * (`course-not-supported`) instead of ranking on an estimate. The course type
 * and the course list stay, so the follow-up needs no API change.
 *
 * ### Follow-up design (not built)
 *
 * Rank a swimmer's events by the place the seed takes in the theoretical field
 * itself: for each event, sort every entrant's seed in that event, and use the
 * rank (or rank over field size). Compare raw in-course times within ONE event
 * only. Use no conversion and no cut table, so the ranking needs nothing that is
 * not in the captured, in-course data.
 *
 * ## Row ids and provenance
 *
 * `SwimmerResult` has no field for a source, and this phase may not edit core,
 * so provenance rides in a parallel `Map` keyed by row id
 * ({@link TheoreticalMeetSeeds.sources}). A row id is
 * `tmseed|meet|gender|team|swimmer|event`, every part URI-encoded. The meet id
 * is part of it because psych result ids are primary keys across all
 * workspaces (`psych_results.id TEXT PRIMARY KEY`). The swimmer part is
 * `sc:{SwimCloud id}`, or `nm:{normalized name}` when the roster gave no id
 * (a name is unique on a team by rule 5). The same input always makes the same
 * ids.
 */

import { Gender } from '@omniswim/core/types';
import type { HistoricalSwim, ScoringSettings, SwimmerResult } from '@omniswim/core/types';
import { categorizeBestEvents, swimEventIdentity } from '@omniswim/core/lib/athleteHistory';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { canAcceptAnotherEntry, type SwimmerEntryCounts } from '@omniswim/core/lib/swimmerEntryLimits';
import { isDivingEvent, normalizeSwimmerName } from '@omniswim/core/lib/utils';
import type { SwimCloudAthlete } from '@omniswim/swimcloud/entities';

/* -------------------------------------------------------------------------- */
/* Courses, errors                                                             */
/* -------------------------------------------------------------------------- */

/** The three courses the codebase names (`HistoricalSwim.timeType`). Only SCY is built; see the file header. */
export const THEORETICAL_MEET_COURSES = ['SCY', 'LCM', 'SCM'] as const;
export type TheoreticalMeetCourse = (typeof THEORETICAL_MEET_COURSES)[number];

export type TheoreticalMeetErrorCode =
  /** The meet course is not SCY, LCM or SCM. */
  | 'unknown-course'
  /** The meet course is LCM or SCM. Not built yet; see the file header. */
  | 'course-not-supported'
  /** A team's gender is not one the meet knows (`Gender.MEN` or `Gender.WOMEN`). */
  | 'unknown-team-gender'
  /** A roster athlete's own gender contradicts the team's gender. */
  | 'athlete-gender-mismatch'
  /** A swim's gender contradicts the team's gender. */
  | 'swim-gender-mismatch'
  /** The scoring settings lack a cap the builder reads, or hold a cap that is not a whole number of 1 or more. */
  | 'invalid-scoring-settings'
  /** A roster athlete has no usable name. */
  | 'athlete-without-name'
  /** Two athletes on one team share a normalized name. Psych scoring would merge them. */
  | 'name-collision-in-team'
  /** A team's roster status is missing, or an empty roster is not stated as `no_rosters_found`. */
  | 'roster-status-required'
  /** The meet id or a team name is empty, or two fields contradict each other. */
  | 'invalid-input'
  /** The same team and gender were given twice. */
  | 'duplicate-team'
  /** The selector returned a best the builder cannot trace to a captured swim. */
  | 'seed-provenance-missing'
  /** Two rows got one id. */
  | 'row-id-collision';

export class TheoreticalMeetError extends Error {
  readonly code: TheoreticalMeetErrorCode;
  constructor(code: TheoreticalMeetErrorCode, message: string) {
    super(message);
    this.name = 'TheoreticalMeetError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/** One roster athlete with the swims already converted from that swimmer's all-time bests. */
export interface TheoreticalMeetAthleteInput {
  readonly athlete: SwimCloudAthlete;
  /**
   * The output of `swimCloudSwimmerTimesToHistoricalSwims(...).swims`.
   * `undefined` means no times page was captured for this athlete, or (with
   * `swimsStatus: 'parse_failed'`) that the page did not parse. An empty array
   * means a page was captured and held no usable swim. These are reported apart.
   */
  readonly swims: readonly HistoricalSwim[] | undefined;
  /**
   * `'parse_failed'`: a times page was captured and the parse failed. Requires
   * `swims: undefined`. Reported in `athletesWithTimesParseFailed`, not in
   * `athletesWithNoTimes`. Absent: no claim.
   */
  readonly swimsStatus?: 'parse_failed';
  /** The capture the times page came from, when known. Copied into the row's source record. */
  readonly captureId?: string;
  /** When the times page was captured. A swim's own `retrievedAt` wins when it has one. */
  readonly retrievedAt?: string;
}

export interface TheoreticalMeetTeamInput {
  /**
   * The team name the rows carry. Division lookups read it
   * (`divisionForTeamOrNull`), so pass the name the workspace uses.
   */
  readonly teamName: string;
  readonly gender: Gender;
  /**
   * What the roster capture said. `parsed`: the page parsed and lists athletes.
   * `no_rosters_found`: the real "No rosters found" page (the parser warns
   * `no-roster-posted`); `athletes` must then be empty. An empty list with
   * `parsed`, or no status, throws `roster-status-required`.
   */
  readonly rosterStatus: 'parsed' | 'no_rosters_found';
  /**
   * The SwimCloud season id the roster was read for (`29` for 2025-2026). A seed
   * is in-season only when its own `seasonId` is string-equal to this. Ids are
   * never ordered. Absent means the all-time-best caveat is always included.
   */
  readonly rosterSeasonId?: string;
  readonly athletes: readonly TheoreticalMeetAthleteInput[];
}

export interface TheoreticalMeetInput {
  /** Scopes the row ids. Use the id of the workspace the rows will be written to. */
  readonly meetId: string;
  /** Must be `'SCY'`. LCM and SCM throw `course-not-supported`. */
  readonly course: TheoreticalMeetCourse;
  /**
   * The meet's scoring settings. `maxIndividualEntriesPerSwimmer` is required.
   * `maxTotalEntriesPerSwimmer` is optional: absent means the meet has no total
   * cap, which is how the non-NSISC presets state it. The settings are merged
   * with `conference` (`mergeScoringSettings`) once, the way the roster
   * optimizer merges them, and each cap in the merged result must be a whole
   * number of 1 or more (999 means no cap).
   */
  readonly scoringSettings: ScoringSettings;
  /** The workspace conference (`workspace.conference`, for example `'NSISC'`). NSISC fixes the entry caps by rule. */
  readonly conference?: string;
  /**
   * The meet's individual events as canonical labels (`meetProgramEvents`).
   * `null` or absent: the standard championship program, as the selector does
   * with no meet loaded.
   */
  readonly meetProgram?: ReadonlySet<string> | null;
  readonly teams: readonly TheoreticalMeetTeamInput[];
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/** Where a row's seed came from. Parallel to the row because `SwimmerResult` has no such field. */
export interface TheoreticalSeedSource {
  readonly swimCloudSwimmerId?: string;
  readonly captureId?: string;
  readonly retrievedAt?: string;
  /** The course the swim was recorded in. Always the meet course. */
  readonly course: TheoreticalMeetCourse;
  /** The event label exactly as recorded (`'100 Free SCY'`). Equals the row's `event`. */
  readonly sourceEvent: string;
  /** The swim's own date, verbatim, when the capture had one. */
  readonly swimDate?: string;
  readonly meetLabel?: string;
  readonly seasonId?: string;
}

export type TheoreticalRankBasis = 'meet_place' | 'cut_distance' | 'time';

/** One event the selector offered for a swimmer, in strength order. */
export interface TheoreticalEventCandidate {
  /** Course-qualified label, as recorded. */
  readonly event: string;
  /** The seed time as recorded. */
  readonly time: string;
  /** Which rule of `rankEventsByStrength` placed this event. `time` is the weakest. */
  readonly rankBasis: TheoreticalRankBasis;
  readonly chosen: boolean;
  /** Present when not chosen: the entry caps stopped it. */
  readonly notChosenReason?: 'entry_cap';
  /** Present when chosen: the id of the row built for it. */
  readonly rowId?: string;
}

export interface TheoreticalSwimmerEvents {
  readonly name: string;
  readonly swimCloudSwimmerId?: string;
  /** Every offered event, strongest first, with the chosen ones marked. */
  readonly events: readonly TheoreticalEventCandidate[];
  /** Seeds in the meet course that the selector did not offer (outside the program, extracted splits). Course-qualified labels. */
  readonly unofferedSeeds: readonly string[];
}

export interface TheoreticalAthleteRef {
  readonly name: string;
  readonly swimCloudSwimmerId?: string;
}

export interface TheoreticalNoSeedAthlete extends TheoreticalAthleteRef {
  /**
   * `no_usable_swim`: a times page was captured (`swims: []`) and held no usable swim.
   * `diving_not_supported`: every captured swim is a dive.
   * `no_swim_in_meet_course`: swims were captured, none was recorded in the meet course.
   * `no_event_in_program`: swims in the meet course exist, none is an event the selector offers.
   */
  readonly reason: 'no_usable_swim' | 'diving_not_supported' | 'no_swim_in_meet_course' | 'no_event_in_program';
}

export interface TheoreticalDuplicateAthlete extends TheoreticalAthleteRef {
  /** The first team given. The swimmer enters for this team. */
  readonly enteredForTeam: string;
  /** The team whose roster listed the swimmer again. No row is made here. */
  readonly skippedForTeam: string;
}

export interface TheoreticalTeamReport {
  readonly teamName: string;
  readonly gender: Gender;
  readonly rosterStatus: 'parsed' | 'no_rosters_found';
  readonly rowsCreated: number;
  /** No times page was captured. */
  readonly athletesWithNoTimes: readonly TheoreticalAthleteRef[];
  /** A times page was captured and did not parse. */
  readonly athletesWithTimesParseFailed: readonly TheoreticalAthleteRef[];
  readonly athletesWithNoSeedInMeetCourse: readonly TheoreticalNoSeedAthlete[];
  readonly duplicateAcrossTeams: readonly TheoreticalDuplicateAthlete[];
  readonly eventsChosenPerSwimmer: readonly TheoreticalSwimmerEvents[];
  readonly caveats: readonly string[];
}

export interface TheoreticalMeetReport {
  readonly course: TheoreticalMeetCourse;
  readonly totalRows: number;
  /** In the order the teams were given. */
  readonly teams: readonly TheoreticalTeamReport[];
  /** Every team caveat once, plus the meet-wide ones. */
  readonly caveats: readonly string[];
}

export interface TheoreticalMeetSeeds {
  /** Every row, in team order, then roster order, then strength order. All have `isPsychSheet: true`. */
  readonly rows: readonly SwimmerResult[];
  /** The men's rows. Write to `workspace.psychMenResults`. */
  readonly psychMenResults: readonly SwimmerResult[];
  /** The women's rows. Write to `workspace.psychWomenResults`. */
  readonly psychWomenResults: readonly SwimmerResult[];
  /** Provenance per row id. Holds exactly one entry for each row. */
  readonly sources: ReadonlyMap<string, TheoreticalSeedSource>;
  readonly report: TheoreticalMeetReport;
}

/* -------------------------------------------------------------------------- */
/* Caveat texts                                                                */
/* -------------------------------------------------------------------------- */

export const ALL_TIME_BEST_CAVEAT =
  'Seeds are all-time bests. An all-time best can overstate a swimmer who has since slowed.';
export const RELAYS_EXCLUDED_CAVEAT =
  'Relays are not included. These rows are individual entries only.';
export const DIVING_EXCLUDED_CAVEAT =
  'Diving is not included. Dives are never made into rows.';
export const TOTAL_CAP_CAVEAT =
  'The meet has a total entry cap. Relay slots are not reserved, so a swimmer\'s individual entries can use the whole cap.';
export const UNCAPPED_CAVEAT =
  'No entry cap applies to these settings, so every offered event is entered for each swimmer.';

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** The selector reads no cap above this as a limit. Used to ask it for the whole ranking. */
const UNCAPPED = 999;

function requireCap(value: unknown, field: string, required: boolean): number | undefined {
  if (value === undefined) {
    if (required) {
      throw new TheoreticalMeetError('invalid-scoring-settings', `The scoring settings have no ${field}. The builder will not guess a cap.`);
    }
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TheoreticalMeetError('invalid-scoring-settings', `${field} must be a whole number of 1 or more. Got ${String(value)}.`);
  }
  return value;
}

/**
 * The settings the whole build uses: the input settings merged ONCE with the
 * conference, as `optimizeEventLineupForTeam` merges them. The individual cap
 * must be present on the input (the merge would otherwise fill in a default).
 */
function resolveSettings(input: TheoreticalMeetInput): { settings: ScoringSettings; indCap: number; totalCap: number | undefined } {
  const raw = input.scoringSettings;
  if (raw === undefined || raw === null) {
    throw new TheoreticalMeetError('invalid-scoring-settings', 'No scoring settings were given.');
  }
  requireCap(raw.maxIndividualEntriesPerSwimmer, 'maxIndividualEntriesPerSwimmer', true);
  const settings = mergeScoringSettings(raw, { conference: input.conference });
  const indCap = requireCap(settings.maxIndividualEntriesPerSwimmer, 'maxIndividualEntriesPerSwimmer', true) as number;
  const totalCap = requireCap(settings.maxTotalEntriesPerSwimmer, 'maxTotalEntriesPerSwimmer', false);
  return { settings, indCap, totalCap };
}

function validateCourse(course: unknown): void {
  if (!(THEORETICAL_MEET_COURSES as readonly unknown[]).includes(course)) {
    throw new TheoreticalMeetError('unknown-course', `The meet course ${JSON.stringify(course)} is not one of ${THEORETICAL_MEET_COURSES.join(', ')}.`);
  }
  if (course !== 'SCY') {
    throw new TheoreticalMeetError(
      'course-not-supported',
      `A ${String(course)} meet is not supported. The event selector ranks on SCY seconds and SCY cut tables, so a ${String(course)} ranking would need a conversion estimate. ` +
        'Ranking in the meet course needs a design with no conversion and no cut (rank by the seed\'s place in the theoretical field, one event at a time). That is a follow-up.'
    );
  }
}

function validateAthletes(team: TheoreticalMeetTeamInput): void {
  for (const entry of team.athletes) {
    const { athlete } = entry;
    if (typeof athlete.name !== 'string' || athlete.name.trim().length === 0) {
      throw new TheoreticalMeetError('athlete-without-name', `Team ${team.teamName} has an athlete with no usable name (swimmer id ${athlete.swimCloudSwimmerId ?? 'none'}).`);
    }
    const g = athlete.gender;
    if (g !== undefined && g !== 'unknown' && (g as string) !== (team.gender as string)) {
      throw new TheoreticalMeetError('athlete-gender-mismatch', `${athlete.name} is listed as ${g} on a ${team.gender} roster for ${team.teamName}.`);
    }
    if (entry.swimsStatus !== undefined && entry.swimsStatus !== 'parse_failed') {
      throw new TheoreticalMeetError('invalid-input', `${athlete.name} has swimsStatus ${JSON.stringify(entry.swimsStatus)}. Only 'parse_failed' is known.`);
    }
    if (entry.swimsStatus === 'parse_failed' && entry.swims !== undefined) {
      throw new TheoreticalMeetError('invalid-input', `${athlete.name} is marked parse_failed but carries swims.`);
    }
  }
}

function validateRosterStatus(team: TheoreticalMeetTeamInput): void {
  const status = team.rosterStatus as unknown;
  if (status !== 'parsed' && status !== 'no_rosters_found') {
    throw new TheoreticalMeetError('roster-status-required', `Team ${team.teamName} (${team.gender}) has roster status ${JSON.stringify(status)}. State 'parsed' or 'no_rosters_found'.`);
  }
  if (status === 'parsed' && team.athletes.length === 0) {
    throw new TheoreticalMeetError('roster-status-required', `Team ${team.teamName} (${team.gender}) has no athletes but its roster status is 'parsed'. An empty roster must be stated as 'no_rosters_found'.`);
  }
  if (status === 'no_rosters_found' && team.athletes.length > 0) {
    throw new TheoreticalMeetError('invalid-input', `Team ${team.teamName} (${team.gender}) is 'no_rosters_found' but lists ${team.athletes.length} athlete(s).`);
  }
}

function validateTeam(team: TheoreticalMeetTeamInput): void {
  if (typeof team.teamName !== 'string' || team.teamName.trim().length === 0) {
    throw new TheoreticalMeetError('invalid-input', 'A team has no name.');
  }
  if (team.gender !== Gender.MEN && team.gender !== Gender.WOMEN) {
    throw new TheoreticalMeetError('unknown-team-gender', `Team ${team.teamName} has gender ${JSON.stringify(team.gender)}. The meet knows ${Gender.MEN} and ${Gender.WOMEN}.`);
  }
  validateRosterStatus(team);
  validateAthletes(team);
}

/* -------------------------------------------------------------------------- */
/* Row ids                                                                     */
/* -------------------------------------------------------------------------- */

const enc = (part: string): string => encodeURIComponent(part.trim());

function teamKey(team: TheoreticalMeetTeamInput): string {
  return `${team.gender}|${normalizeSwimmerName(team.teamName)}`;
}

/** Row id for one seed. Exported so a test or a UI can predict it. */
export function theoreticalSeedRowId(args: {
  meetId: string;
  gender: Gender;
  teamName: string;
  /** `sc:{id}` for an athlete with a SwimCloud id, else `nm:{normalized name}`; see {@link swimmerKeyFor}. */
  swimmerKey: string;
  event: string;
}): string {
  return ['tmseed', enc(args.meetId), args.gender, enc(args.teamName), args.swimmerKey, enc(args.event)].join('|');
}

/** A name is unique on a team (the builder throws otherwise), so the name alone keys an athlete with no id. */
function swimmerKeyFor(athlete: SwimCloudAthlete): string {
  if (athlete.swimCloudSwimmerId !== undefined) return `sc:${enc(athlete.swimCloudSwimmerId)}`;
  return `nm:${enc(normalizeSwimmerName(athlete.name))}`;
}

/* -------------------------------------------------------------------------- */
/* One athlete                                                                 */
/* -------------------------------------------------------------------------- */

/** What every athlete is built under. Settings are already merged. */
type Context = {
  readonly meetId: string;
  readonly course: 'SCY';
  readonly settings: ScoringSettings;
  readonly meetProgram: ReadonlySet<string> | null;
};

type ChosenSeed = {
  readonly swim: HistoricalSwim;
  readonly candidate: Omit<TheoreticalEventCandidate, 'chosen' | 'rowId' | 'notChosenReason'>;
};

type SwimSplit = {
  /** Non-dive swims recorded in the meet course, stamped with the roster athlete's identity. */
  used: HistoricalSwim[];
  /** Non-dive swims with no recorded course. A dive has none and is not counted here. */
  unknownCourse: number;
  /** Whether the athlete has any swim that is not a dive. */
  hasNonDiving: boolean;
};

/**
 * The swims the meet can seed from. The swims came from a times page that names
 * the swimmer another way (`'Paulk, River J'`) and the caller paired them by id,
 * so each is stamped with the roster athlete's name and team.
 */
function splitSwims(team: TheoreticalMeetTeamInput, athlete: SwimCloudAthlete, swims: readonly HistoricalSwim[], course: string): SwimSplit {
  const split: SwimSplit = { used: [], unknownCourse: 0, hasNonDiving: false };
  for (const swim of swims) {
    if (swim.gender !== team.gender) {
      throw new TheoreticalMeetError('swim-gender-mismatch', `A swim of ${athlete.name} (${swim.event}) is ${String(swim.gender)} on a ${team.gender} roster for ${team.teamName}.`);
    }
    if (isDivingEvent(swim.event)) continue;
    split.hasNonDiving = true;
    if (swim.timeType === undefined) {
      split.unknownCourse += 1;
      continue;
    }
    if (swim.timeType === course) split.used.push({ ...swim, name: athlete.name, team: team.teamName });
  }
  return split;
}

function rankBasisOf(strength: Record<string, { basis: TheoreticalRankBasis }> | undefined, event: string): TheoreticalRankBasis {
  const basis = strength?.[event]?.basis;
  if (basis === undefined) {
    throw new TheoreticalMeetError('seed-provenance-missing', `The selector gave no ranking basis for ${event}.`);
  }
  return basis;
}

/** The recorded swim behind one selector best. In SCY the selector's event and time are the recorded ones. */
function traceSeed(
  selectorEvent: string,
  best: { time: string; convertedFrom?: unknown },
  swims: readonly HistoricalSwim[]
): { event: string; time: string; swim: HistoricalSwim } {
  if (best.convertedFrom !== undefined) {
    throw new TheoreticalMeetError('seed-provenance-missing', `The selector offered ${selectorEvent} as a converted time. A seed is never converted.`);
  }
  const swim = swims.find(s => s.event === selectorEvent && s.time === best.time);
  if (swim === undefined) {
    throw new TheoreticalMeetError('seed-provenance-missing', `No captured swim matches ${selectorEvent} ${best.time}.`);
  }
  return { event: selectorEvent, time: best.time, swim };
}

type AthleteOutcome =
  | { kind: 'no_seed'; reason: TheoreticalNoSeedAthlete['reason']; unknownCourse: number }
  | { kind: 'seeded'; ranked: ChosenSeed[]; unoffered: string[]; unknownCourse: number };

/** Choose one athlete's events: the selector for the order, the optimizer's cap check for the limit. */
function chooseAthleteEvents(
  ctx: Context,
  team: TheoreticalMeetTeamInput,
  athlete: SwimCloudAthlete,
  swims: readonly HistoricalSwim[]
): AthleteOutcome {
  if (swims.length === 0) return { kind: 'no_seed', reason: 'no_usable_swim', unknownCourse: 0 };
  const { used, unknownCourse, hasNonDiving } = splitSwims(team, athlete, swims, ctx.course);
  if (!hasNonDiving) return { kind: 'no_seed', reason: 'diving_not_supported', unknownCourse };
  if (used.length === 0) return { kind: 'no_seed', reason: 'no_swim_in_meet_course', unknownCourse };

  // The selector slices its order to the individual cap. Ask for the whole
  // order (cap 999) and apply the real caps below, so a UI can show the events
  // the caps left out.
  const profile = categorizeBestEvents(
    used,
    team.teamName,
    team.gender,
    athlete.name,
    { ...ctx.settings, maxIndividualEntriesPerSwimmer: UNCAPPED },
    [],
    undefined,
    ctx.meetProgram,
    null
  );

  const ranked: ChosenSeed[] = profile.primaryEvents.map(selectorEvent => {
    const seed = traceSeed(selectorEvent, profile.bestByEvent[selectorEvent], used);
    return {
      swim: seed.swim,
      candidate: {
        event: seed.event,
        time: seed.time,
        rankBasis: rankBasisOf(profile.strengthByEvent as Record<string, { basis: TheoreticalRankBasis }> | undefined, selectorEvent),
      },
    };
  });
  if (ranked.length === 0) return { kind: 'no_seed', reason: 'no_event_in_program', unknownCourse };

  const offered = new Set(ranked.map(r => swimEventIdentity(r.candidate.event)));
  const unoffered = [...new Set(used.filter(s => !offered.has(swimEventIdentity(s.event))).map(s => s.event))];
  return { kind: 'seeded', ranked, unoffered, unknownCourse };
}

/** Mark the first events the caps accept, in strength order. Mirrors `addAthleteEventPlans`. */
function applyEntryCaps(ranked: readonly ChosenSeed[], settings: ScoringSettings): boolean[] {
  const counts: SwimmerEntryCounts = { individual: 0, relayEvents: new Set<string>(), relayCount: 0, total: 0 };
  return ranked.map(r => {
    if (!canAcceptAnotherEntry(counts, settings, r.candidate.event)) return false;
    counts.individual += 1;
    counts.total = (counts.total ?? 0) + 1;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Freshness caveat                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A seed is in-season only when its season id is string-equal to the roster's.
 * Season ids are never ordered or compared as numbers: a later season is as
 * much "not the roster season" as an earlier one, and a missing id proves
 * nothing.
 */
function seedInRosterSeason(seedSeasonId: string | undefined, rosterSeasonId: string | undefined): boolean {
  return seedSeasonId !== undefined && rosterSeasonId !== undefined && seedSeasonId === rosterSeasonId;
}

/* -------------------------------------------------------------------------- */
/* The builder                                                                 */
/* -------------------------------------------------------------------------- */

type TeamAccumulator = {
  rows: SwimmerResult[];
  noTimes: TheoreticalAthleteRef[];
  parseFailed: TheoreticalAthleteRef[];
  noSeed: TheoreticalNoSeedAthlete[];
  duplicates: TheoreticalDuplicateAthlete[];
  perSwimmer: TheoreticalSwimmerEvents[];
  seedSeasonIds: (string | undefined)[];
  unknownCourseSwims: number;
  swimmersRankedOnTime: number;
};

function newAccumulator(): TeamAccumulator {
  return { rows: [], noTimes: [], parseFailed: [], noSeed: [], duplicates: [], perSwimmer: [], seedSeasonIds: [], unknownCourseSwims: 0, swimmersRankedOnTime: 0 };
}

function freshnessCaveat(team: TheoreticalMeetTeamInput, seedSeasonIds: readonly (string | undefined)[]): string | undefined {
  if (seedSeasonIds.every(id => seedInRosterSeason(id, team.rosterSeasonId))) return undefined;
  if (team.rosterSeasonId === undefined) {
    return `${ALL_TIME_BEST_CAVEAT} The roster season is not known, so the season of each seed is not checked.`;
  }
  const other = seedSeasonIds.filter(id => !seedInRosterSeason(id, team.rosterSeasonId)).length;
  return `${ALL_TIME_BEST_CAVEAT} ${other} of ${seedSeasonIds.length} seeds are from a season other than ${team.rosterSeasonId} (a seed with no season id counts as other).`;
}

function teamCaveats(team: TheoreticalMeetTeamInput, acc: TeamAccumulator, caps: { indCap: number; totalCap: number | undefined }): string[] {
  const caveats: string[] = [];
  const fresh = freshnessCaveat(team, acc.seedSeasonIds);
  if (fresh !== undefined) caveats.push(fresh);
  if (team.rosterStatus === 'no_rosters_found') {
    caveats.push(`The roster for ${team.teamName} (${team.gender}) lists no athletes (SwimCloud: no rosters found). No rows were made.`);
  }
  const totalCapped = caps.totalCap !== undefined && caps.totalCap < UNCAPPED;
  if (totalCapped) caveats.push(TOTAL_CAP_CAVEAT);
  if (!totalCapped && caps.indCap >= UNCAPPED) caveats.push(UNCAPPED_CAVEAT);
  if (acc.swimmersRankedOnTime > 0) {
    caveats.push(
      `${acc.swimmersRankedOnTime} swimmer(s) have events ranked by raw time, not by distance to a published cut. This team's division is unknown or no standard covers the event, so short events can win a capped lineup.`
    );
  }
  if (acc.unknownCourseSwims > 0) {
    caveats.push(`${acc.unknownCourseSwims} captured swim(s) have no recorded course. They were not used.`);
  }
  if (acc.parseFailed.length > 0) {
    caveats.push(`${acc.parseFailed.length} athlete(s) have a times page that did not parse. No rows were made for them.`);
  }
  return caveats;
}

function buildRow(args: {
  meetId: string;
  team: TheoreticalMeetTeamInput;
  athlete: SwimCloudAthlete;
  swimmerKey: string;
  seed: ChosenSeed;
}): SwimmerResult {
  const { team, athlete, seed } = args;
  const classYear = athlete.classYear !== undefined && athlete.classYear !== 'unknown' ? athlete.classYear : 'UNKNOWN';
  return {
    id: theoreticalSeedRowId({ meetId: args.meetId, gender: team.gender, teamName: team.teamName, swimmerKey: args.swimmerKey, event: seed.candidate.event }),
    rank: 0,
    name: athlete.name,
    classYear,
    team: team.teamName,
    time: seed.candidate.time,
    points: 0,
    event: seed.candidate.event,
    gender: team.gender,
    isRelay: false,
    roundSwam: 'Psych Sheet',
    isPsychSheet: true,
  };
}

function processAthlete(
  ctx: Context,
  team: TheoreticalMeetTeamInput,
  entry: TheoreticalMeetAthleteInput,
  acc: TeamAccumulator,
  sources: Map<string, TheoreticalSeedSource>
): void {
  const { athlete } = entry;
  const swimmerKey = swimmerKeyFor(athlete);
  const ref: TheoreticalAthleteRef = {
    name: athlete.name,
    ...(athlete.swimCloudSwimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimCloudSwimmerId }),
  };
  if (entry.swims === undefined) {
    (entry.swimsStatus === 'parse_failed' ? acc.parseFailed : acc.noTimes).push(ref);
    return;
  }
  const outcome = chooseAthleteEvents(ctx, team, athlete, entry.swims);
  acc.unknownCourseSwims += outcome.unknownCourse;
  if (outcome.kind === 'no_seed') {
    acc.noSeed.push({ ...ref, reason: outcome.reason });
    return;
  }
  const accepted = applyEntryCaps(outcome.ranked, ctx.settings);
  const events: TheoreticalEventCandidate[] = [];
  outcome.ranked.forEach((seed, index) => {
    if (!accepted[index]) {
      events.push({ ...seed.candidate, chosen: false, notChosenReason: 'entry_cap' });
      return;
    }
    const row = buildRow({ meetId: ctx.meetId, team, athlete, swimmerKey, seed });
    acc.rows.push(row);
    acc.seedSeasonIds.push(seed.swim.seasonId);
    const retrievedAt = seed.swim.retrievedAt ?? entry.retrievedAt;
    sources.set(row.id, {
      ...(athlete.swimCloudSwimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimCloudSwimmerId }),
      ...(entry.captureId === undefined ? {} : { captureId: entry.captureId }),
      ...(retrievedAt === undefined ? {} : { retrievedAt }),
      course: ctx.course,
      sourceEvent: seed.candidate.event,
      ...(seed.swim.date === undefined ? {} : { swimDate: seed.swim.date }),
      ...(seed.swim.meetLabel === undefined ? {} : { meetLabel: seed.swim.meetLabel }),
      ...(seed.swim.seasonId === undefined ? {} : { seasonId: seed.swim.seasonId }),
    });
    events.push({ ...seed.candidate, chosen: true, rowId: row.id });
  });
  if (events.some((e, i) => accepted[i] && e.rankBasis === 'time')) acc.swimmersRankedOnTime += 1;
  acc.perSwimmer.push({ ...ref, events, unofferedSeeds: outcome.unoffered });
}

const describeAthlete = (a: SwimCloudAthlete): string => `${a.name} (swimmer id ${a.swimCloudSwimmerId ?? 'none'})`;

function processTeam(
  ctx: Context,
  team: TheoreticalMeetTeamInput,
  claimed: Map<string, string>,
  sources: Map<string, TheoreticalSeedSource>,
  caps: { indCap: number; totalCap: number | undefined }
): TheoreticalTeamReport & { rows: SwimmerResult[] } {
  const acc = newAccumulator();
  const seenNames = new Map<string, SwimCloudAthlete>();
  for (const entry of team.athletes) {
    const id = entry.athlete.swimCloudSwimmerId;
    if (id !== undefined) {
      const firstTeam = claimed.get(id);
      if (firstTeam !== undefined) {
        acc.duplicates.push({ name: entry.athlete.name, swimCloudSwimmerId: id, enteredForTeam: firstTeam, skippedForTeam: team.teamName });
        continue;
      }
      claimed.set(id, team.teamName);
    }
    const nameKey = normalizeSwimmerName(entry.athlete.name);
    const prior = seenNames.get(nameKey);
    if (prior !== undefined) {
      throw new TheoreticalMeetError(
        'name-collision-in-team',
        `Team ${team.teamName} (${team.gender}) has two athletes with the name ${entry.athlete.name}: ${describeAthlete(prior)} and ${describeAthlete(entry.athlete)}. ` +
          'Psych scoring keys an entry on event, team and name, so it would merge them. Neither is picked. Resolve the names first.'
      );
    }
    seenNames.set(nameKey, entry.athlete);
    processAthlete(ctx, team, entry, acc, sources);
  }
  return {
    rows: acc.rows,
    teamName: team.teamName,
    gender: team.gender,
    rosterStatus: team.rosterStatus,
    rowsCreated: acc.rows.length,
    athletesWithNoTimes: acc.noTimes,
    athletesWithTimesParseFailed: acc.parseFailed,
    athletesWithNoSeedInMeetCourse: acc.noSeed,
    duplicateAcrossTeams: acc.duplicates,
    eventsChosenPerSwimmer: acc.perSwimmer,
    caveats: teamCaveats(team, acc, caps),
  };
}

/**
 * Build psych-sheet rows for a theoretical meet from several crawled teams.
 *
 * Throws {@link TheoreticalMeetError} on an unknown course, an LCM or SCM
 * course (`course-not-supported`), an unknown team gender, settings with no
 * individual cap or a cap that is not a whole number of 1 or more, an athlete
 * with no name, two athletes of one name on one team, a roster status that is
 * missing or contradicts the athlete list, a repeated team, or a seed the
 * builder cannot trace to a captured swim.
 */
export function buildTheoreticalMeetSeeds(input: TheoreticalMeetInput): TheoreticalMeetSeeds {
  if (typeof input.meetId !== 'string' || input.meetId.trim().length === 0) {
    throw new TheoreticalMeetError('invalid-input', 'The meet id is empty. Row ids are scoped by it.');
  }
  validateCourse(input.course);
  const { settings, indCap, totalCap } = resolveSettings(input);
  const seenTeams = new Set<string>();
  for (const team of input.teams) {
    validateTeam(team);
    const key = teamKey(team);
    if (seenTeams.has(key)) {
      throw new TheoreticalMeetError('duplicate-team', `${team.teamName} (${team.gender}) was given twice.`);
    }
    seenTeams.add(key);
  }

  const ctx: Context = { meetId: input.meetId, course: 'SCY', settings, meetProgram: input.meetProgram ?? null };
  const claimed = new Map<string, string>();
  const sources = new Map<string, TheoreticalSeedSource>();
  const rows: SwimmerResult[] = [];
  const teamReports: TheoreticalTeamReport[] = [];
  for (const team of input.teams) {
    const { rows: teamRows, ...report } = processTeam(ctx, team, claimed, sources, { indCap, totalCap });
    rows.push(...teamRows);
    teamReports.push(report);
  }

  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new TheoreticalMeetError('row-id-collision', `Two rows share the id ${row.id}.`);
    ids.add(row.id);
  }

  const caveats = [...new Set([...teamReports.flatMap(t => t.caveats), RELAYS_EXCLUDED_CAVEAT, DIVING_EXCLUDED_CAVEAT])];
  return {
    rows,
    psychMenResults: rows.filter(r => r.gender === Gender.MEN),
    psychWomenResults: rows.filter(r => r.gender === Gender.WOMEN),
    sources,
    report: { course: input.course, totalRows: rows.length, teams: teamReports, caveats },
  };
}
