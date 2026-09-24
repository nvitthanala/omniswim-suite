/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Metric (SCM/LCM) swims convert to SCY with the conversion table of the
 * team's own NCAA division.
 *
 * Two defects this locks down (plans/2026-09-22/01, phases P0 and P1):
 *
 * 1. **SwimCloud labels never reached the factor table.** SwimCloud writes
 *    `"50 Free LCM"`; `CONVERSION_FACTORS` is keyed `"50 Freestyle"`. Probe on
 *    2026-09-22: `hasConversionFactor('50 Free LCM') === false`, so
 *    `convertedHistorySwims` skipped every metric SwimCloud swim without a
 *    word. No international recruit time was ever projected.
 * 2. **Every SCM swim used the D1 factor.** The NCAA publishes a different
 *    SCM table for D1 than the Rules Book table D2 prints, and HSU is D2. The
 *    old `both_scm` column held the D1 values, so every D2 SCM projection was
 *    about 1.1% slow. It also rounded, where the NCAA procedure truncates.
 *
 * The factor values are snapshotted here AND, where `pdftotext` is installed,
 * re-read from the archived PDFs, so a transcription error or an upstream
 * change breaks CI instead of a lineup.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSwimmerFastestTimesJson, type SwimCloudParseContext } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import {
  CONVERSION_FACTORS,
  NCAA_SCM_CONVERSION_TABLES,
  type NcaaScmConversionRow,
  type NcaaScmConversionTable,
} from '../packages/core/src/constants';
import { Gender, type HistoricalSwim, type Workspace } from '../packages/core/src/types';
import {
  convertSwimToSCY,
  convertSwimToSCYDetailed,
  convertToSCY,
  formatSecondsToTime,
  hasConversionFactor,
  ncaaScmConversionRow,
  ncaaScmConvertedSeconds,
  resolveConversionFactorKey,
  scmConversionTableFor,
} from '../packages/core/src/lib/utils';
import { convertedHistorySwims } from '../packages/core/src/lib/arbitrage/shared';
import { buildCrossCourseTable } from '../packages/core/src/lib/crossCourseArbitrage';
import { canonicalProgramEvent } from '../packages/core/src/lib/eventIdentity';
import { categorizeBestEvents, normalizeEventLabel } from '../packages/core/src/lib/athleteHistory';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { scyEquivalentForCutline } from '../packages/core/src/lib/cutlineUtils';
import { buildCutlineTag } from '../packages/core/src/lib/cutlineTags';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');

/** The primary workspace. `Henderson State` is a registered alias of HSU (D2). */
const HSU = 'Henderson State';
/** A registered D1 program. */
const D1_TEAM = 'University of Pittsburgh';
const RULES_BOOK = 'ncaa-rules-book-a2-2026-27';
const D1_TABLE = 'ncaa-d1-2025-26';

function swim(over: Partial<HistoricalSwim>): HistoricalSwim {
  return {
    name: 'Test Recruit',
    team: HSU,
    gender: Gender.MEN,
    event: '50 Free LCM',
    time: '24.20',
    timeType: 'LCM',
    source: 'swimcloud',
    ...over,
  };
}

function workspaceWith(history: HistoricalSwim[]): Workspace {
  return {
    id: 'ws-conversion',
    name: 'Conversion',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    athleteHistory: history,
  } as Workspace;
}

/* -------------------------------------------------------------------------- */
/* P0 — SwimCloud labels reach the factor table                                */
/* -------------------------------------------------------------------------- */

