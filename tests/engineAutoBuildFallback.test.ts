/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A5: the time limit and the local search fallback (plans/2026-10-25/D5-AUTOBUILDER.md, section 10, 12.5 and
 * amendments 1 and 1a). Every swimmer, time, point value and limit in the synthetic worlds is generated here and is not a
 * competition value; the config C world is the recorded simulator fixture (men, Henderson State and two opponents).
 *
 * The solver is scripted: a wrapper over the Node HiGHS `MipSolve` that answers a chosen call with "Time limit reached", an
 * incumbent and a dual bound. The incumbents are built from the engine's own integer model (the `LpModel` the LP text comes from),
 * so they are real, feasible, and suboptimal on purpose. The independent oracle is `scoreMeet`, run on the returned lineup, and
 * `rowsHold`, which checks an assignment against the rows without the search's incremental bookkeeping.
 */
import { describe, expect, it, vi } from 'vitest';
import { AutoBuildError, autoBuild, builtinRulePreset, requireComplete, scoreMeet } from '@omniswim/engine';
import type {
  AutoBuildLimits,
  AutoBuildRequest,
  AutoBuildResult,
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  LoadPreference,
  MeetEvent,
  MeetModel,
  MipSolution,
  MipSolve,
  RulePreset,
  ScheduledEvent,
  ScorerTag,
  SessionPreset,
} from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { LpBuild } from '../packages/engine/src/autobuilder/lp';
import { assignmentOf, choiceOfCurrent, CLOCK_EVERY, LOCAL_SEARCH_MAX_EVALUATIONS, localSearch, rowsHold } from '../packages/engine/src/autobuilder/localSearch';
import { pointsToBeat, rescale } from '../packages/engine/src/autobuilder/solve';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set, TEST_PROVENANCE } from './engineTestPresets';

// Every LP the engine builds, in order: a scripted solver finds the model of the text it is asked to solve.
const built = vi.hoisted(() => ({ list: [] as unknown[], skew: false, onBuild: null as (() => void) | null }));
vi.mock('../packages/engine/src/autobuilder/lp', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/engine/src/autobuilder/lp')>();
  return {
    ...real,
    buildLp: (...args: Parameters<typeof real.buildLp>) => {
      const plain = real.buildLp(...args);
      // `skew` makes the LP points disagree with the integer model by one: the local search must notice (test 16).
      const build = built.skew ? { ...plain, pointsOf: (columns: Readonly<Record<string, number>>) => plain.pointsOf(columns) + 1 } : plain;
      built.list.push(build);
      built.onBuild?.();
      return build;
    },
  };
});
const buildOf = (lp: string): LpBuild => {
  const found = (built.list as LpBuild[]).find((b) => b.text === lp);
  if (found === undefined) throw new Error('no build for this LP text');
  return found;
};

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const EVENTS = ['50 Freestyle', '100 Freestyle', '100 Backstroke', '100 Butterfly', '200 Individual Medley'];
const DIVE = '1-Meter Diving';
const LIMITS: AutoBuildLimits = { candidatesPerEvent: 6, maxCandidatesPerEvent: 6, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 0, timeLimitSeconds: 60 };

// ---- a seeded generator and the synthetic worlds -------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly tags: readonly ScorerTag[];
  readonly rules: CompleteRulePreset;
  readonly own: string;
  readonly pinned: readonly string[];
}

/** nsisc v4 with the settings a world names. Not a competition value: the caps are chosen so a cap or a load row binds. */
function rulesOf(over: { size?: number; eventCap?: number; individual?: number; total?: number } = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 4) as RulePreset;
  return requireComplete({
    ...base,
    scorers: {
      ...base.scorers,
      ...(over.size === undefined ? {} : { scoringTeamSize: set(over.size) }),
      ...(over.eventCap === undefined ? {} : { perEventScorerCap: set({ cap: over.eventCap, overCap: 'removed-from-consideration' as const }) }),
    },
    entries: {
      ...base.entries,
      maxIndividualPerSwimmer: set(over.individual ?? 'unlimited'),
      maxRelayPerSwimmer: set('unlimited' as const),
      maxTotalPerSwimmer: set(over.total ?? 'unlimited'),
    },
  });
}

/**
 * SYNTHETIC: team A (own) with `pinned` scorers and `free` untagged swimmers, and two opponents of six swimmers. Times are generated
 * and tie-heavy. The own team enters its pinned swimmers in the first two events only, so a better lineup exists.
 */
function world(seed: number, o: { pinned?: number; free?: number; dive?: boolean; rules?: CompleteRulePreset } = {}): World {
  const rand = rng(seed);
  const events: MeetEvent[] = EVENTS.map((eventKey) => ({ eventKey, gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null }));
  if (o.dive === true) events.push({ eventKey: DIVE, gender: 'Men', kind: 'diving', distanceYards: null, relayKind: null });
  const swimmers: MeetModel['swimmers'][number][] = [];
  const swims: MeetModel['swims'][number][] = [];
  const add = (swimmerId: string, team: string): void => {
    swimmers.push({ swimmerId, teamId: team, gender: 'Men', classYear: null, roster: 'member' });
    for (const e of events) {
      if (rand() < 0.15) continue;
      const hundredths = e.kind === 'diving' ? 22000 + Math.floor(rand() * 6) * 500 : 4500 + Math.floor(rand() * 8) * 10;
      swims.push({
        swimId: `${swimmerId}:${e.eventKey}`,
        swimmerId,
        eventKey: e.eventKey,
        recordedCourse: 'SCY',
        recordedTime: { text: (hundredths / 100).toFixed(2), hundredths },
        date: null,
        seasonId: null,
        flags: {},
        scy: { kind: 'recorded-scy' },
        origin: ORIGIN,
      });
    }
  };
  const pinnedN = o.pinned ?? 2;
  const own = Array.from({ length: pinnedN + (o.free ?? 5) }, (_, i) => `a${i}`);
  own.forEach((id) => add(id, 'A'));
  const opp = ['B', 'C'].flatMap((team) => Array.from({ length: 6 }, (_, i) => `${team.toLowerCase()}${i}`).map((id) => ({ id, team })));
  opp.forEach(({ id, team }) => add(id, team));
  const swam = (id: string, eventKey: string): boolean => swims.some((w) => w.swimmerId === id && w.eventKey === eventKey);
  const entries: LineupEntry[] = [];
  const ind = (team: string, swimmerId: string, eventKey: string): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey, gender: 'Men', seedSwimId: null });
  for (const { id, team } of opp) for (const e of events) if (swam(id, e.eventKey) && rand() < 0.6) entries.push(ind(team, id, e.eventKey));
  const pinned = own.slice(0, pinnedN);
  for (const id of pinned) for (const e of events.slice(0, 2)) if (swam(id, e.eventKey)) entries.push(ind('A', id, e.eventKey));
  const enteredOpp = new Set(entries.filter((e) => e.teamId !== 'A').map((e) => (e.kind === 'individual' ? e.swimmerId : '')));
  const model: MeetModel = {
    payloadVersion: 1,
    meetKey: `synthetic-${seed}`,
    teams: ['A', 'B', 'C'].map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
    swimmers,
    events,
    swims,
    relaySplits: [],
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
  return {
    model,
    lineup: { payloadVersion: 1, meetKey: model.meetKey, entries },
    tags: [...pinned.map((swimmerId) => ({ teamId: 'A', swimmerId, role: 'scorer' as const })), ...[...enteredOpp].sort().map((swimmerId) => ({ teamId: opp.find((x) => x.id === swimmerId)?.team ?? 'B', swimmerId, role: 'scorer' as const }))],
    rules: o.rules ?? rulesOf(),
    own: 'A',
    pinned,
  };
}

