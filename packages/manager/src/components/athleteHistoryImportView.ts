/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure derived-data helpers for AthleteHistoryImportPanel — action/badge
 * labeling and the new/improved/same diff against the workspace's existing
 * athleteHistory. No JSX. Split out per this repo's `X.tsx` + `XParts.tsx` +
 * `XView.ts` convention (see `crossCourseArbitrageView.ts`) — this file was
 * previously inlined at the top of a 767-line monolithic component.
 */

import { Gender, HistoricalSwim, SwimCloudBadge, Workspace } from '@omniswim/core/types';
import { normalizeEventLabel } from '@omniswim/core/lib/athleteHistory';
import { rosterNamesForTeam, type ImportSwimmerAction } from '@omniswim/core/lib/historyImportRoster';
import type { AliasNameEntry, AthleteAliasResolver } from '@omniswim/core/lib/athleteAliases';
import { convertTimeToSeconds, foldDiacritics, normalizeSwimmerName } from '@omniswim/core/lib/utils';

export function actionBadge(action: ImportSwimmerAction): { label: string; className: string } {
  switch (action) {
    case 'new_recruit':
      return { label: 'New recruit', className: 'text-[var(--text-accent)] border-[var(--text-accent)]/30' };
    case 'add_to_lineup':
      return { label: 'Add to lineup', className: 'badge-info' };
    case 'already_recruit':
      return { label: 'Already recruit', className: 'badge-warning' };
    case 'history_matched':
    default:
      return { label: 'History only (matched)', className: 'text-theme-muted border-theme-soft' };
  }
}

export function badgeLabel(badge?: SwimCloudBadge): string | null {
  switch (badge) {
    case 'extracted':
      return 'Official';
    case 'user_input':
      return 'Manual';
    case 'd1_a':
      return 'A CUT';
    case 'd1_b':
      return 'B CUT';
    case 'other':
      return 'Tag';
    default:
      return null;
  }
}

/** Diacritic/course-insensitive-name + event + course key used to diff a parsed swim against athleteHistory. */
export function diffMatchKey(name: string, team: string, event: string, timeType?: string): string {
  const foldedName = foldDiacritics(normalizeSwimmerName(name));
  const normEvent = normalizeEventLabel(event).toLowerCase();
  return `${foldedName}|${team.trim().toLowerCase()}|${normEvent}|${timeType ?? 'SCY'}`;
}

/**
 * Best (fastest) existing seconds per athlete+event+course, from the workspace's
 * athleteHistory. Names are resolved through the alias resolver first so a
 * confirmed link ("Stevie" -> "Steven") unifies the diff onto one identity.
 */
export function buildHistoryBestIndex(
  history: HistoricalSwim[],
  resolver: AthleteAliasResolver
): Map<string, number> {
  const map = new Map<string, number>();
  for (const h of history) {
    const resolvedName = resolver.resolveAthleteName(h.name, h.team, h.gender);
    const key = diffMatchKey(resolvedName, h.team, h.event, h.timeType);
    const sec = convertTimeToSeconds(h.time);
    const prev = map.get(key);
    if (prev == null || sec < prev) map.set(key, sec);
  }
  return map;
}

/** Roster names (results + recruits) for a team/gender — the "existing" side of alias suggestions. */
export function rosterNameEntriesForTeam(workspace: Workspace, team: string, gender: Gender): AliasNameEntry[] {
  return rosterNamesForTeam(workspace, team, gender).map(name => ({ name, team, gender }));
}

export type ImportDiffStatus = 'new' | 'improved' | 'same';

export type RowMeta = {
  diffStatus: ImportDiffStatus;
  deltaSec?: number;
  cutTooltip?: string;
};

export type SwimRowTagSpec = {
  key: string;
  show: boolean;
  className: string;
  title?: string;
  label: string;
};

/** The badge-driven tag row for one swim: which chips to show is decided by
 * the SwimCloud badge stamp plus (for A/B cuts) a locally computed fallback.
 * Built as data and filtered, rather than five independent JSX `&&` guards. */
export function buildSwimRowTagSpecs(
  stamp: ReturnType<typeof badgeLabel>,
  swim: HistoricalSwim,
  cutTooltip: string | undefined
): SwimRowTagSpec[] {
  const showComputedA = swim.computedCut === 'A' && swim.swimcloudBadge !== 'd1_a';
  const showComputedB = swim.computedCut === 'B' && swim.swimcloudBadge !== 'd1_b';
  return [
    {
      key: 'official',
      show: stamp === 'Official',
      className: 'text-ui-micro text-theme-secondary border border-theme-soft px-1.5 rounded-full',
      title: 'Extracted official result',
      label: 'Official',
    },
    {
      key: 'manual',
      show: stamp === 'Manual',
      className: 'text-ui-micro badge-warning px-1.5 rounded-full',
      title: 'User-entered time',
      label: 'Manual',
    },
    {
      key: 'a-cut',
      show: stamp === 'A CUT' || showComputedA,
      className: 'text-ui-micro btn-accent-outline px-1.5 rounded-full',
      title: cutTooltip,
      label: 'A CUT',
    },
    {
      key: 'b-cut',
      show: stamp === 'B CUT' || showComputedB,
      className: 'text-ui-micro bg-amber-400/10 text-amber-400 px-1.5 border border-amber-400/30 rounded-full',
      title: cutTooltip,
      label: 'B CUT',
    },
    {
      key: 'tag',
      show: stamp === 'Tag',
      className: 'text-ui-micro text-theme-muted border border-theme-soft px-1.5 rounded-full',
      label: 'Tag',
    },
  ];
}
