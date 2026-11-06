/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * optimizer.worker. Runs in a worker owned by an extension page (the dashboard tab or the docked
 * iframe), never in a content script (D3 section 3, option D).
 *
 * It implements two requests (the solves live in `optimizerSolve.ts`):
 * - `solve-lp`: solve a CPLEX-LP model with HiGHS and return the solver's own status, objective and column values.
 * - `solve-mip` (D5 section 11): the same model through HiGHS's Model API, with the MIP dual bound and, at a time limit, the
 *   incumbent. `columns` holds values only for the status 'Optimal'.
 * The worker does not build a lineup model. That is the AutoBuilder's job, in the page. Every other request type gets the
 * explicit error below and no result, so there is no fake plan to mistake for a real one.
 *
 * HiGHS is the `highs` npm package, pinned at 1.15.4. The wasm file sits beside this script in
 * `dist/` and is found with `new URL('highs.wasm', self.location.href)`. The glue has no `eval`
 * and no `new Function` (tests/extensionBundleBoundaries.test.ts, T-B7).
 *
 * The extension tsconfig has the DOM lib, where `self.postMessage` takes a target origin. In a
 * worker it does not, so the cast below names the worker shape.
 */
import loadHighs from 'highs';
import type { Highs } from 'highs';
import { OPTIMIZER_UNAVAILABLE, type OptimizerResponse } from '../shared/optimizerProtocol';
import { isSolveLpRequest, isSolveMipRequest, solveLpOn, solveMipOn } from './optimizerSolve';

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

/** Run one solve and post its reply, or an error that names the request. */
function serve(id: number, work: (highs: Highs, loadMs: number) => OptimizerResponse): void {
  getHighs()
    .then(({ highs, loadMs }) => work(highs, loadMs))
    .then(
      (response) => scope.postMessage(response),
      (e: unknown) => scope.postMessage({ kind: 'error', id, error: `solve failed: ${e instanceof Error ? e.message : String(e)}` }),
    );
}

scope.onmessage = (event: MessageEvent) => {
  const message: unknown = event.data;
  if (isSolveLpRequest(message)) serve(message.id, (highs, loadMs) => solveLpOn(highs, message, loadMs));
  else if (isSolveMipRequest(message)) serve(message.id, (highs, loadMs) => solveMipOn(highs, message, loadMs));
  else scope.postMessage({ kind: 'error', error: OPTIMIZER_UNAVAILABLE });
};
