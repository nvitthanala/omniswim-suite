/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `scoreMeet` under `scorers.eligibility: 'roster'` (P3.core-b; README R9, R24, R28, R37, R41, R65,
 * R70 to R72; D2-ENGINE-API.md section 9). The scoring roster is the coach's tags and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { builtinRulePreset, requireComplete, ScoreMeetError, scoreMeet } from '@omniswim/engine';
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
  ScorerRole,
  ScorerTag,
} from '@omniswim/engine';
import { set } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const FREE = '100 Freestyle';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';

const EVENTS: MeetEvent[] = [
  { eventKey: FREE, gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null },
  { eventKey: DIVE, gender: 'Men', kind: 'diving', distanceYards: null, relayKind: null },
  { eventKey: RELAY, gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' },
  { eventKey: FREE, gender: 'Women', kind: 'individual', distanceYards: 100, relayKind: null },
];

// ---- builders ----------------------------------------------------------------------------------

interface Spec {
  id: string;
  team: string;
  gender?: 'Men' | 'Women';
  /** The swimmer's 100 Free in hundredths. Default 5000. It is also the flat start and the split basis of every relay leg. */
  free?: number;
  /** A dive score in hundredths of a point, when the swimmer dives. */
  dive?: number;
  roster?: 'member' | 'not_member' | 'unknown';
}

function build(specs: Spec[]): { model: MeetModel } {
  const swims: MeetSwim[] = [];
  const splits: RelaySplit[] = [];
  for (const s of specs) {
    const free = s.free ?? 5000;
    swims.push({
      swimId: `${s.id}:free`,
      swimmerId: s.id,
      eventKey: FREE,
      recordedCourse: 'SCY',
      recordedTime: { text: (free / 100).toFixed(2), hundredths: free },
      date: null,
      seasonId: null,
      flags: {},
      scy: { kind: 'recorded-scy' },
      origin: ORIGIN,
    });
    if (s.dive !== undefined) {
      swims.push({
        swimId: `${s.id}:dive`,
        swimmerId: s.id,
        eventKey: DIVE,
        recordedCourse: 'SCY',
        recordedTime: { text: (s.dive / 100).toFixed(2), hundredths: s.dive },
        date: null,
        seasonId: null,
        flags: {},
        scy: { kind: 'recorded-scy' },
        origin: ORIGIN,
      });
    }
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
    model: {
      payloadVersion: 1,
      meetKey: 'synthetic',
      teams: teamIds.map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
      swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? 'Men', classYear: null, roster: s.roster ?? 'member' })),
      events: EVENTS,
      swims,
      relaySplits: splits,
      recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
      extendedWindow: false,
      observedScores: null,
    },
  };
}

const free = (team: string, swimmerId: string, gender: 'Men' | 'Women' = 'Men'): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey: FREE, gender, seedSwimId: null });
const dive = (team: string, swimmerId: string): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey: DIVE, gender: 'Men', seedSwimId: null });
const relay = (team: string, letter: string, ids: readonly [string, string, string, string]): LineupEntry => ({
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

/** nsisc v3 with the settings a test names changed. Every other setting is the shipped one. */
function nsisc(opts: {
  nonScorer?: 'holds-place' | 'removed-from-consideration';
  mustBeScorers?: boolean;
  size?: number | 'unlimited';
  scope?: 'meet' | 'event';
  weight?: { numerator: number; denominator: number };
  eventCap?: { cap: number; overCap: 'holds-place' | 'removed-from-consideration' };
  relayCap?: number | 'unlimited';
  ties?: 'split' | 'ordered';
  maxInd?: number | 'unlimited';
  maxRelay?: number | 'unlimited';
  maxTotal?: number | 'unlimited';
} = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 3) as RulePreset;
  const p: RulePreset = {
    ...base,
    scoring: {
      ...base.scoring,
      ...(opts.nonScorer ? { nonScorerPlacement: set(opts.nonScorer) } : {}),
      ...(opts.ties ? { ties: set(opts.ties) } : {}),
    },
    scorers: {
      ...base.scorers,
      ...(opts.mustBeScorers === undefined ? {} : { relayLegsMustBeScorers: set(opts.mustBeScorers) }),
      ...(opts.size === undefined ? {} : { scoringTeamSize: set(opts.size) }),
      ...(opts.scope ? { scoringTeamScope: set(opts.scope) } : {}),
      ...(opts.weight ? { diverWeight: set(opts.weight) } : {}),
      ...(opts.eventCap ? { perEventScorerCap: set(opts.eventCap) } : {}),
      ...(opts.relayCap === undefined ? {} : { scoringRelaysPerTeamPerEvent: set(opts.relayCap) }),
    },
    entries: {
      ...base.entries,
      ...(opts.maxInd === undefined ? {} : { maxIndividualPerSwimmer: set(opts.maxInd) }),
      ...(opts.maxRelay === undefined ? {} : { maxRelayPerSwimmer: set(opts.maxRelay) }),
      ...(opts.maxTotal === undefined ? {} : { maxTotalPerSwimmer: set(opts.maxTotal) }),
    },
  };
  return requireComplete(p);
}

const IND = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

const rowsOf = (r: Results, eventKey: string, gender = 'Men') => r.events.find((e) => e.eventKey === eventKey && e.gender === gender)?.rows ?? [];
const swimmerOf = (entryKey: string): string => entryKey.split('|')[2] as string;
/** `[swimmer, place, points, reason]` per row, in place order. */
const shape = (r: Results, eventKey = FREE) => rowsOf(r, eventKey).map((x) => [swimmerOf(x.entryKey), x.place, x.points, x.notScoredReason ?? null]);
const relayShape = (r: Results) => rowsOf(r, RELAY).map((x) => [`${x.entryKey.split('|')[1]}${x.entryKey.slice(-1)}`, x.place, x.points, x.notScoredReason ?? null]);
const pointsOf = (r: Results, team: string) => r.teams.find((t) => t.teamId === team)?.points;

function failure(fn: () => unknown): ScoreMeetError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScoreMeetError) return error;
    throw error;
  }
  throw new Error('did not throw');
}

