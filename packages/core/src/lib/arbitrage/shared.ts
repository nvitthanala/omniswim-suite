/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Machinery shared by two or more of the four arbitrage analyses
 * (crossCourseTable.ts, exactSwaps.ts, dropAdd.ts, relayLegSwaps.ts). Nothing
 * here is part of the public surface on its own — lib/crossCourseArbitrage.ts
 * is the barrel that re-exports what callers may use.
 *
 * The pieces, in the order they appear:
 *
 *   1. Recency window + best-time picking (teamHistoryWindow, pickRecencyBest).
 *   2. The history → SCY projection prefix (convertedHistorySwims) that every
 *      analysis starts from, and the cross-course table row types it feeds.
 *   3. Conversion-confidence banding (buildEventTimeIndex, conversionConfidence).
 *   4. Full re-score helpers (teamTotal / scoreWorkspaceRows / sumTeamPoints).
 *   5. The droppable-entry union (collectDroppableEntries).
 *   6. The incremental fast-rescore context (buildFastSwapContext) used by the
 *      swap, drop-only and add-only rankings.
 *
 * PROJECTION NOTE. Two analyses project an athlete's history onto the meet's
 * program, and they classify the projected swim DIFFERENTLY on purpose:
 *   * buildCrossCourseTable keys by `canonicalProgramEvent` (the 14 championship
 *     SCY individual events; rejects 25s / 100 IM / off-program distances).
 *   * buildRelayLegTimeIndex keys by `individualStrokeDistance` (distance+stroke
 *     for a relay leg; rejects IM/medley, but accepts any distance).
 * Everything BEFORE the classifier is identical, and only that identical prefix
 * is shared here (convertedHistorySwims). The classifiers are deliberately NOT
 * unified — they answer different questions.
 */

import {
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  ScorerRosterOverride,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '../../types';
import { buildMeetEventLabelIndex, canonicalProgramEvent } from '../eventIdentity';
import { effectivePdfPlacePointsMode } from '../scoringDefaults';
import { buildScorerRosterLookup, usesScorerRoster, type ScorerRosterLookup } from '../scorerRoster';
import { buildWhatIfResults, planToResult, projectRanksInField } from '../whatIfProjection';
import {
  calculatePoints,
  classifyRoundTier,
  convertSwimToSCY,
  convertTimeToSeconds,
  convertToSCY,
  eventMeetSortKey,
  hasConversionFactor,
  isDivingEvent,
  isRelayResult,
  normalizeSwimmerName,
  parseRankInt,
  sortEventsByMeetOrder,
} from '../utils';

// --- recency window ---------------------------------------------------------

/** Default recency window (months) for candidate-time selection. */
export const DEFAULT_RECENCY_MONTHS = 24;

/** Lenient date parse: ms since epoch, or null when absent/unparseable. */
function parseSwimDateMs(date?: string): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : t;
}

/** Newest dated swim across the WHOLE workspace history (recency anchor). */
function newestHistoryDateMs(history: HistoricalSwim[]): number | null {
  let max: number | null = null;
  for (const s of history) {
    const t = parseSwimDateMs(s.date);
    if (t != null && (max == null || t > max)) max = t;
  }
  return max;
}

