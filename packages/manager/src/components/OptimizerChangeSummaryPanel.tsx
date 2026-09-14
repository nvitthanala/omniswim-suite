/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persistent, dismissible breakdown of the most recent optimizer run —
 * replaces the toast as the ONLY place a coach sees what changed.
 * `OptimizerResult` already carries `outcome`/`appliedStages`/
 * `unguardedTotal`; the toast reported only an aggregate gain. This panel
 * adds the per-athlete detail from `diffOptimizerChanges`, a real diff
 * against the workspace's pre-run state (not "every override the result
 * carries" — see that function's own doc comment), plus
 * `OptimizerResult.consideredButRejected` — athletes the scorer-cap ranking
 * did not select, closest misses first. See
 * `plans/2026-09-14/03-OPTIMIZER-TRANSPARENCY.md` pieces 1 and 2.
 */

import React from 'react';
import { X } from 'lucide-react';
import type {
  GuardedOptimizerResult,
  OptimizerChangeSummary,
} from '@omniswim/core/lib/rosterOptimizer';

export type OptimizerRunSummary = {
  /** Label for the run, e.g. the team name or "All teams". */
  label: string;
  result: GuardedOptimizerResult;
  changes: OptimizerChangeSummary;
};

const STAGE_LABEL: Record<GuardedOptimizerResult['appliedStages'], string> = {
  none: 'no change',
  scorers: 'scorer roster',
  events: 'event assignment',
  'scorers+events': 'scorer roster + event assignment',
};

function ScorerChangeRow({ change }: { change: OptimizerChangeSummary['scorerChanges'][number] }) {
  return (
    <li className="text-ui-caption text-[var(--text-primary)]">
      {change.name}{' '}
      <span className={change.isScorer ? 'text-points-positive' : 'text-points-negative'}>
        {change.isScorer ? 'marked scorer' : 'unmarked as scorer'}
      </span>
    </li>
  );
}

function EntryChangeRow({ change }: { change: OptimizerChangeSummary['entryChanges'][number] }) {
  if (change.status === 'removed') {
    return (
      <li className="text-ui-caption text-[var(--text-primary)]">
        {change.name} — removed from <span className="text-theme-secondary">{change.event}</span>
      </li>
    );
  }
  if (change.status === 'changed') {
    return (
      <li className="text-ui-caption text-[var(--text-primary)]">
        {change.name} — moved from{' '}
        <span className="text-theme-secondary">{change.previousEvent}</span> to{' '}
        <span className="text-[var(--text-accent)]">{change.event}</span>
      </li>
    );
  }
  return (
    <li className="text-ui-caption text-[var(--text-primary)]">
      {change.name} — added to <span className="text-[var(--text-accent)]">{change.event}</span>{' '}
      <span className="text-theme-secondary">({change.time})</span>
    </li>
  );
}

type Props = {
  summary: OptimizerRunSummary;
  onDismiss: () => void;
  /** Present only when this run is the single most recent APPLIED optimizer
   *  run this session — undone once, or superseded by the next run, and it's
   *  gone. See RosterOptimizeStep.tsx's own doc comment on this pattern. */
  onUndo?: () => void;
};

function RejectedCandidateRow({ candidate }: { candidate: NonNullable<GuardedOptimizerResult['consideredButRejected']>[number] }) {
  return (
    <li className="text-ui-caption text-[var(--text-primary)]">
      {candidate.name}{' '}
      <span className="text-theme-secondary">
        ({candidate.points.toFixed(1)} pts
        {candidate.behindByPoints > 0 ? `, ${candidate.behindByPoints.toFixed(1)} behind the cap` : ', tied at the cap'})
      </span>
    </li>
  );
}

export default function OptimizerChangeSummaryPanel({ summary, onDismiss, onUndo }: Props) {
  const { label, result, changes } = summary;
  const gain = result.projectedTotal - result.previousTotal;
  const rejected = result.consideredButRejected ?? [];
  const hasDetail = changes.scorerChanges.length > 0 || changes.entryChanges.length > 0 || rejected.length > 0;

  return (
    <div className="rounded-xl border border-theme-soft surface-muted-bg p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-ui-label font-semibold text-[var(--text-primary)]">
            {label}: {result.outcome === 'improved' ? (
              <span className="text-points-positive">+{gain.toFixed(1)} pts</span>
            ) : (
              'no change'
            )}
          </p>
          <p className="text-ui-caption text-theme-secondary mt-0.5">
            {result.outcome === 'improved'
              ? `${result.previousTotal.toFixed(1)} → ${result.projectedTotal.toFixed(1)} pts via ${STAGE_LABEL[result.appliedStages]}`
              : `Already the best lineup found (${result.previousTotal.toFixed(1)} pts) — nothing changed.`}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {onUndo ? (
            <button
              type="button"
              onClick={onUndo}
              className="px-3 py-1.5 text-ui-caption font-medium rounded-lg border border-theme-soft theme-hover-row hover:text-[var(--text-accent)] transition-colors whitespace-nowrap"
            >
              Undo this optimize
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss optimizer summary"
            className="p-1 rounded text-theme-secondary hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {hasDetail ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-theme-soft">
          {changes.scorerChanges.length > 0 ? (
            <div>
              <p className="text-ui-caption font-semibold text-theme-muted uppercase tracking-widest mb-1.5">
                Scorer roster ({changes.scorerChanges.length})
              </p>
              <ul className="space-y-1">
                {changes.scorerChanges.map(c => (
                  <ScorerChangeRow key={`${c.team}|${c.gender}|${c.name}`} change={c} />
                ))}
              </ul>
            </div>
          ) : null}
          {changes.entryChanges.length > 0 ? (
            <div>
              <p className="text-ui-caption font-semibold text-theme-muted uppercase tracking-widest mb-1.5">
                Entries ({changes.entryChanges.length})
              </p>
              <ul className="space-y-1">
                {changes.entryChanges.map((c, i) => (
                  <EntryChangeRow key={`${c.team}|${c.name}|${c.event}|${i}`} change={c} />
                ))}
              </ul>
            </div>
          ) : null}
          {rejected.length > 0 ? (
            <div>
              <p className="text-ui-caption font-semibold text-theme-muted uppercase tracking-widest mb-1.5">
                Didn't make the scorer cap ({rejected.length})
              </p>
              <ul className="space-y-1">
                {rejected.slice(0, 10).map(c => (
                  <RejectedCandidateRow key={`${c.team}|${c.gender}|${c.name}`} candidate={c} />
                ))}
              </ul>
              {rejected.length > 10 ? (
                <p className="text-ui-caption text-theme-muted mt-1">+{rejected.length - 10} more</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
