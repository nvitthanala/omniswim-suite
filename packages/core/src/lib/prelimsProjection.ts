/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Placement-based prelims over/under: each swimmer's expected points from their
 * prelims placement (scored as if finals) vs actual baseline finals points.
 */
import { Gender, ScoringSettings, SwimmerResult, Workspace } from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import type { ScoringBundle } from './scoringEngine';
import { buildProjectedScoringBundle, gatherBaselineScoredByEntry } from './scoringBundleAggregation';
import {
  classifyRoundTier,
  convertTimeToSeconds,
  eventScoringStage,
  formatEventChartAxisLabel,
  isFinalsRound,
  isPrelimsFinalsEvent,
  isRelayResult,
  isScoringSwimTime,
  looksLikeInstitutionTeamName,
  normalizeSwimmerName,
  parseRankInt,
  pointsForPlacement,
  sortEventsByMeetOrder,
  stripEventGenderMarker,
} from './utils';

/** Valid prelims clock for a swim row. */
export function prelimsClock(
  r: Pick<SwimmerResult, 'roundSwam' | 'time' | 'prelimsTime' | 'relayTeamTime' | 'isRelay'>
): string {
  if (isRelayResult(r as SwimmerResult)) {
    if (classifyRoundTier(r.roundSwam) === 'PRE') {
      const clock = String(r.prelimsTime ?? r.time ?? r.relayTeamTime ?? '').trim();
      if (clock && isScoringSwimTime(clock)) return clock;
      return '';
    }
    // Timed-final / finals relay rows: never treat team finals clock as a prelims seed
    if (r.prelimsTime && isScoringSwimTime(r.prelimsTime)) return r.prelimsTime.trim();
    return '';
  }
  if (r.prelimsTime && isScoringSwimTime(r.prelimsTime)) return r.prelimsTime.trim();
  if (classifyRoundTier(r.roundSwam) === 'PRE') {
    return String(r.time ?? '').trim();
  }
  return '';
}

export function hasPrelimsData(results: SwimmerResult[]): boolean {
  return results.some(r => {
    const clock = prelimsClock(r);
    return clock !== '' && isScoringSwimTime(clock);
  });
}

export function entryKey(r: SwimmerResult): string {
  const ev = String(r.event ?? '').trim();
  const team = String(r.team ?? 'Unknown').trim() || 'Unknown';
  if (isRelayResult(r)) return `${ev}|${team}|relay`;
  return `${ev}|${team}|${normalizeSwimmerName(r.name)}`;
}

function isRelayTeamRow(r: SwimmerResult): boolean {
  if (!isRelayResult(r)) return true;
  const tName = String(r.name ?? '').trim().toLowerCase();
  const tTeam = String(r.team ?? '').trim().toLowerCase();
  return Boolean(tName && tTeam === tName && looksLikeInstitutionTeamName(r.team));
}

function isTimeTrialEvent(event: string, rows: SwimmerResult[]): boolean {
  if (/\bTIME TRIAL\b/i.test(event)) return true;
  return rows.some(r => r.isTimeTrial);
}

/** Events with prelims + A/B finals — excludes timed-finals relays, distance, etc. */
export function isPrelimsOuEligibleEvent(event: string, rows: SwimmerResult[]): boolean {
  if (!event || isTimeTrialEvent(event, rows)) return false;
  return isPrelimsFinalsEvent(rows);
}

export { eventScoringStage };

/** Map prelims seed rank to A/B final round + in-heat rank for point lookup. */
export function roundAndRankForPrelimsSeed(
  prelimsRank: number,
  bracketSize: number
): { roundSwam: string; rank: number } {
  if (prelimsRank <= 0) return { roundSwam: 'Preliminaries', rank: prelimsRank };
  if (prelimsRank <= bracketSize) {
    return { roundSwam: 'A Final', rank: prelimsRank };
  }
  if (prelimsRank <= bracketSize * 2) {
    return { roundSwam: 'B Final', rank: prelimsRank - bracketSize };
  }
  return { roundSwam: 'Preliminaries', rank: prelimsRank };
}

/** Points a swimmer would earn if their prelims placement were their finals result. */
export function pointsForPrelimsSeedRank(
  prelimsRank: number,
  event: string,
  settings: ScoringSettings
): number {
  const bracket = settings.aFinalBracketSize ?? Math.floor(settings.scoringPoints.length / 2);
  const { roundSwam, rank } = roundAndRankForPrelimsSeed(prelimsRank, bracket);
  return pointsForPlacement(roundSwam, rank, event, settings);
}

