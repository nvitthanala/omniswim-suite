import type { Lineup, LineupEntry } from '../model/lineup';
import { entryKey } from '../model/lineup';
import type { Results, ResultRow } from '../model/results';
import type { EventKey, TeamId } from '../model/primitives';

export type ReportDiffErrorCode = 'meet_key_mismatch';

export class ReportDiffError extends Error {
  readonly code: ReportDiffErrorCode = 'meet_key_mismatch';
  constructor() {
    super('diffResults: lineups have different meet keys');
    this.name = 'ReportDiffError';
  }
}

export interface ReportSwimmerEventChange {
  readonly event: EventKey;
  readonly timeThen: string | null;
  readonly timeNow: string | null;
}

export interface ReportSwimmerDiff {
  readonly name: string;
  readonly isRelay: boolean;
  readonly eventsAdded: readonly EventKey[];
  readonly eventsRemoved: readonly EventKey[];
  readonly eventsChanged: readonly ReportSwimmerEventChange[];
  readonly pointsThen: number | null;
  readonly pointsNow: number | null;
  readonly deltaPoints: number | null;
  readonly inThen: boolean;
  readonly inNow: boolean;
}

export interface ReportEventDiff {
  readonly eventKey: EventKey;
  readonly pointsThen: number | null;
  readonly pointsNow: number | null;
  readonly delta: number | null;
  readonly swimmersChanged: number;
  readonly inThen: boolean;
  readonly inNow: boolean;
}

export interface ResultsDiff {
  readonly teamId: TeamId;
  readonly team: string;
  readonly totals: {
    readonly then: number | null;
    readonly now: number | null;
    readonly delta: number | null;
    readonly inThen: boolean;
    readonly inNow: boolean;
  };
  readonly swimmers: readonly ReportSwimmerDiff[];
  readonly events: readonly ReportEventDiff[];
}

interface EntryValue {
  readonly entryKey: string;
  readonly swimmerKey: string;
  readonly name: string;
  readonly isRelay: boolean;
  readonly eventKey: EventKey;
  readonly time: string | null;
  readonly row: ResultRow | undefined;
}

interface SideData {
  readonly present: boolean;
  readonly total: number | null;
  readonly swimmers: ReadonlyMap<string, readonly EntryValue[]>;
  readonly events: ReadonlyMap<EventKey, readonly EntryValue[]>;
}

function resultsByEntry(results: Results): Map<string, ResultRow> {
  const rows = new Map<string, ResultRow>();
  for (const event of results.events) for (const row of event.rows) rows.set(row.entryKey, row);
  return rows;
}

function entryName(lineup: Lineup, entry: LineupEntry): { swimmerKey: string; name: string; isRelay: boolean } {
  if (entry.kind === 'individual') {
    return { swimmerKey: entry.swimmerId, name: lineup.display?.swimmers[entry.swimmerId]?.name ?? entry.swimmerId, isRelay: false };
  }
  return { swimmerKey: `relay:${entryKey(entry)}`, name: `${entry.eventKey} ${entry.letter}`, isRelay: true };
}

function sideData(results: Results, lineup: Lineup, teamId: TeamId): SideData {
  const resultRows = resultsByEntry(results);
  const entries = lineup.entries.filter(entry => entry.teamId === teamId).map(entry => {
    const identity = entryName(lineup, entry);
    const key = entryKey(entry);
    return {
      ...identity,
      eventKey: entry.eventKey,
      time: lineup.display?.entryTimes[key]?.text ?? null,
      row: resultRows.get(key),
      entryKey: key,
    };
  });
  const swimmerGroups = groupEntries(entries, entry => entry.swimmerKey);
  const eventGroups = groupEntries(entries, entry => entry.eventKey);
  const team = results.teams.find(item => item.teamId === teamId);
  return { present: entries.length > 0, total: entries.length > 0 && team ? team.points : null, swimmers: swimmerGroups, events: eventGroups };
}

