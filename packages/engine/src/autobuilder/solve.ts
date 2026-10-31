/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The solve sequence of D5 amendment 1, 6.3, for slice A1. `timeLimitSeconds` is wall time, measured with the request's
 * clock. The restricted MIP runs first: any Optimal result or verified incumbent is a real lineup, so a lineup exists before
 * the slow stages start. Then the relaxed MIP (a valid upper bound), at most `refineRounds` refinement rounds when the
 * estimate fits, and the tie-break that minimizes changes when time is left. Every result is checked against its own columns
 * before it is used. Only an `'Optimal'` status, or a verified incumbent, yields columns. When the last solve ends at its time
 * limit, the local search of D5 section 10 (slice A5) tries to improve on the verified incumbent, or on the current state when the request asks for it and no incumbent exists.
 */
import { buildLp, makeScale } from './lp';
import type { LpBuild, Scale, Selection } from './lp';
import { choiceOfChosen, choiceOfCurrent, localSearch, rowsHold } from './localSearch';
import { scaledTarget } from './mode';
import type { Results } from '../model/results';
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
/** The local search stops at a local optimum or after this long, or when the budget is gone (D5 10), whichever comes first (milliseconds). */
export const LOCAL_SEARCH_MAX_MS = 2000;
/** The status text of the local search record in `proof.solves`. */
export const LOCAL_OPTIMUM = 'Local optimum';
export const SEARCH_BUDGET = 'Budget reached';

export interface SolveRecord {
  readonly stage: 'relaxed' | 'restricted' | 'tie-break' | 'local-search';
  readonly status: string;
  readonly ms: number | null;
  readonly rows: number;
  readonly cols: number;
}

export type SolveOutcome =
  | {
      readonly kind: 'found';
      readonly selection: Selection;
      readonly method: 'mip' | 'mip-incumbent' | 'local-search';
      /** The scale of the solve that found the lineup, and what the mode ranks (`LpBuild.pointsOf`, scaled) and its metric (`valueOf`): what the gate checks. */
      readonly scale: Scale;
      readonly bestScaled: number;
      readonly valueScaled: number;
      /**
       * Best and bound on one common scale, for the proof. `upper` is `null` when no bound is known. The scale is `D` for the maximizing
       * modes. Goal seek ranks the negative change count, a whole number at any scale, so its `D` is 1.
       */
      readonly bound: { readonly D: number; readonly best: number; readonly upper: number | null };
    }
  /** No lineup meets every row. `proven`: the relaxed MIP is infeasible too, so no lineup of the whole space exists (goal seek: the target is out of reach). */
  | { readonly kind: 'infeasible'; readonly scale: Scale; readonly proven: boolean }
  | { readonly kind: 'non_result'; readonly upperScaled: number | null; readonly scale: Scale };

const sorted = (ns: Iterable<number>): number[] => [...new Set(ns)].sort((a, b) => a - b);

/** `D` for the evaluations done so far, plus the tie groups of the current results (D5 5.2). */
/** The sizes (2 or more) of the groups of rows that share a place, over every event of the results (D5 5.2). */
export function tieGroupSizes(results: Results): number[] {
  const sizes: number[] = [];
  for (const e of results.events) {
    const byPlace = new Map<number, number>();
    for (const r of e.rows) if (r.place !== null) byPlace.set(r.place, (byPlace.get(r.place) ?? 0) + 1);
    sizes.push(...[...byPlace.values()].filter((n) => n >= 2));
  }
  return sizes;
}

export function scaleFor(space: Space): Scale {
  const sizes: number[] = tieGroupSizes(space.problem.currentResults);
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
  /** What the mode ranks, scaled by `rankD`. */
  readonly points: number;
  /** The scale of `points`: `scale.D`, or 1 in goal seek (the negative change count). */
  readonly rankD: number;
  /** The metric of the lineup, scaled by `scale.D`. */
  readonly value: number;
  readonly rank: 0 | 1 | 2 | 3;
  readonly method: 'mip' | 'mip-incumbent' | 'local-search';
  /** An incumbent whose values satisfy every row of the restricted LP (D5 10). Only a verified incumbent seeds the local search. */
  readonly verified?: boolean;
}

