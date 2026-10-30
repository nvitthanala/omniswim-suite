/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The fast column scorer against the `scoreMeet` reference (plans/2026-10-25/D5-AUTOBUILDER.md, 12.4 test 1). 2,000 or more random
 * columns over the simulator configs A to D and over synthetic fields built here. Every column is scored twice by the same
 * `Evaluator`: once by arithmetic (`selfChecks: 0`, so nothing is compared inside) and once by `scoreMeet`. The rows must match,
 * the per-team points must be equal when scaled to whole numbers, and the race counts must be equal. The synthetic fields carry
 * generated times and are labeled so: they hold no competition value. The RNG is seeded, so the run is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { builtinRulePreset, requireComplete, scoreMeet } from '@omniswim/engine';
import type {
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  MeetEvent,
  MeetModel,
  RelaySplit,
  RulePreset,
  ScorerTag,
  SessionPreset,
} from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { Evaluator, sameRows } from '../packages/engine/src/autobuilder/evaluate';
import { FastScorer, fastSupported } from '../packages/engine/src/autobuilder/fastScore';
import type { ColumnEval, EvalBase } from '../packages/engine/src/autobuilder/evaluate';
import { buildLegSources, generateSquads, legOptions } from '../packages/engine/src/autobuilder/squads';
import type { Squad } from '../packages/engine/src/autobuilder/squads';
import { loadRuleOf } from '../packages/engine/src/autobuilder/support';
import { buildSnapshot } from './helpers/simulatorFixtures';
import type { ConfigName } from './helpers/simulatorFixtures';
import { set, TEST_PROVENANCE } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;

// ---- seeded RNG ---------------------------------------------------------------------------------

/** mulberry32: a small, fixed generator. The same seed gives the same run on every machine. */
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

// ---- rule variants ------------------------------------------------------------------------------

interface Variant {
  readonly name: string;
  readonly ties?: 'split' | 'ordered';
  readonly eventCap?: { cap: number; overCap: 'holds-place' | 'removed-from-consideration' };
  readonly relayCap?: number;
  readonly relayOver?: 'holds-place' | 'exhibition';
  /** A cap of its own for diving (`divingPerEventScorerCap`). */
  readonly divingCap?: { cap: number; overCap: 'holds-place' | 'removed-from-consideration' };
  /** Short TEST tables (not a competition value), so places fall past the end of a table. */
  readonly relayPoints?: { kind: 'table'; points: readonly number[] } | { kind: 'multiple-of-individual'; multiplier: number };
  readonly divingPoints?: { kind: 'table'; points: readonly number[] } | { kind: 'same-as-individual' };
}

const VARIANTS: readonly Variant[] = [
  { name: 'nsisc v5 as shipped' },
  { name: 'split ties' , ties: 'split' },
  { name: 'ordered ties, cap 2 removed', ties: 'ordered', eventCap: { cap: 2, overCap: 'removed-from-consideration' } },
  { name: 'split ties, cap 1 holds place', ties: 'split', eventCap: { cap: 1, overCap: 'holds-place' } },
  { name: 'split ties, one relay, over-cap relay exhibition', ties: 'split', relayCap: 1, relayOver: 'exhibition' },
  { name: 'ordered ties, one relay, over-cap relay holds place, cap 3 removed', ties: 'ordered', relayCap: 1, relayOver: 'holds-place', eventCap: { cap: 3, overCap: 'removed-from-consideration' } },
  { name: 'diving cap 1 holds place, relays 2x the individual table, diving as individual', ties: 'split', divingCap: { cap: 1, overCap: 'holds-place' }, relayPoints: { kind: 'multiple-of-individual', multiplier: 2 }, divingPoints: { kind: 'same-as-individual' } },
  { name: 'diving cap 2 removed, short test tables, ordered ties', ties: 'ordered', divingCap: { cap: 2, overCap: 'removed-from-consideration' }, relayPoints: { kind: 'table', points: [9, 5, 3, 1] }, divingPoints: { kind: 'table', points: [7, 4, 2] }, relayCap: 2, relayOver: 'holds-place' },
];

