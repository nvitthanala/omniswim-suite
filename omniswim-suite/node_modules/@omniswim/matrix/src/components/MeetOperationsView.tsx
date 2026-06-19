/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Users, Plus, TrendingUp, Search, X, GitCompareArrows, ListTree } from 'lucide-react';
import { motion } from 'motion/react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Gender, Recruit, ScoringSettings, TeamScore, Workspace } from '@omniswim/core/types';
import { assignTeamLineStyles, isRelayResult } from '@omniswim/core/lib/utils';
import { aggregateSwimmerMeetPoints, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import TeamCard from './TeamCard';
import ScoringSettingsPanel from './ScoringSettingsPanel';
import MeetDiffTable from './MeetDiffTable';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';

type TimelineTooltipContentProps = {
  active?: boolean;
  payload?: ReadonlyArray<{ name?: string; dataKey?: string; value?: unknown; color?: string }>;
  label?: string;
  teamsWithLineStyles: TeamScore[];
};

function TimelineTooltipContent({ active, payload, label, teamsWithLineStyles }: TimelineTooltipContentProps) {
  if (!active || !payload?.length) return null;
  const dashByTeam = Object.fromEntries(teamsWithLineStyles.map(t => [t.teamName, t.strokeDasharray]));
  const rows = [...payload]
    .map(p => ({
      name: String(p.name ?? p.dataKey ?? ''),
      value: typeof p.value === 'number' ? p.value : Number(p.value),
      color: String(p.color ?? ''),
      strokeDasharray: dashByTeam[String(p.name ?? p.dataKey ?? '')] as string | undefined,
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
              <span className="text-theme-secondary text-ui-micro text-right tabular-nums shrink-0">
                {gapBelow != null && gapBelow > 0 ? `+${gapBelow.toFixed(1)}` : index === rows.length - 1 ? '—' : ''}
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
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  baselineBundle: ScoringBundle;
  baselineByTeam: Map<string, number>;
  scoringSettings: ScoringSettings;
  suggestedPresetId: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  whatIfMode: boolean;
  isParsingPdf: boolean;
  pdfFormat: string;
  onPdfFormatChange: (format: string) => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCancelPdfParse: () => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  onSaveScoringSettings: (sets: ScoringSettings) => void;
  onClearSuggestedPreset: () => void;
  scoringRefreshKey: number;
};

export default function MeetOperationsView({
  workspace,
  gender,
  scoringBundle,
  baselineBundle,
  baselineByTeam,
  scoringSettings,
  suggestedPresetId,
  searchQuery,
  onSearchChange,
  whatIfMode,
  isParsingPdf,
  pdfFormat,
  onPdfFormatChange,
  onFileUpload,
  onCancelPdfParse,
  onUpdate,
  onRequestDeleteSwimmer,
  onSaveScoringSettings,
  onClearSuggestedPreset,
  scoringRefreshKey,
}: Props) {
  const chartTheme = useThemeColors();
  const [matrixView, setMatrixView] = useState<'standings' | 'diff'>('standings');
  const meetConference = workspace.conference;

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

  const { events, timelineData } = scoringBundle;

  return (
    <div className="flex flex-col gap-6">
      <ScoringSettingsPanel
        collapsible
        defaultOpen={false}
        settings={scoringSettings}
        suggestedPresetId={suggestedPresetId}
        onSave={sets => {
          onSaveScoringSettings(sets);
          onClearSuggestedPreset();
        }}
      />

      <div className="space-y-6 min-w-0">
        <div className="surface-card rounded-lg p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={16} className="text-[var(--text-accent)]" />
            <h3 className="text-[12px] font-bold text-[var(--text-primary)] uppercase tracking-tight">
              Chronological Team Score Timeline
            </h3>
          </div>

          <div className="h-64 w-full surface-overlay p-2 rounded border border-theme-soft">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData}>
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
                  interval="preserveStartEnd"
                />
                <YAxis
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
                  cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 2 }}
                  content={props => (
                    <TimelineTooltipContent
                      active={props.active}
                      label={props.label != null ? String(props.label) : undefined}
                      payload={props.payload as TimelineTooltipContentProps['payload']}
                      teamsWithLineStyles={teamsWithLineStyles}
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
                    isAnimationActive={false}
                    activeDot={{ r: 5, strokeWidth: 0, fill: team.lineColor ?? team.color }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div
            className="mt-3 flex flex-wrap gap-x-4 gap-y-2 justify-center pointer-events-none select-none border-t border-theme-soft pt-3"
            aria-hidden
          >
            {teamsWithLineStyles.map(t => (
              <span
                key={t.teamName}
                className="inline-flex items-center gap-2 text-ui-caption text-theme-secondary font-mono uppercase tracking-tight max-w-[220px]"
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
                <span className="truncate" title={t.teamName}>
                  {t.teamName}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div className="surface-card rounded-lg p-5">
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
              <div className="flex items-center surface-overlay border border-theme-soft rounded px-3 py-1.5 focus-within:border-[var(--text-accent)]/50 transition-colors">
                <Search size={12} className="text-theme-secondary mr-2" />
                <input
                  value={searchQuery}
                  onChange={e => onSearchChange(e.target.value)}
                  placeholder="Filter swimmer or team..."
                  className="bg-transparent border-none outline-none text-[10px] uppercase placeholder:text-theme-secondary text-[var(--text-primary)] w-40"
                />
              </div>
              {isParsingPdf ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 px-3 py-1.5 btn-accent-outline rounded text-[10px] uppercase font-medium">
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                    >
                      <Plus size={12} className="opacity-50" />
                    </motion.div>
                    <span>Parsing PDF...</span>
                    <div className="w-16 h-1 bg-[var(--text-accent)]/20 rounded overflow-hidden ml-2">
                      <motion.div
                        className="h-full bg-[var(--text-accent)]"
                        initial={{ width: '0%' }}
                        animate={{ width: '100%' }}
                        transition={{ duration: 15, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onCancelPdfParse}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded btn-accent-outline text-[10px] uppercase font-medium"
                    title="Cancel PDF parsing"
                  >
                    <X size={12} />
                    <span>Cancel</span>
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 border border-theme-soft rounded p-1">
                  <select
                    value={pdfFormat}
                    onChange={e => onPdfFormatChange(e.target.value)}
                    className="bg-transparent text-[10px] uppercase tracking-widest text-theme-secondary outline-none py-1 pl-2 border-r border-theme-soft pr-2 cursor-pointer"
                    title="PDF Column Format"
                  >
                    <option value="auto">Auto Format</option>
                    <option value="regular">Regular List</option>
                    <option value="divided">Divided (2-Col)</option>
                  </select>
                  <label className="cursor-pointer flex items-center gap-1.5 px-3 py-1 btn-accent-outline rounded-sm text-[10px] uppercase font-medium transition-all">
                    <Plus size={12} />
                    <span>Load PDF</span>
                    <input type="file" className="hidden" accept=".pdf" onChange={onFileUpload} />
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center rounded-md border border-theme-soft surface-overlay p-1">
              <button
                type="button"
                onClick={() => setMatrixView('standings')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors ${
                  matrixView === 'standings'
                    ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                    : 'text-theme-secondary hover:text-[var(--text-primary)]'
                }`}
                title="Show team standings"
              >
                <ListTree size={12} />
                <span>Standings</span>
              </button>
              <button
                type="button"
                onClick={() => setMatrixView('diff')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] uppercase font-medium transition-colors ${
                  matrixView === 'diff'
                    ? 'bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                    : 'text-theme-secondary hover:text-[var(--text-primary)]'
                }`}
                title="Show projected versus baseline score changes"
              >
                <GitCompareArrows size={12} />
                <span>Diff</span>
              </button>
            </div>
            {matrixView === 'diff' ? (
              <p className="text-[10px] uppercase tracking-widest text-theme-secondary">
                Comparing what-if projection against loaded meet baseline
              </p>
            ) : null}
          </div>

          <div className="space-y-4">
            {matrixView === 'diff' ? (
              <MeetDiffTable
                projectedTeams={teamsWithLineStyles}
                baselineTeams={baselineBundle.sortedTeams}
                searchQuery={searchQuery}
              />
            ) : teamsWithLineStyles.length > 0 ? (
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
                    eventsList={events}
                    conference={meetConference}
                    searchQuery={searchQuery}
                    actualScore={officialLookup.get(team.teamName)}
                    baselineScore={baselineByTeam.get(team.teamName)}
                    eventThrough={workspace.officialTeamScores?.eventThrough}
                    onRequestDeleteSwimmer={onRequestDeleteSwimmer}
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
              <div className="p-12 text-center border border-dashed border-theme-soft rounded-lg text-theme-secondary">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
                <p className="text-xs uppercase font-medium tracking-widest">No matrix data persistent</p>
              </div>
            )}
          </div>
        </div>

        <div className="surface-card rounded-lg overflow-hidden">
          <div className="p-4 border-b border-theme-soft surface-overlay">
            <h4 className="text-[10px] font-medium text-theme-secondary uppercase tracking-widest">
              Top Individual Contributors
            </h4>
          </div>
          <table className="w-full text-left border-collapse">
            <thead className="surface-overlay text-[10px] uppercase tracking-widest text-theme-secondary font-medium">
              <tr>
                <th className="p-3">Rank</th>
                <th className="p-3">Athlete Name</th>
                <th className="p-3">Team</th>
                <th className="p-3">Class</th>
                <th className="p-3 text-right">Meet pts</th>
              </tr>
            </thead>
            <tbody className="text-xs font-mono">
              {topContributors.length > 0 ? (
                topContributors.map((row, i) => (
                  <tr key={row.key} className="border-b border-theme-soft theme-hover-row transition-colors">
                    <td className="p-3 text-theme-secondary">{i + 1}</td>
                    <td className="p-3 font-sans font-medium text-[var(--text-primary)]">{row.name}</td>
                    <td className="p-3 text-theme-secondary">{row.team}</td>
                    <td className="p-3">
                      {row.classYear ? (
                        <span className="px-1.5 py-0.5 rounded surface-overlay border border-theme-soft">
                          {row.classYear}
                        </span>
                      ) : (
                        <span className="text-theme-muted">—</span>
                      )}
                    </td>
                    <td
                      className={`p-3 text-right font-medium ${
                        row.meetPts > 0 ? 'text-points-positive' : 'text-theme-secondary'
                      }`}
                    >
                      {row.meetPts.toFixed(1)}
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
      </div>
    </div>
  );
}
