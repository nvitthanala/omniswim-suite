/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard page owns the optimizer worker (D3 3, option D): `new Worker('optimizer.worker.js')`,
 * resolved against dashboard.html. The worker starts on the first request and lives as long as the
 * page. No blob worker, no offscreen document.
 */
import type { OptimizerResponse, SolveLpRequest, SolvedResponse } from '../shared/optimizerProtocol';

export interface OptimizerClient {
  solveLp(lp: string, options?: SolveLpRequest['options']): Promise<SolvedResponse>;
  /** Send a request type the worker does not implement. Resolves with the worker's error text. */
  probeUnsupported(): Promise<string>;
  terminate(): void;
}

export function createOptimizerClient(): OptimizerClient {
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve(r: SolvedResponse): void; reject(e: Error): void }>();

  const start = (): Worker => {
    if (worker) return worker;
    const w = new Worker('optimizer.worker.js');
    w.addEventListener('message', (event: MessageEvent<OptimizerResponse>) => {
      const m = event.data;
      if (m.kind === 'solved') {
        pending.get(m.id)?.resolve(m);
        pending.delete(m.id);
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
        pending.set(id, { resolve, reject });
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
