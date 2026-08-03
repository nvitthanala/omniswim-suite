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
import { computeScenarioDiff, type ScenarioDiffResult } from '../lib/scenarioDiff';
import type { Gender, ScoringSettings, Workspace } from '../types';

/** Default op (backward compatible): full scoring snapshot. `op` may be omitted. */
export type ScoringRequest = {
  id: number;
  op?: 'scoring';
  workspace: Workspace;
  gender: Gender;
  removeSeniors: boolean;
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
};

export type WorkerRequest = ScoringRequest | CrossCourseArbitrageRequest | ScenarioDiffRequest;

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

  if (data.op === 'scenarioDiff') {
    const { id, current, snapshot, team, gender, settings, removeSeniors } = data;
    try {
      const result = computeScenarioDiff(current, snapshot, {
        team,
        gender,
        settings,
        removeSeniors,
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

  const { id, workspace, gender, removeSeniors } = data;
  try {
    const snapshot = buildScoringSnapshot(workspace, gender, removeSeniors);
    ctx.postMessage({ id, ok: true, ...snapshot });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
