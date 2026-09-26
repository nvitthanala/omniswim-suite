/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure scoring engine extracted from useWorkspaceScoring so it can run either
 * on the main thread (synchronous fallback) or inside a Web Worker.
 */
import { Gender, SwimmerResult, TeamScore, Workspace } from '../types';
import { buildCategorizedScoringInputs, calculatePoints } from './utils';
import { mergeScoringSettings } from './scoringDefaults';
import { computeVisibleEvents } from './eventIdentity';
import { aggregateTeamScoring } from './scoringBundleAggregation';
import { buildPrelimsProjectedBundle } from './prelimsProjection';
import { buildPsychProjectedBundle } from './psychProjection';
import { buildWhatIfResults } from './whatIfProjection';
import { getSourceResults } from './meetSource';
import { buildAliasResolver } from './athleteAliases';
import type { CatalogTeamRoster } from './rosterCatalog';
import { catalogEventOrderByStrength } from './eventStrength';

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
  /** Optional long-lived Team Roster Catalog: opt-in events injected per
   *  athlete, strongest event first (place in the loaded meet, then distance
   *  to the division cut, then SCY seconds), capped to entry limits. */
  rosterCatalog?: CatalogTeamRoster;
};

export function buildScoringBundle({
  workspace,
  gender,
  removeSeniors,
  applyWhatIf,
  scorerRosterOverrides,
  rosterCatalog,
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
  // Built from the real workspace: the what-if copy below replaces its results.
  const eventOrder = rosterCatalog
    ? catalogEventOrderByStrength({ workspace, gender, team: rosterCatalog.team.name })
    : undefined;

  if (applyWhatIf) {
    const base = buildWhatIfResults({ workspace, gender, removeSeniors });
    allResults = rosterCatalog
      ? buildCategorizedScoringInputs({
          workspace: { ...workspace, menResults: base, womenResults: gender === Gender.WOMEN ? base : [] },
          gender,
          rosterCatalog,
          eventOrder,
        })
      : base;
  } else {
    allResults = rosterCatalog
      ? buildCategorizedScoringInputs({ workspace, gender, rosterCatalog, eventOrder })
      : currentResults;
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
    // The meet's own scoring boundary, from the PDF "Team Rankings - Through
    // Event N" line. Keeps post-meet extra sessions out of the team totals even
    // when the host left "Time Trial" off the event name.
    scoredEventNumberMax: workspace.officialTeamScores?.eventThrough,
  });
  const agg = aggregateTeamScoring(allResults, allScored);

  // Loaded-meet event labels (from the PDF result rows) drive visibility: any
  // canonical-only label that never matched a real meet event is hidden.
  const genderPdfResults = gender === Gender.MEN ? menResults : womenResults;
  const visibleEvents = computeVisibleEvents(agg.events, allResults, genderPdfResults, scoringSettings);

  return {
    allResults,
    allScored,
    events: agg.events,
    visibleEvents,
    sortedTeams: agg.sortedTeams,
    timelineData: agg.timelineData,
    teamStyleSignature: agg.teamStyleSignature,
  };
}

/** Build both projected (what-if) and baseline bundles in one pass. */
export function buildScoringSnapshot(
  workspace: Workspace,
  gender: Gender,
  removeSeniors: boolean,
  rosterCatalog?: CatalogTeamRoster
) {
  const projected = buildScoringBundle({
    workspace,
    gender,
    removeSeniors,
    applyWhatIf: true,
    scorerRosterOverrides: workspace.scorerRosterOverrides,
    rosterCatalog,
  });
  const baseline = buildScoringBundle({
    workspace,
    gender,
    removeSeniors: false,
    applyWhatIf: false,
    scorerRosterOverrides: [],
    rosterCatalog,
  });
  const prelimsProjected = buildPrelimsProjectedBundle({ workspace, gender });
  const psychProjected = buildPsychProjectedBundle({ workspace, gender });
  return { projected, baseline, prelimsProjected, psychProjected };
}
