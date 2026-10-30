/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A2: relays (plans/2026-10-25/D5-AUTOBUILDER.md, 3.2, 3.3, 4.3 and 12.2). Every fixture is synthetic and
 * every rule is the shipped `nsisc` v4 or v5 with the settings a test names changed. No time, point value or standard here is a
 * competition value. The oracle is `scoreMeet`: the brute force builds every own relay and individual entry set of a small
 * fixture by its own code, scores each through a whole-meet `scoreMeet` call, and the AutoBuilder must equal the best one.
 */
import { describe, expect, it } from 'vitest';
import { AutoBuildError, autoBuild, builtinRulePreset, entryKey, requireComplete, scoreMeet } from '@omniswim/engine';
import type {
  AutoBuildLimits,
  AutoBuildRequest,
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  MeetEvent,
  MeetModel,
  RelaySplit,
  RulePreset,
  ScorerTag,
} from '@omniswim/engine';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const BACK = '100 Backstroke';
const BREAST = '100 Breaststroke';
const FLY = '100 Butterfly';
const FREE_RELAY = '400 Freestyle Relay';
const MEDLEY_RELAY = '400 Medley Relay';
const GENDER = 'Men' as const;

const LIMITS: AutoBuildLimits = { candidatesPerEvent: 8, maxCandidatesPerEvent: 8, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 };

// ---- builders ----------------------------------------------------------------------------------

const meetEvent = (eventKey: string): MeetEvent =>
  eventKey === FREE_RELAY || eventKey === MEDLEY_RELAY
    ? { eventKey, gender: GENDER, kind: 'relay', distanceYards: 400, relayKind: eventKey === FREE_RELAY ? 'freestyle' : 'medley' }
    : { eventKey, gender: GENDER, kind: 'individual', distanceYards: 100, relayKind: null };

interface Spec {
  readonly id: string;
  readonly team: string;
  /** Flat-start swims: hundredths per event key. */
  readonly swims?: Readonly<Record<string, number>>;
  /** Relay splits (a flying start): hundredths per leg event key. */
  readonly splits?: Readonly<Record<string, number>>;
  readonly roster?: 'member' | 'not_member' | 'unknown';
}

function buildModel(specs: readonly Spec[], eventKeys: readonly string[]): MeetModel {
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
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: GENDER, classYear: null, roster: s.roster ?? 'member' })),
    events: eventKeys.map(meetEvent),
    swims,
    relaySplits: splits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

const LEG_EVENTS: Readonly<Record<string, readonly string[]>> = {
  [FREE_RELAY]: [FREE, FREE, FREE, FREE],
  [MEDLEY_RELAY]: [BACK, BREAST, FLY, FREE],
};

/** A relay entry by the oracle's own rule: leg 1 is the flat-start swim in the leg event, legs 2 to 4 are the flying splits. */
function relayEntry(team: string, eventKey: string, letter: string, ids: readonly string[]): LineupEntry {
  const events = LEG_EVENTS[eventKey] as readonly string[];
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

const ind = (team: string, swimmerId: string, eventKey: string): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey, gender: GENDER, seedSwimId: null });
const lineup = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });
const tag = (team: string, swimmerId: string, role: ScorerTag['role'] = 'scorer'): ScorerTag => ({ teamId: team, swimmerId, role });
const tags = (team: string, ids: readonly string[]): ScorerTag[] => ids.map((id) => tag(team, id));

interface RuleOpts {
  size?: number;
  maxTotal?: number;
  relayCap?: number;
  version?: 4 | 5;
  ties?: 'split' | 'ordered';
  maxRelay?: number;
}

