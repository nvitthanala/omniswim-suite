/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for BatchOptimizerPanel — none of this touches
 * React.
 */

import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { optimizeRosterAllTeams, type OptimizerStage } from '@omniswim/core/lib/rosterOptimizer';

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
  stage: OptimizerStage
): BatchOptimizationResult {
  const opt = optimizeRosterAllTeams(workspace, gender, false, mergedSettings, stage);
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
  };
}

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
