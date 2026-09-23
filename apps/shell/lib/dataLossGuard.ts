/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data-loss guard for `PUT /api/workspaces/:id`.
 *
 * On 2026-09-22 a workspace held 550 men's meet results at 14:05 and 0
 * afterwards. A startup backup existed on disk the whole time, but nothing
 * told the user it had been taken, or that the save that just happened had
 * wiped the collection it protected. This module is the pure detection half
 * of the fix: it never touches the filesystem or the network, so it can be
 * unit-tested without a server.
 *
 * User decision (2026-09-22): warn and offer the backup; never block a
 * deliberate save. This module only decides "did something sharply drop" —
 * the route (`apps/shell/server.ts`) decides what to do about it (take a
 * `pre-shrink` backup, save anyway, report the warning in the response).
 */
import path from 'node:path';
import type { Workspace } from '../../../packages/core/src/types.ts';

/** Collections this guard watches. Add here, not ad hoc, if another one needs it. */
export const DATA_LOSS_COLLECTIONS = ['menResults', 'womenResults', 'athleteHistory'] as const;

export type DataLossCollection = (typeof DATA_LOSS_COLLECTIONS)[number];

/**
 * Counts for the watched collections, keyed by collection name.
 *
 * A key's ABSENCE is meaningful and distinct from a count of 0: it means the
 * source object did not carry that collection at all (e.g. a PUT patch that
 * never mentions `menResults`). {@link detectSharpDrops} uses that distinction
 * to decide whether a patch touched a collection in the first place — a patch
 * that never mentions `menResults` cannot be blamed for losing it.
 */
export type CollectionCounts = Partial<Record<DataLossCollection, number>>;

export interface DataLossDrop {
  readonly collection: DataLossCollection;
  readonly from: number;
  readonly to: number;
}

export interface DataLossWarning {
  readonly drops: DataLossDrop[];
  /** Bare filename of the `pre-shrink` backup taken before the save, or null if the backup itself failed. */
  readonly backupFile: string | null;
  /** Set only when the backup attempt failed. The save proceeds regardless. */
  readonly backupError?: string;
}

/**
 * A "sharp drop": the previous count was large enough that losing it is
 * unlikely to be a coach deliberately trimming a handful of rows, and the new
 * count either zeroes it out or halves it outright.
 *
 * Threshold agreed with the user for the 2026-09-22 incident: previous >= 20
 * AND (next === 0 OR next < previous / 2).
 */
export function isSharpDrop(previous: number, next: number): boolean {
  return previous >= 20 && (next === 0 || next < previous / 2);
}

/**
 * Extract watched-collection counts from a workspace or a PUT patch.
 *
 * A collection is included only when the source actually carries an array
 * for it. That is deliberate: it lets {@link detectSharpDrops} distinguish "the
 * patch sets this to empty" (present, length 0) from "the patch doesn't
 * mention this" (absent) — the latter must never be treated as a drop to 0.
 */
export function collectionCounts(source: Partial<Workspace> | undefined | null): CollectionCounts {
  const counts: CollectionCounts = {};
  if (!source) return counts;
  const record = source as Record<string, unknown>;
  for (const collection of DATA_LOSS_COLLECTIONS) {
    const value = record[collection];
    if (Array.isArray(value)) counts[collection] = value.length;
  }
  return counts;
}

/**
 * Compare the workspace as stored to the counts an incoming PUT patch would
 * produce, and report every watched collection that sharply dropped.
 *
 * Only collections present in `incomingCounts` are considered — see
 * {@link collectionCounts}. Each collection is judged independently, so a
 * patch that drops `menResults` from 550 to 0 while leaving `womenResults`
 * untouched reports exactly one drop.
 */
export function detectSharpDrops(
  previousCounts: CollectionCounts,
  incomingCounts: CollectionCounts
): DataLossDrop[] {
  const drops: DataLossDrop[] = [];
  for (const collection of DATA_LOSS_COLLECTIONS) {
    if (!(collection in incomingCounts)) continue;
    const from = previousCounts[collection] ?? 0;
    const to = incomingCounts[collection] ?? 0;
    if (isSharpDrop(from, to)) drops.push({ collection, from, to });
  }
  return drops;
}

/** The slice of {@link WorkspaceRepo} the guard needs. Kept narrow so tests
 * can hand it a fake without implementing the whole interface. */
export interface WorkspaceUpdateRepo {
  list(): Promise<Workspace[]>;
  backup(label?: string): Promise<string>;
  update(id: string, patch: Partial<Workspace>, expectedVersion?: number): Promise<Workspace | undefined>;
}

export interface GuardedUpdateResult {
  readonly updated: Workspace | undefined;
  readonly dataLossWarning?: DataLossWarning;
}

/**
 * Orchestrates the data-loss guard around a single `PUT /api/workspaces/:id`
 * save: looks up the workspace as currently stored, detects a sharp drop in
 * any watched collection, takes a `pre-shrink` backup BEFORE saving if one is
 * found, then applies the patch regardless of whether the backup succeeded.
 *
 * The backup is best-effort — see `repo.backup`'s callers elsewhere in
 * `server.ts` for the same rule applied to deletes and restores. A failed
 * backup is reported in `dataLossWarning.backupError`, never thrown, and
 * never blocks the save: the user decision behind this whole guard is "warn
 * and offer the backup; never block a deliberate save."
 *
 * Pulled out of the route handler so the wiring — not just the pure
 * detection above — can be exercised in a test against a real repo, without
 * booting the Express app in `server.ts`.
 */
export async function applyWorkspaceUpdateWithGuard(
  repo: WorkspaceUpdateRepo,
  id: string,
  patch: Partial<Workspace>,
  expectedVersion?: number
): Promise<GuardedUpdateResult> {
  const incomingCounts = collectionCounts(patch);
  let dataLossWarning: DataLossWarning | undefined;

  if (Object.keys(incomingCounts).length > 0) {
    const existing = (await repo.list()).find(w => w.id === id);
    const drops = detectSharpDrops(collectionCounts(existing), incomingCounts);
    if (drops.length > 0) {
      let backupFile: string | null = null;
      let backupError: string | undefined;
      try {
        backupFile = path.basename(await repo.backup('pre-shrink'));
      } catch (err) {
        backupError = err instanceof Error ? err.message : String(err);
      }
      dataLossWarning = backupError ? { drops, backupFile, backupError } : { drops, backupFile };
    }
  }

  const updated = await repo.update(id, patch, expectedVersion);
  return dataLossWarning ? { updated, dataLossWarning } : { updated };
}
