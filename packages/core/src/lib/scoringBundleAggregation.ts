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
import { ProjectedTeamScore, SwimmerResult, TeamScore } from '../types';
import {
  formatEventChartAxisLabel,
  getTeamColors,
  looksLikeInstitutionTeamName,
  sortEventsByMeetOrder,
  stripEventGenderMarker,
} from './utils';
import { computeVisibleEvents } from './eventIdentity';
import { recordAt } from './indexedAccess';
import type { ProjectionBundle, ScoringBundle } from './scoringEngine';

export type AggregatedTeamScoring = {
  /** `allResults`' distinct events, in meet order. */
  events: string[];
  sortedTeams: TeamScore[];
  timelineData: Record<string, unknown>[];
  teamStyleSignature: string;
};

/**
 * The team a row is totalled under, or `null` when the row belongs to no team:
 * a relay-style row whose name equals its team label and whose label does not
 * look like an institution (a person's name used as a team label).
 */
export function aggregationTeamKey(res: SwimmerResult): string | null {
  const tName = String(res.name ?? '')
    .trim()
    .toLowerCase();
  const tTeam = String(res.team ?? '')
    .trim()
    .toLowerCase();
  if (tName && tTeam === tName && !looksLikeInstitutionTeamName(res.team)) {
    return null;
  }
  return String(res.team ?? 'Unknown').trim() || 'Unknown';
}

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
      const teamKey = aggregationTeamKey(res);
      if (teamKey === null) return;
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
      runningTotals[teamKey] = recordAt(runningTotals, teamKey) + pts;
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

/** An entry of a projection that the place-point table has no row for. */
export type ExpectationGap = {
  /** `entryKey` of the entry. */
  key: string;
  /** The row that stands for the entry: it names the team. */
  row: SwimmerResult;
};

/**
 * Projection bundle (prelims-seed or psych-seed) that keeps every team with a
 * seed past the end of the place-point table.
 *
 * - A team with some seeds scored keeps its sum in `expected` and lists the
 *   rest in `withoutExpectation`.
 * - A team with no seed scored has no rows to total. It is appended after the
 *   scored teams with `expected: null` and no `totalPoints`: a missing figure
 *   is never a 0.
 *
 * For input with no gap every figure matches {@link buildProjectedScoringBundle}
 * (`expected` equals the team's total, and `teamStyleSignature` is unchanged).
 */
export function buildProjectionBundle(
  allResults: SwimmerResult[],
  allScored: SwimmerResult[],
  gaps: readonly ExpectationGap[]
): ProjectionBundle {
  const agg = aggregateTeamScoring(allResults, allScored);

  const gapKeysByTeam = new Map<string, string[]>();
  for (const { key, row } of gaps) {
    const team = aggregationTeamKey(row);
    if (team === null) continue; // a row that belongs to no team, as in aggregateTeamScoring
    const keys = gapKeysByTeam.get(team) ?? [];
    if (!keys.includes(key)) keys.push(key);
    gapKeysByTeam.set(team, keys);
  }

  const scoredTeams: ProjectedTeamScore[] = agg.sortedTeams.map(team => {
    const withoutExpectation = gapKeysByTeam.get(team.teamName) ?? [];
    // `totalPoints` is not on ProjectedTeamScore: a reader of `.totalPoints` must
    // get `undefined` on every team, not a number on some and nothing on others.
    const { totalPoints: _totalPoints, ...rest } = team;
    return {
      ...rest,
      expected: team.totalPoints,
      withoutExpectation,
      withoutExpectationCount: withoutExpectation.length,
    };
  });

  const scoredNames = new Set(scoredTeams.map(t => t.teamName));
  const unscoredTeams: ProjectedTeamScore[] = [];
  for (const [teamName, withoutExpectation] of gapKeysByTeam) {
    if (scoredNames.has(teamName)) continue;
    unscoredTeams.push({
      teamName,
      swimmers: [],
      color: getTeamColors(teamName).primary,
      expected: null,
      withoutExpectation,
      withoutExpectationCount: withoutExpectation.length,
    });
  }

  const sortedTeams = [...scoredTeams, ...unscoredTeams];
  // `name:points:color` as in aggregateTeamScoring. The gap count is appended
  // only when above 0, so a memo keyed on it refreshes when a count changes
  // while the sum stays put, and a bundle with no gap is unchanged.
  const teamStyleSignature = sortedTeams
    .map(
      t =>
        `${t.teamName}:${t.expected === null ? 'none' : t.expected}:${t.color}` +
        (t.withoutExpectationCount > 0 ? `:gap${t.withoutExpectationCount}` : '')
    )
    .join('|');

  return {
    allResults,
    allScored,
    events: agg.events,
    visibleEvents: computeVisibleEvents(agg.events, allResults, allResults, {}),
    sortedTeams,
    timelineData: agg.timelineData,
    teamStyleSignature,
  };
}

/**
 * Per-team expectation, split so a caller cannot sum an absent figure as 0.
 * - `expectedByTeam`: teams with a numeric `expected` only.
 * - `withoutExpectationByTeam`: teams with at least one seed past the table
 *   (including teams with no `expected`), mapped to how many.
 */
export function projectionTeamExpectations(teams: readonly ProjectedTeamScore[]): {
  expectedByTeam: Map<string, number>;
  withoutExpectationByTeam: Map<string, number>;
} {
  const expectedByTeam = new Map<string, number>();
  const withoutExpectationByTeam = new Map<string, number>();
  for (const t of teams) {
    if (t.expected !== null) expectedByTeam.set(t.teamName, t.expected);
    if (t.withoutExpectationCount > 0) withoutExpectationByTeam.set(t.teamName, t.withoutExpectationCount);
  }
  return { expectedByTeam, withoutExpectationByTeam };
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
