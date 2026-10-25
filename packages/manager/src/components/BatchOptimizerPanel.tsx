/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "All teams" optimizer dialog — runs rosterOptimizer across all teams in a
 * workspace and lets the user review the result before applying it. It is
 * opened from the Optimize step, which also records the applied run and its
 * Undo (see RosterOptimizeStep.tsx).
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { X, Sparkles, RefreshCw, TrendingUp, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { OptimizerStage } from '@omniswim/core/lib/rosterOptimizer';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import { Button, Modal, useToast } from '@omniswim/ui';
import {
  BATCH_UNCHANGED_MESSAGE,
  batchOptimizationToastMessage,
  batchLineupMoved,
  batchRunInputsCurrent,
  buildBatchApplyPatch,
  buildBatchOptimizationResult,
  type BatchRunInputs,
  deltaColorClass,
  type BatchOptimizationResult,
} from './batchOptimizerView';
import { useOptimizeRun } from './useOptimizeRun';
import {
  OPTIMIZE_CANCELLED_MESSAGE,
  describeOptimizeRun,
  optimizeFailedMessage,
  optimizerInputRefsOf,
  optimizerInputsMoved,
} from './optimizeRunView';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringSettings: ScoringSettings;
  /** Mirrors the Manager's "Drop seniors" switch; the run honours it. */
  removeSeniors?: boolean;
  /**
   * Called with a result that has something to apply. It is never called for an
   * `unchanged` result. The caller owns the toast and the Undo.
   */
  onApply: (result: BatchOptimizationResult) => void;
  onClose: () => void;
};

const STAGES: { value: OptimizerStage; label: string; desc: string }[] = [
  { value: 'scorers', label: 'Scorers only', desc: 'Optimize which swimmers score per team' },
  { value: 'events', label: 'Events only', desc: 'Optimize event lineup per swimmer' },
  { value: 'all', label: 'Full (scorers + events)', desc: 'Both scorer roster and event lineup' },
];

