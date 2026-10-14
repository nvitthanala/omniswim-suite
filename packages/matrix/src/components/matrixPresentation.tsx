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
import { noExpectationText, seedsPastTableLabel } from '../lib/noExpectation';

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

/** Formatted label for a points value — 'N/A' as-is, a signed number with an
 *  optional leading '+', or the raw value stringified. */
function formatPointsLabel(value: number | string, signed: boolean): string {
  if (value === 'N/A') return 'N/A';
  if (typeof value !== 'number') return String(value);
  if (signed && value > 0) return `+${value.toFixed(1)}`;
  return value.toFixed(1);
}

function isZeroPointsValue(value: number | string): boolean {
  if (typeof value === 'number') return value === 0;
  return value === '0' || value === 'N/A';
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
  const isZero = isZeroPointsValue(value);
  const label = formatPointsLabel(value, signed);

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

/**
 * The mark for a value that has no actual result yet. A dash on screen and
 * "No result yet" for a screen reader. It is never 0: 0 means a real result
 * that scored nothing.
 */
export function NoActualMarker({
  label = 'No result yet',
  className,
}: {
  /** Replaces the default words for the screen reader and the hover title. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={['font-mono tabular-nums text-ui-micro text-theme-muted whitespace-nowrap', className]
        .filter(Boolean)
        .join(' ')}
      title={label}
      data-no-actual
    >
      <span aria-hidden="true">{'—'}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Shown where a team's expected figure would be, when no seed of the team has an
 * expectation because every seed is past the end of the place-point table:
 * "— (N seeds past table)". Real text, not colour or an icon alone. It is never 0:
 * 0 would read as "expected nothing". `count` is a positive whole number.
 */
export function NoExpectationText({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={['font-mono tabular-nums text-ui-micro text-theme-muted whitespace-nowrap', className]
        .filter(Boolean)
        .join(' ')}
      title="Seeds past the end of the place-point table have no expected points"
      data-no-expectation
    >
      {noExpectationText(count)}
    </span>
  );
}

/**
 * A dash for a figure that cannot be worked out because the team has no expected
 * points (an over/under against nothing). The screen reader hears the reason.
 * Never 0.
 */
export function NoExpectationMarker({
  label = 'No expected points, so no over/under',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={['font-mono tabular-nums text-ui-micro text-theme-muted whitespace-nowrap', className]
        .filter(Boolean)
        .join(' ')}
      title={label}
      data-no-expectation-dash
    >
      <span aria-hidden="true">{'—'}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The note beside a team's expected sum when some of its seeds are past the end
 * of the place-point table: "N seeds past table". The sum covers the other seeds.
 */
export function SeedsPastTableNote({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={['font-mono text-ui-micro text-theme-muted whitespace-nowrap', className]
        .filter(Boolean)
        .join(' ')}
      title="The sum leaves these seeds out: the place-point table has no row for them"
      data-seeds-past-table
    >
      {seedsPastTableLabel(count)}
    </span>
  );
}

/** Compact prelims over/under badge (+5.0 vs prelims). */
export function PrelimsOuValue({
  value,
  compact = false,
  className,
  noActual = false,
}: {
  value: number | undefined | null;
  compact?: boolean;
  className?: string;
  /** The entry has no actual yet: with no value to show, draw the "No result yet" mark instead of nothing. */
  noActual?: boolean;
}) {
  if (value == null && noActual) return <NoActualMarker className={className} />;
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

/** First available team-level time for a relay leg, fastest-known-first. */
function relayTeamDisplayTime(result: SwimmerResult): string | undefined {
  return result.relayTeamTime || result.finalsTime || result.time;
}

function isRelayLegResult(result: SwimmerResult): boolean {
  return Boolean(result.isRelay && (result.relayLegSplitDetail || result.relayLegSplit));
}

export function SwimTimeCell({ result }: { result: SwimmerResult }) {
  if (isRelayLegResult(result)) {
    const teamTime = relayTeamDisplayTime(result);
    return (
      <div className="min-w-0 text-right font-mono tabular-nums text-ui-caption">
        <span className="text-[var(--text-primary)]">{displayTimeForRelayLeg(result)}</span>
        {teamTime ? (
          <span className="block text-ui-micro text-theme-muted">Relay {teamTime}</span>
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
