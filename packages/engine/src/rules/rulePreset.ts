/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rule preset payload (plans/2026-10-25/D2-ENGINE-API.md, 3.4).
 *
 * A preset holds rule values only. Id, name, revision and `derivedFrom` belong to the storage
 * record. Each value is a `Setting`: `set` with its provenance, or `pending`. There is no
 * default: a value nobody stated stays pending, and `requireComplete` refuses a preset that still
 * has one, naming every pending path.
 *
 * ## Versions
 * `RulePreset` is payload version 3. Each bump adds one setting:
 * - Version 2 (`RulePresetV2`) added `scoring.ties` (how tied times place). Payload version 1
 *   (`RulePresetV1`) had no such setting: the legacy scorer split ties and nothing recorded that.
 * - Version 3 adds `scorers.relayOverCap` (README R67): what happens to a relay over
 *   `scorers.scoringRelaysPerTeamPerEvent`. Versions 1 and 2 had no such setting: `scoreMeet` always
 *   held the place, and nothing recorded that as a rule.
 *
 * - `parseRulePreset` reads version 3. It also reads versions 1 and 2, by explicit migrations:
 *   `migrateRulePresetV1` keeps every setting and leaves `ties` pending (v1 to v2), and
 *   `migrateRulePresetV2` keeps every setting and leaves `relayOverCap` pending (v2 to v3). The result says
 *   `payloadVersion: 3`, and nothing assumes a tie rule or a relay over-cap rule.
 * - `parseRulePresetV1` and `parseRulePresetV2` read their version as that version (a frozen built-in, a
 *   stored payload).
 * - `requireComplete` and `pendingPaths` refuse an object that says version 1 or 2. A stored payload read
 *   without a parse would otherwise look complete, and `scoreMeet` would read a setting that is not there.
 */
import type { ScorerAutoRules } from '../types';
import { editedProvenance, expectKeys, isRecord, parseSetting } from '../model/provenance';
import type { Setting } from '../model/provenance';
import type { IsoTime } from '../model/primitives';
import { parseCap, RulePresetError } from './cap';
import type { Cap } from './cap';

export type { ScorerAutoRules } from '../types';

/** Integers, `0 < numerator <= denominator`. */
export type DiverWeight = { readonly numerator: number; readonly denominator: number };
export type RelayPointRule =
  | { readonly kind: 'table'; readonly points: readonly number[] }
  | { readonly kind: 'multiple-of-individual'; readonly multiplier: number };
export type DivingPointRule =
  | { readonly kind: 'same-as-individual' }
  | { readonly kind: 'table'; readonly points: readonly number[] };
export type PerEventScorerCap =
  | { readonly cap: 'unlimited' }
  | { readonly cap: number; readonly overCap: 'holds-place' | 'removed-from-consideration' };
export type DivingPerEventScorerCap =
  | { readonly kind: 'same-as-swimming' }
  | ({ readonly kind: 'own' } & PerEventScorerCap);
/**
 * A swim in any heat of a split timed final marks a scorer (R40). The legacy scorer has no such
 * field, so the legacy bridge drops it.
 */
export type EngineScorerAutoRules = ScorerAutoRules & { readonly splitTimedFinalMarksScorer: boolean };
export type PlaceTreatment = 'holds-place' | 'removed-from-consideration';
export type CFinalRule = { readonly kind: 'none' } | { readonly kind: 'non-scorers'; readonly size: number };

/**
 * How tied times place.
 * - `'split'`: tied entries share a rank and split the points of the places they cover.
 * - `'ordered'`: every entry takes its own place, and a tie is broken by entry order (the lineup's
 *   order). No points are split.
 */
export type TieRule = 'split' | 'ordered';

