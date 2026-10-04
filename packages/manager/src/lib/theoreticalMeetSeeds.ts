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
 *    no captured times page is reported as `athletesWithNoTimes`. An athlete
 *    with a times page but nothing usable is reported with the reason.
 * 3. **Entries follow the scoring rules.** The events come from the existing
 *    selector, {@link categorizeBestEvents} (strength order: place in a loaded
 *    meet, then distance to the division cut, then raw seconds), and the caps
 *    come from {@link canAcceptAnotherEntry}. That is the same pair the roster
 *    optimizer uses (`addAthleteEventPlans` in `rosterOptimizer.ts`). This file
 *    holds no second selector and no second cap counter.
 * 4. **One swimmer, one team.** The same SwimCloud swimmer id on two rosters
 *    enters for the first team given. The other team reports it as
 *    `duplicateAcrossTeams`. Two names that match, with no shared id, are not
 *    merged.
 * 5. **Fail loudly.** Bad input throws {@link TheoreticalMeetError}.
 *
 * ## The one place the existing selector touches another course
 *
 * `categorizeBestEvents` ranks events on SCY seconds, and states every metric
 * swim in SCY to do so. For an LCM or SCM meet this builder therefore lets the
 * selector RANK on a SCY estimate. The estimate decides only the order of a
 * swimmer's events. It is never a seed. Each row's event and time come from
 * `convertedFrom.sourceEvent` and `convertedFrom.sourceTime`: the swim exactly
 * as it was recorded. A team caveat says so whenever the course is not SCY.
 *
 * ## Row ids and provenance
 *
 * `SwimmerResult` has no field for a source, and this phase may not edit core,
 * so provenance rides in a parallel `Map` keyed by row id
 * ({@link TheoreticalMeetSeeds.sources}). A row id is
 * `tmseed|meet|gender|team|swimmer|event`, every part URI-encoded. The meet id
 * is part of it because psych result ids are primary keys across all
 * workspaces (`psych_results.id TEXT PRIMARY KEY`). The same input always makes
 * the same ids.
 */

import { Gender } from '@omniswim/core/types';
import type { HistoricalSwim, ScoringSettings, SwimmerResult } from '@omniswim/core/types';
import { categorizeBestEvents, swimEventIdentity } from '@omniswim/core/lib/athleteHistory';
import { canAcceptAnotherEntry, type SwimmerEntryCounts } from '@omniswim/core/lib/swimmerEntryLimits';
import { normalizeSwimmerName } from '@omniswim/core/lib/utils';
import type { SwimCloudAthlete } from '@omniswim/swimcloud/entities';

/* -------------------------------------------------------------------------- */
/* Courses, errors                                                             */
/* -------------------------------------------------------------------------- */

/** The three courses the codebase names (`HistoricalSwim.timeType`). */
export const THEORETICAL_MEET_COURSES = ['SCY', 'LCM', 'SCM'] as const;
export type TheoreticalMeetCourse = (typeof THEORETICAL_MEET_COURSES)[number];

export type TheoreticalMeetErrorCode =
  /** The meet course is not SCY, LCM or SCM. */
  | 'unknown-course'
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
  /** The meet id or a team name is empty. */
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
   * `undefined` means no times page was captured for this athlete. An empty
   * array means a page was captured and held no usable swim. The two are
   * reported apart.
   */
  readonly swims: readonly HistoricalSwim[] | undefined;
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
   * The SwimCloud season id the roster was read for (`29` for 2025-2026).
   * Used only to tell whether a seed is older than the roster season. Absent
   * means the caveat is always included.
   */
  readonly rosterSeasonId?: string;
  readonly athletes: readonly TheoreticalMeetAthleteInput[];
}

export interface TheoreticalMeetInput {
  /** Scopes the row ids. Use the id of the workspace the rows will be written to. */
  readonly meetId: string;
  readonly course: TheoreticalMeetCourse;
  /**
   * The meet's scoring settings. `maxIndividualEntriesPerSwimmer` is required.
   * `maxTotalEntriesPerSwimmer` is optional: absent means the meet has no total
   * cap, which is how the non-NSISC presets state it. Each cap that is present
   * must be a whole number of 1 or more (999 means no cap).
   */
  readonly scoringSettings: ScoringSettings;
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
  /** Seeds in the meet course that the selector did not offer (outside the program, extracted splits, no factor). Course-qualified labels. */
  readonly unofferedSeeds: readonly string[];
}

