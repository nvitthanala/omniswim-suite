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
import { set } from './engineTestPresets';

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
function preset(opts: { ties?: 'split' | 'ordered'; scorerCap?: number; relayCap?: number | 'unlimited'; maxInd?: number | 'unlimited'; eligibility?: 'points_pool' | 'roster'; overCap?: 'holds-place' | 'removed-from-consideration' } = {}): CompleteRulePreset {
  const p: RulePreset = {
    payloadVersion: 2,
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
      divingPerEventScorerCap: set({ kind: 'same-as-swimming' as const }),
      scoringRelaysPerTeamPerEvent: set(opts.relayCap ?? 'unlimited'),
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

  it('roster eligibility, tags under points_pool, and a removed-from-consideration cap each throw', () => {
    const m = model(swimmers, swims);
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'a1')), [], preset({ eligibility: 'roster' }), SOURCING))).toBe('roster_mode_unsupported');
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'a1')), [{ teamId: 'T1', swimmerId: 'a1', role: 'scorer' }], preset(), SOURCING))).toBe('tags_need_roster_mode');
    expect(scoreCode(() => scoreMeet(m, lineup(ind('T1', 'a1')), [], preset({ scorerCap: 1, overCap: 'removed-from-consideration' }), SOURCING))).toBe('placement_unsupported');
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
