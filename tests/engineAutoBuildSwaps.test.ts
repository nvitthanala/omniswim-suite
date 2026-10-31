/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A9: roster swaps (R65, plans/2026-10-25/D5-AUTOBUILDER.md 12.9 and amendments 1-7). Under `roster: 'propose-swaps'` a
 * coach scorer tag is free with a current value of 1: the build may take the scorer off the roster (`rosterRemoves`), and a removal counts as
 * one change. A removed scorer keeps his current entries as non-scorer entries. The engine only proposes; it never applies.
 *
 * Every fixture is synthetic and every rule is the shipped `nsisc` v4 with the settings a test names changed through `engineTestPresets.set`.
 * No time, point value or standard here is a competition value. The oracle is `scoreMeet`: the brute force scores every roster and entry set of
 * the search space through a whole-meet `scoreMeet` call, and the AutoBuilder must equal the best one. The change count of the brute force is
 * written out here from the lineups, so a drift in the engine's D5 4.9 count shows as a difference.
 */
import { describe, expect, it, vi } from 'vitest';
import { AutoBuildError, autoBuild, builtinRulePreset, entryKey, requireComplete, scoreMeet, sessionLoad } from '@omniswim/engine';
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
} from '@omniswim/engine';
import type { gate as GateFn } from '../packages/engine/src/autobuilder/gate';
import { restoreIdleRemovals } from '../packages/engine/src/autobuilder/gate';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set, TEST_PROVENANCE } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const BACK = '100 Backstroke';
const FLY = '100 Butterfly';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';
type Gender = 'Men' | 'Women';

// Every call of the gate by the AutoBuilder, kept with the real function: the restore tests call it again with a selection made different.
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
  /** Dated 2025-26 swims by event, newest first (robust mode reads these; `times` swims are undated). */
  readonly dated?: Readonly<Record<string, readonly number[]>>;
  readonly gender?: Gender;
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
  }
  for (const s of specs) {
    for (const [eventKey, list] of Object.entries(s.dated ?? {})) {
      list.forEach((hundredths, i) =>
        swims.push({
          swimId: `${s.id}:${eventKey}:d${i}`,
          swimmerId: s.id,
          eventKey,
          recordedCourse: 'SCY',
          recordedTime: { text: (hundredths / 100).toFixed(2), hundredths },
          date: `2026-03-${String(28 - i).padStart(2, '0')}`,
          seasonId: '2025-26',
          flags: {},
          scy: { kind: 'recorded-scy' },
          origin: ORIGIN,
        })
      );
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
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? 'Men', classYear: null, roster: 'member' as const })),
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
  maxTotal?: number | 'unlimited';
  cap?: PerEventScorerCap;
  nonScorer?: 'holds-place' | 'removed-from-consideration';
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
    },
    scorers: {
      ...base.scorers,
      ...(o.size === undefined ? {} : { scoringTeamSize: set(o.size) }),
      ...(o.cap ? { perEventScorerCap: set(o.cap) } : {}),
    },
    entries: {
      ...base.entries,
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

const swaps = (fx: Fx, over: Partial<AutoBuildRequest> = {}): AutoBuildRequest => request(fx, { roster: 'propose-swaps', ...over });

async function autoError(run: () => Promise<unknown>): Promise<AutoBuildError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AutoBuildError) return error;
    throw error;
  }
  throw new Error('did not throw');
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

const totalsOf = (results: { teams: readonly { teamId: string; points: number }[] }): Readonly<Record<string, number>> =>
  Object.fromEntries(results.teams.map((t) => [t.teamId, t.points]));
const ownOf = (fx: Fx, l: Lineup, t: readonly ScorerTag[]): number => totalsOf(scoreMeet(fx.model, l, t, fx.rules, SOURCING))['A'] as number;
const proposalOf = (r: AutoBuildResult): Extract<AutoBuildResult, { kind: 'improved' }>['proposal'] | null => (r.kind === 'improved' ? r.proposal : null);
const objectiveOf = (r: AutoBuildResult): number => (r.kind === 'improved' ? r.proposal.evaluation.objective : r.current.objective);

// ---- the seeded swap world ----------------------------------------------------------------------

const FAST = [4700, 4750, 4800];
const SLOW = [4900, 4950, 5000, 5100];
const ALL = [...FAST, ...SLOW];
const DIVES = [24000, 25000, 25000, 26000, 27000];

interface World extends Fx {
  readonly pinned: readonly string[];
  readonly free: readonly string[];
  /** The events each own decision swimmer has a time in. */
  readonly options: Readonly<Record<string, readonly string[]>>;
  /** The scoring team size, in swimmers (a diver counts a third of one). */
  readonly size: number;
}

/**
 * Own team A: pinned scorers p0 and p1 (on odd seeds p0 and the diver pd, and p1 is free), free swimmers f0, f1. B and C are tagged opponents. The pinned swimmers are slow on
 * some seeds and the free ones fast, so a swap pays; on the others the times mix. The current lineup holds feasible pinned entries (at most 2 each)
 * and random kept entries for the free swimmers. The scoring team size is 2, so a free swimmer can join only by a swap.
 */
function world(seed: number, size = 2): World {
  const next = rng(seed * 6007 + 31);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const swimEvents = [FREE, BACK, FLY];
  const two = (): string[] => shuffled(swimEvents, Math.floor(next() * 1e9)).slice(0, 2);
  const withDiver = seed % 2 === 1;
  const pinned = withDiver ? ['p0', 'pd'] : ['p0', 'p1'];
  const free = withDiver ? ['p1', 'f0', 'f1'] : ['f0', 'f1'];
  const options: Record<string, string[]> = { p0: swimEvents, p1: two(), f0: swimEvents, f1: two(), ...(withDiver ? { pd: [FREE, DIVE] } : {}) };
  const slowPinned = seed % 4 < 2;
  const specs: Spec[] = [...pinned, ...free].map((id) => ({
    id,
    team: 'A',
    times: Object.fromEntries(
      (options[id] as string[]).map((e) => [e, e === DIVE ? pick(DIVES) : id === 'pd' ? 5200 : slowPinned ? (id.startsWith('p') ? pick(SLOW) : pick(FAST)) : pick(ALL)])
    ),
  }));
  const opp = (team: string, ids: string[], diver: string): void => {
    for (const id of ids) specs.push({ id, team, times: { [FREE]: pick(ALL), [BACK]: pick(ALL), [FLY]: pick(ALL) } });
    specs.push({ id: diver, team, times: { [DIVE]: pick(DIVES) } });
  };
  opp('B', ['b0', 'b1'], 'bd0');
  opp('C', ['c0', 'c1'], 'cd0');

  const entries: LineupEntry[] = [];
  for (const id of [...pinned, ...free]) {
    const events = shuffled(options[id] as string[], Math.floor(next() * 1e9));
    const keep = events.slice(0, Math.floor(next() * 3));
    for (const e of keep) entries.push(ind('A', id, e));
  }
  for (const s of specs) {
    if (s.team === 'A') continue;
    for (const e of Object.keys(s.times)) if (e === DIVE || next() < 0.7) entries.push(ind(s.team, s.id, e));
  }
  const cap: PerEventScorerCap = Math.floor(seed / 2) % 3 === 0 ? { cap: 'unlimited' } : Math.floor(seed / 2) % 3 === 1 ? { cap: 1, overCap: 'removed-from-consideration' } : { cap: 2, overCap: 'holds-place' };
  return {
    model: buildModel(specs, [FREE, BACK, FLY, DIVE]),
    lineup: lineup(...shuffled(entries, Math.floor(next() * 1e9))),
    tags: [...tags('A', pinned), ...tags('B', ['b0', 'b1', 'bd0']), ...tags('C', ['c0', 'c1', 'cd0'])],
    rules: rulesOf({ ties: seed % 2 === 1 ? 'ordered' : 'split', size, maxTotal: 2, cap }),
    pinned,
    free,
    options,
    size,
  };
}

// ---- the oracle: every roster and every entry set, scored by whole-meet scoreMeet ----------------

type Choice = readonly string[] | null; // null: a free swimmer stays off the roster

