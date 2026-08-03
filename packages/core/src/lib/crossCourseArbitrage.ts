/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-course arbitrage engine. Extends the roster-arbitrage module family
 * (see rosterArbitrage.ts) with three read-only analyses over a workspace:
 *
 *   1. buildCrossCourseTable — per swimmer x program event, actual SCY best vs
 *      best converted LCM/SCM (via convertSwimToSCY, which also remaps distance
 *      identity 400->500, 800->1000, 1500->1650), flagging rows where the
 *      converted time beats the actual SCY time.
 *   2. buildCoverageGaps — per program event, how thinly the team fields entries
 *      relative to the scoring depth / field size (uncontested-point spots).
 *   3. rankExactSwaps — exact team-points delta of swapping each candidate
 *      add-event in for each of an athlete's CURRENT individual entries —
 *      whether they come from an active plan, a loaded meet result row, or a
 *      recruit row — by fully re-scoring (same buildWhatIfResults +
 *      calculatePoints pattern as teamTotal in rosterArbitrage.ts). Skipped when
 *      the workspace has no meaningful scoring field (fewer than two distinct
 *      teams with individual results).
 *
 * computeCrossCourseArbitrage bundles all three into one pure function so the UI
 * can run the whole computation off the main thread (see the crossCourseArbitrage
 * worker op in workers/scoringWorker.ts and the client in
 * lib/crossCourseArbitrageClient.ts).
 *
 * Test: npx tsx scripts/test_cross_course_arbitrage.mjs
 */

import {
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  RelayLegOverride,
  RelayLegStroke,
  ScorerRosterOverride,
  ScoringSettings,
  SwimmerResult,
  Workspace,
} from '../types';
import { buildMeetEventLabelIndex, canonicalProgramEvent } from './eventIdentity';
import { effectivePdfPlacePointsMode, mergeScoringSettings } from './scoringDefaults';
import { buildScorerRosterLookup, usesScorerRoster, type ScorerRosterLookup } from './scorerRoster';
import {
  displayTimeForRelayLeg,
  parseRelayDistanceYards,
  relayEntryKey,
  relayLegDistanceYards,
} from './relaySplits';
import {
  eventMatchesStrokeDistance,
  relayLegRequirements,
  relayStrokeForIndex,
  relayTemplateFromLeg,
  swimmerMatchesRelayLeg,
  upsertRelayLegOverride,
} from './relayLegMatching';
import {
  canAcceptAnotherEntry,
  countSwimmerEntries,
  swimmerExceedsEntryLimits,
} from './swimmerEntryLimits';
import { computeVacateRelayLegNames } from './rosterLineupAudit';
import {
  buildWhatIfResults,
  createPlannedEntry,
  planToResult,
  projectRanksInField,
} from './whatIfProjection';
import {
  calculatePoints,
  classifyRoundTier,
  convertSwimToSCY,
  convertTimeToSeconds,
  convertToSCY,
  eventMeetSortKey,
  isDivingEvent,
  isRelayResult,
  normalizeSwimmerName,
  parseRankInt,
  sortEventsByMeetOrder,
} from './utils';

/** Canonical SCY individual program-event order (used to sort table + gaps). */
const PROGRAM_EVENT_ORDER: string[] = [
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
];

function programEventOrderIndex(event: string): number {
  const i = PROGRAM_EVENT_ORDER.indexOf(event);
  return i < 0 ? PROGRAM_EVENT_ORDER.length + 1 : i;
}

/**
 * Canonical SCY program-event mapping now lives in eventIdentity.ts (neutral
 * module) so the scoring path can use it without importing this file. Re-exported
 * here for backward compatibility with existing imports.
 */
export { canonicalProgramEvent } from './eventIdentity';

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

export type CoverageGap = {
  event: string;
  /** Distinct athletes from `team` entered in this event (active plans + results). */
  countTeamEntries: number;
  /** Distinct individual entries across all teams in results for this event. */
  fieldSize: number;
  /** Number of place-scoring slots (settings.scoringPoints.length). */
  scoringPlaces: number;
  /** Per-swimmer individual entry cap (settings.maxIndividualEntriesPerSwimmer). */
  capPerSwimmer: number;
  /** Scoring slots not yet filled by the field (max(0, scoringPlaces - fieldSize)). */
  openSlots: number;
  /** Sortable attractiveness score (higher = thinner coverage / more open points). */
  gapScore: number;
};

export type ExactSwap = {
  athlete: string;
  addEvent: string;
  /** SCY-converted best time used for the added entry. */
  addTime: string;
  /** True when addTime is older than the recency window (only stale times existed). */
  addTimeStale?: boolean;
  dropEvent: string;
  /** Plan-entry id of the dropped entry (dropSource 'plan'). */
  dropEntryId?: string;
  /** Result-row id of the dropped entry (dropSource 'result'). */
  dropResultId?: string;
  /** Recruit-row id of the dropped entry (dropSource 'recruit'). */
  dropRecruitId?: string;
  /** Where the dropped current entry came from: an active plan, a loaded result row, or a recruit row. */
  dropSource: 'plan' | 'result' | 'recruit';
  /** Time as swum on the dropped current entry (when known). */
  dropTime?: string;
  /** True when addTime came from a converted LCM/SCM swim (not swum SCY). */
  addTimeConverted?: boolean;
  /**
   * 'verify' when the swap's outcome hinges on a converted time whose nearest
   * field time is within CONVERSION_VERIFY_MARGIN (~1%) of it — the placement
   * (and therefore the delta) sits inside conversion-factor noise. Additive
   * tag only; never changes ranking or filtering.
   */
  confidence?: EntryConfidence;
  deltaPoints: number;
  newTotal: number;
  baseTotal: number;
};

export type SwapRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  swaps: ExactSwap[];
  /** Number of (athlete x add-event x drop-entry) combinations re-scored. */
  candidatesEvaluated: number;
};

export type CrossCourseArbitrageOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  /**
   * Candidate/table bests prefer times dated within this many months of the
   * newest dated swim in the workspace history. Undated rows always count as
   * recent. An event with only older times keeps its best, flagged `stale`.
   * Default 24.
   */
  recencyMonths?: number;
};

export type CrossCourseArbitrageResult = {
  table: CrossCourseTable;
  gaps: CoverageGap[];
  swapRanking: SwapRanking;
  /** Drop-only analysis (over-entry / cap flags). Additive (2026-07 round). */
  dropRanking: DropOnlyRanking;
  /** Add-only analysis (open-slot gains for under-cap swimmers). Additive (2026-07 round). */
  addRanking: AddOnlyRanking;
};

