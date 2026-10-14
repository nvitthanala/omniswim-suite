/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure helpers for the two-snapshot compare (F3). No React.
 */

import type { Gender, ScoringSettings } from '@omniswim/core/types';
import { getSnapshotContent, type Snapshot } from '@omniswim/core/api/snapshots';
import {
  requestScenarioDiff,
  type ScenarioDiffResult,
} from '@omniswim/core/lib/scenarioDiffClient';
import { formatCompactDate, parseSnapshotLabel } from './scenarioSnapshotsView';

/** Shown for a swim that has no time. Never "0.00". */
export const NO_TIME_LABEL = 'NT';

export const NO_DIFFERENCES_MESSAGE = 'No differences. These two snapshots score the same.';

/** Text for a clock cell. An empty clock is "no time", not zero. */
export function clockLabel(clock: string | null | undefined): string {
  const trimmed = (clock ?? '').trim();
  return trimmed === '' ? NO_TIME_LABEL : trimmed;
}

/** "+3.0", "-1.5", or "0.0" with no sign when nothing moved. */
export function formatChange(delta: number): string {
  if (Math.abs(delta) < 1e-6) return '0.0';
  const abs = Math.abs(delta).toFixed(1);
  return delta > 0 ? `+${abs}` : `-${abs}`;
}

/** "Name, Oct 14, 123.4 pts". Plain label when it carries no points suffix. */
export function snapshotOptionLabel(snap: Snapshot): string {
  const { name, points, hasPointsSuffix } = parseSnapshotLabel(snap.label);
  let pts = '';
  if (hasPointsSuffix) pts = points != null ? `, ${points.toFixed(1)} pts` : ', no points';
  return `${name}, ${formatCompactDate(snap.createdAt)}${pts}`;
}

export type CompareContext = {
  team: string;
  /** The compare needs a gender. Without one it rejects. */
  gender: Gender | undefined;
  settings?: ScoringSettings;
  removeSeniors?: boolean;
};

/**
 * Score snapshot A ("before") against snapshot B ("after"). Both are fetched
 * read-only and never restored. `computeScenarioDiff(current, snapshot, opts)`
 * takes the "after" workspace first, so B goes first and A second.
 */
export async function compareSnapshots(
  aId: string,
  bId: string,
  ctx: CompareContext
): Promise<ScenarioDiffResult> {
  if (!ctx.team || !ctx.gender) {
    throw new Error('Choose a team before comparing snapshots.');
  }
  const [contentA, contentB] = await Promise.all([getSnapshotContent(aId), getSnapshotContent(bId)]);
  return requestScenarioDiff(contentB, contentA, {
    team: ctx.team,
    gender: ctx.gender,
    settings: ctx.settings,
    removeSeniors: ctx.removeSeniors,
  });
}
