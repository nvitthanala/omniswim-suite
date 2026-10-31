/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A6: the `margin` and `goal-seek` objectives (plans/2026-10-25/D5-AUTOBUILDER.md, 4.7, 6.2, 8.4 and 12.6). Every fixture
 * is synthetic and every rule is the shipped `nsisc` v4 with the settings a test names changed through `engineTestPresets.set`. No time,
 * point value or standard here is a competition value. The oracle is `scoreMeet`: each brute force scores every own entry set of the
 * search space through a whole-meet `scoreMeet` call, and the AutoBuilder must equal the best one by the mode's own metric.
 *
 * The change count of the brute force is written out here from the lineups (entries added or removed, plus the roster adds), so a drift
 * in the engine's D5 4.9 count shows as a difference.
 */
import { describe, expect, it, vi } from 'vitest';
import { AutoBuildError, autoBuild, BUILTIN_SESSION_PRESETS, builtinRulePreset, entryKey, requireComplete, scoreMeet, sessionLoad } from '@omniswim/engine';
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
  MeetSwim,
  MipSolve,
  PerEventScorerCap,
  RelaySplit,
  RulePreset,
  ScheduledEvent,
  ScorerTag,
  SessionPreset,
} from '@omniswim/engine';
import type { gate as GateFn } from '../packages/engine/src/autobuilder/gate';
import { lambdaOf, metricOf, step } from '../packages/engine/src/autobuilder/mode';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set, TEST_PROVENANCE } from './engineTestPresets';

// Every call of the gate by the AutoBuilder, kept with the real function: test 14 calls it again with one argument made wrong.
type GateArgs = Parameters<typeof GateFn>;
const gateSeen = vi.hoisted(() => ({ calls: [] as unknown[][], real: null as unknown as typeof GateFn }));
vi.mock('../packages/engine/src/autobuilder/gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/engine/src/autobuilder/gate')>();
  gateSeen.real = real.gate;
  return {
    ...real,
    gate: (...args: Parameters<typeof real.gate>) => {
      gateSeen.calls.push(args);
      return real.gate(...args);
    },
  };
});

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const BACK = '100 Backstroke';
const FLY = '100 Butterfly';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';
type Gender = 'Men' | 'Women';

const NSISC_SESSIONS = (BUILTIN_SESSION_PRESETS[0] as { preset: SessionPreset }).preset;
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

// ---- the oracle: every own entry set, with every team's total ------------------------------------

type Metric = { readonly kind: 'total' } | { readonly kind: 'margin'; readonly rival: string } | { readonly kind: 'closest' };

const objectiveFor = (m: Metric): AutoBuildRequest['objective'] =>
  m.kind === 'total' ? { kind: 'max-own' } : { kind: 'margin', rival: m.kind === 'margin' ? { kind: 'team', teamId: m.rival } : { kind: 'closest' } };

const goalFor = (m: Metric, points: number): AutoBuildRequest['objective'] => ({
  kind: 'goal-seek',
  target: m.kind === 'total' ? { kind: 'total', points } : { kind: 'margin', rival: m.kind === 'margin' ? { kind: 'team', teamId: m.rival } : { kind: 'closest' }, points },
});

type Totals = Readonly<Record<string, number>>;
const totalsOf = (results: { teams: readonly { teamId: string; points: number }[] }): Totals => Object.fromEntries(results.teams.map((t) => [t.teamId, t.points]));
const at = (totals: Totals, team: string): number => totals[team] as number;

/** The metric of a meet, from its team totals: own points, own less a team, or own less the best of the others. */
function valueOf(totals: Totals, m: Metric): number {
  const own = at(totals, 'A');
  if (m.kind === 'total') return own;
  if (m.kind === 'margin') return own - at(totals, m.rival);
  return own - Math.max(...Object.keys(totals).filter((id) => id !== 'A').map((id) => at(totals, id)));
}

interface Row {
  readonly totals: Totals;
  /** Entries added or removed plus roster adds, from the D5 4.9 definition written out for the brute force. */
  readonly changes: number;
  /** With a session load: the own scorers' races above the maximum, and whether an own scorer is over it. */
  readonly extra: number;
  readonly over: boolean;
}

const rowsCache = new Map<string, readonly Row[]>();