// ---- tests -------------------------------------------------------------------------------------

describe('scoreMeet under roster eligibility: the scoring roster is the coach tags', () => {
  it('10 scoring-roster swimmers of one team in one event all score under an unlimited per-event cap (plan F2)', () => {
    const t1 = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, team: 'T1', free: 4000 + i * 10 }));
    const t2 = [{ id: 'b0', team: 'T2', free: 4500 }, { id: 'b1', team: 'T2', free: 4510 }];
    const { model } = build([...t1, ...t2]);
    const entries = [...t1.map((s) => free('T1', s.id)), ...t2.map((s) => free('T2', s.id))];
    const r = scoreMeet(model, lineup(...entries), [...tags('T1', t1.map((s) => s.id)), ...tags('T2', ['b0', 'b1'])], nsisc(), SOURCING);
    const t1Rows = rowsOf(r, FREE).filter((x) => x.teamId === 'T1');
    expect(t1Rows).toHaveLength(10);
    expect(t1Rows.every((x) => x.scored)).toBe(true);
    expect(rowsOf(r, FREE).map((x) => x.points)).toEqual(IND.slice(0, 12));
    expect(r.violations).toEqual([]);
  });

  it('an untagged swimmer is a non-scorer; the scorer behind moves up (README R41 example)', () => {
    // T1-ns (untagged) wins the 100 Free. T2-sc, a scorer, is 2nd and earns 1st-place points.
    const { model } = build([
      { id: 'ns', team: 'T1', free: 4000 },
      { id: 'sc1', team: 'T1', free: 4800 },
      { id: 'sc2', team: 'T2', free: 4100 },
    ]);
    const r = scoreMeet(model, lineup(free('T1', 'ns'), free('T1', 'sc1'), free('T2', 'sc2')), [tag('T1', 'sc1'), tag('T2', 'sc2')], nsisc(), SOURCING);
    expect(shape(r)).toEqual([
      ['sc2', 1, 20, null],
      ['sc1', 2, 17, null],
      ['ns', null, 0, 'non_scorer'],
    ]);
    expect(pointsOf(r, 'T2')).toBe(20);
    expect(pointsOf(r, 'T1')).toBe(17);
  });

  it("role 'non-scorer' behaves as untagged", () => {
    const { model } = build([{ id: 'ns', team: 'T1', free: 4000 }, { id: 'sc1', team: 'T1', free: 4800 }]);
    const r = scoreMeet(model, lineup(free('T1', 'ns'), free('T1', 'sc1')), [tag('T1', 'ns', 'non-scorer'), tag('T1', 'sc1')], nsisc(), SOURCING);
    expect(shape(r)).toEqual([['sc1', 1, 20, null], ['ns', null, 0, 'non_scorer']]);
  });

  it("'holds-place': a non-scorer keeps its place, scores 0, and nobody moves up", () => {
    const { model } = build([
      { id: 'ns', team: 'T1', free: 4000 },
      { id: 'sc1', team: 'T1', free: 4800 },
      { id: 'sc2', team: 'T2', free: 4100 },
    ]);
    const r = scoreMeet(model, lineup(free('T1', 'ns'), free('T1', 'sc1'), free('T2', 'sc2')), [tag('T1', 'sc1'), tag('T2', 'sc2')], nsisc({ nonScorer: 'holds-place' }), SOURCING);
    expect(shape(r)).toEqual([
      ['ns', 1, 0, 'non_scorer'],
      ['sc2', 2, 17, null],
      ['sc1', 3, 16, null],
    ]);
  });

  it("'holds-place': a non-scorer tied with a scorer still takes its share of the tied places", () => {
    const { model } = build([
      { id: 'ns', team: 'T1', free: 4000 },
      { id: 'sc1', team: 'T1', free: 4800 },
      { id: 'sc2', team: 'T2', free: 4000 },
    ]);
    const r = scoreMeet(model, lineup(free('T1', 'ns'), free('T1', 'sc1'), free('T2', 'sc2')), [tag('T1', 'sc1'), tag('T2', 'sc2')], nsisc({ nonScorer: 'holds-place' }), SOURCING);
    // Places 1 and 2 are split between the tied pair: (20 + 17) / 2. The non-scorer's half is not given to anyone.
    expect(shape(r)).toEqual([
      ['ns', 1, 0, 'non_scorer'],
      ['sc2', 1, 18.5, null],
      ['sc1', 3, 16, null],
    ]);
  });

  it("'removed-from-consideration': a non-scorer tied with a scorer leaves the tie group", () => {
    const { model } = build([
      { id: 'ns', team: 'T1', free: 4000 },
      { id: 'sc1', team: 'T1', free: 4800 },
      { id: 'sc2', team: 'T2', free: 4000 },
    ]);
    const r = scoreMeet(model, lineup(free('T1', 'ns'), free('T1', 'sc1'), free('T2', 'sc2')), [tag('T1', 'sc1'), tag('T2', 'sc2')], nsisc(), SOURCING);
    expect(shape(r)).toEqual([['sc2', 1, 20, null], ['sc1', 2, 17, null], ['ns', null, 0, 'non_scorer']]);
  });

  it('a non-scorer diver is removed from the diving places too', () => {
    const { model } = build([
      { id: 'dn', team: 'T1', dive: 30000 },
      { id: 'ds', team: 'T2', dive: 25000 },
      { id: 'sc', team: 'T1' },
    ]);
    const r = scoreMeet(model, lineup(dive('T1', 'dn'), dive('T2', 'ds'), free('T1', 'sc')), [tag('T1', 'sc'), tag('T2', 'ds')], nsisc(), SOURCING);
    expect(shape(r, DIVE)).toEqual([['ds', 1, 20, null], ['dn', null, 0, 'non_scorer']]);
  });

  it('a swimmer on a relay is not added to the roster: R71', () => {
    // u is untagged. He swims a relay and a 100 Free. Swimming the relay does not make him a scorer.
    const { model } = build([
      { id: 'u', team: 'T1', free: 4000 },
      { id: 'a', team: 'T1', free: 4900 },
      { id: 'b', team: 'T1', free: 4900 },
      { id: 'c', team: 'T1', free: 4900 },
      { id: 'z', team: 'T2', free: 4800 },
    ]);
    const r = scoreMeet(
      model,
      lineup(relay('T1', 'A', ['u', 'a', 'b', 'c']), free('T1', 'u'), free('T2', 'z')),
      [...tags('T1', ['a', 'b', 'c']), tag('T2', 'z')],
      nsisc({ mustBeScorers: false }),
      SOURCING
    );
    expect(shape(r)).toEqual([['z', 1, 20, null], ['u', null, 0, 'non_scorer']]);
  });

  it('a swimmer on a relay does not use a scoring-team spot', () => {
    const { model } = build([{ id: 'u', team: 'T1' }, { id: 'a', team: 'T1' }, { id: 'b', team: 'T1' }, { id: 'c', team: 'T1' }]);
    // Three tagged scorers and a limit of 3: u, untagged on the relay, is not a fourth.
    const r = scoreMeet(model, lineup(relay('T1', 'A', ['u', 'a', 'b', 'c'])), tags('T1', ['a', 'b', 'c']), nsisc({ mustBeScorers: false, size: 3 }), SOURCING);
    expect(r.violations.filter((v) => v.kind === 'scoring_team_size')).toEqual([]);
  });
});