/** nsisc v4 (or v5) with the settings a test names changed. */
function rulesOf(o: RuleOpts = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', o.version ?? 4) as RulePreset;
  return requireComplete({
    ...base,
    scoring: { ...base.scoring, ...(o.ties ? { ties: set(o.ties) } : {}) },
    scorers: {
      ...base.scorers,
      ...(o.size === undefined ? {} : { scoringTeamSize: set(o.size) }),
      ...(o.relayCap === undefined ? {} : { scoringRelaysPerTeamPerEvent: set(o.relayCap) }),
    },
    entries: {
      ...base.entries,
      ...(o.maxTotal === undefined ? {} : { maxTotalPerSwimmer: set(o.maxTotal) }),
      ...(o.maxRelay === undefined ? {} : { maxRelayPerSwimmer: set(o.maxRelay) }),
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
    genders: [GENDER],
    objective: { kind: 'max-own' },
    load: null,
    limits: LIMITS,
    ...over,
  };
}

const ownPoints = (fx: Fx, l: Lineup, t: readonly ScorerTag[]): number =>
  (scoreMeet(fx.model, l, t, fx.rules, SOURCING).teams.find((x) => x.teamId === 'A') as { points: number }).points;

/** A tiny seeded generator, so a fixture is the same on every run. */
function prng(seed: number): () => number {
  let state = seed * 2654435761 + 12345;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Own swimmers `o1..oN` with a flat 100 free and a flying free split, and opponent team B: one relay and one 100 free each. */
function freeFixture(seed: number, own: number, individual: boolean, over: RuleOpts = {}): Fx {
  const rand = prng(seed);
  const specs: Spec[] = [];
  const ids: string[] = [];
  for (let i = 1; i <= own; i++) {
    const free = 4600 + Math.floor(rand() * 500);
    specs.push({ id: `o${i}`, team: 'A', swims: { [FREE]: free }, splits: { [FREE]: free - 100 - Math.floor(rand() * 40) } });
    ids.push(`o${i}`);
  }
  const bIds = ['b1', 'b2', 'b3', 'b4'];
  bIds.forEach((id, i) => {
    const free = 4800 + i * 60 + Math.floor(rand() * 60);
    specs.push({ id, team: 'B', swims: { [FREE]: free }, splits: { [FREE]: free - 110 } });
  });
  const events = individual ? [FREE, FREE_RELAY] : [FREE_RELAY];
  return {
    model: buildModel(specs, events),
    lineup: lineup(relayEntry('B', FREE_RELAY, 'A', bIds), ...(individual ? bIds.map((id) => ind('B', id, FREE)) : [])),
    tags: tags('B', bIds),
    rules: rulesOf(over),
  };
}

// ---- the oracle -----------------------------------------------------------------------------------

const combos = <T,>(items: readonly T[], k: number): T[][] => {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items as [T, ...T[]];
  return [...combos(rest, k - 1).map((c) => [head, ...c]), ...combos(rest, k)];
};

/** Every relay an own team could enter by the oracle's rule: each 4-set with each leadoff. */
function allRelays(ids: readonly string[]): string[][] {
  return combos(ids, 4).flatMap((set4) => set4.map((lead) => [lead, ...set4.filter((x) => x !== lead)]));
}

/** The maximum own points over every legal own entry set: individual subsets and 0..R disjoint relays. */
function bruteMax(fx: Fx, ownIds: readonly string[], eventKey: string | null, individualKey: string | null, R: number): number {
  const relays = eventKey === null ? [] : allRelays(ownIds);
  const relayChoices: string[][][] = [[]];
  for (const r of relays) relayChoices.push([r]);
  if (R >= 2) {
    for (let i = 0; i < relays.length; i++) {
      for (let j = i + 1; j < relays.length; j++) {
        const a = relays[i] as string[];
        const b = relays[j] as string[];
        if (a.every((x) => !b.includes(x))) relayChoices.push([a, b]);
      }
    }
  }
  const individualChoices = individualKey === null ? [[]] : combos(ownIds, 0).concat(...Array.from({ length: ownIds.length }, (_, k) => combos(ownIds, k + 1)));
  const base = fx.lineup.entries;
  const inBase = new Set(scoreMeet(fx.model, lineup(...base), fx.tags, fx.rules, SOURCING).violations.map((v) => JSON.stringify(v)));
  let best = -Infinity;
  for (const rc of relayChoices) {
    for (const ic of individualChoices) {
      const entries: LineupEntry[] = [...base];
      rc.forEach((squad, i) => entries.push(relayEntry('A', eventKey as string, 'AB'[i] as string, squad)));
      if (individualKey !== null) for (const id of ic) entries.push(ind('A', id, individualKey));
      const used = new Set<string>([...rc.flat(), ...ic]);
      const l = lineup(...entries);
      const t = [...fx.tags, ...tags('A', [...used].sort())];
      const results = scoreMeet(fx.model, l, t, fx.rules, SOURCING);
      const hard = results.violations.some((v) => !inBase.has(JSON.stringify(v)) && ['entry_cap', 'scoring_team_size', 'relay_entries_over_limit', 'relay_swimmer_repeated', 'relay_leg'].includes(v.kind) && !(v.kind === 'relay_leg' && v.reason === 'off_scoring_roster'));
      if (hard) continue;
      best = Math.max(best, (results.teams.find((x) => x.teamId === 'A') as { points: number }).points);
    }
  }
  return best;
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

describe('autoBuild (D5, slice A2: relays)', () => {
  it('1 bruteForceRelay: one relay event, with and without an individual event, equals the whole-meet brute force and is proven', async () => {
    let improved = 0;
    // Six own swimmers, a 100 free and a free relay, one entry per swimmer: a swimmer swims the relay or the individual event.
    for (const seed of [1, 2, 3]) {
      const fx = freeFixture(seed, 6, true, { maxTotal: 1 });
      const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
      const best = bruteMax(fx, ids, FREE_RELAY, FREE, 2);
      const result = await autoBuild(request(fx), nodeMipSolve());
      expect(result.proof.status, `seed ${seed}`).toBe('proven_optimal');
      expect(result.proof.bestFound, `seed ${seed}`).toBeCloseTo(best, 9);
      if (result.kind === 'improved') {
        improved += 1;
        expect(ownPoints(fx, result.proposal.lineup, result.proposal.tagsForScoring), `seed ${seed}`).toBeCloseTo(best, 9);
      } else {
        expect(result.current.objective, `seed ${seed}`).toBeCloseTo(best, 9);
      }
    }
    // Eight own swimmers and the relay event only: two disjoint relays are possible.
    for (const seed of [4, 5, 6, 7]) {
      const fx = freeFixture(seed, 8, false);
      const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'];
      const best = bruteMax(fx, ids, FREE_RELAY, null, 2);
      const result = await autoBuild(request(fx), nodeMipSolve());
      // 70 squads against T up to 48: some squads stay outside Q_e, so the bound may keep a gap. The best found is still exact.
      expect(result.proof.bestFound, `seed ${seed}`).toBeCloseTo(best, 9);
      expect(result.proof.upperBound as number, `seed ${seed}`).toBeGreaterThanOrEqual(best - 1e-9);
      if (result.kind === 'improved') {
        improved += 1;
        expect(ownPoints(fx, result.proposal.lineup, result.proposal.tagsForScoring), `seed ${seed}`).toBeCloseTo(best, 9);
        expect(result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A').length, `seed ${seed}`).toBe(2);
      }
    }
    expect(improved, 'some fixtures must change the lineup').toBeGreaterThan(3);
  }, 180_000);

  it('2 relayTrap: with one spot left, the swimmer who completes a relay worth more than the other swimmer scores alone is chosen', async () => {
    // Size 4, one entry each. p1, p2 and p3 are pinned and can only swim the relay. X scores 20 in the 100 back alone and has no
    // flat 100 free, so he cannot swim the relay. Y completes a relay with p1, p2 and p3: 40.
    const specs: Spec[] = [
      ...['p1', 'p2', 'p3', 'y'].map((id, i) => ({ id, team: 'A', swims: { [FREE]: 5200 + i * 10 }, splits: { [FREE]: 5000 + i * 10 } })),
      { id: 'x', team: 'A', swims: { [BACK]: 4000 } },
      ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: 5600 + i * 10, [BACK]: 5600 + i * 10 }, splits: { [FREE]: 5400 + i * 10 } })),
    ];
    const fx: Fx = {
      model: buildModel(specs, [BACK, FREE_RELAY]),
      lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), ...['b1', 'b2', 'b3', 'b4'].map((id) => ind('B', id, BACK))),
      tags: [...tags('A', ['p1', 'p2', 'p3']), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
      rules: rulesOf({ size: 4, maxTotal: 1 }),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    expect(result.proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['y']);
    const own = result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A');
    expect(own).toHaveLength(1);
    expect((own[0] as Extract<LineupEntry, { kind: 'relay' }>).legs.map((l) => l.swimmerId).sort()).toEqual(['p1', 'p2', 'p3', 'y']);
    // The relay (40) beats x alone (20): the lineup scores 40, and the greedy choice of x would give 20.
    expect(result.proposal.evaluation.ownPoints).toBe(40);
    expect(result.proof.status).toBe('proven_optimal');
    expect(result.proposal.lineup.entries.some((e) => e.kind === 'individual' && e.teamId === 'A' && e.swimmerId === 'x')).toBe(false);
  }, 60_000);

  it('3 builtRelaysResolve: every relay the build adds has no relay_leg violation: medley order, leg 1 flat, legs 2 to 4 split, distinct legs', async () => {
    const rand = prng(11);
    const specs: Spec[] = [];
    for (let i = 1; i <= 9; i++) {
      const back = 5000 + Math.floor(rand() * 400);
      const free = 4500 + Math.floor(rand() * 400);
      specs.push({ id: `o${i}`, team: 'A', swims: { [BACK]: back, [FREE]: free }, splits: { [BACK]: back - 90, [BREAST]: 5300 + Math.floor(rand() * 400), [FLY]: 4800 + Math.floor(rand() * 400), [FREE]: free - 100 } });
    }
    const bIds = ['b1', 'b2', 'b3', 'b4'];
    bIds.forEach((id, i) => specs.push({ id, team: 'B', swims: { [BACK]: 5600 + i * 20, [FREE]: 5000 + i * 20 }, splits: { [BACK]: 5500, [BREAST]: 6000, [FLY]: 5400, [FREE]: 4900 + i * 20 } }));
    const model = buildModel(specs, [MEDLEY_RELAY, FREE_RELAY]);
    const fx: Fx = {
      model,
      lineup: lineup(relayEntry('B', MEDLEY_RELAY, 'A', bIds), relayEntry('B', FREE_RELAY, 'A', bIds)),
      tags: tags('B', bIds),
      rules: rulesOf({ version: 5 }),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const added = result.proposal.lineup.entries.filter((e): e is Extract<LineupEntry, { kind: 'relay' }> => e.kind === 'relay' && e.teamId === 'A');
    expect(added.length).toBeGreaterThanOrEqual(2);
    const swims = new Map(model.swims.map((s) => [s.swimId, s]));
    const splits = new Map(model.relaySplits.map((s) => [s.splitId, s]));
    for (const entry of added) {
      const events = LEG_EVENTS[entry.eventKey] as readonly string[];
      expect(new Set(entry.legs.map((l) => l.swimmerId)).size).toBe(4);
      entry.legs.forEach((leg, i) => {
        const basis = leg.basis;
        if (i === 0) {
          expect(basis.kind === 'flat-start-swim' || basis.kind === 'split', entryKey(entry)).toBe(true);
          if (basis.kind === 'flat-start-swim') expect((swims.get(basis.swimId) as { eventKey: string }).eventKey).toBe(events[0]);
          if (basis.kind === 'split') expect(splits.get(basis.splitId)).toMatchObject({ legEventKey: events[0], start: 'flat', course: 'SCY' });
        } else {
          expect(basis.kind, entryKey(entry)).toBe('split');
          const split = splits.get((basis as { splitId: string }).splitId) as RelaySplit;
          expect(split.legEventKey).toBe(events[i]);
          expect(['flying', 'unknown']).toContain(split.start);
        }
      });
    }
    expect(result.proposal.evaluation.results.violations.filter((v) => v.kind === 'relay_leg' || v.kind === 'relay_entries_over_limit' || v.kind === 'relay_swimmer_repeated')).toEqual([]);
  }, 120_000);

  it('4 nsisc5TwoRelays: under nsisc v5 no own event holds more than 2 relays, and there is no relay_entries_over_limit', async () => {
    // Sixteen own swimmers are all faster than the opponent: a third relay would be worth points if it were allowed.
    const fx = freeFixture(21, 16, false, { version: 5 });
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const own = result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A');
    expect(own).toHaveLength(2);
    const violations = result.proposal.evaluation.results.violations;
    expect(violations.filter((v) => v.kind === 'relay_entries_over_limit')).toEqual([]);
    expect(result.proof.searchSpace.restrictions).toContain('relays_within_scoring_cap');
    expect(result.proof.searchSpace.restrictions).toContain('disjoint_relays');
    expect(result.proof.searchSpace.restrictions).not.toContain('fixed_relay_events');
  }, 120_000);

  it('5 disjointComplement: when every top-T squad shares one swimmer, a B relay without him is still built', async () => {
    // s is far faster than the rest, so the top 3 squads are s with three of the other seven. The best squad without s is not in
    // the top 3. The complement of each top squad puts one such squad in Q_e.
    const specs: Spec[] = [{ id: 's', team: 'A', swims: { [FREE]: 4300 }, splits: { [FREE]: 4100 } }];
    for (let i = 1; i <= 7; i++) specs.push({ id: `o${i}`, team: 'A', swims: { [FREE]: 4900 + i * 10 }, splits: { [FREE]: 4700 + i * 10 } });
    ['b1', 'b2', 'b3', 'b4'].forEach((id, i) => specs.push({ id, team: 'B', swims: { [FREE]: 6000 + i }, splits: { [FREE]: 5900 + i } }));
    const fx: Fx = {
      model: buildModel(specs, [FREE_RELAY]),
      lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4'])),
      tags: tags('B', ['b1', 'b2', 'b3', 'b4']),
      rules: rulesOf({ version: 5 }),
    };
    const limits = { ...LIMITS, relaySquadsPerEvent: 3, maxRelaySquadsPerEvent: 3, refineRounds: 0 };
    const result = await autoBuild(request(fx, { limits }), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const own = result.proposal.lineup.entries.filter((e): e is Extract<LineupEntry, { kind: 'relay' }> => e.kind === 'relay' && e.teamId === 'A');
    expect(own).toHaveLength(2);
    const [a, b] = own as [(typeof own)[number], (typeof own)[number]];
    const names = (e: typeof a): string[] => e.legs.map((l) => l.swimmerId);
    expect(names(a).filter((id) => names(b).includes(id))).toEqual([]);
    expect(own.filter((e) => names(e).includes('s'))).toHaveLength(1);
    expect(result.proposal.evaluation.ownPoints).toBe(40 + 34);
  }, 60_000);

  it('6 smallTBound: with a small T and no refinement, bestFound <= the brute-force maximum <= upperBound', async () => {
    let gaps = 0;
    for (const seed of [31, 32, 33, 34]) {
      const fx = freeFixture(seed, 8, false);
      const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'];
      const best = bruteMax(fx, ids, FREE_RELAY, null, 2);
      const result = await autoBuild(request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 2, refineRounds: 0 } }), nodeMipSolve());
      expect(result.proof.upperBound, `seed ${seed}`).not.toBeNull();
      expect(result.proof.bestFound, `seed ${seed}`).toBeLessThanOrEqual(best + 1e-9);
      expect(best, `seed ${seed}`).toBeLessThanOrEqual((result.proof.upperBound as number) + 1e-9);
      if (result.proof.status === 'gap') gaps += 1;
    }
    expect(gaps, 'T = 2 must leave a gap somewhere, or the fixtures prove nothing about the relay bound').toBeGreaterThan(0);
  }, 180_000);

  it('refinement doubles T: one round with a small T closes the gap that the small T left', async () => {
    const fx = freeFixture(33, 8, false);
    const tight = await autoBuild(request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 2, refineRounds: 0 } }), nodeMipSolve());
    const grown = await autoBuild(request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 48, refineRounds: 3 } }), nodeMipSolve());
    expect(grown.proof.bestFound).toBeGreaterThanOrEqual(tight.proof.bestFound);
    expect(grown.proof.gap).toBeLessThanOrEqual(tight.proof.gap as number);
    const event = grown.proof.searchSpace.events.find((e) => e.eventKey === FREE_RELAY) as { candidates: number };
    const first = tight.proof.searchSpace.events.find((e) => e.eventKey === FREE_RELAY) as { candidates: number };
    expect(event.candidates).toBeGreaterThan(first.candidates);
  }, 120_000);

  it('a current relay that is already best stays: same entry, same letter, and no change is counted', async () => {
    const fx = freeFixture(41, 4, false);
    const first = await autoBuild(request(fx), nodeMipSolve());
    expect(first.kind).toBe('improved');
    if (first.kind !== 'improved') return;
    const next: Fx = { ...fx, lineup: first.proposal.lineup, tags: first.proposal.tagsForScoring };
    const again = await autoBuild(request(next), nodeMipSolve());
    expect(again).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    // The accepted relay is solver-owned: swapping it out for the same squad changes nothing.
    expect(again.current.objective).toBeCloseTo(first.proposal.evaluation.objective, 9);
  }, 60_000);

  it('a new relay takes the lowest letter that no surviving own relay uses', async () => {
    // The current own relay is letter B. The build keeps it and adds one more: that one is A.
    const fx0 = freeFixture(51, 8, false);
    const keep = relayEntry('A', FREE_RELAY, 'B', ['o1', 'o2', 'o3', 'o4']);
    const fx: Fx = { ...fx0, lineup: lineup(...fx0.lineup.entries, keep), tags: [...fx0.tags, ...tags('A', ['o1', 'o2', 'o3', 'o4'])] };
    const result = await autoBuild(request(fx), nodeMipSolve());
    const entries = (result.kind === 'improved' ? result.proposal.lineup.entries : fx.lineup.entries).filter((e) => e.kind === 'relay' && e.teamId === 'A');
    const letters = entries.map((e) => (e as Extract<LineupEntry, { kind: 'relay' }>).letter);
    expect(new Set(letters).size).toBe(letters.length);
    for (const l of letters) expect(['A', 'B']).toContain(l);
  }, 60_000);

  it('orderIndependence: permuting swimmers, swims and splits gives byte-identical LP text', async () => {
    const fx = freeFixture(61, 8, true, { maxTotal: 1 });
    const solverA = nodeMipSolve();
    await autoBuild(request(fx), solverA);
    const reversed: Fx = {
      ...fx,
      model: { ...fx.model, swimmers: [...fx.model.swimmers].reverse(), swims: [...fx.model.swims].reverse(), relaySplits: [...fx.model.relaySplits].reverse() },
      tags: [...fx.tags].reverse(),
    };
    const solverB = nodeMipSolve();
    await autoBuild(request(reversed), solverB);
    expect(solverA.texts.length).toBeGreaterThan(1);
    expect(solverB.texts).toEqual(solverA.texts);
  }, 60_000);

  it('a relay with a leg tagged off the scoring roster stays as entered, and its event is listed as fixed', async () => {
    const fx0 = freeFixture(71, 6, false);
    const own = relayEntry('A', FREE_RELAY, 'A', ['o1', 'o2', 'o3', 'o4']);
    const fx: Fx = { ...fx0, lineup: lineup(...fx0.lineup.entries, own), tags: [...fx0.tags, tag('A', 'o1'), tag('A', 'o2'), tag('A', 'o3'), tag('A', 'o4', 'non-scorer')] };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.proof.searchSpace.restrictions).toContain('fixed_relay_events');
    const kept = (result.kind === 'improved' ? result.proposal.lineup.entries : fx.lineup.entries).filter((e) => e.kind === 'relay' && e.teamId === 'A');
    expect(kept).toEqual([own]);
    expect(result.proof.searchSpace.events.some((e) => e.eventKey === FREE_RELAY)).toBe(false);
  }, 60_000);

