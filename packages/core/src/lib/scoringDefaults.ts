/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ScorerAutoRules, ScoringPresetMeta, ScoringSettings, SwimmerResult } from '../types';
import { SCORING_POINTS } from '../constants';
import {
  NCAA_FORMAT_RULESETS,
  NCAA_MEET_FORMATS,
  isNcaaHostPublishedTable,
  type NcaaFormatRuleset,
  type NcaaMeetFormat,
  type NcaaPointTable,
} from './ncaaScoringRules';

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

// ---------------------------------------------------------------------------
// Built-in presets, generated from NCAA_FORMAT_RULESETS
// ---------------------------------------------------------------------------

/**
 * A preset the app ships.
 *
 * Every NCAA point value in this module is read out of `NCAA_FORMAT_RULESETS`
 * at module load, never transcribed. That constant is the one place in this repo
 * a Rule 7 number is written down, and it is checked against the archived
 * rulebook PDF by `tests/ncaaScoringRules.test.ts`. Copying a table into a JSON
 * file or into this file would create a second place for it to drift.
 */
export interface BuiltInScoringPreset extends ScoringPresetMeta {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly builtIn: true;
  readonly citation: string;
  readonly group: string;
  readonly meetFormat?: NcaaMeetFormat;
  readonly conferenceMatches?: string[];
  /**
   * Set when the governing body publishes no table for this format. Such a
   * preset carries no `settings`; asking for them throws rather than handing
   * back an invented default. NCAA Rule 7-4 leaves invitational tables to the
   * host institution.
   */
  readonly requiresHostPublishedTable?: true;
  /** Absent exactly when `requiresHostPublishedTable` is true. */
  readonly settings?: ScoringSettings;
}

/** Thrown when a caller asks for point values the governing body does not publish. */
export class HostPublishedTableRequiredError extends Error {
  readonly presetId: string;
  readonly citation: string;
  constructor(presetId: string, citation: string, message: string) {
    super(message);
    this.name = 'HostPublishedTableRequiredError';
    this.presetId = presetId;
    this.citation = citation;
  }
}

/** `ncaa-` + the rulebook format id, so a preset id names the rule it came from. */
export function ncaaPresetId(format: NcaaMeetFormat): string {
  return `ncaa-${format}`;
}

/**
 * Where the A final stops, for a table read by round tier.
 *
 * A `split` format states it (Rules 7-6-3, 7-6-4, 7-6-5). A `single-pool` format
 * contests every place in one field, so the bracket is set past the end of every
 * table the preset carries and a row labelled "B Final" scores nothing —
 * correct, because the format has no consolation final. Taking the *longest*
 * table matters once a preset carries two: a dual meet's 12-place diving table
 * would otherwise start scoring B-final rows that the 6-place swimming table
 * ruled out. Rule 7-6-6 publishes the 24-qualifier tables but *not* the split,
 * and its own remedy is to score the event as a time final, which is one pool:
 * the same answer, and not an invented 12/12 division.
 */
function bracketForFinals(ruleset: NcaaFormatRuleset, longestTable: number): number {
  const finals = ruleset.finals;
  return finals.kind === 'split' ? finals.pools[0].lastPlace : longestTable;
}

function placesOf(table: NcaaPointTable): number[] {
  return [...table.places];
}

/**
 * Base settings shared by every generated NCAA preset.
 *
 * Only the fields Rule 7 actually speaks to are set from the ruleset. The rest
 * are the neutral defaults: Rule 7 states no meet-wide scorer pool, no diver
 * pool weight and no entry limits, so none is fabricated here. `diverScorerWeight`
 * and the entry caps stay at their no-op values rather than being borrowed from
 * a conference preset that happens to publish some.
 */
const NCAA_PRESET_BASE = {
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  scorerCapScope: 'event',
  diverScorerWeight: 1,
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
} as const satisfies Partial<ScoringSettings>;

/**
 * Turn one rulebook format into a preset.
 *
 * `relayMultiplier` is carried at its historical value but is inert whenever
 * `relayPoints` is set, which is every format that contests relays — see
 * {@link ScoringSettings.relayPoints}. A diving-dual format contests no relays at
 * all, so it caps scoring relays at 0 rather than quietly scoring them off the
 * diving table.
 */
