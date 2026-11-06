/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1.3a (plans/2026-10-25/D7-DATA-SOURCING.md section 5, decision K): the flyover estimate, the
 * non-SCY split value, `recordedEventKeyFor` and the cut tag's own-course lookup. Every number here is
 * countable by hand. The relay worlds are synthetic and say so: no SwimCloud row is invented.
 *
 * Mutations these tests must kill (D7 section 5 and 6): `flyover ?? 0`; subtract the flyover from a
 * split; offer the estimate beside a real split; judge the own-course cut with the mapped key.
 */
import { describe, expect, it } from 'vitest';
import {
  builtinLcmToScy,
  closeThresholdFromPercent,
  cutTagForSwim,
  estimateFlyingLeg,
  flyoverFromSeconds,
  formatHundredths,
  parseTimeText,
  recordedEventKeyFor,
  requireComplete,
  scoreMeet,
  ScoreMeetError,
  scyEventKeyFor,
  scyStatementFor,
  scyStatementForSplit,
  splitScyValue,
} from '@omniswim/engine';
import type {
  CompleteRulePreset,
  Course,
  DivisionRef,
  FlyoverSetting,
  Lineup,
  LineupEntry,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MeetSwimmer,
  MeetTeam,
  RelaySplit,
  RulePreset,
  SourcingSettings,
  TimeValue,
} from '@omniswim/engine';
import { getCutlinesForSwim } from '@omniswim/engine/lib/cutlineUtils';

import { buildLegSources, currentSquad, generateSquads, legOptions } from '../packages/engine/src/autobuilder/squads';
import { buildIndex, resolveLineup } from '../packages/engine/src/model/results';
import type { RelayEntry } from '../packages/engine/src/model/lineup';
const LCM_PRESET = builtinLcmToScy('lcm-scy-swimswam', 1)!;
import { set } from './engineTestPresets';

const UNSET: FlyoverSetting = { state: 'unset' };
const flyover = (hundredths: number): FlyoverSetting => ({ state: 'set', hundredths });
const SCY_ONLY: SourcingSettings = { includeConvertedSwims: false, lcmToScy: null, flyover: UNSET };
const settings = (f: FlyoverSetting, converted = false): SourcingSettings => ({ includeConvertedSwims: converted, lcmToScy: null, flyover: f });
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic F1.3a' } as const;
const tv = (h: number): TimeValue => ({ text: formatHundredths(h), hundredths: h });
const D2: DivisionRef = { state: 'known', division: 'D2', season: '2026-2027' };

