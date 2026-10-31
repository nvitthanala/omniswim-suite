/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard page owns the optimizer worker (D3 3, option D): `new Worker('optimizer.worker.js')`,
 * resolved against dashboard.html. The worker starts on the first request and lives as long as the
 * page. No blob worker, no offscreen document.
 */
import type { OptimizerResponse, SolveLpRequest, SolveMipRequest, SolvedMipResponse, SolvedResponse } from '../shared/optimizerProtocol';

export interface OptimizerClient {
  solveLp(lp: string, options?: SolveLpRequest['options']): Promise<SolvedResponse>;
  /**
   * Solve a MIP through the worker's Model API (D5 section 11). The reply has the shape of the engine's `MipSolve` result, so this
   * method is a `MipSolve`. `columns` is `{}` unless the status is 'Optimal'.
   */
  solveMip(lp: string, options?: SolveMipRequest['options']): Promise<SolvedMipResponse>;
  /** Send a request type the worker does not implement. Resolves with the worker's error text. */
  probeUnsupported(): Promise<string>;
  terminate(): void;
}

export function createOptimizerClient(): OptimizerClient {
  let worker: Worker | undefined;
  let nextId = 1;
  /** One entry per request in flight. `kind` is the reply kind the request expects: a reply of another kind is an error, not a result. */
  const pending = new Map<number, { kind: 'solved' | 'solved-mip'; resolve(r: never): void; reject(e: Error): void }>();

  const start = (): Worker => {
    if (worker) return worker;
    const w = new Worker('optimizer.worker.js');
    w.addEventListener('message', (event: MessageEvent<OptimizerResponse>) => {
      const m = event.data;
      if (m.kind === 'solved' || m.kind === 'solved-mip') {
        const waiting = pending.get(m.id);
        if (waiting === undefined) return;
        pending.delete(m.id);
        if (waiting.kind === m.kind) waiting.resolve(m as never);
        else waiting.reject(new Error(`optimizer worker answered a ${waiting.kind} request with ${m.kind}`));
      } else if (m.id !== undefined) {
        pending.get(m.id)?.reject(new Error(m.error));
        pending.delete(m.id);
      }
    });
    w.addEventListener('error', (event) => {
      const error = new Error(`optimizer worker failed: ${event.message}`);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    });
    worker = w;
    return w;
  };

  return {
    solveLp(lp, options) {
      const id = nextId++;
      const request: SolveLpRequest = options ? { kind: 'solve-lp', id, lp, options } : { kind: 'solve-lp', id, lp };
      return new Promise<SolvedResponse>((resolve, reject) => {
        pending.set(id, { kind: 'solved', resolve, reject });
        start().postMessage(request);
      });
    },
    solveMip(lp, options) {
      const id = nextId++;
      const request: SolveMipRequest = options ? { kind: 'solve-mip', id, lp, options } : { kind: 'solve-mip', id, lp };
      return new Promise<SolvedMipResponse>((resolve, reject) => {
        pending.set(id, { kind: 'solved-mip', resolve, reject });
        start().postMessage(request);
      });
    },
    probeUnsupported() {
      const w = start();
      return new Promise<string>((resolve) => {
        const onMessage = (event: MessageEvent<OptimizerResponse>): void => {
          const m = event.data;
          if (m.kind !== 'error' || m.id !== undefined) return;
          w.removeEventListener('message', onMessage);
          resolve(m.error);
        };
        w.addEventListener('message', onMessage);
        w.postMessage({ kind: 'plan-lineup' });
      });
    },
    terminate() {
      worker?.terminate();
      worker = undefined;
      for (const p of pending.values()) p.reject(new Error('optimizer worker terminated'));
      pending.clear();
    },
  };
}
