/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Users } from 'lucide-react';
import { EmptyState } from '@omniswim/ui';

type Props = {
  /** Step name shown as the eyebrow, e.g. "Lineup". */
  eyebrow: string;
  title: string;
  description: string;
  teams: string[];
  onSelectTeam: (team: string) => void;
};

/**
 * "Choose a team" state that actually lets you choose one.
 *
 * These three steps previously rendered a bare `EmptyState` telling the user to
 * select a team while showing no control that could select one — a dead end on
 * every step after Source. The team list lives one component up, so pass it in
 * and render it here.
 */
export default function TeamPickerEmptyState({
  eyebrow,
  title,
  description,
  teams,
  onSelectTeam,
}: Props) {
  if (teams.length === 0) {
    return (
      <EmptyState
        icon={<Users size={28} />}
        eyebrow={eyebrow}
        title="No scoreable team yet"
        description="Load a meet in Matrix, or import swimmers on the Source step, to get a team here."
      />
    );
  }

  return (
    <div className="surface-card rounded-xl p-6 sm:p-8 flex flex-col items-center text-center gap-4">
      <span className="inline-flex items-center justify-center w-14 h-14 rounded-xl surface-overlay border border-theme-soft text-[var(--text-accent)]">
        <Users size={28} />
      </span>
      <div className="space-y-1">
        <p className="text-ui-micro font-bold uppercase tracking-widest text-theme-muted">{eyebrow}</p>
        <h3 className="text-heading-3 text-[var(--text-primary)]">{title}</h3>
        <p className="text-ui-body text-theme-secondary max-w-md">{description}</p>
      </div>
      <div
        className="flex flex-wrap justify-center gap-2 pt-1"
        role="group"
        aria-label={`Choose a team for ${eyebrow}`}
      >
        {teams.map(team => (
          <button
            key={team}
            type="button"
            onClick={() => onSelectTeam(team)}
            className="px-4 py-2 rounded-lg border border-theme-soft theme-hover-row text-ui-label text-[var(--text-primary)] hover:text-[var(--text-accent)] hover:border-[var(--text-accent)] transition-colors"
          >
            {team}
          </button>
        ))}
      </div>
    </div>
  );
}
