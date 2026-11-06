/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.3a follow-ups (docs/reference/F1_3A_FLYOVER_ARCHITECT_REVIEW.md, ruling 3 and MEDIUM-1): the fast column scorer against the
 * `scoreMeet` reference with the flyover set, and `sessionLoad` under a flyover leg.
 *
 * The world is synthetic and says so: every time here is a test value, none is a competition value. Teams are D2, so a
 * short-course-meters split converts. The flyover is 0.30 s. The fast scorer has no arithmetic for a flyover leg or a converted
 * split, so it must give up on the relay event and leave the column to `scoreMeet` (`fastScore.ts`, `UNREADABLE`). The
 * evaluator runs with `selfChecks: 0`, so its own cross-check cannot hide a wrong fast row.
 *
 * Mutations these tests must kill: value a flyover leg as its flat time in `FastScorer.relayValue`; read a non-SCY split at its raw
 * hundredths there; pass no flyover to the index that `sessionLoad` builds.
 */
import { describe, expect, it } from 'vitest';
import { builtinRulePreset, requireComplete, scoreMeet, sessionLoad, splitScyValue } from '@omniswim/engine';
import type {
  CompleteRulePreset,
  DivisionRef,
  Lineup,
  LineupEntry,
  MeetEvent,
  MeetModel,
  MeetSwim,
  RelaySplit,
  RulePreset,
  ScorerTag,
  SessionPreset,
  SourcingSettings,
} from '@omniswim/engine';
import { Evaluator, sameRows } from '../packages/engine/src/autobuilder/evaluate';
import type { EvalBase } from '../packages/engine/src/autobuilder/evaluate';
import { FastScorer, fastSupported } from '../packages/engine/src/autobuilder/fastScore';
import { buildLegSources, generateSquads, legOptions } from '../packages/engine/src/autobuilder/squads';
import type { Squad } from '../packages/engine/src/autobuilder/squads';
import { loadRuleOf } from '../packages/engine/src/autobuilder/support';
import type { RelayEntry } from '../packages/engine/src/model/lineup';
import { set, TEST_PROVENANCE } from './engineTestPresets';

