/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 4: athlete history index. Test: npx tsx scripts/test_athlete_history.mjs
 */

import {
  Gender,
  HistoricalSwim,
  NcaaDivision,
  ScoringSettings,
  SwimmerResult,
  SwimCloudBadge,
  Workspace,
  AthleteEventProfile,
} from '../types';
import { divisionForTeamOrNull } from '../data/teamDivisions';
import { compareTimeToCutline } from './cutlineUtils';
import { mergeScoringSettings } from './scoringDefaults';
import {
  convertSwimToSCY,
  convertTimeToSeconds,
  convertToSCY,
  hasConversionFactor,
  isDivingEvent,
  isRelayResult,
  normalizeSwimmerName,
  stripEventGenderMarker,
} from './utils';
import { parseSwimCloudMultiProfile } from './swimCloudMultiProfile';
import {
  buildAliasResolver,
  IDENTITY_ALIAS_RESOLVER,
  type AthleteAliasResolver,
} from './athleteAliases';
import type { CatalogAthlete, CatalogEventTime, CatalogTeamRoster } from './rosterCatalog';
import { bestTimesByEvent } from './rosterCatalog';

function swimKey(name: string, team: string, gender: Gender, event: string): string {
  return `${normalizeSwimmerName(name)}|${team}|${gender}|${event}`;
}

export function historicalSwimFromResult(r: SwimmerResult, meetLabel?: string): HistoricalSwim | null {
  if (isRelayResult(r) && r.name !== r.team) return null;
  if (r.isRelay && r.name === r.team) return null;
  return {
    name: r.name,
    team: String(r.team ?? '').trim(),
    gender: (r.gender ?? Gender.MEN) as Gender,
    event: r.event,
    time: r.time,
    source: 'pdf',
    classYear: String(r.classYear ?? ''),
    meetLabel,
  };
}

export function buildHistoryFromWorkspace(workspace: Workspace): HistoricalSwim[] {
  const label = workspace.loadedMeet?.pdfFilename ?? workspace.name;
  const out: HistoricalSwim[] = [];
  for (const r of [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])]) {
    const h = historicalSwimFromResult(r, label);
    if (h) out.push(h);
  }
  return out;
}

export function mergeHistoryIndex(
  existing: HistoricalSwim[],
  incoming: HistoricalSwim[]
): HistoricalSwim[] {
  const best = new Map<string, HistoricalSwim>();
  for (const s of [...existing, ...incoming]) {
    // Best per event PER COURSE: an actual SCY swim and its LCM/SCM counterparts are
    // distinct facts — the cross-course arbitrage view needs both to compare.
    const key = `${swimKey(s.name, s.team, s.gender, s.event)}|${s.timeType ?? 'SCY'}`;
    // Raw seconds, deliberately: the key already pins both the event and the
    // course, so every swim compared here shares one conversion factor and the
    // conversion cancels out of the ordering. Converting first would also drag
    // non-program events (25s, 100 IM) through a factor table that does not
    // publish them, for a comparison that does not need it.
    const sec = convertTimeToSeconds(s.time);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, s);
      continue;
    }
    const prevSec = convertTimeToSeconds(prev.time);
    if (sec < prevSec) best.set(key, s);
  }
  return [...best.values()];
}

export function relayEventsForAthlete(
  results: SwimmerResult[],
  team: string,
  gender: Gender,
  name: string,
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER
): string[] {
  const nameKey = normalizeSwimmerName(resolver.resolveAthleteName(name, team, gender));
  const events = new Set<string>();
  for (const r of results) {
    if (r.gender != null && r.gender !== gender) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    if (normalizeSwimmerName(resolver.resolveAthleteName(r.name, team, gender)) !== nameKey) continue;
    if (isRelayResult(r) && r.name !== r.team) {
      events.add(r.event);
    }
  }
  return [...events];
}

