/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The solve sequence of D5 amendment 1, 6.3, for slice A1. `timeLimitSeconds` is wall time, measured with the request's
 * clock. The restricted MIP runs first: any Optimal result or verified incumbent is a real lineup, so a lineup exists before
 * the slow stages start. Then the relaxed MIP (a valid upper bound), at most `refineRounds` refinement rounds when the
 * estimate fits, and the tie-break that minimizes changes when time is left. Every result is checked against its own columns
 * before it is used. Only an `'Optimal'` status, or a verified incumbent, yields columns.
 */
import { buildLp, makeScale } from './lp';
import type { LpBuild, Scale, Selection } from './lp';
import type { Space } from './space';
import { autoBuildFail } from './types';
import type { AutoBuildLimits, MipSolution, MipSolve } from './types';

/** Exact optimum: a zero relative gap, and an absolute gap under one unit of a whole-number objective (rosterSuggest.ts:102). */
const SOLVER_OPTIONS: Readonly<Record<string, string | number | boolean>> = { mip_rel_gap: 0, mip_abs_gap: 0.5, random_seed: 0, output_flag: false };

/** Time kept for the gate, in milliseconds (D5 amendment 1, 6.3). */
export const GATE_RESERVE_MS = 1000;
/** A stage with a smaller allotment is skipped (milliseconds). */
export const MIN_ALLOTMENT_MS = 200;
/** HiGHS overshoots its own limit, so a solve is given this share of its allotment. */
export const SOLVE_SHARE = 0.75;
/** The tie-break runs only with at least this much time left (milliseconds). */
export const TIE_BREAK_MIN_MS = 2000;
/** A refined event gains at most this many outside swimmers per round. */
export const REFINE_PER_EVENT = 2;
/** The share of `left()` the restricted solve may take. */
export const RESTRICTED_SHARE = 0.5;

export interface SolveRecord {
  readonly stage: 'relaxed' | 'restricted' | 'tie-break';
  readonly status: string;
  readonly ms: number | null;
  readonly rows: number;
  readonly cols: number;
}

export type SolveOutcome =
  | {
      readonly kind: 'found';
      readonly selection: Selection;
      readonly method: 'mip' | 'mip-incumbent';
      /** The scale and own points (scaled) of the lineup found: what the gate checks. */
      readonly scale: Scale;
      readonly bestScaled: number;
      /** Best and bound on one common scale, for the proof. `upper` is `null` when no bound is known. */
      readonly bound: { readonly D: number; readonly best: number; readonly upper: number | null };
    }
  | { readonly kind: 'infeasible'; readonly scale: Scale }
  | { readonly kind: 'non_result'; readonly upperScaled: number | null; readonly scale: Scale };

const sorted = (ns: Iterable<number>): number[] => [...new Set(ns)].sort((a, b) => a - b);

/** `D` for the evaluations done so far, plus the tie groups of the current results (D5 5.2). */
export function scaleFor(space: Space): Scale {
  const sizes: number[] = [];
  for (const e of space.problem.currentResults.events) {
    const byPlace = new Map<number, number>();
    for (const r of e.rows) if (r.place !== null) byPlace.set(r.place, (byPlace.get(r.place) ?? 0) + 1);
    sizes.push(...[...byPlace.values()].filter((n) => n >= 2));
  }
  for (const es of space.events) {
    for (const c of es.columns) sizes.push(...c.eval.tieSizes);
    for (const p of es.pairs.values()) if (p.singleton !== null) sizes.push(...p.singleton.tieSizes);
  }
  return makeScale(space.problem.support, sorted(sizes));
}

/** The wall-time budget. With no clock it counts only the seconds the solver reports (evaluation is not counted). */
class Timer {
  private reported = 0;
  private readonly deadline: number;

  constructor(
    totalSeconds: number,
    private readonly clock: (() => number) | undefined,
    started: number | undefined
  ) {
    this.deadline = (started ?? 0) + totalSeconds * 1000;
  }

  now(): number {
    return this.clock === undefined ? this.reported : this.clock();
  }

  /** Milliseconds that stages may still use: the deadline less the gate reserve. */
  left(): number {
    return this.deadline - GATE_RESERVE_MS - this.now();
  }

  charge(ms: number): void {
    if (this.clock === undefined) this.reported += ms;
  }
}

/** The solver objective must equal the objective recomputed from the solver's own columns (D5 8.3.1). */
function checkObjective(build: LpBuild, result: { readonly objective: number; readonly columns: Readonly<Record<string, number>> }, what: string): number {
  const stated = Math.round(result.objective);
  const recomputed = build.objectiveOf(result.columns);
  if (Math.abs(result.objective - stated) > 1e-6 || recomputed !== stated) {
    return autoBuildFail('model_mismatch', `${what}: the solver reports ${result.objective}, its columns give ${recomputed}`);
  }
  return stated;
}

