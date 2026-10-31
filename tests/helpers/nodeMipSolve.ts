/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A `MipSolve` for Node tests: HiGHS through its Model API (plans/2026-10-25/D5-AUTOBUILDER.md, section 11), which, unlike
 * `highs.solve`, reports the MIP dual bound and an incumbent at a time limit. Checked on highs 1.15.4:
 * `createModel`, `readModel({ format: 'lp' })`, `options.set`, `run`, `info.get`, `getSolution().colValue`, `getColName`,
 * `dispose`. The status strings are those of `highs.solve`, so the engine reads one vocabulary.
 */
import loadHighs from 'highs';
import type { MipSolution, MipSolve } from '@omniswim/engine';

const OPTIMAL = 7;
const INFEASIBLE = 8;
const TIME_LIMIT = 13;
const FEASIBLE_SOLUTION = 2;

let highsPromise: ReturnType<typeof loadHighs> | undefined;

const STATUS: Readonly<Record<number, string>> = {
  [OPTIMAL]: 'Optimal',
  [INFEASIBLE]: 'Infeasible',
  9: 'Primal infeasible or unbounded',
  10: 'Unbounded',
  [TIME_LIMIT]: 'Time limit reached',
  14: 'Iteration limit reached',
};

export interface CountingMipSolve extends MipSolve {
  /** The LP texts the solver received, in call order. */
  readonly texts: string[];
  calls: number;
}

/** An info item, or `null` when HiGHS does not report it for this solve (`info.get` throws then). */
function info(model: { readonly info: { get(name: string): number | bigint } }, name: string): number | null {
  try {
    const v = model.info.get(name);
    return Number(v);
  } catch {
    return null;
  }
}

export function nodeMipSolve(): CountingMipSolve {
  const solve = (async (lp, options) => {
    solve.calls += 1;
    solve.texts.push(lp);
    highsPromise ??= loadHighs({});
    const highs = await highsPromise;
    const model = highs.createModel();
    try {
      model.readModel({ format: 'lp', data: lp });
      model.options.set(options as Record<string, string | number | boolean>);
      model.run();
      const code = model.getModelStatus();
      const status = STATUS[code] ?? `HiGHS model status ${code}`;
      const dual = info(model, 'mip_dual_bound');
      const dualBound = dual !== null && Number.isFinite(dual) ? dual : null;
      const seconds = model.getRunTime();
      const read = (): Record<string, number> => {
        const { colValue } = model.getSolution();
        const columns: Record<string, number> = {};
        colValue.forEach((v, i) => {
          columns[model.getColName(i)] = v;
        });
        return columns;
      };
      if (code === OPTIMAL) {
        return { status, objective: model.getObjectiveValue(), columns: read(), incumbent: null, dualBound, seconds } satisfies MipSolution;
      }
      // A time limit with a feasible primal solution gives an incumbent: a lower bound, never an optimum.
      const incumbent =
        code === TIME_LIMIT && info(model, 'primal_solution_status') === FEASIBLE_SOLUTION
          ? { objective: model.getObjectiveValue(), columns: read() }
          : null;
      return { status, objective: 0, columns: {}, incumbent, dualBound, seconds } satisfies MipSolution;
    } finally {
      model.dispose();
    }
  }) as CountingMipSolve;
  solve.calls = 0;
  (solve as { texts: string[] }).texts = [];
  return solve;
}
