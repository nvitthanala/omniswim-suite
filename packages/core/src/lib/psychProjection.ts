/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Placement-based psych-sheet projection: rank psych seed times per event,
 * assign expected placement points, compare to actual baseline scoring.
 */
import { Gender, ScoringSettings, SwimmerResult, TeamScore, Workspace } from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import type { ScoringBundle } from './scoringEngine';
import {
  entryKey,
  pointsForPrelimsSeedRank,
  type PrelimsOverUnderEntry,
  type PrelimsDeltaTimelinePoint,
  buildPrelimsDeltaTimeline,
} from './prelimsProjection';
import {
  convertTimeToSeconds,
  formatEventChartAxisLabel,
  getTeamColors,
  isRelayResult,
  isScoringSwimTime,
  looksLikeInstitutionTeamName,
  normalizeSwimmerName,
  parseRankInt,
  sortEventsByMeetOrder,
  stripEventGenderMarker,
} from './utils';
import { matchMeetTeamName, expandTeamAbbrev } from '../data/teamAliases';

export type PsychOverUnderEntry = PrelimsOverUnderEntry;

/** Psych seed clock from uploaded psych sheet row. */
export function psychClock(r: Pick<SwimmerResult, 'time' | 'isRelay' | 'isPsychSheet'>): string {
  if (isRelayResult(r as SwimmerResult)) return '';
  const clock = String(r.time ?? '').trim();
  if (clock && isScoringSwimTime(clock)) return clock;
  return '';
}

export function psychResultsForGender(workspace: Workspace, gender: Gender): SwimmerResult[] {
  return gender === Gender.MEN
    ? (workspace.psychMenResults ?? [])
    : (workspace.psychWomenResults ?? []);
}

export function hasPsychData(
  source: Workspace | SwimmerResult[] | undefined
): boolean {
  if (!source) return false;
  const rows = Array.isArray(source)
    ? source
    : [...(source.psychMenResults ?? []), ...(source.psychWomenResults ?? [])];
  return rows.some(r => psychClock(r) !== '');
}

type EntryRows = { key: string; rows: SwimmerResult[] };