type EntryRows = { key: string; rows: SwimmerResult[] };

function gatherEligibleEntries(eventRows: SwimmerResult[]): EntryRows[] {
  const byKey = new Map<string, SwimmerResult[]>();
  for (const r of eventRows) {
    if (r.isExhibition || r.isTimeTrial) continue;
    const clock = prelimsClock(r);
    if (!clock || !isScoringSwimTime(clock)) continue;
    const key = entryKey(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  return [...byKey.entries()].map(([key, rows]) => ({ key, rows }));
}

/**
 * Prelims rank per entry: PDF prelims-row rank when present, else field order by prelims time.
 */
export function resolvePrelimsRanksForEvent(
  eventRows: SwimmerResult[]
): Map<string, number> {
  const entries = gatherEligibleEntries(eventRows);
  const ranks = new Map<string, number>();

  for (const { key, rows } of entries) {
    const prelimsRow = rows.find(r => classifyRoundTier(r.roundSwam) === 'PRE');
    const pdfRank = prelimsRow ? parseRankInt(prelimsRow.rank) : null;
    if (pdfRank != null && pdfRank > 0) {
      ranks.set(key, pdfRank);
    }
  }

  const timeSorted = [...entries].sort((a, b) => {
    const clockA = prelimsClock(
      a.rows.find(r => classifyRoundTier(r.roundSwam) === 'PRE') ?? a.rows[0]
    );
    const clockB = prelimsClock(
      b.rows.find(r => classifyRoundTier(r.roundSwam) === 'PRE') ?? b.rows[0]
    );
    return convertTimeToSeconds(clockA) - convertTimeToSeconds(clockB);
  });

  timeSorted.forEach(({ key }, index) => {
    if (!ranks.has(key)) {
      ranks.set(key, index + 1);
    }
  });

  return ranks;
}

function pickRepresentativeRow(rows: SwimmerResult[]): SwimmerResult {
  const finals = rows.find(r => isFinalsRound(r.roundSwam));
  if (finals) return finals;
  const prelims = rows.find(r => classifyRoundTier(r.roundSwam) === 'PRE');
  return prelims ?? rows[0];
}

/** Build synthetic scored rows: one per entry with points = prelims-placement expected. */
export function buildPrelimsExpectedRows(
  results: SwimmerResult[],
  settings: ScoringSettings
): SwimmerResult[] {
  const byEvent = new Map<string, SwimmerResult[]>();
  for (const r of results) {
    const ev = String(r.event ?? '').trim();
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev)!.push(r);
  }

  const out: SwimmerResult[] = [];

  for (const [event, eventRows] of byEvent) {
    if (!isPrelimsOuEligibleEvent(event, eventRows)) continue;

    const prelimsRanks = resolvePrelimsRanksForEvent(eventRows);
    const entries = gatherEligibleEntries(eventRows);

    for (const { key, rows } of entries) {
      const prelimsRank = prelimsRanks.get(key);
      if (prelimsRank == null || prelimsRank < 1) continue;

      const expected = pointsForPrelimsSeedRank(prelimsRank, event, settings);
      const rep = pickRepresentativeRow(rows);
      const bracket = settings.aFinalBracketSize ?? Math.floor(settings.scoringPoints.length / 2);
      const seedRound = roundAndRankForPrelimsSeed(prelimsRank, bracket);

      out.push({
        ...rep,
        id: `prelim-expected-${rep.id}`,
        rank: seedRound.rank,
        roundSwam: seedRound.roundSwam,
        points: expected,
        pdfPoints: undefined,
      });
    }
  }

  return out;
}

export type PrelimsOverUnderEntry = {
  expected: number;
  actual: number;
  overUnder: number;
};

function isRelayAggregateRow(r: SwimmerResult): boolean {
  if (!isRelayResult(r)) return false;
  const tName = String(r.name ?? '').trim().toLowerCase();
  const tTeam = String(r.team ?? '').trim().toLowerCase();
  return Boolean(tName && tTeam === tName);
}

/** Baseline credited points for one entry — never double-count relay aggregate row + leg shares. */
function baselineActualPointsForEntry(rows: SwimmerResult[], key: string): number {
  const isRelayEntry = key.endsWith('|relay');
  if (isRelayEntry) {
    const aggregateRow = rows.find(r => isRelayAggregateRow(r));
    if (aggregateRow) {
      const aggregatePts = typeof aggregateRow.points === 'number' ? aggregateRow.points : 0;
      if (aggregatePts > 0) return aggregatePts;
    }
    return rows
      .filter(r => isRelayResult(r) && !isRelayAggregateRow(r))
      .reduce((sum, r) => sum + (typeof r.points === 'number' ? r.points : 0), 0);
  }
  return rows.reduce((sum, r) => sum + (typeof r.points === 'number' ? r.points : 0), 0);
}

/** Per entry (event+team+swimmer/relay): actual baseline pts vs prelims-placement expected. */
export function buildPrelimsOverUnderByEntryKey(
  baselineScored: SwimmerResult[],
  prelimsExpected: SwimmerResult[]
): Map<string, PrelimsOverUnderEntry> {
  const expectedByKey = new Map<string, number>();
  for (const r of prelimsExpected) {
    const key = entryKey(r);
    const pts = typeof r.points === 'number' ? r.points : 0;
    // One expected value per entry — never sum duplicate rows for the same key.
    const prev = expectedByKey.get(key);
    if (prev == null || pts > prev) expectedByKey.set(key, pts);
  }

  const actualByKey = new Map<string, number>();
  for (const [key, rows] of gatherBaselineScoredByEntry(baselineScored, entryKey)) {
    actualByKey.set(key, baselineActualPointsForEntry(rows, key));
  }

  const out = new Map<string, PrelimsOverUnderEntry>();
  // Only entries with a prelims-placement anchor — skip timed-finals (actual but no expected).
  for (const [key, expected] of expectedByKey) {
    if (expected <= 0) continue;
    const actual = actualByKey.get(key) ?? 0;
    out.set(key, { expected, actual, overUnder: actual - expected });
  }
  return out;
}

/** O/U for a scored row; relay legs omitted (team relay row only). */
export function prelimsOuForResult(
  r: SwimmerResult,
  lookup: Map<string, PrelimsOverUnderEntry>
): PrelimsOverUnderEntry | undefined {
  if (isRelayResult(r) && !isRelayTeamRow(r)) return undefined;
  return lookup.get(entryKey(r));
}

/**
 * Display-only O/U beside credited meet points on a row.
 * Uses the row's credited points (individual or relay leg share), not aggregated lookup actual,
 * so prelims baseline never replaces or inflates actual + relay credit scores.
 */
export function prelimsOuOverUnderForDisplay(
  r: SwimmerResult,
  lookup: Map<string, PrelimsOverUnderEntry>
): number | undefined {
  if (isRelayResult(r) && !isRelayTeamRow(r)) return undefined;
  const entry = lookup.get(entryKey(r));
  if (!entry) return undefined;
  const credited = typeof r.points === 'number' ? r.points : 0;
  if (credited > 0) return credited - entry.expected;
  return entry.overUnder;
}

/** Sum O/U for a list of rows — one entry key counted once (prelims+finals rows deduped). */
export function sumPrelimsOuForSwimmers(
  swimmers: SwimmerResult[],
  lookup: Map<string, PrelimsOverUnderEntry>,
  options?: { includeRelay?: boolean }
): number {
  const includeRelay = options?.includeRelay ?? true;
  let total = 0;
  const seen = new Set<string>();
  for (const res of swimmers) {
    if (isRelayResult(res)) {
      if (!includeRelay) continue;
      if (!isRelayTeamRow(res)) continue;
    }
    const key = entryKey(res);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = lookup.get(key);
    if (entry) total += entry.overUnder;
  }
  return total;
}

/** Team meet O/U from lookup (authoritative deduped total). */
export function sumPrelimsOuForTeam(
  teamName: string,
  lookup: Map<string, PrelimsOverUnderEntry>
): number {
  const teamNorm = teamName.trim();
  let total = 0;
  for (const [key, entry] of lookup) {
    const parts = key.split('|');
    if ((parts[1] ?? '').trim() === teamNorm) total += entry.overUnder;
  }
  return total;
}

export type MomentumSeriesPoint = {
  rawEvent: string;
  label: string;
  delta: number;
  cumulative: number;
};

/** Per-event momentum (O/U) for one team — one delta per entry key, chronological cumulative. */
export function buildMomentumSeriesForTeam(
  teamName: string,
  lookup: Map<string, PrelimsOverUnderEntry>,
  eventsList?: string[]
): MomentumSeriesPoint[] {
  const teamNorm = teamName.trim();
  const eventDelta = new Map<string, number>();

  for (const [key, entry] of lookup) {
    const parts = key.split('|');
    if ((parts[1] ?? '').trim() !== teamNorm) continue;
    const ev = parts[0] ?? '';
    if (!ev) continue;
    eventDelta.set(ev, (eventDelta.get(ev) ?? 0) + entry.overUnder);
  }

  let events = [...eventDelta.keys()];
  if (eventsList && eventsList.length > 0) {
    events.sort((a, b) => {
      const ia = eventsList.indexOf(a);
      const ib = eventsList.indexOf(b);
      return (ia < 0 ? 99999 : ia) - (ib < 0 ? 99999 : ib);
    });
  } else {
    events = sortEventsByMeetOrder(events);
  }

  let cumulative = 0;
  return events.map(rawEvent => {
    const delta = eventDelta.get(rawEvent) ?? 0;
    cumulative += delta;
    return {
      rawEvent,
      label: formatEventChartAxisLabel(rawEvent, { maxLength: 20 }),
      delta,
      cumulative,
    };
  });
}

/** Chart rows for meet-level momentum (cumulative O/U per team by event). */
export function buildMeetMomentumChartDataFromLookup(
  teamNames: string[],
  lookup: Map<string, PrelimsOverUnderEntry>,
  eventsList: string[]
): Record<string, unknown>[] {
  const seriesByTeam = new Map(
    teamNames.map(team => [team, buildMomentumSeriesForTeam(team, lookup, eventsList)])
  );
  const carryForward: Record<string, number> = Object.fromEntries(teamNames.map(t => [t, 0]));

  const orderedEvents = eventsList.filter(ev => !/\bTIME TRIAL\b/i.test(ev));
  return orderedEvents.map(rawEvent => {
    const row: Record<string, unknown> = {
      name: formatEventChartAxisLabel(rawEvent, { maxLength: 24 }),
      fullEvent: stripEventGenderMarker(rawEvent),
    };
    for (const team of teamNames) {
      const pt = (seriesByTeam.get(team) ?? []).find(p => p.rawEvent === rawEvent);
      const cumulative = pt?.cumulative ?? carryForward[team] ?? 0;
      carryForward[team] = cumulative;
      row[team] = cumulative;
    }
    return row;
  });
}

/** @deprecated Prefer buildMeetMomentumChartDataFromLookup — index-aligned delta timeline can skew charts. */
export function buildMeetMomentumChartData(
  prelimsDeltaTimeline: PrelimsDeltaTimelinePoint[],
  teamNames: string[]
): Record<string, unknown>[] {
  return prelimsDeltaTimeline.map(pt => {
    const row: Record<string, unknown> = {
      name: pt.name,
      fullEvent: pt.fullEvent,
    };
    for (const team of teamNames) {
      row[team] = pt.baselineDelta[team] ?? 0;
    }
    return row;
  });
}


export type PrelimsProjectedOptions = {
  workspace: Workspace;
  gender: Gender;
};

/** Build prelims-placement expected scoring bundle from raw loaded meet data. */
export function buildPrelimsProjectedBundle({
  workspace,
  gender,
}: PrelimsProjectedOptions): ScoringBundle {
  const menResults = workspace.menResults ?? [];
  const womenResults = workspace.womenResults ?? [];
  const currentResults = gender === Gender.MEN ? menResults : womenResults;
  const pdfHint = [...menResults, ...womenResults];

  const scoringSettings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
    resultsForPdfHint: pdfHint,
  });

  if (!hasPrelimsData(currentResults)) {
    return {
      allResults: [],
      allScored: [],
      events: [],
      visibleEvents: [],
      sortedTeams: [],
      timelineData: [],
      teamStyleSignature: '',
    };
  }

  const expectedRows = buildPrelimsExpectedRows(currentResults, scoringSettings);
  return buildProjectedScoringBundle(expectedRows, expectedRows);
}