/** Every own entry set that fits the size and the total cap, scored as a whole meet. */
function bruteRows(key: string, fx: Mini, sizeUnits = 9, load: NonNullable<AutoBuildRequest['load']> | null = null): readonly Row[] {
  const cached = rowsCache.get(key);
  if (cached !== undefined) return cached;
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
  const current = (id: string): string[] => fx.lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A' && e.swimmerId === id).map((e) => e.eventKey);
  const choice = new Map<string, Choice>();
  const changesOf = (): number => {
    let n = 0;
    for (const [id, c] of choice) {
      if (c === null) continue;
      const cur = current(id);
      n += c.filter((e) => !cur.includes(e)).length + cur.filter((e) => !c.includes(e)).length + (fx.pinned.includes(id) ? 0 : 1);
    }
    return n;
  };
  const spots = (): number => {
    let sum = 0;
    for (const c of choice.values()) if (c !== null) sum += c.length > 0 && c.every((e) => e === DIVE) ? 1 : 3;
    return sum;
  };
  const rows: Row[] = [];
  const visit = (i: number): void => {
    if (spots() > sizeUnits) return;
    if (i === ids.length) {
      const joined = ids.filter((id) => choice.get(id) !== null && !fx.pinned.includes(id));
      const l = compose(fx, choice);
      const scorers = [...fx.tags, ...tags('A', joined)];
      const results = scoreMeet(fx.model, l, scorers, fx.rules, SOURCING);
      let extra = 0;
      let over = false;
      if (load !== null) {
        const run = sessionLoad(fx.model, l, results, load.schedule, load.preference, fx.rules);
        const own = new Set(scorers.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
        const max = load.preference.mode === 'off' || load.preference.maxRacesPerSession.state !== 'set' ? 0 : load.preference.maxRacesPerSession.value;
        over = run.violations.some((v) => v.kind === 'session_load' && own.has(v.swimmerId));
        for (const sw of run.perSwimmer) if (own.has(sw.swimmerId)) for (const x of sw.sessions) if (x.races > max) extra += x.races - max;
      }
      rows.push({ totals: totalsOf(results), changes: changesOf(), extra, over });
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
  rowsCache.set(key, rows);
  return rows;
}

const bestOf = (rows: readonly Row[], m: Metric): number => Math.max(...rows.map((r) => valueOf(r.totals, m)));
const metricOfResults = (results: { teams: readonly { teamId: string; points: number }[] }, m: Metric): number => valueOf(totalsOf(results), m);
const objectiveOf = (r: AutoBuildResult): number => (r.kind === 'improved' ? r.proposal.evaluation.objective : r.current.objective);

const METRICS: readonly Metric[] = [{ kind: 'margin', rival: 'B' }, { kind: 'margin', rival: 'C' }, { kind: 'closest' }];
const SEEDS = [0, 1, 2, 3, 4, 5, 6, 7];

// ---- hand fixtures --------------------------------------------------------------------------------

/**
 * Own swimmer S enters one event (total cap 1). In FREE two rivals stand behind him: he scores 20 and takes 3 + 1 from them (24 of margin).
 * In BACK two rivals are ahead and eleven behind: he scores 16 and takes 13 from them (29 of margin). Maximizing own points enters FREE.
 * The margin over R enters BACK.
 */
function trap(): Fx {
  const specs: Spec[] = [{ id: 'S', team: 'A', times: { [FREE]: 4700, [BACK]: 4700 } }];
  ['r1', 'r2'].forEach((id, i) => specs.push({ id, team: 'R', times: { [FREE]: 4800 + i * 100 } }));
  for (let i = 1; i <= 13; i++) specs.push({ id: `rb${i}`, team: 'R', times: { [BACK]: i <= 2 ? 4400 + i * 100 : 4700 + (i - 2) * 100 } });
  const rIds = specs.filter((s) => s.team === 'R').map((s) => s.id);
  const entries: LineupEntry[] = [];
  for (const s of specs) if (s.team === 'R') for (const e of Object.keys(s.times)) entries.push(ind('R', s.id, e));
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(...entries),
    tags: [...tags('A', ['S']), ...tags('R', rIds)],
    rules: rulesOf({ maxTotal: 1 }),
  };
}

const CROWD_TIMES = [4400, 4500, 4600, 4700, 4800, 4900, 5000, 5100, 5200, 5300, 5400, 5500, 5600];

/**
 * Three own swimmers who could each swim any of three events, against 9 + 4 rivals: a crowded field, so pushing a rival down costs it
 * points and the margin lineup often differs from the own-points lineup. Times repeat, so ties occur.
 */
function crowd(seed: number): Mini {
  const next = rng(seed * 104729 + 7);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const events = [FREE, BACK, FLY];
  const ownIds = ['a0', 'a1', 'a2'];
  const specs: Spec[] = ownIds.map((id) => ({ id, team: 'A', times: Object.fromEntries(events.map((e) => [e, pick(CROWD_TIMES)])) }));
  const rivals: [string, string][] = [
    ...['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'].map((id) => ['B', id] as [string, string]),
    ...['c0', 'c1', 'c2', 'c3'].map((id) => ['C', id] as [string, string]),
  ];
  for (const [team, id] of rivals) specs.push({ id, team, times: Object.fromEntries(events.map((e) => [e, pick(CROWD_TIMES)])) });
  const entries: LineupEntry[] = [];
  for (const [team, id] of rivals) for (const e of events) if (next() < 0.85) entries.push(ind(team, id, e));
  const pinned = seed % 2 === 0 ? ownIds : ownIds.slice(0, 2);
  const cap: PerEventScorerCap = seed % 3 === 1 ? { cap: 2, overCap: 'removed-from-consideration' } : { cap: 'unlimited' };
  return {
    model: buildModel(specs, events),
    lineup: lineup(...entries),
    tags: [...tags('A', pinned), ...tags('B', rivals.filter(([t]) => t === 'B').map(([, id]) => id)), ...tags('C', rivals.filter(([t]) => t === 'C').map(([, id]) => id))],
    rules: rulesOf({ ties: seed % 3 === 0 ? 'ordered' : 'split', size: 'unlimited', maxTotal: 2, cap }),
    pinned,
    free: ownIds.filter((id) => !pinned.includes(id)),
    options: Object.fromEntries(ownIds.map((id) => [id, events])),
  };
}

interface World {
  readonly key: string;
  readonly fx: Mini;
  /** The size of the scoring team in spot units for the brute force. */
  readonly units: number;
}

const worlds = (): World[] => [
  ...SEEDS.map((seed) => ({ key: `mini${seed}`, fx: mini(seed), units: 9 })),
  ...[0, 1, 2, 3, 4, 5].map((seed) => ({ key: `crowd${seed}`, fx: crowd(seed), units: 1e9 })),
];

const swimmerEvents = (r: AutoBuildResult): string[] => {
  if (r.kind !== 'improved') return [];
  return r.proposal.lineup.entries.flatMap((e) => (e.kind === 'individual' && e.teamId === 'A' ? [e.eventKey] : []));
};

const NEVER: MipSolve = async () => {
  throw new Error('the solver must not run');
};

// ---- fixtures for goal seek and the bound ----------------------------------------------------------

/**
 * Own swimmers each alone in an event E1..En where three rivals of team R score 20-17-16. Entering an event scores 20 and takes
 * 3 + 1 + 1 = 5 from R. The current lineup holds R's entries only, so each entry costs one change and the target decides how many.
 */
function steps(pinned: number, freeJoiner = false): Fx {
  const specs: Spec[] = [];
  const events: string[] = [];
  for (let i = 1; i <= pinned + (freeJoiner ? 1 : 0); i++) events.push(`E${i}`);
  for (let i = 1; i <= pinned; i++) specs.push({ id: `p${i}`, team: 'A', times: { [`E${i}`]: 4500 } });
  if (freeJoiner) specs.push({ id: 'f', team: 'A', times: { [`E${pinned + 1}`]: 4500 } });
  const entries: LineupEntry[] = [];
  for (const e of events) {
    for (let j = 1; j <= 3; j++) {
      specs.push({ id: `r${e}${j}`, team: 'R', times: { [e]: 5000 + j * 100 } });
      entries.push(ind('R', `r${e}${j}`, e));
    }
  }
  return {
    model: buildModel(specs, events),
    lineup: lineup(...entries),
    tags: [...tags('A', Array.from({ length: pinned }, (_, i) => `p${i + 1}`)), ...tags('R', specs.filter((s) => s.team === 'R').map((s) => s.id))],
    rules: rulesOf(),
  };
}

/** The own team's own points less R's, in the current lineup of `steps`: 0 - 53 per event. */
const stepsMargin = (events: number): number => -53 * events;

const asGoal = (fx: Fx, objective: AutoBuildRequest['objective'], over: Partial<AutoBuildRequest> = {}): AutoBuildRequest => request(fx, { objective, ...over });

/** The fixture of D5 test 3 (`deepTeamNeedsNinth`): eight own swimmers each worth 20 in an event of their own, and a ninth for E0. */
function deep(): Fx {
  const eventKeys = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
  const specs: Spec[] = [];
  for (let i = 1; i <= 8; i++) specs.push({ id: `n${i}`, team: 'A', times: { E0: 4000 + i * 10, [`E${i}`]: 4500 } });
  specs.push({ id: 'n9', team: 'A', times: { E0: 5000 } });
  ['b0', 'b1', 'b2', 'b3'].forEach((id, i) => specs.push({ id, team: 'B', times: { E0: 4600 + i * 50 } }));
  return {
    model: buildModel(specs, eventKeys),
    lineup: lineup(...['b0', 'b1', 'b2', 'b3'].map((id) => ind('B', id, 'E0'))),
    tags: tags('B', ['b0', 'b1', 'b2', 'b3']),
    rules: rulesOf({ size: 18, maxTotal: 1 }),
  };
}

/**
 * Margin over B with uneven NSISC steps (20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1). Three own swimmers are faster than everyone and enter
 * one event, except p3, who is 2nd behind C's first. Team C stands 1st to 3rd, team B 4th to 12th, so each own entry pushes B's entries across
 * the 11-9-7 steps.
 */
function uneven(): Fx {
  const specs: Spec[] = [{ id: 'p1', team: 'A', times: { E0: 4000 } }, { id: 'p2', team: 'A', times: { E0: 4010 } }, { id: 'p3', team: 'A', times: { E0: 4115 } }];
  for (let i = 1; i <= 3; i++) specs.push({ id: `c${i}`, team: 'C', times: { E0: 4100 + i * 10 } });
  for (let i = 1; i <= 9; i++) specs.push({ id: `b${i}`, team: 'B', times: { E0: 4300 + i * 10 } });
  const rivals = specs.filter((s) => s.team !== 'A').map((s) => s.id);
  return {
    model: buildModel(specs, ['E0']),
    lineup: lineup(...specs.filter((s) => s.team !== 'A').map((s) => ind(s.team, s.id, 'E0'))),
    tags: [...tags('A', ['p1', 'p2', 'p3']), ...tags('B', rivals.filter((id) => id.startsWith('b'))), ...tags('C', rivals.filter((id) => id.startsWith('c')))],
    rules: rulesOf(),
  };
}

/** The brute force of `uneven`: each of three own swimmers enters E0 or not. */
function unevenRows(fx: Fx): Totals[] {
  const out: Totals[] = [];
  for (let mask = 0; mask < 8; mask++) {
    const ids = ['p1', 'p2', 'p3'].filter((_, i) => (mask >> i) & 1);
    out.push(totalsOf(scoreMeet(fx.model, lineup(...fx.lineup.entries, ...ids.map((id) => ind('A', id, 'E0'))), fx.tags, fx.rules, SOURCING)));
  }
  return out;
}

/** The coefficient of a variable in a text, summed over the whole LP (objective and rows): every `+ k name` or `- k name`. */
function coefficients(text: string, name: string): number[] {
  return [...text.matchAll(new RegExp(`([+-]) (\\d+) ${name}(?![\\w])`, 'g'))].map((m) => (m[1] === '-' ? -1 : 1) * Number(m[2]));
}

/** The objective of an LP text: the text between `Maximize` and `Subject To`. */
const objectiveText = (text: string): string => text.slice(text.indexOf('Maximize'), text.indexOf('Subject To'));

// ---- relays ------------------------------------------------------------------------------------------

/**
 * Own swimmers o1..o8 (a flat 100 free and a flying split each), against team B's two relays and team C's one. The own squads are faster
 * than every rival relay, so an own relay always takes a place from them.
 */
function relayWorld(seed: number): Fx {
  const next = rng(seed * 7717 + 3);
  const specs: Spec[] = [];
  for (let i = 1; i <= 8; i++) specs.push({ id: `o${i}`, team: 'A', times: { [FREE]: 4600 + Math.floor(next() * 160) } });
  for (let i = 1; i <= 8; i++) specs.push({ id: `b${i}`, team: 'B', times: { [FREE]: 5000 + i * 20 + Math.floor(next() * 20) } });
  for (let i = 1; i <= 4; i++) specs.push({ id: `c${i}`, team: 'C', times: { [FREE]: 4950 + i * 20 + Math.floor(next() * 20) } });
  return {
    model: buildModel(specs, [RELAY]),
    lineup: lineup(relay('B', 'A', ['b1', 'b2', 'b3', 'b4']), relay('B', 'B', ['b5', 'b6', 'b7', 'b8']), relay('C', 'A', ['c1', 'c2', 'c3', 'c4'])),
    tags: [...tags('A', Array.from({ length: 8 }, (_, i) => `o${i + 1}`)), ...tags('B', specs.filter((s) => s.team === 'B').map((s) => s.id)), ...tags('C', ['c1', 'c2', 'c3', 'c4'])],
    rules: rulesOf({ size: 18 }),
  };
}

const combos = <T,>(items: readonly T[], k: number): T[][] => {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items as [T, ...T[]];
  return [...combos(rest, k - 1).map((c) => [head, ...c]), ...combos(rest, k)];
};

/** The team totals of every legal own relay choice: none, one squad, or two disjoint squads, each four swimmers with a leadoff. */
function relayRows(fx: Fx): Totals[] {
  const ids = Array.from({ length: 8 }, (_, i) => `o${i + 1}`);
  const squads = combos(ids, 4).flatMap((four) => four.map((lead) => [lead, ...four.filter((x) => x !== lead)]));
  const choices: string[][][] = [[]];
  for (const q of squads) choices.push([q]);
  for (let i = 0; i < squads.length; i++) {
    for (let j = i + 1; j < squads.length; j++) {
      const a = squads[i] as string[];
      const b = squads[j] as string[];
      if (a.every((x) => !b.includes(x))) choices.push([a, b]);
    }
  }
  return choices.map((choice) => {
    const entries = [...fx.lineup.entries, ...choice.map((squad, i) => relay('A', 'AB'[i] as string, squad))];
    return totalsOf(scoreMeet(fx.model, lineup(...entries), fx.tags, fx.rules, SOURCING));
  });
}

/** `step` of D5 6.2, written out for the test: the largest drop of the table from place q to q + 1, over every q at or after the place. */
function stepAt(table: readonly number[], place: number): number {
  let best = 0;
  for (let q = place; q <= table.length; q++) best = Math.max(best, (table[q - 1] as number) - (table[q] ?? 0));
  return best;
}
const NSISC_RELAY = [40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2];

// ---- session load and stub solvers -----------------------------------------------------------------

const timedFinal = (eventKey: string): ScheduledEvent => ({ eventKey, gender: 'both', format: { kind: 'timed-final', session: { day: 1, slot: 'evening' } } });
const prelimsFinals = (eventKey: string): ScheduledEvent => ({
  eventKey,
  gender: 'both',
  format: { kind: 'prelims-finals', prelims: { day: 1, slot: 'morning' }, finals: { day: 1, slot: 'evening' } },
});
const crowdLoad = (preference: LoadPreference): NonNullable<AutoBuildRequest['load']> => ({
  schedule: { payloadVersion: 1, provenance: TEST_PROVENANCE, events: [prelimsFinals(FREE), timedFinal(BACK), prelimsFinals(FLY)] },
  preference,
});
const respect = (max: number): LoadPreference => ({ mode: 'respect', maxRacesPerSession: set(max), diving: set('excluded' as const) });
const prefer = (max: number, penalty: number): LoadPreference => ({ mode: 'prefer', maxRacesPerSession: set(max), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(penalty) });

/** The value of a brute-force row under a load: the metric less the penalty (prefer), or `null` when respect is broken. */
function loadedValue(row: Row, m: Metric, preference: LoadPreference): number | null {
  if (preference.mode === 'respect' && row.over) return null;
  const pen = preference.mode === 'prefer' && preference.penaltyPointsPerExtraRace.state === 'set' ? preference.penaltyPointsPerExtraRace.value : 0;
  return valueOf(row.totals, m) - pen * row.extra;
}

/** A solver that reaches its time limit with nothing: the restricted solve ends the sequence without a lineup, and the fallback may run. */
const TIMES_OUT: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });

describe('autoBuild (D5, slice A6: margin and goal seek)', () => {
  it('1 marginTrap: the margin over a team enters a different event than max-own', async () => {
    const fx = trap();
    const own = await autoBuild(request(fx), nodeMipSolve());
    expect(swimmerEvents(own)).toEqual([FREE]);
    const margin = await autoBuild(request(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'R' } } }), nodeMipSolve());
    expect(margin.kind).toBe('improved');
    expect(swimmerEvents(margin)).toEqual([BACK]);
    expect(margin.proof.status).toBe('proven_optimal');
    if (own.kind !== 'improved' || margin.kind !== 'improved') return;
    // Max-own: +20 own. Margin: +16 own and -13 for R, so a margin of +29 against +24 for the max-own lineup.
    const base = totalsOf(scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING));
    const delta = (l: { proposal: { lineup: Lineup; tagsForScoring: readonly ScorerTag[] } }): { own: number; rival: number } => {
      const after = totalsOf(scoreMeet(fx.model, l.proposal.lineup, l.proposal.tagsForScoring, fx.rules, SOURCING));
      return { own: at(after, 'A') - at(base, 'A'), rival: at(after, 'R') - at(base, 'R') };
    };
    expect(delta(own)).toEqual({ own: 20, rival: -4 });
    expect(delta(margin)).toEqual({ own: 16, rival: -13 });
    expect(margin.proposal.evaluation.objective - margin.current.objective).toBe(29);
    expect(margin.proposal.evaluation.rival).toEqual({ teamId: 'R', points: at(base, 'R') - 13 });
    expect(margin.current.rival).toEqual({ teamId: 'R', points: at(base, 'R') });
  });

  it('2 marginAndClosestBruteForce: seeded fixtures equal the best own entry set by margin over a team and by the closest margin', async () => {
    for (const { key: seed, fx, units } of worlds()) {
      const rows = bruteRows(seed, fx, units);
      expect(rows.length, `seed ${seed}`).toBeGreaterThan(50);
      for (const metric of METRICS) {
        const result = await autoBuild(request(fx, { objective: objectiveFor(metric) }), nodeMipSolve());
        const label = `seed ${seed} ${JSON.stringify(metric)}`;
        expect(result.kind === 'improved' || result.kind === 'unchanged', label).toBe(true);
        expect(result.proof.status, label).toBe('proven_optimal');
        expect(objectiveOf(result), label).toBeCloseTo(bestOf(rows, metric), 9);
        if (result.kind === 'improved') {
          const again = scoreMeet(fx.model, result.proposal.lineup, result.proposal.tagsForScoring, fx.rules, SOURCING);
          expect(metricOfResults(again, metric), label).toBeCloseTo(bestOf(rows, metric), 9);
          if (metric.kind === 'closest') {
            const binding = result.proposal.evaluation.rival;
            expect(binding, label).not.toBeNull();
            expect(at(totalsOf(again), binding?.teamId as string), label).toBe(binding?.points);
            expect(binding?.points, label).toBe(Math.max(at(totalsOf(again), 'B'), at(totalsOf(again), 'C')));
          }
        }
      }
    }
  }, 300_000);