describe('scoreMeet under roster eligibility: relays (README R37, D2 F19)', () => {
  const people: Spec[] = [
    ...['a0', 'a1', 'a2', 'a3'].map((id, i) => ({ id, team: 'T1', free: 4000 + i })),
    ...['b0', 'b1', 'b2', 'b3'].map((id, i) => ({ id, team: 'T2', free: 4100 + i })),
    ...['c0', 'c1', 'c2', 'c3'].map((id, i) => ({ id, team: 'T3', free: 4200 + i })),
  ];
  const entries = [relay('T1', 'A', ['a0', 'a1', 'a2', 'a3']), relay('T2', 'A', ['b0', 'b1', 'b2', 'b3']), relay('T3', 'A', ['c0', 'c1', 'c2', 'c3'])];
  const allTags = [...tags('T1', ['a0', 'a1', 'a2', 'a3']), ...tags('T2', ['b0', 'b1', 'b2', 'b3']), ...tags('T3', ['c0', 'c1', 'c2', 'c3'])];
  const without = (id: string) => allTags.filter((t) => t.swimmerId !== id);

  it('a relay of four scorers scores against the relay table', () => {
    const { model } = build(people);
    const r = scoreMeet(model, lineup(...entries), allTags, nsisc(), SOURCING);
    expect(relayShape(r)).toEqual([['T1A', 1, 40, null], ['T2A', 2, 34, null], ['T3A', 3, 32, null]]);
  });

  it('a relay with one untagged leg does not score; the relays behind it move up (removed-from-consideration)', () => {
    const { model } = build(people);
    const r = scoreMeet(model, lineup(...entries), without('a2'), nsisc(), SOURCING);
    expect(relayShape(r)).toEqual([['T2A', 1, 40, null], ['T3A', 2, 34, null], ['T1A', null, 0, 'non_scorer']]);
  });

  it("'holds-place': the relay with one untagged leg keeps its place and scores 0", () => {
    const { model } = build(people);
    const r = scoreMeet(model, lineup(...entries), without('a2'), nsisc({ nonScorer: 'holds-place' }), SOURCING);
    expect(relayShape(r)).toEqual([['T1A', 1, 0, 'non_scorer'], ['T2A', 2, 34, null], ['T3A', 3, 32, null]]);
  });

  it('relayLegsMustBeScorers false: the legs do not gate the relay', () => {
    const { model } = build(people);
    const r = scoreMeet(model, lineup(...entries), without('a2'), nsisc({ mustBeScorers: false }), SOURCING);
    expect(relayShape(r)).toEqual([['T1A', 1, 40, null], ['T2A', 2, 34, null], ['T3A', 3, 32, null]]);
  });

  it('a relay with a leg tagged non-scorer does not score either', () => {
    const { model } = build(people);
    const r = scoreMeet(model, lineup(...entries), [...without('a2'), tag('T1', 'a2', 'non-scorer')], nsisc(), SOURCING);
    expect(relayShape(r)[2]).toEqual(['T1A', null, 0, 'non_scorer']);
  });

  it('a relay that does not score takes no scoring-relay slot of its team', () => {
    // T1 fields A (untagged leg, fastest), B and C. With a limit of 2, B and C score.
    const t1 = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11'];
    const specs: Spec[] = t1.map((id, i) => ({ id, team: 'T1', free: 4000 + i * 10 }));
    const { model } = build(specs);
    const es = [relay('T1', 'A', ['a0', 'a1', 'a2', 'a3']), relay('T1', 'B', ['a4', 'a5', 'a6', 'a7']), relay('T1', 'C', ['a8', 'a9', 'a10', 'a11'])];
    const ts = tags('T1', t1.filter((id) => id !== 'a0'));
    const held = scoreMeet(model, lineup(...es), ts, nsisc({ relayCap: 2, nonScorer: 'holds-place' }), SOURCING);
    expect(relayShape(held)).toEqual([['T1A', 1, 0, 'non_scorer'], ['T1B', 2, 34, null], ['T1C', 3, 32, null]]);
  });
});

