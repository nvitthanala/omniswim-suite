/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client for the scoring-preset API on `apps/shell/server.ts`.
 *
 * Every read falls back to the built-in presets compiled into this package, so a
 * workspace opened with no server still lists and applies the rule sets the app
 * ships. Writes have no offline fallback — a preset the server never stored does
 * not exist, and pretending otherwise would lose a coach's rule set silently.
 */

import { ScoringPresetMeta, ScoringSettings } from '../types';
import {
  BUILT_IN_SCORING_PRESETS,
  HostPublishedTableRequiredError,
  builtInScoringPresetMeta,
  isBuiltInScoringPresetId,
  setUserConferencePresetBindings,
  settingsForBuiltInScoringPreset,
  settingsFromPresetPayload,
} from './scoringDefaults';

/** The body `createScoringPreset` and `updateScoringPreset` send. */
export interface ScoringPresetWriteInput {
  /** Required on create; on update the URL id wins and this must match it if sent. */
  id?: string;
  label: string;
  description?: string;
  /** Conference-name substrings that should select this preset. Matched case-insensitively. */
  conferenceMatches?: string[];
  settings: ScoringSettings;
}

/** One field the server refused, and why. */
export interface ScoringPresetFieldError {
  path: string;
  message: string;
}

/** A write the server rejected. `details` names the offending fields when validation failed. */
export class ScoringPresetApiError extends Error {
  readonly status: number;
  readonly details: ScoringPresetFieldError[];
  constructor(status: number, message: string, details: ScoringPresetFieldError[] = []) {
    super(message);
    this.name = 'ScoringPresetApiError';
    this.status = status;
    this.details = details;
  }
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  let details: ScoringPresetFieldError[] = [];
  try {
    const body = (await res.json()) as { error?: string; details?: ScoringPresetFieldError[] };
    if (typeof body?.error === 'string' && body.error) message = body.error;
    if (Array.isArray(body?.details)) details = body.details;
  } catch {
    // A non-JSON body means the server failed before it could explain itself.
  }
  throw new ScoringPresetApiError(res.status, message, details);
}

/**
 * Every preset the app can apply: the built-ins, then whatever the server has
 * saved.
 *
 * Side effect, deliberate and documented: the saved presets' `conferenceMatches`
 * are registered with `presetIdForConference` on the way through. That lookup is
 * synchronous and is called from components that never touch this module, so
 * registering here is the only point at which a user-declared conference rule
 * can reach it without every caller learning about the registry. Built-in
 * bindings are still matched first, so a saved preset can add a conference but
 * never capture one the app already claims.
 */
export async function fetchScoringPresetList(): Promise<ScoringPresetMeta[]> {
  try {
    const res = await fetch('/api/scoring-presets');
    if (!res.ok) throw new Error('list failed');
    const list = (await res.json()) as ScoringPresetMeta[];
    setUserConferencePresetBindings(list.filter(p => !p.builtIn));
    return list;
  } catch {
    return builtInScoringPresetMeta();
  }
}

/**
 * Settings for one preset.
 *
 * Throws {@link HostPublishedTableRequiredError} for a format the NCAA publishes
 * no table for (Rule 7-4's invitational meets) rather than handing back a
 * default nobody sourced — a caller must offer the host's table instead.
 */
export async function fetchScoringPresetSettings(presetId: string): Promise<ScoringSettings> {
  const builtIn = isBuiltInScoringPresetId(presetId);
  if (builtIn) {
    const preset = BUILT_IN_SCORING_PRESETS.find(p => p.id === presetId);
    // Fail before the round trip: the server has no table for this either.
    if (preset && !preset.settings) return settingsForBuiltInScoringPreset(presetId);
  }
  try {
    const res = await fetch(`/api/scoring-presets/${encodeURIComponent(presetId)}`);
    if (!res.ok) {
      if (builtIn) return settingsForBuiltInScoringPreset(presetId);
      throw new Error('not found');
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return settingsFromPresetPayload(raw);
  } catch (err) {
    if (err instanceof HostPublishedTableRequiredError) throw err;
    if (builtIn) return settingsForBuiltInScoringPreset(presetId);
    throw new Error(`Unknown preset: ${presetId}`);
  }
}

export async function createScoringPreset(
  input: ScoringPresetWriteInput
): Promise<ScoringPresetMeta> {
  const res = await fetch('/api/scoring-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await throwApiError(res, 'Could not create the scoring preset.');
  return (await res.json()) as ScoringPresetMeta;
}

export async function updateScoringPreset(
  id: string,
  input: ScoringPresetWriteInput
): Promise<ScoringPresetMeta> {
  const res = await fetch(`/api/scoring-presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await throwApiError(res, 'Could not save the scoring preset.');
  return (await res.json()) as ScoringPresetMeta;
}

export async function deleteScoringPreset(id: string): Promise<void> {
  const res = await fetch(`/api/scoring-presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) await throwApiError(res, 'Could not delete the scoring preset.');
}
