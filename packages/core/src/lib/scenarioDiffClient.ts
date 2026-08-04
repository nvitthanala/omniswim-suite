/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client helper that runs computeScenarioDiff off the main thread via the
 * scoringWorker `scenarioDiff` op, returning a promise. Falls back to a
 * synchronous in-thread compute when Web Workers are unavailable (SSR, tests).
 * Each call uses its own short-lived worker instance and terminates it on
 * completion, so it never interferes with the scoring worker owned by
 * useWorkspaceScoring. (Same pattern as crossCourseArbitrageClient.)
 */
import type { Workspace } from '../types';
import {
  computeScenarioDiff,
  type ScenarioDiffOptions,
  type ScenarioDiffResult,
  type ScenarioDiffSideMode,
} from './scenarioDiff';
import type { ScenarioDiffResponse } from '../workers/scoringWorker';

export type { ScenarioDiffOptions, ScenarioDiffResult, ScenarioDiffSideMode };

function supportsModuleWorker(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

let requestId = 0;

/**
 * Compute the per-event/per-swimmer diff between the current workspace and a
 * saved scenario snapshot's content. Off the main thread when possible.
 */
export function requestScenarioDiff(
  current: Workspace,
  snapshotContent: Workspace,
  opts: ScenarioDiffOptions
): Promise<ScenarioDiffResult> {
  if (!supportsModuleWorker()) {
    try {
      return Promise.resolve(computeScenarioDiff(current, snapshotContent, opts));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return new Promise<ScenarioDiffResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/scoringWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // Worker construction failed → run synchronously.
      try {
        resolve(computeScenarioDiff(current, snapshotContent, opts));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    const id = ++requestId;
    const cleanup = () => worker.terminate();

    worker.onmessage = (event: MessageEvent<ScenarioDiffResponse>) => {
      const data = event.data;
      if (!data || data.id !== id || data.op !== 'scenarioDiff') return;
      cleanup();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error ?? 'Scenario diff worker failed'));
    };
    worker.onerror = event => {
      cleanup();
      reject(new Error(event.message || 'Scenario diff worker error'));
    };

    worker.postMessage({
      id,
      op: 'scenarioDiff',
      current,
      snapshot: snapshotContent,
      team: opts.team,
      gender: opts.gender,
      settings: opts.settings,
      removeSeniors: opts.removeSeniors,
      // Must be forwarded explicitly: this postMessage enumerates option fields
      // rather than spreading `opts`, so a field missed here would silently be
      // dropped on the worker path while still working in the sync fallback.
      thenMode: opts.thenMode,
    });
  });
}