/* ---------------------------------------------------------------------------------------------- */
/* T-S1 flyoverFromSeconds                                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe('T-S1 flyoverFromSeconds', () => {
  it('undefined is unset, never a number', () => {
    expect(flyoverFromSeconds(undefined)).toStrictEqual({ state: 'unset' });
  });

  it('a value with at most two decimals is exact hundredths, including the floats that round badly', () => {
    expect(flyoverFromSeconds(0)).toStrictEqual({ state: 'set', hundredths: 0 });
    expect(flyoverFromSeconds(-0)).toStrictEqual({ state: 'set', hundredths: 0 });
    expect(Object.is((flyoverFromSeconds(-0) as { hundredths: number }).hundredths, 0)).toBe(true);
    expect(flyoverFromSeconds(0.3)).toStrictEqual({ state: 'set', hundredths: 30 });
    expect(flyoverFromSeconds(0.29)).toStrictEqual({ state: 'set', hundredths: 29 }); // 0.29 * 100 is 28.999999999999996
    expect(flyoverFromSeconds(0.07)).toStrictEqual({ state: 'set', hundredths: 7 }); // 7.000000000000001
    expect(flyoverFromSeconds(1.15)).toStrictEqual({ state: 'set', hundredths: 115 }); // 114.99999999999999
    expect(flyoverFromSeconds(2)).toStrictEqual({ state: 'set', hundredths: 200 });
  });

  it('a negative value, NaN, infinity, more than two decimals and a non-number throw', () => {
    for (const bad of [-0.01, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.005, 0.001, 0.123, 0.304]) {
      expect(() => flyoverFromSeconds(bad), String(bad)).toThrow(RangeError);
    }
    expect(() => flyoverFromSeconds('0.30' as unknown as number)).toThrow(RangeError);
    expect(() => flyoverFromSeconds(null as unknown as number)).toThrow(RangeError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Builders                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function swimOf(
  swimmerId: string,
  eventKey: string,
  hundredths: number | null,
  extra: { course?: Course; flags?: MeetSwim['flags']; scy?: MeetSwim['scy']; id?: string } = {}
): MeetSwim {
  const course = extra.course ?? 'SCY';
  return {
    swimId: extra.id ?? `${swimmerId}:${eventKey}:${course}:${hundredths ?? 'NT'}`,
    swimmerId,
    eventKey,
    recordedCourse: course,
    recordedTime: hundredths === null ? null : tv(hundredths),
    date: null,
    seasonId: null,
    flags: extra.flags ?? {},
    scy: extra.scy ?? (course === 'SCY' ? { kind: 'recorded-scy' } : { kind: 'not-convertible', reason: 'conversions_excluded' }),
    origin: ORIGIN,
  };
}

const convertedScy = (hundredths: number): MeetSwim['scy'] => ({
  kind: 'converted',
  hundredths,
  basis: { method: 'swimcloud', displayedText: formatHundredths(hundredths) },
  estimated: true,
});

function splitOf(swimmerId: string, hundredths: number, extra: Partial<RelaySplit> = {}): RelaySplit {
  return {
    splitId: `split-${swimmerId}-${extra.course === undefined ? 'SCY' : String(extra.course)}-${hundredths}`,
    swimmerId,
    relayEventKey: null,
    legPosition: null,
    start: 'flying',
    legEventKey: '100 Freestyle',
    split: tv(hundredths),
    course: 'SCY',
    date: null,
    origin: ORIGIN,
    ...extra,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* T-S2 estimateFlyingLeg                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe('T-S2 estimateFlyingLeg', () => {
  const flat = swimOf('s', '100 Freestyle', 2150);

  it('unset gives null, not the flat time', () => {
    expect(estimateFlyingLeg(flat, '100 Freestyle', UNSET)).toBeNull();
  });

  it('a flyover of 0 gives the flat time, as an estimate', () => {
    expect(estimateFlyingLeg(flat, '100 Freestyle', flyover(0))).toStrictEqual({ hundredths: 2150, usedConverted: false });
  });

  it('0.30 on 21.50 is 21.20', () => {
    expect(estimateFlyingLeg(flat, '100 Freestyle', flyoverFromSeconds(0.3))).toStrictEqual({ hundredths: 2120, usedConverted: false });
  });

  it('a swim of another event gets no estimate (invariant 13)', () => {
    expect(estimateFlyingLeg(flat, '50 Freestyle', flyover(30))).toBeNull();
    expect(estimateFlyingLeg(swimOf('s', '100 Butterfly', 2150), '100 Freestyle', flyover(30))).toBeNull();
  });

  it('a swim the engine may not pick gets no estimate (invariant 8)', () => {
    expect(estimateFlyingLeg(swimOf('s', '100 Freestyle', 2150, { flags: { extractedSplit: true } }), '100 Freestyle', flyover(30))).toBeNull();
    expect(estimateFlyingLeg(swimOf('s', '100 Freestyle', 2150, { flags: { userInputted: true } }), '100 Freestyle', flyover(30))).toBeNull();
    expect(estimateFlyingLeg(swimOf('s', '100 Freestyle', 2150, { flags: { programUnconfirmed: true } }), '100 Freestyle', flyover(30))).toBeNull();
  });

  it('a swim with no yards time gets no estimate', () => {
    expect(estimateFlyingLeg(swimOf('s', '100 Freestyle', null), '100 Freestyle', flyover(0))).toBeNull();
    expect(estimateFlyingLeg(swimOf('s', '100 Freestyle', 6000, { course: 'LCM' }), '100 Freestyle', flyover(0))).toBeNull();
  });

  it('a result of 0 or less gives null', () => {
    expect(estimateFlyingLeg(flat, '100 Freestyle', flyover(2149))).toStrictEqual({ hundredths: 1, usedConverted: false });
    expect(estimateFlyingLeg(flat, '100 Freestyle', flyover(2150))).toBeNull();
    expect(estimateFlyingLeg(flat, '100 Freestyle', flyover(9999))).toBeNull();
  });

  it('a converted swim uses its converted time and says so', () => {
    const converted = swimOf('s', '100 Freestyle', 2400, { course: 'SCM', scy: convertedScy(2150) });
    expect(estimateFlyingLeg(converted, '100 Freestyle', flyover(30))).toStrictEqual({ hundredths: 2120, usedConverted: true });
  });

  it('a set value that is not hundredths throws instead of scoring', () => {
    expect(() => estimateFlyingLeg(flat, '100 Freestyle', flyover(-1))).toThrow(RangeError);
    expect(() => estimateFlyingLeg(flat, '100 Freestyle', flyover(0.5))).toThrow(RangeError);
    expect(() => estimateFlyingLeg(flat, '100 Freestyle', flyover(Number.NaN))).toThrow(RangeError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* splitScyValue                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

describe('splitScyValue', () => {
  const convert: SourcingSettings = { includeConvertedSwims: true, lcmToScy: LCM_PRESET, flyover: flyover(30) };

  it('a SCY split is its own time, whatever else it says', () => {
    expect(splitScyValue(splitOf('s', 2300), D2, 'Men', SCY_ONLY)).toBe(2300);
    expect(splitScyValue(splitOf('s', 2300, { legEventKey: null }), D2, 'Men', SCY_ONLY)).toBe(2300);
  });

  it('an SCM split converts with the individual factor for its stroke and distance (R62), and the flyover plays no part', () => {
    const split = splitOf('s', 2500, { course: 'SCM' });
    const individual = scyStatementFor({ eventKey: '100 Freestyle', recordedCourse: 'SCM', recordedTime: tv(2500) }, null, D2, 'Men', convert);
    if (individual.kind !== 'converted') throw new Error('expected a converted statement');
    const value = splitScyValue(split, D2, 'Men', convert);
    expect(value).toBe(individual.hundredths);
    expect(value).not.toBe(2500);
    // The same split under another flyover: the value does not move.
    // splitScyValue takes ConversionSettings, so a flyover cannot reach it; the full SourcingSettings are accepted all the same.
    for (const f of [flyover(0), UNSET, flyover(5000)]) {
      const withFlyover: SourcingSettings = { ...convert, flyover: f };
      expect(splitScyValue(split, D2, 'Men', withFlyover)).toBe(value);
    }
    const statement = scyStatementForSplit(split, D2, 'Men', convert);
    expect(statement.kind === 'converted' && statement.hundredths).toBe(value);
  });

  it('an LCM split converts through the preset; with no preset, or conversions off, or an unknown course it has no value', () => {
    const split = splitOf('s', 6000, { course: 'LCM' });
    const value = splitScyValue(split, D2, 'Men', convert);
    expect(value).not.toBeNull();
    expect(value).toBeLessThan(6000);
    expect(splitScyValue(split, D2, 'Men', { ...convert, lcmToScy: null })).toBeNull();
    expect(splitScyValue(split, D2, 'Men', { ...convert, includeConvertedSwims: false })).toBeNull();
    expect(splitScyValue(splitOf('s', 2500, { course: null }), D2, 'Men', convert)).toBeNull();
    expect(splitScyValue(splitOf('s', 2500, { course: 'SCM', legEventKey: null }), D2, 'Men', convert)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* T-L6 recordedEventKeyFor, and the cut tag's own-course lookup                                   */