function gatherPsychEntries(eventRows: SwimmerResult[]): EntryRows[] {
  const byKey = new Map<string, SwimmerResult[]>();
  for (const r of eventRows) {
    if (r.isExhibition || r.isTimeTrial || isRelayResult(r)) continue;
    const clock = psychClock(r);
    if (!clock || !isScoringSwimTime(clock)) continue;
    const key = entryKey(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  return [...byKey.entries()].map(([key, rows]) => ({ key, rows }));
}

/** Psych rank per entry: PDF rank when present, else time sort. */
export function resolvePsychRanksForEvent(eventRows: SwimmerResult[]): Map<string, number> {
  const entries = gatherPsychEntries(eventRows);
  const ranks = new Map<string, number>();

  for (const { key, rows } of entries) {
    const pdfRank = parseRankInt(rows[0]?.rank);
    if (pdfRank != null && pdfRank > 0) {
      ranks.set(key, pdfRank);
    }
  }

  const timeSorted = [...entries].sort((a, b) => {
    const clockA = psychClock(a.rows[0]);
    const clockB = psychClock(b.rows[0]);
    return convertTimeToSeconds(clockA) - convertTimeToSeconds(clockB);
  });

  timeSorted.forEach(({ key }, index) => {
    if (!ranks.has(key)) {
      ranks.set(key, index + 1);
    }
  });

  return ranks;
}

/** Build synthetic scored rows: one per psych entry with psych-placement expected points. */
export function buildPsychExpectedRows(
  psychResults: SwimmerResult[],
  settings: ScoringSettings
): SwimmerResult[] {
  const byEvent = new Map<string, SwimmerResult[]>();
  for (const r of psychResults) {
    if (isRelayResult(r)) continue;
    const ev = String(r.event ?? '').trim();
    if (!ev) continue;
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev)!.push(r);
  }

  const out: SwimmerResult[] = [];
  for (const [event, eventRows] of byEvent) {
    if (/\bTIME TRIAL\b/i.test(event) || eventRows.some(r => r.isTimeTrial)) continue;
    const ranks = resolvePsychRanksForEvent(eventRows);
    const seen = new Set<string>();
    for (const { key, rows } of gatherPsychEntries(eventRows)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const rep = rows[0];
      const rank = ranks.get(key) ?? 0;
      const pts = rank > 0 ? pointsForPrelimsSeedRank(rank, event, settings) : 0;
      out.push({
        ...rep,
        id: `psych-${key}`,
        rank,
        points: pts,
        roundSwam: 'Psych Sheet',
        isPsychSheet: true,
      });
    }
  }
  return out;
}

function gatherBaselineScoredByEntry(baselineScored: SwimmerResult[]): Map<string, SwimmerResult[]> {
  const byKey = new Map<string, SwimmerResult[]>();
  for (const r of baselineScored) {
    if (r.isExhibition || r.isTimeTrial) continue;
    const key = entryKey(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  return byKey;
}

function baselineActualPointsForEntry(rows: SwimmerResult[], key: string): number {
  const relayKey = key.endsWith('|relay');
  if (relayKey) {
    const teamRow = rows.find(
      r =>
        isRelayResult(r) &&
        String(r.name ?? '')
          .trim()
          .toLowerCase() ===
          String(r.team ?? '')
            .trim()
            .toLowerCase() &&
        looksLikeInstitutionTeamName(r.team)
    );
    if (teamRow && typeof teamRow.points === 'number') return teamRow.points;
    return rows.reduce((s, r) => s + (typeof r.points === 'number' ? r.points : 0), 0);
  }
  const best = rows.reduce((max, r) => {
    const pts = typeof r.points === 'number' ? r.points : 0;
    return pts > max ? pts : max;
  }, 0);
  return best;
}

function entryKeyEventName(key: string): string {
  const parts = key.split('|');
  return `${parts[0] ?? ''}|${parts[2] ?? ''}`;
}

/** Rewrite psych team labels to meet-results team names for O/U key alignment. */
export function alignPsychResultsToMeetTeams(
  psychRows: SwimmerResult[],
  meetRows: SwimmerResult[]
): SwimmerResult[] {
  const meetTeams = [
    ...new Set(
      meetRows
        .map(r => String(r.team ?? '').trim())
        .filter(Boolean)
    ),
  ];
  const cache = new Map<string, string>();
  return psychRows.map(r => {
    const raw = String(r.team ?? '').trim();
    if (!raw) return r;
    let resolved = cache.get(raw);
    if (!resolved) {
      resolved = matchMeetTeamName(raw, meetTeams);
      cache.set(raw, resolved);
    }
    return resolved === raw ? r : { ...r, team: resolved };
  });
}

/** Per entry: actual baseline pts vs psych-placement expected (individual entries only). */
export function buildPsychOverUnderByEntryKey(
  baselineScored: SwimmerResult[],
  psychExpected: SwimmerResult[]
): Map<string, PsychOverUnderEntry> {
  const alignedPsych = alignPsychResultsToMeetTeams(psychExpected, baselineScored);

  const expectedByKey = new Map<string, number>();
  for (const r of alignedPsych) {
    const key = entryKey(r);
    const pts = typeof r.points === 'number' ? r.points : 0;
    const prev = expectedByKey.get(key);
    if (prev == null || pts > prev) expectedByKey.set(key, pts);
  }

  const actualByKey = new Map<string, number>();
  const actualByEventName = new Map<string, number>();
  for (const [key, rows] of gatherBaselineScoredByEntry(baselineScored)) {
    const pts = baselineActualPointsForEntry(rows, key);
    actualByKey.set(key, pts);
    const eventNameKey = entryKeyEventName(key);
    const prev = actualByEventName.get(eventNameKey);
    if (prev == null || pts > prev) actualByEventName.set(eventNameKey, pts);
  }

  const out = new Map<string, PsychOverUnderEntry>();
  for (const [key, expected] of expectedByKey) {
    if (expected <= 0) continue;
    let actual = actualByKey.get(key) ?? 0;
    if (actual === 0) {
      actual = actualByEventName.get(entryKeyEventName(key)) ?? 0;
    }
    out.set(key, { expected, actual, overUnder: actual - expected });
  }
  return out;
}

export function psychExpectedForResult(
  r: SwimmerResult,
  lookup: Map<string, PsychOverUnderEntry>
): number | undefined {
  if (isRelayResult(r)) return undefined;
  return lookup.get(entryKey(r))?.expected;
}

function aggregateBundle(allResults: SwimmerResult[], allScored: SwimmerResult[]): ScoringBundle {
  const scoredById = new Map(allScored.map(r => [r.id, r]));
  const events = sortEventsByMeetOrder(Array.from(new Set(allResults.map(r => r.event))));

  const teamsMap: Record<string, TeamScore> = {};
  const timelineData: Record<string, unknown>[] = [];
  const runningTotals: Record<string, number> = {};

  events.forEach(event => {
    const eventResults = allResults.filter(r => r.event === event);
    const isTimeTrial = eventResults.some(r => r.isTimeTrial);
    const scored = eventResults.map(r => scoredById.get(r.id) ?? { ...r, points: 0 });

    scored.forEach(res => {
      const tName = String(res.name ?? '')
        .trim()
        .toLowerCase();
      const tTeam = String(res.team ?? '')
        .trim()
        .toLowerCase();
      if (tName && tTeam === tName && !looksLikeInstitutionTeamName(res.team)) {
        return;
      }
      const teamKey = String(res.team ?? 'Unknown').trim() || 'Unknown';
      if (!teamsMap[teamKey]) {
        teamsMap[teamKey] = {
          teamName: teamKey,
          totalPoints: 0,
          swimmers: [],
          color: getTeamColors(teamKey).primary,
        };
        runningTotals[teamKey] = 0;
      }
      const pts = typeof res.points === 'number' ? res.points : 0;
      teamsMap[teamKey].totalPoints += pts;
      teamsMap[teamKey].swimmers.push(res);
      runningTotals[teamKey] += pts;
    });

    if (!isTimeTrial) {
      const timelinePoint: Record<string, unknown> = {
        name: formatEventChartAxisLabel(event, { maxLength: 24 }),
        fullEvent: stripEventGenderMarker(event),
      };
      Object.keys(runningTotals).forEach(team => {
        timelinePoint[team] = runningTotals[team];
      });
      if (Object.keys(runningTotals).length > 0) {
        timelineData.push(timelinePoint);
      }
    }
  });

  const sortedTeams = Object.values(teamsMap).sort((a, b) => b.totalPoints - a.totalPoints);
  const teamStyleSignature = sortedTeams
    .map(t => `${t.teamName}:${t.totalPoints}:${t.color}`)
    .join('|');

  return {
    allResults,
    allScored,
    events,
    sortedTeams,
    timelineData,
    teamStyleSignature,
  };
}

export type PsychProjectedOptions = {
  workspace: Workspace;
  gender: Gender;
};

/** Build psych-placement expected scoring bundle from psych sheet data. */
export function buildPsychProjectedBundle({
  workspace,
  gender,
}: PsychProjectedOptions): ScoringBundle {
  const currentResults = psychResultsForGender(workspace, gender);
  const pdfHint = [
    ...(workspace.menResults ?? []),
    ...(workspace.womenResults ?? []),
    ...(workspace.psychMenResults ?? []),
    ...(workspace.psychWomenResults ?? []),
  ];

  const scoringSettings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
    resultsForPdfHint: pdfHint,
  });

  if (!hasPsychData(currentResults)) {
    return {
      allResults: [],
      allScored: [],
      events: [],
      sortedTeams: [],
      timelineData: [],
       teamStyleSignature: '',
    };
  }

  const meetRows = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
  const alignedPsych = alignPsychResultsToMeetTeams(currentResults, meetRows);
  const expectedRows = buildPsychExpectedRows(alignedPsych, scoringSettings);
  return aggregateBundle(expectedRows, expectedRows);
}

export type PsychDeltaTimelinePoint = PrelimsDeltaTimelinePoint;

/** Cumulative baseline − psych anchor per team (same shape as prelims delta timeline). */
export function buildPsychDeltaTimeline(
  baselineTimeline: Record<string, unknown>[],
  projectedTimeline: Record<string, unknown>[],
  psychTimeline: Record<string, unknown>[]
): PsychDeltaTimelinePoint[] {
  return buildPrelimsDeltaTimeline(baselineTimeline, projectedTimeline, psychTimeline);
}