/** Payload version 1: no `scoring.ties`. Stored payloads and frozen built-ins keep this shape. */
export interface RulePresetV1 {
  readonly payloadVersion: 1;
  readonly scoring: {
    readonly individualPoints: Setting<readonly number[]>;
    readonly relayPoints: Setting<RelayPointRule>;
    readonly divingPoints: Setting<DivingPointRule>;
    readonly halfRateRelaySwimmer: Setting<boolean>;
    readonly aFinalBracketSize: Setting<number>;
    readonly nonScorerPlacement: Setting<PlaceTreatment>;
    readonly abFinalsScorersOnly: Setting<boolean>;
    readonly cFinal: Setting<CFinalRule>;
  };
  readonly scorers: {
    readonly eligibility: Setting<'roster' | 'points_pool'>;
    readonly autoRules: Setting<EngineScorerAutoRules | null>;
    readonly scoringTeamSize: Setting<Cap>;
    readonly scoringTeamScope: Setting<'meet' | 'event'>;
    readonly diverWeight: Setting<DiverWeight>;
    readonly perEventScorerCap: Setting<PerEventScorerCap>;
    readonly divingPerEventScorerCap: Setting<DivingPerEventScorerCap>;
    readonly scoringRelaysPerTeamPerEvent: Setting<Cap>;
    /** `'points_pool'` only. Under `'roster'` it is not applicable and stays pending. */
    readonly relayEligibleFromScorerPool: Setting<boolean>;
    /** `'roster'` only. */
    readonly relayLegsMustBeScorers: Setting<boolean>;
  };
  readonly entries: {
    readonly maxIndividualPerSwimmer: Setting<Cap>;
    readonly maxRelayPerSwimmer: Setting<Cap>;
    readonly maxTotalPerSwimmer: Setting<Cap>;
    readonly timeTrialsCount: Setting<boolean>;
    readonly exhibitionCounts: Setting<boolean>;
    readonly relayLegsAllowTimeTrials: Setting<boolean>;
  };
}

/**
 * What happens to a relay over `scorers.scoringRelaysPerTeamPerEvent` (README R67). Which relays are over
 * the limit does not depend on it: the best relays of a team by rank are within the limit.
 * - `'holds-place'`: the relay keeps its place and scores 0. Nobody behind it moves up. SwimCloud's rule.
 * - `'exhibition'`: the relay leaves the places like an exhibition entry, and the relays behind it move up.
 */
export type RelayOverCapRule = 'holds-place' | 'exhibition';

/** Payload version 2: version 1 plus `scoring.ties`. Stored payloads keep this shape. */
export interface RulePresetV2 {
  readonly payloadVersion: 2;
  readonly scoring: RulePresetV1['scoring'] & { readonly ties: Setting<TieRule> };
  readonly scorers: RulePresetV1['scorers'];
  readonly entries: RulePresetV1['entries'];
}

/**
 * Two optional relay entry rules, on payload version 3 only (README R72 and R42). An absent key means the rule is
 * not checked: no preset is read as having one, and `migrateRulePresetV2` adds neither. They report violations
 * and never change a score or trim a lineup. A pending value stops `requireComplete`, like any setting.
 */
export interface RelayEntryRules {
  /**
   * `true`: a swimmer may swim on only one of a team's relays in one event (NCAA Rule 5-7-1-g, README R72).
   * `scoreMeet` reports a `relay_swimmer_repeated` violation. The model has no rounds (D2 section 9, item 17),
   * so every relay entry counts as a timed-final relay.
   */
  readonly relaySwimmerOncePerEvent?: Setting<boolean>;
  /**
   * `false`: a team enters only relays that can score (README R42, NSISC), so every relay beyond
   * `scorers.scoringRelaysPerTeamPerEvent` is an entry violation: `scoreMeet` reports `relay_entries_over_limit`.
   * It does nothing while that limit is `'unlimited'`. `true`: relays beyond the limit are allowed, and
   * `scorers.relayOverCap` alone decides how they score.
   */
  readonly nonScoringRelaysAllowed?: Setting<boolean>;
}

/** Payload version 3: version 2 plus `scorers.relayOverCap`, and the optional `RelayEntryRules`. */
export interface RulePreset {
  readonly payloadVersion: 3;
  readonly scoring: RulePresetV2['scoring'];
  readonly scorers: RulePresetV1['scorers'] & { readonly relayOverCap: Setting<RelayOverCapRule> };
  readonly entries: RulePresetV1['entries'] & RelayEntryRules;
}

/** A preset with no pending setting that applies to its eligibility mode. Only `requireComplete` makes one. */
export type CompleteRulePreset = RulePreset & { readonly __complete: true };

/* -------------------------------------------------------------------------- */
/* Value parsers                                                              */
/* -------------------------------------------------------------------------- */

