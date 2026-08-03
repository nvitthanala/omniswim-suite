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
import { computeVisibleEvents } from './eventIdentity';
import { buildPrelimsProjectedBundle } from './prelimsProjection';
import { buildPsychProjectedBundle } from './psychProjection';
import { buildWhatIfResults } from './whatIfProjection';
import { getSourceResults } from './meetSource';
import { buildAliasResolver } from './athleteAliases';

export type ScoringBundle = {
  allResults: SwimmerResult[];
  allScored: SwimmerResult[];
  events: string[];
  /**
   * Subset of `events` fit for the matrix event axis: excludes non-program
   * individual events (25-yard events, 100 IM, time trials) and, when a meet is
   * loaded, leftover canonical-only labels that never matched a meet event.
   * Relays and diving always remain. Purely presentational — points/totals are
   * computed from `events` and are unaffected by this field.
   */
  visibleEvents: string[];
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
  const workingResults = gender === Gender.MEN ? menResults : womenResults;
  const sourceResults = getSourceResults(workspace, gender);
  /** Baseline uses frozen source copy; projected uses working + what-if layers. */
  const currentResults = applyWhatIf ? workingResults : sourceResults;
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

  // Collapse confirmed duplicate spellings to one identity BEFORE scoring, so a
  // swimmer imported twice ("Camden Mask" from a SwimCloud paste vs "Cam Mask"
  // in the meet results) is one athlete everywhere downstream — roster rows,
  // scorer caps, entry limits and relay legs. Links are user-confirmed or
  // evidence-backed auto-links; an empty alias set is an identity no-op, so this
  // costs nothing when nothing is linked. See athleteAliases.ts.
  const aliasLinks = workspace.athleteAliases ?? [];
  if (aliasLinks.length > 0) {
    const resolver = buildAliasResolver(aliasLinks);
    const canonical = (name: string, team?: string) => resolver.resolveAthleteName(name, team, gender);
    allResults = allResults.map(r => {
      const resolved = canonical(String(r.name ?? ''), r.team);
      return resolved === r.name ? r : { ...r, name: resolved };
    });
    // Overrides are keyed by name; resolve them too or a link would orphan the
    // scorer toggle that was set under the old spelling.
    overrides = overrides.map(o => {
      const resolved = canonical(String(o.name ?? ''), o.team);
      return resolved === o.name ? o : { ...o, name: resolved };
    });
  }

  const allScored = calculatePoints(allResults, scoringSettings, {
    scorerRosterOverrides: overrides,
    conferenceForMerge: workspace.conference,
    resultsForPdfHint: pdfHint,
  });
  const scoredById = new Map(allScored.map(r => [r.id, r]));
  const events = sortEventsByMeetOrder(Array.from(new Set(allResults.map(r => r.event))));

  // Loaded-meet event labels (from the PDF result rows) drive visibility: any
  // canonical-only label that never matched a real meet event is hidden.
  const genderPdfResults = gender === Gender.MEN ? menResults : womenResults;
  const visibleEvents = computeVisibleEvents(events, allResults, genderPdfResults, scoringSettings);

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
    visibleEvents,
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
