/** Strict parsers for persisted report inputs. */
import type { NotScoredReason, Results, ResultRow, Violation } from '../model/results';
import type { LineupDisplay } from '../model/lineup';
import type { Gender } from '../model/primitives';
import type { SessionRef } from '../planner/types';

export class ReportParseError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ReportParseError';
  }
}

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value: unknown, path: string): ObjectValue {
  if (!isObject(value)) throw new ReportParseError(path, 'expected object');
  return value;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ReportParseError(path, 'expected array');
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ReportParseError(path, 'expected string');
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReportParseError(path, 'expected finite number');
  }
  return value;
}

function genderAt(value: unknown, path: string): Gender {
  if (value !== 'Men' && value !== 'Women') throw new ReportParseError(path, 'unknown gender');
  return value;
}

function reasonAt(value: unknown, path: string): NotScoredReason | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'non_scorer' || value === 'scoring_team_full' || value === 'event_scorer_cap' ||
    value === 'relay_scorer_cap' || value === 'removed_over_event_cap' || value === 'exhibition' ||
    value === 'outside_point_table' || value === 'no_time' || value === 'time_trial'
  ) return value;
  throw new ReportParseError(path, 'unknown reason');
}

function sessionAt(value: unknown, path: string): SessionRef {
  const source = objectAt(value, path);
  const day = numberAt(source.day, `${path}.day`);
  if (!Number.isInteger(day) || day < 1) throw new ReportParseError(`${path}.day`, 'expected positive integer');
  if (source.slot !== 'morning' && source.slot !== 'afternoon' && source.slot !== 'evening') {
    throw new ReportParseError(`${path}.slot`, 'unknown slot');
  }
  return { day, slot: source.slot };
}

function stringsAt(value: unknown, path: string): string[] {
  return arrayAt(value, path).map((item, index) => stringAt(item, `${path}[${index}]`));
}

function entryCapAt(source: ObjectValue, path: string): Violation {
  if (source.which !== 'individual' && source.which !== 'relay' && source.which !== 'total') {
    throw new ReportParseError(`${path}.which`, 'unknown cap');
  }
  return {
    kind: 'entry_cap',
    swimmerId: stringAt(source.swimmerId, `${path}.swimmerId`),
    which: source.which,
    count: numberAt(source.count, `${path}.count`),
    limit: numberAt(source.limit, `${path}.limit`),
  };
}

function relayLegAt(source: ObjectValue, path: string): Violation {
  if (source.leg !== 1 && source.leg !== 2 && source.leg !== 3 && source.leg !== 4) {
    throw new ReportParseError(`${path}.leg`, 'expected leg 1 to 4');
  }
  const reason = source.reason;
  if (
    reason !== 'wrong_gender' && reason !== 'duplicate_swimmer' && reason !== 'event_mismatch' &&
    reason !== 'basis_position' && reason !== 'off_scoring_roster'
  ) throw new ReportParseError(`${path}.reason`, 'unknown reason');
  return { kind: 'relay_leg', entryKey: stringAt(source.entryKey, `${path}.entryKey`), leg: source.leg, reason };
}

function pendingSettingAt(source: ObjectValue, path: string): Violation {
  const setting = source.setting;
  if (
    setting !== 'fastHeatSize' && setting !== 'smallFieldSession' && setting !== 'cFinal' &&
    setting !== 'abFinalsScorersOnly' && setting !== 'individualPoints' &&
    setting !== 'relayPoints' && setting !== 'diving'
  ) throw new ReportParseError(`${path}.setting`, 'unknown setting');
  return {
    kind: 'pending_setting',
    eventKey: stringAt(source.eventKey, `${path}.eventKey`),
    gender: genderAt(source.gender, `${path}.gender`),
    setting,
  };
}

function parseViolation(value: unknown, path: string): Violation {
  const source = objectAt(value, path);
  switch (source.kind) {
    case 'entry_cap': return entryCapAt(source, path);
    case 'session_load': return {
      kind: 'session_load', swimmerId: stringAt(source.swimmerId, `${path}.swimmerId`),
      session: sessionAt(source.session, `${path}.session`), races: numberAt(source.races, `${path}.races`),
      limit: numberAt(source.limit, `${path}.limit`),
    };
    case 'relay_leg': return relayLegAt(source, path);
    case 'scorer_without_entry': return {
      kind: 'scorer_without_entry', teamId: stringAt(source.teamId, `${path}.teamId`),
      gender: genderAt(source.gender, `${path}.gender`), swimmerId: stringAt(source.swimmerId, `${path}.swimmerId`),
    };
    case 'relay_swimmer_repeated': return {
      kind: 'relay_swimmer_repeated', teamId: stringAt(source.teamId, `${path}.teamId`),
      swimmerId: stringAt(source.swimmerId, `${path}.swimmerId`), eventKey: stringAt(source.eventKey, `${path}.eventKey`),
      gender: genderAt(source.gender, `${path}.gender`), entryKeys: stringsAt(source.entryKeys, `${path}.entryKeys`),
    };
    case 'relay_entries_over_limit': return {
      kind: 'relay_entries_over_limit', teamId: stringAt(source.teamId, `${path}.teamId`),
      eventKey: stringAt(source.eventKey, `${path}.eventKey`), gender: genderAt(source.gender, `${path}.gender`),
      entryKeys: stringsAt(source.entryKeys, `${path}.entryKeys`), count: numberAt(source.count, `${path}.count`),
      limit: numberAt(source.limit, `${path}.limit`),
    };
    case 'scoring_team_size': {
      const spots = objectAt(source.spots, `${path}.spots`);
      return {
        kind: 'scoring_team_size', teamId: stringAt(source.teamId, `${path}.teamId`),
        gender: genderAt(source.gender, `${path}.gender`), scorers: numberAt(source.scorers, `${path}.scorers`),
        divers: numberAt(source.divers, `${path}.divers`),
        spots: { numerator: numberAt(spots.numerator, `${path}.spots.numerator`), denominator: numberAt(spots.denominator, `${path}.spots.denominator`) },
        limit: numberAt(source.limit, `${path}.limit`),
      };
    }
    case 'unscheduled_event': return {
      kind: 'unscheduled_event', eventKey: stringAt(source.eventKey, `${path}.eventKey`),
      gender: genderAt(source.gender, `${path}.gender`),
    };
    case 'pending_setting': return pendingSettingAt(source, path);
    case 'seed_time_missing': return {
      kind: 'seed_time_missing', entryKey: stringAt(source.entryKey, `${path}.entryKey`),
      eventKey: stringAt(source.eventKey, `${path}.eventKey`), gender: genderAt(source.gender, `${path}.gender`),
    };
    default: throw new ReportParseError(`${path}.kind`, 'unknown violation');
  }
}

