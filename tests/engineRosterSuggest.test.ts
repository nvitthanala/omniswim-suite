/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `suggestScoringRosters` (P3.core-c; plans/2026-10-25/D2-ENGINE-API.md, 3.14). Every fixture is synthetic and every
 * rule is the shipped `nsisc` v4 with the settings a test names changed through `engineTestPresets.set`. No value
 * here is a competition standard. The oracle is `scoreMeet`: the brute force scores every feasible roster through it
 * and the suggestion must equal the best one under the full tie-break (points, spots, lowest swimmer ids).
 */
import { describe, expect, it } from 'vitest';
import loadHighs from 'highs';
import { builtinRulePreset, requireComplete, RosterSuggestError, ScoreMeetError, scoreMeet, suggestScoringRosters } from '@omniswim/engine';
import type {
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  LpSolution,
  LpSolve,
  MeetEvent,
  MeetModel,
  MeetSwim,
  RelaySplit,
  Results,
  RosterSuggestion,
  RulePreset,
  ScorerRole,
  ScorerTag,
} from '@omniswim/engine';
import { set } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const BACK = '100 Backstroke';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';

const EVENTS: MeetEvent[] = [
  { eventKey: FREE, gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null },
  { eventKey: BACK, gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null },
  { eventKey: DIVE, gender: 'Men', kind: 'diving', distanceYards: null, relayKind: null },
  { eventKey: RELAY, gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' },
  { eventKey: FREE, gender: 'Women', kind: 'individual', distanceYards: 100, relayKind: null },
];

// ---- the solver: Node HiGHS, the package the extension worker runs ------------------------------------

let highsPromise: ReturnType<typeof loadHighs> | undefined;

interface CountingSolver extends LpSolve {
  calls: number;
}

/** The extension worker's mapping (apps/extension/src/worker/optimizer.ts): status, objective, primal per column. */
function nodeSolver(tamper = 0): CountingSolver {
  const solve = (async (lp, options) => {
    solve.calls += 1;
    highsPromise ??= loadHighs({});
    const highs = await highsPromise;
    const solution = highs.solve(lp, options as Parameters<typeof highs.solve>[1]);
    const columns: Record<string, number> = {};
    // An infeasible solve has no `Primal`. Read columns only when there is a solution.
    if (solution.Status === 'Optimal') for (const [name, col] of Object.entries(solution.Columns)) columns[name] = col.Primal as number;
    return { status: solution.Status, objective: solution.ObjectiveValue + tamper, columns } satisfies LpSolution;
  }) as CountingSolver;
  solve.calls = 0;
  return solve;
}

// ---- builders ----------------------------------------------------------------------------------

interface Spec {
  id: string;
  team: string;
  free?: number;
  back?: number;
  dive?: number;
  gender?: 'Men' | 'Women';
  roster?: 'member' | 'not_member' | 'unknown';
}

function build(specs: Spec[]): MeetModel {
  const swims: MeetSwim[] = [];
  const splits: RelaySplit[] = [];
  const swim = (id: string, suffix: string, eventKey: string, hundredths: number): void => {
    swims.push({
      swimId: `${id}:${suffix}`,
      swimmerId: id,
      eventKey,
      recordedCourse: 'SCY',
      recordedTime: { text: (hundredths / 100).toFixed(2), hundredths },
      date: null,
      seasonId: null,
      flags: {},
      scy: { kind: 'recorded-scy' },
      origin: ORIGIN,
    });
  };
  for (const s of specs) {
    const free = s.free ?? 5000;
    swim(s.id, 'free', FREE, free);
    if (s.back !== undefined) swim(s.id, 'back', BACK, s.back);
    if (s.dive !== undefined) swim(s.id, 'dive', DIVE, s.dive);
    splits.push({
      splitId: `split-${s.id}`,
      swimmerId: s.id,
      relayEventKey: null,
      legPosition: null,
      start: 'flying',
      legEventKey: FREE,
      split: { text: ((free - 100) / 100).toFixed(2), hundredths: free - 100 },
      course: 'SCY',
      date: null,
      origin: ORIGIN,
    });
  }
  const teamIds = [...new Set(specs.map((s) => s.team))];
  return {
    payloadVersion: 1,
    meetKey: 'synthetic',
    teams: teamIds.map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? ('Men' as const), classYear: null, roster: s.roster ?? 'member' })),
    events: EVENTS,
    swims,
    relaySplits: splits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