const dualOf = (result: MipSolution): number | null => (result.dualBound !== null && Number.isFinite(result.dualBound) ? Math.round(result.dualBound) : null);

/** A real lineup found so far. `rank` orders equal points: the proven relaxed solution, then restricted Optimal, then an incumbent. */
interface Found {
  readonly selection: Selection;
  readonly scale: Scale;
  readonly points: number;
  readonly rank: 1 | 2 | 3;
  readonly method: 'mip' | 'mip-incumbent';
}

interface Bound {
  readonly points: number;
  readonly D: number;
}

const real = (points: number, D: number): number => points / D;

/** `points` (scaled by `from`) on the scale `to`. Scales only grow by whole multiples, so this is exact. */
function rescale(points: number, from: number, to: number): number {
  const x = (points * to) / from;
  if (Math.abs(x - Math.round(x)) >= 1e-6) autoBuildFail('model_mismatch', `${points} at scale ${from} is not whole at scale ${to}`);
  return Math.round(x);
}

/** The best lineup and the best bound so far. */
class Ledger {
  best: Found | null = null;
  upper: Bound | null = null;

  consider(candidate: Found): void {
    if (this.best === null) {
      this.best = candidate;
      return;
    }
    const a = real(candidate.points, candidate.scale.D);
    const b = real(this.best.points, this.best.scale.D);
    if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && candidate.rank > this.best.rank)) this.best = candidate;
  }

  bound(points: number, D: number): void {
    if (this.upper === null || real(points, D) < real(this.upper.points, this.upper.D)) this.upper = { points, D };
  }

  proven(): boolean {
    const { best, upper } = this;
    return best !== null && upper !== null && real(best.points, best.scale.D) >= real(upper.points, upper.D) - 1e-9;
  }
}

/** What the relaxed stage learned: an outside set to refine on, or that the MIP is infeasible. */
interface RelaxedStage {
  readonly infeasible: boolean;
  readonly outside: ReadonlyMap<string, readonly string[]> | null;
}

/** One `solveAutoBuild` call: the stages of D5 amendment 1, 6.3, over one shared budget and one ledger. */
class Sequence {
  private readonly timer: Timer;
  private readonly ledger = new Ledger();
  private scale: Scale;

  constructor(
    private readonly space: Space,
    private readonly limits: AutoBuildLimits,
    private readonly solve: MipSolve,
    private readonly clock: (() => number) | undefined,
    started: number | undefined,
    private readonly records: SolveRecord[]
  ) {
    this.timer = new Timer(limits.timeLimitSeconds, clock, started);
    this.scale = scaleFor(space);
  }

  /** Run one LP. An allotment under 200 ms skips the stage: nothing runs and nothing is recorded. */
  private async run(stage: SolveRecord['stage'], build: LpBuild, allotMs: number): Promise<MipSolution | null> {
    if (allotMs < MIN_ALLOTMENT_MS) return null;
    const t0 = this.clock?.();
    const result = await this.solve(build.text, { ...SOLVER_OPTIONS, time_limit: (SOLVE_SHARE * allotMs) / 1000 });
    const seconds = this.clock !== undefined && t0 !== undefined ? (this.clock() - t0) / 1000 : (result.seconds ?? null);
    if (seconds !== null) this.timer.charge(seconds * 1000);
    this.records.push({ stage, status: result.status, ms: seconds === null ? null : seconds * 1000, rows: build.rows, cols: build.cols });
    return result;
  }

  /** Stage 1, the safety net: the current column is in the space, so an Optimal result or a verified incumbent is a real lineup. */
  private async restricted(): Promise<'infeasible' | 'ok'> {
    const { scale } = this;
    const build = buildLp(this.space, scale, { relaxed: false });
    const result = await this.run('restricted', build, RESTRICTED_SHARE * this.timer.left());
    if (result === null) return 'ok';
    if (result.status === 'Infeasible') {
      if (this.ledger.best !== null) autoBuildFail('model_mismatch', 'the restricted MIP is infeasible after an earlier round found a lineup');
      return 'infeasible';
    }
    if (result.status === 'Optimal') {
      checkObjective(build, result, 'restricted solve');
      this.ledger.consider({ selection: build.select(result.columns), scale, points: build.pointsOf(result.columns), rank: 2, method: 'mip' });
    } else if (result.incumbent !== null) {
      checkObjective(build, result.incumbent, 'restricted incumbent');
      this.ledger.consider({ selection: build.select(result.incumbent.columns), scale, points: build.pointsOf(result.incumbent.columns), rank: 1, method: 'mip-incumbent' });
    }
    return 'ok';
  }

