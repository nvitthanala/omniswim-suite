/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for BatchOptimizerPanel — none of this touches
 * React.
 */

import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  diffOptimizerChanges,
  optimizeRosterAllTeams,
  type GuardedOptimizerResult,
  type OptimizerChangeSummary,
  type OptimizerOutcome,
  type OptimizerStage,
} from '@omniswim/core/lib/rosterOptimizer';

export type TeamDelta = {
  teamName: string;
  previousPoints: number;
  projectedPoints: number;
  delta: number;
};

export type BatchOptimizationResult = {
  overrides: ReturnType<typeof optimizeRosterAllTeams>['overrides'];
  meetEntryPlans: ReturnType<typeof optimizeRosterAllTeams>['meetEntryPlans'];
  activeEntryIds: ReturnType<typeof optimizeRosterAllTeams>['activeEntryIds'];
  teamDeltas: TeamDelta[];
  overrideCount: number;
  planCount: number;
  /** `unchanged` means nothing beat the current lineup: there is nothing to apply. */
  outcome: OptimizerOutcome;
  /** The raw guarded result, so the caller can record the run and its undo. */
  optimizer: GuardedOptimizerResult;
  /** What the run changed against the workspace as it stood, from `diffOptimizerChanges`. */
  changes: OptimizerChangeSummary;
};

/**
 * Runs the all-teams optimizer and packages the result the panel displays.
 * The optimizer reports aggregate totals only, so this shows a single "All
 * Teams" row plus the override/plan counts changed from the workspace as-is.
 */
export function computeBatchOptimizationResult(
  workspace: Workspace,
  gender: Gender,
  mergedSettings: ScoringSettings,
  stage: OptimizerStage,
  removeSeniors = false
): BatchOptimizationResult {
  const opt = optimizeRosterAllTeams(workspace, gender, removeSeniors, mergedSettings, stage);
  const overrideCount = (opt.overrides ?? []).length - (workspace.scorerRosterOverrides ?? []).length;
  const planCount = (opt.meetEntryPlans ?? []).length - (workspace.meetEntryPlans ?? []).length;
  const teamDeltas: TeamDelta[] = [
    {
      teamName: 'All Teams',
      previousPoints: opt.previousTotal,
      projectedPoints: opt.projectedTotal,
      delta: opt.projectedTotal - opt.previousTotal,
    },
  ];
  return {
    overrides: opt.overrides,
    meetEntryPlans: opt.meetEntryPlans,
    activeEntryIds: opt.activeEntryIds,
    teamDeltas,
    overrideCount,
    planCount,
    outcome: opt.outcome,
    optimizer: opt,
    changes: diffOptimizerChanges(
      { overrides: workspace.scorerRosterOverrides ?? [], plans: workspace.meetEntryPlans ?? [] },
      { overrides: opt.overrides, plans: opt.meetEntryPlans }
    ),
  };
}

/**
 * The workspace patch that applies a batch result, or `null` when there is
 * nothing to apply.
 *
 * An `unchanged` result hands back the caller's own state, so applying it would
 * only write the same values back and arm an Undo for a change that never
 * happened. All three optimizer-owned fields are written together, exactly as
 * the per-team path does, because the result holds the FULL post-run arrays: a
 * run that empties one of them must clear it, not leave the old value behind.
 */
export function buildBatchApplyPatch(result: BatchOptimizationResult): Partial<Workspace> | null {
  if (result.outcome === 'unchanged') return null;
  return {
    scorerRosterOverrides: result.overrides,
    meetEntryPlans: result.meetEntryPlans,
    activeEntryIds: result.activeEntryIds,
  };
}

export const BATCH_UNCHANGED_MESSAGE = 'No lineup change improved the field — nothing was applied.';

export function batchOptimizationToastMessage(overrideCount: number, planCount: number): string {
  const rosterPart = overrideCount > 0 ? `${overrideCount} roster changes, ` : '';
  const eventPart = planCount > 0 ? `${planCount} event changes` : 'no event changes';
  return `Optimization complete — ${rosterPart}${eventPart}`;
}

/** CSS color class for a point delta: positive, negative, or unchanged. */
export function deltaColorClass(delta: number): string {
  if (delta > 0) return 'text-points-positive';
  if (delta < 0) return 'text-points-negative';
  return 'text-theme-secondary';
}

/**
 * What a batch run was computed from. A result is shown and applied only while
 * the inputs that produced it still hold.
 */
export type BatchRunInputs = {
  workspaceId: string;
  gender: Gender;
  settingsKey: string;
  stage: OptimizerStage;
  removeSeniors: boolean;
  /** The three optimizer-owned arrays, by identity: any edit replaces them. */
  overrides: Workspace['scorerRosterOverrides'];
  plans: Workspace['meetEntryPlans'];
  activeEntryIds: Workspace['activeEntryIds'];
};

/** True while the scoring inputs of a run still match, so its result may be shown. */
export function batchRunInputsCurrent(ran: BatchRunInputs, now: Pick<BatchRunInputs, 'workspaceId' | 'gender' | 'settingsKey' | 'stage' | 'removeSeniors'>): boolean {
  return (
    ran.workspaceId === now.workspaceId &&
    ran.gender === now.gender &&
    ran.settingsKey === now.settingsKey &&
    ran.stage === now.stage &&
    ran.removeSeniors === now.removeSeniors
  );
}

/**
 * True when the lineup arrays are no longer the objects the run started from.
 * The result holds the FULL post-run arrays, so applying it then would
 * overwrite the edits made since.
 */
export function batchLineupMoved(ran: BatchRunInputs, workspace: Workspace): boolean {
  return (
    ran.overrides !== workspace.scorerRosterOverrides ||
    ran.plans !== workspace.meetEntryPlans ||
    ran.activeEntryIds !== workspace.activeEntryIds
  );
}
