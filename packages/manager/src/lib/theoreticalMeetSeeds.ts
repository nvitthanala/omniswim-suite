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
 * 7. **Exhibition seeds are labelled, and included by default.** A swim the source
 *    marks exhibition (`HistoricalSwim.isExhibition === true`) was not scored at
 *    its own meet. It still seeds here, because it is the swimmer's recorded best,
 *    and the report says so (`exhibitionSeedsUsed`, `isExhibition` on the event
 *    candidate and on the row's source record, a team caveat and a meet caveat).
 *    `exhibitionSeeds: 'exclude'` drops those swims before the selector runs.
 *    The fastest-times endpoint holds ONE row per event, so an excluded
 *    exhibition best leaves that event with NO seed. No slower time is used in
 *    its place and none is invented. Absence of the flag means "not known to be
 *    exhibition", so a swim with no flag is never reported as official. The flag
 *    is read here only. It does not touch `isRankableSwim` or any other reader.
 * 8. **Removed events (`excludedEvents`).** A user may take one chosen event out
 *    of a swimmer's lineup. The event stays in the offered order, marked
 *    `notChosenReason: 'removed_by_user'`, and the entry caps are applied to the
 *    order WITHOUT it, by the same {@link canAcceptAnotherEntry} walk. The freed
 *    slot therefore goes to the next-best offered event the caps had left out
 *    (`fillsRemovedSlot: true`), and to nothing else: no event is added that the
 *    selector did not offer, and no time is invented. A removal names a swimmer
 *    by team, gender, {@link theoreticalSwimmerKey} and course-qualified event, so
 *    it does not depend on the meet id and survives a rebuild under a new id. A
 *    removal that matches no offered event is ignored for the rows and listed in
 *    `report.unmatchedExclusions`. A removal of an event the caps would have left
 *    out anyway changes no row; the event is still marked `removed_by_user`.
 * 9. **Relays are optional estimates, built first.** With `includeRelays: true` the builder also
 *    makes relay entries from the swimmers' flat-start individual bests (design:
 *    `docs/reference/THEORETICAL_MEET_PLAN.md`, "Relays from individual bests"). The relay program is the
 *    NSISC championship's five relays; no other conference has one on record, so no relay is built for
 *    it and the report says so. Legs are chosen by the Manager's own selector
 *    ({@link suggestBestRelayLegFill}); the caps are checked by {@link canAcceptAnotherEntry}. Relays are
 *    chosen BEFORE the individual events, and the individual cap walk then starts from each swimmer's relay
 *    count, so the entry caps hold in either order. The reason for the order is the cap, not the points:
 *    a relay leg pays half an individual swim at the same place, but individual-first would fill the
 *    total cap and leave no relay. The user may set `maxRelaysPerSwimmer` (unset by default) so the fill
 *    skips a swimmer already on N relays. A relay is an estimate by construction: it is a
 *    composite that no team swam. Without `includeRelays` nothing changes, byte for byte.
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
import type { HistoricalSwim, RelayLegStroke, ScoringSettings, SwimmerResult } from '@omniswim/core/types';
import { categorizeBestEvents, swimEventIdentity } from '@omniswim/core/lib/athleteHistory';
import { isRankableSwim } from '@omniswim/core/lib/bestTimeEligibility';
import {
  individualEventDistanceStroke,
  listEligibleRelayLegCandidates,
  relayLegEventName,
  relayLegRequirements,
  suggestBestRelayLegFill,
} from '@omniswim/core/lib/relayLegMatching';
import { mergeScoringSettings, presetIdForConference } from '@omniswim/core/lib/scoringDefaults';
import { canAcceptAnotherEntry, type SwimmerEntryCounts } from '@omniswim/core/lib/swimmerEntryLimits';
import { convertTimeToSeconds, formatSecondsToTime, isDivingEvent, normalizeSwimmerName } from '@omniswim/core/lib/utils';
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
  | 'row-id-collision'
  /** The relay options are not usable: an adjustment without `includeRelays`, a value that is not a number of 0 or more, a distance other than 50, 100 or 200, or an adjustment that would take a leg to zero. */
  | 'invalid-relay-settings';

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
  /**
   * What to do with swims the source marks exhibition (`HistoricalSwim.isExhibition`).
   * `'include'` (default): they seed like any other swim and are labelled.
   * `'exclude'`: they are dropped before the selector runs. An event whose only
   * seed was an exhibition swim then has no seed for that swimmer. Anything else
   * throws `invalid-input`.
   */
  readonly exhibitionSeeds?: ExhibitionSeedMode;
  /**
   * (swimmer, event) pairs the user took out of the lineup (rule 8). Absent or
   * empty: the strength-first selection with the entry caps, as before. Repeats
   * are the same removal. A pair that names no offered event is ignored and
   * reported in `report.unmatchedExclusions`. A malformed pair throws `invalid-input`.
   */
  readonly excludedEvents?: readonly TheoreticalEventExclusion[];
  /**
   * `true`: also build relay entries from individual bests (rule 9). They are estimates. Absent or
   * `false`: no relay, and the output is identical to a build that never knew about relays.
   */
  readonly includeRelays?: boolean;
  /**
   * The flying-start adjustment, in seconds per leg distance, entered by the user. Taken off legs 2 to 4
   * of every relay, never leg 1 (a flat start). The app holds no published figure, so there is NO
   * default: absent, or a distance with no value, means no adjustment for that distance. Requires
   * `includeRelays: true`. Each value must be a finite number of 0 or more.
   */
  readonly relayFlyingStartAdjustmentSec?: RelayFlyingStartAdjustment;
  /**
   * "Relays per swimmer: at most N". A user setting, unset by default: absent means the relay fill is bound
   * only by the entry caps, as before. When set, a swimmer already on N relays is not offered another leg.
   * The meet cap stays total-only: this is not a second cap, it only keeps the fill from spending one
   * swimmer's entries on relays. Requires `includeRelays: true`. A whole number of 1 or more.
   */
  readonly maxRelaysPerSwimmer?: number;
  readonly teams: readonly TheoreticalMeetTeamInput[];
}

/** Leg distances a theoretical relay can have (4x50, 4x100, 4x200). */
export type RelayLegDistance = 50 | 100 | 200;
export const RELAY_LEG_DISTANCES: readonly RelayLegDistance[] = [50, 100, 200];
export type RelayFlyingStartAdjustment = Partial<Record<RelayLegDistance, number>>;

/** One (swimmer, event) pair the user removed. Built from a report: `teamName`, `gender`, `TheoreticalSwimmerEvents.swimmerKey`, `TheoreticalEventCandidate.event`. */
export interface TheoreticalEventExclusion {
  /** The team name as given in {@link TheoreticalMeetTeamInput.teamName}. */
  readonly teamName: string;
  readonly gender: Gender;
  /** `TheoreticalSwimmerEvents.swimmerKey` (`sc:{id}` or `nm:{name}`). */
  readonly swimmerKey: string;
  /** Course-qualified label exactly as the candidate carries it (`'100 Free SCY'`). */
  readonly event: string;
}

export type ExhibitionSeedMode = 'include' | 'exclude';

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
  /** Present (`true`) only when the seed swim is marked exhibition at its source. Absent means not known to be exhibition. */
  readonly isExhibition?: true;
}