function rulesFor(v: Variant): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 5) as RulePreset;
  return requireComplete({
    ...base,
    scoring: {
      ...base.scoring,
      ...(v.ties === undefined ? {} : { ties: set(v.ties) }),
      ...(v.relayPoints === undefined ? {} : { relayPoints: set(v.relayPoints) }),
      ...(v.divingPoints === undefined ? {} : { divingPoints: set(v.divingPoints) }),
    },
    scorers: {
      ...base.scorers,
      ...(v.eventCap === undefined ? {} : { perEventScorerCap: set(v.eventCap) }),
      ...(v.divingCap === undefined ? {} : { divingPerEventScorerCap: set({ kind: 'own' as const, ...v.divingCap }) }),
      ...(v.relayCap === undefined ? {} : { scoringRelaysPerTeamPerEvent: set(v.relayCap) }),
      ...(v.relayOver === undefined ? {} : { relayOverCap: set(v.relayOver) }),
    },
  });
}

// ---- a synthetic schedule, so the race counts are compared too ------------------------------------

/** One row per event key of the model: timed finals, prelims and finals, and split finals, by position. All values are test values. */
function syntheticSchedule(model: MeetModel): SessionPreset {
  const keys = [...new Set(model.events.map((e) => e.eventKey))].sort();
  return {
    payloadVersion: 1,
    provenance: TEST_PROVENANCE,
    events: keys.map((eventKey, i) => {
      const kind = i % 3;
      if (kind === 0) return { eventKey, gender: 'both' as const, format: { kind: 'timed-final' as const, session: { day: 1, slot: 'evening' as const } } };
      if (kind === 1) {
        return { eventKey, gender: 'both' as const, format: { kind: 'prelims-finals' as const, prelims: { day: 1, slot: 'morning' as const }, finals: { day: 1, slot: 'evening' as const } } };
      }
      return {
        eventKey,
        gender: 'both' as const,
        format: {
          kind: 'timed-final-split' as const,
          slowHeats: { day: 1, slot: 'morning' as const },
          fastHeat: { day: 1, slot: 'evening' as const },
          fastHeatSize: set(5),
          smallFieldSession: set({ day: 1, slot: 'evening' as const }),
        },
      };
    }),
  };
}

// ---- the fixtures: configs A to D, and generated fields ---------------------------------------------

interface World {
  readonly label: string;
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly own: string;
}

function configWorld(name: ConfigName): World {
  const { snapshot } = buildSnapshot(name);
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: `parity-config-${name}`, snapshotId: 'test' });
  if (adapted.kind !== 'ready') throw new Error(`config ${name} did not adapt: ${adapted.kind}`);
  const { model, lineup } = adapted.adapted;
  const own = String(model.teams.find((t) => String(t.teamId) === '58')?.teamId ?? (model.teams[0] as { teamId: string }).teamId);
  return { label: `config ${name}`, model, lineup, own };
}

const MEDLEY = '200 Medley Relay';
const BACK50 = '50 Backstroke';
const BREAST50 = '50 Breaststroke';
const FLY50 = '50 Butterfly';
const FREE50 = '50 Freestyle';
const DIVE = '1-Meter Diving';
const SWIM_EVENTS = ['100 Freestyle', '100 Backstroke', '200 Individual Medley'];
const LEGS = [BACK50, BREAST50, FLY50, FREE50];

/**
 * Four teams of 14 swimmers. Every time is generated from a handful of values, so ties are common, and each event holds more
 * entries than the 16 places of the point table when the teams enter everyone. All times are labeled synthetic by this file.
 */
