/** Explicit OmniSwim rule choice for a simulator meet. Missing means the coach has not chosen. */
import { StaleWriteError } from './errors';
import type { StorageRepo } from './repo';
import type { PresetRef } from './schema';
import { listRulePresetChoices, resolveRulePreset } from './presets';

const SETTING_KEY = 'scorerRulePresetsByMeet';

export async function readScorerRulePreset(repo: StorageRepo, meetKey: string): Promise<PresetRef | undefined> {
  const row = await repo.get('settings', SETTING_KEY);
  const map = row.found ? row.value.value as Readonly<Record<string, PresetRef>> : undefined;
  return map?.[meetKey];
}

/** Save only a currently listed, resolvable preset choice; merge concurrent meet updates safely. */
export async function saveScorerRulePreset(repo: StorageRepo, meetKey: string, ref: PresetRef): Promise<void> {
  const choices = await listRulePresetChoices(repo);
  if (!choices.some(choice => JSON.stringify(choice.ref) === JSON.stringify(ref))) throw new Error('The selected rule preset is not available');
  if (!(await resolveRulePreset(repo, ref)).found) throw new Error('The selected rule preset cannot be resolved');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repo.get('settings', SETTING_KEY);
    const map = current.found ? current.value.value as Readonly<Record<string, PresetRef>> : {};
    try {
      await repo.put('settings', { key: SETTING_KEY, value: { ...map, [meetKey]: ref } }, current.found ? current.value.rev : 'new');
      return;
    } catch (error) { if (!(error instanceof StaleWriteError) || attempt === 3) throw error; }
  }
}
