/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The MIP of D5 4 as CPLEX-LP text, slice A1: formulation B, `max-own`, individual and diving events, own relays fixed.
 * The conventions are those of `rosterSuggest.ts` (copied, not imported: that file stays untouched): whole-number
 * coefficients, `formatInt` that refuses a fraction, a constant carried by the column `one`, and a reader that fails loudly.
 *
 * Variable names follow a canonical numbering (swimmers and events in sorted order, columns by sorted member ids), so
 * two requests that differ only in the order of their input arrays give byte-identical text (D5 7).
 */
import type { SwimmerId } from '../model/primitives';
import type { MeetEvent } from '../model/meet';
import { autoBuildFail } from './types';
import type { Column, EventSpace, Problem, Space } from './space';
import { pairKey } from './space';
import { certainSession, scorerIds } from './load';
import type { Support } from './support';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Largest sum of absolute objective coefficients the integer model accepts (rosterSuggest.ts:668). */
// A literal, not `2 ** 40`: esbuild keeps a top-level `**` expression, which would leak this module into extension bundles.
export const MAX_COEFFICIENT_SUM = 1_099_511_627_776;

/** `D`: whole numbers per published point (D5 5.2). */
export interface Scale {
  readonly D: number;
  /** `v * D` as a whole number, or `scale_unsupported`. */
  scaled(v: number, what: string): number;
}

export function makeScale(support: Support, tieSizes: Iterable<number>): Scale {
  let D = lcm(support.decScale, support.load?.penaltyScale ?? 1);
  for (const n of tieSizes) D = lcm(D, n);
  return {
    D,
    scaled(v, what) {
      const x = v * D;
      const r = Math.round(x);
      if (!Number.isFinite(x) || Math.abs(x - r) >= 1e-6) autoBuildFail('scale_unsupported', `${what}: ${v} is not a whole number at scale ${D}`, what);
      return r;
    },
  };
}

export type Term = readonly [string, number];
export interface Row {
  readonly terms: readonly Term[];
  readonly op: '<=' | '>=' | '=';
  readonly rhs: number;
}

/**
 * A variable that is a function of the column choices (the `y` variables), with the value that makes its rows loosest. The local search
 * (D5 10) reads these to derive a whole assignment from one column per event, so it needs no cap, load or diver logic of its own.
 * They are listed in dependency order: a definition reads only `y` variables and earlier definitions.
 * - `sum`: `x` and `g`, equal to the weighted sum of the `y` terms (the equality rows of 4.1 and 4.5).
 * - `any`: `z`, 1 exactly when some `x` of the swimmer is above 0 (Z1 and Z2).
 * - `diver`: `d`, 1 exactly when the swimmer is on the roster, dives, and has no other entry (D1 to D3). A larger `d` only loosens T1.
 * - `excess`: `v`, the least value the row of 4.5 allows: the races above the maximum, or 0.
 */
export type Derived =
  | { readonly kind: 'sum'; readonly name: string; readonly terms: readonly Term[] }
  | { readonly kind: 'any'; readonly name: string; readonly inputs: readonly string[] }
  | { readonly kind: 'diver'; readonly name: string; readonly z: string | null; readonly dives: readonly string[]; readonly others: readonly string[] }
  | { readonly kind: 'excess'; readonly name: string; readonly k0: number; readonly max: number; readonly terms: readonly Term[] };

/** The integer model behind an LP text: what the local search of D5 10 climbs over, and what it checks a solver incumbent against. */
export interface LpModel {
  readonly rows: readonly Row[];
  readonly objective: readonly Term[];
  readonly constant: number;
  readonly binaries: readonly string[];
  readonly generals: readonly { readonly name: string; readonly ub: number }[];
  /** The events that have a choice of column, in `model.events` order. `ys[i]` is the variable of `columns[i]`. */
  readonly events: readonly { readonly id: string; readonly ys: readonly string[]; readonly columns: readonly Column[] }[];
  readonly derived: readonly Derived[];
}

function formatInt(n: number): string {
  if (!Number.isSafeInteger(n)) return autoBuildFail('model_mismatch', `the LP holds a coefficient that is not a whole number: ${n}`);
  return String(n);
}