/** The lineup of an assignment. A swimmer not in `choice` (a removed pinned scorer, or a free one off the roster) keeps his current entries. */
function compose(fx: World, choice: ReadonlyMap<string, Choice>): Lineup {
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

interface Row {
  readonly own: number;
  /** Roster removes + roster adds + entries added or removed of the swimmers who stay on the roster (D5 4.9 with A9, written out here). */
  readonly changes: number;
  readonly removed: readonly string[];
  readonly joined: readonly string[];
  /** With a session load: the roster's races above the maximum, and whether a scorer on the roster is over it. */
  readonly extra: number;
  readonly over: boolean;
}

const rowsCache = new Map<string, readonly Row[]>();

/** The strict team size of D5 4.4 in thirds of a swimmer: a swimmer with entries that are all dives counts 1, any other swimmer 3. */
function spotsOf(choice: ReadonlyMap<string, Choice>): number {
  let sum = 0;
  for (const c of choice.values()) if (c !== null) sum += c.length > 0 && c.every((e) => e === DIVE) ? 1 : 3;
  return sum;
}

/** Every roster (a pinned scorer stays or leaves, a free swimmer joins or not) and every entry set within the caps, with at least one scorer. */
function swapRows(key: string, fx: World, allowSwaps: boolean, load: NonNullable<AutoBuildRequest['load']> | null = null): readonly Row[] {
  const cacheKey = `${key}|${allowSwaps}|${JSON.stringify(load?.preference ?? null)}`;
  const cached = rowsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const ids = [...fx.pinned, ...fx.free].sort();
  const sizeUnits = fx.size * 3;
  const subsets = (events: readonly string[], max: number): string[][] => {
    const out: string[][] = [];
    for (let mask = 0; mask < 1 << events.length; mask++) {
      const s = events.filter((_, i) => (mask >> i) & 1);
      if (s.length <= max) out.push(s);
    }
    return out;
  };
  const REMOVED = 'removed' as const;
  type Option = Choice | typeof REMOVED;
  const optionsOf = (id: string): Option[] => {
    const all = subsets(fx.options[id] as string[], 2);
    return fx.pinned.includes(id) ? (allowSwaps ? [REMOVED, ...all] : all) : [null, ...all.filter((s) => s.length > 0)];
  };
  const current = (id: string): string[] => fx.lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A' && e.swimmerId === id).map((e) => e.eventKey);
  const choice = new Map<string, Choice>();
  const removed = new Set<string>();
  const changesOf = (): number => {
    let n = removed.size;
    for (const [id, c] of choice) {
      if (c === null) continue;
      const cur = current(id);
      n += c.filter((e) => !cur.includes(e)).length + cur.filter((e) => !c.includes(e)).length + (fx.pinned.includes(id) ? 0 : 1);
    }
    return n;
  };
  const rows: Row[] = [];
  const visit = (i: number): void => {
    if (spotsOf(choice) > sizeUnits) return;
    if (i === ids.length) {
      const joined = ids.filter((id) => choice.get(id) !== null && choice.has(id) && !fx.pinned.includes(id));
      const stays = [...choice.keys()].filter((id) => choice.get(id) !== null);
      if (stays.length === 0) return; // scoreMeet needs a scorer
      const l = compose(fx, choice);
      const scorers = [...fx.tags.filter((t) => !(t.teamId === 'A' && removed.has(t.swimmerId))), ...tags('A', joined)];
      const results = scoreMeet(fx.model, l, scorers, fx.rules, SOURCING);
      let extra = 0;
      let over = false;
      if (load !== null) {
        const run = sessionLoad(fx.model, l, results, load.schedule, load.preference, fx.rules);
        const roster = new Set(scorers.filter((s) => s.teamId === 'A' && s.role === 'scorer').map((s) => s.swimmerId));
        const max = load.preference.mode === 'off' || load.preference.maxRacesPerSession.state !== 'set' ? 0 : load.preference.maxRacesPerSession.value;
        over = run.violations.some((v) => v.kind === 'session_load' && roster.has(v.swimmerId));
        for (const sw of run.perSwimmer) if (roster.has(sw.swimmerId)) for (const x of sw.sessions) if (x.races > max) extra += x.races - max;
      }
      rows.push({ own: totalsOf(results)['A'] as number, changes: changesOf(), removed: [...removed].sort(), joined, extra, over });
      return;
    }
    const id = ids[i] as string;
    for (const o of optionsOf(id)) {
      if (o === REMOVED) {
        removed.add(id);
        choice.delete(id);
      } else {
        removed.delete(id);
        choice.set(id, o);
      }
      visit(i + 1);
    }
    removed.delete(id);
    choice.delete(id);
  };
  visit(0);
  rowsCache.set(cacheKey, rows);
  return rows;
}

// ---- session load and stub solvers --------------------------------------------------------------

const timedFinal = (eventKey: string): ScheduledEvent => ({ eventKey, gender: 'both', format: { kind: 'timed-final', session: { day: 1, slot: 'evening' } } });
const prelimsFinals = (eventKey: string): ScheduledEvent => ({
  eventKey,
  gender: 'both',
  format: { kind: 'prelims-finals', prelims: { day: 1, slot: 'morning' }, finals: { day: 1, slot: 'evening' } },
});
const worldLoad = (preference: LoadPreference): NonNullable<AutoBuildRequest['load']> => ({
  schedule: { payloadVersion: 1, provenance: TEST_PROVENANCE, events: [prelimsFinals(FREE), timedFinal(BACK), prelimsFinals(FLY), timedFinal(DIVE)] },
  preference,
});
const respect = (max: number): LoadPreference => ({ mode: 'respect', maxRacesPerSession: set(max), diving: set('excluded' as const) });
const prefer = (max: number, penalty: number): LoadPreference => ({ mode: 'prefer', maxRacesPerSession: set(max), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(penalty) });

/** The value of a brute-force row under a load: own points less the own-only penalty (prefer), or `null` when respect is broken. */
function loadedValue(row: Row, preference: LoadPreference): number | null {
  if (preference.mode === 'respect' && row.over) return null;
  const pen = preference.mode === 'prefer' && preference.penaltyPointsPerExtraRace.state === 'set' ? preference.penaltyPointsPerExtraRace.value : 0;
  return row.own - pen * row.extra;
}

/** The best objective a result reaches: a current-infeasible result reaches its alternative's. */
function bestObjectiveOf(r: AutoBuildResult): number {
  if (r.kind === 'improved') return r.proposal.evaluation.objective;
  if (r.kind === 'current_infeasible') return r.alternative === null ? Number.NaN : r.alternative.evaluation.objective;
  return r.kind === 'unchanged' ? r.current.objective : Number.NaN;
}

/** A solver that reaches its time limit with nothing: the restricted solve ends the sequence without a lineup, and the local search may run. */
const TIMES_OUT: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });

// ---- the hand fixtures --------------------------------------------------------------------------

/** The rival team R: r0 swims FREE, r1 and r2 swim BACK, all entered and tagged. */
function rivalR(): { specs: Spec[]; entries: LineupEntry[]; tags: ScorerTag[] } {
  return {
    specs: [
      { id: 'r0', team: 'R', times: { [FREE]: 4800 } },
      { id: 'r1', team: 'R', times: { [BACK]: 4650 } },
      { id: 'r2', team: 'R', times: { [BACK]: 4900 } },
    ],
    entries: [ind('R', 'r0', FREE), ind('R', 'r1', BACK), ind('R', 'r2', BACK)],
    tags: tags('R', ['r0', 'r1', 'r2']),
  };
}

/**
 * Size 2. Own s0 (FREE 47.00, entered, 1st: 20 points) and s1 (BACK 50.00, entered, 3rd behind r1 and r2: 16 points) are the coach's scorers. The free
 * swimmer f0 (BACK 47.00) would be 2nd (17 points) in s1's place. Fixed roster: 36, and f0 cannot join (size 2). With swaps: s1 out, f0 in, 37.
 * `slowF0`: f0 is 52.00, so no swap pays. `f0Back` sets his BACK time (49.50 places him 3rd, where s1 is: a swap that gains nothing).
 */
function pair(slowF0 = false, f0Back = slowF0 ? 5200 : 4700): Fx {
  const r = rivalR();
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 's1', team: 'A', times: { [BACK]: 5000 } },
    { id: 'f0', team: 'A', times: { [BACK]: f0Back } },
    ...r.specs,
  ];
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(ind('A', 's0', FREE), ind('A', 's1', BACK), ...r.entries),
    tags: [...tags('A', ['s0', 's1']), ...r.tags],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
  };
}

/**
 * Size 2 (6 thirds). Own s0 (FREE, 1st: 20 points) and the diver d0 (6th of 6 on the board: 13 points) are the scorers: 3 + 1 = 4 thirds, 33 points. f0
 * (BACK, 2nd: 17 points) needs 3 thirds, and 4 + 3 = 7 is over 6, so he joins only by a swap. d0 out leaves s0 and f0, 3 + 3 = 6: 20 + 17 = 37. s0 out
 * leaves d0 and f0, 1 + 3 = 4, but loses 20.
 */
function diverPair(): World {
  const r = rivalR();
  const divers: Spec[] = ['rd1', 'rd2', 'rd3', 'rd4', 'rd5'].map((id, i) => ({ id, team: 'R', times: { [DIVE]: 25000 + i * 500 } }));
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 'd0', team: 'A', times: { [DIVE]: 24000 } },
    { id: 'f0', team: 'A', times: { [BACK]: 4700 } },
    ...r.specs,
    ...divers,
  ];
  return {
    model: buildModel(specs, [FREE, BACK, DIVE]),
    lineup: lineup(ind('A', 's0', FREE), ind('A', 'd0', DIVE), ...r.entries, ...divers.map((d) => ind('R', d.id, DIVE))),
    tags: [...tags('A', ['s0', 'd0']), ...r.tags, ...tags('R', divers.map((d) => d.id))],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
    pinned: ['s0', 'd0'],
    free: ['f0'],
    options: { s0: [FREE], d0: [DIVE], f0: [BACK] },
    size: 2,
  };
}

/**
 * Robust mode. F is a coach's scorer entered in FREE with two swims only (49.00, 49.00): a frozen pair, so his entry stays whatever the build does. G is
 * entered in BACK with five consistent swims. H is free with five consistent FREE swims (robust 43.20). Rivals: R1 41.00 FREE and 40.00 BACK, R2 48.00 FREE.
 * Robust points now: F 3rd in FREE (16) and G 2nd in BACK (17), so 33. Size 2, so H joins only in F's place: H 2nd (17), 34.
 */
function robustPair(): Fx {
  const specs: Spec[] = [
    { id: 'F', team: 'A', times: {}, dated: { [FREE]: [4900, 4900] } },
    { id: 'G', team: 'A', times: {}, dated: { [BACK]: [4310, 4320, 4330, 4300, 4340] } },
    { id: 'H', team: 'A', times: {}, dated: { [FREE]: [4310, 4320, 4330, 4300, 4340] } },
    { id: 'R1', team: 'B', times: { [FREE]: 4100, [BACK]: 4000 } },
    { id: 'R2', team: 'D', times: { [FREE]: 4800 } },
  ];
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(ind('A', 'F', FREE), ind('A', 'G', BACK), ind('B', 'R1', FREE), ind('B', 'R1', BACK), ind('D', 'R2', FREE)),
    tags: [...tags('A', ['F', 'G']), ...tags('B', ['R1']), ...tags('D', ['R2'])],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
  };
}

/**
 * Size 2. Own s0 (FREE, entered) and s2 (BACK 46.90, no entry at all) are the scorers. s2 entering BACK is 2nd (17 points). f0 (BACK 53.00) is too slow
 * to matter. s2 has no entry now and a swap never pays, so he is never removed.
 */
function entryless(): Fx {
  const r = rivalR();
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 's2', team: 'A', times: { [BACK]: 4690 } },
    { id: 'f0', team: 'A', times: { [BACK]: 5300 } },
    ...r.specs,
  ];
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(ind('A', 's0', FREE), ...r.entries),
    tags: [...tags('A', ['s0', 's2']), ...r.tags],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
  };
}

