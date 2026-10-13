/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ClassYear,
  Gender,
  RelayLegOverride,
  RelayLegStroke,
  ScoringSettings,
  SwimmerResult,
} from '../types';
import { normalizeEventForCutline } from './cutlineEventNames';
import { relayLegsAllowTimeTrials } from './scoringDefaults';
import { relayEntryKey, relayLegDistanceYardsOfEvent } from './relaySplits';
import {
  canonicalSwimmerName,
  convertTimeToSeconds,
  isTimeTrialSwim,
  normalizeSwimmerName,
  relayEntryLegSignature,
} from './utils';

/**
 * The settings the relay-leg matchers read. Every matcher takes them as an
 * optional trailing argument.
 *
 * - `relayLegsAllowTimeTrials`: whether a time-trial swim may fill a leg.
 *   Omitted, or without the field, a time trial fills no leg.
 * - `scoredEventNumberMax`: the meet's last scored event number. A swim of a
 *   later event is a time trial for a leg (`isTimeTrialSwim`). Omitted, no
 *   event number makes a swim a time trial.
 *
 * A whole `ScoringSettings` satisfies this type. It carries
 * `scoredEventNumberMax` only when the workspace stored one: a loaded meet
 * keeps its boundary on `officialTeamScores.eventThrough`. Callers that hold a
 * workspace build the object with {@link relayLegMatchSettings}, which reads
 * both places the way the scoring engine does.
 */
export type RelayLegMatchSettings = Pick<
  ScoringSettings,
  'relayLegsAllowTimeTrials' | 'scoredEventNumberMax'
>;

/**
 * The relay-leg settings of a workspace: its `relayLegsAllowTimeTrials` and the
 * meet's scored-event boundary.
 *
 * The boundary is `officialTeamScores.eventThrough` (the PDF "Team Rankings -
 * Through Event N" line), else `scoringSettings.scoredEventNumberMax`. The
 * order is the scoring engine's (`buildScoringBundle` hands `eventThrough` to
 * `calculatePoints`, where it wins over the settings value), so a leg is
 * matched against the same boundary the team totals use. Neither present: no
 * boundary.
 */
export function relayLegMatchSettings(
  workspace:
    | { scoringSettings?: ScoringSettings; officialTeamScores?: { eventThrough?: number } }
    | null
    | undefined
): RelayLegMatchSettings {
  const settings = workspace?.scoringSettings;
  const boundary = workspace?.officialTeamScores?.eventThrough ?? settings?.scoredEventNumberMax;
  return {
    ...(settings?.relayLegsAllowTimeTrials === undefined
      ? {}
      : { relayLegsAllowTimeTrials: settings.relayLegsAllowTimeTrials }),
    ...(boundary === undefined ? {} : { scoredEventNumberMax: boundary }),
  };
}

/**
 * The row as a leg may take it: unchanged unless it is a time trial and the
 * setting lets it fill a leg, in which case it carries `relayLegTimeTrial`.
 */
function labelTimeTrialLeg(row: SwimmerResult, settings?: RelayLegMatchSettings): SwimmerResult {
  if (!relayLegsAllowTimeTrials(settings) || !isTimeTrialSwim(row, settings?.scoredEventNumberMax)) {
    return row;
  }
  return row.relayLegTimeTrial === true ? row : { ...row, relayLegTimeTrial: true };
}

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

/**
 * True when `swimmer`'s `time` is a time a relay leg may carry: a finished swim
 * with a readable, positive clock.
 *
 * A disqualified swim (`DQ`), a no-show (`DFS`, `NS`, `SCR`), a no-time entry
 * (`NT`, empty) and any other code that is not a time (`DNF`, `DSQ`) have none:
 * `convertTimeToSeconds` reads none of them as a finite number. That covers
 * every code `isScoringSwimTime` lists, and the ones it does not (`DNF`). A leg
 * is ranked and filled from the row's own `time`, so the prelims or finals
 * clock is never read in its place: a row with `time: 'DQ'` and a legal
 * `prelimsTime` is a disqualified swim here.
 */
export function hasRelayLegTime(swimmer: Pick<SwimmerResult, 'time'>): boolean {
  const seconds = convertTimeToSeconds(String(swimmer.time ?? '').trim());
  return Number.isFinite(seconds) && seconds > 0;
}