function termsText(terms: readonly Term[]): string {
  const parts = terms.map(([name, k]) => `${k < 0 ? '-' : '+'} ${formatInt(Math.abs(k))} ${name}`);
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 8) lines.push(parts.slice(i, i + 8).join(' '));
  return lines.join('\n   ');
}

/** A general integer variable, `0..ub`. */
interface General {
  readonly name: string;
  readonly ub: number;
}

function render(objective: readonly Term[], constant: number, rows: readonly Row[], binaries: readonly string[], generals: readonly General[]): string {
  const lines: string[] = ['Maximize', ` obj: ${formatInt(constant)} one${objective.length > 0 ? ` ${termsText(objective)}` : ''}`, 'Subject To'];
  rows.forEach((r, i) => {
    const body = r.terms.length === 0 ? '0 one' : termsText(r.terms);
    lines.push(` c${i}: ${body} ${r.op} ${formatInt(r.rhs)}`);
  });
  lines.push('Bounds', ' one = 1');
  for (const g of generals) lines.push(` 0 <= ${g.name} <= ${formatInt(g.ub)}`);
  if (generals.length > 0) lines.push('General', ` ${generals.map((g) => g.name).join(' ')}`);
  lines.push('Binary');
  for (let i = 0; i < binaries.length; i += 12) lines.push(` ${binaries.slice(i, i + 12).join(' ')}`);
  lines.push('End');
  return lines.join('\n');
}

/** The value of a binary column, or a loud failure: a missing or fractional column is never read as 0. */
export function readColumn(columns: Readonly<Record<string, number>>, name: string): number {
  const v = columns[name];
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v - Math.round(v)) > 1e-6) {
    return autoBuildFail('model_mismatch', `the solver returned no whole value for column ${name}`);
  }
  return Math.round(v);
}

interface EventVars {
  readonly es: EventSpace;
  readonly ys: readonly { readonly name: string; readonly column: Column }[];
  /** swimmer to x variable */
  readonly xs: ReadonlyMap<SwimmerId, string>;
  /** swimmer to o variable (outside pair, relaxed only) */
  readonly os: ReadonlyMap<SwimmerId, string>;
  /** A relay event: the outside slot `oR` (general, relaxed only). */
  readonly oR: string | null;
}

/** What a solution says, read and checked against the LP's own rows. */
export interface Selection {
  /** The chosen column per multi-column event id. */
  readonly chosen: ReadonlyMap<string, Column>;
  /** Free swimmers with z = 1. */
  readonly joined: ReadonlySet<SwimmerId>;
  /** Outside pairs with o = 1, per event id. */
  readonly outside: ReadonlyMap<string, readonly SwimmerId[]>;
  /** Relay events whose outside slot `oR` is above 0. */
  readonly relayOutside: ReadonlySet<string>;
}

export interface LpBuild {
  readonly text: string;
  readonly rows: number;
  readonly cols: number;
  readonly relaxed: boolean;
  /** The integer model of the text, for the local search (D5 10). */
  readonly model: LpModel;
  /** The objective this LP maximizes, as whole numbers. */
  objectiveOf(columns: Readonly<Record<string, number>>): number;
  /** The own points (scaled, constant included) of the chosen columns: the `y` terms only. */
  pointsOf(columns: Readonly<Record<string, number>>): number;
  select(columns: Readonly<Record<string, number>>): Selection;
}

export interface LpOptions {
  readonly relaxed: boolean;
  /** Tie-break stage (D5 6.3.3): minimize changes (4.9) subject to points of at least `minPoints` (scaled, constant included). */
  readonly tieBreak?: { readonly minPoints: number };
}

/** The scaled own points of everything the columns do not cover: the events outside the search and the one-column events. */
function constantPoints(problem: Problem, space: Space, scale: Scale): number {
  const covered = new Set(problem.built.map((e) => `${e.gender}\u0000${e.eventKey}`));
  let fixed = 0;
  for (const e of problem.currentResults.events) {
    if (covered.has(`${e.gender}\u0000${e.eventKey}`)) continue;
    for (const r of e.rows) if (r.teamId === problem.req.ownTeamId) fixed += r.points;
  }
  let total = scale.scaled(fixed, 'the own points outside the search');
  for (const es of space.events) {
    if (es.columns.length === 1) total += scale.scaled((es.columns[0] as Column).eval.own, `the own points of ${es.event.eventKey}`);
  }
  return total;
}

