/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Possible same athlete" list — renders suggestAliasCandidates() output for
 * confirmation. Purely presentational: linking/dismissing is delegated to the
 * host panel (which owns the workspace patch + undo/toast wiring). Dismiss is
 * session-local (tracked by the host, never persisted).
 */

import React, { useState } from 'react';
import { Link2, X } from 'lucide-react';
import type { AliasSuggestion } from '@omniswim/core/lib/athleteAliases';

const VISIBLE_CAP = 8;

/** Stable key for a suggestion pair — used for dismiss-tracking and list keys. */
export function aliasSuggestionKey(s: AliasSuggestion): string {
  return `${s.existing.name}|${s.existing.team ?? ''}|${s.incoming.name}|${s.incoming.team ?? ''}|${s.incoming.gender}`;
}

type Props = {
  suggestions: AliasSuggestion[];
  /** Session-local hidden suggestion keys (see aliasSuggestionKey). */
  dismissed: Set<string>;
  onLink: (suggestion: AliasSuggestion) => void;
  onDismiss: (key: string) => void;
};

export default function AliasSuggestionsPanel({ suggestions, dismissed, onLink, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false);

  const visible = suggestions.filter(s => !dismissed.has(aliasSuggestionKey(s)));
  if (visible.length === 0) return null;

  const shown = expanded ? visible : visible.slice(0, VISIBLE_CAP);
  const remaining = visible.length - shown.length;

  return (
    <div className="mb-3 rounded-xl border border-theme-soft surface-muted-bg p-3">
      <p className="text-ui-caption text-theme-muted mb-2 flex items-center gap-1.5">
        <Link2 size={13} className="text-[var(--text-accent)] shrink-0" />
        Possible same athlete
      </p>
      <ul className="space-y-1.5">
        {shown.map(s => {
          const key = aliasSuggestionKey(s);
          return (
            <li
              key={key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-theme-soft/70 px-2.5 py-2"
            >
              <div className="min-w-0">
                <p className="text-ui-body text-[var(--text-primary)] truncate">
                  <span className="text-theme-secondary">{s.incoming.name}</span>
                  <span className="text-theme-muted mx-1.5">↔</span>
                  {s.existing.name}
                </p>
                <p className="text-ui-caption text-theme-muted truncate">
                  {s.reason} <span className="text-theme-muted/70">· {Math.round(s.score * 100)}%</span>
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => onLink(s)}
                  className="text-ui-caption px-2.5 py-1 btn-accent-outline rounded-lg font-medium"
                >
                  Link
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(key)}
                  className="p-1.5 rounded-lg text-theme-muted hover:text-[var(--text-primary)]"
                  aria-label={`Dismiss suggestion for ${s.incoming.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-ui-caption text-[var(--text-accent)] hover:underline mt-2"
        >
          Show {remaining} more
        </button>
      ) : null}
    </div>
  );
}