function invalid(path: string, why: string): RulePresetError {
  return new RulePresetError(path, 'invalid', `${path}: ${why}`);
}

function parseBoolean(raw: unknown, path: string): boolean {
  if (typeof raw !== 'boolean') throw invalid(path, 'expected true or false');
  return raw;
}

function parsePointList(raw: unknown, path: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid(path, 'expected a non-empty list of points');
  return raw.map((point, i) => {
    if (typeof point !== 'number' || !Number.isFinite(point) || point < 0) {
      throw invalid(`${path}[${i}]`, 'a point must be a finite number of 0 or more');
    }
    return point;
  });
}

function parsePositiveInteger(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) throw invalid(path, 'expected a whole number of 1 or more');
  return raw;
}

function parseOneOf<T extends string>(raw: unknown, path: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw invalid(path, `expected one of ${allowed.map(a => JSON.stringify(a)).join(', ')}`);
  }
  return raw as T;
}

function parsePlaceTreatment(raw: unknown, path: string): PlaceTreatment {
  return parseOneOf(raw, path, ['holds-place', 'removed-from-consideration']);
}

function parseRelayPointRule(raw: unknown, path: string): RelayPointRule {
  if (!isRecord(raw)) throw invalid(path, 'expected an object');
  if (raw.kind === 'table') {
    const obj = expectKeys(raw, path, ['kind', 'points']);
    return { kind: 'table', points: parsePointList(obj.points, `${path}.points`) };
  }
  if (raw.kind === 'multiple-of-individual') {
    const obj = expectKeys(raw, path, ['kind', 'multiplier']);
    const m = obj.multiplier;
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) {
      throw invalid(`${path}.multiplier`, 'a multiplier must be a finite number of 0 or more');
    }
    return { kind: 'multiple-of-individual', multiplier: m };
  }
  throw invalid(`${path}.kind`, 'expected "table" or "multiple-of-individual"');
}

function parseDivingPointRule(raw: unknown, path: string): DivingPointRule {
  if (!isRecord(raw)) throw invalid(path, 'expected an object');
  if (raw.kind === 'same-as-individual') {
    expectKeys(raw, path, ['kind']);
    return { kind: 'same-as-individual' };
  }
  if (raw.kind === 'table') {
    const obj = expectKeys(raw, path, ['kind', 'points']);
    return { kind: 'table', points: parsePointList(obj.points, `${path}.points`) };
  }
  throw invalid(`${path}.kind`, 'expected "same-as-individual" or "table"');
}

function parseCFinalRule(raw: unknown, path: string): CFinalRule {
  if (!isRecord(raw)) throw invalid(path, 'expected an object');
  if (raw.kind === 'none') {
    expectKeys(raw, path, ['kind']);
    return { kind: 'none' };
  }
  if (raw.kind === 'non-scorers') {
    const obj = expectKeys(raw, path, ['kind', 'size']);
    return { kind: 'non-scorers', size: parsePositiveInteger(obj.size, `${path}.size`) };
  }
  throw invalid(`${path}.kind`, 'expected "none" or "non-scorers"');
}

function parseDiverWeight(raw: unknown, path: string): DiverWeight {
  const obj = expectKeys(raw, path, ['numerator', 'denominator']);
  const { numerator, denominator } = obj;
  if (typeof numerator !== 'number' || !Number.isSafeInteger(numerator) || typeof denominator !== 'number' || !Number.isSafeInteger(denominator)) {
    throw invalid(path, 'numerator and denominator must be integers');
  }
  if (denominator === 0) throw invalid(`${path}.denominator`, 'the denominator is zero');
  if (!(numerator > 0 && numerator <= denominator)) throw invalid(path, 'expected 0 < numerator <= denominator');
  return { numerator, denominator };
}

/** Reads the cap and over-cap pair of a per-event scorer cap. `kind` is checked by the caller. */
function parsePerEventCapFields(obj: Record<string, unknown>, path: string): PerEventScorerCap {
  const cap = parseCap(obj.cap, `${path}.cap`);
  if (cap === 'unlimited') {
    if (Object.hasOwn(obj, 'overCap')) throw invalid(`${path}.overCap`, 'an unlimited cap has no over-cap behavior');
    return { cap: 'unlimited' };
  }
  if (!Object.hasOwn(obj, 'overCap')) throw new RulePresetError(`${path}.overCap`, 'missing', `${path}.overCap: missing`);
  return { cap, overCap: parsePlaceTreatment(obj.overCap, `${path}.overCap`) };
}