/** `pair` with an own relay of s1 and three own non-scorers (n1, n2, n3): the relay holds off-roster legs, so its event stays as entered and s1 is bound to it. */
function fixedRelay(): Fx {
  const base = pair();
  const extra: Spec[] = [
    { id: 'n1', team: 'A', times: { [FREE]: 5000 } },
    { id: 'n2', team: 'A', times: { [FREE]: 5010 } },
    { id: 'n3', team: 'A', times: { [FREE]: 5020 } },
  ];
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 's1', team: 'A', times: { [BACK]: 5000, [FREE]: 5100 } },
    { id: 'f0', team: 'A', times: { [BACK]: 4700 } },
    ...rivalR().specs,
    ...extra,
  ];
  return {
    ...base,
    model: buildModel(specs, [FREE, BACK, RELAY]),
    lineup: lineup(...base.lineup.entries, relay('A', 'A', ['s1', 'n1', 'n2', 'n3'])),
    tags: [...base.tags, tag('A', 'n1', 'non-scorer'), tag('A', 'n2', 'non-scorer'), tag('A', 'n3', 'non-scorer')],
  };
}

/**
 * Size 2. Own s0 (FREE, entered) and s2 are the scorers; s2 has no swim at all, so he has no entry and can have none. f0 (BACK 47.00) is free. The only
 * way f0 joins is a swap: s2 out, f0 in.
 */
function idleSwapper(): Fx {
  const r = rivalR();
  const specs: Spec[] = [{ id: 's0', team: 'A', times: { [FREE]: 4700 } }, { id: 's2', team: 'A', times: {} }, { id: 'f0', team: 'A', times: { [BACK]: 4700 } }, ...r.specs];
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(ind('A', 's0', FREE), ...r.entries),
    tags: [...tags('A', ['s0', 's2']), ...r.tags],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
  };
}

/**
 * Size 2 (6 thirds). Pinned: s0 (FREE 47.00), and the divers d1 (24000) and d2 (23000) on the board behind three rival divers. f0 (BACK) and f1 (FLY) are free
 * and fast. Roster {s0, f0, f1} is 9 thirds: not legal. If a removed diver kept a diver indicator (d = 1) it would count as 2 thirds less, and two removed
 * divers would let {s0, f0, f1} through. The brute force knows only the legal rosters.
 */
function twoDivers(): World {
  const r = rivalR();
  const board: Spec[] = ['rd1', 'rd2', 'rd3'].map((id, i) => ({ id, team: 'R', times: { [DIVE]: 25000 + i * 500 } }));
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 'd1', team: 'A', times: { [DIVE]: 24000 } },
    { id: 'd2', team: 'A', times: { [DIVE]: 23000 } },
    { id: 'f0', team: 'A', times: { [BACK]: 4700 } },
    { id: 'f1', team: 'A', times: { [FLY]: 4700 } },
    ...r.specs,
    { id: 'q1', team: 'R', times: { [FLY]: 4650 } },
    { id: 'q2', team: 'R', times: { [FLY]: 4900 } },
    ...board,
  ];
  return {
    model: buildModel(specs, [FREE, BACK, FLY, DIVE]),
    lineup: lineup(ind('A', 's0', FREE), ind('A', 'd1', DIVE), ind('A', 'd2', DIVE), ...r.entries, ind('R', 'q1', FLY), ind('R', 'q2', FLY), ...board.map((d) => ind('R', d.id, DIVE))),
    tags: [...tags('A', ['s0', 'd1', 'd2']), ...r.tags, ...tags('R', ['q1', 'q2', ...board.map((d) => d.id)])],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
    pinned: ['s0', 'd1', 'd2'],
    free: ['f0', 'f1'],
    options: { s0: [FREE], d1: [DIVE], d2: [DIVE], f0: [BACK], f1: [FLY] },
    size: 2,
  };
}

/**
 * Size 2 (6 thirds). Pinned s0 and s3 each enter a swim and a dive: by the strict rule (D5 4.4) each counts a whole swimmer (3 thirds), by scoreMeet each
 * is a diver (1 third). s2 is a third scorer with no entry. {s0, s3, s2} is 9 thirds strict and 5 thirds lax: the current lineup passes scoreMeet only.
 */
function strictMix(): Fx {
  const r = rivalR();
  const board: Spec[] = ['rd1', 'rd2'].map((id, i) => ({ id, team: 'R', times: { [DIVE]: 25000 + i * 500 } }));
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700, [DIVE]: 24000 } },
    { id: 's3', team: 'A', times: { [BACK]: 4800, [DIVE]: 24500 } },
    { id: 's2', team: 'A', times: { [FLY]: 4800 } },
    ...r.specs,
    { id: 'q1', team: 'R', times: { [FLY]: 4650 } },
    ...board,
  ];
  return {
    model: buildModel(specs, [FREE, BACK, FLY, DIVE]),
    lineup: lineup(ind('A', 's0', FREE), ind('A', 's0', DIVE), ind('A', 's3', BACK), ind('A', 's3', DIVE), ...r.entries, ind('R', 'q1', FLY), ...board.map((d) => ind('R', d.id, DIVE))),
    tags: [...tags('A', ['s0', 's3', 's2']), ...r.tags, ...tags('R', ['q1', ...board.map((d) => d.id)])],
    rules: rulesOf({ size: 2, maxTotal: 2 }),
  };
}

/**
 * Robust mode, one entry per swimmer. F is the only own scorer, entered in FREE (R1 41.00, R2 48.00 ahead: 3rd, 16 points). He is 49.00 in FREE, with two
 * swims (frozen) or three (not frozen), and 43.00 in BACK with five swims, where R3 (46.00) is the only rival: 1st, 20 points. A frozen entry cannot go, so
 * F cannot move to BACK under the one-entry cap.
 */
function frozenStays(frozen: boolean, extraRival?: string): Fx {
  const specs: Spec[] = [
    { id: 'F', team: 'A', times: {}, dated: { [FREE]: frozen ? [4900, 4900] : [4900, 4900, 4900], [BACK]: [4300, 4310, 4320, 4300, 4330] } },
    { id: 'R1', team: 'B', times: { [FREE]: 4100 } },
    { id: 'R2', team: 'D', times: { [FREE]: 4800 } },
    { id: 'R3', team: 'E', times: { [BACK]: 4600 } },
    ...(extraRival === undefined ? [] : [{ id: extraRival, team: 'B', times: { [FREE]: 4500 } }]),
  ];
  const extra = extraRival === undefined ? [] : [extraRival];
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(ind('A', 'F', FREE), ind('B', 'R1', FREE), ind('D', 'R2', FREE), ind('E', 'R3', BACK), ...extra.map((id) => ind('B', id, FREE))),
    tags: [...tags('A', ['F']), ...tags('B', ['R1', ...extra]), ...tags('D', ['R2']), ...tags('E', ['R3'])],
    rules: rulesOf({ size: 2, maxTotal: 1 }),
  };
}

/**
 * Size 2, one entry per swimmer. s1 is entered in FREE (4th, 15 points behind s0, r0 and r3) though BACK is better for him (3rd, 16). f0 is faster in BACK (2nd,
 * 17). Fixed roster: s1 moves to BACK, 36. With swaps: s1 leaves (his FREE entry stays, a non-scorer one) and f0 takes BACK, 37.
 */
function unusualRemoved(): Fx {
  const r = rivalR();
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 's1', team: 'A', times: { [FREE]: 5100, [BACK]: 5000 } },
    { id: 'f0', team: 'A', times: { [BACK]: 4700 } },
    { id: 'r3', team: 'R', times: { [FREE]: 4900 } },
    ...r.specs,
  ];
  return {
    model: buildModel(specs, [FREE, BACK]),
    lineup: lineup(ind('A', 's0', FREE), ind('A', 's1', FREE), ...r.entries, ind('R', 'r3', FREE)),
    tags: [...tags('A', ['s0', 's1']), ...r.tags, tag('R', 'r3')],
    rules: rulesOf({ size: 2, maxTotal: 1 }),
  };
}

/**
 * Relays. Size 4. Own s0..s3 swim the one own relay (leadoff 47.00, then flying splits of 46.00, 46.10 and 46.20: 185.30). Team B's relay is 184.00, so
 * the own relay is 2nd. f0 is free and fast (flying split 43.00): s3 out and f0 in makes the own relay 182.10, the 1st place. The legs are decision legs of
 * a built relay event, so the four are swappable.
 */
function relayPair(): Fx {
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [FREE]: 4700 } },
    { id: 's1', team: 'A', times: { [FREE]: 4700 } },
    { id: 's2', team: 'A', times: { [FREE]: 4710 } },
    { id: 's3', team: 'A', times: { [FREE]: 4720 } },
    { id: 'f0', team: 'A', times: { [FREE]: 4400 } },
    { id: 'b1', team: 'B', times: { [FREE]: 4700 } },
    { id: 'b2', team: 'B', times: { [FREE]: 4660 } },
    { id: 'b3', team: 'B', times: { [FREE]: 4670 } },
    { id: 'b4', team: 'B', times: { [FREE]: 4670 } },
  ];
  return {
    model: buildModel(specs, [RELAY]),
    lineup: lineup(relay('A', 'A', ['s0', 's1', 's2', 's3']), relay('B', 'A', ['b1', 'b2', 'b3', 'b4'])),
    tags: [...tags('A', ['s0', 's1', 's2', 's3']), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
    rules: rulesOf({ size: 4 }),
  };
}

/** A selection that picks the current column of every event: the current lineup, with the given removals and joiners. */
function currentSelection(
  space: GateArgs[1],
  template: GateArgs[2],
  removed: readonly string[],
  joined: readonly string[]
): GateArgs[2] {
  // A removed scorer is in no column: his entries stay as they are.
  const chosen = new Map(
    space.events.map((es) => {
      const keep = [...es.currentColumn].filter((id) => !removed.includes(id)).sort().join(',');
      return [es.id, es.columns.find((c) => c.members.join(',') === keep) ?? es.columns.find((c) => c.isCurrent) ?? (es.columns[0] as (typeof es.columns)[number])];
    })
  );
  return { ...template, chosen, joined: new Set(joined), removed: new Set(removed), outside: new Map(), relayOutside: new Set() };
}

/**
 * Size 3, one scorer per team and event. Own s0 (BACK 46.00) and s2 (BACK 47.00) are entered in BACK: s2 is behind s0 under the cap, so his entry has no place.
 * f0 (FLY 47.00) is free and would be 2nd (17 points): size 3 has room for him with no swap.
 */
