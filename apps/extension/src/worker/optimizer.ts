/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * optimizer.worker. Runs in a worker owned by an extension page (the dashboard tab or the docked
 * iframe), never in a content script (D3 section 3, option D).
 *
 * Today it implements one request, `solve-lp`: solve a CPLEX-LP model with HiGHS and return the
 * solver's own status, objective and column values. It does not build a lineup model. That is the
 * AutoBuilder's job in a later phase. Every other request type gets the explicit error below and
 * no result, so there is no fake plan to mistake for a real one.
 *
 * HiGHS is the `highs` npm package, pinned at 1.15.4. The wasm file sits beside this script in
 * `dist/` and is found with `new URL('highs.wasm', self.location.href)`. The glue has no `eval`
 * and no `new Function` (tests/extensionBundleBoundaries.test.ts, T-B7).
 *
 * The extension tsconfig has the DOM lib, where `self.postMessage` takes a target origin. In a
 * worker it does not, so the cast below names the worker shape.
 */
import loadHighs from 'highs';
import type { Highs, HighsOptions } from 'highs';
import { OPTIMIZER_UNAVAILABLE, type OptimizerRequest, type OptimizerResponse } from '../shared/optimizerProtocol';
import { optimalColumns } from './optimizerResult';

export { OPTIMIZER_UNAVAILABLE };

const scope = self as unknown as {
  postMessage(message: OptimizerResponse): void;
  onmessage: ((event: MessageEvent) => void) | null;
  location: { href: string };
};

let highsPromise: Promise<{ highs: Highs; loadMs: number }> | undefined;

/** Load once per worker. The wasm URL is resolved against this worker's own URL. */
function getHighs(): Promise<{ highs: Highs; loadMs: number }> {
  highsPromise ??= (async () => {
    const wasmUrl = new URL('highs.wasm', scope.location.href).href;
    const t0 = performance.now();
    const highs = await loadHighs({ locateFile: (file: string) => (file === 'highs.wasm' ? wasmUrl : file) });
    return { highs, loadMs: performance.now() - t0 };
  })();
  return highsPromise;
}

function isSolveRequest(m: unknown): m is Extract<OptimizerRequest, { kind: 'solve-lp' }> {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return r.kind === 'solve-lp' && typeof r.id === 'number' && typeof r.lp === 'string';
}

async function solve(request: Extract<OptimizerRequest, { kind: 'solve-lp' }>): Promise<OptimizerResponse> {
  const { highs, loadMs } = await getHighs();
  const t0 = performance.now();
  const solution = highs.solve(request.lp, { output_flag: false, ...(request.options as HighsOptions | undefined) });
  const solveMs = performance.now() - t0;
  const columns = optimalColumns(solution.Status, () => solution.Columns as never);
  return { kind: 'solved', id: request.id, status: solution.Status, objective: solution.ObjectiveValue, columns, loadMs, solveMs };
}

scope.onmessage = (event: MessageEvent) => {
  const message: unknown = event.data;
  if (!isSolveRequest(message)) {
    scope.postMessage({ kind: 'error', error: OPTIMIZER_UNAVAILABLE });
    return;
  }
  solve(message).then(
    (response) => scope.postMessage(response),
    (e: unknown) => scope.postMessage({ kind: 'error', id: message.id, error: `solve failed: ${e instanceof Error ? e.message : String(e)}` }),
  );
};
