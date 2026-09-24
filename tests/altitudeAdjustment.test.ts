/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Altitude (plans/2026-09-22/01, P2).
 *
 * Two facts, both read from primary sources rather than assumed:
 *
 * 1. **The NCAA altitude chart** is printed in the archived D2 2026-27 sheets
 *    (page 2) and the D1 2025-26 sheet (page 3), with identical figures.
 *    `NCAA_ALTITUDE_ADJUSTMENT_TABLE` holds it; this file snapshots every value
 *    and, where `pdftotext -table` is available, re-reads the PDFs. (`-layout`
 *    misaligns the rows of this chart.)
 * 2. **SwimCloud publishes the adjusted time, not the swum one.** Swimmer
 *    1401610's `400 Free LCM` reads `247.11` (4:07.11) with chip `A` /
 *    "Altitude Adjusted"; the meet results page shows the swim as 4:12.11. The
 *    5.00 difference is the chart's 400 m figure for 4,251-6,500 ft.
 *
 * So an `A` swim is imported as-is, flagged `isAltitudeAdjusted`, stays a best
 * (the NCAA enters the adjusted time), and is never adjusted a second time.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud';
import { swimCloudSwimmerTimesToHistoricalSwims } from '@omniswim/manager/lib/swimCloudImportBridge';
import { NCAA_ALTITUDE_ADJUSTMENT_TABLE, type NcaaAltitudeRow } from '../packages/core/src/constants';
import { Gender, type HistoricalSwim, type Workspace } from '../packages/core/src/types';
import {
  ALTITUDE_400_YARD_IM_USER_DECISION,
  adjustSwimForAltitude,
  ncaaAltitudeAdjustment,
  ncaaAltitudeElevationClass,
} from '../packages/core/src/lib/altitude';
import { categorizeBestEvents, mergeHistoryIndex } from '../packages/core/src/lib/athleteHistory';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { buildCrossCourseTable } from '../packages/core/src/lib/crossCourseArbitrage';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { convertToSCY } from '../packages/core/src/lib/utils';
import { buildCutlineTagForTeam } from '../packages/core/src/lib/cutlineTags';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');
const HSU = 'Henderson State';
const NAME = 'Fixture Swimmer';

/* -------------------------------------------------------------------------- */
/* The chart, against its archived sources                                     */
/* -------------------------------------------------------------------------- */

type ManifestEntry = { id: string; filename: string; sha256: string };
const manifest = JSON.parse(readFileSync(join(sourcesDir, 'manifest.json'), 'utf8')) as {
  sources: ManifestEntry[];
};

function pdfTableText(filename: string, page?: number) {
  const args = page ? ['-f', String(page), '-l', String(page)] : [];
  return spawnSync('pdftotext', [...args, '-table', join(sourcesDir, filename), '-'], { encoding: 'utf8' });
}

/** `-table` is an xpdf option; poppler's pdftotext lacks it. Skip rather than misread. */
const hasPdftotextTable = (() => {
  const probe = pdfTableText('2026-27D2MSW_QualStandards.pdf', 2);
  return !probe.error && probe.status === 0 && /Altitude/.test(probe.stdout);
})();

/** Row label as each sheet prints it. The D1 sheet writes `500 Yards-400 Meters`. */
const ROW_PATTERNS: Record<NcaaAltitudeRow, RegExp> = {
  y100m100: /^100 Yards\/Meters\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/m,
  y200m200: /^200 Yards\/Meters\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/m,
  y500m400: /^500 Yards[/-]400 Meters\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/m,
  y1000m800: /^1,000 Yards\/800 Meters\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/m,
  y1650m1500: /^1,650 Yards\/1,500 Meters\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/m,
};

