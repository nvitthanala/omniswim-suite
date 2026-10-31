/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The messages between the dashboard page and autobuilder.worker (plans/2026-10-25/D5-AUTOBUILDER.md, amendment 7 item 2).
 * This file holds types only. Its engine imports are `import type`, so it adds nothing to a bundle.
 *
 * It is a protocol of its own. `optimizerProtocol.ts` (optimizer.worker) stays as it is, imports nothing, and never carries an
 * AutoBuilder message. There is no cancel message: the client calls `terminate()` (see `dashboard/autobuilderClient.ts`).
 */
import type { AutoBuildRequest, AutoBuildResult } from '@omniswim/engine';

/** What the page sends. A request carries no `clock`: a function cannot cross `postMessage`, so the worker sets it. */
export type AutoBuildWireRequest = Omit<AutoBuildRequest, 'clock'>;

/** `'wall'`: the worker passes `performance.now` as the engine clock. `'none'`: no clock, so every timing is `null`. */
export type AutoBuildClockMode = 'wall' | 'none';

/** Run `autoBuild` on `request`. `id` names the run: every reply carries it. */
export interface AutoBuildRequestMessage {
  readonly kind: 'auto-build';
  readonly id: number;
  readonly request: AutoBuildWireRequest;
  readonly clock: AutoBuildClockMode;
}

/** Sent once per finished `MipSolve` call, in order. There are no stage names. */
export interface AutoBuildProgress {
  readonly kind: 'auto-build-progress';
  readonly id: number;
  /** MipSolve calls finished so far in this run. At the end it equals `result.proof.solves.length`. */
  readonly solvesDone: number;
  /** Milliseconds from the start of the run in the worker (`performance.now`). It is sent for the UI whatever the engine clock mode. */
  readonly elapsedMs: number;
  /** The run's wall-time budget, `request.limits.timeLimitSeconds * 1000`. */
  readonly limitMs: number;
}

export interface AutoBuildDone {
  readonly kind: 'auto-build-done';
  readonly id: number;
  readonly result: AutoBuildResult;
  /** Milliseconds this worker took to load HiGHS. The same for every run of one worker, as `loadMs` is in optimizer.worker. */
  readonly loadMs: number;
  /** Milliseconds from the start of the run to this reply, HiGHS load included on a worker's first run. */
  readonly wallMs: number;
}

/** Where an error came from. `'autobuild'`: `AutoBuildError`. `'score'`: `ScoreMeetError`. `'internal'`: anything else. */
export type AutoBuildErrorSource = 'autobuild' | 'score' | 'internal';

/**
 * `code` and `subject` are copied from the error, because an `Error` keeps only its name and message across `postMessage`.
 * `'internal'` errors carry the code `'internal'` (the worker failed, or the message was malformed) and no subject.
 */
export interface AutoBuildErrorMessage {
  readonly kind: 'auto-build-error';
  readonly id: number;
  readonly source: AutoBuildErrorSource;
  readonly code: string;
  readonly subject: string | null;
  readonly message: string;
}

export type AutoBuildWorkerResponse = AutoBuildProgress | AutoBuildDone | AutoBuildErrorMessage;