function parseTeam(value: unknown, index: number): Results['teams'][number] {
  const path = `$.teams[${index}]`;
  const source = objectAt(value, path);
  return {
    teamId: stringAt(source.teamId, `${path}.teamId`),
    points: numberAt(source.points, `${path}.points`),
    rank: numberAt(source.rank, `${path}.rank`),
  };
}

function parseRow(value: unknown, path: string): ResultRow {
  const source = objectAt(value, path);
  const swimmerId = source.swimmerId;
  if (swimmerId !== null && typeof swimmerId !== 'string') {
    throw new ReportParseError(`${path}.swimmerId`, 'expected string or null');
  }
  const place = source.place;
  if (place !== null && (typeof place !== 'number' || !Number.isFinite(place))) {
    throw new ReportParseError(`${path}.place`, 'expected finite number or null');
  }
  if (typeof source.scored !== 'boolean') throw new ReportParseError(`${path}.scored`, 'expected boolean');
  const notScoredReason = reasonAt(source.notScoredReason, `${path}.notScoredReason`);
  return {
    entryKey: stringAt(source.entryKey, `${path}.entryKey`),
    teamId: stringAt(source.teamId, `${path}.teamId`),
    swimmerId,
    place,
    points: numberAt(source.points, `${path}.points`),
    scored: source.scored,
    ...(notScoredReason === undefined ? {} : { notScoredReason }),
  };
}

function parseEvent(value: unknown, index: number): Results['events'][number] {
  const path = `$.events[${index}]`;
  const source = objectAt(value, path);
  const rows = arrayAt(source.rows, `${path}.rows`).map((row, rowIndex) => parseRow(row, `${path}.rows[${rowIndex}]`));
  return { eventKey: stringAt(source.eventKey, `${path}.eventKey`), gender: genderAt(source.gender, `${path}.gender`), rows };
}

function parseDisplayNames(value: unknown, path: string): Record<string, { name: string }> {
  const source = objectAt(value, path);
  const names: Record<string, { name: string }> = {};
  for (const [id, rawName] of Object.entries(source)) {
    names[id] = { name: stringAt(objectAt(rawName, `${path}.${id}`).name, `${path}.${id}.name`) };
  }
  return names;
}

function parseDisplay(value: unknown): LineupDisplay {
  const source = objectAt(value, '$.display');
  const rawTimes = objectAt(source.entryTimes, '$.display.entryTimes');
  const entryTimes: Record<string, { text: string; hundredths: number }> = {};
  for (const [key, rawTime] of Object.entries(rawTimes)) {
    const path = `$.display.entryTimes.${key}`;
    const time = objectAt(rawTime, path);
    const hundredths = numberAt(time.hundredths, `${path}.hundredths`);
    if (!Number.isInteger(hundredths) || hundredths < 0) throw new ReportParseError(`${path}.hundredths`, 'expected non-negative integer');
    entryTimes[key] = { text: stringAt(time.text, `${path}.text`), hundredths };
  }
  return {
    swimmers: parseDisplayNames(source.swimmers, '$.display.swimmers'),
    teams: parseDisplayNames(source.teams, '$.display.teams'),
    entryTimes,
  };
}

/** Parse saved Results and identify malformed fields by their JSON path. */
export function parseResults(json: unknown): Results {
  const source = objectAt(json, '$');
  if (source.payloadVersion !== 1) throw new ReportParseError('$.payloadVersion', 'expected 1');
  const teams = arrayAt(source.teams, '$.teams').map(parseTeam);
  const events = arrayAt(source.events, '$.events').map(parseEvent);
  const violations = arrayAt(source.violations, '$.violations').map((item, index) => parseViolation(item, `$.violations[${index}]`));
  const rosterUnknown = arrayAt(source.rosterUnknown, '$.rosterUnknown').map((item, index) => stringAt(item, `$.rosterUnknown[${index}]`));
  const display = source.display === undefined ? undefined : parseDisplay(source.display);
  return { payloadVersion: 1, teams, events, violations, rosterUnknown, ...(display === undefined ? {} : { display }) };
}
