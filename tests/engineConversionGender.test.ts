/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gender reaches the SCM conversion (Codex review, 2026-10-26). `scyStatementFor` and
 * `scyStatementForSplit` take the swimmer's gender and hand it to the legacy converter. They never
 * supply a gender of their own.
 *
 * Table A (`NCAA_SCM_CONVERSION_TABLES`) is keyed by division and row only, so today a men's and a
 * women's SCM swim convert to the same time. The spy test is what proves the gender is passed on: it
 * fails if a default returns, and it fails if a future table splits by gender and the call site
 * ignores the swimmer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { formatHundredths, parseTimeText, scyStatementFor, scyStatementForSplit } from '@omniswim/engine';
import type { ConversionSettings, DivisionRef, Gender } from '@omniswim/engine';
import { NCAA_SCM_CONVERSION_TABLES } from '@omniswim/engine/constants';
import { Gender as LegacyGender } from '@omniswim/engine/types';
import * as legacy from '@omniswim/engine/lib/scyConversion';

vi.mock('@omniswim/engine/lib/scyConversion', async importOriginal => {
  const actual = await importOriginal<typeof import('@omniswim/engine/lib/scyConversion')>();
  return { ...actual, scyConversionOutcome: vi.fn(actual.scyConversionOutcome) };
});

const D2: DivisionRef = { state: 'known', division: 'D2', season: '2026-2027' };
const SETTINGS: ConversionSettings = { includeConvertedSwims: true, lcmToScy: null };
const t = (text: string) => parseTimeText(text)!;
const spy = vi.mocked(legacy.scyConversionOutcome);

describe('gender in the SCM conversion', () => {
  it('a women\'s SCM swim is converted with Gender.WOMEN, a men\'s swim with Gender.MEN', () => {
    for (const [gender, expected] of [['Women', LegacyGender.WOMEN], ['Men', LegacyGender.MEN]] as const) {
      spy.mockClear();
      const swim = { eventKey: '100 Freestyle', recordedCourse: 'SCM' as const, recordedTime: t('1:00.00') };
      const s = scyStatementFor(swim, null, D2, gender, SETTINGS);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![2]).toBe(expected);
      const direct = legacy.scyConversionOutcome('100 Freestyle', formatHundredths(6000), expected, 'SCM', { division: 'D2' });
      expect(direct.status).toBe('converted');
      expect(s.kind === 'converted' && formatHundredths(s.hundredths)).toBe(
        direct.status === 'converted' ? direct.conversion.time : 'unreachable'
      );
    }
  });

  it('a relay split is converted with the gender given, not a default', () => {
    spy.mockClear();
    scyStatementForSplit({ legEventKey: '50 Freestyle', course: 'SCM', split: t('24.00') }, D2, 'Women', SETTINGS);
    expect(spy.mock.calls[0]![2]).toBe(LegacyGender.WOMEN);
  });

  it('Table A holds no gender column: men and women get the same SCM result today (no event differs)', () => {
    for (const table of Object.values(NCAA_SCM_CONVERSION_TABLES)) {
      expect(Object.keys(table.factors).sort()).toStrictEqual(['allOtherEvents', 'free1500To1650', 'free400To500', 'free800To1000']);
    }
    for (const eventKey of ['50 Freestyle', '100 Backstroke', '400 Freestyle', '200 Individual Medley', '1500 Freestyle']) {
      const [men, women] = (['Men', 'Women'] as Gender[]).map(g =>
        scyStatementFor({ eventKey, recordedCourse: 'SCM', recordedTime: t('2:00.00') }, null, D2, g, SETTINGS)
      );
      expect(men, eventKey).toStrictEqual(women);
    }
  });

  it('the LCM preset has no gender input: no archived request names a gender', () => {
    const archive = JSON.parse(readFileSync(path.join(__dirname, '..', 'data/conversions/swimswam/lcm-to-scy-2026-10-26.json'), 'utf8')) as {
      captures: { request: { fields: Record<string, string> } }[];
    };
    expect(archive.captures.length).toBe(53);
    for (const c of archive.captures) expect(Object.keys(c.request.fields).filter(k => /gender|sex/i.test(k))).toStrictEqual([]);
  });
});