/** One term of a swimmer's races in one session: the variable, its coefficient and its largest value (D5 4.5). */
interface RaceTerm {
  readonly name: string;
  readonly coef: number;
  readonly ub: number;
}

const SLOT_ORDER = ['morning', 'afternoon', 'evening'];

/** Session keys (`day/slot`) in meet order. */
const bySession = (a: string, b: string): number => {
  const [da, sa] = a.split('/') as [string, string];
  const [db, sb] = b.split('/') as [string, string];
  return Number(da) - Number(db) || SLOT_ORDER.indexOf(sa) - SLOT_ORDER.indexOf(sb);
};

class Builder {
  readonly rows: Row[] = [];
  readonly binaries: string[] = [];
  private readonly swimmerIndex = new Map<SwimmerId, number>();
  private readonly eventVars: EventVars[] = [];
  private readonly zVar = new Map<SwimmerId, string>();
  private readonly dVar = new Map<SwimmerId, string>();
  /** every x, o and w variable of a swimmer, with its event (`w`: a relay slot a swimmer may fill, relaxed only) */
  private readonly pairVars = new Map<SwimmerId, { name: string; event: MeetEvent; kind: 'x' | 'o' | 'w'; ub: number }[]>();
  private readonly generals: General[] = [];
  /** D5 4.5: `race(s,e,σ)` terms per swimmer and session key. */
  private readonly raceTerms = new Map<SwimmerId, Map<string, RaceTerm[]>>();
  /** The `-pen·v` terms of `prefer` mode: part of the objective and of the points floor, never of `y`. */
  private readonly penTerms: Term[] = [];
  /** Each `v` row: the constant races and the terms, to read the least `v` of a solution (an incumbent's `v` may be larger). */
  private readonly penaltyRows: { readonly k0: number; readonly terms: readonly RaceTerm[] }[] = [];
  /** Extra races (above the maximum) that no variable can change: they cost `pen` each in every solution. */
  private constantExtra = 0;
  /** Every `g` and `v` variable, read back to fail on a fractional value. */
  private readonly loadVars: string[] = [];
  /** Definitions of the variables that follow the column choices (see `Derived`), in dependency order. */
  private readonly derived: Derived[] = [];
  readonly points: Term[] = [];
  readonly objective: Term[] = [];
  constant = 0;

  constructor(
    private readonly problem: Problem,
    private readonly space: Space,
    private readonly scale: Scale,
    private readonly opts: LpOptions
  ) {
    [...problem.decision].sort(cmp).forEach((id, i) => this.swimmerIndex.set(id, i));
  }

  private general(name: string, ub: number): string {
    this.generals.push({ name, ub });
    return name;
  }

  /** An outside pair or relay slot charges only the race it certainly swims (D5 6.2). */
  private addCertainRace(id: SwimmerId, event: MeetEvent, name: string): void {
    const load = this.problem.support.load;
    const session = load === null ? null : certainSession(load, event);
    if (session !== null) this.addRace(id, session, { name, coef: 1, ub: 1 });
  }

  private addRace(id: SwimmerId, session: string, term: RaceTerm): void {
    const bySwimmer = this.raceTerms.get(id) ?? new Map<string, RaceTerm[]>();
    bySwimmer.set(session, [...(bySwimmer.get(session) ?? []), term]);
    this.raceTerms.set(id, bySwimmer);
  }

