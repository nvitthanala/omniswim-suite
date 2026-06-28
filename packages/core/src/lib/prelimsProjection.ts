/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine-computed prelims projected scoring: re-rank each event field on prelims
 * clocks, assign expected A/B final rounds, then score with conference rules.
 */
import { Gender, ScoringSettings, SwimmerResult, TeamScore, Workspace } from '../types';
import { mergeScoringSettings } from './scoringDefaults';
import type { ScoringBundle } from './scoringEngine';
import {
  calculatePoints,
  classifyRoundTier,
  convertTimeToSeconds,
  formatEventChartAxisLabel,
  getTeamColors,
  isRelayResult,
  isScoringSwimTime,
  looksLikeInstitutionTeamName,
  normalizeSwimmerName,
  sortEventsByMeetOrder,
  stripEventGenderMarker,
} from './utils';

function isDistanceEvent(event: string | undefined): boolean {
  if (!event) return false;
  const u = event.toUpperCase();
  return /\b(1000|1650|1500|800|10000)\b/.test(u) || u.includes('TIMED');
}

function isDivingEvent(event: string | undefined, settings: ScoringSettings): boolean {
  const patterns = settings.diverEventPattern?.length
    ? settings.diverEventPattern
    : ['DIVING', 'DIVE'];
  const u = (event ?? '').toUpperCase();
  return patterns.some(token => {
    if (token === 'DIVE') return /\bDIVE\b/.test(u);
    return u.includes(token);
  });
}

/** Valid prelims clock for a swim row. */
export function prelimsClock(
  r: Pick<SwimmerResult, 'roundSwam' | 'time' | 'prelimsTime' | 'relayTeamTime' | 'isRelay'>
): string {
  if (isRelayResult(r as SwimmerResult)) {
    const relayPrelim = String(r.relayTeamTime ?? r.prelimsTime ?? '').trim();
    if (relayPrelim && isScoringSwimTime(relayPrelim)) return relayPrelim;
    if (classifyRoundTier(r.roundSwam) === 'PRE') {
      return String(r.prelimsTime ?? r.time ?? '').trim();
    }
    return String(r.prelimsTime ?? '').trim();
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

function entryKey(r: SwimmerResult): string {
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

/** Dedupe to one row per athlete/relay per event with the best prelims clock. */
export function buildPrelimsFieldResults(results: SwimmerResult[]): SwimmerResult[] {
  const best = new Map<string, SwimmerResult>();

  for (const r of results) {
    if (r.isExhibition || r.isTimeTrial) continue;
    if (isRelayResult(r) && !isRelayTeamRow(r)) continue;

    const clock = prelimsClock(r);
    if (!clock || !isScoringSwimTime(clock)) continue;

    const key = entryKey(r);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, { ...r });
      continue;
    }
    const existingClock = prelimsClock(existing);
    if (
      convertTimeToSeconds(clock) <
      convertTimeToSeconds(existingClock || '9:99.99')
    ) {
      best.set(key, { ...r });
    }
  }

  return [...best.values()].map(r => {
    const clock = prelimsClock(r);
    return {
      ...r,
      id: `prelim-proj-${r.id}`,
      time: clock,
      prelimsTime: clock,
      finalsTime: clock,
      points: 0,
      pdfPoints: undefined,
    };
  });
}

/** Per event: rank by prelims time and assign projected round placements. */
export function projectPrelimsPlacements(
  results: SwimmerResult[],
  settings: ScoringSettings
): SwimmerResult[] {
  const byEvent = new Map<string, SwimmerResult[]>();
  for (const r of results) {
    const ev = String(r.event ?? '').trim();
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev)!.push(r);
  }

  const updates = new Map<string, { rank: number; roundSwam: string }>();

  for (const [, rows] of byEvent) {
    const sample = rows[0];
    const distanceOrDive =
      isDistanceEvent(sample.event) || isDivingEvent(sample.event, settings);

    const sorted = [...rows].sort(
      (a, b) => convertTimeToSeconds(prelimsClock(a)) - convertTimeToSeconds(prelimsClock(b))
    );

    sorted.forEach((r, i) => {
      const rank = i + 1;
      let roundSwam: string;
      if (distanceOrDive) {
        roundSwam = 'Preliminaries';
      } else if (rank <= 8) {
        roundSwam = 'A Final';
      } else if (rank <= 16) {
        roundSwam = 'B Final';
      } else {
        roundSwam = 'Preliminaries';
      }
      updates.set(r.id, { rank, roundSwam });
    });
  }

  return results.map(r => {
    const upd = updates.get(r.id);
    if (!upd) return r;
    const clock = prelimsClock(r);
    return {
      ...r,
      rank: upd.rank,
      roundSwam: upd.roundSwam,
      time: clock,
      prelimsTime: clock,
      finalsTime: clock,
    };
  });
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

export type PrelimsProjectedOptions = {
  workspace: Workspace;
  gender: Gender;
};

/** Build prelims-projected scoring bundle from raw loaded meet data. */
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
      sortedTeams: [],
      timelineData: [],
      teamStyleSignature: '',
    };
  }

  const field = buildPrelimsFieldResults(currentResults);
  const projected = projectPrelimsPlacements(field, scoringSettings);
  const allScored = calculatePoints(projected, scoringSettings, {
    scorerRosterOverrides: [],
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: pdfHint,
  });

  return aggregateBundle(projected, allScored);
}

export type PrelimsDeltaTimelinePoint = {
  name: string;
  fullEvent?: string;
  /** baseline cumulative − prelims cumulative per team */
  baselineDelta: Record<string, number>;
  /** projected cumulative − prelims cumulative per team */
  projectedDelta: Record<string, number>;
};

/** Merge baseline/projected timelines with prelims timeline for per-event over/under. */
export function buildPrelimsDeltaTimeline(
  baselineTimeline: Record<string, unknown>[],
  projectedTimeline: Record<string, unknown>[],
  prelimsTimeline: Record<string, unknown>[]
): PrelimsDeltaTimelinePoint[] {
  const len = Math.max(baselineTimeline.length, projectedTimeline.length, prelimsTimeline.length);
  const out: PrelimsDeltaTimelinePoint[] = [];

  for (let i = 0; i < len; i++) {
    const base = baselineTimeline[i] ?? {};
    const proj = projectedTimeline[i] ?? {};
    const prelim = prelimsTimeline[i] ?? {};
    const teams = new Set<string>();
    for (const pt of [base, proj, prelim]) {
      for (const k of Object.keys(pt)) {
        if (k !== 'name' && k !== 'fullEvent') teams.add(k);
      }
    }

    const baselineDelta: Record<string, number> = {};
    const projectedDelta: Record<string, number> = {};
    for (const team of teams) {
      const b = typeof base[team] === 'number' ? (base[team] as number) : 0;
      const p = typeof proj[team] === 'number' ? (proj[team] as number) : 0;
      const pr = typeof prelim[team] === 'number' ? (prelim[team] as number) : 0;
      baselineDelta[team] = b - pr;
      projectedDelta[team] = p - pr;
    }

    out.push({
      name: String(base.name ?? proj.name ?? prelim.name ?? ''),
      fullEvent: (base.fullEvent ?? proj.fullEvent ?? prelim.fullEvent) as string | undefined,
      baselineDelta,
      projectedDelta,
    });
  }

  return out;
}