/** The review card for one run: totals, delta and how many scorer and event changes it proposes. */
function BatchResultView({ result }: { result: BatchOptimizationResult }) {
  const scorerChangeCount = result.changes.scorerChanges.length;
  const entryChangeCount = result.changes.entryChanges.length;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* Summary card */}
      <div className="surface-overlay rounded-lg border border-theme-soft p-4">
        <h4 className="text-ui-caption font-bold text-theme-secondary mb-3">
          Optimization summary
        </h4>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-3 rounded-lg surface-muted-bg border border-theme-soft">
            <div className="text-2xl font-bold tabular-nums text-points-positive">
              {result.teamDeltas[0]?.projectedPoints.toFixed(1) ?? '0.0'}
            </div>
            <div className="text-ui-micro text-theme-secondary mt-1">
              Projected total
            </div>
          </div>
          <div className="text-center p-3 rounded-lg surface-muted-bg border border-theme-soft">
            <div className={`text-2xl font-bold tabular-nums ${deltaColorClass(result.teamDeltas[0]?.delta ?? 0)}`}>
              {(result.teamDeltas[0]?.delta ?? 0) > 0 ? '+' : ''}
              {(result.teamDeltas[0]?.delta ?? 0).toFixed(1)}
            </div>
            <div className="text-ui-micro text-theme-secondary mt-1">
              Delta
            </div>
          </div>
          <div className="text-center p-3 rounded-lg surface-muted-bg border border-theme-soft">
            <div className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
              {result.teamDeltas[0]?.previousPoints.toFixed(1) ?? '0.0'}
            </div>
            <div className="text-ui-micro text-theme-secondary mt-1">
              Baseline total
            </div>
          </div>
        </div>
      </div>

      {/* Changes detail */}
      <div className="surface-overlay rounded-lg border border-theme-soft p-4">
        <h4 className="text-ui-caption font-bold text-theme-secondary mb-3">
          Changes proposed
        </h4>
        {result.outcome === 'unchanged' ? (
          <p role="status" className="text-ui-body text-theme-secondary mb-3">
            {BATCH_UNCHANGED_MESSAGE}
          </p>
        ) : null}
        <div className="flex gap-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-theme-soft">
            <CheckCircle size={14} className="text-points-positive" />
            <span className="text-ui-label font-medium text-[var(--text-primary)]">
              {scorerChangeCount} scorer change{scorerChangeCount !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-theme-soft">
            <CheckCircle size={14} className="text-points-positive" />
            <span className="text-ui-label font-medium text-[var(--text-primary)]">
              {entryChangeCount} event change{entryChangeCount !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

type RanResult = { result: BatchOptimizationResult; inputs: BatchRunInputs };

const LINEUP_CHANGED_MESSAGE = 'Lineup changed, run again.';

export default function BatchOptimizerPanel({ workspace, gender, scoringSettings, removeSeniors = false, onApply, onClose }: Props) {
  const toast = useToast();
  const [stage, setStage] = useState<OptimizerStage>('all');
  const optimizeRun = useOptimizeRun();
  // The workspace as of the latest commit. A run finishes after the render that started it.
  const latestWorkspace = useRef(workspace);
  useLayoutEffect(() => {
    latestWorkspace.current = workspace;
  });
  const { run: activeRun, start: startRun, cancel: cancelRun } = optimizeRun;
  const isRunning = activeRun !== null;
  const [ran, setRan] = useState<RanResult | null>(null);
  const [lineupChanged, setLineupChanged] = useState(false);

  const mergedSettings = useMemo(
    () => mergeScoringSettings(scoringSettings, { conference: workspace.conference }),
    [scoringSettings, workspace.conference]
  );
  // Content key, so an equal settings object rebuilt by a parent does not count as a change.
  // `ownTeam` is a display choice, so it stays out of the key: changing it must not drop a result.
  const settingsKey = JSON.stringify({ ...mergedSettings, ownTeam: undefined });

  // The result is dropped (not just disabled) the moment its inputs change.
  const current = { workspaceId: workspace.id, gender, settingsKey, stage, removeSeniors };
  const result = ran && batchRunInputsCurrent(ran.inputs, current) ? ran.result : null;

  // A run stops when anything that produced it changes, so a result for other inputs never lands.
  useEffect(() => {
    cancelRun();
  }, [cancelRun, workspace.id, gender, settingsKey, stage, removeSeniors]);

  const runOptimizer = useCallback(async () => {
    setLineupChanged(false);
    const startedFrom = optimizerInputRefsOf(workspace);
    const inputs: BatchRunInputs = {
      workspaceId: workspace.id,
      gender,
      settingsKey,
      stage,
      removeSeniors,
      inputRefs: startedFrom,
    };
    try {
      // Off the main thread: the worker gets a copy of the workspace and the dialog stays usable.
      const opt = await startRun(workspace, gender, {
        kind: 'allTeams',
        removeSeniors,
        settings: mergedSettings,
        stage,
      });
      // null: cancelled, or the inputs changed while it ran. Nothing was changed.
      if (!opt) return;
      // The run read more than the lineup arrays: roster, aliases, history, deleted swimmers.
      // An edit to any of them while it ran makes the result describe a workspace that is gone.
      if (optimizerInputsMoved(startedFrom, latestWorkspace.current)) {
        setLineupChanged(true);
        return;
      }
      const computed = buildBatchOptimizationResult(workspace, opt);
      setRan({ result: computed, inputs });
      if (computed.outcome === 'unchanged') {
        toast.push('info', BATCH_UNCHANGED_MESSAGE);
      } else {
        toast.push('success', batchOptimizationToastMessage(computed.overrideCount, computed.planCount));
      }
    } catch (err) {
      toast.push('error', optimizeFailedMessage(err));
    }
  }, [workspace, gender, mergedSettings, settingsKey, stage, removeSeniors, toast, startRun]);

  const handleCancelRun = useCallback(() => {
    cancelRun();
    toast.push('info', OPTIMIZE_CANCELLED_MESSAGE);
  }, [cancelRun, toast]);

  const handleApply = useCallback(() => {
    if (isRunning || !ran || !result || !buildBatchApplyPatch(result)) return;
    // The result holds the FULL post-run arrays. If anything the run read moved since
    // the run (lineup, roster, aliases, history, deleted swimmers), applying would
    // silently overwrite those edits.
    if (batchLineupMoved(ran.inputs, workspace)) {
      setRan(null);
      setLineupChanged(true);
      return;
    }
    onApply(result);
    onClose();
  }, [isRunning, ran, result, workspace, onApply, onClose]);

  // A re-run is in flight: the result on screen is about to be replaced, so it is not applied.
  const canApply = Boolean(result && buildBatchApplyPatch(result)) && !isRunning;

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Optimize all teams"
      closeOnBackdropClick
      className="rounded-xl border border-theme-soft w-full max-w-2xl max-h-[80vh] flex flex-col"
      style={{ boxShadow: 'var(--ui-shadow-lg)' }}
    >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-theme-soft shrink-0">
          <div className="flex items-center gap-3">
            <Sparkles size={18} className="text-[var(--text-accent)]" />
            <div>
              <h2 className="text-ui-label font-bold text-[var(--text-primary)]">
                Optimize all teams
              </h2>
              <p className="text-ui-caption text-theme-secondary mt-0.5">
                Optimizes every team using the current What-if setting.{' '}
                {removeSeniors
                  ? 'Drop seniors is on: graduating seniors are left out.'
                  : 'Drop seniors is off: every swimmer stays in.'}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="p-2 text-theme-secondary hover:text-[var(--text-primary)]"
            leadingIcon={<X size={16} />}
          />
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5">
          {/* Stage selector */}
          <div>
            <label className="text-ui-caption font-bold text-theme-secondary mb-2 block">
              Optimization scope
            </label>
            <div className="grid grid-cols-3 gap-2">
              {STAGES.map(s => (
                <Button
                  key={s.value}
                  variant="ghost"
                  size="md"
                  onClick={() => setStage(s.value)}
                  className={`block w-full p-3 rounded-lg border text-left font-normal normal-case tracking-normal ${
                    stage === s.value
                      ? 'border-[var(--text-accent)]/50 bg-[var(--text-accent)]/10'
                      : 'border-theme-soft'
                  }`}
                >
                  <div className="text-ui-label font-bold text-[var(--text-primary)]">
                    {s.label}
                  </div>
                  <div className="text-ui-micro text-theme-secondary mt-1 leading-relaxed">{s.desc}</div>
                </Button>
              ))}
            </div>
          </div>

          {/* Run button */}
          <Button
            variant="primary"
            size="md"
            onClick={runOptimizer}
            disabled={isRunning}
            className="w-full"
          >
            {isRunning ? (
              <>
                <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
                <span>{activeRun?.progress ? describeOptimizeRun(activeRun) : 'Optimizing...'}</span>
              </>
            ) : (
              <>
                <TrendingUp size={14} />
                <span>Run optimizer</span>
              </>
            )}
          </Button>

          {isRunning ? (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={handleCancelRun}>
                Cancel run
              </Button>
            </div>
          ) : null}

          {lineupChanged ? (
            <p role="alert" className="text-ui-body text-theme-secondary">
              {LINEUP_CHANGED_MESSAGE}
            </p>
          ) : null}

          {/* Results */}
          <AnimatePresence>
            {result && (
              <BatchResultView result={result} />
            )}
          </AnimatePresence>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-theme-soft shrink-0">
          <Button
            variant="outline"
            size="md"
            onClick={onClose}
            className="text-theme-secondary hover:text-[var(--text-primary)]"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleApply}
            disabled={!canApply}
          >
            Apply to workspace
          </Button>
        </div>
    </Modal>
  );
}
