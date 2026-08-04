import type { LengthMetrics, Measured, RaceAnalysisResult, RaceConfig } from '../types';

export interface ComparisonSide {
  label: string;
  config: RaceConfig;
  result: RaceAnalysisResult;
}

interface Props {
  left: ComparisonSide;
  right: ComparisonSide;
}

interface MetricRow {
  label: string;
  left: Measured<number>;
  right: Measured<number>;
}

type DeltaCell = { status: 'value'; value: number; unit: string } | { status: 'incomparable'; reason: string };

// A delta is suppressed (marked incomparable) rather than computed whenever
// either side is absent, the two races used a different course, a different
// cycle definition, or the underlying units differ — e.g. never diff a yards
// race against a metres race.
function diffMeasured(a: Measured<number>, b: Measured<number>, sameCourse: boolean, sameCycle: boolean): DeltaCell {
  if (a.status === 'absent' || b.status === 'absent') {
    return { status: 'incomparable', reason: 'one or both values are absent' };
  }
  if (!sameCourse) return { status: 'incomparable', reason: 'different course' };
  if (!sameCycle) return { status: 'incomparable', reason: 'different cycle definition' };
  if (a.unit !== b.unit) return { status: 'incomparable', reason: 'different units' };
  return { status: 'value', value: b.value - a.value, unit: b.unit };
}

function formatMeasured(m: Measured<number>): string {
  if (m.status === 'absent') return '—';
  return `${m.value.toFixed(2)} ${m.unit}`;
}

function formatDelta(d: DeltaCell): string {
  if (d.status === 'incomparable') return '—';
  const sign = d.value > 0 ? '+' : '';
  return `${sign}${d.value.toFixed(2)} ${d.unit}`;
}

function raceLevelRows(left: RaceAnalysisResult, right: RaceAnalysisResult): MetricRow[] {
  return [
    { label: 'Reaction Time', left: left.reactionTime, right: right.reactionTime },
    { label: 'Flight Time', left: left.flightTime, right: right.flightTime },
    { label: 'Race Time', left: left.raceTime, right: right.raceTime },
    { label: 'Race Mean Velocity', left: left.raceMeanVelocity, right: right.raceMeanVelocity },
    { label: 'Finish Segment Time', left: left.finishSegmentTime, right: right.finishSegmentTime },
    { label: 'Finish Segment Velocity', left: left.finishSegmentVelocity, right: right.finishSegmentVelocity },
    {
      label: 'First-to-Last Stroke Rate Delta',
      left: left.firstToLastStrokeRateDelta,
      right: right.firstToLastStrokeRateDelta,
    },
    {
      label: 'First-to-Last Length Mean Velocity Delta',
      left: left.firstToLastLengthMeanVelocityDelta,
      right: right.firstToLastLengthMeanVelocityDelta,
    },
  ];
}

type LengthMeasuredKey =
  | 'breakoutTime'
  | 'underwaterVelocity'
  | 'kickCount'
  | 'kickTempo'
  | 'fifteenMetreTime'
  | 'zeroToFifteenMetreVelocity'
  | 'cycleCount'
  | 'strokeRate'
  | 'distancePerCycle'
  | 'split'
  | 'meanVelocity';

const LENGTH_METRIC_KEYS: ReadonlyArray<readonly [LengthMeasuredKey, string]> = [
  ['breakoutTime', 'Breakout Time'],
  ['underwaterVelocity', 'Underwater Velocity'],
  ['kickCount', 'Kick Count'],
  ['kickTempo', 'Kick Tempo'],
  ['fifteenMetreTime', '15 m Time'],
  ['zeroToFifteenMetreVelocity', '0-15 m Velocity'],
  ['cycleCount', 'Cycle Count'],
  ['strokeRate', 'Stroke Rate'],
  ['distancePerCycle', 'Distance per Cycle'],
  ['split', 'Split'],
  ['meanVelocity', 'Mean Velocity'],
];

function lengthRowGroups(
  left: readonly LengthMetrics[],
  right: readonly LengthMetrics[]
): Array<{ lengthIndex: number; rows: MetricRow[] }> {
  const groups: Array<{ lengthIndex: number; rows: MetricRow[] }> = [];
  for (const leftLength of left) {
    const rightLength = right.find(l => l.lengthIndex === leftLength.lengthIndex);
    if (!rightLength) continue;
    groups.push({
      lengthIndex: leftLength.lengthIndex,
      rows: LENGTH_METRIC_KEYS.map(([key, label]) => ({
        label,
        left: leftLength[key],
        right: rightLength[key],
      })),
    });
  }
  return groups;
}

function MetricTable({
  title,
  rows,
  leftLabel,
  rightLabel,
  sameCourse,
  sameCycle,
}: {
  title: string;
  rows: MetricRow[];
  leftLabel: string;
  rightLabel: string;
  sameCourse: boolean;
  sameCycle: boolean;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <h4 className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted mb-2">{title}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-ui-caption">
          <thead>
            <tr className="text-theme-muted border-b border-theme-soft">
              <th className="text-left py-1.5 pr-3">Metric</th>
              <th className="text-left py-1.5 pr-3">{leftLabel}</th>
              <th className="text-left py-1.5 pr-3">{rightLabel}</th>
              <th className="text-left py-1.5">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const delta = diffMeasured(row.left, row.right, sameCourse, sameCycle);
              return (
                <tr key={row.label} className="border-b border-theme-soft/50">
                  <td className="py-1.5 pr-3 text-theme-muted">{row.label}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{formatMeasured(row.left)}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{formatMeasured(row.right)}</td>
                  <td
                    className="py-1.5 font-mono tabular-nums text-[var(--text-accent)]"
                    title={delta.status === 'incomparable' ? delta.reason : undefined}
                  >
                    {formatDelta(delta)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SessionComparePanel({ left, right }: Props) {
  const sameCourse = left.config.course === right.config.course;
  const sameCycle = left.config.cycleDefinition === right.config.cycleDefinition;

  return (
    <section className="panel p-4 border border-theme-soft rounded-xl">
      <h3 className="text-ui-label font-bold text-[var(--text-primary)] mb-1">Compare Sessions</h3>
      <div className="text-ui-caption text-theme-muted mb-3">
        <span className="font-bold text-[var(--text-primary)]">{left.label}</span> vs{' '}
        <span className="font-bold text-[var(--text-primary)]">{right.label}</span>
        {!sameCourse ? (
          <span className="ml-2 text-red-500 dark:text-red-400">Different course — deltas suppressed</span>
        ) : !sameCycle ? (
          <span className="ml-2 text-red-500 dark:text-red-400">Different cycle definition — deltas suppressed</span>
        ) : null}
      </div>

      <MetricTable
        title="Race"
        rows={raceLevelRows(left.result, right.result)}
        leftLabel={left.label}
        rightLabel={right.label}
        sameCourse={sameCourse}
        sameCycle={sameCycle}
      />

      {lengthRowGroups(left.result.lengths, right.result.lengths).map(group => (
        <MetricTable
          key={group.lengthIndex}
          title={`Length ${group.lengthIndex + 1}`}
          rows={group.rows}
          leftLabel={left.label}
          rightLabel={right.label}
          sameCourse={sameCourse}
          sameCycle={sameCycle}
        />
      ))}
    </section>
  );
}
