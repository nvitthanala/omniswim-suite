/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session load for the AutoBuilder (D5 4.5, 4.6, 5.3, 8.2; slice A3). `sessionLoad` is the only race counter: a column's
 * races are `sessionLoad` on the column's sub-lineup, and the penalty of a proposal is the own-only sum over its `perSwimmer`
 * rows. Nothing here counts a race by itself, and `sessionLoad`'s own `penaltyPoints` is never read: it sums every swimmer of
 * every team, and own entries push opponents out of finals (D5 8.2).
 */
import { sessionLoad } from '../planner/sessionLoad';
import type { Results, Violation } from '../model/results';
import type { Lineup, ScorerTag } from '../model/lineup';
import type { MeetEvent, MeetModel } from '../model/meet';
import type { EventKey, Gender, SwimmerId, TeamId } from '../model/primitives';
import type { CompleteRulePreset } from '../rules/rulePreset';
import type { ScheduledEvent, SessionPreset, SessionRef } from '../planner/types';
import { relayRepeatsForSchedule } from '../planner/relayRepeats';
import type { LoadRule } from './support';
import { autoBuildFail } from './types';

/** A session as a map key, the same shape `sessionLoad` uses internally. */
export const sessionKeyOf = (s: SessionRef): string => `${s.day}/${s.slot}`;

/** Races per swimmer and session key. */
export type Races = ReadonlyMap<SwimmerId, ReadonlyMap<string, number>>;

export const NO_RACES: Races = new Map();

export type SessionLoadResult = ReturnType<typeof sessionLoad>;

/** The schedule row of an event: the last matching row wins, as in `sessionLoad`. */
export function scheduledOf(schedule: SessionPreset, eventKey: EventKey, gender: Gender): ScheduledEvent | undefined {
  let found: ScheduledEvent | undefined;
  for (const row of schedule.events) if (row.eventKey === eventKey && (row.gender === 'both' || row.gender === gender)) found = row;
  return found;
}

/** The schedule with only the rows that cover one event and gender. */
function restricted(schedule: SessionPreset, eventKey: EventKey, gender: Gender): SessionPreset {
  return { ...schedule, events: schedule.events.filter((row) => row.eventKey === eventKey && (row.gender === 'both' || row.gender === gender)) };
}

function sessionsOf(load: SessionLoadResult, who: (id: SwimmerId) => boolean): Map<SwimmerId, Map<string, number>> {
  const out = new Map<SwimmerId, Map<string, number>>();
  for (const s of load.perSwimmer) {
    if (!who(s.swimmerId)) continue;
    out.set(s.swimmerId, new Map(s.sessions.map((x) => [sessionKeyOf(x.session), x.races])));
  }
  return out;
}

/**
 * D5 2.1 item 5, the part that reads a column's `sessionLoad`: a pending setting other than `cFinal` refuses. `cFinal` only
 * decides the races of non-scorers, and the AutoBuilder constrains scorers.
 */
function refusePending(violations: readonly Violation[]): void {
  for (const v of violations) {
    if (v.kind !== 'pending_setting' || v.setting === 'cFinal') continue;
    autoBuildFail('pending_setting', `schedule:${v.eventKey}|${v.gender}: the setting "${v.setting}" is pending`, `schedule:${v.eventKey}|${v.gender}:${v.setting}`);
  }
}

/**
 * The races a column gives its swimmers (D5 5.3): `sessionLoad` on the column's sub-lineup, with the schedule cut to the one
 * event. An event the schedule does not hold has no races.
 */
export function columnRaces(
  load: LoadRule,
  model: MeetModel,
  lineup: Lineup,
  results: Results,
  event: MeetEvent,
  who: ReadonlySet<SwimmerId>,
  rules: CompleteRulePreset
): Races {
  if (scheduledOf(load.schedule, event.eventKey, event.gender) === undefined) return NO_RACES;
  const run = sessionLoad(model, lineup, results, restricted(load.schedule, event.eventKey, event.gender), load.preference, rules);
  refusePending(run.violations);
  return sessionsOf(run, (id) => who.has(id));
}

/**
 * The races an own swimmer already swims in the events the search does not build (fixed relay events, other genders): the
 * constants of the load rows. `sessionLoad` runs once over the current entries of those events.
 */
export function fixedRaces(
  load: LoadRule,
  model: MeetModel,
  lineup: Lineup,
  results: Results,
  isBuilt: (entry: { readonly eventKey: EventKey; readonly gender: Gender }) => boolean,
  own: ReadonlySet<SwimmerId>,
  rules: CompleteRulePreset
): Races {
  const entries = lineup.entries.filter((e) => !isBuilt(e));
  const run = sessionLoad(model, { ...lineup, entries }, results, load.schedule, load.preference, rules);
  return sessionsOf(run, (id) => own.has(id));
}

/**
 * The session a built entry certainly races in (D5 6.2): the prelims of a prelims-finals event, the session of a timed final,
 * and nothing for a split timed final (the heat depends on the seeds) or for a dive that counts 0. `null` when none.
 */
export function certainSession(load: LoadRule, event: MeetEvent): string | null {
  const row = scheduledOf(load.schedule, event.eventKey, event.gender);
  if (row === undefined) return null;
  if (event.kind === 'diving' && load.preference.diving.state === 'set' && load.preference.diving.value === 'excluded') return null;
  const { format } = row;
  if (format.kind === 'timed-final') return sessionKeyOf(format.session);
  if (format.kind === 'prelims-finals') return sessionKeyOf(format.prelims);
  return null;
}

/** D5 8.2: `(races - max) * pen` over the `perSwimmer` rows of the own swimmers named in `z1`. Zero outside `prefer`. */
export function ownPenalty(load: LoadRule | null, result: SessionLoadResult | null, z1: ReadonlySet<SwimmerId>): number {
  if (load === null || !load.prefer || result === null) return 0;
  let extra = 0;
  for (const s of result.perSwimmer) {
    if (!z1.has(s.swimmerId)) continue;
    for (const session of s.sessions) if (session.races > load.max) extra += session.races - load.max;
  }
  return extra * load.penalty;
}

/** The own swimmers on the scoring roster: the `'scorer'` tags of the own team. */
export function scorerIds(tags: readonly ScorerTag[], own: TeamId): Set<SwimmerId> {
  return new Set(tags.filter((t) => t.teamId === own && t.role === 'scorer').map((t) => t.swimmerId));
}

/**
 * Every violation that can name a built lineup: `scoreMeet`'s, with the NCAA timed-final repeat-relay violation dropped for
 * an event the schedule proves has prelims and finals, and the `sessionLoad` violations that are settings or load.
 */
export function violationsOf(results: Results, load: SessionLoadResult | null, schedule: SessionPreset | null): Violation[] {
  const base = schedule === null ? [...results.violations] : relayRepeatsForSchedule(results.violations, schedule);
  const extra = load === null ? [] : load.violations.filter((v) => v.kind === 'session_load' || v.kind === 'unscheduled_event' || v.kind === 'pending_setting');
  return [...base, ...extra];
}
