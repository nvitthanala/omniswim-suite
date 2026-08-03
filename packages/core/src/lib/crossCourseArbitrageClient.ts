/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client helper that runs computeCrossCourseArbitrage off the main thread via
 * the scoringWorker `crossCourseArbitrage` op, returning a promise. Falls back
 * to a synchronous in-thread compute when Web Workers are unavailable (SSR,
 * tests). Each call uses its own short-lived worker instance and terminates it
 * on completion, so it never interferes with the scoring worker owned by
 * useWorkspaceScoring.
 */
import type { Gender, ScoringSettings, Workspace } from '../types';
import {
  computeCrossCourseArbitrage,
  type CrossCourseArbitrageOptions,
  type CrossCourseArbitrageResult,
} from './crossCourseArbitrage';
import type { CrossCourseArbitrageResponse } from '../workers/scoringWorker';

export type { CrossCourseArbitrageResult, CrossCourseArbitrageOptions };

function supportsModuleWorker(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

let requestId = 0;

/**
 * Compute the cross-course arbitrage bundle (table + coverage gaps + exact swap
 * ranking) for a single team/gender. Off the main thread when possible.
 */
export function requestCrossCourseArbitrage(
  workspace: Workspace,
  opts: { team: string; gender: Gender; settings?: ScoringSettings; recencyMonths?: number }
): Promise<CrossCourseArbitrageResult> {
  if (!supportsModuleWorker()) {
    try {
      return Promise.resolve(computeCrossCourseArbitrage(workspace, opts));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return new Promise<CrossCourseArbitrageResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/scoringWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // Worker construction failed → run synchronously.
      try {
        resolve(computeCrossCourseArbitrage(workspace, opts));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    const id = ++requestId;
    const cleanup = () => worker.terminate();

    worker.onmessage = (event: MessageEvent<CrossCourseArbitrageResponse>) => {
      const data = event.data;
      if (!data || data.id !== id || data.op !== 'crossCourseArbitrage') return;
      cleanup();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error ?? 'Cross-course arbitrage worker failed'));
    };
    worker.onerror = event => {
      cleanup();
      reject(new Error(event.message || 'Cross-course arbitrage worker error'));
    };

    worker.postMessage({
      id,
      op: 'crossCourseArbitrage',
      workspace,
      team: opts.team,
      gender: opts.gender,
      settings: opts.settings,
      recencyMonths: opts.recencyMonths,
    });
  });
}