function configC(): World {
  const { snapshot } = buildSnapshot('C');
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'fallback-config-C', snapshotId: 'test' });
  if (adapted.kind !== 'ready') throw new Error(`config C did not adapt: ${adapted.kind}`);
  const { model, lineup } = adapted.adapted;
  const own = String(model.teams.find((t) => String(t.teamId) === '58')?.teamId ?? (model.teams[0] as { teamId: string }).teamId);
  const mine = model.swimmers.filter((s) => s.teamId === own && s.gender === 'Men').map((s) => s.swimmerId).sort();
  const pinned = mine.slice(0, 3);
  const entered = new Map<string, Set<string>>();
  for (const e of lineup.entries) {
    if (e.teamId === own) continue;
    const ids = entered.get(e.teamId) ?? new Set<string>();
    for (const id of e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId)) ids.add(id);
    entered.set(e.teamId, ids);
  }
  const tags: ScorerTag[] = [
    ...pinned.map((swimmerId) => ({ teamId: own, swimmerId, role: 'scorer' as const })),
    ...[...entered].flatMap(([teamId, ids]) => [...ids].sort().map((swimmerId) => ({ teamId, swimmerId, role: 'scorer' as const }))),
  ];
  return { model, lineup, tags, rules: requireComplete(builtinRulePreset('nsisc', 5) as RulePreset), own, pinned };
}

function request(w: World, over: Partial<AutoBuildRequest> = {}): AutoBuildRequest {
  return { model: w.model, lineup: w.lineup, rules: w.rules, sourcing: SOURCING, tags: w.tags, ownTeamId: w.own as never, genders: ['Men'], objective: { kind: 'max-own' }, load: null, limits: LIMITS, ...over };
}

// ---- the scripted solver ---------------------------------------------------------------------------

const TIME_LIMIT: MipSolution = { status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null };

interface Script {
  /** The restricted solve (the first call). */
  readonly restricted: 'real' | 'current-incumbent' | MipSolution | ((lp: string) => MipSolution);
  /** The relaxed solve (the second call): `'bound'` is "Time limit reached" with the real optimum as the dual bound. */
  readonly relaxed: 'real' | 'bound' | 'time-limit' | { readonly boundAt: number };
  /** Later calls (the tie-break). */
  readonly later: 'real' | 'time-limit';
}

interface Scripted extends MipSolve {
  readonly stages: string[];
  readonly bounds: number[];
}

function scripted(script: Script): Scripted {
  const real = nodeMipSolve();
  let call = 0;
  const solve = (async (lp, options) => {
    call += 1;
    if (call === 1) {
      solve.stages.push('restricted');
      if (script.restricted === 'real') return real(lp, options);
      if (script.restricted === 'current-incumbent') {
        const model = buildOf(lp).model;
        const choice = choiceOfCurrent(model);
        if (choice === null) throw new Error('no current column');
        const { columns } = assignmentOf(model, choice);
        return { ...TIME_LIMIT, incumbent: { objective: buildOf(lp).objectiveOf(columns), columns } };
      }
      return typeof script.restricted === 'function' ? script.restricted(lp) : script.restricted;
    }
    if (call === 2) {
      solve.stages.push('relaxed');
      if (script.relaxed === 'real') return real(lp, options);
      if (script.relaxed === 'bound') {
        const exact = await real(lp, { ...options, time_limit: 30 });
        if (exact.status !== 'Optimal') throw new Error('the relaxed solve for the bound was not Optimal');
        solve.bounds.push(exact.objective);
        return { ...TIME_LIMIT, dualBound: exact.objective };
      }
      if (typeof script.relaxed === 'object') return { ...TIME_LIMIT, dualBound: script.relaxed.boundAt };
      return TIME_LIMIT;
    }
    solve.stages.push('later');
    return script.later === 'real' ? real(lp, options) : TIME_LIMIT;
  }) as Scripted;
  (solve as { stages: string[] }).stages = [];
  (solve as { bounds: number[] }).bounds = [];
  return solve;
}

async function run(w: World, solve: MipSolve, over: Partial<AutoBuildRequest> = {}): Promise<AutoBuildResult> {
  return autoBuild(request(w, over), solve);
}

const proposalOf = (r: AutoBuildResult) => (r.kind === 'improved' ? r.proposal : r.kind === 'current_infeasible' ? r.alternative : null);


// ---- helpers for the tests ---------------------------------------------------------------------------

/** The rules that make a cap, a size row and the event cap bind, so the local optimum is below the optimum in most worlds. */
const TIGHT = (): CompleteRulePreset => rulesOf({ individual: 2, total: 2, size: 6, eventCap: 3 });
const tightWorld = (seed: number, dive = false): World => world(seed + 10, { dive, free: 7, rules: TIGHT() });
/** A world with dives and free swimmers for the load tests (tests 11, 12 and 22). */
const loadWorld = (seed: number): World => world(seed + 10, { dive: true, free: 7, rules: TIGHT() });

const respect = (max: number): LoadPreference => ({ mode: 'respect', maxRacesPerSession: set(max), diving: set('excluded' as const) });
const prefer = (max: number, penalty: number): LoadPreference => ({ mode: 'prefer', maxRacesPerSession: set(max), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(penalty) });

/** SYNTHETIC schedule: timed finals, prelims and finals, and split finals by position, so the races per column differ (g rows). */
function schedule(model: MeetModel): SessionPreset {
  const keys = [...new Set(model.events.map((e) => e.eventKey))].sort();
  return {
    payloadVersion: 1,
    provenance: TEST_PROVENANCE,
    events: keys.map((eventKey, i): ScheduledEvent => {
      if (i % 3 === 0) return { eventKey, gender: 'both', format: { kind: 'timed-final', session: { day: 1, slot: 'evening' } } };
      if (i % 3 === 1) return { eventKey, gender: 'both', format: { kind: 'prelims-finals', prelims: { day: 1, slot: 'morning' }, finals: { day: 1, slot: 'evening' } } };
      return {
        eventKey,
        gender: 'both',
        format: { kind: 'timed-final-split', slowHeats: { day: 1, slot: 'morning' }, fastHeat: { day: 1, slot: 'evening' }, fastHeatSize: set(4), smallFieldSession: set({ day: 1, slot: 'evening' as const }) },
      };
    }),
  };
}

/** The builds an `autoBuild` call made, in order: the first is the restricted LP. */
async function withBuilds<T>(go: () => Promise<T>): Promise<{ value: T; builds: LpBuild[] }> {
  const before = built.list.length;
  const value = await go();
  return { value, builds: (built.list as LpBuild[]).slice(before) };
}