/* -------------------------------------------------------------------------- */
/* Relay output (shapes follow RELAY_LEG_CREDITS_SPEC.md, "Theoretical meet relays")  */
/* -------------------------------------------------------------------------- */

/**
 * Where a leg time came from. This builder makes only two: `flat-start-best` (leg 1, a real flat-start swim)
 * and `estimated-from-flat-start` (legs 2 to 4: the flat-start best, less the user's adjustment when one is
 * set for that distance). The other two are for real relay-leg credits and are never produced here.
 */
export type RelayLegBasis = 'flat-start-best' | 'real-leadoff-credit' | 'real-takeover-credit' | 'estimated-from-flat-start';

export interface TheoreticalProjectedRelayLeg {
  readonly position: 1 | 2 | 3 | 4;
  readonly name: string;
  readonly team: string;
  readonly classYear: string;
  readonly swimCloudSwimmerId?: string;
  /** The individual event this leg swims, as recorded (`'50 Free SCY'`). */
  readonly legEvent: string;
  readonly stroke: RelayLegStroke;
  readonly legDistanceYards: RelayLegDistance;
  /** The leg time as shown. Leg 1, and any leg with no adjustment, shows the recorded flat-start time verbatim. */
  readonly time: string;
  readonly timeSec: number;
  readonly basis: RelayLegBasis;
  /** `true` on legs 2 to 4. Leg 1 is a real flat-start swim and is not an estimate by itself. */
  readonly estimated?: true;
  /** The recorded flat-start best the leg is built from. */
  readonly flatStartTime: string;
  /** Present only when the user's adjustment was subtracted from this leg. */
  readonly startAdjustmentSec?: number;
  /** Present (`true`) only when the flat-start best is an exhibition swim at its source. */
  readonly isExhibition?: true;
}

export interface TheoreticalProjectedRelay {
  /** Stable id. See {@link theoreticalRelayEntryId}. */
  readonly id: string;
  /** Course-qualified relay label (`'200 Free Relay SCY'`). */
  readonly event: string;
  readonly team: string;
  readonly gender: Gender;
  /** Always four legs, positions 1 to 4. */
  readonly legs: readonly TheoreticalProjectedRelayLeg[];
  /** The sum of the four leg times, rounded to hundredths, as shown. */
  readonly totalTime: string;
  readonly totalSec: number;
  /** Always `true`: no team swam this relay. */
  readonly anyEstimated: true;
  /** `true` when the user's flying-start adjustment changed at least one leg. */
  readonly adjustmentApplied: boolean;
}

/** Why one leg of an absent relay could not be filled. */
export interface TheoreticalRelayMissingLeg {
  readonly position: 1 | 2 | 3 | 4;
  /** The individual event the leg swims (`'50 Breaststroke'`). */
  readonly legEvent: string;
  /** Swimmers on the team with a flat-start best (in the meet course) at that event. 0 means nobody. */
  readonly swimmersWithBest: number;
  /** Of those, how many were already on this relay. */
  readonly alreadyOnRelay: number;
  /** Of those, how many are at an entry cap. */
  readonly atEntryCap: number;
  /** Of those, how many are already on the most relays the user allowed (`maxRelaysPerSwimmer`). 0 when no limit is set. */
  readonly atRelayLimit: number;
}

/** A relay the team did not get, and why. Never a zero time. */
export interface TheoreticalRelayAbsent {
  readonly event: string;
  readonly team: string;
  readonly gender: Gender;
  readonly missingLegs: readonly TheoreticalRelayMissingLeg[];
}

/** What the relay build did for one team. Present only when relays were requested. */
export interface TheoreticalTeamRelayReport {
  readonly relays: readonly TheoreticalProjectedRelay[];
  readonly absent: readonly TheoreticalRelayAbsent[];
}

/** What the relay build did overall. Present only when relays were requested. */
export interface TheoreticalMeetRelayReport {
  /** `true`: the conference has a relay program on record (NSISC). `false`: none, so no relay was built. */
  readonly programKnown: boolean;
  /** The relay events built for, in order. Empty when the program is unknown. */
  readonly program: readonly string[];
  readonly relaysBuilt: number;
  readonly relaysAbsent: number;
  /** The adjustment the user entered, per distance. Empty when none was set. */
  readonly flyingStartAdjustmentSec: RelayFlyingStartAdjustment;
  /** The "at most N relays per swimmer" limit the user set, or `null` when none was set. */
  readonly maxRelaysPerSwimmer: number | null;
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
  /**
   * Present when not chosen. `entry_cap`: the entry caps stopped it.
   * `removed_by_user`: the user removed it (`excludedEvents`); it is out of the cap walk.
   */
  readonly notChosenReason?: 'entry_cap' | 'removed_by_user';
  /** Present when chosen: the id of the row built for it. */
  readonly rowId?: string;
  /** Present (`true`) only when the seed swim is marked exhibition at its source. Set on every candidate, chosen or not. */
  readonly isExhibition?: true;
  /**
   * Present (`true`) only on a chosen event the entry caps would have left out
   * had nothing been removed: it took a slot a removal freed.
   */
  readonly fillsRemovedSlot?: true;
  /**
   * Present (`true`) only on a `removed_by_user` event the entry caps would have chosen
   * had nothing been removed: its removal freed a slot. Absent on a removed event the
   * caps would have left out anyway (its removal changed no row).
   */
  readonly chosenWithoutRemovals?: true;
}

export interface TheoreticalSwimmerEvents {
  readonly name: string;
  readonly swimCloudSwimmerId?: string;
  /** The key a {@link TheoreticalEventExclusion} names this swimmer by. See {@link theoreticalSwimmerKey}. */
  readonly swimmerKey: string;
  /** Every offered event, strongest first, with the chosen ones marked. */
  readonly events: readonly TheoreticalEventCandidate[];
  /**
   * `exhibitionSeeds: 'exclude'` only. Course-qualified labels of events this
   * swimmer would have been offered but for an exhibition best, which was
   * dropped. Each has NO seed for this swimmer. Absent when none.
   */
  readonly excludedExhibitionEvents?: readonly string[];
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
   * `all_seeds_exhibition_excluded`: `exhibitionSeeds: 'exclude'` only. Every event that would seed is an
   * exhibition best, which was dropped; with those swims back in, the swimmer would have a seed. The dropped
   * events are in `excludedExhibitionEvents`. (Before this reason existed such a swimmer got `no_event_in_program`.)
   */
  readonly reason:
    | 'no_usable_swim'
    | 'diving_not_supported'
    | 'no_swim_in_meet_course'
    | 'no_event_in_program'
    | 'all_seeds_exhibition_excluded';
  /**
   * `exhibitionSeeds: 'exclude'` only. Events dropped because their best swim is
   * exhibition (see {@link TheoreticalSwimmerEvents.excludedExhibitionEvents}).
   * Set with reason `all_seeds_exhibition_excluded` when they are the only cause of
   * no seed; with another reason it lists the dropped events beside it. Absent when none.
   */
  readonly excludedExhibitionEvents?: readonly string[];
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
  /** Rows whose seed swim is marked exhibition at its source. Always 0 with `exhibitionSeeds: 'exclude'`. At most `rowsCreated`. */
  readonly exhibitionSeedsUsed: number;
  /** `'exclude'` only: events left with no seed because their best swim is exhibition. Always 0 with `'include'`. */
  readonly exhibitionEventsExcluded: number;
  /** Candidates marked `removed_by_user` for this team. Always 0 with no `excludedEvents`. */
  readonly eventsRemovedByUser: number;
  /** No times page was captured. */
  readonly athletesWithNoTimes: readonly TheoreticalAthleteRef[];
  /** A times page was captured and did not parse. */
  readonly athletesWithTimesParseFailed: readonly TheoreticalAthleteRef[];
  readonly athletesWithNoSeedInMeetCourse: readonly TheoreticalNoSeedAthlete[];
  readonly duplicateAcrossTeams: readonly TheoreticalDuplicateAthlete[];
  readonly eventsChosenPerSwimmer: readonly TheoreticalSwimmerEvents[];
  /** Present only when `includeRelays` was set. */
  readonly relayReport?: TheoreticalTeamRelayReport;
  readonly caveats: readonly string[];
}

