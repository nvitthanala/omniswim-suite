/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Record validators (plans/2026-10-25/D3-STORAGE-AND-BUILD.md, 5.3 rule 4, 5.4 and 5.6 rule 3).
 *
 * One validator serves `StorageRepo.put`, `putCache`, the service-worker broker and `importData`.
 * Rules, all from CLAUDE.md "Data provenance":
 * - A missing field is an error. Nothing is filled with a default.
 * - An unknown key is an error.
 * - A value must survive `JSON.parse(JSON.stringify(v))`: no `undefined`-valued key, NaN, Infinity,
 *   Date, Map or Set.
 * - Rule presets go through the engine's `parseRulePreset`: a missing or legacy-sentinel cap, and
 *   `provenance:'legacy'`, are rejected there. Every `published` source must also be listed in a
 *   bundled source manifest (a value is never upgraded to published).
 * - Cache rows are never empty by accident: a history with an empty payload is rejected, and so is a
 *   roster with no members unless it carries `verifiedEmpty: true` (R53). A failed fetch or a parser
 *   that found nothing cannot leave a plausible empty row.
 * - A meet with no teams is valid only as a draft (`status: 'draft'`, R54), and a draft has no teams.
 * - Nothing here reads a clock or a random source.
 *
 * INTERIM: the engine has no `parseSessionPreset` or lineup parser until P5. `validateSessionPreset`
 * and `validateLineup` below check shape only (keys, types, enums). Replace them with the engine
 * parsers when P5 lands.
 */
import { parseRulePreset, parseSessionPreset, parseTimeText, RulePresetError } from '@omniswim/engine';
import type { RulePreset, SessionPreset } from '@omniswim/engine';
import { parseLoadPreference } from './sessionPreference';
import { InvalidRecordError } from './errors';
import type { ValidationIssue } from './errors';
import { publishedSourceProblem, toolArchiveProblem } from './sourceManifests';
import { CLASS_YEARS, PAYLOAD_VERSION } from './schema';
import type { SettingsMap, UserStore } from './schema';

/** Internal: thrown by a check, caught by `validateRecord`. */
class Fail extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message);
  }
}

const fail = (path: string, message: string): never => {
  throw new Fail(path, message);
};

type Obj = Record<string, unknown>;

const ISO_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z$/;
/**
 * A real ISO-8601 UTC instant: the `Date#toISOString()` shape, with a day that exists in its month
 * (no 2026-02-30) and no leap second. The regex alone accepts 2026-02-30.
 */
export function isStrictIsoInstant(text: unknown): text is string {
  if (typeof text !== 'string' || !ISO_TIME.test(text)) return false;
  const [y, m, d] = [Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10))] as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
const SWIMCLOUD_ID =/^[1-9][0-9]*$/;

// toString, not a prototype check: a record that crossed a realm or a structured clone still counts, and Map, Set and Date do not.
const isObj = (v: unknown): v is Obj => Object.prototype.toString.call(v) === '[object Object]';

/** The value must be plain JSON: objects, arrays, strings, finite numbers, booleans, null. */
export function assertJsonSafe(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, `${String(value)} is not JSON-safe`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(item, `${path}[${i}]`));
    return;
  }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) fail(`${path}.${k}`, 'undefined is not allowed; leave the key out');
      assertJsonSafe(v, `${path}.${k}`);
    }
    return;
  }
  fail(path, `${value === undefined ? 'undefined' : typeof value === 'object' ? 'a non-plain object' : typeof value} is not JSON-safe`);
}

function keys(raw: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (!isObj(raw)) return fail(path, 'expected an object');
  for (const k of required) if (!Object.hasOwn(raw, k)) fail(`${path}.${k}`, 'missing');
  for (const k of Object.keys(raw)) if (!required.includes(k) && !optional.includes(k)) fail(`${path}.${k}`, 'unknown key');
  return raw;
}