type Proposal = NonNullable<ReturnType<typeof proposalOf>>;

const independentOwn = (w: World, p: Proposal): number => {
  const results = scoreMeet(w.model, p.lineup, p.tagsForScoring, w.rules, SOURCING);
  return (results.teams.find((t) => t.teamId === w.own) as { points: number }).points;
};

async function autoError(go: () => Promise<unknown>): Promise<AutoBuildError> {
  try {
    await go();
  } catch (e) {
    if (e instanceof AutoBuildError) return e;
    throw e;
  }
  throw new Error('did not throw');
}

/** The first real Optimal result a solver gives, kept for the test. */
function recording(): { solve: MipSolve; optimum(): MipSolution } {
  const real = nodeMipSolve();
  let first: MipSolution | null = null;
  return {
    solve: async (lp, options) => {
      const r = await real(lp, options);
      if (first === null && r.status === 'Optimal') first = r;
      return r;
    },
    optimum: () => {
      if (first === null) throw new Error('no Optimal solve was recorded');
      return first;
    },
  };
}

const bySwimmer = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A move that raises the objective, found by fresh recomputation (no incremental bookkeeping): `null` when the choice is a local optimum under M1 and M2. */
function improvingMove(model: LpBuild['model'], choice: readonly number[], objective: number): string | null {
  const better = (next: readonly number[]): boolean => {
    const a = assignmentOf(model, next);
    return a.feasible && a.objective > objective;
  };
  const columnsOf = (e: number): LpBuild['model']['events'][number]['columns'] => (model.events[e] as LpBuild['model']['events'][number]).columns;
  for (let e = 0; e < model.events.length; e++) {
    for (let c = 0; c < columnsOf(e).length; c++) {
      if (c === choice[e]) continue;
      if (better(choice.map((x, i) => (i === e ? c : x)))) return `M1 event ${e} column ${c}`;
    }
  }
  const first = (e: number, members: readonly string[]): number | undefined => {
    const i = columnsOf(e).findIndex((col) => col.members.join('\u0001') === members.join('\u0001'));
    return i < 0 ? undefined : i;
  };
  for (let e1 = 0; e1 < model.events.length; e1++) {
    const p1 = columnsOf(e1)[choice[e1] as number]?.members ?? [];
    for (const s of p1) {
      const without = first(e1, p1.filter((x) => x !== s));
      if (without === undefined) continue;
      for (let e2 = 0; e2 < model.events.length; e2++) {
        if (e2 === e1) continue;
        const p2 = columnsOf(e2)[choice[e2] as number]?.members ?? [];
        if (p2.includes(s)) continue;
        const withS = first(e2, [...p2, s].sort(bySwimmer));
        if (withS === undefined) continue;
        if (better(choice.map((x, i) => (i === e1 ? without : i === e2 ? withS : x)))) return `M2 ${s} from event ${e1} to ${e2}`;
      }
    }
  }
  return null;
}

const CURRENT_THEN_LIMIT: Script = { restricted: 'current-incumbent', relaxed: 'time-limit', later: 'time-limit' };

