/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Final confirm before a SwimCloud replace reimport runs (plans/2026-09-24,
 * item A1) — same destructive-confirm shape as every other delete in this
 * suite (`@omniswim/ui`'s `ConfirmDeleteModal`, e.g.
 * `apps/shell/src/lib/dataLossWatcher.ts`'s Restore action). The preview
 * (`SwimCloudReplacePreviewPanel`) has already shown exactly what goes; this
 * is the one more click before it does.
 */
import type { SwimCloudReplacePreview } from '@omniswim/core/lib/historyImportRoster';
import { ConfirmDeleteModal } from '@omniswim/ui';
import { describeReplaceCounts } from '../lib/swimCloudReplaceFlow';

type Props = {
  preview: SwimCloudReplacePreview;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
};

export default function SwimCloudReplaceConfirmModal({ preview, onConfirm, onCancel, busy }: Props) {
  const removedCounts = {
    history: preview.historyToRemove.length,
    recruits: preview.recruitsToRemove.length,
    plans: preview.plansToRemove.length,
  };
  return (
    <ConfirmDeleteModal
      title="Replace SwimCloud data?"
      description={`${preview.team} (${preview.gender})`}
      warning={
        <>
          This removes {describeReplaceCounts(removedCounts)} for {preview.team}. Manual and PDF data
          stay. A backup is saved first, and lineup entries removed include scoring-theory (optimizer)
          plans — re-run the scoring theory afterward.
        </>
      }
      confirmLabel={busy ? 'Backing up…' : 'Back up & replace'}
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      busy={busy}
    />
  );
}
