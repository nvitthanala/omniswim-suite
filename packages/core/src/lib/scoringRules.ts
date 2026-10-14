/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Scoring eligibility, place tables, place points and tie shares.
// Split out of `utils.ts`, which still re-exports every name from here.

import { SwimmerResult, ScoringSettings } from '../types';
import { regexGroup } from './indexedAccess';

const DEFAULT_UNSCORED_ROUNDS = [
  'C FINAL',
  'C-FINAL',
  'BONUS FINAL',
  'D FINAL',
  'D-FINAL',
  'TIME TRIAL',
];

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

/**
 * True when a swim is a time trial: the row's `isTimeTrial` flag or a "Time
 * Trial" label, except in a Boys/Girls championship event, which scores like a
 * final (`isChampionshipGenderEvent`). The scoring engine reads a time trial the
 * same way (`takesAScoringPlace`, `isUnscoredRoundOrEvent`).
 *
 * The relay-leg code reads it to keep a time trial off a leg unless
 * `ScoringSettings.relayLegsAllowTimeTrials` is on. It accepts a
 * `HistoricalSwim` as well as a `SwimmerResult`.
 *
 * `scoredEventNumberMax` is the meet's last scored event number. A swim whose
 * label names a later event (`Event 938 Women 100 Yard Breaststroke`) is outside
 * the scored program and is a time trial here, with or without the flag and
 * with or without a Boys/Girls word: the championship-event exception does not
 * rescue it. It is the same boundary the scoring engine reads
 * (`isOutsideScoredProgram`). Omitted, only the flag and the label decide, as
 * before.
 */
export function isTimeTrialSwim(
  row: { event?: string; isTimeTrial?: boolean },
  scoredEventNumberMax?: number
): boolean {
  const event = String(row.event ?? '');
  if (isOutsideScoredProgram(event, scoredEventNumberMax)) return true;
  const flagged = row.isTimeTrial === true || /\bTIME\s+TRIALS?\b/i.test(event);
  return flagged && !isChampionshipGenderEvent(event);
}

function isDistanceEvent(event: string | undefined): boolean {
  if (!event) return false;
  const u = event.toUpperCase();
  return /\b(1000|1650|1500|800|10000)\b/.test(u) || u.includes('TIMED');
}

/** Post-meet championship swims (HyTek Boys/Girls events) — scored like finals, not exhibition TTs. */
export function isChampionshipGenderEvent(event: string | undefined): boolean {
  if (!event) return false;
  return /\b(Boys?|Girls?)\b/i.test(event);
}

/**
 * Event number from a HyTek label ("Event 13 Men 100 Yard Butterfly" → 13).
 * Null when the label carries no number — canonical roster labels such as
 * "100 Yard Freestyle" and injected what-if rows have none.
 */