function parsePerEventScorerCap(raw: unknown, path: string): PerEventScorerCap {
  if (!isRecord(raw)) throw invalid(path, 'expected an object');
  const obj = expectKeys(raw, path, ['cap'], ['overCap']);
  return parsePerEventCapFields(obj, path);
}

function parseDivingPerEventScorerCap(raw: unknown, path: string): DivingPerEventScorerCap {
  if (!isRecord(raw)) throw invalid(path, 'expected an object');
  if (raw.kind === 'same-as-swimming') {
    expectKeys(raw, path, ['kind']);
    return { kind: 'same-as-swimming' };
  }
  if (raw.kind === 'own') {
    const obj = expectKeys(raw, path, ['kind', 'cap'], ['overCap']);
    return { kind: 'own', ...parsePerEventCapFields(obj, path) };
  }
  throw invalid(`${path}.kind`, 'expected "same-as-swimming" or "own"');
}

function parseStringList(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw) || raw.some(s => typeof s !== 'string')) throw invalid(path, 'expected a list of strings');
  return [...(raw as string[])];
}

function parseAutoRules(raw: unknown, path: string): EngineScorerAutoRules | null {
  if (raw === null) return null;
  // Every key is required. The legacy merge fills a missing `scorerAutoRules` from
  // `DEFAULT_SCORER_AUTO_RULES` (scoringDefaults.ts:775), and this parser must not let that happen.
  const obj = expectKeys(raw, path, [
    'abFinalTiers',
    'includeRelayLegsInFinals',
    'distanceFinalRequired',
    'distanceEventPattern',
    'splitTimedFinalMarksScorer',
  ]);
  const tiers = parseStringList(obj.abFinalTiers, `${path}.abFinalTiers`).map((tier, i) => {
    if (tier !== 'A' && tier !== 'B') throw invalid(`${path}.abFinalTiers[${i}]`, 'expected "A" or "B"');
    return tier;
  });
  return {
    abFinalTiers: tiers,
    includeRelayLegsInFinals: parseBoolean(obj.includeRelayLegsInFinals, `${path}.includeRelayLegsInFinals`),
    distanceFinalRequired: parseBoolean(obj.distanceFinalRequired, `${path}.distanceFinalRequired`),
    distanceEventPattern: parseStringList(obj.distanceEventPattern, `${path}.distanceEventPattern`),
    splitTimedFinalMarksScorer: parseBoolean(obj.splitTimedFinalMarksScorer, `${path}.splitTimedFinalMarksScorer`),
  };
}

/* -------------------------------------------------------------------------- */
/* parseRulePreset                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read a stored or imported preset. Throws `RulePresetError` on: a missing key; an unknown key or
 * `null`; a provenance kind outside the five (`'legacy'` gives `legacy_provenance`); a numeric cap
 * of 999 or more; `eligibility: 'roster'` with `autoRules: null`; a bad `DiverWeight`; a negative
 * or non-finite point. A payload version 1 reads as version 3 with `ties` and `relayOverCap` pending, and a
 * payload version 2 reads as version 3 with `relayOverCap` pending (see the header).
 */
