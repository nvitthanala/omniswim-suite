/** Per-meet coach choice stored as a settings row; a missing key means no team was chosen. */
import { StaleWriteError } from './errors';
import type { StorageRepo } from './repo';
import type { SwimCloudId } from './schema';

const SETTING_KEY = 'scorerOwnTeamsByMeet';

export async function readScorerOwnTeam(repo: StorageRepo, meetKey: string): Promise<SwimCloudId | undefined> {
  const row = await repo.get('settings', SETTING_KEY);
  const map = row.found ? row.value.value as Readonly<Record<string, SwimCloudId>> : undefined;
  return map?.[meetKey];
}

/** Optimistically merges one meet choice into the map, retrying when another tab updated it. */
export async function saveScorerOwnTeam(repo: StorageRepo, meetKey: string, teamId: SwimCloudId): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repo.get('settings', SETTING_KEY);
    const currentMap = current.found ? current.value.value as Readonly<Record<string, SwimCloudId>> : {};
    const value = { ...currentMap, [meetKey]: teamId };
    try {
      await repo.put('settings', { key: SETTING_KEY, value }, current.found ? current.value.rev : 'new');
      return;
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt === 3) throw error;
    }
  }
}