/**
 * True when `swimmer` is a swim of the individual event leg `legIndex` of
 * `event` swims (`isRelayLegEvent`).
 *
 * A swim with no time (`hasRelayLegTime`: a DQ, a no-show, an NT) matches no
 * leg, whatever the setting.
 *
 * A time-trial swim matches only when `settings.relayLegsAllowTimeTrials` is
 * `true` (user decision D9). `isRelayLegEvent` itself still reads a time trial
 * of the leg event as the leg event; this function is where the setting applies.
 */
export function swimmerMatchesRelayLeg(
  swimmer: SwimmerResult,
  event: string,
  legIndex: number,
  settings?: RelayLegMatchSettings
): boolean {
  if (swimmer.isRelay) return false;
  if (!hasRelayLegTime(swimmer)) return false;
  if (
    (isTimeTrialSwim(swimmer, settings?.scoredEventNumberMax) || swimmer.relayLegTimeTrial === true) &&
    !relayLegsAllowTimeTrials(settings)
  ) {
    return false;
  }
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
 *
 * A time-trial swim is left out unless `settings.relayLegsAllowTimeTrials` is
 * `true`. When it is, the returned row for a time trial carries
 * `relayLegTimeTrial: true` (a copy; the input row is not changed).
 */
export function listEligibleRelayLegCandidates(
  activeSwimmers: SwimmerResult[],
  relayEvent: string,
  legIndex: number,
  assignedInEvent: Set<string>,
  team: string,
  relayGender?: Gender,
  settings?: RelayLegMatchSettings
): SwimmerResult[] {
  const legSwims = activeSwimmers.filter(
    s =>
      !s.isRelay &&
      s.team === team &&
      !assignedInEvent.has(normalizeName(s.name)) &&
      swimmerMatchesRelayLeg(s, relayEvent, legIndex, settings)
  );
  const gender = relayGender ?? relayEntryGender({ event: relayEvent });
  return keepRelayGender(legSwims, gender, activeSwimmers)
    .map(s => labelTimeTrialLeg(s, settings))
    .sort((a, b) => timeToSec(a.time) - timeToSec(b.time));
}

/** The normalized names a relay row lists for its swimmers. */
function relayEntryNameSet(r: SwimmerResult): Set<string> {
  const names = new Set<string>();
  for (const n of r.relayNames ?? []) {
    const key = normalizeSwimmerName(String(n.name ?? ''));
    if (key) names.add(key);
  }
  return names;
}

/** What `narrowToTiedEntry` found: the rows of one entry, or the whole group when it could not tell. */
type TiedNarrowing = {
  /** The leg's own entry's rows (plus unnamed rows), or the whole group when `ambiguous`. */
  rows: SwimmerResult[];
  /** True when the group holds more than one entry and nothing says which one `leg` belongs to. */
  ambiguous: boolean;
};

/**
 * The rows of one relay entry among rows that share its event, round, place and
 * team, when those rows hold more than one entry (a dead heat).
 *
 * `leg` names its swimmers (`relayNames`). The entry that names the same four
 * wins. A leg of a projected relay has had a swimmer replaced, so no entry names
 * exactly its four: the entry that shares the most named swimmers wins, and
 * only when one entry leads. Rows that name no swimmers stay with every entry.
 *
 * When the group holds more than one entry and nothing tells them apart (the
 * leg names no swimmer, shares none, or shares as many with two entries) the
 * result is `ambiguous`, with the whole group in `rows`. The caller must not
 * read an entry, a key or an override from an ambiguous leg: any answer would
 * be one entry's, given to a leg that may belong to the other.
 */
function narrowToTiedEntry(group: SwimmerResult[], leg: SwimmerResult): TiedNarrowing {
  const signatures = new Set<string>();
  for (const r of group) {
    const signature = relayEntryLegSignature(r);
    if (signature) signatures.add(signature);
  }
  if (signatures.size < 2) return { rows: group, ambiguous: false };

  const legSignature = relayEntryLegSignature(leg);
  const unnamed = group.filter(r => relayEntryLegSignature(r) === '');
  if (legSignature && signatures.has(legSignature)) {
    return {
      rows: [...group.filter(r => relayEntryLegSignature(r) === legSignature), ...unnamed],
      ambiguous: false,
    };
  }

  const legNames = relayEntryNameSet(leg);
  if (legNames.size === 0) return { rows: group, ambiguous: true };
  let best: { signature: string; overlap: number } | null = null;
  let leader = true;
  for (const signature of signatures) {
    const row = group.find(r => relayEntryLegSignature(r) === signature);
    if (!row) continue;
    let overlap = 0;
    for (const name of relayEntryNameSet(row)) if (legNames.has(name)) overlap += 1;
    if (best === null || overlap > best.overlap) {
      best = { signature, overlap };
      leader = true;
    } else if (overlap === best.overlap) {
      leader = false;
    }
  }
  if (best === null || best.overlap === 0 || !leader) return { rows: group, ambiguous: true };
  const chosen = best.signature;
  return {
    rows: [...group.filter(r => relayEntryLegSignature(r) === chosen), ...unnamed],
    ambiguous: false,
  };
}

/** The row with the lowest leg index (the first of equals), or `undefined` for no rows. */
function firstLegRow(rows: readonly SwimmerResult[]): SwimmerResult | undefined {
  let first: SwimmerResult | undefined;
  for (const r of rows) {
    if (first === undefined || (r.relayLegIndex ?? 0) < (first.relayLegIndex ?? 0)) first = r;
  }
  return first;
}

/** The relay rows that share `leg`'s team, event, place and round: one entry, or a dead heat of several. */
function relayRowsSharingPlace(results: readonly SwimmerResult[], leg: SwimmerResult): SwimmerResult[] {
  const rs = (leg.roundSwam || '').trim();
  return results.filter(
    r =>
      r.isRelay &&
      r.team === leg.team &&
      r.event === leg.event &&
      r.rank === leg.rank &&
      (r.roundSwam || '').trim() === rs
  );
}

/**
 * The first leg row of the relay entry `leg` belongs to.
 *
 * One team's A and B relays can share event, round, place and clock (a dead
 * heat). Their rows then differ only in the swimmers they name
 * (`relayNames`), and the template of a B leg must be a B row, not the A
 * relay's leadoff (`narrowToTiedEntry`). With no tie the template is the first
 * row of the group, as it always was.
 *
 * A leg that belongs to no entry the rows can name (an ambiguous leg of a
 * projected tied relay) still gets the first row of the whole group here, as
 * before. A caller that holds projected rows must use
 * {@link resolveRelayEntryForLeg}, which says so.
 */
export function relayTemplateFromLeg(results: SwimmerResult[], leg: SwimmerResult): SwimmerResult {
  const group = relayRowsSharingPlace(results, leg);
  if (group.length === 0) return leg;
  const { rows } = narrowToTiedEntry(group, leg);
  return firstLegRow(rows) ?? leg;
}

/**
 * The relay entry of a leg row, or the fact that the rows cannot say.
 *
 * - `resolved`: `template` is a row of the entry, and `entryKey` is the key an
 *   override of it is stored under (`relayEntryKeyIn`).
 * - `ambiguous`: one team's relays share event, round, place and clock, and
 *   nothing in the leg tells them apart (a projected leg whose swimmers all
 *   left, or two of each relay's). It belongs to one of `candidates` (each
 *   the first leg row of one tied entry). `groupKey` names the unresolved
 *   leg's relay for grouping and de-duplication only. It starts with
 *   `ambiguous-tied-relay|`, which no stored override key does, and must never
 *   be written as an override key.
 *
 * An ambiguous leg gets no override read, no autofill and no edit
 * ({@link relayOverrideRefusal}).
 */
export type RelayEntryResolution =
  | { status: 'resolved'; template: SwimmerResult; entryKey: string }
  | { status: 'ambiguous'; candidates: SwimmerResult[]; groupKey: string };

const AMBIGUOUS_TIED_RELAY_PREFIX = 'ambiguous-tied-relay|';

/**
 * Resolve the relay entry `leg` belongs to among `results` (the original rows).
 * See {@link RelayEntryResolution}. A leg whose place holds no relay row is its
 * own template.
 */
export function resolveRelayEntryForLeg(
  results: SwimmerResult[],
  leg: SwimmerResult
): RelayEntryResolution {
  const group = relayRowsSharingPlace(results, leg);
  if (group.length === 0) {
    return { status: 'resolved', template: leg, entryKey: relayEntryKeyIn(results, leg) };
  }
  const narrowed = narrowToTiedEntry(group, leg);
  if (!narrowed.ambiguous) {
    const template = firstLegRow(narrowed.rows) ?? leg;
    return { status: 'resolved', template, entryKey: relayEntryKeyIn(results, template) };
  }
  const bySignature = new Map<string, SwimmerResult[]>();
  for (const r of group) {
    const signature = relayEntryLegSignature(r);
    if (!signature) continue;
    const rows = bySignature.get(signature) ?? [];
    rows.push(r);
    bySignature.set(signature, rows);
  }
  const candidates: SwimmerResult[] = [];
  for (const rows of bySignature.values()) {
    const first = firstLegRow(rows);
    if (first) candidates.push(first);
  }
  const placeKey = relayEntryKey(firstLegRow(group) ?? leg);
  return {
    status: 'ambiguous',
    candidates,
    groupKey: `${AMBIGUOUS_TIED_RELAY_PREFIX}${placeKey}|${relayEntryLegSignature(leg)}`,
  };
}

/** The reason an override write is refused: its relay is one of a tied pair and the leg cannot say which. */
export const TIED_RELAY_AMBIGUOUS = 'tied_relay_ambiguous' as const;

export type RelayOverrideRefusal = {
  reason: typeof TIED_RELAY_AMBIGUOUS;
  /** Plain words for the coach. */
  message: string;
};

/**
 * `null` when an override may be written for the resolved relay entry, else why
 * not. A writer that holds a leg row (the relays screen, the autofill, the
 * quick fill) asks this first and writes nothing when it is not `null`: an
 * override for an ambiguous leg would land on one of two tied relays by luck.
 */
export function relayOverrideRefusal(resolution: RelayEntryResolution): RelayOverrideRefusal | null {
  if (resolution.status === 'resolved') return null;
  return {
    reason: TIED_RELAY_AMBIGUOUS,
    message:
      'This team has two relays with the same place and time, and this leg could belong to either. ' +
      'Nothing was changed.',
  };
}

/**
 * The key an override of `template`'s relay entry is stored under.
 *
 * It is `relayEntryKey(template)` (`team|event|round|place|clock`), and
 * nothing else, unless another relay in `pool` has the same key and names other
 * swimmers: one team's A and B relays on a dead heat. Then the key carries the
 * named swimmers (`relayEntryLegSignature`) after the clock, so an override of
 * a leg of A does not apply to B.
 *
 * Every entry that is not tied keeps the key it always had, so saved overrides
 * and the keys the screens compare are unchanged. Without `pool` the key is
 * `relayEntryKey(template)`.
 */
export function relayEntryKeyIn(
  pool: readonly SwimmerResult[] | undefined,
  template: SwimmerResult
): string {
  const key = relayEntryKey(template);
  if (!pool) return key;
  const signature = relayEntryLegSignature(template);
  if (!signature) return key;
  const tied = pool.some(
    r =>
      r.isRelay &&
      r.team === template.team &&
      r.event === template.event &&
      relayEntryKey(r) === key &&
      relayEntryLegSignature(r) !== '' &&
      relayEntryLegSignature(r) !== signature
  );
  return tied ? `${key}|${signature}` : key;
}

/**
 * The key a stored override for `leg`'s relay entry carries (`relayEntryKeyIn`
 * over the template).
 *
 * Only for a leg of the original rows. A leg of a projected relay may be
 * ambiguous between two tied relays, and then this returns the key of the
 * group's first entry: use {@link resolveRelayEntryForLeg} for such a leg.
 */
export function stableRelayEntryKey(originalResults: SwimmerResult[], leg: SwimmerResult): string {
  return relayEntryKeyIn(originalResults, relayTemplateFromLeg(originalResults, leg));
}

/**
 * The override for leg `legIndex` of `template`'s relay entry.
 *
 * Pass `pool` (the results the template came from) so one team's tied A and B
 * relays are told apart (`relayEntryKeyIn`). Only the override stored under the
 * entry's own key is read. A key saved before the two relays were told apart
 * (the plain `relayEntryKey` of a tied pair) names neither: run the list
 * through {@link migrateTiedRelayOverrides} first, which rewrites it into one
 * override per relay. Without `pool` only the plain key is read, as before.
 */
export function findRelayLegOverride(
  overrides: RelayLegOverride[],
  template: SwimmerResult,
  legIndex: number,
  pool?: readonly SwimmerResult[]
): RelayLegOverride | undefined {
  const key = relayEntryKeyIn(pool, template);
  return overrides.find(o => o.relayEntryKey === key && o.legIndex === legIndex);
}

/**
 * The keys an override of `template`'s relay entry may be stored under: the
 * entry's own key (`relayEntryKeyIn`). One key, in a list for the callers that
 * took two before a tied relay's plain key was migrated away.
 */
export function relayEntryOverrideKeys(
  pool: readonly SwimmerResult[] | undefined,
  template: SwimmerResult
): string[] {
  return [relayEntryKeyIn(pool, template)];
}

/**
 * The overrides with every override stored under the plain key of a tied relay
 * pair rewritten into one override per relay.
 *
 * Before one team's A and B relays on a dead heat were told apart, an override
 * of a tied relay was stored under `relayEntryKey` (`team|event|round|place|
 * clock`) and applied to both. A reader no longer reads that key for a tied
 * relay, so this puts a copy under each relay's own key
 * (`relayEntryKeyIn`: the plain key, `|`, the named swimmers). A copy keeps
 * every field of the override, and the override list keeps its order.
 *
 * A relay's own override of the same leg wins: no copy is made over it. A
 * second legacy override of one leg is dropped, as `findRelayLegOverride` read
 * only the first. A relay that is not tied keeps every key it had.
 *
 * `results` is the original rows of the relays (`menResults`, `womenResults`).
 * Pure and idempotent. The same array comes back when nothing is rewritten.
 */
export function migrateTiedRelayOverrides(
  overrides: RelayLegOverride[],
  results: readonly SwimmerResult[]
): RelayLegOverride[] {
  if (overrides.length === 0) return overrides;
  const signaturesByKey = new Map<string, Set<string>>();
  for (const r of results) {
    if (!r.isRelay) continue;
    const signature = relayEntryLegSignature(r);
    if (!signature) continue;
    const key = relayEntryKey(r);
    const signatures = signaturesByKey.get(key) ?? new Set<string>();
    signatures.add(signature);
    signaturesByKey.set(key, signatures);
  }
  const tiedKeys = new Map<string, string[]>();
  for (const [key, signatures] of signaturesByKey) {
    if (signatures.size >= 2) tiedKeys.set(key, [...signatures].sort());
  }
  if (tiedKeys.size === 0) return overrides;

  const slot = (key: string, legIndex: number): string => `${key}\u0000${legIndex}`;
  const taken = new Set<string>(overrides.map(o => slot(o.relayEntryKey, o.legIndex)));
  const out: RelayLegOverride[] = [];
  let rewritten = false;
  for (const o of overrides) {
    const signatures = tiedKeys.get(o.relayEntryKey);
    if (!signatures) {
      out.push(o);
      continue;
    }
    rewritten = true;
    for (const signature of signatures) {
      const key = `${o.relayEntryKey}|${signature}`;
      if (taken.has(slot(key, o.legIndex))) continue;
      taken.add(slot(key, o.legIndex));
      out.push({ ...o, relayEntryKey: key });
    }
  }
  return rewritten ? out : overrides;
}

/**
 * The swim an override puts on a leg, or `null` when none of the pool's swims
 * may take it.
 *
 * Only a swim of the relay's gender resolves (`isRelayCandidateOfGender`):
 * naming a woman whose only swim at the leg event is a Mixed time trial filed
 * in the men's results leaves a men's leg unresolved. `relayGender` defaults
 * to the gender word of `relayEvent`; pass it when the label has none.
 *
 * A name resolves onto a time-trial swim only when
 * `settings.relayLegsAllowTimeTrials` is `true`, and the swim then carries
 * `relayLegTimeTrial: true`. Otherwise the leg resolves onto the swimmer's
 * other swim at the leg event, or onto nothing.
 *
 * With a leg named, a swim with no time (`hasRelayLegTime`) never resolves, on
 * either path.
 *
 * The recruit id and the name choose the same swim. With a leg named, the id
 * stands for its row's swimmer: the fastest swim of theirs that may fill the leg
 * wins, the id's own row or a program swim at the event. Only when none may
 * does the id's own row come back (so the leg check can name the reason).
 * Without a leg, the id's own row.
 */
export function resolveOverrideAssignee(
  override: RelayLegOverride,
  activeSwimmers: SwimmerResult[],
  team: string,
  relayEvent?: string,
  legIndex?: number,
  relayGender?: Gender,
  settings?: RelayLegMatchSettings
): SwimmerResult | null {
  const gender = relayGender ?? (relayEvent != null ? relayEntryGender({ event: relayEvent }) : undefined);
  const hasLegContext = relayEvent != null && legIndex != null;

  // The swim the recruit id points at. A swim with no time never stands in.
  let hit: SwimmerResult | undefined;
  if (override.recruitId) {
    const found = activeSwimmers.find(s => !s.isRelay && s.id === override.recruitId);
    if (
      found &&
      found.team === team &&
      hasRelayLegTime(found) &&
      keepRelayGender([found], gender, activeSwimmers).length > 0
    ) {
      hit = found;
    }
  }
  // With no leg named there is no swim to choose between: the id's own row.
  if (hit && !hasLegContext) return labelTimeTrialLeg(hit, settings);

  // Both paths choose among the swimmer's swims the same way: the id names the
  // swimmer (its row's name, with the stored name), and the fastest of their
  // swims that may fill the leg wins. A recruit row at another event, or a time
  // trial, no longer shadows the swimmer's program swim at the leg event.
  const keys = new Set<string>();
  if (override.assigneeName) keys.add(normalizeName(override.assigneeName));
  if (hit) keys.add(normalizeName(hit.name));
  if (keys.size === 0) return null;
  const named = activeSwimmers.filter(
    s => !s.isRelay && s.team === team && keys.has(normalizeName(s.name))
  );
  const matches = keepRelayGender(named, gender, named);
  if (relayEvent != null && legIndex != null) {
    const strokeMatches = matches.filter(m =>
      swimmerMatchesRelayLeg(m, relayEvent, legIndex, settings)
    );
    if (strokeMatches.length > 0) {
      strokeMatches.sort((a, b) => timeToSec(a.time) - timeToSec(b.time));
      return labelTimeTrialLeg(strokeMatches[0], settings);
    }
    // Nothing of the swimmer's fills the leg. The id's own row is still the
    // answer, so the leg check can say why (wrong event, or a time trial).
    return hit ? labelTimeTrialLeg(hit, settings) : null;
  }
  return matches.length === 0 ? null : matches[0];
}

/**
 * True when `swimmer` fails leg `legIndex` of `event` only because it is a
 * time-trial swim and `settings.relayLegsAllowTimeTrials` is off: with the
 * setting on, the same swim would match. A swim of another stroke or distance
 * is not this (it is a stroke mismatch).
 */
export function isTimeTrialOnlyForRelayLeg(
  swimmer: SwimmerResult,
  event: string,
  legIndex: number,
  settings?: RelayLegMatchSettings
): boolean {
  // With the setting on, the swim either matches (so this is false) or does not
  // match even as a time trial (so the second test is false).
  if (swimmerMatchesRelayLeg(swimmer, event, legIndex, settings)) return false;
  return swimmerMatchesRelayLeg(swimmer, event, legIndex, {
    ...settings,
    relayLegsAllowTimeTrials: true,
  });
}

/**
 * True when `override` names a swimmer whose only swim at the leg event is a
 * time trial: it resolves onto nothing now (`resolveOverrideAssignee`) and
 * would resolve onto that swim if `settings.relayLegsAllowTimeTrials` were on.
 * The caller reports the leg as `time_trial_only`, not as a plain vacant leg.
 *
 * `false` when the setting is on, and `false` when the override resolves onto
 * a swim now.
 */
export function overrideNamesTimeTrialOnlySwimmer(
  override: RelayLegOverride,
  activeSwimmers: SwimmerResult[],
  team: string,
  relayEvent: string,
  legIndex: number,
  relayGender?: Gender,
  settings?: RelayLegMatchSettings
): boolean {
  const gender = relayGender ?? relayEntryGender({ event: relayEvent });
  if (
    resolveOverrideAssignee(override, activeSwimmers, team, relayEvent, legIndex, gender, settings) !== null
  ) {
    return false;
  }
  return (
    resolveOverrideAssignee(override, activeSwimmers, team, relayEvent, legIndex, gender, {
      ...settings,
      relayLegsAllowTimeTrials: true,
    }) !== null
  );
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

/**
 * The fastest eligible swim for a leg, as an autofill override and the swim
 * behind it. A time trial is a candidate only when
 * `settings.relayLegsAllowTimeTrials` is `true`; `swimmer` then carries
 * `relayLegTimeTrial: true`.
 *
 * Pass `relayPool` (the relay rows `template` came from) so the override is
 * keyed to the one tied relay it fills (`relayEntryKeyIn`).
 */
export function suggestBestRelayLegFill(
  activeSwimmers: SwimmerResult[],
  template: SwimmerResult,
  legIndex: number,
  assignedInEvent: Set<string>,
  excludeNormalizedNames: Set<string>,
  settings?: RelayLegMatchSettings,
  relayPool?: readonly SwimmerResult[]
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
    relayEntryGender(template),
    settings
  );
  if (candidates.length === 0) return null;
  const swimmer = candidates[0];
  const override: RelayLegOverride = {
    relayEntryKey: relayEntryKeyIn(relayPool, template),
    legIndex,
    assigneeName: swimmer.name,
    recruitId: swimmer.isRecruit ? swimmer.id : undefined,
    classYear: swimmer.classYear as ClassYear,
    source: 'autofill',
  };
  return { override, swimmer };
}

/**
 * The overrides with `next` in place of the one it replaces: the override of the
 * same relay entry key and leg.
 *
 * Only the same key counts. An override stored under the plain key of a tied
 * pair is another relay's, or both relays' until `migrateTiedRelayOverrides`
 * splits it: replacing it here would drop the other relay's fill. Readers
 * migrate first, so a plain key left in the list still reaches the tied relay
 * `next` is not for.
 */
export function upsertRelayLegOverride(
  overrides: RelayLegOverride[],
  next: RelayLegOverride
): RelayLegOverride[] {
  return [
    ...overrides.filter(
      o => !(o.legIndex === next.legIndex && o.relayEntryKey === next.relayEntryKey)
    ),
    next,
  ];
}

/**
 * The overrides without the one stored under `entryKey` at `legIndex`.
 * `entryKey` is the key `stableRelayEntryKey` gives (a RelayGroup's `key`).
 *
 * A key saved before A and B were told apart is not `entryKey`. Pass a list
 * that went through `migrateTiedRelayOverrides`, or the legacy key stays and
 * the tied relays read it again after the next migration.
 */
export function removeRelayLegOverride(
  overrides: RelayLegOverride[],
  entryKey: string,
  legIndex: number
): RelayLegOverride[] {
  return overrides.filter(o => !(o.legIndex === legIndex && o.relayEntryKey === entryKey));
}

/**
 * True when the leg has an override stored under `entryKey`: the test
 * `removeRelayLegOverride` clears, and the answer `findRelayLegOverride` gives
 * (non-`undefined`) for the relay `entryKey` was made from.
 *
 * Use it for "is there an override to clear" on a relay group, passing the
 * group's `key` and a migrated list (`migrateTiedRelayOverrides`).
 */
export function hasRelayLegOverride(
  overrides: readonly RelayLegOverride[],
  entryKey: string,
  legIndex: number
): boolean {
  return overrides.some(o => o.legIndex === legIndex && o.relayEntryKey === entryKey);
}

export function relayMissingStrokeLabel(stroke: RelayLegStroke | undefined): string {
  if (!stroke) return '';
  const m: Record<RelayLegStroke, string> = { back: 'Back', breast: 'Breast', fly: 'Fly', free: 'Free' };
  return m[stroke] ?? stroke;
}
