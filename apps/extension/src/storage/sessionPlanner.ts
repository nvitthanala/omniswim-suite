import { parseSessionPreset } from '@omniswim/engine';
import type { LoadPreference, SessionPreset } from '@omniswim/engine';
import { StaleWriteError } from './errors';
import type { StorageRepo } from './repo';
import type { PresetRef, SessionPresetRecord } from './schema';
import { listSessionPresetChoices, resolveSessionPreset } from './presets';
import { defaultLoadPreference, parseLoadPreference } from './sessionPreference';

const PRESET_KEY = 'sessionPresetsByMeet';
const LOAD_KEY = 'sessionLoadPreferencesByMeet';

async function readMap(repo: StorageRepo, key: 'sessionPresetsByMeet' | 'sessionLoadPreferencesByMeet'): Promise<Readonly<Record<string, unknown>>> {
  const row = await repo.get('settings', key);
  return row.found ? row.value.value as Readonly<Record<string, unknown>> : {};
}

async function writeMeetValue(repo: StorageRepo, key: 'sessionPresetsByMeet' | 'sessionLoadPreferencesByMeet', meetKey: string, value: unknown): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repo.get('settings', key);
    const map = current.found ? current.value.value as Readonly<Record<string, unknown>> : {};
    try {
      await repo.put('settings', { key, value: { ...map, [meetKey]: value } } as never, current.found ? current.value.rev : 'new');
      return;
    } catch (error) { if (!(error instanceof StaleWriteError) || attempt === 3) throw error; }
  }
}

export async function readSessionPresetChoice(repo: StorageRepo, meetKey: string): Promise<PresetRef | undefined> {
  return (await readMap(repo, PRESET_KEY))[meetKey] as PresetRef | undefined;
}

export async function saveSessionPresetChoice(repo: StorageRepo, meetKey: string, ref: PresetRef): Promise<void> {
  if (!(await listSessionPresetChoices(repo)).some(c => JSON.stringify(c.ref) === JSON.stringify(ref))) throw new Error('The selected session preset is not available');
  if (!(await resolveSessionPreset(repo, ref)).found) throw new Error('The selected session preset cannot be resolved');
  await writeMeetValue(repo, PRESET_KEY, meetKey, ref);
}

export async function readSessionPreset(repo: StorageRepo, meetKey: string): Promise<{ ref?: PresetRef; preset?: SessionPreset }> {
  const ref = await readSessionPresetChoice(repo, meetKey);
  if (!ref) return {};
  const result = await resolveSessionPreset(repo, ref);
  return result.found ? { ref, preset: result.value } : { ref };
}

export async function readSessionLoadPreference(repo: StorageRepo, meetKey: string): Promise<LoadPreference> {
  const raw = (await readMap(repo, LOAD_KEY))[meetKey];
  return raw === undefined ? defaultLoadPreference() : parseLoadPreference(raw);
}

export async function saveSessionLoadPreference(repo: StorageRepo, meetKey: string, raw: unknown): Promise<LoadPreference> {
  const preference = parseLoadPreference(raw);
  await writeMeetValue(repo, LOAD_KEY, meetKey, preference);
  return preference;
}

/** Validate first; then update the selected user preset or create a user copy of a built-in. */
export async function saveEditedSessionPreset(
  repo: StorageRepo,
  meetKey: string,
  ref: PresetRef,
  raw: unknown,
  id: () => string = () => crypto.randomUUID()
): Promise<PresetRef> {
  const resolved = await resolveSessionPreset(repo, ref);
  if (!resolved.found) throw new Error('The selected session preset cannot be resolved');
  const base = raw as SessionPreset;
  const edited = parseSessionPreset({ ...base, provenance: { kind: 'user-edited', editedAt: new Date().toISOString(), previous: base.provenance ?? resolved.value.provenance } });
  if (ref.kind === 'user') {
    const current = await repo.get('sessionPresets', ref.id);
    if (!current.found) throw new Error('The selected session preset cannot be resolved');
    await repo.put('sessionPresets', { ...current.value, payloadVersion: 1, payload: edited }, current.value.rev);
    await writeMeetValue(repo, PRESET_KEY, meetKey, ref);
    return ref;
  }
  const builtinChoice = (await listSessionPresetChoices(repo)).find(c => JSON.stringify(c.ref) === JSON.stringify(ref));
  if (!builtinChoice) throw new Error('The selected session preset cannot be resolved');
  const copyId = id();
  const record: Omit<SessionPresetRecord, 'rev' | 'updatedAt'> = {
    id: copyId, name: `${builtinChoice.label} (edited)`, payloadVersion: 1, payload: edited,
    origin: { kind: 'local' }, derivedFrom: { builtinId: ref.id, builtinVersion: ref.version }, createdAt: new Date().toISOString(),
  };
  await repo.put('sessionPresets', record, 'new');
  const copyRef: PresetRef = { kind: 'user', id: copyId };
  await writeMeetValue(repo, PRESET_KEY, meetKey, copyRef);
  return copyRef;
}
