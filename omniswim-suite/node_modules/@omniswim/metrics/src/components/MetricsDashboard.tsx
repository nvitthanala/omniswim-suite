import { BiomechanicsData } from '../types';
import { formatTime, exportToCSV } from '../lib/utils';
import { Download } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';

export function MetricsDashboard({ data }: { data: BiomechanicsData }) {
  const chartTheme = useThemeColors();

  const chartData = data.splits.map((s, i) => {
    const velocity = (s.distance / s.time).toFixed(2);
    return {
      lap: s.lap,
      distance: `${s.distance}m`,
      time: s.time,
      cumulative: data.splits.slice(0, i + 1).reduce((acc, curr) => acc + curr.time, 0),
      velocity: parseFloat(velocity),
    };
  });

  const handleExport = () => {
    exportToCSV(chartData, `omni_swim_splits_${new Date().getTime()}.csv`);
  };

  const tooltipBg = chartTheme.isDark ? 'var(--popover-bg)' : 'var(--surface)';
  const tooltipBorder = chartTheme.isDark ? 'var(--popover-border)' : 'var(--border-soft)';
  const tooltipText = 'var(--text-primary)';

  return (
    <div className="space-y-6 flex flex-col h-full">
      <section>
        <h3 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em] mb-3">
          Performance Metrics
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Avg Velocity"
            value={`${data.avgVelocity.toFixed(2)}`}
            unit="m/s"
            highlightClass="text-[var(--text-accent)]"
          />
          <MetricCard
            label="Fatigue Index"
            value={`${data.fatigueIndex.toFixed(1)}`}
            unit="%"
            highlightClass="text-[var(--color-warning)]"
          />
          <MetricCard label="Stroke Rate" value={`${Math.round(data.strokeRate)}`} unit="s/m" />
          <MetricCard label="Dist. per Stroke" value={`${data.distancePerStroke.toFixed(2)}`} unit="m" />
        </div>
      </section>

      <section className="flex-1 min-h-[250px] flex flex-col">
        <h3 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em] mb-3">
          Velocity Profile
        </h3>
        <div className="bg-[var(--surface-muted)] border border-theme-soft rounded-lg p-5 flex-1 relative overflow-hidden">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorVelocity" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--text-accent)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--text-accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={chartTheme.chartGrid}
                strokeOpacity={0.5}
                vertical={false}
              />
              <XAxis
                dataKey="distance"
                stroke={chartTheme.chartTick}
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis stroke={chartTheme.chartTick} fontSize={10} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: tooltipBg,
                  borderColor: tooltipBorder,
                  borderRadius: '8px',
                  color: tooltipText,
                }}
                itemStyle={{
                  color: tooltipText,
                  fontSize: '12px',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <Area
                type="monotone"
                dataKey="velocity"
                name="Velocity"
                stroke="var(--text-accent)"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorVelocity)"
                dot={{ r: 3, fill: 'var(--text-accent)', strokeWidth: 0 }}
                activeDot={{ r: 5, fill: 'var(--text-accent)', strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="flex flex-col">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em]">
            Split Analytics
          </h3>
          <button
            onClick={handleExport}
            className="text-theme-muted hover:text-[var(--text-primary)] transition-colors flex items-center gap-1 text-ui-micro font-medium"
          >
            <Download className="w-3 h-3" />
            <span>CSV Export</span>
          </button>
        </div>
        <div className="bg-[var(--surface-muted)] rounded-lg border border-theme-soft overflow-hidden flex flex-col font-mono text-ui-caption">
          <div className="grid grid-cols-5 p-3 border-b border-theme-soft text-theme-muted font-bold bg-[var(--surface-strong)]">
            <div>LAP</div>
            <div>DIST</div>
            <div>TIME</div>
            <div>CUM.</div>
            <div>VEL.</div>
          </div>
          <div className="divide-y divide-[var(--border-soft)]">
            {chartData.map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-5 p-3 theme-hover-row text-[var(--text-primary)] transition-colors"
              >
                <div className="text-theme-muted">{row.lap}</div>
                <div>{row.distance}</div>
                <div>{row.time.toFixed(2)}</div>
                <div>{formatTime(row.cumulative)}</div>
                <div className="text-[var(--text-accent)] font-bold">{row.velocity.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em] mb-3">
          Granular Segment Velocity
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="0-Dive Entry"
            value={`${data.diveVelocity.toFixed(2)}`}
            unit="m/s"
            highlightClass="text-[var(--color-success)]"
          />
          <MetricCard label="0-15m Segment" value={`${data.vel0to15m.toFixed(2)}`} unit="m/s" />
          <MetricCard label="15m-Wall" value={`${data.vel15mToWall.toFixed(2)}`} unit="m/s" />
          <MetricCard label="1st Length Avg" value={`${data.firstLengthVel.toFixed(2)}`} unit="m/s" />
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[var(--text-accent)]/10 p-4 rounded-lg border border-[var(--text-accent)]/20 flex justify-between items-center">
          <div>
            <div className="text-ui-micro text-[var(--text-accent)] font-bold uppercase tracking-wider mb-1">
              UW Kick Tempo
            </div>
            <div className="text-xl font-mono text-[var(--text-primary)]">
              {Math.round(data.underwaterKickTempo)}{' '}
              <span className="text-ui-micro opacity-80 text-theme-muted">k/min</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-ui-micro text-[var(--text-accent)] font-bold uppercase tracking-wider mb-1">
              Kick Count
            </div>
            <div className="text-xl font-mono text-[var(--text-primary)]">{data.kicksCount}</div>
          </div>
        </div>

        <div className="bg-[var(--surface-muted)] p-4 rounded-lg border border-theme-soft flex justify-between items-center">
          <div>
            <div className="text-ui-micro text-theme-muted font-bold uppercase tracking-wider mb-1">
              Breakout Dist
            </div>
            <div className="text-xl font-mono text-[var(--text-primary)]">
              {data.breakoutDistance.toFixed(1)}{' '}
              <span className="text-ui-micro opacity-80 text-theme-muted">m</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-ui-micro text-theme-muted font-bold uppercase tracking-wider mb-1">
              Breakout Time
            </div>
            <div className="text-xl font-mono text-[var(--text-primary)]">
              {data.breakoutTime.toFixed(2)}{' '}
              <span className="text-ui-micro opacity-80 text-theme-muted">s</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  unit,
  highlightClass,
}: {
  label: string;
  value: string;
  unit: string;
  highlightClass?: string;
}) {
  return (
    <div className="bg-[var(--surface-muted)] p-4 rounded-lg border border-theme-soft">
      <div className="text-ui-micro text-theme-muted mb-1 uppercase tracking-wider font-bold">{label}</div>
      <div className={`text-2xl font-mono ${highlightClass || 'text-[var(--text-primary)]'}`}>
        {value}
        <span className="text-ui-micro ml-1 opacity-60 text-theme-muted">{unit}</span>
      </div>
    </div>
  );
}
