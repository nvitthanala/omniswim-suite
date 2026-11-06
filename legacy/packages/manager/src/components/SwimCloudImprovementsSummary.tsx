/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "N swimmers improved in M events" — shown in the SwimCloud import preview
 * before a coach commits, so a re-crawl's payoff is visible up front instead
 * of buried in a 200-row preview table. See
 * `packages/manager/src/lib/swimCloudImprovementDiff.ts` for what counts as
 * an improvement and why it's computed against the workspace's own stored
 * history rather than a second copy of the capture.
 */
import { ChevronDown, ChevronUp, TrendingUp } from 'lucide-react';
import type { SwimCloudEventImprovement, SwimCloudSwimmerImprovements } from '../lib/swimCloudImprovementDiff';

function formatDelta(improvement: SwimCloudEventImprovement): string {
  const altitude = improvement.isAltitudeAdjusted ? ' (altitude adjusted)' : '';
  if (improvement.kind === 'new_event') return `new: ${improvement.newTime}${altitude}`;
  if (improvement.isDiving) {
    return `${improvement.oldTime} → ${improvement.newTime} (+${improvement.deltaScore?.toFixed(2)})${altitude}`;
  }
  return `${improvement.oldTime} → ${improvement.newTime} (−${improvement.deltaSeconds?.toFixed(2)})${altitude}`;
}

type Props = {
  readonly improvements: readonly SwimCloudSwimmerImprovements[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
};

export default function SwimCloudImprovementsSummary({ improvements, expanded, onToggle }: Props) {
  const eventCount = improvements.reduce((n, s) => n + s.improvements.length, 0);

  if (improvements.length === 0) {
    return (
      <p className="text-ui-caption text-theme-muted">
        No swimmers improved on what this workspace already has stored for them.
      </p>
    );
  }

  return (
    <div className="border border-theme-soft rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-ui-caption text-left hover:bg-[var(--surface-muted)] transition-colors"
      >
        <span className="flex items-center gap-1.5 text-[var(--text-accent)]">
          <TrendingUp size={14} className="shrink-0" />
          {improvements.length} swimmer{improvements.length === 1 ? '' : 's'} improved in {eventCount} event
          {eventCount === 1 ? '' : 's'}
        </span>
        {expanded ? <ChevronUp size={14} className="shrink-0" /> : <ChevronDown size={14} className="shrink-0" />}
      </button>
      {expanded ? (
        <ul className="border-t border-theme-soft divide-y divide-[var(--border-soft)] max-h-48 overflow-y-auto custom-scrollbar">
          {improvements.map(swimmer => (
            <li key={swimmer.name} className="px-3 py-2 text-ui-caption">
              <div className="font-medium text-theme-primary">{swimmer.name}</div>
              <ul className="mt-1 space-y-0.5">
                {swimmer.improvements.map(improvement => (
                  <li
                    key={`${improvement.eventIdentity}|${improvement.course ?? ''}`}
                    className="flex flex-wrap items-baseline gap-x-1.5 text-theme-secondary"
                  >
                    <span className="font-mono tabular-nums">{improvement.eventLabel}</span>
                    <span className="font-mono tabular-nums">{formatDelta(improvement)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