function noPlace(): Fx {
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [BACK]: 4600 } },
    { id: 's2', team: 'A', times: { [BACK]: 4700 } },
    { id: 'f0', team: 'A', times: { [FLY]: 4700 } },
    { id: 'r1', team: 'R', times: { [BACK]: 4650 } },
    { id: 'r2', team: 'R', times: { [BACK]: 4900 } },
    { id: 'q1', team: 'R', times: { [FLY]: 4650 } },
    { id: 'q2', team: 'R', times: { [FLY]: 4900 } },
  ];
  return {
    model: buildModel(specs, [BACK, FLY]),
    lineup: lineup(ind('A', 's0', BACK), ind('A', 's2', BACK), ind('R', 'r1', BACK), ind('R', 'r2', BACK), ind('R', 'q1', FLY), ind('R', 'q2', FLY)),
    tags: [...tags('A', ['s0', 's2']), ...tags('R', ['r1', 'r2', 'q1', 'q2'])],
    rules: rulesOf({ size: 3, maxTotal: 2, cap: { cap: 1, overCap: 'removed-from-consideration' } }),
  };
}

/**
 * Size 3, a cap of one scorer per team and event, a load limit of one race per session. s2 is entered in BACK (47.00, behind s0 at 46.00) and FLY (47.00,
 * behind s3 at 46.00), so neither entry has a place, and the two races are over the limit. Take s2 off the roster and nothing is lost; put him back and he
 * is a scorer over the limit. f0 (FLY 47.00) is free.
 */
function overLoadIdle(): Fx {
  const specs: Spec[] = [
    { id: 's0', team: 'A', times: { [BACK]: 4600 } },
    { id: 's3', team: 'A', times: { [FLY]: 4600 } },
    { id: 's2', team: 'A', times: { [BACK]: 4700, [FLY]: 4700 } },
    { id: 'f0', team: 'A', times: { [FLY]: 4700 } },
    { id: 'r1', team: 'R', times: { [BACK]: 4650 } },
    { id: 'r2', team: 'R', times: { [BACK]: 4900 } },
    { id: 'q1', team: 'R', times: { [FLY]: 4650 } },
    { id: 'q2', team: 'R', times: { [FLY]: 4900 } },
  ];
  return {
    model: buildModel(specs, [BACK, FLY]),
    lineup: lineup(ind('A', 's0', BACK), ind('A', 's3', FLY), ind('A', 's2', BACK), ind('A', 's2', FLY), ind('R', 'r1', BACK), ind('R', 'r2', BACK), ind('R', 'q1', FLY), ind('R', 'q2', FLY)),
    tags: [...tags('A', ['s0', 's3', 's2']), ...tags('R', ['r1', 'r2', 'q1', 'q2'])],
    rules: rulesOf({ size: 3, maxTotal: 2, cap: { cap: 1, overCap: 'removed-from-consideration' } }),
  };
}

/**
 * Size 2 (6 thirds), a cap of one scorer per team and event removed from the places. Pinned: p1 (FREE 47.00, entered, 3 thirds) and m (a slow diver, 24000,
 * no entry now: a rostered swimmer with no entry is 3 thirds). Roster {p1, m} is 6 thirds: full. d (28000, free) is the fastest diver, ahead of the three rival
 * divers (25000 to 26000). By the strict rule (D5 4.4) d can join only if m enters the board too: m with only a dive is 1 third, so {p1, m, d} is 5 thirds,
 * and m's dive entry is over the cap (d is faster), so it scores nothing. It is the one entry that makes room.
 */
function diveFill(): Fx {
  const r = rivalR();
  const board: Spec[] = ['rd1', 'rd2', 'rd3'].map((id, i) => ({ id, team: 'R', times: { [DIVE]: 25000 + i * 500 } }));
  const specs: Spec[] = [
    { id: 'p1', team: 'A', times: { [FREE]: 4700 } },
    { id: 'm', team: 'A', times: { [DIVE]: 24000 } },
    { id: 'd', team: 'A', times: { [DIVE]: 28000 } },
    ...r.specs,
    ...board,
  ];
  return {
    model: buildModel(specs, [FREE, BACK, DIVE]),
    lineup: lineup(ind('A', 'p1', FREE), ...r.entries, ...board.map((b) => ind('R', b.id, DIVE))),
    tags: [...tags('A', ['p1', 'm']), ...r.tags, ...tags('R', board.map((b) => b.id))],
    rules: rulesOf({ size: 2, maxTotal: 2, cap: { cap: 1, overCap: 'removed-from-consideration' } }),
  };
}

const SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

