/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure adapters for the history endpoints described by R68. The request identity and provenance
 * are explicit inputs because neither endpoint carries all of them on each row.
 */
import { formatHundredths } from '@omniswim/engine';
import type { Course, EventKey, MeetSwim, RelaySplit, SwimOrigin, SwimmerId, TeamId, TimeValue } from '@omniswim/engine';
import { simulatorEvent, readDistance } from './events';
import { AdapterError } from './simulatorTypes';
import { parseSwimCloudHundredths } from './times';

export interface HistorySource {
  readonly fetchedAt: string;
  readonly url: string;
}
export interface TimesByEventOptions extends HistorySource {
  readonly swimmerId: SwimmerId;
  /** Event identity comes from the `event=` request parameter. */
  readonly eventKey: EventKey;
  readonly course: Course;
}
export interface TeamHistoryOptions extends HistorySource {
  readonly swimmerId: SwimmerId;
  readonly teamId: TeamId;
  readonly teams: readonly TeamId[];
}
export interface BestRelaySplit {
  readonly teamId: TeamId;
  readonly split: RelaySplit;
}

const isoDate = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const origin = (source: HistorySource): SwimOrigin => ({ kind: 'history-fetch', fetchedAt: source.fetchedAt, url: source.url });
const timeValue = (hundredths: number): TimeValue => ({ text: formatHundredths(hundredths), hundredths });

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('invalid_splash', path, 'expected an object');
  return value as Record<string, unknown>;
}
function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new AdapterError('invalid_splash', path, 'expected an array');
  return value;
}
function field(row: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in row)) throw new AdapterError('invalid_splash', `${path}.${key}`, 'required field is missing');
  return row[key];
}
function idAt(value: unknown, path: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new AdapterError('invalid_splash', path, 'expected a non-empty string or number id');
  }
  return String(value);
}
function dateAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isoDate.test(value)) throw new AdapterError('invalid_splash', path, 'expected an ISO date or null');
  return value;
}
function optionalSeason(value: unknown, path: string): string | null {
  if (value === null) return null;
  return idAt(value, path);
}
function courseAt(value: unknown, path: string): Course {
  if (value === 'Y') return 'SCY';
  if (value === 'S') return 'SCM';
  if (value === 'L') return 'LCM';
  throw new AdapterError('unsupported_course', path, `"${String(value)}" is not Y, S, or L`);
}
function boolAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new AdapterError('invalid_splash', path, 'expected a boolean');
  return value;
}

/** Parse a `times_by_event` array; the empty array is a verified empty history. */
export function parseTimesByEventResponse(input: unknown, options: TimesByEventOptions): MeetSwim[] {
  const rows = arrayAt(input, 'times_by_event');
  return rows.map((value, index) => {
    const path = `times_by_event[${index}]`;
    const row = objectAt(value, path);
    const id = idAt(field(row, 'id', path), `${path}.id`);
    idAt(field(row, 'team_id', path), `${path}.team_id`);
    const date = dateAt(field(row, 'dateofswim', path), `${path}.dateofswim`);
    const rawTime = field(row, 'eventtime', path);
    if (typeof rawTime !== 'string' && typeof rawTime !== 'number') throw new AdapterError('invalid_time', `${path}.eventtime`, 'expected decimal seconds');
    const flying = boolAt(field(row, 'flystart', path), `${path}.flystart`);
    const relayId = field(row, 'relay_id', path);
    if (relayId !== null) idAt(relayId, `${path}.relay_id`);
    const legPosition = field(row, 'legposition', path);
    if (typeof legPosition !== 'number' && typeof legPosition !== 'string') throw new AdapterError('invalid_splash', `${path}.legposition`, 'expected a number or numeric string');
    const seasonId = 'season_id' in row ? optionalSeason(row.season_id, `${path}.season_id`) : null;
    const hundredths = parseSwimCloudHundredths(rawTime, `${path}.eventtime`);
    return {
      swimId: `history:${id}`,
      swimmerId: options.swimmerId,
      eventKey: options.eventKey,
      recordedCourse: options.course,
      recordedTime: timeValue(hundredths),
      date,
      seasonId,
      flags: relayId !== null && Number(legPosition) === 1 && !flying ? { extractedSplit: true } : {},
      scy: { kind: 'recorded-scy' },
      origin: origin(options),
    };
  });
}

/** Return sorted unique team ids from a swimmer's history rows; every row must state its team. */
export function teamsFromTimesByEvent(input: unknown): TeamId[] {
  return [...new Set(arrayAt(input, 'times_by_event').map((value, index) => {
    const path = `times_by_event[${index}]`;
    return idAt(field(objectAt(value, path), 'team_id', path), `${path}.team_id`);
  }))].sort();
}

