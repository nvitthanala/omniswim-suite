/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The fallback of D5 section 10 (slice A5): a local search over the restricted MIP's own integer model. It runs only when the last
 * MIP solve ended at its time limit, and it never claims a proof. This module is pure and has no top-level side effect.
 *
 * State: one column per event with a choice. Every other variable follows (`Derived` in `lp.ts`): `x` and `g` from the columns,
 * `z` from the `x` of the swimmer, `d` at its largest allowed value, `v` at its least. A choice is feasible when every row of the
 * LP holds on that assignment, and its objective is the LP objective. So feasibility and points come from the MIP's rows and
 * coefficients, with no cap, load or diver logic here and no `scoreMeet` call per move. The caller re-scores the final lineup
 * through the gate (D5 8), which throws if the model and `scoreMeet` disagree.
 *
 * Moves, in fixed order, restarting from the first after each accepted move (first strict improvement):
 * - M1: replace one event's column. Events in `model.events` order, columns in index order.
 * - M2: move one swimmer from event e1 to event e2, where the columns `p1 \ {s}` and `p2 ∪ {s}` both exist (looked up by member set,
 *   the first column in index order when two share one). Events in `model.events` order, swimmers by id.
 * A move is accepted only if the new choice is feasible and its objective is strictly higher. The objective is a whole number, so the
 * search ends. It also ends at the budget, which is a clock reading checked at a fixed rate: with a fake clock the stop is exact.
 *
 * Determinism: no randomness, no Map or Set iteration order in a decision, a fixed move order. The same model, seed and budget give
 * the same result.
 */
import type { Column } from './space';
import type { Derived, LpModel, Row } from './lp';
import { autoBuildFail } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The clock is read once per this many evaluated moves. */
export const CLOCK_EVERY = 64;

/**
 * The most moves one search evaluates, with a clock or without. A clock is not always there (the engine reads none itself), so this
 * cap alone bounds the stage and keeps it deterministic. It is about 2 s of work: on the recorded config C a full climb to a local
 * optimum takes 189,956 evaluations in 4.4 s (about 43,000 a second, measured on the development machine), so 2 s is 86,000
 * evaluations, rounded down to 80,000. A capped stop is a 'budget' stop, like a clock stop.
 */
export const LOCAL_SEARCH_MAX_EVALUATIONS = 80_000;

/** `a`, the columns of an event by identity: squads for a relay column, members for an individual one. */
export function columnKey(column: Column): string {
  return column.squads === undefined ? column.members.join('\u0001') : column.squads.map((q) => q.key).join('\u0002');
}

const memberKey = (members: readonly string[]): string => members.join('\u0001');

/** The column index per event (in `model.events` order) of the chosen columns, or `null` when one is not in the model. */
export function choiceOfChosen(model: LpModel, chosen: ReadonlyMap<string, Column>): number[] | null {
  const out: number[] = [];
  for (const ev of model.events) {
    const column = chosen.get(ev.id);
    if (column === undefined) return null;
    const key = columnKey(column);
    const i = ev.columns.findIndex((c) => columnKey(c) === key);
    if (i < 0) return null;
    out.push(i);
  }
  return out;
}

/** The current column of every event, or `null` when an event has none. */
export function choiceOfCurrent(model: LpModel): number[] | null {
  const out: number[] = [];
  for (const ev of model.events) {
    const i = ev.columns.findIndex((c) => c.isCurrent);
    if (i < 0) return null;
    out.push(i);
  }
  return out;
}

/**
 * Whether a solver's values satisfy every row, every bound and every integrality of the model (D5 10: the incumbent is verified
 * on its values). A missing column is a failure, never a 0. `tolerance` is absolute.
 */
