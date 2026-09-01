/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Section components for ScenarioSnapshotsPanel — the save form and the
 * scenario list body (loading / error / empty / populated states). Split out
 * so the panel's top-level return is a short sequence of sections instead of
 * one long conditional tree.
 */

import React from 'react';
import { Camera, Loader2 } from 'lucide-react';
import type { Snapshot } from '@omniswim/core/api/snapshots';
import type { ScenarioDiffResult } from '@omniswim/core/lib/scenarioDiffClient';
import { Button } from '@omniswim/ui';
import ScenarioSnapshotRow from './ScenarioSnapshotRow';

type SaveScenarioFormProps = {
  name: string;
  onNameChange: (name: string) => void;
  saving: boolean;
  scoringSettled: boolean;
  onSave: () => void;
};

export function SaveScenarioForm({ name, onNameChange, saving, scoringSettled, onSave }: SaveScenarioFormProps) {
  const disabled = saving || !name.trim() || !scoringSettled;
  return (
    <div className="mb-3.5">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="Scenario name"
          className="glass-input flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-ui-caption"
          onKeyDown={e => {
            if (e.key === 'Enter' && !saving && scoringSettled) onSave();
          }}
        />
        {/* Gated on the scoring worker settling so a freshly-mounted page can't
            capture a transient "· N pts" total in the scenario label. */}
        <span title={scoringSettled ? undefined : 'Waiting for the projected total to finish recalculating'}>
          <Button variant="outline" size="sm" onClick={onSave} disabled={disabled}>
            {saving || !scoringSettled ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            Save
          </Button>
        </span>
      </div>
      {!scoringSettled ? (
        <p className="text-ui-micro text-theme-muted mt-1">
          Recalculating projected total — Save unlocks when it settles.
        </p>
      ) : null}
    </div>
  );
}

type ScenarioListSectionProps = {
  listLoading: boolean;
  listError: string | null;
  hasSnapshots: boolean;
  sorted: Snapshot[];
  shown: Snapshot[];
  expanded: boolean;
  defaultLimit: number;
  onToggleExpanded: () => void;
  projectedTotal?: number;
  editable: boolean;
  diffSupported: boolean;
  confirmId: string | null;
  restoringId: string | null;
  diffId: string | null;
  diffLoadingId: string | null;
  diffResult: ScenarioDiffResult | null;
  onDiffClick: (snap: Snapshot) => void;
  onRestoreClick: (snapshotId: string) => void;
};

/** The list of saved scenarios, or the loading / error / empty state in its place. */
export function ScenarioListSection({
  listLoading,
  listError,
  hasSnapshots,
  sorted,
  shown,
  expanded,
  defaultLimit,
  onToggleExpanded,
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
}: ScenarioListSectionProps) {
  if (listLoading && !hasSnapshots) {
    return (
      <p className="text-ui-caption text-theme-muted flex items-center gap-1.5">
        <Loader2 size={12} className="animate-spin" />
        Loading scenarios…
      </p>
    );
  }
  if (sorted.length === 0) {
    if (listError) return null;
    return <p className="text-ui-caption text-theme-secondary leading-relaxed">No scenarios saved yet.</p>;
  }

  return (
    <>
      <ul className="space-y-2">
        {shown.map(snap => (
          <ScenarioSnapshotRow
            key={snap.id}
            snap={snap}
            projectedTotal={projectedTotal}
            editable={editable}
            diffSupported={diffSupported}
            confirmId={confirmId}
            restoringId={restoringId}
            diffId={diffId}
            diffLoadingId={diffLoadingId}
            diffResult={diffResult}
            onDiffClick={() => onDiffClick(snap)}
            onRestoreClick={() => onRestoreClick(snap.id)}
          />
        ))}
      </ul>
      {sorted.length > defaultLimit ? (
        <button
          type="button"
          onClick={onToggleExpanded}
          className="mt-2 text-ui-caption text-[var(--text-accent)] hover:underline"
        >
          {expanded ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      ) : null}
    </>
  );
}
