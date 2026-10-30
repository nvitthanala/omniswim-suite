/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A3: session load (plans/2026-10-25/D5-AUTOBUILDER.md, 4.5, 4.6, 5.3, 8.2 and 12.3). Every fixture is
 * synthetic, and every rule is the shipped `nsisc` v4 with the settings a test names changed. No time, point value or limit
 * here is a competition value. The oracle is `scoreMeet` plus `sessionLoad`: the brute force builds every own entry set of a
 * small fixture by its own code, scores each as a whole meet, counts its races with the whole-meet `sessionLoad`, and the
 * AutoBuilder must equal the best lineup that the preference allows.
 */
import { describe, expect, it, vi } from 'vitest';
import { AutoBuildError, autoBuild, BUILTIN_SESSION_PRESETS, builtinRulePreset, requireComplete, scoreMeet, sessionLoad } from '@omniswim/engine';
import type {
  AutoBuildLimits,
  AutoBuildRequest,
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  LoadPreference,
  MeetEvent,
  MeetModel,
  RelaySplit,
  RulePreset,
  ScheduledEvent,
  ScorerTag,
  SessionPreset,
} from '@omniswim/engine';
import { FastScorer } from '../packages/engine/src/autobuilder/fastScore';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set, TEST_PROVENANCE } from './engineTestPresets';

// Counts the `scoreMeet` calls of the engine (and, below, the fast scorer's), so a test can see that a refusal came before the columns were built.
const scored = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../packages/engine/src/model/results', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/engine/src/model/results')>();
  return {
    ...real,
    scoreMeet: (...args: Parameters<typeof real.scoreMeet>) => {
      scored.calls += 1;
      return real.scoreMeet(...args);
    },
  };
});

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const IM = '200 Individual Medley';
const FREE50 = '50 Freestyle';
const MEDLEY = '200 Medley Relay';
const BACK50 = '50 Backstroke';
const BREAST50 = '50 Breaststroke';
const FLY50 = '50 Butterfly';
const GENDER = 'Men' as const;
const NSISC_SESSIONS = (BUILTIN_SESSION_PRESETS[0] as { preset: SessionPreset }).preset;

const LIMITS: AutoBuildLimits = { candidatesPerEvent: 8, maxCandidatesPerEvent: 8, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 };

// ---- builders ----------------------------------------------------------------------------------

const LEGS: Readonly<Record<string, readonly string[]>> = { [MEDLEY]: [BACK50, BREAST50, FLY50, FREE50] };

function meetEvent(eventKey: string, gender: 'Men' | 'Women' = GENDER): MeetEvent {
  if (eventKey === MEDLEY) return { eventKey, gender, kind: 'relay', distanceYards: 200, relayKind: 'medley' };
  if (eventKey === DIVE) return { eventKey, gender, kind: 'diving', distanceYards: null, relayKind: null };
  return { eventKey, gender, kind: 'individual', distanceYards: 100, relayKind: null };
}

const DIVE = '1-Meter Diving';

interface Spec {
  readonly id: string;
  readonly team: string;
  /** Flat-start swims: hundredths per event key (a dive: hundredths of a point). */
  readonly swims?: Readonly<Record<string, number>>;
  /** Relay splits (a flying start): hundredths per leg event key. */
  readonly splits?: Readonly<Record<string, number>>;
  readonly roster?: 'member' | 'not_member' | 'unknown';
  /** Default Men. */
  readonly gender?: 'Men' | 'Women';
}

