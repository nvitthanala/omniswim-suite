/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs one optimizer job at a time through `requestOptimize` (a Web Worker in
 * the browser, in-thread where none exists) and exposes what the status line
 * needs: the run in flight, its progress, and a cancel.
 *
 * The hook never touches the workspace. `start` resolves with the optimizer's
 * result, or `null` when the run was cancelled, superseded or the component
 * unmounted. The caller decides whether and how to apply a result.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Gender, Workspace } from '@omniswim/core/types';
import {
  isOptimizeCancelled,
  requestOptimize,
  type OptimizeJob,
  type OptimizeJobResult,
} from '@omniswim/core/lib/optimizeClient';
import type { OptimizeRunState } from './optimizeRunView';

export type UseOptimizeRun = {
  /** The run in flight, or `null`. */
  run: OptimizeRunState | null;
  /**
   * Start a job. Resolves `null` when it was cancelled. Rejects with the
   * optimizer's error. Starting while a run is in flight cancels that run.
   */
  start: <J extends OptimizeJob>(
    workspace: Workspace,
    gender: Gender,
    job: J
  ) => Promise<OptimizeJobResult<J> | null>;
  /** Cancel the run in flight. No-op when there is none. */
  cancel: () => void;
};

export function useOptimizeRun(): UseOptimizeRun {
  const [run, setRun] = useState<OptimizeRunState | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  // A run that outlives its component would call setState on nothing, and a
  // Worker would keep computing a result nobody reads.
  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    async <J extends OptimizeJob>(
      workspace: Workspace,
      gender: Gender,
      job: J
    ): Promise<OptimizeJobResult<J> | null> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const team = 'team' in job ? job.team : '';
      setRun({ kind: job.kind, team, progress: null });
      try {
        const result = await requestOptimize(workspace, gender, job, {
          signal: controller.signal,
          onProgress: progress => {
            if (controllerRef.current !== controller) return;
            setRun({ kind: job.kind, team, progress });
          },
        });
        // The client rejects with the cancelled error on abort, so a resolved result is a live one.
        return result;
      } catch (err) {
        if (isOptimizeCancelled(err)) return null;
        throw err;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setRun(null);
        }
      }
    },
    []
  );

  return { run, start, cancel };
}