export interface TheoreticalAthleteRef {
  readonly name: string;
  readonly swimCloudSwimmerId?: string;
}

export interface TheoreticalNoSeedAthlete extends TheoreticalAthleteRef {
  /**
   * `no_swim_in_meet_course`: times were captured, none was recorded in the meet course.
   * `no_event_in_program`: swims in the meet course exist, none is an event the selector offers.
   */
  readonly reason: 'no_swim_in_meet_course' | 'no_event_in_program';
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
  readonly rowsCreated: number;
  readonly athletesWithNoTimes: readonly TheoreticalAthleteRef[];
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
export const RANKED_ON_ESTIMATE_CAVEAT =
  'This course is not SCY. The existing event selector ranks a swimmer\'s events on a SCY estimate. The estimate only orders the events. Every seed is the swim as recorded, with no conversion.';
export const TOTAL_CAP_CAVEAT =
  'The meet has a total entry cap. Relay slots are not reserved, so a swimmer\'s individual entries can use the whole cap.';

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

function validateSettings(settings: ScoringSettings): { totalCap: number | undefined } {
  if (settings === undefined || settings === null) {
    throw new TheoreticalMeetError('invalid-scoring-settings', 'No scoring settings were given.');
  }
  requireCap(settings.maxIndividualEntriesPerSwimmer, 'maxIndividualEntriesPerSwimmer', true);
  return { totalCap: requireCap(settings.maxTotalEntriesPerSwimmer, 'maxTotalEntriesPerSwimmer', false) };
}

function validateCourse(course: unknown): TheoreticalMeetCourse {
  if (!(THEORETICAL_MEET_COURSES as readonly unknown[]).includes(course)) {
    throw new TheoreticalMeetError('unknown-course', `The meet course ${JSON.stringify(course)} is not one of ${THEORETICAL_MEET_COURSES.join(', ')}.`);
  }
  return course as TheoreticalMeetCourse;
}

function validateTeam(team: TheoreticalMeetTeamInput): void {
  if (typeof team.teamName !== 'string' || team.teamName.trim().length === 0) {
    throw new TheoreticalMeetError('invalid-input', 'A team has no name.');
  }
  if (team.gender !== Gender.MEN && team.gender !== Gender.WOMEN) {
    throw new TheoreticalMeetError('unknown-team-gender', `Team ${team.teamName} has gender ${JSON.stringify(team.gender)}. The meet knows ${Gender.MEN} and ${Gender.WOMEN}.`);
  }
  for (const { athlete } of team.athletes) {
    if (typeof athlete.name !== 'string' || athlete.name.trim().length === 0) {
      throw new TheoreticalMeetError('athlete-without-name', `Team ${team.teamName} has an athlete with no usable name (swimmer id ${athlete.swimCloudSwimmerId ?? 'none'}).`);
    }
    const g = athlete.gender;
    if (g !== undefined && g !== 'unknown' && (g as string) !== (team.gender as string)) {
      throw new TheoreticalMeetError('athlete-gender-mismatch', `${athlete.name} is listed as ${g} on a ${team.gender} roster for ${team.teamName}.`);
    }
  }
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
  /** `sc:{id}` for an athlete with a SwimCloud id, else `nm:{name}:{n}`; see {@link swimmerKeyFor}. */
  swimmerKey: string;
  event: string;
}): string {
  return ['tmseed', enc(args.meetId), args.gender, enc(args.teamName), args.swimmerKey, enc(args.event)].join('|');
}

/** Per-team counter so two same-name athletes with no id still get two ids. */
function swimmerKeyFor(athlete: SwimCloudAthlete, nameCounts: Map<string, number>): string {
  if (athlete.swimCloudSwimmerId !== undefined) return `sc:${enc(athlete.swimCloudSwimmerId)}`;
  const name = normalizeSwimmerName(athlete.name);
  const n = nameCounts.get(name) ?? 0;
  nameCounts.set(name, n + 1);
  return `nm:${enc(name)}:${n}`;
}