export type PrelimsDeltaTimelinePoint = {
  name: string;
  fullEvent?: string;
  baselineDelta: Record<string, number>;
  projectedDelta: Record<string, number>;
};

/** Merge baseline/projected timelines with prelims timeline for per-event over/under. */
function timelineEventKey(pt: Record<string, unknown>): string {
  return String(pt.fullEvent ?? pt.name ?? '').trim();
}

function indexTimelineByEvent(timeline: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const pt of timeline) {
    const key = timelineEventKey(pt);
    if (key) map.set(key, pt);
  }
  return map;
}

/** Every event across the three timelines, first-seen order (baseline, then prelims, then projected). */
function buildPrelimsTimelineEventOrder(
  baselineTimeline: Record<string, unknown>[],
  prelimsTimeline: Record<string, unknown>[],
  projectedTimeline: Record<string, unknown>[]
): string[] {
  const eventOrder: string[] = [];
  const seen = new Set<string>();
  for (const timeline of [baselineTimeline, prelimsTimeline, projectedTimeline]) {
    for (const pt of timeline) {
      const key = timelineEventKey(pt);
      if (key && !seen.has(key)) {
        seen.add(key);
        eventOrder.push(key);
      }
    }
  }
  return eventOrder;
}

/**
 * Teams to compute a delta for at this event: every team key any of the three
 * timeline points carries here, plus every team a PRIOR event already carried
 * (`lastBase`/`lastPrelim`/`lastProj` so a team stops applying to fewer teams
 * as the timeline goes on, once it has ever appeared).
 */