  /** The `race(s,e,σ)` terms of one swimmer in one event (D5 4.5): `c·x` when every column that holds him gives the same count c, else `g`. */
  private addEventRaces(es: EventSpace, ei: number, ys: EventVars['ys'], id: SwimmerId, x: string): void {
    const holding = ys.filter(({ column }) => column.members.includes(id));
    const sessions = new Set<string>();
    for (const { column } of holding) for (const k of column.eval.races.get(id)?.keys() ?? []) sessions.add(k);
    const unit = (column: Column): boolean => (column.squads ?? []).filter((q) => q.swimmers.includes(id)).length <= 1;
    for (const session of [...sessions].sort(bySession)) {
      const counts = holding.map(({ column }) => column.eval.races.get(id)?.get(session) ?? 0);
      const first = counts[0] as number;
      if (counts.every((c) => c === first) && holding.every(({ column }) => unit(column))) {
        if (first > 0) this.addRace(id, session, { name: x, coef: first, ub: 1 });
        continue;
      }
      const top = Math.max(...counts);
      const name = `g${this.si(id)}_${ei}_${session.replace('/', '')}`;
      const g = top === 1 ? this.bin(name) : this.general(name, top);
      this.loadVars.push(g);
      this.row([[g, 1], ...holding.map(({ name: y, column }) => [y, -(column.eval.races.get(id)?.get(session) ?? 0)] as Term).filter(([, k]) => k !== 0)], '=', 0);
      this.derived.push({ kind: 'sum', name: g, terms: holding.map(({ name: y, column }) => [y, column.eval.races.get(id)?.get(session) ?? 0] as Term).filter(([, k]) => k !== 0) });
      this.addRace(id, session, { name: g, coef: 1, ub: top });
    }
  }

  private bin(name: string): string {
    this.binaries.push(name);
    return name;
  }

  private row(terms: readonly Term[], op: Row['op'], rhs: number): void {
    this.rows.push({ terms, op, rhs });
  }

  private si(id: SwimmerId): number {
    return this.swimmerIndex.get(id) as number;
  }

  private addEvent(es: EventSpace, ei: number): void {
    const { scale } = this;
    const members = new Set<SwimmerId>();
    for (const c of es.columns) for (const id of c.members) members.add(id);
    const ys = es.columns.map((column, ci) => ({ name: this.bin(`y${ei}_${ci}`), column }));
    ys.forEach(({ name, column }) => this.points.push([name, scale.scaled(column.eval.own, `the own points of ${es.event.eventKey}`)]));
    this.row(ys.map(({ name }) => [name, 1] as Term), '=', 1);
    const xs = new Map<SwimmerId, string>();
    for (const id of [...members].sort(cmp)) {
      // D5 amendment 2, 3.3: two current squads of one event may share a swimmer, so `x` counts his squads in the column (0..max).
      const mult = (column: Column): number => (column.squads === undefined ? 1 : column.squads.filter((q) => q.swimmers.includes(id)).length);
      const maxMult = Math.max(1, ...ys.map(({ column }) => mult(column)));
      const x = maxMult === 1 ? this.bin(`x${this.si(id)}_${ei}`) : this.general(`x${this.si(id)}_${ei}`, maxMult);
      xs.set(id, x);
      const holding = ys.filter(({ column }) => column.members.includes(id)).map(({ name, column }) => [name, mult(column)] as Term);
      this.row([...holding, [x, -1]], '=', 0);
      this.derived.push({ kind: 'sum', name: x, terms: holding });
      this.pairVars.set(id, [...(this.pairVars.get(id) ?? []), { name: x, event: es.event, kind: 'x', ub: maxMult }]);
      if (this.problem.support.load !== null && this.problem.decision.has(id)) this.addEventRaces(es, ei, ys, id, x);
    }
    const os = new Map<SwimmerId, string>();
    if (this.opts.relaxed) {
      for (const id of es.outside()) {
        const o = this.bin(`o${this.si(id)}_${ei}`);
        os.set(id, o);
        const pair = es.pairs.get(id);
        const ub = scale.scaled(pair?.singleton?.own ?? 0, `the bound of ${id} in ${es.event.eventKey}`);
        this.objective.push([o, ub]);
        const x = xs.get(id);
        if (x !== undefined) this.row([[x, 1], [o, 1]], '<=', 1);
        this.pairVars.set(id, [...(this.pairVars.get(id) ?? []), { name: o, event: es.event, kind: 'o', ub: 1 }]);
        this.addCertainRace(id, es.event, o);
      }
    }
    const oR = this.opts.relaxed && es.relay !== null ? this.addOutsideRelay(es, ei, ys, xs) : null;
    this.eventVars.push({ es, ys, xs, os, oR });
  }

