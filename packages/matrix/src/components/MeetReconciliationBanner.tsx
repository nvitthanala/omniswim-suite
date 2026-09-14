/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One consolidated "does this meet match the official totals" summary for
 * the whole Standings step. Each team card already shows its own
 * computed-vs-official delta (`ProjectedActualScore.tsx`) — this banner is
 * the cross-team view that surfaces a mismatch without a coach checking
 * every card individually. See
 * `plans/2026-09-14/02-MEET-IMPORT-RECONCILIATION.md`.
 */

import React from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import type { MeetReconciliationSummary } from '@omniswim/core/lib/meetReconciliation';

type Props = {
  summary: MeetReconciliationSummary;
};

function formatDelta(delta: number): string {
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
}

export default function MeetReconciliationBanner({ summary }: Props) {
  if (!summary.hasOfficialScores) return null;

  const mismatched = summary.entries.filter(e => e.status === 'mismatched');
  const officialOnly = summary.entries.filter(e => e.status === 'officialOnly');
  const computedOnly = summary.entries.filter(e => e.status === 'computedOnly');
  const allClear = mismatched.length === 0 && officialOnly.length === 0 && computedOnly.length === 0;

  return (
    <div className="surface-card rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {allClear ? (
          <CheckCircle2 size={16} className="shrink-0 text-[var(--text-accent)]" />
        ) : (
          <AlertTriangle size={16} className="shrink-0 text-amber-400" />
        )}
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          {allClear
            ? `${summary.matchedCount} of ${summary.totalCount} teams match official totals`
            : `${summary.matchedCount} of ${summary.totalCount} teams match official totals — ${mismatched.length + officialOnly.length + computedOnly.length} to review`}
        </h4>
      </div>

      {mismatched.length > 0 ? (
        <div className="space-y-1">
          <p className="text-ui-caption font-semibold text-theme-muted uppercase tracking-widest">
            Score disagrees with official total
          </p>
          <ul className="space-y-1">
            {mismatched.map(entry => (
              <li key={entry.team} className="flex items-center justify-between gap-3 text-ui-caption">
                <span className="text-[var(--text-primary)]">{entry.team}</span>
                <span className="font-mono tabular-nums">
                  <span className="text-theme-secondary">{entry.computed!.toFixed(1)} computed vs {entry.official!.toFixed(1)} official</span>{' '}
                  <span className={entry.delta! > 0 ? 'text-points-positive' : 'text-points-negative'}>
                    ({formatDelta(entry.delta!)})
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {officialOnly.length > 0 ? (
        <div className="space-y-1">
          <p className="text-ui-caption font-semibold text-theme-muted uppercase tracking-widest flex items-center gap-1.5">
            <HelpCircle size={12} /> Official total with no matching computed team
          </p>
          <ul className="space-y-1">
            {officialOnly.map(entry => (
              <li key={entry.team} className="text-ui-caption text-[var(--text-primary)]">
                {entry.team} — {entry.official!.toFixed(1)} official
                <span className="text-theme-muted"> — likely a team-name mapping miss, not a scoring gap</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {computedOnly.length > 0 ? (
        <div className="space-y-1">
          <p className="text-ui-caption font-semibold text-theme-muted uppercase tracking-widest">
            Computed team with no official total
          </p>
          <ul className="space-y-1">
            {computedOnly.map(entry => (
              <li key={entry.team} className="text-ui-caption text-[var(--text-primary)]">
                {entry.team} — {entry.computed!.toFixed(1)} computed
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