describe('scoreMeet under roster eligibility: exhibition (NCAA Rule 7-10-1, README R72)', () => {
  it("an exhibition-role swimmer's swim leaves the places, with reason exhibition; the rest move up", () => {
    const { model } = build([
      { id: 'ex', team: 'T1', free: 4000 },
      { id: 'sc1', team: 'T1', free: 4800 },
      { id: 'sc2', team: 'T2', free: 4100 },
    ]);
    const r = scoreMeet(model, lineup(free('T1', 'ex'), free('T1', 'sc1'), free('T2', 'sc2')), [tag('T1', 'ex', 'exhibition'), tag('T1', 'sc1'), tag('T2', 'sc2')], nsisc(), SOURCING);
    expect(shape(r)).toEqual([['sc2', 1, 20, null], ['sc1', 2, 17, null], ['ex', null, 0, 'exhibition']]);
  });

  it("exhibition is removed even when nonScorerPlacement is 'holds-place'", () => {
    const { model } = build([
      { id: 'ex', team: 'T1', free: 4000 },
      { id: 'sc1', team: 'T1', free: 4800 },
      { id: 'sc2', team: 'T2', free: 4100 },
    ]);
    const r = scoreMeet(model, lineup(free('T1', 'ex'), free('T1', 'sc1'), free('T2', 'sc2')), [tag('T1', 'ex', 'exhibition'), tag('T1', 'sc1'), tag('T2', 'sc2')], nsisc({ nonScorer: 'holds-place' }), SOURCING);
    expect(shape(r)).toEqual([['sc2', 1, 20, null], ['sc1', 2, 17, null], ['ex', null, 0, 'exhibition']]);
  });

  it('a relay with an exhibition-role leg is an exhibition relay', () => {
    const people: Spec[] = [
      ...['a0', 'a1', 'a2', 'a3'].map((id, i) => ({ id, team: 'T1', free: 4000 + i })),
      ...['b0', 'b1', 'b2', 'b3'].map((id, i) => ({ id, team: 'T2', free: 4100 + i })),
    ];
    const { model } = build(people);
    const r = scoreMeet(
      model,
      lineup(relay('T1', 'A', ['a0', 'a1', 'a2', 'a3']), relay('T2', 'A', ['b0', 'b1', 'b2', 'b3'])),
      [...tags('T1', ['a0', 'a1', 'a2']), tag('T1', 'a3', 'exhibition'), ...tags('T2', ['b0', 'b1', 'b2', 'b3'])],
      nsisc(),
      SOURCING
    );
    expect(relayShape(r)).toEqual([['T2A', 1, 40, null], ['T1A', null, 0, 'exhibition']]);
  });
});