  /**
   * The outside relay slot of D5 6.2: `oR` squads outside `Q_e`, each worth at most the relay table at the best place behind the
   * standing relays that beat `tau_out`. They take slots (`Σ|p|·y + oR ≤ R`), and four swimmers each (`w`) who count in the
   * caps, the roster gate and the diver rows like any other entry.
   */
  private addOutsideRelay(es: EventSpace, ei: number, ys: EventVars['ys'], xs: ReadonlyMap<SwimmerId, string>): string | null {
    const relay = es.relay as NonNullable<EventSpace['relay']>;
    if (relay.tauOut === null || relay.ubRel <= 0) return null;
    const { scale } = this;
    const oR = `oR${ei}`;
    this.generals.push({ name: oR, ub: relay.slots });
    this.objective.push([oR, scale.scaled(relay.ubRel, `the relay bound of ${es.event.eventKey}`)]);
    const sized = ys.flatMap(({ name, column }) => ((column.squads?.length ?? 0) > 0 ? [[name, Math.min(column.squads?.length ?? 0, relay.slots)] as Term] : []));
    this.row([...sized, [oR, 1]], '<=', relay.slots);
    const ws: string[] = [];
    for (const id of relay.eligible) {
      const w = this.bin(`w${this.si(id)}_${ei}`);
      ws.push(w);
      this.pairVars.set(id, [...(this.pairVars.get(id) ?? []), { name: w, event: es.event, kind: 'w', ub: 1 }]);
      this.addCertainRace(id, es.event, w);
      const x = xs.get(id);
      if (x !== undefined) {
        // `x` counts the swimmer's squads in the column (up to `ub`): a swimmer who fills an outside slot is in none of them.
        const ub = this.generals.find((g) => g.name === x)?.ub ?? 1;
        this.row([[x, 1], [w, ub]], '<=', ub);
      }
    }
    this.row([...ws.map((w) => [w, 1] as Term), [oR, -4]], '=', 0);
    return oR;
  }

  /** Z1 and Z2 for the free swimmers that have a pair variable. */
  private addRoster(): void {
    for (const id of [...this.problem.freeSet].sort(cmp)) {
      const vars = this.pairVars.get(id);
      if (vars === undefined || vars.length === 0) continue; // nothing to add: the swimmer stays off the roster
      const z = this.bin(`z${this.si(id)}`);
      this.zVar.set(id, z);
      for (const v of vars) this.row([[v.name, 1], [z, -v.ub]], '<=', 0);
      // Z3 (D5 4.6): a held split entry stays whatever `z` is, so `x = z`.
      for (const v of vars) if (v.kind === 'x' && this.problem.held.has(pairKey(id, v.event.eventKey))) this.row([[v.name, 1], [z, -1]], '=', 0);
      this.row([[z, 1], ...vars.map((v) => [v.name, -1] as Term)], '<=', 0);
      this.derived.push({ kind: 'any', name: z, inputs: vars.map((v) => v.name) });
    }
  }

  /**
   * C1 to C3 per swimmer (D5 4). `k_R` is the swimmer's relay entries that stay fixed. A row is omitted only when it is true for every
   * value of its variables, so the test sums the upper bounds: a swimmer in two squads of one column has an `x` that reaches 2.
   */
  private addCaps(): void {
    const { entryCaps } = this.problem.support;
    const reach = (list: readonly { readonly ub: number }[]): number => list.reduce((sum, v) => sum + v.ub, 0);
    for (const id of [...this.problem.decision].sort(cmp)) {
      const vars = this.pairVars.get(id) ?? [];
      const individualVars = vars.filter((v) => v.event.kind !== 'relay');
      const relayVars = vars.filter((v) => v.event.kind === 'relay');
      const individual = individualVars.map((v) => [v.name, 1] as Term);
      const relays = relayVars.map((v) => [v.name, 1] as Term);
      const kR = this.problem.relayEntries.get(id) ?? 0;
      if (entryCaps.individual !== 'unlimited' && reach(individualVars) > entryCaps.individual) this.row(individual, '<=', entryCaps.individual);
      // A fixed relay count over the relay cap cannot be repaired: the row has no variable and is infeasible.
      if (entryCaps.relay !== 'unlimited' && reach(relayVars) + kR > entryCaps.relay) this.row(relays, '<=', entryCaps.relay - kR);
      if (entryCaps.total !== 'unlimited' && reach(vars) + kR > entryCaps.total) this.row([...individual, ...relays], '<=', entryCaps.total - kR);
    }
  }

