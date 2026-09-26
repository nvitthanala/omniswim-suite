import React, { type ReactNode } from 'react';
import { CartesianGrid, ComposedChart, Tooltip, XAxis, YAxis } from 'recharts';
import { useThemeColors, type ThemeColors } from '@omniswim/core/lib/useThemeColors';
import { ChartFrame, ChartShell } from '@omniswim/ui';
import type { LengthMetrics } from '../types';

/**
 * Shared chart skeleton for the per-length race profiles (stroke tempo,
 * velocity): title row, empty state, the axis/grid/tooltip scaffolding that
 * is byte-identical between them, and a `renderSeries` slot for whatever
 * each profile actually plots (Recharts `<Line>`/`<ReferenceArea>` children,
 * which differ enough — shape, count, styling — that sharing them would
 * blur the two profiles). Extracted from TempoProfile/VelocityProfile,
 * which jscpd flagged as a 37 + 43-line clone (2026-09-25 code-health pass).
 */
export function LengthProfileChart<TPoint>({
  title,
  unit,
  emptyMessage,
  lengths,
  data,
  chartKey,
  tooltipFormatter,
  renderSeries,
  footer,
}: {
  title: string;
  unit: string | null;
  emptyMessage: string;
  lengths: readonly LengthMetrics[];
  data: TPoint[];
  chartKey: string;
  tooltipFormatter: (value: unknown, name: unknown, item: unknown) => [string, string];
  renderSeries: (ctx: { chartTheme: ThemeColors; maxX: number }) => ReactNode;
  footer: ReactNode;
}) {
  const chartTheme = useThemeColors();

  if (unit === null || lengths.length === 0) {
    return (
      <div className="surface-card rounded-xl p-5 text-ui-caption text-theme-muted">
        {emptyMessage}
      </div>
    );
  }

  const maxX = lengths.length;
  const axisTicks = Array.from({ length: maxX + 1 }, (_unused, index) => index);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em]">{title}</h4>
        <span className="text-ui-micro text-theme-muted font-mono">{unit}</span>
      </div>
      <ChartShell size="fluid" className="surface-card rounded-xl p-5 overflow-hidden transition-colors">
        {({ width, height }) => (
          <ChartFrame width={width} height={height}>
            <ComposedChart
              key={chartKey}
              width={Math.floor(width)}
              height={Math.floor(height)}
              data={data}
              margin={{ top: 5, right: 8, left: -12, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.chartGrid} vertical={false} />
              <XAxis
                type="number"
                dataKey="x"
                domain={[0, maxX]}
                ticks={axisTicks}
                tickFormatter={(value: any) => (value === 0 ? 'Start' : value === maxX ? 'Finish' : `T${value}`)}
                stroke={chartTheme.chartTick}
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis stroke={chartTheme.chartTick} fontSize={10} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--popover-bg)',
                  borderColor: 'var(--popover-border)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
                itemStyle={{ color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                labelFormatter={() => ''}
                formatter={tooltipFormatter as any}
              />
              {renderSeries({ chartTheme, maxX })}
            </ComposedChart>
          </ChartFrame>
        )}
      </ChartShell>
      <p className="text-ui-micro text-theme-muted mt-2">{footer}</p>
    </div>
  );
}