it('3 goalSeekOneChange: the target is reached with 1 change where max-own uses 4, and changeCount is the entry changes plus the roster adds', async () => {
    const fx = steps(4);
    const own = await autoBuild(request(fx), nodeMipSolve());
    expect(own.kind).toBe('improved');
    if (own.kind === 'improved') expect(own.proposal.changeCount).toBe(4);
    const goal = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 20)), nodeMipSolve());
    expect(goal.kind).toBe('improved');
    if (goal.kind !== 'improved') return;
    expect(goal.proposal.changeCount).toBe(1);
    expect(goal.proposal.entryChanges).toHaveLength(1);
    expect(goal.proposal.entryChanges[0]?.kind).toBe('added');
    expect(goal.proposal.rosterAdds).toHaveLength(0);
    expect(goal.proposal.evaluation.objective).toBe(20);
    expect(goal.proof).toMatchObject({ status: 'proven_optimal', bestFound: 1, upperBound: 1, gap: 0 });
    expect(goal.current.objective).toBe(0);
    // Between the steps: a target of 20.5 needs the second entry, and 80 all four. 81 cannot be reached.
    const between = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 20.5)), nodeMipSolve());
    expect(between.kind === 'improved' && between.proposal.changeCount).toBe(2);
    expect(between.kind === 'improved' && between.proposal.evaluation.objective).toBe(40);
    const all = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 80)), nodeMipSolve());
    expect(all.kind === 'improved' && all.proposal.changeCount).toBe(4);
    // The margin over R: each entry is worth 20 + 5 = 25. The margin of the current lineup is -212.
    for (const metric of [{ kind: 'margin', rival: 'R' }, { kind: 'closest' }] as const) {
      for (const [gain, changes] of [[25, 1], [26, 2], [50, 2], [51, 3], [100, 4]] as const) {
        const r = await autoBuild(asGoal(fx, goalFor(metric, stepsMargin(4) + gain)), nodeMipSolve());
        expect(r.kind, `${metric.kind} +${gain}`).toBe('improved');
        if (r.kind !== 'improved') continue;
        expect(r.proposal.changeCount, `${metric.kind} +${gain}`).toBe(changes);
        expect(r.proposal.evaluation.objective, `${metric.kind} +${gain}`).toBeGreaterThanOrEqual(stepsMargin(4) + gain);
        expect(r.proposal.evaluation.rival?.teamId).toBe('R');
      }
    }
  });

  it('3b goalSeekRosterAdds: a joining swimmer costs his entry and his roster spot, and changeCount counts both', async () => {
    const fx = steps(1, true);
    const r = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 40)), nodeMipSolve());
    expect(r.kind).toBe('improved');
    if (r.kind !== 'improved') return;
    expect(r.proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['f']);
    expect(r.proposal.entryChanges).toHaveLength(2);
    expect(r.proposal.changeCount).toBe(r.proposal.entryChanges.length + r.proposal.rosterAdds.length);
    expect(r.proposal.changeCount).toBe(3);
    expect(r.proposal.tagsForScoring.some((t) => t.swimmerId === 'f' && t.role === 'scorer')).toBe(true);
    // A target one swimmer can reach needs no roster add.
    const one = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 20)), nodeMipSolve());
    expect(one.kind === 'improved' && one.proposal.changeCount).toBe(1);
    expect(one.kind === 'improved' && one.proposal.rosterAdds.length).toBe(0);
  });

  it('3c goalSeekBruteForce: seeded fixtures equal the fewest changes that whole-meet scoreMeet finds among the lineups that reach the target', async () => {
    let improved = 0;
    for (const { key, fx, units } of worlds()) {
      const rows = bruteRows(key, fx, units);
      const current = totalsOf(scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING));
      for (const metric of [{ kind: 'total' }, ...METRICS] as const) {
        const best = bestOf(rows, metric);
        const now = valueOf(current, metric);
        if (best <= now + 1e-9) continue;
        for (const target of [Math.ceil((now + (best - now) / 2) * 10) / 10, best]) {
          const label = `${key} ${JSON.stringify(metric)} target ${target}`;
          const reaching = rows.filter((r) => valueOf(r.totals, metric) >= target - 1e-9);
          const fewest = Math.min(...reaching.map((r) => r.changes));
          const result = await autoBuild(asGoal(fx, goalFor(metric, target)), nodeMipSolve());
          expect(result.kind, label).toBe('improved');
          if (result.kind !== 'improved') continue;
          improved += 1;
          const again = scoreMeet(fx.model, result.proposal.lineup, result.proposal.tagsForScoring, fx.rules, SOURCING);
          expect(metricOfResults(again, metric), label).toBeGreaterThanOrEqual(target - 1e-9);
          expect(result.proposal.evaluation.objective, label).toBeCloseTo(metricOfResults(again, metric), 9);
          expect(result.proposal.changeCount, label).toBe(result.proposal.entryChanges.length + result.proposal.rosterAdds.length);
          expect(result.proof.bestFound, label).toBe(result.proposal.changeCount);
          // Exact with a per-event cap of 1 with removal too: the column prune keeps every column a fewest-changes lineup needs.
          expect(result.proposal.changeCount, label).toBe(fewest);
        }
      }
    }
    expect(improved, 'the fixtures must exercise goal seek').toBeGreaterThan(20);
  }, 300_000);

  it('3d currentMeetsTarget: a feasible current lineup at the target returns unchanged with a zero-change proof, and no solve runs', async () => {
    const fx = steps(2);
    const solved = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 0), { limits: LIMITS }), NEVER);
    expect(solved.kind).toBe('unchanged');
    if (solved.kind !== 'unchanged') return;
    expect(solved.reason).toBe('current_meets_target');
    expect(solved.proof).toMatchObject({ status: 'proven_optimal', bestFound: 0, upperBound: 0, gap: 0, solves: [] });
    expect(solved.current.objective).toBe(0);
    const margin = await autoBuild(asGoal(fx, goalFor({ kind: 'margin', rival: 'R' }, stepsMargin(2))), NEVER);
    expect(margin.kind === 'unchanged' && margin.reason).toBe('current_meets_target');
    // One point above the current lineup is not met: the solver runs.
    const above = await autoBuild(asGoal(fx, goalFor({ kind: 'margin', rival: 'R' }, stepsMargin(2) + 1)), nodeMipSolve());
    expect(above.kind).toBe('improved');
  });

  it('3e goalSeekCurrentInfeasible: a current lineup over the entry cap returns current_infeasible with an alternative that reaches the target', async () => {
    const specs: Spec[] = [{ id: 'p1', team: 'A', times: { E1: 4500, E2: 4500 } }];
    for (const e of ['E1', 'E2']) for (let j = 1; j <= 3; j++) specs.push({ id: `r${e}${j}`, team: 'R', times: { [e]: 5000 + j * 100 } });
    const rIds = specs.filter((s) => s.team === 'R').map((s) => s.id);
    const fx: Fx = {
      model: buildModel(specs, ['E1', 'E2']),
      lineup: lineup(ind('A', 'p1', 'E1'), ind('A', 'p1', 'E2'), ...specs.filter((s) => s.team === 'R').flatMap((s) => Object.keys(s.times).map((e) => ind('R', s.id, e)))),
      tags: [...tags('A', ['p1']), ...tags('R', rIds)],
      rules: rulesOf({ maxTotal: 1 }),
    };
    const r = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 20)), nodeMipSolve());
    expect(r.kind).toBe('current_infeasible');
    if (r.kind !== 'current_infeasible') return;
    expect(r.currentViolations.some((v) => v.kind === 'entry_cap')).toBe(true);
    expect(r.alternative).not.toBeNull();
    expect(r.alternative?.changeCount).toBe(1);
    expect(r.alternative?.evaluation.objective).toBe(20);
  });

  it('4 targetUnreachable: a target above the best lineup gives target_unreachable, proven, with a proven proof', async () => {
    for (const { key, fx, units } of worlds().slice(0, 10)) {
      const rows = bruteRows(key, fx, units);
      for (const metric of [{ kind: 'total' }, ...METRICS] as const) {
        const label = `${key} ${JSON.stringify(metric)}`;
        const best = bestOf(rows, metric);
        const result = await autoBuild(asGoal(fx, goalFor(metric, best + 1)), nodeMipSolve());
        expect(result.kind, label).toBe('target_unreachable');
        if (result.kind !== 'target_unreachable') continue;
        expect(result.reason, label).toBe('proven');
        expect(result.proof.status, label).toBe('proven_optimal');
        // The best lineup itself is reachable.
        const reachable = await autoBuild(asGoal(fx, goalFor(metric, best)), nodeMipSolve());
        expect(reachable.kind === 'improved' || reachable.kind === 'unchanged', label).toBe(true);
      }
    }
    const fx = steps(2);
    const none = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 41)), nodeMipSolve());
    expect(none).toMatchObject({ kind: 'target_unreachable', reason: 'proven', proof: { status: 'proven_optimal', bestFound: 0, upperBound: null, gap: null } });
    if (none.kind === 'target_unreachable') expect(none.current.objective).toBe(0);
  }, 300_000);

  it('4b targetWithinLimits: a target the restricted columns cannot reach but the bound allows is within_limits, and one refinement round reaches it', async () => {
    const fx = deep();
    // With eight candidates the best lineup scores 160 and the relaxed bound is 174; the true best, with the ninth swimmer, is 174.
    const limits = { ...LIMITS, refineRounds: 0 };
    const within = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 170), { limits }), nodeMipSolve());
    expect(within).toMatchObject({ kind: 'target_unreachable', reason: 'within_limits', proof: { status: 'unknown', bestFound: 0, upperBound: null } });
    const refined = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 170), { limits: { ...limits, refineRounds: 1 } }), nodeMipSolve());
    expect(refined.kind).toBe('improved');
    if (refined.kind === 'improved') {
      expect(refined.proposal.evaluation.objective).toBeGreaterThanOrEqual(170);
      expect(refined.proposal.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 'n9')).toBe(true);
    }
    // 175 is above the bound, so even the relaxed MIP is infeasible: proven.
    const proven = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 175), { limits }), nodeMipSolve());
    expect(proven).toMatchObject({ kind: 'target_unreachable', reason: 'proven', proof: { status: 'proven_optimal' } });
  }, 60_000);

  it('5 marginBoundCoversOptimum: with one candidate and no refinement, bestFound <= the brute-force optimum <= upperBound for margin and closest', async () => {
    let gaps = 0;
    const limits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    for (const { key, fx, units } of worlds()) {
      const rows = bruteRows(key, fx, units);
      for (const metric of METRICS) {
        const label = `${key} ${JSON.stringify(metric)}`;
        const result = await autoBuild(request(fx, { objective: objectiveFor(metric), limits }), nodeMipSolve());
        const best = bestOf(rows, metric);
        expect(result.proof.upperBound, label).not.toBeNull();
        expect(result.proof.bestFound, label).toBeLessThanOrEqual(best + 1e-9);
        expect(best, label).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
        if (result.proof.status === 'gap') gaps += 1;
      }
    }
    expect(gaps, 'K = 1 must leave a gap somewhere, or the fixtures prove nothing about the bound').toBeGreaterThan(0);
  }, 300_000);

  it('5b unevenSteps: the margin bound charges the rival with the largest step at or behind its place, not the step at its place', async () => {
    const fx = uneven();
    const rows = unevenRows(fx);
    const limits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    for (const metric of [{ kind: 'margin', rival: 'B' }, { kind: 'closest' }] as const) {
      const solver = nodeMipSolve();
      const result = await autoBuild(request(fx, { objective: objectiveFor(metric), limits }), solver);
      const best = Math.max(...rows.map((r) => valueOf(r, metric)));
      expect(result.proof.bestFound).toBeLessThanOrEqual(best + 1e-9);
      expect(best).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
      // p2 and p3 are outside (K = 1). B's nine entries stand 4th to 12th, so one added entry takes at most 2 (places 4 to 9, where the
      // 11-9-7 steps follow) six times and 1 (places 10 to 12) three times: lambda 15. C's stand 1st to 3rd: 3 + 2 + 2 = 7.
      // p2 is 1st alone (20) and pushes every rival. p3 is 2nd behind C's first (17): C's first is ahead of him, so lambda_C is 2 + 2 = 4.
      const relaxed = solver.texts.find((t) => /\bo1_0\b/.test(t)) as string;
      expect(relaxed, 'the relaxed LP must exist').toBeDefined();
      if (metric.kind === 'margin') {
        expect(coefficients(objectiveText(relaxed), 'o1_0')).toEqual([20 + 15]);
        expect(coefficients(objectiveText(relaxed), 'o2_0')).toEqual([17 + 15]);
      } else {
        expect(coefficients(relaxed, 'o1_0').filter((k) => k < 0).sort((x, y) => x - y)).toEqual([-(20 + 15), -(20 + 7)]);
        expect(coefficients(relaxed, 'o2_0').filter((k) => k < 0).sort((x, y) => x - y)).toEqual([-(17 + 15), -(17 + 4)]);
      }
    }
  });

  it('6 rivalInvalid: the closest rival of a meet with no other team is refused, and a goal-seek with the prefer load mode is not built', async () => {
    const specs: Spec[] = [{ id: 'p1', team: 'A', times: { E1: 4500 } }];
    const alone: Fx = { model: buildModel(specs, ['E1']), lineup: lineup(), tags: tags('A', ['p1']), rules: rulesOf() };
    const closest = await autoError(() => autoBuild(request(alone, { objective: objectiveFor({ kind: 'closest' }) }), nodeMipSolve()));
    expect(closest).toMatchObject({ code: 'rival_invalid', subject: 'closest' });
    const goalClosest = await autoError(() => autoBuild(request(alone, { objective: goalFor({ kind: 'closest' }, 1) }), nodeMipSolve()));
    expect(goalClosest.code).toBe('rival_invalid');
    const own = await autoError(() => autoBuild(request(steps(1), { objective: objectiveFor({ kind: 'margin', rival: 'A' }) }), nodeMipSolve()));
    expect(own).toMatchObject({ code: 'rival_invalid', subject: 'A' });
    const unknown = await autoError(() => autoBuild(request(steps(1), { objective: objectiveFor({ kind: 'margin', rival: 'Z' }) }), nodeMipSolve()));
    expect(unknown).toMatchObject({ code: 'rival_invalid', subject: 'Z' });
    const nan = await autoError(() => autoBuild(request(steps(1), { objective: goalFor({ kind: 'total' }, Number.NaN) }), nodeMipSolve()));
    expect(nan.code).toBe('target_invalid');
    const preferred = await autoError(() =>
      autoBuild(request(steps(1), { objective: goalFor({ kind: 'total' }, 5), load: { schedule: NSISC_SESSIONS, preference: { mode: 'prefer', maxRacesPerSession: set(2), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(5) } } }), nodeMipSolve())
    );
    expect(preferred).toMatchObject({ code: 'mode_not_built', subject: 'goal-seek-prefer' });
    const robust = await autoError(() => autoBuild(request(steps(1), { objective: { kind: 'robust', recentSwims: 5, minSwims: 3 } }), nodeMipSolve()));
    expect(robust).toMatchObject({ code: 'robust_no_spread', subject: 'robust' });
  });

  it('7 orderIndependence: permuting swimmers, swims and tags gives byte-identical LP text for margin, closest and goal seek', async () => {
    const fx = crowd(4);
    for (const objective of [objectiveFor({ kind: 'margin', rival: 'B' }), objectiveFor({ kind: 'closest' }), goalFor({ kind: 'closest' }, -30), goalFor({ kind: 'total' }, 10)]) {
      const a = nodeMipSolve();
      const b = nodeMipSolve();
      await autoBuild(request(fx, { objective, limits: { ...LIMITS, candidatesPerEvent: 2, maxCandidatesPerEvent: 3 } }), a);
      const permuted: Fx = {
        ...fx,
        model: { ...fx.model, swimmers: [...fx.model.swimmers].reverse(), swims: [...fx.model.swims].reverse(), relaySplits: [...fx.model.relaySplits].reverse() },
        tags: [...fx.tags].reverse(),
      };
      await autoBuild(request(permuted, { objective, limits: { ...LIMITS, candidatesPerEvent: 2, maxCandidatesPerEvent: 3 } }), b);
      expect(b.texts, JSON.stringify(objective)).toEqual(a.texts);
      expect(a.texts.length, JSON.stringify(objective)).toBeGreaterThan(1);
    }
  }, 120_000);