/* -------------------------------------------------------------------------- */
/* One athlete                                                                 */
/* -------------------------------------------------------------------------- */

type ChosenSeed = {
  readonly swim: HistoricalSwim;
  readonly candidate: Omit<TheoreticalEventCandidate, 'chosen' | 'rowId' | 'notChosenReason'>;
};

/**
 * The swims the meet can seed from: recorded in the meet course, stamped with
 * the roster athlete's identity (the swims came from a times page that names the
 * swimmer another way, `'Paulk, River J'`, and the caller paired them by id).
 */
function inCourseSwims(
  team: TheoreticalMeetTeamInput,
  athlete: SwimCloudAthlete,
  swims: readonly HistoricalSwim[],
  course: TheoreticalMeetCourse
): { used: HistoricalSwim[]; unknownCourse: number } {
  const used: HistoricalSwim[] = [];
  let unknownCourse = 0;
  for (const swim of swims) {
    if (swim.gender !== team.gender) {
      throw new TheoreticalMeetError('swim-gender-mismatch', `A swim of ${athlete.name} (${swim.event}) is ${String(swim.gender)} on a ${team.gender} roster for ${team.teamName}.`);
    }
    if (swim.timeType === undefined) {
      unknownCourse += 1;
      continue;
    }
    if (swim.timeType === course) used.push({ ...swim, name: athlete.name, team: team.teamName });
  }
  return { used, unknownCourse };
}

function rankBasisOf(strength: Record<string, { basis: TheoreticalRankBasis }> | undefined, event: string): TheoreticalRankBasis {
  const basis = strength?.[event]?.basis;
  if (basis === undefined) {
    throw new TheoreticalMeetError('seed-provenance-missing', `The selector gave no ranking basis for ${event}.`);
  }
  return basis;
}

/** The recorded swim behind one selector best: event, time and the swim row itself. */
function traceSeed(
  selectorEvent: string,
  best: { time: string; convertedFrom?: { sourceCourse: string; sourceEvent: string; sourceTime: string } },
  course: TheoreticalMeetCourse,
  swims: readonly HistoricalSwim[]
): { event: string; time: string; swim: HistoricalSwim } {
  let event = selectorEvent;
  let time = best.time;
  if (course !== 'SCY') {
    const from = best.convertedFrom;
    if (from === undefined || from.sourceCourse !== course) {
      throw new TheoreticalMeetError('seed-provenance-missing', `The selector offered ${selectorEvent} without the ${course} swim it came from.`);
    }
    event = from.sourceEvent;
    time = from.sourceTime;
  }
  const swim = swims.find(s => s.event === event && s.time === time);
  if (swim === undefined) {
    throw new TheoreticalMeetError('seed-provenance-missing', `No captured swim matches ${event} ${time}.`);
  }
  return { event, time, swim };
}

type AthleteOutcome =
  | { kind: 'no_seed'; reason: TheoreticalNoSeedAthlete['reason']; unknownCourse: number }
  | { kind: 'seeded'; ranked: ChosenSeed[]; unoffered: string[]; unknownCourse: number };

