/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard's own settings (D6 section 5): theme, accent and the rival per meet. They are plain `settings` rows read and written
 * through the repo, with a retry when another surface wrote the same row between the read and the write.
 */
import type { RivalRef } from '@omniswim/engine';
import { createStorageRepo, StaleWriteError } from '../storage';
import type { ChangeBus, SettingsMap, StorageRepo } from '../storage';
import type { IDBPDatabase } from 'idb';
import type { OmniDbSchema } from '../storage';
import { isHexColor } from '../shared/theme';
import type { ThemePreference } from '../shared/theme';
import { closeThresholdFromPercent } from '@omniswim/engine';

export async function readSetting<K extends keyof SettingsMap>(repo: StorageRepo, key: K): Promise<SettingsMap[K] | undefined> {
  const row = await repo.get('settings', key);
  return row.found ? (row.value.value as SettingsMap[K]) : undefined;
}

/** Create or update the row. `change` gets the stored value (or `undefined`) and returns the new one. Retries on a lost race. */
export async function updateSetting<K extends keyof SettingsMap>(repo: StorageRepo, key: K, change: (current: SettingsMap[K] | undefined) => SettingsMap[K]): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repo.get('settings', key);
    const next = change(current.found ? (current.value.value as SettingsMap[K]) : undefined);
    try {
      await repo.put('settings', { key, value: next } as never, current.found ? current.value.rev : 'new');
      return;
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt === 3) throw error;
    }
  }
}

/** Remove the row, so the default applies again. A row that is already gone is not an error. */
export async function clearSetting(repo: StorageRepo, key: keyof SettingsMap): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repo.get('settings', key);
    if (!current.found) return;
    try {
      await repo.delete('settings', key, current.value.rev);
      return;
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt === 3) throw error;
    }
  }
}

export interface ThemeSettings {
  readonly preference: ThemePreference;
  /** `#rrggbb`, or absent for the theme's own accent. */
  readonly accent?: string;
}

/** Light is the default (D3 section 4). A stored accent that is not `#rrggbb` is ignored, never applied. */
export async function readThemeSettings(repo: StorageRepo): Promise<ThemeSettings> {
  const preference = (await readSetting(repo, 'theme')) ?? 'light';
  const accent = await readSetting(repo, 'accent');
  return isHexColor(accent) ? { preference, accent } : { preference };
}

export const saveTheme = (repo: StorageRepo, preference: ThemePreference): Promise<void> => updateSetting(repo, 'theme', () => preference);

/** Only `#rrggbb` is written: the colour picker's own form. Anything else throws, and nothing is stored. */
export async function saveAccent(repo: StorageRepo, hex: string): Promise<void> {
  if (!isHexColor(hex)) throw new RangeError(`The accent must be #rrggbb, not "${hex}".`);
  await updateSetting(repo, 'accent', () => hex);
}

export async function saveCutCloseThreshold(repo: StorageRepo, value: number): Promise<void> {
  closeThresholdFromPercent(value);
  await updateSetting(repo, 'cutCloseThresholdPct', () => value);
}

/**
 * Delete every fetched SwimCloud row (`swimmerHistory` and `rosters`) and return how many. It goes through the repo, so the delete bumps
 * `meta.changeRev` and, with a `bus`, announces both stores to the other contexts. User stores are never touched.
 */
export async function clearFetchedSwimCloudData(db: IDBPDatabase<OmniDbSchema>, options: { readonly bus?: ChangeBus } = {}): Promise<number> {
  return createStorageRepo(db, options.bus === undefined ? {} : { bus: options.bus }).clearCache(['swimmerHistory', 'rosters']);
}

export type StorageEstimateText = { readonly available: false; readonly text: string } | { readonly available: true; readonly text: string };
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) return `${(bytes / gb).toFixed(1)} GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
  return `${(bytes / kb).toFixed(1)} KB`;
}

export async function readStorageEstimate(storage: Pick<StorageManager, 'estimate'> | undefined): Promise<StorageEstimateText> {
  if (!storage?.estimate) return { available: false, text: 'Storage estimate is not available in this browser.' };
  try {
    const { usage, quota } = await storage.estimate();
    return { available: true, text: `Using ${usage === undefined ? 'unavailable' : formatStorageBytes(usage)} of ${quota === undefined ? 'unavailable' : formatStorageBytes(quota)}.` };
  } catch {
    return { available: false, text: 'Storage estimate is unavailable.' };
  }
}

export const clearAccent = (repo: StorageRepo): Promise<void> => clearSetting(repo, 'accent');

export async function readRival(repo: StorageRepo, meetKey: string): Promise<RivalRef | undefined> {
  return (await readSetting(repo, 'rivalsByMeet'))?.[meetKey];
}

/** `undefined` removes the choice for this meet, so the F1 default applies again. */
export function saveRival(repo: StorageRepo, meetKey: string, rival: RivalRef | undefined): Promise<void> {
  return updateSetting(repo, 'rivalsByMeet', (current) => {
    const { [meetKey]: _old, ...rest } = current ?? {};
    return rival === undefined ? rest : { ...rest, [meetKey]: rival };
  });
}
