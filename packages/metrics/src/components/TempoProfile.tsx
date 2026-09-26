import React, { useMemo } from 'react';
import { Line, ReferenceArea, ReferenceLine } from 'recharts';
import type { LengthMetrics, TurnMetrics, Unit } from '../types';
import { LengthProfileChart } from './LengthProfileChart';

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

  return (
    <LengthProfileChart
      title="Tempo Profile"
      unit={unit}
      emptyMessage="No stroke-tempo data measured yet."
      lengths={lengths}
      data={meanPoints}
      chartKey={`tempo-${cyclePoints.length}-${meanPoints.length}`}
      tooltipFormatter={(_value: any, _name: any, item: any) => {
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
      renderSeries={({ chartTheme, maxX: _maxX }) => (
        <>
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
        </>
      )}
      footer={`Dots are individual stroke cycles; the step line is each length's mean. Watch whether dots trend downward across the race (drop-off) and whether they climb just before each dashed wall line (rise into the walls).${
        missingCycleCount > 0
          ? ` ${missingCycleCount} cycle${missingCycleCount === 1 ? '' : 's'} had no computed rate and are not plotted.`
          : ''
      }`}
    />
  );
}

export const TempoProfile = React.memo(TempoProfileComponent);