export function categorizeBestEvents(
  history: HistoricalSwim[],
  team: string,
  gender: Gender,
  name: string,
  settings: ScoringSettings,
  relayEvents: string[] = [],
  resolver: AthleteAliasResolver = IDENTITY_ALIAS_RESOLVER,
  /**
   * Canonical events this profile may offer. Pass the loaded meet's program (see
   * {@link meetProgramEvents}) so an athlete is only ever proposed for an event
   * the meet actually contests. `null` falls back to the standard SCY
   * championship program, for recruit-driven workspaces with no meet loaded.
   */
  allowedEvents: ReadonlySet<string> | null = null
): AthleteEventProfile {
  const merged = mergeScoringSettings(settings);
  const indCap = merged.maxIndividualEntriesPerSwimmer ?? 3;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 4;
  const nameKey = normalizeSwimmerName(resolver.resolveAthleteName(name, team, gender));

  const bestByEvent: AthleteEventProfile['bestByEvent'] = {};
  for (const s of history) {
    if (s.gender !== gender || s.team !== team) continue;
    if (normalizeSwimmerName(resolver.resolveAthleteName(s.name, team, gender)) !== nameKey) continue;
    if (s.event.toLowerCase().includes('relay')) continue;
    // A metric swim in an event with no published conversion factor cannot be
    // stated in SCY. Skip it rather than let it into the ranking under another
    // event's factor.
    if ((s.timeType ?? 'SCY') !== 'SCY' && !hasConversionFactor(s.event)) continue;

    // Key on the SCY *program* event, not the raw history label: a 400 Free LCM
    // competes in the 500 Free slot (800→1000, 1500→1650). Keying on the raw
    // label left "400 Freestyle" and "1500 Freestyle" sitting in the profile as
    // if they were events a meet could enter you in.
    const { event: programEvent, time: programTime } = convertSwimToSCY(
      s.event,
      s.time,
      s.gender,
      s.timeType ?? 'SCY'
    );
    if (!isEventOffered(programEvent, allowedEvents)) continue;

    const sec = convertTimeToSeconds(programTime);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    const prev = bestByEvent[programEvent];
    if (!prev || sec < prev.timeSec) {
      bestByEvent[programEvent] = { time: programTime, timeSec: sec, source: s.source };
    }
  }

  // Quality first, then anything we hold no standard for. Unrankable events stay
  // eligible — they fill the cap only after every judged event has, so an athlete
  // whose events lack published standards still gets a lineup, and the caller can
  // see which picks were unjudged via `unrankedEvents`.
  const quality = rankEventsByQuality(bestByEvent, gender, team);
  const primaryEvents = [...quality.ranked, ...quality.unranked].slice(0, indCap);
  const relayList = relayEvents.slice(0, relayCap);

  return {
    name,
    team,
    gender,
    bestByEvent,
    primaryEvents,
    relayEvents: relayList,
    qualityByEvent: quality.ratioByEvent,
    unrankedEvents: quality.unranked,
    rankingDivision: quality.division,
    rankingTier: quality.tier,
  };
}

export type SwimCloudPasteFormat = 'personal_bests' | 'roster' | 'multi_profile' | 'unknown';

const TIME_RE = /^(\d{1,2}:)?\d{1,2}\.\d{2}$/;
const EVENT_COL_RE =
  /^\d+\s*(?:Yard\s*)?(?:Free|Fly|Back|Breast|IM|Individual Medley|Diving|Medley)/i;
const DATE_RE = /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/;
const LOCATION_RE = /^.+,\s*[A-Z]{2}$/;
const SKIP_LINE_RE =
  /^(personal bests|event progression|course|season|sort by|stamp link|event|time|meet|date|name|swimmer)$/i;

const STAMP_BADGE_MAP: Record<string, SwimCloudBadge> = {
  x: 'extracted',
  u: 'user_input',
  b: 'd1_b',
  'd1-b': 'd1_b',
  a: 'd1_a',
  'd1-a': 'd1_a',
};

function splitRow(line: string): string[] {
  if (line.includes('\t')) {
    return line.split('\t').map(c => c.trim());
  }
  return line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
}

function isTimeToken(s: string): boolean {
  return TIME_RE.test(s.trim());
}

function isEventToken(s: string): boolean {
  return EVENT_COL_RE.test(s.trim());
}

function parseStampToken(raw: string): SwimCloudBadge | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (STAMP_BADGE_MAP[key]) return STAMP_BADGE_MAP[key];
  if (/^d1-?[ab]$/i.test(raw)) return raw.toLowerCase().includes('a') ? 'd1_a' : 'd1_b';
  if (/^(r|rcon|pb)$/i.test(raw)) return 'other';
  return null;
}

