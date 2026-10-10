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
  /**
   * A relay of a theoretical meet: the "known" splits are flat-start individual bests, summed into an
   * estimate, not splits from a PDF. The label says so. The comparison itself is unchanged.
   */
  estimated?: boolean;
};

export const RELAY_SPLIT_KNOWN_LABEL = 'Known (PDF)';
export const RELAY_SPLIT_ESTIMATED_LABEL = 'Estimated (flat-start best)';

export default function RelaySplitInspector({ rows, eventLabel, estimated = false }: Props) {
  if (rows.length === 0) return null;

  return (
    <div className="mb-4 border border-theme-soft rounded-lg p-3 surface-muted-bg">
      <p className="text-ui-micro text-theme-secondary mb-2" data-relay-split-label={estimated ? 'estimated' : 'known'}>
        {estimated ? RELAY_SPLIT_ESTIMATED_LABEL : RELAY_SPLIT_KNOWN_LABEL} vs calculated splits · {eventLabel}
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
