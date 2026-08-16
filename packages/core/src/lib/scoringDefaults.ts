/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ScorerAutoRules, ScoringSettings, SwimmerResult } from '../types';
import { SCORING_POINTS } from '../constants';

const TOP16 = [...SCORING_POINTS];

/** Neutral default: configurable unlimited caps, per-event scope. */
export const GENERIC_TOP16_SETTINGS: ScoringSettings = {
  scoringPoints: TOP16,
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'event',
  diverScorerWeight: 1,
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};

/** Optional conference preset (apply via UI or workspace settings). */
export const NSISC_PRESET_SETTINGS: ScoringSettings = {
  scoringPoints: TOP16,
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 2,
  aFinalBracketSize: 8,
  scorerCapScope: 'meet',
  diverScorerWeight: 1 / 3,
  relayEligibleFromScorerPool: false,
  scorerEligibilityMode: 'roster',
  scorerAutoRules: {
    abFinalTiers: ['A', 'B'],
    includeRelayLegsInFinals: true,
    distanceFinalRequired: true,
    distanceEventPattern: ['1000', '1650', '1500'],
  },
  diverEventPattern: ['DIVING', 'DIVE'],
  // NSISC: entry legality is a 7-event total (any ind/relay mix); no per-type caps.
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
  maxTotalEntriesPerSwimmer: 7,
};

export const DEFAULT_SCORER_AUTO_RULES: ScorerAutoRules = {
  abFinalTiers: ['A', 'B'],
  includeRelayLegsInFinals: true,
  distanceFinalRequired: true,
  distanceEventPattern: ['1000', '1650', '1500'],
};

export const DEFAULT_SCORING_SETTINGS: ScoringSettings = GENERIC_TOP16_SETTINGS;

export const SCORING_PRESET_BY_ID: Record<string, ScoringSettings> = {
  'generic-top16': GENERIC_TOP16_SETTINGS,
  nsisc: NSISC_PRESET_SETTINGS,
};

export function presetIdForConference(conference?: string): string | null {
  if (!conference) return null;
  const u = conference.toUpperCase();
  if (u.includes('NSISC')) return 'nsisc';
  if (u.includes('ACC') || u.includes('SEC') || u.includes('BIG 12') || u.includes('BIG12')) {
    return 'generic-top16';
  }
  return null;
}

/** True when enough rows carry `pdfPoints` (HyTek Points column) to trust PDF-place scoring. */
export function resultsHavePdfPlacePoints(results: SwimmerResult[] | undefined): boolean {
  if (!results?.length) return false;
  const nonRecruit = results.filter(r => !r.isRecruit);
  if (!nonRecruit.length) return false;
  const withPdf = nonRecruit.filter(
    r => r.pdfPoints != null && Number.isFinite(Number(r.pdfPoints))
  ).length;
  const threshold = Math.max(8, Math.ceil(nonRecruit.length * 0.01));
  return withPdf >= threshold;
}

export function applyPdfPlacePointsNeutralCaps(settings: ScoringSettings): ScoringSettings {
  return {
    ...settings,
    maxIndividualScorersPerTeam: GENERIC_TOP16_SETTINGS.maxIndividualScorersPerTeam,
    maxRelaysScoringPerTeam: GENERIC_TOP16_SETTINGS.maxRelaysScoringPerTeam,
    scorerCapScope: GENERIC_TOP16_SETTINGS.scorerCapScope,
    diverScorerWeight: GENERIC_TOP16_SETTINGS.diverScorerWeight,
    relayEligibleFromScorerPool: GENERIC_TOP16_SETTINGS.relayEligibleFromScorerPool,
  };
}

export function effectivePdfPlacePointsMode(
  merged: ScoringSettings,
  resultsHint?: SwimmerResult[]
): boolean {
  const flag = merged.usePdfPlacePoints;
  if (flag === false) return false;
  if (flag === true) return true;
  return resultsHavePdfPlacePoints(resultsHint);
}

/** Saved workspaces may have NSISC caps without roster mode (pre-roster saves or partial UI saves). */
export function isNsiscShapedSettings(settings: ScoringSettings): boolean {
  return (
    settings.maxIndividualScorersPerTeam === NSISC_PRESET_SETTINGS.maxIndividualScorersPerTeam &&
    settings.maxRelaysScoringPerTeam === NSISC_PRESET_SETTINGS.maxRelaysScoringPerTeam &&
    settings.scorerCapScope === 'meet' &&
    Math.abs((settings.diverScorerWeight ?? 1) - (NSISC_PRESET_SETTINGS.diverScorerWeight ?? 1)) < 0.01
  );
}

/**
 * Settings that `mergeScoringSettings` overwrites regardless of what the caller
 * passed, and why.
 *
 * These are competition rules, not preferences — a coach must not be able to dial
 * the 18-scorer pool to 999 and produce a fantasy total. The overwrite is
 * deliberate and stays.
 *
 * What was NOT deliberate: both settings UIs rendered these controls as freely
 * editable, so a coach could change a number, save it, and watch the total not
 * move. The value was discarded inside `mergeScoringSettings` before the engine
 * ever saw it. Export the lock so the UI can state it instead of implying the
 * opposite.
 *
 * Keep this list in step with the assignments in `mergeScoringSettings` — a test
 * asserts the two agree.
 */
