/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-click "Optimize all teams" for the Lineup step.
 *
 * The click runs the same engine as the Optimize step's "All teams" dialog
 * (the `allTeams` job, stage 'all', conference-merged settings) and applies the
 * result at once. Nothing asks first: the run is bounded to the three
 * optimizer-owned arrays, and the success toast carries an Undo that lasts until
 * it is dismissed. Undo refuses when the lineup changed after the run, so it
 * never discards a later edit.
 *
 * The run happens in the scoring worker (`useOptimizeRun` -> `requestOptimize`),
 * so the page stays usable. The worker reports "Optimizing N of M teams" and the
 * run can be cancelled. The optimizer walks the teams in order and feeds each
 * team's result into the next, then judges the whole field once. That makes the
 * result one unit: it is applied once, after the run completes, never team by
 * team. Cancel, and any change to the inputs while it runs, applies nothing.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { GuardedOptimizerResult } from '@omniswim/core/lib/rosterOptimizer';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { useToast } from '@omniswim/ui';
import {
  BATCH_UNCHANGED_MESSAGE,
  buildBatchApplyPatch,
  buildBatchOptimizationResult,
} from './batchOptimizerView';
import { useOptimizeRun } from './useOptimizeRun';
import {
  CHANGED_WHILE_OPTIMIZING_MESSAGE,
  OPTIMIZE_CANCELLED_MESSAGE,
  optimizeFailedMessage,
  optimizerInputRefsOf,
  optimizerInputsMoved,
} from './optimizeRunView';
import {
  APPLY_NOT_SAVED_MESSAGE,
  UNDO_CHANGED_MESSAGE,
  buildOptimizerUndo,
  optimizerArraysOf,
  optimizerUndoState,
  type OptimizerUndo,
} from './optimizerUndo';

type Args = {
  workspace?: Workspace;
  gender: Gender;
  settings: ScoringSettings;
  removeSeniors?: boolean;
  /** False when the view is read-only (What-if off). `run` is then undefined. */
  editable: boolean;
  onWorkspaceUpdate?: (patch: Partial<Workspace>) => void;
};

type Armed = { undo: OptimizerUndo; toastId: string };

export const ALL_TEAMS_UNDONE_MESSAGE = 'All teams run undone. The lineup is back to how it was.';