describe('scoreMeet under roster eligibility: a team with no scoring roster is not scored (README R65, R70)', () => {
  it('refuses by name and lists the team ids, never scoring zeros', () => {
    const { model } = build([{ id: 'a', team: 'T1' }, { id: 'b', team: 'T2' }, { id: 'c', team: 'T3' }]);
    const e = failure(() => scoreMeet(model, lineup(free('T1', 'a'), free('T2', 'b'), free('T3', 'c')), [tag('T1', 'a')], nsisc(), SOURCING));
    expect(e.code).toBe('scoring_roster_missing');
    expect(e.teamIds).toEqual(['T2', 'T3']);
    expect(e.missingRosters).toEqual([{ teamId: 'T2', gender: 'Men' }, { teamId: 'T3', gender: 'Men' }]);
    expect(e.message).toContain('T2');
  });

  it('a team tagged only non-scorer or exhibition has no scoring roster', () => {
    const { model } = build([{ id: 'a', team: 'T1' }, { id: 'b', team: 'T2' }]);
    const e = failure(() => scoreMeet(model, lineup(free('T1', 'a'), free('T2', 'b')), [tag('T1', 'a'), tag('T2', 'b', 'non-scorer')], nsisc(), SOURCING));
    expect(e.code).toBe('scoring_roster_missing');
    expect(e.teamIds).toEqual(['T2']);
  });

  it('a team with a roster for the men and none for the women is refused for the women', () => {
    const { model } = build([{ id: 'm', team: 'T1' }, { id: 'w', team: 'T1', gender: 'Women' }, { id: 'x', team: 'T2' }]);
    const e = failure(() => scoreMeet(model, lineup(free('T1', 'm'), free('T1', 'w', 'Women'), free('T2', 'x')), [tag('T1', 'm'), tag('T2', 'x')], nsisc(), SOURCING));
    expect(e.code).toBe('scoring_roster_missing');
    expect(e.missingRosters).toEqual([{ teamId: 'T1', gender: 'Women' }]);
  });

  it('a team with no entry needs no tag', () => {
    const { model } = build([{ id: 'a', team: 'T1' }, { id: 'b', team: 'T2' }]);
    const r = scoreMeet(model, lineup(free('T1', 'a')), [tag('T1', 'a')], nsisc(), SOURCING);
    expect(pointsOf(r, 'T2')).toBe(0);
  });

  it('a relay-only team with no tag is refused', () => {
    const { model } = build(['a0', 'a1', 'a2', 'a3'].map((id) => ({ id, team: 'T1' })));
    const e = failure(() => scoreMeet(model, lineup(relay('T1', 'A', ['a0', 'a1', 'a2', 'a3'])), [], nsisc({ mustBeScorers: false }), SOURCING));
    expect(e.code).toBe('scoring_roster_missing');
  });
});

describe('scoreMeet under roster eligibility: scoring-team size (README R9, R24, R28)', () => {
  /** n swimmers and d divers on T1, all tagged, each entered once. */
  function team(n: number, d: number) {
    const swimmers = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, team: 'T1', free: 4000 + i * 10 }));
    const divers = Array.from({ length: d }, (_, i) => ({ id: `d${i}`, team: 'T1', dive: 30000 - i * 100 }));
    const { model } = build([...swimmers, ...divers]);
    const entries = [...swimmers.map((s) => free('T1', s.id)), ...divers.map((s) => dive('T1', s.id))];
    const ids = [...swimmers, ...divers].map((s) => s.id);
    return { model, entries, ids };
  }
  const sizeViolations = (r: Results) => r.violations.filter((v) => v.kind === 'scoring_team_size');

  it('a diver counts its weight: 3 swimmers and 3 divers at 1/3 each are 4 spots, and fit a size of 4', () => {
    const t = team(3, 3);
    const r = scoreMeet(t.model, lineup(...t.entries), tags('T1', t.ids), nsisc({ size: 4 }), SOURCING);
    expect(sizeViolations(r)).toEqual([]);
  });

  it('over the size: a violation, and the roster is scored as tagged, never trimmed', () => {
    // 3 swimmers and 6 divers at 1/3 each are 5 spots, over a size of 4. A diver weighted 1 would be 9 spots.
    const t = team(3, 6);
    const r = scoreMeet(t.model, lineup(...t.entries), tags('T1', t.ids), nsisc({ size: 4 }), SOURCING);
    expect(sizeViolations(r)).toEqual([
      { kind: 'scoring_team_size', teamId: 'T1', gender: 'Men', scorers: 3, divers: 6, spots: { numerator: 15, denominator: 3 }, limit: 4 },
    ]);
    // Everyone scores: 3 swimmers (20 + 17 + 16) and 6 divers (20 + 17 + 16 + 15 + 14 + 13).
    expect(rowsOf(r, FREE).every((x) => x.scored)).toBe(true);
    expect(rowsOf(r, DIVE).every((x) => x.scored)).toBe(true);
    expect(pointsOf(r, 'T1')).toBe(20 + 17 + 16 + (20 + 17 + 16 + 15 + 14 + 13));
  });

  it('a diver counts a full spot when the weight is 1', () => {
    const t = team(3, 3);
    const r = scoreMeet(t.model, lineup(...t.entries), tags('T1', t.ids), nsisc({ size: 4, weight: { numerator: 1, denominator: 1 } }), SOURCING);
    expect(sizeViolations(r)).toEqual([{ kind: 'scoring_team_size', teamId: 'T1', gender: 'Men', scorers: 3, divers: 3, spots: { numerator: 6, denominator: 1 }, limit: 4 }]);
  });

  it('a tagged swimmer with no entry counts a full spot; an untagged one never counts', () => {
    const { model } = build([{ id: 's0', team: 'T1' }, { id: 's1', team: 'T1' }, { id: 'idle', team: 'T1' }, { id: 'untagged', team: 'T1' }]);
    const r = scoreMeet(model, lineup(free('T1', 's0'), free('T1', 's1'), free('T1', 'untagged')), tags('T1', ['s0', 's1', 'idle']), nsisc({ size: 2 }), SOURCING);
    expect(sizeViolations(r)).toEqual([{ kind: 'scoring_team_size', teamId: 'T1', gender: 'Men', scorers: 3, divers: 0, spots: { numerator: 9, denominator: 3 }, limit: 2 }]);
  });

  it('a relay swimmer takes a full spot, even a swimmer who also dives', () => {
    const { model } = build([
      { id: 'a', team: 'T1' },
      { id: 'b', team: 'T1' },
      { id: 'c', team: 'T1' },
      { id: 'dv', team: 'T1', dive: 30000 },
    ]);
    const r = scoreMeet(model, lineup(relay('T1', 'A', ['a', 'b', 'c', 'dv']), dive('T1', 'dv')), tags('T1', ['a', 'b', 'c', 'dv']), nsisc({ size: 3, mustBeScorers: true }), SOURCING);
    expect(sizeViolations(r)).toEqual([{ kind: 'scoring_team_size', teamId: 'T1', gender: 'Men', scorers: 4, divers: 0, spots: { numerator: 12, denominator: 3 }, limit: 3 }]);
  });

  it('size is counted per team and gender', () => {
    const { model } = build([{ id: 'm0', team: 'T1' }, { id: 'm1', team: 'T1' }, { id: 'w0', team: 'T1', gender: 'Women' }, { id: 'w1', team: 'T1', gender: 'Women' }]);
    const r = scoreMeet(
      model,
      lineup(free('T1', 'm0'), free('T1', 'm1'), free('T1', 'w0', 'Women'), free('T1', 'w1', 'Women')),
      tags('T1', ['m0', 'm1', 'w0', 'w1']),
      nsisc({ size: 2 }),
      SOURCING
    );
    expect(sizeViolations(r)).toEqual([]);
  });

  it('an unlimited size never raises a violation', () => {
    const t = team(20, 0);
    const r = scoreMeet(t.model, lineup(...t.entries), tags('T1', t.ids), nsisc({ size: 'unlimited' }), SOURCING);
    expect(sizeViolations(r)).toEqual([]);
  });

  it('a numeric size with scoringTeamScope "event" under roster is refused: no rule says what it means', () => {
    const t = team(2, 0);
    const e = failure(() => scoreMeet(t.model, lineup(...t.entries), tags('T1', t.ids), nsisc({ size: 18, scope: 'event' }), SOURCING));
    expect(e.code).toBe('team_size_scope_unsupported');
  });
});

