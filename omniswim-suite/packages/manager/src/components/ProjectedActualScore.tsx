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
};

function ScoreRow({
  label,
  value,
  highlight,
  muted,
}: {
  label: string;
  value: number | undefined;
  highlight?: boolean;
  muted?: boolean;
}) {
  if (value == null) return null;
  return (
    <div className="flex items-center justify-between gap-4 text-[10px] font-mono">
      <span className={`uppercase tracking-widest ${muted ? 'text-theme-muted' : 'text-theme-secondary'}`}>
        {label}
      </span>
      <span
        className={`font-bold tabular-nums ${
          highlight ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]'
        }`}
      >
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
}: Props) {
  const delta =
    actual != null ? projected - actual : baseline != null ? projected - baseline : undefined;

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