describe('autoBuild fallback (D5 10, slice A5)', () => {
  it('1 localSearchNeverBelowSeed: from the current state and from random feasible seeds, the result is at least the seed, satisfies every row, and is a local optimum', async () => {
    let compared = 0;
    for (const [seed, dive] of [[1, false], [2, true], [3, false]] as const) {
      const w = tightWorld(seed, dive);
      const { builds } = await withBuilds(() => run(w, scripted(CURRENT_THEN_LIMIT)));
      const build = builds[0] as LpBuild;
      const { model } = build;
      const rand = rng(seed);
      const seeds: (readonly number[])[] = [choiceOfCurrent(model) as number[]];
      for (let draw = 0; draw < 20000 && seeds.length < 5; draw++) {
        const choice = model.events.map((ev) => Math.floor(rand() * ev.columns.length));
        if (assignmentOf(model, choice).feasible) seeds.push(choice);
      }
      expect(seeds.length, `world ${seed} has random feasible seeds`).toBeGreaterThan(2);
      for (const start of seeds) {
        const out = localSearch(model, start);
        expect(out, 'the seed satisfies every row').not.toBeNull();
        const result = out as NonNullable<typeof out>;
        expect(result.objective).toBeGreaterThanOrEqual(result.startObjective);
        expect(result.startObjective).toBe(assignmentOf(model, start).objective);
        // The incremental bookkeeping agrees with a fresh recomputation, and with the LP's own row check.
        const fresh = assignmentOf(model, result.choice);
        expect(fresh.feasible).toBe(true);
        expect(fresh.objective).toBe(result.objective);
        expect(rowsHold(model, result.columns)).toBe(true);
        expect(build.objectiveOf(result.columns)).toBe(result.objective);
        expect(build.pointsOf(result.columns)).toBe(result.objective);
        expect(result.stop).toBe('local-optimum');
        expect(improvingMove(model, result.choice, result.objective), 'no single move improves the result').toBeNull();
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(9);
  }, 300_000);

  it('1b end to end: a time-limited solver with a suboptimal incumbent gives a gate-accepted, strictly better lineup by method "local-search", never above the optimum', async () => {
    for (const seed of [2, 3, 4, 5]) {
      const w = tightWorld(seed);
      const optimum = await run(w, nodeMipSolve());
      expect(optimum.kind).toBe('improved');
      const optimalObjective = (proposalOf(optimum) as Proposal).evaluation.objective;
      const r = await run(w, scripted({ restricted: 'current-incumbent', relaxed: 'bound', later: 'time-limit' }));
      expect(r.kind).toBe('improved');
      const p = proposalOf(r) as Proposal;
      expect(p.method).toBe('local-search');
      expect(p.evaluation.objective).toBeGreaterThan(r.current.objective);
      expect(p.evaluation.objective).toBeLessThanOrEqual(optimalObjective + 1e-9);
      // The independent re-score of the returned lineup is the points the proposal states.
      expect(independentOwn(w, p)).toBeCloseTo(p.evaluation.ownPoints, 9);
      expect(r.proof.solves.map((s) => s.stage)).toEqual(['restricted', 'relaxed', 'tie-break', 'local-search']);
      expect(r.proof.status).not.toBe('proven_optimal');
    }
  }, 300_000);

  it('2 fallbackOnlyAtTimeLimit: an Optimal solve, an Optimal last solve, or an Optimal restricted result runs no local search', async () => {
    const w = tightWorld(3);
    const cases: [string, Script][] = [
      ['every solve Optimal', { restricted: 'real', relaxed: 'real', later: 'real' }],
      ['restricted incumbent, relaxed and tie-break Optimal', { restricted: 'current-incumbent', relaxed: 'real', later: 'real' }],
      ['restricted Optimal, relaxed at the limit', { restricted: 'real', relaxed: 'time-limit', later: 'time-limit' }],
    ];
    for (const [label, script] of cases) {
      const r = await run(w, scripted(script));
      expect(r.proof.solves.map((s) => s.stage), label).not.toContain('local-search');
      expect(proposalOf(r)?.method, label).not.toBe('local-search');
    }
    // The control: the same world with the last solve at its limit does run it.
    const limited = await run(w, scripted(CURRENT_THEN_LIMIT));
    expect(limited.proof.solves.map((s) => s.stage)).toContain('local-search');
  }, 300_000);

  it('3 gapWithIncumbent: a time-limited relaxed solve with a dual bound reports gap = dualBound / D - found, at least 0', async () => {
    const w = tightWorld(4);
    const solve = scripted({ restricted: 'current-incumbent', relaxed: 'bound', later: 'time-limit' });
    const r = await run(w, solve);
    const p = proposalOf(r) as Proposal;
    const { proof } = r;
    expect(proof.upperBound).not.toBeNull();
    expect(proof.gap).not.toBeNull();
    const D = (solve.bounds[0] as number) / (proof.upperBound as number);
    expect(Math.abs(D - Math.round(D))).toBeLessThan(1e-9);
    expect(Math.round(D)).toBeGreaterThanOrEqual(1);
    expect(proof.bestFound).toBeCloseTo(p.evaluation.objective, 9);
    expect(proof.gap).toBeCloseTo((proof.upperBound as number) - proof.bestFound, 9);
    expect(proof.gap as number).toBeGreaterThanOrEqual(0);
    expect(proof.upperBound as number).toBeGreaterThanOrEqual(proof.bestFound);
  }, 120_000);

  it('4 neverProven: a local-search lineup that meets the bound exactly is reported with status "gap" and gap 0, not "proven_optimal"', async () => {
    const w = tightWorld(1);
    // The local search stops at a local optimum below the real optimum (196.67). This fixture's is 192.17 = 11530 / 60 at the scale of 60 (D = 60 here
    // from the tie groups of the field). The relaxed solve is scripted to give a dual bound of exactly that, which stands for a solver whose bound is that tight.
    const FOUND = 11530;
    const D = 60;
    const r = await run(w, scripted({ restricted: 'current-incumbent', relaxed: { boundAt: FOUND }, later: 'time-limit' }));
    const p = proposalOf(r) as Proposal;
    expect(p.method).toBe('local-search');
    // The expected objective is fixed here, not read from the run: the proposal must score it, and whole-meet `scoreMeet` must agree.
    expect(p.evaluation.objective).toBeCloseTo(FOUND / D, 9);
    expect(independentOwn(w, p)).toBeCloseTo(FOUND / D, 9);
    expect(r.proof.upperBound as number).toBeCloseTo(FOUND / D, 9);
    expect(r.proof.gap).toBe(0);
    expect(r.proof.bestFound).toBe(r.proof.upperBound);
    expect(r.proof.status).toBe('gap');
  }, 120_000);

  it('5 label: when the search cannot beat a verified incumbent the method stays "mip-incumbent"', async () => {
    const w = tightWorld(3);
    const rec = recording();
    await run(w, rec.solve);
    const best = rec.optimum();
    const labeled = scripted({ restricted: { ...TIME_LIMIT, incumbent: { objective: best.objective, columns: best.columns } }, relaxed: 'time-limit', later: 'time-limit' });
    const r = await run(w, labeled);
    const p = proposalOf(r) as Proposal;
    expect(p.method).toBe('mip-incumbent');
    expect(r.proof.solves.map((s) => s.stage)).toContain('local-search');
  }, 120_000);

  it('6 seed: with no incumbent the search starts from a feasible current lineup, and an infeasible current lineup seeds nothing', async () => {
    const w = tightWorld(3);
    const fromCurrent = await run(w, scripted({ restricted: TIME_LIMIT, relaxed: 'time-limit', later: 'time-limit' }));
    expect(fromCurrent.kind).toBe('improved');
    expect(proposalOf(fromCurrent)?.method).toBe('local-search');
    expect(fromCurrent.proof.solves.map((s) => s.stage)).toEqual(['restricted', 'relaxed', 'local-search']);
    // A current lineup over the entry cap is not a feasible seed.
    const extra = (eventKey: string): LineupEntry => ({ kind: 'individual', teamId: 'A', swimmerId: 'a0', eventKey, gender: 'Men', seedSwimId: null });
    const over: World = { ...w, lineup: { ...w.lineup, entries: [...w.lineup.entries, extra(EVENTS[2] as string), extra(EVENTS[3] as string)] } };
    const infeasible = await run(over, scripted({ restricted: TIME_LIMIT, relaxed: 'time-limit', later: 'time-limit' }));
    expect(infeasible.kind).not.toBe('improved');
    expect(infeasible.proof.solves.map((s) => s.stage)).not.toContain('local-search');
  }, 120_000);

  it('7 unverified incumbent: values that break a row are never a seed, and the search from the current lineup answers instead', async () => {
    const w = tightWorld(3);
    const { builds } = await withBuilds(() => run(w, scripted(CURRENT_THEN_LIMIT)));
    const build = builds[0] as LpBuild;
    const { model } = build;
    // A column choice that breaks the entry cap: its assignment is whole and self-consistent, but a row fails.
    const rand = rng(99);
    let broken: Record<string, number> | null = null;
    for (let draw = 0; draw < 2000 && broken === null; draw++) {
      const choice = model.events.map((ev) => Math.floor(rand() * ev.columns.length));
      const a = assignmentOf(model, choice);
      if (!a.feasible) broken = a.columns;
    }
    expect(broken).not.toBeNull();
    const columns = broken as Record<string, number>;
    expect(rowsHold(model, columns)).toBe(false);
    const tampered = scripted({ restricted: () => ({ ...TIME_LIMIT, incumbent: { objective: build.objectiveOf(columns), columns } }), relaxed: 'time-limit', later: 'time-limit' });
    // The broken incumbent is not a seed. This fixture is deterministic: the search from the current lineup climbs above the points the
    // broken incumbent claims, so the answer is a valid lineup by "local-search". (When the claim is higher, the gate refuses the
    // incumbent instead: test 20.) The incumbent's own lineup never comes back.
    const climbed = localSearch(model, choiceOfCurrent(model) as number[]) as NonNullable<ReturnType<typeof localSearch>>;
    expect(climbed.objective).toBeGreaterThan(build.pointsOf(columns));
    const r = await run(w, tampered);
    expect(r.kind).toBe('improved');
    const p = proposalOf(r) as Proposal;
    expect(p.method).toBe('local-search');
    expect(r.proof.solves.map((x) => x.stage).at(-1)).toBe('local-search');
    expect(independentOwn(w, p)).toBeCloseTo(p.evaluation.ownPoints, 9);
  }, 120_000);

  it('7b rowsHold: a missing column, a fraction, a value past its bound and a broken row each fail; the real optimum passes', async () => {
    const w = tightWorld(3);
    const rec = recording();
    const { builds } = await withBuilds(() => run(w, rec.solve));
    const { model } = builds[0] as LpBuild;
    const columns = rec.optimum().columns;
    expect(rowsHold(model, columns)).toBe(true);
    const name = model.binaries[0] as string;
    const without = { ...columns };
    delete without[name];
    expect(rowsHold(model, without)).toBe(false);
    expect(rowsHold(model, { ...columns, [name]: 0.5 })).toBe(false);
    expect(rowsHold(model, { ...columns, [name]: 2 })).toBe(false);
    expect(rowsHold(model, { ...columns, [name]: Number.NaN })).toBe(false);
    // The "one column per event" row is an equality: zeroing its columns breaks it.
    const yRow = model.rows.find((r) => r.op === '=' && r.rhs === 1) as (typeof model.rows)[number];
    const flipped = { ...columns };
    for (const [n] of yRow.terms) flipped[n] = 0;
    expect(rowsHold(model, flipped)).toBe(false);
    // A row that is violated by less than the tolerance still holds, and by more does not.
    const cap = model.rows.find((r) => r.op === '<=' && r.terms.length > 0) as (typeof model.rows)[number];
    const used = cap.terms.reduce((s, [n, k]) => s + k * (columns[n] as number), 0);
    expect(used).toBeLessThanOrEqual(cap.rhs);
  }, 120_000);

  it('8 deterministic: the same request, solver script and clock give the same result, and the same seed and budget give the same search', async () => {
    for (const withClock of [false, true]) {
      const results: string[] = [];
      for (let i = 0; i < 2; i++) {
        const w = tightWorld(5, true);
        let t = 0;
        const over = withClock ? { clock: () => (t += 1) } : {};
        const r = await run(w, scripted({ restricted: 'current-incumbent', relaxed: 'bound', later: 'time-limit' }), over);
        const p = proposalOf(r) as Proposal;
        results.push(JSON.stringify({ lineup: p.lineup, method: p.method, objective: p.evaluation.objective, proof: r.proof }));
      }
      expect(results[1], `clock ${withClock}`).toBe(results[0]);
    }
    const w = tightWorld(5, true);
    const { builds } = await withBuilds(() => run(w, scripted(CURRENT_THEN_LIMIT)));
    const { model } = builds[0] as LpBuild;
    const seed = choiceOfCurrent(model) as number[];
    const budgeted = (): { clock: () => number; stopAt: number } => {
      let t = 0;
      return { clock: () => (t += 1), stopAt: 3 };
    };
    const a = localSearch(model, seed, budgeted());
    const b = localSearch(model, seed, budgeted());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a?.stop).toBe('budget');
    // The clock is read once per CLOCK_EVERY moves tried: with this clock the third reading ends the search.
    expect(a?.evaluations).toBe(3 * CLOCK_EVERY);
    const free = localSearch(model, seed);
    expect(free?.stop).toBe('local-optimum');
    expect(free?.moves ?? 0).toBeGreaterThanOrEqual(a?.moves ?? 0);
    expect(free?.objective ?? 0).toBeGreaterThanOrEqual(a?.objective ?? 0);
  }, 300_000);

  it('9 budget: the search stops at min(2 s, the time left), by the request clock', async () => {
    const w = tightWorld(6, true);
    const ends: number[] = [];
    for (const timeLimitSeconds of [120, 9]) {
      // Each clock reading is 700 ms later than the last. The local search ends at the first reading past its allotment.
      let t = 0;
      const clock = (): number => (t += 700);
      const r = await run(w, scripted(CURRENT_THEN_LIMIT), { clock, limits: { ...LIMITS, timeLimitSeconds } });
      const record = r.proof.solves.find((s) => s.stage === 'local-search');
      expect(record, `time limit ${timeLimitSeconds}`).toBeDefined();
      expect(record?.status, `time limit ${timeLimitSeconds}`).toBe('Budget reached');
      ends.push(record?.ms as number);
    }
    // Allotment min(2000, left): 120 s leaves much more than 2 s, so it is 2000 ms and the stop is the first reading at or past it.
    // 9 s leaves 9000 - 1000 (gate reserve) minus the time the earlier stages read, which is under 2000, so the search ends sooner.
    expect(ends[0] as number).toBeGreaterThanOrEqual(2000);
    expect(ends[0] as number).toBeLessThan(2000 + 700 * 3);
    expect(ends[1] as number).toBeLessThan(ends[0] as number);
  }, 300_000);

  it('10 config C: a time-limited solver with the current lineup as the incumbent gives a gate-accepted, strictly better lineup within the 2 s budget', async () => {
    const w = configC();
    const started = performance.now();
    const r = await run(w, scripted(CURRENT_THEN_LIMIT), { clock: () => performance.now(), limits: { ...LIMITS, candidatesPerEvent: 8, maxCandidatesPerEvent: 8, timeLimitSeconds: 30 } });
    const wall = performance.now() - started;
    expect(r.kind).toBe('improved');
    const p = proposalOf(r) as Proposal;
    expect(p.method).toBe('local-search');
    expect(p.evaluation.objective).toBeGreaterThan(r.current.objective);
    expect(independentOwn(w, p)).toBeCloseTo(p.evaluation.ownPoints, 9);
    const record = r.proof.solves.find((s) => s.stage === 'local-search');
    // A wall-clock bound with room for a loaded machine; the exact stop is pinned with a fake clock in tests 9, 14 and 23.
    expect(record?.ms as number).toBeLessThan(3500);
    expect(r.proof.status).toBe('unknown');
    expect(wall).toBeLessThan(60_000);
    process.stderr.write(`CONFIGC wall ${wall.toFixed(0)} ms, local search ${(record?.ms as number).toFixed(0)} ms (${record?.status}), own ${r.current.objective} -> ${p.evaluation.objective}\n`);
  }, 300_000);

  it('11 derivation: on a real restricted optimum, x, g and v follow from the column choices exactly, with a prefer or respect load, and the objective matches', async () => {
    for (const [mode, preference] of [['prefer', prefer(1, 3)], ['respect', respect(2)]] as const) {
      const w = loadWorld(7);
      const load = { schedule: schedule(w.model), preference };
      const rec = recording();
      const { builds } = await withBuilds(() => run(w, rec.solve, { load }));
      const build = builds[0] as LpBuild;
      const columns = rec.optimum().columns;
      const chosen = build.select(columns).chosen;
      const choice = build.model.events.map((ev) => ev.columns.findIndex((c) => chosen.get(ev.id) === c));
      expect(choice.every((c) => c >= 0)).toBe(true);
      const derived = assignmentOf(build.model, choice);
      expect(derived.feasible, mode).toBe(true);
      expect(derived.objective, mode).toBe(build.objectiveOf(columns));
      const kinds = new Set<string>();
      for (const d of build.model.derived) {
        kinds.add(d.kind);
        // The solver reports integers with float noise (1e-16 seen on a board world), so the match is to 1e-9, not exact.
        if (d.kind === 'sum' || d.kind === 'excess' || d.kind === 'any') expect(Math.abs((derived.columns[d.name] as number) - (columns[d.name] as number)), `${mode} ${d.name}`).toBeLessThan(1e-9);
        if (d.kind === 'diver') expect(derived.columns[d.name] as number, d.name).toBeGreaterThanOrEqual((columns[d.name] as number) - 1e-9);
      }
      expect(build.model.derived.some((d) => d.kind === 'sum' && d.name.startsWith('g')), `${mode}: the world has a race count that differs by column (a g row)`).toBe(true);
      expect(build.model.derived.some((d) => d.kind === 'diver'), `${mode}: the world has a diver row`).toBe(true);
      expect(kinds.has('sum')).toBe(true);
      expect(kinds.has('any')).toBe(true);
      if (mode === 'prefer') expect(kinds.has('excess'), 'the world has races above the maximum').toBe(true);
    }
  }, 300_000);

  it('12 load: with a prefer or respect load the local search returns a gate-accepted lineup that is not above the optimum', async () => {
    for (const [mode, preference] of [['prefer', prefer(1, 3)], ['respect', respect(2)]] as const) {
      const w = loadWorld(8);
      const load = { schedule: schedule(w.model), preference };
      const optimum = await run(w, nodeMipSolve(), { load });
      const best = (proposalOf(optimum) as Proposal).evaluation.objective;
      const r = await run(w, scripted(CURRENT_THEN_LIMIT), { load });
      const p = proposalOf(r) as Proposal;
      expect(p.method, mode).toBe('local-search');
      expect(p.evaluation.objective, mode).toBeLessThanOrEqual(best + 1e-9);
      expect(p.evaluation.objective, mode).toBeGreaterThan(r.current.objective);
      expect(p.evaluation.load, mode).not.toBeNull();
    }
  }, 300_000);

  it('13 a current lineup the search cannot beat stays unchanged, with the reason none_found_within_limits', async () => {
    const w = tightWorld(3);
    const optimum = await run(w, nodeMipSolve());
    const best = proposalOf(optimum) as Proposal;
    const settled: World = { ...w, lineup: best.lineup, tags: best.tagsForScoring };
    const r = await run(settled, scripted({ restricted: 'current-incumbent', relaxed: 'bound', later: 'time-limit' }));
    expect(r).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
    expect(r.proof.status).not.toBe('proven_optimal');
  }, 120_000);
});

// ---- mutation-driven additions (synthetic models: every number below is invented for the test) --------------------------------

type Model = LpBuild['model'];
const col = (members: readonly string[]): Model['events'][number]['columns'][number] => ({ members, isCurrent: false }) as never;

/** One event with a choice of `n` single-swimmer columns, one binary each, one "exactly one column" row. */
function oneEvent(n: number, objective: (i: number) => number, extraRows: Model['rows'] = []): Model {
  const ys = Array.from({ length: n }, (_, i) => `y${i}`);
  return {
    rows: [{ terms: ys.map((y) => [y, 1] as const), op: '=', rhs: 1 }, ...extraRows],
    objective: ys.map((y, i) => [y, objective(i)] as const).filter(([, k]) => k !== 0),
    constant: 0,
    binaries: ys,
    generals: [],
    events: [{ id: 'e', ys, columns: ys.map((_, i) => col([`s${i}`])) }],
    derived: [],
  };
}

describe('autoBuild fallback: additions that pin the rules the first tests left open', () => {
  it('14 a time left under the minimum allotment (200 ms) skips the local search', async () => {
    const w = tightWorld(6, true);
    for (const [timeLimitSeconds, runs] of [[4, false], [9, true]] as const) {
      let t = 0;
      const clock = (): number => (t += 700);
      const r = await run(w, scripted(CURRENT_THEN_LIMIT), { clock, limits: { ...LIMITS, timeLimitSeconds } });
      expect(r.proof.solves.some((s) => s.stage === 'local-search'), `time limit ${timeLimitSeconds}`).toBe(runs);
    }
  }, 300_000);

  it('15 a row the seed breaks stops the search, for every row kind; an equality row is checked like the others', () => {
    const free = oneEvent(3, (i) => i);
    expect(localSearch(free, [0])).not.toBeNull();
    const pinned = oneEvent(3, (i) => i, [{ terms: [['y0', 1]], op: '=', rhs: 0 }]);
    expect(localSearch(pinned, [0])).toBeNull();
    expect(localSearch(pinned, [1])).not.toBeNull();
    const atMost = oneEvent(3, (i) => i, [{ terms: [['y0', 1]], op: '<=', rhs: 0 }]);
    expect(localSearch(atMost, [0])).toBeNull();
    const atLeast = oneEvent(3, (i) => i, [{ terms: [['y0', 1]], op: '>=', rhs: 1 }]);
    expect(localSearch(atLeast, [1])).toBeNull();
    expect(localSearch(atLeast, [0])?.objective).toBe(0);
    // A choice index outside the columns is no seed.
    expect(localSearch(free, [7])).toBeNull();
    expect(localSearch(free, [])).toBeNull();
  });

  it('16 the clock is read once per CLOCK_EVERY (64) evaluated moves, and the search climbs to the best of 200 columns', () => {
    const model = oneEvent(200, (i) => i);
    let reads = 0;
    const r = localSearch(model, [0], { clock: () => ++reads, stopAt: Number.POSITIVE_INFINITY });
    expect(CLOCK_EVERY).toBe(64);
    expect(r?.stop).toBe('local-optimum');
    expect(r?.objective).toBe(199);
    expect(r?.evaluations as number).toBeGreaterThan(300);
    expect(reads).toBe(Math.floor((r?.evaluations as number) / 64));
  });

  it('17 a variable the choices do not determine (a relaxed model) is refused, and a value outside a bound fails rowsHold', () => {
    const relaxed: Model = { ...oneEvent(2, (i) => i), rows: [{ terms: [['y0', 1], ['o', 1]], op: '<=', rhs: 1 }], binaries: ['y0', 'y1', 'o'] };
    expect(() => localSearch(relaxed, [0])).toThrow(AutoBuildError);
    const model: Model = { ...oneEvent(2, (i) => i), rows: [{ terms: [['a', 1], ['g', 1]], op: '<=', rhs: 100 }], binaries: ['a'], generals: [{ name: 'g', ub: 3 }] };
    expect(rowsHold(model, { a: 1, g: 3 })).toBe(true);
    for (const bad of [{ a: 2, g: 1 }, { a: -1, g: 1 }, { a: 0.5, g: 1 }, { a: 1, g: 4 }, { a: 1, g: -1 }, { a: 1, g: 1.5 }, { a: 1 }, { g: 1 }]) {
      expect(rowsHold(model, bad as Record<string, number>), JSON.stringify(bad)).toBe(false);
    }
    // Noise below the tolerance is accepted, above it is not.
    expect(rowsHold(model, { a: 1 + 1e-9, g: 3 })).toBe(true);
    expect(rowsHold(model, { a: 1 + 1e-3, g: 3 })).toBe(false);
  });

  it('18 a move of one swimmer to a column whose member set two columns share takes the first column by index', () => {
    // Event A: swimmer s alone, or nobody. Event B: t alone, or {s, t} by column 2 or by a twin, column 3. A row forbids column 3
    // while s stays in A, so only the move of s reaches it, and the move reaches the first of the two twins (worth 0), not the second.
    const model: Model = {
      rows: [
        { terms: [['a0', 1], ['a1', 1]], op: '=', rhs: 1 },
        { terms: [['b0', 1], ['b1', 1], ['b2', 1], ['b3', 1]], op: '=', rhs: 1 },
        { terms: [['a0', 1], ['b3', 1]], op: '<=', rhs: 1 },
        { terms: [['a0', 1], ['b2', 1]], op: '<=', rhs: 1 },
      ],
      objective: [['b3', 10]],
      constant: 0,
      binaries: ['a0', 'a1', 'b0', 'b1', 'b2', 'b3'],
      generals: [],
      events: [
        { id: 'A', ys: ['a0', 'a1'], columns: [col(['s']), col([])] },
        { id: 'B', ys: ['b0', 'b1', 'b2', 'b3'], columns: [col([]), col(['t']), col(['s', 't']), col(['s', 't'])] },
      ],
      derived: [],
    };
    const r = localSearch(model, [0, 1]);
    expect(r?.moves).toBe(0);
    expect(r?.objective).toBe(0);
    expect(r?.choice).toEqual([0, 1]);
  });

  it('19 a model whose points disagree with the LP is a model_mismatch, never a lineup', async () => {
    const w = tightWorld(3);
    built.skew = true;
    try {
      const error = await autoError(() => run(w, scripted(CURRENT_THEN_LIMIT)));
      expect(error.code).toBe('model_mismatch');
      expect(error.message).toContain('local search');
    } finally {
      built.skew = false;
    }
  }, 120_000);

  it('20 an incumbent that breaks a row is not beaten by a worse local search from the current state: the result stays the incumbent and the gate refuses it', async () => {
    const w = tightWorld(3);
    const { builds } = await withBuilds(() => run(w, scripted(CURRENT_THEN_LIMIT)));
    const build = builds[0] as LpBuild;
    const { model } = build;
    const seed = choiceOfCurrent(model) as number[];
    const climbed = localSearch(model, seed);
    expect(climbed !== null && climbed.moves > 0).toBe(true);
    const reach = (climbed as NonNullable<typeof climbed>).objective;
    const rand = rng(7);
    let broken: Record<string, number> | null = null;
    for (let draw = 0; draw < 5000 && broken === null; draw++) {
      const choice = model.events.map((ev) => Math.floor(rand() * ev.columns.length));
      const a = assignmentOf(model, choice);
      if (!a.feasible && build.pointsOf(a.columns) > reach) broken = a.columns;
    }
    expect(broken, 'a broken choice that claims more points than the search reaches').not.toBeNull();
    const columns = broken as Record<string, number>;
    const tampered = scripted({ restricted: () => ({ ...TIME_LIMIT, incumbent: { objective: build.objectiveOf(columns), columns } }), relaxed: 'time-limit', later: 'time-limit' });
    const error = await autoError(() => run(w, tampered));
    expect(error.code).toBe('model_mismatch');
  }, 240_000);
});

describe('autoBuild fallback: seed order', () => {
  it('21 with a verified incumbent and a feasible current lineup, the search starts from the incumbent, not from the current lineup', async () => {
    const w = tightWorld(3);
    const { builds } = await withBuilds(() => run(w, scripted(CURRENT_THEN_LIMIT)));
    const build = builds[0] as LpBuild;
    const { model } = build;
    const fromCurrent = localSearch(model, choiceOfCurrent(model) as number[]) as NonNullable<ReturnType<typeof localSearch>>;
    // A feasible choice that is not the current one, whose climb ends somewhere else than the climb from the current state.
    const rand = rng(21);
    let picked: { columns: Record<string, number>; reach: number } | null = null;
    for (let draw = 0; draw < 5000 && picked === null; draw++) {
      const choice = model.events.map((ev) => Math.floor(rand() * ev.columns.length));
      const a = assignmentOf(model, choice);
      if (!a.feasible) continue;
      const climbed = localSearch(model, choice) as NonNullable<ReturnType<typeof localSearch>>;
      if (climbed.objective > fromCurrent.objective) picked = { columns: a.columns, reach: climbed.objective };
    }
    expect(picked, 'a feasible seed whose climb ends above the climb from the current state').not.toBeNull();
    const columns = (picked as NonNullable<typeof picked>).columns;
    const script = (): Script => ({ restricted: () => ({ ...TIME_LIMIT, incumbent: { objective: build.objectiveOf(columns), columns } }), relaxed: 'time-limit', later: 'time-limit' });
    const fromIncumbent = await run(w, scripted(script()));
    const noIncumbent = await run(w, scripted({ restricted: TIME_LIMIT, relaxed: 'time-limit', later: 'time-limit' }));
    const own = (r: AutoBuildResult): number | null => {
      const p = proposalOf(r);
      return p === null ? null : independentOwn(w, p);
    };
    // The climb from the current state reaches `fromCurrent.objective`; the climb from the incumbent reaches more, and the result shows it.
    expect(own(noIncumbent)).not.toBeNull();
    expect(own(fromIncumbent) as number).toBeGreaterThan(own(noIncumbent) as number);
  }, 240_000);
});

describe('autoBuild fallback: an incumbent that fails the row check never seeds', () => {
  it('22 a feasible incumbent with one derived value the objective does not read tampered is not a seed: the search starts from the current lineup', async () => {
    const w = loadWorld(8);
    const load = { schedule: schedule(w.model), preference: respect(2) };
    const { builds } = await withBuilds(() => run(w, scripted(CURRENT_THEN_LIMIT), { load }));
    const build = builds[0] as LpBuild;
    const { model } = build;
    const fromCurrent = localSearch(model, choiceOfCurrent(model) as number[]) as NonNullable<ReturnType<typeof localSearch>>;
    // A feasible choice whose climb ends above the climb from the current lineup, with a race count (g) the objective does not read.
    const rand = rng(22);
    let picked: { columns: Record<string, number>; tampered: Record<string, number> } | null = null;
    for (let draw = 0; draw < 8000 && picked === null; draw++) {
      const choice = model.events.map((ev) => Math.floor(rand() * ev.columns.length));
      const a = assignmentOf(model, choice);
      if (!a.feasible) continue;
      const climbed = localSearch(model, choice) as NonNullable<ReturnType<typeof localSearch>>;
      if (climbed.objective <= fromCurrent.objective) continue;
      const name = model.derived.map((d) => d.name).find((n) => n.startsWith('g') && (a.columns[n] as number) >= 1);
      if (name === undefined) continue;
      const tampered = { ...a.columns, [name]: (a.columns[name] as number) + 1 };
      if (build.objectiveOf(tampered) === build.objectiveOf(a.columns) && !rowsHold(model, tampered)) picked = { columns: a.columns, tampered };
    }
    expect(picked, 'a feasible seed above the current climb, with a tamperable race count').not.toBeNull();
    const { columns, tampered } = picked as NonNullable<typeof picked>;
    const give = (c: Record<string, number>): Script => ({ restricted: () => ({ ...TIME_LIMIT, incumbent: { objective: build.objectiveOf(c), columns: c } }), relaxed: 'time-limit', later: 'time-limit' });
    const own = (r: AutoBuildResult): number => independentOwn(w, proposalOf(r) as Proposal);
    const clean = await run(w, scripted(give(columns)), { load });
    const broken = await run(w, scripted(give(tampered)), { load });
    const none = await run(w, scripted({ restricted: TIME_LIMIT, relaxed: 'time-limit', later: 'time-limit' }), { load });
    expect(own(clean)).toBeGreaterThan(own(none));
    // The tampered incumbent is no seed: the result is the climb from the current lineup, the same as with no incumbent at all.
    expect(own(broken)).toBe(own(none));
  }, 240_000);
});

describe('autoBuild fallback: the clock covers the LP rebuild', () => {
  it('23 the time the fallback spends rebuilding the LP counts against its allotment', async () => {
    const w = tightWorld(6, true);
    let t = 0;
    const clock = (): number => (t += 100);
    // Every LP build takes 3 s of the request clock. The fallback starts its clock before its own build, so it has used up its 2 s by the time
    // the build is done: the search ends at its first clock check and the record shows the build time.
    built.onBuild = () => {
      t += 3000;
    };
    try {
      const r = await run(w, scripted(CURRENT_THEN_LIMIT), { clock, limits: { ...LIMITS, timeLimitSeconds: 120 } });
      const record = r.proof.solves.find((x) => x.stage === 'local-search');
      expect(record?.status).toBe('Budget reached');
      expect(record?.ms as number).toBeGreaterThanOrEqual(3000);
    } finally {
      built.onBuild = null;
    }
  }, 240_000);
});

describe('autoBuild fallback: opponent session load under respect (D5 amendment 2)', () => {
  /** The session_load warnings of a result whose swimmer is not on the own team (own swimmers are the decision set here). */
  const opponentWarnings = (r: AutoBuildResult): { swimmerId: string; races: number; limit: number }[] =>
    (proposalOf(r)?.newWarnings ?? []).flatMap((v) => (v.kind === 'session_load' && !String(v.swimmerId).startsWith('a') ? [{ swimmerId: String(v.swimmerId), races: v.races, limit: v.limit }] : []));

  it('24 an own change that pushes an opponent over the respect limit builds, and the opponent violation is a new warning, for the MIP and the local search', async () => {
    let seen = 0;
    for (const seed of [0, 1, 7, 12]) {
      const w = world(seed + 10, { dive: true, free: 7, rules: TIGHT() });
      const load = { schedule: schedule(w.model), preference: respect(2) };
      for (const [label, solve] of [['mip', nodeMipSolve()], ['local-search', scripted(CURRENT_THEN_LIMIT)]] as const) {
        const r = await run(w, solve, { load });
        expect(r.kind, `seed ${seed} ${label}`).toBe('improved');
        const warnings = opponentWarnings(r);
        for (const v of warnings) expect(v.races, `seed ${seed} ${label} ${v.swimmerId}`).toBeGreaterThan(v.limit);
        // The own side still obeys the limit: no own swimmer is over it in the built lineup.
        const p = proposalOf(r) as Proposal;
        const own = (p.evaluation.load?.violations ?? []).filter((v) => v.kind === 'session_load' && String(v.swimmerId).startsWith('a'));
        expect(own, `seed ${seed} ${label}`).toEqual([]);
        seen += warnings.length;
      }
    }
    expect(seen, 'the seeds include an opponent pushed over the limit').toBeGreaterThan(0);
  }, 600_000);
});

describe('autoBuild fallback: the bar a local search lineup must clear, on the final scale', () => {
  it('25 the best found is rescaled to the final scale whenever the scales differ, and a fraction after rescaling is a model_mismatch', () => {
    // 10 points at D = 2 are 30 at D = 6. The seed's own points are used only when nothing was found.
    expect(rescale(10, 2, 6)).toBe(30);
    expect(rescale(10, 2, 2)).toBe(10);
    expect(rescale(30, 6, 2)).toBe(10);
    expect(() => rescale(10, 6, 4)).toThrow(AutoBuildError);
    expect(pointsToBeat({ points: 10, scale: { D: 2 } }, 5, 6)).toBe(30);
    expect(pointsToBeat({ points: 10, scale: { D: 6 } }, 5, 6)).toBe(10);
    expect(pointsToBeat(null, 5, 6)).toBe(5);
    expect(() => pointsToBeat({ points: 10, scale: { D: 6 } }, 5, 4)).toThrow(AutoBuildError);
  });
});

describe('autoBuild fallback: the evaluation cap bounds the stage without a clock', () => {
  it('26 a search that needs more evaluations than the cap stops by "budget" at exactly the cap, with or without a clock, and keeps the seed when it found nothing', () => {
    const n = LOCAL_SEARCH_MAX_EVALUATIONS + 1000;
    // Only the last of n columns is better than the seed, and a scan from column 0 reaches it after n - 1 evaluations: past the cap.
    const model = oneEvent(n, (i) => (i === n - 1 ? 1 : 0));
    const none = localSearch(model, [0]) as NonNullable<ReturnType<typeof localSearch>>;
    expect(none.stop).toBe('budget');
    expect(none.evaluations).toBe(LOCAL_SEARCH_MAX_EVALUATIONS);
    expect(none.moves).toBe(0);
    expect(none.objective).toBe(none.startObjective);
    const clocked = localSearch(model, [0], { clock: () => 0, stopAt: Number.POSITIVE_INFINITY }) as NonNullable<ReturnType<typeof localSearch>>;
    expect(clocked.stop).toBe('budget');
    expect(clocked.evaluations).toBe(LOCAL_SEARCH_MAX_EVALUATIONS);
    // A smaller cap given in the budget wins, and a model that fits under the cap ends at its local optimum.
    const small = localSearch(model, [0], { maxEvaluations: 50 }) as NonNullable<ReturnType<typeof localSearch>>;
    expect(small.evaluations).toBe(50);
    expect(small.stop).toBe('budget');
    const fits = localSearch(oneEvent(50, (i) => i), [0]) as NonNullable<ReturnType<typeof localSearch>>;
    expect(fits.stop).toBe('local-optimum');
    expect(fits.objective).toBe(49);
    expect(fits.evaluations).toBeLessThan(LOCAL_SEARCH_MAX_EVALUATIONS);
  });

  it('27 config C with no request clock: the search stops at the cap, the lineup is gate-accepted and strictly better, and the proof is never "proven_optimal"', async () => {
    const w = configC();
    const r = await run(w, scripted(CURRENT_THEN_LIMIT), { limits: { ...LIMITS, candidatesPerEvent: 8, maxCandidatesPerEvent: 8, timeLimitSeconds: 30 } });
    const record = r.proof.solves.find((s) => s.stage === 'local-search');
    // A full climb on config C needs about 190,000 evaluations: the 80,000 cap ends it first.
    expect(record?.status).toBe('Budget reached');
    expect(record?.ms).toBeNull();
    expect(r.kind).toBe('improved');
    const p = proposalOf(r) as Proposal;
    expect(p.method).toBe('local-search');
    expect(p.evaluation.objective).toBeGreaterThan(r.current.objective);
    expect(independentOwn(w, p)).toBeCloseTo(p.evaluation.ownPoints, 9);
    expect(r.proof.status).not.toBe('proven_optimal');
  }, 300_000);
});
