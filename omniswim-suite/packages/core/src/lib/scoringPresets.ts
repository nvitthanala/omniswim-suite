/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ScoringPresetMeta, ScoringSettings } from '../types';
import { SCORING_PRESET_BY_ID, settingsFromPresetPayload } from './scoringDefaults';

export async function fetchScoringPresetList(): Promise<ScoringPresetMeta[]> {
  try {
    const res = await fetch('/api/scoring-presets');
    if (!res.ok) throw new Error('list failed');
    return (await res.json()) as ScoringPresetMeta[];
  } catch {
    return Object.entries(SCORING_PRESET_BY_ID).map(([id]) => ({
      id,
      label: id === 'nsisc' ? 'NSISC' : 'Generic Top 16',
      description: id === 'nsisc' ? '18 meet-wide scorers, diver 1/3, relay pool' : 'Unlimited caps, per-event',
    }));
  }
}

export async function fetchScoringPresetSettings(presetId: string): Promise<ScoringSettings> {
  const local = SCORING_PRESET_BY_ID[presetId];
  try {
    const res = await fetch(`/api/scoring-presets/${encodeURIComponent(presetId)}`);
    if (!res.ok) {
      if (local) return { ...local };
      throw new Error('not found');
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return settingsFromPresetPayload(raw);
  } catch {
    if (local) return { ...local };
    throw new Error(`Unknown preset: ${presetId}`);
  }
}