describe('the NCAA altitude chart matches its archived sources', () => {
  it('snapshots every published figure', () => {
    expect(NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds).toStrictEqual({
      y100m100: { I: 0, II: 0.1, III: 0.15 },
      y200m200: { I: 0.5, II: 1.2, III: 1.6 },
      y500m400: { I: 2.5, II: 5.0, III: 7.0 },
      y1000m800: { I: 6.3, II: 11.4, III: 18.5 },
      y1650m1500: { I: 11.0, II: 20.0, III: 32.5 },
    });
    expect(NCAA_ALTITUDE_ADJUSTMENT_TABLE.relayMultiplier).toBe(4);
    expect(NCAA_ALTITUDE_ADJUSTMENT_TABLE.thresholdFeet).toBe(3000);
    expect(NCAA_ALTITUDE_ADJUSTMENT_TABLE.elevationClasses).toStrictEqual({
      I: { minFeet: 3000, maxFeet: 4250, label: '3,000-4,250 Ft.' },
      II: { minFeet: 4251, maxFeet: 6500, label: '4,251-6,500 Ft.' },
      III: { minFeet: 6501, maxFeet: null, label: 'Above 6,500 Ft.' },
    });
  });

  it('names archived PDFs whose bytes match the manifest', () => {
    for (const doc of NCAA_ALTITUDE_ADJUSTMENT_TABLE.source.documents) {
      const entry = manifest.sources.find((s) => s.id === doc.manifestId);
      expect(entry, doc.manifestId).toBeDefined();
      expect(entry!.filename).toBe(doc.filename);
      const sha = createHash('sha256').update(readFileSync(join(sourcesDir, doc.filename))).digest('hex');
      expect(sha).toBe(entry!.sha256);
    }
  });

  it.skipIf(!hasPdftotextTable)('reads every figure and the instruction off each cited page', () => {
    for (const doc of NCAA_ALTITUDE_ADJUSTMENT_TABLE.source.documents) {
      const run = pdfTableText(doc.filename, doc.page);
      expect(run.status, doc.filename).toBe(0);
      const text = run.stdout;
      const flat = text.replace(/\s+/g, ' ');
      expect(flat, doc.filename).toContain('Times achieved at an altitude of 3,000 feet or higher may be adjusted');
      for (const cls of Object.values(NCAA_ALTITUDE_ADJUSTMENT_TABLE.elevationClasses)) {
        expect(flat, `${doc.filename} ${cls.label}`).toContain(cls.label);
      }
      for (const [row, pattern] of Object.entries(ROW_PATTERNS) as Array<[NcaaAltitudeRow, RegExp]>) {
        const match = text.match(pattern);
        expect(match, `${doc.filename} ${row}`).not.toBeNull();
        expect(match!.slice(1, 4).map(Number), `${doc.filename} ${row}`).toStrictEqual([
          NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds[row].I,
          NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds[row].II,
          NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds[row].III,
        ]);
      }
      expect(flat, doc.filename).toContain(NCAA_ALTITUDE_ADJUSTMENT_TABLE.source.statement);
      expect(flat, doc.filename).toContain('This is the time to be used on the entry form.');
    }
  });

  it.skipIf(!hasPdftotextTable)('finds no altitude chart in the D3 or NAIA sheet', () => {
    for (const filename of ['2026-27D3XSW_QualifyingStandards.pdf', '2026-27-SD-Qualifying-Standards-wo-Relays.pdf']) {
      const run = pdfTableText(filename);
      expect(run.status, filename).toBe(0);
      expect(run.stdout, filename).not.toMatch(/altitude/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Applying the chart                                                          */
/* -------------------------------------------------------------------------- */

describe('ncaaAltitudeAdjustment', () => {
  it('reproduces SwimCloud’s own adjustment of swimmer 1401610’s 400 Free LCM', () => {
    // Swum 4:12.11 (meet results page). SwimCloud publishes 247.11 = 4:07.11.
    const result = ncaaAltitudeAdjustment({
      event: '400 Free LCM',
      time: '4:12.11',
      course: 'LCM',
      elevation: { elevationClass: 'II' },
    });
    expect(result).toMatchObject({
      status: 'adjusted',
      event: '400 Freestyle',
      row: 'y500m400',
      elevationClass: 'II',
      relay: false,
      secondsSubtracted: 5,
      actualTime: '4:12.11',
      adjustedTime: '4:07.11',
      adjustedSeconds: 247.11,
    });
  });

  it('bands elevation in whole feet exactly as printed, and not below 3,000 ft', () => {
    expect(ncaaAltitudeElevationClass(2999)).toBeNull();
    expect(ncaaAltitudeElevationClass(3000)).toBe('I');
    expect(ncaaAltitudeElevationClass(4250)).toBe('I');
    expect(ncaaAltitudeElevationClass(4251)).toBe('II');
    expect(ncaaAltitudeElevationClass(6500)).toBe('II');
    expect(ncaaAltitudeElevationClass(6501)).toBe('III');
    const below = ncaaAltitudeAdjustment({
      event: '200 Freestyle',
      time: '1:40.00',
      course: 'SCY',
      elevation: { feet: 2999 },
    });
    expect(below).toStrictEqual({ status: 'below_threshold', feet: 2999, thresholdFeet: 3000 });
  });

  it('refuses an elevation that falls in no printed band', () => {
    for (const feet of [4250.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ncaaAltitudeElevationClass(feet), String(feet)).toThrow(RangeError);
    }
  });

  it('takes each row’s figure by course: 500 y and 400 m share one row', () => {
    const at = (event: string, time: string, course: 'SCY' | 'SCM' | 'LCM', feet: number) =>
      ncaaAltitudeAdjustment({ event, time, course, elevation: { feet } });
    expect(at('500 Freestyle', '4:30.00', 'SCY', 7000)).toMatchObject({ secondsSubtracted: 7, adjustedTime: '4:23.00' });
    expect(at('1000 Freestyle', '9:30.00', 'SCY', 3500)).toMatchObject({ secondsSubtracted: 6.3, adjustedTime: '9:23.70' });
    expect(at('1650 Freestyle', '16:00.00', 'SCY', 8000)).toMatchObject({ secondsSubtracted: 32.5, adjustedTime: '15:27.50' });
    expect(at('1500 Free LCM', '16:00.00', 'LCM', 5000)).toMatchObject({ row: 'y1650m1500', secondsSubtracted: 20 });
    expect(at('200 Back SCM', '2:00.00', 'SCM', 5000)).toMatchObject({ row: 'y200m200', secondsSubtracted: 1.2 });
    // The chart's own printed `.0`: adjusted, by zero — not absent.
    expect(at('100 Breaststroke', '55.00', 'SCY', 3500)).toMatchObject({
      status: 'adjusted',
      secondsSubtracted: 0,
      adjustedTime: '55.00',
    });
  });

  it('prints nothing for a 50, a 400-yard freestyle, a 25 or diving', () => {
    const miss = (event: string, course: 'SCY' | 'SCM' | 'LCM') =>
      ncaaAltitudeAdjustment({ event, time: '30.00', course, elevation: { elevationClass: 'III' } }).status;
    expect(miss('50 Free SCY', 'SCY')).toBe('event_not_in_table');
    expect(miss('50 Free LCM', 'LCM')).toBe('event_not_in_table');
    // The 400-yard IM decision covers the IM only.
    expect(miss('400 Free SCY', 'SCY')).toBe('event_not_in_table');
    expect(miss('25 Fly SCY', 'SCY')).toBe('event_not_in_table');
    expect(miss('1 mtr Diving', 'SCM')).toBe('event_not_in_table');
    // A metric 400 IM is a "400 Meters (Individual Events)" swim.
    expect(miss('400 IM LCM', 'LCM')).toBe('adjusted');
  });

  it('reads the chart rows as the NCAA prints them', () => {
    const at = (event: string, course: 'SCY' | 'SCM' | 'LCM') =>
      ncaaAltitudeAdjustment({ event, time: '4:30.00', course, elevation: { elevationClass: 'II' } });
    for (const [event, course] of [
      ['500 Freestyle', 'SCY'],
      ['400 IM LCM', 'LCM'],
      ['400 Free SCM', 'SCM'],
      ['200 Back SCY', 'SCY'],
    ] as const) {
      const got = at(event, course);
      expect(got, event).toMatchObject({ status: 'adjusted', rowBasis: 'ncaa_chart' });
      expect(got, event).not.toHaveProperty('userDecision');
    }
  });

  /*
   * User decision, 2026-09-24: a 400-yard IM takes the "500 Yards/400 Meters"
   * row. The chart prints no 400-yard row, so this is the user's reading and
   * not the NCAA's. The result must say so.
   */
  it('gives a 400-yard IM the 500 y / 400 m row, marked as a user decision', () => {
    expect(ALTITUDE_400_YARD_IM_USER_DECISION).toMatchObject({
      id: 'user-decision-2026-09-24-altitude-400y-im',
      decidedOn: '2026-09-24',
      event: '400 Individual Medley',
      course: 'SCY',
      row: 'y500m400',
    });
    expect(ALTITUDE_400_YARD_IM_USER_DECISION.statement).toMatch(/not the NCAA/);
    expect(Object.isFrozen(ALTITUDE_400_YARD_IM_USER_DECISION)).toBe(true);

    // Class II, 500 y / 400 m row: 5.0 s.
    for (const label of ['400 IM SCY', '400 Individual Medley', 'Event 15 Men 400 Yard IM']) {
      const got = ncaaAltitudeAdjustment({
        event: label,
        time: '3:58.24',
        course: 'SCY',
        elevation: { elevationClass: 'II' },
      });
      expect(got, label).toStrictEqual({
        status: 'adjusted',
        event: '400 Individual Medley',
        course: 'SCY',
        elevationClass: 'II',
        row: 'y500m400',
        rowBasis: 'user_decision',
        userDecision: ALTITUDE_400_YARD_IM_USER_DECISION,
        relay: false,
        secondsSubtracted: 5,
        actualTime: '3:58.24',
        actualSeconds: 238.24,
        adjustedTime: '3:53.24',
        adjustedSeconds: 233.24,
        table: 'ncaa-altitude-2026-27',
      });
    }
    // Each column reads the same row's figure.
    const figure = (elevationClass: 'I' | 'II' | 'III') =>
      ncaaAltitudeAdjustment({ event: '400 IM SCY', time: '4:00.00', course: 'SCY', elevation: { elevationClass } });
    expect(figure('I')).toMatchObject({ secondsSubtracted: NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds.y500m400.I });
    expect(figure('III')).toMatchObject({ secondsSubtracted: NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds.y500m400.III });
    // The decision adds nothing to the sourced table.
    expect(Object.keys(NCAA_ALTITUDE_ADJUSTMENT_TABLE.seconds)).toStrictEqual([
      'y100m100',
      'y200m200',
      'y500m400',
      'y1000m800',
      'y1650m1500',
    ]);
  });

  it('refuses the 400-yard IM decision below 3,000 ft and on a stored swim already adjusted', () => {
    expect(
      ncaaAltitudeAdjustment({ event: '400 IM SCY', time: '4:00.00', course: 'SCY', elevation: { feet: 2500 } }).status
    ).toBe('below_threshold');
    expect(() =>
      adjustSwimForAltitude(
        { event: '400 IM SCY', time: '4:00.00', timeType: 'SCY', isAltitudeAdjusted: true },
        { elevationClass: 'II' }
      )
    ).toThrow(/already altitude-adjusted/);
  });

  /*
   * Relays: "four times the appropriate figures" is read as four times the
   * figure for one leg's distance. The user confirmed this reading on
   * 2026-09-24. A 200 relay (50 legs) gets none, because the chart prints no 50.
   */
  it('gives a relay four times its leg distance’s figure', () => {
    const relay = (event: string) =>
      ncaaAltitudeAdjustment({ event, time: '3:00.00', course: 'SCY', elevation: { elevationClass: 'II' } });
    expect(relay('400 Medley Relay')).toMatchObject({
      relay: true,
      row: 'y100m100',
      rowBasis: 'ncaa_chart',
      secondsSubtracted: 0.4,
    });
    expect(relay('400 Freestyle Relay')).toMatchObject({ relay: true, row: 'y100m100', secondsSubtracted: 0.4 });
    expect(relay('800 Freestyle Relay')).toMatchObject({ relay: true, row: 'y200m200', secondsSubtracted: 4.8 });
    expect(relay('Event 20 Men 4x100 Yard Medley Relay')).toMatchObject({ relay: true, row: 'y100m100' });
    // 50-yard legs: the chart prints no 50, so four times nothing is nothing.
    expect(relay('200 Freestyle Relay').status).toBe('event_not_in_table');
    expect(relay('200 Medley Relay').status).toBe('event_not_in_table');
    expect(relay('Event 11 Men 4x50 Yard Medley Relay').status).toBe('event_not_in_table');
    // Not the relay's total distance: a 400 relay is not read on the 400 m row.
    expect(relay('400 Freestyle Relay')).not.toMatchObject({ row: 'y500m400' });
  });

  it('throws on a time that is not a time', () => {
    expect(() =>
      ncaaAltitudeAdjustment({ event: '200 Freestyle', time: 'NT', course: 'SCY', elevation: { elevationClass: 'I' } })
    ).toThrow(/not a swim time/);
  });
});

/* -------------------------------------------------------------------------- */
/* SwimCloud's A tag                                                           */
/* -------------------------------------------------------------------------- */

function caseyParse() {
  const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', 'profile_fastest_times-1401610-altitude.json'), 'utf8');
  const parsed = parseSwimmerFastestTimesJson(raw, {
    sourceUrl: 'https://www.swimcloud.com/api/swimmers/1401610/profile_fastest_times/',
    retrievedAt: '2026-09-22T12:00:00.000Z',
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return parsed.data;
}

function caseySwims(): HistoricalSwim[] {
  const conversion = swimCloudSwimmerTimesToHistoricalSwims(
    { ...caseyParse(), name: NAME },
    { team: HSU, gender: Gender.MEN }
  );
  if (!conversion.ok) throw new Error(conversion.message);
  return [...conversion.swims];
}

describe('an A-tagged SwimCloud swim is flagged, kept as published, and still a best', () => {
  const swims = caseySwims();
  const adjusted = swims.filter((s) => s.isAltitudeAdjusted === true);

  it('flags exactly the rows the page marks Altitude Adjusted', () => {
    expect(adjusted.map((s) => [s.event, s.time, s.timeType])).toStrictEqual([['400 Free LCM', '4:07.11', 'LCM']]);
    const marked = caseyParse()
      .personalBests.filter((b) => b.tags.some((t) => t.title === 'Altitude Adjusted'))
      .map((b) => b.eventLabel);
    expect(marked).toStrictEqual(['400 Free LCM']);
  });

  it('matches the tooltip, never the visible letter', () => {
    const importOnce = (tags: { code: string; title?: string }[]) => {
      const result = swimCloudSwimmerTimesToHistoricalSwims(
        {
          swimCloudSwimmerId: '1',
          name: NAME,
          personalBests: [
            { swimKey: 'k', eventId: 'e', eventLabel: '200 Free SCY', time: '1:40.00', course: 'SCY', tags, relayLeadoff: false },
          ],
        } as never,
        { team: HSU, gender: Gender.MEN }
      );
      if (!result.ok) throw new Error('refused');
      return result.swims[0];
    };
    expect(importOnce([{ code: 'A', title: 'Altitude Adjusted' }]).isAltitudeAdjusted).toBe(true);
    // "A" is also SwimCloud's letter for a D1 A-cut chip.
    expect(importOnce([{ code: 'A', title: 'NCAA Division I A Cut' }]).isAltitudeAdjusted).toBeUndefined();
    expect(importOnce([]).isAltitudeAdjusted).toBeUndefined();
  });

  it('refuses to adjust an already-adjusted swim a second time', () => {
    expect(() => adjustSwimForAltitude(adjusted[0], { elevationClass: 'II' })).toThrow(/already altitude-adjusted/);
    // The same swim without the flag would be adjusted to 4:02.11 — the double
    // subtraction the guard exists to stop.
    const { isAltitudeAdjusted: _flag, ...unflagged } = adjusted[0];
    expect(adjustSwimForAltitude(unflagged, { elevationClass: 'II' })).toMatchObject({ adjustedTime: '4:02.11' });
  });

  it('keeps the published time through the history merge', () => {
    const merged = mergeHistoryIndex([], swims);
    const kept = merged.find((s) => s.event === '400 Free LCM');
    expect(kept).toMatchObject({ time: '4:07.11', isAltitudeAdjusted: true });
  });

  it('ranks as a best on the published time, marked for display', () => {
    const profile = categorizeBestEvents(swims, HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS);
    const best = profile.bestByEvent['500 Free SCY'];
    // The LCM factor applied once, to 4:07.11 — not to 4:12.11 (never
    // un-adjusted) and not to 4:02.11 (never adjusted twice).
    const once = convertToSCY('4:07.11', '400 Free LCM', Gender.MEN, 'LCM');
    expect(once).toBe('4:35.53');
    expect(best).toMatchObject({ time: once, altitudeAdjusted: true, convertedFrom: { sourceTime: '4:07.11' } });
    expect(best?.time).not.toBe(convertToSCY('4:02.11', '400 Free LCM', Gender.MEN, 'LCM'));
    expect(best?.time).not.toBe(convertToSCY('4:12.11', '400 Free LCM', Gender.MEN, 'LCM'));
  });

  it('carries the mark onto the recruit row and the cross-course best', () => {
    // Only the A swim, so the entry cap cannot decide whether its row is written.
    const result = importHistoryToRoster(
      { id: 'w', name: 'w', createdAt: 0, menResults: [], womenResults: [], recruits: [], scoringSettings: { ...NSISC_PRESET_SETTINGS } } as Workspace,
      adjusted,
      { team: HSU, gender: Gender.MEN }
    );
    expect(result.patch.recruits).toHaveLength(1);
    expect(result.patch.recruits![0]).toMatchObject({
      event: '500 Free SCY',
      time: '4:35.53',
      timeType: 'SCY',
      isAltitudeAdjusted: true,
      convertedFrom: { sourceEvent: '400 Free LCM', sourceTime: '4:07.11' },
    });
    expect(result.patch.athleteHistory?.[0]).toMatchObject({ time: '4:07.11', isAltitudeAdjusted: true });
    const table = buildCrossCourseTable(
      { id: 'w', name: 'w', createdAt: 0, menResults: [], womenResults: [], recruits: [], athleteHistory: swims } as Workspace,
      { team: HSU, gender: Gender.MEN }
    );
    const row = table.rows.find((r) => r.event === '500 Freestyle');
    expect(row?.convertedBest).toMatchObject({ time: '4:35.53', sourceTime: '4:07.11', altitudeAdjusted: true });
  });

  it('is judged for cuts like any metric swim, not refused', () => {
    const tag = buildCutlineTagForTeam({
      team: HSU,
      gender: Gender.MEN,
      event: adjusted[0].event,
      time: adjusted[0].time,
      swimCourse: 'LCM',
    });
    expect(tag.state).toBe('no_cut');
    expect(tag.swimSeconds).toBe(247.11);
  });
});

/* -------------------------------------------------------------------------- */
/* No pipeline applies the chart                                               */
/* -------------------------------------------------------------------------- */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe('no code path subtracts the altitude chart from an imported time', () => {
  it('reads the chart only in its definition and in altitude.ts', () => {
    // A structural guarantee. SwimCloud's A times are already adjusted and the
    // pipeline holds no elevation for any swim, so the only legitimate reader
    // is the guarded API in lib/altitude.ts. A new caller has to be added here
    // on purpose, next to the reason it is safe.
    const allowed = new Set(['packages/core/src/constants.ts', 'packages/core/src/lib/altitude.ts']);
    const offenders: string[] = [];
    for (const root of ['packages', 'apps', 'extensions'].map((d) => join(repoRoot, d))) {
      for (const file of sourceFiles(root)) {
        const rel = relative(repoRoot, file).replace(/\\/g, '/');
        if (allowed.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        if (/NCAA_ALTITUDE_ADJUSTMENT_TABLE|ncaaAltitudeAdjustment\(|adjustSwimForAltitude\(/.test(text)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });
});