/** Recency cutoff: `months` calendar months before the anchor. */
function recencyCutoffMs(anchorMs: number, months: number): number {
  const d = new Date(anchorMs);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

/**
 * Fastest ref within the recency window (undated/unparseable rows count as
 * recent). If every ref is stale, keep the fastest but flag it `stale`.
 * cutoffMs null (no dated swims at all) disables filtering.
 */
export function pickRecencyBest<T extends CrossCourseTimeRef>(
  refs: T[],
  cutoffMs: number | null
): T | undefined {
  if (refs.length === 0) return undefined;
  if (cutoffMs == null) return pickFastest(refs);
  const recent = refs.filter(r => {
    const t = parseSwimDateMs(r.date);
    return t == null || t >= cutoffMs;
  });
  if (recent.length > 0) return pickFastest(recent);
  const best = pickFastest(refs);
  return best ? { ...best, stale: true } : undefined;
}

function pickFastest<T extends { timeSec: number }>(refs: T[]): T | undefined {
  let best: T | undefined;
  for (const r of refs) {
    if (!best || r.timeSec < best.timeSec) best = r;
  }
  return best;
}

/** The team+gender history slice plus the recency cutoff derived from it. */
export type TeamHistoryWindow = {
  /** Rows of workspace.athleteHistory for this team+gender. */
  history: HistoricalSwim[];
  /** Recency cutoff in ms, or null when the workspace has no dated swim at all. */
  cutoffMs: number | null;
};

/**
 * Team+gender history slice and its recency cutoff — the identical preamble
 * buildCrossCourseTable and buildRelayLegTimeIndex both open with.
 */
export function teamHistoryWindow(
  workspace: Workspace,
  opts: { team: string; gender: Gender; recencyMonths?: number }
): TeamHistoryWindow {
  const team = opts.team.trim();
  const allHistory = workspace.athleteHistory ?? [];
  const history = allHistory.filter(
    s => s.gender === opts.gender && String(s.team ?? '').trim() === team
  );

  // Recency anchor is the newest dated swim across the WHOLE workspace history,
  // so old files (with old "newest" dates) still surface their own recent bests.
  const recencyMonths = opts.recencyMonths ?? DEFAULT_RECENCY_MONTHS;
  const anchorMs = newestHistoryDateMs(allHistory);
  const cutoffMs = anchorMs == null ? null : recencyCutoffMs(anchorMs, recencyMonths);
  return { history, cutoffMs };
}

// --- history → SCY projection prefix ----------------------------------------

/** One history row projected onto SCY, before any event classification. */
export type ProjectedHistorySwim = {
  /** The original history row (never mutated). */
  swim: HistoricalSwim;
  /** Course as recorded, defaulted to SCY. */
  timeType: 'SCY' | 'LCM' | 'SCM';
  /**
   * convertSwimToSCY output — SCY event label + SCY time. Identity for SCY rows;
   * for LCM/SCM this also remaps distance identity (400→500, 800→1000, 1500→1650).
   */
  converted: { event: string; time: string };
};

/**
 * The projection prefix every history-driven analysis shares: drop relays, drop
 * courses with no published conversion factor, then convert to SCY. The CALLER
 * classifies the converted event (canonical program event vs relay-leg
 * distance+stroke) — those classifiers differ by design, see the module header.
 */
export function* convertedHistorySwims(
  history: HistoricalSwim[]
): Generator<ProjectedHistorySwim> {
  for (const s of history) {
    if (/\brelay\b/i.test(s.event)) continue;
    const timeType = s.timeType ?? 'SCY';
    // No published factor → the swim has no SCY equivalent. These are non-program
    // events (25s, 100 IM) that the caller's classifier rejects regardless.
    if (timeType !== 'SCY' && !hasConversionFactor(s.event)) continue;
    const converted = convertSwimToSCY(s.event, s.time, s.gender, timeType);
    yield { swim: s, timeType, converted };
  }
}

// --- cross-course table row types -------------------------------------------

export type CrossCourseTimeRef = {
  time: string;
  timeSec: number;
  meetLabel?: string;
  date?: string;
  /** True when this best is older than the recency window (kept as a fallback). */
  stale?: boolean;
};

export type CrossCourseConvertedRef = CrossCourseTimeRef & {
  /** Original (un-converted) time as swum. */
  sourceTime: string;
  sourceCourse: 'LCM' | 'SCM';
  /** Original event as swum (e.g. "400 Freestyle" for a 500 Free SCY slot). */
  sourceEvent: string;
};

export type CrossCourseRow = {
  athlete: string;
  /** SCY program event slot. */
  event: string;
  scyBest?: CrossCourseTimeRef;
  convertedBest?: CrossCourseConvertedRef;
  /** Which of the two is faster (drives the recommended time). */
  effectiveBest: 'scy' | 'converted';
  /** Seconds the converted time beats the actual SCY time by (only when it does). */
  convertedWinsBy?: number;
};

export type CrossCourseTable = { rows: CrossCourseRow[] };

/** Effective-best ref carried through swap/add candidate enumeration. */
export type EffectiveBestRef = {
  time: string;
  timeSec: number;
  stale?: boolean;
  /** True when the effective best came from a converted LCM/SCM swim. */
  converted?: boolean;
};

/** effective (recommended) SCY best per (athlete, program event) from a table. */
export function effectiveBestIndex(
  table: CrossCourseTable
): Map<string, Map<string, EffectiveBestRef>> {
  const out = new Map<string, Map<string, EffectiveBestRef>>();
  for (const row of table.rows) {
    const ref = row.effectiveBest === 'converted' ? row.convertedBest : row.scyBest;
    if (!ref) continue;
    const key = normalizeSwimmerName(row.athlete);
    let m = out.get(key);
    if (!m) {
      m = new Map();
      out.set(key, m);
    }
    m.set(row.event, {
      time: ref.time,
      timeSec: ref.timeSec,
      stale: ref.stale,
      converted: row.effectiveBest === 'converted' ? true : undefined,
    });
  }
  return out;
}

// --- conversion confidence bands --------------------------------------------

/**
 * Additive confidence tag for swap/add rows: 'verify' means the row's outcome
 * hinges on a converted (LCM/SCM→SCY) time whose winning margin against the
 * field is within ~1% of the converted time — i.e. inside conversion-factor
 * noise, so the projected points should be verified in practice.
 */
export type EntryConfidence = 'verify';

/**
 * Winning-margin threshold, as a fraction of the converted time, under which a
 * converted-time swap/add row is tagged `confidence: 'verify'`.
 */
export const CONVERSION_VERIFY_MARGIN = 0.01;

export type EventTimeRef = { nameKey: string; timeSec: number };

/**
 * Per canonical program event: every individual competitor time in the current
 * field (loaded results minus exhibitions/time trials, active plans, recruits —
 * all teams). Used only to measure how close a converted candidate time sits to
 * its nearest competitor (the margin that decides placements).
 */
export function buildEventTimeIndex(
  workspace: Workspace,
  gender: Gender
): Map<string, EventTimeRef[]> {
  const out = new Map<string, EventTimeRef[]>();
  const push = (event: string, name: string, timeSec: number) => {
    if (!Number.isFinite(timeSec) || timeSec <= 0) return;
    const canon = canonicalProgramEvent(event);
    if (!canon) return;
    let arr = out.get(canon);
    if (!arr) {
      arr = [];
      out.set(canon, arr);
    }
    arr.push({ nameKey: normalizeSwimmerName(name), timeSec });
  };

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  for (const r of results) {
    if (r.gender != null && r.gender !== gender) continue;
    if (isRelayResult(r) || r.isExhibition || r.isTimeTrial) continue;
    push(r.event, r.name, convertTimeToSeconds(r.time));
  }
  for (const p of workspace.meetEntryPlans ?? []) {
    if (p.gender !== gender || !planIsActive(p, workspace.activeEntryIds)) continue;
    push(
      p.event,
      p.name,
      convertTimeToSeconds(convertToSCY(p.time, p.event, p.gender, p.timeType ?? 'SCY'))
    );
  }
  for (const rec of workspace.recruits ?? []) {
    if (rec.gender !== gender) continue;
    push(
      rec.event,
      rec.name,
      convertTimeToSeconds(convertToSCY(rec.time, rec.event, rec.gender, rec.timeType))
    );
  }
  return out;
}

/**
 * 'verify' when the nearest OTHER-athlete field time in `event` is within
 * CONVERSION_VERIFY_MARGIN of `timeSec` (both faster and slower neighbors
 * count — conversion error can flip the placement either way). Undefined when
 * the margin is comfortable or the event has no field times.
 */
export function conversionConfidence(
  index: Map<string, EventTimeRef[]>,
  event: string,
  athlete: string,
  timeSec: number
): EntryConfidence | undefined {
  if (!Number.isFinite(timeSec) || timeSec <= 0) return undefined;
  const rows = index.get(event);
  if (!rows || rows.length === 0) return undefined;
  const nameKey = normalizeSwimmerName(athlete);
  let minGap = Infinity;
  for (const r of rows) {
    if (r.nameKey === nameKey) continue;
    const gap = Math.abs(r.timeSec - timeSec);
    if (gap < minGap) minGap = gap;
  }
  return minGap <= timeSec * CONVERSION_VERIFY_MARGIN ? 'verify' : undefined;
}

export function planIsActive(entry: PlannedSwimEntry, activeIds?: string[]): boolean {
  if (entry.active === false) return false;
  if (activeIds && activeIds.length > 0) return activeIds.includes(entry.id);
  return true;
}

// --- full re-score helpers --------------------------------------------------

/**
 * Team total via full re-score of a workspace clone (mirrors teamTotal in
 * rosterArbitrage.ts). The caller passes a workspace already carrying whatever
 * drop/add it is simulating (filtered results/recruits + overlay plans); this
 * just scores it. buildWhatIfResults reads currentResults/recruits/plans from
 * the passed workspace, so a filtered clone flows through end to end.
 */
export function teamTotal(
  ws: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): number {
  return sumTeamPoints(scoreWorkspaceRows(ws, gender, settings), team, gender);
}

/** Full re-score of a workspace, rows retained (exact teamTotal pipeline). */
export function scoreWorkspaceRows(
  ws: Workspace,
  gender: Gender,
  settings: ScoringSettings
): SwimmerResult[] {
  const results = buildWhatIfResults({ workspace: ws, gender, removeSeniors: false });
  return calculatePoints(results, settings, {
    scorerRosterOverrides: ws.scorerRosterOverrides ?? [],
    conferenceForMerge: ws.conference,
    resultsForPdfHint: [...(ws.menResults ?? []), ...(ws.womenResults ?? [])],
  });
}

/** Team points over scored rows (same filter teamTotal always used). */
export function sumTeamPoints(scored: SwimmerResult[], team: string, gender: Gender): number {
  return scored
    .filter(r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null))
    .reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
}

