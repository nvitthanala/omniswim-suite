/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One row of ScenarioSnapshotsPanel's scenario list — split out so the
 * per-row diff/restore button state (loading / confirming / open) lives in
 * one small component instead of a long ternary chain in the parent's map.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { Snapshot } from '@omniswim/core/api/snapshots';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { ScenarioDiffView } from './ScenarioDiffView';
import { computeSnapshotDiff, formatCompactDate, formatDiff, parseSnapshotLabel } from './scenarioSnapshotsView';

type Props = {
  snap: Snapshot;
  projectedTotal?: number;
  editable: boolean;
  diffSupported: boolean;
  confirmId: string | null;
  restoringId: string | null;
  diffId: string | null;
  diffLoadingId: string | null;
  diffResult: ScenarioDiffResult | null;
  onDiffClick: () => void;
  onRestoreClick: () => void;
};

function RestoreButtonLabel({ isRestoring, isConfirming }: { isRestoring: boolean; isConfirming: boolean }) {
  if (isRestoring) return <Loader2 size={11} className="animate-spin" />;
  if (isConfirming) return <>Confirm?</>;
  return <>Restore</>;
}

function DiffButtonLabel({ isDiffLoading, isDiffOpen }: { isDiffLoading: boolean; isDiffOpen: boolean }) {
  if (isDiffLoading) return <Loader2 size={11} className="animate-spin" />;
  if (isDiffOpen) return <>Hide diff</>;
  return <>Diff</>;
}

export default function ScenarioSnapshotRow({
  snap,
  projectedTotal,
  editable,
  diffSupported,
  confirmId,
  restoringId,
  diffId,
  diffLoadingId,
  diffResult,
  onDiffClick,
  onRestoreClick,
}: Props) {
  const { name: snapName, points, hasPointsSuffix } = parseSnapshotLabel(snap.label);
  const diff = computeSnapshotDiff(hasPointsSuffix, points, projectedTotal);
  const isConfirming = confirmId === snap.id;
  const isRestoring = restoringId === snap.id;
  const isDiffOpen = diffId === snap.id && diffResult != null;
  const isDiffLoading = diffLoadingId === snap.id;
  const diffButtonDisabled = isDiffLoading || (diffLoadingId != null && !isDiffLoading);

  return (
    <li className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p
            className="text-ui-caption font-semibold text-[var(--text-primary)] truncate"
            title={snapName}
          >
            {snapName}
          </p>
          <p className="text-ui-micro font-mono tabular-nums text-theme-muted mt-0.5">
            {formatCompactDate(snap.createdAt)}
            {hasPointsSuffix ? ` · ${points != null ? `${points.toFixed(1)} pts` : '—'}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {diff != null ? (
            <span
              className={`text-ui-caption font-mono tabular-nums ${
                diff >= 0 ? 'text-points-positive' : 'text-amber-400/80'
              }`}
              title="vs current projected total"
            >
              {formatDiff(diff)}
            </span>
          ) : null}
          {diffSupported ? (
            <button
              type="button"
              onClick={onDiffClick}
              disabled={diffButtonDisabled}
              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold disabled:opacity-50"
              title="Per-event / per-swimmer diff vs the current lineup (does not restore)"
            >
              <DiffButtonLabel isDiffLoading={isDiffLoading} isDiffOpen={isDiffOpen} />
            </button>
          ) : null}
          {editable ? (
            <button
              type="button"
              onClick={onRestoreClick}
              disabled={isRestoring}
              className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold disabled:opacity-50"
            >
              <RestoreButtonLabel isRestoring={isRestoring} isConfirming={isConfirming} />
            </button>
          ) : null}
        </div>
      </div>
      {isDiffOpen && diffResult ? (
        <ScenarioDiffView
          result={diffResult}
          emptyMessage="No differences — this scenario matches the current lineup."
        />
      ) : null}
    </li>
  );
}
