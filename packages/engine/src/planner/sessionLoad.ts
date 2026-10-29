/** Session race accounting (D2 3.11). */
import type { EventKey, Gender, SwimmerId } from '../model/primitives';
import type { MeetModel } from '../model/meet';
import { entryKey, type Lineup, type LineupEntry } from '../model/lineup';
import { buildIndex, resolveLineup, type Results, type ResultRow, type Violation } from '../model/results';
import type { CompleteRulePreset } from '../rules/rulePreset';
import type { LoadPreference, ScheduledEvent, SessionPreset, SessionRef } from './types';

type SessionLoadResult = {
  readonly violations: readonly Violation[];
  readonly perSwimmer: readonly { readonly swimmerId: SwimmerId; readonly sessions: readonly { readonly session: SessionRef; readonly races: number; readonly eventKeys: readonly EventKey[] }[] }[];
  /** Total preference cost for `prefer`; zero in the other modes. */
  readonly penaltyPoints: number;
};

const genderList = (g: ScheduledEvent['gender']): readonly Gender[] => g === 'both' ? ['Men', 'Women'] : [g];
const sessionKey = (s: SessionRef): string => `${s.day}/${s.slot}`;
const scheduleKey = (e: EventKey, g: Gender): string => `${e}\u0000${g}`;