/* ---------------------------------------------------------------------------------------------- */

describe('T-L6 recordedEventKeyFor (decision K)', () => {
  const pairs = [
    ['500 Freestyle', '400 Freestyle'],
    ['1000 Freestyle', '800 Freestyle'],
    ['1650 Freestyle', '1500 Freestyle'],
  ] as const;

  it('maps the yards key back for SCM and LCM, and round-trips with scyEventKeyFor', () => {
    for (const course of ['SCM', 'LCM'] as const) {
      for (const [yards, metres] of pairs) {
        expect(recordedEventKeyFor(yards, course)).toBe(metres);
        expect(scyEventKeyFor(metres, course)).toBe(yards);
        expect(scyEventKeyFor(recordedEventKeyFor(yards, course), course)).toBe(yards);
        expect(recordedEventKeyFor(scyEventKeyFor(metres, course), course)).toBe(metres);
        // A key already in the recorded form is returned as given.
        expect(recordedEventKeyFor(metres, course)).toBe(metres);
      }
    }
  });

  it('is the identity for SCY and for every other event', () => {
    for (const [yards, metres] of pairs) {
      expect(recordedEventKeyFor(yards, 'SCY')).toBe(yards);
      expect(recordedEventKeyFor(metres, 'SCY')).toBe(metres);
    }
    for (const course of ['SCY', 'SCM', 'LCM'] as const) {
      for (const key of ['50 Freestyle', '100 Freestyle', '200 Freestyle', '200 Individual Medley', '1-Meter Diving']) {
        expect(recordedEventKeyFor(key, course)).toBe(key);
      }
    }
  });
});

