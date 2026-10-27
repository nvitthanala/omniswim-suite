/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `validateMeetModel` and `scoreMeet` (plans/2026-10-25/D2-ENGINE-API.md, 3.6 and 3.8), on small
 * synthetic meets where the right answer is countable by hand. The SwimCloud parity test runs the
 * same code over real recorded data.
 */
import { describe, expect, it } from 'vitest';
import {
  MeetModelError,
  requireComplete,
  ScoreMeetError,
  scoreMeet,
  stripResultsDisplay,
  validateMeetModel,
} from '@omniswim/engine';
import type {
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  MeetEvent,
  MeetModel,
  MeetSwim,
  RelaySplit,
  Results,
  RulePreset,
} from '@omniswim/engine';
import { LEGACY_UNLIMITED, toLegacyScoringSettings } from '@omniswim/engine/rules/legacyBridge';
import { completeNsisc, set } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;

// ---- builders ----------------------------------------------------------------------------------

const EVENT_50: MeetEvent = { eventKey: '50 Freestyle', gender: 'Men', kind: 'individual', distanceYards: 50, relayKind: null };
const EVENT_100: MeetEvent = { eventKey: '100 Freestyle', gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null };
const EVENT_DIVE: MeetEvent = { eventKey: '1-Meter Diving', gender: 'Men', kind: 'diving', distanceYards: null, relayKind: null };
const EVENT_RELAY: MeetEvent = { eventKey: '400 Freestyle Relay', gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' };

const swim = (swimmerId: string, eventKey: string, hundredths: number, extra: Partial<MeetSwim> = {}): MeetSwim => ({
  swimId: `${swimmerId}:${eventKey}:${hundredths}`,
  swimmerId,
  eventKey,
  recordedCourse: 'SCY',
  recordedTime: { text: (hundredths / 100).toFixed(2), hundredths },
  date: null,
  seasonId: null,
  flags: {},
  scy: { kind: 'recorded-scy' },
  origin: ORIGIN,
  ...extra,
});

const diveSwim = (swimmerId: string, score: number): MeetSwim => swim(swimmerId, '1-Meter Diving', Math.round(score * 100));

const split = (swimmerId: string, hundredths: number): RelaySplit => ({
  splitId: `split-${swimmerId}`,
  swimmerId,
  relayEventKey: null,
  legPosition: null,
  start: 'flying',
  legEventKey: '100 Freestyle',
  split: { text: (hundredths / 100).toFixed(2), hundredths },
  course: 'SCY',
  date: null,
  origin: ORIGIN,
});

interface Swimmer {
  id: string;
  team: string;
  roster?: 'member' | 'not_member' | 'unknown';
  gender?: 'Men' | 'Women';
}

function model(swimmers: Swimmer[], swims: MeetSwim[], opts: { events?: MeetEvent[]; splits?: RelaySplit[]; display?: boolean } = {}): MeetModel {
  const teamIds = [...new Set(swimmers.map((s) => s.team))];
  return {
    payloadVersion: 1,
    meetKey: 'synthetic',
    teams: teamIds.map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
    swimmers: swimmers.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? 'Men', classYear: null, roster: s.roster ?? 'member' })),
    events: opts.events ?? [EVENT_50, EVENT_100, EVENT_DIVE, EVENT_RELAY],
    swims,
    relaySplits: opts.splits ?? [],
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
    ...(opts.display
      ? {
          display: {
            swimmers: Object.fromEntries(swimmers.map((s) => [s.id, { name: 'Alex Kim' }])),
            teams: Object.fromEntries(teamIds.map((t) => [t, { name: `Team ${t}` }])),
          },
        }
      : {}),
  };
}

const ind = (team: string, swimmerId: string, eventKey = '50 Freestyle'): LineupEntry => ({
  kind: 'individual',
  teamId: team,
  swimmerId,
  eventKey,
  gender: 'Men',
  seedSwimId: null,
});

