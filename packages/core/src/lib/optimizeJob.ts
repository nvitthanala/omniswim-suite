/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The optimizer entry points the Optimize step runs, described as plain data so
 * they can cross a Worker boundary. One function, `runOptimizeJob`, is the ONLY
 * place a job turns into an optimizer call. The scoring worker, the in-thread
 * fallback in `optimizeClient.ts` and the tests all go through it, so the worker
 * path and the synchronous path cannot drift apart.
 *
 * Nothing here changes optimizer logic. Each job passes exactly the arguments
 * the Optimize step passed before (raw settings per team, the caller's merged
 * settings for the all-teams dialog). A job never mutates the workspace it is
 * given; it returns new arrays.
 */
import type { Gender, ScoringSettings, Workspace } from '../types';
import {
  optimizeRosterAllTeams,
  optimizeRosterForTeam,
  type GuardedOptimizerResult,
  type OptimizerProgress,
  type OptimizerStage,
} from './rosterOptimizer';
import {
  buildArbitrageCardsResult,
  optimizeWithArbitrage,
  type ArbitrageCardsResult,
  type ArbitrageMode,
  type ArbitrageOptimizeResult,
} from './rosterArbitrage';

export type { OptimizerProgress };

/** Every team in the field, one after another (`optimizeRosterAllTeams`). */
export type OptimizeAllTeamsJob = {
  kind: 'allTeams';
  removeSeniors: boolean;
  settings: ScoringSettings;
  stage: OptimizerStage;
};

/** One team, scorers then events in one greedy pass (`optimizeRosterForTeam`). */
export type OptimizeTeamLegacyJob = {
  kind: 'teamLegacy';
  team: string;
  removeSeniors: boolean;
  settings: ScoringSettings;
};

/** One team, guarded arbitrage optimizer (`optimizeWithArbitrage`). */
export type OptimizeTeamArbitrageJob = {
  kind: 'teamArbitrage';
  team: string;
  removeSeniors: boolean;
  settings: ScoringSettings;
  mode: ArbitrageMode;
};

/** Read-only swap scan for one team (`buildArbitrageCardsResult`). */
export type OptimizeScanJob = {
  kind: 'scan';
  team: string;
  settings: ScoringSettings;
};

export type OptimizeJob =
  | OptimizeAllTeamsJob
  | OptimizeTeamLegacyJob
  | OptimizeTeamArbitrageJob
  | OptimizeScanJob;

export type OptimizeJobKind = OptimizeJob['kind'];

/** What each job kind returns. */
export type OptimizeJobResultMap = {
  allTeams: GuardedOptimizerResult;
  teamLegacy: GuardedOptimizerResult;
  teamArbitrage: ArbitrageOptimizeResult;
  scan: ArbitrageCardsResult;
};

export type OptimizeJobResult<J extends OptimizeJob = OptimizeJob> = OptimizeJobResultMap[J['kind']];

/**
 * Run one job. Pure with respect to its inputs: the workspace is read, never
 * written. `onProgress` is called only by the all-teams job, once before each
 * team starts.
 */
export function runOptimizeJob<J extends OptimizeJob>(
  workspace: Workspace,
  gender: Gender,
  job: J,
  onProgress?: (progress: OptimizerProgress) => void
): OptimizeJobResult<J>;
export function runOptimizeJob(
  workspace: Workspace,
  gender: Gender,
  job: OptimizeJob,
  onProgress?: (progress: OptimizerProgress) => void
): OptimizeJobResult {
  switch (job.kind) {
    case 'allTeams':
      return optimizeRosterAllTeams(
        workspace,
        gender,
        job.removeSeniors,
        job.settings,
        job.stage,
        undefined,
        onProgress
      );
    case 'teamLegacy':
      return optimizeRosterForTeam(workspace, gender, job.team, job.removeSeniors, job.settings);
    case 'teamArbitrage':
      return optimizeWithArbitrage(
        workspace,
        gender,
        job.team,
        job.removeSeniors,
        job.settings,
        job.mode
      );
    case 'scan':
      return buildArbitrageCardsResult(workspace, gender, job.team, job.settings);
    default: {
      const unknown: never = job;
      throw new Error(`Unknown optimize job: ${JSON.stringify(unknown)}`);
    }
  }
}
