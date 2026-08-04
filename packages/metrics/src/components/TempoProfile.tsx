import React, { useMemo } from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { ChartFrame, ChartShell } from '@omniswim/ui';
import type { LengthMetrics, TurnMetrics, Unit } from '../types';

interface MeanPoint {
  x: number;
  lengthIndex: number;
  rate: number | null;
  reason: string | null;
}

interface CyclePoint {
  x: number;
  rate: number;
  lengthIndex: number;
  cycleIndex: number;
}

interface TooltipPoint {
  rate: number | null;
  lengthIndex: number;
  reason: string | null;
  cycleIndex?: number;
}

function TempoProfileComponent({
  lengths,
  turns,
}: {
  lengths: readonly LengthMetrics[];
  turns: readonly TurnMetrics[];
}) {
  const chartTheme = useThemeColors();

  const unit: Unit | null = useMemo(() => {
    for (const length of lengths) {
      if (length.strokeRate.status === 'value') return length.strokeRate.unit;
      for (const cycle of length.strokeCycles) {
        if (cycle.instantaneousStrokeRate.status === 'value') return cycle.instantaneousStrokeRate.unit;
      }
    }
    return null;
  }, [lengths]);

  const meanPoints = useMemo<MeanPoint[]>(
    () =>
      lengths.map((length) => ({
        x: length.lengthIndex - 1,
        lengthIndex: length.lengthIndex,
        rate: length.strokeRate.status === 'value' ? length.strokeRate.value : null,
        reason: length.strokeRate.status === 'absent' ? length.strokeRate.reason : null,
      })),
    [lengths],
  );

  const { cyclePoints, missingCycleCount } = useMemo(() => {
    const points: CyclePoint[] = [];
    let missing = 0;
    for (const length of lengths) {
      const cycleTotal = length.strokeCycles.length;
      for (const cycle of length.strokeCycles) {
        if (cycle.instantaneousStrokeRate.status !== 'value') {
          missing += 1;
          continue;
        }
        const fraction = cycleTotal > 0 ? (cycle.cycleIndex - 0.5) / cycleTotal : 0.5;
        points.push({
          x: length.lengthIndex - 1 + fraction,
          rate: cycle.instantaneousStrokeRate.value,
          lengthIndex: length.lengthIndex,
          cycleIndex: cycle.cycleIndex,
        });
      }
    }
    return { cyclePoints: points, missingCycleCount: missing };
  }, [lengths]);

  if (unit === null || lengths.length === 0) {
    return (
      <div className="surface-card rounded-xl p-5 text-ui-caption text-theme-muted">
        {'No stroke-tempo data measured yet.'}
      </div>
    );
  }

  const maxX = lengths.length;
  const axisTicks = Array.from({ length: maxX + 1 }, (_unused, index) => index);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em]">{'Tempo Profile'}</h4>
        <span className="text-ui-micro text-theme-muted font-mono">{unit}</span>
      </div>
      <ChartShell size="fluid" className="surface-card rounded-xl p-5 overflow-hidden transition-colors">
        {({ width, height }) => (
          <ChartFrame width={width} height={height}>
            <ComposedChart
              key={`tempo-${cyclePoints.length}-${meanPoints.length}`}
              width={Math.floor(width)}
              height={Math.floor(height)}
              data={meanPoints}
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
                formatter={(_value: any, _name: any, item: any) => {
                  const point = item?.payload as TooltipPoint | undefined;
                  if (!point) return ['not measured', ''];
                  if (typeof point.cycleIndex === 'number') {
                    const rate = point.rate ?? 0;
                    return [`${rate.toFixed(1)} ${unit}`, `Length ${point.lengthIndex}, cycle ${point.cycleIndex}`];
                  }
                  if (point.rate === null || point.rate === undefined) {
                    return [point.reason ?? 'not measured', `Length ${point.lengthIndex} mean`];
                  }
                  return [`${point.rate.toFixed(1)} ${unit}`, `Length ${point.lengthIndex} mean`];
                }}
              />
              <ReferenceArea x1={0} x2={1} fill={chartTheme.chartGrid} fillOpacity={0.4} ifOverflow="visible" />
              {turns.map((turn) => (
                <ReferenceLine
                  key={turn.turnIndex}
                  x={turn.lengthIndex}
                  stroke={chartTheme.chartGrid}
                  strokeDasharray="4 4"
                />
              ))}
              <Line
                data={meanPoints}
                type="stepAfter"
                dataKey="rate"
                stroke={chartTheme.accent}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                data={cyclePoints}
                type="linear"
                dataKey="rate"
                stroke={chartTheme.accent}
                strokeWidth={0}
                dot={{ r: 3, strokeWidth: 0, fill: chartTheme.chartTick }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ChartFrame>
        )}
      </ChartShell>
      <p className="text-ui-micro text-theme-muted mt-2">
        {`Dots are individual stroke cycles; the step line is each length's mean. Watch whether dots trend downward across the race (drop-off) and whether they climb just before each dashed wall line (rise into the walls).${
          missingCycleCount > 0
            ? ` ${missingCycleCount} cycle${missingCycleCount === 1 ? '' : 's'} had no computed rate and are not plotted.`
            : ''
        }`}
      </p>
    </div>
  );
}

export const TempoProfile = React.memo(TempoProfileComponent);
