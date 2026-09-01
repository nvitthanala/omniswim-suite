/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Parse a hand-written "scoring theory" file (relay squads + per-swimmer event plans) and
 * apply it onto a workspace as scorer flags, meet entry plans, and relay leg overrides.
 * Test: npx tsx scripts/test_scoring_theory.mjs
 */

import {
  ClassYear,
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  RelayLegOverride,
  ScorerRosterOverride,
  SwimmerResult,
  Workspace,
} from '../types';
import { isChampionshipProgramEvent, normalizeEventLabel } from './athleteHistory';
import { mergeScoringSettings } from './scoringDefaults';
import { scorerRosterKey, usesScorerRoster } from './scorerRoster';
import { relayEntryKey, parseRelayDistanceYards } from './relaySplits';
import { relayTemplateFromLeg, upsertRelayLegOverride } from './relayLegMatching';
import { countSwimmerEntries, swimmerExceedsEntryLimits } from './swimmerEntryLimits';
import { buildAliasResolver } from './athleteAliases';
import { buildWhatIfResults } from './whatIfProjection';
import {
  convertSwimToSCY,
  convertTimeToSeconds,
  foldDiacritics,
  hasConversionFactor,
  isRelayResult,
  normalizeSwimmerName,
} from './utils';
import { createPlannedEntry } from './whatIfProjection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TheorySquad = 'A' | 'B';

export type TheoryRelayLeg = {
  /** Primary assignee (first listed name). */
  name: string;
  /** Alternate names for this leg (e.g. "Colton/Hunter/Alan" → ["Hunter", "Alan"]). */
  alternates: string[];
};

export type TheoryRelay = {
  /** Normalized relay event label, e.g. "200 Medley Relay". */
  event: string;
  squad: TheorySquad;
  legs: TheoryRelayLeg[];
};

export type TheorySwimmer = {
  rawName: string;
  /** Normalized individual event labels (e.g. "500 Freestyle", "200 Individual Medley"). */
  events: string[];
};

export type TheoryOther = {
  rawName: string;
  note: string;
};

