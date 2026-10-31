/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Suggested opponent scoring rosters (plans/2026-10-25/D2-ENGINE-API.md, 3.14), P3.core-c.
 *
 * For each opponent team and gender the coach has not tagged, `suggestScoringRosters` builds the roster that
 * maximizes that team's points (README R70). It never scores a meet by itself: the ILP only proposes a roster,
 * and `scoreMeet` is the only scorer. The result of every ILP is scored through `scoreMeet` (the guard), and a
 * difference throws `suggest_model_mismatch` instead of returning a plausible, wrong roster.
 *
 * ## What the ILP models
 * One reference field per target team and gender T (never a joint fixed point, which depends on order):
 * - every non-target side scores as tagged, the coach's own team included;
 * - every other target counts each entered swimmer as a scorer, except the swimmers the coach pinned;
 * - T's coach pins hold: a coach `'scorer'` tag is on, a `'non-scorer'` or `'exhibition'` tag is off.
 * A binary x per candidate says whether the candidate is on the roster. A relay counts when all its legs are on
 * the roster (y, the AND of its legs) if `scorers.relayLegsMustBeScorers`. Each event gets, per tie block of T's
 * entries, a one-hot u[m, in, scoring]: `m` T entries ahead stand in the places, `in` entries of the block stand in
 * the places and `scoring` of them earn points. The coefficient is exact: the table places the block spans, divided
 * by the tie group size, scaled to whole numbers by `D` (the least common multiple of the group sizes that occur) and
 * by a power of ten when a point table has decimals. The linking rows are equalities, so a solution can never claim
 * a better place than the lineup gives.
 *
 * Nothing here reads input array order or Map iteration order: candidates, events and teams are sorted, and the
 * tie-break (points, then spots, then the lowest swimmer ids) leaves one roster.
 */
import { buildIndex, groupFields, pointTables, resolveLineup, scoreMeet, settled } from './results';
import type { Results } from './results';
import type { Lineup, ScorerRole, ScorerTag } from './lineup';
import type { Gender, SwimmerId, TeamId } from './primitives';
import type { MeetModel } from './meet';
import type { CompleteRulePreset } from '../rules/rulePreset';
import type { ConversionSettings } from '../sourcing/convert';

/** The fields of `SolvedResponse` (apps/extension optimizerProtocol.ts) the suggester reads. */
export interface LpSolution {
  readonly status: string;
  readonly objective: number;
  readonly columns: Readonly<Record<string, number>>;
}

/** Solve one CPLEX-LP model. `options` are HiGHS option names and values. The engine takes no `highs` dependency. */
export type LpSolve = (lp: string, options: Readonly<Record<string, string | number | boolean>>) => Promise<LpSolution>;

export interface RosterSuggestRequest {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly rules: CompleteRulePreset;
  readonly sourcing: ConversionSettings;
  /** The coach's own tags. A tag with `source` throws `suggested_tag_in_input`. */
  readonly coachTags: readonly ScorerTag[];
  readonly ownTeamId: TeamId;
  readonly targets: readonly { readonly teamId: TeamId; readonly gender: Gender }[];
}

export type RosterSuggestion =
  | {
      readonly kind: 'suggested';
      readonly teamId: TeamId;
      readonly gender: Gender;
      /** Role `'scorer'`, `source: 'suggested'`, sorted by swimmer id. Never a pinned swimmer. */
      readonly tags: readonly ScorerTag[];
      /** The points of this team and gender in its reference field, from `scoreMeet`. Not the final total. */
      readonly referencePoints: number;
      /** The scoring-roster spots used, pins included, as an exact fraction (not reduced). */
      readonly spots: { readonly numerator: number; readonly denominator: number };
      readonly method: 'all_entered' | 'ilp';
    }
  | {
      readonly kind: 'absent';
      readonly teamId: TeamId;
      readonly gender: Gender;
      readonly reason: 'pins_over_size' | 'solver_not_optimal';
    };

export type RosterSuggestErrorCode =
  | 'target_is_own_team'
  | 'target_without_entries'
  | 'suggested_tag_in_input'
  | 'suggest_rule_unsupported'
  | 'suggest_model_mismatch';

export class RosterSuggestError extends Error {
  readonly code: RosterSuggestErrorCode;
  /** The team id, swimmer id or setting path the error is about, when it has one. */
  readonly subject: string | null;

  constructor(code: RosterSuggestErrorCode, message: string, subject: string | null = null) {
    super(message);
    this.name = 'RosterSuggestError';
    this.code = code;
    this.subject = subject;
  }
}

const fail = (code: RosterSuggestErrorCode, message: string, subject: string | null = null): never => {
  throw new RosterSuggestError(code, message, subject);
};