// --- cross-course best-time table -------------------------------------------

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
function pickRecencyBest<T extends CrossCourseTimeRef>(
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

type EventBuckets = {
  scy: CrossCourseTimeRef[];
  converted: CrossCourseConvertedRef[];
};

/**
 * Per swimmer x SCY program event: actual SCY best vs best converted LCM/SCM.
 * Source is workspace.athleteHistory only (original rows are never mutated;
 * conversion happens on read). Program individual events only.
 */
export function buildCrossCourseTable(
  workspace: Workspace,
  opts: { team: string; gender: Gender; recencyMonths?: number }
): CrossCourseTable {
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

  // athlete (display name) -> program event -> buckets
  const byAthlete = new Map<string, { display: string; events: Map<string, EventBuckets> }>();

  const getBuckets = (nameKey: string, display: string, event: string): EventBuckets => {
    let a = byAthlete.get(nameKey);
    if (!a) {
      a = { display, events: new Map() };
      byAthlete.set(nameKey, a);
    }
    let b = a.events.get(event);
    if (!b) {
      b = { scy: [], converted: [] };
      a.events.set(event, b);
    }
    return b;
  };

  for (const s of history) {
    if (/\brelay\b/i.test(s.event)) continue;
    const timeType = s.timeType ?? 'SCY';
    const converted = convertSwimToSCY(s.event, s.time, s.gender, timeType);
    const programEvent = canonicalProgramEvent(converted.event);
    if (!programEvent) continue;
    const timeSec = convertTimeToSeconds(converted.time);
    if (!Number.isFinite(timeSec)) continue;

    const nameKey = normalizeSwimmerName(s.name);
    const buckets = getBuckets(nameKey, s.name, programEvent);
    if (timeType === 'SCY') {
      buckets.scy.push({
        time: converted.time,
        timeSec,
        meetLabel: s.meetLabel,
        date: s.date,
      });
    } else {
      buckets.converted.push({
        time: converted.time,
        timeSec,
        meetLabel: s.meetLabel,
        date: s.date,
        sourceTime: s.time,
        sourceCourse: timeType,
        sourceEvent: s.event,
      });
    }
  }

  const rows: CrossCourseRow[] = [];
  for (const { display, events } of byAthlete.values()) {
    for (const [event, buckets] of events) {
      const scyBest = pickRecencyBest(buckets.scy, cutoffMs);
      const convertedBest = pickRecencyBest(buckets.converted, cutoffMs);
      if (!scyBest && !convertedBest) continue;

      const convertedWins =
        !!convertedBest && (!scyBest || convertedBest.timeSec < scyBest.timeSec);
      const row: CrossCourseRow = {
        athlete: display,
        event,
        scyBest,
        convertedBest,
        effectiveBest: convertedWins ? 'converted' : 'scy',
      };
      if (scyBest && convertedBest && convertedBest.timeSec < scyBest.timeSec) {
        row.convertedWinsBy = Number((scyBest.timeSec - convertedBest.timeSec).toFixed(2));
      }
      rows.push(row);
    }
  }

  rows.sort((a, b) => {
    if (a.athlete !== b.athlete) return a.athlete.localeCompare(b.athlete);
    return programEventOrderIndex(a.event) - programEventOrderIndex(b.event);
  });

  return { rows };
}

function pickFastest<T extends { timeSec: number }>(refs: T[]): T | undefined {
  let best: T | undefined;
  for (const r of refs) {
    if (!best || r.timeSec < best.timeSec) best = r;
  }
  return best;
}

/** Effective-best ref carried through swap/add candidate enumeration. */
type EffectiveBestRef = {
  time: string;
  timeSec: number;
  stale?: boolean;
  /** True when the effective best came from a converted LCM/SCM swim. */
  converted?: boolean;
};

/** effective (recommended) SCY best per (athlete, program event) from a table. */
function effectiveBestIndex(table: CrossCourseTable): Map<string, Map<string, EffectiveBestRef>> {
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

type EventTimeRef = { nameKey: string; timeSec: number };

/**
 * Per canonical program event: every individual competitor time in the current
 * field (loaded results minus exhibitions/time trials, active plans, recruits —
 * all teams). Used only to measure how close a converted candidate time sits to
 * its nearest competitor (the margin that decides placements).
 */
function buildEventTimeIndex(workspace: Workspace, gender: Gender): Map<string, EventTimeRef[]> {
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
function conversionConfidence(
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

// --- team coverage gaps -----------------------------------------------------

/**
 * Per program event: how thinly the team fields entries relative to scoring
 * depth and field size. No heuristic point guesses — just counts and a sortable
 * gapScore (higher = thinner coverage / more open uncontested points).
 */
export function buildCoverageGaps(
  workspace: Workspace,
  opts: { team: string; gender: Gender; settings?: ScoringSettings }
): CoverageGap[] {
  const team = opts.team.trim();
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });
  const scoringPlaces = merged.scoringPoints.length;
  const capPerSwimmer = merged.maxIndividualEntriesPerSwimmer ?? 3;

  const results =
    opts.gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const activePlans = (workspace.meetEntryPlans ?? []).filter(
    p => p.gender === opts.gender && planIsActive(p, workspace.activeEntryIds)
  );

  // fieldSize (all teams) and team entry counts, per program event.
  const fieldByEvent = new Map<string, Set<string>>();
  const teamByEvent = new Map<string, Set<string>>();

  const noteField = (event: string, team_: string, name: string) => {
    let set = fieldByEvent.get(event);
    if (!set) {
      set = new Set();
      fieldByEvent.set(event, set);
    }
    set.add(`${team_}|${normalizeSwimmerName(name)}`);
  };
  const noteTeam = (event: string, name: string) => {
    let set = teamByEvent.get(event);
    if (!set) {
      set = new Set();
      teamByEvent.set(event, set);
    }
    set.add(normalizeSwimmerName(name));
  };

  for (const r of results) {
    if (r.gender != null && r.gender !== opts.gender) continue;
    if (isRelayResult(r)) continue;
    if (r.isExhibition || r.isTimeTrial) continue;
    const event = canonicalProgramEvent(r.event);
    if (!event) continue;
    const rTeam = String(r.team ?? '').trim();
    noteField(event, rTeam, r.name);
    if (rTeam === team) noteTeam(event, r.name);
  }
  for (const p of activePlans) {
    if (String(p.team ?? '').trim() !== team) continue;
    const event = canonicalProgramEvent(p.event);
    if (!event) continue;
    noteTeam(event, p.name);
  }

  const gaps: CoverageGap[] = PROGRAM_EVENT_ORDER.map(event => {
    const fieldSize = fieldByEvent.get(event)?.size ?? 0;
    const countTeamEntries = teamByEvent.get(event)?.size ?? 0;
    const openSlots = Math.max(0, scoringPlaces - fieldSize);
    // Thinner coverage ranks higher; a wholly un-entered event is the strongest gap.
    const gapScore = countTeamEntries === 0 ? openSlots + 1 : openSlots;
    return {
      event,
      countTeamEntries,
      fieldSize,
      scoringPlaces,
      capPerSwimmer,
      openSlots,
      gapScore,
    };
  });

  gaps.sort((a, b) => {
    if (b.gapScore !== a.gapScore) return b.gapScore - a.gapScore;
    return programEventOrderIndex(a.event) - programEventOrderIndex(b.event);
  });

  return gaps;
}

function planIsActive(entry: PlannedSwimEntry, activeIds?: string[]): boolean {
  if (entry.active === false) return false;
  if (activeIds && activeIds.length > 0) return activeIds.includes(entry.id);
  return true;
}

// --- exact points-delta swap ranking ----------------------------------------

/**
 * Team total via full re-score of a workspace clone (mirrors teamTotal in
 * rosterArbitrage.ts). The caller passes a workspace already carrying whatever
 * drop/add it is simulating (filtered results/recruits + overlay plans); this
 * just scores it. buildWhatIfResults reads currentResults/recruits/plans from
 * the passed workspace, so a filtered clone flows through end to end.
 */
function teamTotal(
  ws: Workspace,
  gender: Gender,
  team: string,
  settings: ScoringSettings
): number {
  return sumTeamPoints(scoreWorkspaceRows(ws, gender, settings), team, gender);
}

/** Full re-score of a workspace, rows retained (exact teamTotal pipeline). */
function scoreWorkspaceRows(
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
function sumTeamPoints(scored: SwimmerResult[], team: string, gender: Gender): number {
  return scored
    .filter(r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null))
    .reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
}

/** Shared guided reason when the scoring field cannot produce meaningful deltas. */
function fieldNotMeaningfulReason(teamsWithResults: Set<string>, gender: Gender): string {
  return teamsWithResults.size === 0
    ? `No ${gender === Gender.MEN ? 'men' : 'women'}'s individual results to score against — showing cross-course times only.`
    : `Scoring field has only ${[...teamsWithResults][0]} — point deltas need at least two teams. Showing cross-course times only.`;
}

/** Distinct teams that have at least one scoring-eligible individual result row. */
function distinctIndividualResultTeams(results: SwimmerResult[], gender: Gender): Set<string> {
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

/** One currently-entered individual entry an athlete could drop in a 1-for-1 swap. */
type DroppableEntry = {
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
function collectDroppableEntries(
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

/**
 * Build the modified-workspace clone that simulates one 1-for-1 swap: drop
 * `drop` (a plan/result/recruit entry) and add `newEntry` (the overlay plan for
 * the candidate add-event). Identical semantics to the delete-credited-swim +
 * add-plan simulation. Used by the full re-score path (and as the fallback for
 * the incremental fast path).
 */
function buildSwapWorkspace(
  workspace: Workspace,
  drop: DroppableEntry,
  newEntry: PlannedSwimEntry,
  field: 'menResults' | 'womenResults'
): Workspace {
  const basePlans = workspace.meetEntryPlans ?? [];
  const baseActiveIds = workspace.activeEntryIds;
  const hasActiveIds = !!baseActiveIds && baseActiveIds.length > 0;
  const baseResults = workspace[field] ?? [];
  const baseRecruits = workspace.recruits ?? [];

  if (drop.source === 'plan') {
    const modPlans = basePlans
      .map(p => (p.id === drop.id ? { ...p, active: false } : p))
      .concat(newEntry);
    const modActiveIds = hasActiveIds
      ? [...baseActiveIds!.filter(id => id !== drop.id), newEntry.id]
      : baseActiveIds;
    return { ...workspace, meetEntryPlans: modPlans, activeEntryIds: modActiveIds };
  }
  if (drop.source === 'result') {
    const modActiveIds = hasActiveIds ? [...baseActiveIds!, newEntry.id] : baseActiveIds;
    return {
      ...workspace,
      [field]: baseResults.filter(r => r.id !== drop.id),
      meetEntryPlans: [...basePlans, newEntry],
      activeEntryIds: modActiveIds,
    };
  }
  const modActiveIds = hasActiveIds ? [...baseActiveIds!, newEntry.id] : baseActiveIds;
  return {
    ...workspace,
    recruits: baseRecruits.filter(r => r.id !== drop.id),
    meetEntryPlans: [...basePlans, newEntry],
    activeEntryIds: modActiveIds,
  };
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

type FastSwapContext = {
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
function buildFastSwapContext(
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

/**
 * Exact team-points delta of each 1-for-1 swap: add a candidate program event
 * (using the athlete's SCY-converted best) in place of one of the athlete's
 * CURRENT individual entries — whether that entry came from an active plan, a
 * loaded meet result row, or a recruit row. Uses an incremental fast path that
 * re-scores only the two touched events (see buildFastSwapContext) and falls
 * back to a full re-score whenever the regime or a candidate is not provably
 * safe. Beneficial swaps only, sorted descending. Skips the enumeration
 * entirely when the scoring field is not meaningful (fewer than two distinct
 * teams with individual results).
 */
export function rankExactSwaps(
  workspace: Workspace,
  opts: {
    team: string;
    gender: Gender;
    settings?: ScoringSettings;
    table?: CrossCourseTable;
    recencyMonths?: number;
    /** Test/diagnostic hook: disable the incremental fast path (full re-score). */
    forceFullRescore?: boolean;
  }
): SwapRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const teamsWithResults = distinctIndividualResultTeams(results, gender);

  if (teamsWithResults.size < 2) {
    return {
      pointsMeaningful: false,
      reason: fieldNotMeaningfulReason(teamsWithResults, gender),
      swaps: [],
      candidatesEvaluated: 0,
    };
  }

  const table =
    opts.table ??
    buildCrossCourseTable(workspace, { team, gender, recencyMonths: opts.recencyMonths });
  const bestIndex = effectiveBestIndex(table);

  const droppableByAthlete = collectDroppableEntries(workspace, team, gender);

  // Invariants hoisted out of the inner loop.
  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';

  const baseTotal = teamTotal(workspace, gender, team, merged);
  const baseTotalRounded = Number(baseTotal.toFixed(3));

  // Incremental fast scorer (null => unsupported regime; score fully instead).
  const hint = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const fastCtx = opts.forceFullRescore
    ? null
    : buildFastSwapContext(workspace, team, gender, merged, hint);

  // De-dup identical (athlete, addEvent, dropEvent) outcomes, keeping the best delta.
  const bestByKey = new Map<string, ExactSwap>();
  let candidatesEvaluated = 0;

  for (const [athleteKey, { byEvent }] of droppableByAthlete) {
    const bests = bestIndex.get(athleteKey);
    if (!bests || byEvent.size === 0) continue;

    // Candidate add-events: the athlete's cross-course bests they are NOT already entered in.
    const enteredEvents = byEvent; // keyed by canonical program event
    const candidateEvents = [...bests.keys()].filter(ev => !enteredEvents.has(ev));
    if (candidateEvents.length === 0) continue;

    for (const addEvent of candidateEvents) {
      const best = bests.get(addEvent)!;
      for (const drop of byEvent.values()) {
        if (addEvent === drop.event) continue; // never swap an event for itself
        candidatesEvaluated += 1;

        // The added entry is the same across drop sources (best-per-event pool).
        const newEntry = createPlannedEntry({
          name: drop.name,
          team,
          gender,
          classYear: drop.classYear,
          event: addEvent,
          time: best.time,
          timeType: 'SCY',
          source: 'optimizer',
          active: true,
        });

        // Incremental fast scorer when available/safe; otherwise a full
        // re-score of the delete-credited-swim + add-plan simulation.
        let newTotal = fastCtx ? fastCtx.newTotalFor(drop, newEntry, addEvent) : null;
        if (newTotal == null) {
          const modWs = buildSwapWorkspace(workspace, drop, newEntry, field);
          newTotal = teamTotal(modWs, gender, team, merged);
        }
        const deltaPoints = Number((newTotal - baseTotal).toFixed(3));
        if (deltaPoints <= 0) continue;

        const dedupKey = `${athleteKey}|${addEvent}|${drop.event}`;
        const swap: ExactSwap = {
          athlete: drop.name,
          addEvent,
          addTime: best.time,
          addTimeStale: best.stale ? true : undefined,
          dropEvent: drop.event,
          dropEntryId: drop.id,
          dropResultId: drop.source === 'result' ? drop.id : undefined,
          dropRecruitId: drop.source === 'recruit' ? drop.id : undefined,
          dropSource: drop.source,
          dropTime: drop.time,
          addTimeConverted: best.converted ? true : undefined,
          deltaPoints,
          newTotal: Number(newTotal.toFixed(3)),
          baseTotal: baseTotalRounded,
        };
        const prior = bestByKey.get(dedupKey);
        if (!prior || swap.deltaPoints > prior.deltaPoints) bestByKey.set(dedupKey, swap);
      }
    }
  }

  const swaps = [...bestByKey.values()].sort((a, b) => b.deltaPoints - a.deltaPoints);

  // Conversion confidence bands: additive tagging only, AFTER ranking, so sort
  // and filter behavior are byte-identical to before.
  let timeIndex: Map<string, EventTimeRef[]> | null = null;
  for (const s of swaps) {
    if (!s.addTimeConverted) continue;
    if (!timeIndex) timeIndex = buildEventTimeIndex(workspace, gender);
    const conf = conversionConfidence(
      timeIndex,
      s.addEvent,
      s.athlete,
      convertTimeToSeconds(s.addTime)
    );
    if (conf) s.confidence = conf;
  }

  return { pointsMeaningful: true, swaps, candidatesEvaluated };
}

// --- apply an exact swap to a workspace -------------------------------------

/**
 * Pure workspace patch that enacts one {@link ExactSwap}: add an optimizer plan
 * for `addEvent`/`addTime` (active, appended to meetEntryPlans + activeEntryIds,
 * respecting the empty-activeIds regime), and drop the current entry by source
 * ('plan' → remove the plan; 'result' → filter the men/women result row;
 * 'recruit' → filter the recruit row). Returns the forward `patch`, an `inverse`
 * patch that exactly restores every touched field (round-trips), and a human
 * `description`. No mutation, no I/O.
 */
export function applyExactSwap(
  workspace: Workspace,
  swap: ExactSwap,
  opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const team = opts.team.trim();
  const gender = opts.gender;
  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';

  const newEntry = createPlannedEntry({
    name: swap.athlete,
    team,
    gender,
    event: swap.addEvent,
    time: swap.addTime,
    timeType: 'SCY',
    source: 'optimizer',
    active: true,
  });

  const basePlans = workspace.meetEntryPlans ?? [];
  const baseActiveIds = workspace.activeEntryIds;
  const hasActiveIds = !!baseActiveIds && baseActiveIds.length > 0;

  // Id of the row/entry being dropped (the additive per-source ids, falling back
  // to the shared dropEntryId that enumeration always populates).
  const dropId =
    swap.dropSource === 'plan'
      ? swap.dropEntryId
      : swap.dropSource === 'result'
        ? swap.dropResultId ?? swap.dropEntryId
        : swap.dropRecruitId ?? swap.dropEntryId;

  const patch: Partial<Workspace> = {};
  const inverse: Partial<Workspace> = {};

  // Drop side (result/recruit rows filtered by id; the prior array is stored for undo).
  if (swap.dropSource === 'result') {
    const baseResults = workspace[field] ?? [];
    patch[field] = baseResults.filter(r => r.id !== dropId);
    inverse[field] = baseResults;
  } else if (swap.dropSource === 'recruit') {
    const baseRecruits = workspace.recruits ?? [];
    patch.recruits = baseRecruits.filter(r => r.id !== dropId);
    inverse.recruits = baseRecruits;
  }

  // Plans: drop the plan (plan source) and always append the added entry.
  const plansAfterDrop =
    swap.dropSource === 'plan' ? basePlans.filter(p => p.id !== dropId) : basePlans;
  patch.meetEntryPlans = [...plansAfterDrop, newEntry];
  inverse.meetEntryPlans = basePlans;

  // Active ids only when the workspace uses an explicit active-id allowlist.
  if (hasActiveIds) {
    const withoutDrop =
      swap.dropSource === 'plan' ? baseActiveIds!.filter(id => id !== dropId) : baseActiveIds!;
    patch.activeEntryIds = [...withoutDrop, newEntry.id];
    inverse.activeEntryIds = baseActiveIds!;
  }

  const description = `${swap.athlete}: +${swap.addEvent} (${swap.addTime}), −${swap.dropEvent} (${swap.dropSource})`;

  return { patch, inverse, description };
}

// --- drop-only / add-only analysis ------------------------------------------
//
// Complements rankExactSwaps (1-for-1) with the two degenerate cases:
//
//   * rankDropOnly — the TRUE team delta of dropping ONE current entry alone.
//     Under place scoring a drop is never positive inside its own event, so a
//     positive delta always flags a structural problem: an over-entered swimmer
//     whose points the entry caps void (modeled below — the engine itself does
//     not void), or a meet-wide scorer-pool slot burned on a low-value entry.
//   * rankAddOnly — for swimmers still under their individual/total entry caps
//     (swimmerEntryLimits, incl. the NSISC total-7 cap), the TRUE delta of
//     adding their best available championship-program event without dropping
//     anything (open-slot gains).
//
// CAP-VOID MODEL. calculatePoints does not enforce per-swimmer entry caps —
// over-entry only surfaces in the lineup audit. Real NSISC-style rules void an
// over-entered swimmer's swims, so both rankings here score against an
// "effective" total: engine total minus the scored INDIVIDUAL points of every
// team athlete currently violating swimmerExceedsEntryLimits. (Relay shares
// are deliberately NOT voided — a real over-entry would jeopardize relays too,
// but relay point attribution is placement-based and shared; voiding legs
// would guess at re-swim outcomes. Documented limitation.) Each drop row keeps
// the pure engine delta (`scoredDelta`) and engine totals (`newTotal` /
// `baseTotal`, apply→re-score reproducible) alongside the effective
// `deltaPoints`; `voidedPointsRestored` is the modeled component.
//
// FAST PATH. Both rankings reuse the incremental context (buildFastSwapContext)
// with its structural self-validation, via dropOnlyTotalFor / addOnlyTotalFor.
// They additionally require that nobody is over cap at baseline — a violator's
// voided points can change through promotions/demotions in the touched event,
// which the overlay cannot see — and fall back to the full re-score otherwise
// (or per candidate whenever a gate trips). forceFullRescore mirrors the swap
// ranking's diagnostic hook.

/** One drop-only analysis row (positive effective deltas only). */
export type DropOnlyRow = {
  athlete: string;
  /** Canonical SCY program event of the dropped entry. */
  dropEvent: string;
  /** Id of the dropped entry (plan id / result row id / recruit id). */
  dropEntryId: string;
  /** Result-row id of the dropped entry (dropSource 'result'). */
  dropResultId?: string;
  /** Recruit-row id of the dropped entry (dropSource 'recruit'). */
  dropRecruitId?: string;
  /** Where the dropped entry came from — same semantics as ExactSwap. */
  dropSource: 'plan' | 'result' | 'recruit';
  /** Time as swum on the dropped entry (when known). */
  dropTime?: string;
  /**
   * Effective team delta of dropping this entry alone: pure engine re-score
   * delta plus any cap-void points the drop restores. Positive = the team
   * scores MORE with this entry gone.
   */
  deltaPoints: number;
  /** Pure engine re-score delta (newTotal − baseTotal), excluding void modeling. */
  scoredDelta: number;
  /** Modeled points restored by relieving an entry-cap violation (deltaPoints − scoredDelta, when > 0). */
  voidedPointsRestored?: number;
  /** True when the athlete currently exceeds an entry cap (this drop reduces the violation). */
  capRelief?: boolean;
  /** Engine team totals — applying the drop and re-scoring reproduces newTotal exactly. */
  newTotal: number;
  baseTotal: number;
};

export type DropOnlyRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  /** Positive effective deltas only, sorted descending. */
  drops: DropOnlyRow[];
  /** Number of droppable entries re-scored. */
  candidatesEvaluated: number;
};

export type DropOnlyOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  /** Test/diagnostic hook: disable the incremental fast path (full re-score). */
  forceFullRescore?: boolean;
};

/** One add-only (open-slot) analysis row (positive deltas only). */
export type AddOnlyRow = {
  athlete: string;
  /** Canonical SCY program event being added. */
  addEvent: string;
  /** SCY-converted best time used for the added entry. */
  addTime: string;
  /** True when addTime is older than the recency window (only stale times existed). */
  addTimeStale?: boolean;
  /** True when addTime came from a converted LCM/SCM swim (not swum SCY). */
  addTimeConverted?: boolean;
  /** 'verify' when the projected gain sits inside conversion-factor noise (see ExactSwap.confidence). */
  confidence?: EntryConfidence;
  /** Class year carried onto the created plan entry (when known). */
  classYear?: string;
  deltaPoints: number;
  /** Engine team totals — applying the add and re-scoring reproduces newTotal exactly. */
  newTotal: number;
  baseTotal: number;
};

export type AddOnlyRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  /** Positive deltas only, sorted descending. */
  adds: AddOnlyRow[];
  /** Number of (athlete × open add-event) combinations re-scored. */
  candidatesEvaluated: number;
};

export type AddOnlyOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  table?: CrossCourseTable;
  recencyMonths?: number;
  /** Test/diagnostic hook: disable the incremental fast path (full re-score). */
  forceFullRescore?: boolean;
};

/** Per-team cap-void summary over one scored row set (see CAP-VOID MODEL above). */
type CapVoidSummary = {
  /** Total voided individual points across all violating team athletes. */
  total: number;
  /** Voided individual points per violating athlete (normalized-name key). */
  byAthlete: Map<string, number>;
  /** Every team athlete currently violating an entry cap (even at 0 points). */
  overCapKeys: Set<string>;
};

function computeCapVoids(
  scored: SwimmerResult[],
  team: string,
  gender: Gender,
  settings: ScoringSettings
): CapVoidSummary {
  const teamRows = scored.filter(
    r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null)
  );
  const display = new Map<string, string>();
  for (const r of teamRows) {
    if (isRelayResult(r) && r.name === r.team) continue;
    const name = String(r.name ?? '').trim();
    if (!name || name === '—') continue;
    const k = normalizeSwimmerName(r.name);
    if (!display.has(k)) display.set(k, r.name);
  }

  const byAthlete = new Map<string, number>();
  const overCapKeys = new Set<string>();
  let total = 0;
  for (const [key, name] of display) {
    const counts = countSwimmerEntries(teamRows, team, gender, name);
    const over = swimmerExceedsEntryLimits(counts, settings);
    if (!over.individualOver && !over.relayOver && !over.totalOver) continue;
    overCapKeys.add(key);
    let pts = 0;
    for (const r of teamRows) {
      if (isRelayResult(r)) continue;
      if (normalizeSwimmerName(r.name) !== key) continue;
      pts += typeof r.points === 'number' ? r.points : 0;
    }
    if (pts > 0) {
      byAthlete.set(key, pts);
      total += pts;
    }
  }
  return { total: Number(total.toFixed(3)), byAthlete, overCapKeys };
}

/**
 * Forward/inverse patch that removes ONE entry by source — the exact drop half
 * of applyExactSwap ('plan' → remove the plan (+active-id), 'result' → filter
 * the row, 'recruit' → filter the recruit). Shared by the enumeration (so
 * ranked totals are reproducible by construction) and by applyEntryDrop.
 */
function entryDropPatch(
  workspace: Workspace,
  source: 'plan' | 'result' | 'recruit',
  id: string,
  field: 'menResults' | 'womenResults'
): { patch: Partial<Workspace>; inverse: Partial<Workspace> } {
  const patch: Partial<Workspace> = {};
  const inverse: Partial<Workspace> = {};
  if (source === 'result') {
    const baseResults = workspace[field] ?? [];
    patch[field] = baseResults.filter(r => r.id !== id);
    inverse[field] = baseResults;
    return { patch, inverse };
  }
  if (source === 'recruit') {
    const baseRecruits = workspace.recruits ?? [];
    patch.recruits = baseRecruits.filter(r => r.id !== id);
    inverse.recruits = baseRecruits;
    return { patch, inverse };
  }
  const basePlans = workspace.meetEntryPlans ?? [];
  patch.meetEntryPlans = basePlans.filter(p => p.id !== id);
  inverse.meetEntryPlans = basePlans;
  const baseActiveIds = workspace.activeEntryIds;
  if (baseActiveIds && baseActiveIds.length > 0) {
    patch.activeEntryIds = baseActiveIds.filter(x => x !== id);
    inverse.activeEntryIds = baseActiveIds;
  }
  return { patch, inverse };
}

/**
 * Forward/inverse patch that appends ONE active plan entry — the exact add half
 * of applyExactSwap. Shared by the enumeration and applyEntryAdd.
 */
function entryAddPatch(
  workspace: Workspace,
  newEntry: PlannedSwimEntry
): { patch: Partial<Workspace>; inverse: Partial<Workspace> } {
  const basePlans = workspace.meetEntryPlans ?? [];
  const baseActiveIds = workspace.activeEntryIds;
  const patch: Partial<Workspace> = { meetEntryPlans: [...basePlans, newEntry] };
  const inverse: Partial<Workspace> = { meetEntryPlans: basePlans };
  if (baseActiveIds && baseActiveIds.length > 0) {
    patch.activeEntryIds = [...baseActiveIds, newEntry.id];
    inverse.activeEntryIds = baseActiveIds;
  }
  return { patch, inverse };
}

/**
 * TRUE team delta of dropping each current individual entry ALONE (no add).
 * Droppable union and drop semantics are identical to rankExactSwaps /
 * applyExactSwap (active plans / meet result rows / recruit rows, one per
 * athlete×event, plan > result > recruit). Deltas are effective totals under
 * the cap-void model (see module comment) — positive rows flag over-entry /
 * cap problems (and genuine meet-pool relief). Positive only, sorted
 * descending. Incremental fast path with full-re-score fallback.
 */
export function rankDropOnly(workspace: Workspace, opts: DropOnlyOptions): DropOnlyRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const teamsWithResults = distinctIndividualResultTeams(results, gender);
  if (teamsWithResults.size < 2) {
    return {
      pointsMeaningful: false,
      reason: fieldNotMeaningfulReason(teamsWithResults, gender),
      drops: [],
      candidatesEvaluated: 0,
    };
  }

  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';
  const droppableByAthlete = collectDroppableEntries(workspace, team, gender);

  const scoredBase = scoreWorkspaceRows(workspace, gender, merged);
  const baseTotal = sumTeamPoints(scoredBase, team, gender);
  const baseTotalRounded = Number(baseTotal.toFixed(3));
  const baseVoids = computeCapVoids(scoredBase, team, gender, merged);
  const baseEffective = baseTotal - baseVoids.total;

  // Fast overlay is only void-safe when nobody is over cap at baseline (a
  // violator's voided points can shift with promotions in the touched event).
  const hint = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const fastCtx =
    opts.forceFullRescore || baseVoids.total > 0
      ? null
      : buildFastSwapContext(workspace, team, gender, merged, hint);

  const rows: DropOnlyRow[] = [];
  let candidatesEvaluated = 0;

  for (const { byEvent } of droppableByAthlete.values()) {
    for (const drop of byEvent.values()) {
      candidatesEvaluated += 1;
      const athleteKey = normalizeSwimmerName(drop.name);
      const capRelief = baseVoids.overCapKeys.has(athleteKey);

      let newTotal = fastCtx ? fastCtx.dropOnlyTotalFor(drop) : null;
      let newEffective: number;
      if (newTotal == null) {
        const modWs: Workspace = {
          ...workspace,
          ...entryDropPatch(workspace, drop.source, drop.id, field).patch,
        };
        const scoredMod = scoreWorkspaceRows(modWs, gender, merged);
        newTotal = sumTeamPoints(scoredMod, team, gender);
        newEffective = newTotal - computeCapVoids(scoredMod, team, gender, merged).total;
      } else {
        // fastCtx only exists when baseVoids.total === 0, and dropping cannot
        // create a new violation — effective total equals the engine total.
        newEffective = newTotal;
      }

      const scoredDelta = Number((newTotal - baseTotal).toFixed(3));
      const deltaPoints = Number((newEffective - baseEffective).toFixed(3));
      if (deltaPoints <= 0) continue;
      const voidRestored = Number((deltaPoints - scoredDelta).toFixed(3));

      rows.push({
        athlete: drop.name,
        dropEvent: drop.event,
        dropEntryId: drop.id,
        dropResultId: drop.source === 'result' ? drop.id : undefined,
        dropRecruitId: drop.source === 'recruit' ? drop.id : undefined,
        dropSource: drop.source,
        dropTime: drop.time,
        deltaPoints,
        scoredDelta,
        voidedPointsRestored: voidRestored > 0 ? voidRestored : undefined,
        capRelief: capRelief ? true : undefined,
        newTotal: Number(newTotal.toFixed(3)),
        baseTotal: baseTotalRounded,
      });
    }
  }

  rows.sort((a, b) => b.deltaPoints - a.deltaPoints);
  return { pointsMeaningful: true, drops: rows, candidatesEvaluated };
}

/**
 * TRUE team delta of adding each open championship-program event (athlete's
 * recency-weighted, SCY-converted best from athleteHistory — the exact same
 * candidate machinery as rankExactSwaps) WITHOUT dropping anything, for
 * swimmers still under their entry caps (canAcceptAnotherEntry over the scored
 * what-if rows: individual cap AND the total cap, e.g. NSISC total-7). Each
 * row applies as one active optimizer plan (applyEntryAdd). Positive only,
 * sorted descending; converted-time rows are confidence-tagged.
 */
export function rankAddOnly(workspace: Workspace, opts: AddOnlyOptions): AddOnlyRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const teamsWithResults = distinctIndividualResultTeams(results, gender);
  if (teamsWithResults.size < 2) {
    return {
      pointsMeaningful: false,
      reason: fieldNotMeaningfulReason(teamsWithResults, gender),
      adds: [],
      candidatesEvaluated: 0,
    };
  }

  const table =
    opts.table ??
    buildCrossCourseTable(workspace, { team, gender, recencyMonths: opts.recencyMonths });
  const bestIndex = effectiveBestIndex(table);
  const displayByKey = new Map<string, string>();
  for (const row of table.rows) {
    const k = normalizeSwimmerName(row.athlete);
    if (!displayByKey.has(k)) displayByKey.set(k, row.athlete);
  }

  const droppableByAthlete = collectDroppableEntries(workspace, team, gender);

  const scoredBase = scoreWorkspaceRows(workspace, gender, merged);
  const baseTotal = sumTeamPoints(scoredBase, team, gender);
  const baseTotalRounded = Number(baseTotal.toFixed(3));
  const baseVoids = computeCapVoids(scoredBase, team, gender, merged);
  const baseEffective = baseTotal - baseVoids.total;
  const teamRows = scoredBase.filter(
    r => String(r.team ?? '').trim() === team && (r.gender === gender || r.gender == null)
  );

  const hint = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const fastCtx =
    opts.forceFullRescore || baseVoids.total > 0
      ? null
      : buildFastSwapContext(workspace, team, gender, merged, hint);

  const rows: AddOnlyRow[] = [];
  let candidatesEvaluated = 0;

  for (const [athleteKey, bests] of bestIndex) {
    const display = displayByKey.get(athleteKey);
    if (!display) continue;

    const dropInfo = droppableByAthlete.get(athleteKey);
    const entered = dropInfo?.byEvent ?? new Map<string, DroppableEntry>();
    const openEvents = [...bests.keys()].filter(ev => !entered.has(ev));
    if (openEvents.length === 0) continue;

    // Entry caps over the CURRENT scored what-if rows (plans + results +
    // recruits + relay legs) — an at-cap swimmer gets no add suggestions.
    const counts = countSwimmerEntries(teamRows, team, gender, display);
    if (!canAcceptAnotherEntry(counts, merged, openEvents[0])) continue;

    let classYear: string | undefined;
    if (dropInfo) {
      for (const e of dropInfo.byEvent.values()) {
        if (e.classYear) {
          classYear = e.classYear;
          break;
        }
      }
    }

    for (const addEvent of openEvents) {
      const best = bests.get(addEvent)!;
      candidatesEvaluated += 1;

      const newEntry = createPlannedEntry({
        name: display,
        team,
        gender,
        classYear,
        event: addEvent,
        time: best.time,
        timeType: 'SCY',
        source: 'optimizer',
        active: true,
      });

      let newTotal = fastCtx ? fastCtx.addOnlyTotalFor(newEntry) : null;
      let newEffective: number;
      if (newTotal == null) {
        const modWs: Workspace = { ...workspace, ...entryAddPatch(workspace, newEntry).patch };
        const scoredMod = scoreWorkspaceRows(modWs, gender, merged);
        newTotal = sumTeamPoints(scoredMod, team, gender);
        newEffective = newTotal - computeCapVoids(scoredMod, team, gender, merged).total;
      } else {
        // fastCtx only exists when baseVoids.total === 0; the add is cap-gated,
        // so it cannot create a violation — effective equals engine.
        newEffective = newTotal;
      }

      const deltaPoints = Number((newEffective - baseEffective).toFixed(3));
      if (deltaPoints <= 0) continue;

      rows.push({
        athlete: display,
        addEvent,
        addTime: best.time,
        addTimeStale: best.stale ? true : undefined,
        addTimeConverted: best.converted ? true : undefined,
        classYear,
        deltaPoints,
        newTotal: Number(newTotal.toFixed(3)),
        baseTotal: baseTotalRounded,
      });
    }
  }

  rows.sort((a, b) => b.deltaPoints - a.deltaPoints);

  // Conversion confidence bands (additive tagging only, after ranking).
  let timeIndex: Map<string, EventTimeRef[]> | null = null;
  for (const r of rows) {
    if (!r.addTimeConverted) continue;
    if (!timeIndex) timeIndex = buildEventTimeIndex(workspace, gender);
    const conf = conversionConfidence(timeIndex, r.addEvent, r.athlete, convertTimeToSeconds(r.addTime));
    if (conf) r.confidence = conf;
  }

  return { pointsMeaningful: true, adds: rows, candidatesEvaluated };
}