describe('scoreMeet under roster eligibility: caps and ties keep working on the scoring roster', () => {
  it('a per-event cap counts scorers only: a held non-scorer takes no slot', () => {
    const { model } = build([
      { id: 'ns', team: 'T1', free: 4000 },
      { id: 's1', team: 'T1', free: 4100 },
      { id: 's2', team: 'T1', free: 4200 },
      { id: 'z', team: 'T2', free: 4150 },
    ]);
    const r = scoreMeet(
      model,
      lineup(free('T1', 'ns'), free('T1', 's1'), free('T1', 's2'), free('T2', 'z')),
      [tag('T1', 's1'), tag('T1', 's2'), tag('T2', 'z')],
      nsisc({ nonScorer: 'holds-place', eventCap: { cap: 1, overCap: 'holds-place' } }),
      SOURCING
    );
    expect(shape(r)).toEqual([
      ['ns', 1, 0, 'non_scorer'],
      ['s1', 2, 17, null],
      ['z', 3, 16, null],
      ['s2', 4, 0, 'event_scorer_cap'],
    ]);
  });

  it("a per-event cap under 'removed-from-consideration' runs on the field without the non-scorers", () => {
    const { model } = build([
      { id: 'ns', team: 'T1', free: 4000 },
      { id: 's1', team: 'T1', free: 4100 },
      { id: 's2', team: 'T1', free: 4200 },
      { id: 'z', team: 'T2', free: 4150 },
    ]);
    const r = scoreMeet(
      model,
      lineup(free('T1', 'ns'), free('T1', 's1'), free('T1', 's2'), free('T2', 'z')),
      [tag('T1', 's1'), tag('T1', 's2'), tag('T2', 'z')],
      nsisc({ eventCap: { cap: 1, overCap: 'removed-from-consideration' } }),
      SOURCING
    );
    expect(shape(r)).toEqual([
      ['s1', 1, 20, null],
      ['z', 2, 17, null],
      ['ns', null, 0, 'non_scorer'],
      ['s2', null, 0, 'removed_over_event_cap'],
    ]);
  });

  it('the relay limit counts scoring relays: the third relay of a team is exhibition under nsisc v3', () => {
    const t1 = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const { model } = build(t1.map((id, i) => ({ id, team: 'T1', free: 4000 + i * 10 })));
    const es = [0, 1, 2].map((g) => relay('T1', 'ABC'[g] as string, [0, 1, 2, 3].map((k) => `a${g * 4 + k}`) as unknown as [string, string, string, string]));
    const r = scoreMeet(model, lineup(...es), tags('T1', t1), nsisc(), SOURCING);
    expect(relayShape(r)).toEqual([['T1A', 1, 40, null], ['T1B', 2, 34, null], ['T1C', null, 0, 'exhibition']]);
  });

  it("ties: 'split' shares the places among scorers; 'ordered' breaks the tie by lineup order", () => {
    const { model } = build([{ id: 'x', team: 'T1', free: 4000 }, { id: 'y', team: 'T2', free: 4000 }]);
    const lu = lineup(free('T1', 'x'), free('T2', 'y'));
    const ts = [tag('T1', 'x'), tag('T2', 'y')];
    expect(shape(scoreMeet(model, lu, ts, nsisc(), SOURCING))).toEqual([['x', 1, 18.5, null], ['y', 1, 18.5, null]]);
    expect(shape(scoreMeet(model, lu, ts, nsisc({ ties: 'ordered' }), SOURCING))).toEqual([['x', 1, 20, null], ['y', 2, 17, null]]);
  });
});

