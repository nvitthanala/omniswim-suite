import React, { useMemo } from 'react';
import { Line, ReferenceArea } from 'recharts';
import type { LengthMetrics, TurnMetrics, Unit } from '../types';
import { LengthProfileChart } from './LengthProfileChart';

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

  return (
    <LengthProfileChart
      title="Velocity Profile"
      unit={unit}
      emptyMessage="No velocity data measured yet."
      lengths={lengths}
      data={points}
      chartKey={`velocity-${points.length}`}
      tooltipFormatter={(_value: any, _name: any, item: any) => {
        const point: VelocityPoint | undefined = item?.payload;
        if (!point) return ['not measured', ''];
        if (point.velocity === null) {
          return [point.reason ?? 'not measured', `Length ${point.lengthIndex}`];
        }
        const approx = point.approximate ? ' (approx.)' : '';
        return [`${point.velocity.toFixed(2)} ${unit}${approx}`, `Length ${point.lengthIndex}`];
      }}
      renderSeries={({ chartTheme, maxX }) => (
        <>
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
        </>
      )}
      footer={`Each step is one measured segment mean — there is no data between landmarks. The shaded band at Length 1 marks the dive start, which is not comparable to push-off lengths.${
        turns.length > 0 ? ' Shaded bars mark turn walls.' : ''
      }`}
    />
  );
}

export const VelocityProfile = React.memo(VelocityProfileComponent);
