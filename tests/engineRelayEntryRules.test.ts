/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two optional relay entry rules (plans/2026-10-25/D2-ENGINE-API.md, section 3.8 and section 9 item 23):
 * - `entries.relaySwimmerOncePerEvent` (NCAA Rule 5-7-1-g, README R72): `relay_swimmer_repeated`.
 * - `entries.nonScoringRelaysAllowed` (README R42, NSISC): `relay_entries_over_limit`.
 * An absent rule is not checked. Both only report: the lineup is never trimmed and no score moves.
 * `engineRelayEntryRulesPreset.test.ts` covers the payload.
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
  MeetSwim,
  RelaySplit,
  Results,
  RulePreset,
  ScorerTag,
  Violation,
} from '@omniswim/engine';
import { set } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const RELAY_400 = '400 Freestyle Relay';
const RELAY_200 = '200 Freestyle Relay';
type Gender = 'Men' | 'Women';

const events = (): MeetEvent[] =>
  (['Men', 'Women'] as const).flatMap((gender) => [
    { eventKey: '50 Freestyle', gender, kind: 'individual', distanceYards: 50, relayKind: null } as const,
    { eventKey: '100 Freestyle', gender, kind: 'individual', distanceYards: 100, relayKind: null } as const,
    { eventKey: RELAY_400, gender, kind: 'relay', distanceYards: 400, relayKind: 'freestyle' } as const,
    { eventKey: RELAY_200, gender, kind: 'relay', distanceYards: 200, relayKind: 'freestyle' } as const,
  ]);