export function scoringPresetFromNcaaRuleset(ruleset: NcaaFormatRuleset): BuiltInScoringPreset {
  const id = ncaaPresetId(ruleset.format);
  const group = presetGroupForFormat(ruleset.format);

  if (isNcaaHostPublishedTable(ruleset.individual)) {
    return {
      id,
      label: ruleset.label,
      description:
        `${ruleset.individual.citation}: "${ruleset.individual.rule}" The NCAA publishes no ` +
        `table for this format, so this preset carries no point values. Supply the host's ` +
        `published table before scoring.`,
      builtIn: true,
      citation: ruleset.individual.citation,
      group,
      meetFormat: ruleset.format,
      requiresHostPublishedTable: true,
    };
  }

  const individual = ruleset.individual;
  const relay =
    ruleset.relay && !isNcaaHostPublishedTable(ruleset.relay) ? ruleset.relay : null;
  const places = placesOf(individual);

  const settings: ScoringSettings = {
    ...NCAA_PRESET_BASE,
    scoringPoints: places,
    aFinalBracketSize: bracketForFinals(
      ruleset,
      Math.max(places.length, relay?.places.length ?? 0)
    ),
    maxRelaysScoringPerTeam: ruleset.relay === null ? 0 : (relay?.maxScorersPerTeam ?? 999),
    meetFormat: ruleset.format,
  };
  if (relay) settings.relayPoints = placesOf(relay);
  if (individual.maxScorersPerTeam !== null) {
    settings.maxIndividualScorersPerTeamPerEvent = individual.maxScorersPerTeam;
  }

  return {
    id,
    label: ruleset.label,
    description: describeNcaaPreset(ruleset, individual, relay),
    builtIn: true,
    citation: individual.citation,
    group,
    meetFormat: ruleset.format,
    settings,
  };
}

function presetGroupForFormat(format: NcaaMeetFormat): string {
  if (format.startsWith('dual-diving-')) return 'NCAA diving dual meets';
  if (format.startsWith('dual-')) return 'NCAA dual meets';
  if (format.startsWith('championship-')) return 'NCAA championships';
  return 'NCAA other formats';
}

function describeNcaaPreset(
  ruleset: NcaaFormatRuleset,
  individual: NcaaPointTable,
  relay: NcaaPointTable | null
): string {
  const parts = [`${individual.citation}. Individual ${individual.places.join('-')}`];
  if (individual.maxScorersPerTeam !== null) {
    parts.push(`best ${individual.maxScorersPerTeam} per team score`);
  }
  if (relay) {
    parts.push(`relays ${relay.places.join('-')}`);
    if (relay.maxScorersPerTeam !== null) {
      parts.push(`best ${relay.maxScorersPerTeam} relays per team score`);
    }
  } else if (ruleset.relay === null) {
    parts.push('no relay events in this format');
  }
  if (ruleset.finals.kind === 'unsourced-split') {
    parts.push('scored as one pool — the rulebook publishes no finals split for this field size');
  }
  return `${parts.join('; ')}.`;
}

/**
 * A real dual meet runs Rule 7-1's swimming table and Rule 7-1-4's diving table
 * at the same time, chosen independently: the swimming table by lane count, the
 * diving table by how many divers the teams field. Neither rulebook format
 * describes that meet on its own, so this composes the two — taking every number
 * from `NCAA_FORMAT_RULESETS` and inventing none.
 */
export function composeDualMeetPreset(
  swimFormat: 'dual-six-lanes-or-more' | 'dual-five-lanes-or-fewer',
  divingFormat: 'dual-diving-three-or-fewer' | 'dual-diving-four-or-five' | 'dual-diving-six-or-more'
): BuiltInScoringPreset {
  const swim = scoringPresetFromNcaaRuleset(NCAA_FORMAT_RULESETS[swimFormat]);
  const divingRuleset = NCAA_FORMAT_RULESETS[divingFormat];
  const divingTable = divingRuleset.individual as NcaaPointTable;
  if (!swim.settings) {
    throw new Error(`composeDualMeetPreset: ${swimFormat} carries no point table.`);
  }

  const settings: ScoringSettings = {
    ...swim.settings,
    scoringPoints: [...swim.settings.scoringPoints],
    divingPoints: placesOf(divingTable),
    // Rule 7-1-4 states its own per-team cap, and it is not Rule 7-1-1's.
    // Carrying the swimming cap into the diving event would silently drop a
    // team's fourth through sixth divers.
    ...(divingTable.maxScorersPerTeam !== null
      ? { divingMaxScorersPerTeamPerEvent: divingTable.maxScorersPerTeam }
      : {}),
    // Both formats are single-pool, so the bracket must sit past the longest of
    // the three tables — see `bracketForFinals`.
    aFinalBracketSize: Math.max(
      swim.settings.scoringPoints.length,
      swim.settings.relayPoints?.length ?? 0,
      divingTable.places.length
    ),
  };
  if (swim.settings.relayPoints) settings.relayPoints = [...swim.settings.relayPoints];

  return {
    id: `${swim.id}-plus-${divingFormat}`,
    label: `${swim.label} + ${divingRuleset.label.replace(/^Dual diving meet — /, 'diving, ')}`,
    description:
      `${swim.description} Diving scores from ${divingTable.citation}: ` +
      `${divingTable.places.join('-')}.`,
    builtIn: true,
    citation: `${swim.citation} + ${divingTable.citation}`,
    group: 'NCAA dual meets (swimming + diving)',
    // Deliberately no `meetFormat`: this is two rulebook formats at once, and
    // the field names exactly one. The citation carries both.
    settings,
  };
}

