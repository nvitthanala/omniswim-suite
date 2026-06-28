import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, Download } from 'lucide-react';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { buildSeasonTrends } from '@omniswim/core/lib/seasonAnalytics';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { ChartShell } from '@omniswim/ui';

export default function AnalyticsPage() {
  const { workspaces, activeWorkspace } = useSuiteWorkspace();
  const chartTheme = useThemeColors();
  const trends = useMemo(() => buildSeasonTrends(workspaces), [workspaces]);
  const chartData = trends.teamScoreTrends.map(t => ({
    name: t.meetLabel.length > 20 ? `${t.meetLabel.slice(0, 18)}…` : t.meetLabel,
    men: t.menTotal,
    women: t.womenTotal,
  }));
  const womenLineColor = chartTheme.isDark ? '#34d399' : '#059669';

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link to="/" className="text-ui-caption text-theme-muted hover:text-[var(--text-accent)] flex items-center gap-1 mb-2">
            <ArrowLeft size={14} /> Home
          </Link>
          <h1 className="text-2xl font-black text-[var(--text-primary)]">Season Analytics</h1>
          <p className="text-ui-caption text-theme-muted mt-1">
            Trends across {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}
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
        <h2 className="text-ui-label font-bold text-[var(--text-primary)] mb-4">Team score trends</h2>
        <ChartShell size="md">
          {({ width, height }) =>
            chartData.length > 0 ? (
            <LineChart
              key={`season-${chartData.length}-${width}x${height}`}
              width={width}
              height={height}
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
                <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: chartTheme.chartTick, fontSize: 11 }}
                  stroke={chartTheme.chartTick}
                />
                <YAxis tick={{ fill: chartTheme.chartTick, fontSize: 11 }} stroke={chartTheme.chartTick} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--popover-bg)',
                    borderColor: 'var(--popover-border)',
                    borderRadius: '8px',
                    color: 'var(--text-primary)',
                  }}
                  itemStyle={{ color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
                <Line type="monotone" dataKey="men" stroke={chartTheme.accent} name="Men" strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="women" stroke={womenLineColor} name="Women" strokeWidth={2} connectNulls />
            </LineChart>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-ui-caption text-theme-muted">
              Load meets in Matrix to see season score trends.
            </div>
          )
          }
        </ChartShell>
      </div>

      <div className="panel p-5">
        <h2 className="text-ui-label font-bold text-[var(--text-primary)] mb-4">Swimmer bests</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-ui-caption">
            <thead>
              <tr className="text-theme-muted border-b border-theme-soft">
                <th className="text-left py-2 pr-4">Swimmer</th>
                <th className="text-left py-2 pr-4">Event</th>
                <th className="text-left py-2 pr-4">Best</th>
                <th className="text-left py-2">Points</th>
              </tr>
            </thead>
            <tbody>
              {trends.swimmerTrends.slice(0, 40).map(t => (
                <tr key={`${t.name}-${t.event}`} className="border-b border-theme-soft/50">
                  <td className="py-2 pr-4 font-medium">{t.name}</td>
                  <td className="py-2 pr-4 text-theme-muted">{t.event}</td>
                  <td className="py-2 pr-4 font-mono tabular-nums text-[var(--text-accent)]">{t.bestTime}</td>
                  <td className="py-2 text-theme-muted">{t.meetCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trends.swimmerTrends.length === 0 ? (
            <p className="text-theme-muted py-6 text-center">Load meets in Matrix to see trends.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}