/** `teamCount` teams of 14 swimmers, each with `relaysPerTeam` (at most 3) medley relays. 10 teams of 3 relays put entries past a 16-place table. */
function syntheticWorld(seed: number, teamCount = 4, relaysPerTeam = 2): World {
  const rand = rng(seed);
  const teams = Array.from({ length: teamCount }, (_, i) => `T${i}`);
  const swimmers: MeetModel['swimmers'][number][] = [];
  const swims: MeetModel['swims'][number][] = [];
  const splits: RelaySplit[] = [];
  const events: MeetEvent[] = [
    ...SWIM_EVENTS.map((eventKey) => ({ eventKey, gender: 'Men' as const, kind: 'individual' as const, distanceYards: 100, relayKind: null })),
    { eventKey: DIVE, gender: 'Men', kind: 'diving', distanceYards: null, relayKind: null },
    { eventKey: MEDLEY, gender: 'Men', kind: 'relay', distanceYards: 200, relayKind: 'medley' },
  ];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const addSwim = (swimmerId: string, eventKey: string, hundredths: number, suffix = ''): void => {
    swims.push({
      swimId: `${swimmerId}:${eventKey}${suffix}`,
      swimmerId,
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
  for (const team of teams) {
    for (let i = 0; i < 14; i++) {
      const swimmerId = `${team}s${String(i).padStart(2, '0')}`;
      swimmers.push({ swimmerId, teamId: team, gender: 'Men', classYear: null, roster: 'member' });
      for (const eventKey of SWIM_EVENTS) if (rand() < 0.85) addSwim(swimmerId, eventKey, 4500 + pick([0, 10, 20, 30, 40, 50, 60]) + pick([0, 0, 5]));
      if (rand() < 0.3) {
        addSwim(swimmerId, DIVE, 22000 + pick([0, 500, 1000, 1500, 2000]));
        // A second dive score: the entry takes the best one, and for a dive the best is the highest.
        if (rand() < 0.5) addSwim(swimmerId, DIVE, 22000 + pick([0, 500, 1000, 1500, 2000]), ':second');
      }
      for (const leg of LEGS) {
        if (leg === BACK50) addSwim(swimmerId, leg, 2700 + pick([0, 10, 20, 30]));
        else splits.push({ splitId: `${swimmerId}:${leg}`, swimmerId, relayEventKey: null, legPosition: null, start: 'flying', legEventKey: leg, split: { text: '0', hundredths: 2500 + pick([0, 10, 20, 30]) }, course: 'SCY', date: null, origin: ORIGIN });
      }
    }
  }
  const model: MeetModel = {
    payloadVersion: 1,
    meetKey: `synthetic-${seed}`,
    teams: teams.map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
    swimmers,
    events,
    swims,
    relaySplits: splits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
  const entries: LineupEntry[] = [];
  for (const team of teams) {
    const mine = swimmers.filter((s) => s.teamId === team);
    for (const s of mine) {
      for (const eventKey of [...SWIM_EVENTS, DIVE]) {
        if (swims.some((w) => w.swimmerId === s.swimmerId && w.eventKey === eventKey) && rand() < 0.8) {
          entries.push({ kind: 'individual', teamId: team, swimmerId: s.swimmerId, eventKey, gender: 'Men', seedSwimId: null });
        }
      }
    }
    // Two relays for each team, from four distinct swimmers each.
    const shuffled = [...mine].sort(() => rand() - 0.5);
    for (const [letter, group] of (['A', 'B', 'C'] as const).slice(0, relaysPerTeam).map((l, i) => [l, shuffled.slice(i * 4, i * 4 + 4)] as const)) {
      entries.push({
        kind: 'relay',
        teamId: team,
        eventKey: MEDLEY,
        gender: 'Men',
        letter,
        legs: group.map((s, i) => ({
          swimmerId: s.swimmerId,
          // One leg in ten has no time: the relay then has no time.
          basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${s.swimmerId}:${BACK50}` } : rand() < 0.1 ? { kind: 'no-time' as const } : { kind: 'split' as const, splitId: `${s.swimmerId}:${LEGS[i]}` },
        })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
      });
    }
  }
  return { label: `synthetic field ${seed} (generated times)`, model, lineup: { payloadVersion: 1, meetKey: model.meetKey, entries }, own: 'T0' };
}

// ---- the evaluators and the columns ------------------------------------------------------------------

interface Rig {
  readonly world: World;
  readonly variant: Variant;
  readonly fast: Evaluator;
  readonly reference: Evaluator;
  readonly decision: readonly string[];
  readonly squadsOf: (event: MeetEvent) => readonly Squad[];
}

function rigFor(world: World, variant: Variant, seed: number, allScorers = false): Rig {
  const rand = rng(seed);
  const { model, lineup, own } = world;
  const ownSwimmers = model.swimmers.filter((s) => s.teamId === own).map((s) => s.swimmerId).sort();
  // Half the own swimmers are tagged scorers (pinned). The rest are free.
  const pinned = ownSwimmers.filter(() => rand() < 0.5);
  const free = new Set(ownSwimmers.filter((id) => !pinned.includes(id)));
  const entered = new Map<string, Set<string>>();
  for (const e of lineup.entries) {
    if (e.teamId === own) continue;
    const set = entered.get(e.teamId) ?? new Set<string>();
    for (const id of e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId)) set.add(id);
    entered.set(e.teamId, set);
  }
  const tags: ScorerTag[] = pinned.map((swimmerId) => ({ teamId: own, swimmerId, role: 'scorer' as const }));
  for (const [teamId, ids] of entered) {
    [...ids].sort().forEach((swimmerId, i) => {
      // The first swimmer of a team is always a scorer: a team with entries needs a roster. A few others are not.
      const r = rand();
      const role = allScorers || i === 0 || r < 0.84 ? 'scorer' : r < 0.92 ? 'non-scorer' : 'exhibition';
      tags.push({ teamId, swimmerId, role });
    });
  }
  const rules = rulesFor(variant);
  const load = loadRuleOf({ schedule: syntheticSchedule(model), preference: { mode: 'respect', maxRacesPerSession: set(2), diving: set('counts' as const) } });
  const held = new Set<string>();
  for (const e of lineup.entries) if (e.kind === 'individual' && e.teamId === own && rand() < 0.2) held.add(`${e.swimmerId}\u0000${e.eventKey}`);
  const decision = new Set(ownSwimmers);
  const base: EvalBase = { model, lineup, tags, rules, sourcing: SOURCING, own, decision, free, load, held };
  const sources = buildLegSources(model);
  const squadCache = new Map<string, readonly Squad[]>();
  return {
    world,
    variant,
    fast: new Evaluator({ ...base, fast: true, selfChecks: 0 }),
    reference: new Evaluator({ ...base, fast: false }),
    decision: ownSwimmers,
    squadsOf: (event) => {
      const k = `${event.gender}|${event.eventKey}`;
      const known = squadCache.get(k);
      if (known) return known;
      const swimmers = ownSwimmers.filter((id) => model.swimmers.find((s) => s.swimmerId === id)?.gender === event.gender);
      const positions = legOptions(event, swimmers, sources);
      const squads = positions === null ? [] : generateSquads(positions, event.relayKind !== 'medley', 14, []).squads;
      squadCache.set(k, squads);
      return squads;
    },
  };
}

/** The per-team points of a column's rows, scaled to whole numbers (tie shares are thirds, fifths and so on). */
const SCALE = 10_000 * 2520;
function scaledByTeam(rows: ColumnEval['rows']): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.teamId, (out.get(r.teamId) ?? 0) + r.points);
  return new Map([...out].map(([team, points]) => [team, Math.round(points * SCALE)]));
}

interface Coverage {
  columns: number;
  reasons: Set<string>;
  ties: number;
  relayColumns: number;
  withRaces: number;
}

function compare(rig: Rig, event: MeetEvent, members: readonly string[], squads: readonly Squad[] | null, cover: Coverage, tag: string): void {
  const fast = squads === null ? rig.fast.evaluate(event, members) : rig.fast.evaluateRelay(event, squads);
  const ref = squads === null ? rig.reference.evaluate(event, members) : rig.reference.evaluateRelay(event, squads);
  const label = `${tag}: ${rig.world.label}, ${rig.variant.name}, ${event.gender} ${event.eventKey}, members [${members.join(',')}]`;
  expect(sameRows(fast.rows, ref.rows), `${label}: rows differ\nfast ${JSON.stringify(fast.rows)}\nref  ${JSON.stringify(ref.rows)}`).toBe(true);
  expect(scaledByTeam(fast.rows), `${label}: scaled team points`).toEqual(scaledByTeam(ref.rows));
  expect(Math.round(fast.own * SCALE), `${label}: own points`).toBe(Math.round(ref.own * SCALE));
  expect(fast.tieSizes, `${label}: tie sizes`).toEqual(ref.tieSizes);
  expect(fast.races, `${label}: race counts`).toEqual(ref.races);
  cover.columns += 1;
  for (const r of ref.rows) if (r.notScoredReason !== undefined) cover.reasons.add(r.notScoredReason);
  if (ref.tieSizes.length > 0) cover.ties += 1;
  if (squads !== null) cover.relayColumns += 1;
  if (ref.races.size > 0) cover.withRaces += 1;
}

/** `count` random columns of one rig: members of an individual event, or up to two disjoint squads of a relay event. */
function sampleColumns(rig: Rig, count: number, seed: number, cover: Coverage): void {
  const rand = rng(seed);
  const { model, own } = rig.world;
  const events = model.events;
  for (let n = 0; n < count; n++) {
    const event = events[Math.floor(rand() * events.length)] as MeetEvent;
    if (event.kind === 'relay') {
      const pool = rig.squadsOf(event);
      if (pool.length === 0) continue;
      const chosen: Squad[] = [];
      const used = new Set<string>();
      const want = Math.floor(rand() * 3);
      for (let tries = 0; tries < 20 && chosen.length < want; tries++) {
        const squad = pool[Math.floor(rand() * pool.length)] as Squad;
        if (squad.swimmers.some((id) => used.has(id)) || chosen.includes(squad)) continue;
        chosen.push(squad);
        squad.swimmers.forEach((id) => used.add(id));
      }
      compare(rig, event, [], chosen, cover, `column ${n}`);
      continue;
    }
    const candidates = rig.decision.filter((id) => model.swimmers.find((s) => s.swimmerId === id)?.gender === event.gender && own !== '');
    const members = candidates.filter(() => rand() < 0.25).slice(0, 1 + Math.floor(rand() * 6));
    compare(rig, event, members, null, cover, `column ${n}`);
  }
}

describe('autoBuild fast evaluator parity (D5 12.4)', () => {
  it('2000 random columns: configs A to D and synthetic fields give the same rows, scaled points and race counts as scoreMeet', () => {
    const cover: Coverage = { columns: 0, reasons: new Set(), ties: 0, relayColumns: 0, withRaces: 0 };
    const worlds: World[] = [...(['A', 'B', 'C', 'D'] as const).map(configWorld)];
    let seed = 20261029;
    for (const world of worlds) {
      for (const variant of VARIANTS) {
        const rig = rigFor(world, variant, seed++);
        sampleColumns(rig, 60, seed++, cover);
        expect(rig.fast.fallbacks.size, `${world.label}, ${variant.name}: no event may fall back`).toBe(0);
        expect(rig.fast.referenceCalls, `${world.label}, ${variant.name}: the fast evaluator ran no scoreMeet`).toBe(0);
      }
    }
    for (let k = 0; k < 5; k++) {
      // The fifth field has 30 relays, all scorers: some rank past the last relay place, which 'holds-place' treats on its own.
      const world = k < 4 ? syntheticWorld(900 + k) : syntheticWorld(904, 10, 3);
      for (const variant of VARIANTS) {
        const rig = rigFor(world, variant, seed++, world.model.teams.length > 4);
        sampleColumns(rig, 25, seed++, cover);
        expect(rig.fast.fallbacks.size, `${world.label}, ${variant.name}: no event may fall back`).toBe(0);
        expect(rig.fast.referenceCalls, `${world.label}, ${variant.name}: the fast evaluator ran no scoreMeet`).toBe(0);
      }
    }
    expect(cover.columns).toBeGreaterThanOrEqual(2000);
    // The columns reach every way a row can fail to score, ties, relays, and races.
    for (const reason of ['non_scorer', 'exhibition', 'removed_over_event_cap', 'event_scorer_cap', 'relay_scorer_cap', 'outside_point_table', 'no_time']) {
      expect([...cover.reasons], `a column reaches "${reason}"`).toContain(reason);
    }
    expect(cover.ties).toBeGreaterThan(50);
    expect(cover.relayColumns).toBeGreaterThan(100);
    expect(cover.withRaces).toBeGreaterThan(500);
  }, 600_000);

  it('the self-check falls an event back when the two scorers disagree', () => {
    const world = syntheticWorld(777);
    const rig = rigFor(world, VARIANTS[0] as Variant, 5);
    // A fast scorer that is wrong for one event: the first two columns run both, the difference is seen, the reference rows are used.
    const base: EvalBase = {
      model: world.model,
      lineup: world.lineup,
      tags: world.model.swimmers.filter((s) => s.teamId !== world.own).map((s) => ({ teamId: s.teamId, swimmerId: s.swimmerId, role: 'scorer' as const })),
      rules: rulesFor(VARIANTS[0] as Variant),
      sourcing: SOURCING,
      own: world.own,
      decision: new Set(rig.decision),
      free: new Set(rig.decision),
      load: null,
      held: new Set(),
    };
    const checked = new Evaluator({ ...base, selfChecks: 2 });
    const event = world.model.events[0] as MeetEvent;
    (checked as unknown as { fastScorer: { score: (...a: unknown[]) => unknown } }).fastScorer.score = () => [];
    const reference = new Evaluator({ ...base, fast: false });
    const rows = checked.evaluate(event, ['T0s00']).rows;
    expect(rows).toEqual(reference.evaluate(event, ['T0s00']).rows);
    expect(checked.fallbacks.size).toBe(1);
  });

  /** A plain evaluator base over a synthetic field: every opponent a scorer, every own swimmer free. */
  function plainBase(world: World, rules: CompleteRulePreset): EvalBase {
    const own = world.model.swimmers.filter((x) => x.teamId === world.own).map((x) => x.swimmerId);
    return {
      model: world.model,
      lineup: world.lineup,
      tags: world.model.swimmers.filter((x) => x.teamId !== world.own).map((x) => ({ teamId: x.teamId, swimmerId: x.swimmerId, role: 'scorer' as const })),
      rules,
      sourcing: SOURCING,
      own: world.own,
      decision: new Set(own),
      free: new Set(own),
      load: null,
      held: new Set(),
    };
  }
  const scorerOf = (): 'scorer' => 'scorer';

  it('fastSupported accepts the shipped NSISC rules and refuses each rule the arithmetic does not model', () => {
    const base = builtinRulePreset('nsisc', 5) as RulePreset;
    expect(fastSupported(rulesFor(VARIANTS[0] as Variant))).toBe(true);
    const holds = requireComplete({ ...base, scoring: { ...base.scoring, nonScorerPlacement: set('holds-place' as const) } });
    expect(fastSupported(holds)).toBe(false);
    const legsFree = requireComplete({ ...base, scorers: { ...base.scorers, relayLegsMustBeScorers: set(false) } });
    expect(fastSupported(legsFree)).toBe(false);
  });

  it('an evaluator over unsupported rules builds no fast scorer, so the reference scores every column', () => {
    const base = builtinRulePreset('nsisc', 5) as RulePreset;
    const holds = requireComplete({ ...base, scoring: { ...base.scoring, nonScorerPlacement: set('holds-place' as const) } });
    const world = syntheticWorld(777);
    const ev = new Evaluator(plainBase(world, holds));
    expect((ev as unknown as { fastScorer: unknown }).fastScorer).toBeNull();
    const event = world.model.events[0] as MeetEvent;
    for (const m of ['T0s00', 'T0s01', 'T0s02', 'T0s03']) ev.evaluate(event, [m]);
    expect(ev.calls).toBe(4);
    expect(ev.referenceCalls).toBe(4);
  });

  it('the first two columns of an event run both scorers, and the default is two', () => {
    const world = syntheticWorld(777);
    const rules = rulesFor(VARIANTS[0] as Variant);
    const event = world.model.events[0] as MeetEvent;
    const members = ['T0s00', 'T0s01', 'T0s02', 'T0s03', 'T0s04'];
    const dflt = new Evaluator(plainBase(world, rules));
    for (const m of members) dflt.evaluate(event, [m]);
    expect(dflt.calls).toBe(5);
    expect(dflt.referenceCalls).toBe(2);
    expect(dflt.fallbacks.size).toBe(0);
    const none = new Evaluator({ ...plainBase(world, rules), selfChecks: 0 });
    for (const m of members) none.evaluate(event, [m]);
    expect(none.referenceCalls).toBe(0);
  });

  it('an event the fast scorer gives up on stays with the reference: the scorer is not asked again', () => {
    const world = syntheticWorld(777);
    const ev = new Evaluator(plainBase(world, rulesFor(VARIANTS[0] as Variant)));
    let asked = 0;
    (ev as unknown as { fastScorer: { score: () => null } }).fastScorer.score = () => {
      asked += 1;
      return null;
    };
    const event = world.model.events[0] as MeetEvent;
    for (const m of ['T0s00', 'T0s01', 'T0s02']) ev.evaluate(event, [m]);
    expect(asked).toBe(1);
    expect(ev.fallbacks.size).toBe(1);
    expect(ev.referenceCalls).toBe(3);
  });

  it('the fast scorer returns null for a value it cannot read: a foreign seed swim, or a split that is not SCY', () => {
    const world = syntheticWorld(777);
    const rules = rulesFor(VARIANTS[0] as Variant);
    const scorer = new FastScorer(world.model, rules);
    const event = world.model.events[0] as MeetEvent;
    const mine = world.lineup.entries.find((e) => e.kind === 'individual' && e.eventKey === event.eventKey && e.teamId === 'T0') as Extract<LineupEntry, { kind: 'individual' }>;
    expect(scorer.score(event, [mine], scorerOf)).not.toBeNull();
    const other = world.model.swims.find((w) => w.swimmerId !== mine.swimmerId && w.eventKey === event.eventKey) as { swimId: string };
    expect(scorer.score(event, [{ ...mine, seedSwimId: other.swimId }], scorerOf)).toBeNull();
    const elsewhere = world.model.swims.find((w) => w.swimmerId === mine.swimmerId && w.eventKey !== event.eventKey) as { swimId: string };
    expect(scorer.score(event, [{ ...mine, seedSwimId: elsewhere.swimId }], scorerOf)).toBeNull();
    const relayEvent = world.model.events.find((e) => e.kind === 'relay') as MeetEvent;
    const relay = world.lineup.entries.find((e) => e.kind === 'relay' && e.teamId === 'T0') as Extract<LineupEntry, { kind: 'relay' }>;
    expect(scorer.score(relayEvent, [relay], scorerOf)).not.toBeNull();
    const splitLeg = relay.legs.find((l) => l.basis.kind === 'split') as { basis: { splitId: string } };
    const lcm = { ...world.model, relaySplits: world.model.relaySplits.map((sp) => (sp.splitId === splitLeg.basis.splitId ? { ...sp, course: 'LCM' as const } : sp)) };
    expect(new FastScorer(lcm, rules).score(relayEvent, [relay], scorerOf)).toBeNull();
  });

  it('the fast scorer returns null for an entry scoreMeet would refuse: it leaves the error to the reference', () => {
    const world = syntheticWorld(777);
    const rules = rulesFor(VARIANTS[0] as Variant);
    const event = world.model.events[0] as MeetEvent;
    const mine = world.lineup.entries.find((e) => e.kind === 'individual' && e.eventKey === event.eventKey && e.teamId === 'T0') as Extract<LineupEntry, { kind: 'individual' }>;
    const withSwimmer = (patch: Partial<MeetModel['swimmers'][number]>): FastScorer =>
      new FastScorer({ ...world.model, swimmers: world.model.swimmers.map((w) => (w.swimmerId === mine.swimmerId ? { ...w, ...patch } : w)) }, rules);
    expect(withSwimmer({}).score(event, [mine], scorerOf)).not.toBeNull();
    // The same four cases make `scoreMeet` throw.
    expect(withSwimmer({ roster: 'not_member' }).score(event, [mine], scorerOf)).toBeNull();
    expect(() => scoreMeet({ ...world.model, swimmers: world.model.swimmers.map((w) => (w.swimmerId === mine.swimmerId ? { ...w, roster: 'not_member' as const } : w)) }, { ...world.lineup, entries: [mine] }, [], rules, SOURCING)).toThrow();
    expect(withSwimmer({ teamId: 'T1' }).score(event, [mine], scorerOf)).toBeNull();
    expect(withSwimmer({ gender: 'Women' }).score(event, [mine], scorerOf)).toBeNull();
    expect(new FastScorer(world.model, rules).score(event, [mine, mine], scorerOf)).toBeNull();
    expect(new FastScorer({ ...world.model, teams: world.model.teams.filter((t) => t.teamId !== 'T0') }, rules).score(event, [mine], scorerOf)).toBeNull();
    const relayEvent = world.model.events.find((e) => e.kind === 'relay') as MeetEvent;
    const relay = world.lineup.entries.find((e) => e.kind === 'relay' && e.teamId === 'T0') as Extract<LineupEntry, { kind: 'relay' }>;
    const leg = relay.legs[1]?.swimmerId as string;
    const off = new FastScorer({ ...world.model, swimmers: world.model.swimmers.map((w) => (w.swimmerId === leg ? { ...w, roster: 'not_member' as const } : w)) }, rules);
    expect(off.score(relayEvent, [relay], scorerOf)).toBeNull();
  });
});
