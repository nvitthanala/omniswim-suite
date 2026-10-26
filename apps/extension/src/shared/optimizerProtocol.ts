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

export type OptimizerRequest = SolveLpRequest;

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

export interface ErrorResponse {
  readonly kind: 'error';
  readonly id?: number;
  readonly error: string;
}

export type OptimizerResponse = SolvedResponse | ErrorResponse;
