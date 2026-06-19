/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Batch Optimizer Panel — runs rosterOptimizer across all teams in a workspace
 * and lets the user review/applies changes.
 */

import React, { useMemo, useState, useCallback } from 'react';
import { X, Sparkles, RefreshCw, TrendingUp, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { optimizeRosterAllTeams, type OptimizerStage } from '@omniswim/core/lib/rosterOptimizer';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import { useToast } from '@omniswim/ui';

type TeamDelta = {
  teamName: string;
  previousPoints: number;
  projectedPoints: number;
  delta: number;
};

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringSettings: ScoringSettings;
  onApply: (patch: Partial<Workspace>) => void;
  onClose: () => void;
};

const STAGES: { value: OptimizerStage; label: string; desc: string }[] = [
  { value: 'scorers', label: 'Scorers Only', desc: 'Optimize which athletes score per team' },
  { value: 'events', label: 'Events Only', desc: 'Optimize event lineup per athlete' },
  { value: 'all', label: 'Full (Scorers + Events)', desc: 'Both scorer roster and event lineup' },
];

export default function BatchOptimizerPanel({ workspace, gender, scoringSettings, onApply, onClose }: Props) {
  const toast = useToast();
  const [stage, setStage] = useState<OptimizerStage>('all');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{
    overrides: ReturnType<typeof optimizeRosterAllTeams>['overrides'];
    meetEntryPlans: ReturnType<typeof optimizeRosterAllTeams>['meetEntryPlans'];
    activeEntryIds: ReturnType<typeof optimizeRosterAllTeams>['activeEntryIds'];
    teamDeltas: TeamDelta[];
  } | null>(null);

  const mergedSettings = useMemo(
    () => mergeScoringSettings(scoringSettings, { conference: workspace.conference }),
    [scoringSettings, workspace.conference]
  );

  const runOptimizer = useCallback(() => {
    setIsRunning(true);
    // Use setTimeout to yield to the UI thread for the loading indicator
    setTimeout(() => {
      try {
        const opt = optimizeRosterAllTeams(workspace, gender, false, mergedSettings, stage);

        // Build per-team deltas by scoring the previous vs optimized state
        const allTeams = new Set<string>();
        const prevTeams = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])]
          .filter(r => !r.isRelay || r.name !== r.team)
          .map(r => String(r.team ?? '').trim())
          .filter(Boolean);
        for (const t of prevTeams) allTeams.add(t);

        const teamDeltas: TeamDelta[] = [];
        // Optimizer returns aggregate totals; we show the total per-team by checking what changed
        const overrideCount = (opt.overrides ?? []).length - (workspace.scorerRosterOverrides ?? []).length;
        const planCount = (opt.meetEntryPlans ?? []).length - (workspace.meetEntryPlans ?? []).length;

        // Use all teams from the previous results for display
        const merged = mergeScoringSettings(scoringSettings, { conference: workspace.conference });
        // We need to calculate per-team totals - optimizer gives aggregate, so we'll show aggregate
        // as a single row "All Teams" plus the summary stats
        teamDeltas.push({
          teamName: 'All Teams',
          previousPoints: opt.previousTotal,
          projectedPoints: opt.projectedTotal,
          delta: opt.projectedTotal - opt.previousTotal,
        });

        setResult({
          overrides: opt.overrides,
          meetEntryPlans: opt.meetEntryPlans,
          activeEntryIds: opt.activeEntryIds,
          teamDeltas,
        });
        toast.push('success', `Optimization complete — ${overrideCount > 0 ? `${overrideCount} roster changes, ` : ''}${planCount > 0 ? `${planCount} event changes` : 'no event changes'}`);
      } catch (err) {
        toast.push('error', `Optimization failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, [workspace, gender, mergedSettings, stage, toast, scoringSettings]);

  const handleApply = useCallback(() => {
    if (!result) return;
    const patch: Partial<Workspace> = {};
    if (result.overrides.length > 0) {
      patch.scorerRosterOverrides = result.overrides;
    }
    if (result.meetEntryPlans.length > 0) {
      patch.meetEntryPlans = result.meetEntryPlans;
    }
    if (result.activeEntryIds.length > 0) {
      patch.activeEntryIds = result.activeEntryIds;
    }
    onApply(patch);
    toast.push('success', 'Optimization applied to workspace');
    onClose();
  }, [result, onApply, onClose, toast]);

  const overrideChanges = useMemo(() => {
    if (!result) return 0;
    const before = new Set(
      (workspace.scorerRosterOverrides ?? []).map(o => `${o.team}:${o.gender}:${o.name}:${o.isScorer}`)
    );
    const after = new Set(result.overrides.map(o => `${o.team}:${o.gender}:${o.name}:${o.isScorer}`));
    // Count added/changed
    let changes = 0;
    for (const a of after) {
      if (!before.has(a)) changes++;
    }
    return changes;
  }, [result, workspace.scorerRosterOverrides]);

  const planChanges = useMemo(() => {
    if (!result) return 0;
    return result.meetEntryPlans.length - (workspace.meetEntryPlans ?? []).length;
  }, [result, workspace.meetEntryPlans]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="surface-card rounded-xl shadow-2xl border border-theme-soft w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-theme-soft shrink-0">
          <div className="flex items-center gap-3">
            <Sparkles size={18} className="text-[var(--text-accent)]" />
            <div>
              <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--text-primary)]">
                Batch Optimizer
              </h2>
              <p className="text-[10px] text-theme-secondary mt-0.5">
                Automatically optimize roster and events for all teams
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 theme-hover-row rounded text-theme-secondary hover:text-[var(--text-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5">
          {/* Stage selector */}
          <div>
            <label className="text-[10px] uppercase tracking-widest font-bold text-theme-secondary mb-2 block">
              Optimization Scope
            </label>
            <div className="grid grid-cols-3 gap-2">
              {STAGES.map(s => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStage(s.value)}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    stage === s.value
                      ? 'border-[var(--text-accent)]/50 bg-[var(--text-accent)]/10'
                      : 'border-theme-soft theme-hover-row'
                  }`}
                >
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-primary)]">
                    {s.label}
                  </div>
                  <div className="text-[9px] text-theme-secondary mt-1 leading-relaxed">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Run button */}
          <button
            type="button"
            onClick={runOptimizer}
            disabled={isRunning}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg btn-primary text-[11px] font-bold uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
                <span>Run Optimizer</span>
              </>
            )}
          </button>

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
                  <h4 className="text-[10px] uppercase tracking-widest font-bold text-theme-secondary mb-3">
                    Optimization Summary
                  </h4>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center p-3 rounded-lg surface-muted-bg border border-theme-soft">
                      <div className="text-[20px] font-bold tabular-nums text-points-positive">
                        {result.teamDeltas[0]?.projectedPoints.toFixed(1) ?? '0.0'}
                      </div>
                      <div className="text-[9px] uppercase tracking-wider text-theme-secondary mt-1">
                        Projected Total
                      </div>
                    </div>
                    <div className="text-center p-3 rounded-lg surface-muted-bg border border-theme-soft">
                      <div
                        className={`text-[20px] font-bold tabular-nums ${
                          (result.teamDeltas[0]?.delta ?? 0) > 0
                            ? 'text-points-positive'
                            : (result.teamDeltas[0]?.delta ?? 0) < 0
                              ? 'text-points-negative'
                              : 'text-theme-secondary'
                        }`}
                      >
                        {(result.teamDeltas[0]?.delta ?? 0) > 0 ? '+' : ''}
                        {(result.teamDeltas[0]?.delta ?? 0).toFixed(1)}
                      </div>
                      <div className="text-[9px] uppercase tracking-wider text-theme-secondary mt-1">
                        Delta
                      </div>
                    </div>
                    <div className="text-center p-3 rounded-lg surface-muted-bg border border-theme-soft">
                      <div className="text-[20px] font-bold tabular-nums text-[var(--text-primary)]">
                        {result.teamDeltas[0]?.previousPoints.toFixed(1) ?? '0.0'}
                      </div>
                      <div className="text-[9px] uppercase tracking-wider text-theme-secondary mt-1">
                        Baseline Total
                      </div>
                    </div>
                  </div>
                </div>

                {/* Changes detail */}
                <div className="surface-overlay rounded-lg border border-theme-soft p-4">
                  <h4 className="text-[10px] uppercase tracking-widest font-bold text-theme-secondary mb-3">
                    Changes Proposed
                  </h4>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-theme-soft">
                      <CheckCircle size={14} className="text-points-positive" />
                      <span className="text-[11px] font-medium text-[var(--text-primary)]">
                        {overrideChanges} scorer override{overrideChanges !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-theme-soft">
                      <CheckCircle size={14} className="text-points-positive" />
                      <span className="text-[11px] font-medium text-[var(--text-primary)]">
                        {planChanges === 0 ? 'No new' : `+${planChanges}`} event plan{planChanges !== 1 ? 's' : ''}
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
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-theme-soft text-[10px] font-bold uppercase tracking-widest text-theme-secondary hover:text-[var(--text-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!result}
            className="px-4 py-2 rounded-lg btn-primary text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Apply to Workspace
          </button>
        </div>
      </div>
    </div>
  );
}