/**
 * Pure workspace patch that enacts one {@link DropOnlyRow}: remove the entry by
 * source — the exact same drop-by-source semantics as applyExactSwap, with no
 * added entry. Same {patch, inverse, description} contract; the inverse
 * restores every touched field exactly (round-trips). No mutation, no I/O.
 */
export function applyEntryDrop(
  workspace: Workspace,
  drop: DropOnlyRow,
  opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const gender = opts.gender;
  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';
  const dropId =
    drop.dropSource === 'plan'
      ? drop.dropEntryId
      : drop.dropSource === 'result'
        ? drop.dropResultId ?? drop.dropEntryId
        : drop.dropRecruitId ?? drop.dropEntryId;
  const { patch, inverse } = entryDropPatch(workspace, drop.dropSource, dropId, field);
  const description = `${drop.athlete}: −${drop.dropEvent}${
    drop.dropTime ? ` (${drop.dropTime})` : ''
  } — dropped ${drop.dropSource} entry`;
  return { patch, inverse, description };
}

/**
 * Pure workspace patch that enacts one {@link AddOnlyRow}: append one ACTIVE
 * optimizer plan for the open event (same add semantics as applyExactSwap,
 * with no drop). Same {patch, inverse, description} contract; the inverse
 * restores every touched field exactly (round-trips). No mutation, no I/O.
 */