  /**
   * L1 and L2 (D5 4.5): per decision swimmer and session, the races of the built events plus the constant races of the fixed ones.
   * A row that no assignment can break is left out. `respect` is a hard row. `prefer` adds `v >= races - max` and charges `pen` for each `v`.
   */
  private addLoad(constRaces: ReadonlyMap<SwimmerId, ReadonlyMap<string, number>>): void {
    const load = this.problem.support.load;
    if (load === null) return;
    const penalty = load.prefer ? this.scale.scaled(load.penalty, 'the preference penalty') : 0;
    for (const id of [...this.problem.decision].sort(cmp)) {
      const terms = this.raceTerms.get(id) ?? new Map<string, RaceTerm[]>();
      const fixed = constRaces.get(id) ?? new Map<string, number>();
      for (const session of [...new Set([...terms.keys(), ...fixed.keys()])].sort(bySession)) {
        const list = terms.get(session) ?? [];
        const k0 = fixed.get(session) ?? 0;
        const reach = list.reduce((sum, t) => sum + t.coef * t.ub, 0);
        if (reach + k0 <= load.max) continue;
        if (!load.prefer) {
          this.row(list.map((t) => [t.name, t.coef] as Term), '<=', load.max - k0);
        } else if (list.length === 0) {
          this.constantExtra += k0 - load.max;
        } else {
          const v = this.general(`v${this.si(id)}_${session.replace('/', '')}`, reach + k0 - load.max);
          this.loadVars.push(v);
          this.row([[v, 1], ...list.map((t) => [t.name, -t.coef] as Term)], '>=', k0 - load.max);
          this.derived.push({ kind: 'excess', name: v, k0, max: load.max, terms: list.map((t) => [t.name, t.coef] as Term) });
          this.penTerms.push([v, -penalty]);
          this.penaltyRows.push({ k0, terms: list });
        }
      }
    }
  }

  /** D1 to D3: the strict diver indicator (D5 4.4). A swimmer on a fixed relay has no indicator. */
  private addDivers(): void {
    for (const id of [...this.problem.decision].sort(cmp)) {
      const vars = this.pairVars.get(id) ?? [];
      const dives = vars.filter((v) => v.event.kind === 'diving');
      if (dives.length === 0 || (this.problem.relayEntries.get(id) ?? 0) > 0) continue;
      const d = this.bin(`d${this.si(id)}`);
      this.dVar.set(id, d);
      const z = this.zVar.get(id);
      if (this.problem.freeSet.has(id) && z !== undefined) this.row([[d, 1], [z, -1]], '<=', 0);
      this.row([[d, 1], ...dives.map((v) => [v.name, -1] as Term)], '<=', 0);
      for (const v of vars) if (v.event.kind !== 'diving') this.row([[d, 1], [v.name, 1]], '<=', 1);
      const zOfRow = this.problem.freeSet.has(id) && z !== undefined ? z : null;
      this.derived.push({ kind: 'diver', name: d, z: zOfRow, dives: dives.map((v) => v.name), others: vars.filter((v) => v.event.kind !== 'diving').map((v) => v.name) });
    }
  }

