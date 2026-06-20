/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Users, Plus, TrendingUp, Search, X } from 'lucide-react';
import { motion } from 'motion/react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Gender, ScoringSettings, TeamScore, Workspace } from '@omniswim/core/types';
import { assignTeamLineStyles, isRelayResult } from '@omniswim/core/lib/utils';
import { aggregateSwimmerMeetPoints, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { SectionHeader, SegmentedControl, Toolbar, ToolbarSpacer } from '@omniswim/ui';
import TeamCard from './TeamCard';
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
      <div className="text-[var(--text-accent)] font-bold mb-2 text-ui-label border-b border-theme-soft pb-1">
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
  searchQuery: string;
  onSearchChange: (q: string) => void;
  whatIfMode: boolean;
  onWhatIfModeChange: (value: boolean) => void;
  isParsingPdf: boolean;
  pdfFormat: string;
  onPdfFormatChange: (format: string) => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCancelPdfParse: () => void;
  onUpdate: (patch: Partial<Workspace>) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  scoringRefreshKey: number;
};

export default function MeetOperationsView({
  workspace,
  gender,
  scoringBundle,
  baselineBundle,
  baselineByTeam,
  scoringSettings,
  searchQuery,
  onSearchChange,
  whatIfMode,
  onWhatIfModeChange,
  isParsingPdf,
  pdfFormat,
  onPdfFormatChange,
  onFileUpload,
  onCancelPdfParse,
  onUpdate,
  onRequestDeleteSwimmer,
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
  const showTimelineDots = timelineData.length <= 2;

  const filteredTeams = teamsWithLineStyles.filter(
    t =>
      !searchQuery ||
      t.teamName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      Object.values(t.swimmers).some(s =>
        String(s.name ?? '')
          .toLowerCase()
          .includes(searchQuery.toLowerCase())
      )
  );

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <Toolbar className="panel panel-compact">
        <div className="flex items-center gap-2 flex-1 min-w-[12rem] max-w-sm">
          <Search size={14} className="text-theme-muted shrink-0" />
          <input
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Filter team or swimmer…"
            className="glass-input-compact flex-1 min-w-0 border-0 bg-transparent"
          />
        </div>

        <SegmentedControl
          options={[
            { id: 'standings' as const, label: 'Standings' },
            { id: 'diff' as const, label: 'Diff' },
          ]}
          value={matrixView}
          onChange={setMatrixView}
        />

        <label className="flex items-center gap-2 text-ui-caption text-theme-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={whatIfMode}
            onChange={e => onWhatIfModeChange(e.target.checked)}
            className="rounded border-theme-soft"
          />
          What-if mode
        </label>

        <ToolbarSpacer />

        {isParsingPdf ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 btn-accent-outline rounded text-ui-caption">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              >
                <Plus size={12} className="opacity-50" />
              </motion.div>
              <span>Parsing PDF…</span>
            </div>
            <button type="button" onClick={onCancelPdfParse} className="btn-ghost text-ui-caption">
              <X size={12} />
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={pdfFormat}
              onChange={e => onPdfFormatChange(e.target.value)}
              className="glass-input-compact"
              title="PDF column format"
            >
              <option value="auto">Auto format</option>
              <option value="regular">Regular list</option>
              <option value="divided">Divided (2-col)</option>
            </select>
            <label className="btn-secondary text-ui-caption cursor-pointer flex items-center gap-1.5">
              <Plus size={12} />
              Load meet PDF
              <input type="file" className="hidden" accept=".pdf" onChange={onFileUpload} />
            </label>
          </div>
        )}
      </Toolbar>

      <div className="panel">
        <SectionHeader
          title="Team standings"
          subtitle={`Projected totals (${scoringSettings.scoringPoints.slice(0, 3).join('-')}… scoring)`}
        />

        {matrixView === 'diff' ? (
          <>
            <p className="text-ui-caption text-theme-muted mb-4">
              Comparing what-if projection against loaded meet baseline
            </p>
            <MeetDiffTable
              projectedTeams={teamsWithLineStyles}
              baselineTeams={baselineBundle.sortedTeams}
              searchQuery={searchQuery}
            />
          </>
        ) : filteredTeams.length > 0 ? (
          <div className="space-y-3">
            {filteredTeams.map((team, index) => (
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
            ))}
          </div>
        ) : (
          <div className="p-12 text-center border border-dashed border-theme-soft rounded-lg text-theme-secondary">
            <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p className="text-ui-body font-medium">No meet loaded yet</p>
            <p className="text-ui-caption text-theme-muted mt-1">Upload a HyTek PDF to see team standings</p>
          </div>
        )}
      </div>

      <div className="panel">
        <SectionHeader
          title="Score timeline"
          subtitle="Cumulative team points through the meet"
          actions={<TrendingUp size={16} className="text-[var(--text-accent)]" />}
        />
        <div className="h-64 w-full rounded-lg bg-[var(--surface-muted)]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={timelineData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
              <XAxis
                dataKey="name"
                axisLine={false}
                tickLine={false}
                tick={{
                  fill: chartTheme.chartTick,
                  fontSize: 10,
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
                  fontFamily: 'JetBrains Mono',
                }}
              />
              <Tooltip
                cursor={{
                  stroke: chartTheme.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.08)',
                  strokeWidth: 2,
                }}
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
                  dot={
                    showTimelineDots
                      ? { r: 4, fill: team.lineColor ?? team.color, strokeWidth: 0 }
                      : false
                  }
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
              className="inline-flex items-center gap-2 text-ui-caption text-theme-secondary font-mono max-w-[220px]"
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

      <div className="panel panel-compact overflow-hidden p-0">
        <div className="px-5 py-4 border-b border-theme-soft">
          <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Top individual contributors</h4>
        </div>
        <table className="w-full text-left border-collapse">
          <thead className="text-ui-caption text-theme-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Rank</th>
              <th className="px-4 py-2.5 font-medium">Athlete</th>
              <th className="px-4 py-2.5 font-medium">Team</th>
              <th className="px-4 py-2.5 font-medium">Class</th>
              <th className="px-4 py-2.5 font-medium text-right">Meet pts</th>
            </tr>
          </thead>
          <tbody className="text-ui-caption font-mono tabular-nums">
            {topContributors.length > 0 ? (
              topContributors.map((row, i) => (
                <tr key={row.key} className="border-t border-theme-soft theme-hover-row transition-colors">
                  <td className="px-4 py-2.5 text-theme-secondary">{i + 1}</td>
                  <td className="px-4 py-2.5 font-sans font-medium text-[var(--text-primary)]">{row.name}</td>
                  <td className="px-4 py-2.5 text-theme-secondary">{row.team}</td>
                  <td className="px-4 py-2.5">
                    {row.classYear ? (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--surface-muted)] border border-theme-soft">
                        {row.classYear}
                      </span>
                    ) : (
                      <span className="text-theme-muted">—</span>
                    )}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right font-medium ${
                      row.meetPts > 0 ? 'text-points-positive' : 'text-theme-secondary'
                    }`}
                  >
                    {row.meetPts.toFixed(1)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-theme-muted text-ui-body">
                  No athlete data in current meet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