export function applyEntryAdd(
  workspace: Workspace,
  add: AddOnlyRow,
  opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const newEntry = createPlannedEntry({
    name: add.athlete,
    team: opts.team.trim(),
    gender: opts.gender,
    classYear: add.classYear,
    event: add.addEvent,
    time: add.addTime,
    timeType: 'SCY',
    source: 'optimizer',
    active: true,
  });
  const { patch, inverse } = entryAddPatch(workspace, newEntry);
  const description = `${add.athlete}: +${add.addEvent} (${add.addTime}) — open-slot add`;
  return { patch, inverse, description };
}

// --- combined off-thread entry point ----------------------------------------

/**
 * Single pure function returning all three analyses. Runs the cross-course table
 * and coverage gaps always; runs the expensive exact-swap enumeration only when
 * the scoring field is meaningful. Designed to run inside a Web Worker.
 */
export function computeCrossCourseArbitrage(
  workspace: Workspace,
  opts: CrossCourseArbitrageOptions
): CrossCourseArbitrageResult {
  const table = buildCrossCourseTable(workspace, {
    team: opts.team,
    gender: opts.gender,
    recencyMonths: opts.recencyMonths,
  });
  const gaps = buildCoverageGaps(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
  });
  const swapRanking = rankExactSwaps(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
    table,
    recencyMonths: opts.recencyMonths,
  });
  const dropRanking = rankDropOnly(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
  });
  const addRanking = rankAddOnly(workspace, {
    team: opts.team,
    gender: opts.gender,
    settings: opts.settings,
    table,
    recencyMonths: opts.recencyMonths,
  });
  return { table, gaps, swapRanking, dropRanking, addRanking };
}

