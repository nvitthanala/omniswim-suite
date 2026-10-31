/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The messages between an extension page and optimizer.worker. This file imports nothing.
 */

/** The reply to any request type the worker does not implement. */
export const OPTIMIZER_UNAVAILABLE = 'optimizer not available: unsupported request type';

/** Solve a CPLEX-LP model with HiGHS. `options` are HiGHS option names and values. */
export interface SolveLpRequest {
  readonly kind: 'solve-lp';
  readonly id: number;
  readonly lp: string;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Solve a CPLEX-LP model with HiGHS through its Model API (D5 section 11), for the AutoBuilder's MIP. The reply is a
 * `solved-mip`. `options` are HiGHS option names and values; `time_limit` (seconds) is honored.
 */
export interface SolveMipRequest {
  readonly kind: 'solve-mip';
  readonly id: number;
  readonly lp: string;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

export type OptimizerRequest = SolveLpRequest | SolveMipRequest;

export interface SolvedResponse {
  readonly kind: 'solved';
  readonly id: number;
  /** HiGHS model status, for example "Optimal". "Time limit reached" is not a proven optimum. */
  readonly status: string;
  readonly objective: number;
  /** Primal value per column name. */
  readonly columns: Readonly<Record<string, number>>;
  /** Milliseconds to load the wasm and start HiGHS (first request only counts it; it is cached). */
  readonly loadMs: number;
  readonly solveMs: number;
}

/**
 * The reply to `solve-mip`: the engine's `MipSolution` plus `id`, `loadMs` and `solveMs`.
 * `columns` is `{}` unless `status` is `'Optimal'`. `objective` means something only then.
 */
export interface SolvedMipResponse {
  readonly kind: 'solved-mip';
  readonly id: number;
  /** HiGHS model status, for example "Optimal" or "Time limit reached". Only "Optimal" is a proven optimum. */
  readonly status: string;
  readonly objective: number;
  readonly columns: Readonly<Record<string, number>>;
  /**
   * Only when `status` is "Time limit reached" and HiGHS reports `primal_solution_status` 2 (a feasible solution). A lower bound and
   * a seed. Never an optimum.
   */
  readonly incumbent: { readonly objective: number; readonly columns: Readonly<Record<string, number>> } | null;
  /** HiGHS info `mip_dual_bound` after the run; `null` when it is not reported or not finite. */
  readonly dualBound: number | null;
  /** The solver's own run time in seconds (`getRunTime`). Diagnostic. */
  readonly seconds: number;
  /** Milliseconds to load the wasm and start HiGHS (first request only counts it; it is cached). */
  readonly loadMs: number;
  readonly solveMs: number;
}

export interface ErrorResponse {
  readonly kind: 'error';
  readonly id?: number;
  readonly error: string;
}

export type OptimizerResponse = SolvedResponse | SolvedMipResponse | ErrorResponse;
