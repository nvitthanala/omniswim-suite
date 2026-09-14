/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Sub-components for ScoringTheoryPanel's parsed-theory preview.
 */

import React from 'react';
import { Wand2 } from 'lucide-react';
import type { ScoringTheoryApplyResult, ParsedScoringTheory } from '@omniswim/core/lib/scoringTheory';

/** One resolved-swimmer-match chip: styling, tooltip, and body text all key
 * off whether the raw name matched a roster entry. */
export function SwimmerMatchChip({
  match,
}: {
  match: ScoringTheoryApplyResult['summary']['resolvedSwimmers'][number];
}) {
  const className = match.matched
    ? 'text-ui-caption px-2 py-1 rounded-lg border max-w-full truncate text-theme-secondary border-theme-soft'
    : 'text-ui-caption px-2 py-1 rounded-lg border max-w-full truncate badge-warning';
  const title = match.matched
    ? `${match.rawName} → ${match.matched} (${Math.round(match.confidence * 100)}%)`
    : `${match.rawName}: no roster match`;
  const renamedSuffix = match.matched && match.matched !== match.rawName ? ` → ${match.matched}` : '';
  const unmatchedSuffix = match.matched ? '' : ' · unmatched';

  return (
    <span className={className} title={title}>
      {match.rawName}
      {renamedSuffix}
      {unmatchedSuffix}
    </span>
  );
}

export function SwimmerMatchesSection({
  resolvedSwimmers,
}: {
  resolvedSwimmers: ScoringTheoryApplyResult['summary']['resolvedSwimmers'];
}) {
  if (resolvedSwimmers.length === 0) return null;
  return (
    <div>
      <p className="text-ui-caption text-theme-muted mb-1.5">Swimmer matches</p>
      <div className="flex flex-wrap gap-1.5">
        {resolvedSwimmers.map(s => (
          <SwimmerMatchChip key={s.rawName} match={s} />
        ))}
      </div>
    </div>
  );
}

export function RelaySquadsSection({ relays }: { relays: ParsedScoringTheory['relays'] }) {
  if (relays.length === 0) return null;
  return (
    <div>
      <p className="text-ui-caption text-theme-muted mb-1.5">Relay squads</p>
      <ul className="text-ui-body text-theme-secondary space-y-1">
        {relays.map(r => (
          <li key={`${r.event}|${r.squad}`} className="break-words">
            <span className="text-[var(--text-primary)]">
              {r.event} {r.squad}
            </span>
            : {r.legs.map(l => l.name).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TheoryWarningsList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="text-ui-caption text-amber-400/90 list-disc list-inside space-y-1">
      {warnings.map((w, i) => (
        <li key={i} className="break-words">
          {w}
        </li>
      ))}
    </ul>
  );
}

export function TheoryApplyFooter({
  applyDisabled,
  preview,
  onApply,
}: {
  applyDisabled?: boolean;
  preview: ScoringTheoryApplyResult;
  onApply: () => void;
}) {
  if (applyDisabled) {
    return (
      <p className="text-ui-caption text-theme-secondary leading-relaxed">
        Enable <strong className="text-[var(--text-primary)]">What-if</strong> to apply the theory to
        the roster.
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onApply}
      className="text-ui-label text-[var(--text-accent)] hover:underline font-semibold flex items-center gap-1.5"
    >
      <Wand2 size={14} />
      Apply theory ({preview.summary.entriesAdded} entries · {preview.summary.relayLegsAssigned} relay
      legs)
    </button>
  );
}
