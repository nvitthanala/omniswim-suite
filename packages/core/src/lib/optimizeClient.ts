/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client that runs an optimizer job (`OptimizeJob`) off the main thread via the
 * scoringWorker `optimize` op, returning a promise. Same shape as
 * `crossCourseArbitrageClient.ts` and `scenarioDiffClient.ts`: each call owns a
 * short-lived worker and terminates it when it settles, and the call falls back
 * to an in-thread run when Web Workers are unavailable (SSR, tests).
 *
 * Cancel. Pass an `AbortSignal`. Abort terminates the worker and rejects with
 * `OptimizeCancelledError`. A cancelled run produces no result at all: the
 * worker only ever sees a structured-clone copy of the workspace, so there is
 * nothing to roll back. In the in-thread fallback the run cannot be
 * interrupted; a result that finishes after abort is discarded and the promise
 * still rejects with `OptimizeCancelledError`.
 *
 * Progress. `onProgress` fires before each team of an all-teams job. Single-team
 * jobs report none.
 *
 * Differences from the sibling clients, both deliberate:
 *  - A worker that never started (script failed to load) or that cannot be sent the request
 *    (DataCloneError) falls back to an in-thread run instead of rejecting, because the optimizer
 *    must keep working. The worker posts a `started` message first, so an error after that, or
 *    a reply the page cannot read (`messageerror`), is a real failure and rejects.
 *  - Abort rejects with `OptimizeCancelledError` (name `AbortError`).
 */
import type { Gender, Workspace } from '../types';
import {
  runOptimizeJob,
  type OptimizeJob,
  type OptimizeJobResult,
  type OptimizerProgress,
} from './optimizeJob';
import type { OptimizeResponse } from '../workers/scoringWorker';

export type { OptimizeJob, OptimizeJobResult, OptimizerProgress };

/** Rejection reason when the caller aborts. `name` is `AbortError`, as for `fetch`. */
export class OptimizeCancelledError extends Error {
  constructor() {
    super('Optimization cancelled');
    this.name = 'AbortError';
  }
}

export function isOptimizeCancelled(err: unknown): err is OptimizeCancelledError {
  return err instanceof OptimizeCancelledError;
}

export type OptimizeRequestOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: OptimizerProgress) => void;
};

function supportsModuleWorker(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

let requestId = 0;

/** Run the job on this thread. Used when no Worker exists or it fails to load. */
function runInThread<J extends OptimizeJob>(
  workspace: Workspace,
  gender: Gender,
  job: J,
  opts: OptimizeRequestOptions
): Promise<OptimizeJobResult<J>> {
  if (opts.signal?.aborted) return Promise.reject(new OptimizeCancelledError());
  try {
    const result = runOptimizeJob(workspace, gender, job, opts.onProgress);
    if (opts.signal?.aborted) return Promise.reject(new OptimizeCancelledError());
    return Promise.resolve(result);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Run an optimizer job. The workspace is never mutated; the result holds new
 * arrays that the caller applies (or discards) itself.
 */
export function requestOptimize<J extends OptimizeJob>(
  workspace: Workspace,
  gender: Gender,
  job: J,
  opts: OptimizeRequestOptions = {}
): Promise<OptimizeJobResult<J>> {
  if (opts.signal?.aborted) return Promise.reject(new OptimizeCancelledError());
  if (!supportsModuleWorker()) return runInThread(workspace, gender, job, opts);

  return new Promise<OptimizeJobResult<J>>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/scoringWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // Worker construction failed → run in this thread.
      runInThread(workspace, gender, job, opts).then(resolve, reject);
      return;
    }

    const id = ++requestId;
    let settled = false;
    let heardFromWorker = false;
    const { signal, onProgress } = opts;

    // One exit for every outcome: stop the worker, drop its handlers and the abort listener.
    const finish = () => {
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort() {
      if (settled) return;
      finish();
      reject(new OptimizeCancelledError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<OptimizeResponse>) => {
      const data = event.data;
      if (settled || !data || data.id !== id || data.op !== 'optimize') return;
      heardFromWorker = true;
      if (data.type === 'started') return;
      if (data.type === 'progress') {
        onProgress?.({ current: data.current, total: data.total, team: data.team });
        return;
      }
      finish();
      if (data.ok && data.result !== undefined) resolve(data.result as OptimizeJobResult<J>);
      else reject(new Error(data.error ?? 'Optimize worker failed'));
    };
    worker.onerror = event => {
      if (settled) return;
      finish();
      if (!heardFromWorker) {
        // The worker script never started (load or startup failure). The
        // optimizer must still work, so run it here instead of failing.
        runInThread(workspace, gender, job, opts).then(resolve, reject);
        return;
      }
      reject(new Error(event.message || 'Optimize worker error'));
    };

    // A reply the page could not deserialize. The run's result is lost, so it is a failure.
    worker.onmessageerror = () => {
      if (settled) return;
      finish();
      reject(new Error('Optimize worker sent a reply that could not be read'));
    };

    try {
      worker.postMessage({ id, op: 'optimize', workspace, gender, job });
    } catch {
      // The workspace could not be cloned into the worker (DataCloneError). Nothing has run, so
      // treat it as a worker that never started and run in this thread.
      finish();
      runInThread(workspace, gender, job, opts).then(resolve, reject);
    }
  });
}