describe('P0: SwimCloud event labels resolve to a published factor', () => {
  it.each(['50 Free LCM', '1500 Free LCM', '200 IM SCM', '100 Back LCM', '400 IM LCM', '200 Fly SCM', '100 Breast LCM'])(
    'hasConversionFactor(%s) is true',
    (label) => {
      expect(hasConversionFactor(label)).toBe(true);
    }
  );

  it.each(['1 mtr Diving', '3 mtr Diving', '400 Free Relay LCM', '200 Medley Relay SCM', '100 IM LCM', '25 Free SCM'])(
    // Course-blind: no CONVERSION_FACTORS key covers these. An SCM 25 or 100 IM
    // still converts on the NCAA "All other events" row — see
    // scmAllOtherEventsConversion.test.ts and hasConversionFactorForCourse.
    'hasConversionFactor(%s) stays false — no factor-table key covers it',
    (label) => {
      expect(hasConversionFactor(label)).toBe(false);
    }
  );

  it('resolves each label to the factor row of the same event', () => {
    expect(resolveConversionFactorKey('50 Free LCM')).toBe('50 Freestyle');
    expect(resolveConversionFactorKey('1500 Free LCM')).toBe('1500 Freestyle');
    expect(resolveConversionFactorKey('400 IM LCM')).toBe('400 Individual Medley');
    // A 50 of a stroke rides the 100's factor, as it always has.
    expect(resolveConversionFactorKey('50 Back SCM')).toBe('100 Backstroke');
    expect(resolveConversionFactorKey('1 mtr Diving')).toBeNull();
  });

  it('leaves every label that already resolved on its old factor row', () => {
    for (const key of Object.keys(CONVERSION_FACTORS)) {
      expect(resolveConversionFactorKey(key)).toBe(key);
    }
    expect(resolveConversionFactorKey('50 Backstroke')).toBe('100 Backstroke');
    expect(resolveConversionFactorKey('200 IM')).toBe('200 IM');
  });

  it('converts a SwimCloud label to exactly the time its canonical spelling gets', () => {
    const pairs: Array<[string, string, string]> = [
      ['50 Free LCM', '50 Freestyle', '24.20'],
      ['400 Free LCM', '400 Freestyle', '4:48.31'],
      ['1500 Free LCM', '1500 Freestyle', '18:18.30'],
      ['100 Back SCM', '100 Backstroke', '58.00'],
      ['200 Breast LCM', '200 Breaststroke', '2:25.44'],
      ['100 Fly SCY', '100 Butterfly', '50.00'],
      ['400 IM LCM', '400 Individual Medley', '4:52.50'],
    ];
    for (const [label, canonical, time] of pairs) {
      for (const course of ['LCM', 'SCM', 'SCY'] as const) {
        for (const gender of [Gender.MEN, Gender.WOMEN]) {
          expect(convertToSCY(time, label, gender, course, { team: HSU })).toBe(
            convertToSCY(time, canonical, gender, course, { team: HSU })
          );
        }
      }
    }
  });

  it('remaps the metric distance freestyles onto their SCY slot', () => {
    const cases: Array<[string, string]> = [
      ['400 Free LCM', '500 Free SCY'],
      ['800 Free LCM', '1000 Free SCY'],
      ['1500 Free LCM', '1650 Free SCY'],
      ['1500 Free SCM', '1650 Free SCY'],
    ];
    for (const [label, expected] of cases) {
      const course = label.endsWith('SCM') ? 'SCM' : 'LCM';
      const out = convertSwimToSCY(label, '4:00.00', Gender.MEN, course);
      expect(out.event).toBe(expected);
      expect(canonicalProgramEvent(out.event)).toBe(normalizeEventLabel(expected));
    }
    // The canonical spelling keeps its pre-2026-09-22 output.
    expect(convertSwimToSCY('400 Freestyle', '4:00.00', Gender.MEN, 'LCM').event).toBe('500 Freestyle');
    // A non-distance SwimCloud label keeps its own family, course set to SCY.
    expect(convertSwimToSCY('100 Back LCM', '59.86', Gender.MEN, 'LCM').event).toBe('100 Back SCY');
    // A label that resolved only through normalization takes the canonical form.
    expect(convertSwimToSCY('Event 8 Men 400 Meter Freestyle', '4:00.00', Gender.MEN, 'LCM').event).toBe(
      '500 Freestyle'
    );
  });

  it('still passes relays through untouched, and still refuses diving', () => {
    expect(convertSwimToSCY('400 Free Relay LCM', '3:40.00', Gender.MEN, 'LCM')).toStrictEqual({
      event: '400 Free Relay LCM',
      time: '3:40.00',
    });
    expect(convertSwimToSCYDetailed('400 Free Relay LCM', '3:40.00', Gender.MEN, 'LCM').basis).toStrictEqual({
      method: 'identity',
      reason: 'relay_not_converted',
    });
    expect(() => convertToSCY('285.60', '1 mtr Diving', Gender.MEN, 'SCM')).toThrow(
      /No published SCM→SCY conversion factor/
    );
  });

  it('leaves an SCY swim exactly as recorded, whatever the options say', () => {
    expect(convertToSCY('54.49', '100 Freestyle', Gender.MEN, 'SCY', { division: 'D1' })).toBe('54.49');
    expect(convertSwimToSCY('50 Free SCY', '21.00', Gender.MEN, 'SCY', { team: HSU })).toStrictEqual({
      event: '50 Free SCY',
      time: '21.00',
    });
    expect(convertSwimToSCYDetailed('50 Free SCY', '21.00', Gender.MEN, 'SCY').basis).toStrictEqual({
      method: 'identity',
      reason: 'recorded_in_scy',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* P1 — the SCM table follows the team's division                              */
/* -------------------------------------------------------------------------- */

describe('P1: an SCM swim converts with its division table, truncated', () => {
  it('converts a D2 (HSU) 100 Free SCM 54.49 with 0.896: 48.82304 -> 48.82', () => {
    const out = convertSwimToSCYDetailed('100 Free SCM', '54.49', Gender.MEN, 'SCM', { team: HSU });
    expect(out.time).toBe('48.82');
    expect(out.basis).toStrictEqual({
      method: 'ncaa_scm_table',
      factor: 0.896,
      factorEvent: '100 Freestyle',
      row: 'allOtherEvents',
      tableId: RULES_BOOK,
      division: 'D2',
      reason: 'division_table',
    });
  });

  it('converts a D1 team’s with 0.906 and truncates: 49.36794 -> 49.36, not 49.37', () => {
    const out = convertSwimToSCYDetailed('100 Free SCM', '54.49', Gender.MEN, 'SCM', { team: D1_TEAM });
    expect(out.time).toBe('49.36');
    expect(out.basis).toMatchObject({ factor: 0.906, tableId: D1_TABLE, division: 'D1' });
    // Rounding gives a different answer here — this case would catch a regression to rounding.
    expect(formatSecondsToTime(54.49 * 0.906)).toBe('49.37');
  });

  it('truncates on the Rules Book table too: 58.00 x 0.896 = 51.968 -> 51.96', () => {
    expect(convertToSCY('58.00', '100 Backstroke', Gender.MEN, 'SCM', { team: HSU })).toBe('51.96');
    expect(formatSecondsToTime(58 * 0.896)).toBe('51.97');
  });

  it('uses the distance rows for 400/800/1500 metres', () => {
    // 240 x 1.143 = 274.32; 240 x 1.153 = 276.72
    expect(convertSwimToSCY('400 Free SCM', '4:00.00', Gender.MEN, 'SCM', { team: HSU })).toStrictEqual({
      event: '500 Free SCY',
      time: '4:34.32',
    });
    expect(convertToSCY('4:00.00', '400 Freestyle', Gender.WOMEN, 'SCM', { division: 'D1' })).toBe('4:36.72');
    // 480 x 1.143 = 548.64
    expect(convertToSCY('8:00.00', '800 Free SCM', Gender.MEN, 'SCM', { team: HSU })).toBe('9:08.64');
    // 960 x 1.003 = 962.88; 960 x 1.013 = 972.48
    expect(convertToSCY('16:00.00', '1500 Free SCM', Gender.MEN, 'SCM', { team: HSU })).toBe('16:02.88');
    expect(convertToSCY('16:00.00', '1500 Freestyle', Gender.MEN, 'SCM', { division: 'D1' })).toBe('16:12.48');
  });

  it('never falls back to D1 when the division is unknown, and says so', () => {
    const cases = [
      convertSwimToSCYDetailed('100 Free SCM', '54.49', Gender.MEN, 'SCM'),
      convertSwimToSCYDetailed('100 Free SCM', '54.49', Gender.MEN, 'SCM', { team: 'No Such Swim Club' }),
      convertSwimToSCYDetailed('100 Free SCM', '54.49', Gender.MEN, 'SCM', { division: null }),
      // A discontinued program is not its last division (Lindenwood was D1).
      convertSwimToSCYDetailed('100 Free SCM', '54.49', Gender.MEN, 'SCM', { team: 'Lindenwood University' }),
    ];
    for (const out of cases) {
      expect(out.time).toBe('48.82');
      expect(out.basis).toMatchObject({
        method: 'ncaa_scm_table',
        factor: 0.896,
        tableId: RULES_BOOK,
        division: null,
        reason: 'division_unknown',
      });
    }
  });

  it('uses the Rules Book table for D3 and NAIA, which publish no factor', () => {
    for (const division of ['D3', 'NAIA'] as const) {
      const choice = scmConversionTableFor(division);
      expect(choice.table.id).toBe(RULES_BOOK);
      expect(choice.division).toBe(division);
      expect(choice.reason).toBe('division_publishes_none');
      expect(convertToSCY('54.49', '100 Freestyle', Gender.MEN, 'SCM', { division })).toBe('48.82');
    }
  });

  it('lets an explicit division win over the team', () => {
    expect(convertToSCY('54.49', '100 Freestyle', Gender.MEN, 'SCM', { team: HSU, division: 'D1' })).toBe('49.36');
  });

  it('leaves LCM alone: no division effect, still rounded', () => {
    const base = convertToSCY('24.25', '50 Freestyle', Gender.MEN, 'LCM');
    // 24.25 x 0.87 = 21.0975 — rounds to 21.10, would truncate to 21.09.
    expect(base).toBe('21.10');
    expect(convertToSCY('24.25', '50 Freestyle', Gender.MEN, 'LCM', { division: 'D1' })).toBe(base);
    expect(convertToSCY('24.25', '50 Free LCM', Gender.MEN, 'LCM', { team: HSU })).toBe(base);
    expect(convertSwimToSCYDetailed('50 Free LCM', '24.25', Gender.MEN, 'LCM').basis).toStrictEqual({
      method: 'lcm_factor_table',
      factor: 0.87,
      factorEvent: '50 Freestyle',
    });
  });

  it('truncates exactly, with no float drift, across every factor and a wide range of times', () => {
    const factors = [0.896, 0.906, 1.143, 1.153, 1.003, 1.013];
    for (const factor of factors) {
      const thousandths = Math.round(factor * 1000);
      for (let hundredths = 1000; hundredths <= 120_000; hundredths += 13) {
        const got = ncaaScmConvertedSeconds(hundredths / 100, factor);
        const expected = Math.floor((hundredths * thousandths) / 1000);
        expect(Math.round(got * 100)).toBe(expected);
      }
    }
  });

  it('passes NT through unchanged', () => {
    expect(convertToSCY('NT', '100 Freestyle', Gender.MEN, 'SCM', { team: HSU })).toBe('NT');
  });
});

/* -------------------------------------------------------------------------- */
/* Source provenance — the numbers are the PDFs' numbers                       */
/* -------------------------------------------------------------------------- */

type ManifestEntry = { id: string; filename: string; sha256: string };
const manifest = JSON.parse(readFileSync(join(sourcesDir, 'manifest.json'), 'utf8')) as {
  sources: ManifestEntry[];
};

const hasPdftotext = (() => {
  const probe = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  return !probe.error;
})();

function pdfPageText(filename: string, page?: number): string {
  const args = page ? ['-f', String(page), '-l', String(page)] : [];
  const run = spawnSync('pdftotext', [...args, '-layout', join(sourcesDir, filename), '-'], {
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`pdftotext failed on ${filename}: ${run.stderr}`);
  return run.stdout;
}

const ROW_PATTERNS: Record<NcaaScmConversionRow, RegExp> = {
  free400To500: /400 meters to 500 yards\s+([\d.]+)/,
  free800To1000: /800 meters to 1,?000 yards\s+([\d.]+)/,
  free1500To1650: /1,?500 meters to 1,?650 yards\s+([\d.]+)/,
  allOtherEvents: /All other events\s+([\d.]+)/,
};

const TABLES: NcaaScmConversionTable[] = Object.values(NCAA_SCM_CONVERSION_TABLES);

describe('the NCAA SCM tables match their archived sources', () => {
  it('snapshots the published factors', () => {
    expect(NCAA_SCM_CONVERSION_TABLES[RULES_BOOK].factors).toStrictEqual({
      free400To500: 1.143,
      free800To1000: 1.143,
      free1500To1650: 1.003,
      allOtherEvents: 0.896,
    });
    expect(NCAA_SCM_CONVERSION_TABLES[D1_TABLE].factors).toStrictEqual({
      free400To500: 1.153,
      free800To1000: 1.153,
      free1500To1650: 1.013,
      allOtherEvents: 0.906,
    });
  });

  it('names archived PDFs whose bytes match the manifest', () => {
    for (const table of TABLES) {
      expect(table.source.manifestIds.length).toBe(table.source.filenames.length);
      table.source.manifestIds.forEach((id, i) => {
        const entry = manifest.sources.find((s) => s.id === id);
        expect(entry, `manifest entry ${id}`).toBeDefined();
        expect(entry!.filename).toBe(table.source.filenames[i]);
        const sha = createHash('sha256').update(readFileSync(join(sourcesDir, entry!.filename))).digest('hex');
        expect(sha).toBe(entry!.sha256);
      });
    }
  });

  it('keeps the deprecated both_scm column equal to the D1 table, row for row', () => {
    const d1 = NCAA_SCM_CONVERSION_TABLES[D1_TABLE].factors;
    for (const [key, row] of Object.entries(CONVERSION_FACTORS)) {
      expect(row.both_scm, key).toBe(d1[ncaaScmConversionRow(key)]);
    }
  });

  it.skipIf(!hasPdftotext)('reads every factor, the statement and the truncation rule off the PDF page', () => {
    for (const table of TABLES) {
      for (const filename of table.source.filenames) {
        const text = pdfPageText(filename, table.source.page);
        const flat = text.replace(/\s+/g, ' ');
        expect(flat, filename).toContain('Short-Course Conversion Factors (Men and Women)');
        for (const [row, pattern] of Object.entries(ROW_PATTERNS) as Array<[NcaaScmConversionRow, RegExp]>) {
          const match = text.match(pattern);
          expect(match, `${filename} ${row}`).not.toBeNull();
          expect(Number(match![1]), `${filename} ${row}`).toBe(table.factors[row]);
        }
        expect(flat).toContain(table.source.statement);
        expect(flat).toContain('drop, without rounding, all units smaller than a hundredth of a second');
      }
    }
  });

  it.skipIf(!hasPdftotext)('finds no conversion table in the D3 or NAIA sheet', () => {
    for (const filename of ['2026-27D3XSW_QualifyingStandards.pdf', '2026-27-SD-Qualifying-Standards-wo-Relays.pdf']) {
      expect(pdfPageText(filename), filename).not.toMatch(/conversion/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* End to end — the real SwimCloud capture now projects                        */
/* -------------------------------------------------------------------------- */

const FIXTURE_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/',
  retrievedAt: '2026-09-22T12:02:00.000Z',
  track: 'browser-extension',
};

function realFixtureSwims(): HistoricalSwim[] {
  const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', 'profile_fastest_times-1330318.json'), 'utf8');
  const parsed = parseSwimmerFastestTimesJson(raw, FIXTURE_CONTEXT);
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(
    { ...parsed.data, name: 'Fixture Swimmer' },
    { team: HSU, gender: Gender.MEN }
  );
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

describe('end to end: metric SwimCloud swims reach the projection', () => {
  it('yields the brief’s swim: 50 Free LCM 24.20 -> 21.05 in the 50 Free SCY slot', () => {
    const out = [...convertedHistorySwims([swim({})])];
    expect(out).toHaveLength(1);
    expect(out[0].timeType).toBe('LCM');
    expect(out[0].converted).toMatchObject({ event: '50 Free SCY', time: '21.05', sourceCourse: 'LCM' });
    expect(out[0].converted.basis).toMatchObject({ method: 'lcm_factor_table', factorEvent: '50 Freestyle' });
  });

  it('converts an HSU SCM swim with the D2 table', () => {
    const [row] = [...convertedHistorySwims([swim({ event: '100 Free SCM', time: '54.49', timeType: 'SCM' })])];
    expect(row.converted.time).toBe('48.82');
    expect(row.converted.basis).toMatchObject({ tableId: RULES_BOOK, division: 'D2', reason: 'division_table' });
  });

  it('projects all 17 LCM swims of the real HSU fixture swimmer (0 before the fix)', () => {
    const swims = realFixtureSwims();
    const lcm = swims.filter((s) => s.timeType === 'LCM');
    expect(lcm).toHaveLength(17);
    const projected = [...convertedHistorySwims(swims)].filter((p) => p.timeType === 'LCM');
    expect(projected.map((p) => p.swim.event).sort()).toStrictEqual(lcm.map((s) => s.event).sort());
  });

  it('fills a converted best for every program event in the cross-course table', () => {
    const table = buildCrossCourseTable(workspaceWith(realFixtureSwims()), { team: HSU, gender: Gender.MEN });
    const converted = table.rows.filter((r) => r.convertedBest);
    expect(converted.map((r) => r.event).sort()).toStrictEqual(
      [
        '50 Freestyle',
        '100 Freestyle',
        '200 Freestyle',
        '500 Freestyle',
        '1000 Freestyle',
        '1650 Freestyle',
        '100 Backstroke',
        '200 Backstroke',
        '100 Breaststroke',
        '200 Breaststroke',
        '100 Butterfly',
        '200 Butterfly',
        '200 Individual Medley',
        '400 Individual Medley',
      ].sort()
    );
    const fifty = table.rows.find((r) => r.event === '50 Freestyle');
    expect(fifty?.convertedBest).toMatchObject({
      time: '21.05',
      sourceTime: '24.20',
      sourceCourse: 'LCM',
      sourceEvent: '50 Free LCM',
      basis: { method: 'lcm_factor_table' },
    });
    // The real SCY 20.99 is faster, so the table still recommends it.
    expect(fifty?.scyBest?.time).toBe('20.99');
    expect(fifty?.effectiveBest).toBe('scy');
    const fiveHundred = table.rows.find((r) => r.event === '500 Freestyle');
    expect(fiveHundred?.convertedBest?.sourceEvent).toBe('400 Free LCM');
  });

  it('never gives one event two best-time keys (no phantom second slot)', () => {
    const profile = categorizeBestEvents(
      realFixtureSwims(),
      HSU,
      Gender.MEN,
      'Fixture Swimmer',
      NSISC_PRESET_SETTINGS
    );
    const keys = Object.keys(profile.bestByEvent);
    const normalized = keys.map(normalizeEventLabel);
    expect(new Set(normalized).size).toBe(normalized.length);
    // The actual SCY swim is the faster, so it holds the slot.
    expect(profile.bestByEvent['50 Free SCY']?.time).toBe('20.99');
    expect(profile.bestByEvent['50 Freestyle']).toBeUndefined();
  });

  it('gives a metric-only recruit one roster candidate per event, on the converted time', () => {
    const history = [
      swim({ event: '50 Free LCM', time: '24.20', timeType: 'LCM' }),
      swim({ event: '50 Free SCM', time: '23.00', timeType: 'SCM' }),
      swim({ event: '400 Free LCM', time: '4:10.00', timeType: 'LCM' }),
    ];
    const result = importHistoryToRoster(workspaceWith([]), history, { team: HSU, gender: Gender.MEN });
    const recruits = result.patch.recruits ?? [];
    const events = recruits.map((r) => r.event);
    expect(new Set(events.map(normalizeEventLabel)).size).toBe(events.length);
    // 23.00 x 0.896 = 20.608 -> 20.60 (D2, truncated) beats 24.20 LCM -> 21.05.
    expect(recruits.find((r) => normalizeEventLabel(r.event) === '50 Freestyle')?.time).toBe('20.60');
    expect(recruits.some((r) => normalizeEventLabel(r.event) === '500 Freestyle')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Cut comparison — the converted time uses the judged division's table        */
/* -------------------------------------------------------------------------- */

describe('the indicative cut comparison converts with the judged division', () => {
  it('reports the table on scyEquivalentForCutline', () => {
    const d2 = scyEquivalentForCutline('100 Freestyle', 54.49, 'Men', 'SCM', { division: 'D2' });
    const d1 = scyEquivalentForCutline('100 Freestyle', 54.49, 'Men', 'SCM', { division: 'D1' });
    expect(d2).toMatchObject({ time: '48.82', basis: { tableId: RULES_BOOK, division: 'D2' } });
    expect(d1).toMatchObject({ time: '49.36', basis: { tableId: D1_TABLE, division: 'D1' } });
    const bare = scyEquivalentForCutline('100 Freestyle', 54.49, 'Men', 'SCM');
    expect(bare?.basis).toMatchObject({ tableId: RULES_BOOK, reason: 'division_unknown' });
  });

  it('carries the basis onto a converted_estimate, which is still never a tag', () => {
    // D2 men's 50 Free A standard is 19.39 SCY. 21.00 SCM x 0.896 = 18.816 -> 18.81.
    const result = buildCutlineTag({ gender: 'Men', event: '50 Freestyle', division: 'D2', time: '21.00', swimCourse: 'SCM' });
    expect(result.state).toBe('converted_estimate');
    expect(result.tag).toBeNull();
    expect(result.indicative?.convertedTime).toBe('18.81');
    expect(result.indicative?.conversionBasis).toMatchObject({
      method: 'ncaa_scm_table',
      tableId: RULES_BOOK,
      division: 'D2',
      reason: 'division_table',
    });
  });
});
