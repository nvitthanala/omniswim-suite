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
import { Badge } from '@omniswim/ui';

// `Badge`'s own defaults are an uppercase, bold, `text-ui-micro` pill --
// this tag renders its labels in normal case at `text-ui-caption`/`font-medium`,
// so every use below overrides those three plus the padding to keep this
// component's original size and case exactly as they were.
const SIZE_OVERRIDE = 'shrink-0 px-1.5 py-0.5 text-ui-caption font-medium normal-case tracking-normal';

export default function AthleteRoleTag({
  role,
  isRecruit,
}: {
  role: ScorerRosterAthleteRole;
  isRecruit?: boolean;
}) {
  if (isRecruit) {
    // The accent tone's own `bg-[var(--text-accent)]/10` fill is dropped here --
    // this pill was always border-and-text-only, no fill.
    return (
      <Badge tone="accent" className={`${SIZE_OVERRIDE} bg-transparent`}>
        Recruit
      </Badge>
    );
  }
  const isDiver = role === 'diver';
  return (
    <Badge tone={isDiver ? 'warning' : 'info'} className={SIZE_OVERRIDE}>
      {isDiver ? 'Diver' : 'Swimmer'}
    </Badge>
  );
}
