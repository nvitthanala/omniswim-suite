/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * NAIA SCM follow-ups (plans/2026-09-24/01, item B1).
 *
 * Since 2026-09-24 an NAIA team's SCM swim is judged directly against the
 * NAIA metre column, read as SCM (`NAIA_2026_27_METERS_AS_SCM`). The cut tag
 * (`buildCutlineTag`) did that, but two writers of the stored `computedCut`
 * badge did not: `enrichWithComputedCut` (the paste parsers) and
 * `buildStoredSwim` (the roster catalog) skipped every metric swim. So an
 * NAIA SCM swim that cleared the NAIA standard showed a cut tag and no badge.
 * The import panel's badge tooltip also read the yards table for every swim.
 *
 * Every other metric swim still gets no computed cut: its converted time is
 * an estimate (`converted_estimate`), and an estimate never earns a cut.
 *
 * The rows are Noel Kis's block from the HSU roster export
 * (`hsuroster26-27.txt` lines 878-889), verbatim. The registry holds no NAIA
 * program yet (plan item B5), so the NAIA cases pass `division: 'NAIA'`
 * explicitly, as `tests/naiaMeterCourseAsScm.test.ts` does. HSU itself is D2,
 * and its result is pinned too: B1 changes nothing for it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim } from '../packages/core/src/types';
import { parseSwimCloudPersonalBestsDetailed } from '../packages/core/src/lib/athleteHistory';
import { buildStoredSwim } from '../packages/core/src/lib/rosterCatalog';
import { computedCutInOwnCourse } from '../packages/core/src/lib/cutlineUtils';
import { buildCutlineTag, computedCutTooltip } from '../packages/core/src/lib/cutlineTags';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const NAME = 'Noel Kis';
const NAIA_TEAM = 'Example NAIA College';
const HSU = 'Henderson State';

/** Noel Kis's block, checked at both ends so a shifted file fails loudly. */
function noelKisBlock(): string {
  const lines = readFileSync(join(repoRoot, 'hsuroster26-27.txt'), 'utf8').split(/\r?\n/);
  const block = lines.slice(877, 889);
  expect(block[0]).toBe(NAME);
  expect(block[block.length - 1]).toMatch(/^200 Free SCM\t2:12\.23\t/);
  return block.join('\n');
}

function parse(team: string, division: 'NAIA' | 'D2'): HistoricalSwim[] {
  return parseSwimCloudPersonalBestsDetailed(noelKisBlock(), NAME, team, Gender.MEN, division).swims;
}

const cutsOf = (swims: HistoricalSwim[]) =>
  swims.map(s => [s.event, s.timeType, s.time, s.computedCut ?? null]);

describe('enrichWithComputedCut judges an NAIA SCM swim against the NAIA SCM column', () => {
  it('stamps the NAIA SCM rows, and no other metric row', () => {
    // NAIA men, METERS read as SCM: 100 Free 48.84 / 52.87, 50 Free 22.27 /
    // 24.13, 100 Back 53.58 / 58.00, 200 Free 1:47.52 / 1:56.39. NAIA prints
    // no 50 Fly, so that SCM swim has no own-course table. Before B1 every
    // row below was null.
    expect(cutsOf(parse(NAIA_TEAM, 'NAIA'))).toStrictEqual([
      ['100 Freestyle', 'LCM', '50.78', null],
      ['100 Freestyle', 'SCM', '48.99', 'B'],
      ['50 Freestyle', 'SCM', '22.10', 'A'],
      ['50 Freestyle', 'LCM', '23.32', null],
      ['50 Butterfly', 'SCM', '24.20', null],
      ['50 Butterfly', 'LCM', '25.33', null],
      ['50 Backstroke', 'LCM', '27.04', null],
      ['100 Backstroke', 'SCM', '56.44', 'B'],
      // An extracted split is never judged.
      ['50 Backstroke', 'SCM', '27.47', null],
      // Judged, and missed both tiers.
      ['200 Freestyle', 'SCM', '2:12.23', null],
    ]);
  });

  it('agrees with the cut tag on every row', () => {
    for (const s of parse(NAIA_TEAM, 'NAIA')) {
      const tag = buildCutlineTag({
        division: 'NAIA',
        gender: s.gender,
        event: s.event,
        time: s.time,
        swimCourse: s.timeType,
        extractedSplit: s.isExtractedSplit === true,
      });
      const fromTag = tag.state === 'tagged' ? (tag.tag.tier === 'A' ? 'A' : 'B') : null;
      expect(s.computedCut ?? null, `${s.event} ${s.timeType} ${s.time} (${tag.state})`).toBe(fromTag);
    }
  });

  it('leaves the primary workspace (HSU, D2) exactly as before: no metric row is stamped', () => {
    expect(parse(HSU, 'D2').every(s => (s.computedCut ?? null) === null)).toBe(true);
  });
});