it('8 relayMarginBruteForce: margin, closest and goal seek over relay squads equal the whole-meet brute force', async () => {
    for (const seed of [1, 2, 3]) {
      const fx = relayWorld(seed);
      const rows = relayRows(fx);
      expect(rows.length).toBeGreaterThan(800);
      const current = totalsOf(scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING));
      for (const metric of METRICS.filter((m) => m.kind !== 'margin' || m.rival === 'B').concat([{ kind: 'total' }])) {
        const label = `seed ${seed} ${JSON.stringify(metric)}`;
        const best = Math.max(...rows.map((r) => valueOf(r, metric)));
        if (metric.kind !== 'total') {
          const result = await autoBuild(request(fx, { objective: objectiveFor(metric) }), nodeMipSolve());
          // The relaxed slot of a relay event is loose (the best place for each outside squad), so the proof may keep a gap while the lineup is best.
          expect(objectiveOf(result), label).toBeCloseTo(best, 9);
          expect(best, label).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
          if (result.kind === 'improved') expect(metricOfResults(scoreMeet(fx.model, result.proposal.lineup, result.proposal.tagsForScoring, fx.rules, SOURCING), metric), label).toBeCloseTo(best, 9);
        }
        // Goal seek: the fewest relay entries added or removed that reach a target between the current lineup and the best.
        const now = valueOf(current, metric);
        const target = Math.ceil((now + (best - now) / 2) * 10) / 10;
        const reaching = rows.map((r, i) => ({ r, i })).filter(({ r }) => valueOf(r, metric) >= target - 1e-9);
        const goal = await autoBuild(asGoal(fx, goalFor(metric, target)), nodeMipSolve());
        expect(goal.kind, label).toBe('improved');
        if (goal.kind !== 'improved') continue;
        expect(metricOfResults(scoreMeet(fx.model, goal.proposal.lineup, goal.proposal.tagsForScoring, fx.rules, SOURCING), metric), label).toBeGreaterThanOrEqual(target - 1e-9);
        expect(goal.proposal.changeCount, label).toBe(goal.proposal.entryChanges.length + goal.proposal.rosterAdds.length);
        // Own relays are all new, so the fewest changes is the fewest relay entries among the lineups that reach the target: 1 or 2.
        const fewest = Math.min(...reaching.map(({ i }) => (i === 0 ? 0 : i <= 280 ? 1 : 2)));
        expect(goal.proposal.changeCount, label).toBe(fewest);
      }
    }
  }, 300_000);

  it('8b relayBound: the margin bound covers the brute-force optimum with a small T, and the outside slot is charged the rival relays it can push', async () => {
    const limits = { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 2, refineRounds: 0 };
    let gaps = 0;
    for (const seed of [1, 2, 3]) {
      const fx = relayWorld(seed);
      const rows = relayRows(fx);
      for (const metric of [{ kind: 'margin', rival: 'B' }, { kind: 'closest' }] as const) {
        const label = `seed ${seed} ${JSON.stringify(metric)}`;
        const solver = nodeMipSolve();
        const result = await autoBuild(request(fx, { objective: objectiveFor(metric), limits }), solver);
        const best = Math.max(...rows.map((r) => valueOf(r, metric)));
        expect(result.proof.upperBound, label).not.toBeNull();
        expect(result.proof.bestFound, label).toBeLessThanOrEqual(best + 1e-9);
        expect(best, label).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
        if (result.proof.status === 'gap') gaps += 1;
        // The slot `oR0` of the relaxed LP: its margin coefficient is the max-own coefficient plus the rival's lambda.
        const own = nodeMipSolve();
        await autoBuild(request(fx, { limits }), own);
        const relaxedOwn = own.texts.find((t) => /\boR0\b/.test(t)) as string;
        const relaxed = solver.texts.find((t) => /\boR0\b/.test(t)) as string;
        expect(relaxed, label).toBeDefined();
        const base = coefficients(objectiveText(relaxedOwn), 'oR0')[0] as number;
        // The rival relays stand where scoreMeet puts them with no own relay. All of them are no faster than tau_out here.
        const placed = scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING).events[0]?.rows ?? [];
        const lambda = (team: string): number => placed.filter((r) => r.teamId === team).reduce((s, r) => s + stepAt(NSISC_RELAY, r.place as number), 0);
        expect(lambda('B'), label).toBeGreaterThan(0);
        if (metric.kind === 'margin') expect(coefficients(objectiveText(relaxed), 'oR0'), label).toEqual([base + lambda('B')]);
        else expect(coefficients(relaxed, 'oR0').filter((k) => k < -4), label).toEqual([-(base + lambda('B')), -(base + lambda('C'))].sort((a, b) => a - b));
      }
    }
    expect(gaps, 'T = 2 must leave a gap somewhere').toBeGreaterThan(0);
  }, 300_000);

