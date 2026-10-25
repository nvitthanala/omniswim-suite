/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ArrowUp } from 'lucide-react';

type Props = {
  /** Step name shown as the eyebrow, e.g. "Lineup". */
  eyebrow: string;
  title: string;
  description: string;
};

/**
 * "Choose a team" state for the Lineup, Relays and Optimize steps.
 *
 * It holds no control. The Manager team bar above the step is the one place a
 * team is chosen, so this state only points at it. (It used to render its own
 * row of team buttons, which made a second picker beside the bar.)
 */
export default function TeamPickerEmptyState({ eyebrow, title, description }: Props) {
  return (
    <div className="surface-card rounded-xl p-6 sm:p-8 flex flex-col items-center text-center gap-4">
      <span className="inline-flex items-center justify-center w-14 h-14 rounded-xl surface-overlay border border-theme-soft text-[var(--text-accent)]">
        <ArrowUp size={28} aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-ui-caption font-semibold text-theme-muted">{eyebrow}</p>
        <h3 className="text-heading-3 text-[var(--text-primary)]">{title}</h3>
        <p className="text-ui-body text-theme-secondary max-w-md">{description}</p>
      </div>
    </div>
  );
}
