/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-click "Optimize all teams" for the Lineup step.
 *
 * The click runs the same engine as the Optimize step's "All teams" dialog
 * (`computeBatchOptimizationResult`, stage 'all', conference-merged settings)
 * and applies the result at once. Nothing asks first: the run is bounded to the
 * three optimizer-owned arrays, and the success toast carries an Undo that
 * lasts until it is dismissed. Undo refuses when the lineup changed after the
 * run, so it never discards a later edit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { useToast } from '@omniswim/ui';
import {
  BATCH_UNCHANGED_MESSAGE,
  buildBatchApplyPatch,
  computeBatchOptimizationResult,
} from './batchOptimizerView';
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
  // The toast's Undo and the timed run both read the newest workspace, not the render they started in.
  const latest = useRef(workspace);
  latest.current = workspace;
  const armed = useRef<Armed | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
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

  const applyNow = useCallback(() => {
    const current = latest.current;
    if (!current || !onWorkspaceUpdate) return;
    const merged = mergeScoringSettings(settings, { conference: current.conference });
    const result = computeBatchOptimizationResult(current, gender, merged, 'all', removeSeniors);
    const patch = buildBatchApplyPatch(result);
    if (!patch) {
      toast.push('info', BATCH_UNCHANGED_MESSAGE);
      return;
    }
    const before = optimizerArraysOf(current);
    disarm();
    onWorkspaceUpdate(patch);
    const undo = buildOptimizerUndo({
      label: 'All teams',
      workspaceId: current.id,
      before,
      applied: { ...current, ...patch },
    });
    const gain = result.optimizer.projectedTotal - result.optimizer.previousTotal;
    const toastId = toast.push('success', `All teams: +${gain.toFixed(1)} pts across the field.`, {
      persistent: true,
      action: { label: 'Undo', onClick: () => undoRun(undo) },
    });
    armed.current = { undo, toastId };
  }, [disarm, gender, onWorkspaceUpdate, removeSeniors, settings, toast, undoRun]);

  const run = useCallback(() => {
    if (!enabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // Yield a frame so the busy label paints before the blocking run starts.
    timer.current = window.setTimeout(() => {
      timer.current = null;
      try {
        applyNow();
      } catch (err) {
        toast.push('error', `Optimization failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    }, 50);
  }, [applyNow, enabled, toast]);

  // Leaving the Lineup step drops a pending run and the armed Undo.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
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

  return { run: enabled ? run : undefined, busy };
}
