/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Presentational view shared by saved-scenario and loaded-meet comparisons.
 */

import React from 'react';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { ABSENT_LABEL, rowStatus, sidePointsLabel } from './scenarioCompareView';

type Props = {
  result: ScenarioDiffResult;
  emptyMessage: string;
};

function formatDiff(diff: number): string {
  const abs = Math.abs(diff).toFixed(1);
  return diff >= 0 ? `+${abs}` : `-${abs}`;
}

/** Signed delta text colored with the panel's existing +/- semantic tokens. */
function DeltaText({ value, className = '' }: { value: number; className?: string }) {
  const cls =
    Math.abs(value) < 1e-6
      ? 'text-theme-muted'
      : value > 0
        ? 'text-points-positive'
        : 'text-points-negative';
  return (
    <span className={`font-mono tabular-nums ${cls} ${className}`}>{formatDiff(value)}</span>
  );
}

/** "Added" or "Removed" as plain text beside a name. Nothing when both sides hold the row. */
function StatusText({ inThen, inNow }: { inThen: boolean; inNow: boolean }) {
  const status = rowStatus(inThen, inNow);
  if (status === null) return null;
  return <span className="text-theme-muted"> ({status})</span>;
}

export function ScenarioDiffView({ result, emptyMessage }: Props) {
  return (
    <div className="mt-2.5 border-t border-theme-soft pt-2.5">
      <div className="flex items-center justify-between gap-2 text-ui-micro font-mono tabular-nums">
        <span className="text-theme-secondary">
          Then {sidePointsLabel(result.totals.inThen, result.totals.then)} → Now{' '}
          {sidePointsLabel(result.totals.inNow, result.totals.now)}
        </span>
        {result.totals.inThen || result.totals.inNow ? (
          <DeltaText value={result.totals.delta} className="text-ui-caption" />
        ) : (
          <span className="font-mono tabular-nums text-theme-muted text-ui-caption">{ABSENT_LABEL}</span>
        )}
      </div>
      {result.events.length === 0 && result.swimmers.length === 0 ? (
        <p className="text-ui-micro text-theme-muted mt-1.5">{emptyMessage}</p>
      ) : (
        <>
          {result.events.length > 0 ? (
            <div className="mt-2">
              <p className="text-ui-micro font-semibold text-theme-secondary mb-1">By event</p>
              <ul className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
                {result.events.map(ev => (
                  <li
                    key={ev.event}
                    className="flex items-baseline justify-between gap-2 text-ui-micro"
                  >
                    <span className="text-theme-secondary truncate" title={ev.event}>
                      {ev.event}
                      <StatusText inThen={ev.inThen} inNow={ev.inNow} />
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-theme-muted">
                      {sidePointsLabel(ev.inThen, ev.pointsThen)}→{sidePointsLabel(ev.inNow, ev.pointsNow)}{' '}
                      <DeltaText value={ev.delta} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.swimmers.length > 0 ? (
            <div className="mt-2">
              <p className="text-ui-micro font-semibold text-theme-secondary mb-1">Top movers</p>
              <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {result.swimmers.map(sw => (
                  <li key={`${sw.isRelay ? 'relay' : 'ind'}:${sw.name}`}>
                    <div className="flex items-baseline justify-between gap-2 text-ui-micro">
                      <span className="text-[var(--text-primary)] truncate" title={sw.name}>
                        {sw.name}
                        {sw.isRelay ? <span className="text-theme-muted"> · relay</span> : null}
                        <StatusText inThen={sw.inThen} inNow={sw.inNow} />
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-theme-muted">
                        {sidePointsLabel(sw.inThen, sw.pointsThen)}→{sidePointsLabel(sw.inNow, sw.pointsNow)}{' '}
                        <DeltaText value={sw.deltaPoints} />
                      </span>
                    </div>
                    {sw.eventsAdded.length > 0 ||
                    sw.eventsRemoved.length > 0 ||
                    sw.eventsChanged.length > 0 ? (
                      <p className="text-ui-micro text-theme-muted leading-snug">
                        {[
                          ...sw.eventsAdded.map(e => `+ ${e}`),
                          ...sw.eventsRemoved.map(e => `− ${e}`),
                          ...sw.eventsChanged.map(
                            c => `${c.event}: ${c.timeThen || '—'} → ${c.timeNow || '—'}`
                          ),
                        ].join(' · ')}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
