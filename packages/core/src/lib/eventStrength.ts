/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A swimmer's strongest events, strongest first: the one ranking every entry
 * suggestion uses.
 *
 * ## Why
 *
 * Ranking by raw seconds prefers the shortest events for every swimmer alive,
 * because 20 is less than 900. It measures event length, not swim quality.
 * Under an entry cap that entered distance swimmers in sprints.
 *
 * ## The rules (user decision, 2026-09-24)
 *
 * Each rule breaks the ties of the one before it.
 *
 * 1. **Place in the loaded meet.** When a meet is loaded, an event ranks by the
 *    place the swimmer's time would take in that meet's results for the event
 *    and gender. The place comes from the scoring engine's own placement of an
 *    injected row (`buildMeetPlaceField` in utils.ts). An event the meet holds
 *    no scored field for has no place and ranks after every placed event.
 * 2. **Distance to the division cut.** `swim ÷ cut` against the team's
 *    division table ({@link rankEventsByQuality}). With no meet loaded this is
 *    the first rule. A converted metric time is ranked on its SCY equivalent
 *    and stays an estimate.
 * 3. **Raw seconds.** The last resort, for an event with no place and no
 *    published cut. Each event records which rule placed it
 *    (`EventStrength.basis`), so a UI can say so.
 *
 * Nothing here invents a value. An unmapped team has no division, so no cut;
 * an event the meet did not contest has no place. Absent stays absent.
 *
 * ## Layering
 *
 * This module sits above `cutlineUtils` and below `athleteHistory`, so
 * `athleteHistory` imports it and it imports neither `athleteHistory` nor
 * `eventIdentity` (which imports `athleteHistory`). `utils.ts` sits below the
 * cut lookup, so `buildCategorizedScoringInputs` takes this order as its
 * `eventOrder` argument ({@link catalogEventOrderByStrength}).
 */
import type {
  AthleteEventProfile,
  EventStrength,
  Gender,
  NcaaDivision,
  SwimmerResult,
  Workspace,
} from '../types';
import { divisionForTeamOrNull } from '../data/teamDivisions';
import { compareTimeToCutline } from './cutlineUtils';
import {
  buildMeetPlaceField,
  normalizeSwimmerName,
  type CatalogEventOrder,
  type MeetPlaceField,
} from './utils';
import { getSourceResults } from './meetSource';
import {
  buildAliasResolver,
  IDENTITY_ALIAS_RESOLVER,
  type AthleteAliasResolver,
} from './athleteAliases';
import type { CatalogEventTime } from './rosterCatalog';

export type { EventStrength, EventStrengthBasis } from '../types';
export type { CatalogEventOrder, MeetPlace, MeetPlaceField } from './utils';
export { buildMeetPlaceField } from './utils';

/**
 * What the ranking reads from one best time. `AthleteEventBest` satisfies it.
 */
export type EventBestForRanking = {
  /** SCY seconds. For a metric swim, its SCY equivalent. */
  timeSec: number;
  /** Present when the time was converted from a metric swim. */
  convertedFrom?: unknown;
  /** The time is an estimate (a converted metric swim) with no provenance object. */
  estimate?: boolean;
};

export type EventQualityRanking = {
  /** Rankable events, best first. */
  ranked: string[];
  /** Events with no published standard to judge against, fastest first. */
  unranked: string[];
  /** `swimSeconds / standardSeconds` per rankable event. Lower is better. */
  ratioByEvent: Record<string, number>;
  division: NcaaDivision | null;
  tier: 'A' | 'B' | null;
};

/**
 * Order an athlete's events by how good the swim actually is, not by how short
 * the event is.
 *
 * Sorting by raw elapsed seconds — which this replaces — ranks a 50 Free above a
 * 1650 Free for every swimmer alive, because 20 is less than 900. It measures
 * event length. Under a total-entry cap that silently entered distance swimmers
 * in sprints: on the HSU roster it dropped 1000/1650/500 Free and 400 IM in
 * favour of 50/100 Free for athletes whose distance swims were at the standard
 * and whose sprints were 10%+ off it.
 *
 * The yardstick is each event's published NCAA standard for the team's division,
 * already archived under `data/cutlines/` with a manifest. Ratio = swim ÷
 * standard, so events of wildly different lengths become comparable.
 *
 * Two rules the repo already holds, applied here:
 *
 *  - **An unmapped team is not a D1 team.** With no division we hold no table, so
 *    nothing is rankable and every event comes back in `unranked`.
 *  - **One tier for the whole profile.** A ratio against the permissive tier and a
 *    ratio against the strict tier are different scales; mixing them would make an
 *    event look stronger purely because it was measured against a slower mark.
 *    Events lacking the chosen tier are `unranked`, never quietly rescaled.
 *
 * This is rule 2 of {@link rankEventsByStrength}, which every entry suggestion
 * uses. Moved here from `athleteHistory.ts` (still re-exported there).
 */
