/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClassYear, RelayLegOverride, RelayLegStroke, SwimmerResult } from '../types';
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

export function eventMatchesStrokeDistance(
  eventRaw: string,
  distance: number,
  strokeKeywords: string[]
): boolean {
  const evNorm = eventRaw.replace(/\s*\(relay split\)\s*$/i, '').toLowerCase();
  if (!evNorm.includes(String(distance))) return false;
  return strokeKeywords.some(kw => evNorm.includes(kw));
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
  const { legDistanceYards, keywords } = relayLegRequirements(event, legIndex);
  return eventMatchesStrokeDistance(swimmer.event, legDistanceYards, keywords);
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
