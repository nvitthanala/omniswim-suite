/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `validateMeetModel` (plans/2026-10-25/D2-ENGINE-API.md, 3.6).
 *
 * The boundary for a stored or adapted meet model. It reads untrusted JSON and returns a `MeetModel`
 * or throws `MeetModelError` naming the path. It never repairs: a missing key, an unknown key, a
 * `null` where a value belongs, or a time with no hundredths all throw.
 *
 * Checks, beyond the shape of every record:
 * - IDs are unique: teams, swimmers, swims, relay splits, and events by (event key, gender).
 * - Every reference resolves: swimmer to team, swim to swimmer and to an event of the swimmer's
 *   gender, split to swimmer and to its events, observed scores and display names to a team or swimmer.
 * - A swim's event is not a relay, and the swimmer's gender equals the event's gender.
 * - A `converted` statement never sits on a recorded SCY swim or on a null time. A `recorded-scy`
 *   statement sits only on an SCY swim.
 * - A time is hundredths plus text, and for a non-diving swim the text reads back to the hundredths.
 *
 * Invariant 9 (a source-adjusted swim is never adjusted again): the P1 shape of `MeetSwim` holds no
 * altitude field, so there is nothing to adjust twice and no check can fail. The flag is validated
 * as the literal `true` and nothing more.
 */
import type { NcaaDivision } from '../types';
import { expectIsoDate, expectIsoTime, isRecord, parseProvenance } from './provenance';
import { parseTimeText } from './primitives';
import type { Course, Gender, TimeValue } from './primitives';
import type {
  ConversionBasis,
  DateWindow,
  DivisionRef,
  MeetDisplay,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MeetSwimmer,
  MeetTeam,
  RelaySplit,
  ScyStatement,
  SwimFlags,
  SwimOrigin,
} from './meet';

export type MeetModelErrorCode = 'missing' | 'invalid' | 'duplicate' | 'unresolved' | 'gender_mismatch' | 'inconsistent';

export class MeetModelError extends Error {
  /** Dotted path of the field, e.g. `swims[3].swimmerId`. */
  readonly path: string;
  readonly code: MeetModelErrorCode;

  constructor(path: string, code: MeetModelErrorCode, message: string) {
    super(message);
    this.name = 'MeetModelError';
    this.path = path;
    this.code = code;
  }
}

const fail = (path: string, code: MeetModelErrorCode, why: string): never => {
  throw new MeetModelError(path, code, `${path}: ${why}`);
};

/* -------------------------------------------------------------------------- */
/* Field readers                                                              */
/* -------------------------------------------------------------------------- */

/** Like `expectKeys` in `provenance.ts`, but it throws `MeetModelError`. */
function keys(raw: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(raw)) return fail(path, 'invalid', 'expected an object');
  for (const key of required) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) return fail(`${path}.${key}`, 'missing', 'missing');
  }
  for (const key of Object.keys(raw)) {
    if (!required.includes(key) && !optional.includes(key)) return fail(`${path}.${key}`, 'invalid', 'unknown key');
  }
  return raw;
}

function str(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fail(path, 'invalid', 'expected a non-empty string');
  return raw;
}

