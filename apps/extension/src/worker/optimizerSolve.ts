/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The solves of optimizer.worker (D5 section 11), over a loaded HiGHS. `optimizer.ts` owns the worker scope and the wasm load; this
 * module owns what a request means, so Node tests can run it against a real HiGHS with no worker.
 *
 * - `solve-lp`: the legacy one-shot `highs.solve`. Unchanged since D3: same call, same reply, same field order.
 * - `solve-mip`: the Model API (`createModel`, `readModel`, `options.set`, `run`), which, unlike `highs.solve`, reports the MIP dual
 *   bound and says whether a time-limited run holds a feasible solution. `columns` holds values only for the status `'Optimal'`
 *   (the rule of `optimizerResult.ts`). A time-limited run with a feasible primal solution (`primal_solution_status` 2) also
 *   returns an `incumbent`: a lower bound and a seed, never an optimum.
 *
 * This module imports only types from `highs`, so it adds no runtime dependency to the bundle.
 */
import type { Highs, HighsOptions } from 'highs';
import type { SolveLpRequest, SolveMipRequest, SolvedMipResponse, SolvedResponse } from '../shared/optimizerProtocol';
import { optimalColumns } from './optimizerResult';

const OPTIMAL = 7;
const TIME_LIMIT = 13;
/** HiGHS `primal_solution_status`: 2 is a feasible solution. */
const FEASIBLE_SOLUTION = 2;

/** `HighsModelStatus` names, as `highs.solve` reports them, by the numeric model status of the Model API. */
const STATUS: Readonly<Record<number, string>> = {
  0: 'Not Set',
  1: 'Load error',
  2: 'Model error',
  3: 'Presolve error',
  4: 'Solve error',
  5: 'Postsolve error',
  6: 'Empty',
  [OPTIMAL]: 'Optimal',
  8: 'Infeasible',
  9: 'Primal infeasible or unbounded',
  10: 'Unbounded',
  11: 'Bound on objective reached',
  12: 'Target for objective reached',
  [TIME_LIMIT]: 'Time limit reached',
  14: 'Iteration limit reached',
  15: 'Unknown',
  16: 'Solution-count limit reached',
  17: 'Interrupted',
};

/** The status text of a numeric model status. A code with no entry is named as such, never read as an optimum. */
export function statusText(code: number): string {
  return STATUS[code] ?? `HiGHS model status ${code}`;
}

export function isSolveLpRequest(m: unknown): m is SolveLpRequest {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return r.kind === 'solve-lp' && typeof r.id === 'number' && typeof r.lp === 'string';
}

const isOptionValue = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

export function isSolveMipRequest(m: unknown): m is SolveMipRequest {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.kind !== 'solve-mip' || typeof r.id !== 'number' || typeof r.lp !== 'string') return false;
  if (r.options === undefined) return true;
  return typeof r.options === 'object' && r.options !== null && !Array.isArray(r.options) && Object.values(r.options).every(isOptionValue);
}

export function solveLpOn(highs: Highs, request: SolveLpRequest, loadMs: number): SolvedResponse {
  const t0 = performance.now();
  const solution = highs.solve(request.lp, { output_flag: false, ...(request.options as HighsOptions | undefined) });
  const solveMs = performance.now() - t0;
  const columns = optimalColumns(solution.Status, () => solution.Columns as never);
  return { kind: 'solved', id: request.id, status: solution.Status, objective: solution.ObjectiveValue, columns, loadMs, solveMs };
}

/** An info item, or `null` when HiGHS does not report it for this solve (`info.get` throws then). */
function info(model: { readonly info: { get(name: string): number | bigint } }, name: string): number | null {
  try {
    return Number(model.info.get(name));
  } catch {
    return null;
  }
}

export function solveMipOn(highs: Highs, request: SolveMipRequest, loadMs: number): SolvedMipResponse {
  const model = highs.createModel();
  try {
    model.readModel({ format: 'lp', data: request.lp });
    model.options.set({ output_flag: false, ...request.options });
    const t0 = performance.now();
    model.run();
    const solveMs = performance.now() - t0;
    const code = model.getModelStatus();
    const status = statusText(code);
    const dual = info(model, 'mip_dual_bound');
    const dualBound = dual !== null && Number.isFinite(dual) ? dual : null;
    const seconds = model.getRunTime();
    const read = (): Record<string, number> => {
      const columns: Record<string, number> = {};
      model.getSolution().colValue.forEach((v, i) => {
        columns[model.getColName(i)] = v;
      });
      return columns;
    };
    if (code === OPTIMAL) {
      return { kind: 'solved-mip', id: request.id, status, objective: model.getObjectiveValue(), columns: read(), incumbent: null, dualBound, seconds, loadMs, solveMs };
    }
    const incumbent = code === TIME_LIMIT && info(model, 'primal_solution_status') === FEASIBLE_SOLUTION ? { objective: model.getObjectiveValue(), columns: read() } : null;
    return { kind: 'solved-mip', id: request.id, status, objective: 0, columns: {}, incumbent, dualBound, seconds, loadMs, solveMs };
  } finally {
    model.dispose();
  }
}