function parseCourseFromEvent(raw: string): 'SCY' | 'LCM' | 'SCM' | undefined {
  if (/\bLCM\b/i.test(raw)) return 'LCM';
  if (/\bSCM\b/i.test(raw)) return 'SCM';
  if (/\bSCY\b/i.test(raw)) return 'SCY';
  return undefined;
}

export function normalizeEventLabel(raw: string): string {
  let e = raw.replace(/\s+/g, ' ').trim();
  e = e.replace(/\b(SCY|LCM|SCM)\b/gi, '').trim();
  if (/\bfly\b/i.test(e) && !/butterfly/i.test(e)) {
    e = e.replace(/\bfly\b/i, 'Butterfly');
  }
  if (/\bback\b/i.test(e) && !/backstroke/i.test(e)) {
    e = e.replace(/\bback\b/i, 'Backstroke');
  }
  if (/\bbreast\b/i.test(e) && !/breaststroke/i.test(e)) {
    e = e.replace(/\bbreast\b/i, 'Breaststroke');
  }
  if (/\bfree\b/i.test(e) && !/freestyle/i.test(e)) {
    e = e.replace(/\bfree\b/i, 'Freestyle');
  }
  if (/\bIM\b/.test(e) && !/individual medley/i.test(e)) {
    e = e.replace(/\bIM\b/, 'Individual Medley');
  }
  return e.replace(/\s+/g, ' ').trim();
}

/** Canonical SCY championship individual program events (normalized labels). */
const CHAMPIONSHIP_PROGRAM_EVENTS = new Set<string>([
  '50 Freestyle',
  '100 Freestyle',
  '200 Freestyle',
  '500 Freestyle',
  '1000 Freestyle',
  '1650 Freestyle',
  '100 Backstroke',
  '200 Backstroke',
  '100 Breaststroke',
  '200 Breaststroke',
  '100 Butterfly',
  '200 Butterfly',
  '200 Individual Medley',
  '400 Individual Medley',
]);

/**
 * True only for events that can be scored as championship lineup entries: the standard
 * SCY individual program (50/100/200/500/1000/1650 Free, 100/200 stroke, 200/400 IM) and
 * relays. Excludes 25s, 100 IM, diving, and odd metric distances so they are never picked
 * as lineup entries (their swims are still retained in athleteHistory).
 *
 * This is the *fallback* program, used only when no meet is loaded. When a meet is
 * loaded, the program comes from the meet — see {@link meetProgramEvents}. A
 * conference that contests 100 IM is served by the meet-derived set, not by this
 * constant.
 */
export function isChampionshipProgramEvent(event: string): boolean {
  if (/\brelay\b/i.test(event)) return true;
  return CHAMPIONSHIP_PROGRAM_EVENTS.has(normalizeEventLabel(event));
}

/**
 * Canonical individual-event label for an arbitrary meet event string, WITHOUT
 * the championship whitelist. Handles HyTek labels
 * ("Event 24 Men 100 Yard Backstroke" -> "100 Backstroke").
 *
 * Deliberately unfiltered: the loaded meet defines its own program. NSISC does not
 * contest the 100 IM, but another conference may, and a hardcoded list cannot know
 * that. Relays and diving return null — neither is an individual entry candidate.
 */
export function canonicalMeetEventLabel(raw: string): string | null {
  if (!raw) return null;
  if (/\brelay\b/i.test(raw)) return null;
  if (isDivingEvent(raw)) return null;
  let e = stripEventGenderMarker(raw);
  e = e.replace(/\bEvent\s+\d+\b/gi, ' ');
  e = e.replace(/\b(Yards?|Meters?|mtr|SCY|SCM|LCM)\b/gi, ' ');
  e = e.replace(/\s{2,}/g, ' ').trim();
  if (!e) return null;
  const norm = normalizeEventLabel(e);
  return norm || null;
}

/**
 * The individual events a loaded meet actually contests, as canonical labels.
 *
 * This is the authority for "what can this athlete be entered in". Pass the FROZEN
 * source results (`getSourceResults`) rather than the working copy, so planned
 * entries cannot widen the program that is supposed to constrain them.
 *
 * Time trials are excluded: they are swum at the meet but score nothing, so they
 * are not an opportunity to gain points. Returns an empty set when no meet is
 * loaded; callers treat empty as "fall back to the championship program".
 */