const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic F1.3a follow-ups' } as const;
const D2: DivisionRef = { state: 'known', division: 'D2', season: '2026-2027' };
const FLYOVER_30 = 30;
const SOURCING: SourcingSettings = { includeConvertedSwims: true, lcmToScy: null, flyover: { state: 'set', hundredths: FLYOVER_30 } };
const SOURCING_C: SourcingSettings = { includeConvertedSwims: true, lcmToScy: null, flyover: { state: 'unset' } };
const RELAY: MeetEvent = { eventKey: '400 Freestyle Relay', gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' };
const FREE100: MeetEvent = { eventKey: '100 Freestyle', gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null };

const tv = (h: number) => ({ text: (h / 100).toFixed(2), hundredths: h });
const swimOf = (swimmerId: string, hundredths: number): MeetSwim => ({
  swimId: `${swimmerId}:100 Freestyle`,
  swimmerId,
  eventKey: '100 Freestyle',
  recordedCourse: 'SCY',
  recordedTime: tv(hundredths),
  date: null,
  seasonId: null,
  flags: {},
  scy: { kind: 'recorded-scy' },
  origin: ORIGIN,
});
const splitOf = (swimmerId: string, hundredths: number, course: 'SCY' | 'SCM'): RelaySplit => ({
  splitId: `${swimmerId}:split:${course}`,
  swimmerId,
  relayEventKey: null,
  legPosition: null,
  start: 'flying',
  legEventKey: '100 Freestyle',
  split: tv(hundredths),
  course,
  date: null,
  origin: ORIGIN,
});

// ---- the world ---------------------------------------------------------------------------------------

// T0 is the own team, in two groups. Group F (o1 to o6) tests the flyover: o1, o2, o3 and o6 have a flat swim only, so they get a flyover
// option on legs 2 to 4, and o5 has an SCY split. Group C (c1 to c6) tests the converted split: c2, c3 and c5 have an SCM split, c4 and c6 an
// SCY split, and c1 a flat swim only (a leadoff). The two groups never share a lineup, because the fast scorer gives up on the whole event
// when any one entry is unreadable, and one kind of unreadable entry must not hide the other.
const OWN_F = ['o1', 'o2', 'o3', 'o5', 'o6'];
const OWN_C = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const swims: MeetSwim[] = [
  swimOf('o1', 4950), swimOf('o2', 4900), swimOf('o3', 4800), swimOf('o6', 5200), swimOf('o4', 5300), swimOf('o5', 5100),
  swimOf('c1', 4950), swimOf('c2', 4900), swimOf('c3', 4850), swimOf('c4', 4800), swimOf('c5', 5000), swimOf('c6', 5100),
  swimOf('p1', 5000), swimOf('p5', 5050), swimOf('q1', 5100),
];
const splits: RelaySplit[] = [
  splitOf('o4', 5000, 'SCM'), splitOf('o5', 4850, 'SCY'),
  splitOf('c2', 5200, 'SCM'), splitOf('c3', 5100, 'SCM'), splitOf('c5', 5000, 'SCM'), splitOf('c4', 4700, 'SCY'), splitOf('c6', 4800, 'SCY'),
  splitOf('p2', 4900, 'SCY'), splitOf('p3', 4900, 'SCY'), splitOf('p4', 4900, 'SCY'),
  splitOf('p6', 5000, 'SCM'), splitOf('p7', 5000, 'SCM'), splitOf('p8', 5000, 'SCM'),
  splitOf('q2', 4790, 'SCY'), splitOf('q3', 4790, 'SCY'), splitOf('q4', 4790, 'SCY'),
];
const TEAM_OF = (id: string): string => (id.startsWith('o') || id.startsWith('c') ? 'T0' : id.startsWith('p') ? 'T1' : 'T2');
const swimmerIds = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', ...OWN_C, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'q1', 'q2', 'q3', 'q4'];
const model: MeetModel = {
  payloadVersion: 1,
  meetKey: 'synthetic F1.3a follow-ups',
  teams: ['T0', 'T1', 'T2'].map((teamId) => ({ teamId, division: D2 })),
  swimmers: swimmerIds.map((swimmerId) => ({ swimmerId, teamId: TEAM_OF(swimmerId), gender: 'Men' as const, classYear: null, roster: 'member' as const })),
  events: [FREE100, RELAY],
  swims,
  relaySplits: splits,
  recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
  extendedWindow: false,
  observedScores: null,
};
const flatLeg = (swimmerId: string) => ({ swimmerId, basis: { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:100 Freestyle` } });
const splitLeg = (swimmerId: string, course: 'SCY' | 'SCM') => ({ swimmerId, basis: { kind: 'split' as const, splitId: `${swimmerId}:split:${course}` } });
const estimateLeg = (swimmerId: string) => ({ swimmerId, basis: { kind: 'flyover-estimate' as const, swimId: `${swimmerId}:100 Freestyle` } });
const relay = (teamId: string, letter: string, legs: unknown): RelayEntry => ({ kind: 'relay', teamId, eventKey: RELAY.eventKey, gender: 'Men', letter, legs: legs as RelayEntry['legs'] });
const individual = (swimmerId: string): LineupEntry => ({ kind: 'individual', teamId: TEAM_OF(swimmerId), swimmerId, eventKey: FREE100.eventKey, gender: 'Men', seedSwimId: null });

// T1 A is SCY throughout (19700). T1 B rests on three converted SCM splits. T2 A is SCY (5100 + 3 * 4790 = 19470): it sits between the own squad
// o1, o2, o3, o5 valued with the 0.30 flyover (19440) and valued as flat times (19500), so a flyover leg decides a placement.
const t1a = relay('T1', 'A', [flatLeg('p1'), splitLeg('p2', 'SCY'), splitLeg('p3', 'SCY'), splitLeg('p4', 'SCY')]);
const t1b = relay('T1', 'B', [flatLeg('p5'), splitLeg('p6', 'SCM'), splitLeg('p7', 'SCM'), splitLeg('p8', 'SCM')]);
const t2a = relay('T2', 'A', [flatLeg('q1'), splitLeg('q2', 'SCY'), splitLeg('q3', 'SCY'), splitLeg('q4', 'SCY')]);
const individuals = [individual('p1'), individual('p5'), individual('q1')];

/** A world is an own group, the lineup of the other teams and the settings. */
interface World {
  readonly name: string;
  readonly own: readonly string[];
  readonly lineup: Lineup;
  readonly sourcing: SourcingSettings;
}
const lineupOf = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: model.meetKey, entries });
const WORLD_F: World = { name: 'flyover', own: OWN_F, lineup: lineupOf(t1a, t2a, ...individuals), sourcing: SOURCING };
const WORLD_C: World = { name: 'converted split', own: OWN_C, lineup: lineupOf(t1a, t1b, t2a, ...individuals), sourcing: SOURCING_C };

function rules(): CompleteRulePreset {
  return requireComplete(builtinRulePreset('nsisc', 5) as RulePreset);
}

const schedule: SessionPreset = {
  payloadVersion: 1,
  provenance: TEST_PROVENANCE,
  events: [
    {
      eventKey: RELAY.eventKey,
      gender: 'both',
      format: {
        kind: 'timed-final-split',
        slowHeats: { day: 1, slot: 'morning' },
        fastHeat: { day: 1, slot: 'evening' },
        fastHeatSize: set(2),
        smallFieldSession: set({ day: 1, slot: 'evening' }),
      },
    },
    { eventKey: FREE100.eventKey, gender: 'both', format: { kind: 'timed-final', session: { day: 1, slot: 'evening' } } },
  ],
};

const scorers = (ids: readonly string[]): ScorerTag[] => ids.map((swimmerId) => ({ teamId: TEAM_OF(swimmerId), swimmerId, role: 'scorer' as const }));
const opponentTags = (): ScorerTag[] => scorers(swimmerIds.filter((id) => TEAM_OF(id) !== 'T0'));

function baseFor(world: World, fast: boolean): EvalBase {
  return {
    model,
    lineup: world.lineup,
    tags: opponentTags(),
    rules: rules(),
    sourcing: world.sourcing,
    own: 'T0',
    decision: new Set(world.own),
    free: new Set(world.own),
    load: loadRuleOf({ schedule, preference: { mode: 'respect', maxRacesPerSession: set(2), diving: set('counts' as const) } }),
    held: new Set<string>(),
    fast,
    selfChecks: 0,
  };
}

/**
 * Every squad of the world's own group, scored as its own column by a fresh fast evaluator and a fresh reference evaluator. A fresh pair per
 * column: an evaluator that has once fallen back for an event never tries the arithmetic again, and the first column is the one that shows it.
 */
function compareSquads(world: World): { readonly squads: readonly Squad[]; readonly placed: number; readonly withRaces: number } {
  const positions = legOptions(RELAY, world.own, buildLegSources(model, world.sourcing));
  if (positions === null) throw new Error('no relay leg options');
  const squads = generateSquads(positions, true, 15, []).squads;
  let placed = 0;
  let withRaces = 0;
  for (const squad of squads) {
    const fast = new Evaluator(baseFor(world, true));
    const reference = new Evaluator(baseFor(world, false));
    const a = fast.evaluateRelay(RELAY, [squad]);
    const b = reference.evaluateRelay(RELAY, [squad]);
    const label = `${world.name} squad ${squad.swimmers.join(',')} (${squad.legs.map((l) => l.basis.kind).join(',')})`;
    expect(sameRows(a.rows, b.rows), `${label}: rows differ\nfast ${JSON.stringify(a.rows)}\nref  ${JSON.stringify(b.rows)}`).toBe(true);
    expect(a.own, `${label}: own points`).toBeCloseTo(b.own, 9);
    expect(a.tieSizes, `${label}: tie sizes`).toEqual(b.tieSizes);
    expect(a.races, `${label}: race counts`).toEqual(b.races);
    // The fast evaluator did not do the arithmetic: the relay event fell back and scoreMeet ran for the column.
    expect([...fast.fallbacks], label).toEqual([`Men\u0000${RELAY.eventKey}`]);
    expect(fast.referenceCalls, label).toBe(1);
    const own = b.rows.find((r) => r.teamId === 'T0');
    if (own !== undefined && own.place !== null) placed += 1;
    if (b.races.size > 0) withRaces += 1;
  }
  return { squads, placed, withRaces };
}

// ---- the tests ---------------------------------------------------------------------------------------

describe('F1.3a ruling 3: the fast scorer and scoreMeet agree with the flyover set', () => {
  const converted = splitScyValue(splits.find((s) => s.splitId === 'p6:split:SCM') as RelaySplit, D2, 'Men', SOURCING) as number;

  it('the converted split is a real conversion, far from its raw hundredths', () => {
    expect(converted).not.toBeNull();
    // A converted 50.00 (SCM) is below the raw 5000 hundredths: T1 B is much faster than its raw sum says.
    expect(converted).toBeLessThan(5000);
    expect(fastSupported(rules())).toBe(true);
  });

  it('the fast scorer gives up on a relay with a flyover leg or a converted split, and reads an all-SCY relay', () => {
    const scorer = new FastScorer(model, rules());
    const roleOf = () => 'scorer' as const;
    expect(scorer.score(RELAY, [t1a], roleOf)).not.toBeNull();
    expect(scorer.score(RELAY, [t1b], roleOf)).toBeNull();
    const flying = relay('T1', 'C', [flatLeg('p1'), estimateLeg('p5'), splitLeg('p3', 'SCY'), splitLeg('p4', 'SCY')]);
    expect(scorer.score(RELAY, [flying], roleOf)).toBeNull();
  });

  it('flyover world: every squad has the same rows, races and points by either evaluator, and some squads hold a flyover leg', () => {
    const { squads, placed, withRaces } = compareSquads(WORLD_F);
    expect(squads.filter((q) => q.legs.some((l) => l.basis.kind === 'flyover-estimate')).length).toBeGreaterThan(0);
    // The own relays are timed and placed, so agreeing on "no time" proves nothing.
    expect(placed).toBe(squads.length);
    expect(withRaces).toBeGreaterThan(0);
  });

  it('converted split world: every squad has the same rows, races and points by either evaluator, and some squads hold a converted split', () => {
    const { squads, placed, withRaces } = compareSquads(WORLD_C);
    expect(squads.filter((q) => q.legs.some((l) => l.basis.kind === 'split' && l.basis.splitId.endsWith(':SCM'))).length).toBeGreaterThan(0);
    expect(placed).toBe(squads.length);
    expect(withRaces).toBeGreaterThan(0);
  });

  it('an individual event is still scored by arithmetic in the same world: the fallback is for the relay only', () => {
    const fast = new Evaluator(baseFor(WORLD_F, true));
    const reference = new Evaluator(baseFor(WORLD_F, false));
    const x = fast.evaluate(FREE100, ['o1', 'o2']);
    expect(fast.referenceCalls).toBe(0);
    expect(fast.fallbacks.size).toBe(0);
    expect(sameRows(x.rows, reference.evaluate(FREE100, ['o1', 'o2']).rows)).toBe(true);
  });

  it('the flyover world is sensitive to the allowance: the own squad o1, o2, o3, o5 places differently with 0.30 s than with 0 s', () => {
    const ownPoints = (hundredths: number): number => {
      const s: SourcingSettings = { ...SOURCING, flyover: { state: 'set', hundredths } };
      const own = relay('T0', 'A', [flatLeg('o1'), estimateLeg('o2'), estimateLeg('o3'), splitLeg('o5', 'SCY')]);
      const tags = [...opponentTags(), ...scorers(OWN_F)];
      const rows = scoreMeet(model, lineupOf(...WORLD_F.lineup.entries, own), tags, rules(), s).events.find((e) => e.eventKey === RELAY.eventKey)!.rows;
      return rows.filter((r) => r.teamId === 'T0').reduce((n, r) => n + r.points, 0);
    };
    // 4950 + 4870 + 4770 + 4850 = 19440 < 19470 (T2 A) < 19500 = the same legs as flat times.
    expect(ownPoints(FLYOVER_30)).not.toBe(ownPoints(0));
    const squads = generateSquads(legOptions(RELAY, OWN_F, buildLegSources(model, SOURCING))!, true, 15, []).squads;
    expect(squads.find((q) => [...q.swimmers].sort().join(',') === 'o1,o2,o3,o5')?.time).toBe(19440);
  });

  it('the converted split world is sensitive to the conversion: T1 B has a time when splits convert and none when they do not', () => {
    const rowsOf = (s: SourcingSettings) =>
      scoreMeet(model, WORLD_C.lineup, [...opponentTags(), ...scorers(OWN_C)], rules(), s).events.find((e) => e.eventKey === RELAY.eventKey)!.rows;
    const bRow = (rows: ReturnType<typeof rowsOf>) => rows.find((r) => r.teamId === 'T1' && r.entryKey.includes('B'));
    expect(bRow(rowsOf(SOURCING_C))?.notScoredReason).not.toBe('no_time');
    expect(bRow(rowsOf({ ...SOURCING_C, includeConvertedSwims: false }))?.notScoredReason).toBe('no_time');
  });
});

describe('MEDIUM-1: sessionLoad values a flyover leg under the settings it is given', () => {
  // Three entries in a split timed final with a fast heat of two. The own relay is 4950 + (5200 - f) + 4850 + 5300 = 20300 - f, against
  // T2 A at 19470 and T1 A at 19700.
  const ownRelay = relay('T0', 'A', [flatLeg('o1'), estimateLeg('o6'), splitLeg('o5', 'SCY'), flatLeg('o4')]);
  const small = lineupOf(t1a, ownRelay, t2a);
  const tags: ScorerTag[] = [...scorers(['o1', 'o4', 'o5', 'o6']), ...scorers(['p1', 'p2', 'p3', 'p4', 'q1', 'q2', 'q3', 'q4'])];
  const sessionsOf = (flyover: number | null, swimmer: string) => {
    const s: SourcingSettings = { ...SOURCING, flyover: flyover === null ? { state: 'unset' } : { state: 'set', hundredths: flyover } };
    const results = scoreMeet(model, small, tags, rules(), s);
    const run = sessionLoad(model, small, results, schedule, { mode: 'off' }, rules(), s);
    return { run, slots: (run.perSwimmer.find((p) => p.swimmerId === swimmer)?.sessions ?? []).map((x) => x.session.slot) };
  };

  it('ranks the entry by its estimate, and does not throw on the flyover leg', () => {
    // f = 0: the own relay is 20300, the slowest of three. The fast heat is T2 A and T1 A, and o1 swims the slow heat.
    expect(sessionsOf(0, 'o1').slots).toEqual(['morning']);
    expect(sessionsOf(0, 'p2').slots).toEqual(['evening']);
    // f = 1000: it is 19300, the fastest. The fast heat is the own relay and T2 A, and T1 A drops to the slow heat.
    expect(sessionsOf(1000, 'o1').slots).toEqual(['evening']);
    expect(sessionsOf(1000, 'q2').slots).toEqual(['evening']);
    expect(sessionsOf(1000, 'p2').slots).toEqual(['morning']);
  });

  it('an unset flyover gives the leg no time: the relay has no seed and races nowhere', () => {
    const unset = sessionsOf(null, 'o1');
    expect(unset.slots).toEqual([]);
    expect(unset.run.violations).toContainEqual(expect.objectContaining({ kind: 'seed_time_missing' }));
  });
});