it('9 marginUnderLoad: margin and closest under respect and prefer equal the brute force over entry sets, with the own-only penalty', async () => {
    for (const seed of [0, 2, 4]) {
      const fx = crowd(seed);
      for (const preference of [respect(1), prefer(1, 2), prefer(1, 5)]) {
        const load = crowdLoad(preference);
        const rows = bruteRows(`crowd${seed}-${JSON.stringify(preference)}`, fx, 1e9, load);
        for (const metric of [{ kind: 'margin', rival: 'B' }, { kind: 'closest' }] as const) {
          const label = `crowd${seed} ${preference.mode} ${JSON.stringify(metric)}`;
          const best = Math.max(...rows.flatMap((r) => loadedValue(r, metric, preference) ?? []));
          const result = await autoBuild(request(fx, { objective: objectiveFor(metric), load }), nodeMipSolve());
          expect(result.proof.status, label).toBe('proven_optimal');
          expect(objectiveOf(result), label).toBeCloseTo(best, 9);
          if (result.kind === 'improved') {
            const e = result.proposal.evaluation;
            // The evaluation holds the metric less the penalty, and the penalty is the own-only one.
            expect(e.objective, label).toBeCloseTo(metricOfResults(e.results, metric) - e.penaltyPoints, 9);
            if (preference.mode === 'respect') expect(e.penaltyPoints, label).toBe(0);
          }
        }
      }
    }
  }, 300_000);

  it('9b goalSeekUnderRespect: a goal seek with the respect load mode equals the fewest changes among the lineups the load allows', async () => {
    for (const seed of [0, 2]) {
      const fx = crowd(seed);
      const preference = respect(1);
      const load = crowdLoad(preference);
      const rows = bruteRows(`crowd${seed}-${JSON.stringify(preference)}`, fx, 1e9, load).filter((r) => !r.over);
      const current = totalsOf(scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING));
      for (const metric of [{ kind: 'total' }, { kind: 'margin', rival: 'B' }] as const) {
        const label = `crowd${seed} ${JSON.stringify(metric)}`;
        const best = Math.max(...rows.map((r) => valueOf(r.totals, metric)));
        const now = valueOf(current, metric);
        const target = Math.ceil((now + (best - now) / 2) * 10) / 10;
        const fewest = Math.min(...rows.filter((r) => valueOf(r.totals, metric) >= target - 1e-9).map((r) => r.changes));
        const result = await autoBuild(asGoal(fx, goalFor(metric, target), { load }), nodeMipSolve());
        expect(result.kind, label).toBe('improved');
        if (result.kind === 'improved') expect(result.proposal.changeCount, label).toBe(fewest);
      }
    }
  }, 300_000);

  it('10 fallback: a margin search that times out climbs from the current lineup, a goal seek climbs from a verified incumbent, and closest has no climb', async () => {
    // Margin: both solves time out with nothing. The local search starts at the current lineup and ends in the best event (BACK).
    const fx = trap();
    const margin = await autoBuild(request(fx, { objective: objectiveFor({ kind: 'margin', rival: 'R' }) }), TIMES_OUT);
    expect(margin.kind).toBe('improved');
    if (margin.kind === 'improved') {
      expect(margin.proposal.method).toBe('local-search');
      expect(swimmerEvents(margin)).toEqual([BACK]);
      expect(margin.proof.status).not.toBe('proven_optimal');
      expect(margin.proof.solves.at(-1)?.stage).toBe('local-search');
    }
    // Closest: the integer model holds a `t` that no column choice derives, so no search runs.
    const closest = await autoBuild(request(fx, { objective: objectiveFor({ kind: 'closest' }) }), TIMES_OUT);
    expect(closest).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
    expect(closest.proof.solves.every((s) => s.stage !== 'local-search')).toBe(true);
    // Goal seek: the current lineup misses the target, so only a verified incumbent seeds the search. The incumbent here reaches
    // 80 with 4 changes; the target is 20, and the search removes entries until one is left.
    const four = steps(4);
    const rich = nodeMipSolve();
    await autoBuild(asGoal(four, goalFor({ kind: 'total' }, 80)), rich);
    const solution = await nodeMipSolve()(rich.texts[0] as string, {});
    expect(solution.status).toBe('Optimal');
    let calls = 0;
    const incumbent: MipSolve = async () => {
      calls += 1;
      if (calls === 1) return { status: 'Time limit reached', objective: solution.objective, columns: {}, incumbent: { objective: solution.objective, columns: solution.columns }, dualBound: null };
      return { status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null };
    };
    const goal = await autoBuild(asGoal(four, goalFor({ kind: 'total' }, 20)), incumbent);
    expect(goal.kind).toBe('improved');
    if (goal.kind === 'improved') {
      expect(goal.proposal.method).toBe('local-search');
      expect(goal.proposal.changeCount).toBe(1);
      expect(goal.proposal.evaluation.objective).toBe(20);
    }
    // With no incumbent the goal seek has nothing to climb from.
    const none = await autoBuild(asGoal(four, goalFor({ kind: 'total' }, 20)), TIMES_OUT);
    expect(none).toMatchObject({ kind: 'unchanged', reason: 'none_found_within_limits' });
  });

  it('5c goalSeekLowerBound: a current entry outside the candidates counts as kept, so the lower bound on changes never exceeds the brute-force fewest', async () => {
    // Event E: p1 (4000) and p2 (4010, the current entry), K = 1, so p2 is outside. E2: only p2 has a time. With a total of one entry each,
    // the lineup {p1, p2} in E scores 20 + 17 = 37 with ONE change (p1 added). The restricted columns reach 37 only as p1 in E and p2 in
    // E2 (40 points) with three changes. The relaxed lower bound is 1: p2 stays as an outside entry (0 changes), p1 is added.
    const specs: Spec[] = [
      { id: 'p1', team: 'A', times: { E: 4000 } },
      { id: 'p2', team: 'A', times: { E: 4010, E2: 4000 } },
    ];
    for (const e of ['E', 'E2']) for (let j = 1; j <= 2; j++) specs.push({ id: `r${e}${j}`, team: 'R', times: { [e]: 5000 + j * 100 } });
    const fx: Fx = {
      model: buildModel(specs, ['E', 'E2']),
      lineup: lineup(ind('A', 'p2', 'E'), ...specs.filter((s) => s.team === 'R').flatMap((s) => Object.keys(s.times).map((e) => ind('R', s.id, e)))),
      tags: [...tags('A', ['p1', 'p2']), ...tags('R', specs.filter((s) => s.team === 'R').map((s) => s.id))],
      rules: rulesOf({ maxTotal: 1 }),
    };
    // The brute force: each swimmer's choice of entry set under a total of one, scored as a whole meet, with the changes counted from the lineups.
    const current = new Set(fx.lineup.entries.map((e) => entryKey(e)));
    let fewest = Infinity;
    for (const p1 of [null, 'E']) {
      for (const p2 of [null, 'E', 'E2']) {
        const entries = [...fx.lineup.entries.filter((e) => !(e.kind === 'individual' && e.teamId === 'A')), ...(p1 === null ? [] : [ind('A', 'p1', p1)]), ...(p2 === null ? [] : [ind('A', 'p2', p2)])];
        const own = at(totalsOf(scoreMeet(fx.model, lineup(...entries), fx.tags, fx.rules, SOURCING)), 'A');
        if (own < 37) continue;
        const keys = new Set(entries.map((e) => entryKey(e)));
        const changes = [...keys].filter((k) => !current.has(k)).length + [...current].filter((k) => !keys.has(k)).length;
        fewest = Math.min(fewest, changes);
      }
    }
    expect(fewest).toBe(1);
    const limits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    const result = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 37), { limits }), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    // Three changes found, and a bound of one: not proven. The bound is no larger than the true fewest.
    expect(result.proposal.changeCount).toBe(3);
    expect(result.proof.status).toBe('gap');
    expect(result.proof.upperBound).toBe(1);
    expect(result.proof.upperBound as number).toBeLessThanOrEqual(fewest);
    expect(result.proof.gap).toBe(2);
    // One refinement round brings p2 into the candidates: the one-change lineup is found and proven.
    const refined = await autoBuild(asGoal(fx, goalFor({ kind: 'total' }, 37), { limits: { ...limits, maxCandidatesPerEvent: 2, refineRounds: 1 } }), nodeMipSolve());
    expect(refined.kind === 'improved' && refined.proposal.changeCount).toBe(1);
    expect(refined.proof).toMatchObject({ status: 'proven_optimal', bestFound: 1, upperBound: 1 });
  });

  it('5d reachableIsNeverProvenUnreachable: with one candidate and no refinement, a target the brute force reaches is never target_unreachable, proven', async () => {
    const limits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    let within = 0;
    for (const { key, fx, units } of worlds()) {
      const rows = bruteRows(key, fx, units);
      for (const metric of [{ kind: 'total' }, ...METRICS] as const) {
        const target = bestOf(rows, metric);
        const result = await autoBuild(asGoal(fx, goalFor(metric, target), { limits }), nodeMipSolve());
        const label = `${key} ${JSON.stringify(metric)} target ${target}`;
        if (result.kind === 'target_unreachable') {
          expect(result.reason, label).toBe('within_limits');
          within += 1;
        }
      }
    }
    expect(within, 'K = 1 must leave some target out of reach of the restricted columns').toBeGreaterThan(0);
  }, 300_000);

  it('6b closestTie: when two teams tie for the closest, the evaluation names the lower team id', async () => {
    // B and C each hold three entries in their own event and score 53, so the closest margin is the same over either.
    const specs: Spec[] = [{ id: 'p1', team: 'A', times: { E1: 4500 } }];
    for (const [team, e] of [['B', 'E1'], ['C', 'E2']] as const) for (let j = 1; j <= 3; j++) specs.push({ id: `${team}${j}`, team, times: { [e]: 5000 + j * 100 } });
    const rivals = specs.filter((s) => s.team !== 'A');
    const fx: Fx = {
      model: buildModel(specs, ['E1', 'E2']),
      lineup: lineup(...rivals.flatMap((s) => Object.keys(s.times).map((e) => ind(s.team, s.id, e)))),
      tags: [...tags('A', ['p1']), ...tags('B', ['B1', 'B2', 'B3']), ...tags('C', ['C1', 'C2', 'C3'])],
      rules: rulesOf(),
    };
    const r = await autoBuild(request(fx, { objective: objectiveFor({ kind: 'closest' }) }), nodeMipSolve());
    expect(r.current.rival).toEqual({ teamId: 'B', points: 53 });
    expect(r.current.objective).toBe(-53);
    expect(r.kind).toBe('improved');
    if (r.kind === 'improved') {
      // p1 enters E1 (+20 own, -5 for B). B has 48 left, C 53: C binds, the margin is 20 - 53.
      expect(r.proposal.evaluation.rival).toEqual({ teamId: 'C', points: 53 });
      expect(r.proposal.evaluation.objective).toBe(20 - 53);
    }
  });

  it('11 modeArithmetic: the margin step is the largest drop at or behind the place, a tie names the lower team id, and an empty field has no step', () => {
    const table = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];
    // Place 1: the 20-17 drop of 3. Place 2 to 7: each own drop is 1, but the 11-9 and 9-7 drops (2) follow. Place 10 and later: 1.
    expect([1, 2, 4, 7, 8, 9, 10, 16].map((p) => step(table, p))).toEqual([3, 2, 2, 2, 2, 2, 1, 1]);
    expect(step(table, 17)).toBe(0);
    // The last place drops to nothing: a table that ends on its largest drop still has that step.
    expect(step([3, 1], 2)).toBe(1);
    expect(step([5, 4, 0], 1)).toBe(4);
    expect(lambdaOf(table, [{ place: 4, pushed: true }, { place: 2, pushed: false }, { place: 10, pushed: true }])).toBe(2 + 1);
    expect(lambdaOf(table, [])).toBe(0);
    const results = { teams: [{ teamId: 'A', points: 10, rank: 1 }, { teamId: 'C', points: 7, rank: 2 }, { teamId: 'B', points: 7, rank: 2 }] } as unknown as Parameters<typeof metricOf>[1];
    expect(metricOf({ metric: 'closest', rivals: ['B', 'C'], target: null }, results, 'A')).toEqual({ value: 3, rival: { teamId: 'B', points: 7 } });
    expect(metricOf({ metric: 'margin', rivals: ['C'], target: null }, results, 'A')).toEqual({ value: 3, rival: { teamId: 'C', points: 7 } });
    expect(metricOf({ metric: 'own', rivals: [], target: null }, results, 'A')).toEqual({ value: 10, rival: null });
  });

  /** Another gender stays as entered: its points are a constant of the margin, of the closest margin and of the goal-seek rows. */
  function otherGender(): { fx: Fx; before: Totals; after: Totals } {
    const specs: Spec[] = [
      { id: 'S', team: 'A', times: { [FREE]: 4700 } },
      { id: 'b1', team: 'B', times: { [FREE]: 4800 } },
      { id: 'b2', team: 'B', times: { [FREE]: 4900 } },
      { id: 'c1', team: 'C', times: { [FREE]: 5000 } },
      { id: 'c2', team: 'C', times: { [BACK]: 5000 } },
      { id: 'W1', team: 'A', gender: 'Women', times: { [FREE]: 4500, [BACK]: 4500 } },
      { id: 'bw1', team: 'B', gender: 'Women', times: { [FREE]: 4600, [BACK]: 4800 } },
      { id: 'bw2', team: 'B', gender: 'Women', times: { [FREE]: 4700 } },
      { id: 'cw1', team: 'C', gender: 'Women', times: { [BACK]: 4650 } },
    ];
    const entries: LineupEntry[] = [];
    for (const s of specs) if (s.id !== 'S') for (const e of Object.keys(s.times)) entries.push(ind(s.team, s.id, e, s.gender ?? 'Men'));
    const fx: Fx = {
      model: buildModel(specs, [FREE, BACK], ['Men', 'Women']),
      lineup: lineup(...entries),
      tags: [...tags('A', ['S', 'W1']), ...tags('B', ['b1', 'b2', 'bw1', 'bw2']), ...tags('C', ['c1', 'c2', 'cw1'])],
      rules: rulesOf(),
    };
    const score = (l: Lineup): Totals => totalsOf(scoreMeet(fx.model, l, fx.tags, fx.rules, SOURCING));
    return { fx, before: score(fx.lineup), after: score(lineup(...entries, ind('A', 'S', FREE))) };
  }

  it('12 otherGenderConstants: the points of a gender the search does not build enter the margin, closest and goal-seek rows, and the penalty of its races', async () => {
    const { fx, before, after } = otherGender();
    expect(at(before, 'B')).toBeGreaterThan(40); // the women's points of the rivals are a real constant
    for (const metric of METRICS) {
      const label = JSON.stringify(metric);
      const r = await autoBuild(request(fx, { objective: objectiveFor(metric) }), nodeMipSolve());
      expect(r.kind, label).toBe('improved');
      expect(r.proof.status, label).toBe('proven_optimal');
      expect(objectiveOf(r), label).toBe(valueOf(after, metric));
      expect(r.current.objective, label).toBe(valueOf(before, metric));
      // Goal seek: the target is the margin the entry reaches, so one change; one point more is out of reach.
      const target = valueOf(after, metric);
      const goal = await autoBuild(asGoal(fx, goalFor(metric, target)), nodeMipSolve());
      expect(goal.kind, label).toBe('improved');
      expect(goal.kind === 'improved' && goal.proposal.changeCount, label).toBe(1);
      expect(goal.kind === 'improved' && goal.proposal.evaluation.objective, label).toBe(target);
      const over = await autoBuild(asGoal(fx, goalFor(metric, target + 1)), nodeMipSolve());
      expect(over, label).toMatchObject({ kind: 'target_unreachable', reason: 'proven' });
      // Prefer: W1 races twice in the evening session, which the search cannot change, so the penalty is a constant of the objective.
      const loaded = await autoBuild(request(fx, { objective: objectiveFor(metric), load: crowdLoad(prefer(1, 3)) }), nodeMipSolve());
      expect(loaded.kind, label).toBe('improved');
      if (loaded.kind !== 'improved') continue;
      const ev = loaded.proposal.evaluation;
      expect(ev.penaltyPoints, label).toBeGreaterThan(0);
      expect(ev.penaltyPoints % 3, label).toBe(0);
      expect(ev.objective, label).toBeCloseTo(valueOf(after, metric) - ev.penaltyPoints, 9);
      expect(loaded.proof.status, label).toBe('proven_optimal');
    }
  });

  it('13 tiedRivalIsPushed: a rival entry that ties the added swimmer, or the slowest outside squad, counts in the margin bound', async () => {
    // Pair: p1 4000 is the one candidate, so p2 (4010) is outside. B's t1 ties p2 at 4010 (they split 20 + 17) and t2 trails. Added alone, p2
    // takes the tied place 1, so t1 is pushed (step 3 at place 1) and so is t2 (step 2 at place 2 of the empty field): lambda 5.
    const specs: Spec[] = [
      { id: 'p1', team: 'A', times: { E0: 4000 } },
      { id: 'p2', team: 'A', times: { E0: 4010 } },
      { id: 't1', team: 'B', times: { E0: 4010 } },
      { id: 't2', team: 'B', times: { E0: 4500 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, ['E0']),
      lineup: lineup(ind('B', 't1', 'E0'), ind('B', 't2', 'E0')),
      tags: [...tags('A', ['p1', 'p2']), ...tags('B', ['t1', 't2'])],
      rules: rulesOf(),
    };
    const limits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    const solver = nodeMipSolve();
    await autoBuild(request(fx, { objective: objectiveFor({ kind: 'margin', rival: 'B' }), limits }), solver);
    const own = nodeMipSolve();
    await autoBuild(request(fx, { limits }), own);
    const relaxed = solver.texts.find((t) => /\bo1_0\b/.test(t)) as string;
    const baseOwn = coefficients(objectiveText(own.texts.find((t) => /\bo1_0\b/.test(t)) as string), 'o1_0');
    expect(baseOwn).toHaveLength(1);
    const D = (baseOwn[0] as number) / 18.5; // the own bound of a tied place 1 is (20 + 17) / 2 points
    expect(Number.isInteger(D) && D >= 1).toBe(true);
    expect(coefficients(objectiveText(relaxed), 'o1_0')).toEqual([(baseOwn[0] as number) + 5 * D]);
  });

  it('13b tiedRelayIsPushed: a rival relay as slow as the slowest outside squad counts in the relay slot bound', async () => {
    // Every own swimmer and every swimmer of B swims the same 100 free, so every squad has the same time as B's relay: they tie.
    const specs: Spec[] = [];
    for (let i = 1; i <= 8; i++) specs.push({ id: `o${i}`, team: 'A', times: { [FREE]: 4600 } });
    for (let i = 1; i <= 4; i++) specs.push({ id: `b${i}`, team: 'B', times: { [FREE]: 4600 } });
    const fx: Fx = {
      model: buildModel(specs, [RELAY]),
      lineup: lineup(relay('B', 'A', ['b1', 'b2', 'b3', 'b4'])),
      tags: [...tags('A', specs.filter((s) => s.team === 'A').map((s) => s.id)), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
      rules: rulesOf({ size: 18 }),
    };
    const limits = { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 2, refineRounds: 0 };
    const solver = nodeMipSolve();
    await autoBuild(request(fx, { objective: objectiveFor({ kind: 'margin', rival: 'B' }), limits }), solver);
    const own = nodeMipSolve();
    await autoBuild(request(fx, { limits }), own);
    const relaxed = solver.texts.find((t) => /\boR0\b/.test(t)) as string;
    const relaxedOwn = own.texts.find((t) => /\boR0\b/.test(t)) as string;
    expect(relaxed).toBeDefined();
    const base = coefficients(objectiveText(relaxedOwn), 'oR0');
    expect(base).toHaveLength(1);
    const place = scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING).events[0]?.rows.find((r) => r.teamId === 'B')?.place as number;
    expect(place).toBe(1);
    // The points of the tied places split three ways at most, so the solver scales by D = 6. B's relay stands 1st: lambda is stepAt(1) = 6.
    const D = 6;
    expect(base).toEqual([40 * D]);
    expect(coefficients(objectiveText(relaxed), 'oR0')).toEqual([40 * D + stepAt(NSISC_RELAY, place) * D]);
  });

  it('14 gateChecks: the gate rejects a goal-seek selection whose change count, metric or target disagrees with the solver', async () => {
    // A real run gives the arguments `autoBuild` hands the gate. The tests then call the real gate with one of them made wrong.
    const fx = steps(4);
    const objective = goalFor({ kind: 'total' }, 20);
    gateSeen.calls.length = 0;
    const result = await autoBuild(asGoal(fx, objective), nodeMipSolve());
    expect(result.kind).toBe('improved');
    const last = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const [problem, space, selection, scale, mipPoints, method, valueScaled] = last;
    expect(mipPoints, 'goal seek ranks the negative change count').toBe(-1);
    const call = (over: { problem?: GateArgs[0]; mip?: number; value?: number } = {}): ReturnType<typeof gateSeen.real> =>
      gateSeen.real(over.problem ?? problem, space, selection, scale, over.mip ?? mipPoints, method, over.value ?? valueScaled);
    const mismatch = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        if (!(error instanceof AutoBuildError)) throw error;
        expect(error.code).toBe('model_mismatch');
        return error.message;
      }
      throw new Error('the gate accepted a selection that disagrees with the solver');
    };
    // The control: the arguments of the real run pass, and the proposal has the one change.
    expect(call().changeCount).toBe(1);
    // The change count the solver minimized is not the one counted from the built lineup.
    expect(mismatch(() => call({ mip: mipPoints - 1 }))).toMatch(/1 changes; the solver counted 2/);
    expect(mismatch(() => call({ mip: mipPoints + 1 }))).toMatch(/1 changes; the solver counted 0/);
    // The metric of the solver is not the metric of the built lineup (checked by the metric, not by the change count).
    expect(mismatch(() => call({ value: (valueScaled as number) + 1 }))).toMatch(/the metric/);
    expect(mismatch(() => call({ value: (valueScaled as number) - 1 }))).toMatch(/the metric/);
    // The built lineup misses the target: the same selection against a target one point higher.
    const higher = { ...problem, mode: { ...problem.mode, target: (problem.mode.target as number) + 1 } };
    expect(mismatch(() => call({ problem: higher }))).toMatch(/below the target/);
  });
});
