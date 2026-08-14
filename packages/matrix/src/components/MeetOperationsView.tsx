/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Users, Plus, TrendingUp, Search, X, GitCompareArrows } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ChartFrame, ChartShell, EmptyState } from '@omniswim/ui';
import { Gender, Recruit, ScoringSettings, TeamScore, Workspace } from '@omniswim/core/types';
import { assignTeamLineStyles, isRelayResult } from '@omniswim/core/lib/utils';
import { aggregateSwimmerMeetPoints, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import type { PrelimsDeltaTimelinePoint, PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import { buildMeetMomentumChartDataFromLookup, buildPrelimsOverUnderByEntryKey } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import TeamCard from './TeamCard';
import ScoringSettingsPanel from './ScoringSettingsPanel';
import MeetDiffTable from './MeetDiffTable';
import PrelimsDiffTable from './PrelimsDiffTable';
import MomentumChartCard from './MomentumChartCard';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { AthleteName, PointsValue, TeamName } from './matrixPresentation';

type TimelineTooltipContentProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string; dataKey?: string; value?: unknown; color?: string }>;
  label?: string;
  teamsWithLineStyles: TeamScore[];
  prelimsDeltaByTeam?: Record<string, number>;
};

function TimelineTooltipContent({
  active,
  payload,
  label,
  teamsWithLineStyles,
  prelimsDeltaByTeam,
}: TimelineTooltipContentProps) {
  if (!active || !payload?.length) return null;
  const dashByTeam = Object.fromEntries(teamsWithLineStyles.map(t => [t.teamName, t.strokeDasharray]));
  const rows = [...payload]
    .map(p => ({
      name: String(p.name ?? p.dataKey ?? ''),
      value: typeof p.value === 'number' ? p.value : Number(p.value),
      color: String(p.color ?? ''),
      strokeDasharray: dashByTeam[String(p.name ?? p.dataKey ?? '')] as string | undefined,
      prelimsDelta: prelimsDeltaByTeam?.[String(p.name ?? p.dataKey ?? '')],
    }))
    .filter(r => !Number.isNaN(r.value))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  return (
    <div className="theme-popover rounded-lg p-3 max-w-sm">
      <div className="text-[var(--text-accent)] font-bold mb-2 text-ui-label uppercase tracking-wide border-b border-theme-soft pb-1">
        {label}
      </div>
      <ul className="space-y-1.5 font-mono text-ui-caption">
        {rows.map((r, index) => {
          const teamBelow = rows[index + 1];
          const gapBelow = teamBelow ? r.value - teamBelow.value : null;
          const prelimsOu =
            r.prelimsDelta != null && Math.abs(r.prelimsDelta) > 0.05 ? r.prelimsDelta : null;
          return (
            <li key={r.name} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 text-[var(--text-primary)]">
              <span className="flex items-center gap-2 min-w-0">
                <svg width="22" height="8" className="shrink-0" aria-hidden>
                  <line
                    x1="0"
                    y1="4"
                    x2="22"
                    y2="4"
                    stroke={r.color}
                    strokeWidth="2.5"
                    strokeDasharray={r.strokeDasharray}
                  />
                </svg>
                <span className="truncate font-sans text-ui-body">{r.name}</span>
              </span>
              <span
                className={`text-ui-micro text-right tabular-nums shrink-0 ${
                  prelimsOu != null
                    ? prelimsOu > 0
                      ? 'text-points-positive'
                      : 'text-points-negative'
                    : 'text-theme-secondary'
                }`}
              >
                {prelimsOu != null
                  ? `${prelimsOu > 0 ? '+' : ''}${prelimsOu.toFixed(1)} vs prelims`
                  : gapBelow != null && gapBelow > 0
                    ? `+${gapBelow.toFixed(1)}`
                    : index === rows.length - 1
                      ? '—'
                      : ''}
              </span>
              <span className="text-points-positive font-bold shrink-0 tabular-nums">{r.value.toFixed(1)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
  psychProjectedBundle,
  baselineByTeam,
  prelimsByTeam,
  psychByTeam,
  prelimsDeltaTimeline,
  psychDeltaTimeline,
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
    [scoringBundle.teamStyleSignature, chartTheme.isDark]
  );

  const officialLookup = useMemo(() => {
    const teams = teamsWithLineStyles.map(t => t.teamName);
    return buildTeamScoreLookup(teams, officialScoresForGender(workspace.officialTeamScores, gender));
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
      {activeStep === 'score' ? <>
        <div>
          <h4 className="text-heading-2">Configure scoring model</h4>
          <p className="mt-1 text-ui-body text-theme-secondary">Select a preset or adjust how entries earn points.</p>
        </div>
        <ScoringSettingsPanel
          collapsible
          defaultOpen
          settings={scoringSettings}
          suggestedPresetId={suggestedPresetId}
          onSave={sets => {
            onSaveScoringSettings(sets);
            onClearSuggestedPreset();
          }}
          scoringView={workspace.scoringView ?? 'merged'}
          onScoringViewChange={onScoringViewChange}
        />
        {officialLookup.size > 0 ? (
          <div className="surface-card rounded-xl overflow-hidden">
            <div className="p-4 border-b border-theme-soft surface-overlay"><h4 className="text-ui-label font-medium text-theme-secondary uppercase tracking-widest">Official team scores</h4></div>
            <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3 surface-overlay">
              {teamsWithLineStyles.filter(team => officialLookup.has(team.teamName)).map(team => (
                <div key={team.teamName} className="surface-card px-4 py-3 flex items-center justify-between gap-3"><TeamName name={team.teamName} /><span className="font-mono font-bold text-[var(--text-primary)]">{officialLookup.get(team.teamName)?.toFixed(1)}</span></div>
              ))}
            </div>
          </div>
        ) : null}
      </> : null}

      <div className="space-y-6 min-w-0">
        {activeStep === 'load' ? (
          <div className="space-y-6">
            {!workspace.loadedMeet ? (
              <EmptyState
                icon={<Plus size={24} />}
                eyebrow="Start here"
                title="Load a meet PDF to begin"
                description="Bring in the meet results first, then set the scoring rules and review team standings."
                actionLabel="Load meet PDF"
                onAction={() => meetFileInputRef.current?.click()}
              />
            ) : null}
            <div className="surface-card rounded-xl p-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h3 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Meet files</h3>
                  <p className="text-xs text-theme-secondary">Load results and link a psych sheet for this meet.</p>
                </div>
                {isParsingPdf || isParsingPsychPdf ? (
                  <div className="flex items-center gap-2">
                    <span className="text-ui-caption text-theme-secondary">{isParsingPsychPdf ? 'Parsing psych PDF...' : 'Parsing meet PDF...'}</span>
                    <button type="button" onClick={isParsingPsychPdf ? onCancelPsychPdfParse : onCancelPdfParse} aria-label="Cancel PDF parsing" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded btn-accent-outline text-[10px] uppercase font-medium">
                      <X size={12} /><span>Cancel</span>
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 border border-theme-soft rounded-lg p-1">
                    <label aria-label="Load meet results PDF" className="cursor-pointer flex items-center gap-1.5 px-3 py-1 btn-accent-outline rounded-md text-[10px] uppercase font-medium transition-colors">
                      <Plus size={12} /><span>Load PDF</span><input ref={meetFileInputRef} aria-label="Meet results PDF file" type="file" className="hidden" accept=".pdf" onChange={onFileUpload} />
                    </label>
                    <label aria-label="Link psych sheet PDF" className="cursor-pointer flex items-center gap-1.5 px-3 py-1 border border-theme-soft rounded-md text-[10px] uppercase font-medium text-theme-secondary hover:text-[var(--text-primary)] transition-colors">
                      <Plus size={12} /><span>Link Psych</span><input aria-label="Psych sheet PDF file" type="file" className="hidden" accept=".pdf" onChange={onPsychFileUpload} />
                    </label>
                  </div>
                )}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 text-ui-caption">
                <div className="rounded-lg border border-theme-soft surface-overlay p-3"><span className="text-theme-muted">Meet results</span><p className="mt-1 text-[var(--text-primary)]">{workspace.loadedMeet?.pdfFilename ?? 'No meet PDF loaded'}</p></div>
                <div className="rounded-lg border border-theme-soft surface-overlay p-3"><span className="text-theme-muted">Psych sheet</span><p className="mt-1 text-[var(--text-primary)]">{workspace.loadedPsych?.pdfFilename ?? 'No psych sheet linked'}</p></div>
              </div>
              {workspaceMeetSources.length > 0 ? (
                <div className="mt-4 border-t border-theme-soft pt-4">
                  <label className="block text-ui-caption text-theme-secondary mb-2">Copy a loaded meet from another workspace</label>
                  <select defaultValue="" onChange={event => { if (event.target.value) onCopyMeetFromWorkspace(event.target.value); event.target.value = ''; }} aria-label="Copy meet from another workspace" className="surface-overlay border border-theme-soft rounded-lg px-3 py-2 text-ui-caption text-[var(--text-primary)]">
                    <option value="">Choose a workspace…</option>
                    {workspaceMeetSources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeStep === 'analyze' ? <>
        <div className="surface-card rounded-xl p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={16} className="text-[var(--text-accent)]" />
            <h3 className="text-[12px] font-bold text-[var(--text-primary)] uppercase tracking-tight">
              Chronological Team Score Timeline
            </h3>
            {showPrelimsPerformance ? (
              <p className="text-[10px] text-theme-muted mt-1 normal-case tracking-normal">
                Tooltip middle column shows baseline over/under vs prelims projection at each event.
              </p>
            ) : null}
          </div>

          <ChartShell size="md" className="surface-overlay p-2 rounded-lg border border-theme-soft">
            {({ width, height }) =>
              timelineData.length > 0 ? (
                <ChartFrame width={width} height={height}>
                <LineChart
                  key={timelineChartKey}
                  width={Math.floor(width)}
                  height={Math.floor(height)}
                  responsive={false}
                  data={timelineData}
                  margin={{ top: 8, right: 12, left: 4, bottom: 20 }}
                >
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
                    <XAxis
                      dataKey="name"
                      axisLine={false}
                      tickLine={false}
                      tick={{
                        fill: chartTheme.chartTick,
                        fontSize: 9,
                        fontStyle: 'bold',
                        fontFamily: 'JetBrains Mono',
                      }}
                      // `preserveStartEnd` forces the final tick even when it collides
                      // with its neighbour, which ran the last two event labels together
                      // and clipped the result at the plot edge. Equidistant spacing with
                      // a measured minimum gap keeps them apart.
                      interval="equidistantPreserveStart"
                      minTickGap={24}
                      tickMargin={8}
                    />
                    <YAxis
                      width={48}
                      axisLine={false}
                      tickLine={false}
                      tick={{
                        fill: chartTheme.chartTick,
                        fontSize: 10,
                        fontStyle: 'bold',
                        fontFamily: 'JetBrains Mono',
                      }}
                    />
                    <Tooltip
                      cursor={{ stroke: chartTheme.chartGrid, strokeWidth: 2 }}
                      content={props => (
                        <TimelineTooltipContent
                          active={props.active}
                          label={props.label != null ? String(props.label) : undefined}
                          payload={props.payload as TimelineTooltipContentProps['payload']}
                          teamsWithLineStyles={teamsWithLineStyles}
                          prelimsDeltaByTeam={
                            showPrelimsPerformance && props.label != null
                              ? prelimsDeltaByLabel.get(String(props.label))
                              : undefined
                          }
                        />
                      )}
                    />
                    {teamsWithLineStyles.map(team => (
                      <Line
                        key={team.teamName}
                        type="monotone"
                        dataKey={team.teamName}
                        name={team.teamName}
                        stroke={team.lineColor ?? team.color}
                        strokeWidth={2.5}
                        strokeDasharray={team.strokeDasharray}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                        activeDot={{ r: 5, strokeWidth: 0, fill: team.lineColor ?? team.color }}
                      />
                    ))}
                </LineChart>
                </ChartFrame>
              ) : (
                <div className="flex h-full items-center justify-center text-center text-ui-caption text-theme-muted">
                  Load meet results to see team score progression.
                </div>
              )
            }
          </ChartShell>
          <div
            className="mt-3 flex flex-wrap gap-x-4 gap-y-2 justify-center pointer-events-none select-none border-t border-theme-soft pt-3"
            aria-hidden
          >
            {teamsWithLineStyles.map(t => (
              <span
                key={t.teamName}
                className="inline-flex items-center gap-2 text-ui-caption text-theme-secondary max-w-[220px]"
              >
                <svg width="28" height="10" className="shrink-0 overflow-visible">
                  <line
                    x1="0"
                    y1="5"
                    x2="28"
                    y2="5"
                    stroke={t.lineColor ?? t.color}
                    strokeWidth="2.5"
                    strokeDasharray={t.strokeDasharray}
                  />
                </svg>
                <TeamName name={t.teamName} />
              </span>
            ))}
          </div>
        </div>

        {(showPrelimsPerformance || showPsychPerformance) ? (
          <div className="mb-6">
            {showPrelimsPerformance && showPsychPerformance ? (
              <div className="flex items-center gap-1 mb-2 px-1">
                <button
                  type="button"
                  onClick={() => setMeetMomentumAnchor('prelims')}
                  aria-label="Show meet momentum versus prelims"
                  className={`text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${
                    meetMomentumAnchor === 'prelims'
                      ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                      : 'text-theme-muted hover:text-theme-secondary'
                  }`}
                >
                  vs Prelims
                </button>
                <button
                  type="button"
                  onClick={() => setMeetMomentumAnchor('psych')}
                  aria-label="Show meet momentum versus psych sheet"
                  className={`text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${
                    meetMomentumAnchor === 'psych'
                      ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                      : 'text-theme-muted hover:text-theme-secondary'
                  }`}
                >
                  vs Psych
                </button>
              </div>
            ) : null}
            <MomentumChartCard
              mode="multi"
              title={
                meetMomentumAnchor === 'psych' ? 'Meet Momentum vs Psych' : 'Meet Momentum vs Prelims'
              }
              data={meetMomentumData}
              teams={teamsWithLineStyles}
              size="md"
              emptyMessage={momentumEmptyMessage}
            />
          </div>
        ) : null}
        <div className="surface-card rounded-xl p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">Score differences</h3><p className="text-xs text-theme-secondary">Compare the projection with the loaded meet and prelims.</p></div>
            <div className="inline-flex items-center rounded-md border border-theme-soft surface-overlay p-1">
              <button type="button" onClick={() => setAnalysisView('diff')} aria-label="Show projected versus baseline score differences" aria-pressed={analysisView === 'diff'} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors ${analysisView === 'diff' ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}><GitCompareArrows size={12} /><span>Diff</span></button>
              {showPrelimsPerformance ? <button type="button" onClick={() => setAnalysisView('prelims')} aria-label="Show score differences versus prelims" aria-pressed={analysisView === 'prelims'} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors ${analysisView === 'prelims' ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]' : 'text-theme-secondary hover:text-[var(--text-primary)]'}`}><TrendingUp size={12} /><span>Prelims</span></button> : null}
            </div>
          </div>
          {analysisView === 'prelims' && showPrelimsPerformance ? <PrelimsDiffTable projectedTeams={teamsWithLineStyles} baselineTeams={baselineBundle.sortedTeams} prelimsTeams={prelimsProjectedBundle.sortedTeams} searchQuery={searchQuery} /> : <MeetDiffTable projectedTeams={teamsWithLineStyles} baselineTeams={baselineBundle.sortedTeams} searchQuery={searchQuery} />}
        </div>
        </> : null}

        {activeStep === 'standings' ? (
        <>
        <div className="surface-card rounded-xl p-5">
          <div className="flex justify-between items-end mb-6">
            <div>
              <h3 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">
                Performance Matrix: Overall Standing
              </h3>
              <p className="text-xs text-theme-secondary">
                Projected totals from custom scoring model ({scoringSettings.scoringPoints.slice(0, 3).join('-')}
                ...)
              </p>
            </div>
            <div className="flex items-center gap-3">
              <select value={pdfFormat} onChange={e => onPdfFormatChange(e.target.value)} aria-label="PDF column format" className="surface-overlay border border-theme-soft rounded-lg text-[10px] uppercase tracking-widest text-theme-secondary outline-none py-1.5 px-2 cursor-pointer">
                <option value="auto">Auto Format</option><option value="regular">Regular List</option><option value="divided">Divided (2-Col)</option>
              </select>
              <div className="flex items-center surface-overlay border border-theme-soft rounded-lg px-3 py-1.5 focus-within:border-[var(--text-accent)]/50 transition-colors">
                <Search size={12} className="text-theme-secondary mr-2" />
                <input
                  value={searchQuery}
                  onChange={e => onSearchChange(e.target.value)}
                  placeholder="Filter swimmer or team..."
                  aria-label="Filter swimmers or teams"
                  className="bg-transparent border-none outline-none text-[10px] uppercase placeholder:text-theme-secondary text-[var(--text-primary)] w-40"
                />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {teamsWithLineStyles.length > 0 ? (
              teamsWithLineStyles
                .filter(
                  t =>
                    !searchQuery ||
                    t.teamName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    Object.values(t.swimmers).some(s =>
                      String(s.name ?? '')
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase())
                    )
                )
                .map((team, index) => (
                  <TeamCard
                    key={team.teamName}
                    team={team}
                    index={index}
                    gender={gender}
                    eventsList={visibleEvents}
                    conference={meetConference}
                    searchQuery={searchQuery}
                    actualScore={officialLookup.get(team.teamName)}
                    baselineScore={baselineByTeam.get(team.teamName)}
                    prelimsProjectedScore={prelimsByTeam.get(team.teamName)}
                    baselineOverUnder={
                      prelimsByTeam.has(team.teamName)
                        ? (baselineByTeam.get(team.teamName) ?? 0) -
                          (prelimsByTeam.get(team.teamName) ?? 0)
                        : undefined
                    }
                    projectedOverUnder={
                      prelimsByTeam.has(team.teamName)
                        ? team.totalPoints - (prelimsByTeam.get(team.teamName) ?? 0)
                        : undefined
                    }
                    showPrelimsPerformance={showPrelimsPerformance}
                    prelimsOuByEntry={resolvedPrelimsOuByEntry}
                    showPsychPerformance={showPsychPerformance}
                    psychOuByEntry={resolvedPsychOuByEntry}
                    psychProjectedScore={psychByTeam.get(team.teamName)}
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
                  />
                ))
            ) : (
              <div className="p-12 text-center border border-dashed border-theme-soft rounded-xl text-theme-secondary">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p className="text-xs uppercase font-medium tracking-widest">No matrix data persistent</p>
              </div>
            )}
          </div>
        </div>

        <div className="surface-card rounded-xl overflow-hidden">
          <div className="p-4 border-b border-theme-soft surface-overlay">
            <h4 className="text-[10px] font-medium text-theme-secondary uppercase tracking-widest">
              Top Individual Contributors
            </h4>
          </div>
          <table className="w-full text-left border-collapse">
            <thead className="surface-overlay text-ui-micro uppercase tracking-widest text-theme-secondary font-medium">
              <tr>
                <th className="p-3">Rank</th>
                <th className="p-3">Athlete Name</th>
                <th className="p-3">Team</th>
                <th className="p-3">Class</th>
                <th className="p-3 text-right">Meet pts</th>
              </tr>
            </thead>
            <tbody>
              {topContributors.length > 0 ? (
                topContributors.map((row, i) => (
                  <tr key={row.key} className="border-b border-theme-soft theme-hover-row transition-colors">
                    <td className="p-3 text-ui-micro font-mono tabular-nums text-theme-muted">{i + 1}</td>
                    <td className="p-3">
                      <AthleteName name={row.name} />
                    </td>
                    <td className="p-3">
                      <TeamName name={row.team} />
                    </td>
                    <td className="p-3">
                      {row.classYear ? (
                        <span className="px-1.5 py-0.5 rounded surface-overlay border border-theme-soft text-ui-micro font-mono">
                          {row.classYear}
                        </span>
                      ) : (
                        <span className="text-theme-muted">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      <PointsValue value={row.meetPts} />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-theme-muted italic">
                    No athlete data available in current matrix
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>
        ) : null}
      </div>
    </div>
  );
}