/** Parse one team's simulator response for this swimmer's relay splits and leadoffs. */
export function parseTeamRelayHistory(input: unknown, options: TeamHistoryOptions): { readonly swims: readonly MeetSwim[]; readonly splits: readonly RelaySplit[] } {
  if (!options.teams.includes(options.teamId)) throw new AdapterError('unresolved_reference', 'options.teamId', `team ${options.teamId} is not in the swimmer's history teams`);
  const root = objectAt(input, 'team_simulator');
  const swimmers = arrayAt(field(root, 'swimmers', 'team_simulator'), 'team_simulator.swimmers');
  const target = swimmers.find((value, index) => {
    const path = `team_simulator.swimmers[${index}]`;
    return idAt(field(objectAt(value, path), 'id', path), `${path}.id`) === String(options.swimmerId);
  });
  if (target === undefined) throw new AdapterError('unresolved_reference', 'team_simulator.swimmers', `swimmer ${options.swimmerId} is absent`);
  const swimmer = objectAt(target, 'team_simulator.swimmers');
  const parsedSwims: MeetSwim[] = [];
  const parsedSplits: RelaySplit[] = [];
  for (const [fieldName, start] of [['relayleadoffs', 'flat'], ['relaysplits', 'flying']] as const) {
    const rows = arrayAt(field(swimmer, fieldName, 'team_simulator.swimmers'), `team_simulator.swimmers.${fieldName}`);
    rows.forEach((value, index) => {
      const path = `team_simulator.swimmers.${fieldName}[${index}]`;
      const row = objectAt(value, path);
      const id = idAt(field(row, 'id', path), `${path}.id`);
      const strokeRaw = field(row, 'eventstroke', path);
      if (typeof strokeRaw !== 'string' && typeof strokeRaw !== 'number') throw new AdapterError('unknown_event', `${path}.eventstroke`, 'expected a stroke code');
      const distanceRaw = field(row, 'eventdistance', path);
      if (typeof distanceRaw !== 'string' && typeof distanceRaw !== 'number') throw new AdapterError('unknown_event', `${path}.eventdistance`, 'expected a distance');
      const stroke = String(strokeRaw);
      const distance = readDistance(distanceRaw, `${path}.eventdistance`);
      const shape = simulatorEvent(stroke, distance, `${path}.eventstroke`);
      if (shape.kind !== 'individual') throw new AdapterError('unknown_event', path, 'a relay split must name an individual leg event');
      const course = courseAt(field(row, 'eventcourse', path), `${path}.eventcourse`);
      const eventGender = field(row, 'eventgender', path);
      if (eventGender !== 'M' && eventGender !== 'F' && eventGender !== 'X') throw new AdapterError('unsupported_gender', `${path}.eventgender`, 'expected M, F, or X');
      const rawTime = field(row, 'eventtime', path);
      if (typeof rawTime !== 'string' && typeof rawTime !== 'number') throw new AdapterError('invalid_time', `${path}.eventtime`, 'expected decimal seconds');
      const hundredths = parseSwimCloudHundredths(rawTime, `${path}.eventtime`);
      const flystart = boolAt(field(row, 'flystart', path), `${path}.flystart`);
      if (flystart !== (start === 'flying')) throw new AdapterError('invalid_splash', `${path}.flystart`, `expected ${start === 'flying' ? 'true' : 'false'} in ${fieldName}`);
      if (start === 'flat') {
        parsedSwims.push({
          swimId: `history-leadoff:${id}`, swimmerId: options.swimmerId, eventKey: shape.eventKey,
          recordedCourse: course, recordedTime: timeValue(hundredths), date: null, seasonId: null,
          flags: { extractedSplit: true }, scy: { kind: 'recorded-scy' }, origin: origin(options),
        });
      } else {
        parsedSplits.push({
          splitId: `history-split:${id}`, swimmerId: options.swimmerId, relayEventKey: null, legPosition: null,
          start, legEventKey: shape.eventKey, split: timeValue(hundredths), course, date: null, origin: origin(options),
        });
      }
    });
  }
  return { swims: parsedSwims, splits: parsedSplits };
}

/** Keep the fastest split per leg event across the swimmer's teams; tied best rows are retained. */
export function bestRelaySplitsAcrossTeams(byTeam: ReadonlyMap<TeamId, readonly RelaySplit[]>, teams: readonly TeamId[]): BestRelaySplit[] {
  const best = new Map<string, number>();
  const out: BestRelaySplit[] = [];
  for (const teamId of teams) {
    const rows = byTeam.get(teamId);
    if (rows === undefined) throw new AdapterError('unresolved_reference', `teams.${teamId}`, 'team relay history is absent');
    for (const split of rows) {
      const key = `${split.legEventKey ?? ''}\u0000${split.start}\u0000${split.course ?? ''}`;
      const time = split.split.hundredths;
      const held = best.get(key);
      if (held === undefined || time < held) {
        best.set(key, time);
        for (let i = out.length - 1; i >= 0; i -= 1) if (`${out[i]?.split.legEventKey ?? ''}\u0000${out[i]?.split.start}\u0000${out[i]?.split.course ?? ''}` === key) out.splice(i, 1);
        out.push({ teamId, split });
      } else if (time === held) out.push({ teamId, split });
    }
  }
  return out;
}