/** Shared guided reason when the scoring field cannot produce meaningful deltas. */
export function fieldNotMeaningfulReason(teamsWithResults: Set<string>, gender: Gender): string {
  return teamsWithResults.size === 0
    ? `No ${gender === Gender.MEN ? 'men' : 'women'}'s individual results to score against — showing cross-course times only.`
    : `Scoring field has only ${[...teamsWithResults][0]} — point deltas need at least two teams. Showing cross-course times only.`;
}

/** Distinct teams that have at least one scoring-eligible individual result row. */
export function distinctIndividualResultTeams(
  results: SwimmerResult[],
  gender: Gender
): Set<string> {
  const teams = new Set<string>();
  for (const r of results) {
    if (r.gender != null && r.gender !== gender) continue;
    if (isRelayResult(r)) continue;
    if (r.isExhibition || r.isTimeTrial) continue;
    const t = String(r.team ?? '').trim();
    if (t) teams.add(t);
  }
  return teams;
}

// --- droppable current entries ----------------------------------------------

/** One currently-entered individual entry an athlete could drop in a 1-for-1 swap. */
export type DroppableEntry = {
  source: 'plan' | 'result' | 'recruit';
  id: string;
  /** Canonical SCY program event. */
  event: string;
  /** Display name (for the created replacement entry). */
  name: string;
  classYear?: string;
  /** Time as swum on the dropped entry (for reporting). */
  time?: string;
};