// eslint-disable-next-line complexity -- one pass coordinates schedule lookup, rounds, pending settings and per-session totals (D2 3.11)
export function sessionLoad(model: MeetModel, lineup: Lineup, results: Results, schedule: SessionPreset, pref: LoadPreference, rules: CompleteRulePreset): SessionLoadResult {
  const violations: Violation[] = [];
  let resolvedByKey: Map<string, { readonly value: number | null }> | undefined;
  const resolvedSeeds = () => resolvedByKey ??= new Map(resolveLineup(model, lineup, buildIndex(model)).resolved.map(row => [row.key, row]));
  const scheduled = new Map<string, ScheduledEvent>();
  for (const row of schedule.events) for (const gender of genderList(row.gender)) scheduled.set(scheduleKey(row.eventKey, gender), row);
  const entriesByEvent = new Map<string, LineupEntry[]>();
  for (const entry of lineup.entries) {
    const key = scheduleKey(entry.eventKey, entry.gender);
    const rows = entriesByEvent.get(key) ?? [];
    rows.push(entry);
    entriesByEvent.set(key, rows);
    if (!scheduled.has(key)) violations.push({ kind: 'unscheduled_event', eventKey: entry.eventKey, gender: entry.gender });
  }

  const rowByEntry = new Map<string, Results['events'][number]['rows'][number]>();
  for (const event of results.events) for (const row of event.rows) rowByEntry.set(row.entryKey, row);
  const modelEvent = new Map(model.events.map(e => [scheduleKey(e.eventKey, e.gender), e]));
  const races = new Map<SwimmerId, Map<string, { session: SessionRef; count: number; events: Set<EventKey> }>>();
  const pendingSeen = new Set<string>();
  const pending = (eventKey: EventKey, gender: Gender, setting: 'fastHeatSize' | 'smallFieldSession' | 'cFinal' | 'abFinalsScorersOnly' | 'individualPoints' | 'relayPoints' | 'diving') => {
    const k = `${eventKey}\u0000${gender}\u0000${setting}`;
    if (pendingSeen.has(k)) return;
    pendingSeen.add(k);
    violations.push({ kind: 'pending_setting', eventKey, gender, setting });
  };
  const addRace = (swimmerId: SwimmerId, session: SessionRef, eventKey: EventKey) => {
    const sessions = races.get(swimmerId) ?? new Map();
    const k = sessionKey(session);
    const item = sessions.get(k) ?? { session, count: 0, events: new Set<EventKey>() };
    item.count++;
    item.events.add(eventKey);
    sessions.set(k, item);
    races.set(swimmerId, sessions);
  };

  for (const [key, entries] of entriesByEvent) {
    const sched = scheduled.get(key);
    if (!sched) continue;
    const [eventKey, gender] = key.split('\u0000') as [EventKey, Gender];
    const event = modelEvent.get(key);
    const isDive = event?.kind === 'diving';
    if (isDive && pref.mode !== 'off') {
      if (pref.diving.state === 'pending') { pending(eventKey, gender, 'diving'); continue; }
      if (pref.diving.value === 'excluded') continue;
    }
    const format = sched.format;
    const resultRows = results.events.find(e => e.eventKey === eventKey && e.gender === gender)?.rows ?? [];
    const resultByKey = new Map(resultRows.map(r => [r.entryKey, r]));
    if (format.kind === 'timed-final') {
      for (const entry of entries) for (const swimmer of entrySwimmers(entry)) addRace(swimmer, format.session, eventKey);
    } else if (format.kind === 'prelims-finals') {
      for (const entry of entries) for (const swimmer of entrySwimmers(entry)) addRace(swimmer, format.prelims, eventKey);
      const kind = event?.kind ?? 'individual';
      const pointTable = rules ? pointCountFor(kind, rules) : null;
      if (pointTable === null) pending(eventKey, gender, pointSettingName(event?.kind ?? 'individual'));
      const scorerOnly = rules?.scoring.abFinalsScorersOnly;
      if (!scorerOnly || scorerOnly.state === 'pending') pending(eventKey, gender, 'abFinalsScorersOnly');
      if (pointTable !== null && scorerOnly.state === 'set') {
        const scorerRows = entries.map(e => ({ entry: e, row: resultByKey.get(entryKey(e)) }))
          .filter((x): x is { entry: LineupEntry; row: ResultRow } => x.row !== undefined && x.row.notScoredReason !== 'non_scorer' && x.row.place !== null);
        const scorerRank = rankScorers(scorerRows);
        for (const entry of entries) {
          const row = resultByKey.get(entryKey(entry));
          if (row?.place == null) continue;
          const rank = scorerOnly.value ? scorerRank.get(entryKey(entry)) : row.place;
          if (rank !== undefined && rank <= pointTable) for (const swimmer of entrySwimmers(entry)) addRace(swimmer, format.finals, eventKey);
        }
      }
      const nonScorers = entries.filter(e => resultByKey.get(entryKey(e))?.notScoredReason === 'non_scorer');
      if (nonScorers.length) {
        const cFinal = rules?.scoring.cFinal;
        if (!cFinal || cFinal.state === 'pending') pending(eventKey, gender, 'cFinal');
        else if (cFinal.value.kind === 'non-scorers') {
          const resolved = resolvedSeeds();
          const seededNonScorers = nonScorers.map((entry, index) => ({ entry, index, seed: resolved.get(entryKey(entry))?.value ?? null }));
          const ordered = seededNonScorers.filter(x => x.seed !== null).sort((a, b) => {
            const delta = (a.seed as number) - (b.seed as number);
            return (event?.kind === 'diving' ? -delta : delta) || a.index - b.index;
          });
          for (const x of seededNonScorers.filter(x => x.seed === null)) violations.push({ kind: 'seed_time_missing', entryKey: entryKey(x.entry), eventKey, gender });
          for (const { entry } of ordered.slice(0, cFinal.value.size)) for (const swimmer of entrySwimmers(entry)) addRace(swimmer, format.finals, eventKey);
        }
      }
    } else {
      if (format.fastHeatSize.state === 'pending') { pending(eventKey, gender, 'fastHeatSize'); continue; }
      const size = format.fastHeatSize.value;
      if (entries.length <= size) {
        if (format.smallFieldSession.state === 'pending') { pending(eventKey, gender, 'smallFieldSession'); continue; }
        for (const entry of entries) for (const swimmer of entrySwimmers(entry)) addRace(swimmer, format.smallFieldSession.value, eventKey);
      } else {
        const resolved = resolvedSeeds();
        const ranked = entries.map((entry, index) => ({ entry, index, seed: resolved.get(entryKey(entry))?.value ?? null }));
        const seeded = ranked.filter(x => x.seed !== null).sort((a, b) => {
          const delta = (a.seed as number) - (b.seed as number);
          return (event?.kind === 'diving' ? -delta : delta) || a.index - b.index;
        });
        const missing = ranked.filter(x => x.seed === null);
        for (const x of missing) violations.push({ kind: 'seed_time_missing', entryKey: entryKey(x.entry), eventKey, gender });
        const fast = new Set(seeded.slice(0, size).map(x => entryKey(x.entry)));
        for (const x of seeded) for (const swimmer of entrySwimmers(x.entry)) addRace(swimmer, fast.has(entryKey(x.entry)) ? format.fastHeat : format.slowHeats, eventKey);
      }
    }
  }

  const perSwimmer = [...races].sort(([a], [b]) => a.localeCompare(b)).map(([swimmerId, sessions]) => ({
    swimmerId,
    sessions: [...sessions.values()].sort((a, b) => a.session.day - b.session.day || ['morning', 'afternoon', 'evening'].indexOf(a.session.slot) - ['morning', 'afternoon', 'evening'].indexOf(b.session.slot)).map(x => ({ session: x.session, races: x.count, eventKeys: [...x.events] })),
  }));
  let penaltyPoints = 0;
  if (pref.mode !== 'off') {
    if (pref.maxRacesPerSession.state === 'set') {
      const limit = pref.maxRacesPerSession.value;
      for (const swimmer of perSwimmer) for (const s of swimmer.sessions) if (s.races > limit) {
        violations.push({ kind: 'session_load', swimmerId: swimmer.swimmerId, session: s.session, races: s.races, limit });
        if (pref.mode === 'prefer' && pref.penaltyPointsPerExtraRace.state === 'set') penaltyPoints += (s.races - limit) * pref.penaltyPointsPerExtraRace.value;
      }
    }
  }
  return { violations, perSwimmer, penaltyPoints };
}

