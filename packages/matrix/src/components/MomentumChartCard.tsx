/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';
import { ChartFrame, ChartShell } from '@omniswim/ui';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import type { MomentumSeriesPoint } from '@omniswim/core/lib/prelimsProjection';
import { assignTeamLineStyles } from '@omniswim/core/lib/utils';
import { CompactEventLabel, PrelimsOuValue } from './matrixPresentation';

type SingleTeamProps = {
  mode?: 'single';
  title: string;
  series: MomentumSeriesPoint[];
  meetTotalOu?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  emptyMessage?: string;
};

type MultiTeamProps = {
  mode: 'multi';
  title: string;
  data: Record<string, unknown>[];
  teams: { teamName: string; color?: string; lineColor?: string; strokeDasharray?: string }[];
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  emptyMessage?: string;
};

type Props = SingleTeamProps | MultiTeamProps;

export default function MomentumChartCard(props: Props) {
  const chartTheme = useThemeColors();
  const size = props.size ?? 'md';

  const multiStyled = useMemo(() => {
    if (props.mode !== 'multi') return null;
    return assignTeamLineStyles(
      props.teams.map(t => ({
        teamName: t.teamName,
        totalPoints: 0,
        swimmers: [],
        color: t.color ?? '#888',
        lineColor: t.lineColor,
        strokeDasharray: t.strokeDasharray,
      })),
      { chartTheme: chartTheme.isDark ? 'dark' : 'light' }
    );
  }, [props, chartTheme.isDark]);

  return (
    <div
      className={[
        'surface-overlay border border-theme-soft rounded-lg p-3',
        props.className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-theme-secondary">
          {props.title}
        </h4>
        {props.mode !== 'multi' && props.meetTotalOu != null && Math.abs(props.meetTotalOu) > 0.05 ? (
          <PrelimsOuValue value={props.meetTotalOu} compact />
        ) : null}
      </div>

      <ChartShell size={size} className="min-h-[140px]">
        {({ width, height }) =>
          props.mode === 'multi' ? (
            props.data.length > 0 && multiStyled ? (
              <ChartFrame width={width} height={height}>
                <LineChart
                  width={Math.floor(width)}
                  height={Math.floor(height)}
                  responsive={false}
                  data={props.data}
                  margin={{ top: 8, right: 8, left: 4, bottom: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
                  <ReferenceLine y={0} stroke={chartTheme.chartGrid} strokeDasharray="2 4" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{
                      fill: chartTheme.chartTick,
                      fontSize: 8,
                      fontFamily: 'JetBrains Mono',
                    }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: chartTheme.chartTick, fontSize: 8, fontFamily: 'JetBrains Mono' }}
                    width={36}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="theme-popover rounded-lg p-2 text-ui-micro font-mono">
                          <div className="text-[var(--text-accent)] font-bold mb-1">{label}</div>
                          {payload.map(p => (
                            <div key={String(p.dataKey)} className="flex justify-between gap-4">
                              <span className="text-theme-secondary truncate max-w-[120px]">
                                {String(p.dataKey)}
                              </span>
                              <PrelimsOuValue value={typeof p.value === 'number' ? p.value : 0} compact />
                            </div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  {multiStyled.map(team => (
                    <Line
                      key={team.teamName}
                      type="monotone"
                      dataKey={team.teamName}
                      stroke={team.lineColor ?? team.color}
                      strokeWidth={2}
                      strokeDasharray={team.strokeDasharray}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ChartFrame>
            ) : (
              <div
                className="flex items-center justify-center text-center text-ui-caption text-theme-muted px-4"
                style={{ width, height }}
              >
                {props.emptyMessage ?? 'No momentum data yet.'}
              </div>
            )
          ) : props.series.length > 0 ? (
            <ChartFrame width={width} height={height}>
              <LineChart
                width={Math.floor(width)}
                height={Math.floor(height)}
                responsive={false}
                data={props.series}
                margin={{ top: 8, right: 8, left: 4, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
                <ReferenceLine y={0} stroke={chartTheme.chartGrid} strokeDasharray="2 4" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: chartTheme.chartTick, fontSize: 8, fontFamily: 'JetBrains Mono' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: chartTheme.chartTick, fontSize: 8, fontFamily: 'JetBrains Mono' }}
                  width={36}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]?.payload) return null;
                    const row = payload[0].payload as MomentumSeriesPoint;
                    return (
                      <div className="theme-popover rounded-lg p-2 text-ui-micro font-mono">
                        <div className="text-[var(--text-accent)] font-bold mb-1">
                          <CompactEventLabel event={row.rawEvent} />
                        </div>
                        <div className="text-theme-secondary">
                          Event: <PrelimsOuValue value={row.delta} compact />
                        </div>
                        <div className="text-theme-muted">
                          Cumulative: <PrelimsOuValue value={row.cumulative} compact />
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke={chartTheme.isDark ? '#94a3b8' : '#64748b'}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartFrame>
          ) : (
            <div
              className="flex items-center justify-center text-center text-ui-caption text-theme-muted px-4"
              style={{ width, height }}
            >
              {props.emptyMessage ?? 'No momentum data yet.'}
            </div>
          )
        }
      </ChartShell>
      <p className="text-[9px] text-theme-muted mt-2 normal-case tracking-normal">
        Cumulative over/under vs prelims placement expected points. Timed-finals events contribute 0.
      </p>
    </div>
  );
}