export function meetProgramEvents(results: SwimmerResult[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const r of results ?? []) {
    if (isRelayResult(r)) continue;
    if (r.isTimeTrial) continue;
    const canon = canonicalMeetEventLabel(r.event);
    if (canon) set.add(canon);
  }
  return set;
}

/** Is `event` one this profile may offer, given the meet program (or the fallback)? */
function isEventOffered(event: string, allowed: ReadonlySet<string> | null): boolean {
  const norm = normalizeEventLabel(event);
  if (allowed && allowed.size > 0) return allowed.has(norm);
  return isChampionshipProgramEvent(norm) && !/\brelay\b/i.test(norm);
}

export type EventQualityRanking = {
  /** Rankable events, best first. */
  ranked: string[];
  /** Events with no published standard to judge against, fastest first. */
  unranked: string[];
  /** `swimSeconds / standardSeconds` per rankable event. Lower is better. */
  ratioByEvent: Record<string, number>;
  division: NcaaDivision | null;
  tier: 'A' | 'B' | null;
};

/**
 * Order an athlete's events by how good the swim actually is, not by how short
 * the event is.
 *
 * Sorting by raw elapsed seconds — which this replaces — ranks a 50 Free above a
 * 1650 Free for every swimmer alive, because 20 is less than 900. It measures
 * event length. Under a total-entry cap that silently entered distance swimmers
 * in sprints: on the HSU roster it dropped 1000/1650/500 Free and 400 IM in
 * favour of 50/100 Free for athletes whose distance swims were at the standard
 * and whose sprints were 10%+ off it.
 *
 * The yardstick is each event's published NCAA standard for the team's division,
 * already archived under `data/cutlines/` with a manifest. Ratio = swim ÷
 * standard, so events of wildly different lengths become comparable.
 *
 * Two rules the repo already holds, applied here:
 *
 *  - **An unmapped team is not a D1 team.** With no division we hold no table, so
 *    nothing is rankable and every event comes back in `unranked`.
 *  - **One tier for the whole profile.** A ratio against the permissive tier and a
 *    ratio against the strict tier are different scales; mixing them would make an
 *    event look stronger purely because it was measured against a slower mark.
 *    Events lacking the chosen tier are `unranked`, never quietly rescaled.
 */
export function rankEventsByQuality(
  bestByEvent: AthleteEventProfile['bestByEvent'],
  gender: Gender,
  team: string,
  divisionOverride?: NcaaDivision | null
): EventQualityRanking {
  const events = Object.keys(bestByEvent);
  const byTimeThenName = (list: string[]) =>
    [...list].sort(
      (a, b) => (bestByEvent[a]?.timeSec ?? 0) - (bestByEvent[b]?.timeSec ?? 0) || a.localeCompare(b)
    );

  const division = divisionOverride !== undefined ? divisionOverride : divisionForTeamOrNull(team);
  if (!division) {
    return { ranked: [], unranked: byTimeThenName(events), ratioByEvent: {}, division: null, tier: null };
  }

  const refs = new Map<string, { a: number; b: number }>();
  for (const event of events) {
    const sec = bestByEvent[event]?.timeSec ?? 0;
    const cmp = compareTimeToCutline(sec, gender, event, division);
    refs.set(event, cmp.status === 'ok' ? { a: cmp.aCutSec, b: cmp.bCutSec } : { a: 0, b: 0 });
  }

  const withB = events.filter(e => (refs.get(e)?.b ?? 0) > 0);
  const withA = events.filter(e => (refs.get(e)?.a ?? 0) > 0);
  const tier: 'A' | 'B' | null =
    withB.length > 0 && withB.length >= withA.length ? 'B' : withA.length > 0 ? 'A' : null;
  if (!tier) {
    return { ranked: [], unranked: byTimeThenName(events), ratioByEvent: {}, division, tier: null };
  }

  const ratioByEvent: Record<string, number> = {};
  const ranked: string[] = [];
  const unranked: string[] = [];
  for (const event of events) {
    const ref = tier === 'B' ? refs.get(event)?.b ?? 0 : refs.get(event)?.a ?? 0;
    const sec = bestByEvent[event]?.timeSec ?? 0;
    if (ref > 0 && Number.isFinite(sec) && sec > 0) {
      ratioByEvent[event] = sec / ref;
      ranked.push(event);
    } else {
      unranked.push(event);
    }
  }
  ranked.sort((a, b) => ratioByEvent[a] - ratioByEvent[b] || a.localeCompare(b));
  return { ranked, unranked: byTimeThenName(unranked), ratioByEvent, division, tier };
}