  /** T1 per built gender: the scoring-team size, in units of 1/denominator of a spot. */
  private addTeamSize(): void {
    const { size, weight } = this.problem.support;
    if (size === 'unlimited') return;
    for (const g of this.problem.genders) {
      const pinned = this.problem.pinned.get(g) ?? [];
      const free = this.problem.free.get(g) ?? [];
      const terms: Term[] = [];
      for (const id of free) {
        const z = this.zVar.get(id);
        if (z !== undefined) terms.push([z, weight.denominator]);
      }
      for (const id of [...pinned, ...free]) {
        const d = this.dVar.get(id);
        if (d !== undefined) terms.push([d, -(weight.denominator - weight.numerator)]);
      }
      const rhs = size * weight.denominator - weight.denominator * pinned.length;
      if (terms.length > 0 || rhs < 0) this.row(terms, '<=', rhs);
    }
  }

  /** The tie-break objective: the negative change count of D5 4.9, and the points floor. */
  private addTieBreak(minPoints: number): void {
    this.row([...this.points, ...this.penTerms], '>=', minPoints - this.constant);
    let constant = 0;
    for (const id of [...this.problem.decision].sort(cmp)) {
      const vars = this.pairVars.get(id) ?? [];
      const current = (v: { event: MeetEvent }): boolean => this.problem.currentEntry.has(pairKey(id, v.event.eventKey));
      let nCurrent = 0;
      for (const e of this.problem.built) if (this.problem.currentEntry.has(pairKey(id, e.eventKey))) nCurrent += 1;
      if (this.problem.freeSet.has(id)) {
        const z = this.zVar.get(id);
        if (z !== undefined) this.objective.push([z, -(1 + nCurrent)]);
      } else {
        constant -= nCurrent;
      }
      for (const v of vars) if (v.event.kind !== 'relay') this.objective.push([v.name, current(v) ? 1 : -1]);
    }
    // A relay event changes by the squads that differ from the current ones (D5 4.9): an entry removed plus an entry added.
    for (const ev of this.eventVars) {
      if (ev.es.relay === null) continue;
      const now = new Set(ev.es.relay.current.map((q) => q.key));
      for (const { name, column } of ev.ys) {
        const keys = new Set((column.squads ?? []).map((q) => q.key));
        const changed = [...keys].filter((k) => !now.has(k)).length + [...now].filter((k) => !keys.has(k)).length;
        if (changed > 0) this.objective.push([name, -changed]);
      }
    }
    this.constant = constant;
  }