it('a current relay that stays keeps its letter, and the tie-break keeps the current squad among equal ones', async () => {
    // Eight own swimmers with one time each: every 4-set ties. The current relay is the last 4-set with letter C. An own 100 free
    // is open to every swimmer, so the build improves the lineup, and the relay must stay exactly as entered.
    const specs: Spec[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i + 1}`, team: 'A', swims: { [FREE]: 4700 + i * 15 }, splits: { [FREE]: 4600 } })),
      ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: 5600 + i * 60 }, splits: { [FREE]: 5500 } })),
    ];
    const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'];
    const current = relayEntry('A', FREE_RELAY, 'C', ['o5', 'o6', 'o7', 'o8']);
    const fx: Fx = {
      model: buildModel(specs, [FREE, FREE_RELAY]),
      lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), ...['b1', 'b2', 'b3', 'b4'].map((id) => ind('B', id, FREE)), current),
      tags: [...tags('A', ids), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
      rules: rulesOf({ relayCap: 1 }),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const own = result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A');
    expect(own).toEqual([current]);
    expect(result.proposal.entryChanges.filter((c) => c.entryKey === entryKey(current))).toEqual([]);
  }, 60_000);

  it('the best leadoff of a freestyle set is the one kept: the squad time decides the place against a close relay', async () => {
    // o2 has the smallest flat-minus-split gap, so he leads: 5000 + 3 * 4900 = 19700. Any other leadoff gives 19750. The opponent
    // swims 19725: only the best leadoff wins the relay.
    const specs: Spec[] = [
      { id: 'o1', team: 'A', swims: { [FREE]: 5000 }, splits: { [FREE]: 4900 } },
      { id: 'o2', team: 'A', swims: { [FREE]: 5000 }, splits: { [FREE]: 4950 } },
      { id: 'o3', team: 'A', swims: { [FREE]: 5000 }, splits: { [FREE]: 4900 } },
      { id: 'o4', team: 'A', swims: { [FREE]: 5000 }, splits: { [FREE]: 4900 } },
      ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: i === 0 ? 5025 : 5100 }, splits: { [FREE]: 4900 } })),
    ];
    const fx: Fx = {
      model: buildModel(specs, [FREE_RELAY]),
      lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4'])),
      tags: tags('B', ['b1', 'b2', 'b3', 'b4']),
      rules: rulesOf({ size: 4 }),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    const own = result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A') as Extract<LineupEntry, { kind: 'relay' }>[];
    expect(own).toHaveLength(1);
    expect(own[0]?.legs.map((l) => l.swimmerId)).toEqual(['o2', 'o1', 'o3', 'o4']);
    const best = ownPoints(fx, lineup(fx.lineup.entries[0] as LineupEntry, relayEntry('A', FREE_RELAY, 'A', ['o2', 'o1', 'o3', 'o4'])), [...tags('A', ['o1', 'o2', 'o3', 'o4']), ...fx.tags]);
    expect(result.proposal.evaluation.ownPoints).toBeCloseTo(best, 9);
    expect(result.proof.status).toBe('proven_optimal');
  }, 60_000);

  it('a standing relay with the time of an outside squad is ahead of it under ordered ties and not under split ties', async () => {
    // Eight own swimmers share one time, and the opponent relay swims that time too. With a small T the outside slot is active. Under
    // "ordered" a new entry loses the tie, so the outside squad's best place is behind the opponent: the bound is smaller.
    const specs: Spec[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i + 1}`, team: 'A', swims: { [FREE]: 5000 }, splits: { [FREE]: 4900 } })),
      ...['b1', 'b2', 'b3', 'b4'].map((id) => ({ id, team: 'B', swims: { [FREE]: 5000 }, splits: { [FREE]: 4900 } })),
    ];
    const upper = async (ties: 'split' | 'ordered'): Promise<number> => {
      const fx: Fx = {
        model: buildModel(specs, [FREE_RELAY]),
        lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4'])),
        tags: tags('B', ['b1', 'b2', 'b3', 'b4']),
        rules: rulesOf({ ties }),
      };
      const result = await autoBuild(request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 2, refineRounds: 0 } }), nodeMipSolve());
      return result.proof.upperBound as number;
    };
    expect(await upper('ordered')).toBeLessThan(await upper('split'));
  }, 120_000);

  it('a standing relay faster than every outside squad lowers the bound, and a slower one does not', async () => {
    const upper = async (b: { flat: number; split: number }): Promise<number> => {
      const specs: Spec[] = [
        ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i + 1}`, team: 'A', swims: { [FREE]: 5000 }, splits: { [FREE]: 4900 } })),
        ...['b1', 'b2', 'b3', 'b4'].map((id) => ({ id, team: 'B', swims: { [FREE]: b.flat }, splits: { [FREE]: b.split } })),
      ];
      const fx: Fx = {
        model: buildModel(specs, [FREE_RELAY]),
        lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4'])),
        tags: tags('B', ['b1', 'b2', 'b3', 'b4']),
        rules: rulesOf(),
      };
      const result = await autoBuild(request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 2, maxRelaySquadsPerEvent: 2, refineRounds: 0 } }), nodeMipSolve());
      return result.proof.upperBound as number;
    };
    // Faster than any own squad: an outside squad can place 2nd at best. Slower than every own squad: it can place 1st.
    expect(await upper({ flat: 4900, split: 4800 })).toBeLessThan(await upper({ flat: 5100, split: 5000 }));
  }, 120_000);

  it('a built relay counts once against a swimmer: under a total of one entry a built relay stays as it is', async () => {
    const fx = freeFixture(41, 4, false, { maxTotal: 1 });
    const first = await autoBuild(request(fx), nodeMipSolve());
    expect(first.kind).toBe('improved');
    if (first.kind !== 'improved') return;
    const next: Fx = { ...fx, lineup: first.proposal.lineup, tags: first.proposal.tagsForScoring };
    const again = await autoBuild(request(next), nodeMipSolve());
    expect(again).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(again.current.ownPoints).toBeCloseTo(first.proposal.evaluation.ownPoints, 9);
  }, 60_000);

  it('cappedLegsDoNotCrowdQ: a swimmer whose relay cap a fixed relay used up does not fill Q_e, so the default T still finds the relay without him', async () => {
    // The cap that the fixed relay uses up is the relay cap in one pass and the total cap in the other.
    for (const caps of [{ maxRelay: 1 }, { maxTotal: 1 }]) {
      // o1, o2 and o3 swim the fixed medley relay (o4 is tagged off the roster, so the event is fixed). The cap is one relay each.
      // o1, o2 and o3 are the fastest free relay swimmers, but the free relay must use o5 to o8.
      const swimmers = (id: string, free: number): Spec => ({
        id,
        team: 'A',
        swims: { [FREE]: free, [BACK]: 5500 },
        splits: { [FREE]: free - 100, [BREAST]: 6000, [FLY]: 5500 },
      });
      const specs: Spec[] = [
        ...['o1', 'o2', 'o3', 'o4'].map((id, i) => swimmers(id, 4600 + i * 10)),
        ...['o5', 'o6', 'o7', 'o8'].map((id, i) => swimmers(id, 5000 + i * 10)),
        ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: 5400 + i * 10 }, splits: { [FREE]: 5300 + i * 10 } })),
      ];
      const fixed = relayEntry('A', MEDLEY_RELAY, 'A', ['o1', 'o2', 'o3', 'o4']);
      const fx: Fx = {
        model: buildModel(specs, [FREE_RELAY, MEDLEY_RELAY]),
        lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), fixed),
        tags: [...tags('A', ['o1', 'o2', 'o3']), tag('A', 'o4', 'non-scorer'), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
        rules: rulesOf(caps),
      };
      // The top 12 of the 35 squads hold o1, o2 or o3, whose one relay is used up. Without the drop of those legs, Q_e holds none of o5 to o8.
      const result = await autoBuild(request(fx), nodeMipSolve());
      expect(result.kind, JSON.stringify(caps)).toBe('improved');
      expect(result.proof.searchSpace.restrictions).toContain('fixed_relay_events');
      expect(result.proof.searchSpace.fixedRelayEvents).toEqual([{ eventKey: MEDLEY_RELAY, gender: GENDER }]);
      const lineupOf = result.kind === 'improved' ? result.proposal.lineup : fx.lineup;
      const results = result.kind === 'improved' ? result.proposal.evaluation.results : null;
      const free = lineupOf.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A' && e.eventKey === FREE_RELAY) as Extract<LineupEntry, { kind: 'relay' }>[];
      expect(free).toHaveLength(1);
      expect(free[0]?.legs.map((l) => l.swimmerId).sort()).toEqual(['o5', 'o6', 'o7', 'o8']);
      expect(results?.violations.filter((v) => v.kind === 'relay_entries_over_limit') ?? []).toEqual([]);
    }
  }, 60_000);

  it('the relay cap per event bounds a column even when every squad is a column: two disjoint squads, a cap of one, one relay built', async () => {
    // Medley relay, two own swimmers per stroke and each swims one stroke only: 16 squads, all inside Q_e, so no outside slot exists.
    // Eight swimmers make two disjoint squads. The cap is one own relay per event: the build enters exactly one.
    const own: Spec[] = [
      { id: 'o1', team: 'A', swims: { [BACK]: 5000 } },
      { id: 'o2', team: 'A', swims: { [BACK]: 5010 } },
      { id: 'o3', team: 'A', splits: { [BREAST]: 5500 } },
      { id: 'o4', team: 'A', splits: { [BREAST]: 5510 } },
      { id: 'o5', team: 'A', splits: { [FLY]: 4800 } },
      { id: 'o6', team: 'A', splits: { [FLY]: 4810 } },
      { id: 'o7', team: 'A', splits: { [FREE]: 4500 } },
      { id: 'o8', team: 'A', splits: { [FREE]: 4510 } },
    ];
    const opp: Spec[] = [
      { id: 'b1', team: 'B', swims: { [BACK]: 5200 } },
      { id: 'b2', team: 'B', splits: { [BREAST]: 5700 } },
      { id: 'b3', team: 'B', splits: { [FLY]: 5000 } },
      { id: 'b4', team: 'B', splits: { [FREE]: 4700 } },
    ];
    const fx: Fx = {
      model: buildModel([...own, ...opp], [MEDLEY_RELAY]),
      lineup: lineup(relayEntry('B', MEDLEY_RELAY, 'A', ['b1', 'b2', 'b3', 'b4'])),
      tags: tags('B', ['b1', 'b2', 'b3', 'b4']),
      rules: rulesOf({ relayCap: 1 }),
    };
    const result = await autoBuild(request(fx, { limits: { ...LIMITS, relaySquadsPerEvent: 24, maxRelaySquadsPerEvent: 24 } }), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    expect(result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A')).toHaveLength(1);
    expect(result.proposal.evaluation.results.violations.filter((v) => v.kind === 'relay_entries_over_limit')).toEqual([]);
    expect(result.proof.searchSpace.events.find((e) => e.eventKey === MEDLEY_RELAY)).toMatchObject({ outside: 0, candidates: 16, columns: 17 });
  }, 60_000);

  it('fixedRelayEvent: an event with a relay that holds an off-roster leg stays as entered, and an event of decision legs is built', async () => {
    const swimmers = (id: string, free: number): Spec => ({
      id,
      team: 'A',
      swims: { [FREE]: free, [BACK]: 5300 },
      splits: { [FREE]: free - 100, [BREAST]: 5800, [FLY]: 5300 },
    });
    const specs: Spec[] = [
      ...['o1', 'o2', 'o3', 'o4'].map((id, i) => swimmers(id, 5000 + i * 10)),
      ...['o5', 'o6', 'o7', 'o8'].map((id, i) => swimmers(id, 4700 + i * 10)),
      ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: 5600 + i, [BACK]: 6000 }, splits: { [FREE]: 5500 + i, [BREAST]: 6500, [FLY]: 6000 } })),
    ];
    // The free relay holds o4, who is off the scoring roster: the event is fixed. The medley relay has only decision legs.
    const fixed = relayEntry('A', FREE_RELAY, 'A', ['o1', 'o2', 'o3', 'o4']);
    const fx: Fx = {
      model: buildModel(specs, [FREE_RELAY, MEDLEY_RELAY]),
      lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), relayEntry('B', MEDLEY_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), fixed),
      tags: [...tags('A', ['o1', 'o2', 'o3', 'o5', 'o6', 'o7', 'o8']), tag('A', 'o4', 'non-scorer'), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
      rules: rulesOf({ relayCap: 2 }),
    };
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.proof.searchSpace.fixedRelayEvents).toEqual([{ eventKey: FREE_RELAY, gender: GENDER }]);
    expect(result.proof.searchSpace.events.map((e) => e.eventKey)).toEqual([MEDLEY_RELAY]);
    const entries = result.kind === 'improved' ? result.proposal.lineup.entries : fx.lineup.entries;
    const own = (key: string) => entries.filter((e) => e.kind === 'relay' && e.teamId === 'A' && e.eventKey === key);
    expect(own(FREE_RELAY)).toEqual([fixed]);
    expect(result.kind).toBe('improved');
    expect(own(MEDLEY_RELAY).length).toBeGreaterThan(0);
  }, 60_000);

  /** Own scorers and three current own relays in one event, faster than the opponent: 12 swimmers in three disjoint relays, or 11 where o4 swims two of them. */
  const threeRelays = (rules: CompleteRulePreset, shared: boolean): Fx => {
    const specs: Spec[] = [
      ...Array.from({ length: shared ? 11 : 12 }, (_, i) => ({ id: `o${i + 1}`, team: 'A', swims: { [FREE]: 4700 + i * 10 }, splits: { [FREE]: 4600 + i * 10 } })),
      ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: 6000 + i }, splits: { [FREE]: 5900 + i } })),
    ];
    const ids = specs.filter((x) => x.team === 'A').map((x) => x.id);
    const groups = shared ? [['o1', 'o2', 'o3', 'o4'], ['o5', 'o6', 'o7', 'o4'], ['o8', 'o9', 'o10', 'o11']] : [ids.slice(0, 4), ids.slice(4, 8), ids.slice(8, 12)];
    return {
      model: buildModel(specs, [FREE_RELAY]),
      lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), ...groups.map((g, i) => relayEntry('A', FREE_RELAY, 'ABC'[i] as string, g))),
      tags: [...tags('A', ids), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
      rules,
    };
  };

  it('overLimitCurrentV5: under nsisc v5 three current relays in one event are never kept: the result holds at most two there', async () => {
    const fx = threeRelays(rulesOf({ version: 5 }), false);
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(['current_infeasible', 'improved']).toContain(result.kind);
    const lineupOf = result.kind === 'improved' ? result.proposal.lineup : result.kind === 'current_infeasible' ? result.alternative?.lineup : null;
    expect(lineupOf).toBeTruthy();
    expect(lineupOf?.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A').length).toBeLessThanOrEqual(2);
  }, 60_000);

  it('overLimitCurrentAllowed: with the rule absent the three current relays, two of which share a swimmer, stay and the result is unchanged', async () => {
    // With 11 swimmers and a cap of 3, the shared-swimmer column is the only way to score three relays: it must be selectable.
    for (const [shared, relayCap] of [[false, 2], [true, 2], [true, 3]] as const) {
      const fx = threeRelays(rulesOf({ relayCap }), shared);
      const result = await autoBuild(request(fx), nodeMipSolve());
      expect(result.kind, `shared ${shared}, cap ${relayCap}`).toBe('unchanged');
    }
  }, 120_000);

  it('badBasisSurvives: a current relay with a flat start on leg 3 stays as entered, and no new relay raises a relay_leg violation', async () => {
    const fx0 = freeFixture(91, 4, true);
    const own = relayEntry('A', FREE_RELAY, 'A', ['o1', 'o2', 'o3', 'o4']) as Extract<LineupEntry, { kind: 'relay' }>;
    const bad: LineupEntry = { ...own, legs: own.legs.map((l, i) => (i === 2 ? { swimmerId: l.swimmerId, basis: { kind: 'flat-start-swim' as const, swimId: `${l.swimmerId}:${FREE}` } } : l)) as unknown as typeof own.legs };
    const fx: Fx = { ...fx0, lineup: lineup(...fx0.lineup.entries, bad), tags: [...fx0.tags, ...tags('A', ['o1', 'o2', 'o3', 'o4'])] };
    const before = scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING).violations.filter((v) => v.kind === 'relay_leg');
    expect(before.length, 'the fixture must carry the bad leg').toBeGreaterThan(0);
    const result = await autoBuild(request(fx), nodeMipSolve());
    expect(result.kind).toBe('improved');
    if (result.kind !== 'improved') return;
    expect(result.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A')).toEqual([bad]);
    const after = result.proposal.evaluation.results.violations.filter((v) => v.kind === 'relay_leg');
    expect(after).toEqual(before);
  }, 60_000);

  it('sharedSwimmerCaps: two current relays share a swimmer whose relay or total cap is 1: the cap rows count his two entries, so the result is a legal lineup', async () => {
    // o4 swims both current relays. The column is legal in size (R = 2), but o4 has two relay entries and the cap is one.
    for (const caps of [{ maxRelay: 1 }, { maxTotal: 1 }]) {
      const specs: Spec[] = [
        ...Array.from({ length: 7 }, (_, i) => ({ id: `o${i + 1}`, team: 'A', swims: { [FREE]: 4700 + i * 10 }, splits: { [FREE]: 4600 + i * 10 } })),
        ...['b1', 'b2', 'b3', 'b4'].map((id, i) => ({ id, team: 'B', swims: { [FREE]: 6000 + i }, splits: { [FREE]: 5900 + i } })),
      ];
      const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'];
      const fx: Fx = {
        model: buildModel(specs, [FREE_RELAY]),
        lineup: lineup(relayEntry('B', FREE_RELAY, 'A', ['b1', 'b2', 'b3', 'b4']), relayEntry('A', FREE_RELAY, 'A', ['o1', 'o2', 'o3', 'o4']), relayEntry('A', FREE_RELAY, 'B', ['o5', 'o6', 'o7', 'o4'])),
        tags: [...tags('A', ids), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
        rules: rulesOf({ relayCap: 2, ...caps }),
      };
      const result = await autoBuild(request(fx), nodeMipSolve());
      const label = JSON.stringify(caps);
      expect(['current_infeasible', 'improved'], label).toContain(result.kind);
      const lineupOf = result.kind === 'improved' ? result.proposal.lineup : result.kind === 'current_infeasible' ? result.alternative?.lineup : null;
      expect(lineupOf, label).toBeTruthy();
      const own = (lineupOf?.entries ?? []).filter((e) => e.kind === 'relay' && e.teamId === 'A') as Extract<LineupEntry, { kind: 'relay' }>[];
      expect(own.filter((e) => e.legs.some((l) => l.swimmerId === 'o4')).length, label).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('refusals stay: an unlimited relay cap is not supported', async () => {
    const fx = freeFixture(81, 6, false);
    const base = builtinRulePreset('nsisc', 4) as RulePreset;
    const rules = requireComplete({ ...base, scorers: { ...base.scorers, scoringRelaysPerTeamPerEvent: set('unlimited' as const) } });
    const error = await autoError(() => autoBuild(request({ ...fx, rules }), nodeMipSolve()));
    expect(error.code).toBe('rule_unsupported');
  });
});
