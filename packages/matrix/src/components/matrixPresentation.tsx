/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type { SwimmerResult } from '@omniswim/core/types';
import { displayTimeForRelayLeg } from '@omniswim/core/lib/relaySplits';

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

export function PointsValue({
  value,
  className,
}: {
  value: number | string;
  className?: string;
}) {
  const isZero = typeof value === 'number' ? value === 0 : value === '0' || value === 'N/A';
  const label =
    value === 'N/A'
      ? 'N/A'
      : typeof value === 'number'
        ? value > 0
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
