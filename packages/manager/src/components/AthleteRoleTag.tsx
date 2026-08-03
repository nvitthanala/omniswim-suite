/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared role/recruit pill — used by the roster table rows and the athlete
 * lineup drawer header. Split out of TeamRosterPanel so the drawer (which is
 * rendered as a sibling of the table, not a child) doesn't need a circular
 * import back into it.
 */

import React from 'react';
import type { ScorerRosterAthleteRole } from '@omniswim/core/lib/scorerRoster';

export default function AthleteRoleTag({
  role,
  isRecruit,
}: {
  role: ScorerRosterAthleteRole;
  isRecruit?: boolean;
}) {
  if (isRecruit) {
    return (
      <span className="shrink-0 px-1.5 py-0.5 rounded-full text-ui-caption font-medium text-[var(--text-accent)] border border-[var(--text-accent)]/30">
        Recruit
      </span>
    );
  }
  const isDiver = role === 'diver';
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded-full text-ui-caption font-medium ${
        isDiver ? 'badge-warning' : 'badge-info'
      }`}
    >
      {isDiver ? 'Diver' : 'Swimmer'}
    </span>
  );
}
