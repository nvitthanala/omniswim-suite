/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SCM swims outside the factor table (plans/2026-09-22/01, P13 item 3).
 *
 * The NCAA SCM table has four rows: "400 meters to 500 yards", "800 meters to
 * 1000 yards", "1500 meters to 1650 yards" and "All other events". Before
 * 2026-09-24 an SCM swim converted only when `CONVERSION_FACTORS` held a key
 * for its event, so a 100 IM or a 25 in SCM had no SCY time at all.
 *
 * User decision, 2026-09-24: the "All other events" row covers those events,
 * because that is what it says. 0.896 on the Rules Book table, 0.906 on the
 * D1 table. LCM has no published factor, so an LCM swim outside the table
 * stays unconverted. Relays and diving never convert.
 *
 * The real case is Gavin Kock (HSU): `hsuroster26-27.txt` lines 161-200 hold
 * `100 IM SCM 58.25`, `25 Free SCM 11.00` and `100 IM SCY 52.57`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONVERSION_FACTORS, NCAA_SCM_CONVERSION_TABLES } from '../packages/core/src/constants';
import { Gender } from '../packages/core/src/types';
import {
  convertSwimToSCYDetailed,
  convertToSCY,
  hasConversionFactor,
  hasConversionFactorForCourse,
  ncaaScmConversionEvent,
  ncaaScmConversionRow,
} from '../packages/core/src/lib/utils';
import { categorizeBestEvents, parseSwimCloudPasteDetailed } from '../packages/core/src/lib/athleteHistory';
import { convertedHistorySwims } from '../packages/core/src/lib/arbitrage/shared';
import { scyEquivalentForCutline } from '../packages/core/src/lib/cutlineUtils';
import { buildCutlineTagForTeam } from '../packages/core/src/lib/cutlineTags';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');
const HSU = 'Henderson State';
const D1_TEAM = 'University of Pittsburgh';
const RULES_BOOK = NCAA_SCM_CONVERSION_TABLES['ncaa-rules-book-a2-2026-27'];
const D1_TABLE = NCAA_SCM_CONVERSION_TABLES['ncaa-d1-2025-26'];

/** Gavin Kock's block from the real HSU export, checked at both ends so a shifted file fails loudly. */
function gavinKockBlock(): string {
  const lines = readFileSync(join(repoRoot, 'hsuroster26-27.txt'), 'utf8').split(/\r?\n/);
  const block = lines.slice(160, 200);
  expect(block[0]).toBe('Gavin Kock');
  expect(block[block.length - 1]).toMatch(/^100 IM SCY\t52\.57\t/);
  return block.join('\n');
}

describe('the "All other events" row, as printed', () => {
  it('holds 0.896 (Rules Book) and 0.906 (D1)', () => {
    expect(RULES_BOOK.factors.allOtherEvents).toBe(0.896);
    expect(D1_TABLE.factors.allOtherEvents).toBe(0.906);
  });

  const pdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  it.skipIf(pdftotext.error != null)('is headed "All other events" in both archived sheets', () => {
    for (const [filename, page] of [
      ['2026-27D2MSW_QualStandards.pdf', 2],
      ['2026-27D2WSW_QualStandards.pdf', 2],
      ['2025-26D1XSW_QUALSTANDARDS.pdf', 3],
    ] as const) {
      const out = spawnSync(
        'pdftotext',
        ['-f', String(page), '-l', String(page), '-layout', join(sourcesDir, filename), '-'],
        { encoding: 'utf8' }
      );
      expect(out.status, filename).toBe(0);
      expect(out.stdout, filename).toMatch(/All other events/i);
    }
  });
});

