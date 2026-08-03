import React, { useMemo } from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceArea, Tooltip, XAxis, YAxis } from 'recharts';
import { useThemeColors } from '@omniswim/core/lib/useThemeColors';
import { ChartFrame, ChartShell } from '@omniswim/ui';
import type { LengthMetrics, TurnMetrics, Unit } from '../types';

interface VelocityPoint {
  x: number;
  lengthIndex: number;
  velocity: number | null;
  reason: string | null;
  approximate: boolean;
}

function VelocityProfileComponent({
  lengths,
  turns,
}: {
  lengths: readonly LengthMetrics[];
  turns: readonly TurnMetrics[];
}) {
  const chartTheme = useThemeColors();

  const unit: Unit | null = useMemo(() => {
    for (const length of lengths) {
      if (length.meanVelocity.status === 'value') return length.meanVelocity.unit;
    }
    return null;
  }, [lengths]);

  const points = useMemo<VelocityPoint[]>(
    () =>
      lengths.map((length) => ({
        x: length.lengthIndex - 1,
        lengthIndex: length.lengthIndex,
        velocity: length.meanVelocity.status === 'value' ? length.meanVelocity.value : null,
        reason: length.meanVelocity.status === 'absent' ? length.meanVelocity.reason : null,
        approximate: length.meanVelocity.status === 'value' ? length.meanVelocity.approximate : false,
      })),
    [lengths],
  );

  if (unit === null || lengths.length === 0) {
    return (
      <div className="surface-card rounded-xl p-5 text-ui-caption text-theme-muted">
        {'No velocity data measured yet.'}
      </div>
    );
  }

  const maxX = lengths.length;
  const axisTicks = Array.from({ length: maxX + 1 }, (_unused, index) => index);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-ui-micro font-bold text-theme-muted uppercase tracking-[0.2em]">{'Velocity Profile'}</h4>
        <span className="text-ui-micro text-theme-muted font-mono">{unit}</span>
      </div>
      <ChartShell size="fluid" className="surface-card rounded-xl p-5 overflow-hidden transition-colors">
        {({ width, height }) => (
          <ChartFrame width={width} height={height}>
            <ComposedChart
              key={`velocity-${points.length}`}
              width={Math.floor(width)}
              height={Math.floor(height)}
              data={points}
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
                  const point: VelocityPoint | undefined = item?.payload;
                  if (!point) return ['not measured', ''];
                  if (point.velocity === null) {
                    return [point.reason ?? 'not measured', `Length ${point.lengthIndex}`];
                  }
                  const approx = point.approximate ? ' (approx.)' : '';
                  return [`${point.velocity.toFixed(2)} ${unit}${approx}`, `Length ${point.lengthIndex}`];
                }}
              />
              <ReferenceArea x1={0} x2={1} fill={chartTheme.chartGrid} fillOpacity={0.4} ifOverflow="visible" />
              {turns.map((turn) => (
                <ReferenceArea
                  key={turn.turnIndex}
                  x1={Math.max(0, turn.lengthIndex - 0.12)}
                  x2={Math.min(maxX, turn.lengthIndex + 0.12)}
                  fill={chartTheme.accent}
                  fillOpacity={0.22}
                  ifOverflow="visible"
                />
              ))}
              <Line
                type="stepAfter"
                dataKey="velocity"
                stroke={chartTheme.accent}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0, fill: chartTheme.accent }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ChartFrame>
        )}
      </ChartShell>
      <p className="text-ui-micro text-theme-muted mt-2">
        {`Each step is one measured segment mean — there is no data between landmarks. The shaded band at Length 1 marks the dive start, which is not comparable to push-off lengths.${
          turns.length > 0 ? ' Shaded bars mark turn walls.' : ''
        }`}
      </p>
    </div>
  );
}

export const VelocityProfile = React.memo(VelocityProfileComponent);