function buildModel(specs: readonly Spec[], eventKeys: readonly string[], womenEventKeys: readonly string[] = []): MeetModel {
  const swims: MeetModel['swims'][number][] = [];
  const splits: RelaySplit[] = [];
  for (const s of specs) {
    for (const [eventKey, hundredths] of Object.entries(s.swims ?? {})) {
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
    for (const [legEventKey, hundredths] of Object.entries(s.splits ?? {})) {
      splits.push({
        splitId: `split-${s.id}-${legEventKey}`,
        swimmerId: s.id,
        relayEventKey: null,
        legPosition: null,
        start: 'flying',
        legEventKey,
        split: { text: (hundredths / 100).toFixed(2), hundredths },
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
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? GENDER, classYear: null, roster: s.roster ?? 'member' })),
    events: [...eventKeys.map((k) => meetEvent(k)), ...womenEventKeys.map((k) => meetEvent(k, 'Women'))],
    swims,
    relaySplits: splits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

/** A relay entry by the oracle's own rule: leg 1 is the flat-start swim in the leg event, legs 2 to 4 are the flying splits. */
function relayEntry(team: string, eventKey: string, letter: string, ids: readonly string[]): LineupEntry {
  const events = LEGS[eventKey] as readonly string[];
  return {
    kind: 'relay',
    teamId: team,
    eventKey,
    gender: GENDER,
    letter,
    legs: ids.map((swimmerId, i) => ({
      swimmerId,
      basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:${events[0]}` } : { kind: 'split' as const, splitId: `split-${swimmerId}-${events[i]}` },
    })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
  };
}

const ind = (team: string, swimmerId: string, eventKey: string, gender: 'Men' | 'Women' = GENDER): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey, gender, seedSwimId: null });
const lineup = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });
const tag = (team: string, swimmerId: string, role: ScorerTag['role'] = 'scorer'): ScorerTag => ({ teamId: team, swimmerId, role });
const tags = (team: string, ids: readonly string[], role: ScorerTag['role'] = 'scorer'): ScorerTag[] => ids.map((id) => tag(team, id, role));

/** nsisc v4 with the entry caps off, so a load row is the only thing that can bind. */
function rulesOf(over: { size?: number; eventCap?: number } = {}): CompleteRulePreset {
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
      maxIndividualPerSwimmer: set('unlimited' as const),
      maxRelayPerSwimmer: set('unlimited' as const),
      maxTotalPerSwimmer: set('unlimited' as const),
    },
  });
}

interface Fx {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly tags: readonly ScorerTag[];
  readonly rules: CompleteRulePreset;
}

const respect = (max: number): LoadPreference => ({ mode: 'respect', maxRacesPerSession: set(max), diving: set('excluded' as const) });
const prefer = (max: number, penalty: number): LoadPreference => ({ mode: 'prefer', maxRacesPerSession: set(max), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(penalty) });

const timedFinal = (eventKey: string, day = 1, slot: 'morning' | 'afternoon' | 'evening' = 'evening'): ScheduledEvent => ({ eventKey, gender: 'both', format: { kind: 'timed-final', session: { day, slot } } });
const prelimsFinals = (eventKey: string, day = 1): ScheduledEvent => ({ eventKey, gender: 'both', format: { kind: 'prelims-finals', prelims: { day, slot: 'morning' }, finals: { day, slot: 'evening' } } });
const schedule = (...events: ScheduledEvent[]): SessionPreset => ({ payloadVersion: 1, provenance: TEST_PROVENANCE, events });

function request(fx: Fx, load: AutoBuildRequest['load'], over: Partial<AutoBuildRequest> = {}): AutoBuildRequest {
  return {
    model: fx.model,
    lineup: fx.lineup,
    rules: fx.rules,
    sourcing: SOURCING,
    tags: fx.tags,
    ownTeamId: 'A',
    genders: [GENDER],
    objective: { kind: 'max-own' },
    load,
    limits: LIMITS,
    ...over,
  };
}

async function autoError(run: () => Promise<unknown>): Promise<AutoBuildError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AutoBuildError) return error;
    throw error;
  }
  throw new Error('did not throw');
}

// ---- the oracle ---------------------------------------------------------------------------------

/**
 * The objective of one whole lineup: own points, less the own-only penalty in `prefer` mode. `null` when `respect` mode is
 * broken by an own swimmer on the roster. It reads `scoreMeet` and `sessionLoad` on the whole meet and nothing else.
 */
function wholeObjective(fx: Fx, entries: readonly LineupEntry[], scorers: readonly ScorerTag[], load: NonNullable<AutoBuildRequest['load']>): number | null {
  const l = lineup(...entries);
  const results = scoreMeet(fx.model, l, scorers, fx.rules, SOURCING);
  const run = sessionLoad(fx.model, l, results, load.schedule, load.preference, fx.rules);
  const own = new Set(scorers.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
  const points = (results.teams.find((t) => t.teamId === 'A') as { points: number }).points;
  const pref = load.preference;
  if (pref.mode === 'respect' && run.violations.some((v) => v.kind === 'session_load' && own.has(v.swimmerId))) return null;
  if (pref.mode === 'prefer') {
    const max = pref.maxRacesPerSession.state === 'set' ? pref.maxRacesPerSession.value : 0;
    const pen = pref.penaltyPointsPerExtraRace.state === 'set' ? pref.penaltyPointsPerExtraRace.value : 0;
    let extra = 0;
    for (const s of run.perSwimmer) if (own.has(s.swimmerId)) for (const x of s.sessions) if (x.races > max) extra += x.races - max;
    return points - extra * pen;
  }
  return points;
}

/** The best objective over every on/off choice of the option groups (the entries of a group go in together), under `valid`. */
function bruteLoad(
  fx: Fx,
  load: NonNullable<AutoBuildRequest['load']>,
  groups: readonly (readonly LineupEntry[])[],
  valid: (mask: readonly boolean[]) => boolean,
  scorerVariants: readonly (readonly ScorerTag[])[] = [fx.tags]
): number {
  let best = -Infinity;
  for (const scorers of scorerVariants) {
    for (let bits = 0; bits < 1 << groups.length; bits++) {
      const mask = groups.map((_, i) => ((bits >> i) & 1) === 1);
      if (!valid(mask)) continue;
      // An own swimmer off the roster has no new entry: the free swimmers who join are the ones who swim.
      const roster = new Set(scorers.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
      const onRoster = (e: LineupEntry): boolean => (e.kind === 'individual' ? roster.has(e.swimmerId) : e.legs.every((l) => roster.has(l.swimmerId)));
      if (groups.some((g, i) => mask[i] && !g.every(onRoster))) continue;
      const entries = [...fx.lineup.entries, ...groups.flatMap((g, i) => (mask[i] ? g : []))];
      const value = wholeObjective(fx, entries, scorers, load);
      if (value !== null) best = Math.max(best, value);
    }
  }
  return best;
}

// ---- the F3 fixture ------------------------------------------------------------------------------

/**
 * Plan F3 under the shipped NSISC schedule: on day 2 the 200 IM and the 50 free have prelims in the morning and finals in the
 * evening, and the 200 medley relay is an evening final. Star `s` wins both individual events and leads the relay with 2150 at
 * the free leg; `t4` is a slower free leg who still beats nobody. All own swimmers are pinned.
 */
function f3(): { fx: Fx; groups: LineupEntry[][]; relayWithS: LineupEntry; relayWithT4: LineupEntry } {
  const specs: Spec[] = [
    { id: 's', team: 'A', swims: { [IM]: 12000, [FREE50]: 2200 }, splits: { [FREE50]: 2150 } },
    { id: 't1', team: 'A', swims: { [BACK50]: 2750 } },
    { id: 't2', team: 'A', splits: { [BREAST50]: 2950 } },
    { id: 't3', team: 'A', splits: { [FLY50]: 2550 } },
    { id: 't4', team: 'A', splits: { [FREE50]: 2600 } },
    { id: 'b1', team: 'B', swims: { [IM]: 12500, [FREE50]: 2300, [BACK50]: 2800 } },
    { id: 'b2', team: 'B', splits: { [BREAST50]: 3000 } },
    { id: 'b3', team: 'B', splits: { [FLY50]: 2600 } },
    { id: 'b4', team: 'B', splits: { [FREE50]: 2300 } },
  ];
  const relayWithS = relayEntry('A', MEDLEY, 'A', ['t1', 't2', 't3', 's']);
  const relayWithT4 = relayEntry('A', MEDLEY, 'A', ['t1', 't2', 't3', 't4']);
  const fx: Fx = {
    model: buildModel(specs, [IM, FREE50, MEDLEY]),
    lineup: lineup(ind('B', 'b1', IM), ind('B', 'b1', FREE50), relayEntry('B', MEDLEY, 'A', ['b1', 'b2', 'b3', 'b4'])),
    tags: [...tags('A', ['s', 't1', 't2', 't3', 't4']), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
    rules: rulesOf(),
  };
  // Four options: s in the IM, s in the 50 free, the relay with s, the relay with t4. The two relays share t1 to t3.
  return { fx, groups: [[ind('A', 's', IM)], [ind('A', 's', FREE50)], [relayWithS], [relayWithT4]], relayWithS, relayWithT4 };
}

const OWN = new Set(['s', 't1', 't2', 't3', 't4']);
const notBothRelays = (mask: readonly boolean[]): boolean => !(mask[2] && mask[3]);

describe('autoBuild (D5, slice A3: session load)', () => {
  it('1 planF3: in respect mode no proposal holds the 200 IM, the 50 free and the 200 medley relay finals on day 2', async () => {
    const { fx, groups, relayWithS } = f3();
    const load = { schedule: NSISC_SESSIONS, preference: respect(2) };
    const best = bruteLoad(fx, load, groups, notBothRelays);
    const result = await autoBuild(request(fx, load), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    expect(result.proposal.evaluation.objective).toBe(best);
    expect(result.proof.status).toBe('proven_optimal');
    // The star does not swim all three finals: he is not on the relay when he swims both individual events.
    const loadRun = result.proposal.evaluation.load;
    expect(loadRun).not.toBeNull();
    expect(loadRun?.violations.filter((v) => v.kind === 'session_load' && OWN.has(v.swimmerId))).toEqual([]);
    const star = loadRun?.perSwimmer.find((s) => s.swimmerId === 's');
    for (const session of star?.sessions ?? []) expect(session.races).toBeLessThanOrEqual(2);
    expect(result.proposal.lineup.entries).not.toContainEqual(relayWithS);
    // Without the preference the best lineup puts him on all three: the load is the reason for the change.
    const free = await autoBuild(request(fx, null), nodeMipSolve());
    expect(free.kind).toBe('improved');
    if (free.kind === 'improved') expect(free.proposal.evaluation.objective).toBeGreaterThan(best);
  }, 120_000);

  it('1b planF3Current: a current lineup that holds all three finals is current_infeasible or improved with the load fixed', async () => {
    const { fx, groups, relayWithS } = f3();
    const current: Fx = { ...fx, lineup: lineup(...fx.lineup.entries, ind('A', 's', IM), ind('A', 's', FREE50), relayWithS) };
    const load = { schedule: NSISC_SESSIONS, preference: respect(2) };
    const result = await autoBuild(request(current, load), nodeMipSolve());
    expect(['current_infeasible', 'improved']).toContain(result.kind);
    const proposal = result.kind === 'improved' ? result.proposal : result.kind === 'current_infeasible' ? result.alternative : null;
    expect(proposal).not.toBeNull();
    expect(proposal?.evaluation.load?.violations.filter((v) => v.kind === 'session_load' && OWN.has(v.swimmerId))).toEqual([]);
    expect(proposal?.evaluation.objective).toBe(bruteLoad(fx, load, groups, notBothRelays));
  }, 120_000);

  it('2 preferMode: a penalty below the gain takes the third race, and a penalty above it does not', async () => {
    const { fx, groups } = f3();
    // The third race on day 2 evening is the relay with s: 40 against 34 for the relay with t4 (a gain of 6).
    const taken: number[] = [];
    for (const [penalty, takesThird] of [[5, true], [7, false]] as const) {
      const load = { schedule: NSISC_SESSIONS, preference: prefer(2, penalty) };
      const best = bruteLoad(fx, load, groups, notBothRelays);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      expect(result.kind, `penalty ${penalty}`).toBe('improved');
      if (result.kind !== 'improved') return;
      expect(result.proposal.evaluation.objective, `penalty ${penalty}`).toBeCloseTo(best, 9);
      expect(result.proof.status, `penalty ${penalty}`).toBe('proven_optimal');
      const entries = result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A' && e.legs.some((l) => l.swimmerId === 's'));
      expect(entries.length > 0, `penalty ${penalty}`).toBe(takesThird);
      expect(result.proposal.evaluation.penaltyPoints, `penalty ${penalty}`).toBeCloseTo(takesThird ? penalty : 0, 9);
      taken.push(result.proposal.evaluation.ownPoints);
    }
    expect(taken[0]).toBeGreaterThan(taken[1] as number);
  }, 120_000);

  it('3 outsideTopTable: a swimmer outside the scorer top 16 counts prelims only, so a current entry there does not block a final', async () => {
    // p is 17th in the 100 free (16 opponents are faster), so his prelims race counts and no finals race does. He also swims the
    // 100 back (morning prelims, evening final), so a timed final that evening is his second evening race, not his third.
    const E = '100 Freestyle';
    const F = '100 Backstroke';
    const G = '100 Breaststroke';
    const opp = Array.from({ length: 16 }, (_, i) => `q${i + 1}`);
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [E]: 6000, [F]: 5000, [G]: 5000 } },
      ...opp.map((id, i) => ({ id, team: 'B', swims: { [E]: 5000 + i, ...(i < 3 ? { [F]: 5500 + i } : {}), ...(i < 1 ? { [G]: 5600 } : {}) } })),
    ];
    const fx: Fx = {
      model: buildModel(specs, [E, F, G]),
      lineup: lineup(
        ...opp.map((id) => ind('B', id, E)),
        ...opp.slice(0, 3).map((id) => ind('B', id, F)),
        ind('B', 'q1', G),
        ind('A', 'p', E),
        ind('A', 'p', F)
      ),
      tags: [tag('A', 'p'), ...tags('B', opp)],
      rules: rulesOf(),
    };
    const load = { schedule: schedule(prelimsFinals(E), prelimsFinals(F), timedFinal(G)), preference: respect(2) };
    const result = await autoBuild(request(fx, load), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const mine = result.proposal.lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A');
    expect(mine).toContainEqual(ind('A', 'p', G));
    // The entry that scores nothing stays: with a finals race counted for it, keeping it and swimming G would be a third evening race.
    expect(mine).toContainEqual(ind('A', 'p', E));
    const star = result.proposal.evaluation.load?.perSwimmer.find((x) => x.swimmerId === 'p');
    const evening = star?.sessions.find((x) => x.session.slot === 'evening');
    expect(evening?.races).toBe(2);
  }, 60_000);

  it('4 splitHeatsHeld: a split heat is assigned by seed over all entries, and a free swimmer\'s kept entry holds its place', async () => {
    const PF = '100 Freestyle';
    const SP = '500 Freestyle';
    // Four entries in the split event: f (4900), b1 (5000), p (5100), b2 (5200). With fast-heat size 2, p is in the slow (morning)
    // heat while f's entry stands there. Dropping f's entry from the column would put p in the fast (evening) heat.
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [PF]: 5000, [SP]: 5100 } },
      { id: 'f', team: 'A', swims: { [SP]: 4900 } },
      { id: 'b1', team: 'B', swims: { [PF]: 5500, [SP]: 5000 } },
      { id: 'b2', team: 'B', swims: { [SP]: 5200 } },
    ];
    const split: ScheduledEvent = {
      eventKey: SP,
      gender: 'both',
      format: {
        kind: 'timed-final-split',
        slowHeats: { day: 1, slot: 'morning' },
        fastHeat: { day: 1, slot: 'evening' },
        fastHeatSize: set(2),
        smallFieldSession: set({ day: 1, slot: 'evening' as const }),
      },
    };
    const base = [ind('B', 'b1', PF), ind('B', 'b1', SP), ind('B', 'b2', SP), ind('A', 'f', SP)];
    const fx: Fx = { model: buildModel(specs, [PF, SP]), lineup: lineup(...base, ind('A', 'p', PF)), tags: [tag('A', 'p'), ...tags('B', ['b1', 'b2'])], rules: rulesOf() };
    const load = { schedule: schedule(prelimsFinals(PF), split), preference: respect(1) };
    // The oracle: p's entries are options, and f joins or not. f's entry stays in the lineup either way.
    const oracleFx: Fx = { ...fx, lineup: lineup(...base) };
    const best = bruteLoad(oracleFx, load, [[ind('A', 'p', SP)], [ind('A', 'p', PF)]], () => true, [fx.tags, [...fx.tags, tag('A', 'f')]]);
    const result = await autoBuild(request(fx, load), nodeMipSolve());
    expect(result.proof.searchSpace.restrictions).toContain('held_split_entries');
    const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
    expect(objective).toBe(best);
    expect(result.proof.status).toBe('proven_optimal');
    if (result.kind === 'improved') {
      const run = result.proposal.evaluation.load;
      expect(run?.violations.filter((v) => v.kind === 'session_load' && (v.swimmerId === 'p' || v.swimmerId === 'f'))).toEqual([]);
      // f's entry is never removed: it is held whatever his place on the roster is.
      expect(result.proposal.lineup.entries).toContainEqual(ind('A', 'f', SP));
    }
  }, 60_000);

  it('5 refusals: a pending fast-heat size refuses, a pending C final does not, an unscheduled event refuses, and a dive that counts 0 is excluded', async () => {
    const PF = '100 Freestyle';
    const SP = '500 Freestyle';
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [PF]: 5000, [SP]: 5100 } },
      { id: 'b1', team: 'B', swims: { [PF]: 5500, [SP]: 5000 } },
      { id: 'b2', team: 'B', swims: { [PF]: 5600, [SP]: 5200 } },
    ];
    const pendingSetting = { state: 'pending' as const, question: 'synthetic', blocks: [] as string[] };
    const splitRow = (size: unknown): ScheduledEvent => ({
      eventKey: SP,
      gender: 'both',
      format: { kind: 'timed-final-split', slowHeats: { day: 1, slot: 'morning' }, fastHeat: { day: 1, slot: 'evening' }, fastHeatSize: size as never, smallFieldSession: set({ day: 1, slot: 'evening' as const }) },
    });
    const fx: Fx = {
      model: buildModel(specs, [PF, SP]),
      lineup: lineup(ind('B', 'b1', PF), ind('B', 'b2', PF), ind('B', 'b1', SP), ind('B', 'b2', SP)),
      tags: [tag('A', 'p'), ...tags('B', ['b1', 'b2'])],
      rules: rulesOf(),
    };
    const pend = await autoError(() => autoBuild(request(fx, { schedule: schedule(prelimsFinals(PF), splitRow(pendingSetting)), preference: respect(2) }), nodeMipSolve()));
    expect(pend.code).toBe('pending_setting');
    expect(pend.subject).toBe(`schedule:${SP}|Men:fastHeatSize`);
    // A pending C final affects only non-scorers: an opponent non-scorer in a prelims-finals event does not refuse.
    const noC = { ...fx.rules, scoring: { ...fx.rules.scoring, cFinal: pendingSetting } } as unknown as CompleteRulePreset;
    const withNonScorer: Fx = { ...fx, tags: [tag('A', 'p'), tag('B', 'b1'), tag('B', 'b2', 'non-scorer')], rules: noC };
    const ok = await autoBuild(request(withNonScorer, { schedule: schedule(prelimsFinals(PF), splitRow(set(8))), preference: respect(2) }), nodeMipSolve());
    expect(['improved', 'unchanged']).toContain(ok.kind);
    const missing = await autoError(() => autoBuild(request(fx, { schedule: schedule(prelimsFinals(PF)), preference: respect(2) }), nodeMipSolve()));
    expect(missing.code).toBe('unscheduled_event');
    expect(missing.subject).toBe(`${SP}|Men`);
    // A row for the other gender is no schedule for this one.
    const otherGender = await autoError(() =>
      autoBuild(request(fx, { schedule: schedule(prelimsFinals(PF), { ...timedFinal(SP), gender: 'Women' }), preference: respect(2) }), nodeMipSolve())
    );
    expect(otherGender.code).toBe('unscheduled_event');
    expect(otherGender.subject).toBe(`${SP}|Men`);
  }, 60_000);

  it('5b divesExcluded: a dive counts 0 races under "excluded" and 1 under "counts"', async () => {
    const E1 = '100 Freestyle';
    const E2 = '100 Backstroke';
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [E1]: 5000, [E2]: 5000, [DIVE]: 27000 } },
      { id: 'b', team: 'B', swims: { [E1]: 5500, [E2]: 5500, [DIVE]: 26000 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, E2, DIVE]),
      lineup: lineup(ind('B', 'b', E1), ind('B', 'b', E2), ind('B', 'b', DIVE)),
      tags: [tag('A', 'p'), tag('B', 'b')],
      rules: rulesOf(),
    };
    const sched = schedule(timedFinal(E1), timedFinal(E2), timedFinal(DIVE));
    const counts = async (diving: 'excluded' | 'counts'): Promise<{ events: number; objective: number }> => {
      const preference: LoadPreference = { mode: 'respect', maxRacesPerSession: set(2), diving: set(diving) };
      const load = { schedule: sched, preference };
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const proposal = result.kind === 'improved' ? result.proposal : null;
      expect(proposal).not.toBeNull();
      return { events: (proposal?.lineup.entries ?? []).filter((e) => e.teamId === 'A').length, objective: proposal?.evaluation.objective ?? 0 };
    };
    const excluded = await counts('excluded');
    const counted = await counts('counts');
    expect(excluded.events).toBe(3);
    expect(counted.events).toBe(2);
    expect(excluded.objective).toBeGreaterThan(counted.objective);
  }, 60_000);

  it('6 penaltyOwnOnly: penaltyPoints is the own-only sum from perSwimmer, and differs from sessionLoad.penaltyPoints', async () => {
    const { fx } = f3();
    // The opponent b1 swims the IM, the 50 free and the relay: three evening races. That is one extra race that sessionLoad prices.
    const load = { schedule: NSISC_SESSIONS, preference: prefer(2, 5) };
    const result = await autoBuild(request(fx, load), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const run = result.proposal.evaluation.load;
    expect(run).not.toBeNull();
    const OWN_IDS = new Set(['s', 't1', 't2', 't3', 't4']);
    let ownExtra = 0;
    for (const sw of run?.perSwimmer ?? []) if (OWN_IDS.has(sw.swimmerId)) for (const x of sw.sessions) if (x.races > 2) ownExtra += x.races - 2;
    expect(result.proposal.evaluation.penaltyPoints).toBeCloseTo(ownExtra * 5, 9);
    expect(run?.penaltyPoints).toBeGreaterThan(result.proposal.evaluation.penaltyPoints);
    expect(result.proposal.evaluation.objective).toBeCloseTo(result.proposal.evaluation.ownPoints - result.proposal.evaluation.penaltyPoints, 9);
    // The current lineup has no own entry: its own-only penalty is 0, and sessionLoad still prices the opponent.
    expect(result.current.penaltyPoints).toBe(0);
    expect(result.current.load?.penaltyPoints).toBe(5);
  }, 120_000);

  /** Three own swimmers and three events on one day: a prelims-finals event, a timed final in the evening, and a second prelims-finals event. */
  function randomFixture(seed: number, free: number): { fx: Fx; groups: LineupEntry[][]; variants: ScorerTag[][]; events: string[] } {
    const state = { v: seed * 2654435761 + 12345 };
    const rand = (): number => {
      state.v = (state.v * 1664525 + 1013904223) % 4294967296;
      return state.v / 4294967296;
    };
    const events = ['100 Freestyle', '100 Backstroke', '100 Breaststroke'];
    const own = ['o1', 'o2', 'o3'];
    const opp = ['b1', 'b2', 'b3'];
    const specs: Spec[] = [
      ...own.map((id) => ({ id, team: 'A', swims: Object.fromEntries(events.map((e) => [e, 4600 + Math.floor(rand() * 600)])) })),
      ...opp.map((id) => ({ id, team: 'B', swims: Object.fromEntries(events.map((e) => [e, 4700 + Math.floor(rand() * 400)])) })),
    ];
    const base = lineup(...opp.flatMap((id) => events.map((e) => ind('B', id, e))));
    const pinned = own.slice(0, own.length - free);
    const joiners = own.slice(own.length - free);
    const fx: Fx = { model: buildModel(specs, events), lineup: base, tags: [...tags('A', pinned), ...tags('B', opp)], rules: rulesOf() };
    const variants: ScorerTag[][] = [];
    for (let bits = 0; bits < 1 << joiners.length; bits++) variants.push([...fx.tags, ...joiners.filter((_, i) => ((bits >> i) & 1) === 1).map((id) => tag('A', id))]);
    return { fx, groups: own.flatMap((id) => events.map((e) => [ind('A', id, e)])), variants, events };
  }

  const randomLoad = (seed: number, events: readonly string[]): NonNullable<AutoBuildRequest['load']> => ({
    schedule: schedule(prelimsFinals(events[0] as string), timedFinal(events[1] as string), prelimsFinals(events[2] as string)),
    preference: seed % 2 === 1 ? respect(1 + (seed % 3 === 0 ? 1 : 0)) : prefer(1, [0.5, 2, 5][seed % 3] as number),
  });

  it('7 bruteForceLoad: seeded fixtures with pinned and free swimmers equal the whole-meet brute force and are proven', async () => {
    for (const [seed, free] of [[1, 0], [2, 0], [3, 0], [4, 2], [5, 2], [6, 1]] as const) {
      const { fx, groups, variants, events } = randomFixture(seed, free);
      const load = randomLoad(seed, events);
      const best = bruteLoad(fx, load, groups, () => true, variants);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, `seed ${seed}`).toBeCloseTo(best, 9);
      expect(result.proof.status, `seed ${seed}`).toBe('proven_optimal');
    }
  }, 300_000);

  it('7b boundCoversLoad: with one candidate and no refinement the bound still covers the brute-force optimum, outside races charged', async () => {
    for (const [seed, free] of [[1, 0], [2, 0], [3, 0], [4, 2], [6, 1]] as const) {
      const { fx, groups, variants, events } = randomFixture(seed, free);
      const load = randomLoad(seed, events);
      const best = bruteLoad(fx, load, groups, () => true, variants);
      const result = await autoBuild(request(fx, load, { limits: { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 } }), nodeMipSolve());
      expect(result.proof.upperBound, `seed ${seed}`).not.toBeNull();
      expect(result.proof.bestFound, `seed ${seed}`).toBeLessThanOrEqual(best + 1e-9);
      expect(best, `seed ${seed}`).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
    }
  }, 300_000);

  it('8 orderIndependence: permuting swimmers and tags gives byte-identical LP text with load rows', async () => {
    const { fx } = f3();
    const load = { schedule: NSISC_SESSIONS, preference: prefer(2, 5) };
    const a = nodeMipSolve();
    const b = nodeMipSolve();
    await autoBuild(request(fx, load), a);
    const permuted: Fx = {
      ...fx,
      model: { ...fx.model, swimmers: [...fx.model.swimmers].reverse(), swims: [...fx.model.swims].reverse(), relaySplits: [...fx.model.relaySplits].reverse() },
      tags: [...fx.tags].reverse(),
    };
    await autoBuild(request(permuted, load), b);
    expect(b.texts).toEqual(a.texts);
    expect(a.texts.some((t) => /\bv\d+_/.test(t))).toBe(true);
  }, 120_000);

  it('9 offModeIsNoRows: a load with mode off builds no load rows and the result equals the no-load result', async () => {
    const { fx } = f3();
    const none = await autoBuild(request(fx, null), nodeMipSolve());
    const off = await autoBuild(request(fx, { schedule: NSISC_SESSIONS, preference: { mode: 'off' } }), nodeMipSolve());
    expect(off.kind).toBe(none.kind);
    if (off.kind === 'improved' && none.kind === 'improved') expect(off.proposal.evaluation.objective).toBe(none.proposal.evaluation.objective);
    // An empty schedule is no refusal and no violation when the mode is off: nothing reads the schedule.
    const empty = await autoBuild(request(fx, { schedule: { ...NSISC_SESSIONS, events: [] }, preference: { mode: 'off' } }), nodeMipSolve());
    expect(empty.kind).toBe(none.kind);
    if (empty.kind === 'improved') {
      expect(empty.proposal.evaluation.load).toBeNull();
      expect(empty.proposal.evaluation.penaltyPoints).toBe(0);
    }
  }, 120_000);

  // ---- fixtures that pin one rule of the load model each (found by mutation) -----------------------

  const prelimsFinalsSameSession = (eventKey: string): ScheduledEvent => ({
    eventKey,
    gender: 'both',
    format: { kind: 'prelims-finals', prelims: { day: 1, slot: 'morning' }, finals: { day: 1, slot: 'morning' } },
  });

  it('10 racesPerEntry: an entry with prelims and finals in one session counts 2 races, so max 1 refuses it and max 2 fills the session', async () => {
    const X = '100 Freestyle';
    const Y = '100 Backstroke';
    const specs: Spec[] = [
      { id: 'o1', team: 'A', swims: { [X]: 4800, [Y]: 4900 } },
      { id: 'b1', team: 'B', swims: { [X]: 5000, [Y]: 5100 } },
    ];
    const fx: Fx = { model: buildModel(specs, [X, Y]), lineup: lineup(ind('B', 'b1', X), ind('B', 'b1', Y)), tags: [tag('A', 'o1'), tag('B', 'b1')], rules: rulesOf() };
    for (const max of [1, 2, 3]) {
      const load = { schedule: schedule(prelimsFinalsSameSession(X), timedFinal(Y, 1, 'morning')), preference: respect(max) };
      const best = bruteLoad(fx, load, [[ind('A', 'o1', X)], [ind('A', 'o1', Y)]], () => true);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, `max ${max}`).toBe(best);
      expect(result.proof.status, `max ${max}`).toBe('proven_optimal');
    }
  }, 120_000);

  const splitRow = (eventKey: string): ScheduledEvent => ({
    eventKey,
    gender: 'both',
    format: {
      kind: 'timed-final-split',
      slowHeats: { day: 1, slot: 'morning' },
      fastHeat: { day: 1, slot: 'evening' },
      fastHeatSize: set(2),
      smallFieldSession: set({ day: 1, slot: 'evening' as const }),
    },
  });

  it('12 heldEntryShapesHeats: a held split entry ahead of the swimmer keeps him in the slow heat, so he can add the event beside an evening final', async () => {
    const T = '100 Freestyle';
    const SP = '500 Freestyle';
    // Seeds in the split event: f 4900 (held), b1 5000, p 5100, b2 5200. With fast-heat size 2 the fast (evening) heat is f and b1.
    // p is in the slow (morning) heat. Without f's entry the fast heat would be b1 and p: p would race twice that evening.
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [T]: 5000, [SP]: 5100 } },
      { id: 'f', team: 'A', swims: { [SP]: 4900 } },
      { id: 'b1', team: 'B', swims: { [T]: 5500, [SP]: 5000 } },
      { id: 'b2', team: 'B', swims: { [SP]: 5200 } },
    ];
    const base = [ind('B', 'b1', T), ind('B', 'b1', SP), ind('B', 'b2', SP), ind('A', 'f', SP)];
    const fx: Fx = { model: buildModel(specs, [T, SP]), lineup: lineup(...base, ind('A', 'p', T)), tags: [tag('A', 'p'), ...tags('B', ['b1', 'b2'])], rules: rulesOf() };
    const oracleFx: Fx = { ...fx, lineup: lineup(...base) };
    for (const preference of [respect(1), prefer(1, 4)]) {
      const load = { schedule: schedule(timedFinal(T), splitRow(SP)), preference };
      const best = bruteLoad(oracleFx, load, [[ind('A', 'p', SP)], [ind('A', 'p', T)]], () => true, [fx.tags, [...fx.tags, tag('A', 'f')]]);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const label = preference.mode;
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, label).toBeCloseTo(best, 9);
      expect(result.proof.status, label).toBe('proven_optimal');
      expect(result.proof.searchSpace.restrictions, label).toContain('held_split_entries');
      const lineupOut = result.kind === 'improved' ? result.proposal.lineup : fx.lineup;
      expect(lineupOut.entries, label).toContainEqual(ind('A', 'f', SP));
      expect(lineupOut.entries, label).toContainEqual(ind('A', 'p', SP));
    }
    // With one candidate per event the held entry still shapes the heats and still stays in the lineup, and the bound covers the optimum.
    const narrow = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    const load = { schedule: schedule(timedFinal(T), splitRow(SP)), preference: respect(1) };
    const best = bruteLoad(oracleFx, load, [[ind('A', 'p', SP)], [ind('A', 'p', T)]], () => true, [fx.tags, [...fx.tags, tag('A', 'f')]]);
    const result = await autoBuild(request(fx, load, { limits: narrow }), nodeMipSolve());
    expect(result.proof.upperBound).not.toBeNull();
    expect(best).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
    expect(result.proof.bestFound).toBeLessThanOrEqual(best + 1e-9);
    const lineupOut = result.kind === 'improved' ? result.proposal.lineup : fx.lineup;
    expect(lineupOut.entries).toContainEqual(ind('A', 'f', SP));
  }, 120_000);

  const narrowLimits: AutoBuildLimits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };

  it('13 outsideRaceCharge: an outside pair is charged the race it certainly swims, so the bound is the brute-force optimum', async () => {
    // Two swimmers, two events, one candidate each: a is the candidate in E1 and b in E2, and the other swimmer is an outside pair.
    // Each swimmer may swim one race a session, so a relaxed model that charges nothing for an outside pair lets both swim twice.
    const E1 = '100 Freestyle';
    const E2 = '100 Backstroke';
    const specs: Spec[] = [
      { id: 'a', team: 'A', swims: { [E1]: 4800, [E2]: 5000 } },
      { id: 'b', team: 'A', swims: { [E1]: 4900, [E2]: 4700 } },
      { id: 'x', team: 'B', swims: { [E1]: 5200, [E2]: 5200 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, E2]),
      lineup: lineup(ind('B', 'x', E1), ind('B', 'x', E2)),
      tags: [tag('A', 'a'), tag('A', 'b'), tag('B', 'x')],
      rules: rulesOf(),
    };
    const formats: [string, ScheduledEvent[]][] = [
      ['timed finals', [timedFinal(E1), timedFinal(E2)]],
      ['prelims and finals', [prelimsFinals(E1), prelimsFinals(E2)]],
    ];
    for (const [name, events] of formats) {
      const load = { schedule: schedule(...events), preference: respect(1) };
      const best = bruteLoad(fx, load, [[ind('A', 'a', E1)], [ind('A', 'a', E2)], [ind('A', 'b', E1)], [ind('A', 'b', E2)]], () => true);
      const result = await autoBuild(request(fx, load, { limits: narrowLimits }), nodeMipSolve());
      expect(result.proof.upperBound, name).not.toBeNull();
      expect(result.proof.bestFound, name).toBeLessThanOrEqual(best + 1e-9);
      expect(best, name).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
      // The charge makes the bound exact here: a swimmer's second race is never free in the relaxed model.
      expect(result.proof.upperBound, name).toBeCloseTo(best, 9);
    }
  }, 120_000);

  it('13b outsideDive: a dive that counts 0 is not charged to an outside pair, so the bound still covers the optimum', async () => {
    const E1 = '100 Freestyle';
    const specs: Spec[] = [
      { id: 'a', team: 'A', swims: { [E1]: 5100, [DIVE]: 28000 } },
      { id: 'b', team: 'A', swims: { [E1]: 4800, [DIVE]: 27000 } },
      { id: 'x', team: 'B', swims: { [E1]: 5200, [DIVE]: 26000 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, DIVE]),
      lineup: lineup(ind('B', 'x', E1), ind('B', 'x', DIVE)),
      tags: [tag('A', 'a'), tag('A', 'b'), tag('B', 'x')],
      rules: rulesOf(),
    };
    const load = { schedule: schedule(timedFinal(E1), timedFinal(DIVE)), preference: respect(1) };
    const best = bruteLoad(fx, load, [[ind('A', 'a', E1)], [ind('A', 'a', DIVE)], [ind('A', 'b', E1)], [ind('A', 'b', DIVE)]], () => true);
    const result = await autoBuild(request(fx, load, { limits: narrowLimits }), nodeMipSolve());
    expect(result.proof.upperBound).not.toBeNull();
    expect(result.proof.bestFound).toBeLessThanOrEqual(best + 1e-9);
    expect(best).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
  }, 120_000);

  it('14 constantPenalty: an own swimmer of a gender that is not built keeps his races, and his penalty is a constant of the objective', async () => {
    const E1 = '100 Freestyle';
    const W1 = '100 Backstroke';
    const W2 = '100 Breaststroke';
    const specs: Spec[] = [
      { id: 'o1', team: 'A', swims: { [E1]: 4800 } },
      { id: 'w', team: 'A', gender: 'Women', swims: { [W1]: 5000, [W2]: 5100 } },
      { id: 'x', team: 'B', swims: { [E1]: 5200 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1], [W1, W2]),
      lineup: lineup(ind('B', 'x', E1), ind('A', 'w', W1, 'Women'), ind('A', 'w', W2, 'Women')),
      tags: [tag('A', 'o1'), tag('A', 'w'), tag('B', 'x')],
      rules: rulesOf(),
    };
    for (const penalty of [3, 0.5]) {
      const load = { schedule: schedule(timedFinal(E1), timedFinal(W1), timedFinal(W2)), preference: prefer(1, penalty) };
      const best = bruteLoad(fx, load, [[ind('A', 'o1', E1)]], () => true);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, `penalty ${penalty}`).toBeCloseTo(best, 9);
      expect(result.proof.status, `penalty ${penalty}`).toBe('proven_optimal');
      // The Women's swimmer is over the limit by one race in the evening, and the penalty prices it.
      expect(result.current.penaltyPoints, `penalty ${penalty}`).toBeCloseTo(penalty, 9);
    }
  }, 120_000);

  it('14b constantRaces: a decision swimmer on two fixed relays keeps both races, and his penalty is a constant of the objective', async () => {
    const E1 = '100 Freestyle';
    // The relay legs n1 to n6 are non-scorers, so the medley relay is fixed as entered. m is a scorer on two of its squads.
    const specs: Spec[] = [
      { id: 'm', team: 'A', splits: { [FREE50]: 2300 } },
      { id: 'o1', team: 'A', swims: { [E1]: 4800 } },
      { id: 'n1', team: 'A', swims: { [BACK50]: 2800 } },
      { id: 'n2', team: 'A', splits: { [BREAST50]: 3000 } },
      { id: 'n3', team: 'A', splits: { [FLY50]: 2600 } },
      { id: 'n4', team: 'A', swims: { [BACK50]: 2850 } },
      { id: 'n5', team: 'A', splits: { [BREAST50]: 3050 } },
      { id: 'n6', team: 'A', splits: { [FLY50]: 2650 } },
      { id: 'x', team: 'B', swims: { [E1]: 5200 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, MEDLEY]),
      lineup: lineup(ind('B', 'x', E1), relayEntry('A', MEDLEY, 'A', ['n1', 'n2', 'n3', 'm']), relayEntry('A', MEDLEY, 'B', ['n4', 'n5', 'n6', 'm'])),
      tags: [tag('A', 'm'), tag('A', 'o1'), ...tags('A', ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'], 'non-scorer'), tag('B', 'x')],
      rules: rulesOf(),
    };
    for (const penalty of [3, 0.5]) {
      const load = { schedule: schedule(timedFinal(E1), timedFinal(MEDLEY)), preference: prefer(1, penalty) };
      const best = bruteLoad(fx, load, [[ind('A', 'o1', E1)]], () => true);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, `penalty ${penalty}`).toBeCloseTo(best, 9);
      expect(result.proof.status, `penalty ${penalty}`).toBe('proven_optimal');
      expect(result.current.penaltyPoints, `penalty ${penalty}`).toBeCloseTo(penalty, 9);
    }
  }, 120_000);

  it('15 sharedSquadRaces: a current column with two squads that share a swimmer counts his two races, and the current lineup stays reachable', async () => {
    const { fx } = f3();
    const second = relayEntry('A', MEDLEY, 'B', ['t1', 't2', 't3', 't4']);
    const first = relayEntry('A', MEDLEY, 'A', ['t1', 't2', 't3', 's']);
    const current: Fx = { ...fx, lineup: lineup(...fx.lineup.entries, first, second) };
    for (const max of [2, 1]) {
      const load = { schedule: NSISC_SESSIONS, preference: respect(max) };
      const result = await autoBuild(request(current, load), nodeMipSolve());
      const proposal = result.kind === 'improved' ? result.proposal : result.kind === 'current_infeasible' ? result.alternative : null;
      // At max 2 the two squads are legal (t1 swims twice), and at max 1 they are not: the proposal repairs it.
      if (max === 2) expect(result.kind, `max ${max}`).not.toBe('current_infeasible');
      else expect(['current_infeasible', 'improved'], `max ${max}`).toContain(result.kind);
      const run = proposal === null ? result.current.load : proposal.evaluation.load;
      expect(run?.violations.filter((v) => v.kind === 'session_load' && OWN.has(v.swimmerId)), `max ${max}`).toEqual([]);
      if (max === 2) {
        const out = proposal === null ? current.lineup : proposal.lineup;
        const t1 = (run?.perSwimmer.find((p) => p.swimmerId === 't1')?.sessions ?? []).reduce((n, x) => n + x.races, 0);
        expect(t1, 'his races are counted from the lineup it returns').toBe(out.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A' && e.legs.some((l) => l.swimmerId === 't1')).length);
      }
    }
  }, 120_000);

  it('12b heldOffRoster: a held entry of a swimmer who is off the roster still shapes the heats, and a held entry stays on the roster with its swimmer', async () => {
    const T = '100 Freestyle';
    const SP = '500 Freestyle';
    // Team size 1: p is the one scorer, so f cannot join the roster. His entry is still in the heat: p stays in the slow heat.
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [T]: 5000, [SP]: 5100 } },
      { id: 'f', team: 'A', swims: { [SP]: 4900 } },
      { id: 'b1', team: 'B', swims: { [T]: 5500, [SP]: 5000 } },
      { id: 'b2', team: 'B', swims: { [SP]: 5200 } },
    ];
    const base = [ind('B', 'b1', T), ind('B', 'b1', SP), ind('B', 'b2', SP), ind('A', 'f', SP)];
    const fx: Fx = { model: buildModel(specs, [T, SP]), lineup: lineup(...base, ind('A', 'p', T)), tags: [tag('A', 'p'), ...tags('B', ['b1', 'b2'])], rules: rulesOf({ size: 1 }) };
    const oracleFx: Fx = { ...fx, lineup: lineup(...base) };
    for (const preference of [respect(1), prefer(1, 4)]) {
      const load = { schedule: schedule(timedFinal(T), splitRow(SP)), preference };
      const best = bruteLoad(oracleFx, load, [[ind('A', 'p', SP)], [ind('A', 'p', T)]], () => true);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, preference.mode).toBeCloseTo(best, 9);
      expect(result.proof.status, preference.mode).toBe('proven_optimal');
      const out = result.kind === 'improved' ? result.proposal.lineup : fx.lineup;
      expect(out.entries, preference.mode).toContainEqual(ind('A', 'f', SP));
      expect(out.entries, preference.mode).toContainEqual(ind('A', 'p', SP));
    }
  }, 120_000);

  it('12c heldRosterZ: a held entry cannot be dropped while its swimmer is on the roster, so a swimmer with two evening races is on it or he is not', async () => {
    const T = '100 Freestyle';
    const SP = '500 Freestyle';
    // f's held entry is in the fast (evening) heat, as is his timed final: two evening races. On the roster he must drop the final and
    // keep the held entry (2nd place in SP); off it he scores nothing. Keeping the final and hiding the held race would score more.
    const specs: Spec[] = [
      { id: 'f', team: 'A', swims: { [T]: 4800, [SP]: 4900 } },
      { id: 'z', team: 'A' },
      { id: 'b1', team: 'B', swims: { [T]: 5500, [SP]: 4800 } },
      { id: 'b2', team: 'B', swims: { [SP]: 5200 } },
    ];
    const base = [ind('B', 'b1', T), ind('B', 'b1', SP), ind('B', 'b2', SP), ind('A', 'f', SP)];
    const fx: Fx = { model: buildModel(specs, [T, SP]), lineup: lineup(...base, ind('A', 'f', T)), tags: [tag('A', 'z'), ...tags('B', ['b1', 'b2'])], rules: rulesOf() };
    const oracleFx: Fx = { ...fx, lineup: lineup(...base) };
    for (const preference of [respect(1), prefer(1, 4)]) {
      const load = { schedule: schedule(timedFinal(T), splitRow(SP)), preference };
      const best = bruteLoad(oracleFx, load, [[ind('A', 'f', T)]], () => true, [fx.tags, [...fx.tags, tag('A', 'f')]]);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      // In respect mode the current lineup (f with two evening races, off the roster or on it) is infeasible when he is on it.
      const proposal = result.kind === 'improved' ? result.proposal : result.kind === 'current_infeasible' ? result.alternative : null;
      const objective = proposal === null ? result.current.objective : proposal.evaluation.objective;
      expect(objective, preference.mode).toBeCloseTo(best, 9);
      const out = proposal === null ? fx.lineup : proposal.lineup;
      expect(out.entries, preference.mode).toContainEqual(ind('A', 'f', SP));
    }
  }, 120_000);

  it('12d heldBeyondK: with one candidate per event a held entry beyond it is still a candidate, so its swimmer can be on the roster', async () => {
    const SP = '500 Freestyle';
    const specs: Spec[] = [
      { id: 'f1', team: 'A', swims: { [SP]: 4900 } },
      { id: 'f2', team: 'A', swims: { [SP]: 5300 } },
      { id: 'z', team: 'A' },
      { id: 'b1', team: 'B', swims: { [SP]: 5000 } },
      { id: 'b2', team: 'B', swims: { [SP]: 5200 } },
    ];
    const base = [ind('B', 'b1', SP), ind('B', 'b2', SP), ind('A', 'f1', SP), ind('A', 'f2', SP)];
    const fx: Fx = { model: buildModel(specs, [SP]), lineup: lineup(...base), tags: [tag('A', 'z'), ...tags('B', ['b1', 'b2'])], rules: rulesOf() };
    const oracleFx: Fx = { ...fx, lineup: lineup(...base) };
    const load = { schedule: schedule(splitRow(SP)), preference: respect(1) };
    const variants = [[], [tag('A', 'f1')], [tag('A', 'f2')], [tag('A', 'f1'), tag('A', 'f2')]].map((extra) => [...fx.tags, ...extra]);
    const best = bruteLoad(oracleFx, load, [], () => true, variants);
    const result = await autoBuild(request(fx, load, { limits: narrowLimits }), nodeMipSolve());
    expect(result.proof.bestFound).toBeCloseTo(best, 9);
    const tagged = new Set((result.kind === 'improved' ? result.proposal.tagsForScoring : fx.tags).filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
    expect([...tagged].sort()).toEqual(['f1', 'f2', 'z']);
  }, 120_000);

  it('16 heatDependsOnColumn: a faster candidate pushes a swimmer to the slow heat, so his races depend on who else enters', async () => {
    const T = '100 Freestyle';
    const SP = '500 Freestyle';
    // Seeds in the split event: b1 4900, g 4950 (free, not entered), p 5000, b2 5100. With fast-heat size 2, p is in the fast
    // (evening) heat unless g enters: then p is in the slow (morning) heat. p also holds a timed final that evening.
    const specs: Spec[] = [
      { id: 'p', team: 'A', swims: { [T]: 5000, [SP]: 5000 } },
      { id: 'g', team: 'A', swims: { [SP]: 4950 } },
      { id: 'b1', team: 'B', swims: { [T]: 5500, [SP]: 4900 } },
      { id: 'b2', team: 'B', swims: { [SP]: 5100 } },
    ];
    const base = [ind('B', 'b1', T), ind('B', 'b1', SP), ind('B', 'b2', SP)];
    for (const size of [undefined, 1]) {
      const fx: Fx = {
        model: buildModel(specs, [T, SP]),
        lineup: lineup(...base, ind('A', 'p', T)),
        tags: [tag('A', 'p'), ...tags('B', ['b1', 'b2'])],
        rules: rulesOf(size === undefined ? {} : { size }),
      };
      const oracleFx: Fx = { ...fx, lineup: lineup(...base) };
      const variants = size === undefined ? [fx.tags, [...fx.tags, tag('A', 'g')]] : [fx.tags];
      for (const preference of [respect(1), prefer(1, 4)]) {
        const load = { schedule: schedule(timedFinal(T), splitRow(SP)), preference };
        // g's own entry has to be an option too: he swims or not as a free swimmer.
        const groups = [[ind('A', 'p', SP)], [ind('A', 'p', T)], [ind('A', 'g', SP)]];
        const best = bruteLoad(oracleFx, load, groups, () => true, variants);
        const result = await autoBuild(request(fx, load), nodeMipSolve());
        const label = `size ${size} ${preference.mode}`;
        const proposal = result.kind === 'improved' ? result.proposal : result.kind === 'current_infeasible' ? result.alternative : null;
        expect(proposal === null ? result.current.objective : proposal.evaluation.objective, label).toBeCloseTo(best, 9);
        expect(result.proof.status, label).toBe('proven_optimal');
      }
    }
  }, 120_000);

  it('18 heldOverCap: with an event cap of 1 a held entry over the cap is kept beside the scorer, so the team keeps its first place and gains the swimmer', async () => {
    const SP = '500 Freestyle';
    const E2 = '100 Freestyle';
    // Cap 1 per team per event, over-cap entries removed. a is 1st in SP, f is held in SP behind the opponent b0 and over the cap.
    // f also wins E2. Putting f on the roster forces his held SP entry in beside a's, so a column with two own entries is needed.
    const specs: Spec[] = [
      { id: 'a', team: 'A', swims: { [SP]: 4800 } },
      { id: 'f', team: 'A', swims: { [SP]: 4900, [E2]: 5000 } },
      { id: 'b0', team: 'B', swims: { [SP]: 4850 } },
      { id: 'b1', team: 'B', swims: { [SP]: 5000, [E2]: 5500 } },
    ];
    const base = [ind('B', 'b0', SP), ind('B', 'b1', SP), ind('B', 'b1', E2), ind('A', 'f', SP)];
    const fx: Fx = { model: buildModel(specs, [SP, E2]), lineup: lineup(...base), tags: [tag('A', 'a'), ...tags('B', ['b0', 'b1'])], rules: rulesOf({ eventCap: 1 }) };
    const load = { schedule: schedule(splitRow(SP), timedFinal(E2)), preference: respect(3) };
    const variants = [fx.tags, [...fx.tags, tag('A', 'f')]];
    const best = bruteLoad(fx, load, [[ind('A', 'a', SP)], [ind('A', 'f', E2)]], () => true, variants);
    const result = await autoBuild(request(fx, load), nodeMipSolve());
    const proposal = result.kind === 'improved' ? result.proposal : result.kind === 'current_infeasible' ? result.alternative : null;
    expect(proposal === null ? result.current.objective : proposal.evaluation.objective).toBeCloseTo(best, 9);
    expect(result.proof.status).toBe('proven_optimal');
  }, 120_000);

  it('19 refusalOrder: pending and unscheduled refusals come before any column is built, and a pending setting comes first', async () => {
    const E1 = '100 Freestyle';
    const E2 = '100 Backstroke';
    const SP = '500 Freestyle';
    const own = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'];
    const specs: Spec[] = [
      ...own.map((id, i) => ({ id, team: 'A', swims: { [E1]: 5000 + i, [E2]: 5100 + i, [SP]: 5200 + i } })),
      { id: 'b1', team: 'B', swims: { [E1]: 5500, [E2]: 5500, [SP]: 5500 } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, E2, SP]),
      lineup: lineup(ind('B', 'b1', E1), ind('B', 'b1', E2), ind('B', 'b1', SP)),
      tags: [tag('A', 'o1'), tag('B', 'b1')],
      rules: rulesOf(),
    };
    // Six free swimmers make 64 columns per event, 192 in all, once the space is built. A refusal must cost far fewer scoreMeet calls.
    const pendingSplit: ScheduledEvent = {
      eventKey: SP,
      gender: 'both',
      format: { kind: 'timed-final-split', slowHeats: { day: 1, slot: 'morning' }, fastHeat: { day: 1, slot: 'evening' }, fastHeatSize: { state: 'pending', question: 'synthetic', blocks: [] }, smallFieldSession: set({ day: 1, slot: 'evening' as const }) },
    };
    const evaluations = (): number => scored.calls + fastSpy.mock.calls.length;
    const fastSpy = vi.spyOn(FastScorer.prototype, 'score');
    scored.calls = 0;
    fastSpy.mockClear();
    const unscheduled = await autoError(() => autoBuild(request(fx, { schedule: schedule(timedFinal(E1), timedFinal(SP)), preference: respect(2) }), nodeMipSolve()));
    expect({ code: unscheduled.code, subject: unscheduled.subject }).toEqual({ code: 'unscheduled_event', subject: `${E2}|Men` });
    expect(evaluations(), 'unscheduled refusal: no column enumeration').toBeLessThan(40);
    // E2 is unscheduled and SP has a pending setting: the pending setting (2.1 item 5) wins over the unscheduled event (item 6).
    scored.calls = 0;
    fastSpy.mockClear();
    const both = await autoError(() => autoBuild(request(fx, { schedule: schedule(timedFinal(E1), pendingSplit), preference: respect(2) }), nodeMipSolve()));
    expect({ code: both.code, subject: both.subject }).toEqual({ code: 'pending_setting', subject: `schedule:${SP}|Men:fastHeatSize` });
    expect(evaluations(), 'pending refusal: no column enumeration').toBeLessThan(40);
    // Control: a schedule that covers every event builds the columns, which costs many more calls.
    scored.calls = 0;
    fastSpy.mockClear();
    await autoBuild(request(fx, { schedule: schedule(timedFinal(E1), timedFinal(E2), timedFinal(SP)), preference: respect(2) }), nodeMipSolve());
    expect(evaluations(), 'control').toBeGreaterThan(100);
  }, 120_000);

  it('11 rankDependentCounts: a swimmer at the edge of the top 16 races a final or not by who else enters, and the load follows the column', async () => {
    // 15 opponents in the 100 free. Own p1 and p2 both sit behind them: alone, either is 16th and races a final that evening; with
    // the faster p2 in, p1 is 17th and his prelims race is the only one. p1 also holds a timed final that evening.
    const E = '100 Freestyle';
    const T = '100 Backstroke';
    const opp = Array.from({ length: 15 }, (_, i) => `q${i + 1}`);
    const specs: Spec[] = [
      { id: 'p1', team: 'A', swims: { [E]: 6100, [T]: 5000 } },
      { id: 'p2', team: 'A', swims: { [E]: 6000 } },
      ...opp.map((id, i) => ({ id, team: 'B', swims: { [E]: 5000 + i * 10 } })),
    ];
    const fx: Fx = {
      model: buildModel(specs, [E, T]),
      lineup: lineup(...opp.map((id) => ind('B', id, E))),
      tags: [tag('A', 'p1'), tag('A', 'p2'), ...tags('B', opp)],
      rules: rulesOf(),
    };
    for (const preference of [respect(1), respect(2), prefer(1, 3), prefer(1, 0.5)]) {
      const load = { schedule: schedule(prelimsFinals(E), timedFinal(T)), preference };
      const groups = [[ind('A', 'p1', E)], [ind('A', 'p2', E)], [ind('A', 'p1', T)]];
      const best = bruteLoad(fx, load, groups, () => true);
      const result = await autoBuild(request(fx, load), nodeMipSolve());
      const objective = result.kind === 'improved' ? result.proposal.evaluation.objective : result.current.objective;
      expect(objective, `${preference.mode} ${JSON.stringify(preference)}`).toBeCloseTo(best, 9);
      expect(result.proof.status).toBe('proven_optimal');
    }
  }, 120_000);

  it('17 outsideRelayCharge: an outside relay slot is charged the race it certainly swims, so the bound is tight when one race a session binds', async () => {
    // Eight own swimmers can each swim the evening 50 free or the evening medley relay, not both at max 1. With few squads in
    // the relaxed model some squads are outside it: if their swimmers were not charged the race, the bound would ignore the limit.
    const ids = Array.from({ length: 8 }, (_, i) => 's' + (i + 1));
    const specs: Spec[] = [
      ...ids.map((id, i) => ({ id, team: 'A', swims: { [BACK50]: 2800 + i, [FREE50]: 2300 + i * 3 }, splits: { [BREAST50]: 3000 + i, [FLY50]: 2600 + i, [FREE50]: 2400 + i } })),
      { id: 'x', team: 'B', swims: { [FREE50]: 2500 } },
    ];
    const fx: Fx = { model: buildModel(specs, [FREE50, MEDLEY]), lineup: lineup(ind('B', 'x', FREE50)), tags: [...tags('A', ids), tag('B', 'x')], rules: rulesOf() };
    const run = async (max: number, squads: number): Promise<{ best: number; upper: number }> => {
      const load = { schedule: schedule(timedFinal(FREE50), timedFinal(MEDLEY)), preference: respect(max) };
      const limits = { ...LIMITS, relaySquadsPerEvent: squads, maxRelaySquadsPerEvent: squads, refineRounds: 0 };
      const result = await autoBuild(request(fx, load, { limits }), nodeMipSolve());
      return { best: result.proof.bestFound as number, upper: result.proof.upperBound as number };
    };
    for (const squads of [1, 2]) {
      const tight = await run(1, squads);
      const loose = await run(2, squads);
      expect(tight.upper, `T ${squads}`).toBeCloseTo(tight.best, 9);
      expect(tight.upper, `T ${squads}`).toBeLessThan(loose.upper);
    }
  }, 120_000);

});