function looksLikePersonName(line: string): boolean {
  const t = line.trim();
  if (!t || t.includes('\t')) return false;
  if (SKIP_LINE_RE.test(t)) return false;
  if (LOCATION_RE.test(t)) return false;
  if (isEventToken(t) || isTimeToken(t)) return false;
  if (/university|college|school|swimming|team/i.test(t) && t.split(/\s+/).length > 2) return false;
  const parts = t.split(/\s+/);
  return parts.length >= 2 && parts.length <= 5 && /^[A-Za-z]/.test(parts[0]);
}

export function extractSwimmerNameFromPaste(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (looksLikePersonName(t)) return t;
  }
  return undefined;
}

function isHeaderOrJunkLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (SKIP_LINE_RE.test(t)) return true;
  if (/^event\s+time/i.test(t)) return true;
  if (LOCATION_RE.test(t)) return true;
  if (/^(personal bests|event progression)$/i.test(t)) return true;
  return false;
}

/** A bare name line in a multi-profile paste (no tab, not an event/time/header row). */
export function isProfileNameLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.includes('\t')) return false;
  if (isHeaderOrJunkLine(t)) return false;
  return looksLikePersonName(t);
}

/** Count bare name lines each followed (within their block) by >=1 personal-bests row. */
function countProfileBlocks(text: string): number {
  let blocks = 0;
  let pending = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (isProfileNameLine(t)) {
      pending = true;
      continue;
    }
    if (isHeaderOrJunkLine(t)) continue;
    const cols = splitRow(t);
    if (cols.length >= 2 && isEventToken(cols[0]) && isTimeToken(cols[1]) && pending) {
      blocks += 1;
      pending = false;
    }
  }
  return blocks;
}

export function detectSwimCloudPasteFormat(text: string): SwimCloudPasteFormat {
  if (countProfileBlocks(text) >= 2) return 'multi_profile';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || isHeaderOrJunkLine(t)) continue;
    const cols = splitRow(t);
    if (cols.length < 2) continue;
    if (isEventToken(cols[0]) && isTimeToken(cols[1])) return 'personal_bests';
    if (looksLikePersonName(cols[0])) return 'roster';
    break;
  }
  return 'unknown';
}

/**
 * Stamp each swim with the cut it achieved, judged against **its own team's**
 * division table. These values become the cut badges a coach reads.
 *
 * `division` follows the same three-state contract as
 * {@link rankEventsByQuality}: `undefined` means "resolve it from the team",
 * `null` means the caller has already established it is unresolvable, and a
 * division wins outright.
 *
 * This resolved through the deprecated `divisionForTeam`, which answers `D1` for
 * every team it does not recognise. D1 publishes the fastest standards, so an
 * unmapped D2/D3/NAIA program had its cuts silently under-reported — and a swim
 * quick enough for the D1 mark was stamped with a badge from a table that never
 * applied to it. Neither failure throws; both render as a plausible badge.
 * `divisionForTeamOrNull` returns the honest answer, and `compareTimeToCutline`
 * reports the same case as `status: 'no_table_for_division'`.
 *
 * One consequence to carry downstream: `computedCut: null` is under-determined
 * on its own — it covers both "we hold no table" and "missed every published
 * standard". Per `CutlineLookupStatus`, only `status: 'ok'` licenses the
 * statement "did not achieve a cut", so a caller rendering that phrase must
 * re-check `divisionForTeamOrNull(team)` (or the lookup status) first rather
 * than reading a null here as a miss.
 */
function enrichWithComputedCut(
  swims: HistoricalSwim[],
  team: string,
  division?: NcaaDivision | null
): HistoricalSwim[] {
  const div = division !== undefined ? division : divisionForTeamOrNull(team);
  return swims.map(s => {
    // Two swims we hold no standard for: a metric swim (the NCAA publishes SCY
    // standards only) and any swim whose division did not resolve. Neither may
    // be given a verdict here; a value the caller arrived with is theirs to keep.
    if (!div || (s.timeType && s.timeType !== 'SCY')) {
      return { ...s, computedCut: s.computedCut ?? null };
    }
    const sec = convertTimeToSeconds(convertToSCY(s.time, s.event, s.gender, s.timeType ?? 'SCY'));
    const { achieved } = compareTimeToCutline(sec, s.gender, s.event, div);
    return { ...s, computedCut: achieved };
  });
}