// --- relay-leg swap enumeration ---------------------------------------------
//
// SCORING MODEL (important, drives what this surfaces):
//   The what-if engine NEVER re-ranks relays by time — a relay carries the rank
//   it was loaded with (projectRanksInField skips relays; calculatePoints scores
//   relays from their stored rank). So substituting a faster leg does NOT by
//   itself change a relay's placement points. A leg substitution changes team
//   points only through the ENGINE-NATIVE levers that a RelayLegOverride actually
//   moves: it fills a leg the projection has flagged for replacement (a
//   soft-removed/deleted holder, a senior removed, or — in roster mode — a
//   non-scorer whose leg simulateRoster vacates), and the fill flips the relay's
//   eligibility/completeness (roster all-scorer gate for non-A/B rounds, or the
//   legacy relayEligibleFromScorerPool meet-pool gate). On an all-A/B-final roster
//   field every relay is already eligible, so most legs yield a zero delta and are
//   filtered out — that is correct, not a miss.
//
// The override is scored EXACTLY like rankExactSwaps: a modified-workspace clone
// re-scored through buildWhatIfResults + calculatePoints (full re-score baseline;
// relay-leg counts are small so worst-case runtime stays modest — see the test's
// timing line). No incremental fast path: the override couples events through the
// meet-wide relay/pool state in ways that are not cheaply localizable, and
// correctness dominates here.
//
// CLOCK HOLD: the override sets manualLegTime to the departed leg's own split so
// the relay's team clock is unchanged by the substitution. Relay points depend on
// placement, not time, so this loses no accuracy — and it is REQUIRED: a changed
// clock makes simulateRoster re-emit the original (unmodified) leg rows under a
// new relayGroupKey, which cancels the eligibility gain in the full re-score. The
// incoming swimmer's real projected leg time is carried separately on `inTime`.