export function useAllTeamsApply({ workspace, gender, settings, removeSeniors = false, editable, onWorkspaceUpdate }: Args) {
  const enabled = Boolean(editable && workspace && onWorkspaceUpdate);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { run: activeRun, start: startRun, cancel: cancelRun } = useOptimizeRun();
  // The toast's Undo and a finishing run both read the newest workspace, not the render they started in.
  // Published after commit, never during render: a render React abandons must not become what a run reads.
  const latest = useRef(workspace);
  const enabledRef = useRef(enabled);
  const toastRef = useRef(toast);
  useLayoutEffect(() => {
    latest.current = workspace;
    enabledRef.current = enabled;
    toastRef.current = toast;
  });
  const armed = useRef<Armed | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  // The toast context value changes with every toast, so the unmount cleanup reads `dismiss` from a ref.
  const dismissRef = useRef(toast.dismiss);
  dismissRef.current = toast.dismiss;

  const disarm = useCallback(() => {
    if (armed.current) toast.dismiss(armed.current.toastId);
    armed.current = null;
  }, [toast]);

  const undoRun = useCallback(
    (undo: OptimizerUndo) => {
      const current = latest.current;
      disarm();
      // The toast outlives the Lineup step. Once this step is gone `latest` is a stale snapshot,
      // so an Undo pressed later would compare against it and could wipe a newer run.
      if (!mounted.current || !current || current.id !== undo.workspaceId || !onWorkspaceUpdate) return;
      const state = optimizerUndoState(undo, optimizerArraysOf(current));
      if (state === 'changed') toast.push('info', UNDO_CHANGED_MESSAGE);
      else if (state === 'apply_not_saved') toast.push('info', APPLY_NOT_SAVED_MESSAGE);
      else {
        onWorkspaceUpdate(undo.patch);
        toast.push('success', ALL_TEAMS_UNDONE_MESSAGE);
      }
    },
    [disarm, onWorkspaceUpdate, toast]
  );

  /** Apply a finished run to the workspace as it stands now, and arm its Undo. */
  const applyResult = useCallback(
    (current: Workspace, opt: GuardedOptimizerResult) => {
      const result = buildBatchOptimizationResult(current, opt);
      const patch = buildBatchApplyPatch(result);
      if (!patch) {
        toastRef.current.push('info', BATCH_UNCHANGED_MESSAGE);
        return;
      }
      const before = optimizerArraysOf(current);
      disarm();
      onWorkspaceUpdate?.(patch);
      const undo = buildOptimizerUndo({
        label: 'All teams',
        workspaceId: current.id,
        before,
        applied: { ...current, ...patch },
      });
      const gain = result.optimizer.projectedTotal - result.optimizer.previousTotal;
      const toastId = toastRef.current.push('success', `All teams: +${gain.toFixed(1)} pts across the field.`, {
        persistent: true,
        action: { label: 'Undo', onClick: () => undoRun(undo) },
      });
      armed.current = { undo, toastId };
    },
    [disarm, onWorkspaceUpdate, undoRun]
  );

  const run = useCallback(async () => {
    if (!enabled || busyRef.current) return;
    const started = latest.current;
    if (!started || !onWorkspaceUpdate) return;
    // `start` cancels a run already in flight, so a second click must not reach it.
    busyRef.current = true;
    setBusy(true);
    // What the run read, by reference. Compared when the result arrives.
    const startedFrom = optimizerInputRefsOf(started);
    const merged = mergeScoringSettings(settings, { conference: started.conference });
    try {
      // Off the main thread: the worker gets a copy of the workspace, so nothing is written until it is done.
      const opt = await startRun(started, gender, { kind: 'allTeams', removeSeniors, settings: merged, stage: 'all' });
      // null: cancelled, or the inputs changed while it ran. Nothing was changed.
      if (!opt || !mounted.current || !enabledRef.current) return;
      const now = latest.current;
      if (!now) return;
      // The result holds the FULL post-run arrays and was computed from the inputs as they were.
      if (optimizerInputsMoved(startedFrom, now)) {
        toastRef.current.push('info', CHANGED_WHILE_OPTIMIZING_MESSAGE);
        return;
      }
      applyResult(now, opt);
    } catch (err) {
      if (mounted.current) toastRef.current.push('error', optimizeFailedMessage(err));
    } finally {
      // After an unmount the cleanup already reset the guard.
      if (mounted.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [applyResult, enabled, gender, onWorkspaceUpdate, removeSeniors, settings, startRun]);

  const handleCancel = useCallback(() => {
    cancelRun();
    toastRef.current.push('info', OPTIMIZE_CANCELLED_MESSAGE);
  }, [cancelRun]);

  // A run belongs to one workspace, gender, rule set and drop-seniors choice. If any changes, its
  // result would describe a lineup the coach is no longer looking at, so the run stops and applies
  // nothing. Edits to the fields the optimizer reads are caught when the result arrives.
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);
  const workspaceId = workspace?.id;
  useEffect(() => {
    cancelRun();
  }, [cancelRun, workspaceId, gender, settingsKey, removeSeniors, enabled]);

  // Leaving the Lineup step drops a pending run and the armed Undo.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyRef.current = false;
      if (armed.current) dismissRef.current(armed.current.toastId);
      armed.current = null;
    };
  }, []);

  // The Undo belongs to one lineup. A workspace switch or a later edit drops it.
  useEffect(() => {
    const live = armed.current;
    if (!live) return;
    const stale =
      !workspace ||
      workspace.id !== live.undo.workspaceId ||
      optimizerUndoState(live.undo, optimizerArraysOf(workspace)) === 'changed';
    if (stale) disarm();
  }, [workspace, disarm]);

  return {
    run: enabled ? run : undefined,
    busy,
    /** The run in flight, for "Optimizing N of M teams". `null` when idle. */
    progress: activeRun,
    /** Cancel the run in flight and say nothing was changed. */
    cancel: handleCancel,
  };
}
