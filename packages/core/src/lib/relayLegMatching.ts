/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClassYear, RelayLegOverride, RelayLegStroke, SwimmerResult } from '../types';
import { normalizeEventForCutline } from './cutlineEventNames';
import { parseRelayDistanceYards, relayEntryKey, relayLegDistanceYards } from './relaySplits';

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function timeToSec(timeStr: string): number {
  if (!timeStr || timeStr === 'NT' || timeStr === 'DQ') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(parts[0]);
}

export function strokeKeywordsForRelayLeg(eventLower: string, legIndex: number): string[] {
  if (eventLower.includes('medley')) {
    const m: Record<number, string[]> = {
      0: ['backstroke', 'back'],
      1: ['breaststroke', 'breast'],
      2: ['butterfly', 'fly'],
      3: ['freestyle', 'free'],
    };
    return m[legIndex] || ['freestyle', 'free'];
  }
  return ['freestyle', 'free'];
}

export function inferRelayStrokeDistance(event: string): number {
  return relayLegDistanceYards(parseRelayDistanceYards(event));
}

/** The individual event each relay-leg stroke swims, spelled as the canonical event name. */
const LEG_STROKE_EVENT: Record<RelayLegStroke, string> = {
  back: 'Backstroke',
  breast: 'Breaststroke',
  fly: 'Butterfly',
  free: 'Freestyle',
};

/** The stroke each keyword from {@link strokeKeywordsForRelayLeg} names. */
const STROKE_BY_KEYWORD: Record<string, RelayLegStroke> = {
  backstroke: 'back',
  back: 'back',
  breaststroke: 'breast',
  breast: 'breast',
  butterfly: 'fly',
  fly: 'fly',
  freestyle: 'free',
  free: 'free',
};

/** The label suffix a relay-split row carries: `100 Freestyle (relay split)`. */
const RELAY_SPLIT_SUFFIX = /\s*\(relay split\)\s*$/i;

/**
 * The individual event one relay leg swims, as a canonical event name:
 * `relayLegEventName(100, 'free')` is `100 Freestyle`.
 */
export function relayLegEventName(legDistanceYards: number, stroke: RelayLegStroke): string {
  return normalizeEventForCutline(`${legDistanceYards} ${LEG_STROKE_EVENT[stroke]}`);
}

/**
 * True when `eventRaw` is the individual event one relay leg swims: the leg's
 * own distance and stroke, and nothing else.
 *
 * Compared as canonical event names (`normalizeEventForCutline`), never by
 * substring. The substring test this replaces read `1000 Freestyle` as a 100
 * Free, `500 Free` and `1650 Free` as a 50 Free, and the HyTek entry number in
 * `Event 500 Women 100 Yard Butterfly Time Trial` as a 50 Fly. On the scoring
 * path that let a distance swim fill a sprint leg, and let `simulateRoster`
 * measure a substitute against a 1000 Free (IMPROVEMENTS_2026-09-22 P15).
 *
 * Every spelling of the leg event matches: canonical (`100 Freestyle`), short
 * (`100 Free`), SwimCloud (`100 Free SCY`), HyTek (`Event 35 Men 100 Yard
 * Freestyle`), and a relay-split row (`100 Freestyle (relay split)`).
 *
 * A time trial of the leg event matches. It is the same swim over the same
 * distance and stroke, and the substring test always accepted it. This is
 * where the leg test differs from `swimEventIdentity`, which keeps a time
 * trial apart because a time trial never occupies the program event.
 *
 * Course is not tested, exactly as before. On the scoring path every row's
 * time is already stated in yards (`buildWhatIfProjection` converts each
 * recruit row with `scoredTimeOf` before it reaches `simulateRoster`), while
 * its label may still name the course it was swum in. Rejecting on the label
 * would drop converted times.
 */
export function isRelayLegEvent(
  eventRaw: string,
  legDistanceYards: number,
  stroke: RelayLegStroke
): boolean {
  const label = String(eventRaw ?? '').replace(RELAY_SPLIT_SUFFIX, '').trim();
  if (!label) return false;
  const want = relayLegEventName(legDistanceYards, stroke).toLowerCase();
  return normalizeEventForCutline(label).toLowerCase() === want;
}

/**
 * Keyword form of {@link isRelayLegEvent}, kept for existing callers.
 *
 * `strokeKeywords` names the leg's stroke the way
 * {@link strokeKeywordsForRelayLeg} does (`['backstroke', 'back']`). The
 * event matches when it is the leg event for any stroke the keywords name. A
 * keyword that names no stroke is ignored; keywords that name none match
 * nothing.
 */
export function eventMatchesStrokeDistance(
  eventRaw: string,
  distance: number,
  strokeKeywords: string[]
): boolean {
  const strokes = new Set<RelayLegStroke>();
  for (const kw of strokeKeywords) {
    const stroke = STROKE_BY_KEYWORD[kw.trim().toLowerCase()];
    if (stroke) strokes.add(stroke);
  }
  return [...strokes].some(stroke => isRelayLegEvent(eventRaw, distance, stroke));
}

export function relayStrokeForIndex(eventLower: string, legIndex: number): RelayLegStroke {
  if (eventLower.includes('medley') && legIndex < 4) {
    return (['back', 'breast', 'fly', 'free'] as const)[legIndex];
  }
  return 'free';
}