export function rankEventsByQuality(
  bestByEvent: Record<string, { timeSec: number }>,
  gender: Gender,
  team: string,
  divisionOverride?: NcaaDivision | null
): EventQualityRanking {
  const events = Object.keys(bestByEvent);
  const byTimeThenName = (list: string[]) =>
    [...list].sort(
      (a, b) => (bestByEvent[a]?.timeSec ?? 0) - (bestByEvent[b]?.timeSec ?? 0) || a.localeCompare(b)
    );

  const division = divisionOverride !== undefined ? divisionOverride : divisionForTeamOrNull(team);
  if (!division) {
    return { ranked: [], unranked: byTimeThenName(events), ratioByEvent: {}, division: null, tier: null };
  }

  const refs = new Map<string, { a: number; b: number }>();
  for (const event of events) {
    const sec = bestByEvent[event]?.timeSec ?? 0;
    const cmp = compareTimeToCutline(sec, gender, event, division);
    refs.set(event, cmp.status === 'ok' ? { a: cmp.aCutSec, b: cmp.bCutSec } : { a: 0, b: 0 });
  }

  const withB = events.filter(e => (refs.get(e)?.b ?? 0) > 0);
  const withA = events.filter(e => (refs.get(e)?.a ?? 0) > 0);
  const tier: 'A' | 'B' | null =
    withB.length > 0 && withB.length >= withA.length ? 'B' : withA.length > 0 ? 'A' : null;
  if (!tier) {
    return { ranked: [], unranked: byTimeThenName(events), ratioByEvent: {}, division, tier: null };
  }

  const ratioByEvent: Record<string, number> = {};
  const ranked: string[] = [];
  const unranked: string[] = [];
  for (const event of events) {
    const ref = tier === 'B' ? refs.get(event)?.b ?? 0 : refs.get(event)?.a ?? 0;
    const sec = bestByEvent[event]?.timeSec ?? 0;
    if (ref > 0 && Number.isFinite(sec) && sec > 0) {
      ratioByEvent[event] = sec / ref;
      ranked.push(event);
    } else {
      unranked.push(event);
    }
  }
  ranked.sort((a, b) => ratioByEvent[a] - ratioByEvent[b] || a.localeCompare(b));
  return { ranked, unranked: byTimeThenName(unranked), ratioByEvent, division, tier };
}

export type EventStrengthOptions = {
  /**
   * The loaded meet's scored fields ({@link meetPlaceFieldForWorkspace}).
   * `null` or absent: no meet is loaded, so rule 1 does not apply.
   */
  meetField?: MeetPlaceField | null;
  /**
   * Leaves the swimmer's own meet rows out of the field (see
   * {@link sameSwimmerPredicate}). A swimmer does not race their own result.
   */
  isSameSwimmer?: (row: SwimmerResult) => boolean;
  /** Same three-state contract as {@link rankEventsByQuality}. */
  divisionOverride?: NcaaDivision | null;
};

export type EventStrengthRanking = EventQualityRanking & {
  /** Every event in the input, strongest first (see {@link compareEventStrength}). */
  order: string[];
  /** The evidence per event: place, cut ratio, seconds, and which rule decided. */
  strengthByEvent: Record<string, EventStrength>;
  /** True when at least one event was placed in the loaded meet (rule 1 applied). */
  rankedAgainstMeet: boolean;
};

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A value beats no value; two values compare low-first; two absences tie. */
function compareOptional(a: number | undefined, b: number | undefined): number {
  if (a != null && b != null) return compareNumbers(a, b);
  if (a != null) return -1;
  if (b != null) return 1;
  return 0;
}

function usableSeconds(sec: number): number {
  return Number.isFinite(sec) && sec > 0 ? sec : Number.POSITIVE_INFINITY;
}

/**
 * Strongest first: meet place, then cut ratio, then raw seconds, then the
 * event label (so the order never depends on input order). An event with a
 * value for a rule sorts ahead of one without.
 */
export function compareEventStrength(a: EventStrength, b: EventStrength): number {
  return (
    compareOptional(a.meetPlace, b.meetPlace) ||
    compareOptional(a.cutRatio, b.cutRatio) ||
    compareNumbers(usableSeconds(a.timeSec), usableSeconds(b.timeSec)) ||
    a.event.localeCompare(b.event)
  );
}

function isEstimate(best: EventBestForRanking | undefined): boolean {
  return Boolean(best && (best.convertedFrom != null || best.estimate === true));
}

/**
 * Rank a swimmer's events, strongest first, by the three rules in this
 * module's header. `bestByEvent` holds one rankable best per event (results
 * only: see `isRankableSwim`), in SCY seconds.
 *
 * The cut-ratio fields (`ranked`, `unranked`, `ratioByEvent`, `division`,
 * `tier`) are {@link rankEventsByQuality}'s, unchanged, so a caller reading
 * them keeps working. `order` is the new strongest-first order.
 */