/** Rule 7 formats, generated. Order follows `NCAA_MEET_FORMATS` (rulebook order). */
export const NCAA_FORMAT_PRESETS: readonly BuiltInScoringPreset[] = NCAA_MEET_FORMATS.map(format =>
  scoringPresetFromNcaaRuleset(NCAA_FORMAT_RULESETS[format])
);

/** Every swimming-dual × diving-dual pairing Rule 7-1 allows. */
export const NCAA_DUAL_COMBINED_PRESETS: readonly BuiltInScoringPreset[] = (
  ['dual-six-lanes-or-more', 'dual-five-lanes-or-fewer'] as const
).flatMap(swim =>
  (['dual-diving-three-or-fewer', 'dual-diving-four-or-five', 'dual-diving-six-or-more'] as const).map(
    diving => composeDualMeetPreset(swim, diving)
  )
);

/**
 * The two presets that predate Rule 7 generation.
 *
 * `generic-top16` is the neutral app default and `nsisc` is a conference rule
 * set, not an NCAA meet format — both stay hand-defined, and both keep their
 * exact settings objects so every saved workspace scores as it did.
 */
export const LEGACY_BUILT_IN_PRESETS: readonly BuiltInScoringPreset[] = [
  {
    id: 'generic-top16',
    label: 'Generic Top 16',
    description:
      '16-place table, unlimited individual scorers and relays, per-event caps. For ACC/SEC/Big 12 ' +
      'PDFs with a HyTek Points column, enable PDF place points (auto or on) so team totals match the sheet.',
    builtIn: true,
    citation: 'App default — not a published NCAA format',
    group: 'App defaults',
    conferenceMatches: ['ACC', 'SEC', 'BIG 12', 'BIG12'],
    settings: GENERIC_TOP16_SETTINGS,
  },
  {
    id: 'nsisc',
    label: 'NSISC',
    description:
      '16 places; 18 meet-wide scorer units; 7 total entries per swimmer (any individual/relay mix); ' +
      'A/B finalists + relay legs on editable roster; divers 1/3 slot; max 2 scoring relays.',
    builtIn: true,
    citation: 'NSISC conference rules',
    group: 'Conference',
    conferenceMatches: ['NSISC'],
    settings: NSISC_PRESET_SETTINGS,
  },
];

/** Every preset the app ships, in picker order. */
export const BUILT_IN_SCORING_PRESETS: readonly BuiltInScoringPreset[] = [
  ...LEGACY_BUILT_IN_PRESETS,
  ...NCAA_FORMAT_PRESETS,
  ...NCAA_DUAL_COMBINED_PRESETS,
];

export const BUILT_IN_SCORING_PRESET_BY_ID: Readonly<Record<string, BuiltInScoringPreset>> =
  Object.freeze(Object.fromEntries(BUILT_IN_SCORING_PRESETS.map(p => [p.id, p])));

export function isBuiltInScoringPresetId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_SCORING_PRESET_BY_ID, id);
}

/** List metadata for a picker. Never carries point values — use {@link settingsForBuiltInScoringPreset}. */
export function builtInScoringPresetMeta(): ScoringPresetMeta[] {
  return BUILT_IN_SCORING_PRESETS.map(p => ({
    id: p.id,
    label: p.label,
    description: p.description,
    builtIn: true,
    citation: p.citation,
    group: p.group,
    ...(p.meetFormat ? { meetFormat: p.meetFormat } : {}),
    ...(p.requiresHostPublishedTable ? { requiresHostPublishedTable: true as const } : {}),
    ...(p.conferenceMatches ? { conferenceMatches: [...p.conferenceMatches] } : {}),
  }));
}