/** Source priority when the same athlete+event appears more than once (lower wins). */
const DROP_SOURCE_PRIORITY: Record<DroppableEntry['source'], number> = {
  plan: 0,
  result: 1,
  recruit: 2,
};

/**
 * Every current individual entry the team's athletes hold, grouped by athlete
 * (normalized name) then by canonical program event. Union of three sources:
 *   - active individual plan entries (dropSource 'plan'),
 *   - individual program-event result rows in men/womenResults (dropSource
 *     'result'), skipping relays / exhibitions / time trials,
 *   - recruit rows for the team (dropSource 'recruit').
 * When an event appears from more than one source for the same athlete, the
 * higher-priority source is kept (plan > result > recruit) so a single event is
 * never double-counted as two separate drops.
 */
export function collectDroppableEntries(
  workspace: Workspace,
  team: string,
  gender: Gender
): Map<string, { display: string; byEvent: Map<string, DroppableEntry> }> {
  const byAthlete = new Map<string, { display: string; byEvent: Map<string, DroppableEntry> }>();

  const consider = (nameKey: string, display: string, entry: DroppableEntry) => {
    let a = byAthlete.get(nameKey);
    if (!a) {
      a = { display, byEvent: new Map() };
      byAthlete.set(nameKey, a);
    }
    const existing = a.byEvent.get(entry.event);
    if (!existing || DROP_SOURCE_PRIORITY[entry.source] < DROP_SOURCE_PRIORITY[existing.source]) {
      a.byEvent.set(entry.event, entry);
    }
  };

  // 1. Active individual plan entries.
  const activePlans = (workspace.meetEntryPlans ?? []).filter(
    p =>
      p.gender === gender &&
      String(p.team ?? '').trim() === team &&
      planIsActive(p, workspace.activeEntryIds)
  );
  for (const p of activePlans) {
    const event = canonicalProgramEvent(p.event);
    if (!event) continue;
    consider(normalizeSwimmerName(p.name), p.name, {
      source: 'plan',
      id: p.id,
      event,
      name: p.name,
      classYear: p.classYear == null ? undefined : String(p.classYear),
      time: p.time,
    });
  }

  // 2. Individual result rows (loaded meet PDF / paste) for this team+gender.
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  for (const r of results) {
    if (r.gender != null && r.gender !== gender) continue;
    if (isRelayResult(r)) continue;
    if (r.isExhibition || r.isTimeTrial) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    const event = canonicalProgramEvent(r.event);
    if (!event) continue;
    consider(normalizeSwimmerName(r.name), r.name, {
      source: 'result',
      id: r.id,
      event,
      name: r.name,
      classYear: r.classYear == null ? undefined : String(r.classYear),
      time: r.time,
    });
  }

  // 3. Recruit rows for this team+gender (they become what-if results too).
  for (const rec of workspace.recruits ?? []) {
    if (rec.gender !== gender) continue;
    if (String(rec.team ?? '').trim() !== team) continue;
    const event = canonicalProgramEvent(rec.event);
    if (!event) continue;
    consider(normalizeSwimmerName(rec.name), rec.name, {
      source: 'recruit',
      id: rec.id,
      event,
      name: rec.name,
      classYear: rec.classYear == null ? undefined : String(rec.classYear),
      time: rec.time,
    });
  }

  return byAthlete;
}