interface Bound {
  readonly points: number;
  readonly D: number;
}

const real = (points: number, D: number): number => points / D;

/** `points` (scaled by `from`) on the scale `to`. Scales only grow by whole multiples, so this is exact. */
export function rescale(points: number, from: number, to: number): number {
  const x = (points * to) / from;
  if (Math.abs(x - Math.round(x)) >= 1e-6) autoBuildFail('model_mismatch', `${points} at scale ${from} is not whole at scale ${to}`);
  return Math.round(x);
}

/**
 * The points, on the final scale, that a local search lineup must exceed to replace what is found: the best found so far when there is
 * one, rescaled whenever its scale is not the final one (a refinement round can change `D`), else the points of the seed.
 */
export function pointsToBeat(best: { readonly points: number; readonly scale: { readonly D: number } } | null, seedPoints: number, finalD: number): number {
  return best === null ? seedPoints : rescale(best.points, best.scale.D, finalD);
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
    const a = real(candidate.points, candidate.rankD);
    const b = real(this.best.points, this.best.rankD);
    if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && candidate.rank > this.best.rank)) this.best = candidate;
  }

  bound(points: number, D: number): void {
    if (this.upper === null || real(points, D) < real(this.upper.points, this.upper.D)) this.upper = { points, D };
  }

  proven(): boolean {
    const { best, upper } = this;
    return best !== null && upper !== null && real(best.points, best.rankD) >= real(upper.points, upper.D) - 1e-9;
  }
}

/** What the relaxed stage learned: the active outside terms to refine on, or that the MIP is infeasible. */
interface RelaxedStage {
  readonly infeasible: boolean;
  /** The relaxed solution, when an outside term (`o` or `oR`) is active in it. */
  readonly active: Selection | null;
}

/** One `solveAutoBuild` call: the stages of D5 amendment 1, 6.3, over one shared budget and one ledger. */
class Sequence {
  private readonly timer: Timer;
  private readonly ledger = new Ledger();
  private scale: Scale;
  /** Goal seek (D5 4.7): the MIP minimizes changes, so the ledger ranks the negative change count. */
  private readonly goal: boolean;

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
    this.goal = space.problem.mode.target !== null;
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

  /** Goal seek ranks the negative change count, whole at any scale; every other mode ranks its metric at the scale `D`. */
  private rankD(scale: Scale): number {
    return this.goal ? 1 : scale.D;
  }

  /** Goal seek: a lineup the MIP calls real must reach the target. A missed target means the rows and the metric disagree. */
  private checkTarget(build: LpBuild, columns: Readonly<Record<string, number>>, scale: Scale, what: string): void {
    const target = this.space.problem.mode.target;
    if (target === null) return;
    const need = scaledTarget(target, scale.D);
    const value = build.valueOf(columns);
    if (value < need) autoBuildFail('model_mismatch', `${what}: the metric ${value} is below the target ${need} at scale ${scale.D}`);
  }

  /** A lineup from one solve's columns, with what the mode ranks and the metric. */
  private foundOf(build: LpBuild, columns: Readonly<Record<string, number>>, scale: Scale, extra: Pick<Found, 'rank' | 'method'> & { readonly verified?: boolean }): Found {
    return { selection: build.select(columns), scale, points: build.pointsOf(columns), rankD: this.rankD(scale), value: build.valueOf(columns), ...extra };
  }

