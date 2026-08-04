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
import { Camera, Loader2 } from 'lucide-react';
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
import { Button, useToast } from '@omniswim/ui';

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

/** Label suffix convention written by this panel: "<name> · <points> pts". */
const LABEL_SUFFIX_RE = / · (-?[\d.]+) pts$/;

function parseSnapshotLabel(label: string): {
  name: string;
  points: number | null;
  hasPointsSuffix: boolean;
} {
  const m = LABEL_SUFFIX_RE.exec(label);
  if (!m) return { name: label, points: null, hasPointsSuffix: false };
  const points = Number(m[1]);
  return {
    name: label.slice(0, m.index),
    points: Number.isFinite(points) ? points : null,
    hasPointsSuffix: true,
  };
}

function formatCompactDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDiff(diff: number): string {
  const abs = Math.abs(diff).toFixed(1);
  return diff >= 0 ? `+${abs}` : `-${abs}`;
}

/** Signed delta text colored with the panel's existing +/- semantic tokens. */
function DeltaText({ value, className = '' }: { value: number; className?: string }) {
  const cls =
    Math.abs(value) < 1e-6
      ? 'text-theme-muted'
      : value > 0
        ? 'text-points-positive'
        : 'text-points-negative';
  return (
    <span className={`font-mono tabular-nums ${cls} ${className}`}>{formatDiff(value)}</span>
  );
}

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
        <div className="mb-3.5">
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Scenario name"
              className="glass-input flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-ui-caption"
              onKeyDown={e => {
                if (e.key === 'Enter' && !saving && scoringSettled) void handleSave();
              }}
            />
            {/* Gated on the scoring worker settling so a freshly-mounted page can't
                capture a transient "· N pts" total in the scenario label. */}
            <span title={scoringSettled ? undefined : 'Waiting for the projected total to finish recalculating'}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !name.trim() || !scoringSettled}
              >
                {saving || !scoringSettled ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Camera size={12} />
                )}
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
      ) : null}

      {listError ? (
        <p className="text-ui-caption text-amber-400/90 leading-relaxed mb-2">{listError}</p>
      ) : null}

      {listLoading && snapshots.length === 0 ? (
        <p className="text-ui-caption text-theme-muted flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" />
          Loading scenarios…
        </p>
      ) : sorted.length === 0 ? (
        !listError ? (
          <p className="text-ui-caption text-theme-secondary leading-relaxed">
            No scenarios saved yet.
          </p>
        ) : null
      ) : (
        <>
          <ul className="space-y-2">
            {shown.map(snap => {
              const { name: snapName, points, hasPointsSuffix } = parseSnapshotLabel(snap.label);
              const diff =
                hasPointsSuffix && points != null && projectedTotal != null
                  ? projectedTotal - points
                  : null;
              const isConfirming = confirmId === snap.id;
              const isRestoring = restoringId === snap.id;
              const isDiffOpen = diffId === snap.id && diffResult != null;
              const isDiffLoading = diffLoadingId === snap.id;
              return (
                <li
                  key={snap.id}
                  className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
                >
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
                        {hasPointsSuffix
                          ? ` · ${points != null ? `${points.toFixed(1)} pts` : '—'}`
                          : ''}
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
                          onClick={() => void handleDiffClick(snap)}
                          disabled={isDiffLoading || (diffLoadingId != null && !isDiffLoading)}
                          className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold disabled:opacity-50"
                          title="Per-event / per-swimmer diff vs the current lineup (does not restore)"
                        >
                          {isDiffLoading ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : isDiffOpen ? (
                            'Hide diff'
                          ) : (
                            'Diff'
                          )}
                        </button>
                      ) : null}
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => handleRestoreClick(snap.id)}
                          disabled={isRestoring}
                          className="btn-accent-outline rounded-md px-2 py-1 text-ui-micro font-semibold disabled:opacity-50"
                        >
                          {isRestoring ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : isConfirming ? (
                            'Confirm?'
                          ) : (
                            'Restore'
                          )}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {isDiffOpen && diffResult ? (
                    <div className="mt-2.5 border-t border-theme-soft pt-2.5">
                      <div className="flex items-center justify-between gap-2 text-ui-micro font-mono tabular-nums">
                        <span className="text-theme-secondary">
                          Then {diffResult.totals.then.toFixed(1)} → Now{' '}
                          {diffResult.totals.now.toFixed(1)}
                        </span>
                        <DeltaText value={diffResult.totals.delta} className="text-ui-caption" />
                      </div>
                      {diffResult.events.length === 0 && diffResult.swimmers.length === 0 ? (
                        <p className="text-ui-micro text-theme-muted mt-1.5">
                          No differences — this scenario matches the current lineup.
                        </p>
                      ) : (
                        <>
                          {diffResult.events.length > 0 ? (
                            <div className="mt-2">
                              <p className="text-ui-micro font-semibold text-theme-secondary mb-1">
                                By event
                              </p>
                              <ul className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
                                {diffResult.events.map(ev => (
                                  <li
                                    key={ev.event}
                                    className="flex items-baseline justify-between gap-2 text-ui-micro"
                                  >
                                    <span className="text-theme-secondary truncate" title={ev.event}>
                                      {ev.event}
                                    </span>
                                    <span className="shrink-0 font-mono tabular-nums text-theme-muted">
                                      {ev.pointsThen.toFixed(1)}→{ev.pointsNow.toFixed(1)}{' '}
                                      <DeltaText value={ev.delta} />
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {diffResult.swimmers.length > 0 ? (
                            <div className="mt-2">
                              <p className="text-ui-micro font-semibold text-theme-secondary mb-1">
                                Top movers
                              </p>
                              <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                {diffResult.swimmers.map(sw => (
                                  <li key={`${sw.isRelay ? 'relay' : 'ind'}:${sw.name}`}>
                                    <div className="flex items-baseline justify-between gap-2 text-ui-micro">
                                      <span
                                        className="text-[var(--text-primary)] truncate"
                                        title={sw.name}
                                      >
                                        {sw.name}
                                        {sw.isRelay ? (
                                          <span className="text-theme-muted"> · relay</span>
                                        ) : null}
                                      </span>
                                      <span className="shrink-0 font-mono tabular-nums text-theme-muted">
                                        {sw.pointsThen.toFixed(1)}→{sw.pointsNow.toFixed(1)}{' '}
                                        <DeltaText value={sw.deltaPoints} />
                                      </span>
                                    </div>
                                    {sw.eventsAdded.length > 0 ||
                                    sw.eventsRemoved.length > 0 ||
                                    sw.eventsChanged.length > 0 ? (
                                      <p className="text-ui-micro text-theme-muted leading-snug">
                                        {[
                                          ...sw.eventsAdded.map(e => `+ ${e}`),
                                          ...sw.eventsRemoved.map(e => `− ${e}`),
                                          ...sw.eventsChanged.map(
                                            c => `${c.event}: ${c.timeThen || '—'} → ${c.timeNow || '—'}`
                                          ),
                                        ].join(' · ')}
                                      </p>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {sorted.length > SNAPSHOTS_DEFAULT_LIMIT ? (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="mt-2 text-ui-caption text-[var(--text-accent)] hover:underline"
            >
              {expanded ? 'Show fewer' : `Show all ${sorted.length}`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