export function rankEventsByStrength(
  bestByEvent: Record<string, EventBestForRanking>,
  gender: Gender,
  team: string,
  options: EventStrengthOptions = {}
): EventStrengthRanking {
  const quality = rankEventsByQuality(bestByEvent, gender, team, options.divisionOverride);
  const field = options.meetField ?? null;

  const strengthByEvent: Record<string, EventStrength> = {};
  for (const event of Object.keys(bestByEvent)) {
    const best = bestByEvent[event];
    const timeSec = best?.timeSec ?? Number.NaN;
    const placed = field ? field.placeFor(event, timeSec, options.isSameSwimmer) : null;
    const cutRatio = Object.prototype.hasOwnProperty.call(quality.ratioByEvent, event)
      ? quality.ratioByEvent[event]
      : undefined;
    strengthByEvent[event] = {
      event,
      timeSec,
      basis: placed ? 'meet_place' : cutRatio !== undefined ? 'cut_distance' : 'time',
      ...(placed
        ? { meetPlace: placed.place, meetFieldSize: placed.fieldSize, meetEvent: placed.meetEvent }
        : {}),
      ...(cutRatio !== undefined ? { cutRatio } : {}),
      ...(isEstimate(best) ? { estimate: true as const } : {}),
    };
  }

  const order = Object.keys(strengthByEvent).sort((a, b) =>
    compareEventStrength(strengthByEvent[a], strengthByEvent[b])
  );
  const rankedAgainstMeet = order.some(e => strengthByEvent[e].meetPlace != null);
  return { ...quality, order, strengthByEvent, rankedAgainstMeet };
}

/**
 * The loaded meet's scored fields for one gender, read from the FROZEN source
 * copy (`getSourceResults`), the same copy `getAthleteProfile` reads the meet
 * program from, so planned entries cannot move the yardstick they are ranked
 * by. `null` when no meet is loaded.
 */
export function meetPlaceFieldForWorkspace(
  workspace: Workspace,
  gender: Gender
): MeetPlaceField | null {
  return buildMeetPlaceField(getSourceResults(workspace, gender), gender);
}

/**
 * A meet row belongs to this swimmer: same team, and the same name once aliases
 * are resolved (a linked "Cam Mask" row is Camden Mask's own row).
 */
export function sameSwimmerPredicate(
  name: string,
  team: string,
  gender: Gender,
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER
): (row: SwimmerResult) => boolean {
  const teamKey = team.trim();
  const nameKey = normalizeSwimmerName(resolver.resolveAthleteName(name, team, gender));
  return row => {
    const rowTeam = String(row.team ?? '').trim();
    if (rowTeam !== teamKey) return false;
    return normalizeSwimmerName(resolver.resolveAthleteName(String(row.name ?? ''), rowTeam, gender)) === nameKey;
  };
}

/**
 * The strength order for catalog times, for `buildCategorizedScoringInputs`'s
 * `eventOrder`. Build it once per scoring pass: it indexes the loaded meet.
 *
 * `workspace` is the real workspace, not a what-if copy with its results
 * replaced: the meet field is read from its frozen source results.
 */
export function catalogEventOrderByStrength(args: {
  workspace: Workspace;
  gender: Gender;
  team: string;
}): CatalogEventOrder {
  const meetField = meetPlaceFieldForWorkspace(args.workspace, args.gender);
  const resolver = buildAliasResolver(args.workspace);
  return (athleteName: string, times: readonly CatalogEventTime[]): CatalogEventTime[] => {
    const bestByEvent: Record<string, EventBestForRanking> = {};
    const timeByEvent = new Map<string, CatalogEventTime>();
    for (const t of times) {
      if (timeByEvent.has(t.event)) {
        throw new Error(
          `catalogEventOrderByStrength: two times for ${athleteName} in ${t.event}; expected one per event`
        );
      }
      timeByEvent.set(t.event, t);
      bestByEvent[t.event] = { timeSec: t.timeSecondsScy, estimate: t.timeType !== 'SCY' };
    }
    const ranking = rankEventsByStrength(bestByEvent, args.gender, args.team, {
      meetField,
      isSameSwimmer: sameSwimmerPredicate(athleteName, args.team, args.gender, resolver),
    });
    return ranking.order.map(event => timeByEvent.get(event) as CatalogEventTime);
  };
}

/** The profile fields {@link rankEventsByStrength} fills, for the two profile builders. */
export function profileRankingFields(
  ranking: EventStrengthRanking
): Pick<
  AthleteEventProfile,
  | 'qualityByEvent'
  | 'unrankedEvents'
  | 'rankingDivision'
  | 'rankingTier'
  | 'strengthByEvent'
  | 'rankedAgainstMeet'
> {
  return {
    qualityByEvent: ranking.ratioByEvent,
    unrankedEvents: ranking.unranked,
    rankingDivision: ranking.division,
    rankingTier: ranking.tier,
    strengthByEvent: ranking.strengthByEvent,
    rankedAgainstMeet: ranking.rankedAgainstMeet,
  };
}