export function parseRulePreset(json: unknown): RulePreset {
  const root = expectKeys(json, 'preset', ['payloadVersion', 'scoring', 'scorers', 'entries']);
  if (root.payloadVersion === 1) return migrateRulePresetV2(migrateRulePresetV1(parseRulePresetV1(json)));
  if (root.payloadVersion === 2) return migrateRulePresetV2(parseRulePresetV2(json));
  if (root.payloadVersion !== 3) throw invalid('payloadVersion', 'expected 1, 2 or 3');
  const so = expectKeys(root.scorers, 'scorers', [...SCORER_KEYS, 'relayOverCap']);
  const { relayOverCap, ...v2Scorers } = so;
  const en = expectKeys(root.entries, 'entries', ENTRY_KEYS, RELAY_ENTRY_RULE_KEYS);
  const { relaySwimmerOncePerEvent, nonScoringRelaysAllowed, ...v2Entries } = en;
  const v2 = readVersion2Body({ ...root, scorers: v2Scorers, entries: v2Entries });
  // A key is added only when present: an absent rule stays absent, and never becomes `undefined`.
  const relayRules: RelayEntryRules = {
    ...(relaySwimmerOncePerEvent === undefined
      ? {}
      : { relaySwimmerOncePerEvent: parseSetting(relaySwimmerOncePerEvent, 'entries.relaySwimmerOncePerEvent', parseBoolean) }),
    ...(nonScoringRelaysAllowed === undefined
      ? {}
      : { nonScoringRelaysAllowed: parseSetting(nonScoringRelaysAllowed, 'entries.nonScoringRelaysAllowed', parseBoolean) }),
  };
  return {
    payloadVersion: 3,
    scoring: v2.scoring,
    scorers: {
      ...v2.scorers,
      relayOverCap: parseSetting(relayOverCap, 'scorers.relayOverCap', (v, p) => parseOneOf(v, p, ['holds-place', 'exhibition'] as const)),
    },
    entries: { ...v2.entries, ...relayRules },
  };
}

/** Reads the version 2 shape of `root`: version 1 keys plus `scoring.ties`. The `payloadVersion` of `root` is not read. */
function readVersion2Body(root: Record<string, unknown>): RulePresetV2 {
  const sc = expectKeys(root.scoring, 'scoring', [...SCORING_KEYS, 'ties']);
  const { ties, ...v1Scoring } = sc;
  const body = parseBody({ ...root, payloadVersion: 1, scoring: v1Scoring });
  return {
    payloadVersion: 2,
    scoring: { ...body.scoring, ties: parseSetting(ties, 'scoring.ties', (v, p) => parseOneOf(v, p, ['split', 'ordered'] as const)) },
    scorers: body.scorers,
    entries: body.entries,
  };
}

/**
 * Read a payload version 2 preset (a stored one). It has no `scorers.relayOverCap`, and that key is an
 * unknown key. Same checks as `parseRulePreset`.
 */
export function parseRulePresetV2(json: unknown): RulePresetV2 {
  const root = expectKeys(json, 'preset', ['payloadVersion', 'scoring', 'scorers', 'entries']);
  if (root.payloadVersion !== 2) throw invalid('payloadVersion', 'expected 2');
  return readVersion2Body(root);
}

/**
 * Read a payload version 1 preset (a stored one, or a frozen built-in). It has no `scoring.ties`, and a
 * `ties` key is an unknown key. Same checks as `parseRulePreset`.
 */
export function parseRulePresetV1(json: unknown): RulePresetV1 {
  const root = expectKeys(json, 'preset', ['payloadVersion', 'scoring', 'scorers', 'entries']);
  if (root.payloadVersion !== 1) throw invalid('payloadVersion', 'expected 1');
  return parseBody(root);
}

/**
 * Move a version 1 preset to version 2. Every setting is kept as it is. `ties` is what the caller
 * states, or `pending` when the caller states none: the old payload never recorded a tie rule, and no
 * rule is assumed. A pending `ties` stops `requireComplete`, so nothing scores until someone sets it.
 */
export function migrateRulePresetV1(old: RulePresetV1, ties?: Setting<TieRule>): RulePresetV2 {
  return {
    payloadVersion: 2,
    scoring: {
      ...old.scoring,
      ties:
        ties ?? {
          state: 'pending',
          question: 'This preset was saved before the ties setting existed. How do tied times score: "split" or "ordered"?',
          blocks: ['requireComplete', 'scoreMeet'],
        },
    },
    scorers: old.scorers,
    entries: old.entries,
  };
}

/**
 * Move a version 2 preset to version 3. Every setting is kept as it is. `relayOverCap` is what the caller
 * states, or `pending` when the caller states none: the old payload never recorded what happens to a relay
 * over the scoring-relay limit, and no rule is assumed (README R67). A pending `relayOverCap` stops
 * `requireComplete`, so nothing scores until someone sets it.
 */