describe('scoreMeet under roster eligibility: tags are checked', () => {
  const { model } = build([{ id: 'a', team: 'T1' }, { id: 'b', team: 'T2' }, { id: 'gone', team: 'T1', roster: 'not_member' }]);
  const lu = lineup(free('T1', 'a'), free('T2', 'b'));
  const base = [tag('T1', 'a'), tag('T2', 'b')];
  const code = (extra: ScorerTag[]) => failure(() => scoreMeet(model, lu, [...base, ...extra], nsisc(), SOURCING)).code;

  it('refuses a tag for a swimmer the model does not have', () => {
    expect(code([tag('T1', 'nobody')])).toBe('unresolved_swimmer');
  });
  it('refuses a tag whose team is not the swimmer\'s team', () => {
    const { model: m2 } = build([{ id: 'a', team: 'T1' }, { id: 'q', team: 'T2' }]);
    expect(failure(() => scoreMeet(m2, lineup(free('T1', 'a')), [tag('T2', 'a')], nsisc(), SOURCING)).code).toBe('team_mismatch');
  });
  it('refuses a tag for a team the model does not have', () => {
    expect(code([tag('T9', 'a')])).toBe('unresolved_team');
  });
  it('refuses a tag for a swimmer who is not on the roster', () => {
    expect(code([tag('T1', 'gone')])).toBe('roster_not_member');
  });
  it('refuses two different roles for one swimmer, and accepts the same tag twice', () => {
    expect(code([tag('T1', 'a', 'non-scorer')])).toBe('duplicate_tag');
    expect(() => scoreMeet(model, lu, [...base, tag('T1', 'a')], nsisc(), SOURCING)).not.toThrow();
  });
  it('tags under points_pool still throw', () => {
    const pool = requireComplete({
      ...(builtinRulePreset('nsisc', 3) as RulePreset),
      scorers: {
        ...(builtinRulePreset('nsisc', 3) as RulePreset).scorers,
        eligibility: set('points_pool' as const),
        autoRules: set(null),
        scoringTeamSize: set('unlimited' as const),
        scoringTeamScope: set('event' as const),
        relayEligibleFromScorerPool: set(false),
      },
    });
    expect(failure(() => scoreMeet(model, lu, base, pool, SOURCING)).code).toBe('tags_need_roster_mode');
  });
});

