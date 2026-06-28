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
        {delta != null && Math.abs(delta) > 0.05 ? (
          <span className={delta > 0 ? 'text-points-positive' : 'text-points-negative'}>
            {delta > 0 ? '+' : ''}
            {delta.toFixed(1)}
          </span>
        ) : null}
        {showPrelims && prelimsProjected != null ? (
          <span className="text-theme-secondary">
            Prelims{' '}
            <span className="text-[var(--text-primary)] font-bold">{prelimsProjected.toFixed(1)}</span>
          </span>
        ) : null}
        {showPrelims && baselineOverUnder != null && Math.abs(baselineOverUnder) > 0.05 ? (
          <span className={baselineOverUnder > 0 ? 'text-points-positive' : 'text-points-negative'}>
            Base {baselineOverUnder > 0 ? '+' : ''}
            {baselineOverUnder.toFixed(1)}
          </span>
        ) : null}
        {showPrelims &&
        projectedOverUnder != null &&
        Math.abs(projectedOverUnder) > 0.05 &&
        (baselineOverUnder == null || Math.abs(projectedOverUnder - baselineOverUnder) > 0.05) ? (
          <span className={projectedOverUnder > 0 ? 'text-points-positive' : 'text-points-negative'}>
            Proj {projectedOverUnder > 0 ? '+' : ''}
            {projectedOverUnder.toFixed(1)}
          </span>
        ) : null}
      </div>
    );
  }

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
        <>
          <div className="pt-2 border-t border-theme-soft space-y-2">
            <ScoreRow label="Prelims Proj" value={prelimsProjected} muted />
            <ScoreRow label="Baseline vs Prelims" value={baselineOverUnder} delta />
            <ScoreRow label="Projected vs Prelims" value={projectedOverUnder} delta />
          </div>
        </>
      ) : null}
      {actual == null && baseline == null ? (
        <p className="text-[9px] text-theme-muted italic leading-relaxed">
          No official PDF totals — showing computed scores only.
        </p>
      ) : null}
      {delta != null && Math.abs(delta) > 0.05 ? (
        <div className="pt-2 border-t border-theme-soft flex justify-between text-[10px] font-mono">
          <span className="text-theme-secondary uppercase tracking-widest">
            Delta vs {actual != null ? 'actual' : 'baseline'}
          </span>
          <span className={`font-bold ${delta > 0 ? 'text-points-positive' : 'text-points-negative'}`}>
            {delta > 0 ? '+' : ''}
            {delta.toFixed(1)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