function timelineTeamsAtEvent(
  points: (Record<string, unknown> | undefined)[],
  lastBase: Record<string, number>,
  lastPrelim: Record<string, number>,
  lastProj: Record<string, number>
): Set<string> {
  const teams = new Set<string>();
  for (const pt of points) {
    if (!pt) continue;
    for (const k of Object.keys(pt)) {
      if (k !== 'name' && k !== 'fullEvent') teams.add(k);
    }
  }
  for (const k of Object.keys(lastBase)) teams.add(k);
  for (const k of Object.keys(lastPrelim)) teams.add(k);
  for (const k of Object.keys(lastProj)) teams.add(k);
  return teams;
}

/**
 * Per-team baseline/projected deltas against the prelims anchor for one event.
 * Mutates `lastBase`/`lastPrelim`/`lastProj` (carry-forward running totals) —
 * same running-total contract `buildPrelimsDeltaTimeline`'s loop always had.
 */
function computeTimelineDeltasForEvent(
  basePt: Record<string, unknown> | undefined,
  projPt: Record<string, unknown> | undefined,
  prelimPt: Record<string, unknown> | undefined,
  lastBase: Record<string, number>,
  lastPrelim: Record<string, number>,
  lastProj: Record<string, number>
): { baselineDelta: Record<string, number>; projectedDelta: Record<string, number> } {
  const teams = timelineTeamsAtEvent([basePt, projPt, prelimPt], lastBase, lastPrelim, lastProj);
  const baselineDelta: Record<string, number> = {};
  const projectedDelta: Record<string, number> = {};
  for (const team of teams) {
    if (basePt && typeof basePt[team] === 'number') lastBase[team] = basePt[team] as number;
    if (projPt && typeof projPt[team] === 'number') lastProj[team] = projPt[team] as number;
    if (prelimPt && typeof prelimPt[team] === 'number') lastPrelim[team] = prelimPt[team] as number;

    baselineDelta[team] = (lastBase[team] ?? 0) - (lastPrelim[team] ?? 0);
    projectedDelta[team] = (lastProj[team] ?? 0) - (lastPrelim[team] ?? 0);
  }
  return { baselineDelta, projectedDelta };
}