describe('slice A9 roster swaps', () => {
  it('1 bruteForce: max-own with swaps equals the best roster and entry set; without the flag it equals the best with the roster fixed', async () => {
    let better = 0;
    for (const seed of SEEDS) {
      const fx = world(seed);
      const fixedRows = swapRows(`w${seed}`, fx, false);
      const swapRowsAll = swapRows(`w${seed}`, fx, true);
      const bestFixed = Math.max(...fixedRows.map((r) => r.own));
      const bestSwap = Math.max(...swapRowsAll.map((r) => r.own));
      const fixed = await autoBuild(request(fx), nodeMipSolve());
      expect(fixed.proof.status, `seed ${seed}`).toBe('proven_optimal');
      expect(objectiveOf(fixed), `seed ${seed} fixed`).toBeCloseTo(bestFixed, 9);
      // The fewest-changes tie-break is exact too (the column prune keeps every column a fewest-changes lineup needs).
      const fewest = (rows: readonly { own: number; changes: number }[], best: number): number => Math.min(...rows.filter((r) => r.own >= best - 1e-9).map((r) => r.changes));
      const changesOf = (r: AutoBuildResult): number => (r.kind === 'improved' ? r.proposal.changeCount : 0);
      expect(changesOf(fixed), `seed ${seed} fixed changes`).toBe(fewest(fixedRows, bestFixed));
      const flagged = await autoBuild(swaps(fx), nodeMipSolve());
      expect(flagged.proof.status, `seed ${seed}`).toBe('proven_optimal');
      expect(objectiveOf(flagged), `seed ${seed} swaps`).toBeCloseTo(bestSwap, 9);
      expect(changesOf(flagged), `seed ${seed} swaps changes`).toBe(fewest(swapRowsAll, bestSwap));
      if (bestSwap > bestFixed) better++;
    }
    expect(better).toBeGreaterThan(2);
  }, 600_000);

  it('2 proposalFields: a flagged proposal lists the removals, drops their scorer tags, keeps their entries, and counts every change', async () => {
    let removing = 0;
    for (const seed of SEEDS) {
      const fx = world(seed);
      const result = await autoBuild(swaps(fx), nodeMipSolve());
      const p = proposalOf(result);
      if (p === null) continue;
      const pinnedTags = fx.tags.filter((t) => t.teamId === 'A').map((t) => t.swimmerId);
      const onRoster = new Set(p.tagsForScoring.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
      const removed = p.rosterRemoves.map((r) => r.swimmerId);
      expect(removed, `seed ${seed}`).toEqual(pinnedTags.filter((id) => !onRoster.has(id)).sort());
      expect(p.rosterRemoves.every((r) => r.teamId === 'A' && r.gender === 'Men'), `seed ${seed}`).toBe(true);
      expect(p.rosterAdds.map((a) => a.swimmerId).sort(), `seed ${seed}`).toEqual([...onRoster].filter((id) => !pinnedTags.includes(id)).sort());
      expect(p.changeCount, `seed ${seed}`).toBe(p.rosterAdds.length + p.rosterRemoves.length + p.entryChanges.length);
      // The other teams' tags pass through, and a removed swimmer's entries stay in the lineup unless an entry change says otherwise.
      expect(p.tagsForScoring.filter((t) => t.teamId !== 'A'), `seed ${seed}`).toEqual(fx.tags.filter((t) => t.teamId !== 'A'));
      const keys = new Set(p.lineup.entries.map(entryKey));
      for (const e of fx.lineup.entries) if (e.kind === 'individual' && e.teamId === 'A' && removed.includes(e.swimmerId)) expect(keys.has(entryKey(e)), `seed ${seed} ${entryKey(e)}`).toBe(true);
      // The evaluation is the whole-meet score of the proposal's own lineup and tags.
      expect(p.evaluation.ownPoints, `seed ${seed}`).toBe(ownOf(fx, p.lineup, p.tagsForScoring));
      if (removed.length > 0) removing++;
    }
    expect(removing).toBeGreaterThan(2);
  }, 300_000);

  it('3 goalSeekChangeCount: the fewest changes to reach a target equal the brute force, and a removal counts as one change', async () => {
    let sawRemoval = false;
    let checked = 0;
    for (const seed of [...SEEDS, 12, 13]) {
      const fx = world(seed);
      const rows = swapRows(`w${seed}`, fx, true);
      const current = ownOf(fx, fx.lineup, fx.tags);
      const above = [...new Set(rows.map((r) => r.own).filter((o) => o > current))].sort((a, b) => a - b);
      if (above.length === 0) continue;
      const targets = [...new Set([above[0], above[Math.floor(above.length / 2)], above[above.length - 1]])] as number[];
      for (const points of targets) {
        const result = await autoBuild(swaps(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points } } }), nodeMipSolve());
        const label = `seed ${seed} target ${points}`;
        const fewest = Math.min(...rows.filter((r) => r.own >= points).map((r) => r.changes));
        expect(result.kind, label).toBe('improved');
        const p = proposalOf(result);
        if (p === null) continue;
        // Equal to the brute force with or without a numeric cap, and so the proven label is true (the column prune keeps every column a fewest-changes lineup needs).
        expect(p.changeCount, label).toBe(fewest);
        if (result.proof.status === 'proven_optimal') expect(result.proof.bestFound, label).toBe(fewest);
        expect(p.evaluation.ownPoints, label).toBeGreaterThanOrEqual(points);
        expect(p.changeCount, label).toBe(p.rosterAdds.length + p.rosterRemoves.length + p.entryChanges.length);
        if (p.rosterRemoves.length > 0) sawRemoval = true;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(sawRemoval).toBe(true);
  }, 600_000);

  it('3b goalSeekWithoutFlag: the same sweep with the roster fixed, at size 3 (no swap needed), equals the brute force with and without a numeric cap', async () => {
    // Was a false proven label (follow-up A6-goalseek-proven-overstated): the column prune dropped a column that holds an over-cap entry the current lineup already has,
    // so the fewest-changes tie-break reported one more change than the brute force, with a `proven_optimal` status. It reproduced here with the flag off.
    let checked = 0;
    for (const seed of [0, 1, 2, 3, 6, 7, 8, 9]) {
      const fx = world(seed, 3);
      const rows = swapRows(`g${seed}-3`, fx, false);
      const current = ownOf(fx, fx.lineup, fx.tags);
      const above = [...new Set(rows.map((r) => r.own).filter((o) => o > current))].sort((a, b) => a - b);
      if (above.length === 0) continue;
      for (const points of [above[0], above[above.length - 1]] as number[]) {
        const result = await autoBuild(request(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points } } }), nodeMipSolve());
        const fewest = Math.min(...rows.filter((r) => r.own >= points).map((r) => r.changes));
        const label = `seed ${seed} target ${points}`;
        expect(result.kind, label).toBe('improved');
        expect(proposalOf(result)?.changeCount, label).toBe(fewest);
        expect(result.proof.status, label).toBe('proven_optimal');
        expect(result.proof.bestFound, label).toBe(fewest);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(8);
  }, 300_000);

  it('4 loadBruteForce: respect and prefer equal the brute force when a removed scorer\'s races are no longer counted', async () => {
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const fx = world(seed);
      for (const preference of [respect(1), prefer(1, 2)]) {
        const load = worldLoad(preference);
        const rows = swapRows(`w${seed}`, fx, true, load);
        const best = Math.max(...rows.flatMap((r) => loadedValue(r, preference) ?? []));
        const label = `seed ${seed} ${preference.mode}`;
        const result = await autoBuild(swaps(fx, { load }), nodeMipSolve());
        expect(result.proof.status, label).toBe('proven_optimal');
        expect(bestObjectiveOf(result), label).toBeCloseTo(best, 9);
        const p = result.kind === 'improved' ? result.proposal : result.kind === 'current_infeasible' ? result.alternative : null;
        if (p !== null && preference.mode === 'respect') {
          // A scorer on the proposal's roster keeps the maximum; a removed scorer is not one.
          const roster = new Set(p.tagsForScoring.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
          expect(p.evaluation.load?.violations.some((v) => v.kind === 'session_load' && roster.has(v.swimmerId)), label).toBe(false);
        }
      }
    }
  }, 600_000);

  it('4b removedRaces: a removed scorer\'s races stay in the lineup and are not his load, so a removal can meet a load the fixed roster can only meet by dropping an entry', async () => {
    // s1 swims BACK and FLY in one session (a timed final each) with a maximum of one race. Fixed roster: drop one of the two entries (37 points).
    // With swaps: s1 leaves with both entries kept (no race of his is a scorer's race), and f0, who is faster in BACK, takes the place: 40.
    const specs: Spec[] = [
      { id: 's0', team: 'A', times: { [FREE]: 4700 } },
      { id: 's1', team: 'A', times: { [BACK]: 4900, [FLY]: 4900 } },
      { id: 'f0', team: 'A', times: { [BACK]: 4700 } },
      { id: 'q0', team: 'R', times: { [FLY]: 4800 } },
      { id: 'q1', team: 'R', times: { [BACK]: 4800 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [FREE, BACK, FLY]),
      lineup: lineup(ind('A', 's0', FREE), ind('A', 's1', BACK), ind('A', 's1', FLY), ind('R', 'q0', FLY), ind('R', 'q1', BACK)),
      tags: [...tags('A', ['s0', 's1']), ...tags('R', ['q0', 'q1'])],
      rules: rulesOf({ size: 2, maxTotal: 2 }),
    };
    const load = { schedule: { payloadVersion: 1 as const, provenance: TEST_PROVENANCE, events: [timedFinal(FREE), timedFinal(BACK), timedFinal(FLY)] }, preference: respect(1) };
    const fixed = await autoBuild(request(fx, { load }), nodeMipSolve());
    expect(fixed.kind).toBe('current_infeasible');
    expect(bestObjectiveOf(fixed)).toBe(37);
    const flagged = await autoBuild(swaps(fx, { load }), nodeMipSolve());
    expect(flagged.kind).toBe('current_infeasible');
    expect(bestObjectiveOf(flagged)).toBe(40);
    if (flagged.kind !== 'current_infeasible' || flagged.alternative === null) return;
    const p = flagged.alternative;
    expect(p.rosterRemoves.map((x) => x.swimmerId)).toEqual(['s1']);
    expect(p.rosterAdds.map((x) => x.swimmerId)).toEqual(['f0']);
    expect(p.lineup.entries.filter((e) => e.kind === 'individual' && e.swimmerId === 's1').map((e) => e.kind === 'individual' && e.eventKey).sort()).toEqual([BACK, FLY]);
    // sessionLoad lists s1's two races, but he is not a scorer: no violation is a scorer's.
    const roster = new Set(p.tagsForScoring.filter((x) => x.teamId === 'A' && x.role === 'scorer').map((x) => x.swimmerId));
    expect(p.evaluation.load?.violations.some((v) => v.kind === 'session_load' && v.swimmerId === 's1')).toBe(true);
    expect(p.evaluation.load?.violations.filter((v) => v.kind === 'session_load' && roster.has(v.swimmerId))).toEqual([]);
    // The same run under prefer: s1's two races cost 2 points as a scorer, so the best is the better of swap (40) and keeping him with one race over (54 - 2).
    const preferred = await autoBuild(swaps(fx, { load: { ...load, preference: prefer(1, 2) } }), nodeMipSolve());
    expect(bestObjectiveOf(preferred)).toBe(Math.max(40, 20 + 17 + 17 - 2));
  }, 60_000);

  it('5 explanations: a removal is explained after the adds, by swimmer id, with the spots after it and the points it was worth, from scoreMeet', async () => {
    let seen = 0;
    for (const seed of SEEDS) {
      const fx = world(seed);
      const result = await autoBuild(swaps(fx), nodeMipSolve());
      const p = proposalOf(result);
      if (p === null) continue;
      const removes = p.explanations.filter((e) => e.kind === 'roster_remove');
      expect(removes.map((e) => (e.kind === 'roster_remove' ? e.swimmerId : '')), `seed ${seed}`).toEqual(p.rosterRemoves.map((r) => r.swimmerId));
      const kinds = p.explanations.map((e) => e.kind);
      const lastAdd = kinds.lastIndexOf('roster_add');
      const firstRemove = kinds.indexOf('roster_remove');
      if (firstRemove >= 0) expect(lastAdd < firstRemove, `seed ${seed}: removes come after adds`).toBe(true);
      for (const e of removes) {
        if (e.kind !== 'roster_remove') continue;
        // Independent oracle: the points of the proposal with the swimmer a scorer again, less the proposal's points.
        const kept = [...p.tagsForScoring, tag('A', e.swimmerId)];
        expect(e.marginalPoints, `seed ${seed} ${e.swimmerId}`).toBe(ownOf(fx, p.lineup, kept) - ownOf(fx, p.lineup, p.tagsForScoring));
        // The roster after the removal, in thirds of a spot: a scorer with a dive entry and no other counts a third (no relay in this world).
        const roster = p.tagsForScoring.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId);
        const divers = roster.filter((id) => p.lineup.entries.some((x) => x.kind === 'individual' && x.swimmerId === id && x.eventKey === DIVE)).length;
        expect(e.spotsAfter, `seed ${seed} ${e.swimmerId}`).toEqual({ numerator: (roster.length - divers) * 3 + divers, denominator: 3 });
        seen++;
      }
      // A removed scorer is not on the roster, so no explanation names one of his events as unusual.
      for (const e of p.explanations) if (e.kind === 'unusual_event') expect(p.rosterRemoves.map((r) => r.swimmerId)).not.toContain(e.swimmerId);
    }
    expect(seen).toBeGreaterThan(2);
  }, 300_000);

  it('6 pairSwap: a swap is the only way the free swimmer joins, the removed scorer keeps his entry as a non-scorer entry, and a swap-only improvement is improved', async () => {
    const fx = pair();
    const fixed = await autoBuild(request(fx), nodeMipSolve());
    expect(fixed).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(fixed.current.objective).toBe(36);
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    expect(flagged.kind).toBe('improved');
    if (flagged.kind !== 'improved') return;
    const p = flagged.proposal;
    expect(flagged.proof.status).toBe('proven_optimal');
    expect(flagged.current.objective).toBe(36);
    expect(p.evaluation.objective).toBe(37);
    expect(p.rosterRemoves).toEqual([{ teamId: 'A', gender: 'Men', swimmerId: 's1' }]);
    expect(p.rosterAdds).toEqual([{ teamId: 'A', gender: 'Men', swimmerId: 'f0' }]);
    expect(p.entryChanges).toEqual([{ kind: 'added', entryKey: entryKey(ind('A', 'f0', BACK)) }]);
    expect(p.changeCount).toBe(3);
    expect(p.tagsForScoring.filter((t) => t.teamId === 'A').map((t) => t.swimmerId).sort()).toEqual(['f0', 's0']);
    expect(p.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 's1' && e.eventKey === BACK)).toBe(true);
    // A removal after the add, with the points the scorer was worth: with s1 a scorer again he is 4th (15 points) behind r1, f0 and r2.
    expect(p.explanations.filter((e) => e.kind === 'roster_remove')).toEqual([{ kind: 'roster_remove', swimmerId: 's1', spotsAfter: { numerator: 6, denominator: 3 }, marginalPoints: 15 }]);
    expect(p.explanations.map((e) => e.kind).indexOf('roster_add')).toBeLessThan(p.explanations.map((e) => e.kind).indexOf('roster_remove'));
    // `roster: 'fixed'` is the run without the flag.
    const explicit = await autoBuild(request(fx, { roster: 'fixed' }), nodeMipSolve());
    expect(explicit).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
  });

  it('6b noGain: with the roster already best, the flag proposes nothing, and a removal is never proposed for its own sake', async () => {
    const fx = pair(true);
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    expect(flagged).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(proposalOf(flagged)).toBeNull();
  });

  it('6c equalPoints: a swap that scores exactly what the current lineup scores is not an improvement', async () => {
    // f0 is 49.50 in BACK: 3rd behind r1 and r2, as s1 is (50.00). Swapping gains nothing and costs three changes.
    const fx = pair(false, 4950);
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    expect(flagged).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(flagged.current.objective).toBe(36);
    // The same swap one point ahead of that (49.00 is 2nd behind r1: 17) is an improvement.
    const better = await autoBuild(swaps(pair(false, 4899)), nodeMipSolve());
    expect(better.kind).toBe('improved');
    expect(objectiveOf(better)).toBe(37);
  });

  it('7 diverWeight: removing the diver frees a third of a spot, and removing the swimmer frees a whole one', async () => {
    const fx = diverPair();
    const fixed = await autoBuild(request(fx), nodeMipSolve());
    expect(fixed.kind).toBe('unchanged');
    expect(fixed.current.objective).toBe(33);
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    expect(flagged.kind).toBe('improved');
    if (flagged.kind !== 'improved') return;
    // {s0, d0} is 3 + 1 = 4 thirds against a size of 6, and f0 (3 thirds) does not fit beside both. With d0 out, {s0, f0} is 6: legal. The brute force:
    const rows = swapRows('diver', fx as World, true);
    expect(flagged.proposal.evaluation.objective).toBe(Math.max(...rows.map((r) => r.own)));
    expect(flagged.proposal.rosterRemoves.map((r) => r.swimmerId)).toEqual(['d0']);
    expect(flagged.proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['f0']);
    expect(flagged.proposal.evaluation.objective).toBe(37);
    expect(flagged.proposal.explanations.filter((e) => e.kind === 'roster_remove')).toMatchObject([{ swimmerId: 'd0', spotsAfter: { numerator: 6, denominator: 3 } }]);
  });

  it('8 robustFrozenEntry: a frozen current entry of a tagged swimmer is held, not fixed, so the swimmer can leave and his entry stays (A7)', async () => {
    const fx = robustPair();
    const robust = { kind: 'robust', recentSwims: 5, minSwims: 3 } as const;
    const fixed = await autoBuild(request(fx, { objective: robust }), nodeMipSolve());
    expect(fixed.kind).toBe('unchanged');
    expect(fixed.current.objective).toBe(33);
    const flagged = await autoBuild(swaps(fx, { objective: robust }), nodeMipSolve());
    expect(flagged.kind).toBe('improved');
    if (flagged.kind !== 'improved') return;
    const p = flagged.proposal;
    expect(flagged.proof.status).toBe('proven_optimal');
    expect(flagged.proof.searchSpace.frozenPairs).toEqual([{ swimmerId: 'F', eventKey: FREE, gender: 'Men', swims: 2 }]);
    expect(flagged.proof.searchSpace.restrictions).toContain('robust_frozen_pairs');
    expect(p.rosterRemoves.map((r) => r.swimmerId)).toEqual(['F']);
    expect(p.rosterAdds.map((a) => a.swimmerId)).toEqual(['H']);
    // The frozen entry of F is never dropped: it is a non-scorer entry now.
    expect(p.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 'F' && e.eventKey === FREE)).toBe(true);
    expect(p.entryChanges.some((c) => c.kind === 'removed')).toBe(false);
    expect(p.evaluation.objective).toBe(34);
    expect(p.evaluation.robustOwnPoints).toBe(34);
    expect(flagged.current.robustOwnPoints).toBe(33);
  });

  it('9 unlimitedSize: with no size limit nobody is swappable, and the run is the run without the flag, LP text included', async () => {
    for (const seed of [0, 1, 2, 3]) {
      const fx: Fx = { ...world(seed), rules: rulesOf({ ties: seed % 2 === 1 ? 'ordered' : 'split', size: 'unlimited', maxTotal: 2 }) };
      const plain = nodeMipSolve();
      const flagged = nodeMipSolve();
      const a = await autoBuild(request(fx), plain);
      const b = await autoBuild(swaps(fx), flagged);
      expect(flagged.texts, `seed ${seed}`).toEqual(plain.texts);
      expect(b.kind, `seed ${seed}`).toBe(a.kind);
      expect(proposalOf(b)?.rosterRemoves ?? [], `seed ${seed}`).toEqual([]);
      expect(proposalOf(b)?.lineup, `seed ${seed}`).toEqual(proposalOf(a)?.lineup);
      expect(proposalOf(b)?.changeCount, `seed ${seed}`).toBe(proposalOf(a)?.changeCount);
    }
  }, 120_000);

  it('10 noFlagLp: the flag changes the LP text only where a scorer can leave', async () => {
    const fx = pair();
    const plain = nodeMipSolve();
    const flagged = nodeMipSolve();
    await autoBuild(request(fx), plain);
    await autoBuild(swaps(fx), flagged);
    expect(plain.texts[0]).not.toEqual(flagged.texts[0]);
    // Without the flag no scorer has a roster variable; with it each tagged own scorer does, and the side keeps at least one.
    const zs = (text: string): number => (text.match(/\bz\d+\b/g) ?? []).filter((v, i, all) => all.indexOf(v) === i).length;
    expect(zs(plain.texts[0] as string)).toBe(1); // f0 only
    expect(zs(flagged.texts[0] as string)).toBe(3); // s0, s1 and f0
    expect(flagged.texts[0]).toMatch(/c\d+: (\+ 1 z\d+ )+>= 1\n/);
    expect(plain.texts[0]).not.toMatch(/c\d+: (\+ 1 z\d+ )+>= 1\n/);
  });

  it('11 entrylessCurrentScorer: a tagged scorer with no current entry is a valid current lineup under the flag (no model_mismatch), by the MIP and the local search', async () => {
    const fx = entryless();
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    expect(flagged.proof.status).toBe('proven_optimal');
    const onRoster = (r: AutoBuildResult): string[] => (r.kind === 'improved' ? r.proposal.tagsForScoring.filter((t) => t.teamId === 'A').map((t) => t.swimmerId) : ['s0', 's2']);
    // s2 has no entry and none worth making: he is never removed for nothing.
    expect(onRoster(flagged)).toContain('s2');
    const stalled = await autoBuild(swaps(fx), TIMES_OUT);
    expect(stalled.kind === 'improved' || stalled.kind === 'unchanged').toBe(true);
    expect(onRoster(stalled)).toContain('s2');
  });

  it('12 restoreIdleRemovals: the gate puts back a removed scorer whose return changes nothing while the strict count holds, never one whose entries score, never in goal seek', async () => {
    const fx = entryless();
    gateSeen.calls.length = 0;
    await autoBuild(swaps(fx), nodeMipSolve());
    const [problem, space, selection, scale] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const at = (removed: readonly string[], joined: readonly string[] = []) => currentSelection(space, selection, removed, joined);
    // The entryless s2 is put back, and the tag is all that comes back: his entries stay as built.
    const idle = restoreIdleRemovals(problem, space, at(['s2']));
    expect([...idle.removed]).toEqual([]);
    expect([...(idle.restored ?? [])]).toEqual(['s2']);
    // s0 is entered in FREE and scores there: with him a scorer again the objective rises, which a restore may do (delta review): he is put back.
    const scoring = restoreIdleRemovals(problem, space, at(['s0']));
    expect([...scoring.removed]).toEqual([]);
    expect([...(scoring.restored ?? [])]).toEqual(['s0']);
    // Both out, f0 in (a side always keeps a scorer): s0 comes back first, in id order, and with f0 he fills the size, so s2 stays out.
    expect([...restoreIdleRemovals(problem, space, at(['s0', 's2'], ['f0'])).removed]).toEqual(['s2']);
    // With f0 joined and s0 kept, putting s2 back makes three scorers at size 2: not allowed.
    expect([...restoreIdleRemovals(problem, space, at(['s2'], ['f0'])).removed]).toEqual(['s2']);
    // The gate itself restores before it builds: the proposal lists no removal, no change, and the current lineup.
    const current = Math.round(ownOf(fx, fx.lineup, fx.tags) * scale.D);
    const built = gateSeen.real(problem, space, at(['s2']), scale, current);
    expect(built.rosterRemoves).toEqual([]);
    expect(built.changeCount).toBe(0);
    expect(built.lineup.entries).toEqual(fx.lineup.entries);
    // Nothing to restore: the same object.
    const empty = at([]);
    expect(restoreIdleRemovals(problem, space, empty)).toBe(empty);
    // A goal seek counts the changes the solver minimized, so it restores nothing.
    gateSeen.calls.length = 0;
    await autoBuild(swaps(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points: 30 } } }), nodeMipSolve());
    const goal = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    expect(goal).toBeDefined();
    const sel = currentSelection(goal[1], goal[2], ['s2'], []);
    expect(restoreIdleRemovals(goal[0], goal[1], sel)).toBe(sel);
  });

  it('12b removalWithoutGain: a removed scorer whose current entry has no place is put back, with his entry as built (J21)', async () => {
    const fx = noPlace();
    // Cap 1 per event: s2 (47.00) is behind s0 (46.00) in BACK, so his current entry has no place. Size 3 has room for f0 to join with no swap.
    const run = await autoBuild(swaps(fx), nodeMipSolve());
    expect(proposalOf(run)?.rosterAdds.map((x) => x.swimmerId)).toEqual(['f0']);
    expect(proposalOf(run)?.rosterRemoves).toEqual([]);
    // A solver that skipped the tie-break may return s2 off the roster: take the real solution and leave s2 out of the BACK column.
    gateSeen.calls.length = 0;
    await autoBuild(swaps(fx), nodeMipSolve());
    const [problem, space, selection, scale, mipPoints, method, valueScaled] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const chosen = new Map(selection.chosen);
    const back = space.events.find((es) => es.event.eventKey === BACK);
    const without = back?.columns.find((c) => c.members.join(',') === 's0');
    expect(without).toBeDefined();
    chosen.set((back as NonNullable<typeof back>).id, without as NonNullable<typeof without>);
    const crafted = { ...selection, chosen, removed: new Set(['s2']) };
    expect([...crafted.removed]).toEqual(['s2']);
    const built = gateSeen.real(problem, space, crafted, scale, mipPoints, method, valueScaled);
    expect(built.rosterRemoves).toEqual([]);
    expect(built.tagsForScoring.filter((x) => x.teamId === 'A').map((x) => x.swimmerId).sort()).toEqual(['f0', 's0', 's2']);
    // His entry stays as built, and the only changes are f0's: the roster add and the entry add.
    expect(built.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 's2' && e.eventKey === BACK)).toBe(true);
    expect(built.changeCount).toBe(2);
  });

  it('13 localSearchNeverRemoves: the climb from the current lineup keeps every tagged scorer', async () => {
    const fx = entryless();
    const result = await autoBuild(swaps(fx), TIMES_OUT);
    const p = proposalOf(result);
    if (p !== null) {
      expect(p.rosterRemoves).toEqual([]);
      expect(p.method).toBe('local-search');
    }
    expect(result.kind === 'improved' || result.kind === 'unchanged').toBe(true);
    // The climb does improve here: s2 has a FREE time that scores, and entering it is a move within the roster.
    expect(result.kind).toBe('improved');
  });

  it('14 fixedRelayScorer: a scorer on an own relay that stays as entered is not swappable', async () => {
    const control = pair();
    const flagged = await autoBuild(swaps(control), nodeMipSolve());
    expect(proposalOf(flagged)?.rosterRemoves.map((r) => r.swimmerId)).toEqual(['s1']);
    const fx = fixedRelay();
    const result = await autoBuild(swaps(fx), nodeMipSolve());
    expect(result.proof.searchSpace.fixedRelayEvents).toEqual([{ eventKey: RELAY, gender: 'Men' }]);
    // s1 swims the fixed relay, so he stays and f0 has no place on the roster.
    expect(result).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
  });

  it('16 heldSplitEntries: a swappable scorer\'s current entry in a split-heat event is held, and the restriction is listed only in a flagged run that has one', async () => {
    const fx = pair();
    const split: ScheduledEvent = {
      eventKey: BACK,
      gender: 'both',
      format: { kind: 'timed-final-split', slowHeats: { day: 1, slot: 'morning' }, fastHeat: { day: 1, slot: 'evening' }, fastHeatSize: set(8), smallFieldSession: set({ day: 1, slot: 'evening' as const }) },
    };
    const load = { schedule: { payloadVersion: 1 as const, provenance: TEST_PROVENANCE, events: [timedFinal(FREE), split] }, preference: respect(2) };
    const plain = await autoBuild(request(fx, { load }), nodeMipSolve());
    expect(plain.proof.searchSpace.restrictions).not.toContain('held_split_entries');
    const flagged = await autoBuild(swaps(fx, { load }), nodeMipSolve());
    expect(flagged.proof.searchSpace.restrictions).toContain('held_split_entries');
    // The held entry of s1 stays in the lineup whether or not he leaves, and he can still leave.
    expect(flagged.kind).toBe('improved');
    const p = proposalOf(flagged);
    expect(p?.rosterRemoves.map((r) => r.swimmerId)).toEqual(['s1']);
    expect(p?.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 's1' && e.eventKey === BACK)).toBe(true);
    // With no split event the flagged run lists no held entry.
    const noSplit = await autoBuild(swaps(fx, { load: { ...load, schedule: { ...load.schedule, events: [timedFinal(FREE), timedFinal(BACK)] } } }), nodeMipSolve());
    expect(noSplit.proof.searchSpace.restrictions).not.toContain('held_split_entries');
  });

  it('15 flagValidated: the roster flag is "fixed" or "propose-swaps"', async () => {
    const fx = pair();
    for (const bad of ['swap', '', 'propose', 1, null, true]) {
      const error = await autoError(() => autoBuild(request(fx, { roster: bad as never }), nodeMipSolve()));
      expect(error).toMatchObject({ code: 'limits_invalid', subject: 'roster' });
    }
    expect(await autoBuild(request(fx, { roster: undefined }), nodeMipSolve())).toMatchObject({ kind: 'unchanged' });
  });
  it('17 idleSwapper: the local search never removes a scorer, and the MIP swaps an idle one for a free swimmer', async () => {
    const fx = idleSwapper();
    const mip = await autoBuild(swaps(fx), nodeMipSolve());
    expect(mip.kind).toBe('improved');
    const p = proposalOf(mip);
    expect(p?.rosterRemoves.map((r) => r.swimmerId)).toEqual(['s2']);
    expect(p?.rosterAdds.map((a) => a.swimmerId)).toEqual(['f0']);
    expect(p?.changeCount).toBe(3);
    expect(p?.evaluation.objective).toBe(37);
    // The climb from the current lineup moves one entry at a time inside the roster: f0 cannot join while s2 is on it, and the search proposes no removal.
    const stalled = await autoBuild(swaps(fx), TIMES_OUT);
    expect(stalled.kind).toBe('unchanged');
  });

  it('18 twoDivers: a removed diver is no diver indicator, so removed divers do not make room for an illegal roster', async () => {
    const fx = twoDivers();
    const rows = swapRows('twoDivers', fx, true);
    const best = Math.max(...rows.map((r) => r.own));
    const result = await autoBuild(swaps(fx), nodeMipSolve());
    expect(result.proof.status).toBe('proven_optimal');
    expect(objectiveOf(result)).toBe(best);
    // The illegal roster {s0, f0, f1} would score more: that is what the brute force may not reach.
    expect(best).toBeLessThan(20 + 17 + 17);
  });

  it('19 restoreStrict: putting an idle scorer back counts a swimmer with a swim and a dive as a whole spot (D5 4.4)', async () => {
    const fx = strictMix();
    gateSeen.calls.length = 0;
    await autoBuild(swaps(fx), nodeMipSolve());
    expect(gateSeen.calls.length).toBeGreaterThan(0);
    const [problem, space, selection] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const current = new Map(space.events.map((es) => [es.id, es.columns.find((c) => c.isCurrent) ?? (es.columns[0] as (typeof es.columns)[number])]));
    const base = { ...selection, chosen: current, joined: new Set<string>(), outside: new Map<string, string[]>(), relayOutside: new Set<string>() };
    // s0 and s3 are 3 + 3 thirds by the strict rule, so s2 (3 more) is over 6: his removal stays. By scoreMeet they are 1 + 1 and he would fit.
    expect([...restoreIdleRemovals(problem, space, { ...base, removed: new Set(['s2']) }).removed]).toEqual(['s2']);
  });

  it('20 frozenStays: a swappable scorer who stays keeps the current entry of a frozen pair, though dropping it would raise the objective (A7)', async () => {
    const robust = { kind: 'robust', recentSwims: 5, minSwims: 3 } as const;
    // The control: with three swims the FREE pair is not frozen, and F moves to BACK (20 points), with and without the flag.
    for (const flag of [false, true]) {
      const free = await autoBuild(flag ? swaps(frozenStays(false), { objective: robust }) : request(frozenStays(false), { objective: robust }), nodeMipSolve());
      expect(free.kind, `flag ${flag}`).toBe('improved');
      expect(objectiveOf(free), `flag ${flag}`).toBe(20);
    }
    for (const flag of [false, true]) {
      const frozen = await autoBuild(flag ? swaps(frozenStays(true), { objective: robust }) : request(frozenStays(true), { objective: robust }), nodeMipSolve());
      expect(frozen.kind, `flag ${flag}`).toBe('unchanged');
      expect(objectiveOf(frozen), `flag ${flag}`).toBe(16);
      expect(frozen.proof.searchSpace.frozenPairs, `flag ${flag}`).toEqual([{ swimmerId: 'F', eventKey: FREE, gender: 'Men', swims: 2 }]);
    }
  });

  it('21 removedIsNotExplained: no unusual-event explanation names a scorer the proposal removed', async () => {
    const fx = unusualRemoved();
    const fixed = await autoBuild(request(fx), nodeMipSolve());
    expect(objectiveOf(fixed)).toBe(36);
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    const p = proposalOf(flagged);
    expect(p?.rosterRemoves.map((r) => r.swimmerId)).toEqual(['s1']);
    expect(p?.evaluation.objective).toBe(37);
    expect(p?.explanations.filter((e) => e.kind === 'unusual_event' && e.swimmerId === 's1')).toEqual([]);
    // Why the guard is enough: the rules refuse "holds-place", so a removed scorer's entry is removed from the places and has no place to explain.
    const row = p?.evaluation.results.events.find((e) => e.eventKey === FREE)?.rows.find((x) => x.entryKey === entryKey(ind('A', 's1', FREE)));
    expect(row?.place).toBeNull();
  });
  it('22 relayLegs: a scorer on a built own relay can be swapped; the relay is rebuilt without him, and the run is consistent (no model_mismatch)', async () => {
    const fx = relayPair();
    const fixed = await autoBuild(request(fx), nodeMipSolve());
    expect(fixed).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(objectiveOf(fixed)).toBe(34); // the own relay is 2nd behind team B
    const flagged = await autoBuild(swaps(fx), nodeMipSolve());
    expect(flagged.kind).toBe('improved');
    const p = proposalOf(flagged);
    if (p === null) return;
    expect(flagged.proof.status).toBe('proven_optimal');
    expect(p.evaluation.objective).toBe(40); // 1st
    expect(p.evaluation.ownPoints).toBe(ownOf(fx, p.lineup, p.tagsForScoring));
    // One scorer leaves, f0 joins, and the relay is the one replaced entry: an entry removed and an entry added (D5 4.9), so 4 changes.
    expect(p.rosterRemoves).toHaveLength(1);
    expect(p.rosterAdds.map((x) => x.swimmerId)).toEqual(['f0']);
    expect(p.entryChanges.map((c) => c.kind).sort()).toEqual(['added', 'removed']);
    expect(p.changeCount).toBe(4);
    // The removed scorer cannot stay a leg (his tag is gone and the relay legs must be scorers), so the relay is rebuilt without him.
    const legs = p.lineup.entries.flatMap((e) => (e.kind === 'relay' && e.teamId === 'A' ? e.legs.map((l) => l.swimmerId) : []));
    expect(legs).toHaveLength(4);
    expect(legs).toContain('f0');
    expect(legs).not.toContain((p.rosterRemoves[0] as { swimmerId: string }).swimmerId);
    // A goal seek counts the same changes as the solver minimized (the gate checks it, so a disagreement is a model_mismatch).
    const goal = await autoBuild(swaps(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points: 40 } } }), nodeMipSolve());
    expect(goal.kind).toBe('improved');
    expect(proposalOf(goal)?.changeCount).toBe(4);
  });
  it('24 anchorIdIsFresh: a model swimmer whose id is the old fixed anchor id is not replaced by the synthetic scorer', async () => {
    const robust = { kind: 'robust', recentSwims: 5, minSwims: 3 } as const;
    // F is the only own scorer and his frozen entry sits beside an empty column, which is the case that needs the synthetic scorer. Team B has a
    // swimmer with the old fixed id, entered in FREE, and the control has the same swimmer under another id.
    const clash = await autoBuild(swaps(frozenStays(true, '\u0000anchor'), { objective: robust }), nodeMipSolve());
    const control = await autoBuild(swaps(frozenStays(true, 'zz'), { objective: robust }), nodeMipSolve());
    expect(control.kind).toBe('unchanged');
    expect(clash.kind).toBe(control.kind);
    expect(objectiveOf(clash)).toBe(objectiveOf(control));
    expect(objectiveOf(clash)).toBe(15); // R1, the rival at 45.00 and R2 are ahead of F
    expect(clash.proof.status).toBe(control.proof.status);
  });
});