function entrySwimmers(entry: LineupEntry): readonly SwimmerId[] {
  return entry.kind === 'individual' ? [entry.swimmerId] : [...new Set(entry.legs.map(leg => leg.swimmerId))];
}

function pointCountFor(kind: 'individual' | 'relay' | 'diving', rules: CompleteRulePreset): number | null {
  if (kind === 'individual') return rules.scoring.individualPoints.state === 'set' ? rules.scoring.individualPoints.value.length : null;
  if (kind === 'relay') {
    const value = rules.scoring.relayPoints;
    if (value.state === 'pending') return null;
    return value.value.kind === 'table' ? value.value.points.length : rules.scoring.individualPoints.state === 'set' ? rules.scoring.individualPoints.value.length : null;
  }
  const value = rules.scoring.divingPoints;
  if (value.state === 'pending') return null;
  return value.value.kind === 'table' ? value.value.points.length : rules.scoring.individualPoints.state === 'set' ? rules.scoring.individualPoints.value.length : null;
}

function pointSettingName(kind: 'individual' | 'relay' | 'diving'): 'individualPoints' | 'relayPoints' | 'diving' {
  return kind === 'relay' ? 'relayPoints' : kind === 'diving' ? 'diving' : 'individualPoints';
}

function rankScorers(rows: readonly { readonly entry: LineupEntry; readonly row: ResultRow }[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => (a.row.place as number) - (b.row.place as number));
  const ranks = new Map<string, number>();
  let previousPlace: number | null = null;
  let rank = 0;
  sorted.forEach((x, index) => {
    const place = x.row.place as number;
    if (previousPlace !== place) rank = index + 1;
    ranks.set(entryKey(x.entry), rank);
    previousPlace = place;
  });
  return ranks;
}
