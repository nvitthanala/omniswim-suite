/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay-leg candidates from athlete history (plans/2026-09-24, item R1 e).
 *
 * A relay leg used to take a swim only from the loaded meet's result rows and
 * the recruit rows. A swimmer with no swim at the leg's event at the meet was
 * never offered for the leg, however fast their recorded history: Colton
 * Bennett (Henderson State) swam no 50 Free at the 2026 NSISC championships,
 * and his 22.93 50 Free SCY (`hsuroster26-27.txt`) never reached a 50 leg.
 *
 * {@link relayLegHistoryCandidates} adds those swims, under four rules:
 *
 * 1. **Only a result.** A history swim qualifies only through `isRankableSwim`:
 *    never an extracted split, never a self-reported time, never an event its
 *    recorded course does not swim. A swim whose course nobody recorded is
 *    left out too (`recordedCourseOfSwim`): it cannot be stated in yards
 *    without a guess.
 * 2. **Only the leg's exact event.** The swim, stated in SCY, must be the
 *    individual event a leg of one of the gender's loaded relays swims
 *    (`isRelayLegEvent`): a 50 Free for a 50 free leg, never a 500.
 * 3. **Never over a meet or recruit swim.** A swimmer who already has a row at
 *    the leg's event in the pool gets no history candidate for it, even a
 *    faster one. Gavin Kock's history 20.46 50 Free does not displace his
 *    20.47 at the meet.
 * 4. **Only a swimmer already on the roster.** History is read only for a
 *    swimmer the pool already holds (same team, same name after the alias
 *    links), so the roster gates the pool passed ("drop seniors", removed
 *    swimmers) reach history too, and the candidate takes that swimmer's
 *    class year and name spelling.
 *
 * Each candidate is one row per swimmer and leg event: the fastest qualifying
 * swim once stated in SCY, the same rule the athlete profile's best uses. It
 * carries `relayLegHistory` (the swim as recorded), and `convertedFrom` when
 * the SCY time came out of a metric conversion.
 *
 * A candidate is never an individual entry. `simulateRoster` receives the
 * rows as `relayLegOnlyPool`: an override may resolve onto one, and no row is
 * ever emitted.
 *
 * Time trials: a history swim flagged as one still qualifies, exactly as a
 * meet time-trial row does today. Whether a time trial may fill a relay leg
 * is an open user question (R1 g); change both together or neither.
 */

import {
  Gender,
  type HistoricalSwim,
  type RelayLegStroke,
  type ScyConversionProvenance,
  type SwimmerResult,
  type Workspace,
} from '../types';
import { aliasNameKey, buildAliasResolver } from './athleteAliases';
import { isRankableSwim } from './bestTimeEligibility';
import { recordedCourseOfSwim } from './courseEvents';
import {
  individualEventDistanceStroke,
  relayLegEventKey,
  relayLegEventName,
  relayStrokeForIndex,
} from './relayLegMatching';
import { relayLegDistanceYardsOfEvent } from './relaySplits';
import {
  convertTimeToSeconds,
  isRelayResult,
  scyConversionOutcome,
  scyConversionProvenance,
} from './utils';

/** One leg event: the distance and stroke a relay leg swims. */
type LegEvent = { distance: number; stroke: RelayLegStroke };

/**
 * The individual events the legs of `results`' relays swim, keyed by the
 * canonical event name (`50 Freestyle`, `100 Backstroke`). A relay whose label
 * names no distance adds none.
 */
function relayLegEventsOf(results: readonly SwimmerResult[]): Map<string, LegEvent> {
  const legEvents = new Map<string, LegEvent>();
  const seenRelays = new Set<string>();
  for (const row of results) {
    if (!isRelayResult(row) || seenRelays.has(row.event)) continue;
    seenRelays.add(row.event);
    const distance = relayLegDistanceYardsOfEvent(row.event);
    if (distance == null) continue;
    const lower = row.event.toLowerCase();
    for (let legIndex = 0; legIndex < 4; legIndex++) {
      const stroke = relayStrokeForIndex(lower, legIndex);
      legEvents.set(relayLegEventName(distance, stroke), { distance, stroke });
    }
  }
  return legEvents;
}

