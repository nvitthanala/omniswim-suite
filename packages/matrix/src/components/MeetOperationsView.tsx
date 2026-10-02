/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { assignTeamLineStyles, isRelayResult } from '@omniswim/core/lib/utils';
import { aggregateSwimmerMeetPoints, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import { buildMeetReconciliationSummary } from '@omniswim/core/lib/meetReconciliation';
import type { PrelimsDeltaTimelinePoint, PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import { buildMeetMomentumChartDataFromLookup, buildPrelimsOverUnderByEntryKey } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { MeetOpsLoadStep } from './MeetOpsLoadStep';
import { MeetOpsScoreStep } from './MeetOpsScoreStep';
import { MeetOpsAnalyzeStep } from './MeetOpsAnalyzeStep';
import { MeetOpsStandingsStep } from './MeetOpsStandingsStep';

type Props = {
  activeStep: 'load' | 'score' | 'standings' | 'analyze';
  workspace: Workspace;
  workspaceMeetSources: Workspace[];
  onCopyMeetFromWorkspace: (sourceId: string) => void;
  gender: Gender;
  scoringBundle: ScoringBundle;
  baselineBundle: ScoringBundle;
  prelimsProjectedBundle: ScoringBundle;
  psychProjectedBundle: ScoringBundle;
  baselineByTeam: Map<string, number>;
  prelimsByTeam: Map<string, number>;
  psychByTeam: Map<string, number>;
  prelimsDeltaTimeline: PrelimsDeltaTimelinePoint[];
  psychDeltaTimeline: PrelimsDeltaTimelinePoint[];
  showPrelimsPerformance: boolean;
  showPsychPerformance: boolean;
  prelimsOuByEntry: Map<string, PrelimsOverUnderEntry>;
  psychOuByEntry: Map<string, PsychOverUnderEntry>;
  scoringSettings: ScoringSettings;
  suggestedPresetId: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  whatIfMode: boolean;
  isParsingPdf: boolean;
  isParsingPsychPdf: boolean;
  pdfFormat: string;
  onPdfFormatChange: (format: string) => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPsychFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCancelPdfParse: () => void;
  onCancelPsychPdfParse: () => void;
  /**
   * Opens the shared `SwimCloudCaptureBrowser` (`@omniswim/ui`) in
   * `meet-results` mode — browsing and importing from a capture the
   * extension already fetched. The clipboard path (Track A) is no longer a
   * peer entry point here; it is the browser's own secondary link, offered
   * only when no capture exists yet.
   */
  onBrowseSwimCloudCaptures: () => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  onSaveScoringSettings: (sets: ScoringSettings) => void;
  onScoringViewChange: (view: 'merged' | 'pdf_only') => void;
  onClearSuggestedPreset: () => void;
  scoringRefreshKey: number;
};

export default function MeetOperationsView({
  activeStep,
  workspace,
  workspaceMeetSources,
  onCopyMeetFromWorkspace,
  gender,
  scoringBundle,
  baselineBundle,
  prelimsProjectedBundle,
  psychProjectedBundle: _psychProjectedBundle,
  baselineByTeam,
  prelimsByTeam,
  psychByTeam,
  prelimsDeltaTimeline,
  psychDeltaTimeline: _psychDeltaTimeline,
  showPrelimsPerformance,
  showPsychPerformance,
  prelimsOuByEntry,
  psychOuByEntry,
  scoringSettings,
  suggestedPresetId,
  searchQuery,
  onSearchChange,
  whatIfMode,
  isParsingPdf,
  isParsingPsychPdf,
  pdfFormat,
  onPdfFormatChange,
  onFileUpload,
  onBrowseSwimCloudCaptures,
  onPsychFileUpload,
  onCancelPdfParse,
  onCancelPsychPdfParse,
  onUpdate,
  onRequestDeleteSwimmer,
  onSaveScoringSettings,
  onScoringViewChange,
  onClearSuggestedPreset,
  scoringRefreshKey,
}: Props) {
  const chartTheme = useThemeColors();
  const [analysisView, setAnalysisView] = useState<'diff' | 'prelims'>('diff');
  const [meetMomentumAnchor, setMeetMomentumAnchor] = useState<'prelims' | 'psych'>('prelims');
  const meetFileInputRef = useRef<HTMLInputElement>(null);
  const meetConference = workspace.conference;

  useEffect(() => {
    if (!showPrelimsPerformance && showPsychPerformance) {
      setMeetMomentumAnchor('psych');
    }
  }, [showPrelimsPerformance, showPsychPerformance]);

  const teamsWithLineStyles = useMemo(
    () => assignTeamLineStyles(scoringBundle.sortedTeams, { chartTheme: chartTheme.isDark ? 'dark' : 'light' }),
    // Deliberate: depends on teamStyleSignature, which is `name:points:color`
    // per team (see prelimsProjection.ts), so it changes whenever anything read
    // here changes. sortedTeams is a fresh array on every worker response, so
    // depending on it would rebuild this for identical data every recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoringBundle.teamStyleSignature, chartTheme.isDark]
  );

  const officialLookup = useMemo(() => {
    const teams = teamsWithLineStyles.map(t => t.teamName);
    return buildTeamScoreLookup(teams, officialScoresForGender(workspace.officialTeamScores, gender));
  }, [teamsWithLineStyles, workspace.officialTeamScores, gender]);

  const reconciliationSummary = useMemo(() => {
    const computedTotals = new Map(teamsWithLineStyles.map(t => [t.teamName, t.totalPoints]));
    return buildMeetReconciliationSummary(computedTotals, workspace.officialTeamScores, gender);
  }, [teamsWithLineStyles, workspace.officialTeamScores, gender]);

  const topContributors = useMemo(() => {
    const scored = scoringBundle.allScored;
    const totals = aggregateSwimmerMeetPoints(scored, gender);
    const meta = new Map<string, { name: string; team: string; classYear: string }>();

    for (const r of scored) {
      if (r.isRecruit) continue;
      if (r.gender !== gender) continue;
      if (isRelayResult(r) && r.name === r.team) continue;
      const team = String(r.team ?? '').trim() || 'Unknown';
      const key = scorerRosterKey(team, r.gender ?? gender, r.name);
      if (!meta.has(key)) {
        meta.set(key, { name: r.name, team, classYear: String(r.classYear ?? '') });
      }
    }

    const q = searchQuery.trim().toLowerCase();
    return [...totals.entries()]
      .map(([key, meetPts]) => ({ key, meetPts, ...meta.get(key)! }))
      .filter(row => meta.has(row.key))
      .filter(
        row =>
          !q ||
          row.name.toLowerCase().includes(q) ||
          row.team.toLowerCase().includes(q)
      )
      .sort((a, b) => b.meetPts - a.meetPts || a.name.localeCompare(b.name))
      .slice(0, 10);
  // Deliberate: scoringRefreshKey is a cache-buster. It is not read in the
  // body; bumping it is how a caller forces a recompute.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoringBundle.allScored, gender, searchQuery, scoringRefreshKey]);

  const prelimsOuByEntryLocal = useMemo(
    () =>
      showPrelimsPerformance
        ? buildPrelimsOverUnderByEntryKey(
            baselineBundle.allScored,
            prelimsProjectedBundle.allScored
          )
        : new Map(),
    [showPrelimsPerformance, baselineBundle.allScored, prelimsProjectedBundle.allScored]
  );

  const resolvedPrelimsOuByEntry = prelimsOuByEntry.size > 0 ? prelimsOuByEntry : prelimsOuByEntryLocal;
  const resolvedPsychOuByEntry = psychOuByEntry;

  const { visibleEvents, timelineData } = scoringBundle;
  const timelineChartKey = `timeline-${scoringRefreshKey}-${scoringBundle.teamStyleSignature}`;

  const prelimsDeltaByLabel = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const pt of prelimsDeltaTimeline) {
      map.set(pt.name, pt.baselineDelta);
    }
    return map;
  }, [prelimsDeltaTimeline]);

  const psychMomentumHasData = resolvedPsychOuByEntry.size > 0;
  const prelimsMomentumHasData = resolvedPrelimsOuByEntry.size > 0;

  const meetMomentumData = useMemo(() => {
    const teamNames = teamsWithLineStyles.map(t => t.teamName);
    if (meetMomentumAnchor === 'psych' && showPsychPerformance) {
      if (!psychMomentumHasData) return [];
      return buildMeetMomentumChartDataFromLookup(teamNames, resolvedPsychOuByEntry, visibleEvents);
    }
    if (showPrelimsPerformance) {
      if (!prelimsMomentumHasData) return [];
      return buildMeetMomentumChartDataFromLookup(teamNames, resolvedPrelimsOuByEntry, visibleEvents);
    }
    return [];
  }, [
    meetMomentumAnchor,
    showPrelimsPerformance,
    showPsychPerformance,
    psychMomentumHasData,
    prelimsMomentumHasData,
    resolvedPrelimsOuByEntry,
    resolvedPsychOuByEntry,
    teamsWithLineStyles,
    visibleEvents,
  ]);

  const momentumEmptyMessage =
    meetMomentumAnchor === 'psych' && showPsychPerformance && !psychMomentumHasData
      ? 'No psych momentum for this gender — team names on the psych sheet may not match meet results yet.'
      : meetMomentumAnchor === 'prelims' && showPrelimsPerformance && !prelimsMomentumHasData
        ? 'No prelims momentum — meet results need prelims times for scored events.'
        : undefined;

  return (
    <div className="flex flex-col gap-6">
      {activeStep === 'score' ? (
        <MeetOpsScoreStep
          scoringSettings={scoringSettings}
          suggestedPresetId={suggestedPresetId}
          onSaveScoringSettings={onSaveScoringSettings}
          onClearSuggestedPreset={onClearSuggestedPreset}
          scoringView={workspace.scoringView}
          onScoringViewChange={onScoringViewChange}
          conference={workspace.conference}
          officialLookup={officialLookup}
          teamsWithLineStyles={teamsWithLineStyles}
        />
      ) : null}

      <div className="space-y-6 min-w-0">
        {activeStep === 'load' ? (
          <MeetOpsLoadStep
            workspace={workspace}
            pdfFormat={pdfFormat}
            onPdfFormatChange={onPdfFormatChange}
            workspaceMeetSources={workspaceMeetSources}
            onCopyMeetFromWorkspace={onCopyMeetFromWorkspace}
            isParsingPdf={isParsingPdf}
            isParsingPsychPdf={isParsingPsychPdf}
            onFileUpload={onFileUpload}
            onPsychFileUpload={onPsychFileUpload}
            onCancelPdfParse={onCancelPdfParse}
            onCancelPsychPdfParse={onCancelPsychPdfParse}
            onBrowseSwimCloudCaptures={onBrowseSwimCloudCaptures}
            meetFileInputRef={meetFileInputRef}
          />
        ) : null}

        {activeStep === 'analyze' ? (
          <MeetOpsAnalyzeStep
            chartTheme={chartTheme}
            showPrelimsPerformance={showPrelimsPerformance}
            showPsychPerformance={showPsychPerformance}
            timelineData={timelineData}
            timelineChartKey={timelineChartKey}
            teamsWithLineStyles={teamsWithLineStyles}
            prelimsDeltaByLabel={prelimsDeltaByLabel}
            meetMomentumAnchor={meetMomentumAnchor}
            onMeetMomentumAnchorChange={setMeetMomentumAnchor}
            meetMomentumData={meetMomentumData}
            momentumEmptyMessage={momentumEmptyMessage}
            analysisView={analysisView}
            onAnalysisViewChange={setAnalysisView}
            baselineBundle={baselineBundle}
            prelimsProjectedBundle={prelimsProjectedBundle}
            searchQuery={searchQuery}
          />
        ) : null}

        {activeStep === 'standings' ? (
          <MeetOpsStandingsStep
            reconciliationSummary={reconciliationSummary}
            scoringSettings={scoringSettings}
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
            teamsWithLineStyles={teamsWithLineStyles}
            gender={gender}
            visibleEvents={visibleEvents}
            meetConference={meetConference}
            officialLookup={officialLookup}
            baselineByTeam={baselineByTeam}
            prelimsByTeam={prelimsByTeam}
            psychByTeam={psychByTeam}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={resolvedPrelimsOuByEntry}
            showPsychPerformance={showPsychPerformance}
            psychOuByEntry={resolvedPsychOuByEntry}
            eventThrough={workspace.officialTeamScores?.eventThrough}
            onRequestDeleteSwimmer={onRequestDeleteSwimmer}
            scoringRefreshKey={scoringRefreshKey}
            onUpdateTime={
              whatIfMode
                ? (id, newTime) => {
                    const field = gender === Gender.MEN ? 'menResults' : 'womenResults';
                    const arr = workspace[field] ?? [];
                    const newArr = arr.map(r => (r.id === id ? { ...r, time: newTime } : r));
                    onUpdate({ [field]: newArr });
                  }
                : undefined
            }
            topContributors={topContributors}
          />
        ) : null}
      </div>
    </div>
  );
}
