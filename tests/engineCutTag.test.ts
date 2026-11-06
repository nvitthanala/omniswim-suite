/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cut tags (plans/2026-10-25/D2-ENGINE-API.md, 3.9) with the estimated tag of README R61.
 *
 * Standards are read from the published tables at run time (`getCutlinesForSwim`), so no competition
 * time is typed in here. A converted time earns `estimated-achieved`. A real swim earns `achieved` and
 * replaces it. The rules that predate R61 still hold: absent is not `none`, an unknown division is not
 * D1, a discontinued program or an unsponsored gender is `unknown`.
 */
import { describe, expect, it } from 'vitest';

import {
  builtinLcmToScy,
  closeThresholdFromPercent,
  cutTagForSwim,
  cutTagFromLegacy,
  foldEventCutTags,
  formatHundredths,
  parseTimeText,
  scyStatementFor,
} from '@omniswim/engine';
import type { ConversionSettings, CutTag, DivisionRef, MeetSwim, MeetSwimmer, MeetTeam, NcaaDivision, TimeValue } from '@omniswim/engine';
import { buildCutlineTag } from '@omniswim/engine/lib/cutlineTags';
import { getCutlinesForSwim } from '@omniswim/engine/lib/cutlineUtils';

const SEASON = '2026-2027';
const LCM_PRESET = builtinLcmToScy('lcm-scy-swimswam', 1)!;
const SETTINGS: ConversionSettings = { includeConvertedSwims: true, lcmToScy: LCM_PRESET };
const T = closeThresholdFromPercent(1);

const tv = (h: number): TimeValue => ({ text: formatHundredths(h), hundredths: h });
const known = (division: NcaaDivision): DivisionRef => ({ state: 'known', division, season: SEASON });
const teamOf = (division: DivisionRef): MeetTeam => ({ teamId: 't1', division });
const swimmerOf = (gender: 'Men' | 'Women' = 'Men'): MeetSwimmer => ({ swimmerId: '1', teamId: 't1', gender, classYear: null, roster: 'member' });

function swimOf(
  eventKey: string,
  course: 'SCY' | 'SCM' | 'LCM',
  hundredths: number | null,
  division: DivisionRef,
  settings: ConversionSettings = SETTINGS,
  flags: MeetSwim['flags'] = {}
): MeetSwim {
  const recordedTime = hundredths === null ? null : tv(hundredths);
  return {
    swimId: 's',
    swimmerId: '1',
    eventKey,
    recordedCourse: course,
    recordedTime,
    date: null,
    seasonId: null,
    flags,
    scy: scyStatementFor({ eventKey, recordedCourse: course, recordedTime }, null, division, 'Men', settings),
    origin: { kind: 'simulator', snapshotId: 'x' },
  };
}

/** The published tiers for an event, as `{tier, hundredths}`, slowest first. Reads the real table. */
function tiersOf(division: NcaaDivision, event: string, course: 'SCY' | 'SCM' = 'SCY', gender: 'Men' | 'Women' = 'Men') {
  const lookup = getCutlinesForSwim(gender, event, division, SEASON, course);
  if (lookup.status !== 'ok') throw new Error(`no ${division} ${event} ${course} table: ${lookup.status}`);
  return lookup.tiers.map(t => ({ tier: t.tier, hundredths: parseTimeText(t.time)!.hundredths })).sort((a, b) => b.hundredths - a.hundredths);
}

/** The LCM time in hundredths whose converted yards time is the largest that is at or under `scyTarget`. */
function lcmClearing(lcmEvent: string, scyTarget: number): number {
  const probe = (lcm: number): number => {
    const r = scyStatementFor({ eventKey: lcmEvent, recordedCourse: 'LCM', recordedTime: tv(lcm) }, null, known('D2'), 'Men', SETTINGS);
    if (r.kind !== 'converted') throw new Error('not converted');
    return r.hundredths;
  };
  let lcm = Math.floor(scyTarget * 1.2) + 2000;
  while (probe(lcm) > scyTarget) lcm--;
  return lcm;
}