/** Best flat time an athlete owns at a relay-leg (distance, stroke), SCY-converted. */
type RelayLegTimeRef = CrossCourseTimeRef & {
  /** True when the best came from a converted LCM/SCM swim (not swum SCY). */
  converted?: boolean;
};

export type RelayLegSwap = {
  /** relayEntryKey of the target relay entry (team|event|round|rank|clock). */
  relayEntryKey: string;
  /** Relay event label as loaded (e.g. "200 Yard Medley Relay"). */
  relayEvent: string;
  /** Relay placement (which entry — 1 = fastest/A). */
  relayRank: number;
  roundSwam?: string;
  /** 0-based leg index. */
  legIndex: number;
  /** Stroke this leg swims (medley legs by index; free relays are all `free`). */
  stroke: RelayLegStroke;
  legDistanceYards: number;
  /** Current leg holder being replaced (may already be vacated/departed). */
  outAthlete: string;
  /** Outgoing leg split/time, when known. */
  outTime?: string;
  inAthlete: string;
  /** Incoming swimmer's projected leg time (SCY, cross-course best) — for display. */
  inTime: string;
  /** True when inTime came from a converted LCM/SCM swim. */
  inTimeConverted?: boolean;
  /** True when inTime is older than the recency window (only stale times existed). */
  inTimeStale?: boolean;
  /**
   * manualLegTime the override carries so the relay team clock is held constant
   * (the departed leg's split). Points are placement-based; holding the clock
   * keeps the delta free of simulateRoster's leg re-add artifact. Undefined when
   * the leg has no prior split to hold (the substitution then leaves the clock
   * unchanged on its own).
   */
  clockLegTime?: string;
  deltaPoints: number;
  newTotal: number;
  baseTotal: number;
};