describe('T-L6 cutTagForSwim judges the NAIA SCM 400 in its own course under either key', () => {
  const SEASON = '2026-2027';
  const naia: DivisionRef = { state: 'known', division: 'NAIA', season: SEASON };
  const team: MeetTeam = { teamId: 't1', division: naia };
  const swimmer: MeetSwimmer = { swimmerId: '1', teamId: 't1', gender: 'Men', classYear: null, roster: 'member' };
  const T = closeThresholdFromPercent(1);
  const lookup = getCutlinesForSwim('Men', '400 Freestyle', 'NAIA', SEASON, 'SCM');
  if (lookup.status !== 'ok') throw new Error(`no NAIA 400 Freestyle SCM table: ${lookup.status}`);
  const fastest = Math.min(...lookup.tiers.map((t) => parseTimeText(t.time)!.hundredths));
  const settingsOn: SourcingSettings = { includeConvertedSwims: true, lcmToScy: null, flyover: UNSET };

  // The yards key is decision K's `MeetSwim.eventKey`; the statement is computed from the recorded key.
  function swimUnder(eventKey: string, hundredths: number): MeetSwim {
    return {
      ...swimOf('1', eventKey, hundredths, { course: 'SCM' }),
      scy: scyStatementFor({ eventKey: '400 Freestyle', recordedCourse: 'SCM', recordedTime: tv(hundredths) }, null, naia, 'Men', settingsOn),
    };
  }

  it('the same real tag, with a standard, whichever key the swim is stored under', () => {
    const recorded = cutTagForSwim(swimUnder('400 Freestyle', fastest - 5), swimmer, team, T);
    const mapped = cutTagForSwim(swimUnder('500 Freestyle', fastest - 5), swimmer, team, T);
    expect(recorded.kind).toBe('achieved');
    expect(mapped).toStrictEqual(recorded);
    if (mapped.kind !== 'achieved') return;
    expect(mapped.standard.hundredths).toBe(fastest);
  });

  it('a swim just outside the standard reads the same under both keys too', () => {
    const slow = Math.max(...lookup.tiers.map((t) => parseTimeText(t.time)!.hundredths)) + 100000;
    const recorded = cutTagForSwim(swimUnder('400 Freestyle', slow), swimmer, team, T);
    const mapped = cutTagForSwim(swimUnder('500 Freestyle', slow), swimmer, team, T);
    expect(mapped).toStrictEqual(recorded);
    expect(mapped.kind).not.toBe('unknown');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Relay worlds                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

const EVENT_RELAY: MeetEvent = { eventKey: '400 Freestyle Relay', gender: 'Men', kind: 'relay', distanceYards: 400, relayKind: 'freestyle' };
const EVENT_100: MeetEvent = { eventKey: '100 Freestyle', gender: 'Men', kind: 'individual', distanceYards: 100, relayKind: null };

function worldOf(opts: { swimmers: readonly { id: string; team: string }[]; swims: readonly MeetSwim[]; splits?: readonly RelaySplit[]; division?: DivisionRef }): MeetModel {
  const teams = [...new Set(opts.swimmers.map((s) => s.team))];
  return {
    payloadVersion: 1,
    meetKey: 'synthetic F1.3a',
    teams: teams.map((teamId) => ({ teamId, division: opts.division ?? D2 })),
    swimmers: opts.swimmers.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: 'Men', classYear: null, roster: 'member' })),
    events: [EVENT_100, EVENT_RELAY],
    swims: [...opts.swims],
    relaySplits: [...(opts.splits ?? [])],
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

const relayOf = (team: string, letter: string, legs: RelayEntry['legs']): RelayEntry => ({ kind: 'relay', teamId: team, eventKey: '400 Freestyle Relay', gender: 'Men', letter, legs });
const lineupOf = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic F1.3a', entries });

function pointsPreset(): CompleteRulePreset {
  const p: RulePreset = {
    payloadVersion: 3,
    scoring: {
      ties: set('split' as const),
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
      eligibility: set('points_pool' as const),
      autoRules: set(null),
      scoringTeamSize: set('unlimited' as const),
      scoringTeamScope: set('event' as const),
      diverWeight: set({ numerator: 1, denominator: 1 }),
      perEventScorerCap: set({ cap: 'unlimited' as const }),
      divingPerEventScorerCap: set({ kind: 'same-as-swimming' as const }),
      scoringRelaysPerTeamPerEvent: set('unlimited' as const),
      relayOverCap: set('holds-place' as const),
      relayEligibleFromScorerPool: set(false),
      relayLegsMustBeScorers: { state: 'pending', question: 'not applicable', blocks: ['requireComplete', 'scoreMeet'] },
    },
    entries: {
      maxIndividualPerSwimmer: set('unlimited' as const),
      maxRelayPerSwimmer: set('unlimited' as const),
      maxTotalPerSwimmer: set('unlimited' as const),
      timeTrialsCount: set(false),
      exhibitionCounts: set(true),
      relayLegsAllowTimeTrials: set(false),
    },
  };
  return requireComplete(p);
}

const valueOf = (model: MeetModel, lineup: Lineup, s: SourcingSettings): (number | null)[] =>
  resolveLineup(model, lineup, buildIndex(model, s)).resolved.map((r) => r.value);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScoreMeetError) return error.code;
    throw error;
  }
  return 'did not throw';
}