// --- incremental (fast) swap re-scoring ------------------------------------
//
// The full re-score above runs buildWhatIfResults + calculatePoints per swap
// candidate (~3.5 ms each; seconds on a realistic merged workspace). The fast
// path re-uses a single baseline scoring and, per candidate, re-scores ONLY the
// two events a 1-for-1 swap touches — reproducing calculatePoints' exact result.
//
// INVARIANCE ANALYSIS (1-for-1 same-swimmer swap X: drop event D, add event A).
// team T's total = T's relay points + T's individual points. The fast path is
// applied behind a gate; anything it cannot prove invariant falls back.
//
//  * PDF place-points mode (effectivePdfPlacePointsMode): points come straight
//    from row.pdfPoints, an entirely different code path — FALL BACK.
//  * relayEligibleFromScorerPool: relay eligibility would couple to the shared
//    individual scorer pool across events — FALL BACK.
//  * entryPlanMode 'plan_sheet': different pool-assembly pipeline — FALL BACK.
//  * Per-event individual cap (scorerCapScope !== 'meet' with a finite cap):
//    the sweep below models the meet-wide pool; a per-event cap is a different
//    rule — FALL BACK. (An unbounded cap, >=999, blocks no one, and the sweep
//    degenerates to "everyone eligible scores", which is exactly correct.)
//  * Roster eligibility (usesScorerRoster): the auto/override scorer flag is per
//    swimmer. Only X's own flag can change (its added entry is an optimizer =
//    recruit row, always a scorer). To keep every other event invariant we
//    REQUIRE X to already be a baseline scorer; otherwise X's untouched result
//    rows in other events could newly score — FALL BACK for that candidate.
//    With X already a scorer the roster lookup is identical before/after, so
//    T's relay points and T's individual points outside {A,D} are unchanged.
//  * Meet-wide individual scorer pool (scorerCapScope 'meet'): genuinely couples
//    events in meet order. Rather than prove it away, the fast path REPRODUCES
//    it with an explicit pool sweep and SELF-VALIDATES: it re-derives the
//    baseline team total two ways (real calculatePoints vs. the sweep) and only
//    trusts the fast deltas when they agree to the cent; otherwise FALL BACK.
//
// Only events {A, D} change placements under the swap (projectRanksInField
// re-ranks by time, per event); every other event's per-row placement points
// are identical to baseline, so the sweep re-uses cached baseline groups for
// them and re-scores only the two touched events (no-pool) per candidate.

/** One scored tie-group for a single team, in meet+rank order (pool sweep unit). */
type TeamScoreGroup = {
  /** Distinct swimmer keys sharing this placement (all-or-none against the pool). */
  names: string[];
  /** Team points each listed swimmer earns if the group scores. */
  ptsEach: number;
  /** Pool weight each NEW swimmer consumes (diving events weigh less). */
  weight: number;
};

export type FastSwapContext = {
  /** Returns the exact modWs team total for a swap, or null to fall back. */
  newTotalFor: (drop: DroppableEntry, newEntry: PlannedSwimEntry, addEvent: string) => number | null;
  /**
   * Exact team total after dropping ONE entry alone (no add), or null to fall
   * back. Only the drop's own event is re-scored; the overlay is valid only
   * when the projection regime is unchanged by the drop and (in roster mode)
   * scorer flags cannot shift — both gated inside, else null.
   */
  dropOnlyTotalFor: (drop: DroppableEntry) => number | null;
  /**
   * Exact team total after adding ONE optimizer plan alone (no drop), or null
   * to fall back. The added optimizer plan always forces field projection —
   * the same regime the baseline context is built in — so only the add event
   * needs re-scoring. Roster mode requires the athlete to already be a scorer
   * (same invariance gate as swaps), else null.
   */
  addOnlyTotalFor: (newEntry: PlannedSwimEntry) => number | null;
};

/** Sum of pool weights currently held. */
function poolWeightSum(pool: Map<string, number>): number {
  let s = 0;
  pool.forEach(w => (s += w));
  return s;
}

/**
 * Meet-wide scorer-pool sweep for ONE team, mirroring scoreIndividualsInEvent's
 * per-team pool logic exactly: groups are offered in meet+rank order; a group
 * scores iff every one of its distinct swimmers is already pooled or can still
 * be added (each checked against the pre-group pool, all-or-none). Newly pooled
 * swimmers consume their event weight. An unbounded cap never blocks.
 */
function sweepTeamIndividualTotal(
  eventsOrder: string[],
  groupsByEvent: Map<string, TeamScoreGroup[]>,
  cap: number
): number {
  const pool = new Map<string, number>();
  let total = 0;
  for (const ev of eventsOrder) {
    const groups = groupsByEvent.get(ev);
    if (!groups) continue;
    for (const grp of groups) {
      const preWeight = poolWeightSum(pool);
      const canAll = grp.names.every(
        n => pool.has(n) || preWeight + grp.weight <= cap + 1e-9
      );
      if (!canAll) continue;
      for (const n of grp.names) {
        if (!pool.has(n)) pool.set(n, grp.weight);
        total += grp.ptsEach;
      }
    }
  }
  return total;
}

