/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClassYear, Gender, RelayLegOverride, RelayLegStroke, SwimmerResult } from '../types';
import { normalizeEventForCutline } from './cutlineEventNames';
import { relayEntryKey, relayLegDistanceYardsOfEvent } from './relaySplits';
import { canonicalSwimmerName } from './utils';

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

/**
 * The distance one leg of the relay swims, or `null` when the relay's label
 * names no distance (`relayLegDistanceYardsOfEvent`). A `null` leg distance
 * matches no swim: no candidate, no departed swim, no fill.
 */
export function inferRelayStrokeDistance(event: string): number | null {
  return relayLegDistanceYardsOfEvent(event);
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

/** The relay-leg stroke each canonical single-stroke event name swims. */
const STROKE_BY_EVENT_WORD: Record<string, RelayLegStroke> = {
  backstroke: 'back',
  breaststroke: 'breast',
  butterfly: 'fly',
  freestyle: 'free',
};

/** A canonical single-stroke individual event: `100 Butterfly`. Nothing before or after. */
const SINGLE_STROKE_EVENT = /^(\d{2,4}) (Freestyle|Backstroke|Breaststroke|Butterfly)$/i;

/**
 * The distance and relay-leg stroke of a single-stroke individual event, or
 * `null` for a relay, an individual medley, a relay split, a dive, or a label
 * with no readable distance.
 *
 * Read from the canonical event name (`normalizeEventForCutline`), so the
 * distance is the event's own `<n> Yard` / `<n> Meter` token, never a HyTek
 * entry number: `Event 500 Women 100 Yard Butterfly Time Trial` is a 100
 * Butterfly, and `Event 35 Men 100 Yard Freestyle` a 100 Freestyle. Every
 * spelling {@link isRelayLegEvent} accepts reads the same way (`100 Free`,
 * `100 Free SCY`, `100 Freestyle`).
 */
export function individualEventDistanceStroke(
  event: string
): { distance: number; stroke: RelayLegStroke } | null {
  const match = SINGLE_STROKE_EVENT.exec(normalizeEventForCutline(String(event ?? '')));
  if (!match) return null;
  return { distance: Number(match[1]), stroke: STROKE_BY_EVENT_WORD[match[2].toLowerCase()] };
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
 *
 * A `null` leg distance (a relay label that names no distance, see
 * `parseRelayDistanceYardsOrNull`) matches nothing.
 */
export function isRelayLegEvent(
  eventRaw: string,
  legDistanceYards: number | null,
  stroke: RelayLegStroke
): boolean {
  if (legDistanceYards == null) return false;
  const key = relayLegEventKey(eventRaw);
  if (!key) return false;
  return key === relayLegEventName(legDistanceYards, stroke).toLowerCase();
}

/**
 * The key {@link isRelayLegEvent} compares: the canonical event name of a
 * label, lower-cased, with a relay-split suffix dropped. Empty for an empty
 * label. `isRelayLegEvent(label, d, s)` is exactly
 * `relayLegEventKey(label) === relayLegEventName(d, s).toLowerCase()`, so a
 * caller testing one label against many legs can read the key once.
 */
export function relayLegEventKey(eventRaw: string): string {
  const label = String(eventRaw ?? '').replace(RELAY_SPLIT_SUFFIX, '').trim();
  if (!label) return '';
  return normalizeEventForCutline(label).toLowerCase();
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

/* -------------------------------------------------------------------------- */
/* Who may swim a leg: the swimmer's gender                                    */
/* -------------------------------------------------------------------------- */

/** The gender word a HyTek label opens with, after its entry number. */
const LABEL_GENDER_WORD = /^\s*(?:event\s+\d+\s+)?(men|women|boys|girls|mixed)\b/i;

const GENDER_BY_LABEL_WORD: Record<string, Gender | 'mixed'> = {
  men: Gender.MEN,
  boys: Gender.MEN,
  women: Gender.WOMEN,
  girls: Gender.WOMEN,
  mixed: 'mixed',
};

/**
 * The gender an event label names, or `null` when it names none.
 *
 * `Event 31 Men 4x50 Yard Freestyle Relay` is `Gender.MEN`; `Event 403 Mixed
 * 50 Yard Freestyle Time Trial` is `'mixed'`; `50 Free SCY` is `null`. Boys
 * and Girls (high-school exports) read as Men and Women.
 */
export function eventLabelGender(event: string): Gender | 'mixed' | null {
  const match = LABEL_GENDER_WORD.exec(String(event ?? ''));
  return match ? GENDER_BY_LABEL_WORD[match[1].toLowerCase()] : null;
}

/**
 * The swimmer's gender as one row records it, or `undefined`.
 *
 * - A gendered label (Men, Women, Boys, Girls) records it.
 * - A Mixed label records nothing. HyTek files a mixed time trial under one
 *   gender's results, and the parser stamps the row with that gender, so the
 *   row's `gender` names the results it was filed under, not the swimmer.
 * - A label with no gender word records the row's `gender` field: a SwimCloud
 *   meet row, a recruit row, a history swim.
 */
function genderRecordedByRow(row: Pick<SwimmerResult, 'event' | 'gender'>): Gender | undefined {
  const fromLabel = eventLabelGender(row.event);
  if (fromLabel === 'mixed') return undefined;
  return fromLabel ?? row.gender ?? undefined;
}

/** One swimmer: team and canonical name, whichever order the rows spell it in. */
function swimmerGenderKey(row: Pick<SwimmerResult, 'team' | 'name'>): string {
  return `${String(row.team ?? '').trim()}|${canonicalSwimmerName(row.name)}`;
}

/**
 * The genders each swimmer's rows record, keyed by team and canonical name.
 * Built by {@link buildRelayCandidateGenderIndex}.
 */
export type RelayCandidateGenderIndex = ReadonlyMap<string, ReadonlySet<Gender>>;

/** Index the genders a pool's rows record, once per pool. Mixed rows record none. */
export function buildRelayCandidateGenderIndex(
  rows: readonly SwimmerResult[]
): RelayCandidateGenderIndex {
  const index = new Map<string, Set<Gender>>();
  for (const row of rows) {
    const gender = genderRecordedByRow(row);
    if (!gender) continue;
    const key = swimmerGenderKey(row);
    const genders = index.get(key) ?? new Set<Gender>();
    genders.add(gender);
    index.set(key, genders);
  }
  return index;
}

/**
 * The swimmer's gender for relay purposes, or `undefined` when no row on
 * record states it.
 *
 * A Mixed-event row belongs to the swimmer, not the event: it takes the one
 * gender the same swimmer's other rows record (same team, same canonical
 * name). No such row, or rows that disagree, leave it `undefined`.
 */
export function relayCandidateGender(
  row: SwimmerResult,
  index: RelayCandidateGenderIndex
): Gender | undefined {
  if (eventLabelGender(row.event) !== 'mixed') return genderRecordedByRow(row);
  const genders = index.get(swimmerGenderKey(row));
  return genders && genders.size === 1 ? [...genders][0] : undefined;
}

/**
 * True when `row` may swim a leg of a relay for `relayGender`.
 *
 * A Mixed-event row qualifies only when the swimmer's gender is on record and
 * equals the relay's. Real case (2026 NSISC final results): Event 403 "Mixed
 * 50 Yard Freestyle Time Trial" is filed in the men's results and holds Ave
 * Owens of Delta State, who swims the women's program. Her 23.19 was offered
 * for a leg of Delta State's men's 200 Free Relay. The same event holds
 * Landon Dehn of Ouachita Baptist, who swims the men's program; his row still
 * qualifies.
 *
 * Any other row qualifies unless its recorded gender contradicts the relay's.
 * A row with no recorded gender sits in a single-gender pool and is that
 * pool's, as before. An unknown relay gender (a Mixed relay, or a label and
 * row with no gender) rules out only Mixed-event rows.
 */
export function isRelayCandidateOfGender(
  row: SwimmerResult,
  relayGender: Gender | undefined,
  index: RelayCandidateGenderIndex
): boolean {
  const gender = relayCandidateGender(row, index);
  if (eventLabelGender(row.event) === 'mixed') {
    return gender != null && relayGender != null && gender === relayGender;
  }
  return gender == null || relayGender == null || gender === relayGender;
}

/**
 * The gender a relay entry is for: the gender word of its label, else its
 * row's `gender`. A Mixed relay is for neither.
 */
export function relayEntryGender(
  template: Pick<SwimmerResult, 'event' | 'gender'>
): Gender | undefined {
  const fromLabel = eventLabelGender(template.event);
  if (fromLabel === 'mixed') return undefined;
  return fromLabel ?? template.gender ?? undefined;
}

const EMPTY_GENDER_INDEX: RelayCandidateGenderIndex = new Map();

/**
 * Keep the rows that pass {@link isRelayCandidateOfGender}. The gender index
 * is built from `pool` only when a Mixed-event row needs it.
 */
function keepRelayGender(
  rows: SwimmerResult[],
  relayGender: Gender | undefined,
  pool: readonly SwimmerResult[]
): SwimmerResult[] {
  if (!rows.some(r => eventLabelGender(r.event) === 'mixed')) {
    return rows.filter(r => isRelayCandidateOfGender(r, relayGender, EMPTY_GENDER_INDEX));
  }
  const index = buildRelayCandidateGenderIndex(pool);
  return rows.filter(r => isRelayCandidateOfGender(r, relayGender, index));
}

export function swimmerMatchesRelayLeg(swimmer: SwimmerResult, event: string, legIndex: number): boolean {
  if (swimmer.isRelay) return false;
  const { legDistanceYards, stroke } = relayLegRequirements(event, legIndex);
  return isRelayLegEvent(swimmer.event, legDistanceYards, stroke);
}

/**
 * The swims on `team` that may fill leg `legIndex` of `relayEvent`, fastest
 * first: the leg's exact event (`swimmerMatchesRelayLeg`), a swimmer not
 * already on the relay, and a swimmer of the relay's gender
 * (`isRelayCandidateOfGender`).
 *
 * `relayGender` defaults to the gender word of `relayEvent`. Pass it when the
 * label has none (a SwimCloud `200 Free Relay`).
 */
export function listEligibleRelayLegCandidates(
  activeSwimmers: SwimmerResult[],
  relayEvent: string,
  legIndex: number,
  assignedInEvent: Set<string>,
  team: string,
  relayGender?: Gender
): SwimmerResult[] {
  const legSwims = activeSwimmers.filter(
    s =>
      !s.isRelay &&
      s.team === team &&
      !assignedInEvent.has(normalizeName(s.name)) &&
      swimmerMatchesRelayLeg(s, relayEvent, legIndex)
  );
  const gender = relayGender ?? relayEntryGender({ event: relayEvent });
  return keepRelayGender(legSwims, gender, activeSwimmers).sort(
    (a, b) => timeToSec(a.time) - timeToSec(b.time)
  );
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

/**
 * The swim an override puts on a leg, or `null` when none of the pool's swims
 * may take it.
 *
 * Only a swim of the relay's gender resolves (`isRelayCandidateOfGender`):
 * naming a woman whose only swim at the leg event is a Mixed time trial filed
 * in the men's results leaves a men's leg unresolved. `relayGender` defaults
 * to the gender word of `relayEvent`; pass it when the label has none.
 */
export function resolveOverrideAssignee(
  override: RelayLegOverride,
  activeSwimmers: SwimmerResult[],
  team: string,
  relayEvent?: string,
  legIndex?: number,
  relayGender?: Gender
): SwimmerResult | null {
  const gender = relayGender ?? (relayEvent != null ? relayEntryGender({ event: relayEvent }) : undefined);
  if (override.recruitId) {
    const hit = activeSwimmers.find(s => !s.isRelay && s.id === override.recruitId);
    if (hit && hit.team === team && keepRelayGender([hit], gender, activeSwimmers).length > 0) {
      return hit;
    }
  }
  if (override.assigneeName) {
    const key = normalizeName(override.assigneeName);
    const named = activeSwimmers.filter(
      s => !s.isRelay && s.team === team && normalizeName(s.name) === key
    );
    const matches = keepRelayGender(named, gender, named);
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
    template.team,
    relayEntryGender(template)
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