export type RelayLegSwapRanking = {
  pointsMeaningful: boolean;
  reason?: string;
  swaps: RelayLegSwap[];
  /** Number of (relay x leg x candidate) combinations re-scored. */
  candidatesEvaluated: number;
};

export type RelayLegSwapOptions = {
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  recencyMonths?: number;
};

/** Parse an individual event label to its (distance yards, relay-leg stroke), or null. */
function individualStrokeDistance(
  event: string
): { dist: number; stroke: RelayLegStroke } | null {
  const lower = event.toLowerCase();
  if (/\brelay\b/.test(lower) || /\bim\b|individual medley|medley/.test(lower)) return null;
  const m = lower.match(/(\d{2,4})/);
  if (!m) return null;
  const dist = parseInt(m[1], 10);
  let stroke: RelayLegStroke | null = null;
  if (/back/.test(lower)) stroke = 'back';
  else if (/breast/.test(lower)) stroke = 'breast';
  else if (/butterfly|\bfly\b/.test(lower)) stroke = 'fly';
  else if (/free/.test(lower)) stroke = 'free';
  if (!stroke) return null;
  return { dist, stroke };
}

/** Per athlete → `${legDistanceYards}|${stroke}` → best SCY-converted leg time (recency-weighted). */
function buildRelayLegTimeIndex(
  workspace: Workspace,
  opts: { team: string; gender: Gender; recencyMonths?: number }
): Map<string, Map<string, RelayLegTimeRef>> {
  const team = opts.team.trim();
  const allHistory = workspace.athleteHistory ?? [];
  const history = allHistory.filter(
    s => s.gender === opts.gender && String(s.team ?? '').trim() === team
  );
  const recencyMonths = opts.recencyMonths ?? DEFAULT_RECENCY_MONTHS;
  const anchorMs = newestHistoryDateMs(allHistory);
  const cutoffMs = anchorMs == null ? null : recencyCutoffMs(anchorMs, recencyMonths);

  // athlete → legKey → all candidate refs
  const buckets = new Map<string, Map<string, RelayLegTimeRef[]>>();
  for (const s of history) {
    if (/\brelay\b/i.test(s.event)) continue;
    const timeType = s.timeType ?? 'SCY';
    const converted = convertSwimToSCY(s.event, s.time, s.gender, timeType);
    const sd = individualStrokeDistance(converted.event);
    if (!sd) continue;
    const timeSec = convertTimeToSeconds(converted.time);
    if (!Number.isFinite(timeSec)) continue;
    const nameKey = normalizeSwimmerName(s.name);
    const legKey = `${sd.dist}|${sd.stroke}`;
    let m = buckets.get(nameKey);
    if (!m) {
      m = new Map();
      buckets.set(nameKey, m);
    }
    let arr = m.get(legKey);
    if (!arr) {
      arr = [];
      m.set(legKey, arr);
    }
    arr.push({
      time: converted.time,
      timeSec,
      meetLabel: s.meetLabel,
      date: s.date,
      converted: timeType !== 'SCY',
    });
  }

  const out = new Map<string, Map<string, RelayLegTimeRef>>();
  for (const [nameKey, legs] of buckets) {
    const chosen = new Map<string, RelayLegTimeRef>();
    for (const [legKey, refs] of legs) {
      const best = pickRecencyBest(refs, cutoffMs);
      if (best) chosen.set(legKey, best);
    }
    out.set(nameKey, chosen);
  }
  return out;
}

/** One team relay entry (its template row + ordered leg names). */
type RelayEntry = {
  template: SwimmerResult;
  entryKey: string;
  legNames: string[];
  legRows: SwimmerResult[];
};

/** Distinct team relay entries for a gender, deduped by relayEntryKey. */
function collectTeamRelayEntries(
  results: SwimmerResult[],
  team: string,
  gender: Gender
): RelayEntry[] {
  const seen = new Set<string>();
  const entries: RelayEntry[] = [];
  for (const r of results) {
    if (!isRelayResult(r)) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    if (r.gender != null && r.gender !== gender) continue;
    const template = relayTemplateFromLeg(results, r);
    const entryKey = relayEntryKey(template);
    if (seen.has(entryKey)) continue;
    seen.add(entryKey);
    const legRows = results
      .filter(
        x =>
          x.isRelay &&
          String(x.team ?? '').trim() === team &&
          x.event === template.event &&
          x.rank === template.rank &&
          (x.roundSwam || '').trim() === (template.roundSwam || '').trim()
      )
      .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
    const legNames =
      template.relayNames && template.relayNames.length > 0
        ? template.relayNames.map(n => n.name)
        : legRows.map(x => x.name);
    entries.push({ template, entryKey, legNames, legRows });
  }
  return entries;
}

/** Individuals (results + recruits) an override could actually resolve onto a leg. */
function resolvableLegPool(workspace: Workspace, team: string, gender: Gender): SwimmerResult[] {
  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const pool: SwimmerResult[] = [];
  for (const r of results) {
    if (r.isRelay) continue;
    if (r.gender != null && r.gender !== gender) continue;
    if (String(r.team ?? '').trim() !== team) continue;
    pool.push(r);
  }
  for (const rec of workspace.recruits ?? []) {
    if (rec.gender !== gender) continue;
    if (String(rec.team ?? '').trim() !== team) continue;
    pool.push({
      id: rec.id,
      rank: 0,
      name: rec.name,
      classYear: rec.classYear ?? 'UNKNOWN',
      team: rec.team,
      time: rec.time,
      points: 0,
      event: rec.event,
      gender: rec.gender,
      isRecruit: true,
    });
  }
  return pool;
}

/**
 * Exact team-points delta of substituting a rostered athlete onto each relay leg.
 * For every distinct team relay entry × leg × eligible candidate, attach a
 * RelayLegOverride and full re-score through buildWhatIfResults + calculatePoints
 * (same pipeline as rankExactSwaps). Only positive deltas, de-duped per
 * (relayEntryKey, legIndex, inAthlete), sorted descending.
 *
 * Candidates are drawn from the team's individuals (result/recruit rows) that
 * stroke- and distance-match the leg (medley legs by index; free relays use free)
 * — the pool a RelayLegOverride can actually resolve a name onto — enriched with
 * the athlete's SCY-converted cross-course best for the leg (converted/stale
 * flags reused from the recency machinery). Eligibility mirrors what the scorer
 * enforces today: roster-mode candidates must be scorers, and a candidate at the
 * per-swimmer relay-entry cap is skipped.
 */
