import type { LoadPreference, Setting } from '@omniswim/engine';

const R6 = { kind: 'user-stated', statedOn: '2026-10-25', wording: '2 races per session, relays included. Editable per meet.', where: 'plans/2026-10-25/README.md:23', verbatim: false } as const;
const R22 = { kind: 'user-stated', statedOn: '2026-10-25', wording: 'Diving does not count toward the races-per-session preference.', where: 'plans/2026-10-25/README.md:39', verbatim: false } as const;

export function defaultLoadPreference(): Extract<LoadPreference, { mode: 'respect' }> {
  return {
    mode: 'respect',
    maxRacesPerSession: { state: 'set', value: 2, provenance: R6 },
    diving: { state: 'set', value: 'excluded', provenance: R22 },
  };
}

export function pendingPenaltyPreference(): Setting<number> {
  return { state: 'pending', question: 'What penalty should each extra race carry in Prefer mode?', blocks: ['sessionLoad'] };
}

export function userPreference<T>(value: T): Setting<T> {
  return { state: 'set', value, provenance: { kind: 'user-edited', editedAt: new Date().toISOString(), previous: null } };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path}: expected an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: missing`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new Error(`${path}.${key}: unknown key`);
}

function parseSetting<T>(raw: unknown, path: string, parse: (value: unknown, path: string) => T): Setting<T> {
  const s = record(raw, path);
  if (s.state === 'pending') {
    keys(s, path, ['state', 'question', 'blocks']);
    if (typeof s.question !== 'string' || !Array.isArray(s.blocks) || !s.blocks.every(x => typeof x === 'string')) throw new Error(`${path}: invalid pending setting`);
    return s as Setting<T>;
  }
  if (s.state !== 'set') throw new Error(`${path}.state: expected set or pending`);
  keys(s, path, ['state', 'value', 'provenance']);
  if (typeof s.provenance !== 'object' || s.provenance === null) throw new Error(`${path}.provenance: expected an object`);
  return { state: 'set', value: parse(s.value, `${path}.value`), provenance: s.provenance } as Setting<T>;
}

export function parseLoadPreference(raw: unknown): LoadPreference {
  const value = record(raw, 'loadPreference');
  if (value.mode === 'off') { keys(value, 'loadPreference', ['mode']); return { mode: 'off' }; }
  if (value.mode !== 'respect' && value.mode !== 'prefer') throw new Error('loadPreference.mode: expected respect, prefer or off');
  keys(value, 'loadPreference', ['mode', 'maxRacesPerSession', 'diving'], value.mode === 'prefer' ? ['penaltyPointsPerExtraRace'] : []);
  const maxRacesPerSession = parseSetting(value.maxRacesPerSession, 'loadPreference.maxRacesPerSession', (v, p) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${p}: expected a positive integer`);
    return v;
  });
  const diving = parseSetting(value.diving, 'loadPreference.diving', (v, p) => {
    if (v !== 'counts' && v !== 'excluded') throw new Error(`${p}: expected counts or excluded`);
    return v;
  });
  if (value.mode === 'respect') return { mode: 'respect', maxRacesPerSession, diving };
  if (!Object.hasOwn(value, 'penaltyPointsPerExtraRace')) throw new Error('loadPreference.penaltyPointsPerExtraRace: missing');
  const penaltyPointsPerExtraRace = parseSetting(value.penaltyPointsPerExtraRace, 'loadPreference.penaltyPointsPerExtraRace', (v, p) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${p}: expected a non-negative finite number`);
    return v;
  });
  return { mode: 'prefer', maxRacesPerSession, diving, penaltyPointsPerExtraRace };
}
