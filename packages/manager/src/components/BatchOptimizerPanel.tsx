/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "All teams" optimizer dialog — runs rosterOptimizer across all teams in a
 * workspace and lets the user review the result before applying it. It is
 * opened from the Optimize step, which also records the applied run and its
 * Undo (see RosterOptimizeStep.tsx).
 */

import React, { useMemo, useState, useCallback } from 'react';
import { X, Sparkles, RefreshCw, TrendingUp, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import type { OptimizerStage } from '@omniswim/core/lib/rosterOptimizer';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import { Button, Modal, useToast } from '@omniswim/ui';
import {
  BATCH_UNCHANGED_MESSAGE,
  batchOptimizationToastMessage,
  buildBatchApplyPatch,
  computeBatchOptimizationResult,
  deltaColorClass,
  type BatchOptimizationResult,
} from './batchOptimizerView';

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
  { value: 'scorers', label: 'Scorers Only', desc: 'Optimize which athletes score per team' },
  { value: 'events', label: 'Events Only', desc: 'Optimize event lineup per athlete' },
  { value: 'all', label: 'Full (Scorers + Events)', desc: 'Both scorer roster and event lineup' },
];

export default function BatchOptimizerPanel({ workspace, gender, scoringSettings, removeSeniors = false, onApply, onClose }: Props) {
  const toast = useToast();
  const [stage, setStage] = useState<OptimizerStage>('all');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<BatchOptimizationResult | null>(null);

  const mergedSettings = useMemo(
    () => mergeScoringSettings(scoringSettings, { conference: workspace.conference }),
    [scoringSettings, workspace.conference]
  );

  const runOptimizer = useCallback(() => {
    setIsRunning(true);
    // Use setTimeout to yield to the UI thread for the loading indicator
    setTimeout(() => {
      try {
        const computed = computeBatchOptimizationResult(workspace, gender, mergedSettings, stage, removeSeniors);
        setResult(computed);
        if (computed.outcome === 'unchanged') {
          toast.push('info', BATCH_UNCHANGED_MESSAGE);
        } else {
          toast.push('success', batchOptimizationToastMessage(computed.overrideCount, computed.planCount));
        }
      } catch (err) {
        toast.push('error', `Optimization failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, [workspace, gender, mergedSettings, stage, removeSeniors, toast]);

  const handleApply = useCallback(() => {
    if (!result || !buildBatchApplyPatch(result)) return;
    onApply(result);
    onClose();
  }, [result, onApply, onClose]);

  const canApply = Boolean(result && buildBatchApplyPatch(result));
  const scorerChangeCount = result?.changes.scorerChanges.length ?? 0;
  const entryChangeCount = result?.changes.entryChanges.length ?? 0;

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
                  : 'Drop seniors is off: every athlete stays in.'}
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
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
                  <RefreshCw size={14} />
                </motion.div>
                <span>Optimizing...</span>
              </>
            ) : (
              <>
                <TrendingUp size={14} />
                <span>Run optimizer</span>
              </>
            )}
          </Button>

          {/* Results */}
          <AnimatePresence>
            {result && (
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