/**
 * `relayLegEventKey` per label. A workspace holds a few dozen distinct labels,
 * and every re-score reads each pool row's label; normalizing once per label
 * keeps the what-if projection's cost where it was. Cleared if it ever grows
 * past a bound no real workspace reaches.
 */
const LEG_EVENT_KEY_BY_LABEL = new Map<string, string>();
const LEG_EVENT_KEY_MEMO_LIMIT = 5000;

function memoLegEventKey(label: string): string {
  let key = LEG_EVENT_KEY_BY_LABEL.get(label);
  if (key === undefined) {
    if (LEG_EVENT_KEY_BY_LABEL.size >= LEG_EVENT_KEY_MEMO_LIMIT) LEG_EVENT_KEY_BY_LABEL.clear();
    key = relayLegEventKey(label);
    LEG_EVENT_KEY_BY_LABEL.set(label, key);
  }
  return key;
}

/** A history swim that may fill a leg, stated in SCY. */
type HistoryLegSwim = {
  swim: HistoricalSwim;
  /** Canonical name of the individual event the swim is, in SCY. */
  legEvent: string;
  /** Time stated in SCY. */
  time: string;
  timeSec: number;
  course: 'SCY' | 'LCM' | 'SCM';
  convertedFrom?: ScyConversionProvenance;
};

/**
 * The history swim stated in SCY as a single-stroke individual event, or
 * `null` when it may fill no leg at all (rule 1). The caller checks the event
 * against the loaded relays' leg events (rule 2).
 */
function historyLegSwim(swim: HistoricalSwim): HistoryLegSwim | null {
  if (/\brelay\b/i.test(swim.event)) return null;
  if (!isRankableSwim(swim)) return null;
  const course = recordedCourseOfSwim(swim);
  if (!course) return null;
  const outcome = scyConversionOutcome(swim.event, swim.time, swim.gender, course, {
    team: swim.team,
  });
  if (outcome.status !== 'converted') return null;
  const leg = individualEventDistanceStroke(outcome.conversion.event);
  if (!leg) return null;
  const timeSec = convertTimeToSeconds(outcome.conversion.time);
  if (!Number.isFinite(timeSec) || timeSec <= 0) return null;
  const convertedFrom = scyConversionProvenance(
    { event: swim.event, time: swim.time },
    outcome.conversion
  );
  return {
    swim,
    legEvent: relayLegEventName(leg.distance, leg.stroke),
    time: outcome.conversion.time,
    timeSec,
    course,
    ...(convertedFrom ? { convertedFrom } : {}),
  };
}

/**
 * Per history array: its gender's swims that may fill a leg. The what-if
 * projection calls {@link relayLegHistoryCandidates} on every re-score, and
 * every re-score of one workspace shares its `athleteHistory` array, so the
 * conversions run once. A history array is replaced, never edited in place,
 * when a workspace changes; the stored length is a second guard.
 */
const LEG_SWIMS_BY_HISTORY = new WeakMap<
  readonly HistoricalSwim[],
  { length: number; byGender: Map<Gender, HistoryLegSwim[]> }
>();

function historyLegSwims(history: readonly HistoricalSwim[], gender: Gender): HistoryLegSwim[] {
  let cached = LEG_SWIMS_BY_HISTORY.get(history);
  if (!cached || cached.length !== history.length) {
    cached = { length: history.length, byGender: new Map() };
    LEG_SWIMS_BY_HISTORY.set(history, cached);
  }
  let swims = cached.byGender.get(gender);
  if (!swims) {
    swims = [];
    for (const swim of history) {
      if (swim.gender !== gender) continue;
      const legSwim = historyLegSwim(swim);
      if (legSwim) swims.push(legSwim);
    }
    cached.byGender.set(gender, swims);
  }
  return swims;
}

/** A pool swimmer, and the leg events the pool already holds a swim at. */
type RosterSwimmer = { row: SwimmerResult; legEventsSwum: Set<string> };