/**
 * Settings for one built-in preset.
 *
 * Throws {@link HostPublishedTableRequiredError} for a format whose table the
 * NCAA does not publish, rather than returning a default nobody sourced. Throws
 * a plain error for an unknown id — an unrecognised preset is not "the default".
 */
export function settingsForBuiltInScoringPreset(id: string): ScoringSettings {
  const preset = BUILT_IN_SCORING_PRESET_BY_ID[id];
  if (!preset) throw new Error(`Unknown built-in scoring preset: ${id}`);
  if (!preset.settings) {
    throw new HostPublishedTableRequiredError(id, preset.citation, preset.description);
  }
  return { ...preset.settings };
}

export const SCORING_PRESET_BY_ID: Record<string, ScoringSettings> = Object.fromEntries(
  BUILT_IN_SCORING_PRESETS.filter(p => p.settings).map(p => [p.id, p.settings as ScoringSettings])
);

// ---------------------------------------------------------------------------
// Conference → preset, declared rather than hardcoded
// ---------------------------------------------------------------------------

/** One "this conference scores by that preset" rule. */
export interface ConferencePresetBinding {
  /** Matched case-insensitively as a substring of the workspace's conference name. */
  readonly match: string;
  readonly presetId: string;
  readonly builtIn: boolean;
}

function bindingsFrom(presets: readonly ScoringPresetMeta[], builtIn: boolean): ConferencePresetBinding[] {
  const out: ConferencePresetBinding[] = [];
  for (const preset of presets) {
    for (const match of preset.conferenceMatches ?? []) {
      const trimmed = String(match).trim().toUpperCase();
      if (trimmed) out.push({ match: trimmed, presetId: preset.id, builtIn });
    }
  }
  return out;
}

const BUILT_IN_CONFERENCE_BINDINGS: readonly ConferencePresetBinding[] = bindingsFrom(
  BUILT_IN_SCORING_PRESETS,
  true
);

let userConferenceBindings: readonly ConferencePresetBinding[] = [];

/**
 * Declare conference bindings from user presets, replacing any previous set.
 *
 * A user binding is only ever consulted after every built-in one, so a saved
 * preset cannot capture "NSISC" and quietly switch off the conference lock in
 * `mergeScoringSettings` — a rule the UI states and the engine enforces.
 */
export function setUserConferencePresetBindings(presets: readonly ScoringPresetMeta[]): void {
  userConferenceBindings = bindingsFrom(presets, false);
}

/** Built-in bindings first, then user ones; within each layer the longest match wins. */
export function conferencePresetBindings(): readonly ConferencePresetBinding[] {
  const byLength = (a: ConferencePresetBinding, b: ConferencePresetBinding) =>
    b.match.length - a.match.length;
  return [...BUILT_IN_CONFERENCE_BINDINGS].sort(byLength).concat([...userConferenceBindings].sort(byLength));
}

/**
 * Which preset a workspace's conference selects, or `null` when nothing claims it.
 *
 * The conference names used to be four string literals inside this function —
 * the hardcoding this round exists to remove. They are now declared as
 * `conferenceMatches` on the presets themselves, so adding a conference means
 * adding a preset, not editing an engine.
 */