/** Exact optimum: a zero relative gap, and an absolute gap under one unit of a whole-number objective. */
const SOLVER_OPTIONS: Readonly<Record<string, string | number | boolean>> = {
  mip_rel_gap: 0,
  mip_abs_gap: 0.5,
  time_limit: 10,
  random_seed: 0,
  output_flag: false,
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sideKey = (teamId: TeamId, gender: Gender): string => `${teamId}\u0000${gender}`;

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

interface Support {
  readonly ties: 'split' | 'ordered';
  readonly holds: boolean;
  readonly mustBeScorers: boolean;
  readonly size: number | 'unlimited';
  readonly weight: { readonly numerator: number; readonly denominator: number };
  /** `'unlimited'`, or a number under `relayOverCap: 'exhibition'`. */
  readonly relayCap: number | 'unlimited';
  /** The point tables, as whole numbers (`decScale` times the published value). */
  readonly tables: { readonly individual: readonly number[]; readonly diving: readonly number[]; readonly relay: readonly number[] };
  readonly decScale: number;
}

function checkSupported(rules: CompleteRulePreset): Support {
  const unsupported = (path: string, why: string): never => fail('suggest_rule_unsupported', `${path}: ${why}`, path);
  if (settled(rules.scorers.eligibility, 'scorers.eligibility') !== 'roster') {
    unsupported('scorers.eligibility', 'only "roster" is supported');
  }
  if (settled(rules.scorers.scoringTeamScope, 'scorers.scoringTeamScope') !== 'meet') {
    unsupported('scorers.scoringTeamScope', 'only "meet" is supported');
  }
  if (settled(rules.scorers.perEventScorerCap, 'scorers.perEventScorerCap').cap !== 'unlimited') {
    unsupported('scorers.perEventScorerCap', 'a numeric per-event scorer cap is not supported');
  }
  const diving = settled(rules.scorers.divingPerEventScorerCap, 'scorers.divingPerEventScorerCap');
  if (diving.kind === 'own' && diving.cap !== 'unlimited') {
    unsupported('scorers.divingPerEventScorerCap', 'a numeric diving per-event scorer cap is not supported');
  }
  const relayCap = settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent');
  if (relayCap !== 'unlimited' && settled(rules.scorers.relayOverCap, 'scorers.relayOverCap') !== 'exhibition') {
    unsupported('scorers.relayOverCap', 'a relay cap is supported only when the over-cap relays leave the places ("exhibition")');
  }

  // The all-entered shortcut needs tables that never rise with place and hold no negative value (D2 3.14).
  const raw = pointTables(rules);
  const named: readonly (readonly [string, readonly number[]])[] = [
    ['scoring.individualPoints', raw.individual],
    ['scoring.divingPoints', raw.diving],
    ['scoring.relayPoints', raw.relay],
  ];
  let decScale = 1;
  for (const [path, table] of named) {
    table.forEach((v, i) => {
      if (!Number.isFinite(v) || v < 0) unsupported(path, `place ${i + 1} holds ${v}; a negative point value is not supported`);
      if (i > 0 && v > (table[i - 1] as number)) unsupported(path, `place ${i + 1} scores more than place ${i}; a table that rises with place is not supported`);
    });
    while (decScale <= 10000 && !table.every((v) => Math.abs(v * decScale - Math.round(v * decScale)) < 1e-9)) decScale *= 10;
    if (!table.every((v) => Math.abs(v * decScale - Math.round(v * decScale)) < 1e-9)) {
      unsupported(path, 'a point value has more than 4 decimals; the integer model cannot hold it exactly');
    }
  }
  const whole = (table: readonly number[]): readonly number[] => table.map((v) => Math.round(v * decScale));

  return {
    ties: settled(rules.scoring.ties, 'scoring.ties'),
    holds: settled(rules.scoring.nonScorerPlacement, 'scoring.nonScorerPlacement') === 'holds-place',
    mustBeScorers: settled(rules.scorers.relayLegsMustBeScorers, 'scorers.relayLegsMustBeScorers'),
    size: settled(rules.scorers.scoringTeamSize, 'scorers.scoringTeamSize'),
    weight: settled(rules.scorers.diverWeight, 'scorers.diverWeight'),
    relayCap,
    tables: { individual: whole(raw.individual), diving: whole(raw.diving), relay: whole(raw.relay) },
    decScale,
  };
}

/* -------------------------------------------------------------------------- */
/* Linear expressions over binary variables                                   */
/* -------------------------------------------------------------------------- */

interface Expr {
  readonly c: number;
  readonly t: ReadonlyMap<string, number>;
}

const konst = (c: number): Expr => ({ c, t: new Map() });
const variable = (name: string): Expr => ({ c: 0, t: new Map([[name, 1]]) });

function plus(a: Expr, b: Expr, sign: 1 | -1 = 1): Expr {
  const t = new Map(a.t);
  for (const [name, k] of b.t) {
    const next = (t.get(name) ?? 0) + sign * k;
    if (next === 0) t.delete(name);
    else t.set(name, next);
  }
  return { c: a.c + sign * b.c, t };
}
const minus = (a: Expr, b: Expr): Expr => plus(a, b, -1);
const total = (list: readonly Expr[]): Expr => list.reduce((acc, e) => plus(acc, e), konst(0));
const lo = (e: Expr): number => [...e.t.values()].reduce((s, k) => (k < 0 ? s + k : s), e.c);
const hi = (e: Expr): number => [...e.t.values()].reduce((s, k) => (k > 0 ? s + k : s), e.c);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

interface Row {
  readonly terms: readonly (readonly [string, number])[];
  readonly op: '<=' | '>=' | '=';
  readonly rhs: number;
}

function row(e: Expr, op: Row['op'], rhs: number): Row {
  return { terms: [...e.t], op, rhs: rhs - e.c };
}

function formatInt(n: number): string {
  if (!Number.isSafeInteger(n)) return fail('suggest_model_mismatch', `the LP holds a coefficient that is not a whole number: ${n}`);
  return String(n);
}

function termsText(terms: readonly (readonly [string, number])[]): string {
  const parts = terms.map(([name, k]) => `${k < 0 ? '-' : '+'} ${formatInt(Math.abs(k))} ${name}`);
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 8) lines.push(parts.slice(i, i + 8).join(' '));
  return lines.join('\n   ');
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

type Resolved = ReturnType<typeof resolveLineup>['resolved'][number];

interface Context {
  readonly req: RosterSuggestRequest;
  readonly support: Support;
  readonly resolved: readonly Resolved[];
  readonly lineIndex: ReadonlyMap<string, number>;
  readonly fields: readonly { readonly gender: Gender; readonly field: readonly Resolved[] }[];
  readonly entered: ReadonlyMap<string, readonly SwimmerId[]>;
  readonly swimmerSide: ReadonlyMap<SwimmerId, { teamId: TeamId; gender: Gender }>;
  readonly coachRoles: ReadonlyMap<SwimmerId, ScorerRole>;
  readonly dives: ReadonlySet<SwimmerId>;
  readonly relays: ReadonlySet<SwimmerId>;
  readonly targets: readonly { teamId: TeamId; gender: Gender }[];
}

/** Every swimmer of a side with at least one entry (an individual swim or a relay leg), sorted. */
function enteredBySide(lineup: Lineup, swimmerSide: ReadonlyMap<SwimmerId, { teamId: TeamId; gender: Gender }>): Map<string, SwimmerId[]> {
  const ids = new Set<SwimmerId>();
  for (const e of lineup.entries) {
    if (e.kind === 'individual') ids.add(e.swimmerId);
    else e.legs.forEach((leg) => ids.add(leg.swimmerId));
  }
  const out = new Map<string, SwimmerId[]>();
  for (const id of [...ids].sort(cmp)) {
    const side = swimmerSide.get(id);
    if (!side) continue; // scoreMeet names an unresolved swimmer.
    const key = sideKey(side.teamId, side.gender);
    const bucket = out.get(key);
    if (bucket) bucket.push(id);
    else out.set(key, [id]);
  }
  return out;
}

/** A scorer tag for each entered swimmer of every target except `skip`, when the coach did not tag the swimmer. */
function fillTags(ctx: Context, skip: string | null): ScorerTag[] {
  const tags: ScorerTag[] = [];
  for (const t of ctx.targets) {
    const key = sideKey(t.teamId, t.gender);
    if (key === skip) continue;
    for (const swimmerId of ctx.entered.get(key) ?? []) {
      if (!ctx.coachRoles.has(swimmerId)) tags.push({ teamId: t.teamId, swimmerId, role: 'scorer', source: 'suggested' });
    }
  }
  return tags;
}

function sidePoints(results: Results, teamId: TeamId, gender: Gender): number {
  let sum = 0;
  for (const e of results.events) {
    if (e.gender !== gender) continue;
    for (const r of e.rows) if (r.teamId === teamId) sum += r.points;
  }
  return sum;
}

/* -------------------------------------------------------------------------- */
/* The ILP of one target                                                      */
/* -------------------------------------------------------------------------- */

interface BlockSpec {
  readonly a: number;
  readonly k: number;
  readonly table: readonly number[];
  readonly ci: Expr;
  readonly cs: Expr;
  readonly m: Expr;
}

interface Model {
  readonly rows: Row[];
  readonly binaries: string[];
  /** The objective terms (one per u variable) and the constant. */
  readonly pointTerms: (readonly [string, number])[];
  pointConstant: number;
  readonly spotTerms: (readonly [string, number])[];
  /** Whole-number points per published point: `D` times the decimal scale. */
  scale: number;
}

/** The role of a swimmer outside the target's variables: a coach tag or the fill of another target. */
type Handle = { readonly kind: 'var'; readonly name: string } | { readonly kind: 'role'; readonly role: ScorerRole | undefined };

interface TEntry {
  readonly inE: Expr;
  readonly scE: Expr;
}

interface TargetSide {
  readonly team: TeamId;
  readonly gender: Gender;
  readonly candidateVar: ReadonlyMap<SwimmerId, string>;
  readonly baseRole: ReadonlyMap<SwimmerId, ScorerRole>;
}

function placeSum(table: readonly number[], start: number, size: number): number {
  let sum = 0;
  for (let p = start; p < start + size; p++) sum += table[p] ?? 0;
  return sum;
}

class ModelBuilder {
  readonly model: Model = { rows: [], binaries: [], pointTerms: [], pointConstant: 0, spotTerms: [], scale: 1 };
  private readonly counters = new Map<string, number>();
  private readonly andCache = new Map<string, Expr>();
  private readonly specs: BlockSpec[] = [];

  constructor(
    private readonly ctx: Context,
    private readonly side: TargetSide
  ) {}

  private get support(): Support {
    return this.ctx.support;
  }

  private newVar(prefix: string): string {
    const n = this.counters.get(prefix) ?? 0;
    this.counters.set(prefix, n + 1);
    const name = `${prefix}${n}`;
    this.model.binaries.push(name);
    return name;
  }

  private handleOf(id: SwimmerId): Handle {
    const name = this.side.candidateVar.get(id);
    return name !== undefined ? { kind: 'var', name } : { kind: 'role', role: this.side.baseRole.get(id) };
  }

  /** y: the AND of the variable legs of a relay, shared by relays with the same legs. */
  private and(names: readonly string[]): Expr {
    if (names.length === 1) return variable(names[0] as string);
    const key = names.join(',');
    const known = this.andCache.get(key);
    if (known) return known;
    const y = this.newVar('y');
    for (const n of names) this.model.rows.push(row(minus(variable(y), variable(n)), '<=', 0));
    this.model.rows.push(row(minus(variable(y), total(names.map(variable))), '>=', -(names.length - 1)));
    const e = variable(y);
    this.andCache.set(key, e);
    return e;
  }

  /** The counting indicator of an entry: 1 when it is on the scoring roster. `null`: an exhibition swimmer, the entry leaves the places. */
  private z(r: Resolved): Expr | null {
    const handles = r.swimmerIds.map((id) => this.handleOf(id));
    if (handles.some((h) => h.kind === 'role' && h.role === 'exhibition')) return null;
    if (r.entry.kind === 'individual') {
      const h = handles[0] as Handle;
      return h.kind === 'var' ? variable(h.name) : konst(h.role === 'scorer' ? 1 : 0);
    }
    if (!this.support.mustBeScorers) return konst(1);
    const names = new Set<string>();
    for (const h of handles) {
      if (h.kind === 'var') names.add(h.name);
      else if (h.role !== 'scorer') return konst(0);
    }
    return names.size === 0 ? konst(1) : this.and([...names].sort(cmp));
  }

  /** Non-target entries are constants: whether each stands in the places. A relay over a numeric cap leaves them. */
  private nonTargetIn(sorted: readonly Resolved[], isRelay: boolean): Map<string, boolean> {
    const { support } = this;
    const stands = new Map<string, boolean>();
    const counting = new Map<TeamId, number>();
    for (const r of sorted) {
      if (r.entry.teamId === this.side.team) continue;
      const z = this.z(r);
      if (z === null) stands.set(r.key, false);
      else if (z.c === 0) stands.set(r.key, support.holds);
      else if (isRelay && support.relayCap !== 'unlimited') {
        const used = counting.get(r.entry.teamId) ?? 0;
        counting.set(r.entry.teamId, used + 1);
        stands.set(r.key, used < support.relayCap);
      } else stands.set(r.key, true);
    }
    return stands;
  }

  /** The target's first `cap` counting relays, in rank order, stand; the later ones leave the places. */
  private standing(zs: readonly { readonly key: string; readonly z: Expr }[], cap: number, entries: Map<string, TEntry>): void {
    let ahead = konst(0);
    for (const { key, z } of zs) {
      const st = this.standingOne(z, ahead, cap);
      // A held relay keeps its place under 'holds-place'; a counting relay over the cap leaves.
      entries.set(key, { inE: this.support.holds ? plus(minus(konst(1), z), st) : st, scE: st });
      ahead = plus(ahead, z);
    }
  }

  private standingOne(z: Expr, ahead: Expr, cap: number): Expr {
    const isConst = z.t.size === 0;
    if (hi(ahead) < cap) return z;
    if (lo(ahead) >= cap || (isConst && z.c === 0)) return konst(0);
    const { rows } = this.model;
    const w = this.newVar('w');
    rows.push(row(plus(ahead, { c: 0, t: new Map([[w, cap]]) }), '>=', cap));
    const k = hi(ahead);
    rows.push(row(plus(ahead, { c: 0, t: new Map([[w, k - cap + 1]]) }), '<=', k));
    if (isConst) return variable(w);
    const s = this.newVar('t');
    rows.push(row(minus(variable(s), z), '<=', 0));
    rows.push(row(minus(variable(s), variable(w)), '<=', 0));
    rows.push(row(minus(variable(s), plus(z, variable(w))), '>=', -1));
    return variable(s);
  }

  /** The target's entries as expressions of the variables. */
  private targetEntries(sorted: readonly Resolved[], isRelay: boolean): Map<string, TEntry> {
    const { support } = this;
    const entries = new Map<string, TEntry>();
    const capped: { key: string; z: Expr }[] = [];
    for (const r of sorted) {
      if (r.entry.teamId !== this.side.team) continue;
      const z = this.z(r);
      if (z === null) entries.set(r.key, { inE: konst(0), scE: konst(0) });
      else if (isRelay && support.relayCap !== 'unlimited') capped.push({ key: r.key, z });
      else entries.set(r.key, { inE: support.holds ? konst(1) : z, scE: z });
    }
    if (capped.length > 0) this.standing(capped, support.relayCap as number, entries);
    return entries;
  }

  /** The blocks of one event: equal values under 'split', one entry under 'ordered', in rank order. */
  private addEvent(field: readonly Resolved[]): void {
    const { support } = this;
    const team = this.side.team;
    const timed = field.filter((r) => r.value !== null);
    if (!timed.some((r) => r.entry.teamId === team)) return;
    const kind = (timed[0] as Resolved).event.kind;
    const diving = kind === 'diving';
    const isRelay = kind === 'relay';
    const table = isRelay ? support.tables.relay : diving ? support.tables.diving : support.tables.individual;
    const at = (r: Resolved): number => this.ctx.lineIndex.get(r.key) as number;
    const sorted = [...timed].sort((a, b) => (diving ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)) || at(a) - at(b));
    const stands = this.nonTargetIn(sorted, isRelay);
    const entries = this.targetEntries(sorted, isRelay);

    const groups: Resolved[][] = [];
    for (const r of sorted) {
      const last = groups[groups.length - 1];
      if (support.ties === 'split' && last && (last[0] as Resolved).value === r.value) last.push(r);
      else groups.push([r]);
    }
    let nonTargetAhead = 0;
    let targetAhead: Expr = konst(0);
    for (const group of groups) {
      const mine = group.filter((r) => r.entry.teamId === team).map((r) => entries.get(r.key) as TEntry);
      const others = group.filter((r) => r.entry.teamId !== team && stands.get(r.key) === true).length;
      if (mine.length > 0) {
        const ci = total(mine.map((e) => e.inE));
        this.specs.push({ a: nonTargetAhead, k: others, table, ci, cs: total(mine.map((e) => e.scE)), m: targetAhead });
        targetAhead = plus(targetAhead, ci);
      }
      nonTargetAhead += others;
    }
  }

  /** The scale: the least common multiple of the tie group sizes that can earn a share. */
  private groupScale(): number {
    let scaleD = 1;
    for (const s of this.specs) {
      if (hi(s.cs) < 1) continue;
      for (let ci = Math.max(1, lo(s.ci)); ci <= hi(s.ci); ci++) scaleD = lcm(scaleD, s.k + ci);
    }
    return scaleD;
  }

  private emitBlock(s: BlockSpec, scaleD: number): void {
    const { model } = this;
    const combos: { m: number; ci: number; cs: number; coef: number }[] = [];
    for (let m = Math.max(0, lo(s.m)); m <= hi(s.m); m++) {
      for (let ci = Math.max(0, lo(s.ci)); ci <= hi(s.ci); ci++) {
        for (let cs = Math.max(0, lo(s.cs)); cs <= Math.min(hi(s.cs), ci); cs++) {
          const coef = cs === 0 ? 0 : cs * placeSum(s.table, s.a + m, s.k + ci) * (scaleD / (s.k + ci));
          combos.push({ m, ci, cs, coef });
        }
      }
    }
    if (combos.length === 0) return;
    if (combos.length === 1) {
      model.pointConstant += (combos[0] as { coef: number }).coef;
      return;
    }
    const us = combos.map((c) => ({ ...c, name: this.newVar('u') }));
    model.rows.push(row(total(us.map((u) => variable(u.name))), '=', 1));
    const link = (pick: (c: { m: number; ci: number; cs: number }) => number, e: Expr): void => {
      if (lo(e) === hi(e)) return;
      model.rows.push(row(minus(total(us.map((u) => ({ c: 0, t: new Map([[u.name, pick(u)]]) }))), e), '=', 0));
    };
    link((c) => c.ci, s.ci);
    link((c) => c.cs, s.cs);
    link((c) => c.m, s.m);
    for (const u of us) if (u.coef !== 0) model.pointTerms.push([u.name, u.coef]);
  }

  build(candidates: readonly SwimmerId[], weightOf: (id: SwimmerId) => number, spotLimit: number): Model {
    const { model } = this;
    candidates.forEach((id, i) => {
      const name = `x${i}`;
      model.binaries.push(name);
      model.spotTerms.push([name, weightOf(id)]);
    });
    model.rows.push(row({ c: 0, t: new Map(model.spotTerms) }, '<=', spotLimit));
    for (const { gender, field } of this.ctx.fields) if (gender === this.side.gender) this.addEvent(field);
    const scaleD = this.groupScale();
    for (const s of this.specs) this.emitBlock(s, scaleD);
    model.scale = scaleD * this.support.decScale;
    return model;
  }
}