  build(): LpBuild {
    const { problem, space, scale } = this;
    const fixed = constantPoints(problem, space, scale);
    space.events.filter((es) => es.columns.length > 1).forEach((es, ei) => this.addEvent(es, ei));
    this.addRoster();
    this.addCaps();
    const constRaces = new Map<SwimmerId, Map<string, number>>();
    const bump = (id: SwimmerId, session: string, n: number): void => {
      const m = constRaces.get(id) ?? new Map<string, number>();
      m.set(session, (m.get(session) ?? 0) + n);
      constRaces.set(id, m);
    };
    for (const [id, sessions] of problem.fixedRaces) for (const [k, n] of sessions) bump(id, k, n);
    for (const es of space.events.filter((e) => e.columns.length === 1)) {
      for (const [id, sessions] of (es.columns[0] as Column).eval.races) for (const [k, n] of sessions) bump(id, k, n);
    }
    this.addLoad(constRaces);
    this.addDivers();
    this.addTeamSize();
    const loadRule = problem.support.load;
    // An own swimmer on the roster who is not a decision swimmer (another gender) keeps the races he has: a constant penalty.
    let extra = this.constantExtra;
    if (loadRule !== null && loadRule.prefer) {
      for (const id of scorerIds(problem.req.tags, problem.req.ownTeamId)) {
        if (problem.decision.has(id)) continue;
        for (const n of problem.fixedRaces.get(id)?.values() ?? []) if (n > loadRule.max) extra += n - loadRule.max;
      }
    }
    const penaltyUnit = loadRule !== null && loadRule.prefer ? scale.scaled(loadRule.penalty, 'the preference penalty') : 0;
    const pointsConstant = fixed - extra * penaltyUnit;
    if (this.opts.tieBreak !== undefined) {
      this.constant = pointsConstant;
      this.addTieBreak(this.opts.tieBreak.minPoints);
    } else {
      this.objective.unshift(...this.points, ...this.penTerms);
      this.constant = pointsConstant;
    }
    const sum = this.objective.reduce((s, [, k]) => s + Math.abs(k), 0) + Math.abs(this.constant);
    if (!Number.isSafeInteger(sum) || sum >= MAX_COEFFICIENT_SUM) {
      autoBuildFail('scale_unsupported', `the objective scale ${scale.D} is too large for an exact solve (coefficient sum ${sum})`, 'objective');
    }
    const objective = this.objective;
    const constant = this.constant;
    const points = this.points;
    const penaltyRows = this.penaltyRows;
    const text = render(objective, constant, this.rows, this.binaries, this.generals);
    const sumTerms = (terms: readonly Term[], columns: Readonly<Record<string, number>>): number =>
      terms.reduce((s, [name, k]) => s + k * readColumn(columns, name), 0);
    const order = new Map<string, number>(problem.req.model.events.map((e, i) => [`${e.gender}\u0000${e.eventKey}`, i]));
    const model: LpModel = {
      rows: this.rows,
      objective,
      constant,
      binaries: this.binaries,
      generals: this.generals,
      events: [...this.eventVars]
        .sort((a, b) => (order.get(a.es.id) as number) - (order.get(b.es.id) as number))
        .map((ev) => ({ id: ev.es.id, ys: ev.ys.map(({ name }) => name), columns: ev.ys.map(({ column }) => column) })),
      derived: this.derived,
    };
    return {
      text,
      rows: this.rows.length,
      cols: this.binaries.length + this.generals.length + 1,
      relaxed: this.opts.relaxed,
      model,
      objectiveOf: (columns) => constant + sumTerms(objective, columns),
      // The least `v` of the solution: an incumbent may carry a larger `v`, and the gate re-scores the lineup itself.
      pointsOf: (columns) => {
        let extraRaces = 0;
        for (const row of penaltyRows) {
          const races = row.k0 + row.terms.reduce((sum, t) => sum + t.coef * readColumn(columns, t.name), 0);
          if (races > (loadRule?.max ?? 0)) extraRaces += races - (loadRule?.max ?? 0);
        }
        return pointsConstant + sumTerms(points, columns) - extraRaces * penaltyUnit;
      },
      select: (columns) => this.select(columns),
    };
  }

  private select(columns: Readonly<Record<string, number>>): Selection {
    const chosen = new Map<string, Column>();
    const outside = new Map<string, SwimmerId[]>();
    const relayOutside = new Set<string>();
    for (const ev of this.eventVars) {
      const on = ev.ys.filter(({ name }) => readColumn(columns, name) === 1);
      if (on.length !== 1) autoBuildFail('model_mismatch', `the solver chose ${on.length} columns for ${ev.es.event.eventKey}`, ev.es.event.eventKey);
      const column = (on[0] as { column: Column }).column;
      chosen.set(ev.es.id, column);
      for (const [id, x] of ev.xs) {
        const held = (column.squads ?? []).filter((q) => q.swimmers.includes(id)).length;
        if (readColumn(columns, x) !== (column.squads === undefined ? (column.members.includes(id) ? 1 : 0) : held)) {
          autoBuildFail('model_mismatch', `the solver's x for ${id} in ${ev.es.event.eventKey} disagrees with its column`, id);
        }
      }
      const active = [...ev.os].filter(([, o]) => readColumn(columns, o) === 1).map(([id]) => id);
      if (active.length > 0) outside.set(ev.es.id, active);
      if (ev.oR !== null && readColumn(columns, ev.oR) > 0) relayOutside.add(ev.es.id);
    }
    for (const vars of this.pairVars.values()) for (const v of vars) if (v.kind === 'w') readColumn(columns, v.name);
    const joined = new Set<SwimmerId>();
    for (const [id, z] of this.zVar) if (readColumn(columns, z) === 1) joined.add(id);
    for (const d of this.dVar.values()) readColumn(columns, d); // fail on a missing or fractional indicator
    for (const name of this.loadVars) readColumn(columns, name);
    return { chosen, joined, outside, relayOutside };
  }
}

export function buildLp(space: Space, scale: Scale, opts: LpOptions): LpBuild {
  return new Builder(space.problem, space, scale, opts).build();
}