describe('scoreMeet under roster eligibility: entry limits count every entry (README R75, which corrects R74)', () => {
  const capViolations = (r: Results) => r.violations.filter((v) => v.kind === 'entry_cap');
  const people: Spec[] = [
    { id: 'x', team: 'T1', free: 4000, dive: 25000 },
    { id: 'y', team: 'T1' },
    { id: 'z', team: 'T1' },
    { id: 'w', team: 'T1' },
    { id: 'o', team: 'T2' },
  ];
  const { model } = build(people);
  // x has 3 entries: a 100 Free, a dive and a relay leg. The total limit is 2.
  const lu = lineup(free('T1', 'x'), dive('T1', 'x'), relay('T1', 'A', ['x', 'y', 'z', 'w']), free('T2', 'o'));
  const others = [...tags('T1', ['y', 'z', 'w']), tag('T2', 'o')];
  const run = (role: ScorerRole, extra: Parameters<typeof nsisc>[0] = {}) =>
    scoreMeet(model, lu, [tag('T1', 'x', role), ...others], nsisc({ mustBeScorers: false, maxTotal: 2, ...extra }), SOURCING);

  it.each(['scorer', 'non-scorer', 'exhibition'] as const)('a swimmer tagged %s over the total limit is flagged', (role) => {
    expect(capViolations(run(role))).toContainEqual({ kind: 'entry_cap', swimmerId: 'x', which: 'total', count: 3, limit: 2 });
  });

  it('an untagged swimmer over the total limit is flagged too', () => {
    const r = scoreMeet(model, lu, others, nsisc({ mustBeScorers: false, maxTotal: 2 }), SOURCING);
    expect(capViolations(r)).toContainEqual({ kind: 'entry_cap', swimmerId: 'x', which: 'total', count: 3, limit: 2 });
  });

  it('exhibition entries count toward the individual and relay limits, and the legs of an exhibition relay count', () => {
    const r = run('exhibition', { maxInd: 1, maxRelay: 0 });
    expect(capViolations(r)).toContainEqual({ kind: 'entry_cap', swimmerId: 'x', which: 'individual', count: 2, limit: 1 });
    expect(capViolations(r)).toContainEqual({ kind: 'entry_cap', swimmerId: 'x', which: 'relay', count: 1, limit: 0 });
    // The relay is an exhibition relay: its other legs count as well.
    expect(capViolations(r)).toContainEqual({ kind: 'entry_cap', swimmerId: 'y', which: 'relay', count: 1, limit: 0 });
  });

  it('the legs of a relay removed as exhibition by relayOverCap count', () => {
    const t1 = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const m = build(t1.map((id, i) => ({ id, team: 'T1', free: 4000 + i * 10 }))).model;
    const es = [0, 1, 2].map((g) => relay('T1', 'ABC'[g] as string, [0, 1, 2, 3].map((k) => `a${g * 4 + k}`) as unknown as [string, string, string, string]));
    const r = scoreMeet(m, lineup(...es), tags('T1', t1), nsisc({ maxRelay: 0 }), SOURCING);
    // T1C is exhibition under nsisc v3 (limit 2). a8 to a11 are flagged all the same.
    expect(relayShape(r)[2]).toEqual(['T1C', null, 0, 'exhibition']);
    expect(capViolations(r).map((v) => v.swimmerId)).toEqual([...t1].sort());
  });

  it('a scorer at the total limit plus a leg of a relay removed by relayOverCap is over it', () => {
    const t1 = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const m = build(t1.map((id, i) => ({ id, team: 'T1', free: 4000 + i * 10 }))).model;
    const es = [0, 1, 2].map((g) => relay('T1', 'ABC'[g] as string, [0, 1, 2, 3].map((k) => `a${g * 4 + k}`) as unknown as [string, string, string, string]));
    const lu2 = lineup(...es, free('T1', 'a8'), dive('T1', 'a8'));
    const m2 = { ...m, swims: [...m.swims, { ...m.swims[0], swimId: 'a8:dive', swimmerId: 'a8', eventKey: DIVE, recordedTime: { text: '250.00', hundredths: 25000 } } as MeetSwim] };
    const r = scoreMeet(m2, lu2, tags('T1', t1), nsisc({ maxTotal: 2, relayCap: 2 }), SOURCING);
    expect(capViolations(r).filter((v) => v.swimmerId === 'a8' && v.which === 'total')).toEqual([
      { kind: 'entry_cap', swimmerId: 'a8', which: 'total', count: 3, limit: 2 },
    ]);
  });
});

describe('scoreMeet under roster eligibility: nsisc v3 end to end', () => {
  it('scores a small fixture: individuals, a dive and two relays, with a non-scorer and an exhibition swimmer', () => {
    const specs: Spec[] = [
      // T1 men
      { id: 'a0', team: 'T1', free: 4000, dive: 25000 },
      { id: 'a1', team: 'T1', free: 4010 },
      { id: 'a2', team: 'T1', free: 4020 },
      { id: 'a3', team: 'T1', free: 4030 },
      { id: 'ex', team: 'T1', free: 3900 },
      { id: 'ns', team: 'T1', free: 3950 },
      // T2 men
      { id: 'b0', team: 'T2', free: 4005, dive: 26000 },
      { id: 'b1', team: 'T2', free: 4015 },
      { id: 'b2', team: 'T2', free: 4025 },
      { id: 'b3', team: 'T2', free: 4035 },
    ];
    const { model } = build(specs);
    const lu = lineup(
      free('T1', 'ex'),
      free('T1', 'ns'),
      free('T1', 'a0'),
      free('T1', 'a1'),
      free('T2', 'b0'),
      free('T2', 'b1'),
      dive('T1', 'a0'),
      dive('T2', 'b0'),
      relay('T1', 'A', ['a0', 'a1', 'a2', 'a3']),
      relay('T2', 'A', ['b0', 'b1', 'b2', 'b3'])
    );
    const ts = [...tags('T1', ['a0', 'a1', 'a2', 'a3']), tag('T1', 'ex', 'exhibition'), ...tags('T2', ['b0', 'b1', 'b2', 'b3'])];
    const r = scoreMeet(model, lu, ts, requireComplete(builtinRulePreset('nsisc', 3) as RulePreset), SOURCING);
    // 100 Free: ex (exhibition) and ns (non-scorer) leave. a0 4000, b0 4005, a1 4010, b1 4015.
    expect(shape(r)).toEqual([
      ['a0', 1, 20, null],
      ['b0', 2, 17, null],
      ['a1', 3, 16, null],
      ['b1', 4, 15, null],
      ['ex', null, 0, 'exhibition'],
      ['ns', null, 0, 'non_scorer'],
    ]);
    // Dive: b0 260.00 beats a0 250.00.
    expect(shape(r, DIVE)).toEqual([['b0', 1, 20, null], ['a0', 2, 17, null]]);
    // Relay: T1 is a flat 4000 plus splits 3910, 3920, 3930 (15760). T2 is 4005 plus 3915, 3925, 3935 (15780).
    expect(relayShape(r)).toEqual([['T1A', 1, 40, null], ['T2A', 2, 34, null]]);
    expect(pointsOf(r, 'T1')).toBe(20 + 16 + 17 + 40);
    expect(pointsOf(r, 'T2')).toBe(17 + 15 + 20 + 34);
    expect(r.violations).toEqual([]);
  });
});