export function migrateRulePresetV2(old: RulePresetV2, relayOverCap?: Setting<RelayOverCapRule>): RulePreset {
  return {
    payloadVersion: 3,
    scoring: old.scoring,
    scorers: {
      ...old.scorers,
      relayOverCap:
        relayOverCap ?? {
          state: 'pending',
          question:
            'This preset was saved before the relayOverCap setting existed. What happens to a relay over the scoring-relay limit: "holds-place" (keeps its place, scores 0) or "exhibition" (leaves the places)? See README R67.',
          blocks: ['requireComplete', 'scoreMeet'],
        },
    },
    entries: old.entries,
  };
}

const SCORING_KEYS = [
  'individualPoints',
  'relayPoints',
  'divingPoints',
  'halfRateRelaySwimmer',
  'aFinalBracketSize',
  'nonScorerPlacement',
  'abFinalsScorersOnly',
  'cFinal',
] as const;

const SCORER_KEYS = [
  'eligibility',
  'autoRules',
  'scoringTeamSize',
  'scoringTeamScope',
  'diverWeight',
  'perEventScorerCap',
  'divingPerEventScorerCap',
  'scoringRelaysPerTeamPerEvent',
  'relayEligibleFromScorerPool',
  'relayLegsMustBeScorers',
] as const;

const ENTRY_KEYS = [
  'maxIndividualPerSwimmer',
  'maxRelayPerSwimmer',
  'maxTotalPerSwimmer',
  'timeTrialsCount',
  'exhibitionCounts',
  'relayLegsAllowTimeTrials',
] as const;

/** The optional `entries` keys of payload version 3 (`RelayEntryRules`). Versions 1 and 2 reject them. */
const RELAY_ENTRY_RULE_KEYS = ['relaySwimmerOncePerEvent', 'nonScoringRelaysAllowed'] as const;