const splitLeg = (swimmerId: string, splitId: string) => ({ swimmerId, basis: { kind: 'split' as const, splitId } });
const flatLeg = (swimmerId: string, swimId: string) => ({ swimmerId, basis: { kind: 'flat-start-swim' as const, swimId } });
const estimateLeg = (swimmerId: string, swimId: string) => ({ swimmerId, basis: { kind: 'flyover-estimate' as const, swimId } });

/* ---------------------------------------------------------------------------------------------- */
/* T-S3 a split keeps its exact time                                                               */
/* ---------------------------------------------------------------------------------------------- */

describe('T-S3 scoreMeet: a split leg keeps its exact time when the flyover is set', () => {
  // T1's relay is three splits behind a flat leadoff. T2's relay is four flat-start swims, so no flyover
  // can touch it (it is flagged `basis_position`, which does not matter here). T1 is 0.03 slower than T2.
  // Taking 0.30 off each of T1's split legs would put it ahead: the placement flips if the flyover reaches a split.
  const swimmers = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].map((id) => ({ id, team: id.startsWith('a') ? 'T1' : 'T2' }));
  const flatA = swimOf('a1', '100 Freestyle', 5000);
  const flatsB = ['b1', 'b2', 'b3', 'b4'].map((id) => swimOf(id, '100 Freestyle', 4925));
  const splitsA = ['a2', 'a3', 'a4'].map((id) => splitOf(id, 4901));
  const model = worldOf({ swimmers, swims: [flatA, ...flatsB], splits: splitsA });
  const entries = lineupOf(
    relayOf('T1', 'A', [flatLeg('a1', flatA.swimId), ...splitsA.map((s) => splitLeg(s.swimmerId, s.splitId))] as unknown as RelayEntry['legs']),
    relayOf('T2', 'A', flatsB.map((f) => flatLeg(f.swimmerId, f.swimId)) as unknown as RelayEntry['legs'])
  );
  it('the relay total is the exact sum, with the flyover unset, 0 and 0.30', () => {
    const exact = 5000 + 3 * 4901;
    for (const f of [UNSET, flyover(0), flyover(30), flyover(1000)]) {
      expect(valueOf(model, entries, settings(f))[0]).toBe(exact);
    }
  });

  it('the placement is the same with the flyover set as unset', () => {
    // T1 19703 against T2 19700.
    for (const f of [UNSET, flyover(0), flyover(30), flyover(1000)]) {
      const rows = scoreMeet(model, entries, [], pointsPreset(), settings(f)).events[0]!.rows;
      expect(rows.map((r) => [r.teamId, r.place, r.points]), JSON.stringify(f)).toEqual([['T2', 1, 11], ['T1', 2, 4]]);
    }
  });

  it('a converted split keeps its converted value when the flyover is set, and scoring no longer throws', () => {
    const scm = ['a2', 'a3', 'a4'].map((id) => splitOf(id, 5200, { course: 'SCM' }));
    const m = worldOf({ swimmers, swims: [flatA, ...flatsB], splits: scm });
    const l = lineupOf(relayOf('T1', 'A', [flatLeg('a1', flatA.swimId), ...scm.map((s) => splitLeg(s.swimmerId, s.splitId))] as unknown as RelayEntry['legs']));
    const converted = splitScyValue(scm[0]!, D2, 'Men', settings(UNSET, true));
    expect(converted).not.toBeNull();
    for (const f of [UNSET, flyover(0), flyover(30)]) {
      expect(valueOf(m, l, settings(f, true))[0]).toBe(5000 + 3 * (converted as number));
      expect(() => scoreMeet(m, l, [], pointsPreset(), settings(f, true))).not.toThrow();
    }
  });

  it('a non-SCY split with conversions off has no value: the relay has no time, nothing throws', () => {
    const scm = ['a2', 'a3', 'a4'].map((id) => splitOf(id, 5200, { course: 'SCM' }));
    const m = worldOf({ swimmers, swims: [flatA, ...flatsB], splits: scm });
    const l = lineupOf(relayOf('T1', 'A', [flatLeg('a1', flatA.swimId), ...scm.map((s) => splitLeg(s.swimmerId, s.splitId))] as unknown as RelayEntry['legs']));
    expect(valueOf(m, l, settings(flyover(30), false))).toEqual([null]);
    const row = scoreMeet(m, l, [], pointsPreset(), settings(flyover(30), false)).events[0]!.rows[0]!;
    expect(row.place).toBeNull();
    expect(row.notScoredReason).toBe('no_time');
  });

  it('without sourcing settings the index throws as before P4', () => {
    const scm = splitOf('a2', 5200, { course: 'SCM' });
    const m = worldOf({ swimmers, swims: [flatA], splits: [scm, splitsA[1]!, splitsA[2]!] });
    const l = lineupOf(relayOf('T1', 'A', [flatLeg('a1', flatA.swimId), splitLeg('a2', scm.splitId), splitLeg('a3', splitsA[1]!.splitId), splitLeg('a4', splitsA[2]!.splitId)] as unknown as RelayEntry['legs']));
    expect(() => resolveLineup(m, l, buildIndex(m))).toThrow(ScoreMeetError);
    const fl = lineupOf(relayOf('T1', 'A', [flatLeg('a1', flatA.swimId), estimateLeg('a2', flatA.swimId), splitLeg('a3', splitsA[1]!.splitId), splitLeg('a4', splitsA[2]!.splitId)] as unknown as RelayEntry['legs']));
    expect(() => resolveLineup(m, fl, buildIndex(m))).toThrow(ScoreMeetError);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* flyover-estimate legs in scoreMeet                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe('scoreMeet: a flyover-estimate leg', () => {
  const swimmers = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].map((id) => ({ id, team: id.startsWith('a') ? 'T1' : 'T2' }));
  const flat1 = swimOf('a1', '100 Freestyle', 5000);
  const flat2 = swimOf('a2', '100 Freestyle', 4950);
  const flatB = swimOf('b1', '100 Freestyle', 5000);
  const splitsA = ['a3', 'a4'].map((id) => splitOf(id, 4900));
  const splitsB = ['b2', 'b3', 'b4'].map((id) => splitOf(id, 4900));
  const model = worldOf({ swimmers, swims: [flat1, flat2, flatB, swimOf('a3', '50 Freestyle', 2300)], splits: [...splitsA, ...splitsB] });
  const rival = relayOf('T2', 'A', [flatLeg('b1', flatB.swimId), ...splitsB.map((s) => splitLeg(s.swimmerId, s.splitId))] as unknown as RelayEntry['legs']);
  const withEstimate = (swimId: string, who = 'a2'): RelayEntry =>
    relayOf('T1', 'A', [flatLeg('a1', flat1.swimId), estimateLeg(who, swimId), ...splitsA.map((s) => splitLeg(s.swimmerId, s.splitId))] as unknown as RelayEntry['legs']);

  it('with the flyover unset the leg has no time and the relay has no total', () => {
    const l = lineupOf(withEstimate(flat2.swimId), rival);
    expect(valueOf(model, l, settings(UNSET))).toEqual([null, 5000 + 3 * 4900]);
    const rows = scoreMeet(model, l, [], pointsPreset(), settings(UNSET)).events[0]!.rows;
    const own = rows.find((r) => r.teamId === 'T1')!;
    expect(own.place).toBeNull();
    expect(own.notScoredReason).toBe('no_time');
  });

  it('with the flyover set the leg is the flat time minus the allowance, and it scores', () => {
    const l = lineupOf(withEstimate(flat2.swimId), rival);
    expect(valueOf(model, l, settings(flyover(0)))[0]).toBe(5000 + 4950 + 2 * 4900);
    expect(valueOf(model, l, settings(flyover(30)))[0]).toBe(5000 + 4920 + 2 * 4900);
    // 30 hundredths: T1 is 19720 against T2's 19700, so T2 wins. With 100 hundredths T1 is 19650 and wins.
    const slower = scoreMeet(model, l, [], pointsPreset(), settings(flyover(30))).events[0]!.rows;
    expect(slower.map((r) => [r.teamId, r.place])).toEqual([['T2', 1], ['T1', 2]]);
    const faster = scoreMeet(model, l, [], pointsPreset(), settings(flyover(100))).events[0]!.rows;
    expect(faster.map((r) => [r.teamId, r.place])).toEqual([['T1', 1], ['T2', 2]]);
  });

  it('the estimate raises no event_mismatch or basis_position violation', () => {
    const r = scoreMeet(model, lineupOf(withEstimate(flat2.swimId), rival), [], pointsPreset(), settings(flyover(30)));
    expect(r.violations.filter((v) => v.kind === 'relay_leg')).toEqual([]);
  });

  it('a swim of another event is no estimate for the leg (invariant 13): no time, not a wrong time', () => {
    const wrong = swimOf('a3', '50 Freestyle', 2300);
    const entry = withEstimate(wrong.swimId, 'a3');
    // a3 now also holds leg 3 as a duplicate; the leg value is what matters here.
    expect(valueOf(model, lineupOf(entry), settings(flyover(30)))[0]).toBeNull();
  });

  it('refuses a leg 1 estimate, a missing swim and another swimmer swim loudly', () => {
    const leg1 = relayOf('T1', 'A', [estimateLeg('a1', flat1.swimId), ...splitsA.map((s) => splitLeg(s.swimmerId, s.splitId)), splitLeg('a4', splitsA[1]!.splitId)] as unknown as RelayEntry['legs']);
    expect(codeOf(() => scoreMeet(model, lineupOf(leg1), [], pointsPreset(), settings(flyover(30))))).toBe('leg_basis_unsupported');
    expect(codeOf(() => scoreMeet(model, lineupOf(withEstimate('nope')), [], pointsPreset(), settings(flyover(30))))).toBe('unresolved_swim');
    expect(codeOf(() => scoreMeet(model, lineupOf(withEstimate(flatB.swimId)), [], pointsPreset(), settings(flyover(30))))).toBe('seed_mismatch');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* T-S4 squads                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

describe('T-S4 squads: a flyover option only where the swimmer has no split option', () => {
  // The estimate from a's flat swim (48.00 - 0.30 = 47.70) is faster than a's real split (50.00). If the
  // estimate were offered beside the split, it would win. The split must stand.
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const swimmers = ids.map((id) => ({ id, team: 'T1' }));
  const aSplit = splitOf('a', 5000);
  const cScm = splitOf('c', 5200, { course: 'SCM' });
  const swims = [
    swimOf('a', '100 Freestyle', 4800),
    swimOf('b', '100 Freestyle', 4900),
    swimOf('c', '100 Freestyle', 4700),
    swimOf('d', '100 Freestyle', 4900, { id: 'd-slow' }),
    swimOf('d', '100 Freestyle', 4800, { id: 'd-fast' }),
    swimOf('d', '100 Freestyle', 4000, { id: 'd-typed', flags: { userInputted: true } }),
    swimOf('e', '100 Freestyle', 4600, { id: 'e-fly', flags: { extractedSplit: true } }),
    swimOf('f', '100 Butterfly', 4500),
    swimOf('f', '100 Freestyle', 6000, { course: 'LCM', id: 'f-lcm' }),
  ];
  const model = worldOf({ swimmers, swims, splits: [aSplit, cScm] });
  const optionsUnder = (s: SourcingSettings, who = ids) => legOptions(EVENT_RELAY, who, buildLegSources(model, s)) as NonNullable<ReturnType<typeof legOptions>>;
  const at = (positions: ReturnType<typeof optionsUnder>, position: number, id: string) => positions[position]!.find((o) => o.swimmerId === id);

  it('unset: no estimate for anybody, and the real options are as before', () => {
    const p = optionsUnder(settings(UNSET));
    expect(p[1]!.map((o) => o.swimmerId)).toEqual(['a']); // c's SCM split has no conversion when conversions are off
    expect(at(p, 1, 'a')).toMatchObject({ value: 5000, basis: { kind: 'split', splitId: aSplit.splitId } });
    for (const position of [1, 2, 3]) expect(p[position]!.some((o) => o.basis.kind === 'flyover-estimate')).toBe(false);
    // Leg 1 is the flat swim, as before.
    expect(p[0]!.map((o) => [o.swimmerId, o.value])).toEqual([['c', 4700], ['a', 4800], ['d', 4800], ['b', 4900]]);
  });

  it('set: a real split stands even when the estimate would be faster', () => {
    const p = optionsUnder(settings(flyover(30)));
    for (const position of [1, 2, 3]) {
      expect(at(p, position, 'a')).toMatchObject({ value: 5000, basis: { kind: 'split', splitId: aSplit.splitId } });
    }
  });

  it('set: a swimmer with no split gets the estimate from the fastest rankable swim of the leg event', () => {
    const p = optionsUnder(settings(flyover(30)));
    for (const position of [1, 2, 3]) {
      expect(at(p, position, 'b')).toMatchObject({ value: 4870, basis: { kind: 'flyover-estimate', swimId: 'b:100 Freestyle:SCY:4900' } });
      // d: the fastest rankable swim is the 48.00; the typed-in 40.00 is not rankable.
      expect(at(p, position, 'd')).toMatchObject({ value: 4770, basis: { kind: 'flyover-estimate', swimId: 'd-fast' } });
      // e has only an extracted split, f only another event and an LCM swim with no yards time.
      expect(at(p, position, 'e')).toBeUndefined();
      expect(at(p, position, 'f')).toBeUndefined();
    }
    // Leg 1 never gets an estimate.
    expect(p[0]!.some((o) => o.basis.kind === 'flyover-estimate')).toBe(false);
  });

  it('set: a split with no value counts as no split option (conversions off), so the estimate is offered', () => {
    const off = optionsUnder(settings(flyover(30), false));
    expect(at(off, 1, 'c')).toMatchObject({ value: 4670, basis: { kind: 'flyover-estimate' } });
  });

  it('set: a converted non-SCY split is a split option, valued by the conversion, and no estimate competes', () => {
    const on = settings(flyover(30), true);
    const p = optionsUnder(on);
    const converted = splitScyValue(cScm, D2, 'Men', on) as number;
    expect(converted).toBeGreaterThan(0);
    for (const position of [1, 2, 3]) {
      expect(at(p, position, 'c')).toMatchObject({ value: converted, basis: { kind: 'split', splitId: cScm.splitId } });
    }
  });

  it('every built squad is worth the same in the squad set as in scoreMeet', () => {
    const s = settings(flyover(30), true);
    const sources = buildLegSources(model, s);
    const positions = legOptions(EVENT_RELAY, ['a', 'b', 'c', 'd'], sources) as NonNullable<ReturnType<typeof legOptions>>;
    const set4 = generateSquads(positions, true, 10, []);
    expect(set4.squads.length).toBeGreaterThan(0);
    for (const squad of set4.squads) {
      const entry = relayOf('T1', 'A', squad.legs);
      expect(valueOf(model, lineupOf(entry), s)[0]).toBe(squad.time);
      expect(currentSquad(entry, sources).time).toBe(squad.time);
    }
    // At least one squad uses an estimate, so the check above covered that path.
    expect(set4.squads.some((q) => q.legs.some((l) => l.basis.kind === 'flyover-estimate'))).toBe(true);
  });

  it('currentSquad values an estimate leg like scoreMeet: with the flyover unset the time is Infinity', () => {
    const entry = relayOf('T1', 'A', [flatLeg('a', 'a:100 Freestyle:SCY:4800'), estimateLeg('b', 'b:100 Freestyle:SCY:4900'), splitLeg('a', aSplit.splitId), estimateLeg('d', 'd-fast')] as unknown as RelayEntry['legs']);
    expect(currentSquad(entry, buildLegSources(model, settings(UNSET))).time).toBe(Infinity);
    expect(currentSquad(entry, buildLegSources(model, settings(flyover(30)))).time).toBe(4800 + 4870 + 5000 + 4770);
    // Leg 1 takes no estimate.
    const leg1 = relayOf('T1', 'A', [estimateLeg('a', 'a:100 Freestyle:SCY:4800'), splitLeg('a', aSplit.splitId), splitLeg('a', aSplit.splitId), splitLeg('a', aSplit.splitId)] as unknown as RelayEntry['legs']);
    expect(currentSquad(leg1, buildLegSources(model, settings(flyover(30)))).time).toBe(Infinity);
  });
});