/** Group a team's scored (no-pool) individual rows into ordered pool-sweep units. */
function buildTeamGroupsForEvent(
  rows: SwimmerResult[],
  event: string,
  diverEventPattern: string[] | undefined,
  diverWeight: number
): TeamScoreGroup[] {
  const scoring = rows.filter(r => Number(r.points ?? 0) > 0);
  if (scoring.length === 0) return [];
  const byKey = new Map<string, SwimmerResult[]>();
  for (const r of scoring) {
    const key = `${(r.roundSwam ?? '').trim()}|${parseRankInt(r.rank) ?? 0}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const weight = isDivingEvent(event, diverEventPattern) ? diverWeight : 1;
  const keys = [...byKey.keys()].sort((a, b) => {
    const ga = byKey.get(a)![0];
    const gb = byKey.get(b)![0];
    const tw = roundTierSortForSweep(ga.roundSwam) - roundTierSortForSweep(gb.roundSwam);
    if (tw !== 0) return tw;
    return (parseRankInt(ga.rank) ?? 9999) - (parseRankInt(gb.rank) ?? 9999);
  });
  return keys.map(k => {
    const rs = byKey.get(k)!;
    const names = [...new Set(rs.map(r => normalizeSwimmerName(r.name)))];
    return { names, ptsEach: Number(rs[0].points ?? 0), weight };
  });
}

/** Mirror of utils' roundTierSort (kept local; only ordering matters for the sweep). */
function roundTierSortForSweep(roundSwam: string | undefined): number {
  const t = classifyRoundTier(roundSwam);
  const order: Record<string, number> = { A: 1, FIN: 1, UNK: 1, B: 2, PRE: 3, C: 8, D: 8, TT: 9 };
  return order[t] ?? 5;
}

/**
 * Build the fast (incremental) swap scorer for a workspace/gender/team, or null
 * when the regime is unsupported (falls back to full re-score). See the
 * invariance analysis above.
 */
export function buildFastSwapContext(
  workspace: Workspace,
  team: string,
  gender: Gender,
  merged: ScoringSettings,
  hint: SwimmerResult[]
): FastSwapContext | null {
  // --- gate: unsupported scoring regimes fall back wholesale.
  if (effectivePdfPlacePointsMode(merged, hint)) return null;
  if (merged.relayEligibleFromScorerPool === true) return null;
  if ((workspace.entryPlanMode ?? 'overlay') === 'plan_sheet') return null;
  // pdf_only excludes the added optimizer plan from scoring; the incremental add
  // model assumes the added row scores, so fall back to a full re-score.
  if ((workspace.scoringView ?? 'merged') === 'pdf_only') return null;
  const cap = merged.maxIndividualScorersPerTeam ?? 999;
  const capBinds = cap < 999;
  if (capBinds && merged.scorerCapScope !== 'meet') return null;

  const overrides = workspace.scorerRosterOverrides ?? [];
  const diverWeight = merged.diverScorerWeight ?? 1;
  const diverPattern = merged.diverEventPattern;

  // Merged remap: the added optimizer plan carries a canonical add-event label,
  // but buildWhatIfResults remaps imported/planned rows onto the loaded meet's
  // real event label. Mirror that here so the fast add-event group matches the
  // full re-score's grouping exactly. Empty index (roster-only) => identity.
  const genderResults = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const labelIndex = buildMeetEventLabelIndex(genderResults);
  const remapEvent = (event: string): string => {
    if (labelIndex.size === 0) return event;
    const canon = canonicalProgramEvent(event);
    if (!canon) return event;
    return labelIndex.get(canon) ?? event;
  };

  // Baseline scored once, in the SAME projection regime every swap produces
  // (an added optimizer plan always forces projectRanksInField).
  const R = projectRanksInField(buildWhatIfResults({ workspace, gender, removeSeniors: false }));
  const realScored = calculatePoints(R, merged, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: hint,
  });

  const isTeam = (r: SwimmerResult) =>
    String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null);
  let realIndivT = 0;
  let baseRelayT = 0;
  for (const r of realScored) {
    if (!isTeam(r)) continue;
    if (isRelayResult(r)) baseRelayT += Number(r.points ?? 0);
    else realIndivT += Number(r.points ?? 0);
  }

  // No-pool scoring => per-row "points if the pool allowed it". conference is
  // dropped so the NSISC merge cannot re-force the meet cap we just lifted.
  const noPoolSettings: ScoringSettings = {
    ...merged,
    maxIndividualScorersPerTeam: 999,
    scorerCapScope: 'event',
  };
  const npScored = calculatePoints(R, noPoolSettings, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: undefined,
    resultsForPdfHint: hint,
  });
  const npById = new Map(npScored.map(r => [r.id, r]));

  // Event insertion order exactly as calculatePoints sees it: non-recruit rows
  // first, then recruit rows, deduped; then sorted by meet order (stable).
  const insertionOrder: string[] = [];
  const seen = new Set<string>();
  for (const r of R) {
    if (r.isRecruit) continue;
    if (!seen.has(r.event)) {
      seen.add(r.event);
      insertionOrder.push(r.event);
    }
  }
  for (const r of R) {
    if (!r.isRecruit) continue;
    if (!seen.has(r.event)) {
      seen.add(r.event);
      insertionOrder.push(r.event);
    }
  }
  const eventsOrder = sortEventsByMeetOrder(insertionOrder);

  // Baseline team groups per event, from the no-pool scoring.
  const npTeamByEvent = new Map<string, SwimmerResult[]>();
  for (const r of npScored) {
    if (isRelayResult(r) || !isTeam(r)) continue;
    if (!npTeamByEvent.has(r.event)) npTeamByEvent.set(r.event, []);
    npTeamByEvent.get(r.event)!.push(r);
  }
  const baseGroupsByEvent = new Map<string, TeamScoreGroup[]>();
  for (const [ev, rows] of npTeamByEvent) {
    baseGroupsByEvent.set(ev, buildTeamGroupsForEvent(rows, ev, diverPattern, diverWeight));
  }

  // SELF-VALIDATION: the sweep must reproduce the real baseline exactly.
  // NOTE (2026-07-20): on the seeded HSU+NSISC merged workspace this check
  // currently FAILS (sweep 1044.3 vs real 1314.1 — the engine's roster-mode
  // relay-leg pool seeding is not modeled by the sweep since the entry-limit
  // round's scoring changes), so the context falls back to the full re-score
  // wholesale there. Correctness is preserved by design; the 62x fast path is
  // simply inactive on that regime until the sweep learns relay pool seeding.
  const sweepBase = sweepTeamIndividualTotal(eventsOrder, baseGroupsByEvent, cap);
  if (Math.abs(sweepBase - realIndivT) > 1e-4) return null;

  // Rows grouped by event for fast subset assembly, and the roster lookup for
  // the X-eligibility gate + override pinning.
  const rRowsByEvent = new Map<string, SwimmerResult[]>();
  for (const r of R) {
    if (!rRowsByEvent.has(r.event)) rRowsByEvent.set(r.event, []);
    rRowsByEvent.get(r.event)!.push(r);
  }
  const rById = new Map(R.map(r => [r.id, r]));
  const rosterLookup: ScorerRosterLookup = buildScorerRosterLookup(R, merged, overrides);
  const rosterMode = usesScorerRoster(merged);

  // Because no-pool scoring is independent per event, event A (add) and event D
  // (drop) can be re-scored separately and memoized across the many candidates
  // that share the same add or the same drop.
  const scoreOneEventNoPool = (eventStr: string, rows: SwimmerResult[]): TeamScoreGroup[] => {
    const projected = projectRanksInField(rows);
    const subOverrides: ScorerRosterOverride[] = [];
    const pinned = new Set<string>();
    for (const r of projected) {
      const t = String(r.team ?? '').trim() || 'Unknown';
      const g = (r.gender ?? gender) as Gender;
      const key = `${t}|||${g}|||${normalizeSwimmerName(r.name)}`;
      if (pinned.has(key)) continue;
      pinned.add(key);
      subOverrides.push({ team: t, gender: g, name: r.name, isScorer: rosterLookup.isScorer(r.name, t, g) });
    }
    const np = calculatePoints(projected, noPoolSettings, {
      scorerRosterOverrides: subOverrides,
      conferenceForMerge: undefined,
      resultsForPdfHint: hint,
    });
    const teamRows = np.filter(r => !isRelayResult(r) && isTeam(r) && r.event === eventStr);
    return buildTeamGroupsForEvent(teamRows, eventStr, diverPattern, diverWeight);
  };

  const dropMemo = new Map<string, { eventStr: string; groups: TeamScoreGroup[] } | null>();
  const dropGroupsFor = (drop: DroppableEntry): { eventStr: string; groups: TeamScoreGroup[] } | null => {
    if (dropMemo.has(drop.id)) return dropMemo.get(drop.id)!;
    const dropRow = rById.get(drop.id);
    let out: { eventStr: string; groups: TeamScoreGroup[] } | null = null;
    if (dropRow) {
      const eventStr = dropRow.event;
      const rows = (rRowsByEvent.get(eventStr) ?? []).filter(r => r.id !== drop.id);
      out = { eventStr, groups: scoreOneEventNoPool(eventStr, rows) };
    }
    dropMemo.set(drop.id, out);
    return out;
  };

  const addMemo = new Map<string, TeamScoreGroup[]>();
  const addGroupsFor = (newEntry: PlannedSwimEntry, addEventStr: string): TeamScoreGroup[] => {
    const key = `${normalizeSwimmerName(newEntry.name)}|${addEventStr}`;
    const cached = addMemo.get(key);
    if (cached) return cached;
    // The added row must carry the SAME (remapped) event label as its group so
    // projectRanksInField ranks it against the real meet field.
    const addedRow = { ...planToResult(newEntry), event: addEventStr };
    const rows = [...(rRowsByEvent.get(addEventStr) ?? []), addedRow];
    const groups = scoreOneEventNoPool(addEventStr, rows);
    addMemo.set(key, groups);
    return groups;
  };

  const newTotalFor = (
    drop: DroppableEntry,
    newEntry: PlannedSwimEntry,
    addEvent: string
  ): number | null => {
    const dropRow = rById.get(drop.id);
    if (!dropRow) return null; // e.g. a plan that replaced a result row — fall back.
    // X must already be a baseline scorer so the roster lookup (relays + all
    // other events) is invariant under the swap.
    if (rosterMode && !rosterLookup.isScorer(newEntry.name, team, gender)) return null;

    const dropEventStr = dropRow.event;
    // Add-event group: the loaded meet's real label (merged remap) or the
    // canonical label when unmatched / roster-only — matching buildWhatIfResults.
    const addEventStr = remapEvent(newEntry.event);
    if (dropEventStr === addEventStr) return null; // nothing localizable.

    const dropRes = dropGroupsFor(drop);
    if (!dropRes) return null;
    const addGroups = addGroupsFor(newEntry, addEventStr);

    // Overlay the two recomputed events onto the cached baseline groups.
    const modGroups = new Map(baseGroupsByEvent);
    modGroups.set(dropEventStr, dropRes.groups);
    modGroups.set(addEventStr, addGroups);
    let order = eventsOrder;
    if (!seen.has(addEventStr)) {
      // A brand-new canonical add-event: added rows sort at the meet-order tail.
      order = [...eventsOrder, addEventStr].sort(
        (a, b) => eventMeetSortKey(a) - eventMeetSortKey(b)
      );
    }

    const indivT = sweepTeamIndividualTotal(order, modGroups, cap);
    return baseRelayT + indivT;
  };

  // --- drop-only / add-only incremental scorers (same overlay machinery) ----

  // The base workspace's own projection regime (mirrors buildWhatIfResults:
  // overlay mode + at least one projected plan for this gender => field
  // projection). The baseline R above is ALWAYS projected, so a drop-only
  // overlay is only valid when the base regime projects too — otherwise the
  // dropped workspace scores on stored ranks and we must fall back.
  const plansAll = workspace.meetEntryPlans ?? [];
  const planProjects = (p: PlannedSwimEntry): boolean =>
    p.gender === gender &&
    (p.projectedRank != null || p.source === 'optimizer' || p.source === 'swimcloud');
  const baseProjects = plansAll.some(planProjects);

  const dropOnlyTotalFor = (drop: DroppableEntry): number | null => {
    // Roster mode: removing a row can flip auto-derived scorer flags (an
    // A/B-final row disappearing un-marks its athlete), which couples relays
    // and every other event — not localizable, fall back.
    if (rosterMode) return null;
    if (!baseProjects) return null;
    // Removing the last projected plan would flip the whole workspace back to
    // stored-rank scoring — a regime change the overlay cannot model.
    if (drop.source === 'plan' && !plansAll.some(p => p.id !== drop.id && planProjects(p))) {
      return null;
    }
    const dropRes = dropGroupsFor(drop);
    if (!dropRes) return null;
    const modGroups = new Map(baseGroupsByEvent);
    modGroups.set(dropRes.eventStr, dropRes.groups);
    return baseRelayT + sweepTeamIndividualTotal(eventsOrder, modGroups, cap);
  };

  const addOnlyTotalFor = (newEntry: PlannedSwimEntry): number | null => {
    // Same roster gate as swaps: the athlete must already be a baseline scorer
    // so the roster lookup (relays + all other events) is invariant.
    if (rosterMode && !rosterLookup.isScorer(newEntry.name, team, gender)) return null;
    const addEventStr = remapEvent(newEntry.event);
    const addGroups = addGroupsFor(newEntry, addEventStr);
    const modGroups = new Map(baseGroupsByEvent);
    modGroups.set(addEventStr, addGroups);
    let order = eventsOrder;
    if (!seen.has(addEventStr)) {
      order = [...eventsOrder, addEventStr].sort(
        (a, b) => eventMeetSortKey(a) - eventMeetSortKey(b)
      );
    }
    return baseRelayT + sweepTeamIndividualTotal(order, modGroups, cap);
  };

  return { newTotalFor, dropOnlyTotalFor, addOnlyTotalFor };
}