export interface TheoreticalMeetReport {
  readonly course: TheoreticalMeetCourse;
  readonly totalRows: number;
  /** In the order the teams were given. */
  readonly teams: readonly TheoreticalTeamReport[];
  /** Every team caveat once, plus the meet-wide ones. */
  readonly caveats: readonly string[];
  /** `excludedEvents` pairs (repeats removed) that matched no offered event. They changed nothing. Empty when all matched. */
  readonly unmatchedExclusions: readonly TheoreticalEventExclusion[];
  /** Present only when `includeRelays` was set. */
  readonly relays?: TheoreticalMeetRelayReport;
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
  /**
   * The relay entries (estimates), in team order then program order. Empty without `includeRelays`. They are
   * not rows: the workspace builder turns each into four scored leg rows.
   */
  readonly relayEntries: readonly TheoreticalProjectedRelay[];
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

export const RELAYS_ESTIMATED_CAVEAT =
  "Relays are estimates. Each relay time is the sum of four swimmers' individual best times (flat start), not a time any team swam. Every relay is tagged estimated.";
export const RELAYS_NO_PROGRAM_CAVEAT =
  'Relays were requested, but no relay program is on record in the app for this scoring preset (only NSISC has one), so no relay was built. The app does not guess a relay program.';
export const RELAY_FILL_CAVEAT =
  "Each team has one relay per event. Its legs are filled one leg at a time with the fastest eligible swimmer (the Manager's autofill rule), so it is not a guaranteed fastest relay. A second (B) relay is not built.";
export const RELAY_CAP_CAVEAT =
  "Relay legs are chosen first and count toward each swimmer's entry caps. The reason is the cap: with individual events first, the total cap would be used up and no relay could be built. A relay leg pays half what an individual swim at the same place pays (the relay's points are split over four swimmers), so a swimmer on many relays can give up individual events that are worth more. \"Relays per swimmer\" limits that.";
export function relayLimitCaveat(max: number): string {
  return `Relays per swimmer: at most ${max}. A swimmer already on ${max} ${max === 1 ? 'relay' : 'relays'} is not offered another leg. The entry cap itself stays total-only.`;
}
export const RELAYS_NOT_ADJUSTED_CAVEAT =
  'Flying starts are not adjusted. Legs 2 to 4 use flat-start bests, so a relay time runs slower than a real relay with flying starts.';

/** Meet line when the user entered a flying-start adjustment. Distances with no value are named. */
export function relayAdjustmentCaveat(adjustment: RelayFlyingStartAdjustment): string {
  const set = RELAY_LEG_DISTANCES.filter(d => adjustment[d] !== undefined);
  const unset = RELAY_LEG_DISTANCES.filter(d => adjustment[d] === undefined);
  const given = set.map(d => `${d} yd: ${adjustment[d]} s`).join(', ');
  const none = unset.length === 0 ? '' : ` No adjustment for ${unset.map(d => `${d} yd`).join(', ')} legs.`;
  return `Legs 2 to 4 are reduced by the flying-start adjustment you entered (${given}). Leg 1 is never adjusted. The app holds no published figure.${none}`;
}

/** Meet line when some relays could not be built. */
export function relaysAbsentCaveat(n: number): string {
  return `${n} relay(s) could not be built because a team did not have four eligible swimmers. Those teams have no entry in that relay, so their totals run low.`;
}

/** Team line and meet line when exhibition seeds are included. `n` of `m` seeds. */
export function exhibitionIncludedCaveat(n: number, m: number): string {
  return `${n} of ${m} seeds come from exhibition swims (not scored in their meet). They are included.`;
}

/** Team line and meet line when exhibition seeds are excluded. `n` events were left with no seed. */
export function exhibitionExcludedCaveat(n: number): string {
  return `${n} event(s) were dropped because the swimmer's best swim there is exhibition (not scored in their meet). Exhibition seeds are excluded, so each of those events has NO seed. No slower time was used in its place.`;
}

/** Team line and meet line when the user removed events. `n` events were removed. */
export function removedEventsCaveat(n: number): string {
  return `${n} event(s) were removed by you. The freed slot goes to the swimmer's next-best offered event under the same entry caps, so a swimmer can enter an event the strength order alone would have left out.`;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Settings saved from a PDF or SwimCloud meet carry `usePdfPlacePoints: true`
 * (`buildScoringPatchForParsedPdf`). Under that flag the engine scores from the
 * HyTek Points column and skips the conference override, so with theoretical rows
 * (which carry no PDF points) every team would score 0 and the entry caps would
 * not be the conference's. The caller must pass the preset's own settings.
 */
export const PDF_POINTS_SETTINGS_MESSAGE =
  'The scoring settings carry usePdfPlacePoints: true. Theoretical rows carry no PDF points, so every team would score 0 and the conference entry caps would not apply. ' +
  'Pass preset settings instead: settingsForBuiltInScoringPreset(presetIdForConference(conference)) from @omniswim/core/lib/scoringDefaults, or the generic preset when the conference has none.';

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
  if (raw.usePdfPlacePoints === true) {
    throw new TheoreticalMeetError('invalid-scoring-settings', PDF_POINTS_SETTINGS_MESSAGE);
  }
  requireCap(raw.maxIndividualEntriesPerSwimmer, 'maxIndividualEntriesPerSwimmer', true);
  const settings = mergeScoringSettings(raw, { conference: input.conference });
  const indCap = requireCap(settings.maxIndividualEntriesPerSwimmer, 'maxIndividualEntriesPerSwimmer', true) as number;
  const totalCap = requireCap(settings.maxTotalEntriesPerSwimmer, 'maxTotalEntriesPerSwimmer', false);
  return { settings, indCap, totalCap };
}

function resolveExhibitionMode(mode: unknown): ExhibitionSeedMode {
  if (mode === undefined) return 'include';
  if (mode === 'include' || mode === 'exclude') return mode;
  throw new TheoreticalMeetError('invalid-input', `exhibitionSeeds is ${JSON.stringify(mode)}. Use 'include' or 'exclude'.`);
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

function validateExclusions(list: unknown): TheoreticalEventExclusion[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new TheoreticalMeetError('invalid-input', 'excludedEvents must be a list.');
  return list.map((raw: unknown, index) => {
    const e = raw as Partial<TheoreticalEventExclusion> | null;
    const ok =
      e !== null &&
      typeof e === 'object' &&
      typeof e.teamName === 'string' &&
      e.teamName.trim().length > 0 &&
      (e.gender === Gender.MEN || e.gender === Gender.WOMEN) &&
      typeof e.swimmerKey === 'string' &&
      e.swimmerKey.length > 0 &&
      typeof e.event === 'string' &&
      e.event.length > 0;
    if (!ok) {
      throw new TheoreticalMeetError('invalid-input', `excludedEvents[${index}] needs a team name, a team gender, a swimmer key and an event. Got ${JSON.stringify(raw)}.`);
    }
    // Copy the four fields. The caller's object may carry more, and `report.unmatchedExclusions` hands these back.
    return { teamName: e.teamName as string, gender: e.gender as Gender, swimmerKey: e.swimmerKey as string, event: e.event as string };
  });
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

/** The key a swimmer carries in a row id and in {@link TheoreticalSwimmerEvents.swimmerKey}. Exported so a caller can predict it. */
export const theoreticalSwimmerKey = swimmerKeyFor;

/**
 * One string per (team, gender, swimmer, event), for sets and maps on the caller's side. The team name is
 * normalized the way the builder compares teams. Two exclusions with one key are the same removal.
 * The team name and the event are encoded like the parts of {@link theoreticalSeedRowId}, so a `|` inside either
 * cannot make two different removals share a key.
 */
export function theoreticalEventExclusionKey(e: TheoreticalEventExclusion): string {
  return [e.gender, enc(normalizeSwimmerName(e.teamName)), e.swimmerKey, enc(e.event)].join('|');
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
  readonly exhibition: ExhibitionSeedMode;
  /** Keys of the user's removals ({@link theoreticalEventExclusionKey}). */
  readonly exclusions: ReadonlySet<string>;
  /** Filled while building: the removal keys that matched an offered event. */
  readonly matchedExclusions: Set<string>;
  /** `null`: relays were not requested. */
  readonly relays: RelayPlan | null;
};

type ChosenSeed = {
  readonly swim: HistoricalSwim;
  readonly candidate: Omit<TheoreticalEventCandidate, 'chosen' | 'rowId' | 'notChosenReason'>;
};

type SwimSplit = {
  /** Non-dive swims recorded in the meet course, stamped with the roster athlete's identity. Exhibition swims are left out when the mode is `'exclude'`. */
  used: HistoricalSwim[];
  /** `'exclude'` only: the meet-course swims marked exhibition that were left out of `used`, stamped like `used`. */
  excludedExhibition: HistoricalSwim[];
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
function splitSwims(
  team: TheoreticalMeetTeamInput,
  athlete: SwimCloudAthlete,
  swims: readonly HistoricalSwim[],
  course: string,
  exhibition: ExhibitionSeedMode
): SwimSplit {
  const split: SwimSplit = { used: [], excludedExhibition: [], unknownCourse: 0, hasNonDiving: false };
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
    if (swim.timeType !== course) continue;
    const stamped = { ...swim, name: athlete.name, team: team.teamName };
    (exhibition === 'exclude' && swim.isExhibition === true ? split.excludedExhibition : split.used).push(stamped);
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
  // Same event and time on an exhibition swim and an official one: the seed is
  // backed by the official swim, so it is never labelled exhibition.
  const matches = swims.filter(s => s.event === selectorEvent && s.time === best.time);
  const swim = matches.find(s => s.isExhibition !== true) ?? matches[0];
  if (swim === undefined) {
    throw new TheoreticalMeetError('seed-provenance-missing', `No captured swim matches ${selectorEvent} ${best.time}.`);
  }
  return { event: selectorEvent, time: best.time, swim };
}

type AthleteOutcome =
  | { kind: 'no_seed'; reason: TheoreticalNoSeedAthlete['reason']; unknownCourse: number; excludedExhibition: string[]; used: HistoricalSwim[] }
  | { kind: 'seeded'; ranked: ChosenSeed[]; unoffered: string[]; unknownCourse: number; excludedExhibition: string[]; used: HistoricalSwim[] };

/** The selector's strength order over `used`, each event traced to its recorded swim. The selector gets the whole order (cap 999). */
function rankSeeds(ctx: Context, team: TheoreticalMeetTeamInput, athlete: SwimCloudAthlete, used: readonly HistoricalSwim[]): ChosenSeed[] {
  // The selector slices its order to the individual cap. Ask for the whole
  // order (cap 999) and apply the real caps later, so a UI can show the events
  // the caps left out.
  const profile = categorizeBestEvents(
    [...used],
    team.teamName,
    team.gender,
    athlete.name,
    { ...ctx.settings, maxIndividualEntriesPerSwimmer: UNCAPPED },
    [],
    undefined,
    ctx.meetProgram,
    null
  );
  return profile.primaryEvents.map(selectorEvent => {
    const seed = traceSeed(selectorEvent, profile.bestByEvent[selectorEvent], used);
    return {
      swim: seed.swim,
      candidate: {
        event: seed.event,
        time: seed.time,
        rankBasis: rankBasisOf(profile.strengthByEvent as Record<string, { basis: TheoreticalRankBasis }> | undefined, selectorEvent),
        ...(seed.swim.isExhibition === true ? { isExhibition: true as const } : {}),
      },
    };
  });
}

/**
 * `'exclude'` only: the events the selector would offer with the excluded
 * exhibition swims back in, that it no longer offers without them. Those events
 * have no seed. An event an official swim still seeds is not listed.
 */
function droppedExhibitionEvents(
  ctx: Context,
  team: TheoreticalMeetTeamInput,
  athlete: SwimCloudAthlete,
  split: SwimSplit,
  kept: readonly ChosenSeed[]
): string[] {
  if (split.excludedExhibition.length === 0) return [];
  const keptIdentities = new Set(kept.map(r => swimEventIdentity(r.candidate.event)));
  const all = rankSeeds(ctx, team, athlete, [...split.used, ...split.excludedExhibition]);
  return all.map(r => r.candidate.event).filter(event => !keptIdentities.has(swimEventIdentity(event)));
}

/** Choose one athlete's events: the selector for the order, the optimizer's cap check for the limit. */
function chooseAthleteEvents(
  ctx: Context,
  team: TheoreticalMeetTeamInput,
  athlete: SwimCloudAthlete,
  swims: readonly HistoricalSwim[]
): AthleteOutcome {
  if (swims.length === 0) return { kind: 'no_seed', reason: 'no_usable_swim', unknownCourse: 0, excludedExhibition: [], used: [] };
  const split = splitSwims(team, athlete, swims, ctx.course, ctx.exhibition);
  const { used, unknownCourse, hasNonDiving } = split;
  if (!hasNonDiving) return { kind: 'no_seed', reason: 'diving_not_supported', unknownCourse, excludedExhibition: [], used: [] };
  if (used.length === 0 && split.excludedExhibition.length === 0) {
    return { kind: 'no_seed', reason: 'no_swim_in_meet_course', unknownCourse, excludedExhibition: [], used: [] };
  }

  const ranked = used.length === 0 ? [] : rankSeeds(ctx, team, athlete, used);
  const excludedExhibition = droppedExhibitionEvents(ctx, team, athlete, split, ranked);
  if (ranked.length === 0) {
    // Dropped exhibition events mean the swimmer would have a seed with those swims back in.
    const reason = excludedExhibition.length > 0 ? 'all_seeds_exhibition_excluded' : 'no_event_in_program';
    return { kind: 'no_seed', reason, unknownCourse, excludedExhibition, used };
  }

  const offered = new Set(ranked.map(r => swimEventIdentity(r.candidate.event)));
  const unoffered = [...new Set(used.filter(s => !offered.has(swimEventIdentity(s.event))).map(s => s.event))];
  return { kind: 'seeded', ranked, unoffered, unknownCourse, excludedExhibition, used };
}

/**
 * Mark the first events the caps accept, in strength order. Mirrors `addAthleteEventPlans`.
 * A removed event is skipped: it is not accepted and it uses no slot, so the next event meets the same cap check.
 */
function applyEntryCaps(
  ranked: readonly ChosenSeed[],
  settings: ScoringSettings,
  removed: readonly boolean[] = [],
  /** The swimmer's relay entries, chosen before the individual events. Absent: no relay (the count starts at zero). */
  relayCounts?: SwimmerEntryCounts
): boolean[] {
  const counts: SwimmerEntryCounts =
    relayCounts === undefined
      ? { individual: 0, relayEvents: new Set<string>(), relayCount: 0, total: 0 }
      : { individual: 0, relayEvents: new Set(relayCounts.relayEvents), relayCount: relayCounts.relayCount, total: relayCounts.total ?? relayCounts.relayCount };
  return ranked.map((r, index) => {
    if (removed[index] === true) return false;
    if (!canAcceptAnotherEntry(counts, settings, r.candidate.event)) return false;
    counts.individual += 1;
    counts.total = (counts.total ?? 0) + 1;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Relays (estimates), chosen before the individual events                     */
/* -------------------------------------------------------------------------- */

/**
 * The NSISC championship relay program, in the order the meet runs it. Read from the real 2026 NSISC
 * results: `tests/fixtures/nsisc-2026-relay-followups-r1.json` (men: Events 2, 11, 20, 31, 42) and the
 * women's rows of `data/meets.json` (Events 1, 10, 19, 30, 41). The same five events in both genders:
 * 4x200 free, 4x50 medley, 4x100 medley, 4x50 free, 4x100 free. Labels follow the individual rows.
 */
export const NSISC_RELAY_PROGRAM: readonly string[] = [
  '800 Free Relay SCY',
  '200 Medley Relay SCY',
  '400 Medley Relay SCY',
  '200 Free Relay SCY',
  '400 Free Relay SCY',
];

/**
 * The relay events a conference scores, or `null` when the app has none on record. Only NSISC has one.
 * `null` is not an empty program: it says the build did not know, and no relay is guessed.
 */
export function theoreticalRelayProgram(conference: string | undefined): readonly string[] | null {
  return presetIdForConference(conference) === 'nsisc' ? NSISC_RELAY_PROGRAM : null;
}

/** Position of a relay label in the NSISC program, or -1. Used to order relay rows. */
export function theoreticalRelayProgramIndex(event: string): number {
  return NSISC_RELAY_PROGRAM.indexOf(event);
}

/** Id of one relay entry. Every part is URI-encoded, the meet id is part of it, so it is unique per workspace. */
export function theoreticalRelayEntryId(args: { meetId: string; gender: Gender; teamName: string; event: string }): string {
  return ['tmrelay', enc(args.meetId), args.gender, enc(args.teamName), enc(args.event)].join('|');
}

type RelayPlan = {
  /** `null`: no relay program on record for the conference. Nothing is built. */
  readonly program: readonly string[] | null;
  readonly adjustment: RelayFlyingStartAdjustment;
  /** The user's "at most N relays per swimmer", or `undefined` when unset. */
  readonly maxPerSwimmer: number | undefined;
};

function resolveRelayPlan(input: TheoreticalMeetInput): RelayPlan | null {
  const include = input.includeRelays as unknown;
  const adjustment = input.relayFlyingStartAdjustmentSec as unknown;
  const maxRelays = input.maxRelaysPerSwimmer as unknown;
  if (include !== undefined && include !== true && include !== false) {
    throw new TheoreticalMeetError('invalid-relay-settings', `includeRelays is ${JSON.stringify(include)}. Use true or false.`);
  }
  const given: RelayFlyingStartAdjustment = {};
  if (adjustment !== undefined) {
    if (adjustment === null || typeof adjustment !== 'object' || Array.isArray(adjustment)) {
      throw new TheoreticalMeetError('invalid-relay-settings', 'relayFlyingStartAdjustmentSec must be an object keyed by leg distance (50, 100, 200).');
    }
    for (const [key, value] of Object.entries(adjustment as Record<string, unknown>)) {
      if (!(RELAY_LEG_DISTANCES as readonly number[]).includes(Number(key)) || String(Number(key)) !== key) {
        throw new TheoreticalMeetError('invalid-relay-settings', `A flying-start adjustment for a ${key}-yard leg is not usable. The legs are 50, 100 or 200 yards.`);
      }
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TheoreticalMeetError('invalid-relay-settings', `The flying-start adjustment for ${key}-yard legs is ${JSON.stringify(value)}. It must be a number of seconds, 0 or more.`);
      }
      given[Number(key) as RelayLegDistance] = value;
    }
  }
  if (maxRelays !== undefined && (typeof maxRelays !== 'number' || !Number.isInteger(maxRelays) || maxRelays < 1)) {
    throw new TheoreticalMeetError('invalid-relay-settings', `Relays per swimmer is ${JSON.stringify(maxRelays)}. It must be a whole number of 1 or more, or left unset.`);
  }
  if (include !== true) {
    if (Object.keys(given).length > 0) {
      throw new TheoreticalMeetError('invalid-relay-settings', 'A flying-start adjustment was given, but includeRelays is not true. It would have no effect.');
    }
    if (maxRelays !== undefined) {
      throw new TheoreticalMeetError('invalid-relay-settings', 'Relays per swimmer was given, but includeRelays is not true. It would have no effect.');
    }
    return null;
  }
  return { program: theoreticalRelayProgram(input.conference), adjustment: given, maxPerSwimmer: maxRelays as number | undefined };
}

/** The best flat-start time of one swimmer at one relay-leg event. */
type LegBest = { readonly swim: HistoricalSwim; readonly distance: RelayLegDistance; readonly stroke: RelayLegStroke; readonly seconds: number };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A swimmer's flat-start bests at the events relay legs swim (single-stroke 50, 100 and 200), from the
 * swims already limited to the meet course and the exhibition mode. Only a result counts (`isRankableSwim`:
 * no extracted split, no self-reported time). One best per event, the fastest; on an exact tie an official
 * swim wins over an exhibition one. An unreadable time on such a swim throws: it is never skipped.
 */
function legBestsOf(used: readonly HistoricalSwim[], athleteName: string): LegBest[] {
  const best = new Map<string, LegBest>();
  for (const swim of used) {
    if (!isRankableSwim(swim)) continue;
    const ds = individualEventDistanceStroke(swim.event);
    if (ds === null || !(RELAY_LEG_DISTANCES as readonly number[]).includes(ds.distance)) continue;
    const seconds = convertTimeToSeconds(swim.time);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new TheoreticalMeetError('invalid-input', `${athleteName} has a ${swim.event} time of ${JSON.stringify(swim.time)}, which is not a time. A relay leg is never built from it.`);
    }
    const key = `${ds.distance}|${ds.stroke}`;
    const known = best.get(key);
    const better = known === undefined || seconds < known.seconds || (seconds === known.seconds && known.swim.isExhibition === true && swim.isExhibition !== true);
    if (better) best.set(key, { swim, distance: ds.distance as RelayLegDistance, stroke: ds.stroke, seconds });
  }
  return [...best.values()];
}

type RelayCandidate = {
  readonly athlete: SwimCloudAthlete;
  readonly swimmerKey: string;
  readonly legBests: readonly LegBest[];
};

type TeamRelayOutcome = {
  readonly relays: TheoreticalProjectedRelay[];
  readonly absent: TheoreticalRelayAbsent[];
  /** Each swimmer's entries after the relays, keyed by swimmer key. */
  readonly counts: ReadonlyMap<string, SwimmerEntryCounts>;
};

function makeLeg(
  team: TheoreticalMeetTeamInput,
  candidate: RelayCandidate,
  best: LegBest,
  position: 1 | 2 | 3 | 4,
  adjustment: RelayFlyingStartAdjustment
): TheoreticalProjectedRelayLeg {
  const { athlete } = candidate;
  const adj = position === 1 ? undefined : adjustment[best.distance];
  const base = {
    position,
    name: athlete.name,
    team: team.teamName,
    classYear: athlete.classYear !== undefined && athlete.classYear !== 'unknown' ? athlete.classYear : 'UNKNOWN',
    ...(athlete.swimCloudSwimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimCloudSwimmerId }),
    legEvent: best.swim.event,
    stroke: best.stroke,
    legDistanceYards: best.distance,
    flatStartTime: best.swim.time,
    ...(best.swim.isExhibition === true ? { isExhibition: true as const } : {}),
  };
  if (position === 1) {
    return { ...base, time: best.swim.time, timeSec: round2(best.seconds), basis: 'flat-start-best' };
  }
  if (adj === undefined) {
    return { ...base, time: best.swim.time, timeSec: round2(best.seconds), basis: 'estimated-from-flat-start', estimated: true };
  }
  const adjusted = round2(best.seconds - adj);
  if (!(adjusted > 0)) {
    throw new TheoreticalMeetError(
      'invalid-relay-settings',
      `The flying-start adjustment of ${adj} s takes ${athlete.name}'s ${best.swim.event} (${best.swim.time}) to ${adjusted} s. A leg time must stay above zero.`
    );
  }
  return { ...base, time: formatSecondsToTime(adjusted), timeSec: adjusted, basis: 'estimated-from-flat-start', estimated: true, startAdjustmentSec: adj };
}

/**
 * Build one team's relays, one per program event, before the individual events.
 *
 * The legs come from the Manager's selector, not a new one: {@link suggestBestRelayLegFill} (the function
 * `buildRelaysFromIndividualLineup` calls) takes the fastest eligible swimmer for each leg in turn, never a
 * swimmer already on this relay, never one of the wrong gender. The caps come from
 * {@link canAcceptAnotherEntry} on the swimmer's running counts: a swimmer at a cap is passed to the
 * selector as excluded. A relay with a missing leg charges nobody; its counts are committed only when all
 * four legs are filled.
 */
function buildTeamRelays(
  ctx: Context,
  plan: RelayPlan & { program: readonly string[] },
  team: TheoreticalMeetTeamInput,
  candidates: readonly RelayCandidate[]
): TeamRelayOutcome {
  const counts = new Map<string, SwimmerEntryCounts>();
  const pool: SwimmerResult[] = [];
  const bestById = new Map<string, { candidate: RelayCandidate; best: LegBest }>();
  for (const candidate of candidates) {
    counts.set(candidate.swimmerKey, { individual: 0, relayEvents: new Set<string>(), relayCount: 0, total: 0 });
    for (const best of candidate.legBests) {
      const id = `${candidate.swimmerKey}|${best.distance}|${best.stroke}`;
      bestById.set(id, { candidate, best });
      pool.push({
        id,
        rank: 0,
        name: candidate.athlete.name,
        classYear: 'UNKNOWN',
        team: team.teamName,
        time: best.swim.time,
        points: 0,
        event: best.swim.event,
        gender: team.gender,
      });
    }
  }

  const relays: TheoreticalProjectedRelay[] = [];
  const absent: TheoreticalRelayAbsent[] = [];
  for (const event of plan.program) {
    const template: SwimmerResult = {
      id: 'tmrelay-template',
      rank: 0,
      name: team.teamName,
      classYear: 'UNKNOWN',
      team: team.teamName,
      time: '',
      points: 0,
      event,
      gender: team.gender,
      isRelay: true,
    };
    const atCap = new Set<string>();
    const atRelayLimit = new Set<string>();
    for (const candidate of candidates) {
      const swimmerCounts = counts.get(candidate.swimmerKey) as SwimmerEntryCounts;
      if (!canAcceptAnotherEntry(swimmerCounts, ctx.settings, event)) {
        atCap.add(normalizeSwimmerName(candidate.athlete.name));
      }
      // The user's relay limit: the swimmer is passed to the selector as excluded, like a swimmer at a cap.
      if (plan.maxPerSwimmer !== undefined && swimmerCounts.relayCount >= plan.maxPerSwimmer) {
        atCap.add(normalizeSwimmerName(candidate.athlete.name));
        atRelayLimit.add(normalizeSwimmerName(candidate.athlete.name));
      }
    }
    const assigned = new Set<string>();
    const legs: TheoreticalProjectedRelayLeg[] = [];
    const missing: TheoreticalRelayMissingLeg[] = [];
    const chosen: RelayCandidate[] = [];
    for (let legIndex = 0; legIndex < 4; legIndex += 1) {
      const position = (legIndex + 1) as 1 | 2 | 3 | 4;
      const suggestion = suggestBestRelayLegFill(pool, template, legIndex, assigned, atCap);
      if (suggestion === null) {
        const everyone = listEligibleRelayLegCandidates(pool, event, legIndex, new Set<string>(), team.teamName, team.gender);
        const req = relayLegRequirements(event, legIndex);
        missing.push({
          position,
          legEvent: relayLegEventName(req.legDistanceYards as number, req.stroke),
          swimmersWithBest: everyone.length,
          alreadyOnRelay: everyone.filter(s => assigned.has(normalizeSwimmerName(s.name))).length,
          atEntryCap: everyone.filter(s => atCap.has(normalizeSwimmerName(s.name)) && !atRelayLimit.has(normalizeSwimmerName(s.name))).length,
          atRelayLimit: everyone.filter(s => atRelayLimit.has(normalizeSwimmerName(s.name))).length,
        });
        continue;
      }
      const hit = bestById.get(suggestion.swimmer.id) as { candidate: RelayCandidate; best: LegBest };
      assigned.add(normalizeSwimmerName(hit.candidate.athlete.name));
      chosen.push(hit.candidate);
      legs.push(makeLeg(team, hit.candidate, hit.best, position, plan.adjustment));
    }
    if (missing.length > 0) {
      absent.push({ event, team: team.teamName, gender: team.gender, missingLegs: missing });
      continue;
    }
    for (const candidate of chosen) {
      const c = counts.get(candidate.swimmerKey) as SwimmerEntryCounts;
      c.relayEvents.add(event);
      c.relayCount += 1;
      c.total = (c.total ?? 0) + 1;
    }
    const totalSec = round2(legs.reduce((sum, leg) => sum + leg.timeSec, 0));
    relays.push({
      id: theoreticalRelayEntryId({ meetId: ctx.meetId, gender: team.gender, teamName: team.teamName, event }),
      event,
      team: team.teamName,
      gender: team.gender,
      legs,
      totalTime: formatSecondsToTime(totalSec),
      totalSec,
      anyEstimated: true,
      adjustmentApplied: legs.some(leg => leg.startAdjustmentSec !== undefined),
    });
  }
  return { relays, absent, counts };
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
  exhibitionSeedsUsed: number;
  exhibitionEventsExcluded: number;
  eventsRemovedByUser: number;
  /** Relay entries and absences, when relays were requested. */
  relays: TheoreticalProjectedRelay[];
  relaysAbsent: TheoreticalRelayAbsent[];
};

function newAccumulator(): TeamAccumulator {
  return {
    rows: [],
    noTimes: [],
    parseFailed: [],
    noSeed: [],
    duplicates: [],
    perSwimmer: [],
    seedSeasonIds: [],
    unknownCourseSwims: 0,
    swimmersRankedOnTime: 0,
    exhibitionSeedsUsed: 0,
    exhibitionEventsExcluded: 0,
    eventsRemovedByUser: 0,
    relays: [],
    relaysAbsent: [],
  };
}

/** The exhibition line for a team or the whole meet. Nothing when there is nothing to say. */
function exhibitionCaveats(used: number, rows: number, excluded: number): string[] {
  const lines: string[] = [];
  if (used > 0) lines.push(exhibitionIncludedCaveat(used, rows));
  if (excluded > 0) lines.push(exhibitionExcludedCaveat(excluded));
  return lines;
}

function freshnessCaveat(team: TheoreticalMeetTeamInput, seedSeasonIds: readonly (string | undefined)[]): string | undefined {
  if (seedSeasonIds.every(id => seedInRosterSeason(id, team.rosterSeasonId))) return undefined;
  if (team.rosterSeasonId === undefined) {
    return `${ALL_TIME_BEST_CAVEAT} The roster season is not known, so the season of each seed is not checked.`;
  }
  const other = seedSeasonIds.filter(id => !seedInRosterSeason(id, team.rosterSeasonId)).length;
  return `${ALL_TIME_BEST_CAVEAT} ${other} of ${seedSeasonIds.length} seeds are from a season other than ${team.rosterSeasonId} (a seed with no season id counts as other).`;
}

function teamCaveats(
  team: TheoreticalMeetTeamInput,
  acc: TeamAccumulator,
  caps: { indCap: number; totalCap: number | undefined },
  relaysAccounted: boolean
): string[] {
  const caveats: string[] = [];
  const fresh = freshnessCaveat(team, acc.seedSeasonIds);
  if (fresh !== undefined) caveats.push(fresh);
  if (team.rosterStatus === 'no_rosters_found') {
    caveats.push(`The roster for ${team.teamName} (${team.gender}) lists no athletes (SwimCloud: no rosters found). No rows were made.`);
  }
  const totalCapped = caps.totalCap !== undefined && caps.totalCap < UNCAPPED;
  // With relays built the slots ARE accounted for (relays are chosen first), so the "not reserved" line would be false.
  if (totalCapped && !relaysAccounted) caveats.push(TOTAL_CAP_CAVEAT);
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
  caveats.push(...exhibitionCaveats(acc.exhibitionSeedsUsed, acc.rows.length, acc.exhibitionEventsExcluded));
  if (acc.eventsRemovedByUser > 0) caveats.push(removedEventsCaveat(acc.eventsRemovedByUser));
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

/** One roster athlete after the first pass: who they are and what the selector offered. */
type PreparedAthlete = {
  readonly entry: TheoreticalMeetAthleteInput;
  readonly swimmerKey: string;
  readonly ref: TheoreticalAthleteRef;
  readonly excludedField: { excludedExhibitionEvents?: string[] };
  /** `undefined`: no times page, or it did not parse (already reported). */
  readonly outcome: AthleteOutcome | undefined;
};

/** First pass: report the athlete's data status and run the selector. Makes no row. */
function prepareAthlete(ctx: Context, team: TheoreticalMeetTeamInput, entry: TheoreticalMeetAthleteInput, acc: TeamAccumulator): PreparedAthlete {
  const { athlete } = entry;
  const swimmerKey = swimmerKeyFor(athlete);
  const ref: TheoreticalAthleteRef = {
    name: athlete.name,
    ...(athlete.swimCloudSwimmerId === undefined ? {} : { swimCloudSwimmerId: athlete.swimCloudSwimmerId }),
  };
  if (entry.swims === undefined) {
    (entry.swimsStatus === 'parse_failed' ? acc.parseFailed : acc.noTimes).push(ref);
    return { entry, swimmerKey, ref, excludedField: {}, outcome: undefined };
  }
  const outcome = chooseAthleteEvents(ctx, team, athlete, entry.swims);
  acc.unknownCourseSwims += outcome.unknownCourse;
  acc.exhibitionEventsExcluded += outcome.excludedExhibition.length;
  const excludedField = outcome.excludedExhibition.length === 0 ? {} : { excludedExhibitionEvents: outcome.excludedExhibition };
  return { entry, swimmerKey, ref, excludedField, outcome };
}

/**
 * Second pass: apply the removals and the entry caps and make the rows. `relayCounts` is what the swimmer's
 * relays already use (chosen first); absent means no relay, and the walk is the one it always was.
 */
function finishAthlete(
  ctx: Context,
  team: TheoreticalMeetTeamInput,
  prepared: PreparedAthlete,
  acc: TeamAccumulator,
  sources: Map<string, TheoreticalSeedSource>,
  relayCounts: SwimmerEntryCounts | undefined
): void {
  const { entry, swimmerKey, ref, excludedField, outcome } = prepared;
  const { athlete } = entry;
  if (outcome === undefined) return;
  if (outcome.kind === 'no_seed') {
    acc.noSeed.push({ ...ref, reason: outcome.reason, ...excludedField });
    return;
  }
  const removed = outcome.ranked.map(seed => {
    const key = theoreticalEventExclusionKey({ teamName: team.teamName, gender: team.gender, swimmerKey, event: seed.candidate.event });
    if (!ctx.exclusions.has(key)) return false;
    ctx.matchedExclusions.add(key);
    return true;
  });
  const accepted = applyEntryCaps(outcome.ranked, ctx.settings, removed, relayCounts);
  // The same walk with nothing removed: an event chosen now and not then took a freed slot.
  const baseline = removed.some(Boolean) ? applyEntryCaps(outcome.ranked, ctx.settings, [], relayCounts) : accepted;
  acc.eventsRemovedByUser += removed.filter(Boolean).length;
  const events: TheoreticalEventCandidate[] = [];
  outcome.ranked.forEach((seed, index) => {
    if (removed[index]) {
      events.push({ ...seed.candidate, chosen: false, notChosenReason: 'removed_by_user', ...(baseline[index] ? { chosenWithoutRemovals: true as const } : {}) });
      return;
    }
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
      ...(seed.swim.isExhibition === true ? { isExhibition: true as const } : {}),
    });
    if (seed.swim.isExhibition === true) acc.exhibitionSeedsUsed += 1;
    events.push({ ...seed.candidate, chosen: true, rowId: row.id, ...(baseline[index] ? {} : { fillsRemovedSlot: true as const }) });
  });
  if (events.some((e, i) => accepted[i] && e.rankBasis === 'time')) acc.swimmersRankedOnTime += 1;
  acc.perSwimmer.push({ ...ref, swimmerKey, events, unofferedSeeds: outcome.unoffered, ...excludedField });
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
  const prepared: PreparedAthlete[] = [];
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
    prepared.push(prepareAthlete(ctx, team, entry, acc));
  }
  // Relays first (rule 9). Their entries are charged against the same caps the individual walk reads.
  const relayOutcome = buildRelaysForTeam(ctx, team, prepared);
  if (relayOutcome !== undefined) {
    acc.relays.push(...relayOutcome.relays);
    acc.relaysAbsent.push(...relayOutcome.absent);
  }
  for (const p of prepared) finishAthlete(ctx, team, p, acc, sources, relayOutcome?.counts.get(p.swimmerKey));
  return {
    rows: acc.rows,
    teamName: team.teamName,
    gender: team.gender,
    rosterStatus: team.rosterStatus,
    rowsCreated: acc.rows.length,
    exhibitionSeedsUsed: acc.exhibitionSeedsUsed,
    exhibitionEventsExcluded: acc.exhibitionEventsExcluded,
    eventsRemovedByUser: acc.eventsRemovedByUser,
    athletesWithNoTimes: acc.noTimes,
    athletesWithTimesParseFailed: acc.parseFailed,
    athletesWithNoSeedInMeetCourse: acc.noSeed,
    duplicateAcrossTeams: acc.duplicates,
    eventsChosenPerSwimmer: acc.perSwimmer,
    ...(ctx.relays === null ? {} : { relayReport: { relays: acc.relays, absent: acc.relaysAbsent } }),
    // Slots are accounted for only when relays are really built. Relays asked for under a conference with no
    // relay program build none, so the total cap is still unreserved and its line must stay.
    caveats: teamCaveats(team, acc, caps, ctx.relays?.program != null),
  };
}

/** The team's relays, or `undefined` when relays were not requested or the conference has no relay program. */
function buildRelaysForTeam(ctx: Context, team: TheoreticalMeetTeamInput, prepared: readonly PreparedAthlete[]): TeamRelayOutcome | undefined {
  const plan = ctx.relays;
  if (plan === null || plan.program === null) return undefined;
  const candidates: RelayCandidate[] = [];
  for (const p of prepared) {
    if (p.outcome === undefined) continue;
    const legBests = legBestsOf(p.outcome.used, p.entry.athlete.name);
    if (legBests.length > 0) candidates.push({ athlete: p.entry.athlete, swimmerKey: p.swimmerKey, legBests });
  }
  return buildTeamRelays(ctx, { ...plan, program: plan.program }, team, candidates);
}

/** The meet-wide relay lines. Without relays the one old line, so a build that never asked is unchanged. */
function relayCaveats(plan: RelayPlan | null, report: TheoreticalMeetRelayReport | undefined): string[] {
  if (plan === null || report === undefined) return [RELAYS_EXCLUDED_CAVEAT];
  if (!report.programKnown) return [RELAYS_NO_PROGRAM_CAVEAT, RELAYS_EXCLUDED_CAVEAT];
  const lines: string[] = [];
  if (report.relaysBuilt === 0) lines.push(RELAYS_EXCLUDED_CAVEAT);
  else lines.push(RELAYS_ESTIMATED_CAVEAT, RELAY_FILL_CAVEAT, RELAY_CAP_CAVEAT);
  if (report.relaysBuilt > 0) {
    lines.push(Object.keys(plan.adjustment).length === 0 ? RELAYS_NOT_ADJUSTED_CAVEAT : relayAdjustmentCaveat(plan.adjustment));
  }
  if (report.relaysBuilt > 0 && plan.maxPerSwimmer !== undefined) lines.push(relayLimitCaveat(plan.maxPerSwimmer));
  if (report.relaysAbsent > 0) lines.push(relaysAbsentCaveat(report.relaysAbsent));
  return lines;
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
  const exhibition = resolveExhibitionMode(input.exhibitionSeeds);
  const exclusions = validateExclusions(input.excludedEvents);
  const { settings, indCap, totalCap } = resolveSettings(input);
  const relayPlan = resolveRelayPlan(input);
  const seenTeams = new Set<string>();
  for (const team of input.teams) {
    validateTeam(team);
    const key = teamKey(team);
    if (seenTeams.has(key)) {
      throw new TheoreticalMeetError('duplicate-team', `${team.teamName} (${team.gender}) was given twice.`);
    }
    seenTeams.add(key);
  }

  const ctx: Context = {
    meetId: input.meetId,
    course: 'SCY',
    settings,
    meetProgram: input.meetProgram ?? null,
    exhibition,
    exclusions: new Set(exclusions.map(theoreticalEventExclusionKey)),
    matchedExclusions: new Set<string>(),
    relays: relayPlan,
  };
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

  // Meet-wide totals across teams. A team line with the same numbers as another
  // team's collapses in the set, so the totals are stated once here.
  const meetExhibition = exhibitionCaveats(
    teamReports.reduce((n, t) => n + t.exhibitionSeedsUsed, 0),
    rows.length,
    teamReports.reduce((n, t) => n + t.exhibitionEventsExcluded, 0)
  ).map(line => `All teams: ${line}`);
  const removedTotal = teamReports.reduce((n, t) => n + t.eventsRemovedByUser, 0);
  const meetRemoved = removedTotal > 0 ? [`All teams: ${removedEventsCaveat(removedTotal)}`] : [];
  const relayEntries = teamReports.flatMap(t => t.relayReport?.relays ?? []);
  const relaysAbsent = teamReports.reduce((n, t) => n + (t.relayReport?.absent.length ?? 0), 0);
  const relayReport: TheoreticalMeetRelayReport | undefined =
    relayPlan === null
      ? undefined
      : {
          programKnown: relayPlan.program !== null,
          program: relayPlan.program ?? [],
          relaysBuilt: relayEntries.length,
          relaysAbsent,
          flyingStartAdjustmentSec: relayPlan.adjustment,
          maxRelaysPerSwimmer: relayPlan.maxPerSwimmer ?? null,
        };
  const caveats = [
    ...new Set([...teamReports.flatMap(t => t.caveats), ...meetExhibition, ...meetRemoved, ...relayCaveats(relayPlan, relayReport), DIVING_EXCLUDED_CAVEAT]),
  ];
  const seenUnmatched = new Set<string>();
  const unmatchedExclusions = exclusions.filter(e => {
    const key = theoreticalEventExclusionKey(e);
    if (ctx.matchedExclusions.has(key) || seenUnmatched.has(key)) return false;
    seenUnmatched.add(key);
    return true;
  });
  return {
    rows,
    psychMenResults: rows.filter(r => r.gender === Gender.MEN),
    psychWomenResults: rows.filter(r => r.gender === Gender.WOMEN),
    sources,
    relayEntries,
    report: {
      course: input.course,
      totalRows: rows.length,
      teams: teamReports,
      caveats,
      unmatchedExclusions,
      ...(relayReport === undefined ? {} : { relays: relayReport }),
    },
  };
}