export type ParsedScoringTheory = {
  relays: TheoryRelay[];
  swimmers: TheorySwimmer[];
  others: TheoryOther[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Event abbreviation expander
// ---------------------------------------------------------------------------

const RELAY_EVENT_MAP: Record<string, string> = {
  '200 fr': '200 Freestyle Relay',
  '400 fr': '400 Freestyle Relay',
  '800 fr': '800 Freestyle Relay',
  '200 mr': '200 Medley Relay',
  '400 mr': '400 Medley Relay',
};

const STROKE_CODE_MAP: Record<string, string> = {
  '1fr': '100 Freestyle',
  '2fr': '200 Freestyle',
  '1fly': '100 Butterfly',
  '2fly': '200 Butterfly',
  '1back': '100 Backstroke',
  '2back': '200 Backstroke',
  '1br': '100 Breaststroke',
  '2br': '200 Breaststroke',
  '2im': '200 IM',
  '4im': '400 IM',
};

/**
 * Stroke word for the suffix of a "<distance><stroke>" token. A flat dispatch — every
 * key is an alternative of the same regex group, so no key takes precedence over another.
 */
const STROKE_SUFFIX_MAP: Record<string, string> = {
  fr: 'Freestyle',
  free: 'Freestyle',
  fly: 'Butterfly',
  back: 'Backstroke',
  br: 'Breaststroke',
  breast: 'Breaststroke',
  im: 'IM',
};

const BARE_DISTANCE = /^\d+$/;
const DISTANCE_AND_STROKE = /^(\d+)\s*(fr|free|fly|back|br|breast|im)$/;

/**
 * Reduce a raw theory token to its comparable form: trailing "?" stripped, the first
 * option of a slashed set ("1fr/2br" → "1fr"), lowercased, inner runs of whitespace
 * collapsed. Returns null for a token that carries no event ("", "?").
 */
function normalizeTheoryEventToken(raw: string): string | null {
  let t = raw.trim();
  if (!t || t === '?') return null;
  t = t.replace(/\?+$/, '').trim();
  if (!t) return null;
  if (t.includes('/')) t = t.split('/')[0].trim();
  const lower = t.toLowerCase().replace(/\s+/g, ' ');
  if (!lower || lower === '?') return null;
  return lower;
}

/**
 * Expand a scoring-theory event token to a normalized event label, or null when it should
 * be skipped ("?"). Bare distances default to freestyle ("50" → 50 Freestyle); stroke codes
 * like "1fly"/"2br"/"4IM" expand to their full labels; trailing "?" is stripped; a slashed
 * token ("1fr/2br") resolves to its first option.
 */
export function expandEventToken(raw: string): string | null {
  const lower = normalizeTheoryEventToken(raw);
  if (!lower) return null;

  if (STROKE_CODE_MAP[lower]) return normalizeEventLabel(STROKE_CODE_MAP[lower]);

  // Bare distance → freestyle (e.g. "50", "500", "1650").
  if (BARE_DISTANCE.test(lower)) return normalizeEventLabel(`${lower} Freestyle`);

  const m = lower.match(DISTANCE_AND_STROKE);
  if (!m) return null;
  return normalizeEventLabel(`${m[1]} ${STROKE_SUFFIX_MAP[m[2]]}`);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseRelayLegs(raw: string): TheoryRelayLeg[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(seg => {
      const parts = seg
        .split('/')
        .map(p => p.trim())
        .filter(Boolean);
      return { name: parts[0] ?? seg, alternates: parts.slice(1) };
    });
}

type Section = 'none' | 'relays' | 'possibilities' | 'others';

/** Section header prefixes, lowercased. Disjoint, so the scan order carries no rule. */
const SECTION_HEADERS: ReadonlyArray<readonly [string, Section]> = [
  ['scoring team relays', 'relays'],
  ['scoring team possibilities', 'possibilities'],
  ['other possibilities', 'others'],
];

/** "Name (a, b, c)" — used by both the swimmer and the "other possibilities" lines. */
const NAME_WITH_PARENS = /^(.+?)\s*\(([^)]*)\)\s*$/;
const RELAY_EVENT_HEADER = /^(\d{3,4})\s+(fr|mr)\b/i;
const RELAY_SQUAD_LINE = /^([ab])\s+(.+)$/i;

/** Accumulators for one parse, plus the relay event the current squad lines belong to. */
type TheoryParseState = {
  relays: TheoryRelay[];
  swimmers: TheorySwimmer[];
  others: TheoryOther[];
  warnings: string[];
  /** The relay event most recently opened by a header line inside the relay section. */
  relayEvent: string | null;
};

/** The section a header line opens, or null when the line is not a header. */
function sectionHeaderFor(lower: string): Section | null {
  for (const [prefix, section] of SECTION_HEADERS) {
    if (lower.startsWith(prefix)) return section;
  }
  return null;
}

/** One line in the relay section: an event header, a squad roster, or unrecognized. */
function parseRelaySectionLine(t: string, state: TheoryParseState): void {
  const header = t.match(RELAY_EVENT_HEADER);
  if (header) {
    const sig = `${header[1]} ${header[2].toLowerCase()}`;
    state.relayEvent = RELAY_EVENT_MAP[sig] ?? null;
    if (!state.relayEvent) state.warnings.push(`Unknown relay event "${t}"`);
    return;
  }
  const squad = t.match(RELAY_SQUAD_LINE);
  if (squad && state.relayEvent) {
    state.relays.push({
      event: state.relayEvent,
      squad: squad[1].toUpperCase() as TheorySquad,
      legs: parseRelayLegs(squad[2]),
    });
    return;
  }
  state.warnings.push(`Unrecognized relay line "${t}"`);
}

/** "Beni Bona (50, 100, 200 fr)" → name plus its normalized, deduped event labels. */
function parseSwimmerLine(t: string): TheorySwimmer | null {
  const m = t.match(NAME_WITH_PARENS);
  if (!m) return null;
  const events: string[] = [];
  for (const token of m[2].split(',')) {
    const ev = expandEventToken(token);
    if (ev && !events.includes(ev)) events.push(ev);
  }
  return { rawName: m[1].trim(), events };
}

/** "Tristin F (sprint fr)" → name plus its free-text note, kept verbatim. */
function parseOtherLine(t: string): TheoryOther | null {
  const m = t.match(NAME_WITH_PARENS);
  if (!m) return null;
  return { rawName: m[1].trim(), note: m[2].trim() };
}

/** Route one non-blank, non-header line to the handler for the section it sits in. */
function parseTheoryBodyLine(t: string, section: Section, state: TheoryParseState): void {
  if (section === 'relays') {
    parseRelaySectionLine(t, state);
    return;
  }
  if (section === 'possibilities') {
    const swimmer = parseSwimmerLine(t);
    if (swimmer) state.swimmers.push(swimmer);
    else state.warnings.push(`Unrecognized swimmer line "${t}"`);
    return;
  }
  if (section === 'others') {
    const other = parseOtherLine(t);
    if (other) state.others.push(other);
    else state.warnings.push(`Unrecognized other line "${t}"`);
  }
}

export function parseScoringTheory(text: string): ParsedScoringTheory {
  const state: TheoryParseState = {
    relays: [],
    swimmers: [],
    others: [],
    warnings: [],
    relayEvent: null,
  };
  let section: Section = 'none';

  for (const rawLine of text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;

    const header = sectionHeaderFor(t.toLowerCase());
    if (header) {
      section = header;
      // Re-entering the relay section starts a new event; squad lines before the
      // next header belong to no event and are reported, never guessed.
      if (header === 'relays') state.relayEvent = null;
      continue;
    }

    parseTheoryBodyLine(t, section, state);
  }

  const { relays, swimmers, others, warnings } = state;
  return { relays, swimmers, others, warnings };
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

/** Common theory nickname → roster first-name expansions (diacritic-folded, lowercase). */
const NICKNAMES: Record<string, string> = {
  beni: 'benedek',
  cam: 'camden',
  stevie: 'steven',
  mate: 'mate',
  oliver: 'oliver',
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

const NAME_MATCH_THRESHOLD = 0.6;

/** A normalized, diacritic-folded name split into the tokens the scorers compare. */
type FoldedName = {
  folded: string;
  parts: string[];
  /** First token, exactly as written. */
  first: string;
  /** Last token, or '' for a single-token name. */
  last: string;
};

/**
 * Fold and split one name. Deliberately does NOT expand nicknames: the roster side is
 * the authority on spelling, and expanding a roster first name would rewrite a real
 * swimmer called "Cam" into "Camden".
 */
function foldNameParts(raw: string): FoldedName {
  const folded = foldDiacritics(normalizeSwimmerName(raw));
  const parts = folded.split(' ').filter(Boolean);
  return {
    folded,
    parts,
    first: parts[0] ?? '',
    last: parts.length > 1 ? parts[parts.length - 1] : '',
  };
}

/** The theory-side name, with its nickname expansion and its "First L" shape flag. */
type TheoryQueryName = FoldedName & {
  /** First token after nickname expansion ("beni" → "benedek"). */
  firstExpanded: string;
  /** True for the "First L" form — a first name plus a bare surname initial. */
  isInitialForm: boolean;
};

function foldTheoryQuery(raw: string): TheoryQueryName {
  const base = foldNameParts(raw);
  return {
    ...base,
    firstExpanded: NICKNAMES[base.first] ?? base.first,
    isInitialForm: base.parts.length === 2 && base.parts[1].length === 1,
  };
}

/** The roster first name is the theory first name, under either spelling. */
function firstNamesAgree(query: TheoryQueryName, roster: FoldedName): boolean {
  return roster.first === query.firstExpanded || roster.first === query.first;
}

/** Theory name is a bare first name ("Beni"), as relay legs are written. */
function scoreSingleTokenQuery(query: TheoryQueryName, roster: FoldedName): number {
  if (firstNamesAgree(query, roster)) return 0.9;
  return similarity(query.firstExpanded, roster.first) * 0.8;
}

/** Theory name is "First L" — a first name plus a surname initial. */
function scoreInitialFormQuery(query: TheoryQueryName, roster: FoldedName): number {
  const firstOk =
    firstNamesAgree(query, roster) ||
    roster.first.startsWith(query.firstExpanded) ||
    query.firstExpanded.startsWith(roster.first);
  const initialOk = roster.last.startsWith(query.parts[1]);
  if (firstOk && initialOk) return 0.9;
  return similarity(query.folded, roster.folded) * 0.6;
}

/** Theory name carries a full surname: average first and last, floored by whole-string similarity. */
function scoreFullNameQuery(query: TheoryQueryName, roster: FoldedName): number {
  const firstScore = firstNamesAgree(query, roster)
    ? 1
    : similarity(query.firstExpanded, roster.first);
  const lastScore = query.last ? (roster.last === query.last ? 1 : similarity(query.last, roster.last)) : 0;
  const combined = 0.5 * firstScore + 0.5 * lastScore;
  return Math.max(combined, similarity(query.folded, roster.folded));
}

/**
 * Confidence that one roster name is the person a theory name refers to.
 *
 * An ordered chain, not a lookup table: an exact fold wins outright, and the remaining
 * rules are selected by how many tokens the theory name has, which is itself the rule.
 */
function scoreTheoryNameAgainstRoster(query: TheoryQueryName, roster: FoldedName): number {
  if (roster.folded === query.folded) return 1;
  if (query.parts.length === 1) return scoreSingleTokenQuery(query, roster);
  if (query.isInitialForm) return scoreInitialFormQuery(query, roster);
  return scoreFullNameQuery(query, roster);
}

/**
 * Resolve a theory name (relay leg first-name, nickname, misspelled surname, or "First L"
 * form) to a roster name. Uses diacritic folding, nickname expansion, initial matching, and
 * fuzzy similarity. Returns `{ match: null }` when the best confidence is below a sane
 * threshold — unresolvable names should be warned, never guessed.
 */
export function resolveTheoryName(
  rawName: string,
  rosterNames: string[]
): { match: string | null; confidence: number } {
  const query = foldTheoryQuery(rawName);
  if (!query.folded) return { match: null, confidence: 0 };

  let best: { match: string | null; confidence: number } = { match: null, confidence: 0 };
  for (const roster of rosterNames) {
    const score = scoreTheoryNameAgainstRoster(query, foldNameParts(roster));
    if (score > best.confidence) best = { match: roster, confidence: score };
  }

  if (best.confidence < NAME_MATCH_THRESHOLD) {
    return { match: null, confidence: best.confidence };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Apply onto workspace
// ---------------------------------------------------------------------------

export type ApplyScoringTheoryOpts = {
  team: string;
  gender: Gender;
  classYearOverrides?: Record<string, ClassYear>;
};

export type ScoringTheoryApplyResult = {
  patch: Partial<Workspace>;
  summary: {
    scorersMarked: number;
    entriesAdded: number;
    relayLegsAssigned: number;
    resolvedSwimmers: Array<{ rawName: string; matched: string | null; confidence: number }>;
    relayAlternates: Array<{
      event: string;
      squad: TheorySquad;
      legIndex: number;
      chosen: string;
      alternates: string[];
    }>;
  };
  warnings: string[];
};

/** The result rows for one gender. Both arrays are optional on a workspace. */
function resultsForGender(workspace: Workspace, gender: Gender): SwimmerResult[] {
  return gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
}

/**
 * A result row belongs to this team's gender squad. The team string is trimmed, and a
 * row with no recorded gender is accepted — some parsed meets omit it on individual rows.
 */
function resultRowIsForTeam(r: SwimmerResult, team: string, gender: Gender): boolean {
  if (String(r.team ?? '').trim() !== team) return false;
  return r.gender == null || r.gender === gender;
}

/**
 * A recruit or history row belongs to this team's gender squad. Stricter than the
 * result-row test on purpose: both fields are required on these types, so an exact
 * match is the right test and a missing gender is not a match.
 */
function rosterRowIsForTeam(row: { team: string; gender: Gender }, team: string, gender: Gender): boolean {
  return row.gender === gender && row.team === team;
}

/** A relay placeholder row carries the team name in the swimmer slot. Not a person. */
function isRelayPlaceholderRow(r: SwimmerResult): boolean {
  return Boolean(r.isRelay) && r.name === r.team;
}

function rosterNamesForTeam(workspace: Workspace, team: string, gender: Gender): string[] {
  const names = new Set<string>();
  for (const r of resultsForGender(workspace, gender)) {
    if (!resultRowIsForTeam(r, team, gender)) continue;
    if (isRelayPlaceholderRow(r)) continue;
    names.add(r.name);
  }
  for (const r of workspace.recruits ?? []) {
    if (rosterRowIsForTeam(r, team, gender)) names.add(r.name);
  }
  for (const s of workspace.athleteHistory ?? []) {
    if (rosterRowIsForTeam(s, team, gender)) names.add(s.name);
  }
  return [...names];
}

function relaySignature(event: string): string {
  const dist = parseRelayDistanceYards(event);
  const kind = /medley/i.test(event) ? 'mr' : 'fr';
  return `${dist} ${kind}`;
}

function buildClassYearLookup(overrides?: Record<string, ClassYear>): Map<string, ClassYear> {
  const map = new Map<string, ClassYear>();
  if (!overrides) return map;
  for (const [rawName, year] of Object.entries(overrides)) {
    const norm = normalizeSwimmerName(rawName);
    if (!map.has(norm)) map.set(norm, year);
    const folded = foldDiacritics(norm);
    if (!map.has(folded)) map.set(folded, year);
  }
  return map;
}

function lookupClassYear(map: Map<string, ClassYear>, name: string): ClassYear | undefined {
  const norm = normalizeSwimmerName(name);
  return map.get(norm) ?? map.get(foldDiacritics(norm));
}

/** An individual (non-relay) meet result swum by this athlete for this team's squad. */
function isIndividualResultFor(
  r: SwimmerResult,
  team: string,
  gender: Gender,
  nameKey: string
): boolean {
  if (!resultRowIsForTeam(r, team, gender)) return false;
  if (normalizeSwimmerName(r.name) !== nameKey) return false;
  return !isRelayResult(r);
}

/** An individual (non-relay) planned entry held by this athlete for this team's squad. */
function isIndividualPlanFor(
  p: PlannedSwimEntry,
  team: string,
  gender: Gender,
  nameKey: string
): boolean {
  if (p.team !== team || p.gender !== gender) return false;
  if (normalizeSwimmerName(p.name) !== nameKey) return false;
  return !/\brelay\b/i.test(p.event);
}

/**
 * Individual events this athlete already holds — from meet results and from planned
 * entries. Read at the point of use, so entries added earlier in the same apply count
 * against the cap for a later theory line naming the same athlete.
 */
function existingIndividualEvents(
  results: SwimmerResult[],
  plans: PlannedSwimEntry[],
  team: string,
  gender: Gender,
  name: string
): Set<string> {
  const nameKey = normalizeSwimmerName(name);
  const events = new Set<string>();
  for (const r of results) {
    if (isIndividualResultFor(r, team, gender, nameKey) && r.event) events.add(r.event);
  }
  for (const p of plans) {
    if (isIndividualPlanFor(p, team, gender, nameKey)) events.add(p.event);
  }
  return events;
}

/**
 * The SCY program event and time one history row contributes, or null when it
 * contributes nothing.
 *
 * A non-SCY swim with no published conversion factor has no SCY equivalent, so it is
 * dropped rather than estimated. An event outside the championship program is dropped
 * too — it is not an entry candidate.
 */
function programSwimFromHistory(s: HistoricalSwim): { event: string; time: string } | null {
  const relay = /\brelay\b/i.test(s.event);
  if (!relay && (s.timeType ?? 'SCY') !== 'SCY' && !hasConversionFactor(s.event)) return null;
  const { event, time } = relay
    ? { event: s.event, time: s.time }
    : convertSwimToSCY(s.event, s.time, s.gender, s.timeType ?? 'SCY');
  if (!isChampionshipProgramEvent(event)) return null;
  return { event, time };
}

/**
 * Best SCY-converted program time per `${normalizedName}|${event}` from athleteHistory.
 * On an exact tie the first row encountered wins — the fold keeps the incumbent.
 */
function buildHistoryBestTimes(
  workspace: Workspace,
  team: string,
  gender: Gender
): Map<string, string> {
  const best = new Map<string, string>();
  for (const s of workspace.athleteHistory ?? []) {
    if (s.gender !== gender || String(s.team ?? '').trim() !== team) continue;
    const swim = programSwimFromHistory(s);
    if (!swim) continue;
    const key = `${normalizeSwimmerName(s.name)}|${swim.event}`;
    const prev = best.get(key);
    if (!prev || convertTimeToSeconds(swim.time) < convertTimeToSeconds(prev)) {
      best.set(key, swim.time);
    }
  }
  return best;
}

/** Class year recorded on this athlete's recruit row for this team's squad, if any. */
function recruitClassYearFor(
  workspace: Workspace,
  team: string,
  gender: Gender,
  name: string
): ClassYear | undefined {
  const nameKey = normalizeSwimmerName(name);
  return (workspace.recruits ?? []).find(
    r => r.team === team && r.gender === gender && normalizeSwimmerName(r.name) === nameKey
  )?.classYear;
}

/** Everything resolved once per apply and read by every step of it. */
type TheoryApplyContext = {
  team: string;
  gender: Gender;
  /** Individual-entry cap: the tighter of the individual cap and the total cap. */
  indCap: number;
  /** Roster-mode scoring — a theory swimmer gets an explicit scorer flag. */
  rosterMode: boolean;
  results: SwimmerResult[];
  rosterNames: string[];
  historyBest: Map<string, string>;
  /** Class year for a planned entry: caller override first, then the recruit row. */
  classYearForEntry: (name: string) => ClassYear | undefined;
  /**
   * Class year for a relay leg override: caller override ONLY.
   * Deliberately narrower than `classYearForEntry` — a relay leg does not inherit the
   * recruit-row fallback. Preserved as found; see the findings note on this asymmetry.
   */
  classYearForRelayLeg: (name: string) => ClassYear | undefined;
};

/** The workspace arrays this apply is building, plus the running summary and warnings. */
type TheoryApplyDraft = {
  meetEntryPlans: PlannedSwimEntry[];
  activeEntryIds: string[];
  scorerOverrides: ScorerRosterOverride[];
  relayOverrides: RelayLegOverride[];
  summary: ScoringTheoryApplyResult['summary'];
  warnings: string[];
};

function buildTheoryApplyContext(
  workspace: Workspace,
  team: string,
  opts: ApplyScoringTheoryOpts
): TheoryApplyContext {
  const gender = opts.gender;
  const settings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const classYearMap = buildClassYearLookup(opts.classYearOverrides);
  return {
    team,
    gender,
    indCap: Math.min(
      settings.maxIndividualEntriesPerSwimmer ?? 3,
      settings.maxTotalEntriesPerSwimmer ?? 999
    ),
    rosterMode: usesScorerRoster(settings),
    results: resultsForGender(workspace, gender),
    rosterNames: rosterNamesForTeam(workspace, team, gender),
    historyBest: buildHistoryBestTimes(workspace, team, gender),
    classYearForEntry: name =>
      lookupClassYear(classYearMap, name) ?? recruitClassYearFor(workspace, team, gender, name),
    classYearForRelayLeg: name => lookupClassYear(classYearMap, name),
  };
}

/**
 * Why this theory event cannot become a planned entry, as the warning to report, or
 * null when it can.
 *
 * An ordered chain, not a table: the checks run in the order a coach would apply them,
 * and the first one that fires is the reason reported. Reordering them would change
 * which warning a swimmer sees.
 */
function theoryEntryBlocker(
  displayName: string,
  event: string,
  already: Set<string>,
  indCap: number,
  time: string | undefined
): string | null {
  if (!isChampionshipProgramEvent(event)) {
    return `Skipped non-program event "${event}" for ${displayName}`;
  }
  if (already.has(event)) {
    return `${displayName} already has a plan for ${event} — skipped`;
  }
  if (already.size >= indCap) {
    return `${displayName} at individual entry cap (${indCap}) — skipped ${event}`;
  }
  if (!time) {
    return `No history time for ${displayName} in ${event} — skipped`;
  }
  return null;
}

/** Flag one athlete as a scorer, replacing any prior flag against the same identity. */
function withScorerMarked(
  overrides: ScorerRosterOverride[],
  team: string,
  gender: Gender,
  name: string
): ScorerRosterOverride[] {
  const key = scorerRosterKey(team, gender, name);
  return [
    ...overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key),
    { name, team, gender, isScorer: true },
  ];
}

/**
 * Add the planned entries one theory swimmer's event list earns, under the entry cap.
 * Times come from history — an event with no history time is warned, never invented.
 */
function addTheoryEntries(
  ctx: TheoryApplyContext,
  draft: TheoryApplyDraft,
  displayName: string,
  events: string[]
): void {
  const classYear = ctx.classYearForEntry(displayName);
  const already = existingIndividualEvents(
    ctx.results,
    draft.meetEntryPlans,
    ctx.team,
    ctx.gender,
    displayName
  );
  const nameKey = normalizeSwimmerName(displayName);

  for (const event of events) {
    const time = ctx.historyBest.get(`${nameKey}|${event}`);
    const blocked = theoryEntryBlocker(displayName, event, already, ctx.indCap, time);
    if (blocked) {
      draft.warnings.push(blocked);
      continue;
    }
    const entry = createPlannedEntry({
      name: displayName,
      team: ctx.team,
      gender: ctx.gender,
      classYear,
      event,
      // theoryEntryBlocker returns a reason when the time is missing, so it is set here.
      time: time as string,
      timeType: 'SCY',
      source: 'optimizer',
      active: true,
    });
    draft.meetEntryPlans.push(entry);
    draft.activeEntryIds.push(entry.id);
    already.add(event);
    draft.summary.entriesAdded += 1;
  }
}

/** Resolve one theory swimmer against the roster, flag them, and plan their events. */
function applyTheorySwimmer(
  ctx: TheoryApplyContext,
  draft: TheoryApplyDraft,
  sw: TheorySwimmer
): void {
  const resolved = resolveTheoryName(sw.rawName, ctx.rosterNames);
  draft.summary.resolvedSwimmers.push({
    rawName: sw.rawName,
    matched: resolved.match,
    confidence: resolved.confidence,
  });
  if (!resolved.match) {
    draft.warnings.push(`Could not resolve swimmer "${sw.rawName}"`);
    return;
  }

  if (ctx.rosterMode) {
    draft.scorerOverrides = withScorerMarked(
      draft.scorerOverrides,
      ctx.team,
      ctx.gender,
      resolved.match
    );
    draft.summary.scorersMarked += 1;
  }

  addTheoryEntries(ctx, draft, resolved.match, sw.events);
}

/**
 * Existing relay entries for this team's gender squad, grouped by event signature and
 * ordered by finishing rank — squad A attaches to the fastest entry, squad B to the next.
 */
function indexRelayTemplatesBySignature(
  results: SwimmerResult[],
  team: string,
  gender: Gender
): Map<string, SwimmerResult[]> {
  const bySig = new Map<string, SwimmerResult[]>();
  const seenKeys = new Set<string>();
  for (const r of results) {
    if (!isRelayResult(r)) continue;
    if (!resultRowIsForTeam(r, team, gender)) continue;
    const template = relayTemplateFromLeg(results, r);
    const key = relayEntryKey(template);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const sig = relaySignature(template.event);
    const list = bySig.get(sig) ?? [];
    list.push(template);
    bySig.set(sig, list);
  }
  for (const list of bySig.values()) {
    list.sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999));
  }
  return bySig;
}

/**
 * Roster names for a leg's alternates, in theory order, deduped. An alternate that does
 * not resolve is dropped — never guessed — but the theory spelling still reaches the
 * summary for display.
 */
function resolveLegAlternates(alternates: string[], rosterNames: string[]): string[] {
  const resolved: string[] = [];
  for (const alt of alternates) {
    const match = resolveTheoryName(alt, rosterNames).match;
    if (match && !resolved.includes(match)) resolved.push(match);
  }
  return resolved;
}

/**
 * Assign one theory relay leg onto an existing relay entry.
 *
 * Alternates are persisted on the override (additive) so suggestRelayAlternatePromotions
 * can auto-fill this leg later when the primary becomes unavailable.
 */
function assignRelayLeg(
  ctx: TheoryApplyContext,
  draft: TheoryApplyDraft,
  relay: TheoryRelay,
  entryKey: string,
  leg: TheoryRelayLeg,
  legIndex: number
): void {
  const resolved = resolveTheoryName(leg.name, ctx.rosterNames);
  if (!resolved.match) {
    draft.warnings.push(
      `Could not resolve relay leg "${leg.name}" (${relay.event} ${relay.squad})`
    );
    return;
  }

  const resolvedAlternates = resolveLegAlternates(leg.alternates, ctx.rosterNames);
  draft.relayOverrides = upsertRelayLegOverride(draft.relayOverrides, {
    relayEntryKey: entryKey,
    legIndex,
    assigneeName: resolved.match,
    classYear: ctx.classYearForRelayLeg(resolved.match),
    source: 'manual',
    ...(resolvedAlternates.length > 0 ? { alternates: resolvedAlternates } : {}),
  });
  draft.summary.relayLegsAssigned += 1;

  if (leg.alternates.length > 0) {
    draft.summary.relayAlternates.push({
      event: relay.event,
      squad: relay.squad,
      legIndex,
      chosen: resolved.match,
      alternates: leg.alternates,
    });
  }
}

/** Attach one theory relay squad's legs to the matching existing relay entry. */
function applyTheoryRelay(
  ctx: TheoryApplyContext,
  draft: TheoryApplyDraft,
  templatesBySig: Map<string, SwimmerResult[]>,
  relay: TheoryRelay
): void {
  const list = templatesBySig.get(relaySignature(relay.event)) ?? [];
  const template = relay.squad === 'A' ? list[0] : list[1];
  if (!template) {
    draft.warnings.push(
      `No existing ${relay.event} relay entry to attach squad ${relay.squad} — leg assignments skipped`
    );
    return;
  }
  const entryKey = relayEntryKey(template);
  relay.legs.forEach((leg, legIndex) =>
    assignRelayLeg(ctx, draft, relay, entryKey, leg, legIndex)
  );
}

/**
 * Apply a parsed scoring theory onto a workspace. Marks resolved swimmers as scorers,
 * creates meetEntryPlans (best SCY-converted time from athleteHistory) up to the individual
 * entry cap, and fills relay leg assignments via RelayLegOverride against existing relay
 * entries. Only adds/updates entries it owns — never deletes or overwrites user data; skips
 * (with a warning) any swimmer already holding a conflicting plan for the same event.
 */
export function applyScoringTheory(
  workspace: Workspace,
  parsed: ParsedScoringTheory,
  opts: ApplyScoringTheoryOpts
): ScoringTheoryApplyResult {
  const team = opts.team.trim();
  const summary: ScoringTheoryApplyResult['summary'] = {
    scorersMarked: 0,
    entriesAdded: 0,
    relayLegsAssigned: 0,
    resolvedSwimmers: [],
    relayAlternates: [],
  };

  if (!team) {
    return { patch: {}, summary, warnings: ['Team is required'] };
  }

  const ctx = buildTheoryApplyContext(workspace, team, opts);
  const draft: TheoryApplyDraft = {
    meetEntryPlans: [...(workspace.meetEntryPlans ?? [])],
    activeEntryIds: [...(workspace.activeEntryIds ?? [])],
    scorerOverrides: [...(workspace.scorerRosterOverrides ?? [])],
    relayOverrides: [...(workspace.relayLegOverrides ?? [])],
    summary,
    warnings: [],
  };

  // Swimmers first: their new plans count against the entry cap the relay step reads.
  for (const sw of parsed.swimmers) applyTheorySwimmer(ctx, draft, sw);

  const templatesBySig = indexRelayTemplatesBySignature(ctx.results, team, ctx.gender);
  for (const relay of parsed.relays) applyTheoryRelay(ctx, draft, templatesBySig, relay);

  const patch: Partial<Workspace> = {
    meetEntryPlans: draft.meetEntryPlans,
    activeEntryIds: draft.activeEntryIds,
    relayLegOverrides: draft.relayOverrides,
  };
  if (ctx.rosterMode) patch.scorerRosterOverrides = draft.scorerOverrides;

  return { patch, summary, warnings: draft.warnings };
}

// ---------------------------------------------------------------------------
// Theory-alternate auto-fill
// ---------------------------------------------------------------------------

export type RelayAlternateReason = 'soft_removed' | 'over_entry_cap' | 'missing_from_roster';

export type RelayAlternatePromotion = {
  relayEntryKey: string;
  /** Relay event label (parsed from the entry key). */
  relayEvent: string;
  legIndex: number;
  /** The (unavailable) primary assignee this promotion replaces. */
  primary: string;
  /** The first available alternate promoted onto the leg. */
  alternate: string;
  reason: RelayAlternateReason;
  patch: Partial<Workspace>;
  inverse: Partial<Workspace>;
  description: string;
};

/** How each reason reads in a suggestion's description. A flat dispatch — no ordering. */
const PROMOTION_REASON_LABELS: Record<RelayAlternateReason, string> = {
  soft_removed: 'soft-removed',
  over_entry_cap: 'over entry cap',
  missing_from_roster: 'off roster',
};

/** An override that records scoring-theory alternates for one of this team's relay entries. */
function hasTheoryAlternatesForTeam(o: RelayLegOverride, team: string): boolean {
  if (!Array.isArray(o.alternates) || o.alternates.length === 0) return false;
  return String(o.relayEntryKey.split('|')[0] ?? '').trim() === team;
}

/** null when available; otherwise why the swimmer is unavailable. */
type AvailabilityCheck = (name: string) => RelayAlternateReason | null;

/**
 * Build the availability check for one scan. Everything it reads — roster keys, the
 * soft-removed set, the projected entry pool, the alias resolver — is computed once
 * here rather than per candidate name.
 *
 * The three checks are an ordered chain, not a table: their precedence is itself a
 * rule. A swimmer who is both soft-removed and off the roster reports the soft-remove,
 * because that is the decision a coach made rather than a data gap.
 */
function buildAvailabilityCheck(
  workspace: Workspace,
  team: string,
  gender: Gender
): AvailabilityCheck {
  const settings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const rosterKeys = new Set(
    rosterNamesForTeam(workspace, team, gender).map(n => normalizeSwimmerName(n))
  );
  const deleted = new Set(
    (workspace.deletedSwimmers ?? [])
      .filter(d => d.gender === gender)
      .map(d => normalizeSwimmerName(d.name))
  );
  // Projected pool (results + active plans + recruits) for entry-cap counting.
  const pool = buildWhatIfResults({ workspace, gender, removeSeniors: false });
  // One resolver for the whole scan, not one per candidate name. A relay
  // alternate written in the theory file under the other spelling of a linked
  // athlete must be counted against the SAME cap as the primary — otherwise the
  // promotion "fills" a leg with someone already at their entry limit.
  const resolver = buildAliasResolver(workspace);

  const isOverCap = (name: string): boolean => {
    const counts = countSwimmerEntries(pool, team, gender, name, resolver);
    const over = swimmerExceedsEntryLimits(counts, settings);
    return over.individualOver || over.totalOver;
  };

  return (name: string): RelayAlternateReason | null => {
    const key = normalizeSwimmerName(name);
    if (deleted.has(key)) return 'soft_removed';
    if (!rosterKeys.has(key)) return 'missing_from_roster';
    if (isOverCap(name)) return 'over_entry_cap';
    return null;
  };
}

/**
 * The promotion this override earns, or null when it earns none — the primary is still
 * available, the leg has no assignee, or no alternate is available either.
 */
function promotionForOverride(
  override: RelayLegOverride,
  allOverrides: RelayLegOverride[],
  isUnavailable: AvailabilityCheck
): RelayAlternatePromotion | null {
  const primary = override.assigneeName;
  if (!primary) return null;
  const reason = isUnavailable(primary);
  if (!reason) return null;

  const alternate = (override.alternates ?? []).find(a => isUnavailable(a) === null);
  if (!alternate) return null;

  const relayEvent = override.relayEntryKey.split('|')[1] ?? '';
  const next: RelayLegOverride = { ...override, assigneeName: alternate, source: 'autofill' };
  return {
    relayEntryKey: override.relayEntryKey,
    relayEvent,
    legIndex: override.legIndex,
    primary,
    alternate,
    reason,
    patch: { relayLegOverrides: upsertRelayLegOverride(allOverrides, next) },
    inverse: { relayLegOverrides: allOverrides },
    description:
      `${relayEvent} leg ${override.legIndex + 1}: promote ${alternate} for ${primary} ` +
      `(${PROMOTION_REASON_LABELS[reason]})`,
  };
}

/**
 * For each relay leg whose scoring-theory-recorded primary has become unavailable
 * — soft-removed (in deletedSwimmers), over the individual entry cap in a way that
 * voids their entries, or no longer on the roster — suggest promoting the first
 * still-available alternate (persisted on the RelayLegOverride by applyScoringTheory).
 * Each suggestion carries a ready `{ patch, inverse, description }` that upserts the
 * override to the alternate (same undo-able contract as applyExactSwap); the inverse
 * restores the full prior relayLegOverrides array (exact round-trip). Read-only —
 * no mutation.
 */
export function suggestRelayAlternatePromotions(
  workspace: Workspace,
  opts: { team: string; gender: Gender }
): RelayAlternatePromotion[] {
  const team = opts.team.trim();
  const overrides = workspace.relayLegOverrides ?? [];
  const withAlternates = overrides.filter(o => hasTheoryAlternatesForTeam(o, team));
  // Before building the projected pool: it is the expensive part of this scan.
  if (withAlternates.length === 0) return [];

  const isUnavailable = buildAvailabilityCheck(workspace, team, opts.gender);

  const suggestions: RelayAlternatePromotion[] = [];
  for (const override of withAlternates) {
    const promotion = promotionForOverride(override, overrides, isUnavailable);
    if (promotion) suggestions.push(promotion);
  }
  return suggestions;
}