function buildModel(
  ctx: Context,
  team: TeamId,
  gender: Gender,
  candidates: readonly SwimmerId[],
  baseRole: ReadonlyMap<SwimmerId, ScorerRole>,
  weightOf: (id: SwimmerId) => number,
  spotLimit: number
): Model {
  const candidateVar = new Map<SwimmerId, string>(candidates.map((id, i) => [id, `x${i}`]));
  return new ModelBuilder(ctx, { team, gender, candidateVar, baseRole }).build(candidates, weightOf, spotLimit);
}


/** The model as CPLEX-LP text. `constant` is the objective's constant, carried by the column `one`, which is fixed at 1. */
function render(model: Model, objective: readonly (readonly [string, number])[], extra: readonly Row[], constant = 0): string {
  const lines: string[] = ['Maximize', ` obj: ${formatInt(constant)} one${objective.length > 0 ? ` ${termsText(objective)}` : ''}`, 'Subject To'];
  [...model.rows, ...extra].forEach((r, i) => {
    const body = r.terms.length === 0 ? '0 one' : termsText(r.terms);
    lines.push(` c${i}: ${body} ${r.op} ${formatInt(r.rhs)}`);
  });
  lines.push('Bounds', ' one = 1', 'Binary');
  for (let i = 0; i < model.binaries.length; i += 12) lines.push(` ${model.binaries.slice(i, i + 12).join(' ')}`);
  lines.push('End');
  return lines.join('\n');
}