/** The candidate row for one swimmer and leg event. */
function historyCandidateRow(
  member: RosterSwimmer,
  legSwim: HistoryLegSwim,
  gender: Gender,
  key: string
): SwimmerResult {
  const { swim } = legSwim;
  return {
    id: `history-leg:${key}|${legSwim.legEvent}`,
    rank: 0,
    name: member.row.name,
    classYear: member.row.classYear,
    team: member.row.team,
    time: legSwim.time,
    points: 0,
    event: legSwim.legEvent,
    gender,
    ...(legSwim.convertedFrom ? { convertedFrom: legSwim.convertedFrom } : {}),
    relayLegHistory: {
      event: swim.event,
      time: swim.time,
      timeType: legSwim.course,
      ...(swim.meetLabel ? { meetLabel: swim.meetLabel } : {}),
      ...(swim.date ? { date: swim.date } : {}),
      source: swim.source,
    },
  };
}

/**
 * Relay-leg candidates from `workspace.athleteHistory` for the swimmers in
 * `pool`: one row per swimmer and leg event, marked `relayLegHistory`. See the
 * module header for the four rules.
 *
 * `pool` is the gender's candidate pool as the caller holds it: meet result
 * rows and recruit rows, after its roster gates. Relay rows and rows that are
 * already history candidates in it are ignored. The leg events are those of
 * the gender's loaded relays (`menResults` / `womenResults`).
 *
 * Returns `[]` when the workspace holds no relay or no history.
 */
export function relayLegHistoryCandidates(
  workspace: Workspace,
  pool: readonly SwimmerResult[],
  gender: Gender
): SwimmerResult[] {
  const history = workspace.athleteHistory ?? [];
  if (history.length === 0) return [];
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const legEvents = relayLegEventsOf(results);
  if (legEvents.size === 0) return [];

  const resolver = buildAliasResolver(workspace);
  const keys = new Map<string, string>();
  const keyOf = (name: string, team: string): string => {
    const t = String(team ?? '').trim();
    const memo = `${t}\u0001${name}`;
    let key = keys.get(memo);
    if (key === undefined) {
      key = `${t}|${aliasNameKey(resolver.resolveAthleteName(name, t, gender))}`;
      keys.set(memo, key);
    }
    return key;
  };

  // The leg events by `relayLegEventKey`, so a pool row's label is read once:
  // the same comparison `isRelayLegEvent` makes.
  const legEventByKey = new Map<string, string>();
  for (const name of legEvents.keys()) legEventByKey.set(name.toLowerCase(), name);

  const roster = new Map<string, RosterSwimmer>();
  for (const row of pool) {
    if (isRelayResult(row) || row.relayLegHistory) continue;
    const key = keyOf(row.name, row.team);
    const member = roster.get(key) ?? { row, legEventsSwum: new Set<string>() };
    const legEvent = legEventByKey.get(memoLegEventKey(row.event));
    if (legEvent) member.legEventsSwum.add(legEvent);
    roster.set(key, member);
  }
  if (roster.size === 0) return [];

  const fastest = new Map<string, { legSwim: HistoryLegSwim; key: string; member: RosterSwimmer }>();
  for (const legSwim of historyLegSwims(history, gender)) {
    if (!legEvents.has(legSwim.legEvent)) continue;
    const key = keyOf(legSwim.swim.name, legSwim.swim.team);
    const member = roster.get(key);
    if (!member || member.legEventsSwum.has(legSwim.legEvent)) continue;
    const slot = `${key}|${legSwim.legEvent}`;
    const prior = fastest.get(slot);
    if (prior && prior.legSwim.timeSec <= legSwim.timeSec) continue;
    fastest.set(slot, { legSwim, key, member });
  }

  return [...fastest.values()].map(({ legSwim, key, member }) =>
    historyCandidateRow(member, legSwim, gender, key)
  );
}

/** True for a row {@link relayLegHistoryCandidates} built. */
export function isRelayLegHistoryCandidate(row: Pick<SwimmerResult, 'relayLegHistory'>): boolean {
  return row.relayLegHistory != null;
}
