/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lineup scenario snapshots side panel for the roster Lineup step. Reuses the
 * workspace snapshot API (SQLite/PostgreSQL backend only) to let a what-if
 * session save named checkpoints of the current lineup ("scenarios"), see how
 * each compares to the live projected total, and restore one back over the
 * active workspace (safety-netted with an automatic backup snapshot first).
 * On the JSON persistence backend (no snapshot support) the panel renders a
 * persistent guided note instead of the save/restore controls.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  createSnapshot,
  getSnapshotContent,
  listSnapshots,
  restoreSnapshot,
  type Snapshot,
} from '@omniswim/core/api/snapshots';
import {
  requestScenarioDiff,
  type ScenarioDiffResult,
} from '@omniswim/core/lib/scenarioDiffClient';
import { useScoringSettled } from '@omniswim/core/lib/useWorkspaceScoring';
import { useToast } from '@omniswim/ui';
import { SaveScenarioForm, ScenarioListSection } from './ScenarioSnapshotsPanelParts';

type Props = {
  workspace: Workspace;
  team: string;
  projectedTotal?: number;
  onUpdate: (patch: Partial<Workspace>) => void;
  editable: boolean;
  /** Enables the per-snapshot Diff drill-down when provided. */
  gender?: Gender;
  /** Settings applied to both sides of the diff (apples-to-apples). */
  scoringSettings?: ScoringSettings;
  /** Mirror of the Lineup step's remove-seniors toggle for diff fidelity. */
  removeSeniors?: boolean;
};

const SNAPSHOTS_DEFAULT_LIMIT = 8;
const CONFIRM_WINDOW_MS = 4000;
const BACKEND_UNSUPPORTED_MESSAGE = 'Snapshots require SQLite or PostgreSQL backend';

export default function ScenarioSnapshotsPanel({
  workspace,
  team,
  projectedTotal,
  onUpdate,
  editable,
  gender,
  scoringSettings,
  removeSeniors,
}: Props) {
  const toast = useToast();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [backendUnsupported, setBackendUnsupported] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scoringSettled = useScoringSettled();
  const [diffId, setDiffId] = useState<string | null>(null);
  const [diffLoadingId, setDiffLoadingId] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<ScenarioDiffResult | null>(null);
  const diffSupported = Boolean(team && gender);

  const workspaceId = workspace.id;

  const fetchSnapshots = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const list = await listSnapshots(workspaceId);
      setSnapshots(list);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load scenarios');
    } finally {
      setListLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchSnapshots();
  }, [fetchSnapshots]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const label = `${trimmed} · ${projectedTotal != null ? projectedTotal.toFixed(1) : '—'} pts`;
      await createSnapshot(workspaceId, label);
      toast.push('success', `Scenario "${trimmed}" saved`);
      setName('');
      await fetchSnapshots();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save scenario';
      if (msg === BACKEND_UNSUPPORTED_MESSAGE) {
        setBackendUnsupported(true);
      } else {
        toast.push('error', msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const doRestore = async (snapshotId: string) => {
    setRestoringId(snapshotId);
    try {
      // Safety net: snapshot the current (about-to-be-overwritten) lineup first.
      const backupLabel = `Backup before restore · ${
        projectedTotal != null ? projectedTotal.toFixed(1) : '—'
      } pts`;
      await createSnapshot(workspaceId, backupLabel);
      const restored = await restoreSnapshot(snapshotId);
      // restoreSnapshot persists server-side and returns the full restored
      // workspace (same id). Handing the whole object to onUpdate — the same
      // updateWorkspace wired throughout the Lineup step — keeps the client
      // provider's cache in sync with what the server just wrote. There is no
      // lighter-weight refresh/invalidate primitive exposed through this
      // panel's props, so this full-workspace patch is the path used.
      onUpdate(restored);
      toast.push('success', 'Scenario restored');
      await fetchSnapshots();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to restore scenario';
      if (msg === BACKEND_UNSUPPORTED_MESSAGE) {
        setBackendUnsupported(true);
      } else {
        toast.push('error', msg);
      }
    } finally {
      setRestoringId(null);
    }
  };

  // Collapse any open diff when the workspace/team/gender context changes.
  useEffect(() => {
    setDiffId(null);
    setDiffResult(null);
  }, [workspaceId, team, gender]);

  const handleDiffClick = async (snap: Snapshot) => {
    if (diffId === snap.id) {
      setDiffId(null);
      setDiffResult(null);
      return;
    }
    if (!diffSupported || !gender || diffLoadingId) return;
    setDiffLoadingId(snap.id);
    try {
      // Read-only fetch — the snapshot is never restored for a diff.
      const content = await getSnapshotContent(snap.id);
      const result = await requestScenarioDiff(workspace, content, {
        team,
        gender,
        settings: scoringSettings,
        removeSeniors,
      });
      setDiffId(snap.id);
      setDiffResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to compute scenario diff';
      if (msg === BACKEND_UNSUPPORTED_MESSAGE) {
        setBackendUnsupported(true);
      } else {
        toast.push('error', msg);
      }
    } finally {
      setDiffLoadingId(null);
    }
  };

  const handleRestoreClick = (snapshotId: string) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (confirmId === snapshotId) {
      setConfirmId(null);
      void doRestore(snapshotId);
      return;
    }
    setConfirmId(snapshotId);
    confirmTimerRef.current = setTimeout(() => setConfirmId(null), CONFIRM_WINDOW_MS);
  };

  if (backendUnsupported) {
    return (
      <div className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-2">
          <Camera size={16} className="text-[var(--text-accent)] shrink-0" />
          <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
            Lineup scenarios
          </h4>
        </div>
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          Scenarios need the SQLite backend — start with{' '}
          <code className="font-mono text-[var(--text-accent)]">OMNI_DB=sqlite</code>.
        </p>
      </div>
    );
  }

  const sorted = [...snapshots].sort((a, b) => b.createdAt - a.createdAt);
  const shown = expanded ? sorted : sorted.slice(0, SNAPSHOTS_DEFAULT_LIMIT);

  return (
    <div className="surface-card rounded-xl border border-theme-soft p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3.5">
        <Camera size={16} className="text-[var(--text-accent)] shrink-0" />
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          Lineup scenarios
        </h4>
      </div>

      {editable ? (
        <SaveScenarioForm
          name={name}
          onNameChange={setName}
          saving={saving}
          scoringSettled={scoringSettled}
          onSave={() => void handleSave()}
        />
      ) : null}

      {listError ? (
        <p className="text-ui-caption text-amber-400/90 leading-relaxed mb-2">{listError}</p>
      ) : null}

      <ScenarioListSection
        listLoading={listLoading}
        listError={listError}
        hasSnapshots={snapshots.length > 0}
        sorted={sorted}
        shown={shown}
        expanded={expanded}
        defaultLimit={SNAPSHOTS_DEFAULT_LIMIT}
        onToggleExpanded={() => setExpanded(v => !v)}
        projectedTotal={projectedTotal}
        editable={editable}
        diffSupported={diffSupported}
        confirmId={confirmId}
        restoringId={restoringId}
        diffId={diffId}
        diffLoadingId={diffLoadingId}
        diffResult={diffResult}
        onDiffClick={snap => void handleDiffClick(snap)}
        onRestoreClick={snapshotId => handleRestoreClick(snapshotId)}
      />
    </div>
  );
}
