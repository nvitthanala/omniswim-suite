/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * UI-side orchestration for a SwimCloud "replace this team's data" reimport
 * (plans/2026-09-24, item A1). `importHistoryToRoster(..., { mode: 'replace' })`
 * (packages/core/src/lib/historyImportRoster.ts) already decides what a
 * replace removes and keeps; this module is only the two steps a caller must
 * do around it that a pure core function cannot: back the workspace up first,
 * and never run the replace if that backup did not land.
 *
 * Kept separate from the wizard/panel components so the ordering — backup,
 * then import, never the reverse — is one small function a test can call
 * directly, without rendering React.
 */
import type { HistoricalSwim, Recruit, Workspace } from '@omniswim/core/types';
import {
  importHistoryToRoster,
  type HistoryImportRosterOpts,
  type HistoryImportRosterResult,
} from '@omniswim/core/lib/historyImportRoster';

export type SwimCloudImportMode = 'merge' | 'replace';

/**
 * Runs `importHistoryToRoster`. When `opts.mode === 'replace'`, backs the
 * workspace up first via `backup()` and never imports if that call throws —
 * a replace can delete rows a merge never would, so an unbacked-up replace
 * must not run. `backup()` is not called at all for a merge.
 */
export async function performSwimCloudImport(
  workspace: Workspace,
  preview: HistoricalSwim[],
  opts: HistoryImportRosterOpts,
  deps: { backup: () => Promise<unknown> }
): Promise<HistoryImportRosterResult> {
  if (opts.mode === 'replace') {
    await deps.backup();
  }
  return importHistoryToRoster(workspace, preview, opts);
}

/**
 * `Recruit.source` for a row a coach types by hand into the roster (never
 * through a SwimCloud/CSV/PDF import). Set so a later replace reimport can
 * never trace a hand-typed row to a removed SwimCloud swim and delete it —
 * `planSwimCloudReplace` never removes a recruit whose `source` is set and
 * is not SwimCloud's. A no-op when the row already carries a source (an
 * import path building its own `Recruit` sets its own).
 */
export function withManualSource(recruit: Recruit): Recruit {
  return recruit.source != null ? recruit : { ...recruit, source: 'manual' };
}

/** One line naming what a replace preview would remove, for a confirm dialog. */
export function describeReplaceCounts(counts: {
  history: number;
  recruits: number;
  plans: number;
}): string {
  const parts: string[] = [];
  if (counts.history > 0) parts.push(`${counts.history} history row${counts.history === 1 ? '' : 's'}`);
  if (counts.recruits > 0) parts.push(`${counts.recruits} recruit row${counts.recruits === 1 ? '' : 's'}`);
  if (counts.plans > 0) parts.push(`${counts.plans} lineup entr${counts.plans === 1 ? 'y' : 'ies'}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}
