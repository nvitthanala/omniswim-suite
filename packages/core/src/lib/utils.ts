/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gender,
  ScorerRosterOverride,
  SwimmerResult,
  Recruit,
  ClassYear,
  ScoringSettings,
  TeamScore,
  RelayMissingLeg,
  RelayLegOverride,
} from '../types';
import {
  buildScorerRosterLookup,
  isAbFinalRelayLeg,
  relayEntryRosterEligible,
  ScorerRosterLookup,
  usesScorerRoster,
} from './scorerRoster';
import { CONVERSION_FACTORS, SCORING_POINTS } from '../constants';
import { DEFAULT_SCORING_SETTINGS, effectivePdfPlacePointsMode, mergeScoringSettings } from './scoringDefaults';
import {
  buildSyntheticLegSplitDetail,
  normalizeRelayLegSplitDetail,
  parseRelayDistanceYards,
  rebuildTeamSplitSummary,
  relayLegDistanceYards,
} from './relaySplits';
import {
  eventMatchesStrokeDistance,
  findRelayLegOverride,
  inferRelayStrokeDistance,
  relayStrokeForIndex,
  resolveOverrideAssignee,
  strokeKeywordsForRelayLeg,
  swimmerMatchesRelayLeg,
} from './relayLegMatching';

export { DEFAULT_SCORING_SETTINGS, mergeScoringSettings } from './scoringDefaults';
import teamColorsData from '../team_colors.json';
import {
  colorForChartStroke,
  parseTeamColorEntry,
  resolveTeamColorKey,
  type TeamColorJsonEntry,
} from './teamColorLookup';

export {
  colorForChartStroke,
  normalizeTeamNameForColorLookup,
  parseTeamColorEntry,
  resolveTeamColorKey,
  scoreTeamColorKeyMatch,
} from './teamColorLookup';