  /**
   * Stage 1, the safety net: the current column is in the space, so an Optimal result or a verified incumbent is a real lineup. In goal
   * seek the current lineup misses the target, so the restricted MIP can be infeasible: that is an answer, and the relaxed MIP still runs.
   */
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
      this.checkTarget(build, result.columns, scale, 'restricted solve');
      this.ledger.consider(this.foundOf(build, result.columns, scale, { rank: 2, method: 'mip' }));
    } else if (result.incumbent !== null) {
      checkObjective(build, result.incumbent, 'restricted incumbent');
      const verified = rowsHold(build.model, result.incumbent.columns);
      if (verified) this.checkTarget(build, result.incumbent.columns, scale, 'restricted incumbent');
      this.ledger.consider(this.foundOf(build, result.incumbent.columns, scale, { rank: 1, method: 'mip-incumbent', verified }));
    }
    return 'ok';
  }

  /** Stage 2: a valid upper bound, and a proven lineup when no outside term is active. `restrictedInfeasible`: the restricted MIP had no solution. */
  private async relaxed(restrictedInfeasible: boolean): Promise<RelaxedStage> {
    const { scale, ledger } = this;
    const build = buildLp(this.space, scale, { relaxed: true });
    const result = await this.run('relaxed', build, this.timer.left());
    if (result === null) return { infeasible: false, active: null };
    if (result.status === 'Infeasible') {
      if (ledger.best !== null) autoBuildFail('model_mismatch', 'the relaxed MIP is infeasible, but the restricted MIP found a lineup');
      return { infeasible: true, active: null };
    }
    if (result.status !== 'Optimal') {
      const dual = dualOf(result);
      if (dual !== null) ledger.bound(dual, this.rankD(scale));
      return { infeasible: false, active: null };
    }
    ledger.bound(checkObjective(build, result, 'relaxed solve'), this.rankD(scale));
    const selection = build.select(result.columns);
    if (selection.outside.size > 0 || selection.relayOutside.size > 0) return { infeasible: false, active: selection };
    if (restrictedInfeasible) autoBuildFail('model_mismatch', 'the relaxed MIP found a lineup with no outside term, but the restricted MIP is infeasible');
    this.checkTarget(build, result.columns, scale, 'relaxed solve');
    ledger.consider(this.foundOf(build, result.columns, scale, { rank: 3, method: 'mip' }));
    return { infeasible: false, active: null };
  }

  /** Stage 3: grow the candidate sets, only when the estimate fits. Returns whether a round ran. */
  private refine(active: Selection): boolean {
    const limits = { kMax: this.limits.maxCandidatesPerEvent, tMax: this.limits.maxRelaySquadsPerEvent };
    const plan = this.space.planGrowth(active.outside, active.relayOutside, limits, REFINE_PER_EVENT);
    if (plan.empty) return false;
    const perColumn = this.space.msPerColumn();
    if (perColumn !== null && plan.newColumns * perColumn + 1000 >= this.timer.left()) return false;
    if (this.timer.left() < MIN_ALLOTMENT_MS) return false;
    this.space.applyGrowth(plan);
    this.scale = scaleFor(this.space);
    return true;
  }

  /**
   * Stage 4: fewest changes among the lineups with these points. A timeout keeps the lineup from before it. In goal seek it is the
   * other way round: the best metric among the lineups with no more changes than the best found.
   */
  private async tieBreak(best: Found, finalScale: Scale): Promise<Found> {
    if (this.timer.left() < TIE_BREAK_MIN_MS) return best;
    const floor = rescale(best.points, best.rankD, this.rankD(finalScale));
    const build = buildLp(this.space, finalScale, { relaxed: false, tieBreak: { minPoints: floor } });
    const result = await this.run('tie-break', build, this.timer.left());
    if (result === null) return best;
    if (result.status === 'Infeasible') autoBuildFail('model_mismatch', `the tie-break found no lineup with the ${floor} points of the previous solve`);
    if (result.status !== 'Optimal') return best;
    checkObjective(build, result, 'tie-break solve');
    this.checkTarget(build, result.columns, finalScale, 'tie-break solve');
    const found = this.foundOf(build, result.columns, finalScale, { rank: best.rank, method: best.method });
    if (found.points < floor) autoBuildFail('model_mismatch', 'the tie-break solution has fewer points than the floor it was given');
    return found;
  }

  /**
   * D5 10. Runs only when the last MIP solve ended at its time limit, and not after an Optimal restricted or relaxed result (which is
   * the best over these columns already). Seed: the verified incumbent, else the current state if it
   * satisfies every row; with neither, nothing runs. It returns a lineup only when the search beat both the seed and `best`: then the method is
   * `'local-search'`. It never raises the proof: `proofOf` caps the status below `proven_optimal` for this method.
   */
  private fallback(best: Found | null, finalScale: Scale): Found | null {
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.status !== 'Time limit reached') return best;
    if (best !== null && best.rank !== 1) return best;
    const allotment = Math.min(LOCAL_SEARCH_MAX_MS, this.timer.left());
    if (allotment < MIN_ALLOTMENT_MS) return best;
    // The clock starts before the LP is rebuilt: the rebuild is part of the allotment, so the stage ends within min(2 s, left).
    const t0 = this.clock?.();
    const build = buildLp(this.space, finalScale, { relaxed: false });
    const { model } = build;
    const fromIncumbent = best !== null && best.verified === true ? choiceOfChosen(model, best.selection.chosen) : null;
    const seeds = [fromIncumbent, choiceOfCurrent(model)];
    const budget = this.clock === undefined || t0 === undefined ? {} : { clock: this.clock, stopAt: t0 + allotment };
    let seeded: ReturnType<typeof localSearch> = null;
    for (const seed of seeds) {
      if (seed === null) continue;
      seeded = localSearch(model, seed, budget);
      if (seeded !== null) break;
    }
    if (seeded === null) return best;
    const ms = this.clock !== undefined && t0 !== undefined ? this.clock() - t0 : null;
    this.records.push({ stage: 'local-search', status: seeded.stop === 'budget' ? SEARCH_BUDGET : LOCAL_OPTIMUM, ms, rows: build.rows, cols: build.cols });
    const points = build.pointsOf(seeded.columns);
    if (points !== seeded.objective) autoBuildFail('model_mismatch', `the local search objective ${seeded.objective} differs from the LP points ${points}`);
    const finalD = this.rankD(finalScale);
    const beaten = pointsToBeat(best === null ? null : { points: best.points, scale: { D: best.rankD } }, seeded.startObjective, finalD);
    if (seeded.moves === 0 || points <= beaten) return best;
    this.checkTarget(build, seeded.columns, finalScale, 'local search');
    return this.foundOf(build, seeded.columns, finalScale, { rank: 0, method: 'local-search' });
  }

  async go(): Promise<SolveOutcome> {
    const { ledger } = this;
    let restrictedInfeasible = false;
    for (let round = 0; ; round++) {
      restrictedInfeasible = (await this.restricted()) === 'infeasible';
      // Without a goal the current lineup is a witness for the restricted MIP; with one, no lineup may reach the target.
      if (restrictedInfeasible && !this.goal) return { kind: 'infeasible', scale: this.scale, proven: false };
      const stage = await this.relaxed(restrictedInfeasible);
      if (stage.infeasible) return { kind: 'infeasible', scale: this.scale, proven: true };
      if (ledger.proven() || round >= this.limits.refineRounds || stage.active === null || !this.refine(stage.active)) break;
    }
    if (restrictedInfeasible && ledger.best === null) return { kind: 'infeasible', scale: scaleFor(this.space), proven: false };
    const finalScale = scaleFor(this.space);
    const finalD = this.rankD(finalScale);
    const { upper } = ledger;
    const bestSoFar = ledger.best === null ? null : await this.tieBreak(ledger.best, finalScale);
    const chosen = this.fallback(bestSoFar, finalScale);
    if (chosen === null) {
      return { kind: 'non_result', upperScaled: upper === null ? null : rescale(upper.points, upper.D, finalD), scale: finalScale };
    }
    const bestAtFinal = rescale(chosen.points, chosen.rankD, finalD);
    const upperAtFinal = upper === null ? null : rescale(upper.points, upper.D, finalD);
    if (upperAtFinal !== null && bestAtFinal > upperAtFinal) {
      autoBuildFail('model_mismatch', `the upper bound ${upperAtFinal} is below the lineup found, ${bestAtFinal}`);
    }
    return {
      kind: 'found',
      selection: chosen.selection,
      method: chosen.method,
      scale: chosen.scale,
      bestScaled: chosen.points,
      valueScaled: chosen.value,
      bound: { D: finalD, best: bestAtFinal, upper: upperAtFinal },
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
