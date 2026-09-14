/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

type Props = {
  actual?: number;
  baseline?: number;
  projected: number;
  compact?: boolean;
  eventThrough?: number;
  prelimsProjected?: number;
  baselineOverUnder?: number;
  projectedOverUnder?: number;
};

/** True when a delta is far enough from zero to be worth showing. */
function isMeaningfulDelta(value: number | null | undefined): value is number {
  return value != null && Math.abs(value) > 0.05;
}

/** The projected-vs-prelims delta is only worth its own badge when it says
 * something the baseline-vs-prelims delta hasn't already said. */
function shouldShowProjectedOverUnder(
  baselineOverUnder: number | undefined,
  projectedOverUnder: number | undefined
): projectedOverUnder is number {
  return (
    isMeaningfulDelta(projectedOverUnder) &&
    (baselineOverUnder == null || Math.abs(projectedOverUnder - baselineOverUnder) > 0.05)
  );
}

function ScoreRow({
  label,
  value,
  highlight,
  muted,
  delta,
}: {
  label: string;
  value: number | undefined;
  highlight?: boolean;
  muted?: boolean;
  delta?: boolean;
}) {
  if (value == null) return null;
  const deltaClass =
    delta && Math.abs(value) > 0.05
      ? value > 0
        ? 'text-points-positive'
        : 'text-points-negative'
      : highlight
        ? 'text-[var(--text-accent)]'
        : 'text-[var(--text-primary)]';
  return (
    <div className="flex items-center justify-between gap-4 text-[10px] font-mono">
      <span className={`uppercase tracking-widest ${muted ? 'text-theme-muted' : 'text-theme-secondary'}`}>
        {label}
      </span>
      <span className={`font-bold tabular-nums ${deltaClass}`}>
        {delta && value > 0 ? '+' : ''}
        {value.toFixed(1)}
      </span>
    </div>
  );
}

/** A signed, colored delta value — positive in points-positive, negative in points-negative. */
function DeltaBadge({ value, prefix = '', className = '' }: { value: number; prefix?: string; className?: string }) {
  const colorClass = value > 0 ? 'text-points-positive' : 'text-points-negative';
  return (
    <span className={className ? `${className} ${colorClass}` : colorClass}>
      {prefix}
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}
    </span>
  );
}

interface CompactScoreSummaryProps {
  actual?: number;
  projected: number;
  delta?: number;
  prelimsProjected?: number;
  baselineOverUnder?: number;
  projectedOverUnder?: number;
  showPrelims: boolean;
}

/** The one-line compact summary used inline in tighter layouts (e.g. the TeamCard header). */
function CompactScoreSummary({
  actual,
  projected,
  delta,
  prelimsProjected,
  baselineOverUnder,
  projectedOverUnder,
  showPrelims,
}: CompactScoreSummaryProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-mono uppercase tracking-widest">
      {actual != null ? (
        <span className="text-theme-secondary">
          Actual <span className="text-[var(--text-primary)] font-bold">{actual.toFixed(1)}</span>
        </span>
      ) : null}
      <span className="text-theme-secondary">
        Proj{' '}
        <span className="text-[var(--text-accent)] font-bold">{projected.toFixed(1)}</span>
      </span>
      {isMeaningfulDelta(delta) ? <DeltaBadge value={delta} /> : null}
      {showPrelims && prelimsProjected != null ? (
        <span className="text-theme-secondary">
          Prelims{' '}
          <span className="text-[var(--text-primary)] font-bold">{prelimsProjected.toFixed(1)}</span>
        </span>
      ) : null}
      {showPrelims && isMeaningfulDelta(baselineOverUnder) ? (
        <DeltaBadge value={baselineOverUnder} prefix="Base " />
      ) : null}
      {showPrelims && shouldShowProjectedOverUnder(baselineOverUnder, projectedOverUnder) ? (
        <DeltaBadge value={projectedOverUnder} prefix="Proj " />
      ) : null}
    </div>
  );
}

interface FullScoreSummaryProps {
  actual?: number;
  baseline?: number;
  projected: number;
  eventThrough?: number;
  prelimsProjected?: number;
  baselineOverUnder?: number;
  projectedOverUnder?: number;
  delta?: number;
  showPrelims: boolean;
}

/** The full card-style summary used in the expanded team panel. */
function FullScoreSummary({
  actual,
  baseline,
  projected,
  eventThrough,
  prelimsProjected,
  baselineOverUnder,
  projectedOverUnder,
  delta,
  showPrelims,
}: FullScoreSummaryProps) {
  return (
    <div className="surface-overlay border border-theme-soft rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h5 className="text-[9px] font-bold uppercase tracking-widest text-theme-secondary">
          Team score summary
        </h5>
        {eventThrough != null ? (
          <span className="text-[8px] text-theme-muted uppercase">Through event {eventThrough}</span>
        ) : null}
      </div>
      <ScoreRow label="Actual" value={actual} />
      <ScoreRow label="Baseline" value={baseline} muted />
      <ScoreRow label="Projected" value={projected} highlight />
      {showPrelims ? (
        <div className="pt-2 border-t border-theme-soft space-y-2">
          <ScoreRow label="Prelims Proj" value={prelimsProjected} muted />
          <ScoreRow label="Baseline vs Prelims" value={baselineOverUnder} delta />
          <ScoreRow label="Projected vs Prelims" value={projectedOverUnder} delta />
        </div>
      ) : null}
      {actual == null && baseline == null ? (
        <p className="text-[9px] text-theme-muted italic leading-relaxed">
          No official PDF totals — showing computed scores only.
        </p>
      ) : null}
      {isMeaningfulDelta(delta) ? (
        <div className="pt-2 border-t border-theme-soft flex justify-between text-[10px] font-mono">
          <span className="text-theme-secondary uppercase tracking-widest">
            Delta vs {actual != null ? 'actual' : 'baseline'}
          </span>
          <DeltaBadge value={delta} className="font-bold" />
        </div>
      ) : null}
    </div>
  );
}

export default function ProjectedActualScore({
  actual,
  baseline,
  projected,
  compact = false,
  eventThrough,
  prelimsProjected,
  baselineOverUnder,
  projectedOverUnder,
}: Props) {
  const delta =
    actual != null ? projected - actual : baseline != null ? projected - baseline : undefined;

  const showPrelims =
    prelimsProjected != null &&
    (baselineOverUnder != null || projectedOverUnder != null);

  if (compact) {
    return (
      <CompactScoreSummary
        actual={actual}
        projected={projected}
        delta={delta}
        prelimsProjected={prelimsProjected}
        baselineOverUnder={baselineOverUnder}
        projectedOverUnder={projectedOverUnder}
        showPrelims={showPrelims}
      />
    );
  }

  return (
    <FullScoreSummary
      actual={actual}
      baseline={baseline}
      projected={projected}
      eventThrough={eventThrough}
      prelimsProjected={prelimsProjected}
      baselineOverUnder={baselineOverUnder}
      projectedOverUnder={projectedOverUnder}
      delta={delta}
      showPrelims={showPrelims}
    />
  );
}