function groupEntries<K extends string>(entries: readonly EntryValue[], keyOf: (entry: EntryValue) => K): Map<K, readonly EntryValue[]> {
  const groups = new Map<K, EntryValue[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function pointsOf(entries: readonly EntryValue[] | undefined): number | null {
  if (entries === undefined || entries.length === 0) return null;
  let total = 0;
  for (const entry of entries) {
    if (entry.row === undefined) return null;
    total += entry.row.points;
  }
  return total;
}

function eventsForSwimmer(entries: readonly EntryValue[] | undefined): Set<EventKey> {
  return new Set((entries ?? []).map(entry => entry.eventKey));
}

function eventChanges(thenEntries: readonly EntryValue[] | undefined, nowEntries: readonly EntryValue[] | undefined): ReportSwimmerEventChange[] {
  const thenByEvent = groupEntries(thenEntries ?? [], entry => entry.eventKey);
  const nowByEvent = groupEntries(nowEntries ?? [], entry => entry.eventKey);
  const changes: ReportSwimmerEventChange[] = [];
  for (const eventKey of new Set([...thenByEvent.keys(), ...nowByEvent.keys()])) {
    if (!thenByEvent.has(eventKey) || !nowByEvent.has(eventKey)) continue;
    const timeThen = (thenByEvent.get(eventKey) ?? []).map(entry => entry.time).filter((time): time is string => time !== null).join(', ') || null;
    const timeNow = (nowByEvent.get(eventKey) ?? []).map(entry => entry.time).filter((time): time is string => time !== null).join(', ') || null;
    if (timeThen !== timeNow) changes.push({ event: eventKey, timeThen, timeNow });
  }
  return changes;
}

function changedSwimmer(
  thenEntries: readonly EntryValue[] | undefined,
  nowEntries: readonly EntryValue[] | undefined,
): ReportSwimmerDiff | undefined {
  const inThen = thenEntries !== undefined;
  const inNow = nowEntries !== undefined;
  const thenPoints = pointsOf(thenEntries);
  const nowPoints = pointsOf(nowEntries);
  const thenEvents = eventsForSwimmer(thenEntries);
  const nowEvents = eventsForSwimmer(nowEntries);
  const added = [...nowEvents].filter(event => !thenEvents.has(event));
  const removed = [...thenEvents].filter(event => !nowEvents.has(event));
  const changedEvents = eventChanges(thenEntries, nowEntries);
  if (inThen === inNow && thenPoints === nowPoints && added.length === 0 && removed.length === 0 && changedEvents.length === 0) return undefined;
  const sample = nowEntries?.[0] ?? thenEntries?.[0];
  if (sample === undefined) return undefined;
  return {
    name: sample.name,
    isRelay: sample.isRelay,
    eventsAdded: added,
    eventsRemoved: removed,
    eventsChanged: changedEvents,
    pointsThen: thenPoints,
    pointsNow: nowPoints,
    deltaPoints: thenPoints === null || nowPoints === null ? null : nowPoints - thenPoints,
    inThen,
    inNow,
  };
}

function eventDiff(
  eventKey: EventKey,
  thenEntries: readonly EntryValue[] | undefined,
  nowEntries: readonly EntryValue[] | undefined,
  changedEntries: ReadonlySet<string>,
): ReportEventDiff | undefined {
  const inThen = thenEntries !== undefined;
  const inNow = nowEntries !== undefined;
  const pointsThen = pointsOf(thenEntries);
  const pointsNow = pointsOf(nowEntries);
  if (inThen === inNow && pointsThen === pointsNow) return undefined;
  const swimmersChanged = [...changedEntries].filter(key => {
    return [...(thenEntries ?? []), ...(nowEntries ?? [])].some(entry => entry.swimmerKey === key && entry.eventKey === eventKey);
  }).length;
  return {
    eventKey,
    pointsThen,
    pointsNow,
    delta: pointsThen === null || pointsNow === null ? null : pointsNow - pointsThen,
    swimmersChanged,
    inThen,
    inNow,
  };
}

function byLargestDelta<T>(deltaOf: (value: T) => number | null): (a: T, b: T) => number {
  return (a, b) => Math.abs(deltaOf(b) ?? 0) - Math.abs(deltaOf(a) ?? 0);
}

/** Compare two saved lineups, preserving absence separately from a recorded zero score. */
export function diffResults(
  then: { readonly results: Results; readonly lineup: Lineup },
  now: { readonly results: Results; readonly lineup: Lineup },
  teamId: TeamId,
): ResultsDiff {
  if (then.lineup.meetKey !== now.lineup.meetKey) throw new ReportDiffError();
  const before = sideData(then.results, then.lineup, teamId);
  const after = sideData(now.results, now.lineup, teamId);
  const changedSwimmers: ReportSwimmerDiff[] = [];
  const changedKeys = new Set<string>();
  for (const key of new Set([...before.swimmers.keys(), ...after.swimmers.keys()])) {
    const diff = changedSwimmer(before.swimmers.get(key), after.swimmers.get(key));
    if (diff !== undefined) {
      changedSwimmers.push(diff);
      changedKeys.add(key);
    }
  }
  changedSwimmers.sort(byLargestDelta(swimmer => swimmer.deltaPoints));

  const changedEvents: ReportEventDiff[] = [];
  for (const eventKey of new Set([...before.events.keys(), ...after.events.keys()])) {
    const diff = eventDiff(eventKey, before.events.get(eventKey), after.events.get(eventKey), changedKeys);
    if (diff !== undefined) changedEvents.push(diff);
  }
  changedEvents.sort(byLargestDelta(event => event.delta));
  const totalThen = before.total;
  const totalNow = after.total;
  return {
    teamId,
    team: now.lineup.display?.teams[teamId]?.name ?? then.lineup.display?.teams[teamId]?.name ?? teamId,
    totals: {
      then: totalThen,
      now: totalNow,
      delta: totalThen === null || totalNow === null ? null : totalNow - totalThen,
      inThen: before.present,
      inNow: after.present,
    },
    swimmers: changedSwimmers,
    events: changedEvents,
  };
}