export function rowsHold(model: LpModel, columns: Readonly<Record<string, number>>, tolerance = 1e-6): boolean {
  const value = (name: string): number | null => {
    if (name === 'one') return 1;
    const v = columns[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const whole = (v: number): boolean => Math.abs(v - Math.round(v)) <= tolerance;
  for (const name of model.binaries) {
    const v = value(name);
    if (v === null || !whole(v) || Math.round(v) < 0 || Math.round(v) > 1) return false;
  }
  for (const g of model.generals) {
    const v = value(g.name);
    if (v === null || !whole(v) || Math.round(v) < 0 || Math.round(v) > g.ub) return false;
  }
  for (const row of model.rows) {
    let sum = 0;
    for (const [name, coef] of row.terms) {
      const v = value(name);
      if (v === null) return false;
      sum += coef * v;
    }
    if (row.op === '<=' ? sum > row.rhs + tolerance : row.op === '>=' ? sum < row.rhs - tolerance : Math.abs(sum - row.rhs) > tolerance) return false;
  }
  return true;
}

export interface SearchBudget {
  /** A monotonic clock in milliseconds. With none, the search runs to a local optimum. */
  readonly clock?: () => number;
  /** The clock reading at which the search stops. Needs `clock`. */
  readonly stopAt?: number;
  /** The most moves to evaluate. Default `LOCAL_SEARCH_MAX_EVALUATIONS`; it applies with or without a clock. */
  readonly maxEvaluations?: number;
}

export interface SearchResult {
  /** The column index per event, in `model.events` order. */
  readonly choice: readonly number[];
  /** The whole assignment of the final choice, by variable name (every variable of the LP, `one` included). */
  readonly columns: Readonly<Record<string, number>>;
  readonly startObjective: number;
  readonly objective: number;
  /** Accepted moves. */
  readonly moves: number;
  /** Moves tried (a feasibility and objective check each). */
  readonly evaluations: number;
  readonly stop: 'local-optimum' | 'budget';
}

/** `null` when the seed choice breaks a row: nothing runs then. */
export function localSearch(model: LpModel, seed: readonly number[], budget: SearchBudget = {}): SearchResult | null {
  const search = new Search(model, budget);
  if (!search.load(seed)) return null;
  return search.run();
}

/** The assignment of a choice, and whether it satisfies every row. Used by tests and by the caller to price a seed. */
export function assignmentOf(model: LpModel, choice: readonly number[]): { readonly feasible: boolean; readonly objective: number; readonly columns: Record<string, number> } {
  const search = new Search(model, {});
  const feasible = search.load(choice);
  return { feasible, objective: search.objective(), columns: search.assignment() };
}

class Search {
  private readonly ids = new Map<string, number>();
  private readonly names: string[] = [];
  private val: Float64Array;
  private act: Float64Array;
  private readonly rowOps: Row['op'][];
  private readonly rowRhs: Float64Array;
  /** Per variable: the rows it is in, with the coefficient of each occurrence. */
  private readonly inRows: { readonly row: number[]; readonly coef: number[] }[] = [];
  private readonly objCoef: Float64Array;
  private readonly yId: number[][];
  private readonly derivedId: number[];
  private readonly derived: readonly Derived[];
  /** Per event and column: the derived definitions to recompute after that `y` changes, in dependency order. */
  private readonly closure: number[][][];
  private readonly byMembers: Map<string, number>[];
  private violated = 0;
  private obj = 0;
  private choice: number[] = [];
  private undo: [number, number][] = [];
  private evaluations = 0;
  private moves = 0;
  private stopped = false;

  constructor(
    private readonly model: LpModel,
    private readonly budget: SearchBudget
  ) {
    const idOf = (name: string): number => {
      let id = this.ids.get(name);
      if (id === undefined) {
        id = this.names.length;
        this.ids.set(name, id);
        this.names.push(name);
        this.inRows.push({ row: [], coef: [] });
      }
      return id;
    };
    idOf('one');
    this.yId = model.events.map((ev) => ev.ys.map(idOf));
    this.derived = model.derived;
    this.derivedId = model.derived.map((d) => idOf(d.name));
    this.rowOps = model.rows.map((r) => r.op);
    this.rowRhs = Float64Array.from(model.rows.map((r) => r.rhs));
    model.rows.forEach((r, i) => {
      for (const [name, coef] of r.terms) {
        const id = idOf(name);
        (this.inRows[id] as { row: number[]; coef: number[] }).row.push(i);
        (this.inRows[id] as { row: number[]; coef: number[] }).coef.push(coef);
      }
    });
    const objective: [number, number][] = model.objective.map(([name, coef]) => [idOf(name), coef]);
    this.objCoef = new Float64Array(this.names.length);
    for (const [id, coef] of objective) this.objCoef[id] = (this.objCoef[id] as number) + coef;
    this.val = new Float64Array(this.names.length);
    this.act = new Float64Array(model.rows.length);
    // Every variable of the LP must be a column choice or follow from one. A relaxed model (outside pairs) has others: refuse it.
    const known = new Set<number>([0, ...this.yId.flat(), ...this.derivedId]);
    for (let id = 0; id < this.names.length; id++) {
      if (!known.has(id)) autoBuildFail('model_mismatch', `the local search cannot derive the variable ${this.names[id]} from the column choices`, this.names[id]);
    }
    // Dependents of each variable among the derived definitions, then the transitive closure of every column variable.
    const dependents: number[][] = this.names.map(() => []);
    this.derived.forEach((d, i) => {
      for (const name of inputsOf(d)) (dependents[idOf(name)] as number[]).push(i);
    });
    this.closure = this.yId.map((ys) =>
      ys.map((y) => {
        const seen = new Set<number>();
        const stack = [y];
        while (stack.length > 0) {
          for (const di of dependents[stack.pop() as number] as number[]) {
            if (seen.has(di)) continue;
            seen.add(di);
            stack.push(this.derivedId[di] as number);
          }
        }
        return [...seen].sort((a, b) => a - b);
      })
    );
    this.byMembers = model.events.map((ev) => {
      const m = new Map<string, number>();
      ev.columns.forEach((c, i) => {
        const k = memberKey(c.members);
        if (!m.has(k)) m.set(k, i);
      });
      return m;
    });
  }

  /** Set the whole assignment from a choice. Returns whether every row holds. */
  load(choice: readonly number[]): boolean {
    if (choice.length !== this.model.events.length) return false;
    this.choice = [...choice];
    this.val.fill(0);
    this.val[0] = 1;
    choice.forEach((c, e) => {
      const y = (this.yId[e] as number[])[c];
      if (y === undefined) return;
      this.val[y] = 1;
    });
    if (choice.some((c, e) => (this.yId[e] as number[])[c] === undefined)) return false;
    this.derived.forEach((_, i) => {
      this.val[this.derivedId[i] as number] = this.compute(i);
    });
    this.act.fill(0);
    this.violated = 0;
    for (let id = 0; id < this.names.length; id++) {
      const v = this.val[id] as number;
      if (v === 0) continue;
      const { row, coef } = this.inRows[id] as { row: number[]; coef: number[] };
      for (let k = 0; k < row.length; k++) this.act[row[k] as number] = (this.act[row[k] as number] as number) + (coef[k] as number) * v;
    }
    for (let r = 0; r < this.act.length; r++) if (!this.holds(r)) this.violated += 1;
    this.obj = this.model.constant;
    for (let id = 0; id < this.names.length; id++) this.obj += (this.objCoef[id] as number) * (this.val[id] as number);
    return this.violated === 0;
  }

  objective(): number {
    return this.obj;
  }

  assignment(): Record<string, number> {
    const out: Record<string, number> = {};
    this.names.forEach((name, id) => {
      out[name] = this.val[id] as number;
    });
    return out;
  }

  private holds(r: number): boolean {
    const a = this.act[r] as number;
    const op = this.rowOps[r];
    return op === '<=' ? a <= (this.rowRhs[r] as number) : op === '>=' ? a >= (this.rowRhs[r] as number) : a === this.rowRhs[r];
  }

  private compute(i: number): number {
    const d = this.derived[i] as Derived;
    const v = (name: string): number => this.val[this.ids.get(name) as number] as number;
    switch (d.kind) {
      case 'sum':
        return d.terms.reduce((s, [name, k]) => s + k * v(name), 0);
      case 'any':
        return d.inputs.reduce((s, name) => s + v(name), 0) >= 1 ? 1 : 0;
      case 'stay':
        return 1; // a swappable scorer (slice A9) stays: the search never infers a removal from "no entries"
      case 'diver': {
        if (d.z !== null && v(d.z) !== 1) return 0;
        return d.dives.reduce((s, name) => s + v(name), 0) >= 1 && d.others.every((name) => v(name) === 0) ? 1 : 0;
      }
      case 'excess':
        return Math.max(0, d.k0 + d.terms.reduce((s, [name, k]) => s + k * v(name), 0) - d.max);
      case 'min':
        return Math.min(...d.lanes.map((lane) => lane.constant + lane.terms.reduce((s, [name, k]) => s + k * v(name), 0)));
    }
  }

  /** Set one variable, keep the row activities, the violation count and the objective, and log the old value. */
  private set(id: number, next: number): void {
    const old = this.val[id] as number;
    if (old === next) return;
    this.undo.push([id, old]);
    this.write(id, next - old);
    this.val[id] = next;
  }

  private write(id: number, delta: number): void {
    const { row, coef } = this.inRows[id] as { row: number[]; coef: number[] };
    for (let k = 0; k < row.length; k++) {
      const r = row[k] as number;
      const before = this.holds(r);
      this.act[r] = (this.act[r] as number) + (coef[k] as number) * delta;
      const after = this.holds(r);
      if (before !== after) this.violated += after ? -1 : 1;
    }
    this.obj += (this.objCoef[id] as number) * delta;
  }

  private revert(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const [id, old] = this.undo[i] as [number, number];
      this.write(id, old - (this.val[id] as number));
      this.val[id] = old;
    }
    this.undo = [];
  }

  /** Try replacing the columns of some events. Accepts and returns true only for a feasible, strictly better choice. */
  private attempt(changes: readonly (readonly [number, number])[]): boolean {
    this.evaluations += 1;
    if (this.evaluations >= (this.budget.maxEvaluations ?? LOCAL_SEARCH_MAX_EVALUATIONS)) this.stopped = true;
    if (this.budget.clock !== undefined && this.budget.stopAt !== undefined && this.evaluations % CLOCK_EVERY === 0 && this.budget.clock() >= this.budget.stopAt) this.stopped = true;
    const best = this.obj;
    const affected = new Set<number>();
    for (const [e, c] of changes) {
      this.set(this.yId[e]?.[this.choice[e] as number] as number, 0);
      this.set(this.yId[e]?.[c] as number, 1);
      for (const di of (this.closure[e] as number[][])[this.choice[e] as number] as number[]) affected.add(di);
      for (const di of (this.closure[e] as number[][])[c] as number[]) affected.add(di);
    }
    for (const di of [...affected].sort((a, b) => a - b)) this.set(this.derivedId[di] as number, this.compute(di));
    if (this.violated === 0 && this.obj > best) {
      for (const [e, c] of changes) this.choice[e] = c;
      this.undo = [];
      this.moves += 1;
      return true;
    }
    this.revert();
    return false;
  }

  private improveByReplace(): boolean {
    for (let e = 0; e < this.model.events.length; e++) {
      const columns = (this.model.events[e] as LpModel['events'][number]).columns.length;
      for (let c = 0; c < columns; c++) {
        if (this.stopped) return false;
        if (c === this.choice[e]) continue;
        if (this.attempt([[e, c]])) return true;
      }
    }
    return false;
  }

  private improveByMove(): boolean {
    const events = this.model.events;
    for (let e1 = 0; e1 < events.length; e1++) {
      const p1 = (events[e1] as LpModel['events'][number]).columns[this.choice[e1] as number]?.members ?? [];
      for (const s of p1) {
        const without = (this.byMembers[e1] as Map<string, number>).get(memberKey(p1.filter((x) => x !== s)));
        if (without === undefined) continue;
        for (let e2 = 0; e2 < events.length; e2++) {
          if (e2 === e1) continue;
          const p2 = (events[e2] as LpModel['events'][number]).columns[this.choice[e2] as number]?.members ?? [];
          if (p2.includes(s)) continue;
          const withS = (this.byMembers[e2] as Map<string, number>).get(memberKey([...p2, s].sort(cmp)));
          if (withS === undefined) continue;
          if (this.stopped) return false;
          if (this.attempt([[e1, without], [e2, withS]])) return true;
        }
      }
    }
    return false;
  }

  run(): SearchResult {
    const startObjective = this.obj;
    while (!this.stopped && (this.improveByReplace() || this.improveByMove())) {
      // Each accepted move restarts the scan from M1.
    }
    return {
      choice: [...this.choice],
      columns: this.assignment(),
      startObjective,
      objective: this.obj,
      moves: this.moves,
      evaluations: this.evaluations,
      stop: this.stopped ? 'budget' : 'local-optimum',
    };
  }
}

function inputsOf(d: Derived): readonly string[] {
  switch (d.kind) {
    case 'sum':
    case 'excess':
      return d.terms.map(([name]) => name);
    case 'any':
      return d.inputs;
    case 'stay':
      return [];
    case 'diver':
      return [...(d.z === null ? [] : [d.z]), ...d.dives, ...d.others];
    case 'min':
      return d.lanes.flatMap((lane) => lane.terms.map(([name]) => name));
  }
}