function str(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fail(path, 'expected a non-empty string');
  return raw;
}
function int(raw: unknown, path: string, min: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) return fail(path, `expected a whole number of ${min} or more`);
  return raw;
}
function finite(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(path, 'expected a finite number');
  return raw;
}
function oneOf<T extends string>(raw: unknown, path: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return fail(path, `expected one of ${allowed.map(a => JSON.stringify(a)).join(', ')}`);
  }
  return raw as T;
}
function isoTime(raw: unknown, path: string): string {
  const text = str(raw, path);
  if (!ISO_TIME.test(text)) return fail(path, 'not an ISO instant (YYYY-MM-DDTHH:MM:SS.sssZ)');
  return text;
}
function swimCloudId(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !SWIMCLOUD_ID.test(raw)) return fail(path, 'not a SwimCloud id (a string of digits, no leading zero)');
  return raw;
}
function list(raw: unknown, path: string): unknown[] {
  if (!Array.isArray(raw)) return fail(path, 'expected a list');
  return raw;
}
function gender(raw: unknown, path: string): void {
  oneOf(raw, path, ['Men', 'Women'] as const);
}
function rev(raw: unknown, path: string): void {
  int(raw, path, 1);
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

function origin(raw: unknown, path: string): void {
  if (!isObj(raw)) return fail(path, 'expected an object');
  if (raw.kind === 'local') {
    keys(raw, path, ['kind']);
    return;
  }
  if (raw.kind === 'imported') {
    const o = keys(raw, path, ['kind', 'fileName', 'importedAt', 'exportedAt']);
    str(o.fileName, `${path}.fileName`);
    isoTime(o.importedAt, `${path}.importedAt`);
    isoTime(o.exportedAt, `${path}.exportedAt`);
    return;
  }
  fail(`${path}.kind`, 'expected "local" or "imported"');
}

function presetRef(raw: unknown, path: string): void {
  if (!isObj(raw)) return fail(path, 'expected an object');
  if (raw.kind === 'builtin') {
    const o = keys(raw, path, ['kind', 'id', 'version']);
    str(o.id, `${path}.id`);
    int(o.version, `${path}.version`, 1);
    return;
  }
  if (raw.kind === 'user') {
    const o = keys(raw, path, ['kind', 'id']);
    str(o.id, `${path}.id`);
    return;
  }
  fail(`${path}.kind`, 'expected "builtin" or "user"');
}

function derivedFrom(raw: unknown, path: string): void {
  const o = keys(raw, path, ['builtinId', 'builtinVersion']);
  str(o.builtinId, `${path}.builtinId`);
  int(o.builtinVersion, `${path}.builtinVersion`, 1);
}

function payloadVersion(raw: unknown, path: string): void {
  if (raw !== PAYLOAD_VERSION) fail(path, `expected ${PAYLOAD_VERSION} (the only payload version this build reads)`);
}

/** Run an engine parser and turn its `RulePresetError` into a path under `base`. */
function viaEngine<T>(base: string, run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof RulePresetError) {
      const rel = e.path.replace(/^preset\.?/, '');
      return fail(rel === '' ? base : `${base}.${rel}`, `${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/**
 * Every `provenance` in the value (and each `previous` link of a `user-edited` chain) must not be
 * `legacy`, every `published` source must be in a bundled manifest, and every `tool-derived` archive
 * must be one a built-in sourcing preset cites, with the same sha256.
 */
function checkProvenanceSources(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkProvenanceSources(item, `${path}[${i}]`));
    return;
  }
  if (!isObj(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'provenance') checkChain(v, `${path}.${k}`);
    else checkProvenanceSources(v, `${path}.${k}`);
  }
}
function checkChain(prov: unknown, path: string): void {
  if (!isObj(prov)) return;
  if (prov.kind === 'legacy') fail(path, 'provenance kind "legacy" is banned');
  if (prov.kind === 'published' && isObj(prov.source)) {
    const problem = publishedSourceProblem(prov.source as never);
    if (problem) fail(`${path}.source`, problem);
  }
  if (prov.kind === 'tool-derived') {
    const archive = prov.archive;
    if (!isObj(archive) || typeof archive.path !== 'string' || typeof archive.sha256 !== 'string') {
      fail(`${path}.archive`, 'a tool-derived value must cite its archive path and sha256');
    } else {
      const problem = toolArchiveProblem({ path: archive.path, sha256: archive.sha256 });
      if (problem) fail(`${path}.archive`, problem);
    }
  }
  if (prov.kind === 'user-edited') checkChain(prov.previous, `${path}.previous`);
}

function rulePresetPayload(raw: unknown, path: string): RulePreset {
  // The raw input is checked first and the engine parser second, so neither check is the only guard against "legacy".
  checkProvenanceSources(raw, path);
  return viaEngine(path, () => parseRulePreset(raw));
}

/* -------------------------------------------------------------------------- */
/* SessionPreset (interim shape check, see the file header)                   */
/* -------------------------------------------------------------------------- */

export function validateSessionPreset(raw: unknown, path: string): SessionPreset {
  const parsed = viaEngine(path, () => parseSessionPreset(raw));
  checkProvenanceSources(parsed, path);
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Lineup (interim shape check, see the file header)                          */
/* -------------------------------------------------------------------------- */

function legBasis(raw: unknown, path: string): void {
  if (!isObj(raw)) return fail(path, 'expected an object');
  if (raw.kind === 'split') str(keys(raw, path, ['kind', 'splitId']).splitId, `${path}.splitId`);
  else if (raw.kind === 'flat-start-swim' || raw.kind === 'flyover-estimate') str(keys(raw, path, ['kind', 'swimId']).swimId, `${path}.swimId`);
  else if (raw.kind === 'no-time') keys(raw, path, ['kind']);
  else fail(`${path}.kind`, 'expected "split", "flat-start-swim", "flyover-estimate" or "no-time"');
}

function lineupEntry(raw: unknown, path: string): void {
  if (!isObj(raw)) return fail(path, 'expected an object');
  if (raw.kind === 'individual') {
    const o = keys(raw, path, ['kind', 'teamId', 'swimmerId', 'eventKey', 'gender', 'seedSwimId']);
    // The same id rule as tags, rosters and meets: '0123' and 123 are different ids from '123'.
    swimCloudId(o.teamId, `${path}.teamId`);
    swimCloudId(o.swimmerId, `${path}.swimmerId`);
    str(o.eventKey, `${path}.eventKey`);
    gender(o.gender, `${path}.gender`);
    if (o.seedSwimId !== null) str(o.seedSwimId, `${path}.seedSwimId`);
  } else if (raw.kind === 'relay') {
    const o = keys(raw, path, ['kind', 'teamId', 'eventKey', 'gender', 'letter', 'legs']);
    swimCloudId(o.teamId, `${path}.teamId`);
    str(o.eventKey, `${path}.eventKey`);
    gender(o.gender, `${path}.gender`);
    str(o.letter, `${path}.letter`);
    const legs = list(o.legs, `${path}.legs`);
    if (legs.length !== 4) fail(`${path}.legs`, `expected 4 legs, got ${legs.length}`);
    legs.forEach((leg, i) => {
      const l = keys(leg, `${path}.legs[${i}]`, ['swimmerId', 'basis']);
      swimCloudId(l.swimmerId, `${path}.legs[${i}].swimmerId`);
      legBasis(l.basis, `${path}.legs[${i}].basis`);
    });
  } else {
    fail(`${path}.kind`, 'expected "individual" or "relay"');
  }
}

function nameMap(raw: unknown, path: string): void {
  if (!isObj(raw)) return fail(path, 'expected an object');
  for (const [id, v] of Object.entries(raw)) str(keys(v, `${path}.${id}`, ['name']).name, `${path}.${id}.name`);
}

function lineupDisplay(raw: unknown, path: string): void {
  const o = keys(raw, path, ['swimmers', 'teams', 'entryTimes']);
  nameMap(o.swimmers, `${path}.swimmers`);
  nameMap(o.teams, `${path}.teams`);
  if (!isObj(o.entryTimes)) return fail(`${path}.entryTimes`, 'expected an object');
  for (const [k, v] of Object.entries(o.entryTimes)) {
    const p = `${path}.entryTimes[${JSON.stringify(k)}]`;
    const t = keys(v, p, ['text', 'hundredths']);
    str(t.text, `${p}.text`);
    int(t.hundredths, `${p}.hundredths`, 0);
    let parsed: { hundredths: number } | null;
    try {
      parsed = parseTimeText(t.text as string);
    } catch {
      return fail(`${p}.text`, 'not a time');
    }
    if (parsed === null || parsed.hundredths !== t.hundredths) fail(p, 'text and hundredths disagree');
  }
}

export function validateLineup(raw: unknown, path: string): void {
  const o = keys(raw, path, ['payloadVersion', 'meetKey', 'entries'], ['display']);
  payloadVersion(o.payloadVersion, `${path}.payloadVersion`);
  str(o.meetKey, `${path}.meetKey`);
  list(o.entries, `${path}.entries`).forEach((e, i) => lineupEntry(e, `${path}.entries[${i}]`));
  if (o.display !== undefined) lineupDisplay(o.display, `${path}.display`);
}

/* -------------------------------------------------------------------------- */
/* Per-store records                                                          */
/* -------------------------------------------------------------------------- */

const SETTING_VALUES: { readonly [K in keyof SettingsMap]: (v: unknown, path: string) => void } = {
  theme: (v, p) => void oneOf(v, p, ['light', 'dark', 'system'] as const),
  accent: (v, p) => void str(v, p),
  cutCloseThresholdPct: (v, p) => {
    if (finite(v, p) < 0) fail(p, 'a threshold cannot be negative');
  },
  // No bound: no source states a range for the flyover allowance (R14).
  flyoverAllowanceSec: (v, p) => void finite(v, p),
  fetchPosture: (v, p) => void oneOf(v, p, ['off', 'on-click'] as const),
  scorerOwnTeamsByMeet: (v, p) => {
    const map = isObj(v) ? v : fail(p, 'expected an object keyed by meet key');
    for (const [meetKey, teamId] of Object.entries(map)) {
      str(meetKey, `${p} key`);
      swimCloudId(teamId, `${p}.${meetKey}`);
    }
  },
  scorerRulePresetsByMeet: (v, p) => {
    const map = isObj(v) ? v : fail(p, 'expected an object keyed by meet key');
    for (const [meetKey, ref] of Object.entries(map)) { str(meetKey, `${p} key`); presetRef(ref, `${p}.${meetKey}`); }
  },
  sessionPresetsByMeet: (v, p) => {
    const map = isObj(v) ? v : fail(p, 'expected an object keyed by meet key');
    for (const [meetKey, ref] of Object.entries(map)) { str(meetKey, `${p} key`); presetRef(ref, `${p}.${meetKey}`); }
  },
  sessionLoadPreferencesByMeet: (v, p) => {
    const map = isObj(v) ? v : fail(p, 'expected an object keyed by meet key');
    for (const [meetKey, preference] of Object.entries(map)) {
      str(meetKey, `${p} key`);
      try { parseLoadPreference(preference); } catch (error) { fail(`${p}.${meetKey}`, error instanceof Error ? error.message : String(error)); }
    }
  },
};

function parserInfo(raw: unknown, path: string, withWarnings: boolean): void {
  const p = withWarnings ? keys(raw, path, ['name', 'confidence', 'warnings']) : keys(raw, path, ['name', 'confidence']);
  str(p.name, `${path}.name`);
  str(p.confidence, `${path}.confidence`);
  if (withWarnings) list(p.warnings, `${path}.warnings`).forEach((w, i) => str(w, `${path}.warnings[${i}]`));
}

const RECORD_CHECKS: { readonly [S in UserStore]: (raw: unknown, path: string) => void } = {
  settings(raw, path) {
    const o = keys(raw, path, ['key', 'value', 'rev', 'updatedAt']);
    const key = oneOf(o.key, `${path}.key`, Object.keys(SETTING_VALUES) as (keyof SettingsMap)[]);
    SETTING_VALUES[key](o.value, `${path}.value`);
    rev(o.rev, `${path}.rev`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
  },
  rulePresets(raw, path) {
    const o = keys(raw, path, ['id', 'name', 'payloadVersion', 'payload', 'rev', 'createdAt', 'updatedAt', 'origin'], ['derivedFrom']);
    str(o.id, `${path}.id`);
    str(o.name, `${path}.name`);
    payloadVersion(o.payloadVersion, `${path}.payloadVersion`);
    rulePresetPayload(o.payload, `${path}.payload`);
    rev(o.rev, `${path}.rev`);
    isoTime(o.createdAt, `${path}.createdAt`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
    origin(o.origin, `${path}.origin`);
    if (o.derivedFrom !== undefined) derivedFrom(o.derivedFrom, `${path}.derivedFrom`);
  },
  sessionPresets(raw, path) {
    const o = keys(raw, path, ['id', 'name', 'payloadVersion', 'payload', 'rev', 'createdAt', 'updatedAt', 'origin'], ['derivedFrom']);
    str(o.id, `${path}.id`);
    str(o.name, `${path}.name`);
    payloadVersion(o.payloadVersion, `${path}.payloadVersion`);
    validateSessionPreset(o.payload, `${path}.payload`);
    rev(o.rev, `${path}.rev`);
    isoTime(o.createdAt, `${path}.createdAt`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
    origin(o.origin, `${path}.origin`);
    if (o.derivedFrom !== undefined) derivedFrom(o.derivedFrom, `${path}.derivedFrom`);
  },
  meets(raw, path) {
    const o = keys(
      raw,
      path,
      ['meetKey', 'name', 'gender', 'teamIds', 'rulePreset', 'origin', 'rev', 'createdAt', 'updatedAt'],
      ['simulatorQuery', 'sessionPreset', 'status']
    );
    str(o.meetKey, `${path}.meetKey`);
    str(o.name, `${path}.name`);
    gender(o.gender, `${path}.gender`);
    // R54: no teams if and only if status is 'draft'. Any other status, and a draft with teams, is refused.
    if (o.status !== undefined && o.status !== 'draft') fail(`${path}.status`, 'expected "draft"; leave the key out for a meet with teams');
    const teams = list(o.teamIds, `${path}.teamIds`);
    if (o.status === 'draft') {
      if (teams.length > 0) fail(`${path}.status`, 'a draft has no teams; leave status out once the meet has teams');
    } else if (teams.length === 0) {
      fail(`${path}.teamIds`, 'a meet with no teams must be saved as a draft (status: "draft")');
    }
    teams.forEach((t, i) => swimCloudId(t, `${path}.teamIds[${i}]`));
    if (o.simulatorQuery !== undefined) str(o.simulatorQuery, `${path}.simulatorQuery`);
    presetRef(o.rulePreset, `${path}.rulePreset`);
    if (o.sessionPreset !== undefined) presetRef(o.sessionPreset, `${path}.sessionPreset`);
    origin(o.origin, `${path}.origin`);
    rev(o.rev, `${path}.rev`);
    isoTime(o.createdAt, `${path}.createdAt`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
  },
  tags(raw, path) {
    const o = keys(raw, path, ['meetKey', 'teamId', 'swimmerId', 'role', 'rev', 'updatedAt']);
    str(o.meetKey, `${path}.meetKey`);
    swimCloudId(o.teamId, `${path}.teamId`);
    swimCloudId(o.swimmerId, `${path}.swimmerId`);
    // No 'auto': auto is the absence of a record.
    oneOf(o.role, `${path}.role`, ['scorer', 'non-scorer', 'exhibition'] as const);
    rev(o.rev, `${path}.rev`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
  },
  lineups(raw, path) {
    const o = keys(
      raw,
      path,
      ['lineupId', 'meetKey', 'name', 'kind', 'payloadVersion', 'payload', 'builtUnder', 'origin', 'rev', 'createdAt', 'updatedAt'],
      ['parentLineupId', 'results']
    );
    str(o.lineupId, `${path}.lineupId`);
    str(o.meetKey, `${path}.meetKey`);
    str(o.name, `${path}.name`);
    const kind = oneOf(o.kind, `${path}.kind`, ['lineup', 'snapshot'] as const);
    payloadVersion(o.payloadVersion, `${path}.payloadVersion`);
    validateLineup(o.payload, `${path}.payload`);
    if ((o.payload as Obj).meetKey !== o.meetKey) fail(`${path}.payload.meetKey`, 'differs from the record meetKey');
    if (o.parentLineupId !== undefined) str(o.parentLineupId, `${path}.parentLineupId`);
    if (o.results !== undefined) {
      if (kind !== 'snapshot') fail(`${path}.results`, 'only a snapshot holds results');
      if (o.results === null) fail(`${path}.results`, 'null results; leave the key out when there are none');
    }
    const b = keys(
      o.builtUnder,
      `${path}.builtUnder`,
      ['rulePreset', 'rulePresetValues'],
      ['rulePresetRev', 'sessionPreset', 'sessionPresetRev', 'sessionPresetValues']
    );
    presetRef(b.rulePreset, `${path}.builtUnder.rulePreset`);
    if (b.rulePresetRev !== undefined) rev(b.rulePresetRev, `${path}.builtUnder.rulePresetRev`);
    rulePresetPayload(b.rulePresetValues, `${path}.builtUnder.rulePresetValues`);
    if (b.sessionPreset !== undefined) presetRef(b.sessionPreset, `${path}.builtUnder.sessionPreset`);
    if (b.sessionPresetRev !== undefined) rev(b.sessionPresetRev, `${path}.builtUnder.sessionPresetRev`);
    if (b.sessionPresetValues !== undefined) validateSessionPreset(b.sessionPresetValues, `${path}.builtUnder.sessionPresetValues`);
    origin(o.origin, `${path}.origin`);
    rev(o.rev, `${path}.rev`);
    isoTime(o.createdAt, `${path}.createdAt`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
  },
  swimmerHistory(raw, path) {
    const o = keys(raw, path, ['swimmerId', 'payloadVersion', 'payload', 'fetchedAt', 'sourceUrl', 'parser']);
    swimCloudId(o.swimmerId, `${path}.swimmerId`);
    int(o.payloadVersion, `${path}.payloadVersion`, 1);
    // Absent is not empty (D3 5.4): a failed fetch writes nothing, so an empty payload is never valid.
    const p = o.payload;
    if (p === null || (Array.isArray(p) && p.length === 0) || (isObj(p) && Object.keys(p).length === 0)) {
      fail(`${path}.payload`, 'an empty history payload; write nothing when the fetch failed');
    }
    isoTime(o.fetchedAt, `${path}.fetchedAt`);
    str(o.sourceUrl, `${path}.sourceUrl`);
    parserInfo(o.parser, `${path}.parser`, true);
  },
  classYearOverrides(raw, path) {
    const o = keys(raw, path, ['swimmerId', 'seasonId', 'classYear', 'origin', 'rev', 'createdAt', 'updatedAt']);
    swimCloudId(o.swimmerId, `${path}.swimmerId`);
    str(o.seasonId, `${path}.seasonId`);
    // No null: a user clears an override by deleting the record (tags work the same way).
    oneOf(o.classYear, `${path}.classYear`, CLASS_YEARS);
    origin(o.origin, `${path}.origin`);
    rev(o.rev, `${path}.rev`);
    isoTime(o.createdAt, `${path}.createdAt`);
    isoTime(o.updatedAt, `${path}.updatedAt`);
  },
  rosters(raw, path) {
    const o = keys(raw, path, ['teamId', 'seasonId', 'gender', 'memberIds', 'sourceUrl', 'fetchedAt', 'parser'], ['verifiedEmpty', 'classYears']);
    swimCloudId(o.teamId, `${path}.teamId`);
    str(o.seasonId, `${path}.seasonId`);
    gender(o.gender, `${path}.gender`);
    const members = list(o.memberIds, `${path}.memberIds`);
    members.forEach((m, i) => swimCloudId(m, `${path}.memberIds[${i}]`));
    // Absent is not empty (D3 5.4): a season never fetched has no row. R53: a fetched roster with no members is
    // stored only as verified-empty, so `memberIds: []` without the mark (a parser that found nothing) is refused.
    if (o.verifiedEmpty !== undefined) {
      if (o.verifiedEmpty !== true) fail(`${path}.verifiedEmpty`, 'expected true; leave the key out for a roster with members');
      if (members.length > 0) fail(`${path}.verifiedEmpty`, 'a roster with members is not verified-empty');
    } else if (members.length === 0) {
      fail(`${path}.memberIds`, 'an empty roster must be marked verifiedEmpty: true; write nothing when the season was not fetched');
    }
    if (o.classYears !== undefined) {
      const map = o.classYears;
      if (!isObj(map) || Object.keys(map).length === 0) return fail(`${path}.classYears`, 'expected an object with an entry; leave the key out when SwimCloud gave no class years');
      for (const [id, code] of Object.entries(map)) {
        const p = `${path}.classYears.${id}`;
        swimCloudId(id, p);
        if (!members.includes(id)) fail(p, 'not a member of this roster');
        oneOf(code, p, CLASS_YEARS);
      }
    }
    str(o.sourceUrl, `${path}.sourceUrl`);
    isoTime(o.fetchedAt, `${path}.fetchedAt`);
    parserInfo(o.parser, `${path}.parser`, false);
  },
};

/**
 * Every problem in one record, as JSON paths under `path`. An empty list means valid. The first
 * failing check ends the record, so a record yields at most one issue.
 */
export function validateRecord(store: UserStore, raw: unknown, path = '$'): ValidationIssue[] {
  // `meta` and any other name have no record check. Own-property test: 'toString' is not a store.
  if (!Object.hasOwn(RECORD_CHECKS, store)) return [{ path, message: `"${String(store)}" is not a user store` }];
  try {
    assertJsonSafe(raw, path);
    RECORD_CHECKS[store](raw, path);
    return [];
  } catch (e) {
    if (e instanceof Fail) return [{ path: e.path, message: e.message }];
    throw e;
  }
}

/** Throws `InvalidRecordError` (broker code `invalid`) when the record is not valid. */
export function assertValidRecord(store: UserStore, raw: unknown): void {
  const issues = validateRecord(store, raw);
  if (issues.length > 0) throw new InvalidRecordError(store, issues);
}
