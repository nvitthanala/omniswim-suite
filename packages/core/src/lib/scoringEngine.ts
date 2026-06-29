/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure scoring engine extracted from useWorkspaceScoring so it can run either
 * on the main thread (synchronous fallback) or inside a Web Worker.
 */
import { Gender, SwimmerResult, TeamScore, Workspace } from '../types';
import {
  calculatePoints,
  getTeamColors,
  looksLikeInstitutionTeamName,
  sortEventsByMeetOrder,
  formatEventChartAxisLabel,
  stripEventGenderMarker,
} from './utils';
import { mergeScoringSettings } from './scoringDefaults';
import { buildPrelimsProjectedBundle } from './prelimsProjection';
import { buildPsychProjectedBundle } from './psychProjection';
import { buildWhatIfResults } from './whatIfProjection';

export type ScoringBundle = {
  allResults: SwimmerResult[];
  allScored: SwimmerResult[];
  events: string[];
  sortedTeams: TeamScore[];
  timelineData: Record<string, unknown>[];
  teamStyleSignature: string;
};

export type BuildOptions = {
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
  applyWhatIf: boolean;
  scorerRosterOverrides: Workspace['scorerRosterOverrides'];
};

export function buildScoringBundle({
  workspace,
  gender,
  removeSeniors,
  applyWhatIf,
  scorerRosterOverrides,
}: BuildOptions): ScoringBundle {
  const menResults = workspace.menResults ?? [];
  const womenResults = workspace.womenResults ?? [];
  const currentResults = gender === Gender.MEN ? menResults : womenResults;
  const pdfHint = [...menResults, ...womenResults];

  const scoringSettings = mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
    resultsForPdfHint: pdfHint,
  });

  let allResults: SwimmerResult[];
  let overrides = scorerRosterOverrides ?? [];

  if (applyWhatIf) {
    allResults = buildWhatIfResults({ workspace, gender, removeSeniors });
  } else {
    allResults = currentResults;
    overrides = [];
  }

  const allScored = calculatePoints(allResults, scoringSettings, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: pdfHint,
  });
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

/** Build both projected (what-if) and baseline bundles in one pass. */
export function buildScoringSnapshot(workspace: Workspace, gender: Gender, removeSeniors: boolean) {
  const projected = buildScoringBundle({
    workspace,
    gender,
    removeSeniors,
    applyWhatIf: true,
    scorerRosterOverrides: workspace.scorerRosterOverrides,
  });
  const baseline = buildScoringBundle({
    workspace,
    gender,
    removeSeniors: false,
    applyWhatIf: false,
    scorerRosterOverrides: [],
  });
  const prelimsProjected = buildPrelimsProjectedBundle({ workspace, gender });
  const psychProjected = buildPsychProjectedBundle({ workspace, gender });
  return { projected, baseline, prelimsProjected, psychProjected };
}