const termsExpr = (terms: readonly (readonly [string, number])[]): Expr => ({ c: 0, t: new Map(terms) });

/** The value of a binary column, or a loud failure: a missing or fractional column is never read as 0. */
function readColumn(columns: Readonly<Record<string, number>>, name: string): number {
  const v = columns[name];
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v - Math.round(v)) > 1e-6) {
    return fail('suggest_model_mismatch', `the solver returned no whole value for column ${name}`);
  }
  return Math.round(v);
}

/* -------------------------------------------------------------------------- */
/* suggestScoringRosters                                                      */
/* -------------------------------------------------------------------------- */

export async function suggestScoringRosters(req: RosterSuggestRequest, solve: LpSolve): Promise<readonly RosterSuggestion[]> {
  const support = checkSupported(req.rules);
  for (const tag of req.coachTags) {
    if (tag.source !== undefined) {
      fail('suggested_tag_in_input', `the tag for swimmer "${tag.swimmerId}" on team "${tag.teamId}" is marked "${tag.source}"; pass only coach tags`, tag.swimmerId);
    }
  }
  const targetMap = new Map<string, { teamId: TeamId; gender: Gender }>();
  for (const t of req.targets) {
    if (t.teamId === req.ownTeamId) fail('target_is_own_team', `team "${t.teamId}" is the coach's own team; its roster is the coach's`, t.teamId);
    targetMap.set(sideKey(t.teamId, t.gender), { teamId: t.teamId, gender: t.gender });
  }
  const targets = [...targetMap.values()].sort((a, b) => cmp(a.teamId, b.teamId) || cmp(a.gender, b.gender));
  for (const t of targets) {
    if (!req.lineup.entries.some((e) => e.teamId === t.teamId && e.gender === t.gender)) {
      fail('target_without_entries', `team "${t.teamId}" (${t.gender}) has no entry in the lineup`, t.teamId);
    }
  }

  const index = buildIndex(req.model);
  const swimmerSide = new Map<SwimmerId, { teamId: TeamId; gender: Gender }>();
  for (const s of [...req.model.swimmers].sort((a, b) => cmp(a.swimmerId, b.swimmerId))) swimmerSide.set(s.swimmerId, { teamId: s.teamId, gender: s.gender });
  const entered = enteredBySide(req.lineup, swimmerSide);

  // Preflight: every target counts every entered swimmer. scoreMeet then names an untagged non-target side
  // (`scoring_roster_missing`), a bad tag, or a lineup the model cannot place, before any solve.
  const coachRoles = new Map<SwimmerId, ScorerRole>();
  for (const t of req.coachTags) coachRoles.set(t.swimmerId, t.role);
  const early: Context = {
    req, support, resolved: [], lineIndex: new Map(), fields: [], entered, swimmerSide, coachRoles, dives: new Set(), relays: new Set(), targets,
  };
  scoreMeet(req.model, req.lineup, [...req.coachTags, ...fillTags(early, null)], req.rules, req.sourcing);

  const { resolved } = resolveLineup(req.model, req.lineup, index);
  const fieldOf = groupFields(resolved);
  const fields = [...fieldOf.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([, field]) => ({ gender: (field[0] as Resolved).gender, field }));
  const dives = new Set<SwimmerId>();
  const relays = new Set<SwimmerId>();
  for (const r of resolved) {
    if (r.entry.kind === 'relay') r.swimmerIds.forEach((id) => relays.add(id));
    else if (r.event.kind === 'diving') dives.add(r.entry.swimmerId);
  }
  const ctx: Context = {
    ...early,
    resolved,
    lineIndex: new Map(resolved.map((r, i) => [r.key, i])),
    fields,
    dives,
    relays,
  };

  const out: RosterSuggestion[] = [];
  for (const t of targets) out.push(await suggestOne(ctx, t.teamId, t.gender, solve));
  return out;
}