/** One team (`T1`) of swimmers `[id, gender]`. Every swimmer has a 50 and a 100 Free swim and a split for each. */
function build(swimmers: readonly (readonly [string, Gender])[]): MeetModel {
  const swims: MeetSwim[] = swimmers.flatMap(([id], i) =>
    (['50 Freestyle', '100 Freestyle'] as const).map((eventKey) => ({
      swimId: `${id}:${eventKey}`,
      swimmerId: id,
      eventKey,
      recordedCourse: 'SCY' as const,
      recordedTime: { text: '50.00', hundredths: 2000 + i * 10 + (eventKey === '50 Freestyle' ? 0 : 2300) },
      date: null,
      seasonId: null,
      flags: {},
      scy: { kind: 'recorded-scy' as const },
      origin: ORIGIN,
    }))
  );
  const relaySplits: RelaySplit[] = swimmers.flatMap(([id], i) =>
    (['50 Freestyle', '100 Freestyle'] as const).map((legEventKey) => ({
      splitId: `split-${id}-${legEventKey}`,
      swimmerId: id,
      relayEventKey: null,
      legPosition: null,
      start: 'flying' as const,
      legEventKey,
      split: { text: '20.00', hundredths: 1900 + i + (legEventKey === '50 Freestyle' ? 0 : 2300) },
      course: 'SCY' as const,
      date: null,
      origin: ORIGIN,
    }))
  );
  return {
    payloadVersion: 1,
    meetKey: 'synthetic',
    teams: [{ teamId: 'T1', division: { state: 'unknown', reason: 'unmapped_team' } }],
    swimmers: swimmers.map(([swimmerId, gender]) => ({ swimmerId, teamId: 'T1', gender, classYear: null, roster: 'member' as const })),
    events: events(),
    swims,
    relaySplits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

type RelayLineupEntry = Extract<LineupEntry, { kind: 'relay' }>;
function relay(letter: string, ids: readonly [string, string, string, string], eventKey = RELAY_400, gender: Gender = 'Men'): RelayLineupEntry {
  const legEvent = eventKey === RELAY_400 ? '100 Freestyle' : '50 Freestyle';
  const legs = ids.map((swimmerId, i) => ({
    swimmerId,
    basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:${legEvent}` } : { kind: 'split' as const, splitId: `split-${swimmerId}-${legEvent}` },
  })) as unknown as RelayLineupEntry['legs'];
  return { kind: 'relay', teamId: 'T1', eventKey, gender, letter, legs };
}
const lineupOf = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });
const tagAll = (swimmers: readonly (readonly [string, Gender])[]): ScorerTag[] => swimmers.map(([swimmerId]) => ({ teamId: 'T1', swimmerId, role: 'scorer' }));
const keyOf = (e: LineupEntry): string => (e.kind === 'relay' ? `r|${e.teamId}|${e.eventKey}|${e.gender}|${e.letter}` : '');

type Extra = { once?: boolean; allowed?: boolean; relayCap?: number | 'unlimited'; exhibitionCounts?: boolean; relayOverCap?: 'holds-place' | 'exhibition' };
/** The shipped nsisc v4, complete, plus the relay entry rules the test names. A key not named stays absent. */
function rules(extra: Extra = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 4) as RulePreset;
  return requireComplete({
    ...base,
    scorers: {
      ...base.scorers,
      scoringRelaysPerTeamPerEvent: set(extra.relayCap ?? 2),
      relayOverCap: set(extra.relayOverCap ?? ('exhibition' as const)),
    },
    entries: {
      ...base.entries,
      exhibitionCounts: set(extra.exhibitionCounts ?? true),
      ...(extra.once === undefined ? {} : { relaySwimmerOncePerEvent: set(extra.once) }),
      ...(extra.allowed === undefined ? {} : { nonScoringRelaysAllowed: set(extra.allowed) }),
    },
  });
}

const MEN12 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((id) => [id, 'Men'] as const);
const run = (swimmers: readonly (readonly [string, Gender])[], entries: LineupEntry[], r: CompleteRulePreset): Results =>
  scoreMeet(build(swimmers), lineupOf(...entries), tagAll(swimmers), r, SOURCING);
const ofKind = <K extends Violation['kind']>(r: Results, kind: K) => r.violations.filter((v): v is Extract<Violation, { kind: K }> => v.kind === kind);

describe('NCAA Rule 5-7-1-g: a swimmer on only one relay of a team in an event (README R72)', () => {
  const A = relay('A', ['a', 'b', 'c', 'd']);
  const B = relay('B', ['d', 'e', 'f', 'g']); // d swims on both

  it('reports the swimmer, team, event, gender and both relays when the rule is on', () => {
    const r = run(MEN12, [A, B], rules({ once: true }));
    expect(ofKind(r, 'relay_swimmer_repeated')).toStrictEqual([
      { kind: 'relay_swimmer_repeated', teamId: 'T1', swimmerId: 'd', eventKey: RELAY_400, gender: 'Men', entryKeys: [keyOf(A), keyOf(B)] },
    ]);
  });

  it('does not report it when the rule is off or absent', () => {
    expect(ofKind(run(MEN12, [A, B], rules({ once: false })), 'relay_swimmer_repeated')).toStrictEqual([]);
    expect(ofKind(run(MEN12, [A, B], rules()), 'relay_swimmer_repeated')).toStrictEqual([]);
  });

  it('is fine to swim on one relay in each of two different events', () => {
    const r = run(MEN12, [A, relay('A', ['d', 'e', 'f', 'g'], RELAY_200)], rules({ once: true }));
    expect(ofKind(r, 'relay_swimmer_repeated')).toStrictEqual([]);
  });

  it('is fine when the relays share no swimmer', () => {
    const r = run(MEN12, [A, relay('B', ['e', 'f', 'g', 'h'])], rules({ once: true }));
    expect(ofKind(r, 'relay_swimmer_repeated')).toStrictEqual([]);
  });

  it('lists every relay the swimmer is on, and one violation per swimmer, in swimmer order', () => {
    const C = relay('C', ['d', 'a', 'h', 'i']); // d on A, B, C; a on A, C
    const found = ofKind(run(MEN12, [A, B, C], rules({ once: true })), 'relay_swimmer_repeated');
    expect(found.map((v) => [v.swimmerId, v.entryKeys])).toStrictEqual([
      ['a', [keyOf(A), keyOf(C)]],
      ['d', [keyOf(A), keyOf(B), keyOf(C)]],
    ]);
  });

  it('a swimmer twice on one relay is duplicate_swimmer, not a repeat across relays', () => {
    const r = run(MEN12, [relay('A', ['a', 'a', 'b', 'c'])], rules({ once: true }));
    expect(ofKind(r, 'relay_swimmer_repeated')).toStrictEqual([]);
    expect(r.violations.some((v) => v.kind === 'relay_leg' && v.reason === 'duplicate_swimmer')).toBe(true);
  });

  it('counts an exhibition relay: the repeat is reported even when exhibitionCounts is false', () => {
    const r = run(MEN12, [A, B, relay('C', ['h', 'i', 'j', 'k'])], rules({ once: true, exhibitionCounts: false, relayCap: 2 }));
    expect(ofKind(r, 'relay_swimmer_repeated').map((v) => v.swimmerId)).toStrictEqual(['d']);
  });

  it('never trims the lineup and never changes a score', () => {
    const off = run(MEN12, [A, B], rules({ once: false }));
    const on = run(MEN12, [A, B], rules({ once: true }));
    expect(on.events).toStrictEqual(off.events);
    expect(on.teams).toStrictEqual(off.teams);
    expect(on.events.find((e) => e.eventKey === RELAY_400)?.rows).toHaveLength(2);
  });
});

describe('NSISC has no non-scoring relays: a relay beyond the scoring limit is an entry violation (README R42)', () => {
  const A = relay('A', ['a', 'b', 'c', 'd']);
  const B = relay('B', ['e', 'f', 'g', 'h']);
  const C = relay('C', ['i', 'j', 'k', 'l']);

  it('reports a 3rd relay: team, event, gender, every relay key, the count and the limit', () => {
    const r = run(MEN12, [A, B, C], rules({ allowed: false }));
    expect(ofKind(r, 'relay_entries_over_limit')).toStrictEqual([
      { kind: 'relay_entries_over_limit', teamId: 'T1', eventKey: RELAY_400, gender: 'Men', entryKeys: [keyOf(A), keyOf(B), keyOf(C)], count: 3, limit: 2 },
    ]);
  });

  it('does not report two relays, the limit itself', () => {
    expect(ofKind(run(MEN12, [A, B], rules({ allowed: false })), 'relay_entries_over_limit')).toStrictEqual([]);
  });

  it('does not report it when a preset allows non-scoring relays, or says nothing', () => {
    expect(ofKind(run(MEN12, [A, B, C], rules({ allowed: true })), 'relay_entries_over_limit')).toStrictEqual([]);
    expect(ofKind(run(MEN12, [A, B, C], rules()), 'relay_entries_over_limit')).toStrictEqual([]);
  });

  it('does nothing while the scoring-relay limit is unlimited', () => {
    expect(ofKind(run(MEN12, [A, B, C], rules({ allowed: false, relayCap: 'unlimited' })), 'relay_entries_over_limit')).toStrictEqual([]);
  });

  it('follows the limit the preset states, never a hardcoded 2', () => {
    const three = run(MEN12, [A, B, C], rules({ allowed: false, relayCap: 3 }));
    expect(ofKind(three, 'relay_entries_over_limit')).toStrictEqual([]);
    const one = run(MEN12, [A, B], rules({ allowed: false, relayCap: 1 }));
    expect(ofKind(one, 'relay_entries_over_limit').map((v) => [v.count, v.limit])).toStrictEqual([[2, 1]]);
  });

  it('still reports it when exhibitionCounts is false and relayOverCap removes the 3rd relay', () => {
    // The removed relay is the over-limit one. If the check read the counted entries, it could never fire.
    const r = run(MEN12, [A, B, C], rules({ allowed: false, exhibitionCounts: false, relayOverCap: 'exhibition' }));
    expect(ofKind(r, 'relay_entries_over_limit')).toHaveLength(1);
    const rows = r.events.find((e) => e.eventKey === RELAY_400)?.rows ?? [];
    expect(rows.filter((row) => row.notScoredReason === 'exhibition')).toHaveLength(1);
  });

  it('counts a relay with no time as an entry', () => {
    const noTime = { ...C, legs: C.legs.map((leg) => ({ ...leg, basis: { kind: 'no-time' as const } })) } as unknown as RelayLineupEntry;
    expect(ofKind(run(MEN12, [A, B, noTime], rules({ allowed: false })), 'relay_entries_over_limit')).toHaveLength(1);
  });

  it('counts per team, event and gender: two men and two women relays are within a limit of 2', () => {
    const swimmers: (readonly [string, Gender])[] = [...MEN12.slice(0, 8), ...['m', 'n', 'o', 'p', 'q', 'r', 's', 't'].map((id) => [id, 'Women'] as const)];
    const entries = [
      A,
      B,
      relay('A', ['m', 'n', 'o', 'p'], RELAY_400, 'Women'),
      relay('B', ['q', 'r', 's', 't'], RELAY_400, 'Women'),
      relay('A', ['a', 'b', 'c', 'd'], RELAY_200),
      relay('B', ['e', 'f', 'g', 'h'], RELAY_200),
    ];
    expect(ofKind(run(swimmers, entries, rules({ allowed: false })), 'relay_entries_over_limit')).toStrictEqual([]);
  });

  it('reports each over-limit team, event and gender once, in team, event, gender order', () => {
    const swimmers: (readonly [string, Gender])[] = [...MEN12, ...['m', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x'].map((id) => [id, 'Women'] as const)];
    const women = (letter: string, ids: [string, string, string, string]) => relay(letter, ids, RELAY_400, 'Women');
    const entries = [
      women('A', ['m', 'n', 'o', 'p']),
      women('B', ['q', 'r', 's', 't']),
      women('C', ['u', 'v', 'w', 'x']),
      A,
      B,
      C,
    ];
    const found = ofKind(run(swimmers, entries, rules({ allowed: false })), 'relay_entries_over_limit');
    expect(found.map((v) => [v.gender, v.count])).toStrictEqual([['Men', 3], ['Women', 3]]);
  });

  it('never trims the lineup and never changes a score', () => {
    const off = run(MEN12, [A, B, C], rules());
    const on = run(MEN12, [A, B, C], rules({ allowed: false }));
    expect(on.events).toStrictEqual(off.events);
    expect(on.teams).toStrictEqual(off.teams);
    expect(on.events.find((e) => e.eventKey === RELAY_400)?.rows).toHaveLength(3);
  });

  it('both rules together report both, over-limit first', () => {
    const D = relay('C', ['i', 'j', 'k', 'a']); // a is also on A
    const r = run(MEN12, [A, B, D], rules({ allowed: false, once: true }));
    expect(r.violations.filter((v) => v.kind.startsWith('relay_')).map((v) => v.kind)).toStrictEqual(['relay_entries_over_limit', 'relay_swimmer_repeated']);
  });
});
