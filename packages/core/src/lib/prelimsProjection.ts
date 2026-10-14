/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Placement-based prelims over/under: each swimmer's expected points from their
 * prelims placement (scored as if finals) vs actual baseline finals points.
 */
import { Gender, ProjectedTeamScore, ScoringSettings, SwimmerResult, Workspace } from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import type { ProjectionBundle } from './scoringEngine';
import {
  aggregationTeamKey,
  buildProjectionBundle,
  gatherBaselineScoredByEntry,
  type ExpectationGap,
} from './scoringBundleAggregation';
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
  pointsForPlacementOrNull,
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

/**
 * Points a swimmer would earn if their prelims placement were their finals
 * result, or `null` when the place-point table has no row for that place (a
 * place past the end of the table).
 *
 * `null` is the table being silent; 0 is the table saying "no points". A
 * caller that needs a number says what silent means for it.
 */
export function pointsForPrelimsSeedRankOrNull(
  prelimsRank: number,
  event: string,
  settings: ScoringSettings
): number | null {
  const bracket = settings.aFinalBracketSize ?? Math.floor(settings.scoringPoints.length / 2);
  const { roundSwam, rank } = roundAndRankForPrelimsSeed(prelimsRank, bracket);
  return pointsForPlacementOrNull(roundSwam, rank, event, settings);
}

/**
 * {@link pointsForPrelimsSeedRankOrNull} read as a number: a place the table has
 * no row for expects 0 points.
 *
 * @deprecated Reads "the table is silent" as 0 points, which is not what the
 * table says. Use {@link pointsForPrelimsSeedRankOrNull} and keep `null` apart
 * from 0. The projection builders no longer call this.
 */