/**
 * The three stages (D2 3.14): the most points P*, then the most spots with P* points, then the lowest swimmer ids.
 * `null`: the solver did not prove an optimum. Every result is checked against its own columns.
 */
async function optimize(
  built: Model,
  candidates: readonly SwimmerId[],
  team: TeamId,
  solve: LpSolve
): Promise<{ readonly chosen: readonly SwimmerId[]; readonly best: number } | null> {
  const pointsTotal = (columns: Readonly<Record<string, number>>): number =>
    built.pointConstant + built.pointTerms.reduce((s, [name, k]) => s + k * readColumn(columns, name), 0);
  const spotsTotal = (columns: Readonly<Record<string, number>>): number => built.spotTerms.reduce((s, [name, k]) => s + k * readColumn(columns, name), 0);
  const pointsExpr = termsExpr(built.pointTerms);
  const spotsExpr = termsExpr(built.spotTerms);
  /** The points of a solution, constant included, are at least `p`. */
  const pointRows = (p: number): Row[] => [row(pointsExpr, '>=', p - built.pointConstant)];
  const maxCoefficients = built.pointTerms.reduce((s, [, k]) => s + Math.abs(k), 0) + built.pointConstant;
  if (!Number.isSafeInteger(maxCoefficients) || maxCoefficients > 2 ** 40) {
    return fail('suggest_model_mismatch', `the objective scale ${built.scale} is too large for an exact solve`, team);
  }

  const solved = async (objective: readonly (readonly [string, number])[], extra: readonly Row[], constant = 0): Promise<LpSolution> =>
    solve(render(built, objective, extra, constant), SOLVER_OPTIONS);

  // Stage 1: the most points, P*.
  const first = await solved(built.pointTerms, [], built.pointConstant);
  if (first.status !== 'Optimal') return null;
  const best = Math.round(first.objective);
  if (Math.abs(first.objective - best) > 1e-6 || pointsTotal(first.columns) !== best) {
    return fail('suggest_model_mismatch', `stage 1: the solver reports ${first.objective}, its columns give ${pointsTotal(first.columns)}`, team);
  }

  // Stage 2: the most spots with at least P* points, S*.
  const second = await solved(built.spotTerms, pointRows(best));
  if (second.status === 'Infeasible') {
    return fail('suggest_model_mismatch', `stage 2: no roster reaches the ${best} points that stage 1 reported`, team);
  }
  if (second.status !== 'Optimal') return null;
  const bestSpots = Math.round(second.objective);
  if (spotsTotal(second.columns) !== bestSpots || pointsTotal(second.columns) < best) {
    return fail('suggest_model_mismatch', 'stage 2: the solver result does not match its columns', team);
  }

  // Stage 3: the lowest swimmer ids. Walk the candidates in ascending id order and keep every decision.
  let current = second.columns;
  const decided: Row[] = [];
  const xName = (i: number): string => `x${i}`;
  for (let i = 0; i < candidates.length; i++) {
    const name = xName(i);
    if (readColumn(current, name) === 1) {
      decided.push(row(variable(name), '=', 1));
      continue;
    }
    const attempt = await solved([], [...pointRows(best), row(spotsExpr, '>=', bestSpots), ...decided, row(variable(name), '=', 1)]);
    if (attempt.status === 'Infeasible') {
      decided.push(row(variable(name), '=', 0));
    } else if (attempt.status === 'Optimal') {
      if (readColumn(attempt.columns, name) !== 1 || pointsTotal(attempt.columns) < best || spotsTotal(attempt.columns) < bestSpots) {
        return fail('suggest_model_mismatch', `stage 3: the solver result for ${candidates[i]} does not match its constraints`, team);
      }
      current = attempt.columns;
      decided.push(row(variable(name), '=', 1));
    } else {
      return null;
    }
  }

  return { chosen: candidates.filter((_, i) => readColumn(current, xName(i)) === 1), best };
}