const ind = (team: string, swimmerId: string, eventKey: string, gender: 'Men' | 'Women' = 'Men'): LineupEntry => ({
  kind: 'individual',
  teamId: team,
  swimmerId,
  eventKey,
  gender,
  seedSwimId: null,
});
const relay = (team: string, letter: string, ids: readonly string[]): LineupEntry => ({
  kind: 'relay',
  teamId: team,
  eventKey: RELAY,
  gender: 'Men',
  letter,
  legs: ids.map((swimmerId, i) => ({
    swimmerId,
    basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:free` } : { kind: 'split' as const, splitId: `split-${swimmerId}` },
  })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
});
const lineup = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });
const tag = (team: string, swimmerId: string, role: ScorerRole = 'scorer'): ScorerTag => ({ teamId: team, swimmerId, role });
const tags = (team: string, ids: readonly string[], role: ScorerRole = 'scorer'): ScorerTag[] => ids.map((id) => tag(team, id, role));

interface RuleOpts {
  ties?: 'split' | 'ordered';
  holds?: boolean;
  mustBe?: boolean;
  size?: number | 'unlimited';
  relayCap?: number | 'unlimited';
  maxInd?: number | 'unlimited';
}

/** nsisc v4 with the settings a test names changed. Every other setting is the shipped one. */
function rulesOf(opts: RuleOpts = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 4) as RulePreset;
  return requireComplete({
    ...base,
    scoring: {
      ...base.scoring,
      ...(opts.ties ? { ties: set(opts.ties) } : {}),
      ...(opts.holds === undefined ? {} : { nonScorerPlacement: set(opts.holds ? ('holds-place' as const) : ('removed-from-consideration' as const)) }),
    },
    scorers: {
      ...base.scorers,
      ...(opts.mustBe === undefined ? {} : { relayLegsMustBeScorers: set(opts.mustBe) }),
      ...(opts.size === undefined ? {} : { scoringTeamSize: set(opts.size) }),
      ...(opts.relayCap === undefined ? {} : { scoringRelaysPerTeamPerEvent: set(opts.relayCap) }),
    },
    entries: {
      ...base.entries,
      ...(opts.maxInd === undefined ? {} : { maxIndividualPerSwimmer: set(opts.maxInd) }),
    },
  });
}

// ---- the seeded fixtures ------------------------------------------------------------------------

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

/** A shuffled copy. The order of the copy follows the seed, never the input. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

interface Fixture {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly aTags: ScorerTag[];
  /** Team B's swimmers: six swimmers and two divers. */
  readonly bIds: readonly string[];
  readonly cIds: readonly string[];
}

// Few distinct times, so ties are common: a tie fixture is what the lowest-id tie-break and the split shares need.
const TIMES = [4700, 4750, 4800, 4800, 4850, 4900, 4950, 5000];
const DIVES = [24000, 25000, 25000, 26000, 27000, 28000];

function fixture(seed: number): Fixture {
  const next = rng(seed * 7919 + 13);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const aIds = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
  const bSwim = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'];
  const bIds = [...bSwim, 'bd0', 'bd1'];
  const cIds = ['c0', 'c1', 'c2', 'c3'];
  const specs: Spec[] = [
    ...aIds.map((id) => ({ id, team: 'A', free: pick(TIMES), back: pick(TIMES) })),
    { id: 'ad0', team: 'A', free: 5200, dive: pick(DIVES) },
    ...bSwim.map((id) => ({ id, team: 'B', free: pick(TIMES), back: pick(TIMES) })),
    ...['bd0', 'bd1'].map((id) => ({ id, team: 'B', free: 5200, dive: pick(DIVES) })),
    ...cIds.map((id) => ({ id, team: 'C', free: pick(TIMES), back: pick(TIMES) })),
  ];
  const entries: LineupEntry[] = [];
  for (const s of specs) {
    if (s.dive !== undefined) entries.push(ind(s.team, s.id, DIVE));
    else {
      entries.push(ind(s.team, s.id, FREE));
      if (next() < 0.6) entries.push(ind(s.team, s.id, BACK));
    }
  }
  entries.push(relay('A', 'A', aIds.slice(0, 4)), relay('C', 'A', cIds));
  // Two relays of one team never share the same four swimmers: the legacy scorer groups such entries as one
  // (relayEntryGroupKey), which no real meet can produce. The guard refuses that input (D2 3.14 Found).
  const bRelays = 2 + Math.floor(next() * 2);
  const used = new Set<string>();
  for (let i = 0; i < bRelays; i++) {
    let legs: string[];
    do legs = shuffled(bSwim, Math.floor(next() * 1e9)).slice(0, 4);
    while (used.has([...legs].sort().join()));
    used.add([...legs].sort().join());
    entries.push(relay('B', 'ABC'[i] as string, legs));
  }
  // The coach's own side is not always all scorers: a3 (a leg of A's relay) is an exhibition swimmer in some seeds and a5 a
  // non-scorer in others, so the non-target branches (a relay with an exhibition leg, a held or removed non-scorer) meet the oracle.
  const role = (id: string): ScorerRole => (id === 'a3' && seed % 4 >= 2 ? 'exhibition' : id === 'a5' && seed % 3 === 1 ? 'non-scorer' : 'scorer');
  const aTags = [...aIds, 'ad0'].map((id) => tag('A', id, role(id)));
  return { model: build(specs), lineup: lineup(...entries), aTags, bIds, cIds };
}

const optionsOf = (seed: number): RuleOpts => ({
  ties: seed % 2 === 0 ? 'split' : 'ordered',
  holds: Math.floor(seed / 2) % 2 === 1,
  mustBe: Math.floor(seed / 4) % 2 === 0,
  size: 4,
});

// ---- the oracle ---------------------------------------------------------------------------------

const weightOf = (id: string): number => (id.startsWith('bd') ? 1 : 3);

/** Team B's points when its scoring roster is `ids`, scored through `scoreMeet`. Team C counts every entered swimmer. */
function referenceScore(fx: Fixture, rules: CompleteRulePreset, pins: readonly ScorerTag[], ids: readonly string[]): { points: number; results: Results } {
  const all = [...fx.aTags, ...tags('C', fx.cIds), ...pins, ...tags('B', ids)];
  const results = scoreMeet(fx.model, fx.lineup, all, rules, SOURCING);
  return { points: results.teams.find((t) => t.teamId === 'B')?.points as number, results };
}

interface Roster {
  readonly ids: readonly string[];
  readonly points: number;
  readonly spots: number;
}

/** Is `a` better than `b` under the full tie-break: points, then spots, then the lowest swimmer ids. */
function better(a: Roster, b: Roster): boolean {
  if (Math.abs(a.points - b.points) > 1e-9) return a.points > b.points;
  if (a.spots !== b.spots) return a.spots > b.spots;
  const ia = new Set(a.ids);
  const ib = new Set(b.ids);
  const universe = [...new Set([...a.ids, ...b.ids])].sort();
  for (const id of universe) {
    if (ia.has(id) !== ib.has(id)) return ia.has(id);
  }
  return false;
}

function subsets(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << ids.length; mask++) out.push(ids.filter((_, i) => (mask >> i) & 1));
  return out;
}

const spotsOf = (ids: readonly string[]): number => ids.reduce((s, id) => s + weightOf(id), 0);

function score(fx: Fixture, rules: CompleteRulePreset, pins: readonly ScorerTag[], ids: readonly string[]): Roster {
  // scoreMeet refuses a team with no scorer at all, and a team with none scores nothing.
  if (ids.length === 0 && !pins.some((p) => p.teamId === 'B' && p.role === 'scorer')) return { ids: [], points: 0, spots: 0 };
  return { ids: [...ids].sort(), points: referenceScore(fx, rules, pins, ids).points, spots: spotsOf(ids) };
}

/** Every feasible roster of the candidates, scored by `scoreMeet`, and the best under the full tie-break. */
function bruteForceOptimal(fx: Fixture, rules: CompleteRulePreset, pins: readonly ScorerTag[] = [], limit = 12): Roster {
  const pinnedOn = pins.filter((p) => p.teamId === 'B' && p.role === 'scorer').map((p) => p.swimmerId);
  const pinned = new Set(pins.map((p) => p.swimmerId));
  const candidates = fx.bIds.filter((id) => !pinned.has(id));
  const room = limit - spotsOf(pinnedOn);
  let best: Roster | null = null;
  for (const subset of subsets(candidates)) {
    if (spotsOf(subset) > room) continue;
    const r = score(fx, rules, pins, subset);
    if (best === null || better(r, best)) best = r;
  }
  return best as Roster;
}

function request(fx: Fixture, rules: CompleteRulePreset, coachTags: readonly ScorerTag[] = fx.aTags, targets: { teamId: string; gender: 'Men' | 'Women' }[] = [{ teamId: 'B', gender: 'Men' }, { teamId: 'C', gender: 'Men' }]) {
  return { model: fx.model, lineup: fx.lineup, rules, sourcing: SOURCING, coachTags, ownTeamId: 'A', targets };
}

const suggestedOf = (list: readonly RosterSuggestion[], team: string) => {
  const found = list.find((s) => s.teamId === team);
  if (!found || found.kind !== 'suggested') throw new Error(`no suggestion for ${team}: ${JSON.stringify(found)}`);
  return found;
};

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
}

// ---- tests -------------------------------------------------------------------------------------

describe('suggestScoringRosters (D2 3.14)', () => {
  it('1 bruteForceOptimal: 20 seeded fixtures equal the best roster that scoreMeet finds under the full tie-break', async () => {
    const started = Date.now();
    let ilp = 0;
    for (let seed = 0; seed < 20; seed++) {
      const fx = fixture(seed);
      const rules = rulesOf(optionsOf(seed));
      const solver = nodeSolver();
      const list = await suggestScoringRosters(request(fx, rules), solver);
      const b = suggestedOf(list, 'B');
      const expected = bruteForceOptimal(fx, rules);
      expect(b.method, `seed ${seed}`).toBe('ilp');
      ilp += 1;
      expect(b.tags.map((t) => t.swimmerId), `seed ${seed}`).toEqual(expected.ids);
      expect(b.referencePoints, `seed ${seed}`).toBeCloseTo(expected.points, 9);
      expect(b.spots).toEqual({ numerator: expected.spots, denominator: 3 });
      expect(b.tags.every((t) => t.role === 'scorer' && t.source === 'suggested' && t.teamId === 'B')).toBe(true);
      expect(suggestedOf(list, 'C').method).toBe('all_entered');
    }
    expect(ilp).toBe(20);
    // The brute force scores about 180 rosters per fixture. The budget is 30 s (the build brief's stop condition).
    expect(Date.now() - started).toBeLessThan(30000);
  }, 60000);

  it('2 relayTrap: with one spot left, the swimmer who completes a 40-point relay beats the one who scores 20 alone', async () => {
    const specs: Spec[] = [
      { id: 'a0', team: 'A', free: 5500 },
      { id: 'a1', team: 'A', free: 5500 },
      { id: 'a2', team: 'A', free: 5500 },
      { id: 'a3', team: 'A', free: 5500 },
      { id: 'p1', team: 'B', free: 4600 },
      { id: 'p2', team: 'B', free: 4600 },
      { id: 'p3', team: 'B', free: 4600 },
      { id: 'x', team: 'B', free: 4000 },
      { id: 'y', team: 'B', free: 4600 },
    ];
    const model = build(specs);
    const entries = [
      ind('A', 'a0', FREE),
      ind('B', 'x', FREE),
      relay('A', 'A', ['a0', 'a1', 'a2', 'a3']),
      relay('B', 'A', ['p1', 'p2', 'p3', 'y']),
    ];
    const rules = rulesOf({ size: 4, ties: 'split', holds: false, mustBe: true });
    const pins = tags('B', ['p1', 'p2', 'p3']);
    const solver = nodeSolver();
    const list = await suggestScoringRosters(
      { model, lineup: lineup(...entries), rules, sourcing: SOURCING, coachTags: [...tags('A', ['a0', 'a1', 'a2', 'a3']), ...pins], ownTeamId: 'A', targets: [{ teamId: 'B', gender: 'Men' }] },
      solver
    );
    const b = suggestedOf(list, 'B');
    expect(b.method).toBe('ilp');
    expect(b.tags.map((t) => t.swimmerId)).toEqual(['y']);
    // x alone would give 20 (a0 is the only other swimmer in the 100 free, the relay scores nothing: y is off the roster).
    const withX = scoreMeet(model, lineup(...entries), [...tags('A', ['a0', 'a1', 'a2', 'a3']), ...pins, tag('B', 'x')], rules, SOURCING);
    expect(withX.teams.find((t) => t.teamId === 'B')?.points).toBe(20);
    expect(b.referencePoints).toBe(40);
  });

  it('3 noWorseNeighbor: no feasible swap, add or drop beats the result, and a seeded worse roster fails the same checker', async () => {
    const improving = (fx: Fixture, rules: CompleteRulePreset, current: readonly string[]): string[] | null => {
      const now = score(fx, rules, [], current);
      const inSet = new Set(current);
      const neighbors: string[][] = [];
      for (const id of fx.bIds) {
        if (inSet.has(id)) neighbors.push(current.filter((x) => x !== id));
        else neighbors.push([...current, id]);
      }
      for (const out of current) for (const inn of fx.bIds) if (!inSet.has(inn)) neighbors.push([...current.filter((x) => x !== out), inn]);
      for (const n of neighbors) {
        if (spotsOf(n) > 12) continue;
        if (better(score(fx, rules, [], n), now)) return n;
      }
      return null;
    };
    for (const seed of [0, 3, 6, 9, 12, 15]) {
      const fx = fixture(seed);
      const rules = rulesOf(optionsOf(seed));
      const b = suggestedOf(await suggestScoringRosters(request(fx, rules), nodeSolver()), 'B');
      const ids = b.tags.map((t) => t.swimmerId);
      expect(improving(fx, rules, ids), `seed ${seed}`).toBeNull();
      // The seeded worse roster: the top scorer (the swimmer whose removal costs the most points) swapped out for the
      // excluded candidate that earns least, among the swaps that fit the size. It must score strictly less, and the checker
      // must reject it.
      const best = score(fx, rules, [], ids);
      const cost = (id: string): number => best.points - score(fx, rules, [], ids.filter((x) => x !== id)).points;
      // The costliest swimmer that has a swap which fits the size (a diver cannot be swapped for a full swimmer at 12 spots).
      const byCost = [...ids].sort((p, q) => cost(q) - cost(p) || (p < q ? -1 : 1));
      const swapsFor = (top: string): string[][] =>
        fx.bIds
          .filter((id) => !ids.includes(id))
          .map((inn) => ids.filter((x) => x !== top).concat(inn))
          .filter((roster) => spotsOf(roster) <= 12);
      const top = byCost.find((id) => swapsFor(id).length > 0) as string;
      const swaps = swapsFor(top);
      expect(swaps.length, `seed ${seed}`).toBeGreaterThan(0);
      const swapped = swaps.sort((p, q) => score(fx, rules, [], p).points - score(fx, rules, [], q).points)[0] as string[];
      expect(score(fx, rules, [], swapped).points, `seed ${seed} worse`).toBeLessThan(best.points - 1e-9);
      expect(improving(fx, rules, swapped), `seed ${seed} worse`).not.toBeNull();
    }
  }, 60000);

  it('4 diverBoundaryExact: 17 full swimmers and 3 divers fit 54 = 54; with 4 divers exactly one diver is left off', async () => {
    const full = Array.from({ length: 17 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    const divers = ['d0', 'd1', 'd2', 'd3'];
    // The shipped nsisc v4 tables (16 places). Team A has twelve divers who outscore team B's, so B's divers place 13 to 16
    // (4, 3, 2, 1 points). The 17 full swimmers split between the 100 free (9) and the 100 back (8), so each places in the top 9
    // and scores 9 or more. Dropping a full swimmer costs at least 9 points, dropping any diver exactly 1.
    const aDivers = Array.from({ length: 12 }, (_, i) => `ad${String(i).padStart(2, '0')}`);
    const make = (diverIds: readonly string[]) => {
      const specs: Spec[] = [
        { id: 'a0', team: 'A', free: 5200 },
        ...aDivers.map((id, i) => ({ id, team: 'A', free: 5300, dive: 30000 - i * 100 })),
        ...full.map((id, i) => (i < 9 ? { id, team: 'B', free: 4500 + i * 25 } : { id, team: 'B', free: 6000, back: 4600 + i * 25 })),
        ...diverIds.map((id, i) => ({ id, team: 'B', free: 5300, dive: 27000 - i * 500 })),
      ];
      const entries = [
        ind('A', 'a0', FREE),
        ...aDivers.map((id) => ind('A', id, DIVE)),
        ...full.map((id, i) => ind('B', id, i < 9 ? FREE : BACK)),
        ...diverIds.map((id) => ind('B', id, DIVE)),
      ];
      return { model: build(specs), lineup: lineup(...entries) };
    };
    const run = async (diverIds: readonly string[]) => {
      const { model, lineup: lu } = make(diverIds);
      const solver = nodeSolver();
      const list = await suggestScoringRosters(
        { model, lineup: lu, rules: rulesOf(), sourcing: SOURCING, coachTags: tags('A', ['a0', ...aDivers]), ownTeamId: 'A', targets: [{ teamId: 'B', gender: 'Men' }] },
        solver
      );
      return { b: suggestedOf(list, 'B'), solver };
    };
    const three = await run(divers.slice(0, 3));
    expect(three.b.method).toBe('all_entered');
    expect(three.solver.calls).toBe(0);
    expect(three.b.tags).toHaveLength(20);
    expect(three.b.spots).toEqual({ numerator: 54, denominator: 3 });

    const four = await run(divers);
    expect(four.b.method).toBe('ilp');
    const ids = four.b.tags.map((t) => t.swimmerId);
    expect(ids.filter((id) => id.startsWith('f'))).toHaveLength(17);
    // Any diver costs 1 point and every full swimmer at least 9, so a diver is left off. The lowest ids stay: d3 goes.
    expect(ids.filter((id) => id.startsWith('d'))).toEqual(['d0', 'd1', 'd2']);
    expect(four.b.spots).toEqual({ numerator: 54, denominator: 3 });
  });

  it('5 monotoneAddition and allEnteredShortcut', async () => {
    // f(S + s) >= f(S) for scoreMeet on the fixtures: the lemma the shortcut rests on.
    for (const seed of [1, 4, 6, 11]) {
      const fx = fixture(seed);
      const rules = rulesOf(optionsOf(seed));
      const next = rng(seed + 100);
      for (let k = 0; k < 40; k++) {
        const base = fx.bIds.filter(() => next() < 0.5);
        const extra = fx.bIds.filter((id) => !base.includes(id));
        if (extra.length === 0) continue;
        const s = extra[Math.floor(next() * extra.length)] as string;
        // A roster with no scorer at all is refused by scoreMeet, so the smallest set holds one swimmer.
        if (base.length === 0) continue;
        expect(referenceScore(fx, rules, [], [...base, s]).points).toBeGreaterThanOrEqual(referenceScore(fx, rules, [], base).points - 1e-9);
      }
    }
    // When every candidate fits, the result is all of them and the solver is never called.
    const fx = fixture(2);
    const solver = nodeSolver();
    const list = await suggestScoringRosters(request(fx, rulesOf({ ...optionsOf(2), size: 18 })), solver);
    expect(solver.calls).toBe(0);
    expect(suggestedOf(list, 'B').method).toBe('all_entered');
    expect(suggestedOf(list, 'B').tags.map((t) => t.swimmerId)).toEqual([...fx.bIds].sort());
    expect(suggestedOf(list, 'C').tags.map((t) => t.swimmerId)).toEqual([...fx.cIds].sort());
  });

  it('6 pinsHonored: no pinned swimmer is in the output, the pins count toward the size, and the merged tags score', async () => {
    for (const seed of [0, 5, 10, 19]) {
      const fx = fixture(seed);
      const rules = rulesOf(optionsOf(seed));
      const pins = [tag('B', 'b0', 'scorer'), tag('B', 'b1', 'non-scorer'), tag('B', 'b2', 'exhibition')];
      const coach = [...fx.aTags, ...pins];
      const list = await suggestScoringRosters(request(fx, rules, coach), nodeSolver());
      const b = suggestedOf(list, 'B');
      const ids = b.tags.map((t) => t.swimmerId);
      for (const pinned of ['b0', 'b1', 'b2']) expect(ids).not.toContain(pinned);
      // No `duplicate_tag`, and no over-size roster.
      const merged = scoreMeet(fx.model, fx.lineup, [...coach, ...tags('C', fx.cIds), ...b.tags], rules, SOURCING);
      expect(merged.violations.filter((v) => v.kind === 'scoring_team_size' && v.teamId !== 'A')).toEqual([]);
      // The pin (b0 scores, weight 3) is part of the spots, and the optimum is the brute force's.
      expect(b.spots.numerator).toBe(3 + spotsOf(ids));
      const expected = bruteForceOptimal(fx, rules, pins);
      expect(ids, `seed ${seed}`).toEqual(expected.ids);
    }
  }, 60000);

  it('7 pinsOverSize: pins alone over the size are absent with pins_over_size, and no solve runs', async () => {
    const fx = fixture(0);
    const pins = tags('B', ['b0', 'b1', 'b2', 'b3', 'b4']);
    const solver = nodeSolver();
    const list = await suggestScoringRosters(request(fx, rulesOf({ size: 4 }), [...fx.aTags, ...pins]), solver);
    const b = list.find((s) => s.teamId === 'B');
    expect(b).toEqual({ kind: 'absent', teamId: 'B', gender: 'Men', reason: 'pins_over_size' });
    expect(solver.calls).toBe(0);
  });

  it('8 ownTeamRefusals: an untagged own team throws scoring_roster_missing; the own team as a target throws target_is_own_team', async () => {
    const fx = fixture(0);
    const rules = rulesOf(optionsOf(0));
    const missing = await failure(() => suggestScoringRosters(request(fx, rules, []), nodeSolver()));
    expect(missing).toBeInstanceOf(ScoreMeetError);
    expect((missing as ScoreMeetError).code).toBe('scoring_roster_missing');
    expect((missing as ScoreMeetError).teamIds).toEqual(['A']);
    const own = await failure(() => suggestScoringRosters(request(fx, rules, fx.aTags, [{ teamId: 'A', gender: 'Men' }]), nodeSolver()));
    expect(own).toBeInstanceOf(RosterSuggestError);
    expect((own as RosterSuggestError).code).toBe('target_is_own_team');
    const none = await failure(() => suggestScoringRosters(request(fx, rules, fx.aTags, [{ teamId: 'B', gender: 'Women' }]), nodeSolver()));
    expect((none as RosterSuggestError).code).toBe('target_without_entries');
  });

  it('9 orderIndependence: permuting teams, swimmers, tags and targets gives a deep-equal result', async () => {
    for (const seed of [0, 7, 13]) {
      const fx = fixture(seed);
      const rules = rulesOf(optionsOf(seed));
      const pins = [tag('B', 'b3', 'scorer'), tag('C', 'c0', 'non-scorer')];
      const base = await suggestScoringRosters(request(fx, rules, [...fx.aTags, ...pins]), nodeSolver());
      const model: MeetModel = { ...fx.model, teams: shuffled(fx.model.teams, seed + 1), swimmers: shuffled(fx.model.swimmers, seed + 2) };
      const permuted = await suggestScoringRosters(
        request({ ...fx, model }, rules, shuffled([...fx.aTags, ...pins], seed + 3), shuffled([{ teamId: 'B', gender: 'Men' as const }, { teamId: 'C', gender: 'Men' as const }], seed + 4)),
        nodeSolver()
      );
      expect(permuted).toEqual(base);
    }
  });

  it('10 entryLimitsUntouched: the entry_cap violations are the same with and without the suggestions, and no roster warning follows', async () => {
    const fx = fixture(3);
    const rules = rulesOf({ ...optionsOf(3), maxInd: 1 });
    const list = await suggestScoringRosters(request(fx, rules), nodeSolver());
    const merged = [...fx.aTags, ...list.flatMap((s) => (s.kind === 'suggested' ? s.tags : []))];
    const withSuggestions = scoreMeet(fx.model, fx.lineup, merged, rules, SOURCING);
    const everyone = scoreMeet(fx.model, fx.lineup, [...fx.aTags, ...tags('B', fx.bIds), ...tags('C', fx.cIds)], rules, SOURCING);
    const caps = (r: Results) => r.violations.filter((v) => v.kind === 'entry_cap');
    expect(caps(withSuggestions).length).toBeGreaterThan(0);
    expect(caps(withSuggestions)).toEqual(caps(everyone));
    const own = (v: { teamId?: string }) => v.teamId === 'B' || v.teamId === 'C';
    expect(withSuggestions.violations.filter((v) => (v.kind === 'scorer_without_entry' || v.kind === 'scoring_team_size') && own(v))).toEqual([]);
  });

  it('11 sourceIgnored: scoreMeet ignores `source`, and an input tag marked suggested throws suggested_tag_in_input', async () => {
    const fx = fixture(4);
    const rules = rulesOf(optionsOf(4));
    const list = await suggestScoringRosters(request(fx, rules), nodeSolver());
    const suggested = list.flatMap((s) => (s.kind === 'suggested' ? s.tags : []));
    expect(suggested.length).toBeGreaterThan(0);
    const stripped = suggested.map(({ source: _source, ...rest }) => rest);
    const a = scoreMeet(fx.model, fx.lineup, [...fx.aTags, ...suggested], rules, SOURCING);
    const b = scoreMeet(fx.model, fx.lineup, [...fx.aTags, ...stripped], rules, SOURCING);
    expect(a).toEqual(b);
    const bad = await failure(() => suggestScoringRosters(request(fx, rules, [...fx.aTags, { ...tag('B', 'b0'), source: 'suggested' as const }]), nodeSolver()));
    expect((bad as RosterSuggestError).code).toBe('suggested_tag_in_input');
    expect((bad as RosterSuggestError).subject).toBe('b0');
  });

  it('12 solverNotOptimal: a time-limit status gives absent and no roster', async () => {
    const fx = fixture(0);
    const stub: LpSolve = async () => ({ status: 'Time limit reached', objective: 123, columns: { x0: 1 } });
    const list = await suggestScoringRosters(request(fx, rulesOf(optionsOf(0))), stub);
    expect(list.find((s) => s.teamId === 'B')).toEqual({ kind: 'absent', teamId: 'B', gender: 'Men', reason: 'solver_not_optimal' });
    expect(JSON.stringify(list.find((s) => s.teamId === 'B'))).not.toContain('tags');
  });

  it('13 guardCatchesDrift: a solver that reports another objective, higher or lower, throws suggest_model_mismatch', async () => {
    const fx = fixture(0);
    for (const tamper of [1, -1]) {
      const error = await failure(() => suggestScoringRosters(request(fx, rulesOf(optionsOf(0))), nodeSolver(tamper)));
      expect(error).toBeInstanceOf(RosterSuggestError);
      expect((error as RosterSuggestError).code).toBe('suggest_model_mismatch');
    }
  });

  it('14 unsupportedRules: a numeric per-event cap and a relay cap under holds-place throw', async () => {
    const fx = fixture(0);
    const base = builtinRulePreset('nsisc', 4) as RulePreset;
    const withScorers = (patch: Partial<RulePreset['scorers']>): CompleteRulePreset => requireComplete({ ...base, scorers: { ...base.scorers, ...patch } });
    const numeric = withScorers({ perEventScorerCap: set({ cap: 3, overCap: 'holds-place' as const }) });
    const e1 = await failure(() => suggestScoringRosters(request(fx, numeric), nodeSolver()));
    expect((e1 as RosterSuggestError).code).toBe('suggest_rule_unsupported');
    expect((e1 as RosterSuggestError).subject).toBe('scorers.perEventScorerCap');
    const holdsCap = withScorers({ relayOverCap: set('holds-place' as const) });
    const e2 = await failure(() => suggestScoringRosters(request(fx, holdsCap), nodeSolver()));
    expect((e2 as RosterSuggestError).code).toBe('suggest_rule_unsupported');
    expect((e2 as RosterSuggestError).subject).toBe('scorers.relayOverCap');
    // Unlimited relays under holds-place are inside the set.
    const ok = withScorers({ relayOverCap: set('holds-place' as const), scoringRelaysPerTeamPerEvent: set('unlimited' as const) });
    await expect(suggestScoringRosters(request(fx, ok), nodeSolver())).resolves.toBeDefined();
  });

  it('a swimmer with unknown roster membership is a candidate, and a swimmer with no entry is not', async () => {
    const specs: Spec[] = [
      { id: 'a0', team: 'A', free: 5200 },
      { id: 'u0', team: 'B', free: 4500, roster: 'unknown' },
      { id: 'u1', team: 'B', free: 4600 },
      { id: 'idle', team: 'B', free: 4400 },
    ];
    const model = build(specs);
    const lu = lineup(ind('A', 'a0', FREE), ind('B', 'u0', FREE), ind('B', 'u1', FREE));
    const list = await suggestScoringRosters(
      { model, lineup: lu, rules: rulesOf(), sourcing: SOURCING, coachTags: tags('A', ['a0']), ownTeamId: 'A', targets: [{ teamId: 'B', gender: 'Men' }] },
      nodeSolver()
    );
    expect(suggestedOf(list, 'B').tags.map((t) => t.swimmerId)).toEqual(['u0', 'u1']);
  });

  it('a relay cap under relayOverCap exhibition matches the brute force on seeded fixtures', async () => {
    for (const seed of [20, 21, 22, 23]) {
      const fx = fixture(seed);
      const rules = rulesOf({ ...optionsOf(seed), relayCap: 1 });
      const b = suggestedOf(await suggestScoringRosters(request(fx, rules), nodeSolver()), 'B');
      const expected = bruteForceOptimal(fx, rules);
      expect(b.tags.map((t) => t.swimmerId), `seed ${seed}`).toEqual(expected.ids);
      expect(b.referencePoints).toBeCloseTo(expected.points, 9);
    }
  }, 60000);
  it('every solve carries the exact-optimum options of D2 3.14', async () => {
    const fx = fixture(0);
    const seen: Record<string, string | number | boolean>[] = [];
    const real = nodeSolver();
    const spy: LpSolve = async (lp, options) => {
      seen.push({ ...options });
      return real(lp, options);
    };
    await suggestScoringRosters(request(fx, rulesOf(optionsOf(0))), spy);
    expect(seen.length).toBeGreaterThan(2);
    for (const options of seen) {
      expect(options).toEqual({ mip_rel_gap: 0, mip_abs_gap: 0.5, time_limit: 10, random_seed: 0, output_flag: false });
    }
  });

  it('guardCatchesModelDrift: a solver whose model lost its linking rows is caught by scoreMeet', async () => {
    const fx = fixture(0);
    const real = nodeSolver();
    // Drop every linking equality ("... = 0"). The columns and the objective stay consistent with each other, so
    // only the comparison against scoreMeet can see that the roster no longer earns the claimed points.
    const broken: LpSolve = async (lp, options) => {
      const [head, rest] = lp.split('Subject To\n') as [string, string];
      const [rows, tailText] = rest.split('\nBounds') as [string, string];
      const kept = rows.split(/\n(?= c\d+:)/).filter((r) => !/= 0$/.test(r.trim()));
      return real([head, 'Subject To', kept.join('\n'), 'Bounds', tailText].join('\n'), options);
    };
    const error = await failure(() => suggestScoringRosters(request(fx, rulesOf(optionsOf(0))), broken));
    expect(error).toBeInstanceOf(RosterSuggestError);
    expect((error as RosterSuggestError).code).toBe('suggest_model_mismatch');
  });

  it('lowestIdWins: equal swimmers for one spot give the lowest swimmer id, not the solver pick', async () => {
    for (const ids of [['z1', 'z2', 'z3', 'z4'], ['z4', 'z3', 'z2', 'z1']]) {
      const specs: Spec[] = [{ id: 'a0', team: 'A', free: 5200 }, ...ids.map((id) => ({ id, team: 'B', free: 4800 }))];
      const lu = lineup(ind('A', 'a0', FREE), ...ids.map((id) => ind('B', id, FREE)));
      const list = await suggestScoringRosters(
        { model: build(specs), lineup: lu, rules: rulesOf({ size: 1, ties: 'ordered' }), sourcing: SOURCING, coachTags: tags('A', ['a0']), ownTeamId: 'A', targets: [{ teamId: 'B', gender: 'Men' }] },
        nodeSolver()
      );
      expect(suggestedOf(list, 'B').tags.map((t) => t.swimmerId)).toEqual(['z1']);
    }
  });

  it('the two genders of one team are separate sides', async () => {
    const specs: Spec[] = [
      { id: 'a0', team: 'A', free: 5200 },
      { id: 'aw0', team: 'A', free: 5200, gender: 'Women' },
      ...['m1', 'm2', 'm3'].map((id, i) => ({ id, team: 'B', free: 4500 + i * 100 })),
      ...['w1', 'w2', 'w3'].map((id, i) => ({ id, team: 'B', free: 4500 + i * 100, gender: 'Women' as const })),
    ];
    const lu = lineup(
      ind('A', 'a0', FREE),
      ind('A', 'aw0', FREE, 'Women'),
      ...['m1', 'm2', 'm3'].map((id) => ind('B', id, FREE)),
      ...['w1', 'w2', 'w3'].map((id) => ind('B', id, FREE, 'Women'))
    );
    const rules = rulesOf({ size: 2 });
    const coachTags = [...tags('A', ['a0', 'aw0'])];
    const list = await suggestScoringRosters(
      { model: build(specs), lineup: lu, rules, sourcing: SOURCING, coachTags, ownTeamId: 'A', targets: [{ teamId: 'B', gender: 'Women' }, { teamId: 'B', gender: 'Men' }] },
      nodeSolver()
    );
    expect(list.map((s) => [s.teamId, s.gender])).toEqual([['B', 'Men'], ['B', 'Women']]);
    expect(suggestedOf(list, 'B').tags.map((t) => t.swimmerId)).toEqual(['m1', 'm2']);
    const women = list.find((s) => s.gender === 'Women');
    expect(women?.kind === 'suggested' ? women.tags.map((t) => t.swimmerId) : null).toEqual(['w1', 'w2']);
    const merged = scoreMeet(build(specs), lu, [...coachTags, ...list.flatMap((s) => (s.kind === 'suggested' ? s.tags : []))], rules, SOURCING);
    expect(merged.violations.filter((v) => v.kind === 'scoring_team_size')).toEqual([]);
  });

});