export const NSISC_LOCKED_SETTING_KEYS = [
  'maxIndividualScorersPerTeam',
  'maxRelaysScoringPerTeam',
  'scorerCapScope',
  'diverScorerWeight',
  'relayEligibleFromScorerPool',
  'maxIndividualEntriesPerSwimmer',
  'maxRelayEntriesPerSwimmer',
  'maxTotalEntriesPerSwimmer',
] as const satisfies readonly (keyof ScoringSettings)[];

/** Settings the PDF place-points regime neutralises. See {@link applyPdfPlacePointsNeutralCaps}. */
export const PDF_PLACE_POINTS_LOCKED_SETTING_KEYS = [
  'scorerEligibilityMode',
  'maxIndividualScorersPerTeam',
  'maxRelaysScoringPerTeam',
  'scorerCapScope',
  'diverScorerWeight',
  'relayEligibleFromScorerPool',
] as const satisfies readonly (keyof ScoringSettings)[];

export type ScoringSettingsLock = {
  /** Field names the engine will overwrite. Empty when the caller's values all stand. */
  keys: readonly (keyof ScoringSettings)[];
  /** Which regime is doing the locking, for the UI to explain. */
  reason: 'nsisc' | 'pdf_place_points' | null;
  /** One sentence a UI can render verbatim. */
  message: string | null;
};

/**
 * Which settings will be ignored for this workspace, and why — so a settings UI
 * can disable them and say so rather than accepting an edit it will discard.
 */
export function scoringSettingsLock(
  settings?: Partial<ScoringSettings>,
  options?: { conference?: string; resultsForPdfHint?: SwimmerResult[] }
): ScoringSettingsLock {
  const merged: ScoringSettings = { ...DEFAULT_SCORING_SETTINGS, ...settings };
  if (effectivePdfPlacePointsMode(merged, options?.resultsForPdfHint)) {
    return {
      keys: PDF_PLACE_POINTS_LOCKED_SETTING_KEYS,
      reason: 'pdf_place_points',
      message:
        'This meet PDF carries its own place points, so the scorer pool settings below are ignored — the published points are used as they stand.',
    };
  }
  if (presetIdForConference(options?.conference) === 'nsisc') {
    return {
      keys: NSISC_LOCKED_SETTING_KEYS,
      reason: 'nsisc',
      message:
        'NSISC fixes these by rule (18-scorer meet-wide pool, 2 scoring relays, 7 entries per swimmer), so they are locked to the conference values.',
    };
  }
  return { keys: [], reason: null, message: null };
}

export function mergeScoringSettings(
  settings?: Partial<ScoringSettings>,
  options?: { conference?: string; resultsForPdfHint?: SwimmerResult[] }
): ScoringSettings {
  const merged: ScoringSettings = { ...DEFAULT_SCORING_SETTINGS, ...settings };
  const pdfLock = effectivePdfPlacePointsMode(merged, options?.resultsForPdfHint);

  if (pdfLock) {
    merged.scorerEligibilityMode = 'points_pool';
    merged.scorerAutoRules = undefined;
    Object.assign(merged, applyPdfPlacePointsNeutralCaps(merged));
  } else {
    const nsiscConference = presetIdForConference(options?.conference) === 'nsisc';
    const shouldUseRoster =
      merged.scorerEligibilityMode === 'roster' ||
      (merged.scorerEligibilityMode !== 'points_pool' &&
        (nsiscConference || isNsiscShapedSettings(merged)));
    if (shouldUseRoster) {
      merged.scorerEligibilityMode = 'roster';
      if (!merged.scorerAutoRules) {
        merged.scorerAutoRules = { ...DEFAULT_SCORER_AUTO_RULES };
      }
    }
    // NSISC meets always use meet-wide 18-scorer caps; stale generic workspace caps must not win.
    if (nsiscConference) {
      merged.maxIndividualScorersPerTeam = NSISC_PRESET_SETTINGS.maxIndividualScorersPerTeam;
      merged.maxRelaysScoringPerTeam = NSISC_PRESET_SETTINGS.maxRelaysScoringPerTeam;
      merged.scorerCapScope = NSISC_PRESET_SETTINGS.scorerCapScope;
      merged.diverScorerWeight = NSISC_PRESET_SETTINGS.diverScorerWeight;
      merged.relayEligibleFromScorerPool = NSISC_PRESET_SETTINGS.relayEligibleFromScorerPool;
      merged.maxIndividualEntriesPerSwimmer = NSISC_PRESET_SETTINGS.maxIndividualEntriesPerSwimmer;
      merged.maxRelayEntriesPerSwimmer = NSISC_PRESET_SETTINGS.maxRelayEntriesPerSwimmer;
      merged.maxTotalEntriesPerSwimmer = NSISC_PRESET_SETTINGS.maxTotalEntriesPerSwimmer;
    }
  }
  return merged;
}

export function settingsFromPresetPayload(raw: Record<string, unknown>): ScoringSettings {
  const { id: _id, label: _label, description: _desc, ...rest } = raw;
  return mergeScoringSettings(rest as Partial<ScoringSettings>);
}