function parseBody(root: Record<string, unknown>): RulePresetV1 {
  const sc = expectKeys(root.scoring, 'scoring', SCORING_KEYS);
  const so = expectKeys(root.scorers, 'scorers', SCORER_KEYS);
  const en = expectKeys(root.entries, 'entries', ENTRY_KEYS);

  const preset: RulePresetV1 = {
    payloadVersion: 1,
    scoring: {
      individualPoints: parseSetting(sc.individualPoints, 'scoring.individualPoints', parsePointList),
      relayPoints: parseSetting(sc.relayPoints, 'scoring.relayPoints', parseRelayPointRule),
      divingPoints: parseSetting(sc.divingPoints, 'scoring.divingPoints', parseDivingPointRule),
      halfRateRelaySwimmer: parseSetting(sc.halfRateRelaySwimmer, 'scoring.halfRateRelaySwimmer', parseBoolean),
      aFinalBracketSize: parseSetting(sc.aFinalBracketSize, 'scoring.aFinalBracketSize', parsePositiveInteger),
      nonScorerPlacement: parseSetting(sc.nonScorerPlacement, 'scoring.nonScorerPlacement', parsePlaceTreatment),
      abFinalsScorersOnly: parseSetting(sc.abFinalsScorersOnly, 'scoring.abFinalsScorersOnly', parseBoolean),
      cFinal: parseSetting(sc.cFinal, 'scoring.cFinal', parseCFinalRule),
    },
    scorers: {
      eligibility: parseSetting(so.eligibility, 'scorers.eligibility', (v, p) => parseOneOf(v, p, ['roster', 'points_pool'] as const)),
      autoRules: parseSetting(so.autoRules, 'scorers.autoRules', parseAutoRules),
      scoringTeamSize: parseSetting(so.scoringTeamSize, 'scorers.scoringTeamSize', parseCap),
      scoringTeamScope: parseSetting(so.scoringTeamScope, 'scorers.scoringTeamScope', (v, p) => parseOneOf(v, p, ['meet', 'event'] as const)),
      diverWeight: parseSetting(so.diverWeight, 'scorers.diverWeight', parseDiverWeight),
      perEventScorerCap: parseSetting(so.perEventScorerCap, 'scorers.perEventScorerCap', parsePerEventScorerCap),
      divingPerEventScorerCap: parseSetting(so.divingPerEventScorerCap, 'scorers.divingPerEventScorerCap', parseDivingPerEventScorerCap),
      scoringRelaysPerTeamPerEvent: parseSetting(so.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent', parseCap),
      relayEligibleFromScorerPool: parseSetting(so.relayEligibleFromScorerPool, 'scorers.relayEligibleFromScorerPool', parseBoolean),
      relayLegsMustBeScorers: parseSetting(so.relayLegsMustBeScorers, 'scorers.relayLegsMustBeScorers', parseBoolean),
    },
    entries: {
      maxIndividualPerSwimmer: parseSetting(en.maxIndividualPerSwimmer, 'entries.maxIndividualPerSwimmer', parseCap),
      maxRelayPerSwimmer: parseSetting(en.maxRelayPerSwimmer, 'entries.maxRelayPerSwimmer', parseCap),
      maxTotalPerSwimmer: parseSetting(en.maxTotalPerSwimmer, 'entries.maxTotalPerSwimmer', parseCap),
      timeTrialsCount: parseSetting(en.timeTrialsCount, 'entries.timeTrialsCount', parseBoolean),
      exhibitionCounts: parseSetting(en.exhibitionCounts, 'entries.exhibitionCounts', parseBoolean),
      relayLegsAllowTimeTrials: parseSetting(en.relayLegsAllowTimeTrials, 'entries.relayLegsAllowTimeTrials', parseBoolean),
    },
  };

  const { eligibility, autoRules } = preset.scorers;
  if (eligibility.state === 'set' && eligibility.value === 'roster' && autoRules.state === 'set' && autoRules.value === null) {
    throw invalid(
      'scorers.autoRules',
      'eligibility "roster" needs auto rules; null would let the legacy merge fill the defaults silently'
    );
  }
  return preset;
}

/* -------------------------------------------------------------------------- */
/* Pending paths, completeness, editing                                       */
/* -------------------------------------------------------------------------- */

/** Throws `unsupported_version` for an object that is not a version 3 preset. */
function requireVersion3(p: { readonly payloadVersion: number }): void {
  if (p.payloadVersion !== 3) {
    throw new RulePresetError(
      'payloadVersion',
      'unsupported_version',
      `payloadVersion: expected 3, got ${String(p.payloadVersion)}. A version 1 preset has no ties setting and a version 1 or 2 preset has no relayOverCap setting: read it with parseRulePreset, or migrate it with migrateRulePresetV1 and migrateRulePresetV2`
    );
  }
}

/** The path of the one scorer field that does not apply to the preset's eligibility mode, or null. */
function notApplicablePath(p: RulePreset): string | null {
  const { eligibility } = p.scorers;
  if (eligibility.state !== 'set') return null;
  return eligibility.value === 'roster' ? 'scorers.relayEligibleFromScorerPool' : 'scorers.relayLegsMustBeScorers';
}

/**
 * Dotted paths of every pending setting that applies, sorted. `relayEligibleFromScorerPool` is
 * skipped under `'roster'` and `relayLegsMustBeScorers` under `'points_pool'`. While the
 * eligibility mode is itself pending, neither is skipped.
 */
export function pendingPaths(p: RulePreset): string[] {
  requireVersion3(p);
  const skip = notApplicablePath(p);
  const out: string[] = [];
  for (const section of ['scoring', 'scorers', 'entries'] as const) {
    const fields = p[section] as Readonly<Record<string, Setting<unknown>>>;
    for (const [key, setting] of Object.entries(fields)) {
      const path = `${section}.${key}`;
      if (setting.state === 'pending' && path !== skip) out.push(path);
    }
  }
  return out.sort();
}

/** The preset itself, typed complete. Throws `pending`, naming every pending path, when it is not. */
export function requireComplete(p: RulePreset): CompleteRulePreset {
  const pending = pendingPaths(p);
  if (pending.length > 0) {
    throw new RulePresetError(
      pending[0] as string,
      'pending',
      `Rule preset is not complete. Pending: ${pending.join(', ')}`,
      pending
    );
  }
  return p as CompleteRulePreset;
}

/** A user edit: `set`, with `user-edited` provenance that keeps the old provenance as `previous`. */
export function editSetting<T>(s: Setting<T>, value: T, at: IsoTime): Setting<T> {
  return {
    state: 'set',
    value,
    provenance: editedProvenance(s.state === 'set' ? s.provenance : null, at),
  };
}
