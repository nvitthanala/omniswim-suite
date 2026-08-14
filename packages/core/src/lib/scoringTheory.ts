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
 * Expand a scoring-theory event token to a normalized event label, or null when it should
 * be skipped ("?"). Bare distances default to freestyle ("50" → 50 Freestyle); stroke codes
 * like "1fly"/"2br"/"4IM" expand to their full labels; trailing "?" is stripped; a slashed
 * token ("1fr/2br") resolves to its first option.
 */
export function expandEventToken(raw: string): string | null {
  let t = raw.trim();
  if (!t || t === '?') return null;
  t = t.replace(/\?+$/, '').trim();
  if (!t) return null;
  if (t.includes('/')) t = t.split('/')[0].trim();
  const lower = t.toLowerCase().replace(/\s+/g, ' ');
  if (!lower || lower === '?') return null;

  if (STROKE_CODE_MAP[lower]) return normalizeEventLabel(STROKE_CODE_MAP[lower]);

  // Bare distance → freestyle (e.g. "50", "500", "1650").
  if (/^\d+$/.test(lower)) return normalizeEventLabel(`${lower} Freestyle`);

  // "<num> fr|fly|back|br|im"
  const m = lower.match(/^(\d+)\s*(fr|free|fly|back|br|breast|im)$/);
  if (m) {
    const dist = m[1];
    const stroke = m[2];
    const strokeLabel =
      stroke === 'fr' || stroke === 'free'
        ? 'Freestyle'
        : stroke === 'fly'
          ? 'Butterfly'
          : stroke === 'back'
            ? 'Backstroke'
            : stroke === 'br' || stroke === 'breast'
              ? 'Breaststroke'
              : 'IM';
    return normalizeEventLabel(`${dist} ${strokeLabel}`);
  }

  return null;
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

export function parseScoringTheory(text: string): ParsedScoringTheory {
  const relays: TheoryRelay[] = [];
  const swimmers: TheorySwimmer[] = [];
  const others: TheoryOther[] = [];
  const warnings: string[] = [];

  let section: Section = 'none';
  let currentRelayEvent: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    const lower = t.toLowerCase();

    if (lower.startsWith('scoring team relays')) {
      section = 'relays';
      currentRelayEvent = null;
      continue;
    }
    if (lower.startsWith('scoring team possibilities')) {
      section = 'possibilities';
      continue;
    }
    if (lower.startsWith('other possibilities')) {
      section = 'others';
      continue;
    }

    if (section === 'relays') {
      const header = t.match(/^(\d{3,4})\s+(fr|mr)\b/i);
      if (header) {
        const sig = `${header[1]} ${header[2].toLowerCase()}`;
        currentRelayEvent = RELAY_EVENT_MAP[sig] ?? null;
        if (!currentRelayEvent) warnings.push(`Unknown relay event "${t}"`);
        continue;
      }
      const squad = t.match(/^([ab])\s+(.+)$/i);
      if (squad && currentRelayEvent) {
        relays.push({
          event: currentRelayEvent,
          squad: squad[1].toUpperCase() as TheorySquad,
          legs: parseRelayLegs(squad[2]),
        });
        continue;
      }
      warnings.push(`Unrecognized relay line "${t}"`);
      continue;
    }

    if (section === 'possibilities') {
      const m = t.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
      if (!m) {
        warnings.push(`Unrecognized swimmer line "${t}"`);
        continue;
      }
      const rawName = m[1].trim();
      const events: string[] = [];
      for (const token of m[2].split(',')) {
        const ev = expandEventToken(token);
        if (ev && !events.includes(ev)) events.push(ev);
      }
      swimmers.push({ rawName, events });
      continue;
    }

    if (section === 'others') {
      const m = t.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
      if (!m) {
        warnings.push(`Unrecognized other line "${t}"`);
        continue;
      }
      others.push({ rawName: m[1].trim(), note: m[2].trim() });
      continue;
    }
  }

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
  const rawFolded = foldDiacritics(normalizeSwimmerName(rawName));
  if (!rawFolded) return { match: null, confidence: 0 };
  const rawParts = rawFolded.split(' ').filter(Boolean);
  const rawFirstRaw = rawParts[0] ?? '';
  const rawFirst = NICKNAMES[rawFirstRaw] ?? rawFirstRaw;
  const rawLast = rawParts.length > 1 ? rawParts[rawParts.length - 1] : '';
  const isInitialForm = rawParts.length === 2 && rawParts[1].length === 1;

  let best: { match: string | null; confidence: number } = { match: null, confidence: 0 };

  for (const roster of rosterNames) {
    const rFolded = foldDiacritics(normalizeSwimmerName(roster));
    const rParts = rFolded.split(' ').filter(Boolean);
    const rFirst = rParts[0] ?? '';
    const rLast = rParts.length > 1 ? rParts[rParts.length - 1] : '';

    let score = 0;
    if (rFolded === rawFolded) {
      score = 1;
    } else if (rawParts.length === 1) {
      if (rFirst === rawFirst || rFirst === rawFirstRaw) score = 0.9;
      else score = similarity(rawFirst, rFirst) * 0.8;
    } else if (isInitialForm) {
      const firstOk =
        rFirst === rawFirst ||
        rFirst === rawFirstRaw ||
        rFirst.startsWith(rawFirst) ||
        rawFirst.startsWith(rFirst);
      const initialOk = rLast.startsWith(rawParts[1]);
      score = firstOk && initialOk ? 0.9 : similarity(rawFolded, rFolded) * 0.6;
    } else {
      const firstScore = rFirst === rawFirst || rFirst === rawFirstRaw ? 1 : similarity(rawFirst, rFirst);
      const lastScore = rawLast ? (rLast === rawLast ? 1 : similarity(rawLast, rLast)) : 0;
      const combined = 0.5 * firstScore + 0.5 * lastScore;
      score = Math.max(combined, similarity(rawFolded, rFolded));
    }

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

function rosterNamesForTeam(workspace: Workspace, team: string, gender: Gender): string[] {
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const names = new Set<string>();
  for (const r of results) {
    if (String(r.team ?? '').trim() !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    if (r.isRelay && r.name === r.team) continue;
    names.add(r.name);
  }
  for (const r of workspace.recruits ?? []) {
    if (r.gender !== gender || r.team !== team) continue;
    names.add(r.name);
  }
  for (const s of workspace.athleteHistory ?? []) {
    if (s.gender !== gender || s.team !== team) continue;
    names.add(s.name);
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
  const gender = opts.gender;
  const warnings: string[] = [];
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

  const settings = mergeScoringSettings(workspace.scoringSettings, { conference: workspace.conference });
  const indCap = Math.min(
    settings.maxIndividualEntriesPerSwimmer ?? 3,
    settings.maxTotalEntriesPerSwimmer ?? 999
  );
  const roster = usesScorerRoster(settings);

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const rosterNames = rosterNamesForTeam(workspace, team, gender);
  const classYearMap = buildClassYearLookup(opts.classYearOverrides);

  // Best SCY-converted program time per (swimmer, event) from athleteHistory.
  const histBest = new Map<string, string>();
  for (const s of workspace.athleteHistory ?? []) {
    if (s.gender !== gender || String(s.team ?? '').trim() !== team) continue;
    const relay = /\brelay\b/i.test(s.event);
    // No published factor → no SCY equivalent. Non-program events only; the
    // championship filter on the next line rejects them regardless.
    if (!relay && (s.timeType ?? 'SCY') !== 'SCY' && !hasConversionFactor(s.event)) continue;
    const { event, time } = relay
      ? { event: s.event, time: s.time }
      : convertSwimToSCY(s.event, s.time, s.gender, s.timeType ?? 'SCY');
    if (!isChampionshipProgramEvent(event)) continue;
    const key = `${normalizeSwimmerName(s.name)}|${event}`;
    const prev = histBest.get(key);
    if (!prev || convertTimeToSeconds(time) < convertTimeToSeconds(prev)) histBest.set(key, time);
  }

  const meetEntryPlans: PlannedSwimEntry[] = [...(workspace.meetEntryPlans ?? [])];
  const activeEntryIds: string[] = [...(workspace.activeEntryIds ?? [])];
  let overrides: ScorerRosterOverride[] = [...(workspace.scorerRosterOverrides ?? [])];
  let relayOverrides: RelayLegOverride[] = [...(workspace.relayLegOverrides ?? [])];

  const recruitClassYear = (name: string): ClassYear | undefined => {
    const key = normalizeSwimmerName(name);
    return (workspace.recruits ?? []).find(
      r => r.team === team && r.gender === gender && normalizeSwimmerName(r.name) === key
    )?.classYear;
  };

  const existingIndEvents = (name: string): Set<string> => {
    const key = normalizeSwimmerName(name);
    const set = new Set<string>();
    for (const r of results) {
      if (String(r.team ?? '').trim() !== team) continue;
      if (r.gender != null && r.gender !== gender) continue;
      if (normalizeSwimmerName(r.name) !== key) continue;
      if (isRelayResult(r)) continue;
      if (r.event) set.add(r.event);
    }
    for (const p of meetEntryPlans) {
      if (p.team !== team || p.gender !== gender) continue;
      if (normalizeSwimmerName(p.name) !== key) continue;
      if (/\brelay\b/i.test(p.event)) continue;
      set.add(p.event);
    }
    return set;
  };

  // --- Individual swimmers ---
  for (const sw of parsed.swimmers) {
    const resolved = resolveTheoryName(sw.rawName, rosterNames);
    summary.resolvedSwimmers.push({
      rawName: sw.rawName,
      matched: resolved.match,
      confidence: resolved.confidence,
    });
    if (!resolved.match) {
      warnings.push(`Could not resolve swimmer "${sw.rawName}"`);
      continue;
    }
    const displayName = resolved.match;
    const classYear = lookupClassYear(classYearMap, displayName) ?? recruitClassYear(displayName);

    if (roster) {
      const key = scorerRosterKey(team, gender, displayName);
      overrides = [
        ...overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key),
        { name: displayName, team, gender, isScorer: true },
      ];
      summary.scorersMarked += 1;
    }

    const already = existingIndEvents(displayName);
    for (const event of sw.events) {
      if (!isChampionshipProgramEvent(event)) {
        warnings.push(`Skipped non-program event "${event}" for ${displayName}`);
        continue;
      }
      if (already.has(event)) {
        warnings.push(`${displayName} already has a plan for ${event} — skipped`);
        continue;
      }
      if (already.size >= indCap) {
        warnings.push(`${displayName} at individual entry cap (${indCap}) — skipped ${event}`);
        continue;
      }
      const time = histBest.get(`${normalizeSwimmerName(displayName)}|${event}`);
      if (!time) {
        warnings.push(`No history time for ${displayName} in ${event} — skipped`);
        continue;
      }
      const entry = createPlannedEntry({
        name: displayName,
        team,
        gender,
        classYear,
        event,
        time,
        timeType: 'SCY',
        source: 'optimizer',
        active: true,
      });
      meetEntryPlans.push(entry);
      activeEntryIds.push(entry.id);
      already.add(event);
      summary.entriesAdded += 1;
    }
  }

  // --- Relays ---
  const templatesBySig = new Map<string, SwimmerResult[]>();
  const seenKeys = new Set<string>();
  for (const r of results) {
    if (!isRelayResult(r)) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    const template = relayTemplateFromLeg(results, r);
    const key = relayEntryKey(template);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const sig = relaySignature(template.event);
    const list = templatesBySig.get(sig) ?? [];
    list.push(template);
    templatesBySig.set(sig, list);
  }
  for (const list of templatesBySig.values()) {
    list.sort((a, b) => (Number(a.rank) || 999) - (Number(b.rank) || 999));
  }

  for (const relay of parsed.relays) {
    const sig = relaySignature(relay.event);
    const list = templatesBySig.get(sig) ?? [];
    const template = relay.squad === 'A' ? list[0] : list[1];
    if (!template) {
      warnings.push(
        `No existing ${relay.event} relay entry to attach squad ${relay.squad} — leg assignments skipped`
      );
      continue;
    }
    const entryKey = relayEntryKey(template);
    relay.legs.forEach((leg, legIndex) => {
      const resolved = resolveTheoryName(leg.name, rosterNames);
      if (!resolved.match) {
        warnings.push(`Could not resolve relay leg "${leg.name}" (${relay.event} ${relay.squad})`);
        return;
      }
      // Resolve each alternate name to a roster name; persist them on the override
      // (additive) so suggestRelayAlternatePromotions can auto-fill this leg later
      // when the primary becomes unavailable. Unresolvable alternates are dropped
      // (never guessed) but still recorded in the summary for display.
      const resolvedAlternates: string[] = [];
      for (const alt of leg.alternates) {
        const altResolved = resolveTheoryName(alt, rosterNames);
        if (altResolved.match && !resolvedAlternates.includes(altResolved.match)) {
          resolvedAlternates.push(altResolved.match);
        }
      }
      relayOverrides = upsertRelayLegOverride(relayOverrides, {
        relayEntryKey: entryKey,
        legIndex,
        assigneeName: resolved.match,
        classYear: lookupClassYear(classYearMap, resolved.match),
        source: 'manual',
        ...(resolvedAlternates.length > 0 ? { alternates: resolvedAlternates } : {}),
      });
      summary.relayLegsAssigned += 1;
      if (leg.alternates.length > 0) {
        summary.relayAlternates.push({
          event: relay.event,
          squad: relay.squad,
          legIndex,
          chosen: resolved.match,
          alternates: leg.alternates,
        });
      }
    });
  }

  const patch: Partial<Workspace> = {
    meetEntryPlans,
    activeEntryIds,
    relayLegOverrides: relayOverrides,
  };
  if (roster) patch.scorerRosterOverrides = overrides;

  return { patch, summary, warnings };
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
  const gender = opts.gender;
  const overrides = workspace.relayLegOverrides ?? [];
  const withAlternates = overrides.filter(
    o =>
      Array.isArray(o.alternates) &&
      o.alternates.length > 0 &&
      String(o.relayEntryKey.split('|')[0] ?? '').trim() === team
  );
  if (withAlternates.length === 0) return [];

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

  const isOverCap = (name: string): boolean => {
    const counts = countSwimmerEntries(pool, team, gender, name);
    const over = swimmerExceedsEntryLimits(counts, settings);
    return over.individualOver || over.totalOver;
  };
  /** null when available; otherwise why the swimmer is unavailable. */
  const unavailableReason = (name: string): RelayAlternateReason | null => {
    const key = normalizeSwimmerName(name);
    if (deleted.has(key)) return 'soft_removed';
    if (!rosterKeys.has(key)) return 'missing_from_roster';
    if (isOverCap(name)) return 'over_entry_cap';
    return null;
  };

  const suggestions: RelayAlternatePromotion[] = [];
  for (const override of withAlternates) {
    const primary = override.assigneeName;
    if (!primary) continue;
    const reason = unavailableReason(primary);
    if (!reason) continue;

    const alternate = (override.alternates ?? []).find(a => unavailableReason(a) === null);
    if (!alternate) continue;

    const relayEvent = override.relayEntryKey.split('|')[1] ?? '';
    const next: RelayLegOverride = { ...override, assigneeName: alternate, source: 'autofill' };
    const patch: Partial<Workspace> = {
      relayLegOverrides: upsertRelayLegOverride(overrides, next),
    };
    const inverse: Partial<Workspace> = { relayLegOverrides: overrides };
    const reasonLabel =
      reason === 'soft_removed'
        ? 'soft-removed'
        : reason === 'over_entry_cap'
          ? 'over entry cap'
          : 'off roster';
    suggestions.push({
      relayEntryKey: override.relayEntryKey,
      relayEvent,
      legIndex: override.legIndex,
      primary,
      alternate,
      reason,
      patch,
      inverse,
      description: `${relayEvent} leg ${override.legIndex + 1}: promote ${alternate} for ${primary} (${reasonLabel})`,
    });
  }
  return suggestions;
}
