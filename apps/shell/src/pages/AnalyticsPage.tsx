import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, BarChart3, Download } from 'lucide-react';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { buildSeasonTrends, defaultSeasonTeam } from '@omniswim/core/lib/seasonAnalytics';
import { isTheoreticalMeet } from '@omniswim/core/lib/theoreticalMeetLabel';
import { useThemeColors, type ThemeColors } from '@omniswim/core/lib/useThemeColors';
import { ChartFrame, ChartShell, EmptyState, TeamSelect } from '@omniswim/ui';
import {
  describeTeamScoreSelection,
  describeUnreadablePointRows,
  describeWorkspacesWithoutScore,
  requestedSeasonTeam,
  teamTrendRows,
} from '../lib/seasonTrendView';

type SeriesKey = 'men' | 'women';

/**
 * The two series differ without color: men are a solid line with round
 * markers, women a dashed line with square markers.
 */
const SERIES: Record<SeriesKey, { label: string; dash: string | undefined; shape: 'circle' | 'square'; words: string }> = {
  men: { label: 'Men', dash: undefined, shape: 'circle', words: 'solid line, round markers' },
  women: { label: 'Women', dash: '6 4', shape: 'square', words: 'dashed line, square markers' },
};

const MARKER_SIZE = 4;

type DotProps = { cx?: number; cy?: number; stroke?: string; index?: number };

/** A recharts `dot` renderer. A null point has no coordinates, so it draws nothing: the gap stays a gap. */
function markerFor(shape: 'circle' | 'square') {
  return function Marker({ cx, cy, stroke, index }: DotProps) {
    if (cx == null || cy == null) return <g key={`gap-${index}`} />;
    return shape === 'circle' ? (
      <circle key={`pt-${index}`} cx={cx} cy={cy} r={MARKER_SIZE} fill={stroke} stroke={stroke} />
    ) : (
      <rect
        key={`pt-${index}`}
        x={cx - MARKER_SIZE}
        y={cy - MARKER_SIZE}
        width={MARKER_SIZE * 2}
        height={MARKER_SIZE * 2}
        fill={stroke}
        stroke={stroke}
      />
    );
  };
}

const circleMarker = markerFor('circle');
const squareMarker = markerFor('square');

