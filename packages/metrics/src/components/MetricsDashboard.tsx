import React, { useCallback, useMemo } from 'react';
import { BiomechanicsData } from '../types';
import { formatTime, exportToCSV } from '../lib/utils';
import { Download } from 'lucide-react';
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, AreaChart, Area } from 'recharts';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { ChartShell } from '@omniswim/ui';

function MetricsDashboardComponent({ data }: { data: BiomechanicsData }) {
  const chartTheme = useThemeColors();
  
  const chartData = useMemo(() => data.splits.map((s, i) => {
    // Generate a simulated velocity point for the chart for visual intrigue
    const velocity = (s.distance / s.time).toFixed(2);
    return {
      lap: s.lap,
      distance: `${s.distance}m`,
      time: s.time,
      cumulative: data.splits.slice(0, i + 1).reduce((acc, curr) => acc + curr.time, 0),
      velocity: parseFloat(velocity)
    };
  }), [data.splits]);

  const handleExport = useCallback(() => {
    exportToCSV(chartData, `omni_swim_splits_${new Date().getTime()}.csv`);
  }, [chartData]);

  return (
    <div className="space-y-6 flex flex-col h-full">
      <section>
        <h3 className="text-ui-micro font-bold text-slate-500 uppercase tracking-[0.2em] mb-3">Performance Metrics</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label="Avg Velocity" value={`${data.avgVelocity.toFixed(2)}`} unit="m/s" highlightClass="text-[var(--text-accent)]" />
          <MetricCard label="Fatigue Index" value={`${data.fatigueIndex.toFixed(1)}`} unit="%" highlightClass="text-red-500 dark:text-red-400" />
          <MetricCard label="Stroke Rate" value={`${Math.round(data.strokeRate)}`} unit="s/m" />
          <MetricCard label="Dist. per Stroke" value={`${data.distancePerStroke.toFixed(2)}`} unit="m" />
        </div>
      </section>

      <section className="flex-1 min-h-[250px] flex flex-col">
        <h3 className="text-ui-micro font-bold text-slate-500 uppercase tracking-[0.2em] mb-3">Velocity Profile</h3>
        <ChartShell size="fluid" className="bg-white dark:bg-black/30 border border-slate-200 dark:border-white/5 rounded-lg p-5 overflow-hidden shadow-sm dark:shadow-none transition-colors">
          {({ width, height }) => (
          <AreaChart
            key={`velocity-${chartData.length}`}
            width={width}
            height={height}
            responsive={false}
            data={chartData}
            margin={{ top: 5, right: 0, left: -20, bottom: 0 }}
          >
              <defs>
                <linearGradient id="colorVelocity" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartTheme.accent} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={chartTheme.accent} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
              <XAxis dataKey="distance" stroke={chartTheme.chartTick} fontSize={10} tickLine={false} axisLine={false} />
              <YAxis stroke={chartTheme.chartTick} fontSize={10} tickLine={false} axisLine={false} />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'var(--popover-bg)', 
                  borderColor: 'var(--popover-border)', 
                  borderRadius: '8px',
                  color: 'var(--text-primary)'
                }}
                itemStyle={{ color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
              />
              <Area type="monotone" dataKey="velocity" stroke={chartTheme.accent} strokeWidth={2} fillOpacity={1} fill="url(#colorVelocity)" />
              <Line type="monotone" dataKey="time" stroke="#10b981" strokeWidth={0} dot={{ r: 3, fill: '#10b981', strokeWidth: 0 }} />
          </AreaChart>
          )}
        </ChartShell>
      </section>

      <section className="flex flex-col">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-ui-micro font-bold text-slate-500 uppercase tracking-[0.2em]">Split Analytics</h3>
          <button 
            onClick={handleExport}
            className="text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors flex items-center gap-1 text-ui-micro font-medium"
          >
            <Download className="w-3 h-3" />
            <span>CSV Export</span>
          </button>
        </div>
        <div className="bg-white dark:bg-black/30 rounded-lg border border-slate-200 dark:border-white/5 overflow-hidden flex flex-col font-mono text-ui-caption shadow-sm dark:shadow-none transition-colors">
          <div className="grid grid-cols-5 p-3 border-b border-slate-200 dark:border-white/5 text-slate-500 font-bold bg-slate-50 dark:bg-white/5 transition-colors">
            <div>LAP</div>
            <div>DIST</div>
            <div>TIME</div>
            <div>CUM.</div>
            <div>VEL.</div>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-white/5">
            {chartData.map((row, i) => (
              <div key={i} className="grid grid-cols-5 p-3 hover:bg-slate-50 dark:hover:bg-white/5 text-slate-700 dark:text-slate-300 transition-colors">
                <div className="text-slate-500">{row.lap}</div>
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
        <h3 className="text-ui-micro font-bold text-slate-500 uppercase tracking-[0.2em] mb-3">Granular Segment Velocity</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label="0-Dive Entry" value={`${data.diveVelocity.toFixed(2)}`} unit="m/s" highlightClass="text-emerald-500 dark:text-emerald-400" />
          <MetricCard label="0-15m Segment" value={`${data.vel0to15m.toFixed(2)}`} unit="m/s" />
          <MetricCard label="15m-Wall" value={`${data.vel15mToWall.toFixed(2)}`} unit="m/s" />
          <MetricCard label="1st Length Avg" value={`${data.firstLengthVel.toFixed(2)}`} unit="m/s" />
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[var(--surface-muted)] p-4 rounded-lg border border-theme-soft flex justify-between items-center transition-colors">
          <div>
            <div className="text-ui-micro text-[var(--text-accent)] font-bold uppercase tracking-wider mb-1">UW Kick Tempo</div>
            <div className="text-xl font-mono text-[var(--text-primary)]">{Math.round(data.underwaterKickTempo)} <span className="text-ui-micro opacity-80 text-[var(--text-accent)]">k/min</span></div>
          </div>
          <div className="text-right">
             <div className="text-ui-micro text-[var(--text-accent)] font-bold uppercase tracking-wider mb-1">Kick Count</div>
             <div className="text-xl font-mono text-[var(--text-primary)]">{data.kicksCount}</div>
          </div>
        </div>
        
        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-lg border border-slate-200 dark:border-white/5 flex justify-between items-center transition-colors">
          <div>
            <div className="text-ui-micro text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider mb-1">Breakout Dist</div>
            <div className="text-xl font-mono text-slate-900 dark:text-slate-100">{data.breakoutDistance.toFixed(1)} <span className="text-ui-micro opacity-80 dark:opacity-60 text-slate-500">m</span></div>
          </div>
          <div className="text-right">
             <div className="text-ui-micro text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider mb-1">Breakout Time</div>
             <div className="text-xl font-mono text-slate-900 dark:text-slate-100">{data.breakoutTime.toFixed(2)} <span className="text-ui-micro opacity-80 dark:opacity-60 text-slate-500">s</span></div>
          </div>
        </div>
      </section>
    </div>
  );
}

export const MetricsDashboard = React.memo(MetricsDashboardComponent);

const MetricCard = React.memo(function MetricCard({ label, value, unit, highlightClass }: { label: string, value: string, unit: string, highlightClass?: string }) {
  return (
    <div className="bg-white dark:bg-black/30 p-4 rounded-lg border border-slate-200 dark:border-white/5 shadow-sm dark:shadow-none transition-colors">
      <div className="text-ui-micro text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wider font-bold">{label}</div>
      <div className={`text-2xl font-mono ${highlightClass || 'text-slate-900 dark:text-white'}`}>
        {value}<span className="text-ui-micro ml-1 opacity-60 text-slate-500">{unit}</span>
      </div>
    </div>
  );
});