export function parseEventNumber(event: string | undefined): number | null {
  const m = /^\s*Event\s+(\d+)\b/i.exec(String(event ?? ''));
  if (!m) return null;
  const n = Number.parseInt(regexGroup(m, 1), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when the label names an event past the meet's scored program.
 *
 * Only a positively identified out-of-range number excludes a row. An
 * unnumbered label is left scoring: canonical and what-if rows carry no event
 * number, and zeroing those would silently empty every projection.
 */
export function isOutsideScoredProgram(
  event: string | undefined,
  scoredEventNumberMax: number | undefined
): boolean {
  if (scoredEventNumberMax == null || !Number.isFinite(scoredEventNumberMax)) return false;
  const n = parseEventNumber(event);
  if (n == null) return false;
  return n > scoredEventNumberMax;
}

function isUnscoredRoundOrEvent(roundSwam: string | undefined, event: string | undefined, settings: ScoringSettings): boolean {
  const r = (roundSwam || '').toUpperCase();
  const e = (event || '').toUpperCase();
  // The meet's own published boundary. HyTek numbers post-meet extra sessions
  // above the program and leaves them out of the team totals; the 2026 NSISC
  // results score "Through Event 42" and print events 938/939 after the time
  // trials with no "Time Trial" suffix to give them away.
  if (isOutsideScoredProgram(event, settings.scoredEventNumberMax)) return true;
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

export function canScoreAthlete(roundSwam: string | undefined, event: string | undefined, settings: ScoringSettings): boolean {
  if (isUnscoredRoundOrEvent(roundSwam, event, settings)) return false;
  const tier = classifyRoundTier(roundSwam);
  if (tier === 'TT' || tier === 'C' || tier === 'D') return false;
  if (tier === 'PRE') return isDistanceEvent(event) || isDivingForSettings(event, settings);
  return true;
}

/** Prelim diving place points only when the diver did not also score in A/B finals of that event. */
export function athleteHasFinalsDiveInEvent(
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
      const n = parseInt(regexGroup(m, 1), 10);
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

/**
 * The place-value table one individual event scores from.
 *
 * `divingPoints` exists because NCAA Rule 7-1-4 gives dual-meet diving its own
 * table, different from the swimming table in the same meet. Absent — every
 * preset written before 2026-09-20 — this returns `scoringPoints` and every
 * caller behaves exactly as it did.
 */
export function individualPlaceTable(
  event: string | undefined,
  settings: ScoringSettings
): number[] {
  const diving = settings.divingPoints;
  if (diving?.length && isDivingForSettings(event, settings)) return diving;
  return settings.scoringPoints;
}

/**
 * The place-value table one relay event scores from, or `null` to keep the
 * `scoringPoints[place] * relayMultiplier` path.
 *
 * Rule 7-1-1's relay table is 11-4-2-0 against an individual 9-4-3-2-1-0 — not a
 * multiple of it — so a scalar cannot express a dual meet. See
 * {@link ScoringSettings.relayPoints}.
 */
function relayPlaceTable(settings: ScoringSettings): number[] | null {
  const relay = settings.relayPoints;
  return relay?.length ? relay : null;
}

/**
 * A/B bracket boundary, which describes the meet's finals structure and not any
 * one table. Anchored to `scoringPoints` so a diving or relay table of a
 * different length cannot move where the B final starts.
 */
function aFinalBracket(settings: ScoringSettings): number {
  return settings.aFinalBracketSize ?? Math.floor(settings.scoringPoints.length / 2);
}

/** 0-based index into `table`, or null if this swim does not earn place points. */
function placeRowIndex(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings,
  table: number[]
): number | null {
  if (!canScoreAthlete(roundSwam, event, settings)) return null;
  if (!rank || rank < 1) return null;
  if (!table.length) return null;
  const bracket = aFinalBracket(settings);
  const tier = classifyRoundTier(roundSwam);
  if (tier === 'B') {
    return scoringRowIndexBFinal(rank, bracket, table.length);
  }
  const idx = rank - 1;
  return idx >= 0 && idx < table.length ? idx : null;
}

/** 0-based index into the event's individual table, or null if this swim does not earn place points. */
export function scoringRowIndex(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number | null {
  return placeRowIndex(roundSwam, rank, event, settings, individualPlaceTable(event, settings));
}

/**
 * The value a place-point table holds at a 0-based place index, or `null` when it
 * holds none — the index is past the table's end, or the cell is blank.
 *
 * `null` is "the table says nothing", which is not the same fact as a table that
 * says 0. A caller decides what absent means for its own total; this function
 * never decides for it. See CLAUDE.md § Data provenance, rule 4.
 */
export function placePointAt(
  table: readonly (number | null | undefined)[],
  idx: number
): number | null {
  const value = table[idx];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Points each of `tiedCount` tied entries takes when they share a place.
 *
 * The points of every place the tie spans are added and divided by the number of
 * tied entries — NCAA Rule 7-8, and the user's rule for this app (decision U1,
 * 2026-10-12): 1st and 2nd tied under the NSISC table score (20 + 17) / 2 each.
 *
 * A spanned place the table does not reach adds nothing, and the divisor stays
 * `tiedCount`: two entries tied for 8th in an 8-place table score (pts8 + 0) / 2
 * each, never pts8 each. A missing place never turns the total into null or NaN.
 *
 * Returns `null` only when the table holds no value at ANY spanned place, so a
 * tie wholly past the end reads as "no table row" and not as a computed 0.
 *
 * This is the single tie rule. Individual swims (both scorers) and relay entries
 * all divide through here; do not write a second one.
 *
 * @param table      the place-value table, place 1 first
 * @param startIdx   0-based index of the first place the tie spans
 * @param tiedCount  how many entries share those places (at least 1)
 */
export function tiedPlaceShare(
  table: readonly (number | null | undefined)[],
  startIdx: number,
  tiedCount: number
): number | null {
  if (!Number.isInteger(tiedCount) || tiedCount < 1) return null;
  let sum = 0;
  let spanned = 0;
  for (let idx = startIdx; idx < startIdx + tiedCount; idx += 1) {
    const value = placePointAt(table, idx);
    if (value == null) continue;
    sum += value;
    spanned += 1;
  }
  return spanned === 0 ? null : sum / tiedCount;
}

/**
 * Single-place team points for a round + rank (no tie splits or scorer caps), or
 * `null` when the swim is eligible and holds a place but the individual table has
 * no row for it — a place past the table's end.
 *
 * `0` is kept for the cases where the RULES give the swim nothing: a round that
 * does not score, or no place at all. Only `null` means "the table is silent".
 */
export function pointsForPlacementOrNull(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number | null {
  if (!canScoreAthlete(roundSwam, event, settings)) return 0;
  if (!rank || rank < 1) return 0;
  const table = individualPlaceTable(event, settings);
  const idx = placeRowIndex(roundSwam, rank, event, settings, table);
  if (idx == null) return null;
  return placePointAt(table, idx);
}

/**
 * Single-place team points for a round + rank (no tie splits or scorer caps).
 *
 * Reads a place past the end of the table as 0 — the pre-2026-10-12 behaviour,
 * kept so existing callers do not change. A caller that must tell "no points"
 * from "table has no row" calls {@link pointsForPlacementOrNull}.
 */
export function pointsForPlacement(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number {
  return pointsForPlacementOrNull(roundSwam, rank, event, settings) ?? 0;
}

export function scoringRowIndexForRelay(
  roundSwam: string | undefined,
  rank: number,
  event: string | undefined,
  settings: ScoringSettings
): number | null {
  const explicit = relayPlaceTable(settings);
  if (explicit) return placeRowIndex(roundSwam, rank, event, settings, explicit);
  return scoringRowIndex(roundSwam, rank, event, settings);
}

/**
 * The team points a relay earns at each place, place 1 first.
 *
 * `relayPoints` wins when present; otherwise the historical
 * `scoringPoints[place] * relayMultiplier`, which is exact for every championship
 * field size and wrong for every other format. A blank place stays blank.
 */
export function relayPlaceValues(settings: ScoringSettings): readonly (number | null | undefined)[] {
  const explicit = relayPlaceTable(settings);
  if (explicit) return explicit;
  const multiplier = settings.relayMultiplier;
  return settings.scoringPoints.map(p => (typeof p === 'number' ? p * multiplier : null));
}

/**
 * Team points a relay entry earns for the place at `idx`, or `null` when the
 * relay table (or the individual table x `relayMultiplier`) has no row there.
 *
 * `null` is not 0. The relay scorer reads it as "this entry takes no points",
 * which is right for a place past the end of 11-4-2-0; it is returned as `null`
 * so that decision is made by the caller and not hidden in the lookup.
 */
export function relayTeamPointsForIndex(settings: ScoringSettings, idx: number): number | null {
  return placePointAt(relayPlaceValues(settings), idx);
}

export function roundTierSort(roundSwam: string | undefined): number {
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

export function isDivingForSettings(event: string | undefined, settings: ScoringSettings): boolean {
  return isDivingEvent(event, settings.diverEventPattern);
}