/** Curated secondary accents where many programs share the same primary in data. */
const MANUAL_TEAM_SECONDARY: Record<string, string> = {
  'wayne state university': '#FFCC00',
  'wayne state': '#FFCC00',
  'wayne st.': '#FFCC00',
  'wayne st': '#FFCC00',
  'grand valley state university': '#A2B8C8',
  'grand valley': '#A2B8C8',
  'gvsu': '#A2B8C8',
  'uw-green bay': '#FFFFFF',
  'iowa state': '#F1BE48',
  'iowa st.': '#F1BE48',
  'iowa st': '#F1BE48',
  'youngstown state': '#FFFFFF',
  'youngstown st': '#FFFFFF',
  'lenoir-rhyne university': '#000000',
  'lenoir-rhyne': '#000000',
  'emmanuel college': '#002D62',
  'emmanuel (ga)': '#002D62',
  'emmanuel': '#002D62',
  'florida tech': '#CBA052',
  'carson-newman university': '#E2C044',
  'carson-newman': '#E2C044',
  'catawba college': '#C8102E',
  'catawba': '#C8102E',
  'denison': '#FFFFFF',
  'houston': '#FFFFFF',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim();
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  if (h.length === 6) {
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Euclidean distance in RGB, max ~441. */
export function rgbColorDistance(a: string, b: string): number {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return 999;
  return Math.sqrt((A.r - B.r) ** 2 + (A.g - B.g) ** 2 + (A.b - B.b) ** 2);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      break;
    case g:
      h = ((b - r) / d + 2) * 60;
      break;
    default:
      h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

/** Distinct secondary for charts on dark UI; stable per team name. */
export function synthesizeSecondaryColor(primary: string, salt: string | null | undefined): string {
  const rgb = hexToRgb(primary);
  if (!rgb) return '#00F5FF';
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const sSafe = String(salt ?? 'x');
  const hash = Array.from(sSafe.toLowerCase()).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const h2 = (h + 38 + (hash % 180)) % 360;
  const s2 = Math.min(0.95, s + 0.15);
  const l2 = Math.min(0.82, Math.max(0.35, l + (hash % 2 === 0 ? 0.18 : -0.1)));
  const o = hslToRgb(h2, s2, l2);
  return rgbToHex(o.r, o.g, o.b);
}

const COLOR_CLOSE_THRESHOLD = 42;
const DASH_PATTERNS: (string | undefined)[] = [undefined, '6 4', '2 3', '10 4', '4 2 1 2', '8 3 2 3'];

function buildNormalizedColorMap(): Record<string, TeamColorJsonEntry> {
  const out: Record<string, TeamColorJsonEntry> = {};
  for (const [key, val] of Object.entries(teamColorsData as Record<string, TeamColorJsonEntry>)) {
    out[key.toLowerCase()] = val;
  }
  return out;
}

let cachedColorMap: Record<string, TeamColorJsonEntry> | null = null;
function getNormalizedColorMap(): Record<string, TeamColorJsonEntry> {
  if (!cachedColorMap) cachedColorMap = buildNormalizedColorMap();
  return cachedColorMap;
}

export function getTeamColors(teamName: string | null | undefined): { primary: string; secondary: string } {
  const safeName = String(teamName ?? 'Unknown').trim() || 'Unknown';
  const normalizedMap = getNormalizedColorMap();

  const matchKey = resolveTeamColorKey(safeName, normalizedMap);
  const entry = matchKey ? normalizedMap[matchKey] : undefined;

  let primary: string;
  let secondaryFromJson: string | undefined;

  if (entry) {
    const parsed = parseTeamColorEntry(entry);
    primary = parsed.primary;
    secondaryFromJson = parsed.secondary;
  } else {
    const hash = Array.from(safeName).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const colors = ['#00F5FF', '#FF00FF', '#39FF14', '#FFD700', '#FF4444', '#8A2BE2', '#FF8C00'];
    primary = colors[hash % colors.length];
  }

  const searchName = safeName.toLowerCase();
  const manual = MANUAL_TEAM_SECONDARY[searchName];
  if (manual) {
    return { primary, secondary: manual };
  }
  for (const [k, v] of Object.entries(MANUAL_TEAM_SECONDARY)) {
    if (searchName.includes(k) || k.includes(searchName)) {
      return { primary, secondary: v };
    }
  }

  const secondary = secondaryFromJson || synthesizeSecondaryColor(primary, safeName);
  return { primary, secondary };
}

export function convertTimeToSeconds(timeStr: string): number {
  if (!timeStr || timeStr === 'NT' || timeStr === 'DQ') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(parts[0]);
}

export function formatSecondsToTime(seconds: number): string {
  if (seconds === Infinity) return 'NT';
  if (seconds < 60) return seconds.toFixed(2);
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, '0')}`;
}

/** Case-insensitive name key for roster / relay matching. */
export function normalizeSwimmerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function relayGroupKey(r: SwimmerResult): string {
  const clock = relayTeamClock(r) || r.time;
  const t = convertTimeToSeconds(clock);
  const rk = parseRankInt(r.rank) ?? '';
  const rs = (r.roundSwam || '').trim();
  return `${(r.team || '').trim()}|${r.event}|${rs}|${rk}|${t}`;
}

export function calculateProjectedTime(timeSec: number, classYear: string, overallDropPercent = -1.0): number {
  let yearsRemaining = 0;
  if (classYear === 'FR') yearsRemaining = 3;
  if (classYear === 'SO') yearsRemaining = 2;
  if (classYear === 'JR') yearsRemaining = 1;
  if (classYear === 'HS') yearsRemaining = 4;
  
  if (yearsRemaining === 0) return timeSec;
  
  // Apply a drop of overallDropPercent% over the 4 years, mathematically prorated.
  const dropFraction = (overallDropPercent / 100) * (yearsRemaining / 4);
  return timeSec * (1 + dropFraction);
}

export function convertToSCY(timeStr: string, event: string, gender: Gender, type: 'LCM' | 'SCM' | 'SCY'): string {
  if (type === 'SCY') return timeStr;

  const seconds = convertTimeToSeconds(timeStr);
  const baseEvent = event.replace(/\s*\(Relay split\)\s*$/i, '').trim();
  let factors = CONVERSION_FACTORS[baseEvent];
  if (!factors && baseEvent.startsWith('50 ')) {
    const hundredKey = baseEvent.replace(/^50\s+/, '100 ');
    factors = CONVERSION_FACTORS[hundredKey];
  }
  if (!factors) factors = CONVERSION_FACTORS['50 Freestyle'];
  
  let factor = 1.0;
  if (type === 'LCM') {
    factor = gender === Gender.MEN ? factors.men_lcm : factors.women_lcm;
  } else if (type === 'SCM') {
    factor = factors.both_scm;
  }
  
  return formatSecondsToTime(seconds * factor);
}

const DEFAULT_UNSCORED_ROUNDS = [
  'C FINAL',
  'C-FINAL',
  'BONUS FINAL',
  'D FINAL',
  'D-FINAL',
  'TIME TRIAL',
];

const INSTITUTION_TEAM_HINT =
  /\b(university|college|institute|seminary|baptist|methodist|lutheran|catholic|christian|technological|polytechnic|academy|national|international)\b/i;

/** True if string looks like a school name (not a bare "First Last" athlete). */
export function looksLikeInstitutionTeamName(team: string | null | undefined): boolean {
  const s = String(team ?? '').trim();
  if (!s) return false;
  if (INSTITUTION_TEAM_HINT.test(s)) return true;
  if (/\b(st\.|st\s|'s)\b/i.test(s)) return true;
  if (/\btech\b/i.test(s)) return true;
  if (/\ba\s*&\s*m\b/i.test(s)) return true;
  if (/\bstate\b/i.test(s)) return true;
  return false;
}

export function classifyRoundTier(
  roundSwam: string | undefined
): 'A' | 'B' | 'C' | 'D' | 'PRE' | 'TT' | 'FIN' | 'UNK' {
  const r = (roundSwam || '').toUpperCase();
  if (r.includes('TIME TRIAL') || r.includes('TIME TRIALS')) return 'TT';
  if (r.includes('C FINAL') || r.includes('C-FINAL') || r.includes('BONUS FINAL')) return 'C';
  if (r.includes('D FINAL') || r.includes('D-FINAL')) return 'D';
  if (r.includes('PRELIM')) return 'PRE';
  if (r.includes('B FINAL') || r.includes('B-FINAL') || r.includes('CONSOLATION')) return 'B';
  if (r.includes('A FINAL') || r.includes('A-FINAL') || r.includes('CHAMPIONSHIP')) return 'A';
  // HyTek distance timed-finals label (not A/B bracket heats)
  if (/^FINALS?$/.test(r.trim()) || (/\bFINALS?\b/.test(r) && !/[ABCD]\s*FINAL/.test(r))) return 'FIN';
  return 'UNK';
}

function isDistanceEvent(event: string | undefined): boolean {
  if (!event) return false;
  const u = event.toUpperCase();
  return /\b(1000|1650|1500|800|10000)\b/.test(u) || u.includes('TIMED');
}

/** Post-meet championship swims (HyTek Boys/Girls events) — scored like finals, not exhibition TTs. */
function isChampionshipGenderEvent(event: string | undefined): boolean {
  if (!event) return false;
  return /\b(Boys?|Girls?)\b/i.test(event);
}

function isUnscoredRoundOrEvent(roundSwam: string | undefined, event: string | undefined, settings: ScoringSettings): boolean {
  const r = (roundSwam || '').toUpperCase();
  const e = (event || '').toUpperCase();
  const list = (settings.unscoredRounds?.length ? settings.unscoredRounds : DEFAULT_UNSCORED_ROUNDS).map(x => x.toUpperCase());
  for (const ur of list) {
    if (r.includes(ur) || e.includes(ur)) return true;
  }
  if (e.includes('TIME TRIAL') && !isChampionshipGenderEvent(event)) return true;
  return false;
}

const NON_SCORING_TIME_RE = /^(?:DQ|DFS|SCR|NS|NP|NC|NT|N\/A|---)(?:\b|$)/i;

/** A/B (or timed) championship heats — not prelims or time trials. */
export function isFinalsRound(roundSwam: string | undefined): boolean {
  const tier = classifyRoundTier(roundSwam);
  return tier === 'A' || tier === 'B' || tier === 'FIN';
}

export type EventScoringStage = 'prelims_finals' | 'timed_finals' | 'unknown';

/**
 * Infer how an event was contested from roundSwam on its rows.
 * Prelims+A/B finals vs single-session timed finals (relays, 1650, etc.).
 */
export function eventScoringStage(eventRows: SwimmerResult[]): EventScoringStage {
  const rows = eventRows.filter(r => !r.isExhibition && !r.isTimeTrial);
  if (rows.length === 0) return 'unknown';

  let hasPre = false;
  let hasAbFinal = false;
  let hasTimedFinalLabel = false;

  for (const r of rows) {
    const tier = classifyRoundTier(r.roundSwam);
    if (tier === 'PRE') hasPre = true;
    if (tier === 'A' || tier === 'B') hasAbFinal = true;
    if (tier === 'FIN') hasTimedFinalLabel = true;
  }

  if (hasPre || hasAbFinal) return 'prelims_finals';
  if (hasTimedFinalLabel) return 'timed_finals';
  return 'unknown';
}

/** True when the event has a prelims session and A/B (or C) finals — eligible for placement O/U. */
export function isPrelimsFinalsEvent(eventRows: SwimmerResult[]): boolean {
  return eventScoringStage(eventRows) === 'prelims_finals';
}

/** Clock for the round this row represents (prelims row → prelims time; finals → relay/finals clock). */
export function swimResultClock(
  r: Pick<SwimmerResult, 'roundSwam' | 'time' | 'finalsTime' | 'prelimsTime' | 'relayTeamTime'>
): string {
  if (classifyRoundTier(r.roundSwam) === 'PRE') {
    return String(r.prelimsTime ?? r.time ?? '').trim();
  }
  return String(r.relayTeamTime ?? r.finalsTime ?? r.time ?? '').trim();
}

/** False for DQ, scratch, DFS, NT, and other non-finish codes (HyTek/PDF). */
export function isScoringSwimTime(clock: string | null | undefined): boolean {
  const u = String(clock ?? '').trim();
  if (!u) return false;
  return !NON_SCORING_TIME_RE.test(u);
}

/**
 * Prelims: non-finish codes on the prelims row do not block scoring eligibility here.
 * Finals: DQ/SCR/etc. on the finals clock → 0 pts and excluded from tie splits.
 */
export function isScoringSwimResult(r: SwimmerResult): boolean {
  if (!isFinalsRound(r.roundSwam)) return true;
  return isScoringSwimTime(swimResultClock(r));
}

function canScoreAthlete(roundSwam: string | undefined, event: string | undefined, settings: ScoringSettings): boolean {
  if (isUnscoredRoundOrEvent(roundSwam, event, settings)) return false;
  const tier = classifyRoundTier(roundSwam);
  if (tier === 'TT' || tier === 'C' || tier === 'D') return false;
  if (tier === 'PRE') return isDistanceEvent(event) || isDivingForSettings(event, settings);
  return true;
}

/** Prelim diving place points only when the diver did not also score in A/B finals of that event. */
function athleteHasFinalsDiveInEvent(
  eventRows: SwimmerResult[],
  name: string,
  team: string,
  settings: ScoringSettings
): boolean {
  const n = name.trim();
  const t = team.trim();
  return eventRows.some(
    r =>
      r.name === n &&
      String(r.team ?? '').trim() === t &&
      isDivingForSettings(r.event, settings) &&
      (classifyRoundTier(r.roundSwam) === 'A' || classifyRoundTier(r.roundSwam) === 'B')
  );
}

/** Parse HyTek rank (number or string) for scoring. */
export function parseRankInt(rank: unknown): number | null {
  if (typeof rank === 'number' && Number.isFinite(rank) && rank > 0) {
    return Math.floor(rank);
  }
  if (typeof rank === 'string') {
    const m = rank.trim().match(/(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      return n > 0 ? n : null;
    }
  }
  return null;
}

export function isRelayResult(r: SwimmerResult): boolean {
  if (r.isRelay) return true;
  return /\brelay\b/i.test(r.event || '');
}

/**
 * B-final row index into scoringPoints (0-based).
 * - In-heat place 1..bracket → overall places bracket+1 .. bracket*2 (e.g. 1→9th, 8→16th).
 * - Overall place bracket+1 .. bracket*2 (HyTek/NSISC often lists 9–16 on the sheet).
 */
function scoringRowIndexBFinal(rank: number, bracket: number, ptsLength: number): number | null {
  if (rank < 1) return null;
  const lastScoringPlace = Math.min(ptsLength, bracket * 2);
  if (rank > bracket) {
    if (rank < bracket + 1 || rank > lastScoringPlace) return null;
    return rank - 1;
  }
  const idx = bracket + (rank - 1);
  return idx >= 0 && idx < ptsLength ? idx : null;
}

/** 0-based index into scoringPoints, or null if this swim does not earn place points. */
function scoringRowIndex(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number | null {
  if (!canScoreAthlete(roundSwam, event, settings)) return null;
  if (!rank || rank < 1) return null;
  const pts = settings.scoringPoints;
  if (!pts.length) return null;
  const bracket = settings.aFinalBracketSize ?? Math.floor(pts.length / 2);
  const tier = classifyRoundTier(roundSwam);
  if (tier === 'B') {
    return scoringRowIndexBFinal(rank, bracket, pts.length);
  }
  const idx = rank - 1;
  return idx >= 0 && idx < pts.length ? idx : null;
}

/** Single-place team points for a round + rank (no tie splits or scorer caps). */
export function pointsForPlacement(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number {
  const idx = scoringRowIndex(roundSwam, rank, event, settings);
  if (idx == null) return 0;
  return settings.scoringPoints[idx] ?? 0;
}

function scoringRowIndexForRelay(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number | null {
  return scoringRowIndex(roundSwam, rank, event, settings);
}

function roundTierSort(roundSwam: string | undefined): number {
  const t = classifyRoundTier(roundSwam);
  const order: Record<string, number> = { A: 1, FIN: 1, UNK: 1, B: 2, PRE: 3, C: 8, D: 8, TT: 9 };
  return order[t] ?? 5;
}

export function isDivingEvent(event: string | undefined, patterns?: string[]): boolean {
  if (!event) return false;
  const u = event.toUpperCase();
  const list = patterns?.length ? patterns : ['DIVING', 'DIVE'];
  return list.some(p => {
    const token = p.toUpperCase();
    return token === 'DIVE' ? /\bDIVE\b/.test(u) : u.includes(token);
  });
}

function isDivingForSettings(event: string | undefined, settings: ScoringSettings): boolean {
  return isDivingEvent(event, settings.diverEventPattern);
}

export function eventMeetSortKey(event: string): number {
  const m = event.match(/Event\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 99999;
}

export function sortEventsByMeetOrder(events: string[]): string[] {
  return [...events].sort((a, b) => eventMeetSortKey(a) - eventMeetSortKey(b));
}

/** Remove gender markers from HyTek-style event titles (gender comes from workspace tab). */
export function stripEventGenderMarker(event: string): string {
  return event
    .replace(/\b(Men|Women|Boys|Boy|Girls|Girl)\b\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Full stripped event name for hover tooltips when compact label is shown. */
export function compactEventTitleAttr(event: string): string {
  return stripEventGenderMarker(event);
}

const STROKE_ABBREV: [RegExp, string][] = [
  [/\bIndividual\s+Medley\b/i, 'IM'],
  [/\bMedley\s+Relay\b/i, 'MD-R'],
  [/\bFreestyle\s+Relay\b/i, 'FR-R'],
  [/\bButterfly\b/i, 'FL'],
  [/\bBackstroke\b/i, 'BK'],
  [/\bBreaststroke\b/i, 'BR'],
  [/\bFreestyle\b/i, 'FR'],
  [/\bDiving\b/i, 'DV'],
  [/\bFly\b/i, 'FL'],
  [/\bBack\b/i, 'BK'],
  [/\bBreast\b/i, 'BR'],
  [/\bFree\b/i, 'FR'],
  [/\bIM\b/i, 'IM'],
  [/\bRelay\b/i, 'R'],
];

function abbreviateStrokeText(strokeText: string): string {
  let s = strokeText.trim();
  if (!s) return '';
  for (const [re, code] of STROKE_ABBREV) {
    if (re.test(s)) {
      s = s.replace(re, code);
      break;
    }
  }
  return s.replace(/\s+/g, '').toUpperCase();
}

/**
 * Compact display label: `Event 6 Men 200 Yard Individual Medley` → `E6 200IM`.
 * Display-only; does not mutate stored event keys.
 */
export function formatCompactEventLabel(event: string): string {
  const eventNumMatch = event.match(/\bEvent\s+(\d+)\b/i);
  const prefix = eventNumMatch ? `E${eventNumMatch[1]}` : '';

  let s = stripEventGenderMarker(event);
  s = s.replace(/\bEvent\s+\d+\b\s*/i, '');
  s = s.replace(/\s*\(Avg Split\)\s*/gi, ' ');
  s = s.replace(/\b(Yards?|Meters?|SCY|SCM|LCM)\b/gi, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();

  const distMatch = s.match(/\b(\d{2,4})\b/);
  const distance = distMatch?.[1] ?? '';
  const strokePart = distMatch ? s.slice(distMatch.index! + distMatch[0].length).trim() : s;
  const strokeCode = abbreviateStrokeText(strokePart);

  const body = `${distance}${strokeCode}`.trim();
  if (prefix && body) return `${prefix} ${body}`;
  if (prefix) return prefix;
  return body || stripEventGenderMarker(event);
}

/** Compact event number + stroke label for chart x-axes and tooltips. */
export function formatEventChartAxisLabel(
  event: string,
  options?: { abbreviate?: boolean; maxLength?: number }
): string {
  const { abbreviate = true, maxLength } = options ?? {};
  let label = abbreviate ? formatCompactEventLabel(event) : stripEventGenderMarker(event);
  if (maxLength != null && label.length > maxLength) {
    return label.substring(0, maxLength);
  }
  return label;
}

type TeamMeetState = {
  poolWeights: Map<string, number>;
};

function teamMeetStateKey(team: string, gender: Gender | string | undefined): string {
  return `${String(team).trim()}|||${gender ?? ''}`;
}

function totalPoolWeight(pool: Map<string, number>): number {
  let sum = 0;
  pool.forEach(w => {
    sum += w;
  });
  return sum;
}

function scorerWeightForEvent(event: string, settings: ScoringSettings): number {
  if (!isDivingForSettings(event, settings)) return 1;
  return settings.diverScorerWeight ?? 1;
}

function swimmerInPool(pool: Map<string, number>, name: string): boolean {
  return pool.has(normalizeSwimmerName(name));
}

function canAddSwimmerToPool(
  pool: Map<string, number>,
  name: string,
  event: string,
  settings: ScoringSettings
): boolean {
  const cap = settings.maxIndividualScorersPerTeam ?? 18;
  if (cap >= 999) return true;
  const key = normalizeSwimmerName(name);
  if (pool.has(key)) return true;
  const add = scorerWeightForEvent(event, settings);
  return totalPoolWeight(pool) + add <= cap + 1e-9;
}

function addSwimmerToPool(pool: Map<string, number>, name: string, event: string, settings: ScoringSettings): void {
  const key = normalizeSwimmerName(name);
  if (pool.has(key)) return;
  pool.set(key, scorerWeightForEvent(event, settings));
}

/** Add A/B relay legs to the meet scorer pool so relay-only athletes can score relays (pool rule). */
function seedAbRelayLegsIntoPool(
  relayRows: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>
): void {
  for (const r of relayRows) {
    if (!isAbFinalRelayLeg(r, merged)) continue;
    const team = String(r.team ?? '').trim() || 'Unknown';
    const meetState = getOrCreateMeetState(meetStates, team, r.gender);
    if (canAddSwimmerToPool(meetState.poolWeights, r.name, r.event, merged)) {
      addSwimmerToPool(meetState.poolWeights, r.name, r.event, merged);
    }
  }
}

function getOrCreateMeetState(states: Map<string, TeamMeetState>, team: string, gender: Gender | string | undefined): TeamMeetState {
  const key = teamMeetStateKey(team, gender);
  let s = states.get(key);
  if (!s) {
    s = { poolWeights: new Map() };
    states.set(key, s);
  }
  return s;
}

export type CalculatePointsOptions = {
  scorerRosterOverrides?: ScorerRosterOverride[];
  /** Forwarded to mergeScoringSettings (NSISC roster coercion vs PDF lock). */
  conferenceForMerge?: string;
  /** When omitted, non-recruit rows from `results` are used for PDF-place auto-detect. */
  resultsForPdfHint?: SwimmerResult[];
};

/** Distance timed finals (1000/1650 etc.) — one heat, not A/B prelims. */
export function isTimedFinalDistanceHeat(
  event: string | undefined,
  roundSwam: string | undefined
): boolean {
  if (!event) return false;
  const u = event.toUpperCase();
  const isDistance = /\b(1000|1650|1500|800|10000)\b/.test(u) || u.includes('TIMED');
  if (!isDistance) return false;
  return classifyRoundTier(roundSwam) === 'FIN';
}

function isTimedFinalDistanceSession(individuals: SwimmerResult[]): boolean {
  return individuals.length > 0 && individuals.every(r => isTimedFinalDistanceHeat(r.event, r.roundSwam));
}

/**
 * Timed-finals distance: place points follow scoring order among finishers who actually earn
 * points (exhibition, non-roster, and pool-blocked swimmers do not consume ladder slots).
 */
function scoreTimedFinalIndividualsInEvent(
  individuals: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  const pts = merged.scoringPoints;
  const cap = merged.maxIndividualScorersPerTeam ?? 999;
  const teamIndivScorers: Record<string, number> = {};
  const indivOut: SwimmerResult[] = [];

  const byRank = new Map<string, SwimmerResult[]>();
  for (const r of individuals) {
    const rk = parseRankInt(r.rank);
    const key =
      rk != null && rk > 0 ? String(rk) : `T|${convertTimeToSeconds(r.time)}|${r.name}`;
    if (!byRank.has(key)) byRank.set(key, []);
    byRank.get(key)!.push(r);
  }

  const sortedKeys = Array.from(byRank.keys()).sort((a, b) => {
    const ra = parseRankInt(byRank.get(a)![0].rank) ?? 9999;
    const rb = parseRankInt(byRank.get(b)![0].rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return (
      convertTimeToSeconds(byRank.get(a)![0].time) - convertTimeToSeconds(byRank.get(b)![0].time)
    );
  });

  let scoringPlace = 0;

  for (const key of sortedKeys) {
    const group = byRank.get(key)!;
    const ineligible = group.filter(r => !isScoringSwimResult(r));
    ineligible.forEach(r => indivOut.push({ ...r, points: 0 }));

    const eligible = group.filter(r => isScoringSwimResult(r));
    if (eligible.length === 0) continue;

    const sample = eligible[0];
    const pointEligible: SwimmerResult[] = [];
    for (const r of eligible) {
      const ex = r.isExhibition;
      const tt = r.isTimeTrial && !isChampionshipGenderEvent(r.event);
      if (ex || tt || !canScoreAthlete(r.roundSwam, r.event, merged)) {
        indivOut.push({ ...r, points: 0 });
        continue;
      }
      // Timed-finals distance: place ladder follows meet finish order among legal swims;
      // roster caps apply via meet-wide pool below, not by skipping ladder slots.
      pointEligible.push(r);
    }

    if (pointEligible.length === 0) continue;

    const avail = pts.length - scoringPlace;
    const take = Math.min(pointEligible.length, avail);
    const slice = pts.slice(scoringPlace, scoringPlace + take);
    if (!slice.length) {
      pointEligible.forEach(r => indivOut.push({ ...r, points: 0 }));
      continue;
    }
    const each = slice.reduce((s, p) => s + p, 0) / pointEligible.length;

    const byTeam = new Map<string, SwimmerResult[]>();
    for (const r of pointEligible) {
      const t = String(r.team ?? 'Unknown').trim() || 'Unknown';
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t)!.push(r);
    }

    let anyAwarded = false;
    for (const [team, members] of byTeam) {
      const meetState = getOrCreateMeetState(meetStates, team, members[0].gender);
      const uniqueNames = [...new Set(members.map(m => m.name))];
      const gender = members[0].gender;

      if (useMeetWidePool) {
        const canAllScore = uniqueNames.every(n =>
          canAddSwimmerToPool(meetState.poolWeights, n, sample.event, merged)
        );
        for (const r of members) {
          const award = canAllScore ? each : 0;
          indivOut.push({ ...r, points: award });
          if (award > 0) anyAwarded = true;
        }
        if (canAllScore) {
          uniqueNames.forEach(n => addSwimmerToPool(meetState.poolWeights, n, sample.event, merged));
        }
      } else if (cap < 999 && (teamIndivScorers[team] || 0) >= cap) {
        members.forEach(r => indivOut.push({ ...r, points: 0 }));
      } else {
        for (const r of members) {
          indivOut.push({ ...r, points: each });
        }
        anyAwarded = true;
        if (cap < 999) teamIndivScorers[team] = (teamIndivScorers[team] || 0) + uniqueNames.length;
      }
    }

    if (anyAwarded) scoringPlace += take;
  }

  return indivOut;
}

function scoreIndividualsInEvent(
  individuals: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  const indivGroups = new Map<string, SwimmerResult[]>();
  for (const r of individuals) {
    const rk = parseRankInt(r.rank) ?? 0;
    const ev = String(r.event ?? '').trim();
    const key =
      rk > 0
        ? `${ev}|${(r.roundSwam || '').trim()}|${rk}`
        : `${ev}|${(r.roundSwam || '').trim()}|T|${convertTimeToSeconds(r.time)}|${r.name}`;
    if (!indivGroups.has(key)) indivGroups.set(key, []);
    indivGroups.get(key)!.push(r);
  }

  const indivSortedKeys = Array.from(indivGroups.keys()).sort((a, b) => {
    const ga = indivGroups.get(a)![0];
    const gb = indivGroups.get(b)![0];
    const tw = roundTierSort(ga.roundSwam) - roundTierSort(gb.roundSwam);
    if (tw !== 0) return tw;
    const ra = parseRankInt(ga.rank) ?? 9999;
    const rb = parseRankInt(gb.rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return convertTimeToSeconds(ga.time) - convertTimeToSeconds(gb.time);
  });

  const teamIndivScorers: Record<string, number> = {};
  const indivOut: SwimmerResult[] = [];

  for (const key of indivSortedKeys) {
    const group = indivGroups.get(key)!;
    const ineligible = group.filter(r => !isScoringSwimResult(r));
    const eligible = group.filter(r => isScoringSwimResult(r));
    ineligible.forEach(r => indivOut.push({ ...r, points: 0 }));
    if (eligible.length === 0) continue;

    const sample = eligible[0];
    const ex = eligible.some(r => r.isExhibition);
    const tt = eligible.some(r => r.isTimeTrial) && !isChampionshipGenderEvent(sample.event);

    if (ex || tt || !canScoreAthlete(sample.roundSwam, sample.event, merged)) {
      eligible.forEach(r => indivOut.push({ ...r, points: 0 }));
      continue;
    }

    const rk = parseRankInt(sample.rank);
    const isPrelimDiving =
      classifyRoundTier(sample.roundSwam) === 'PRE' && isDivingForSettings(sample.event, merged);
    const baseIdx = rk != null ? scoringRowIndex(sample.roundSwam, rk, sample.event, merged) : null;
    if (baseIdx == null) {
      eligible.forEach(r => indivOut.push({ ...r, points: 0 }));
      continue;
    }

    const pts = merged.scoringPoints;
    const gLen = eligible.length;
    const avail = pts.length - baseIdx;
    const take = Math.min(gLen, avail);
    const slice = pts.slice(baseIdx, baseIdx + take);
    if (!slice.length) {
      eligible.forEach(r => indivOut.push({ ...r, points: 0 }));
      continue;
    }
    const each = slice.reduce((s, p) => s + p, 0) / gLen;

    const cap = merged.maxIndividualScorersPerTeam ?? 999;
    const byTeam = new Map<string, SwimmerResult[]>();
    for (const r of eligible) {
      const t = String(r.team ?? 'Unknown').trim() || 'Unknown';
      if (!byTeam.has(t)) byTeam.set(t, []);
      byTeam.get(t)!.push(r);
    }

    for (const [team, members] of byTeam) {
      const meetState = getOrCreateMeetState(meetStates, team, members[0].gender);
      const uniqueNames = [...new Set(members.map(m => m.name))];
      const gender = members[0].gender;

      if (rosterLookup && usesScorerRoster(merged)) {
        const rosterOk = uniqueNames.every(n => rosterLookup.isScorer(n, team, gender));
        if (!rosterOk) {
          members.forEach(r => indivOut.push({ ...r, points: 0 }));
          continue;
        }
      }

      const prelimDiveBlocked = (r: SwimmerResult) =>
        isPrelimDiving && athleteHasFinalsDiveInEvent(individuals, r.name, team, merged);

      if (useMeetWidePool) {
        const canAllScore = uniqueNames.every(n =>
          canAddSwimmerToPool(meetState.poolWeights, n, sample.event, merged)
        );
        for (const r of members) {
          const pts = canAllScore && !prelimDiveBlocked(r) ? each : 0;
          indivOut.push({ ...r, points: pts });
        }
        if (canAllScore) {
          uniqueNames
            .filter(n => !members.some(m => m.name === n && prelimDiveBlocked(m)))
            .forEach(n => addSwimmerToPool(meetState.poolWeights, n, sample.event, merged));
        }
      } else if (cap < 999 && (teamIndivScorers[team] || 0) >= cap) {
        members.forEach(r => indivOut.push({ ...r, points: 0 }));
      } else {
        members.forEach(r => indivOut.push({ ...r, points: prelimDiveBlocked(r) ? 0 : each }));
        if (cap < 999) {
          const added = uniqueNames.filter(n => !members.some(m => m.name === n && prelimDiveBlocked(m))).length;
          teamIndivScorers[team] = (teamIndivScorers[team] || 0) + added;
        }
      }
    }
  }

  return indivOut;
}

/** Team relay clock for grouping legs — never use leg split in `time`. */
export function relayTeamClock(r: SwimmerResult): string {
  return String(r.relayTeamTime ?? r.finalsTime ?? r.prelimsTime ?? '').trim();
}

/**
 * One key per team relay entry (all legs share this). Used for scoring caps and grouping.
 * Event + team + round + place + team time — not per-leg split times.
 */
export function relayEntryGroupKey(r: SwimmerResult): string {
  const team = String(r.team ?? '').trim();
  const event = String(r.event ?? '').trim();
  const round = String(r.roundSwam ?? '').trim();
  const rk = parseRankInt(r.rank) ?? '';
  const clock = relayTeamClock(r);
  return `${event}|${team}|${round}|${rk}|${clock}`;
}

/** @deprecated Use relayEntryGroupKey */
function relayScoringGroupKey(r: SwimmerResult): string {
  return relayEntryGroupKey(r);
}

function scoreRelaysInEvent(
  relays: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  useMeetWidePool: boolean,
  rosterLookup?: ScorerRosterLookup
): SwimmerResult[] {
  const relayMap = new Map<string, SwimmerResult[]>();
  for (const r of relays) {
    const k = relayScoringGroupKey(r);
    if (!relayMap.has(k)) relayMap.set(k, []);
    relayMap.get(k)!.push(r);
  }
  const relayKeys = Array.from(relayMap.keys()).sort((a, b) => {
    const ra = relayMap.get(a)![0];
    const rb = relayMap.get(b)![0];
    const tw = roundTierSort(ra.roundSwam) - roundTierSort(rb.roundSwam);
    if (tw !== 0) return tw;
    const rna = parseRankInt(ra.rank) ?? 9999;
    const rnb = parseRankInt(rb.rank) ?? 9999;
    if (rna !== rnb) return rna - rnb;
    return convertTimeToSeconds(ra.time) - convertTimeToSeconds(rb.time);
  });

  /** Relay cap is per team per relay event (e.g. max 2 scoring entries in 200 Free Relay). */
  const teamRelayCountsByEvent = new Map<string, number>();
  const relayOut: SwimmerResult[] = [];

  for (const key of relayKeys) {
    const group = relayMap.get(key)!;
    const sample = group[0];
    const ex = group.some(r => r.isExhibition);
    const tt = group.some(r => r.isTimeTrial);
    const team = String(sample.team ?? 'Unknown').trim() || 'Unknown';
    const eventName = String(sample.event ?? '').trim();
    const meetState = getOrCreateMeetState(meetStates, team, sample.gender);

    if (ex || tt || !canScoreAthlete(sample.roundSwam, sample.event, merged) || !isScoringSwimResult(sample)) {
      group.forEach(r => relayOut.push({ ...r, points: 0 }));
      continue;
    }

    const rk = parseRankInt(sample.rank);
    const idx = rk != null ? scoringRowIndexForRelay(sample.roundSwam, rk, sample.event, merged) : null;
    if (idx == null) {
      group.forEach(r => relayOut.push({ ...r, points: 0 }));
      continue;
    }

    const maxRel = merged.maxRelaysScoringPerTeam ?? 2;
    const relayCapKey = `${team}|||${eventName}`;
    const relayCount = teamRelayCountsByEvent.get(relayCapKey) ?? 0;
    if (relayCount >= maxRel) {
      group.forEach(r => relayOut.push({ ...r, points: 0 }));
      continue;
    }

    if (rosterLookup && usesScorerRoster(merged)) {
      if (!relayEntryRosterEligible(group, merged, rosterLookup)) {
        group.forEach(r => relayOut.push({ ...r, points: 0 }));
        continue;
      }
    } else if (useMeetWidePool && merged.relayEligibleFromScorerPool === true) {
      const allInPool = group.every(r => swimmerInPool(meetState.poolWeights, r.name));
      if (!allInPool) {
        group.forEach(r => relayOut.push({ ...r, points: 0 }));
        continue;
      }
    }

    const teamPts = merged.scoringPoints[idx] * merged.relayMultiplier;
    const n = group.length;
    // halfRateRelaySwimmer: each leg earns 1/n of team relay points (typically n=4 → 1/4 share).
    let swimmerPts = teamPts / (n > 0 ? n : 1);
    if (merged.halfRateRelaySwimmer) {
      swimmerPts = teamPts / (n >= 4 ? 4 : Math.max(n, 1));
    }

    // One relay unit per team entry (4 legs), capped per relay event.
    teamRelayCountsByEvent.set(relayCapKey, relayCount + 1);

    group.forEach(r => relayOut.push({ ...r, points: swimmerPts }));
  }

  return relayOut;
}

/** Per-row points from HyTek PDF when PDF-place scoring is active (see usePdfPlacePoints). */
function pdfPlacePointsForRow(row: SwimmerResult): number {
  if (row.isExhibition) return 0;
  if (row.isTimeTrial && !isChampionshipGenderEvent(row.event)) return 0;
  const pp = row.pdfPoints;
  if (pp != null && Number.isFinite(pp) && pp >= 0) return pp;
  return 0;
}

/** Assign championship-round ranks to injected recruits from time order within each event. */
export function prepareRecruitsForScoring(
  pdfResults: SwimmerResult[],
  recruits: SwimmerResult[]
): SwimmerResult[] {
  if (!recruits.length) return [];

  return recruits.map(recruit => {
    const comparators = pdfResults.filter(
      r =>
        !isRelayResult(r) &&
        r.event === recruit.event &&
        (r.gender == null || recruit.gender == null || r.gender === recruit.gender) &&
        ['A', 'B', 'FIN'].includes(classifyRoundTier(r.roundSwam))
    );
    const field = [...comparators, recruit].sort(
      (a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time)
    );
    const rank = field.findIndex(r => r.id === recruit.id) + 1;
    return {
      ...recruit,
      roundSwam: 'A Final',
      rank: rank > 0 ? rank : 1,
    };
  });
}

export function calculatePoints(
  results: SwimmerResult[],
  settings?: ScoringSettings,
  options?: CalculatePointsOptions
): SwimmerResult[] {
  const pdfResultsPre = results.filter(r => !r.isRecruit);
  const hint = options?.resultsForPdfHint ?? pdfResultsPre;
  const merged = mergeScoringSettings(settings, {
    conference: options?.conferenceForMerge,
    resultsForPdfHint: hint,
  });
  const usePdfScoring = effectivePdfPlacePointsMode(merged, hint);

  if (usePdfScoring) {
    const recruitResults = results.filter(r => r.isRecruit);
    const pdfResults = pdfResultsPre;
    const sortedPdf = [...pdfResults].sort((a, b) => {
      const tw = roundTierSort(a.roundSwam) - roundTierSort(b.roundSwam);
      if (tw !== 0) return tw;
      const ra = parseRankInt(a.rank) ?? 9999;
      const rb = parseRankInt(b.rank) ?? 9999;
      if (ra !== rb) return ra - rb;
      return convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time);
    });
    const scoredById = new Map<string, SwimmerResult>();
    for (const r of pdfResults) {
      scoredById.set(r.id, { ...r, points: pdfPlacePointsForRow(r) });
    }
    const sorted: SwimmerResult[] = [];
    let pdfIdx = 0;
    recruitResults.sort((a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time));
    for (const recruit of recruitResults) {
      const recTime = convertTimeToSeconds(recruit.time);
      while (pdfIdx < sortedPdf.length && convertTimeToSeconds(sortedPdf[pdfIdx].time) <= recTime) {
        const p = sortedPdf[pdfIdx];
        sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
        pdfIdx++;
      }
      sorted.push({ ...recruit, rank: 0, points: 0 });
    }
    while (pdfIdx < sortedPdf.length) {
      const p = sortedPdf[pdfIdx];
      sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
      pdfIdx++;
    }
    return sorted;
  }

  const maxIndivCap = merged.maxIndividualScorersPerTeam ?? 999;
  const maxRelayCap = merged.maxRelaysScoringPerTeam ?? 999;
  /** 18-scorer pool across the full meet (NSISC); only when scorerCapScope is 'meet'. */
  const useMeetWideIndividualPool =
    merged.scorerCapScope === 'meet' && maxIndivCap < 999;
  const relayPoolRule =
    merged.relayEligibleFromScorerPool === true && !usesScorerRoster(merged);
  /** Score each event in meet order (required for meet pool, relay caps, roster relays, or per-event individual cap). */
  const processEventsChronologically =
    useMeetWideIndividualPool ||
    relayPoolRule ||
    maxRelayCap < 999 ||
    maxIndivCap < 999 ||
    usesScorerRoster(merged);

  const pdfResults = results.filter(r => !r.isRecruit);
  const recruitResults = results.filter(r => r.isRecruit);
  const preparedRecruits = prepareRecruitsForScoring(pdfResults, recruitResults);
  const scoringPool = [...pdfResults, ...preparedRecruits];

  const rosterLookup = usesScorerRoster(merged)
    ? buildScorerRosterLookup(scoringPool, merged, options?.scorerRosterOverrides)
    : undefined;

  const meetStates = new Map<string, TeamMeetState>();
  const scoredById = new Map<string, SwimmerResult>();

  if (processEventsChronologically) {
    const byEvent = new Map<string, SwimmerResult[]>();
    for (const r of scoringPool) {
      if (!byEvent.has(r.event)) byEvent.set(r.event, []);
      byEvent.get(r.event)!.push(r);
    }
    const sortedEvents = sortEventsByMeetOrder(Array.from(byEvent.keys()));

    // When relays must use the meet-wide individual scorer pool, score ALL individuals first
    // so early relay events are not evaluated against an empty pool.
    const runIndividuals = (event: string) => {
      const evRows = byEvent.get(event)!;
      const indiv = evRows.filter(r => !isRelayResult(r));
      const scoreFn = isTimedFinalDistanceSession(indiv)
        ? scoreTimedFinalIndividualsInEvent
        : scoreIndividualsInEvent;
      for (const row of scoreFn(indiv, merged, meetStates, useMeetWideIndividualPool, rosterLookup)) {
        scoredById.set(row.id, row);
      }
    };
    const runRelays = (event: string) => {
      const evRows = byEvent.get(event)!;
      for (const row of scoreRelaysInEvent(
        evRows.filter(r => isRelayResult(r)),
        merged,
        meetStates,
        useMeetWideIndividualPool,
        rosterLookup
      )) {
        scoredById.set(row.id, row);
      }
    };

    if (relayPoolRule) {
      for (const event of sortedEvents) {
        runIndividuals(event);
        seedAbRelayLegsIntoPool(
          (byEvent.get(event) ?? []).filter(r => isRelayResult(r)),
          merged,
          meetStates
        );
        runRelays(event);
      }
    } else {
      for (const event of sortedEvents) {
        runIndividuals(event);
        runRelays(event);
      }
    }
  } else {
    const byEvent = new Map<string, SwimmerResult[]>();
    for (const r of scoringPool) {
      if (!byEvent.has(r.event)) byEvent.set(r.event, []);
      byEvent.get(r.event)!.push(r);
    }
    for (const event of sortEventsByMeetOrder(Array.from(byEvent.keys()))) {
      const evRows = byEvent.get(event)!;
      const indiv = evRows.filter(r => !isRelayResult(r));
      const relays = evRows.filter(r => isRelayResult(r));
      const scoreFn = isTimedFinalDistanceSession(indiv)
        ? scoreTimedFinalIndividualsInEvent
        : scoreIndividualsInEvent;
      for (const row of scoreFn(indiv, merged, meetStates, false, rosterLookup)) {
        scoredById.set(row.id, row);
      }
      for (const row of scoreRelaysInEvent(relays, merged, meetStates, false, rosterLookup)) {
        scoredById.set(row.id, row);
      }
    }
  }

  for (const r of scoringPool) {
    if (!scoredById.has(r.id)) scoredById.set(r.id, { ...r, points: 0 });
  }

  const byId = scoredById;

  // Preserve recruit interleave order (by time vs PDF) for display; recruits score 0
  const sortedPdf = [...pdfResults].sort((a, b) => {
    const tw = roundTierSort(a.roundSwam) - roundTierSort(b.roundSwam);
    if (tw !== 0) return tw;
    const ra = parseRankInt(a.rank) ?? 9999;
    const rb = parseRankInt(b.rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time);
  });

  const sorted: SwimmerResult[] = [];
  let pdfIdx = 0;
  recruitResults.sort((a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time));
  for (const recruit of recruitResults) {
    const recTime = convertTimeToSeconds(recruit.time);
    while (pdfIdx < sortedPdf.length && convertTimeToSeconds(sortedPdf[pdfIdx].time) <= recTime) {
      const p = sortedPdf[pdfIdx];
      sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
      pdfIdx++;
    }
    sorted.push(scoredById.get(recruit.id) ?? { ...recruit, rank: 0, points: 0 });
  }
  while (pdfIdx < sortedPdf.length) {
    const p = sortedPdf[pdfIdx];
    sorted.push(byId.get(p.id) ?? { ...p, points: 0 });
    pdfIdx++;
  }

  return sorted;
}

export function getYearsRemaining(year: ClassYear): number {
  switch (year) {
    case ClassYear.FR: return 3;
    case ClassYear.SO: return 2;
    case ClassYear.JR: return 1;
    case ClassYear.SR: return 0;
    default: return 4;
  }
}

/** @deprecated Prefer getTeamColors; kept for call sites that only need a single stroke. */
export function getTeamColor(teamName: string | null | undefined, _index: number): string {
  return getTeamColors(teamName).primary;
}

/**
 * Resolve per-team timeline stroke color and optional dash when multiple teams share similar primaries.
 * `team.color` must already be each school's primary. Mutates copies with `lineColor` and `strokeDasharray`.
 */
export function assignTeamLineStyles(
  teams: TeamScore[],
  options?: { chartTheme?: 'dark' | 'light' }
): TeamScore[] {
  const chartTheme = options?.chartTheme ?? 'dark';
  const toStroke = (c: string) => colorForChartStroke(c, chartTheme);
  const n = teams.length;
  if (n === 0) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(a: number): number {
    if (parent[a] !== a) parent[a] = find(parent[a]);
    return parent[a];
  }
  function unite(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  const safeHex = (c: string | undefined) => String(c || '#888888');

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ci = safeHex(teams[i].color).toUpperCase();
      const cj = safeHex(teams[j].color).toUpperCase();
      if (ci === cj || rgbColorDistance(safeHex(teams[i].color), safeHex(teams[j].color)) < COLOR_CLOSE_THRESHOLD) {
        unite(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }

  const out: TeamScore[] = teams.map(t => ({
    ...t,
    color: safeHex(t.color),
    lineColor: toStroke(safeHex(t.color)),
    strokeDasharray: undefined,
  }));

  for (const idxs of groups.values()) {
    if (idxs.length <= 1) continue;

    idxs.sort((a, b) => teams[b].totalPoints - teams[a].totalPoints);

    if (idxs.length === 2) {
      const [win, lose] = idxs;
      const { secondary } = getTeamColors(teams[lose].teamName);
      out[win].lineColor = toStroke(safeHex(teams[win].color));
      out[lose].lineColor = toStroke(
        rgbColorDistance(safeHex(teams[win].color), secondary) < 22
          ? synthesizeSecondaryColor(safeHex(teams[lose].color), teams[lose].teamName)
          : secondary
      );
      out[win].strokeDasharray = undefined;
      out[lose].strokeDasharray = undefined;
      continue;
    }

    const used = new Set<string>();
    idxs.forEach((teamIdx, rank) => {
      const t = teams[teamIdx];
      const { primary: schoolPrimary, secondary } = getTeamColors(t.teamName);
      const basePrimary = safeHex(t.color);
      const baseSecondary =
        rgbColorDistance(basePrimary, secondary) < 18 ? synthesizeSecondaryColor(basePrimary, t.teamName) : secondary;

      let dash = DASH_PATTERNS[rank % DASH_PATTERNS.length];
      let lineC = rank % 2 === 0 ? basePrimary : baseSecondary;
      let guard = 0;
      while (used.has(`${lineC}|${dash ?? ''}`) && guard < 48) {
        guard++;
        const altDash = DASH_PATTERNS[guard % DASH_PATTERNS.length];
        const altColor =
          guard % 3 === 0 ? basePrimary : guard % 3 === 1 ? baseSecondary : synthesizeSecondaryColor(schoolPrimary, `${t.teamName}:${guard}`);
        dash = altDash;
        lineC = altColor;
      }
      used.add(`${lineC}|${dash ?? ''}`);
      out[teamIdx].lineColor = toStroke(lineC);
      out[teamIdx].strokeDasharray = dash;
    });
  }

  return out;
}

export function simulateRoster(
  results: SwimmerResult[],
  recruits: SwimmerResult[],
  removeSeniors: boolean,
  excludedSwimmerNames?: Set<string>,
  relayLegOverrides: RelayLegOverride[] = []
): SwimmerResult[] {
  const excluded = excludedSwimmerNames ?? new Set<string>();
  const overrideList = relayLegOverrides ?? [];
  const runRosterSim = removeSeniors || excluded.size > 0 || overrideList.length > 0;
  if (!runRosterSim) {
    return [...results, ...recruits];
  }

  const basePool = results.filter(r => {
    if (r.isRelay) return true;
    if (excluded.has(normalizeSwimmerName(r.name))) return false;
    if (removeSeniors && (r.classYear === 'SR' || r.classYear === 'Sr' || r.classYear === 'Senior')) return false;
    return true;
  });

  const activeSwimmers = [...basePool, ...recruits];

  const finalResults: SwimmerResult[] = [];
  const processedRelayKeys = new Set<string>();

  for (const r of activeSwimmers) {
    if (!r.isRelay) {
      finalResults.push(r);
      continue;
    }

    const k = relayGroupKey(r);
    if (processedRelayKeys.has(k)) continue;
    processedRelayKeys.add(k);

    const group = results.filter(x => x.isRelay && relayGroupKey(x) === k);
    if (group.length === 0) continue;

    const template = group[0];
    const evLower = template.event.toLowerCase();
    const distance = inferRelayStrokeDistance(template.event);

    const ordered = [...group].sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));

    const legsCanonical =
      template.relayNames && template.relayNames.length > 0
        ? template.relayNames.map(n => ({ name: n.name, year: n.year }))
        : ordered.map(row => ({ name: row.name, year: String(row.classYear) }));

    if (legsCanonical.length === 0) {
      ordered.forEach(row => finalResults.push(row));
      continue;
    }

    const outLegs = legsCanonical.map(l => ({ ...l }));
    let newTimeSecs = convertTimeToSeconds(template.time);
    let modified = false;
    const legReplacements = new Map<number, SwimmerResult>();
    const legMissingByIndex = new Map<number, RelayMissingLeg>();
    const legVacantByIndex = new Map<number, boolean>();
    const relayDist = parseRelayDistanceYards(template.event);
    const legDistYards = relayLegDistanceYards(relayDist);
    const assignedInRelay = new Set<string>();

    const applyLegTimeDelta = (
      index: number,
      newLegTimeSec: number,
      oldSplitSec: number | null,
      departedIndiv: SwimmerResult | undefined
    ) => {
      let delta = newLegTimeSec - (oldSplitSec ?? newLegTimeSec);
      if (departedIndiv && Number.isFinite(convertTimeToSeconds(departedIndiv.time))) {
        delta = newLegTimeSec - convertTimeToSeconds(departedIndiv.time);
      } else if (oldSplitSec != null && Number.isFinite(oldSplitSec)) {
        delta = newLegTimeSec - oldSplitSec;
      }
      newTimeSecs += delta;
    };

    for (let index = 0; index < outLegs.length; index++) {
      const leg = outLegs[index];
      const isSeniorLeg =
        leg.year === 'SR' || leg.year === 'Sr' || leg.year === 'Senior' || leg.year === 'GR';
      const isDeletedLeg = excluded.has(normalizeSwimmerName(leg.name));
      const needsReplace = (removeSeniors && isSeniorLeg) || isDeletedLeg;
      if (!needsReplace) {
        const nm = leg.name?.trim();
        if (nm && nm !== '—' && nm !== 'Unknown') {
          assignedInRelay.add(normalizeSwimmerName(nm));
        }
        continue;
      }

      const strokes = strokeKeywordsForRelayLeg(evLower, index);
      const legRowForSplit =
        ordered.find(row => (row.relayLegIndex ?? -1) === index) ?? ordered[index];
      const oldSplitSec =
        legRowForSplit?.relayLegSplit && legRowForSplit.relayLegSplit !== 'NT'
          ? convertTimeToSeconds(legRowForSplit.relayLegSplit)
          : null;

      const departedIndiv = results.find(
        s =>
          !s.isRelay &&
          s.name === leg.name &&
          eventMatchesStrokeDistance(s.event, distance, strokes)
      );

      const stroke = relayStrokeForIndex(evLower, index);
      const override = findRelayLegOverride(overrideList, template, index);
      const departedNameKey = normalizeSwimmerName(leg.name);

      const markVacant = (reason: RelayMissingLeg['reason']) => {
        modified = true;
        newTimeSecs += 3.0;
        outLegs[index] = { name: '—', year: '' };
        legVacantByIndex.set(index, true);
        legMissingByIndex.set(index, { legIndex: index, stroke, reason });
        legReplacements.set(index, {
          ...template,
          id: `vacant-${index}`,
          name: '—',
          classYear: '',
          time: formatSecondsToTime((oldSplitSec ?? 30) + 3),
          isRelay: false,
        });
      };

      if (!override) {
        markVacant('vacant');
        continue;
      }

      const assignee = resolveOverrideAssignee(
        override,
        activeSwimmers,
        template.team,
        template.event,
        index
      );
      const manualTime = override.manualLegTime?.trim();

      if (assignee) {
        if (normalizeSwimmerName(assignee.name) === departedNameKey) {
          markVacant('vacant');
          continue;
        }
        if (!swimmerMatchesRelayLeg(assignee, template.event, index)) {
          markVacant('stroke_mismatch');
          continue;
        }
        const assigneeKey = normalizeSwimmerName(assignee.name);
        if (assignedInRelay.has(assigneeKey)) {
          markVacant('stroke_mismatch');
          continue;
        }

        modified = true;
        legReplacements.set(index, assignee);
        assignedInRelay.add(assigneeKey);
        const legTimeSec = convertTimeToSeconds(manualTime || assignee.time);
        applyLegTimeDelta(index, legTimeSec, oldSplitSec, departedIndiv);
        outLegs[index] = {
          name: assignee.name,
          year: String(override.classYear ?? assignee.classYear),
        };
        continue;
      }

      if (manualTime) {
        modified = true;
        const legTimeSec = convertTimeToSeconds(manualTime);
        applyLegTimeDelta(index, legTimeSec, oldSplitSec, departedIndiv);
        outLegs[index] = { name: '—', year: '' };
        legReplacements.set(index, {
          ...template,
          id: `manual-${index}`,
          name: '—',
          classYear: '',
          time: manualTime,
          isRelay: false,
        });
        continue;
      }

      markVacant('vacant');
    }

    const newTeamStr = formatSecondsToTime(newTimeSecs);

    const legTotals: (string | null)[] = [];
    const legDetailsByIndex = new Map<number, SwimmerResult['relayLegSplitDetail']>();

    for (let index = 0; index < outLegs.length; index++) {
      const legRowForSplit =
        ordered.find(row => (row.relayLegIndex ?? -1) === index) ?? ordered[index];
      const stroke = legRowForSplit?.relayLegStroke ?? relayStrokeForIndex(evLower, index);

      if (legReplacements.has(index)) {
        const replacement = legReplacements.get(index)!;
        const prior = normalizeRelayLegSplitDetail(legRowForSplit?.relayLegSplitDetail);
        const detail = buildSyntheticLegSplitDetail(
          index,
          stroke,
          legDistYards,
          replacement.time,
          prior?.segments
        );
        legDetailsByIndex.set(index, detail);
        legTotals.push(detail.legTotal ?? replacement.time);
      } else if (legRowForSplit?.relayLegSplitDetail) {
        const normalizedDetail = normalizeRelayLegSplitDetail(legRowForSplit.relayLegSplitDetail);
        if (normalizedDetail) legDetailsByIndex.set(index, normalizedDetail);
        legTotals.push(
          normalizedDetail?.legTotal ?? legRowForSplit.relayLegSplit ?? null
        );
      } else {
        legTotals.push(legRowForSplit?.relayLegSplit ?? null);
      }
    }

    const teamSplits =
      modified || ordered.some(r => r.relayTeamSplits)
        ? rebuildTeamSplitSummary(legTotals, newTeamStr)
        : ordered[0]?.relayTeamSplits;

    if (modified) {
      ordered.forEach(row => {
        const idx =
          row.relayLegIndex != null
            ? Math.min(Math.max(0, row.relayLegIndex), outLegs.length - 1)
            : Math.min(Math.max(0, ordered.indexOf(row)), outLegs.length - 1);
        const legMeta = outLegs[idx];
        const legDetail = legDetailsByIndex.get(idx);
        finalResults.push({
          ...row,
          name: legMeta.name,
          classYear: legMeta.year,
          time: newTeamStr,
          finalsTime: newTeamStr,
          relayNames: outLegs,
          relayTeamTime: newTeamStr,
          relayLegSplit: legDetail?.legTotal ?? row.relayLegSplit,
          relayLegSplitDetail: legDetail,
          relayTeamSplits: teamSplits,
          relayMissingLeg: legMissingByIndex.get(idx),
          relayLegVacant: legVacantByIndex.get(idx) ?? false,
        });
      });
    } else {
      ordered.forEach(row => finalResults.push(row));
    }
  }

  // Safety: never drop relay legs if grouping skipped them during iteration
  const emittedRelayKeys = new Set(finalResults.filter(r => r.isRelay).map(r => relayGroupKey(r)));
  for (const r of results) {
    if (!r.isRelay) continue;
    const k = relayGroupKey(r);
    if (emittedRelayKeys.has(k)) continue;
    const group = results.filter(x => x.isRelay && relayGroupKey(x) === k);
    group.forEach(row => {
      finalResults.push(row);
      emittedRelayKeys.add(k);
    });
  }

  return finalResults;
}

/** For UI cut badges only: 400 medley leadoff back compares to 100 Backstroke standards (not scored as individual). */
export function relaySplitQualificationCutEvent(res: SwimmerResult): string | null {
  if (!res.isRelay || res.relayLegStroke !== 'back') return null;
  const ev = res.event.toLowerCase();
  if (!ev.includes('medley')) return null;
  if (!/\b400\b/.test(ev)) return null;
  return '100 Backstroke';
}