describe('estimated cut achieved (README R61)', () => {
  const standards = tiersOf('D2', '100 Freestyle');
  const slowest = standards[0]!; // the easiest published tier
  const lcmClear = lcmClearing('100 Freestyle', slowest.hundredths);

  it('an LCM swim whose converted time clears a standard earns estimated-achieved, never achieved', () => {
    const tag = cutTagForSwim(swimOf('100 Freestyle', 'LCM', lcmClear, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(tag.kind).toBe('estimated-achieved');
    if (tag.kind !== 'estimated-achieved') return;
    expect(tag.tier).toBe(slowest.tier);
    expect(tag.standard.hundredths).toBe(slowest.hundredths);
    expect(tag.basis).toMatchObject({ method: 'lcm_scy_tool_derived' });
    expect(tag.marginHundredths).toBe(slowest.hundredths - tag.convertedHundredths);
    expect(tag.marginHundredths).toBeGreaterThanOrEqual(0);
  });

  it('no converted swim ever gets kind achieved, over a sweep of LCM times', () => {
    for (let lcm = lcmClear - 3000; lcm <= lcmClear + 3000; lcm += 37) {
      const tag = cutTagForSwim(swimOf('100 Freestyle', 'LCM', lcm, known('D2')), swimmerOf(), teamOf(known('D2')), T);
      expect(tag.kind, String(lcm)).not.toBe('achieved');
    }
  });

  it('a converted time that clears nothing is converted with no indicative comparison, not none', () => {
    const tag = cutTagForSwim(swimOf('100 Freestyle', 'LCM', lcmClear + 3000, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(tag).toStrictEqual({ kind: 'converted', indicative: null });
  });

  it('an LCM 400 Freestyle is judged as the 500 Freestyle SCY', () => {
    const std500 = tiersOf('D2', '500 Freestyle')[0]!;
    const lcm = lcmClearing('400 Freestyle', std500.hundredths);
    const tag = cutTagForSwim(swimOf('400 Freestyle', 'LCM', lcm, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(tag.kind).toBe('estimated-achieved');
    expect(tag.kind === 'estimated-achieved' && tag.standard.hundredths).toBe(std500.hundredths);
  });

  it('an SCM swim converts through Table A and can earn the estimated tag', () => {
    // Pick an SCM time well inside the standard, so the table factor (about 1.14) cannot matter.
    const tag = cutTagForSwim(swimOf('100 Freestyle', 'SCM', Math.floor(slowest.hundredths / 1.3), known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(tag.kind).toBe('estimated-achieved');
    expect(tag.kind === 'estimated-achieved' && tag.basis.method).toBe('ncaa_scm_table');
  });

  it('a converted swim with no LCM preset is unknown (conversion_unavailable), not none', () => {
    const none: ConversionSettings = { includeConvertedSwims: true, lcmToScy: null };
    const tag = cutTagForSwim(swimOf('100 Freestyle', 'LCM', lcmClear, known('D2'), none), swimmerOf(), teamOf(known('D2')), T);
    expect(tag).toMatchObject({ kind: 'unknown', reason: 'conversion_unavailable' });
  });

  it('an NAIA SCM swim is judged in its own course: a real achieved tag, never estimated', () => {
    const naia = tiersOf('NAIA', '100 Freestyle', 'SCM')[0]!;
    const tag = cutTagForSwim(swimOf('100 Freestyle', 'SCM', naia.hundredths - 5, known('NAIA')), swimmerOf(), teamOf(known('NAIA')), T);
    expect(tag.kind).toBe('achieved');
    expect(tag.kind === 'achieved' && tag.standard.hundredths).toBe(naia.hundredths);
    // An NAIA LCM swim has no LCM table, so it still converts and stays estimated.
    const lcmTag = cutTagForSwim(swimOf('100 Freestyle', 'LCM', 2000, known('NAIA')), swimmerOf(), teamOf(known('NAIA')), T);
    expect(lcmTag.kind).toBe('estimated-achieved');
  });
});

describe('a real swim replaces the estimated tag (README R61)', () => {
  const standards = tiersOf('D2', '100 Freestyle');
  const easiest = standards[0]!;
  const lcm = lcmClearing('100 Freestyle', easiest.hundredths);
  const estimated = cutTagForSwim(swimOf('100 Freestyle', 'LCM', lcm, known('D2')), swimmerOf(), teamOf(known('D2')), T);
  const real = cutTagForSwim(swimOf('100 Freestyle', 'SCY', easiest.hundredths, known('D2')), swimmerOf(), teamOf(known('D2')), T);

  it('a real SCY swim that clears the cut gets the normal achieved tag', () => {
    expect(real.kind).toBe('achieved');
    expect(real.kind === 'achieved' && real.marginHundredths).toBe(0);
    expect(real.kind === 'achieved' && real.slot).toBeDefined();
  });

  it('the fold keeps the real tag and drops the estimated one at the same standard', () => {
    expect(estimated.kind).toBe('estimated-achieved');
    expect(foldEventCutTags([estimated, real])).toStrictEqual([real]);
    expect(foldEventCutTags([real, estimated])).toStrictEqual([real]);
  });

  it('with no real swim the estimated tag stands, and a real swim that missed does not remove it', () => {
    expect(foldEventCutTags([estimated])).toStrictEqual([estimated]);
    const missed = cutTagForSwim(swimOf('100 Freestyle', 'SCY', easiest.hundredths + 500, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(['none', 'close']).toContain(missed.kind);
    expect(foldEventCutTags([missed, estimated])).toStrictEqual([estimated]);
  });

  it('a real tag weaker than the estimated one is not decided by R61: the fold keeps both, real first', () => {
    const strict = standards[standards.length - 1]!;
    expect(strict.hundredths).toBeLessThan(easiest.hundredths);
    const strictEstimated = cutTagForSwim(swimOf('100 Freestyle', 'LCM', lcmClearing('100 Freestyle', strict.hundredths), known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(strictEstimated.kind === 'estimated-achieved' && strictEstimated.standard.hundredths).toBe(strict.hundredths);
    expect(foldEventCutTags([strictEstimated, real])).toStrictEqual([real, strictEstimated]);
  });

  it('a real tag at a stricter standard than the estimated one replaces it', () => {
    const strict = standards[standards.length - 1]!;
    const strictReal = cutTagForSwim(swimOf('100 Freestyle', 'SCY', strict.hundredths, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(strictReal.kind).toBe('achieved');
    expect(foldEventCutTags([estimated, strictReal])).toStrictEqual([strictReal]);
  });

  it('no tags is absent ([]), not none', () => {
    expect(foldEventCutTags([])).toStrictEqual([]);
  });

  it('without an achieved tag, one tag stands by this precedence: close, none, converted, unknown, not-applicable', () => {
    const unknown: CutTag = { kind: 'unknown', reason: 'no_time', detail: 'd' };
    const converted: CutTag = { kind: 'converted', indicative: null };
    const none: CutTag = { kind: 'none', nearest: null };
    expect(foldEventCutTags([unknown, converted, none])).toStrictEqual([none]);
    expect(foldEventCutTags([unknown, converted])).toStrictEqual([converted]);
    expect(foldEventCutTags([unknown])).toStrictEqual([unknown]);
  });
});

describe('rules that predate R61 still hold', () => {
  const tagFor = (division: DivisionRef, course: 'SCY' | 'LCM' = 'SCY', flags: MeetSwim['flags'] = {}) =>
    cutTagForSwim(swimOf('100 Freestyle', course, course === 'SCY' ? 4000 : 4500, division, SETTINGS, flags), swimmerOf(), teamOf(division), T);

  it('absent is not none: an NT swim is unknown no_time', () => {
    const tag = cutTagForSwim(swimOf('100 Freestyle', 'SCY', null, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(tag).toMatchObject({ kind: 'unknown', reason: 'no_time' });
  });

  it('an unknown division is unknown, never D1, for an SCY swim and a converted one', () => {
    for (const course of ['SCY', 'LCM'] as const) {
      expect(tagFor({ state: 'unknown', reason: 'unmapped_team' }, course), course).toMatchObject({ kind: 'unknown', reason: 'division_unknown' });
    }
  });

  it('a discontinued program, an unsponsored gender and an unaudited sponsorship are unknown, never none', () => {
    expect(tagFor({ state: 'unknown', reason: 'program_discontinued' })).toMatchObject({ kind: 'unknown', reason: 'program_discontinued' });
    expect(tagFor({ state: 'unknown', reason: 'gender_not_sponsored' }, 'LCM')).toMatchObject({ kind: 'unknown', reason: 'gender_not_sponsored' });
    expect(tagFor({ state: 'unknown', reason: 'sponsorship_unaudited' })).toMatchObject({ kind: 'unknown', reason: 'sponsorship_unaudited' });
  });

  it('a season with no table is unknown no_table_for_division, not a default season', () => {
    const old: DivisionRef = { state: 'known', division: 'D2', season: '2019-2020' };
    expect(tagFor(old)).toMatchObject({ kind: 'unknown', reason: 'no_table_for_division' });
    expect(tagFor(old, 'LCM')).toMatchObject({ kind: 'unknown', reason: 'no_table_for_division' });
  });

  it('flags make a swim unknown, converted or not', () => {
    expect(tagFor(known('D2'), 'LCM', { userInputted: true })).toMatchObject({ reason: 'user_inputted' });
    expect(tagFor(known('D2'), 'SCY', { extractedSplit: true })).toMatchObject({ reason: 'extracted_split' });
    expect(tagFor(known('D2'), 'SCY', { programUnconfirmed: true })).toMatchObject({ reason: 'program_unconfirmed' });
  });

  it('a not-convertible swim is unknown, never none', () => {
    const swim = swimOf('1000 Freestyle', 'SCM', 60000, known('D2'));
    expect(cutTagForSwim(swim, swimmerOf(), teamOf(known('D2')), T)).toMatchObject({ kind: 'unknown', reason: 'event_not_swum_in_course' });
    const off = swimOf('100 Freestyle', 'LCM', 6000, known('D2'), { includeConvertedSwims: false, lcmToScy: LCM_PRESET });
    expect(cutTagForSwim(off, swimmerOf(), teamOf(known('D2')), T)).toMatchObject({ kind: 'unknown', reason: 'conversion_unavailable' });
  });

  it('diving is not-applicable', () => {
    const tag = cutTagForSwim(swimOf('1-Meter Diving', 'SCY', 25000, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(tag).toStrictEqual({ kind: 'not-applicable', reason: 'diving' });
  });

  it('a real swim over the standard is close inside the threshold and none beyond it, in integers', () => {
    const std = tiersOf('D2', '100 Freestyle')[0]!.hundredths;
    const onePercent = Math.floor(std / 100);
    const inside = cutTagForSwim(swimOf('100 Freestyle', 'SCY', std + onePercent, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    const outside = cutTagForSwim(swimOf('100 Freestyle', 'SCY', std + onePercent + 1, known('D2')), swimmerOf(), teamOf(known('D2')), T);
    expect(inside.kind).toBe('close');
    expect(outside.kind).toBe('none');
    expect(outside.kind === 'none' && outside.nearest?.gapHundredths).toBe(onePercent + 1);
  });

  it('a swim exactly 1.0% off the standard is close: 57.57 against 57.00, and 64.64 against 1:04.00 (D2 named bug)', () => {
    const source = { sourceId: 'x', url: 'u', sha256: 'a'.repeat(64), page: 1 };
    const legacyMiss = (standard: string, swimSeconds: number, tier: 'A' | 'B' = 'A') =>
      ({
        state: 'no_cut',
        tag: null,
        swimSeconds,
        reason: 'r',
        nextTier: { tier, label: 'l', tierName: 'n', standardTime: standard, standardSeconds: 0, judgedSeconds: swimSeconds, shortBySeconds: 0, event: 'e', sourceUrl: 'u', source },
      }) as unknown as Parameters<typeof cutTagFromLegacy>[0];
    for (const [standard, swim] of [['57.00', 57.57], ['1:04.00', 64.64]] as const) {
      const tag = cutTagFromLegacy(legacyMiss(standard, swim), T);
      expect(tag.kind, standard).toBe('close');
      expect(tag.kind === 'close' && tag.nearest.gapBasisPoints).toBe(100);
    }
    expect(cutTagFromLegacy(legacyMiss('57.00', 57.58), T).kind).toBe('none');
  });

  it('closeThresholdFromPercent throws on a negative, NaN or 3-decimal value', () => {
    expect(closeThresholdFromPercent(1)).toStrictEqual({ basisPoints: 100 });
    expect(closeThresholdFromPercent(0)).toStrictEqual({ basisPoints: 0 });
    for (const bad of [-1, Number.NaN, 1.005, Number.POSITIVE_INFINITY]) expect(() => closeThresholdFromPercent(bad), String(bad)).toThrow(RangeError);
  });

  it('cutTagFromLegacy maps a legacy LCM converted_estimate to converted, never to an estimated tag', () => {
    const legacy = buildCutlineTag({ time: '50.00', gender: 'Men', event: '100 Free LCM', division: 'D2', season: SEASON, swimCourse: 'LCM' });
    expect(legacy.state).toBe('converted_estimate');
    expect(cutTagFromLegacy(legacy, T).kind).toBe('converted');
  });
});
