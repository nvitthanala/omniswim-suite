/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A1 (plans/2026-10-25/D5-AUTOBUILDER.md, 2.2, 8.5.1 to 8.5.4 and 12.1). Every fixture is synthetic
 * and every rule is the shipped `nsisc` v4 with the settings a test names changed through `engineTestPresets.set`. No time,
 * point value or standard here is a competition value. The oracle is `scoreMeet`: each brute force scores every own
 * entry set of the search space through a whole-meet `scoreMeet` call and the AutoBuilder must equal the best one.
 *
 * The brute force builds its lineups by its own code (the D5 5.1 position rule: a kept entry stays in place, a new entry is
 * appended after, sorted by entry key), so a drift in the engine's positions shows as a points difference under `'ordered'`.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOBUILD_DEFAULT_LIMITS,
  AutoBuildError,
  autoBuild,
  builtinRulePreset,
  entryKey,
  requireComplete,
  ScoreMeetError,
  scoreMeet,
} from '@omniswim/engine';
import type {
  AutoBuildLimits,
  AutoBuildObjective,
  AutoBuildRequest,
  AutoBuildResult,
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  LoadPreference,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MipSolve,
  PerEventScorerCap,
  RelaySplit,
  RulePreset,
  ScorerTag,
  SessionPreset,
} from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { set, TEST_PROVENANCE } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const BACK = '100 Backstroke';
const FLY = '100 Butterfly';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';
type Gender = 'Men' | 'Women';

const LIMITS: AutoBuildLimits = { candidatesPerEvent: 8, maxCandidatesPerEvent: 12, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 };

// ---- builders ----------------------------------------------------------------------------------

function meetEvent(eventKey: string, gender: Gender = 'Men'): MeetEvent {
  if (eventKey === DIVE) return { eventKey, gender, kind: 'diving', distanceYards: null, relayKind: null };
  if (eventKey === RELAY) return { eventKey, gender, kind: 'relay', distanceYards: 400, relayKind: 'freestyle' };
  return { eventKey, gender, kind: 'individual', distanceYards: 100, relayKind: null };
}

interface Spec {
  readonly id: string;
  readonly team: string;
  /** hundredths per event (a dive: hundredths of a point) */
  readonly times: Readonly<Record<string, number>>;
  readonly gender?: Gender;
  readonly roster?: 'member' | 'not_member' | 'unknown';
}

function buildModel(specs: readonly Spec[], eventKeys: readonly string[], genders: readonly Gender[] = ['Men']): MeetModel {
  const swims: MeetSwim[] = [];
  const splits: RelaySplit[] = [];
  for (const s of specs) {
    for (const [eventKey, hundredths] of Object.entries(s.times)) {
      swims.push({
        swimId: `${s.id}:${eventKey}`,
        swimmerId: s.id,
        eventKey,
        recordedCourse: 'SCY',
        recordedTime: { text: (hundredths / 100).toFixed(2), hundredths },
        date: null,
        seasonId: null,
        flags: {},
        scy: { kind: 'recorded-scy' },
        origin: ORIGIN,
      });
    }
    const free = s.times[FREE];
    if (free !== undefined) {
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
  }
  const teamIds = [...new Set(specs.map((s) => s.team))];
  return {
    payloadVersion: 1,
    meetKey: 'synthetic',
    teams: teamIds.map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? 'Men', classYear: null, roster: s.roster ?? 'member' })),
    events: genders.flatMap((g) => eventKeys.map((k) => meetEvent(k, g))),
    swims,
    relaySplits: splits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