function oneOf<T extends string>(raw: unknown, path: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return fail(path, 'invalid', `expected one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
  }
  return raw as T;
}

function list(raw: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(raw)) return fail(path, 'invalid', 'expected a list');
  return raw;
}

function nonNegativeInteger(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return fail(path, 'invalid', 'expected a whole number of 0 or more');
  return raw;
}

function bool(raw: unknown, path: string): boolean {
  if (typeof raw !== 'boolean') return fail(path, 'invalid', 'expected true or false');
  return raw;
}

/** Wrap the shared date, instant and provenance readers, which throw `RulePresetError`. */
function wrapped<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof MeetModelError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(path, 'invalid', message);
  }
}

function parseTimeValue(raw: unknown, path: string, isScore: boolean): TimeValue {
  const obj = keys(raw, path, ['text', 'hundredths']);
  const text = str(obj.text, `${path}.text`);
  const hundredths = nonNegativeInteger(obj.hundredths, `${path}.hundredths`);
  if (!isScore) {
    // A time text reads back to its hundredths. A mismatch is a stored value that disagrees with itself.
    const parsed = wrapped(`${path}.text`, () => parseTimeText(text));
    if (parsed === null || parsed.hundredths !== hundredths) {
      return fail(`${path}.text`, 'inconsistent', `"${text}" does not read as ${hundredths} hundredths`);
    }
  }
  return { text, hundredths };
}

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

const GENDERS = ['Men', 'Women'] as const;
const COURSES = ['SCY', 'SCM', 'LCM'] as const;
const DIVISIONS: readonly NcaaDivision[] = ['D1', 'D2', 'D3', 'NAIA'];

function parseDivision(raw: unknown, path: string): DivisionRef {
  if (!isRecord(raw)) return fail(path, 'invalid', 'expected an object');
  if (raw.state === 'known') {
    const obj = keys(raw, path, ['state', 'division', 'season']);
    return { state: 'known', division: oneOf(obj.division, `${path}.division`, DIVISIONS), season: str(obj.season, `${path}.season`) };
  }
  if (raw.state === 'unknown') {
    const obj = keys(raw, path, ['state', 'reason']);
    return {
      state: 'unknown',
      reason: oneOf(obj.reason, `${path}.reason`, ['unmapped_team', 'program_discontinued', 'gender_not_sponsored', 'sponsorship_unaudited'] as const),
    };
  }
  return fail(`${path}.state`, 'invalid', 'expected "known" or "unknown"');
}

function parseTeam(raw: unknown, path: string): MeetTeam {
  const obj = keys(raw, path, ['teamId', 'division']);
  return { teamId: str(obj.teamId, `${path}.teamId`), division: parseDivision(obj.division, `${path}.division`) };
}

function parseSwimmer(raw: unknown, path: string): MeetSwimmer {
  const obj = keys(raw, path, ['swimmerId', 'teamId', 'gender', 'classYear', 'roster']);
  const classYear = obj.classYear === null ? null : oneOf(obj.classYear, `${path}.classYear`, ['FR', 'SO', 'JR', 'SR', 'GR'] as const);
  return {
    swimmerId: str(obj.swimmerId, `${path}.swimmerId`),
    teamId: str(obj.teamId, `${path}.teamId`),
    gender: oneOf(obj.gender, `${path}.gender`, GENDERS),
    classYear,
    roster: oneOf(obj.roster, `${path}.roster`, ['member', 'not_member', 'unknown'] as const),
  };
}

function parseEvent(raw: unknown, path: string): MeetEvent {
  const obj = keys(raw, path, ['eventKey', 'gender', 'kind', 'distanceYards', 'relayKind']);
  const kind = oneOf(obj.kind, `${path}.kind`, ['individual', 'relay', 'diving'] as const);
  const distanceYards = obj.distanceYards === null ? null : nonNegativeInteger(obj.distanceYards, `${path}.distanceYards`);
  const relayKind = obj.relayKind === null ? null : oneOf(obj.relayKind, `${path}.relayKind`, ['medley', 'freestyle'] as const);
  if (kind === 'diving' && distanceYards !== null) fail(`${path}.distanceYards`, 'inconsistent', 'a diving event has no distance');
  if (kind !== 'diving' && distanceYards === null) fail(`${path}.distanceYards`, 'inconsistent', 'a swimming event needs a distance');
  if (kind === 'relay' && relayKind === null) fail(`${path}.relayKind`, 'inconsistent', 'a relay event needs a relay kind');
  if (kind !== 'relay' && relayKind !== null) fail(`${path}.relayKind`, 'inconsistent', 'only a relay event has a relay kind');
  return { eventKey: str(obj.eventKey, `${path}.eventKey`), gender: oneOf(obj.gender, `${path}.gender`, GENDERS), kind, distanceYards, relayKind };
}

function parseFlags(raw: unknown, path: string): SwimFlags {
  const names = ['extractedSplit', 'userInputted', 'altitudeAdjustedBySource', 'exhibition', 'timeTrial', 'programUnconfirmed'] as const;
  const obj = keys(raw, path, [], names);
  const out: Record<string, true> = {};
  for (const name of names) {
    if (obj[name] === undefined) continue;
    // `false` is not allowed: an absent flag means not stated, and a stored `false` would claim a statement.
    if (obj[name] !== true) fail(`${path}.${name}`, 'invalid', 'a flag is true or absent');
    out[name] = true;
  }
  return out as SwimFlags;
}

function parseBasis(raw: unknown, path: string): ConversionBasis {
  if (!isRecord(raw)) return fail(path, 'invalid', 'expected an object');
  switch (raw.method) {
    case 'swimcloud': {
      const obj = keys(raw, path, ['method', 'displayedText']);
      return { method: 'swimcloud', displayedText: str(obj.displayedText, `${path}.displayedText`) };
    }
    case 'ncaa_scm_table': {
      const obj = keys(raw, path, ['method', 'tableId', 'factor', 'division', 'reason'], ['appliedTo']);
      if (typeof obj.factor !== 'number' || !Number.isFinite(obj.factor) || obj.factor <= 0) fail(`${path}.factor`, 'invalid', 'expected a positive number');
      const tableId = oneOf(obj.tableId, `${path}.tableId`, ['ncaa-rules-book-a2-2026-27', 'ncaa-d1-2025-26'] as const);
      const division = obj.division === null ? null : oneOf(obj.division, `${path}.division`, DIVISIONS);
      const base = { method: 'ncaa_scm_table' as const, tableId, factor: obj.factor as number, division, reason: str(obj.reason, `${path}.reason`) };
      const withApplied = obj.appliedTo === undefined ? base : { ...base, appliedTo: oneOf(obj.appliedTo, `${path}.appliedTo`, ['relay-split'] as const) };
      return withApplied as unknown as ConversionBasis;
    }
    case 'lcm_scy_tool_derived': {
      const obj = keys(raw, path, ['method', 'lcmEventKey', 'scyEventKey', 'divisorScaled', 'turnHundredths', 'provenance', 'appliedTo']);
      return {
        method: 'lcm_scy_tool_derived',
        lcmEventKey: str(obj.lcmEventKey, `${path}.lcmEventKey`),
        scyEventKey: str(obj.scyEventKey, `${path}.scyEventKey`),
        divisorScaled: nonNegativeInteger(obj.divisorScaled, `${path}.divisorScaled`),
        turnHundredths: nonNegativeInteger(obj.turnHundredths, `${path}.turnHundredths`),
        provenance: wrapped(`${path}.provenance`, () => parseProvenance(obj.provenance, `${path}.provenance`)),
        appliedTo: oneOf(obj.appliedTo, `${path}.appliedTo`, ['individual-swim', 'relay-split'] as const),
      };
    }
    case 'table_d': {
      const obj = keys(raw, path, ['method', 'multiplierPermille', 'turnAdjustmentHundredths', 'provenance']);
      return {
        method: 'table_d',
        multiplierPermille: nonNegativeInteger(obj.multiplierPermille, `${path}.multiplierPermille`),
        turnAdjustmentHundredths: nonNegativeInteger(obj.turnAdjustmentHundredths, `${path}.turnAdjustmentHundredths`),
        provenance: wrapped(`${path}.provenance`, () => parseProvenance(obj.provenance, `${path}.provenance`)),
      };
    }
    default:
      return fail(`${path}.method`, 'invalid', 'unknown conversion method');
  }
}

function parseScy(raw: unknown, path: string): ScyStatement {
  if (!isRecord(raw)) return fail(path, 'invalid', 'expected an object');
  if (raw.kind === 'recorded-scy') {
    keys(raw, path, ['kind']);
    return { kind: 'recorded-scy' };
  }
  if (raw.kind === 'converted') {
    const obj = keys(raw, path, ['kind', 'hundredths', 'basis', 'estimated']);
    if (obj.estimated !== true) fail(`${path}.estimated`, 'invalid', 'a converted time is always an estimate: expected true');
    const hundredths = nonNegativeInteger(obj.hundredths, `${path}.hundredths`);
    if (hundredths === 0) fail(`${path}.hundredths`, 'invalid', 'a converted time of 0 is not a time');
    return { kind: 'converted', hundredths, basis: parseBasis(obj.basis, `${path}.basis`), estimated: true };
  }
  if (raw.kind === 'not-convertible') {
    const obj = keys(raw, path, ['kind', 'reason']);
    return {
      kind: 'not-convertible',
      reason: oneOf(obj.reason, `${path}.reason`, ['event_not_swum_in_course', 'no_conversion_available', 'conversions_excluded'] as const),
    };
  }
  return fail(`${path}.kind`, 'invalid', 'expected "recorded-scy", "converted" or "not-convertible"');
}

function parseOrigin(raw: unknown, path: string): SwimOrigin {
  if (!isRecord(raw)) return fail(path, 'invalid', 'expected an object');
  if (raw.kind === 'simulator') {
    const obj = keys(raw, path, ['kind', 'snapshotId']);
    return { kind: 'simulator', snapshotId: str(obj.snapshotId, `${path}.snapshotId`) };
  }
  if (raw.kind === 'history-fetch') {
    const obj = keys(raw, path, ['kind', 'fetchedAt', 'url']);
    return {
      kind: 'history-fetch',
      fetchedAt: wrapped(`${path}.fetchedAt`, () => expectIsoTime(obj.fetchedAt, `${path}.fetchedAt`)),
      url: str(obj.url, `${path}.url`),
    };
  }
  return fail(`${path}.kind`, 'invalid', 'expected "simulator" or "history-fetch"');
}

function nullableDate(raw: unknown, path: string): string | null {
  return raw === null ? null : wrapped(path, () => expectIsoDate(raw, path));
}

function nullableString(raw: unknown, path: string): string | null {
  return raw === null ? null : str(raw, path);
}

function parseCourse(raw: unknown, path: string): Course {
  return oneOf(raw, path, COURSES);
}

function parseSwim(raw: unknown, path: string, diving: ReadonlySet<string>): MeetSwim {
  const obj = keys(raw, path, ['swimId', 'swimmerId', 'eventKey', 'recordedCourse', 'recordedTime', 'date', 'seasonId', 'flags', 'scy', 'origin']);
  const eventKey = str(obj.eventKey, `${path}.eventKey`);
  const recordedTime = obj.recordedTime === null ? null : parseTimeValue(obj.recordedTime, `${path}.recordedTime`, diving.has(eventKey));
  const recordedCourse = parseCourse(obj.recordedCourse, `${path}.recordedCourse`);
  const scy = parseScy(obj.scy, `${path}.scy`);
  if (scy.kind === 'converted' && recordedCourse === 'SCY') {
    fail(`${path}.scy`, 'inconsistent', 'a converted statement on a recorded SCY swim');
  }
  if (scy.kind === 'converted' && recordedTime === null) fail(`${path}.scy`, 'inconsistent', 'a converted statement on a null time');
  if (scy.kind === 'recorded-scy' && recordedCourse !== 'SCY') {
    fail(`${path}.scy`, 'inconsistent', `a recorded-scy statement on a ${recordedCourse} swim`);
  }
  return {
    swimId: str(obj.swimId, `${path}.swimId`),
    swimmerId: str(obj.swimmerId, `${path}.swimmerId`),
    eventKey,
    recordedCourse,
    recordedTime,
    date: nullableDate(obj.date, `${path}.date`),
    seasonId: nullableString(obj.seasonId, `${path}.seasonId`),
    flags: parseFlags(obj.flags, `${path}.flags`),
    scy,
    origin: parseOrigin(obj.origin, `${path}.origin`),
  };
}

function parseSplit(raw: unknown, path: string): RelaySplit {
  const obj = keys(raw, path, ['splitId', 'swimmerId', 'relayEventKey', 'legPosition', 'start', 'legEventKey', 'split', 'course', 'date', 'origin']);
  let legPosition: 1 | 2 | 3 | 4 | null = null;
  if (obj.legPosition !== null) {
    if (obj.legPosition !== 1 && obj.legPosition !== 2 && obj.legPosition !== 3 && obj.legPosition !== 4) {
      fail(`${path}.legPosition`, 'invalid', 'expected 1, 2, 3, 4 or null');
    }
    legPosition = obj.legPosition as 1 | 2 | 3 | 4;
  }
  return {
    splitId: str(obj.splitId, `${path}.splitId`),
    swimmerId: str(obj.swimmerId, `${path}.swimmerId`),
    relayEventKey: nullableString(obj.relayEventKey, `${path}.relayEventKey`),
    legPosition,
    start: oneOf(obj.start, `${path}.start`, ['flat', 'flying', 'unknown'] as const),
    legEventKey: nullableString(obj.legEventKey, `${path}.legEventKey`),
    split: parseTimeValue(obj.split, `${path}.split`, false),
    course: obj.course === null ? null : parseCourse(obj.course, `${path}.course`),
    date: nullableDate(obj.date, `${path}.date`),
    origin: parseOrigin(obj.origin, `${path}.origin`),
  };
}

function parseWindow(raw: unknown, path: string): DateWindow {
  if (!isRecord(raw)) return fail(path, 'invalid', 'expected an object');
  if (raw.kind === 'seasons') {
    const obj = keys(raw, path, ['kind', 'seasonIds']);
    const ids = list(obj.seasonIds, `${path}.seasonIds`).map((id, i) => str(id, `${path}.seasonIds[${i}]`));
    if (ids.length === 0) fail(`${path}.seasonIds`, 'invalid', 'a season window names at least one season');
    return { kind: 'seasons', seasonIds: ids };
  }
  if (raw.kind === 'dates') {
    const obj = keys(raw, path, ['kind', 'from', 'to']);
    const from = wrapped(`${path}.from`, () => expectIsoDate(obj.from, `${path}.from`));
    const to = wrapped(`${path}.to`, () => expectIsoDate(obj.to, `${path}.to`));
    if (from > to) fail(path, 'invalid', 'from is after to');
    return { kind: 'dates', from, to };
  }
  return fail(`${path}.kind`, 'invalid', 'expected "seasons" or "dates"');
}

function parseDisplay(raw: unknown, path: string): MeetDisplay {
  const obj = keys(raw, path, ['swimmers', 'teams']);
  const names = (rec: unknown, p: string): Record<string, { readonly name: string }> => {
    if (!isRecord(rec)) return fail(p, 'invalid', 'expected an object');
    const out: Record<string, { readonly name: string }> = {};
    for (const [id, value] of Object.entries(rec)) {
      const entry = keys(value, `${p}.${id}`, ['name']);
      out[id] = { name: str(entry.name, `${p}.${id}.name`) };
    }
    return out;
  };
  return { swimmers: names(obj.swimmers, `${path}.swimmers`), teams: names(obj.teams, `${path}.teams`) };
}

/* -------------------------------------------------------------------------- */
/* validateMeetModel                                                          */
/* -------------------------------------------------------------------------- */

function unique<T>(items: readonly T[], idOf: (item: T) => string, path: string, what: string): Map<string, T> {
  const seen = new Map<string, T>();
  items.forEach((item, i) => {
    const id = idOf(item);
    if (seen.has(id)) fail(`${path}[${i}]`, 'duplicate', `${what} "${id}" appears twice`);
    seen.set(id, item);
  });
  return seen;
}

const eventId = (eventKey: string, gender: Gender): string => `${gender}\u0000${eventKey}`;

/**
 * Read an untrusted meet model. Throws `MeetModelError` on the first problem, naming its path.
 * The result is a fresh object: nothing aliases the input.
 */
export function validateMeetModel(m: unknown): MeetModel {
  const root = keys(m, 'model', ['payloadVersion', 'meetKey', 'teams', 'swimmers', 'events', 'swims', 'relaySplits', 'recordRange', 'extendedWindow', 'observedScores'], ['display']);
  if (root.payloadVersion !== 1) fail('model.payloadVersion', 'invalid', 'expected 1');

  const teams = list(root.teams, 'model.teams').map((t, i) => parseTeam(t, `model.teams[${i}]`));
  const swimmers = list(root.swimmers, 'model.swimmers').map((s, i) => parseSwimmer(s, `model.swimmers[${i}]`));
  const events = list(root.events, 'model.events').map((e, i) => parseEvent(e, `model.events[${i}]`));

  const teamById = unique(teams, (t) => t.teamId, 'model.teams', 'team');
  const swimmerById = unique(swimmers, (s) => s.swimmerId, 'model.swimmers', 'swimmer');
  const eventById = unique(events, (e) => eventId(e.eventKey, e.gender), 'model.events', 'event');
  const divingKeys = new Set(events.filter((e) => e.kind === 'diving').map((e) => e.eventKey));

  const swims = list(root.swims, 'model.swims').map((s, i) => parseSwim(s, `model.swims[${i}]`, divingKeys));
  const relaySplits = list(root.relaySplits, 'model.relaySplits').map((s, i) => parseSplit(s, `model.relaySplits[${i}]`));
  unique(swims, (s) => s.swimId, 'model.swims', 'swim');
  unique(relaySplits, (s) => s.splitId, 'model.relaySplits', 'split');

  swimmers.forEach((s, i) => {
    if (!teamById.has(s.teamId)) fail(`model.swimmers[${i}].teamId`, 'unresolved', `team "${s.teamId}" is not in the model`);
  });

  swims.forEach((swim, i) => {
    const path = `model.swims[${i}]`;
    const swimmer = swimmerById.get(swim.swimmerId);
    if (!swimmer) return fail(`${path}.swimmerId`, 'unresolved', `swimmer "${swim.swimmerId}" is not in the model`);
    const event = eventById.get(eventId(swim.eventKey, swimmer.gender));
    if (!event) {
      const other = eventById.get(eventId(swim.eventKey, swimmer.gender === 'Men' ? 'Women' : 'Men'));
      if (other) return fail(`${path}.eventKey`, 'gender_mismatch', `${swimmer.gender} swimmer "${swim.swimmerId}" has a swim in the ${other.gender} event "${swim.eventKey}"`);
      return fail(`${path}.eventKey`, 'unresolved', `event "${swim.eventKey}" is not in the model`);
    }
    if (event.kind === 'relay') return fail(`${path}.eventKey`, 'inconsistent', `"${swim.eventKey}" is a relay; a relay swim is a lineup entry, not a swim`);
  });

  relaySplits.forEach((split, i) => {
    const path = `model.relaySplits[${i}]`;
    const swimmer = swimmerById.get(split.swimmerId);
    if (!swimmer) return fail(`${path}.swimmerId`, 'unresolved', `swimmer "${split.swimmerId}" is not in the model`);
    if (split.relayEventKey !== null) {
      const relay = eventById.get(eventId(split.relayEventKey, swimmer.gender));
      if (!relay) return fail(`${path}.relayEventKey`, 'unresolved', `relay "${split.relayEventKey}" is not in the model for ${swimmer.gender}`);
      if (relay.kind !== 'relay') return fail(`${path}.relayEventKey`, 'inconsistent', `"${split.relayEventKey}" is not a relay`);
    }
    if (split.legEventKey !== null && !eventById.has(eventId(split.legEventKey, swimmer.gender))) {
      return fail(`${path}.legEventKey`, 'unresolved', `event "${split.legEventKey}" is not in the model for ${swimmer.gender}`);
    }
  });

  let observedScores: MeetModel['observedScores'] = null;
  if (root.observedScores !== null) {
    const seen = new Set<string>();
    observedScores = list(root.observedScores, 'model.observedScores').map((row, i) => {
      const path = `model.observedScores[${i}]`;
      const obj = keys(row, path, ['teamId', 'points']);
      const teamId = str(obj.teamId, `${path}.teamId`);
      if (!teamById.has(teamId)) fail(`${path}.teamId`, 'unresolved', `team "${teamId}" is not in the model`);
      if (seen.has(teamId)) fail(`${path}.teamId`, 'duplicate', `team "${teamId}" appears twice`);
      seen.add(teamId);
      if (typeof obj.points !== 'number' || !Number.isFinite(obj.points) || obj.points < 0) fail(`${path}.points`, 'invalid', 'expected a finite number of 0 or more');
      return { teamId, points: obj.points as number };
    });
  }

  let display: MeetDisplay | undefined;
  if (root.display !== undefined) {
    display = parseDisplay(root.display, 'model.display');
    for (const id of Object.keys(display.swimmers)) {
      if (!swimmerById.has(id)) fail(`model.display.swimmers.${id}`, 'unresolved', `swimmer "${id}" is not in the model`);
    }
    for (const id of Object.keys(display.teams)) {
      if (!teamById.has(id)) fail(`model.display.teams.${id}`, 'unresolved', `team "${id}" is not in the model`);
    }
  }

  const out: MeetModel = {
    payloadVersion: 1,
    meetKey: str(root.meetKey, 'model.meetKey'),
    teams,
    swimmers,
    events,
    swims,
    relaySplits,
    recordRange: parseWindow(root.recordRange, 'model.recordRange'),
    extendedWindow: bool(root.extendedWindow, 'model.extendedWindow'),
    observedScores,
  };
  return display === undefined ? out : { ...out, display };
}

