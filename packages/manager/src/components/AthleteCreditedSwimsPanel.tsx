/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Trash2, X, Waves } from 'lucide-react';
import type { AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import { formatLegSplitSummary } from '@omniswim/core/lib/relaySplits';

type Props = {
  athleteName: string;
  team: string;
  swims: AthleteCreditedSwim[];
  totalPoints: number;
  onClose: () => void;
  deletable?: boolean;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
  entryLimitLabel?: string;
};

export default function AthleteCreditedSwimsPanel({
  athleteName,
  team,
  swims,
  totalPoints,
  onClose,
  deletable = false,
  onDeleteSwim,
  entryLimitLabel,
}: Props) {
  const credited = swims.filter(s => s.points > 0);
  const other = swims.filter(s => s.points <= 0);
  const colCount = deletable ? 7 : 6;

  const renderRows = (rows: AthleteCreditedSwim[], dimmed = false) =>
    rows.map(swim => (
      <tr
        key={swim.id}
        className={`border-b border-theme-soft/50 text-[11px] ${dimmed ? 'text-theme-muted' : 'text-[var(--text-primary)]'}`}
      >
        <td className="py-1.5 px-2">{swim.event}</td>
        <td className="py-1.5 px-2 text-theme-secondary">{swim.roundSwam?.trim() || '—'}</td>
        <td className="py-1.5 px-2 font-mono tabular-nums">
          <div>{swim.displayTime || swim.time || '—'}</div>
          {swim.kind === 'relay' && swim.relayLegSplitDetail ? (
            <div
              className="text-[9px] text-theme-secondary font-sans mt-0.5 leading-snug"
              title={formatLegSplitSummary(swim.relayLegSplitDetail)}
            >
              {formatLegSplitSummary(swim.relayLegSplitDetail)}
            </div>
          ) : null}
        </td>
        <td className="py-1.5 px-2 text-right text-theme-secondary tabular-nums">
          {swim.rank > 0 ? swim.rank : '—'}
        </td>
        <td className="py-1.5 px-2 text-center">
          <span
            className={`text-[8px] uppercase tracking-wide px-1 py-0.5 rounded ${
              swim.kind === 'relay' ? 'badge-warning' : 'badge-info'
            }`}
          >
            {swim.kind === 'relay' ? 'Relay' : 'Ind'}
          </span>
        </td>
        <td
          className={`py-1.5 px-2 text-right font-mono tabular-nums font-medium ${
            swim.points > 0 ? 'text-[var(--text-accent)]' : 'text-theme-muted'
          }`}
        >
          {swim.points.toFixed(1)}
        </td>
        {deletable ? (
          <td className="py-1.5 px-1 text-center">
            <button
              type="button"
              onClick={() => onDeleteSwim?.(swim)}
              className="p-1 rounded text-theme-muted hover:text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
              title={swim.isRecruit ? 'Remove recruit entry' : 'Remove this swim from projection'}
              aria-label={`Remove ${swim.event}`}
            >
              <Trash2 size={12} />
            </button>
          </td>
        ) : null}
      </tr>
    ));

  return (
    <div className="mt-3 surface-overlay border border-[var(--text-accent)]/25 rounded-lg overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-theme-soft bg-[var(--text-accent)]/5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Waves size={12} className="text-[var(--text-accent)] shrink-0" />
            <h5 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-primary)] truncate">
              Credited swims — {athleteName}
            </h5>
          </div>
          <p className="text-[9px] text-theme-secondary mt-1 truncate" title={team}>
            {team}
            {entryLimitLabel ? (
              <span className="ml-2 text-theme-muted">· {entryLimitLabel}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[10px] font-mono text-[var(--text-accent)] font-bold tabular-nums">
            {totalPoints.toFixed(1)} pts
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-theme-muted hover:text-[var(--text-primary)] transition-colors"
            aria-label="Close swim breakdown"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {swims.length === 0 ? (
        <p className="p-4 text-[10px] text-theme-muted italic text-center">No swims found for this athlete.</p>
      ) : (
        <>
          {deletable ? (
            <p className="px-3 py-1.5 text-[9px] text-theme-secondary border-b border-theme-soft">
              What-if mode — use the trash icon to remove a swim from the projection.
            </p>
          ) : null}
          <div className="max-h-48 overflow-y-auto custom-scrollbar">
          <table className="w-full">
            <thead className="sticky top-0 surface-overlay text-[9px] uppercase text-theme-secondary border-b border-theme-soft">
              <tr>
                <th className="text-left py-1.5 px-2 font-medium">Event</th>
                <th className="text-left py-1.5 px-2 font-medium">Round</th>
                <th className="text-left py-1.5 px-2 font-medium">Time</th>
                <th className="text-right py-1.5 px-2 font-medium w-10">Pl</th>
                <th className="text-center py-1.5 px-2 font-medium w-14">Type</th>
                <th className="text-right py-1.5 px-2 font-medium w-14">Pts</th>
                {deletable ? <th className="w-8" aria-label="Remove" /> : null}
              </tr>
            </thead>
            <tbody>
              {renderRows(credited)}
              {other.length > 0 ? (
                <>
                  <tr>
                    <td
                      colSpan={colCount}
                      className="py-1.5 px-2 text-[8px] uppercase tracking-widest text-theme-muted bg-[var(--surface-muted)]/50"
                    >
                      Non-scoring swims ({other.length})
                    </td>
                  </tr>
                  {renderRows(other, true)}
                </>
              ) : null}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