describe('an SCM swim outside CONVERSION_FACTORS takes the "All other events" row', () => {
  it('converts a 100 IM and a 25 with the Rules Book factor for a D2 team, truncated', () => {
    // 58.25 x 0.896 = 52.192 -> 52.19. 11.00 x 0.896 = 9.856 -> 9.85.
    expect(convertToSCY('58.25', '100 IM SCM', Gender.MEN, 'SCM', { team: HSU })).toBe('52.19');
    expect(convertToSCY('58.25', '100 Individual Medley', Gender.MEN, 'SCM', { team: HSU })).toBe('52.19');
    expect(convertToSCY('11.00', '25 Free SCM', Gender.MEN, 'SCM', { team: HSU })).toBe('9.85');
    expect(convertToSCY('15.93', '25 Fly SCM', Gender.WOMEN, 'SCM', { team: HSU })).toBe('14.27');
  });

  it('converts with the D1 factor for a D1 team', () => {
    // 58.25 x 0.906 = 52.7745 -> 52.77.
    expect(convertToSCY('58.25', '100 IM SCM', Gender.MEN, 'SCM', { team: D1_TEAM })).toBe('52.77');
  });

  it('says which row, table and division it used', () => {
    const out = convertSwimToSCYDetailed('100 IM SCM', '58.25', Gender.MEN, 'SCM', { team: HSU });
    expect(out).toStrictEqual({
      event: '100 IM SCY',
      time: '52.19',
      sourceCourse: 'SCM',
      basis: {
        method: 'ncaa_scm_table',
        factor: 0.896,
        factorEvent: '100 Individual Medley',
        row: 'allOtherEvents',
        tableId: 'ncaa-rules-book-a2-2026-27',
        division: 'D2',
        reason: 'division_table',
      },
    });
    expect(ncaaScmConversionEvent('25 Free SCM')).toStrictEqual({
      factorEvent: '25 Freestyle',
      row: 'allOtherEvents',
      coverage: 'all_other_events',
    });
  });

  it('leaves every factor-table key on the row it had before', () => {
    for (const key of Object.keys(CONVERSION_FACTORS)) {
      expect(ncaaScmConversionEvent(key), key).toStrictEqual({
        factorEvent: key,
        row: ncaaScmConversionRow(key),
        coverage: 'factor_table',
      });
    }
    // The distance rows are untouched: 400 m still takes 400-to-500.
    expect(ncaaScmConversionEvent('400 Free SCM')).toMatchObject({ row: 'free400To500' });
    expect(convertToSCY('4:00.00', '400 Free SCM', Gender.MEN, 'SCM', { team: HSU })).toBe('4:34.32');
  });

  it('reports the course-aware answer, and leaves the course-blind one as it was', () => {
    expect(hasConversionFactorForCourse('100 IM SCM', 'SCM')).toBe(true);
    expect(hasConversionFactorForCourse('25 Free SCM', 'SCM')).toBe(true);
    expect(hasConversionFactorForCourse('100 IM SCY', 'SCY')).toBe(true);
    // Course-blind: no factor-table key, so no LCM factor.
    expect(hasConversionFactor('100 IM SCM')).toBe(false);
    expect(hasConversionFactor('25 Free SCM')).toBe(false);
  });
});

describe('what still never converts', () => {
  it('an LCM 100 IM or 25: no LCM factor is published', () => {
    expect(hasConversionFactorForCourse('100 IM LCM', 'LCM')).toBe(false);
    expect(hasConversionFactorForCourse('25 Free LCM', 'LCM')).toBe(false);
    expect(() => convertToSCY('1:02.00', '100 IM LCM', Gender.MEN, 'LCM')).toThrow(/No published LCM→SCY/);
    expect(() => convertToSCY('12.00', '25 Free LCM', Gender.MEN, 'LCM')).toThrow(/No published LCM→SCY/);
  });

  it('a relay: passed through as recorded, never factored', () => {
    expect(hasConversionFactorForCourse('200 Medley Relay SCM', 'SCM')).toBe(false);
    expect(hasConversionFactorForCourse('400 Free Relay LCM', 'LCM')).toBe(false);
    expect(ncaaScmConversionEvent('Event 11 Men 4x50 Yard Medley Relay')).toBeNull();
    expect(convertSwimToSCYDetailed('200 Medley Relay SCM', '1:45.00', Gender.MEN, 'SCM').basis).toStrictEqual({
      method: 'identity',
      reason: 'relay_not_converted',
    });
    expect(() => convertToSCY('1:45.00', '200 Medley Relay', Gender.MEN, 'SCM')).toThrow(/No published SCM→SCY/);
  });

  it('a dive, or a label that names no stroke', () => {
    for (const label of ['1 mtr Diving', 'Event 29 Men 3 mtr Diving', '200 Sidestroke', '100 Kick']) {
      expect(ncaaScmConversionEvent(label), label).toBeNull();
      expect(hasConversionFactorForCourse(label, 'SCM'), label).toBe(false);
      expect(() => convertToSCY('1:00.00', label, Gender.MEN, 'SCM'), label).toThrow(/No published SCM→SCY/);
    }
  });

  it('a distance that is not a whole number of 25 m lengths', () => {
    expect(ncaaScmConversionEvent('30 Freestyle')).toBeNull();
  });
});