export function parseSwimCloudStampBadge(raw: string): SwimCloudBadge {
  return parseStampToken(raw) ?? 'none';
}

/**
 * `division` may be passed `null` to state outright that the team's division is
 * unknown; omitting it resolves from the team. Either way an unresolved division
 * yields `computedCut: null` rather than a verdict from the D1 table.
 */
export function parseSwimCloudPersonalBests(
  text: string,
  swimmerName: string,
  team: string,
  gender: Gender,
  division?: NcaaDivision | null
): HistoricalSwim[] {
  const out: HistoricalSwim[] = [];
  const name = swimmerName.trim();
  if (!name) return out;

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || isHeaderOrJunkLine(t)) continue;
    const cols = splitRow(t);
    if (cols.length < 2) continue;
    if (!isEventToken(cols[0]) || !isTimeToken(cols[1])) continue;

    const rawEvent = cols[0];
    const time = cols[1];
    const timeType = parseCourseFromEvent(rawEvent) ?? 'SCY';
    let rest = cols.slice(2).filter(c => c.length > 0);

    let swimcloudBadge: SwimCloudBadge = 'none';
    if (rest.length > 0) {
      const stamp = parseStampToken(rest[0]);
      if (stamp) {
        swimcloudBadge = stamp;
        rest = rest.slice(1);
      }
    }

    let meetLabel = '';
    let date = '';
    for (const c of rest) {
      if (!date && DATE_RE.test(c)) {
        date = c;
      } else if (!meetLabel && c.length > 3 && !DATE_RE.test(c)) {
        meetLabel = c;
      }
    }

    out.push({
      name,
      team,
      gender,
      event: normalizeEventLabel(rawEvent),
      time,
      timeType,
      meetLabel: meetLabel || undefined,
      date: date || undefined,
      source: 'paste',
      swimcloudBadge,
    });
  }

  return enrichWithComputedCut(out, team, division);
}

/** `division` takes the same three states as {@link parseSwimCloudPersonalBests}. */
export function parseSwimCloudRosterPaste(
  text: string,
  team: string,
  gender: Gender,
  division?: NcaaDivision | null
): HistoricalSwim[] {
  const eventRe =
    /(\d+\s*(?:Yard\s*)?(?:Freestyle|Backstroke|Breaststroke|Butterfly|IM|Individual Medley|Diving)[^\t]*)/i;
  const timeRe = /(\d{1,2}:)?\d{1,2}\.\d{2}/;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out: HistoricalSwim[] = [];

  for (const line of lines) {
    const cols = line.split(/\t+|\s{2,}/).map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const swimmer = cols[0];
    if (!swimmer || /^(name|swimmer|event)/i.test(swimmer)) continue;
    let event = '';
    let time = '';
    for (const c of cols.slice(1)) {
      if (!event && eventRe.test(c)) event = c.replace(/\s+/g, ' ').trim();
      else if (!time && timeRe.test(c)) time = c.match(timeRe)![0];
    }
    if (!event || !time) continue;
    out.push({
      name: swimmer,
      team,
      gender,
      event: normalizeEventLabel(event),
      time,
      source: 'paste',
      swimcloudBadge: 'none',
    });
  }

  return enrichWithComputedCut(out, team, division);
}

export type ParseSwimCloudOptions = {
  team: string;
  gender: Gender;
  swimmerName?: string;
  format?: 'auto' | 'personal_bests' | 'roster' | 'multi_profile';
  division?: NcaaDivision;
};

export type ParseSwimCloudResult = {
  swims: HistoricalSwim[];
  format: SwimCloudPasteFormat;
  warnings: string[];
  detectedName?: string;
};