export function buildPrelimsDeltaTimeline(
  baselineTimeline: Record<string, unknown>[],
  projectedTimeline: Record<string, unknown>[],
  prelimsTimeline: Record<string, unknown>[]
): PrelimsDeltaTimelinePoint[] {
  const baselineByEvent = indexTimelineByEvent(baselineTimeline);
  const projectedByEvent = indexTimelineByEvent(projectedTimeline);
  const prelimsByEvent = indexTimelineByEvent(prelimsTimeline);

  const eventOrder = buildPrelimsTimelineEventOrder(baselineTimeline, prelimsTimeline, projectedTimeline);

  const lastBase: Record<string, number> = {};
  const lastProj: Record<string, number> = {};
  const lastPrelim: Record<string, number> = {};
  const out: PrelimsDeltaTimelinePoint[] = [];

  for (const eventKey of eventOrder) {
    const basePt = baselineByEvent.get(eventKey);
    const projPt = projectedByEvent.get(eventKey);
    const prelimPt = prelimsByEvent.get(eventKey);

    const { baselineDelta, projectedDelta } = computeTimelineDeltasForEvent(
      basePt,
      projPt,
      prelimPt,
      lastBase,
      lastPrelim,
      lastProj
    );

    out.push({
      name: String(basePt?.name ?? prelimPt?.name ?? projPt?.name ?? eventKey),
      fullEvent: (basePt?.fullEvent ?? prelimPt?.fullEvent ?? projPt?.fullEvent ?? eventKey) as
        | string
        | undefined,
      baselineDelta,
      projectedDelta,
    });
  }

  return out;
}