async function suggestOne(ctx: Context, team: TeamId, gender: Gender, solve: LpSolve): Promise<RosterSuggestion> {
  const { req, support } = ctx;
  const key = sideKey(team, gender);
  const side = ctx.entered.get(key) ?? [];
  const den = support.weight.denominator;
  const weightOf = (id: SwimmerId): number => (ctx.dives.has(id) && !ctx.relays.has(id) ? support.weight.numerator : den);

  // Coach tags of this side are pins. A swimmer of the side with no coach tag and an entry is a candidate.
  const pinnedOn: SwimmerId[] = [];
  for (const [id, role] of ctx.coachRoles) {
    const s = ctx.swimmerSide.get(id);
    if (role === 'scorer' && s && s.teamId === team && s.gender === gender) pinnedOn.push(id);
  }
  const candidates = side.filter((id) => !ctx.coachRoles.has(id));
  const pinnedWeight = pinnedOn.reduce((sum, id) => sum + weightOf(id), 0);
  const candidateWeight = candidates.reduce((sum, id) => sum + weightOf(id), 0);

  const referenceTags = (roster: readonly ScorerTag[]): ScorerTag[] => [...req.coachTags, ...fillTags(ctx, key), ...roster];
  const suggestedTags = (ids: readonly SwimmerId[]): ScorerTag[] => ids.map((swimmerId) => ({ teamId: team, swimmerId, role: 'scorer', source: 'suggested' }));
  const absent = (reason: 'pins_over_size' | 'solver_not_optimal'): RosterSuggestion => ({ kind: 'absent', teamId: team, gender, reason });

  const limit = support.size;
  const spotLimit = limit === 'unlimited' ? Infinity : limit * den;
  if (pinnedWeight > spotLimit) return absent('pins_over_size');

  // Shortcut: one more standing entry never lowers its team's points, so when everyone fits, everyone is tagged.
  if (pinnedWeight + candidateWeight <= spotLimit) {
    const tags = suggestedTags(candidates);
    const results = scoreMeet(req.model, req.lineup, referenceTags(tags), req.rules, req.sourcing);
    return {
      kind: 'suggested', teamId: team, gender, tags,
      referencePoints: sidePoints(results, team, gender),
      spots: { numerator: pinnedWeight + candidateWeight, denominator: den },
      method: 'all_entered',
    };
  }

  // The roles outside the target's variables: coach tags and the fill of the other targets.
  const baseRole = new Map<SwimmerId, ScorerRole>(ctx.coachRoles);
  for (const t of fillTags(ctx, key)) baseRole.set(t.swimmerId, t.role);
  const built = buildModel(ctx, team, gender, candidates, baseRole, weightOf, spotLimit - pinnedWeight);
  const optimum = await optimize(built, candidates, team, solve);
  if (optimum === null) return absent('solver_not_optimal');
  const { chosen, best } = optimum;
  const tags = suggestedTags(chosen);
  const results = scoreMeet(req.model, req.lineup, referenceTags(tags), req.rules, req.sourcing);
  const points = sidePoints(results, team, gender);
  const scaled = points * built.scale;
  if (Math.abs(scaled - Math.round(scaled)) >= 1e-6 || Math.round(scaled) !== best) {
    return fail('suggest_model_mismatch', `scoreMeet gives ${points} points (${scaled} scaled); the solver proved ${best}`, team);
  }
  if (results.violations.some((v) => v.kind === 'scoring_team_size' && v.teamId === team && v.gender === gender)) {
    return fail('suggest_model_mismatch', 'the suggested roster is over the scoring-team size', team);
  }
  return {
    kind: 'suggested', teamId: team, gender, tags,
    referencePoints: points,
    spots: { numerator: pinnedWeight + chosen.reduce((s, id) => s + weightOf(id), 0), denominator: den },
    method: 'ilp',
  };
}