export function rankRelayLegSwaps(
  workspace: Workspace,
  opts: RelayLegSwapOptions
): RelayLegSwapRanking {
  const team = opts.team.trim();
  const gender = opts.gender;
  const merged = mergeScoringSettings(opts.settings ?? workspace.scoringSettings, {
    conference: workspace.conference,
  });

  const results = gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const relayEntries = collectTeamRelayEntries(results, team, gender);
  if (relayEntries.length === 0) {
    return {
      pointsMeaningful: false,
      reason: `No ${gender === Gender.MEN ? "men's" : "women's"} relay entries for ${team || 'this team'} to substitute legs on.`,
      swaps: [],
      candidatesEvaluated: 0,
    };
  }

  const legTimeIndex = buildRelayLegTimeIndex(workspace, {
    team,
    gender,
    recencyMonths: opts.recencyMonths,
  });
  const pool = resolvableLegPool(workspace, team, gender);

  const rosterMode = usesScorerRoster(merged);
  const rosterLookup: ScorerRosterLookup | null = rosterMode
    ? buildScorerRosterLookup(results, merged, workspace.scorerRosterOverrides ?? [], gender)
    : null;
  const relayCap = merged.maxRelayEntriesPerSwimmer ?? 999;

  // A substitution only moves points on a leg the projection flags for replacement
  // (a non-scorer whose leg simulateRoster vacates, or a soft-removed holder); an
  // override on a healthy leg is a scorer no-op → guaranteed zero delta. Skip those
  // legs wholesale rather than re-score every candidate against them.
  const vacateNames = computeVacateRelayLegNames(
    results,
    gender,
    merged,
    workspace.scorerRosterOverrides ?? []
  );
  const deletedNames = new Set(
    (workspace.deletedSwimmers ?? [])
      .filter(d => d.gender === gender)
      .map(d => normalizeSwimmerName(d.name))
  );
  const legIsReplaceable = (name: string): boolean => {
    const k = normalizeSwimmerName(name);
    return vacateNames.has(k) || deletedNames.has(k);
  };

  const baseTotal = teamTotal(workspace, gender, team, merged);
  const baseTotalRounded = Number(baseTotal.toFixed(3));

  const baseOverrides = workspace.relayLegOverrides ?? [];
  const bestByKey = new Map<string, RelayLegSwap>();
  let candidatesEvaluated = 0;

  for (const entry of relayEntries) {
    const evLower = entry.template.event.toLowerCase();
    const legDistYards = relayLegDistanceYards(parseRelayDistanceYards(entry.template.event));
    const onRelay = new Set(entry.legNames.filter(Boolean).map(n => normalizeSwimmerName(n)));

    for (let legIndex = 0; legIndex < entry.legNames.length; legIndex++) {
      const stroke = relayStrokeForIndex(evLower, legIndex);
      const outAthlete = entry.legNames[legIndex] ?? '';
      const outKey = normalizeSwimmerName(outAthlete);
      // Only a replaceable leg can gain points; healthy scorer legs are no-ops.
      if (!legIsReplaceable(outAthlete)) continue;
      const legRow = entry.legRows.find(r => (r.relayLegIndex ?? -1) === legIndex);
      const outTime = legRow ? displayTimeForRelayLeg(legRow) : undefined;
      const legKey = `${legDistYards}|${stroke}`;

      // Clock-hold time: the value simulateRoster would treat as this leg's prior
      // split, so a substitution leaves the team clock unchanged (see CLOCK HOLD).
      // Mirrors simulateRoster: the departed swimmer's own matching individual time
      // when it exists (and is finite), else the leg's recorded split.
      const req = relayLegRequirements(entry.template.event, legIndex);
      const departedIndiv = results.find(
        s =>
          !s.isRelay &&
          s.name === outAthlete &&
          eventMatchesStrokeDistance(s.event, req.legDistanceYards, req.keywords)
      );
      const departedSec = departedIndiv ? convertTimeToSeconds(departedIndiv.time) : NaN;
      const rawSplit = legRow?.relayLegSplit;
      const clockLegTime =
        departedIndiv && Number.isFinite(departedSec)
          ? departedIndiv.time
          : rawSplit && rawSplit !== 'NT'
            ? rawSplit
            : undefined;

      // Candidates: stroke/distance-matching individuals not already on this relay.
      for (const cand of pool) {
        const candKey = normalizeSwimmerName(cand.name);
        if (candKey === outKey) continue;
        if (onRelay.has(candKey)) continue;
        if (!swimmerMatchesRelayLeg(cand, entry.template.event, legIndex)) continue;
        if (rosterLookup && !rosterLookup.isScorer(cand.name, team, gender)) continue;
        if (relayCap < 999) {
          const counts = countSwimmerEntries(results, team, gender, cand.name);
          if (counts.relayCount >= relayCap) continue;
        }

        candidatesEvaluated += 1;

        const bestRef = legTimeIndex.get(candKey)?.get(legKey);
        const inTime = bestRef?.time ?? cand.time;

        const override: RelayLegOverride = {
          relayEntryKey: entry.entryKey,
          legIndex,
          assigneeName: cand.name,
          classYear: cand.classYear,
          ...(clockLegTime ? { manualLegTime: clockLegTime } : {}),
          source: 'manual',
        };
        const modWs: Workspace = {
          ...workspace,
          relayLegOverrides: upsertRelayLegOverride(baseOverrides, override),
        };
        const newTotal = teamTotal(modWs, gender, team, merged);
        const deltaPoints = Number((newTotal - baseTotal).toFixed(3));
        if (deltaPoints <= 0) continue;

        const dedupKey = `${entry.entryKey}|${legIndex}|${candKey}`;
        const swap: RelayLegSwap = {
          relayEntryKey: entry.entryKey,
          relayEvent: entry.template.event,
          relayRank: Number(entry.template.rank) || 0,
          roundSwam: entry.template.roundSwam,
          legIndex,
          stroke,
          legDistanceYards: legDistYards,
          outAthlete,
          outTime,
          inAthlete: cand.name,
          inTime,
          inTimeConverted: bestRef?.converted ? true : undefined,
          inTimeStale: bestRef?.stale ? true : undefined,
          clockLegTime,
          deltaPoints,
          newTotal: Number(newTotal.toFixed(3)),
          baseTotal: baseTotalRounded,
        };
        const prior = bestByKey.get(dedupKey);
        if (!prior || swap.deltaPoints > prior.deltaPoints) bestByKey.set(dedupKey, swap);
      }
    }
  }

  const swaps = [...bestByKey.values()].sort((a, b) => b.deltaPoints - a.deltaPoints);
  return { pointsMeaningful: true, swaps, candidatesEvaluated };
}

/**
 * Pure workspace patch that enacts one {@link RelayLegSwap}: upsert a
 * RelayLegOverride assigning the incoming swimmer to the target relay leg,
 * replacing any prior override for that (relayEntryKey, legIndex). The override
 * carries the swap's `clockLegTime` as manualLegTime so re-scoring reproduces the
 * ranking's newTotal exactly (the clock-hold that keeps the point delta free of
 * simulateRoster's leg re-add artifact — see CLOCK HOLD above). Same patch/inverse
 * contract as applyExactSwap — the inverse restores the full prior
 * relayLegOverrides array (exact round-trip). No mutation, no I/O.
 */
export function applyRelayLegSwap(
  workspace: Workspace,
  swap: RelayLegSwap,
  _opts: { team: string; gender: Gender }
): { patch: Partial<Workspace>; inverse: Partial<Workspace>; description: string } {
  const baseOverrides = workspace.relayLegOverrides ?? [];
  const override: RelayLegOverride = {
    relayEntryKey: swap.relayEntryKey,
    legIndex: swap.legIndex,
    assigneeName: swap.inAthlete,
    ...(swap.clockLegTime ? { manualLegTime: swap.clockLegTime } : {}),
    source: 'manual',
  };
  const patch: Partial<Workspace> = {
    relayLegOverrides: upsertRelayLegOverride(baseOverrides, override),
  };
  const inverse: Partial<Workspace> = { relayLegOverrides: baseOverrides };
  const outLabel = swap.outAthlete && swap.outAthlete !== '—' ? swap.outAthlete : 'vacant leg';
  const description = `${swap.relayEvent} leg ${swap.legIndex + 1} (${swap.stroke}): +${swap.inAthlete} (${swap.inTime}), −${outLabel}`;
  return { patch, inverse, description };
}
