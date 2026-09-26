/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared team-aggregation step for the three scoring-bundle builders
 * (scoringEngine.buildScoringBundle, and prelimsProjection /
 * psychProjection's own `aggregateBundle`): given a set of already-scored
 * rows and the meet-ordered event list, group them into per-team totals and
 * a cumulative per-event timeline.
 *
 * Extracted 2026-09-26 (code-health plan 2026-09-25, item H8) — the three
 * call sites carried byte-identical copies of this ~60-line loop
 * (`prelimsProjection.ts` and `psychProjection.ts`'s `aggregateBundle`, and
 * `scoringEngine.ts`'s `buildScoringBundle`). `visibleEvents` is deliberately
 * NOT computed here: the three callers derive it differently (the projection
 * builders always pass `allResults` as their own PDF hint with empty
 * settings; the real scoring engine passes the gender's real PDF rows and the
 * merged settings), so that one line stays with each caller.
 */
import { SwimmerResult, TeamScore } from '../types';
import {
  formatEventChartAxisLabel,
  getTeamColors,
  looksLikeInstitutionTeamName,
  sortEventsByMeetOrder,
  stripEventGenderMarker,
} from './utils';
import { computeVisibleEvents } from './eventIdentity';
import type { ScoringBundle } from './scoringEngine';

export type AggregatedTeamScoring = {
  /** `allResults`' distinct events, in meet order. */
  events: string[];
  sortedTeams: TeamScore[];
  timelineData: Record<string, unknown>[];
  teamStyleSignature: string;
};

/**
 * Per-event team totals and a cumulative timeline from a result/scored-row
 * pair sharing `id`. A scored row missing from `allScored` counts 0 points
 * (mirrors each caller's own `scoredById.get(r.id) ?? { ...r, points: 0 }`).
 */
export function aggregateTeamScoring(
  allResults: SwimmerResult[],
  allScored: SwimmerResult[]
): AggregatedTeamScoring {
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

  return { events, sortedTeams, timelineData, teamStyleSignature };
}

/**
 * Full `ScoringBundle` for a placement-projection builder (prelims-seed or
 * psych-seed): `allResults` doubles as its own PDF hint with no settings, so
 * `visibleEvents` never hides a canonical-only label the way the real scoring
 * engine's own PDF-aware visibility does. `prelimsProjection.ts` and
 * `psychProjection.ts`'s own `aggregateBundle` wrappers were byte-identical;
 * this is that wrapper, shared.
 */
export function buildProjectedScoringBundle(
  allResults: SwimmerResult[],
  allScored: SwimmerResult[]
): ScoringBundle {
  const agg = aggregateTeamScoring(allResults, allScored);
  return {
    allResults,
    allScored,
    events: agg.events,
    visibleEvents: computeVisibleEvents(agg.events, allResults, allResults, {}),
    sortedTeams: agg.sortedTeams,
    timelineData: agg.timelineData,
    teamStyleSignature: agg.teamStyleSignature,
  };
}

/**
 * Baseline-scored rows grouped by entry key, skipping exhibition/time-trial
 * noise. Identical in `prelimsProjection.ts` and `psychProjection.ts`
 * (`gatherBaselineScoredByEntry`); extracted here with the caller's own
 * `entryKey` passed in since the two files key entries the same way but
 * import it from different places (`psychProjection.ts` re-exports
 * `prelimsProjection.ts`'s `entryKey`).
 */
export function gatherBaselineScoredByEntry(
  baselineScored: SwimmerResult[],
  entryKey: (r: SwimmerResult) => string
): Map<string, SwimmerResult[]> {
  const byKey = new Map<string, SwimmerResult[]>();
  for (const r of baselineScored) {
    if (r.isExhibition || r.isTimeTrial) continue;
    const key = entryKey(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  return byKey;
}
