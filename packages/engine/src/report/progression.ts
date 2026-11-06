import type { Results } from '../model/results';
import type { EventKey, Gender, TeamId } from '../model/primitives';
import type { EventFormat, SessionPreset, SessionRef as PlannerSessionRef } from '../planner/types';

export type SessionRef = PlannerSessionRef;
export type UnplacedProgressionEvent = { readonly eventKey: EventKey; readonly gender: Gender; readonly why: 'unscheduled' | 'pending_setting' };
export type ProgressionOrder =
  | { readonly kind: 'schedule' }
  | { readonly kind: 'simulator'; readonly reason: 'no_schedule' | 'unplaced'; readonly unplaced: readonly UnplacedProgressionEvent[] };
export interface ProgressionPoint {
  readonly eventKey: EventKey;
  readonly gender: Gender;
  readonly scoresIn: SessionRef | null;
  readonly totals: Readonly<Record<TeamId, number>>;
}
export interface Progression { readonly order: ProgressionOrder; readonly points: readonly ProgressionPoint[] }

type ScheduledResultEvent = {
  readonly resultIndex: number;
  readonly presetIndex: number;
  readonly eventKey: EventKey;
  readonly gender: Gender;
  readonly session: SessionRef;
};
type Placement = { readonly kind: 'placed'; readonly session: SessionRef } | { readonly kind: 'pending' };

function placement(format: EventFormat, entries: number): Placement {
  if (format.kind === 'timed-final') return { kind: 'placed', session: format.session };
  if (format.kind === 'prelims-finals') return { kind: 'placed', session: format.finals };
  if (format.fastHeatSize.state !== 'set') return { kind: 'pending' };
  if (entries <= format.fastHeatSize.value) {
    return format.smallFieldSession.state === 'set'
      ? { kind: 'placed', session: format.smallFieldSession.value }
      : { kind: 'pending' };
  }
  return { kind: 'placed', session: format.fastHeat };
}

function simulatorPoints(results: Results, teams: readonly TeamId[]): ProgressionPoint[] {
  return cumulativePoints(results, teams, results.events.map((event, resultIndex) => ({
    resultIndex,
    eventKey: event.eventKey,
    gender: event.gender,
    scoresIn: null,
  })));
}

function cumulativePoints(
  results: Results,
  teams: readonly TeamId[],
  events: readonly { resultIndex: number; eventKey: EventKey; gender: Gender; scoresIn: SessionRef | null }[],
): ProgressionPoint[] {
  const totals: Record<TeamId, number> = Object.fromEntries(teams.map(teamId => [teamId, 0]));
  return events.map(event => {
    const result = results.events[event.resultIndex];
    for (const row of result?.rows ?? []) totals[row.teamId] = (totals[row.teamId] ?? 0) + row.points;
    return { eventKey: event.eventKey, gender: event.gender, scoresIn: event.scoresIn, totals: { ...totals } };
  });
}

function comparePlacedEvents(a: ScheduledResultEvent, b: ScheduledResultEvent): number {
  const slotOrder = ['morning', 'afternoon', 'evening'];
  return a.session.day - b.session.day ||
    slotOrder.indexOf(a.session.slot) - slotOrder.indexOf(b.session.slot) ||
    a.presetIndex - b.presetIndex ||
    (a.gender === 'Men' ? -1 : 1) - (b.gender === 'Men' ? -1 : 1) ||
    a.resultIndex - b.resultIndex;
}

/** Build cumulative team points in scheduled order, falling back as a whole if an event is unplaced. */
export function scoreProgression(results: Results, schedule: SessionPreset | null): Progression {
  const teamIds = results.teams.map(team => team.teamId);
  if (schedule === null) {
    return { order: { kind: 'simulator', reason: 'no_schedule', unplaced: [] }, points: simulatorPoints(results, teamIds) };
  }

  const unplaced: UnplacedProgressionEvent[] = [];
  const placed: ScheduledResultEvent[] = [];
  results.events.forEach((event, resultIndex) => {
    const match = schedule.events
      .map((scheduled, presetIndex) => ({ scheduled, presetIndex }))
      .find(({ scheduled }) => scheduled.eventKey === event.eventKey && (scheduled.gender === event.gender || scheduled.gender === 'both'));
    if (match === undefined) {
      unplaced.push({ eventKey: event.eventKey, gender: event.gender, why: 'unscheduled' });
      return;
    }
    const assigned = placement(match.scheduled.format, event.rows.length);
    if (assigned.kind === 'pending') {
      unplaced.push({ eventKey: event.eventKey, gender: event.gender, why: 'pending_setting' });
      return;
    }
    placed.push({ resultIndex, presetIndex: match.presetIndex, eventKey: event.eventKey, gender: event.gender, session: assigned.session });
  });

  if (unplaced.length > 0) {
    return { order: { kind: 'simulator', reason: 'unplaced', unplaced }, points: simulatorPoints(results, teamIds) };
  }
  placed.sort(comparePlacedEvents);
  const points = cumulativePoints(results, teamIds, placed.map(event => ({
    resultIndex: event.resultIndex,
    eventKey: event.eventKey,
    gender: event.gender,
    scoresIn: event.session,
  })));
  return { order: { kind: 'schedule' }, points };
}
