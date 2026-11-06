/** Session preset parser (D2 3.11). */
import { RulePresetError } from '../rules/cap';
import { expectKeys, expectString, parseProvenance, parseSetting, isRecord } from '../model/provenance';
import type { EventFormat, ScheduledEvent, SessionPreset, SessionRef, SessionSlot } from './types';

const SLOTS: readonly SessionSlot[] = ['morning', 'afternoon', 'evening'];
const GENDERS = ['Men', 'Women', 'both'] as const;

function parseSession(raw: unknown, path: string): SessionRef {
  const obj = expectKeys(raw, path, ['day', 'slot']);
  if (typeof obj.day !== 'number' || !Number.isInteger(obj.day) || obj.day < 1) {
    throw new RulePresetError(`${path}.day`, 'invalid', `${path}.day: expected an integer of 1 or more`);
  }
  if (!SLOTS.includes(obj.slot as SessionSlot)) throw new RulePresetError(`${path}.slot`, 'invalid', `${path}.slot: invalid session slot`);
  return { day: obj.day, slot: obj.slot as SessionSlot };
}

function sessionOrder(s: SessionRef): number { return s.day * 3 + SLOTS.indexOf(s.slot); }

function parseFormat(raw: unknown, path: string): EventFormat {
  if (!isRecord(raw)) throw new RulePresetError(path, 'invalid', `${path}: expected an object`);
  if (raw.kind === 'timed-final') {
    const x = expectKeys(raw, path, ['kind', 'session']);
    return { kind: 'timed-final', session: parseSession(x.session, `${path}.session`) };
  }
  if (raw.kind === 'prelims-finals') {
    const x = expectKeys(raw, path, ['kind', 'prelims', 'finals']);
    const prelims = parseSession(x.prelims, `${path}.prelims`);
    const finals = parseSession(x.finals, `${path}.finals`);
    if (sessionOrder(finals) <= sessionOrder(prelims)) throw new RulePresetError(`${path}.finals`, 'invalid', `${path}.finals: must be strictly after prelims`);
    return { kind: 'prelims-finals', prelims, finals };
  }
  if (raw.kind === 'timed-final-split') {
    const x = expectKeys(raw, path, ['kind', 'slowHeats', 'fastHeat', 'fastHeatSize', 'smallFieldSession']);
    const fastHeatSize = parseSetting(x.fastHeatSize, `${path}.fastHeatSize`, (v, p) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new RulePresetError(p, 'invalid', `${p}: expected a positive integer`);
      return v;
    });
    const smallFieldSession = parseSetting(x.smallFieldSession, `${path}.smallFieldSession`, parseSession);
    return { kind: 'timed-final-split', slowHeats: parseSession(x.slowHeats, `${path}.slowHeats`), fastHeat: parseSession(x.fastHeat, `${path}.fastHeat`), fastHeatSize, smallFieldSession };
  }
  throw new RulePresetError(`${path}.kind`, 'invalid', `${path}.kind: unsupported event format`);
}

function parseEvent(raw: unknown, path: string): ScheduledEvent {
  const x = expectKeys(raw, path, ['eventKey', 'gender', 'format']);
  const eventKey = expectString(x.eventKey, `${path}.eventKey`);
  if (!GENDERS.includes(x.gender as typeof GENDERS[number])) throw new RulePresetError(`${path}.gender`, 'invalid', `${path}.gender: expected Men, Women or both`);
  return { eventKey, gender: x.gender as ScheduledEvent['gender'], format: parseFormat(x.format, `${path}.format`) };
}

function scheduleSessions(e: ScheduledEvent): SessionRef[] {
  const f = e.format;
  return f.kind === 'timed-final' ? [f.session] : f.kind === 'prelims-finals' ? [f.prelims, f.finals] : [f.slowHeats, f.fastHeat];
}

export function parseSessionPreset(json: unknown): SessionPreset {
  const x = expectKeys(json, 'sessionPreset', ['payloadVersion', 'provenance', 'events']);
  if (x.payloadVersion !== 1) throw new RulePresetError('sessionPreset.payloadVersion', 'unsupported_version', 'sessionPreset.payloadVersion: expected 1');
  if (!Array.isArray(x.events)) throw new RulePresetError('sessionPreset.events', 'invalid', 'sessionPreset.events: expected a list');
  const events = x.events.map((e, i) => parseEvent(e, `sessionPreset.events[${i}]`));
  const seen = new Set<string>();
  for (const e of events) {
    for (const g of e.gender === 'both' ? GENDERS.slice(0, 2) : [e.gender]) {
      const key = `${e.eventKey}\u0000${g}`;
      if (seen.has(key)) throw new RulePresetError('sessionPreset.events', 'invalid', `sessionPreset.events: duplicate schedule key ${e.eventKey}/${g}`);
      seen.add(key);
    }
    const refs = scheduleSessions(e);
    // Even split formats require morning slow heats before evening fast heats.
    if (e.format.kind === 'timed-final-split' && sessionOrder(e.format.fastHeat) <= sessionOrder(e.format.slowHeats)) {
      throw new RulePresetError('sessionPreset.events', 'invalid', 'timed-final-split fastHeat must be after slowHeats');
    }
    void refs;
  }
  return { payloadVersion: 1, provenance: parseProvenance(x.provenance, 'sessionPreset.provenance'), events };
}