/** Choose one athlete's events: the selector for the order, the optimizer's cap check for the limit. */
function chooseAthleteEvents(
  input: TheoreticalMeetInput,
  team: TheoreticalMeetTeamInput,
  athlete: SwimCloudAthlete,
  swims: readonly HistoricalSwim[]
): AthleteOutcome {
  const { used, unknownCourse } = inCourseSwims(team, athlete, swims, input.course);
  if (used.length === 0) return { kind: 'no_seed', reason: 'no_swim_in_meet_course', unknownCourse };

  // The selector slices its order to the individual cap. Ask for the whole
  // order (cap 999) and apply the real caps below, so a UI can show the events
  // the caps left out.
  const profile = categorizeBestEvents(
    used,
    team.teamName,
    team.gender,
    athlete.name,
    { ...input.scoringSettings, maxIndividualEntriesPerSwimmer: UNCAPPED },
    [],
    undefined,
    input.meetProgram ?? null,
    null
  );

  const ranked: ChosenSeed[] = profile.primaryEvents.map(selectorEvent => {
    const best = profile.bestByEvent[selectorEvent];
    const seed = traceSeed(selectorEvent, best, input.course, used);
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
 * Whether a seed is provably not older than the roster season. SwimCloud
 * numbers seasons in time order (checked on the real swimmer 1330318 response:
 * season 21 holds 2018, season 29 holds 2025-2026). Anything that cannot be
 * compared counts as "not proven", which keeps the caveat.
 */
function seedProvenNotOlder(seedSeasonId: string | undefined, rosterSeasonId: string | undefined): boolean {
  if (seedSeasonId === undefined || rosterSeasonId === undefined) return false;
  if (!/^\d+$/.test(seedSeasonId) || !/^\d+$/.test(rosterSeasonId)) return false;
  return Number(seedSeasonId) >= Number(rosterSeasonId);
}

/* -------------------------------------------------------------------------- */
/* The builder                                                                 */
/* -------------------------------------------------------------------------- */

type TeamAccumulator = {
  rows: SwimmerResult[];
  noTimes: TheoreticalAthleteRef[];
  noSeed: TheoreticalNoSeedAthlete[];
  duplicates: TheoreticalDuplicateAthlete[];
  perSwimmer: TheoreticalSwimmerEvents[];
  seedSeasonIds: (string | undefined)[];
  unknownCourseSwims: number;
  swimmersRankedOnTime: number;
};

function newAccumulator(): TeamAccumulator {
  return { rows: [], noTimes: [], noSeed: [], duplicates: [], perSwimmer: [], seedSeasonIds: [], unknownCourseSwims: 0, swimmersRankedOnTime: 0 };
}

function teamCaveats(input: TheoreticalMeetInput, team: TheoreticalMeetTeamInput, acc: TeamAccumulator, totalCap: number | undefined): string[] {
  const caveats: string[] = [];
  const notProven = acc.seedSeasonIds.some(id => !seedProvenNotOlder(id, team.rosterSeasonId));
  if (notProven) {
    const olderKnown = acc.seedSeasonIds.filter(id => id !== undefined && team.rosterSeasonId !== undefined && /^\d+$/.test(id) && /^\d+$/.test(team.rosterSeasonId) && Number(id) < Number(team.rosterSeasonId)).length;
    const detail = team.rosterSeasonId === undefined
      ? ' The roster season is not known, so the age of each seed is not checked.'
      : ` ${olderKnown} of ${acc.seedSeasonIds.length} seeds are older than roster season ${team.rosterSeasonId}.`;
    caveats.push(`${ALL_TIME_BEST_CAVEAT}${detail}`);
  }
  if (team.athletes.length === 0) {
    caveats.push(`The roster for ${team.teamName} (${team.gender}) lists no athletes. No rows were made.`);
  }
  if (input.course !== 'SCY') caveats.push(RANKED_ON_ESTIMATE_CAVEAT);
  if (totalCap !== undefined && totalCap < UNCAPPED) caveats.push(TOTAL_CAP_CAVEAT);
  if (acc.swimmersRankedOnTime > 0) {
    caveats.push(
      `${acc.swimmersRankedOnTime} swimmer(s) have events ranked by raw time, not by distance to a published cut. This team's division is unknown or no standard covers the event, so short events can win a capped lineup.`
    );
  }
  if (acc.unknownCourseSwims > 0) {
    caveats.push(`${acc.unknownCourseSwims} captured swim(s) have no recorded course. They were not used.`);
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
  input: TheoreticalMeetInput,
  team: TheoreticalMeetTeamInput,
  entry: TheoreticalMeetAthleteInput,
  swimmerKey: string,
  acc: TeamAccumulator,
  sources: Map<string, TheoreticalSeedSource>
): void {
  const { athlete } = entry;
  const ref: TheoreticalAthleteRef = {
    name: athlete.name,
    ...(athlete.swimCloudSwimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimCloudSwimmerId }),
  };
  if (entry.swims === undefined) {
    acc.noTimes.push(ref);
    return;
  }
  const outcome = chooseAthleteEvents(input, team, athlete, entry.swims);
  acc.unknownCourseSwims += outcome.unknownCourse;
  if (outcome.kind === 'no_seed') {
    acc.noSeed.push({ ...ref, reason: outcome.reason });
    return;
  }
  const accepted = applyEntryCaps(outcome.ranked, input.scoringSettings);
  const events: TheoreticalEventCandidate[] = [];
  outcome.ranked.forEach((seed, index) => {
    if (!accepted[index]) {
      events.push({ ...seed.candidate, chosen: false, notChosenReason: 'entry_cap' });
      return;
    }
    const row = buildRow({ meetId: input.meetId, team, athlete, swimmerKey, seed });
    acc.rows.push(row);
    acc.seedSeasonIds.push(seed.swim.seasonId);
    const retrievedAt = seed.swim.retrievedAt ?? entry.retrievedAt;
    sources.set(row.id, {
      ...(athlete.swimCloudSwimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimCloudSwimmerId }),
      ...(entry.captureId === undefined ? {} : { captureId: entry.captureId }),
      ...(retrievedAt === undefined ? {} : { retrievedAt }),
      course: input.course,
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

function processTeam(
  input: TheoreticalMeetInput,
  team: TheoreticalMeetTeamInput,
  claimed: Map<string, string>,
  sources: Map<string, TheoreticalSeedSource>,
  totalCap: number | undefined
): { acc: TeamAccumulator; report: TheoreticalTeamReport } {
  const acc = newAccumulator();
  const nameCounts = new Map<string, number>();
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
    processAthlete(input, team, entry, swimmerKeyFor(entry.athlete, nameCounts), acc, sources);
  }
  const report: TheoreticalTeamReport = {
    teamName: team.teamName,
    gender: team.gender,
    rowsCreated: acc.rows.length,
    athletesWithNoTimes: acc.noTimes,
    athletesWithNoSeedInMeetCourse: acc.noSeed,
    duplicateAcrossTeams: acc.duplicates,
    eventsChosenPerSwimmer: acc.perSwimmer,
    caveats: teamCaveats(input, team, acc, totalCap),
  };
  return { acc, report };
}

/**
 * Build psych-sheet rows for a theoretical meet from several crawled teams.
 *
 * Throws {@link TheoreticalMeetError} on a bad course, an unknown team gender,
 * settings with no individual cap or a cap that is not a whole number of 1 or
 * more, an athlete with no name, a repeated team, or a seed the builder cannot
 * trace to a captured swim.
 */
export function buildTheoreticalMeetSeeds(input: TheoreticalMeetInput): TheoreticalMeetSeeds {
  if (typeof input.meetId !== 'string' || input.meetId.trim().length === 0) {
    throw new TheoreticalMeetError('invalid-input', 'The meet id is empty. Row ids are scoped by it.');
  }
  validateCourse(input.course);
  const { totalCap } = validateSettings(input.scoringSettings);
  const seenTeams = new Set<string>();
  for (const team of input.teams) {
    validateTeam(team);
    const key = teamKey(team);
    if (seenTeams.has(key)) {
      throw new TheoreticalMeetError('duplicate-team', `${team.teamName} (${team.gender}) was given twice.`);
    }
    seenTeams.add(key);
  }

  const claimed = new Map<string, string>();
  const sources = new Map<string, TheoreticalSeedSource>();
  const rows: SwimmerResult[] = [];
  const teamReports: TheoreticalTeamReport[] = [];
  for (const team of input.teams) {
    const { acc, report } = processTeam(input, team, claimed, sources, totalCap);
    rows.push(...acc.rows);
    teamReports.push(report);
  }

  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new TheoreticalMeetError('row-id-collision', `Two rows share the id ${row.id}.`);
    ids.add(row.id);
  }

  const caveats = [...new Set([...teamReports.flatMap(t => t.caveats), RELAYS_EXCLUDED_CAVEAT])];
  return {
    rows,
    psychMenResults: rows.filter(r => r.gender === Gender.MEN),
    psychWomenResults: rows.filter(r => r.gender === Gender.WOMEN),
    sources,
    report: { course: input.course, totalRows: rows.length, teams: teamReports, caveats },
  };
}