describe('Gavin Kock (HSU), through the pipelines', () => {
  const swims = parseSwimCloudPasteDetailed(gavinKockBlock(), { team: HSU, gender: Gender.MEN }).swims;

  it('parses the three rows this item is about', () => {
    const pick = (event: string, timeType: string) =>
      swims.filter(s => s.event === event && s.timeType === timeType).map(s => s.time);
    expect(pick('100 Individual Medley', 'SCM')).toStrictEqual(['58.25']);
    expect(pick('100 Individual Medley', 'SCY')).toStrictEqual(['52.57']);
    expect(pick('25 Freestyle', 'SCM')).toStrictEqual(['11.00']);
  });

  it('now yields the SCM 100 IM and 25 to the cross-course reader', () => {
    const converted = [...convertedHistorySwims(swims)]
      .filter(c => c.timeType === 'SCM')
      .map(c => [c.swim.event, c.converted.time, c.converted.basis.method === 'ncaa_scm_table' && c.converted.basis.row]);
    expect(converted).toContainEqual(['100 Individual Medley', '52.19', 'allOtherEvents']);
    expect(converted).toContainEqual(['25 Freestyle', '9.85', 'allOtherEvents']);
  });

  it('offers the converted 100 IM in a meet that contests the 100 IM, marked as converted', () => {
    const profile = categorizeBestEvents(
      swims,
      HSU,
      Gender.MEN,
      'Gavin Kock',
      NSISC_PRESET_SETTINGS,
      [],
      undefined,
      new Set(['100 Individual Medley'])
    );
    // 52.19 (converted from 58.25 SCM) is faster than the real 52.57 yards swim.
    expect(profile.bestByEvent['100 Individual Medley']).toMatchObject({
      time: '52.19',
      convertedFrom: { sourceCourse: 'SCM', sourceTime: '58.25', scyTime: '52.19' },
    });
  });

  it('judges the SCM 100 IM against the D2 table and finds no published standard', () => {
    const tag = buildCutlineTagForTeam({
      team: HSU,
      gender: Gender.MEN,
      event: '100 IM SCM',
      time: '58.25',
      swimCourse: 'SCM',
    });
    // It converts now, so the honest answer is "D2 publishes no 100 IM", not
    // "no conversion".
    expect(tag.state).toBe('event_not_in_table');
    const lcm = buildCutlineTagForTeam({
      team: HSU,
      gender: Gender.MEN,
      event: '100 IM LCM',
      time: '1:02.00',
      swimCourse: 'LCM',
    });
    expect(lcm.state).toBe('conversion_unavailable');
    expect(scyEquivalentForCutline('100 Individual Medley', 58.25, Gender.MEN, 'SCM', { division: 'D2' })).toMatchObject({
      time: '52.19',
      factorEvent: '100 Individual Medley',
    });
    expect(scyEquivalentForCutline('100 Individual Medley', 62, Gender.MEN, 'LCM')).toBeNull();
  });
});
