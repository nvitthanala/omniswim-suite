/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Web Worker that runs the scoring engine off the main thread. The shell
 * instantiates this with Vite's `new Worker(new URL(...), { type: 'module' })`.
 */
/// <reference lib="webworker" />
import { buildScoringSnapshot } from '../lib/scoringEngine';
import {
  computeCrossCourseArbitrage,
  type CrossCourseArbitrageResult,
} from '../lib/crossCourseArbitrage';
import {
  computeScenarioDiff,
  type ScenarioDiffResult,
  type ScenarioDiffSideMode,
} from '../lib/scenarioDiff';
import { runOptimizeJob, type OptimizeJob, type OptimizeJobResult } from '../lib/optimizeJob';
import type { Gender, ScoringSettings, Workspace } from '../types';
import type { CatalogTeamRoster } from '../lib/rosterCatalog';

/** Default op (backward compatible): full scoring snapshot. `op` may be omitted. */
export type ScoringRequest = {
  id: number;
  op?: 'scoring';
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
  rosterCatalog?: CatalogTeamRoster;
};

/** Cross-course arbitrage op (table + coverage gaps + exact swap ranking). */
export type CrossCourseArbitrageRequest = {
  id: number;
  op: 'crossCourseArbitrage';
  workspace: Workspace;
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  /** Recency window (months) for candidate-time selection (optional; default 24). */
  recencyMonths?: number;
};

/** Scenario diff op: saved lineup snapshot vs current lineup, per event/swimmer. */
export type ScenarioDiffRequest = {
  id: number;
  op: 'scenarioDiff';
  current: Workspace;
  snapshot: Workspace;
  team: string;
  gender: Gender;
  settings?: ScoringSettings;
  removeSeniors?: boolean;
  /** How the "then" side is scored; `baseline` diffs the loaded meet. */
  thenMode?: ScenarioDiffSideMode;
};

/**
 * Optimizer op: runs one `OptimizeJob` (single team, all teams or the swap scan)
 * through the same `runOptimizeJob` the in-thread fallback uses. The worker
 * receives a structured-clone copy of the workspace and returns plain data; the
 * caller applies the result on the main thread. Cancel is `worker.terminate()`
 * from the client, so the worker holds no cancel state.
 */
export type OptimizeRequest = {
  id: number;
  op: 'optimize';
  workspace: Workspace;
  gender: Gender;
  job: OptimizeJob;
};

export type WorkerRequest =
  | ScoringRequest
  | CrossCourseArbitrageRequest
  | ScenarioDiffRequest
  | OptimizeRequest;

export type CrossCourseArbitrageResponse = {
  id: number;
  op: 'crossCourseArbitrage';
  ok: boolean;
  result?: CrossCourseArbitrageResult;
  error?: string;
};

export type ScenarioDiffResponse = {
  id: number;
  op: 'scenarioDiff';
  ok: boolean;
  result?: ScenarioDiffResult;
  error?: string;
};

/**
 * Posted first, before any work. It tells the client the worker script started, so a later
 * worker error is a real failure of the run and not a failure to load.
 */
export type OptimizeStartedResponse = {
  id: number;
  op: 'optimize';
  type: 'started';
};

/** Posted before each team of an all-teams job. `current` is 1-based. */
export type OptimizeProgressResponse = {
  id: number;
  op: 'optimize';
  type: 'progress';
  current: number;
  total: number;
  team: string;
};

export type OptimizeResultResponse = {
  id: number;
  op: 'optimize';
  type: 'result';
  ok: boolean;
  result?: OptimizeJobResult;
  error?: string;
};

export type OptimizeResponse =
  | OptimizeStartedResponse
  | OptimizeProgressResponse
  | OptimizeResultResponse;

const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;

  if (data.op === 'crossCourseArbitrage') {
    const { id, workspace, team, gender, settings, recencyMonths } = data;
    try {
      const result = computeCrossCourseArbitrage(workspace, {
        team,
        gender,
        settings,
        recencyMonths,
      });
      ctx.postMessage({ id, op: 'crossCourseArbitrage', ok: true, result });
    } catch (err) {
      ctx.postMessage({
        id,
        op: 'crossCourseArbitrage',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (data.op === 'optimize') {
    const { id, workspace, gender, job } = data;
    const started: OptimizeStartedResponse = { id, op: 'optimize', type: 'started' };
    ctx.postMessage(started);
    try {
      const result = runOptimizeJob(workspace, gender, job, progress => {
        const message: OptimizeProgressResponse = { id, op: 'optimize', type: 'progress', ...progress };
        ctx.postMessage(message);
      });
      const message: OptimizeResultResponse = { id, op: 'optimize', type: 'result', ok: true, result };
      ctx.postMessage(message);
    } catch (err) {
      const message: OptimizeResultResponse = {
        id,
        op: 'optimize',
        type: 'result',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      ctx.postMessage(message);
    }
    return;
  }

  if (data.op === 'scenarioDiff') {
    const { id, current, snapshot, team, gender, settings, removeSeniors, thenMode } = data;
    try {
      const result = computeScenarioDiff(current, snapshot, {
        team,
        gender,
        settings,
        removeSeniors,
        thenMode,
      });
      ctx.postMessage({ id, op: 'scenarioDiff', ok: true, result });
    } catch (err) {
      ctx.postMessage({
        id,
        op: 'scenarioDiff',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Default op: full scoring snapshot, optionally enriched by the roster catalog.
  const { id, workspace, gender, removeSeniors, rosterCatalog } = data;
  try {
    const snapshot = buildScoringSnapshot(workspace, gender, removeSeniors, rosterCatalog);
    ctx.postMessage({ id, ok: true, ...snapshot });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