  /** Stage 2: a valid upper bound, and a proven lineup when no outside term is active. */
  private async relaxed(): Promise<RelaxedStage> {
    const { scale, ledger } = this;
    const build = buildLp(this.space, scale, { relaxed: true });
    const result = await this.run('relaxed', build, this.timer.left());
    if (result === null) return { infeasible: false, outside: null };
    if (result.status === 'Infeasible') {
      if (ledger.best !== null) autoBuildFail('model_mismatch', 'the relaxed MIP is infeasible, but the restricted MIP found a lineup');
      return { infeasible: true, outside: null };
    }
    if (result.status !== 'Optimal') {
      const dual = dualOf(result);
      if (dual !== null) ledger.bound(dual, scale.D);
      return { infeasible: false, outside: null };
    }
    ledger.bound(checkObjective(build, result, 'relaxed solve'), scale.D);
    const selection = build.select(result.columns);
    if (selection.outside.size > 0) return { infeasible: false, outside: selection.outside };
    ledger.consider({ selection, scale, points: build.pointsOf(result.columns), rank: 3, method: 'mip' });
    return { infeasible: false, outside: null };
  }

  /** Stage 3: grow the candidate sets, only when the estimate fits. Returns whether a round ran. */
  private refine(outside: ReadonlyMap<string, readonly string[]>): boolean {
    const plan = this.space.planGrowth(outside, this.limits.maxCandidatesPerEvent, REFINE_PER_EVENT);
    if (plan.next.size === 0) return false;
    const perColumn = this.space.msPerColumn();
    if (perColumn !== null && plan.newColumns * perColumn + 1000 >= this.timer.left()) return false;
    if (this.timer.left() < MIN_ALLOTMENT_MS) return false;
    this.space.applyGrowth(plan.next);
    this.scale = scaleFor(this.space);
    return true;
  }

  /** Stage 4: fewest changes among the lineups with these points. A timeout keeps the lineup from before it. */
  private async tieBreak(best: Found, finalScale: Scale): Promise<Found> {
    if (this.timer.left() < TIE_BREAK_MIN_MS) return best;
    const floor = rescale(best.points, best.scale.D, finalScale.D);
    const build = buildLp(this.space, finalScale, { relaxed: false, tieBreak: { minPoints: floor } });
    const result = await this.run('tie-break', build, this.timer.left());
    if (result === null) return best;
    if (result.status === 'Infeasible') autoBuildFail('model_mismatch', `the tie-break found no lineup with the ${floor} points of the previous solve`);
    if (result.status !== 'Optimal') return best;
    checkObjective(build, result, 'tie-break solve');
    const points = build.pointsOf(result.columns);
    if (points < floor) autoBuildFail('model_mismatch', 'the tie-break solution has fewer points than the floor it was given');
    return { selection: build.select(result.columns), scale: finalScale, points, rank: best.rank, method: best.method };
  }

  async go(): Promise<SolveOutcome> {
    const { ledger } = this;
    for (let round = 0; ; round++) {
      if ((await this.restricted()) === 'infeasible') return { kind: 'infeasible', scale: this.scale };
      const stage = await this.relaxed();
      if (stage.infeasible) return { kind: 'infeasible', scale: this.scale };
      if (ledger.proven() || round >= this.limits.refineRounds || stage.outside === null || !this.refine(stage.outside)) break;
    }
    const finalScale = scaleFor(this.space);
    const { best, upper } = ledger;
    if (best === null) {
      return { kind: 'non_result', upperScaled: upper === null ? null : rescale(upper.points, upper.D, finalScale.D), scale: finalScale };
    }
    const chosen = await this.tieBreak(best, finalScale);
    const bestAtFinal = rescale(chosen.points, chosen.scale.D, finalScale.D);
    const upperAtFinal = upper === null ? null : rescale(upper.points, upper.D, finalScale.D);
    if (upperAtFinal !== null && bestAtFinal > upperAtFinal) {
      autoBuildFail('model_mismatch', `the upper bound ${upperAtFinal} is below the lineup found, ${bestAtFinal}`);
    }
    return {
      kind: 'found',
      selection: chosen.selection,
      method: chosen.method,
      scale: chosen.scale,
      bestScaled: chosen.points,
      bound: { D: finalScale.D, best: bestAtFinal, upper: upperAtFinal },
    };
  }
}

export function solveAutoBuild(
  space: Space,
  limits: AutoBuildLimits,
  solve: MipSolve,
  clock: (() => number) | undefined,
  started: number | undefined,
  records: SolveRecord[]
): Promise<SolveOutcome> {
  return new Sequence(space, limits, solve, clock, started, records).go();
}
