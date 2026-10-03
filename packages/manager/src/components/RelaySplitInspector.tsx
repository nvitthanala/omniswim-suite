/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Known (PDF) vs calculated splits" panel inside IndRelayManagementView's
 * relay split inspector card — split out of the view's own function body.
 */
import type { RelaySplitComparison } from '@omniswim/core/lib/relayBuilder';

type Props = {
  rows: RelaySplitComparison[];
  eventLabel: string;
};

export default function RelaySplitInspector({ rows, eventLabel }: Props) {
  if (rows.length === 0) return null;

  return (
    <div className="mb-4 border border-theme-soft rounded-lg p-3 surface-muted-bg">
      <p className="text-ui-micro text-theme-secondary mb-2">
        Known (PDF) vs calculated splits · {eventLabel}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {rows.map(row => (
          <div key={row.legIndex} className="text-ui-caption flex justify-between gap-2">
            <span className="text-[var(--text-primary)] truncate">
              L{row.legIndex + 1} {row.swimmerName}
            </span>
            <span className="font-mono text-theme-secondary shrink-0">
              {row.knownSplit ?? '—'}
              {row.calculatedSplit ? (
                <span className="text-[var(--text-accent)] ml-1">
                  / {row.calculatedSplit}
                  {row.deltaSec != null ? ` (${row.deltaSec >= 0 ? '+' : ''}${row.deltaSec.toFixed(2)}s)` : ''}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