describe('slice A9 restore, delta review', () => {
  const loadOf = (): NonNullable<AutoBuildRequest['load']> => ({ schedule: { payloadVersion: 1 as const, provenance: TEST_PROVENANCE, events: [timedFinal(BACK), timedFinal(FLY)] }, preference: respect(1) });

  it('25 restoreRefusesNewHardViolation: with the size and the cap slack, a removed scorer whose two races are over the respect limit is not put back', async () => {
    const fx = overLoadIdle();
    gateSeen.calls.length = 0;
    await autoBuild(swaps(fx, { load: loadOf() }), nodeMipSolve());
    expect(gateSeen.calls.length).toBeGreaterThan(0);
    const [problem, space, selection, scale] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const crafted = currentSelection(space, selection, ['s2'], []);
    // His entries have no place, so by points alone his return changes nothing, and three scorers fit size 3.
    const tagsWithout = fx.tags.filter((x) => x.swimmerId !== 's2');
    const mip = Math.round(ownOf(fx, fx.lineup, tagsWithout) * scale.D);
    expect(Math.round(ownOf(fx, fx.lineup, fx.tags) * scale.D)).toBe(mip);
    // Put back, he would be a scorer with two races in a session of one: the restore must not add that violation.
    const kept = restoreIdleRemovals(problem, space, crafted);
    expect([...kept.removed]).toEqual(['s2']);
    expect([...(kept.restored ?? [])]).toEqual([]);
    // The gate builds the proposal with the removal and does not throw model_mismatch.
    const built = gateSeen.real(problem, space, crafted, scale, mip);
    expect(built.rosterRemoves.map((x) => x.swimmerId)).toEqual(['s2']);
    expect(built.tagsForScoring.some((x) => x.teamId === 'A' && x.swimmerId === 's2')).toBe(false);
    expect(Math.round(built.evaluation.objective * scale.D)).toBe(mip);
    // Control: with the limit at two races the same removal buys nothing and breaks no rule, so he is put back.
    gateSeen.calls.length = 0;
    const loose = { ...loadOf(), preference: respect(2) };
    await autoBuild(swaps(fx, { load: loose }), nodeMipSolve());
    const [p2, s2, sel2] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const back = restoreIdleRemovals(p2, s2, currentSelection(s2, sel2, ['s2'], []));
    expect([...back.removed]).toEqual([]);
    expect([...(back.restored ?? [])]).toEqual(['s2']);
  }, 60_000);

  it('27 restoreNeverLowersTheObjective: under prefer a return that costs a penalty is refused, and one that follows a gain is judged against the gain', async () => {
    const fx = overLoadIdle();
    // prefer(1, 2): s2's two races are one over the limit, which costs 2 points as a scorer. His entries have no place, so his return only costs.
    gateSeen.calls.length = 0;
    await autoBuild(swaps(fx, { load: { ...loadOf(), preference: prefer(1, 2) } }), nodeMipSolve());
    const [problem, space, selection, scale] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    const kept = restoreIdleRemovals(problem, space, currentSelection(space, selection, ['s2'], []));
    expect([...kept.removed]).toEqual(['s2']);
    expect([...(kept.restored ?? [])]).toEqual([]);
    // s0 first (id order): his BACK entry scores 20, so he comes back. Then s2 would take the objective below the 20 just gained: he stays out.
    const both = restoreIdleRemovals(problem, space, currentSelection(space, selection, ['s0', 's2'], []));
    expect([...(both.restored ?? [])]).toEqual(['s0']);
    expect([...both.removed]).toEqual(['s2']);
    // The gate agrees: the proposal keeps s2 out and the score is the lineup's, with s0 back.
    const tagsOf = fx.tags.filter((x) => x.swimmerId !== 's0' && x.swimmerId !== 's2');
    const mip = Math.round(ownOf(fx, fx.lineup, tagsOf) * scale.D);
    const built = gateSeen.real(problem, space, currentSelection(space, selection, ['s0', 's2'], []), scale, mip);
    expect(built.rosterRemoves.map((x) => x.swimmerId)).toEqual(['s2']);
    expect(built.evaluation.objective).toBeGreaterThan(mip / scale.D);
    expect(built.evaluation.penaltyPoints).toBe(0);
  }, 60_000);

  it('26 restoreRaisesObjective: an early-stop incumbent that took a scoring scorer off the roster gets him back, and the proposal is scored as the lineup it is', async () => {
    const fx = entryless();
    const optimum = await autoBuild(swaps(fx), nodeMipSolve());
    const best = objectiveOf(optimum);
    expect(best).toBe(37);
    // The incumbent has f0 and s0 off the roster: s0's FREE entry (20 points) stays as a non-scorer entry, so the solver's value is s2's 17 alone.
    gateSeen.calls.length = 0;
    const exact = await autoBuild(swaps(fx), stopsEarly([0, 1], 0));
    const [, , raw, scale, mip, method] = gateSeen.calls[gateSeen.calls.length - 1] as GateArgs;
    expect([...raw.removed]).toEqual(['s0']);
    expect(mip).toBe(17 * scale.D);
    expect(method).toBe('mip-incumbent');
    // The gate scores the lineup it gives: s0 is back, the objective is the optimum, and the classification and the evaluation use it.
    expect(exact.kind).toBe('improved');
    const proposal = proposalOf(exact);
    expect(proposal?.rosterRemoves).toEqual([]);
    expect(proposal?.evaluation.objective).toBe(37);
    expect(proposal?.evaluation.ownPoints).toBe(ownOf(fx, proposal?.lineup as Lineup, proposal?.tagsForScoring as ScorerTag[]));
    expect(proposal?.changeCount).toBe(1);
    // The explanations are read from the lineup the proposal is: s0 is not removed, so no removal is explained (read from the solver's build, one would be),
    // and no roster add is, since f0 stayed out.
    expect(proposal?.explanations).toEqual([]);
    // The bound equals the proposal's score, so the proof may say proven_optimal: the lineup it names is the one that scores the bound.
    expect(exact.proof.bestFound).toBe(37);
    expect(exact.proof.upperBound).toBe(37);
    expect(exact.proof.gap).toBe(0);
    expect(exact.proof.status).toBe('proven_optimal');
    // A looser bound: a gap from the proposal's score, never from the solver's 17.
    const loose = await autoBuild(swaps(fx), stopsEarly([0, 1], 4 * 6));
    expect(loose.kind).toBe('improved');
    expect(loose.proof.status).toBe('gap');
    expect(loose.proof.bestFound).toBe(37);
    expect((loose.proof.upperBound as number) - 37).toBeCloseTo(loose.proof.gap as number, 9);
    expect(loose.proof.gap).toBeGreaterThan(0);
    // A bound below the proposal's score cannot hold: the model and scoreMeet disagree.
    const wrong = await autoError(() => autoBuild(swaps(fx), stopsEarly([0, 1], -6)));
    expect(wrong.code).toBe('model_mismatch');
  }, 60_000);

  /**
   * A solver that stops early (D5 10): the restricted solve returns an incumbent with the swappable scorers `pinned` off the roster (`z<i> = 0`, by the
   * index of the sorted decision swimmers f0, s0, s2), and every solve returns the true optimum plus `slack` (in scaled points) as its bound.
   */
  function stopsEarly(pinned: readonly number[], slack: number): MipSolve {
    const real = nodeMipSolve();
    let calls = 0;
    return async (lp, options) => {
      calls += 1;
      const free = await real(lp, options);
      const text = lp.replace('\n one = 1', `\n one = 1${pinned.map((i) => `\n z${i} = 0`).join('')}`);
      if (text === lp) throw new Error('the LP has no one = 1 bound');
      const run = await real(text, options);
      if (free.status !== 'Optimal' || run.status !== 'Optimal') return free;
      // The third solve is the tie-break: its Optimal result ends the run with the incumbent's lineup, with no local search after it.
      if (calls === 3) return run;
      return { status: 'Time limit reached', objective: 0, columns: {}, incumbent: { objective: run.objective, columns: run.columns }, dualBound: free.objective + slack };
    };
  }

  it('28 pruneKeepsDivingFill: with a cap of 1 on the board and a binding team size, a non-scoring dive entry that turns a rostered swimmer into a diver is kept, so the lineup that needs it is found and the label is true', async () => {
    const fx = diveFill();
    const result = await autoBuild(request(fx), nodeMipSolve());
    // The oracle is scoreMeet. Every legal choice of who enters the board (strict weight written out): {} 3 + 3 thirds; m alone 3 + 1; d alone 3 + 3 + 1 (illegal);
    // m and d 3 + 1 + 1.
    const own = (lines: readonly LineupEntry[], extra: readonly string[]): number => ownOf(fx, lineup(...fx.lineup.entries, ...lines), [...fx.tags, ...tags('A', extra)]);
    const current = own([], []);
    const mAlone = own([ind('A', 'm', DIVE)], []);
    const both = own([ind('A', 'm', DIVE), ind('A', 'd', DIVE)], ['d']);
    expect(both).toBeGreaterThan(Math.max(current, mAlone));
    expect(result.kind).toBe('improved');
    expect(objectiveOf(result)).toBe(both);
    expect(result.proof.status).toBe('proven_optimal');
    const p = proposalOf(result);
    expect(p?.rosterAdds.map((x) => x.swimmerId)).toEqual(['d']);
    expect(p?.lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A' && e.eventKey === DIVE).map((e) => e.kind === 'individual' && e.swimmerId).sort()).toEqual(['d', 'm']);
    expect(p?.changeCount).toBe(3);
  }, 60_000);
});