export function presetIdForConference(
  conference?: string,
  bindings: readonly ConferencePresetBinding[] = conferencePresetBindings()
): string | null {
  if (!conference) return null;
  const u = conference.toUpperCase();
  for (const binding of bindings) {
    if (u.includes(binding.match)) return binding.presetId;
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

/**
 * Settings an explicit `relayPoints` table makes inert.
 *
 * `relayMultiplier` is read only when no relay table is present, so a settings
 * editor that leaves the multiplier enabled next to a Rule 7-1-1 relay table is
 * offering an edit the engine discards — the same defect
 * {@link NSISC_LOCKED_SETTING_KEYS} was exported to fix.
 */
export const EXPLICIT_RELAY_TABLE_LOCKED_SETTING_KEYS = [
  'relayMultiplier',
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
  reason: 'nsisc' | 'pdf_place_points' | 'explicit_relay_table' | null;
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
  if (appliesConferenceOverride(merged, options?.conference)) {
    return {
      keys: NSISC_LOCKED_SETTING_KEYS,
      reason: 'nsisc',
      message:
        'NSISC fixes these by rule (18-scorer meet-wide pool, 2 scoring relays, 7 entries per swimmer), so they are locked to the conference values.',
    };
  }
  if (merged.relayPoints?.length) {
    return {
      keys: EXPLICIT_RELAY_TABLE_LOCKED_SETTING_KEYS,
      reason: 'explicit_relay_table',
      message:
        'This rule set carries its own relay point table, so relay places score from that table and the relay multiplier is ignored.',
    };
  }
  return { keys: [], reason: null, message: null };
}

/**
 * Whether a conference's own rules override these settings.
 *
 * They do not when the settings name an NCAA meet format. A dual meet between
 * two NSISC schools is scored by NCAA Rule 7-1, not by the conference
 * championship's 18-scorer pool — and before this guard, picking the dual preset
 * on an NSISC workspace silently swapped the dual rules back out for the
 * championship ones. Settings that name no format behave exactly as before,
 * which is every preset and every saved workspace written before 2026-09-20.
 */
function appliesConferenceOverride(
  settings: ScoringSettings,
  conference: string | undefined
): boolean {
  if (settings.meetFormat) return false;
  return presetIdForConference(conference) === 'nsisc';
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
    const nsiscConference = appliesConferenceOverride(merged, options?.conference);
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

/**
 * Keys a stored preset carries that are *about* the preset rather than settings
 * the engine reads. Stripped before the rest is merged into `ScoringSettings`.
 *
 * `meetFormat` is deliberately absent: it is a real `ScoringSettings` field (the
 * provenance link back to `NCAA_FORMAT_RULESETS`) that a picker also surfaces as
 * metadata. Stripping it would drop it on every save/load round trip.
 */
export const SCORING_PRESET_META_KEYS = [
  'id',
  'label',
  'description',
  'builtIn',
  'citation',
  'group',
  'requiresHostPublishedTable',
  'conferenceMatches',
] as const;

export function settingsFromPresetPayload(raw: Record<string, unknown>): ScoringSettings {
  const rest: Record<string, unknown> = {};
  const meta = new Set<string>(SCORING_PRESET_META_KEYS);
  for (const [k, v] of Object.entries(raw)) {
    if (!meta.has(k)) rest[k] = v;
  }
  return mergeScoringSettings(rest as Partial<ScoringSettings>);
}

/**
 * The scoring-settings patch a freshly parsed meet (PDF or SwimCloud) needs,
 * if any. `undefined` means the workspace's existing settings already apply
 * — the caller should leave `scoringSettings` out of its update patch rather
 * than write back an unchanged value.
 *
 * Extracted 2026-09-08 from `OpsModule.tsx` (`packages/matrix`), which
 * originally defined this privately and called it from both `handleFileUpload`
 * (PDF path) and `handleSwimCloudImport` (SwimCloud path) — the same inputs,
 * the same trust decision, one copy. It has zero React or UI dependency and
 * zero SwimCloud-specific knowledge (`allParsed` is already plain
 * `SwimmerResult[]` by the time this runs), so it belongs here, next to the
 * `presetIdForConference`/`resultsHavePdfPlacePoints`/`NSISC_PRESET_SETTINGS`
 * it composes — not in a component only the browser UI can import. This is
 * what makes a non-UI caller (a script, a future server-side import route)
 * able to reproduce the real "load a meet" write path exactly, instead of
 * only being able to call the pure parse/convert steps and leave scoring
 * unconfigured.
 *
 * Takes the workspace's current `ScoringSettings` directly rather than the
 * whole `Workspace` — the only field this ever read — so this module never
 * needs to import the `Workspace` type.
 */
export function buildScoringPatchForParsedPdf(
  currentScoringSettings: ScoringSettings | undefined,
  conference: string | undefined,
  presetHint: string | null,
  allParsed: SwimmerResult[]
): ScoringSettings | undefined {
  if (resultsHavePdfPlacePoints(allParsed)) {
    return mergeScoringSettings(
      {
        ...currentScoringSettings,
        usePdfPlacePoints: true,
        scorerEligibilityMode: 'points_pool',
        scorerAutoRules: undefined,
        ...applyPdfPlacePointsNeutralCaps(
          mergeScoringSettings(currentScoringSettings, { conference })
        ),
      },
      { conference, resultsForPdfHint: allParsed }
    );
  }
  if (presetHint === 'nsisc') {
    return mergeScoringSettings(
      {
        ...currentScoringSettings,
        ...NSISC_PRESET_SETTINGS,
        scorerEligibilityMode: 'roster',
      },
      { conference }
    );
  }
  return undefined;
}