export function relayLegRequirements(event: string, legIndex: number) {
  const evLower = event.toLowerCase();
  return {
    stroke: relayStrokeForIndex(evLower, legIndex),
    legDistanceYards: inferRelayStrokeDistance(event),
    keywords: strokeKeywordsForRelayLeg(evLower, legIndex),
  };
}

export function relayEventAssignmentKey(team: string, gender: string | undefined, event: string): string {
  return `${(team || '').trim()}|${gender ?? ''}|${event}`;
}

export function swimmerMatchesRelayLeg(swimmer: SwimmerResult, event: string, legIndex: number): boolean {
  if (swimmer.isRelay) return false;
  const { legDistanceYards, stroke } = relayLegRequirements(event, legIndex);
  return isRelayLegEvent(swimmer.event, legDistanceYards, stroke);
}

export function listEligibleRelayLegCandidates(
  activeSwimmers: SwimmerResult[],
  relayEvent: string,
  legIndex: number,
  assignedInEvent: Set<string>,
  team: string
): SwimmerResult[] {
  return activeSwimmers
    .filter(
      s =>
        !s.isRelay &&
        s.team === team &&
        !assignedInEvent.has(normalizeName(s.name)) &&
        swimmerMatchesRelayLeg(s, relayEvent, legIndex)
    )
    .sort((a, b) => timeToSec(a.time) - timeToSec(b.time));
}

export function relayTemplateFromLeg(results: SwimmerResult[], leg: SwimmerResult): SwimmerResult {
  const rs = (leg.roundSwam || '').trim();
  const group = results.filter(
    r =>
      r.isRelay &&
      r.team === leg.team &&
      r.event === leg.event &&
      r.rank === leg.rank &&
      (r.roundSwam || '').trim() === rs
  );
  if (group.length === 0) return leg;
  return [...group].sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0))[0];
}

export function stableRelayEntryKey(originalResults: SwimmerResult[], leg: SwimmerResult): string {
  return relayEntryKey(relayTemplateFromLeg(originalResults, leg));
}

export function findRelayLegOverride(
  overrides: RelayLegOverride[],
  template: SwimmerResult,
  legIndex: number
): RelayLegOverride | undefined {
  const key = relayEntryKey(template);
  return overrides.find(o => o.relayEntryKey === key && o.legIndex === legIndex);
}

export function resolveOverrideAssignee(
  override: RelayLegOverride,
  activeSwimmers: SwimmerResult[],
  team: string,
  relayEvent?: string,
  legIndex?: number
): SwimmerResult | null {
  if (override.recruitId) {
    const hit = activeSwimmers.find(s => !s.isRelay && s.id === override.recruitId);
    if (hit && hit.team === team) return hit;
  }
  if (override.assigneeName) {
    const key = normalizeName(override.assigneeName);
    const matches = activeSwimmers.filter(
      s => !s.isRelay && s.team === team && normalizeName(s.name) === key
    );
    if (matches.length === 0) return null;
    if (relayEvent != null && legIndex != null) {
      const strokeMatches = matches.filter(m => swimmerMatchesRelayLeg(m, relayEvent, legIndex));
      if (strokeMatches.length === 0) return null;
      strokeMatches.sort((a, b) => timeToSec(a.time) - timeToSec(b.time));
      return strokeMatches[0];
    }
    return matches[0];
  }
  return null;
}

export function relayLegNameKeys(template: SwimmerResult): Set<string> {
  const keys = new Set<string>();
  if (template.relayNames?.length) {
    for (const leg of template.relayNames) {
      if (leg.name) keys.add(normalizeName(leg.name));
    }
  }
  return keys;
}

export function suggestBestRelayLegFill(
  activeSwimmers: SwimmerResult[],
  template: SwimmerResult,
  legIndex: number,
  assignedInEvent: Set<string>,
  excludeNormalizedNames: Set<string>
): { override: RelayLegOverride; swimmer: SwimmerResult } | null {
  const blocked = new Set(assignedInEvent);
  relayLegNameKeys(template).forEach(n => blocked.add(n));
  excludeNormalizedNames.forEach(n => blocked.add(n));
  const candidates = listEligibleRelayLegCandidates(
    activeSwimmers,
    template.event,
    legIndex,
    blocked,
    template.team
  );
  if (candidates.length === 0) return null;
  const swimmer = candidates[0];
  const override: RelayLegOverride = {
    relayEntryKey: relayEntryKey(template),
    legIndex,
    assigneeName: swimmer.name,
    recruitId: swimmer.isRecruit ? swimmer.id : undefined,
    classYear: swimmer.classYear as ClassYear,
    source: 'autofill',
  };
  return { override, swimmer };
}

export function upsertRelayLegOverride(
  overrides: RelayLegOverride[],
  next: RelayLegOverride
): RelayLegOverride[] {
  return [
    ...overrides.filter(o => !(o.relayEntryKey === next.relayEntryKey && o.legIndex === next.legIndex)),
    next,
  ];
}

export function removeRelayLegOverride(
  overrides: RelayLegOverride[],
  entryKey: string,
  legIndex: number
): RelayLegOverride[] {
  return overrides.filter(o => !(o.relayEntryKey === entryKey && o.legIndex === legIndex));
}

export function relayMissingStrokeLabel(stroke: RelayLegStroke | undefined): string {
  if (!stroke) return '';
  const m: Record<RelayLegStroke, string> = { back: 'Back', breast: 'Breast', fly: 'Fly', free: 'Free' };
  return m[stroke] ?? stroke;
}