export function pointsForPrelimsSeedRank(
  prelimsRank: number,
  event: string,
  settings: ScoringSettings
): number {
  return pointsForPrelimsSeedRankOrNull(prelimsRank, event, settings) ?? 0;
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

/** The expected rows of a prelims projection, and the entries the table has no row for. */
type PrelimsExpectation = {
  rows: SwimmerResult[];
  /** Entries whose seed is past the end of the place-point table: no expectation. */
  gaps: ExpectationGap[];
};

function collectPrelimsExpectation(
  results: SwimmerResult[],
  settings: ScoringSettings
): PrelimsExpectation {
  const byEvent = new Map<string, SwimmerResult[]>();
  for (const r of results) {
    const ev = String(r.event ?? '').trim();
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev)!.push(r);
  }

  const out: SwimmerResult[] = [];
  const gaps: ExpectationGap[] = [];

  for (const [event, eventRows] of byEvent) {
    if (!isPrelimsOuEligibleEvent(event, eventRows)) continue;

    const prelimsRanks = resolvePrelimsRanksForEvent(eventRows);
    const entries = gatherEligibleEntries(eventRows);

    for (const { key, rows } of entries) {
      const prelimsRank = prelimsRanks.get(key);
      if (prelimsRank == null || prelimsRank < 1) continue;

      const expected = pointsForPrelimsSeedRankOrNull(prelimsRank, event, settings);
      const rep = pickRepresentativeRow(rows);
      // The table is silent for this seed: there is no expectation. It is not 0
      // points, so no row is built (a 0 row would read as "expected nothing").
      if (expected === null) {
        gaps.push({ key: entryKey(rep), row: rep });
        continue;
      }
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

  return { rows: out, gaps };
}

/**
 * Build synthetic scored rows: one per entry with points = prelims-placement
 * expected.
 *
 * An entry whose seed is past the end of the place-point table has no
 * expectation, and no row. A seed the table scores 0 keeps its row with 0 points.
 * {@link listPrelimsEntriesWithoutExpectation} names the entries left out.
 */
export function buildPrelimsExpectedRows(
  results: SwimmerResult[],
  settings: ScoringSettings
): SwimmerResult[] {
  return collectPrelimsExpectation(results, settings).rows;
}

/**
 * Entry keys (`entryKey`) that {@link buildPrelimsExpectedRows} leaves out
 * because the place-point table has no row for the seed. Distinct from an entry
 * that expects 0 points, which has a row.
 */
export function listPrelimsEntriesWithoutExpectation(
  results: SwimmerResult[],
  settings: ScoringSettings
): string[] {
  return collectPrelimsExpectation(results, settings).gaps.map(g => g.key);
}

export type PrelimsOverUnderEntry = {
  expected: number;
  /**
   * The points the entry actually earned in the baseline, or `null` when the
   * baseline holds no row for it: the swim has not been scored yet, or the
   * entrant never swam it. `null` is "no actual", which is not 0 points.
   */
  actual: number | null;
  /** `actual - expected`, or `null` exactly when `actual` is. A sum skips it. */
  overUnder: number | null;
  /** `false` exactly when `actual` is `null`. The field a screen reads to draw a "no actual" marker. */
  hasActual: boolean;
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
    // No baseline row is "no actual", not 0: an entry whose swim is not scored
    // yet must not read as a swimmer who earned nothing.
    const actual = actualByKey.get(key) ?? null;
    out.set(key, {
      expected,
      actual,
      overUnder: actual === null ? null : actual - expected,
      hasActual: actual !== null,
    });
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
  // No actual: nothing to show, rather than -expected.
  return entry.overUnder ?? undefined;
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
    // An entry with no actual adds nothing; it is counted by
    // {@link countPrelimsEntriesWithoutActual}, not as an under.
    if (entry && entry.overUnder !== null) total += entry.overUnder;
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
    if ((parts[1] ?? '').trim() === teamNorm && entry.overUnder !== null) total += entry.overUnder;
  }
  return total;
}

/**
 * How many entries have an expected value and no actual yet. Pair it with
 * {@link sumPrelimsOuForTeam}: that sum covers only the entries that have one.
 * Pass `teamName` for one team; omit it for the whole lookup.
 */
export function countPrelimsEntriesWithoutActual(
  lookup: Map<string, PrelimsOverUnderEntry>,
  teamName?: string
): number {
  const teamNorm = teamName?.trim();
  let n = 0;
  for (const [key, entry] of lookup) {
    if (entry.actual !== null) continue;
    if (teamNorm !== undefined && (key.split('|')[1] ?? '').trim() !== teamNorm) continue;
    n += 1;
  }
  return n;
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
    if (entry.overUnder === null) continue; // no actual: no delta for this event from it
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
  // A team with no entry that has an actual has no momentum at all. Its line is
  // absent (null), not a flat 0 that reads as "exactly on expectation".
  const hasMomentum = new Set(teamNames.filter(t => (seriesByTeam.get(t) ?? []).length > 0));

  const orderedEvents = eventsList.filter(ev => !/\bTIME TRIAL\b/i.test(ev));
  return orderedEvents.map(rawEvent => {
    const row: Record<string, unknown> = {
      name: formatEventChartAxisLabel(rawEvent, { maxLength: 24 }),
      fullEvent: stripEventGenderMarker(rawEvent),
    };
    for (const team of teamNames) {
      const pt = (seriesByTeam.get(team) ?? []).find(p => p.rawEvent === rawEvent);
      if (!hasMomentum.has(team)) {
        row[team] = null;
        continue;
      }
      const cumulative = pt?.cumulative ?? carryForward[team];
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
      // A team the timeline point does not name has no value there: absent, not 0.
      row[team] = pt.baselineDelta[team] ?? null;
    }
    return row;
  });
}


export type PrelimsProjectedOptions = {
  workspace: Workspace;
  gender: Gender;
};

/**
 * Build prelims-placement expected scoring bundle from raw loaded meet data.
 *
 * A team with a seed past the end of the place-point table stays in
 * `sortedTeams`: with its sum and the count of seeds left out, or with
 * `expected: null` when every seed is past the table (see
 * {@link ProjectedTeamScore}).
 */
export function buildPrelimsProjectedBundle({
  workspace,
  gender,
}: PrelimsProjectedOptions): ProjectionBundle {
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

  const { rows, gaps } = collectPrelimsExpectation(currentResults, scoringSettings);
  return buildProjectionBundle(rows, rows, gaps);
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
 * Points of a scored side that the expectation side has no figure for: the rows
 * of the entries a team lists in `withoutExpectation`. A team total of that side
 * includes them; the team's `expected` leaves them out. Subtract them to compare
 * the same entries on both sides.
 */
export type ProjectionLeftOutPoints = {
  /** Team -> points of its left-out entries. Only teams with a left-out entry. */
  byTeam: Map<string, number>;
  /**
   * Team -> event (as on a timeline point's `fullEvent`) -> points. The per-event
   * split lets a cumulative timeline subtract each entry from its own event on.
   */
  byTeamEvent: Map<string, Map<string, number>>;
};

/**
 * Sum the points of `scored` rows whose entry a team lists in
 * `withoutExpectation`.
 *
 * Sums every row of the entry exactly as `aggregateTeamScoring` added it to the
 * team total (a relay aggregate row and its leg shares included), so the
 * subtraction leaves no residue. The result is empty when no team lists a
 * left-out entry, which is the case for any meet whose seeds all sit inside the
 * place-point table.
 */
export function sumProjectionLeftOutPoints(
  scored: readonly SwimmerResult[],
  teams: readonly ProjectedTeamScore[]
): ProjectionLeftOutPoints {
  const byTeam = new Map<string, number>();
  const byTeamEvent = new Map<string, Map<string, number>>();
  const keysByTeam = new Map<string, Set<string>>();
  for (const team of teams) {
    if (team.withoutExpectation.length > 0) {
      keysByTeam.set(team.teamName, new Set(team.withoutExpectation));
    }
  }
  if (keysByTeam.size === 0) return { byTeam, byTeamEvent };

  for (const row of scored) {
    const teamName = aggregationTeamKey(row);
    if (teamName === null) continue;
    const keys = keysByTeam.get(teamName);
    if (!keys || !keys.has(entryKey(row))) continue;
    const pts = typeof row.points === 'number' ? row.points : 0;
    byTeam.set(teamName, (byTeam.get(teamName) ?? 0) + pts);
    const eventKey = stripEventGenderMarker(row.event);
    const events = byTeamEvent.get(teamName) ?? new Map<string, number>();
    events.set(eventKey, (events.get(eventKey) ?? 0) + pts);
    byTeamEvent.set(teamName, events);
  }
  return { byTeam, byTeamEvent };
}

/**
 * What {@link buildPrelimsDeltaTimeline} needs to compare like with like when a
 * projection bundle (prelims or psych) holds teams with no expectation.
 */
export type PrelimsDeltaTimelineOptions = {
  /**
   * Teams the projection bundle lists with `expected: null`. Such a team has no
   * point on the projection timeline, so it gets no delta: its whole baseline
   * would otherwise read as "over". A team the bundle does not list at all keeps
   * its delta against 0.
   */
  noExpectationTeams?: ReadonlySet<string>;
  /** Baseline points of each team's left-out entries, by event ({@link ProjectionLeftOutPoints.byTeamEvent}). */
  baselineLeftOut?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Projected points of each team's left-out entries, by event. */
  projectedLeftOut?: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

/**
 * Options for {@link buildPrelimsDeltaTimeline} read from a projection bundle,
 * or `undefined` when the bundle has no team with `expected: null` and no
 * left-out entry. With `undefined` the plain timeline is already right, so a
 * caller keeps the delta timeline it has.
 */
export function prelimsDeltaTimelineOptions(
  projection: Pick<ProjectionBundle, 'sortedTeams'>,
  baselineScored: readonly SwimmerResult[],
  projectedScored: readonly SwimmerResult[]
): PrelimsDeltaTimelineOptions | undefined {
  const teams = projection.sortedTeams;
  const noExpectationTeams = new Set(teams.filter(t => t.expected === null).map(t => t.teamName));
  const hasLeftOut = teams.some(t => t.withoutExpectationCount > 0);
  if (noExpectationTeams.size === 0 && !hasLeftOut) return undefined;
  return {
    noExpectationTeams,
    baselineLeftOut: sumProjectionLeftOutPoints(baselineScored, teams).byTeamEvent,
    projectedLeftOut: sumProjectionLeftOutPoints(projectedScored, teams).byTeamEvent,
  };
}

/** Carry a team's cumulative value from a timeline point into its running total, when the point has one. */
function carryTimelineValue(
  pt: Record<string, unknown> | undefined,
  team: string,
  last: Record<string, number>
): void {
  const value = pt?.[team];
  if (typeof value === 'number') last[team] = value;
}

/** Add the left-out points of `team` at `eventKey` to its running total. */
function addLeftOutAtEvent(
  running: Record<string, number>,
  leftOut: ReadonlyMap<string, ReadonlyMap<string, number>> | undefined,
  team: string,
  eventKey: string
): void {
  running[team] = (running[team] ?? 0) + (leftOut?.get(team)?.get(eventKey) ?? 0);
}

/**
 * Per-team baseline/projected deltas against the prelims anchor for one event.
 * Mutates `lastBase`/`lastPrelim`/`lastProj` (carry-forward running totals) —
 * same running-total contract `buildPrelimsDeltaTimeline`'s loop always had.
 *
 * `leftOutBase`/`leftOutProj` are the running totals of the left-out entries'
 * points (also mutated); a team with none keeps the plain difference.
 */
function computeTimelineDeltasForEvent(
  basePt: Record<string, unknown> | undefined,
  projPt: Record<string, unknown> | undefined,
  prelimPt: Record<string, unknown> | undefined,
  lastBase: Record<string, number>,
  lastPrelim: Record<string, number>,
  lastProj: Record<string, number>,
  eventKey: string,
  options: PrelimsDeltaTimelineOptions | undefined,
  leftOutBase: Record<string, number>,
  leftOutProj: Record<string, number>
): { baselineDelta: Record<string, number>; projectedDelta: Record<string, number> } {
  const teams = timelineTeamsAtEvent([basePt, projPt, prelimPt], lastBase, lastPrelim, lastProj);
  const baselineDelta: Record<string, number> = {};
  const projectedDelta: Record<string, number> = {};
  for (const team of teams) {
    carryTimelineValue(basePt, team, lastBase);
    carryTimelineValue(projPt, team, lastProj);
    carryTimelineValue(prelimPt, team, lastPrelim);

    // No expectation for the team: there is nothing to be over or under, so no key.
    if (options?.noExpectationTeams?.has(team)) continue;

    // A left-out entry leaves a side once its own event has a point on that
    // side's timeline, in step with the cumulative total it sits in.
    if (basePt) addLeftOutAtEvent(leftOutBase, options?.baselineLeftOut, team, eventKey);
    if (projPt) addLeftOutAtEvent(leftOutProj, options?.projectedLeftOut, team, eventKey);

    baselineDelta[team] = (lastBase[team] ?? 0) - (leftOutBase[team] ?? 0) - (lastPrelim[team] ?? 0);
    projectedDelta[team] = (lastProj[team] ?? 0) - (leftOutProj[team] ?? 0) - (lastPrelim[team] ?? 0);
  }
  return { baselineDelta, projectedDelta };
}

export function buildPrelimsDeltaTimeline(
  baselineTimeline: Record<string, unknown>[],
  projectedTimeline: Record<string, unknown>[],
  prelimsTimeline: Record<string, unknown>[],
  options?: PrelimsDeltaTimelineOptions
): PrelimsDeltaTimelinePoint[] {
  const baselineByEvent = indexTimelineByEvent(baselineTimeline);
  const projectedByEvent = indexTimelineByEvent(projectedTimeline);
  const prelimsByEvent = indexTimelineByEvent(prelimsTimeline);

  const eventOrder = buildPrelimsTimelineEventOrder(baselineTimeline, prelimsTimeline, projectedTimeline);

  const lastBase: Record<string, number> = {};
  const lastProj: Record<string, number> = {};
  const lastPrelim: Record<string, number> = {};
  const leftOutBase: Record<string, number> = {};
  const leftOutProj: Record<string, number> = {};
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
      lastProj,
      eventKey,
      options,
      leftOutBase,
      leftOutProj
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