export function parseSwimCloudPaste(
  text: string,
  teamOrOpts: string | ParseSwimCloudOptions,
  genderArg?: Gender
): HistoricalSwim[] | ParseSwimCloudResult {
  const opts: ParseSwimCloudOptions =
    typeof teamOrOpts === 'string'
      ? { team: teamOrOpts, gender: genderArg ?? Gender.MEN, format: 'auto' }
      : teamOrOpts;

  const result = parseSwimCloudPasteDetailed(text, opts);
  if (typeof teamOrOpts === 'string') {
    return result.swims;
  }
  return result;
}

export function parseSwimCloudPasteDetailed(
  text: string,
  opts: ParseSwimCloudOptions
): ParseSwimCloudResult {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return { swims: [], format: 'unknown', warnings: ['Paste is empty'] };
  }

  const detectedName = extractSwimmerNameFromPaste(trimmed);
  let format = opts.format === 'auto' || !opts.format ? detectSwimCloudPasteFormat(trimmed) : opts.format;

  if (format === 'unknown') {
    warnings.push('Could not detect paste format; tried personal bests layout');
    format = 'personal_bests';
  }

  let swims: HistoricalSwim[] = [];
  if (format === 'multi_profile') {
    const multi = parseSwimCloudMultiProfile(trimmed, {
      team: opts.team,
      gender: opts.gender,
      division: opts.division,
    });
    swims = multi.athletes.flatMap(a => a.swims);
    warnings.push(...multi.warnings);
    warnings.push(`Multi-profile paste: ${multi.athletes.length} athlete(s) parsed`);
    if (swims.some(s => s.timeType === 'LCM' || s.timeType === 'SCM')) {
      warnings.push('LCM/SCM times included — cut comparison uses SCY conversion where applicable');
    }
    if (swims.length === 0) {
      warnings.push('No swim rows parsed — check copy includes the Personal Bests tables');
    }
    return { swims, format, warnings, detectedName };
  }
  if (format === 'personal_bests') {
    const swimmerName = (opts.swimmerName ?? detectedName ?? '').trim();
    if (!swimmerName) {
      warnings.push('Swimmer name required for personal bests paste');
      return { swims: [], format, warnings, detectedName };
    }
    swims = parseSwimCloudPersonalBests(trimmed, swimmerName, opts.team, opts.gender, opts.division);
    if (swims.some(s => s.timeType === 'LCM' || s.timeType === 'SCM')) {
      warnings.push('LCM/SCM times included — cut comparison uses SCY conversion where applicable');
    }
    if (swims.some(s => s.swimcloudBadge === 'user_input')) {
      warnings.push('Some rows are user-entered (U) — not from official meet files');
    }
  } else {
    swims = parseSwimCloudRosterPaste(trimmed, opts.team, opts.gender, opts.division);
  }

  if (swims.length === 0) {
    warnings.push('No swim rows parsed — check copy includes the Personal Bests table');
  }

  return { swims, format, warnings, detectedName };
}

export function matchAthleteToRoster(
  name: string,
  rosterNames: string[]
): { match: string | null; confidence: number } {
  const key = normalizeSwimmerName(name);
  for (const r of rosterNames) {
    if (normalizeSwimmerName(r) === key) return { match: r, confidence: 1 };
  }
  for (const r of rosterNames) {
    if (normalizeSwimmerName(r).includes(key) || key.includes(normalizeSwimmerName(r))) {
      return { match: r, confidence: 0.7 };
    }
  }
  return { match: null, confidence: 0 };
}

export function getAthleteProfile(
  workspace: Workspace,
  team: string,
  gender: Gender,
  name: string,
  settings: ScoringSettings,
  resolver?: AthleteAliasResolver
): AthleteEventProfile {
  const alias = resolver ?? buildAliasResolver(workspace);
  const pdfHistory = buildHistoryFromWorkspace(workspace);
  const merged = mergeHistoryIndex(pdfHistory, workspace.athleteHistory ?? []);
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const relays = relayEventsForAthlete(results, team, gender, name, alias);
  // Constrain the profile to what the loaded meet actually contests, read from the
  // FROZEN source copy so planned entries cannot widen their own constraint. An
  // empty set (no meet loaded) falls back to the standard championship program.
  const sourceResults =
    gender === Gender.MEN
      ? workspace.sourceMenResults ?? workspace.menResults
      : workspace.sourceWomenResults ?? workspace.womenResults;
  const program = meetProgramEvents(sourceResults);
  return categorizeBestEvents(
    merged,
    team,
    gender,
    name,
    settings,
    relays,
    alias,
    program.size > 0 ? program : null
  );
}
// ===================== Catalog-backed helpers =====================

