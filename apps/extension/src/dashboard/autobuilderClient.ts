/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard page owns the AutoBuilder worker (plans/2026-10-25/D5-AUTOBUILDER.md, amendment 7): `new Worker('autobuilder.worker.js')`,
 * resolved against dashboard.html, like `optimizerClient.ts`. The worker starts on the first run and stays for the next ones.
 *
 * One run at a time. `cancel()` terminates the worker (there is no cancel message), rejects the run with the error 'cancelled',
 * and the next run starts a fresh worker. `optimizer.worker` is a different worker, so a cancel never touches a solve in flight there.
 */
import type { AutoBuildResult } from '@omniswim/engine';
import type {
  AutoBuildClockMode,
  AutoBuildErrorSource,
  AutoBuildProgress,
  AutoBuildRequestMessage,
  AutoBuildWireRequest,
  AutoBuildWorkerResponse,
} from '../shared/autobuilderProtocol';

/** The message of the error a cancelled run rejects with. */
export const AUTOBUILD_CANCELLED = 'cancelled';

/** The progress the page sees: `kind` and `id` are the client's business. */
export type AutoBuildProgressUpdate = Pick<AutoBuildProgress, 'solvesDone' | 'elapsedMs' | 'limitMs'>;

/** What a finished run resolves with. `loadMs` and `wallMs` come from the worker. */
export interface AutoBuildRun {
  readonly result: AutoBuildResult;
  readonly loadMs: number;
  readonly wallMs: number;
}

/** A run the worker ended with an error. `source`, `code` and `subject` are the worker's copy of the engine error's fields. */
export class AutoBuildRunError extends Error {
  readonly source: AutoBuildErrorSource;
  readonly code: string;
  readonly subject: string | null;

  constructor(source: AutoBuildErrorSource, code: string, subject: string | null, message: string) {
    super(message);
    this.name = 'AutoBuildRunError';
    this.source = source;
    this.code = code;
    this.subject = subject;
  }
}

export interface AutoBuildClient {
  /**
   * Run `autoBuild` in the worker. `req` must not hold a `clock`: a function cannot be posted, so a request that holds one is refused
   * with a rejection before anything is sent. `options.clock` is `'wall'` (default) or `'none'` (every timing is `null`).
   * Rejects with `AutoBuildRunError` for an engine error, and with `Error('cancelled')` after `cancel()`.
   * Resolves with the engine's result. Use `runTimed` for the worker's timings too.
   */
  run(req: AutoBuildWireRequest, onProgress: (progress: AutoBuildProgressUpdate) => void, options?: { readonly clock?: AutoBuildClockMode }): Promise<AutoBuildResult>;
  /** Like `run`, and also resolves with the worker's `loadMs` and `wallMs`. */
  runTimed(req: AutoBuildWireRequest, onProgress: (progress: AutoBuildProgressUpdate) => void, options?: { readonly clock?: AutoBuildClockMode }): Promise<AutoBuildRun>;
  /** Terminate the worker and reject the run in flight with `Error('cancelled')`. Does nothing when no run is in flight. */
  cancel(): void;
}

interface Active {
  readonly id: number;
  readonly onProgress: (progress: AutoBuildProgressUpdate) => void;
  resolve(run: AutoBuildRun): void;
  reject(error: Error): void;
}

export function createAutoBuildClient(): AutoBuildClient {
  let worker: Worker | undefined;
  let nextId = 1;
  let active: Active | undefined;

  /** Drop the worker. It is fresh on the next run. */
  const discard = (): void => {
    worker?.terminate();
    worker = undefined;
  };

  const settle = (id: number): Active | undefined => {
    if (active?.id !== id) return undefined;
    const run = active;
    active = undefined;
    return run;
  };

  const start = (): Worker => {
    if (worker) return worker;
    const w = new Worker('autobuilder.worker.js');
    w.addEventListener('message', (event: MessageEvent<AutoBuildWorkerResponse>) => {
      if (worker !== w) return;
      const m = event.data;
      if (m.kind === 'auto-build-progress') {
        if (active?.id === m.id) active.onProgress({ solvesDone: m.solvesDone, elapsedMs: m.elapsedMs, limitMs: m.limitMs });
      } else if (m.kind === 'auto-build-done') {
        settle(m.id)?.resolve({ result: m.result, loadMs: m.loadMs, wallMs: m.wallMs });
      } else {
        settle(m.id)?.reject(new AutoBuildRunError(m.source, m.code, m.subject, m.message));
      }
    });
    // A script that fails to load, or a message the worker cannot read: the run cannot finish. Drop the worker so the next run is fresh.
    const fail = (what: string) => (event: Event): void => {
      if (worker !== w) return;
      const detail = (event as { message?: string }).message;
      const run = active;
      active = undefined;
      discard();
      run?.reject(new Error(`autobuilder worker ${what}${detail ? `: ${detail}` : ''}`));
    };
    w.addEventListener('error', fail('failed'));
    w.addEventListener('messageerror', fail('sent an unreadable message'));
    worker = w;
    return w;
  };

  const runTimed: AutoBuildClient['runTimed'] = (req, onProgress, options) => {
    // A function in the request cannot be cloned. Refuse here, before a worker starts and before the run slot is taken.
    if ((req as { clock?: unknown }).clock !== undefined) return Promise.reject(new Error('the request holds a clock; pass the clock mode instead'));
    if (active) return Promise.reject(new Error('an auto-build is already running'));
    const id = nextId++;
    const message: AutoBuildRequestMessage = { kind: 'auto-build', id, request: req, clock: options?.clock ?? 'wall' };
    return new Promise<AutoBuildRun>((resolve, reject) => {
      active = { id, onProgress, resolve, reject };
      try {
        start().postMessage(message);
      } catch (cause) {
        // A request that cannot be cloned throws here. The worker is fine, but the run slot must be free again.
        active = undefined;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  };

  return {
    runTimed,
    async run(req, onProgress, options) {
      return (await runTimed(req, onProgress, options)).result;
    },
    cancel() {
      const run = active;
      active = undefined;
      if (run === undefined) return;
      discard();
      run.reject(new Error(AUTOBUILD_CANCELLED));
    },
  };
}