const ind = (team: string, swimmerId: string, eventKey: string, gender: Gender = 'Men'): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey, gender, seedSwimId: null });
const relay = (team: string, letter: string, ids: readonly string[]): LineupEntry => ({
  kind: 'relay',
  teamId: team,
  eventKey: RELAY,
  gender: 'Men',
  letter,
  legs: ids.map((swimmerId, i) => ({
    swimmerId,
    basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:${FREE}` } : { kind: 'split' as const, splitId: `split-${swimmerId}` },
  })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
});
const lineup = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });
const tag = (team: string, swimmerId: string, role: ScorerTag['role'] = 'scorer'): ScorerTag => ({ teamId: team, swimmerId, role });
const tags = (team: string, ids: readonly string[], role: ScorerTag['role'] = 'scorer'): ScorerTag[] => ids.map((id) => tag(team, id, role));

interface RuleOpts {
  ties?: 'split' | 'ordered';
  size?: number | 'unlimited';
  maxInd?: number | 'unlimited';
  maxTotal?: number | 'unlimited';
  cap?: PerEventScorerCap;
  relayCap?: number | 'unlimited';
  nonScorer?: 'holds-place' | 'removed-from-consideration';
  mustBe?: boolean;
  individualPoints?: readonly number[];
  eligibility?: 'roster' | 'points_pool';
}

/** nsisc v4 with the settings a test names changed. Every other setting is the shipped one. */
function rulesOf(o: RuleOpts = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 4) as RulePreset;
  return requireComplete({
    ...base,
    scoring: {
      ...base.scoring,
      ...(o.ties ? { ties: set(o.ties) } : {}),
      ...(o.nonScorer ? { nonScorerPlacement: set(o.nonScorer) } : {}),
      ...(o.individualPoints ? { individualPoints: set([...o.individualPoints]), divingPoints: set({ kind: 'same-as-individual' as const }) } : {}),
    },
    scorers: {
      ...base.scorers,
      ...(o.size === undefined ? {} : { scoringTeamSize: set(o.size) }),
      ...(o.cap ? { perEventScorerCap: set(o.cap) } : {}),
      ...(o.relayCap === undefined ? {} : { scoringRelaysPerTeamPerEvent: set(o.relayCap) }),
      ...(o.mustBe === undefined ? {} : { relayLegsMustBeScorers: set(o.mustBe) }),
      ...(o.eligibility ? { eligibility: set(o.eligibility), relayEligibleFromScorerPool: set(false) } : {}),
    },
    entries: {
      ...base.entries,
      ...(o.maxInd === undefined ? {} : { maxIndividualPerSwimmer: set(o.maxInd) }),
      ...(o.maxTotal === undefined ? {} : { maxTotalPerSwimmer: set(o.maxTotal) }),
    },
  });
}

interface Fx {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly tags: readonly ScorerTag[];
  readonly rules: CompleteRulePreset;
}

function request(fx: Fx, over: Partial<AutoBuildRequest> = {}): AutoBuildRequest {
  return {
    model: fx.model,
    lineup: fx.lineup,
    rules: fx.rules,
    sourcing: SOURCING,
    tags: fx.tags,
    ownTeamId: 'A',
    genders: ['Men'],
    objective: { kind: 'max-own' },
    load: null,
    limits: LIMITS,
    ...over,
  };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
}

async function autoError(run: () => Promise<unknown>): Promise<AutoBuildError> {
  const error = await failure(run);
  if (!(error instanceof AutoBuildError)) throw new Error(`expected an AutoBuildError, got ${String(error)}`);
  return error;
}

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

function shuffled<T>(list: readonly T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const ownPoints = (results: { teams: readonly { teamId: string; points: number }[] }): number => (results.teams.find((t) => t.teamId === 'A') as { points: number }).points;

// ---- the seeded mini meet ----------------------------------------------------------------------

const TIMES = [4700, 4750, 4800, 4800, 4850, 4900, 4950, 5000];
const DIVES = [24000, 25000, 25000, 26000, 27000];

interface Mini extends Fx {
  readonly pinned: readonly string[];
  readonly free: readonly string[];
  /** The events each own decision swimmer has a time in. */
  readonly options: Readonly<Record<string, readonly string[]>>;
}

/**
 * Own team A: a0 (3 events), a1, a2 (2 events), ad (a diver who also swims the 100 free), and a3 on some seeds. B and C are
 * tagged opponents with a diver each. The current lineup holds random entries: the pinned swimmers' entries are feasible
 * (at most 2 each), the free swimmers' are kept non-scorer entries.
 */
function mini(seed: number): Mini {
  const next = rng(seed * 7919 + 17);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const swimEvents = [FREE, BACK, FLY];
  const two = (): string[] => shuffled(swimEvents, Math.floor(next() * 1e9)).slice(0, 2);
  const ownIds = ['a0', 'a1', 'a2', 'ad', ...(seed % 3 === 0 ? ['a3'] : [])];
  const options: Record<string, string[]> = { a0: swimEvents, ad: [FREE, DIVE] };
  for (const id of ownIds) if (options[id] === undefined) options[id] = two();
  const specs: Spec[] = ownIds.map((id) => ({
    id,
    team: 'A',
    times: Object.fromEntries((options[id] as string[]).map((e) => [e, e === DIVE ? pick(DIVES) : id === 'ad' ? 5200 : pick(TIMES)])),
  }));
  const opp = (team: string, ids: string[], diver: string): void => {
    for (const id of ids) specs.push({ id, team, times: { [FREE]: pick(TIMES), [BACK]: pick(TIMES), [FLY]: pick(TIMES) } });
    specs.push({ id: diver, team, times: { [DIVE]: pick(DIVES) } });
  };
  opp('B', ['b0', 'b1'], 'bd0');
  opp('C', ['c0', 'c1'], 'cd0');

  const pinned = seed % 2 === 1 ? ['a0', 'ad'] : ['a0'];
  const free = ownIds.filter((id) => !pinned.includes(id));
  const entries: LineupEntry[] = [];
  for (const id of ownIds) {
    const events = shuffled(options[id] as string[], Math.floor(next() * 1e9));
    const keep = events.slice(0, Math.floor(next() * 3));
    for (const e of keep) entries.push(ind('A', id, e));
  }
  for (const s of specs) {
    if (s.team === 'A') continue;
    for (const e of Object.keys(s.times)) if (e === DIVE || next() < 0.7) entries.push(ind(s.team, s.id, e));
  }
  const cap: PerEventScorerCap =
    Math.floor(seed / 2) % 3 === 0 ? { cap: 'unlimited' } : Math.floor(seed / 2) % 3 === 1 ? { cap: 1, overCap: 'removed-from-consideration' } : { cap: 2, overCap: 'holds-place' };
  return {
    model: buildModel(specs, [FREE, BACK, FLY, DIVE]),
    lineup: lineup(...shuffled(entries, Math.floor(next() * 1e9))),
    tags: [...tags('A', pinned), ...tags('B', ['b0', 'b1', 'bd0']), ...tags('C', ['c0', 'c1', 'cd0'])],
    rules: rulesOf({ ties: seed % 2 === 1 ? 'ordered' : 'split', size: 3, maxTotal: 2, cap }),
    pinned,
    free,
    options,
  };
}

// ---- the oracle: every own entry set, scored by whole-meet scoreMeet ---------------------------

type Choice = readonly string[] | null; // null: a free swimmer stays off the roster

/** The lineup of an assignment, by the D5 5.1 position rule written out independently of the engine. */
function compose(fx: Mini, choice: ReadonlyMap<string, Choice>): Lineup {
  const entries: LineupEntry[] = [];
  const have = new Set<string>();
  for (const e of fx.lineup.entries) {
    if (e.kind === 'individual' && e.teamId === 'A' && choice.has(e.swimmerId)) {
      const c = choice.get(e.swimmerId) as Choice;
      if (c !== null) {
        if (!c.includes(e.eventKey)) continue;
        have.add(`${e.swimmerId}|${e.eventKey}`);
      }
    }
    entries.push(e);
  }
  for (const event of fx.model.events) {
    const fresh: LineupEntry[] = [];
    for (const [id, c] of choice) {
      if (c !== null && c.includes(event.eventKey) && !have.has(`${id}|${event.eventKey}`)) fresh.push(ind('A', id, event.eventKey));
    }
    fresh.sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : 1));
    entries.push(...fresh);
  }
  return { ...fx.lineup, entries };
}

const isDiveOnly = (events: readonly string[]): boolean => events.length > 0 && events.every((e) => e === DIVE);

/** The optimum over every own entry set that fits the size (strict or loose diver weight) and the total cap. */
function bruteMax(fx: Mini, weight: 'strict' | 'loose' = 'strict', sizeUnits = 9): { best: number; sets: number; minChanges: number } {
  const ids = [...fx.pinned, ...fx.free].sort();
  const subsets = (events: readonly string[], max: number): string[][] => {
    const out: string[][] = [];
    for (let mask = 0; mask < 1 << events.length; mask++) {
      const s = events.filter((_, i) => (mask >> i) & 1);
      if (s.length <= max) out.push(s);
    }
    return out;
  };
  const optionsOf = (id: string): Choice[] => {
    const all = subsets(fx.options[id] as string[], 2);
    return fx.pinned.includes(id) ? all : [null, ...all.filter((s) => s.length > 0)];
  };
  let best = -Infinity;
  let sets = 0;
  const seen: { points: number; changes: number }[] = [];
  const current = (id: string): string[] => fx.lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A' && e.swimmerId === id).map((e) => e.eventKey);
  /** D5 4.9: a pinned swimmer's entries added or dropped; a free swimmer who joins adds 1 for the roster spot plus the same. */
  const changesOf = (): number => {
    let n = 0;
    for (const [id, c] of choice) {
      if (c === null) continue;
      const cur = current(id);
      n += c.filter((e) => !cur.includes(e)).length + cur.filter((e) => !c.includes(e)).length + (fx.pinned.includes(id) ? 0 : 1);
    }
    return n;
  };
  const choice = new Map<string, Choice>();
  const spots = (): number => {
    let sum = 0;
    for (const c of choice.values()) {
      if (c === null) continue;
      // Loose: a swimmer with a dive and no relay counts 1/3 (results.ts:1002). Strict: only when every entry is a dive.
      const diver = weight === 'strict' ? isDiveOnly(c) : c.includes(DIVE);
      sum += diver ? 1 : 3;
    }
    return sum;
  };
  const visit = (i: number): void => {
    if (spots() > sizeUnits) return;
    if (i === ids.length) {
      sets += 1;
      const joined = ids.filter((id) => choice.get(id) !== null && !fx.pinned.includes(id));
      const results = scoreMeet(fx.model, compose(fx, choice), [...fx.tags, ...tags('A', joined)], fx.rules, SOURCING);
      const points = ownPoints(results);
      best = Math.max(best, points);
      seen.push({ points, changes: changesOf() });
      return;
    }
    const id = ids[i] as string;
    for (const c of optionsOf(id)) {
      choice.set(id, c);
      visit(i + 1);
    }
    choice.delete(id);
  };
  visit(0);
  return { best, sets, minChanges: Math.min(...seen.filter((s) => Math.abs(s.points - best) < 1e-9).map((s) => s.changes)) };
}

const objectiveOf = (r: AutoBuildResult): number => (r.kind === 'improved' ? r.proposal.evaluation.objective : r.current.objective);

// ---- tests -------------------------------------------------------------------------------------

describe('autoBuild (D5, slice A1)', () => {
  it('1 bruteForceMaxOwn: 12 seeded fixtures equal the best own entry set that whole-meet scoreMeet finds', async () => {
    let improved = 0;
    for (let seed = 0; seed < 12; seed++) {
      const fx = mini(seed);
      const solver = nodeMipSolve();
      const result = await autoBuild(request(fx), solver);
      const brute = bruteMax(fx);
      expect(result.kind === 'improved' || result.kind === 'unchanged', `seed ${seed}: ${result.kind}`).toBe(true);
      expect(result.proof.status, `seed ${seed}`).toBe('proven_optimal');
      expect(objectiveOf(result), `seed ${seed}`).toBeCloseTo(brute.best, 9);
      expect(brute.sets, `seed ${seed}`).toBeGreaterThan(50);
      if (result.kind === 'improved') {
        improved += 1;
        const again = scoreMeet(fx.model, result.proposal.lineup, result.proposal.tagsForScoring, fx.rules, SOURCING);
        expect(ownPoints(again), `seed ${seed}`).toBeCloseTo(brute.best, 9);
        expect(result.proposal.evaluation.ownPoints).toBeCloseTo(ownPoints(again), 9);
        // Among the optimal lineups the proposal changes the fewest entries and roster spots (the tie-break, D5 4.9).
        // A per-event cap of 1 with removal prunes the columns that hold more than one swimmer (D5 3.3), so a joining swimmer cannot
        // keep a dominated current entry: the tie-break is then minimal only within the pruned columns, never below the brute force.
        if (Math.floor(seed / 2) % 3 === 1) expect(result.proposal.changeCount, `seed ${seed}`).toBeGreaterThanOrEqual(brute.minChanges);
        else expect(result.proposal.changeCount, `seed ${seed}`).toBe(brute.minChanges);
      } else if (result.kind === 'unchanged') {
        expect(result.reason).toBe('proven_no_better');
      }
    }
    expect(improved, 'some fixtures must change the lineup').toBeGreaterThan(3);
  }, 120_000);

  it('2 boundCoversOptimum: with K = 1 and no refinement, bestFound <= the brute-force maximum <= upperBound', async () => {
    // D5 amendment 1, 6.5 a: a free swimmer who has only outside pairs must be able to join (Z2 counts the o terms). Without
    // that the relaxation is not a relaxation and the bound drops below the optimum on some of these fixtures.
    let gaps = 0;
    for (let seed = 0; seed < 12; seed++) {
      const fx = mini(seed);
      const result = await autoBuild(request(fx, { limits: { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 } }), nodeMipSolve());
      const brute = bruteMax(fx).best;
      expect(result.proof.upperBound, `seed ${seed}`).not.toBeNull();
      expect(result.proof.bestFound, `seed ${seed}`).toBeLessThanOrEqual(brute + 1e-9);
      expect(brute, `seed ${seed}`).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
      if (result.proof.status === 'gap') gaps += 1;
    }
    expect(gaps, 'K = 1 must leave a gap somewhere, or the fixtures prove nothing about the bound').toBeGreaterThan(0);
  }, 120_000);

  it('3 deepTeamNeedsNinth: with K = 8 and no refinement the bound has a gap, and one round enters the ninth swimmer', async () => {
    // Event E0 holds eight fast own swimmers who each score 20 alone in their own event (cap: one entry each), four opponents
    // behind them, and a ninth own swimmer who is 5th in E0 once the eight leave. Every top-8 subset of E0 leaves those 14 points out.
    const eventKeys = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
    const specs: Spec[] = [];
    for (let i = 1; i <= 8; i++) specs.push({ id: `n${i}`, team: 'A', times: { E0: 4000 + i * 10, [`E${i}`]: 4500 } });
    specs.push({ id: 'n9', team: 'A', times: { E0: 5000 } });
    ['b0', 'b1', 'b2', 'b3'].forEach((id, i) => specs.push({ id, team: 'B', times: { E0: 4600 + i * 50 } }));
    const fx: Fx = {
      model: buildModel(specs, eventKeys),
      lineup: lineup(...['b0', 'b1', 'b2', 'b3'].map((id) => ind('B', id, 'E0'))),
      tags: tags('B', ['b0', 'b1', 'b2', 'b3']),
      rules: rulesOf({ size: 18, maxTotal: 1 }),
    };
    const gap = await autoBuild(request(fx, { limits: { ...LIMITS, refineRounds: 0 } }), nodeMipSolve());
    expect(gap.kind).toBe('improved');
    expect(gap.proof.status).toBe('gap');
    expect(gap.proof.bestFound).toBe(160);
    expect(gap.proof.upperBound).toBe(174);
    expect(gap.proof.gap).toBe(14);
    expect(gap.proof.searchSpace.events.find((e) => e.eventKey === 'E0')).toMatchObject({ candidates: 8, outside: 1 });
    if (gap.kind === 'improved') expect(gap.proposal.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 'n9')).toBe(false);

    const proven = await autoBuild(request(fx, { limits: { ...LIMITS, refineRounds: 1 } }), nodeMipSolve());
    expect(proven.kind).toBe('improved');
    expect(proven.proof.status).toBe('proven_optimal');
    expect(proven.proof.bestFound).toBe(174);
    expect(proven.proof.searchSpace.events.find((e) => e.eventKey === 'E0')).toMatchObject({ candidates: 9, outside: 0 });
    if (proven.kind === 'improved') {
      const nine = proven.proposal.lineup.entries.find((e) => e.kind === 'individual' && e.swimmerId === 'n9');
      expect(nine).toMatchObject({ eventKey: 'E0', gender: 'Men' });
      expect(proven.proposal.rosterAdds).toHaveLength(9);
      expect(proven.proposal.evaluation.objective).toBe(174);
    }
  }, 60_000);

  it('4 noDiverDiscountFromDive: a swimmer who swims and dives never takes the 1/3 spot under a tight team size', async () => {
    // Team size 1 spot (3 thirds). Loosely, x (swim + dive) and the divers y and z would take 1/3 each and score 73. Strictly,
    // x counts one spot while he swims, so the best legal roster scores 53 (three divers) or 40 (x alone).
    const specs: Spec[] = [
      { id: 'x', team: 'A', times: { [FREE]: 4700, [DIVE]: 28000 } },
      { id: 'y', team: 'A', times: { [DIVE]: 27000 } },
      { id: 'z', team: 'A', times: { [DIVE]: 26000 } },
      { id: 'b0', team: 'B', times: { [FREE]: 6000 } },
    ];
    const fx: Mini = {
      model: buildModel(specs, [FREE, DIVE]),
      lineup: lineup(ind('B', 'b0', FREE)),
      tags: tags('B', ['b0']),
      rules: rulesOf({ size: 1 }),
      pinned: [],
      free: ['x', 'y', 'z'],
      options: { x: [FREE, DIVE], y: [DIVE], z: [DIVE] },
    };
    const strict = bruteMax(fx, 'strict', 3).best;
    const loose = bruteMax(fx, 'loose', 3).best;
    expect(loose).toBe(73);
    expect(strict).toBe(53);
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    expect(objectiveOf(result)).toBe(strict);
    expect(result.proof.searchSpace.restrictions).toContain('strict_diver_weight');
    if (result.kind === 'improved') {
      const swims = result.proposal.lineup.entries.filter((e) => e.teamId === 'A' && e.eventKey !== DIVE);
      expect(swims, 'nobody swims while the roster relies on the dive weight').toEqual([]);
      expect(result.proposal.evaluation.results.violations.filter((v) => v.kind === 'scoring_team_size')).toEqual([]);
    }
  });

  it('5 pinsHonored: pinned scorers stay, pinned-off entries are byte-identical, unknown swimmers get no entry', async () => {
    const specs: Spec[] = [
      { id: 'p1', team: 'A', times: { [FREE]: 4800, [BACK]: 4900 } },
      { id: 'p2', team: 'A', times: { [FREE]: 4700, [BACK]: 4600 } },
      { id: 'p3', team: 'A', times: { [FLY]: 4500 } },
      { id: 'u1', team: 'A', times: { [FREE]: 4000 }, roster: 'unknown' },
      { id: 'f1', team: 'A', times: { [FREE]: 4850, [BACK]: 4950 } },
      { id: 'f2', team: 'A', times: { [FLY]: 5000 } },
      { id: 'b0', team: 'B', times: { [FREE]: 4750, [BACK]: 4850, [FLY]: 4900 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [FREE, BACK, FLY]),
      lineup: lineup(ind('A', 'p1', FREE), ind('A', 'p2', FREE), ind('A', 'p3', FLY), ind('B', 'b0', FREE), ind('B', 'b0', BACK), ind('B', 'b0', FLY)),
      tags: [tag('A', 'p1'), tag('A', 'p2', 'non-scorer'), tag('A', 'p3', 'exhibition'), ...tags('B', ['b0'])],
      rules: rulesOf({}),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const { proposal } = result;
    const entriesOf = (l: Lineup, id: string): string[] => l.entries.filter((e) => e.kind === 'individual' && e.swimmerId === id).map((e) => JSON.stringify(e));
    for (const id of ['p2', 'p3']) expect(entriesOf(proposal.lineup, id), id).toEqual(entriesOf(fx.lineup, id));
    // The pinned-off entries also keep their order among the entries that were already in the lineup.
    const pinnedOff = (l: Lineup): string[] => l.entries.filter((e) => e.kind === 'individual' && (e.swimmerId === 'p2' || e.swimmerId === 'p3')).map((e) => JSON.stringify(e));
    expect(pinnedOff(proposal.lineup)).toEqual(pinnedOff(fx.lineup));
    expect(entriesOf(proposal.lineup, 'u1')).toEqual([]);
    expect(proposal.rosterAdds.map((a) => a.swimmerId).every((id) => id === 'f1' || id === 'f2')).toBe(true);
    expect(proposal.entryChanges.filter((c) => /\|(p2|p3|u1)\|/.test(c.entryKey))).toEqual([]);
    expect(proposal.tagsForScoring.filter((t) => t.teamId === 'A').every((t) => t.source === undefined)).toBe(true);
    expect(proposal.tagsForScoring).toEqual(expect.arrayContaining([tag('A', 'p1'), tag('A', 'p2', 'non-scorer'), tag('A', 'p3', 'exhibition')]));
    const added = proposal.tagsForScoring.filter((t) => !fx.tags.some((o) => o.swimmerId === t.swimmerId));
    expect(added.map((t) => t.swimmerId).sort()).toEqual(proposal.rosterAdds.map((a) => a.swimmerId).sort());
    expect(added.every((t) => t.role === 'scorer' && !('source' in t))).toBe(true);
  });

  it('6 orderIndependence: permuting teams, swimmers, swims and tags gives byte-identical LP text and an equal result', async () => {
    const stripped = (r: AutoBuildResult): unknown => {
      const copy = JSON.parse(JSON.stringify(r)) as {
        proof: { solves: { ms: unknown }[]; timings: unknown };
        current: { results: { teams: { teamId: string }[] } };
        proposal?: { evaluation: { results: { teams: { teamId: string }[] } } };
      };
      copy.proof.solves.forEach((s) => (s.ms = null)); // wall time differs per run
      copy.proof.timings = null;
      // scoreMeet orders tied teams by model.teams order. That is its rule, not the AutoBuilder's, so tied teams are sorted here.
      const byId = (a: { teamId: string }, b: { teamId: string }): number => (a.teamId < b.teamId ? -1 : 1);
      copy.current.results.teams.sort(byId);
      copy.proposal?.evaluation.results.teams.sort(byId);
      return copy;
    };
    for (const seed of [2, 5, 7]) {
      const fx = mini(seed);
      const permuted: Fx = {
        ...fx,
        model: { ...fx.model, teams: shuffled(fx.model.teams, seed + 1), swimmers: shuffled(fx.model.swimmers, seed + 2), swims: shuffled(fx.model.swims, seed + 3), relaySplits: shuffled(fx.model.relaySplits, seed + 4) },
        tags: shuffled(fx.tags, seed + 5),
      };
      const a = nodeMipSolve();
      const b = nodeMipSolve();
      const first = await autoBuild(request(fx), a);
      const second = await autoBuild(request(permuted), b);
      expect(a.texts.length, `seed ${seed}`).toBeGreaterThan(1);
      expect(b.texts, `seed ${seed}`).toEqual(a.texts);
      expect(stripped(second), `seed ${seed}`).toEqual(stripped(first));
    }
  }, 60_000);

  it('7 orderedTiesPosition: a new own entry loses a tie it would not lose under "split", and a kept entry keeps the place it holds', async () => {
    const specs: Spec[] = [
      { id: 'p', team: 'A', times: { [FREE]: 6000 } },
      { id: 'f', team: 'A', times: { [FREE]: 5000 } },
      { id: 'b0', team: 'B', times: { [FREE]: 5000 } },
    ];
    const model = buildModel(specs, [FREE]);
    const run = async (ties: 'split' | 'ordered', entries: LineupEntry[]) => {
      const fx: Fx = { model, lineup: lineup(...entries), tags: [tag('A', 'p'), ...tags('B', ['b0'])], rules: rulesOf({ ties }) };
      const result = await autoBuild(request(fx), nodeMipSolve());
      expect(result.kind).toBe('improved');
      if (result.kind !== 'improved') throw new Error('unreachable');
      const again = scoreMeet(model, result.proposal.lineup, result.proposal.tagsForScoring, fx.rules, SOURCING);
      expect(ownPoints(again)).toBeCloseTo(result.proposal.evaluation.ownPoints, 9);
      const placeOf = (id: string): number | null => again.events[0]?.rows.find((r) => r.swimmerId === id)?.place ?? null;
      return { points: ownPoints(again), fPlace: placeOf('f'), proof: result.proof };
    };
    // f is new: it comes after b0 in the lineup, so under 'ordered' it is 2nd (17) and p is 3rd (16).
    const behind = await run('ordered', [ind('B', 'b0', FREE)]);
    expect(behind).toMatchObject({ points: 33, fPlace: 2 });
    expect(behind.proof.status).toBe('proven_optimal');
    // f already has an entry before b0's (a kept non-scorer entry when it is untagged): it keeps that place and wins the tie.
    const ahead = await run('ordered', [ind('A', 'f', FREE), ind('B', 'b0', FREE)]);
    expect(ahead).toMatchObject({ points: 36, fPlace: 1 });
    // Under 'split' the tie shares places 1 and 2: (20 + 17) / 2 for each, and p is 3rd.
    const split = await run('split', [ind('B', 'b0', FREE)]);
    expect(split.points).toBeCloseTo(18.5 + 16, 9);
  });

  it('8 scaleExact: a three-way tie is held as exact integers (thirds), and the result matches scoreMeet', async () => {
    const specs: Spec[] = [
      { id: 'p', team: 'A', times: { [FREE]: 9000 } },
      { id: 'f', team: 'A', times: { [FREE]: 5000 } },
      { id: 'b0', team: 'B', times: { [FREE]: 5000 } },
      { id: 'c0', team: 'C', times: { [FREE]: 5000 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [FREE]),
      lineup: lineup(ind('B', 'b0', FREE), ind('C', 'c0', FREE)),
      tags: [tag('A', 'p'), ...tags('B', ['b0']), ...tags('C', ['c0'])],
      rules: rulesOf({ ties: 'split' }),
    };
    const solver = nodeMipSolve();
    const result = await autoBuild(request(fx), solver);
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    // f ties b0 and c0 for 1st: (20 + 17 + 16) / 3. p is 4th with 15.
    expect(result.proposal.evaluation.ownPoints).toBeCloseTo(53 / 3 + 15, 9);
    // The sizes seen are 2 (b0 and c0) and 3, so the scale is 6 and the column {f, p} holds 196 = (53/3 + 15) * 6.
    const first = solver.texts[0] as string;
    expect(first).toMatch(/\+ 196 y\d+_\d+/);
    for (const m of first.matchAll(/[+-] (\S+) [a-z]/g)) expect(m[1], 'every coefficient is a whole number').toMatch(/^\d+$/);
    expect(result.proof.bestFound).toBeCloseTo(53 / 3 + 15, 9);
  });

  it('9 fixedRelaysUntouched: own relays stay as entered, free relay legs stay off the roster, and relay entries count toward the cap', async () => {
    const specs: Spec[] = [
      { id: 'p1', team: 'A', times: { [FREE]: 4800, [BACK]: 4900, [FLY]: 5000 } },
      { id: 'q', team: 'A', times: { [FREE]: 4850, [BACK]: 4700 } },
      { id: 'r', team: 'A', times: { [FREE]: 4900 } },
      { id: 's', team: 'A', times: { [FREE]: 4950 } },
      { id: 'w', team: 'A', times: { [BACK]: 4950 } },
      ...['b0', 'b1', 'b2', 'b3'].map((id, i) => ({ id, team: 'B', times: { [FREE]: 5200 + i * 10, [BACK]: 5300, [FLY]: 5400 } })),
    ];
    const ownRelay = relay('A', 'A', ['p1', 'q', 'r', 's']);
    const theirRelay = relay('B', 'A', ['b0', 'b1', 'b2', 'b3']);
    const fx: Fx = {
      model: buildModel(specs, [FREE, BACK, FLY, RELAY]),
      lineup: lineup(ownRelay, theirRelay, ind('A', 'q', BACK), ind('B', 'b0', FREE), ind('B', 'b0', BACK), ind('B', 'b0', FLY)),
      tags: [tag('A', 'p1'), ...tags('B', ['b0', 'b1', 'b2', 'b3'])],
      rules: rulesOf({ maxTotal: 2 }),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const { proposal } = result;
    expect(proposal.lineup.entries.filter((e) => e.kind === 'relay')).toEqual([ownRelay, theirRelay]);
    expect(proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['w']);
    expect(proposal.lineup.entries.filter((e) => e.kind === 'individual' && e.swimmerId === 'q')).toEqual([ind('A', 'q', BACK)]);
    // p1 is on the relay (1 entry) and the total cap is 2, so p1 may swim one individual event at most.
    expect(proposal.lineup.entries.filter((e) => e.kind === 'individual' && e.swimmerId === 'p1').length).toBeLessThanOrEqual(1);
    // b0 is over the cap in the input too (a relay and three swims). That is the opponent's, and unchanged.
    expect(proposal.evaluation.results.violations.filter((v) => v.kind === 'entry_cap' && ['p1', 'q', 'r', 's', 'w'].includes(v.swimmerId))).toEqual([]);
    expect(result.proof.searchSpace.restrictions).toContain('fixed_relays');
  });

  // ---- D5 2.2 and 8.5 --------------------------------------------------------------------------

  /** Accept the proposal: its lineup and its tags are the new current state. */
  async function improvedLineup(fx: Fx): Promise<{ lineup: Lineup; tags: readonly ScorerTag[] }> {
    const result = await autoBuild(request(fx), nodeMipSolve());
    if (result.kind !== 'improved') throw new Error('expected an improved result, got ' + result.kind);
    return { lineup: result.proposal.lineup, tags: result.proposal.tagsForScoring };
  }

  /** The recorded simulator config C: Henderson State (58) and two opponents, men only. Opponent entered swimmers are all scorers. */
  function loadConfigC(): { model: MeetModel; lineup: Lineup; own: string; opponentTags: ScorerTag[] } {
    const { snapshot } = buildSnapshot('C');
    const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'autobuild-config-C', snapshotId: 'test' });
    if (adapted.kind !== 'ready') throw new Error('config-C did not adapt: ' + adapted.kind);
    const { model, lineup: l } = adapted.adapted;
    const own = String(model.teams.find((t) => String(t.teamId) === '58')?.teamId ?? (model.teams[0] as { teamId: string }).teamId);
    const entered = new Map<string, Set<string>>();
    for (const e of l.entries) {
      if (String(e.teamId) === own) continue;
      const set = entered.get(String(e.teamId)) ?? new Set<string>();
      for (const id of e.kind === 'individual' ? [e.swimmerId] : e.legs.map((leg) => leg.swimmerId)) set.add(String(id));
      entered.set(String(e.teamId), set);
    }
    const opponentTags = [...entered].flatMap(([team, ids]) => tags(team, [...ids].sort()));
    return { model, lineup: l, own, opponentTags };
  }

  /** A small valid meet: own a0 (free) and a1 (pinned), opponent b0. */
  function base(over: Partial<Fx> = {}): Fx {
    const specs: Spec[] = [
      { id: 'a0', team: 'A', times: { [FREE]: 4800, [BACK]: 4900 } },
      { id: 'a1', team: 'A', times: { [FREE]: 4850 } },
      { id: 'b0', team: 'B', times: { [FREE]: 4750 } },
    ];
    return { model: buildModel(specs, [FREE, BACK]), lineup: lineup(ind('B', 'b0', FREE)), tags: [tag('A', 'a1'), ...tags('B', ['b0'])], rules: rulesOf({}), ...over };
  }

  const schedule = (...keys: string[]): SessionPreset => ({
    payloadVersion: 1,
    provenance: TEST_PROVENANCE,
    events: keys.map((eventKey) => ({ eventKey, gender: 'both' as const, format: { kind: 'timed-final' as const, session: { day: 1, slot: 'morning' as const } } })),
  });
  const respect: LoadPreference = { mode: 'respect', maxRacesPerSession: set(3), diving: set('excluded' as const) };
  const pending = { state: 'pending' as const, question: 'synthetic', blocks: [] as string[] };

  it('refusals: every code A1 can reach throws with its code and subject', async () => {
    const fx = base();
    const cases: { label: string; req: AutoBuildRequest; code: string; subject: string | null }[] = [
      { label: 'own team not in the model', req: request(fx, { ownTeamId: 'ZZ' }), code: 'own_team_unknown', subject: 'ZZ' },
      {
        label: 'a model with no team',
        req: request({ ...fx, model: { ...fx.model, teams: [], swimmers: [], swims: [], relaySplits: [] }, lineup: lineup(), tags: [] }),
        code: 'draft_meet',
        subject: null,
      },
      { label: 'every own swimmer pinned off', req: request({ ...fx, tags: [tag('A', 'a0', 'non-scorer'), tag('A', 'a1', 'exhibition'), ...tags('B', ['b0'])] }, { genders: ['Men'] }), code: 'nothing_to_build', subject: null },
      { label: 'no gender to build', req: request(fx, { genders: [] }), code: 'nothing_to_build', subject: null },
      { label: 'a suggested own tag', req: request({ ...fx, tags: [{ ...tag('A', 'a1'), source: 'suggested' }, ...tags('B', ['b0'])] }), code: 'own_tag_not_coach', subject: 'a1' },
      { label: 'a points pool', req: request({ ...fx, tags: [], rules: rulesOf({ eligibility: 'points_pool' }) }), code: 'rule_unsupported', subject: 'scorers.eligibility' },
      { label: 'holds-place non-scorers', req: request({ ...fx, rules: rulesOf({ nonScorer: 'holds-place' }) }), code: 'rule_unsupported', subject: 'scoring.nonScorerPlacement' },
      { label: 'relay legs need not be scorers', req: request({ ...fx, rules: rulesOf({ mustBe: false }) }), code: 'rule_unsupported', subject: 'scorers.relayLegsMustBeScorers' },
      { label: 'unlimited scoring relays', req: request({ ...fx, rules: rulesOf({ relayCap: 'unlimited' }) }), code: 'rule_unsupported', subject: 'scorers.scoringRelaysPerTeamPerEvent' },
      { label: 'a table that rises', req: request({ ...fx, rules: rulesOf({ individualPoints: [1, 2, 3] }) }), code: 'rule_unsupported', subject: 'scoring.individualPoints' },
      { label: 'a negative point value', req: request({ ...fx, rules: rulesOf({ individualPoints: [3, -1] }) }), code: 'rule_unsupported', subject: 'scoring.individualPoints' },
      { label: 'five decimals', req: request({ ...fx, rules: rulesOf({ individualPoints: [1.00001, 1] }) }), code: 'rule_unsupported', subject: 'scoring.individualPoints' },
      {
        label: 'a prefer penalty with five decimals',
        req: request(fx, { load: { schedule: schedule(FREE, BACK), preference: { mode: 'prefer', maxRacesPerSession: set(3), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(0.00001) } } }),
        code: 'rule_unsupported',
        subject: 'load.preference.penaltyPointsPerExtraRace',
      },
      { label: 'pending race limit', req: request(fx, { load: { schedule: schedule(FREE, BACK), preference: { ...respect, maxRacesPerSession: pending } } }), code: 'pending_setting', subject: 'load.preference.maxRacesPerSession' },
      { label: 'pending diving rule', req: request(fx, { load: { schedule: schedule(FREE, BACK), preference: { ...respect, diving: pending } } }), code: 'pending_setting', subject: 'load.preference.diving' },
      {
        label: 'pending prefer penalty',
        req: request(fx, { load: { schedule: schedule(FREE, BACK), preference: { mode: 'prefer', maxRacesPerSession: set(3), diving: set('excluded' as const), penaltyPointsPerExtraRace: pending } } }),
        code: 'pending_setting',
        subject: 'load.preference.penaltyPointsPerExtraRace',
      },
      { label: 'a candidate event missing from the schedule', req: request(fx, { load: { schedule: schedule(FREE), preference: respect } }), code: 'unscheduled_event', subject: `${BACK}|Men` },
      { label: 'rival is the own team', req: request(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'A' } } }), code: 'rival_invalid', subject: 'A' },
      { label: 'rival not in the model', req: request(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'ZZ' } } }), code: 'rival_invalid', subject: 'ZZ' },
      { label: 'goal-seek rival invalid', req: request(fx, { objective: { kind: 'goal-seek', target: { kind: 'margin', rival: { kind: 'team', teamId: 'ZZ' }, points: 1 } } }), code: 'rival_invalid', subject: 'ZZ' },
      { label: 'a target that is not a number', req: request(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points: Number.NaN } } }), code: 'target_invalid', subject: 'target.points' },
      { label: 'K of 0', req: request(fx, { limits: { ...LIMITS, candidatesPerEvent: 0 } }), code: 'limits_invalid', subject: 'candidatesPerEvent' },
      { label: 'K above 12', req: request(fx, { limits: { ...LIMITS, candidatesPerEvent: 13, maxCandidatesPerEvent: 13 } }), code: 'limits_invalid', subject: 'candidatesPerEvent' },
      { label: 'K_max below K', req: request(fx, { limits: { ...LIMITS, maxCandidatesPerEvent: 7 } }), code: 'limits_invalid', subject: 'maxCandidatesPerEvent' },
      { label: 'T of 0', req: request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 0 } }), code: 'limits_invalid', subject: 'relaySquadsPerEvent' },
      { label: 'T_max above 48', req: request(fx, { limits: { ...LIMITS, maxRelaySquadsPerEvent: 49 } }), code: 'limits_invalid', subject: 'maxRelaySquadsPerEvent' },
      { label: 'four rounds', req: request(fx, { limits: { ...LIMITS, refineRounds: 4 } }), code: 'limits_invalid', subject: 'refineRounds' },
      { label: 'a fractional round count', req: request(fx, { limits: { ...LIMITS, refineRounds: 1.5 } }), code: 'limits_invalid', subject: 'refineRounds' },
      { label: 'no time', req: request(fx, { limits: { ...LIMITS, timeLimitSeconds: 0 } }), code: 'limits_invalid', subject: 'timeLimitSeconds' },
      { label: 'more than 120 s', req: request(fx, { limits: { ...LIMITS, timeLimitSeconds: 121 } }), code: 'limits_invalid', subject: 'timeLimitSeconds' },
      { label: 'a scale the integer model cannot hold', req: request({ ...fx, rules: rulesOf({ individualPoints: [1e12, 1e12] }) }), code: 'scale_unsupported', subject: 'objective' },
      { label: 'the margin objective (slice A6)', req: request(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'B' } } }), code: 'mode_not_built', subject: 'margin' },
      { label: 'the goal-seek objective (slice A6)', req: request(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points: 10 } } }), code: 'mode_not_built', subject: 'goal-seek' },
      { label: 'the robust objective (slice A7)', req: request(fx, { objective: { kind: 'robust', recentSwims: 5, minSwims: 3 } as AutoBuildObjective }), code: 'mode_not_built', subject: 'robust' },
      { label: 'session-load rows (slice A3)', req: request(fx, { load: { schedule: schedule(FREE, BACK), preference: respect } }), code: 'mode_not_built', subject: 'load' },
    ];
    for (const c of cases) {
      const error = await autoError(() => autoBuild(c.req, nodeMipSolve()).then((r) => { throw new Error('did not throw: ' + c.label + ' gave ' + r.kind); }));
      expect({ label: c.label, code: error.code, subject: error.subject }, c.label).toEqual({ label: c.label, code: c.code, subject: c.subject });
    }
    // 'off' needs no load rows: it is the same as no load.
    const off = await autoBuild(request(fx, { load: { schedule: schedule(), preference: { mode: 'off' } } }), nodeMipSolve());
    expect(off.kind).toBe('improved');
  });

  it('preflightPassesThrough: an own side with entries and no scorer tag gives ScoreMeetError, not an AutoBuildError', async () => {
    const fx = base({ lineup: lineup(ind('A', 'a0', FREE), ind('B', 'b0', FREE)), tags: tags('B', ['b0']) });
    const error = await failure(() => autoBuild(request(fx), nodeMipSolve()));
    expect(error).toBeInstanceOf(ScoreMeetError);
    expect((error as ScoreMeetError).code).toBe('scoring_roster_missing');
    expect(error).not.toBeInstanceOf(AutoBuildError);
  });

  it('ownTagWithSource: an own tag with source "suggested" throws own_tag_not_coach, and an opponent tag with a source passes', async () => {
    const fx = base();
    const own = await autoError(() => autoBuild(request({ ...fx, tags: [{ ...tag('A', 'a1'), source: 'suggested' }, ...tags('B', ['b0'])] }), nodeMipSolve()));
    expect({ code: own.code, subject: own.subject }).toEqual({ code: 'own_tag_not_coach', subject: 'a1' });
    const opponent = await autoBuild(request({ ...fx, tags: [tag('A', 'a1'), { ...tag('B', 'b0'), source: 'suggested' }] }), nodeMipSolve());
    expect(opponent.kind).toBe('improved');
    if (opponent.kind === 'improved') expect(opponent.proposal.tagsForScoring).toContainEqual({ ...tag('B', 'b0'), source: 'suggested' });
  });

  it('8.5.1 neverWorse: 20 seeded fixtures with feasible current lineups are improved or unchanged, and an improved result is re-scored exactly', async () => {
    let improved = 0;
    for (let seed = 100; seed < 120; seed++) {
      const fx = mini(seed);
      const result = await autoBuild(request(fx), nodeMipSolve());
      expect(result.kind === 'improved' || result.kind === 'unchanged', `seed ${seed}: ${result.kind}`).toBe(true);
      if (result.kind !== 'improved') continue;
      improved += 1;
      expect(result.proposal.evaluation.objective, `seed ${seed}`).toBeGreaterThan(result.current.objective);
      const again = scoreMeet(fx.model, result.proposal.lineup, result.proposal.tagsForScoring, fx.rules, SOURCING);
      expect(ownPoints(again), `seed ${seed}`).toBeCloseTo(result.proposal.evaluation.ownPoints, 9);
      expect(result.proposal.changeCount, `seed ${seed}`).toBe(result.proposal.rosterAdds.length + result.proposal.entryChanges.length);
    }
    expect(improved).toBeGreaterThan(5);
  }, 120_000);

  it('8.5.2 unchangedSaysSo: a current lineup that is the brute-force optimum is unchanged, proven, with no proposal', async () => {
    for (const seed of [3, 6, 9]) {
      const fx = mini(seed);
      const first = await autoBuild(request(fx), nodeMipSolve());
      expect(first.kind).toBe('improved');
      if (first.kind !== 'improved') continue;
      // Accept the proposal: its lineup and its tags are the new current state.
      const next: Mini = { ...fx, lineup: first.proposal.lineup, tags: first.proposal.tagsForScoring };
      const again = await autoBuild(request(next), nodeMipSolve());
      expect(again.kind, `seed ${seed}`).toBe('unchanged');
      if (again.kind !== 'unchanged') continue;
      expect(again.reason).toBe('proven_no_better');
      expect(again.proof.status).toBe('proven_optimal');
      expect('proposal' in again).toBe(false);
      expect(again.current.objective).toBeCloseTo(bruteMax(fx).best, 9);
    }
  }, 120_000);

  it('8.5.3 gateCatchesDrift: a solver that returns tampered columns makes autoBuild throw model_mismatch', async () => {
    const fx = mini(1);
    const tamper = (mode: 'objective' | 'swap' | 'fraction' | 'missing'): MipSolve => {
      const real = nodeMipSolve();
      return async (lp, options) => {
        const r = await real(lp, options);
        if (r.status !== 'Optimal') return r;
        const columns = { ...r.columns };
        const ys = Object.keys(columns).filter((n) => /^y\d+_\d+$/.test(n));
        const chosen = ys.find((n) => columns[n] === 1) as string;
        if (mode === 'swap') {
          const other = ys.find((n) => n !== chosen && n.split('_')[0] === chosen.split('_')[0]) as string;
          columns[chosen] = 0;
          columns[other] = 1;
        }
        if (mode === 'fraction') columns[chosen] = 0.5;
        if (mode === 'missing') delete columns[chosen];
        return { ...r, columns, objective: mode === 'objective' ? r.objective + 1 : r.objective };
      };
    };
    for (const mode of ['objective', 'swap', 'fraction', 'missing'] as const) {
      const error = await autoError(() => autoBuild(request(fx), tamper(mode)));
      expect(error.code, mode).toBe('model_mismatch');
    }
  }, 60_000);

  it('8.5.4 currentInfeasible: a pinned swimmer over the total cap gives current_infeasible with the best legal lineup as the alternative', async () => {
    const specs: Spec[] = [
      { id: 'p', team: 'A', times: { [FREE]: 4700, [BACK]: 4750, [FLY]: 4800 } },
      { id: 'f', team: 'A', times: { [FREE]: 4900, [BACK]: 4950 } },
      { id: 'b0', team: 'B', times: { [FREE]: 4800, [BACK]: 4800, [FLY]: 4850 } },
    ];
    const model = buildModel(specs, [FREE, BACK, FLY]);
    const fx: Mini = {
      model,
      lineup: lineup(ind('A', 'p', FREE), ind('A', 'p', BACK), ind('A', 'p', FLY), ind('B', 'b0', FREE), ind('B', 'b0', BACK), ind('B', 'b0', FLY)),
      tags: [tag('A', 'p'), ...tags('B', ['b0'])],
      rules: rulesOf({ maxTotal: 2 }),
      pinned: ['p'],
      free: ['f'],
      options: { p: [FREE, BACK, FLY], f: [FREE, BACK] },
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('current_infeasible');
    if (result.kind !== 'current_infeasible') return;
    expect(result.currentViolations).toContainEqual({ kind: 'entry_cap', swimmerId: 'p', which: 'total', count: 3, limit: 2 });
    expect(result.alternative).not.toBeNull();
    const alt = result.alternative;
    if (alt === null) return;
    // The opponent b0 is over the cap in the input as well (3 entries against 2): that is not the AutoBuilder's to fix.
    expect(alt.evaluation.results.violations.filter((v) => v.kind === 'entry_cap' && (v.swimmerId === 'p' || v.swimmerId === 'f'))).toEqual([]);
    expect(alt.lineup.entries.filter((e) => e.kind === 'individual' && e.swimmerId === 'p').length).toBeLessThanOrEqual(2);
    expect(alt.evaluation.objective).toBeCloseTo(bruteMax(fx, 'strict', 54).best, 9);
    // The caller shows the signed change. It is finite, and the kind is never "improved".
    expect(Number.isFinite(alt.evaluation.objective - result.current.objective)).toBe(true);
    expect(result.proof.status).toBe('proven_optimal');
  });

  it('resultKinds: improved, both unchanged reasons, current_infeasible, and the witness check', async () => {
    const fx = mini(4);
    expect((await autoBuild(request(fx), nodeMipSolve())).kind).toBe('improved');
    const accepted = await improvedLineup(fx);
    const proven = await autoBuild(request({ ...fx, lineup: accepted.lineup, tags: accepted.tags }), nodeMipSolve());
    expect(proven).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    // A solver that times out has proven nothing: the current lineup stays, and the reason says so.
    const slow: MipSolve = () => Promise.resolve({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: 500 });
    const timedOut = await autoBuild(request(fx), slow);
    expect(timedOut).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
    expect(timedOut.proof.status).toBe('gap');
    const unknown = await autoBuild(request(fx), () => Promise.resolve({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null }));
    expect(unknown).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
    expect(unknown.proof.status).toBe('unknown');
    // The current lineup is a witness: an infeasible MIP is a model error, not "unchanged".
    const infeasible: MipSolve = () => Promise.resolve({ status: 'Infeasible', objective: 0, columns: {}, incumbent: null, dualBound: null });
    expect((await autoError(() => autoBuild(request(fx), infeasible))).code).toBe('model_mismatch');
  });

  it('a current lineup that leans on the loose diver weight is not a witness: no model_mismatch, the result stays unchanged', async () => {
    // a0 swims and dives (loose weight 1/3, strict weight 1) and is pinned: the gate accepts this lineup under size 1,
    // the strict MIP cannot reproduce it. The MIP's optimum is below the current points. That is not a model error.
    const specs: Spec[] = [
      { id: 'a0', team: 'A', times: { [FREE]: 4700, [DIVE]: 28000 } },
      { id: 'a1', team: 'A', times: { [DIVE]: 27000 } },
      { id: 'b0', team: 'B', times: { [FREE]: 6000 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [FREE, DIVE]),
      lineup: lineup(ind('A', 'a0', FREE), ind('A', 'a0', DIVE), ind('B', 'b0', FREE)),
      tags: [tag('A', 'a0'), tag('A', 'a1', 'non-scorer'), ...tags('B', ['b0'])],
      rules: rulesOf({ size: 1 }),
    };
    const current = scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING);
    expect(current.violations.filter((v) => v.kind === 'scoring_team_size')).toEqual([]);
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('unchanged');
    expect(result.current.objective).toBe(40);
    expect(result.proof.searchSpace.restrictionStatus.find((r) => r.restriction === 'strict_diver_weight')?.binding).toBe(false);
  });

  it('6.5 b binding: a current lineup that passes the gate but breaks the strict diver weight is guarded normally, and the proof says the weight binds', async () => {
    // Size 1 spot. a0 swims and dives (strict weight 1) and a1 only dives (1/3). Loose: 1/3 + 1/3 fits. Strict: 4/3 does not.
    const specs: Spec[] = [
      { id: 'a0', team: 'A', times: { [FREE]: 4700, [DIVE]: 28000 } },
      { id: 'a1', team: 'A', times: { [DIVE]: 27000 } },
      { id: 'b0', team: 'B', times: { [FREE]: 6000 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [FREE, DIVE]),
      lineup: lineup(ind('A', 'a0', FREE), ind('A', 'a0', DIVE), ind('A', 'a1', DIVE), ind('B', 'b0', FREE)),
      tags: [tag('A', 'a0'), tag('A', 'a1'), ...tags('B', ['b0'])],
      rules: rulesOf({ size: 1 }),
    };
    const current = scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING);
    expect(current.violations.filter((v) => v.kind === 'scoring_team_size')).toEqual([]);
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
    const status = result.proof.searchSpace.restrictionStatus;
    expect(status.find((r) => r.restriction === 'strict_diver_weight')?.binding).toBe(true);
    expect(status.filter((r) => r.binding)).toHaveLength(1);
  });

  it('real data: config C (Henderson State and two opponents) returns candidates, columns and an improved lineup', async () => {
    const { model, lineup: realLineup, own, opponentTags } = loadConfigC();
    const ownSwimmers = model.swimmers.filter((s) => s.teamId === own).map((s) => s.swimmerId).sort();
    const pinned = ownSwimmers.slice(0, 3);
    const rules = requireComplete(builtinRulePreset('nsisc', 5) as RulePreset);
    const solver = nodeMipSolve();
    const result = await autoBuild(
      {
        model, lineup: realLineup, rules, sourcing: SOURCING, tags: [...tags(own, pinned), ...opponentTags], ownTeamId: own, genders: ['Men'],
        objective: { kind: 'max-own' }, load: null, limits: { ...LIMITS, refineRounds: 0, timeLimitSeconds: 60 },
      },
      solver
    );
    // Not a silent empty: the primary workspace has candidates and columns.
    expect(result.proof.searchSpace.events.length).toBeGreaterThan(5);
    expect(result.proof.searchSpace.events.some((e) => e.candidates > 0 && e.columns > 1)).toBe(true);
    expect(solver.calls).toBeGreaterThan(0);
    // 42 untagged members are free: the current lineup scores only the 3 pinned swimmers, so the build must find more.
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    expect(result.proposal.evaluation.objective).toBeGreaterThan(result.current.objective);
    expect(result.proof.upperBound as number).toBeGreaterThanOrEqual(result.proof.bestFound);
    expect(result.proposal.rosterAdds.length).toBeGreaterThan(0);
    expect(result.proposal.rosterAdds.length + pinned.length).toBeLessThanOrEqual(18);
  }, 120_000);

  it('tableEdge: an own swimmer at the last scoring place is entered, and one past the table is never entered', async () => {
    const run = async (ahead: number): Promise<AutoBuildResult> => {
      const opponents = Array.from({ length: ahead }, (_, i) => ({ id: `o${i}`, team: i < 8 ? 'B' : 'C', times: { [FREE]: 4000 + i * 10 } }));
      const specs: Spec[] = [{ id: 's', team: 'A', times: { [FREE]: 9000 } }, ...opponents];
      const fx: Fx = {
        model: buildModel(specs, [FREE]),
        lineup: lineup(...opponents.map((o) => ind(o.team, o.id, FREE))),
        tags: [...tags('B', opponents.filter((o) => o.team === 'B').map((o) => o.id)), ...tags('C', opponents.filter((o) => o.team === 'C').map((o) => o.id))],
        rules: rulesOf({}),
      };
      return autoBuild(request(fx), nodeMipSolve());
    };
    const last = await run(15); // 16th of 16 places: 1 point
    expect(last.kind).toBe('improved');
    expect(objectiveOf(last)).toBe(1);
    const past = await run(16); // 17th: outside the table, moves nothing
    expect(past).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(past.proof.searchSpace.events[0]).toMatchObject({ candidates: 0, outside: 0 });
  });

  it('outsideChargesCaps: an outside swimmer counts once against the entry cap, so the bound is tight', async () => {
    // K = 1 leaves t outside in both events. Cap: one entry each. u1 and u2 score 20 alone; t scores 17 behind one of them.
    // The best lineup is 57. The bound charges t as if alone (20): 60 when t's two outside terms share one cap row, 80 without it.
    const specs: Spec[] = [
      { id: 'u1', team: 'A', times: { E1: 4000 } },
      { id: 'u2', team: 'A', times: { E2: 4000 } },
      { id: 't', team: 'A', times: { E1: 4500, E2: 4500 } },
    ];
    const fx: Fx = { model: buildModel(specs, ['E1', 'E2']), lineup: lineup(), tags: [], rules: rulesOf({ maxTotal: 1 }) };
    const result = await autoBuild(request(fx, { limits: { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 } }), nodeMipSolve());
    expect(result.kind).toBe('improved');
    expect(result.proof.bestFound).toBe(40);
    expect(result.proof.upperBound).toBe(60);
    expect(result.proof.gap).toBe(20);
    const full = await autoBuild(request(fx), nodeMipSolve());
    expect(full.proof).toMatchObject({ status: 'proven_optimal', bestFound: 57 });
  });

  it('outsideDivers: an outside swim and an outside dive of one swimmer cannot both take the diver weight in the bound', async () => {
    // Size 1 spot (3 thirds). h and d both swim and dive. K = 1 leaves d outside in the swim and in the dive. Under the strict
    // rule d's swim keeps him a full spot, so h + d never fit: the best is h in both events (40). Without the D3 rows on the
    // outside terms the bound lets d take 1/3 while his swim also scores: 60.
    const specs: Spec[] = [
      { id: 'h', team: 'A', times: { [FREE]: 4000, [DIVE]: 30000 } },
      { id: 'd', team: 'A', times: { [FREE]: 4500, [DIVE]: 29000 } },
    ];
    const fx: Fx = { model: buildModel(specs, [FREE, DIVE]), lineup: lineup(), tags: [], rules: rulesOf({ size: 1 }) };
    const tight = await autoBuild(request(fx, { limits: { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 } }), nodeMipSolve());
    const full = await autoBuild(request(fx), nodeMipSolve());
    expect(full.proof).toMatchObject({ status: 'proven_optimal', bestFound: 40 });
    expect(tight.proof).toMatchObject({ status: 'proven_optimal', bestFound: 40, upperBound: 40 });
  });
  // ---- D5 amendment 1: the wall-time budget, the solve order and incumbents (8.5.6 to 8.5.10) ----

  /** Test 3's meet: nine own swimmers, one event with a ninth swimmer outside the top 8. Optimum 174; the K = 8 optimum is 160. */
  function deepTeam(extra = 0): Fx {
    const eventKeys = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
    const specs: Spec[] = [];
    for (let i = 1; i <= 8; i++) specs.push({ id: `n${i}`, team: 'A', times: { E0: 4000 + i * 10, [`E${i}`]: 4500 } });
    specs.push({ id: 'n9', team: 'A', times: { E0: 5000 } });
    for (let i = 0; i < extra; i++) specs.push({ id: `x${i}`, team: 'A', times: { E0: 5100 + i * 10 } });
    ['b0', 'b1', 'b2', 'b3'].forEach((id, i) => specs.push({ id, team: 'B', times: { E0: 4600 + i * 50 } }));
    return {
      model: buildModel(specs, eventKeys),
      lineup: lineup(...['b0', 'b1', 'b2', 'b3'].map((id) => ind('B', id, 'E0'))),
      tags: tags('B', ['b0', 'b1', 'b2', 'b3']),
      rules: rulesOf({ size: 18, maxTotal: 1 }),
    };
  }

  /** A fake clock that moves only when a solve finishes, and a solver that runs HiGHS and records each `time_limit`. */
  function fakeBudget(advanceMs: number, stepPerRead = 0): { clock: () => number; solve: MipSolve; limits: number[] } {
    let now = 0;
    const limits: number[] = [];
    const real = nodeMipSolve();
    const solve: MipSolve = async (lp, options) => {
      limits.push(options.time_limit as number);
      const result = await real(lp, options);
      now += advanceMs;
      return result;
    };
    return {
      clock: () => {
        const at = now;
        now += stepPerRead;
        return at;
      },
      solve,
      limits,
    };
  }
  const stagesOf = (r: AutoBuildResult): string[] => r.proof.solves.map((s) => s.stage);
  const NO_RESULT: MipSolve = () => Promise.resolve({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });

  it('8.5.6 defaultLimitsConfigC: the default limits on the primary workspace give an improved lineup inside the wall-time limit', async () => {
    const { model, lineup: realLineup, own, opponentTags } = loadConfigC();
    const pinned = model.swimmers.filter((s) => s.teamId === own).map((s) => s.swimmerId).sort().slice(0, 3);
    const rules = requireComplete(builtinRulePreset('nsisc', 5) as RulePreset);
    const ask = (limits: AutoBuildLimits): AutoBuildRequest => ({
      model, lineup: realLineup, rules, sourcing: SOURCING, tags: [...tags(own, pinned), ...opponentTags], ownTeamId: own, genders: ['Men'],
      objective: { kind: 'max-own' }, load: null, limits, clock: () => performance.now(),
    });
    const reference = await autoBuild(ask({ ...AUTOBUILD_DEFAULT_LIMITS, refineRounds: 0, timeLimitSeconds: 60 }), nodeMipSolve());
    expect(reference.kind).toBe('improved');
    const started = performance.now();
    const result = await autoBuild(ask(AUTOBUILD_DEFAULT_LIMITS), nodeMipSolve());
    const wallMs = performance.now() - started;
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved' || reference.kind !== 'improved') return;
    expect(result.proposal.evaluation.ownPoints).toBeGreaterThanOrEqual(reference.proposal.evaluation.ownPoints);
    expect(result.proof.upperBound).not.toBeNull();
    expect(result.proof.bestFound).toBeLessThanOrEqual(result.proof.upperBound as number);
    expect(wallMs).toBeLessThanOrEqual((AUTOBUILD_DEFAULT_LIMITS.timeLimitSeconds + 1) * 1000);
    expect(stagesOf(result)[0]).toBe('restricted');
  }, 120_000);

  it('8.5.7 restrictedFirstSafetyNet: a relaxed solve that times out with nothing still leaves the restricted lineup', async () => {
    const fx = deepTeam();
    const real = nodeMipSolve();
    const order: string[] = [];
    const solver: MipSolve = (lp, options) => {
      const relaxed = /\bo\d+_\d+\b/.test(lp); // only the relaxed LP has outside variables
      order.push(relaxed ? 'relaxed' : 'restricted');
      return relaxed ? NO_RESULT(lp, options) : real(lp, options);
    };
    const result = await autoBuild(request(fx, { limits: { ...LIMITS, refineRounds: 0 } }), solver);
    expect(order[0]).toBe('restricted');
    expect(result.kind).toBe('improved');
    expect(['unknown', 'gap']).toContain(result.proof.status);
    expect(result.proof.bestFound).toBe(160);
    expect(result.proof.upperBound).toBeNull();
    if (result.kind === 'improved') expect(result.proposal.method).toBe('mip');
  }, 60_000);

  it('8.5.8 clockBudget: each solve gets 0.75 of its allotment, and the stages past the deadline are skipped in order', async () => {
    const fx = deepTeam();
    // 8 s limit, 3 s per solve: left() is 7000 ms, so restricted gets 3500 ms and relaxed gets 4000 ms. Then left() is 1000 ms:
    // the refinement round and the tie-break are both skipped.
    const a = fakeBudget(3000);
    const tight = await autoBuild(request(fx, { clock: a.clock, limits: { ...LIMITS, timeLimitSeconds: 8 } }), a.solve);
    expect(a.limits).toEqual([0.75 * 3.5, 0.75 * 4]);
    expect(stagesOf(tight)).toEqual(['restricted', 'relaxed']);
    expect(tight.kind).toBe('improved');
    expect(tight.proof).toMatchObject({ status: 'gap', bestFound: 160, upperBound: 174 });
    // 12 s limit: the refinement round fits (restricted 2500 ms, relaxed 2000 ms), then the tie-break is skipped.
    const b = fakeBudget(3000);
    const round = await autoBuild(request(fx, { clock: b.clock, limits: { ...LIMITS, timeLimitSeconds: 12 } }), b.solve);
    expect(b.limits).toEqual([0.75 * 5.5, 0.75 * 8, 0.75 * 2.5, 0.75 * 2]);
    expect(stagesOf(round)).toEqual(['restricted', 'relaxed', 'restricted', 'relaxed']);
    expect(round.proof).toMatchObject({ status: 'proven_optimal', bestFound: 174 });
    // Past the deadline after the first solve: relaxed is skipped (allotment under 200 ms), the restricted lineup stays.
    const c = fakeBudget(4000);
    const late = await autoBuild(request(fx, { clock: c.clock, limits: { ...LIMITS, timeLimitSeconds: 5 } }), c.solve);
    expect(stagesOf(late)).toEqual(['restricted']);
    expect(late.kind).toBe('improved');
    expect(late.proof).toMatchObject({ status: 'unknown', bestFound: 160, upperBound: null });
    // Evaluation time counts: a clock that moves 100 ms per read moves while the columns are evaluated, before the first solve.
    // The first restricted solve may use 0.5 of what is left, and 0.75 of that is its time_limit.
    const d = fakeBudget(0, 100);
    const timed = await autoBuild(request(fx, { clock: d.clock, limits: { ...LIMITS, timeLimitSeconds: 10 } }), d.solve);
    const evaluateMs = timed.proof.timings.evaluateMs as number;
    expect(evaluateMs).toBeGreaterThan(0);
    expect(((d.limits[0] as number) * 1000) / (0.75 * 0.5)).toBeLessThanOrEqual(10 * 1000 - 1000 - evaluateMs - 1);
    // Every time_limit is at most 0.75 of the time the call had left.
    for (const limit of [...a.limits, ...b.limits, ...c.limits]) expect(limit).toBeLessThanOrEqual(0.75 * 11);
  }, 60_000);

  it('refineAddsAtMostTwo: a refinement round adds at most 2 outside swimmers to an event, even when more are active', async () => {
    // Three own swimmers (n9, x0, x1) are outside the top 8 of E0. The relaxed solution uses all three. One round adds two.
    const fx = deepTeam(2);
    const result = await autoBuild(request(fx, { limits: { ...LIMITS, refineRounds: 1 } }), nodeMipSolve());
    expect(result.proof.searchSpace.events.find((e) => e.eventKey === 'E0')).toMatchObject({ candidates: 10, outside: 1 });
    expect(stagesOf(result)).toEqual(['restricted', 'relaxed', 'restricted', 'relaxed', 'tie-break']);
  }, 60_000);

  /** Runs HiGHS on the LP with its objective flipped to a minimum: a valid lineup with the fewest own points. */
  const worstOf =
    (real: MipSolve): MipSolve =>
    (lp, options) =>
      real(lp.replace('Maximize', 'Minimize'), options);

  it('boundTightens: a refinement round tightens the upper bound and the proof closes (the bound is the smallest seen)', async () => {
    // K = 1 leaves a bound of 60 against a best of 40 (outsideChargesCaps). With K_max = 2, t enters E2 in round 1 and E1 in round 2: the bound stays 60 after round 1 and is 57 after round 2.
    const specs: Spec[] = [
      { id: 'u1', team: 'A', times: { E1: 4000 } },
      { id: 'u2', team: 'A', times: { E2: 4000 } },
      { id: 't', team: 'A', times: { E1: 4500, E2: 4500 } },
    ];
    const fx: Fx = { model: buildModel(specs, ['E1', 'E2']), lineup: lineup(), tags: [], rules: rulesOf({ maxTotal: 1 }) };
    const result = await autoBuild(request(fx, { limits: { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 2, refineRounds: 2 } }), nodeMipSolve());
    expect(result.proof).toMatchObject({ status: 'proven_optimal', bestFound: 57, upperBound: 57, gap: 0 });
  }, 60_000);

  it('neverDiscardsBest: a later round that returns a worse lineup does not replace the best one found', async () => {
    const fx = deepTeam();
    const real = nodeMipSolve();
    const worst = worstOf(real);
    let restricted = 0;
    let relaxed = 0;
    const solver: MipSolve = (lp, options) => {
      if (/\bo\d+_\d+\b/.test(lp)) {
        relaxed += 1;
        return relaxed === 1 ? real(lp, options) : NO_RESULT(lp, options); // round 0 gives a bound and an outside swimmer, round 1 nothing
      }
      restricted += 1;
      if (restricted === 1) return real(lp, options); // 160
      if (restricted === 2) return worst(lp, options); // round 1: a valid lineup with fewer points
      return NO_RESULT(lp, options);
    };
    const result = await autoBuild(request(fx, { limits: { ...LIMITS, refineRounds: 1 } }), solver);
    expect(restricted).toBeGreaterThanOrEqual(2);
    expect(result.kind).toBe('improved');
    expect(result.proof).toMatchObject({ bestFound: 160, upperBound: 174 });
    if (result.kind === 'improved') expect(result.proposal.evaluation.ownPoints).toBe(160);
  }, 60_000);

  it('incumbentBelowCurrent: an incumbent below an in-space current lineup is not a model error, the result stays unchanged', async () => {
    const fx = mini(4);
    const accepted = await improvedLineup(fx);
    const current: Fx = { ...fx, lineup: accepted.lineup, tags: accepted.tags };
    const real = nodeMipSolve();
    let calls = 0;
    const solver: MipSolve = async (lp, options) => {
      calls += 1;
      if (calls > 1) return NO_RESULT(lp, options);
      const r = await worstOf(real)(lp, options);
      return { status: 'Time limit reached', objective: 0, columns: {}, incumbent: { objective: r.objective, columns: r.columns }, dualBound: null };
    };
    const result = await autoBuild(request(current), solver);
    expect(result).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
    expect(result.proof.bestFound).toBeLessThan(result.current.objective);
  }, 60_000);

  it('8.5.9 tieBreakSkippedWhenLate: with under 2000 ms left after the relaxed solve, no tie-break is issued', async () => {
    const fx = deepTeam();
    const limits = { ...LIMITS, candidatesPerEvent: 9, timeLimitSeconds: 10 }; // K = 9: nothing is outside, the relaxed solve proves it
    const late = fakeBudget(3600); // after two solves left() is 1800 ms
    const skipped = await autoBuild(request(fx, { clock: late.clock, limits }), late.solve);
    expect(stagesOf(skipped)).toEqual(['restricted', 'relaxed']);
    expect(skipped.proof.status).toBe('proven_optimal');
    expect(late.limits).toHaveLength(2);
    const early = fakeBudget(100);
    const ran = await autoBuild(request(fx, { clock: early.clock, limits }), early.solve);
    expect(stagesOf(ran)).toEqual(['restricted', 'relaxed', 'tie-break']);
  }, 60_000);

  it('8.5.10 incumbentGated: a verified incumbent passes the gate as mip-incumbent, and a tampered one throws model_mismatch', async () => {
    const fx = deepTeam();
    const incumbent = (tamper: 'none' | 'objective' | 'missing'): MipSolve => {
      const real = nodeMipSolve();
      let calls = 0;
      return async (lp, options) => {
        calls += 1;
        if (calls > 1) return NO_RESULT(lp, options);
        const r = await real(lp, options);
        const columns = { ...r.columns };
        if (tamper === 'missing') delete columns[Object.keys(columns).find((n) => /^y\d+_\d+$/.test(n) && columns[n] === 1) as string];
        const objective = tamper === 'objective' ? r.objective + 1 : r.objective;
        return { status: 'Time limit reached', objective: 0, columns: {}, incumbent: { objective, columns }, dualBound: null };
      };
    };
    const result = await autoBuild(request(fx), incumbent('none'));
    expect(result.kind).toBe('improved');
    if (result.kind === 'improved') {
      expect(result.proposal.method).toBe('mip-incumbent');
      expect(result.proposal.evaluation.objective).toBe(160);
    }
    expect(result.proof.status).toBe('unknown');
    for (const tamper of ['objective', 'missing'] as const) {
      expect((await autoError(() => autoBuild(request(fx), incumbent(tamper)))).code, tamper).toBe('model_mismatch');
    }
  }, 60_000);
});