/**
 * Build an `AthleteEventProfile` strictly from a catalog roster (no
 * `Workspace.athleteHistory` mixing). Used by the Manager UI to render the
 * athlete's effective best times from the long-lived catalog.
 */
export function buildEventProfileFromCatalog(
  roster: CatalogTeamRoster | undefined,
  teamName: string,
  gender: Gender,
  fullName: string,
  settings: ScoringSettings,
  /** Loaded meet's program; see {@link meetProgramEvents}. Null falls back to the championship program. */
  allowedEvents: ReadonlySet<string> | null = null
): AthleteEventProfile | null {
  if (!roster) return null;
  const merged = mergeScoringSettings(settings);
  const indCap = merged.maxIndividualEntriesPerSwimmer ?? 3;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 4;
  const athlete = roster.athletes.find(
    a =>
      normalizeSwimmerName(a.fullName) === normalizeSwimmerName(fullName) &&
      (a.gender === (gender === Gender.WOMEN ? 'Women' : 'Men'))
  );
  if (!athlete) return null;
  void teamName;

  const bestMap = bestTimesByEvent(athlete.times);
  const bestByEvent: AthleteEventProfile['bestByEvent'] = {};
  for (const [event, t] of bestMap.entries()) {
    if (event.toLowerCase().includes('relay')) continue;
    // Same gate as the history-backed profile: only events the loaded meet
    // contests (or the championship program when no meet is loaded). Without it
    // a catalog 50 Butterfly became a scoring "opportunity" in a meet that
    // contests no 50s of stroke.
    if (!isEventOffered(event, allowedEvents)) continue;
    bestByEvent[event] = {
      time: t.timeText,
      timeSec: t.timeSecondsScy,
      source: t.source,
    };
  }
  // Same quality ranking as the history-backed profile — raw seconds here would
  // have ordered a catalog athlete's events by length just as it did there.
  const quality = rankEventsByQuality(bestByEvent, gender, roster.team.name);
  const primaryEvents = [...quality.ranked, ...quality.unranked].slice(0, indCap);

  const relayEvents: string[] = [];
  for (const t of athlete.times) {
    if (t.event.toLowerCase().includes('relay') && t.isEligible) {
      relayEvents.push(t.event);
    }
  }
  const dedupedRelays = [...new Set(relayEvents)].slice(0, relayCap);

  return {
    name: athlete.fullName,
    team: roster.team.name,
    gender,
    bestByEvent,
    primaryEvents,
    relayEvents: dedupedRelays,
    qualityByEvent: quality.ratioByEvent,
    unrankedEvents: quality.unranked,
    rankingDivision: quality.division,
    rankingTier: quality.tier,
  };
}

/** Toggle a single time's eligibility inside a roster (immutable update). */
export function toggleSwimEligibility(
  roster: CatalogTeamRoster,
  athleteId: string,
  timeId: string,
  isEligible: boolean
): CatalogTeamRoster {
  return {
    ...roster,
    athletes: roster.athletes.map((a: CatalogAthlete & { times: CatalogEventTime[] }) =>
      a.id === athleteId
        ? {
            ...a,
            times: a.times.map((t: CatalogEventTime) =>
              t.id === timeId ? { ...t, isEligible, updatedAt: Date.now() } : t
            ),
          }
        : a
    ),
  };
}

/** Search the roster for an athlete by name; returns the strongest match. */
export function findAthleteInRoster(
  roster: CatalogTeamRoster | undefined,
  fullName: string,
  gender: Gender
): CatalogAthlete | undefined {
  if (!roster) return undefined;
  const candidates = roster.athletes.filter(
    a => a.gender === (gender === Gender.WOMEN ? 'Women' : 'Men')
  );
  const exact = candidates.find(
    a => normalizeSwimmerName(a.fullName) === normalizeSwimmerName(fullName)
  );
  if (exact) return exact;
  return candidates.find(a =>
    normalizeSwimmerName(a.fullName).includes(normalizeSwimmerName(fullName)) ||
    normalizeSwimmerName(fullName).includes(normalizeSwimmerName(a.fullName))
  );
}