function readCssColor(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Series colors from theme tokens, re-read when the theme changes. */
function useSeriesColors(chartTheme: ThemeColors): Record<SeriesKey, string> {
  return useMemo(
    () => ({ men: chartTheme.accent, women: readCssColor('--color-success') || chartTheme.accent }),
    [chartTheme]
  );
}

function SeriesLegend({ colors }: { colors: Record<SeriesKey, string> }) {
  return (
    <ul aria-label="Chart legend" className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-ui-caption text-theme-secondary">
      {(Object.keys(SERIES) as SeriesKey[]).map(key => {
        const s = SERIES[key];
        return (
          <li key={key} className="flex items-center gap-2" data-series={key}>
            <svg width="32" height="12" aria-hidden="true">
              <line x1="0" y1="6" x2="32" y2="6" stroke={colors[key]} strokeWidth="2" strokeDasharray={s.dash} />
              {s.shape === 'circle' ? (
                <circle cx="16" cy="6" r={MARKER_SIZE} fill={colors[key]} />
              ) : (
                <rect x={16 - MARKER_SIZE} y={6 - MARKER_SIZE} width={MARKER_SIZE * 2} height={MARKER_SIZE * 2} fill={colors[key]} />
              )}
            </svg>
            <span className="font-medium text-[var(--text-primary)]">{s.label}</span>
            <span className="text-theme-muted">{s.words}</span>
          </li>
        );
      })}
    </ul>
  );
}

function MatrixLink({ children }: { children: string }) {
  return (
    <Link to="/matrix" className="text-[var(--text-accent)] font-medium hover:underline">
      {children}
    </Link>
  );
}

export default function AnalyticsPage() {
  const { workspaces, activeWorkspace } = useSuiteWorkspace();
  const chartTheme = useThemeColors();
  const seriesColors = useSeriesColors(chartTheme);
  // The user's pick, kept apart from the default. The default is read on every
  // render so a workspace that loads after first paint still sets it.
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const requestedTeam = requestedSeasonTeam(pickedTeam, defaultSeasonTeam(activeWorkspace));

  const trends = useMemo(
    () => buildSeasonTrends(workspaces, { team: requestedTeam }),
    [workspaces, requestedTeam]
  );
  const chartData = useMemo(() => teamTrendRows(trends.teamScoreTrends), [trends.teamScoreTrends]);
  const meetWorkspaceCount = useMemo(
    () => workspaces.filter(ws => !isTheoreticalMeet(ws)).length,
    [workspaces]
  );

  const selectionSentence = describeTeamScoreSelection(trends, requestedTeam);
  const unreadableNote = describeUnreadablePointRows(trends.unreadablePointRows);
  const missingNote = describeWorkspacesWithoutScore(meetWorkspaceCount, trends.teamScoreTrends.length);
  const needsMatrixData = trends.teamScoreSelection === 'no-teams' || (trends.teamScoreSelection === 'chosen' && chartData.length === 0);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link to="/" className="text-ui-caption text-theme-muted hover:text-[var(--text-accent)] flex items-center gap-1 mb-2">
            <ArrowLeft size={14} /> Home
          </Link>
          <h1 className="text-2xl font-black text-[var(--text-primary)]">Season analytics</h1>
          <p className="text-ui-caption text-theme-muted mt-1">
            Trends across {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}. A workspace is one saved
            meet or roster. This page compares them over the season.
          </p>
        </div>
        {activeWorkspace ? (
          <a
            href={`/api/workspaces/${activeWorkspace.id}/report`}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary px-4 py-2 rounded-lg text-ui-caption font-bold flex items-center gap-2"
          >
            <Download size={14} /> Export report
          </a>
        ) : null}
      </div>

      <div className="panel p-5 mb-6">
        <h2 className="text-ui-label font-bold text-[var(--text-primary)] mb-1">Team score by meet</h2>
        <p className="text-ui-caption text-theme-muted mb-4">
          Team score is the points a team earned at one meet. It comes from the meet's published team scores when the
          meet has them. Otherwise it is added up from that team's own results.
        </p>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label htmlFor="season-team" className="text-ui-caption font-medium text-theme-secondary">
            Team
          </label>
          <TeamSelect
            id="season-team"
            teams={trends.availableTeams}
            value={trends.team ?? ''}
            onChange={event => setPickedTeam(event.target.value || null)}
            placeholder="Choose a team…"
            disabled={trends.availableTeams.length === 0}
            className="glass-input rounded-lg py-1.5 px-2 text-ui-caption min-w-[14rem]"
          />
        </div>

        <p role="status" className="text-ui-caption text-theme-secondary" data-testid="season-team-sentence">
          {selectionSentence}
        </p>
        {unreadableNote ? (
          <p className="text-ui-caption text-warning mt-1" data-testid="season-unreadable-rows">
            {unreadableNote}
          </p>
        ) : null}
        {missingNote ? (
          <p className="text-ui-caption text-theme-muted mt-1" data-testid="season-missing-workspaces">
            {missingNote}
          </p>
        ) : null}

        {chartData.length > 0 ? (
          <div className="mt-4">
            <ChartShell size="md">
              {({ width, height }) => (
                <ChartFrame width={width} height={height}>
                  <LineChart
                    key={`season-${trends.team}-${chartData.length}`}
                    width={Math.floor(width)}
                    height={Math.floor(height)}
                    responsive={false}
                    data={chartData}
                    margin={{ top: 8, right: 12, left: 4, bottom: 20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: chartTheme.chartTick, fontSize: 11 }}
                      stroke={chartTheme.chartTick}
                    />
                    <YAxis width={48} tick={{ fill: chartTheme.chartTick, fontSize: 11 }} stroke={chartTheme.chartTick} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--popover-bg)',
                        borderColor: 'var(--popover-border)',
                        borderRadius: '8px',
                        color: 'var(--text-primary)',
                      }}
                      itemStyle={{ color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                    />
                    {/* connectNulls is off: a gender the team did not enter in a meet is a gap, not a line through 0. */}
                    <Line
                      type="monotone"
                      dataKey="men"
                      stroke={seriesColors.men}
                      name={SERIES.men.label}
                      strokeWidth={2}
                      strokeDasharray={SERIES.men.dash}
                      dot={circleMarker}
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="women"
                      stroke={seriesColors.women}
                      name={SERIES.women.label}
                      strokeWidth={2}
                      strokeDasharray={SERIES.women.dash}
                      dot={squareMarker}
                      connectNulls={false}
                    />
                  </LineChart>
                </ChartFrame>
              )}
            </ChartShell>
            <SeriesLegend colors={seriesColors} />
          </div>
        ) : needsMatrixData ? (
          <EmptyState
            className="mt-4"
            icon={<BarChart3 size={24} />}
            eyebrow="Nothing to chart yet"
            title="Load a meet to see a team's score by meet"
            description="Season analytics reads the meets you have loaded. Open Matrix, load a meet results PDF, and come back to see how a team's score changes from meet to meet."
            secondaryAction={
              <Link to="/matrix" className="btn-secondary px-4 py-2 rounded-lg text-ui-caption font-bold inline-block">
                Open Matrix
              </Link>
            }
          />
        ) : (
          <p className="mt-4 text-ui-caption text-theme-muted">Choose a team above to see its score at each meet.</p>
        )}
      </div>

      <div className="panel p-5">
        <h2 className="text-ui-label font-bold text-[var(--text-primary)] mb-1">Swimmer bests</h2>
        <p className="text-ui-caption text-theme-muted mb-4">
          Each row is one swimmer in one event and course. Best is the fastest time across your loaded meets (for
          dives, the highest score). Meets counts how many loaded meets include that swim.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-ui-caption">
            <thead>
              <tr className="text-theme-muted border-b border-theme-soft">
                <th className="text-left py-2 pr-4">Swimmer</th>
                <th className="text-left py-2 pr-4">Event</th>
                <th className="text-left py-2 pr-4">Course</th>
                <th className="text-left py-2 pr-4">Best</th>
                <th className="text-left py-2">Meets</th>
              </tr>
            </thead>
            <tbody>
              {trends.swimmerTrends.slice(0, 40).map(t => (
                <tr key={`${t.name}-${t.event}-${t.course}`} className="border-b border-theme-soft/50">
                  <td className="py-2 pr-4 font-medium">{t.name}</td>
                  <td className="py-2 pr-4 text-theme-muted">{t.event}</td>
                  <td className="py-2 pr-4 text-theme-muted">{t.course === 'METRIC_UNSPECIFIED' ? 'Meters' : t.course}</td>
                  <td className="py-2 pr-4 font-mono tabular-nums text-[var(--text-accent)]">{t.bestTime}</td>
                  <td className="py-2 text-theme-muted">{t.meetCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trends.swimmerTrends.length === 0 ? (
            <p className="text-theme-muted py-6 text-center">
              No swimmer times yet. <MatrixLink>Load a meet in Matrix</MatrixLink> to see them here.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