type RelayLineupEntry = Extract<LineupEntry, { kind: 'relay' }>;
const relay = (team: string, letter: string, ids: [string, string, string, string]): RelayLineupEntry => ({
  kind: 'relay',
  teamId: team,
  eventKey: '400 Freestyle Relay',
  gender: 'Men',
  letter,
  legs: ids.map((swimmerId, i) => ({
    swimmerId,
    basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:100 Freestyle:${flatOf.get(swimmerId)}` } : { kind: 'split' as const, splitId: `split-${swimmerId}` },
  })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
});
const flatOf = new Map<string, number>();

const lineup = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });

/** A points_pool preset with the college tables (9-4-3-2-1, relay 11-4-2) and the caps a test names. */
function preset(opts: { ties?: 'split' | 'ordered'; scorerCap?: number; relayCap?: number | 'unlimited'; relayOverCap?: 'holds-place' | 'exhibition'; maxInd?: number | 'unlimited'; eligibility?: 'points_pool' | 'roster'; overCap?: 'holds-place' | 'removed-from-consideration'; divingCap?: { cap: number; overCap: 'holds-place' | 'removed-from-consideration' } } = {}): CompleteRulePreset {
  const p: RulePreset = {
    payloadVersion: 3,
    scoring: {
      ties: set(opts.ties ?? ('split' as const)),
      individualPoints: set([9, 4, 3, 2, 1]),
      relayPoints: set({ kind: 'table' as const, points: [11, 4, 2] }),
      divingPoints: set({ kind: 'same-as-individual' as const }),
      halfRateRelaySwimmer: set(true),
      aFinalBracketSize: set(8),
      nonScorerPlacement: set('holds-place' as const),
      abFinalsScorersOnly: set(false),
      cFinal: set({ kind: 'none' as const }),
    },
    scorers: {
      eligibility: set(opts.eligibility ?? ('points_pool' as const)),
      autoRules: set(null),
      scoringTeamSize: set('unlimited' as const),
      scoringTeamScope: set('event' as const),
      diverWeight: set({ numerator: 1, denominator: 1 }),
      perEventScorerCap: set(opts.scorerCap === undefined ? { cap: 'unlimited' as const } : { cap: opts.scorerCap, overCap: opts.overCap ?? ('holds-place' as const) }),
      divingPerEventScorerCap: set(opts.divingCap === undefined ? { kind: 'same-as-swimming' as const } : { kind: 'own' as const, ...opts.divingCap }),
      scoringRelaysPerTeamPerEvent: set(opts.relayCap ?? 'unlimited'),
      relayOverCap: set(opts.relayOverCap ?? ('holds-place' as const)),
      relayEligibleFromScorerPool: set(false),
      relayLegsMustBeScorers:
        opts.eligibility === 'roster' ? set(false) : { state: 'pending', question: 'not applicable', blocks: ['requireComplete', 'scoreMeet'] },
    },
    entries: {
      maxIndividualPerSwimmer: set(opts.maxInd ?? 'unlimited'),
      maxRelayPerSwimmer: set('unlimited' as const),
      maxTotalPerSwimmer: set('unlimited' as const),
      timeTrialsCount: set(false),
      exhibitionCounts: set(true),
      relayLegsAllowTimeTrials: set(false),
    },
  };
  return requireComplete(p);
}

const pointsOf = (r: Results, team: string) => r.teams.find((t) => t.teamId === team)?.points;
const rowsOf = (r: Results, eventKey: string) => r.events.find((e) => e.eventKey === eventKey)?.rows ?? [];

function scoreCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScoreMeetError) return error.code;
    throw error;
  }
  return 'did not throw';
}

// ---- scoreMeet ---------------------------------------------------------------------------------

describe('scoreMeet: same names, synthetic keys', () => {
  // The named bug: the legacy scorer keys by display name, so two "Alex Kim"s on one team merged.
  const swimmers = [{ id: 'a1', team: 'T1' }, { id: 'a2', team: 'T1' }, { id: 'b1', team: 'T2' }];
  const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2100), swim('b1', '50 Freestyle', 2050)];

  it('two swimmers with one display name on one team score as two athletes', () => {
    const m = model(swimmers, swims, { display: true });
    const r = scoreMeet(m, lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1')), [], preset(), SOURCING);
    // a1 first (9), b1 second (4), a2 third (3).
    expect(rowsOf(r, '50 Freestyle').map((x) => [x.swimmerId, x.place, x.points])).toEqual([
      ['a1', 1, 9],
      ['b1', 2, 4],
      ['a2', 3, 3],
    ]);
    expect(pointsOf(r, 'T1')).toBe(12);
    expect(pointsOf(r, 'T2')).toBe(4);
  });

  it('the result does not depend on the display names, and stripResultsDisplay removes them', () => {
    const withNames = scoreMeet(model(swimmers, swims, { display: true }), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1')), [], preset(), SOURCING);
    const without = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1')), [], preset(), SOURCING);
    expect(withNames).toEqual(without);
    const display = { swimmers: { a1: { name: 'x' } }, teams: {}, entryTimes: {} };
    const stripped = stripResultsDisplay({ ...without, display });
    expect('display' in stripped).toBe(false);
    expect(stripped).toEqual(without);
  });

  it('refuses two ids that normalize to one legacy key, instead of merging them', () => {
    const m = model([{ id: 'X1', team: 'T1' }, { id: 'x1', team: 'T1' }], [swim('X1', '50 Freestyle', 2000), swim('x1', '50 Freestyle', 2100)]);
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'X1'), ind('T1', 'x1')), [], preset(), SOURCING))).toBe('name_collision');
  });
});

describe('scoreMeet: caps and ranking', () => {
  const swimmers = [{ id: 'a1', team: 'T1' }, { id: 'a2', team: 'T1' }, { id: 'a3', team: 'T1' }, { id: 'b1', team: 'T2' }, { id: 'b2', team: 'T2' }];

  it('an over-cap entry earns 0 and holds its place', () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('a3', '50 Freestyle', 2020), swim('b1', '50 Freestyle', 2030), swim('b2', '50 Freestyle', 2040)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T1', 'a3'), ind('T2', 'b1'), ind('T2', 'b2')), [], preset({ scorerCap: 2 }), SOURCING);
    expect(rowsOf(r, '50 Freestyle').map((x) => [x.swimmerId, x.place, x.points, x.notScoredReason ?? null])).toEqual([
      ['a1', 1, 9, null],
      ['a2', 2, 4, null],
      ['a3', 3, 0, 'event_scorer_cap'],
      ['b1', 4, 2, null], // fourth place scores 2: a3 kept the third place
      ['b2', 5, 1, null],
    ]);
  });

  it('with no cap, the same field scores every place', () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('a3', '50 Freestyle', 2020), swim('b1', '50 Freestyle', 2030), swim('b2', '50 Freestyle', 2040)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T1', 'a3'), ind('T2', 'b1'), ind('T2', 'b2')), [], preset(), SOURCING);
    expect(rowsOf(r, '50 Freestyle').map((x) => x.points)).toEqual([9, 4, 3, 2, 1]);
  });

  it('an entry past the point table scores 0 and says why', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, team: i % 2 === 0 ? 'T1' : 'T2' }));
    const swims = many.map((s, i) => swim(s.id, '50 Freestyle', 2000 + i));
    const r = scoreMeet(model(many, swims), lineup(...many.map((s) => ind(s.team, s.id))), [], preset(), SOURCING);
    const last = rowsOf(r, '50 Freestyle')[5];
    expect(last).toMatchObject({ points: 0, scored: false, notScoredReason: 'outside_point_table', place: 6 });
  });

  it('a tie shares a rank and splits the points of the places it covers', () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('b1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2100)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T2', 'b1'), ind('T1', 'a2')), [], preset(), SOURCING);
    expect(rowsOf(r, '50 Freestyle').map((x) => [x.swimmerId, x.place, x.points])).toEqual([
      ['a1', 1, 6.5],
      ['b1', 1, 6.5],
      ['a2', 3, 3],
    ]);
    // Standard competition ranking, with the points shared by teams: T1 has 9.5, T2 has 6.5.
    expect(r.teams).toEqual([
      { teamId: 'T1', points: 9.5, rank: 1 },
      { teamId: 'T2', points: 6.5, rank: 2 },
    ]);
  });

  it("under 'ordered' a tie takes consecutive places, and lineup order breaks it: nothing is split", () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('b1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2100)];
    const ordered = (...entries: LineupEntry[]) => scoreMeet(model(swimmers, swims), lineup(...entries), [], preset({ ties: 'ordered' }), SOURCING);
    const first = ordered(ind('T1', 'a1'), ind('T2', 'b1'), ind('T1', 'a2'));
    expect(rowsOf(first, '50 Freestyle').map((x) => [x.swimmerId, x.place, x.points])).toEqual([
      ['a1', 1, 9],
      ['b1', 2, 4],
      ['a2', 3, 3],
    ]);
    // The same field with the tied entries entered the other way round: the tiebreak is entry order.
    const swapped = ordered(ind('T2', 'b1'), ind('T1', 'a1'), ind('T1', 'a2'));
    expect(rowsOf(swapped, '50 Freestyle').map((x) => [x.swimmerId, x.place, x.points])).toEqual([
      ['b1', 1, 9],
      ['a1', 2, 4],
      ['a2', 3, 3],
    ]);
    expect(pointsOf(first, 'T1')).toBe(12);
    expect(pointsOf(swapped, 'T1')).toBe(7);
  });

  it("a tie across the last scoring place: 'split' shares it, 'ordered' gives it to the first entered", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, team: i % 2 === 0 ? 'T1' : 'T2' }));
    const swims = many.map((s, i) => swim(s.id, '50 Freestyle', i < 4 ? 2000 + i : 2500));
    const entries = many.map((s) => ind(s.team, s.id));
    const run = (ties: 'split' | 'ordered') => rowsOf(scoreMeet(model(many, swims), lineup(...entries), [], preset({ ties }), SOURCING), '50 Freestyle').map((x) => x.points);
    expect(run('split')).toEqual([9, 4, 3, 2, 0.5, 0.5]);
    expect(run('ordered')).toEqual([9, 4, 3, 2, 1, 0]);
  });

  it('a dive ranks by score, highest first', () => {
    const swims = [diveSwim('a1', 300.5), diveSwim('b1', 310.25), diveSwim('a2', 299.99)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1', '1-Meter Diving'), ind('T2', 'b1', '1-Meter Diving'), ind('T1', 'a2', '1-Meter Diving')), [], preset(), SOURCING);
    expect(rowsOf(r, '1-Meter Diving').map((x) => [x.swimmerId, x.points])).toEqual([
      ['b1', 9],
      ['a1', 4],
      ['a2', 3],
    ]);
  });

  it('with two swims for one event, the engine picks the best: lowest time, highest dive', () => {
    const swims = [swim('a1', '50 Freestyle', 2200), swim('a1', '50 Freestyle', 2000), swim('b1', '50 Freestyle', 2100), diveSwim('a1', 250), diveSwim('a1', 280), diveSwim('b1', 270)];
    const r = scoreMeet(
      model(swimmers, swims),
      lineup(ind('T1', 'a1'), ind('T2', 'b1'), ind('T1', 'a1', '1-Meter Diving'), ind('T2', 'b1', '1-Meter Diving')),
      [],
      preset(),
      SOURCING
    );
    expect(rowsOf(r, '50 Freestyle')[0]).toMatchObject({ swimmerId: 'a1', points: 9 });
    expect(rowsOf(r, '1-Meter Diving')[0]).toMatchObject({ swimmerId: 'a1', points: 9 });
  });

  it('an entry with no time earns 0, has no place, and says no_time', () => {
    const r = scoreMeet(model(swimmers, [swim('a1', '50 Freestyle', 2000)]), lineup(ind('T1', 'a1'), ind('T2', 'b1')), [], preset(), SOURCING);
    const none = rowsOf(r, '50 Freestyle').find((x) => x.swimmerId === 'b1');
    expect(none).toMatchObject({ place: null, points: 0, notScoredReason: 'no_time' });
  });

  it('a team with no entry still appears, with 0 points', () => {
    const r = scoreMeet(model(swimmers, [swim('a1', '50 Freestyle', 2000)]), lineup(ind('T1', 'a1')), [], preset(), SOURCING);
    expect(pointsOf(r, 'T2')).toBe(0);
    expect(r.teams).toHaveLength(2);
  });
});

describe('scoreMeet: relays', () => {
  // T1 fields three relays, T2 one. Each relay is four swimmers: a flat-start swim for leg 1, flying splits after.
  const ids = (team: string, n: number) => Array.from({ length: n }, (_, i) => `${team}-${i}`);
  const swimmers = [...ids('T1', 12), ...ids('T2', 4)].map((id) => ({ id, team: id.slice(0, 2) }));
  const swims: MeetSwim[] = [];
  const splits: RelaySplit[] = [];
  const base: Record<string, number> = { T1: 2000, T2: 2300 };
  swimmers.forEach((s, i) => {
    const flat = base[s.team]! + i * 10;
    swims.push(swim(s.id, '100 Freestyle', flat));
    flatOf.set(s.id, flat);
    splits.push(split(s.id, flat - 100));
  });
  const group = (team: string, g: number): [string, string, string, string] => [0, 1, 2, 3].map((k) => `${team}-${g * 4 + k}`) as [string, string, string, string];
  const entries = [relay('T1', 'A', group('T1', 0)), relay('T1', 'B', group('T1', 1)), relay('T1', 'C', group('T1', 2)), relay('T2', 'A', group('T2', 0))];

  it('a relay scores its summed leg times against the relay table', () => {
    const r = scoreMeet(model(swimmers, swims, { splits }), lineup(...entries), [], preset(), SOURCING);
    expect(rowsOf(r, '400 Freestyle Relay').map((x) => x.points)).toEqual([11, 4, 2, 0]);
  });

  it('the per-event scorer cap limits relays too: the third T1 relay earns 0 and holds its place', () => {
    const r = scoreMeet(model(swimmers, swims, { splits }), lineup(...entries), [], preset({ relayCap: 2 }), SOURCING);
    const rows = rowsOf(r, '400 Freestyle Relay');
    expect(rows.map((x) => [x.entryKey, x.place, x.points, x.notScoredReason ?? null])).toEqual([
      ['r|T1|400 Freestyle Relay|Men|A', 1, 11, null],
      ['r|T1|400 Freestyle Relay|Men|B', 2, 4, null],
      ['r|T1|400 Freestyle Relay|Men|C', 3, 0, 'relay_scorer_cap'],
      ['r|T2|400 Freestyle Relay|Men|A', 4, 0, 'outside_point_table'],
    ]);
  });

  it('a flat-start swim on leg 2 scores, and is flagged', () => {
    const swapped = relay('T1', 'A', group('T1', 0));
    const legs = [...swapped.legs] as unknown as { swimmerId: string; basis: unknown }[];
    legs[1] = { swimmerId: 'T1-1', basis: { kind: 'flat-start-swim', swimId: `T1-1:100 Freestyle:${flatOf.get('T1-1')}` } };
    const r = scoreMeet(model(swimmers, swims, { splits }), lineup({ ...swapped, legs: legs as never }), [], preset(), SOURCING);
    expect(r.violations).toContainEqual({ kind: 'relay_leg', entryKey: 'r|T1|400 Freestyle Relay|Men|A', leg: 2, reason: 'basis_position' });
    expect(pointsOf(r, 'T1')).toBe(11);
  });

  it('a relay that lists a swimmer twice is flagged', () => {
    const [a, b, c] = group('T1', 0);
    const r = scoreMeet(model(swimmers, swims, { splits }), lineup(relay('T1', 'A', [a, b, c, a])), [], preset(), SOURCING);
    expect(r.violations).toContainEqual({ kind: 'relay_leg', entryKey: 'r|T1|400 Freestyle Relay|Men|A', leg: 4, reason: 'duplicate_swimmer' });
  });

  it('a flyover-estimate leg throws instead of scoring', () => {
    const e = relay('T1', 'A', group('T1', 0));
    const legs = [...e.legs] as unknown as { swimmerId: string; basis: unknown }[];
    legs[3] = { swimmerId: legs[3]!.swimmerId, basis: { kind: 'flyover-estimate', swimId: 'x' } };
    expect(scoreCode(() => scoreMeet(model(swimmers, swims, { splits }), lineup({ ...e, legs: legs as never }), [], preset(), SOURCING))).toBe('leg_basis_unsupported');
  });
});

describe("scoreMeet: an over-cap entry under 'removed-from-consideration'", () => {
  const REMOVED = 'removed_over_event_cap';
  const swimmers = [
    { id: 'a1', team: 'T1' }, { id: 'a2', team: 'T1' }, { id: 'a3', team: 'T1' },
    { id: 'b1', team: 'T2' }, { id: 'b2', team: 'T2' },
    { id: 'c1', team: 'T3' },
  ];
  const removedPreset = (opts: Parameters<typeof preset>[0] = {}) => preset({ scorerCap: 2, overCap: 'removed-from-consideration', ...opts });
  const shape = (r: Results, eventKey: string) => rowsOf(r, eventKey).map((x) => [x.swimmerId, x.place, x.points, x.scored, x.notScoredReason ?? null]);

  it('removes the over-cap entry from the places and moves the entries behind it up', () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('a3', '50 Freestyle', 2020), swim('b1', '50 Freestyle', 2030), swim('b2', '50 Freestyle', 2040), swim('c1', '50 Freestyle', 2050)];
    const entries = [ind('T1', 'a1'), ind('T1', 'a2'), ind('T1', 'a3'), ind('T2', 'b1'), ind('T2', 'b2'), ind('T3', 'c1')];
    const removed = scoreMeet(model(swimmers, swims), lineup(...entries), [], removedPreset(), SOURCING);
    expect(shape(removed, '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['a2', 2, 4, true, null],
      ['b1', 3, 3, true, null], // a3 left the places: b1 moves up from 4th (2 points) to 3rd (3)
      ['b2', 4, 2, true, null],
      ['c1', 5, 1, true, null], // 6th held no points; 5th does
      ['a3', null, 0, false, REMOVED], // in Results, no place, no points, and a reason that is not a placed zero
    ]);
    expect(pointsOf(removed, 'T1')).toBe(13);
    expect(pointsOf(removed, 'T2')).toBe(5);
    expect(pointsOf(removed, 'T3')).toBe(1);
  });

  it("'holds-place' is unchanged: the over-cap entry keeps its place and the entries behind it do not move up", () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('a3', '50 Freestyle', 2020), swim('b1', '50 Freestyle', 2030), swim('b2', '50 Freestyle', 2040), swim('c1', '50 Freestyle', 2050)];
    const entries = [ind('T1', 'a1'), ind('T1', 'a2'), ind('T1', 'a3'), ind('T2', 'b1'), ind('T2', 'b2'), ind('T3', 'c1')];
    const held = scoreMeet(model(swimmers, swims), lineup(...entries), [], preset({ scorerCap: 2, overCap: 'holds-place' }), SOURCING);
    expect(shape(held, '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['a2', 2, 4, true, null],
      ['a3', 3, 0, false, 'event_scorer_cap'],
      ['b1', 4, 2, true, null],
      ['b2', 5, 1, true, null],
      ['c1', 6, 0, false, 'outside_point_table'],
    ]);
  });

  it('an unbound cap removes nothing', () => {
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('b1', '50 Freestyle', 2030)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1')), [], removedPreset(), SOURCING);
    expect(shape(r, '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['a2', 2, 4, true, null],
      ['b1', 3, 3, true, null],
    ]);
  });

  it("'split': a removed entry inside a tie group leaves the group, and its tie-mate takes the place alone", () => {
    // a2 and b1 tie for 2nd. T1 is capped at 1, so a2 is removed. b1 holds 2nd by itself and scores the full
    // value of 2nd (4), not half of 2nd and 3rd (3.5). c1 moves up from 4th to 3rd.
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('b1', '50 Freestyle', 2010), swim('c1', '50 Freestyle', 2100)];
    const entries = [ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1'), ind('T3', 'c1')];
    const r = scoreMeet(model(swimmers, swims), lineup(...entries), [], removedPreset({ scorerCap: 1 }), SOURCING);
    expect(shape(r, '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['b1', 2, 4, true, null],
      ['c1', 3, 3, true, null],
      ['a2', null, 0, false, REMOVED],
    ]);
    // The same field under 'holds-place': a2 keeps the shared 2nd place and the tie splits.
    const held = scoreMeet(model(swimmers, swims), lineup(...entries), [], preset({ scorerCap: 1, overCap: 'holds-place' }), SOURCING);
    expect(shape(held, '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['a2', 2, 0, false, 'event_scorer_cap'],
      ['b1', 2, 3.5, true, null],
      ['c1', 4, 2, true, null],
    ]);
  });

  it("'split': a tie between entries that all stay shares the places, with a removal behind it", () => {
    // a1 and b1 tie for 1st and split 9 and 4. a2 is over the cap and removed. c1 moves from 4th to 3rd.
    const swims = [swim('a1', '50 Freestyle', 2000), swim('b1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('c1', '50 Freestyle', 2100)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T2', 'b1'), ind('T1', 'a2'), ind('T3', 'c1')), [], removedPreset({ scorerCap: 1 }), SOURCING);
    expect(shape(r, '50 Freestyle')).toEqual([
      ['a1', 1, 6.5, true, null],
      ['b1', 1, 6.5, true, null],
      ['c1', 3, 3, true, null],
      ['a2', null, 0, false, REMOVED],
    ]);
  });

  it("'ordered': a removed entry leaves the places, and lineup order still breaks the tie among the rest", () => {
    // a2 and b1 tie at 20.10. Entered a2 first, a2 is 2nd, b1 3rd. T1 is capped at 1, so a2 is removed: b1 is 2nd.
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('b1', '50 Freestyle', 2010), swim('c1', '50 Freestyle', 2100)];
    const ordered = (...entries: LineupEntry[]) => scoreMeet(model(swimmers, swims), lineup(...entries), [], removedPreset({ ties: 'ordered', scorerCap: 1 }), SOURCING);
    expect(shape(ordered(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1'), ind('T3', 'c1')), '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['b1', 2, 4, true, null],
      ['c1', 3, 3, true, null],
      ['a2', null, 0, false, REMOVED],
    ]);
    // Entered b1 first, b1 is 2nd and a2 3rd; a2 is still over T1's cap, so it is removed and c1 is 3rd.
    expect(shape(ordered(ind('T1', 'a1'), ind('T2', 'b1'), ind('T1', 'a2'), ind('T3', 'c1')), '50 Freestyle')).toEqual([
      ['a1', 1, 9, true, null],
      ['b1', 2, 4, true, null],
      ['c1', 3, 3, true, null],
      ['a2', null, 0, false, REMOVED],
    ]);
  });

  it('diving with its own cap removes the over-cap diver and moves the field up', () => {
    const swims = [diveSwim('a1', 300), diveSwim('a2', 290), diveSwim('b1', 280), diveSwim('a3', 270), swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('a3', '50 Freestyle', 2020)];
    const dives = [ind('T1', 'a1', '1-Meter Diving'), ind('T1', 'a2', '1-Meter Diving'), ind('T2', 'b1', '1-Meter Diving'), ind('T1', 'a3', '1-Meter Diving')];
    const swum = [ind('T1', 'a1'), ind('T1', 'a2'), ind('T1', 'a3')];
    const r = scoreMeet(model(swimmers, swims), lineup(...dives, ...swum), [], preset({ divingCap: { cap: 1, overCap: 'removed-from-consideration' } }), SOURCING);
    expect(shape(r, '1-Meter Diving')).toEqual([
      ['a1', 1, 9, true, null],
      ['b1', 2, 4, true, null], // a2 left the places: b1 moves up from 3rd to 2nd
      ['a2', null, 0, false, REMOVED],
      ['a3', null, 0, false, REMOVED],
    ]);
    // The swimming cap is unlimited, so the swimming event is untouched.
    expect(shape(r, '50 Freestyle').map((x) => x[2])).toEqual([9, 4, 3]);
  });

  it("diving 'same-as-swimming' follows the swimming cap's behavior", () => {
    const swims = [diveSwim('a1', 300), diveSwim('a2', 290), diveSwim('b1', 280)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1', '1-Meter Diving'), ind('T1', 'a2', '1-Meter Diving'), ind('T2', 'b1', '1-Meter Diving')), [], removedPreset({ scorerCap: 1 }), SOURCING);
    expect(shape(r, '1-Meter Diving')).toEqual([
      ['a1', 1, 9, true, null],
      ['b1', 2, 4, true, null],
      ['a2', null, 0, false, REMOVED],
    ]);
  });

  it("diving 'own' with 'holds-place' is unchanged while swimming is unlimited", () => {
    const swims = [diveSwim('a1', 300), diveSwim('a2', 290), diveSwim('b1', 280)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1', '1-Meter Diving'), ind('T1', 'a2', '1-Meter Diving'), ind('T2', 'b1', '1-Meter Diving')), [], preset({ divingCap: { cap: 1, overCap: 'holds-place' } }), SOURCING);
    expect(shape(r, '1-Meter Diving')).toEqual([
      ['a1', 1, 9, true, null],
      ['a2', 2, 0, false, 'event_scorer_cap'],
      ['b1', 3, 3, true, null],
    ]);
  });

  describe('relays', () => {
    const ids = (team: string, n: number) => Array.from({ length: n }, (_, i) => `${team}-${i}`);
    const relaySwimmers = [...ids('T1', 12), ...ids('T2', 4)].map((id) => ({ id, team: id.slice(0, 2) }));
    const swims: MeetSwim[] = [];
    const splits: RelaySplit[] = [];
    const base: Record<string, number> = { T1: 2000, T2: 2300 };
    relaySwimmers.forEach((s, i) => {
      const flat = base[s.team]! + i * 10;
      swims.push(swim(s.id, '100 Freestyle', flat));
      flatOf.set(s.id, flat);
      splits.push(split(s.id, flat - 100));
    });
    const group = (team: string, g: number): [string, string, string, string] => [0, 1, 2, 3].map((k) => `${team}-${g * 4 + k}`) as [string, string, string, string];
    const entries = [relay('T1', 'A', group('T1', 0)), relay('T1', 'B', group('T1', 1)), relay('T1', 'C', group('T1', 2)), relay('T2', 'A', group('T2', 0))];

    // A relay over its cap follows scorers.relayOverCap (README R67), never the swimming cap's overCap. Under
    // 'holds-place' it keeps its place whatever the swimming cap says. The 'exhibition' case is in its own describe below.
    it("relayOverCap 'holds-place': a relay over its cap holds its place even when the swimming cap's overCap is 'removed-from-consideration'", () => {
      const r = scoreMeet(model(relaySwimmers, swims, { splits }), lineup(...entries), [], preset({ relayCap: 2, relayOverCap: 'holds-place', scorerCap: 5, overCap: 'removed-from-consideration' }), SOURCING);
      expect(rowsOf(r, '400 Freestyle Relay').map((x) => [x.entryKey, x.place, x.points, x.notScoredReason ?? null])).toEqual([
        ['r|T1|400 Freestyle Relay|Men|A', 1, 11, null],
        ['r|T1|400 Freestyle Relay|Men|B', 2, 4, null],
        ['r|T1|400 Freestyle Relay|Men|C', 3, 0, 'relay_scorer_cap'],
        ['r|T2|400 Freestyle Relay|Men|A', 4, 0, 'outside_point_table'],
      ]);
    });
  });

  it('the engine, not the legacy scorer, removes: a removed entry never reaches legacy with a place', () => {
    // Legacy `shiftRanksAfterRemoval` restores source ranks, so only the engine reports place 2 for b1 here.
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('b1', '50 Freestyle', 2020)];
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1')), [], removedPreset({ scorerCap: 1 }), SOURCING);
    expect(rowsOf(r, '50 Freestyle').find((x) => x.swimmerId === 'b1')?.place).toBe(2);
    expect(rowsOf(r, '50 Freestyle').find((x) => x.swimmerId === 'a2')).toMatchObject({ place: null, notScoredReason: REMOVED });
  });
});

describe('scoreMeet: a relay over the scoring limit under relayOverCap (README R67)', () => {
  const EXHIBITION = 'exhibition';
  const RELAY_EVENT = '400 Freestyle Relay';
  type Spec = { team: string; letter: string; t: number };

  /**
   * A relay field with exact total times. Each relay has its own four swimmers, every leg at `t` hundredths
   * (a flat start for leg 1, a split for legs 2 to 4), so the relay's time is 4t. The relay table is 11-4-2.
   */
  function relayField(specs: readonly Spec[]) {
    const swimmers: Swimmer[] = [];
    const swims: MeetSwim[] = [];
    const splits: RelaySplit[] = [];
    const entries: LineupEntry[] = [];
    for (const { team, letter, t } of specs) {
      const ids = [0, 1, 2, 3].map((k) => `${team}${letter}-${k}`) as [string, string, string, string];
      for (const id of ids) {
        swimmers.push({ id, team });
        swims.push(swim(id, '100 Freestyle', t));
        flatOf.set(id, t);
        splits.push(split(id, t));
      }
      entries.push(relay(team, letter, ids));
    }
    return { swimmers, swims, splits, entries };
  }

  /** `order` names the relays (`T1A`) in lineup order. Without it the lineup follows `specs`. */
  const run = (specs: readonly Spec[], p: CompleteRulePreset, order?: readonly string[]) => {
    const f = relayField(specs);
    const entries = order
      ? order.map((name) => f.entries.find((e) => e.kind === 'relay' && `${e.teamId}${e.letter}` === name) as LineupEntry)
      : f.entries;
    return scoreMeet(model(f.swimmers, f.swims, { splits: f.splits }), lineup(...entries), [], p, SOURCING);
  };
  const nameOf = (entryKey: string): string => `${entryKey.split('|')[1]}${entryKey.slice(-1)}`;
  const shapeOf = (r: Results) => rowsOf(r, RELAY_EVENT).map((x) => [nameOf(x.entryKey), x.place, x.points, x.notScoredReason ?? null]);
  const FIELD: Spec[] = [
    { team: 'T1', letter: 'A', t: 2000 },
    { team: 'T1', letter: 'B', t: 2050 },
    { team: 'T1', letter: 'C', t: 2100 },
    { team: 'T2', letter: 'A', t: 2200 },
    { team: 'T3', letter: 'A', t: 2300 },
  ];

  it("'exhibition' removes the over-limit relay and the relays behind it move up", () => {
    const r = run(FIELD, preset({ relayCap: 2, relayOverCap: 'exhibition' }));
    expect(shapeOf(r)).toEqual([
      ['T1A', 1, 11, null],
      ['T1B', 2, 4, null],
      ['T2A', 3, 2, null], // T1 C left the places: T2 A moves from 4th (outside the table) to 3rd
      ['T3A', 4, 0, 'outside_point_table'],
      ['T1C', null, 0, EXHIBITION], // in Results, no place, no points, reason exhibition
    ]);
    expect(pointsOf(r, 'T1')).toBe(15);
    expect(pointsOf(r, 'T2')).toBe(2);
  });

  it("'holds-place' is unchanged: the over-limit relay keeps its place, scores 0, and nobody moves up", () => {
    const r = run(FIELD, preset({ relayCap: 2, relayOverCap: 'holds-place' }));
    expect(shapeOf(r)).toEqual([
      ['T1A', 1, 11, null],
      ['T1B', 2, 4, null],
      ['T1C', 3, 0, 'relay_scorer_cap'],
      ['T2A', 4, 0, 'outside_point_table'],
      ['T3A', 5, 0, 'outside_point_table'],
    ]);
    expect(pointsOf(r, 'T2')).toBe(0);
  });

  it('which relays are over the limit does not depend on the treatment', () => {
    const over = (relayOverCap: 'holds-place' | 'exhibition') =>
      rowsOf(run(FIELD, preset({ relayCap: 2, relayOverCap })), RELAY_EVENT)
        .filter((x) => x.notScoredReason === 'relay_scorer_cap' || x.notScoredReason === EXHIBITION)
        .map((x) => x.entryKey);
    expect(over('exhibition')).toEqual(over('holds-place'));
    expect(over('exhibition')).toEqual(['r|T1|400 Freestyle Relay|Men|C']);
  });

  it("an unlimited relay cap removes nothing under 'exhibition'", () => {
    const r = run(FIELD, preset({ relayCap: 'unlimited', relayOverCap: 'exhibition' }));
    expect(shapeOf(r)).toEqual([
      ['T1A', 1, 11, null],
      ['T1B', 2, 4, null],
      ['T1C', 3, 2, null],
      ['T2A', 4, 0, 'outside_point_table'],
      ['T3A', 5, 0, 'outside_point_table'],
    ]);
  });

  describe('ties', () => {
    // T1 C (over the limit) ties T2 A at 21.00 a leg.
    const TIED: Spec[] = [
      { team: 'T1', letter: 'A', t: 2000 },
      { team: 'T1', letter: 'B', t: 2050 },
      { team: 'T1', letter: 'C', t: 2100 },
      { team: 'T2', letter: 'A', t: 2100 },
      { team: 'T3', letter: 'A', t: 2300 },
    ];
    // T1 C is over the limit at 3rd. T2 A and T3 A tie for 4th, so the removal moves the tie into the table.
    const STAY: Spec[] = [
      { team: 'T1', letter: 'A', t: 2000 },
      { team: 'T1', letter: 'B', t: 2010 },
      { team: 'T1', letter: 'C', t: 2020 },
      { team: 'T2', letter: 'A', t: 2030 },
      { team: 'T3', letter: 'A', t: 2030 },
    ];

    it("'split': the removed relay leaves its tie group, so its tie-mate takes the whole place", () => {
      const ex = run(TIED, preset({ ties: 'split', relayCap: 2, relayOverCap: 'exhibition' }));
      expect(shapeOf(ex)).toEqual([
        ['T1A', 1, 11, null],
        ['T1B', 2, 4, null],
        ['T2A', 3, 2, null],
        ['T3A', 4, 0, 'outside_point_table'],
        ['T1C', null, 0, EXHIBITION],
      ]);
      // Under 'holds-place' the tie group stays: C and T2 A share 3rd.
      const held = run(TIED, preset({ ties: 'split', relayCap: 2, relayOverCap: 'holds-place' }));
      expect(shapeOf(held).map((x) => x.slice(0, 2))).toEqual([['T1A', 1], ['T1B', 2], ['T1C', 3], ['T2A', 3], ['T3A', 5]]);
    });

    it("'split': a tie that stays moves up into the table together and splits the place it reaches", () => {
      const r = run(STAY, preset({ ties: 'split', relayCap: 2, relayOverCap: 'exhibition' }));
      // 3rd place is worth 2 and 4th is outside the table: the shared 3rd place pays (2 + 0) / 2 each.
      expect(shapeOf(r)).toEqual([
        ['T1A', 1, 11, null],
        ['T1B', 2, 4, null],
        ['T2A', 3, 1, null],
        ['T3A', 3, 1, null],
        ['T1C', null, 0, EXHIBITION],
      ]);
      const held = run(STAY, preset({ ties: 'split', relayCap: 2, relayOverCap: 'holds-place' }));
      expect(shapeOf(held).map((x) => x.slice(0, 3))).toEqual([['T1A', 1, 11], ['T1B', 2, 4], ['T1C', 3, 0], ['T2A', 4, 0], ['T3A', 4, 0]]);
    });

    it("'ordered': the removed relay leaves the places, and lineup order still breaks a tie that stays", () => {
      // C is entered before T2 A, so C is 3rd and T2 A 4th. C is removed: T2 A is 3rd.
      const ex = run(TIED, preset({ ties: 'ordered', relayCap: 2, relayOverCap: 'exhibition' }), ['T1A', 'T1B', 'T1C', 'T2A', 'T3A']);
      expect(shapeOf(ex)).toEqual([
        ['T1A', 1, 11, null],
        ['T1B', 2, 4, null],
        ['T2A', 3, 2, null],
        ['T3A', 4, 0, 'outside_point_table'],
        ['T1C', null, 0, EXHIBITION],
      ]);
      // The tie between T2 A and T3 A stays after the removal: lineup order decides who takes 3rd.
      const p = preset({ ties: 'ordered', relayCap: 2, relayOverCap: 'exhibition' });
      expect(shapeOf(run(STAY, p, ['T1A', 'T1B', 'T1C', 'T2A', 'T3A']))).toEqual([
        ['T1A', 1, 11, null],
        ['T1B', 2, 4, null],
        ['T2A', 3, 2, null],
        ['T3A', 4, 0, 'outside_point_table'],
        ['T1C', null, 0, EXHIBITION],
      ]);
      expect(shapeOf(run(STAY, p, ['T1A', 'T1B', 'T1C', 'T3A', 'T2A'])).slice(2, 4)).toEqual([
        ['T3A', 3, 2, null],
        ['T2A', 4, 0, 'outside_point_table'],
      ]);
    });
  });

  // D2 9.8: under 'exhibition' every relay after a team's first `relayCap` leaves the places, past the table or
  // not. Before the fix T1 D (4th, past the 3-place table) took no cap slot, moved into 3rd once T1 C was removed,
  // and held it with 0 points, so T2 A lost its 2 points.
  it("a team's 4th relay, ranked past the table, is also exhibition and does not take the place the removal opens", () => {
    const field: Spec[] = [
      { team: 'T1', letter: 'A', t: 2000 },
      { team: 'T1', letter: 'B', t: 2010 },
      { team: 'T1', letter: 'C', t: 2020 },
      { team: 'T1', letter: 'D', t: 2030 },
      { team: 'T2', letter: 'A', t: 2040 },
    ];
    const r = run(field, preset({ relayCap: 2, relayOverCap: 'exhibition' }));
    expect(shapeOf(r)).toEqual([
      ['T1A', 1, 11, null],
      ['T1B', 2, 4, null],
      ['T2A', 3, 2, null],
      ['T1C', null, 0, EXHIBITION],
      ['T1D', null, 0, EXHIBITION],
    ]);
  });

  it('only relays are affected: an individual entry over its cap follows its own rule', () => {
    // The swimming cap holds the place. relayOverCap 'exhibition' removes relays only.
    const swimmers = [{ id: 'a1', team: 'T1' }, { id: 'a2', team: 'T1' }, { id: 'b1', team: 'T2' }];
    const swims = [swim('a1', '50 Freestyle', 2000), swim('a2', '50 Freestyle', 2010), swim('b1', '50 Freestyle', 2020)];
    const p = preset({ scorerCap: 1, overCap: 'holds-place', relayCap: 2, relayOverCap: 'exhibition' });
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a2'), ind('T2', 'b1')), [], p, SOURCING);
    expect(rowsOf(r, '50 Freestyle').map((x) => [x.swimmerId, x.place, x.points, x.notScoredReason ?? null])).toEqual([
      ['a1', 1, 9, null],
      ['a2', 2, 0, 'event_scorer_cap'],
      ['b1', 3, 3, null],
    ]);
  });

  it('a relay removed as exhibition is not a no_time row and not a removed individual entry', () => {
    const r = run(FIELD, preset({ relayCap: 2, relayOverCap: 'exhibition' }));
    const noPlace = rowsOf(r, RELAY_EVENT).filter((x) => x.place === null);
    expect(noPlace).toHaveLength(1);
    expect(noPlace[0]).toMatchObject({ points: 0, scored: false, notScoredReason: 'exhibition' });
  });

  it('a pending relayOverCap stops requireComplete, so scoreMeet is never reached with it', () => {
    const p = preset({ relayCap: 2 });
    const pendingPreset = { ...p, scorers: { ...p.scorers, relayOverCap: { state: 'pending' as const, question: 'q', blocks: [] } } };
    expect(() => requireComplete(pendingPreset)).toThrow(/scorers\.relayOverCap/);
  });
});

describe('F17: the engine never reaches the legacy relay cap fallback', () => {
  // relayScoring.ts reads `merged.maxRelaysScoringPerTeam ?? 2`. The engine path always writes the key.
  it('toLegacyScoringSettings writes maxRelaysScoringPerTeam for unlimited, a number and the NSISC preset', () => {
    const keyOf = (p: CompleteRulePreset) => {
      const settings = toLegacyScoringSettings(p, { ranksAreDistinct: true });
      expect(Object.hasOwn(settings, 'maxRelaysScoringPerTeam')).toBe(true);
      return settings.maxRelaysScoringPerTeam;
    };
    expect(keyOf(preset({ relayCap: 'unlimited' }))).toBe(LEGACY_UNLIMITED);
    expect(keyOf(preset({ relayCap: 3 }))).toBe(3);
    expect(typeof keyOf(completeNsisc())).toBe('number');
  });

  it("an unlimited relay cap lets a team's third relay score: a `?? 2` fallback would have stopped it", () => {
    const ids = (team: string, n: number) => Array.from({ length: n }, (_, i) => `${team}-${i}`);
    const swimmers = [...ids('T1', 12), ...ids('T2', 4)].map((id) => ({ id, team: id.slice(0, 2) }));
    const swims: MeetSwim[] = [];
    const splits: RelaySplit[] = [];
    const base: Record<string, number> = { T1: 2000, T2: 2300 };
    swimmers.forEach((s, i) => {
      const flat = base[s.team]! + i * 10;
      swims.push(swim(s.id, '100 Freestyle', flat));
      flatOf.set(s.id, flat);
      splits.push(split(s.id, flat - 100));
    });
    const group = (team: string, g: number): [string, string, string, string] => [0, 1, 2, 3].map((k) => `${team}-${g * 4 + k}`) as [string, string, string, string];
    const entries = [relay('T1', 'A', group('T1', 0)), relay('T1', 'B', group('T1', 1)), relay('T1', 'C', group('T1', 2))];
    const r = scoreMeet(model(swimmers, swims, { splits }), lineup(...entries), [], preset({ relayCap: 'unlimited' }), SOURCING);
    expect(rowsOf(r, '400 Freestyle Relay').map((x) => x.points)).toEqual([11, 4, 2]);
  });
});

describe('scoreMeet: entry limits and the roster', () => {
  const swimmers = [{ id: 'a1', team: 'T1' }, { id: 'b1', team: 'T2' }];
  const swims = [swim('a1', '50 Freestyle', 2000), swim('a1', '100 Freestyle', 4500), swim('b1', '50 Freestyle', 2100), swim('b1', '100 Freestyle', 4600)];

  it('a swimmer over the individual-entry limit is flagged, and still scores', () => {
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T1', 'a1', '100 Freestyle'), ind('T2', 'b1')), [], preset({ maxInd: 1 }), SOURCING);
    expect(r.violations).toContainEqual({ kind: 'entry_cap', swimmerId: 'a1', which: 'individual', count: 2, limit: 1 });
    expect(r.violations.filter((v) => v.kind === 'entry_cap')).toHaveLength(1);
    expect(pointsOf(r, 'T1')).toBe(9 + 9);
  });

  it('at the limit there is no violation', () => {
    const r = scoreMeet(model(swimmers, swims), lineup(ind('T1', 'a1'), ind('T2', 'b1')), [], preset({ maxInd: 1 }), SOURCING);
    expect(r.violations).toEqual([]);
  });

  it('a swimmer who is not on the roster throws; an unknown one is listed', () => {
    const out = model([{ id: 'a1', team: 'T1', roster: 'not_member' }], [swim('a1', '50 Freestyle', 2000)]);
    expect(scoreCode(() => scoreMeet(out, lineup(ind('T1', 'a1')), [], preset(), SOURCING))).toBe('roster_not_member');
    const unsure = model([{ id: 'a1', team: 'T1', roster: 'unknown' }, { id: 'a0', team: 'T1' }], [swim('a1', '50 Freestyle', 2000)]);
    const r = scoreMeet(unsure, lineup(ind('T1', 'a1')), [], preset(), SOURCING);
    expect(r.rosterUnknown).toEqual(['a1']);
  });

  it('roster eligibility and tags under points_pool each throw', () => {
    const m = model(swimmers, swims);
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'a1')), [], preset({ eligibility: 'roster' }), SOURCING))).toBe('roster_mode_unsupported');
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'a1')), [{ teamId: 'T1', swimmerId: 'a1', role: 'scorer' }], preset(), SOURCING))).toBe('tags_need_roster_mode');
  });

  it('refuses a lineup for another meet, a duplicate entry, a swimmer on the wrong team and the wrong gender', () => {
    const m = model(swimmers, swims);
    expect(scoreCode(() => scoreMeet(m, { ...lineup(ind('T1', 'a1')), meetKey: 'other' }, [], preset(), SOURCING))).toBe('meet_key_mismatch');
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'a1'), ind('T1', 'a1')), [], preset(), SOURCING))).toBe('duplicate_entry');
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T2', 'a1')), [], preset(), SOURCING))).toBe('team_mismatch');
    const women = model([{ id: 'w1', team: 'T1', gender: 'Women' }], []);
    expect(scoreCode(() => scoreMeet(women, lineup(ind('T1', 'w1')), [], preset(), SOURCING))).toBe('gender_mismatch');
  });

  it('a pinned seed swim of another swimmer is refused', () => {
    const m = model(swimmers, swims);
    const pinned: LineupEntry = { ...(ind('T1', 'a1') as Extract<LineupEntry, { kind: 'individual' }>), seedSwimId: swims[2]!.swimId };
    expect(scoreCode(() => scoreMeet(m, lineup(pinned), [], preset(), SOURCING))).toBe('seed_mismatch');
  });

  it('an extracted split is never picked by the engine, but a pinned seed is honored', () => {
    const lead = swim('a1', '50 Freestyle', 1900, { swimId: 'lead-1', flags: { extractedSplit: true } });
    const m = model(swimmers, [lead, swim('a1', '50 Freestyle', 2000), swim('b1', '50 Freestyle', 1950)]);
    const free = scoreMeet(m, lineup(ind('T1', 'a1'), ind('T2', 'b1')), [], preset(), SOURCING);
    expect(rowsOf(free, '50 Freestyle').map((x) => [x.swimmerId, x.points])).toEqual([['b1', 9], ['a1', 4]]);
    const pinned = scoreMeet(m, lineup({ ...(ind('T1', 'a1') as Extract<LineupEntry, { kind: 'individual' }>), seedSwimId: 'lead-1' }, ind('T2', 'b1')), [], preset(), SOURCING);
    expect(rowsOf(pinned, '50 Freestyle').map((x) => [x.swimmerId, x.points])).toEqual([['a1', 9], ['b1', 4]]);
  });
});

// ---- validateMeetModel -------------------------------------------------------------------------

describe('validateMeetModel', () => {
  const good = (): MeetModel => model([{ id: 'a1', team: 'T1' }, { id: 'b1', team: 'T2' }], [swim('a1', '50 Freestyle', 2000), swim('b1', '50 Freestyle', 2100)], { display: true });
  const edit = (fn: (m: any) => void): unknown => {
    const m = structuredClone(good()) as unknown;
    fn(m);
    return m;
  };
  function failure(input: unknown): { code: string; path: string } {
    try {
      validateMeetModel(input);
    } catch (error) {
      if (error instanceof MeetModelError) return { code: error.code, path: error.path };
      throw error;
    }
    return { code: 'did not throw', path: '' };
  }

  it('accepts a well-formed model and returns it unchanged', () => {
    const m = good();
    expect(validateMeetModel(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it('refuses a missing key, an unknown key and a wrong payload version', () => {
    expect(failure(edit((m) => delete m.swims))).toEqual({ code: 'missing', path: 'model.swims' });
    expect(failure(edit((m) => (m.surprise = 1))).code).toBe('invalid');
    expect(failure(edit((m) => (m.payloadVersion = 2)))).toEqual({ code: 'invalid', path: 'model.payloadVersion' });
  });

  it('refuses duplicate ids', () => {
    expect(failure(edit((m) => m.teams.push(m.teams[0]))).code).toBe('duplicate');
    expect(failure(edit((m) => m.swimmers.push(m.swimmers[0]))).code).toBe('duplicate');
    expect(failure(edit((m) => m.swims.push(m.swims[0]))).code).toBe('duplicate');
    expect(failure(edit((m) => m.events.push(m.events[0]))).code).toBe('duplicate');
  });

  it('refuses references that do not resolve', () => {
    expect(failure(edit((m) => (m.swimmers[0].teamId = 'nope')))).toMatchObject({ code: 'unresolved', path: 'model.swimmers[0].teamId' });
    expect(failure(edit((m) => (m.swims[0].swimmerId = 'nope')))).toMatchObject({ code: 'unresolved', path: 'model.swims[0].swimmerId' });
    expect(failure(edit((m) => (m.swims[0].eventKey = '999 Freestyle')))).toMatchObject({ code: 'unresolved', path: 'model.swims[0].eventKey' });
    expect(failure(edit((m) => (m.observedScores = [{ teamId: 'nope', points: 1 }]))).code).toBe('unresolved');
    expect(failure(edit((m) => (m.display.swimmers.nope = { name: 'x' }))).code).toBe('unresolved');
  });

  it('refuses a swim in an event of the other gender, and a swim in a relay', () => {
    expect(
      failure(
        edit((m) => {
          m.events.push({ ...EVENT_50, gender: 'Women' });
          m.swims[0].eventKey = '50 Freestyle';
          m.swimmers[0].gender = 'Women';
          m.events = m.events.filter((e: MeetEvent) => !(e.eventKey === '50 Freestyle' && e.gender === 'Men'));
          m.swimmers[0].gender = 'Men';
        })
      ).code
    ).toBe('gender_mismatch');
    expect(failure(edit((m) => (m.swims[0].eventKey = '400 Freestyle Relay')))).toMatchObject({ code: 'inconsistent', path: 'model.swims[0].eventKey' });
  });

  it('refuses a converted statement on a recorded SCY swim, and a time whose text disagrees with its hundredths', () => {
    expect(
      failure(
        edit((m) => {
          m.swims[0].scy = { kind: 'converted', hundredths: 1999, estimated: true, basis: { method: 'swimcloud', displayedText: '19.99' } };
        })
      )
    ).toMatchObject({ code: 'inconsistent', path: 'model.swims[0].scy' });
    expect(failure(edit((m) => (m.swims[0].recordedTime.hundredths = 2001)))).toMatchObject({ code: 'inconsistent', path: 'model.swims[0].recordedTime.text' });
  });

  it('refuses a recorded-scy statement on a non-SCY swim', () => {
    expect(failure(edit((m) => (m.swims[0].recordedCourse = 'LCM')))).toMatchObject({ code: 'inconsistent', path: 'model.swims[0].scy' });
  });

  it('refuses a flag that is not the literal true, and an event with an impossible shape', () => {
    expect(failure(edit((m) => (m.swims[0].flags = { exhibition: false }))).code).toBe('invalid');
    expect(failure(edit((m) => (m.events[0].relayKind = 'medley'))).code).toBe('inconsistent');
    expect(failure(edit((m) => (m.events[2].distanceYards = 10))).code).toBe('inconsistent');
  });

  it('a dive score is not read back as a time', () => {
    const m = edit((x) => {
      x.swims.push({ ...x.swims[0], swimId: 'dive-1', swimmerId: 'a1', eventKey: '1-Meter Diving', recordedTime: { text: '451.28', hundredths: 45128 } });
    });
    expect(failure(m).code).toBe('did not throw');
  });

  it('refuses garbage that is not an object', () => {
    for (const bad of [null, undefined, 'x', 3, []]) expect(failure(bad).code, String(bad)).toBe('invalid');
  });
});