describe('buildStoredSwim stamps an NAIA SCM catalog time', () => {
  const stored = (division: 'NAIA' | 'D2') =>
    buildStoredSwim({
      athleteId: 'a-kis',
      event: '50 Free SCM',
      timeText: '22.10',
      timeType: 'SCM',
      source: 'paste',
      gender: Gender.MEN,
      division,
    });

  it('judges it against the NAIA SCM column; the SCY companion stays the converted estimate', () => {
    // NAIA prints no factor, so the estimate uses the Rules Book table:
    // 22.10 x 0.896 = 19.8016, truncated to 19.80.
    expect(stored('NAIA')).toMatchObject({ computedCut: 'A', timeSeconds: 22.1, timeSecondsScy: 19.8 });
  });

  it('gives a D2 SCM time no computed cut, as before', () => {
    expect(stored('D2')).toMatchObject({ computedCut: null, timeSecondsScy: 19.8 });
  });

  it('gives an NAIA LCM time no computed cut: NAIA publishes no LCM column', () => {
    const lcm = buildStoredSwim({
      athleteId: 'a-kis',
      event: '50 Free LCM',
      timeText: '23.32',
      timeType: 'LCM',
      source: 'paste',
      gender: Gender.MEN,
      division: 'NAIA',
    });
    expect(lcm.computedCut).toBeNull();
  });
});

describe('computedCutInOwnCourse', () => {
  it('uses the recorded seconds in the own-course table only', () => {
    const base = { gender: Gender.MEN, event: '50 Freestyle', division: 'NAIA' as const };
    expect(computedCutInOwnCourse({ ...base, seconds: 22.1, swimCourse: 'SCM' })).toBe('A');
    expect(computedCutInOwnCourse({ ...base, seconds: 24.13, swimCourse: 'SCM' })).toBe('B');
    expect(computedCutInOwnCourse({ ...base, seconds: 24.14, swimCourse: 'SCM' })).toBeNull();
    expect(computedCutInOwnCourse({ ...base, seconds: 22.1, swimCourse: 'LCM' })).toBeNull();
    // Yards: the NAIA yards column (19.91 / 21.55).
    expect(computedCutInOwnCourse({ ...base, seconds: 21.5, swimCourse: 'SCY' })).toBe('B');
    // D2 publishes no SCM column: an SCM swim is never judged in SCM.
    expect(computedCutInOwnCourse({ ...base, division: 'D2', seconds: 18.0, swimCourse: 'SCM' })).toBeNull();
  });
});

describe('computedCutTooltip quotes the standard in the swim’s own course', () => {
  it('quotes the NAIA metre standard for an NAIA SCM badge', () => {
    // Before B1 the panel read the yards table and printed "Beats NCAA NAIA
    // A cut (19.91)" for this swim.
    expect(
      computedCutTooltip({ gender: Gender.MEN, event: '50 Freestyle', timeType: 'SCM', computedCut: 'A' }, 'NAIA')
    ).toBe('Beats NAIA 2026-2027 automatic standard — 22.27 (short-course metres)');
    expect(
      computedCutTooltip({ gender: Gender.MEN, event: '100 Freestyle', timeType: 'SCM', computedCut: 'B' }, 'NAIA')
    ).toBe('Beats NAIA 2026-2027 provisional standard — 52.87 (short-course metres)');
  });

  it('quotes the yards standard for a yards badge', () => {
    // Avery Henke, hsuroster26-27.txt line 3: 100 Breast SCY 54.09 (D2 B).
    expect(
      computedCutTooltip({ gender: Gender.MEN, event: '100 Breaststroke', timeType: 'SCY', computedCut: 'B' }, 'D2')
    ).toBe('Beats NCAA D2 2026-2027 B standard — 55.08');
  });

  it('quotes nothing when no own-course table applies or no cut is held', () => {
    expect(
      computedCutTooltip({ gender: Gender.MEN, event: '50 Freestyle', timeType: 'LCM', computedCut: 'A' }, 'NAIA')
    ).toBeNull();
    expect(
      computedCutTooltip({ gender: Gender.MEN, event: '50 Freestyle', timeType: 'SCM', computedCut: 'A' }, 'D2')
    ).toBeNull();
    expect(
      computedCutTooltip({ gender: Gender.MEN, event: '50 Freestyle', timeType: 'SCM', computedCut: null }, 'NAIA')
    ).toBeNull();
  });
});
