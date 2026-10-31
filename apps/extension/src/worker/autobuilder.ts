/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * autobuilder.worker (plans/2026-10-25/D5-AUTOBUILDER.md, amendment 7). Runs all of `autoBuild` in a worker owned by the dashboard
 * page, so the synchronous column evaluation, local search, gate and explanations never block the page or the port handler of the
 * docked panel. `optimizer.worker` does not change and keeps serving `rosterSuggest` and the opponent re-suggests.
 *
 * It loads its own HiGHS exactly as `optimizer.ts` does (`highs.wasm` beside this script) and builds the engine's `MipSolve` by
 * calling `solveMipOn` (`optimizerSolve.ts`) directly. The wrapper posts one `auto-build-progress` after each MipSolve call.
 * The protocol is `shared/autobuilderProtocol.ts`. There is no cancel message: the page terminates the worker.
 *
 * The extension tsconfig has the DOM lib, where `self.postMessage` takes a target origin. In a worker it does not, so the cast
 * below names the worker shape.
 */
import loadHighs from 'highs';
import type { Highs } from 'highs';
import { AutoBuildError, ScoreMeetError, autoBuild, autoBuildObjective } from '@omniswim/engine';
import type { AutoBuildRequest, AutoBuildResult, MipSolve } from '@omniswim/engine';
import type { AutoBuildErrorMessage, AutoBuildRequestMessage, AutoBuildScoreRequestMessage, AutoBuildWorkerResponse } from '../shared/autobuilderProtocol';
import { solveMipOn } from './optimizerSolve';

const scope = self as unknown as {
  postMessage(message: AutoBuildWorkerResponse): void;
  onmessage: ((event: MessageEvent) => void) | null;
  location: { href: string };
};

let highsPromise: Promise<{ highs: Highs; loadMs: number }> | undefined;

/** Load once per worker. The wasm URL is resolved against this worker's own URL. A failed load is not kept, so the next run retries. */
function getHighs(): Promise<{ highs: Highs; loadMs: number }> {
  highsPromise ??= (async () => {
    const wasmUrl = new URL('highs.wasm', scope.location.href).href;
    const t0 = performance.now();
    const highs = await loadHighs({ locateFile: (file: string) => (file === 'highs.wasm' ? wasmUrl : file) });
    return { highs, loadMs: performance.now() - t0 };
  })();
  highsPromise.catch(() => {
    highsPromise = undefined;
  });
  return highsPromise;
}

function isAutoBuildMessage(m: unknown): m is AutoBuildRequestMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.kind !== 'auto-build' || typeof r.id !== 'number') return false;
  if (r.clock !== 'wall' && r.clock !== 'none') return false;
  return typeof r.request === 'object' && r.request !== null;
}

function isScoreMessage(m: unknown): m is AutoBuildScoreRequestMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.kind !== 'score' || typeof r.id !== 'number') return false;
  if (r.scaleD !== undefined && typeof r.scaleD !== 'number') return false;
  return typeof r.request === 'object' && r.request !== null && typeof r.lineup === 'object' && r.lineup !== null && Array.isArray(r.tags);
}

/** Score one lineup in the request's objective (D5 amendment 10). Synchronous and HiGHS-free, so it never waits on the wasm load. */
function score(message: AutoBuildScoreRequestMessage): void {
  const { id } = message;
  try {
    scope.postMessage({ kind: 'score-done', id, score: autoBuildObjective(message.request, message.lineup, message.tags, message.scaleD) });
  } catch (cause) {
    scope.postMessage(errorMessageOf(id, cause));
  }
}

/** `code` and `subject` are copied: an Error keeps only its name and message across `postMessage`. */
function errorMessageOf(id: number, cause: unknown): AutoBuildErrorMessage {
  if (cause instanceof AutoBuildError) return { kind: 'auto-build-error', id, source: 'autobuild', code: cause.code, subject: cause.subject, message: cause.message };
  if (cause instanceof ScoreMeetError) return { kind: 'auto-build-error', id, source: 'score', code: cause.code, subject: cause.subject, message: cause.message };
  return { kind: 'auto-build-error', id, source: 'internal', code: 'internal', subject: null, message: cause instanceof Error ? cause.message : String(cause) };
}

async function run(message: AutoBuildRequestMessage): Promise<void> {
  const { id } = message;
  const startedAt = performance.now();
  try {
    // A function cannot cross postMessage, so a real page never sends one. A caller that does is refused, not obeyed.
    if ((message.request as { clock?: unknown }).clock !== undefined) {
      scope.postMessage({ kind: 'auto-build-error', id, source: 'internal', code: 'internal', subject: 'clock', message: 'the request holds a clock; the worker sets it from the clock mode' });
      return;
    }
    const { highs, loadMs } = await getHighs();
    const limitMs = message.request.limits.timeLimitSeconds * 1000;
    let solvesDone = 0;
    const solve: MipSolve = async (lp, options) => {
      const reply = solveMipOn(highs, { kind: 'solve-mip', id, lp, options }, loadMs);
      solvesDone += 1;
      scope.postMessage({ kind: 'auto-build-progress', id, solvesDone, elapsedMs: performance.now() - startedAt, limitMs });
      const { status, objective, columns, incumbent, dualBound, seconds } = reply;
      return { status, objective, columns, incumbent, dualBound, seconds };
    };
    const request: AutoBuildRequest = message.clock === 'wall' ? { ...message.request, clock: () => performance.now() } : message.request;
    const result: AutoBuildResult = await autoBuild(request, solve);
    scope.postMessage({ kind: 'auto-build-done', id, result, loadMs, wallMs: performance.now() - startedAt });
  } catch (cause) {
    scope.postMessage(errorMessageOf(id, cause));
  }
}

scope.onmessage = (event: MessageEvent) => {
  const message: unknown = event.data;
  if (isAutoBuildMessage(message)) {
    void run(message);
    return;
  }
  if (isScoreMessage(message)) {
    score(message);
    return;
  }
  // Every other message gets an error when it names a run. One that does not has nobody to answer.
  const id = (message as { id?: unknown } | null)?.id;
  if (typeof id === 'number') scope.postMessage({ kind: 'auto-build-error', id, source: 'internal', code: 'internal', subject: null, message: 'autobuilder worker: unsupported request' });
};
