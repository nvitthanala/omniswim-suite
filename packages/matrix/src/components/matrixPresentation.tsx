/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type { SwimmerResult } from '@omniswim/core/types';
import { displayTimeForRelayLeg } from '@omniswim/core/lib/relaySplits';
import {
  compactEventTitleAttr,
  formatCompactEventLabel,
} from '@omniswim/core/lib/utils';

export function AthleteName({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={['truncate text-ui-body font-medium text-[var(--text-primary)]', className].filter(Boolean).join(' ')}
      title={name}
    >
      {name}
    </span>
  );
}

export function TeamName({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={['truncate text-ui-caption text-theme-secondary', className].filter(Boolean).join(' ')}
      title={name}
    >
      {name}
    </span>
  );
}

/** Compact event label (E6 200IM) with full name on hover. */
export function CompactEventLabel({ event, className }: { event: string; className?: string }) {
  const compact = formatCompactEventLabel(event);
  const full = compactEventTitleAttr(event);
  return (
    <span
      className={className}
      title={full !== compact ? full : undefined}
    >
      {compact}
    </span>
  );
}

export function PointsValue({
  value,
  className,
  signed = true,
}: {
  value: number | string;
  className?: string;
  /** When false, show credited meet points without a leading + (O/U uses PrelimsOuValue). */
  signed?: boolean;
}) {
  const isZero = typeof value === 'number' ? value === 0 : value === '0' || value === 'N/A';
  const label =
    value === 'N/A'
      ? 'N/A'
      : typeof value === 'number'
        ? signed && value > 0
          ? `+${value.toFixed(1)}`
          : value.toFixed(1)
        : String(value);

  return (
    <span
      className={[
        'font-mono tabular-nums text-ui-caption font-medium text-right',
        isZero || value === 'N/A' ? 'text-theme-secondary' : 'text-points-positive',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {label}
    </span>
  );
}

/** Compact prelims over/under badge (+5.0 vs prelims). */
export function PrelimsOuValue({
  value,
  compact = false,
  className,
}: {
  value: number | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (value == null || Math.abs(value) <= 0.05) return null;
  const positive = value > 0;
  const label = compact
    ? `${positive ? '+' : ''}${value.toFixed(1)}`
    : `${positive ? '+' : ''}${value.toFixed(1)} vs prelims`;
  return (
    <span
      className={[
        'font-mono tabular-nums text-ui-micro font-bold whitespace-nowrap',
        positive ? 'text-points-positive' : 'text-points-negative',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title="Over/under vs prelims placement expected"
    >
      {label}
    </span>
  );
}

/** Compact placement-expected points badge (prelims or psych anchor). */
export function PlacementExpectedValue({
  value,
  label,
  className,
}: {
  value?: number;
  label: 'Prelims' | 'Psych';
  className?: string;
}) {
  if (value == null || value <= 0) return null;
  const short = label === 'Prelims' ? 'P' : 'Ps';
  return (
    <span
      className={[
        'font-mono tabular-nums text-ui-micro text-theme-muted whitespace-nowrap',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={`${label} placement expected points`}
    >
      {short}:{value.toFixed(1)}
    </span>
  );
}

export function SwimTimeCell({ result }: { result: SwimmerResult }) {
  const isRelayLeg = Boolean(result.isRelay && (result.relayLegSplitDetail || result.relayLegSplit));

  if (isRelayLeg) {
    return (
      <div className="min-w-0 text-right font-mono tabular-nums text-ui-caption">
        <span className="text-[var(--text-primary)]">{displayTimeForRelayLeg(result)}</span>
        {result.relayTeamTime || result.finalsTime || result.time ? (
          <span className="block text-ui-micro text-theme-muted">
            Relay {result.relayTeamTime || result.finalsTime || result.time}
          </span>
        ) : null}
      </div>
    );
  }

  if (result.finalsTime) {
    return (
      <span className="font-mono tabular-nums text-ui-caption text-theme-secondary">
        F:{result.finalsTime}
      </span>
    );
  }

  if (result.prelimsTime) {
    return (
      <span className="font-mono tabular-nums text-ui-caption text-theme-muted">
        P:{result.prelimsTime}
      </span>
    );
  }

  return (
    <span className="font-mono tabular-nums text-ui-caption text-theme-secondary">{result.time}</span>
  );
}

type MatrixRowProps = {
  rank?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  trailing: ReactNode;
  className?: string;
};

export function MatrixRow({ rank, primary, secondary, trailing, className }: MatrixRowProps) {
  return (
    <div
      className={['matrix-data-grid py-1.5 border-t border-theme-soft first:border-t-0', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="text-ui-micro font-mono tabular-nums text-theme-muted">{rank ?? ''}</div>
      <div className="min-w-0">{primary}</div>
      <div className="min-w-0 text-right">{secondary}</div>
      <div>{trailing}</div>
    </div>
  );
}
