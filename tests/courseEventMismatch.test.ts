/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Events that do not exist in a course (plans/2026-09-24/01, item B4).
 *
 * User decision, 2026-09-24: "there is no such event, the 1000 is never swum
 * in SCM." A 1000 Freestyle recorded SCM is invalid: flag it, never convert
 * it. Before this change `convertToSCY` gave an SCM "1000 Freestyle" the
 * NCAA "800 meters to 1000 yards" factor (1.143 on the Rules Book table), a
 * factor the NCAA prints for an 800 m swim, and the result ranked, cut-tagged
 * and entered like a real yards time.
 *
 * The rule generalises only as far as the archived sheets reach. They pair
 * the yards 500/1000/1650 Freestyle with the short-course metres 400/800/1500
 * (NCAA conversion table rows; NAIA "500/400" and "1650/1500" labels). So a
 * yards distance recorded SCM and a metres distance recorded SCY are flagged.
 * LCM is not: no archived sheet lists the long-course events.
 *
 * No real export in this repo holds a mismatched row (checked below against
 * both roster exports). The flagged rows are built from real ones: Bartu
 * Akin's `800 Free SCM 8:17.00` (`hsuroster26-27.txt` line 123) typed under
 * the yards name, which is what the recruit form invites (it lists only yards
 * event names beside a course picker).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COURSE_DISTANCE_PAIRS,
  EventNotSwumInCourseError,
  eventNotSwumInCourse,
  findSwimsNotSwumInCourse,
  recordedCourseOfSwim,
  swimEventNotSwumInCourse,
} from '../packages/core/src/lib/courseEvents';
import {
  ClassYear,
  Gender,
  type HistoricalSwim,
  type PlannedSwimEntry,
  type Recruit,
  type Workspace,
} from '../packages/core/src/types';
import {
  buildCategorizedScoringInputs,
  convertSwimToSCY,
  convertSwimToSCYDetailed,
  convertToSCY,
  hasConversionFactorForCourse,
  ncaaScmConversionEvent,
  scyConversionOutcome,
} from '../packages/core/src/lib/utils';
import { isRankableSwim } from '../packages/core/src/lib/bestTimeEligibility';
import {
  categorizeBestEvents,
  parseSwimCloudPasteDetailed,
} from '../packages/core/src/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  importHistoryToRoster,
} from '../packages/core/src/lib/historyImportRoster';
import { scyEquivalentForCutline } from '../packages/core/src/lib/cutlineUtils';
import {
  buildCutlineTagForTeam,
  cutlineSwimOfRecord,
  cutlineTagRenderMode,
} from '../packages/core/src/lib/cutlineTags';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { buildEventTimeIndex, convertedHistorySwims } from '../packages/core/src/lib/arbitrage/shared';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';
import {
  bestTimesByEvent,
  buildStoredSwim,
  isRankableCatalogTime,
  type CatalogTeamRoster,
} from '../packages/core/src/lib/rosterCatalog';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');
const manifest = JSON.parse(readFileSync(join(sourcesDir, 'manifest.json'), 'utf8')) as {
  sources: { id: string; filename: string; sha256: string }[];
};

/** The primary workspace. `Henderson State` is a registered alias of HSU (D2). */
const HSU = 'Henderson State';
const AKIN = 'Bartu Akin';
const AKIN_MEET = 'TÜRKİYE KULÜPLER ARASI KISA KULVAR YILDIZ, GENÇ VE AÇIK YAŞ ŞAMPİYONASI';

/** `hsuroster26-27.txt` lines 115-116 and 127, verbatim: the name, the header and a real SCM row. */
const AKIN_HEADER = [AKIN, 'Event\tTime\t\tMeet\tDate\tStamp Link'];
const AKIN_200_SCM = `200 Free SCM\t1:54.30\t\t${AKIN_MEET}\tDec 27, 2024\t`;
/** Line 123, verbatim: his real 800 m swim. */
const AKIN_800_SCM = `800 Free SCM\t8:17.00\t\t${AKIN_MEET}\tDec 26, 2024\t`;
/** Line 123 with one change: the 800 m swim typed under the yards event name. */
const AKIN_1000_SCM_MISLABEL = `1000 Free SCM\t8:17.00\t\t${AKIN_MEET}\tDec 26, 2024\t`;
/** Line 124 with one change: the 400 m swim typed as yards (and without its `U`). */
const AKIN_400_SCY_MISLABEL = `400 Free SCY\t4:01.80\t\tTED Mersin Koleji Spor Kulübü Intrasquad\tNov 22, 2024\t`;

function parseAkin(rows: string[]) {
  return parseSwimCloudPasteDetailed([...AKIN_HEADER, ...rows].join('\n'), {
    team: HSU,
    gender: Gender.MEN,
    format: 'personal_bests',
  });
}

function workspaceWith(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-course-events',
    name: 'Course events',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    athleteHistory: [],
    ...over,
  } as Workspace;
}

/** A recruit row exactly as the recruit form writes it: a yards event name and the picked course. */
function formRecruit(over: Partial<Recruit> = {}): Recruit {
  return {
    id: 'recruit-akin-1000',
    name: 'Akin, Bartu',
    team: HSU,
    event: '1000 Freestyle',
    time: '8:17.00',
    gender: Gender.MEN,
    classYear: ClassYear.FR,
    timeType: 'SCM',
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* The sources                                                                 */
/* -------------------------------------------------------------------------- */

describe('the sourced pairing', () => {
  it('pairs exactly the three distance freestyle events', () => {
    expect(
      COURSE_DISTANCE_PAIRS.map(p => [p.id, p.yardsEvent, p.scmEvent, p.sources.map(s => s.printed)])
    ).toStrictEqual([
      [
        'free-500y-400m',
        '500 Freestyle',
        '400 Freestyle',
        [
          '400 meters to 500 yards',
          '400 meters to 500 yards',
          '400 meters to 500 yards',
          '500/400 FREESTYLE',
          '500/400 FREESTYLE',
        ],
      ],
      [
        'free-1000y-800m',
        '1000 Freestyle',
        '800 Freestyle',
        ['800 meters to 1000 yards', '800 meters to 1000 yards', '800 meters to 1,000 yards'],
      ],
      [
        'free-1650y-1500m',
        '1650 Freestyle',
        '1500 Freestyle',
        [
          '1500 meters to 1650 yards',
          '1500 meters to 1650 yards',
          '1,500 meters to 1,650 yards',
          '1650/1500 FREESTYLE',
          '1650/1500 FREESTYLE',
        ],
      ],
    ]);
  });

  it('cites archived PDFs whose bytes match the manifest', () => {
    for (const pair of COURSE_DISTANCE_PAIRS) {
      for (const source of pair.sources) {
        const entry = manifest.sources.find(s => s.id === source.manifestId);
        expect(entry, source.manifestId).toBeDefined();
        expect(entry!.filename).toBe(source.filename);
        const sha = createHash('sha256').update(readFileSync(join(sourcesDir, entry!.filename))).digest('hex');
        expect(sha, source.filename).toBe(entry!.sha256);
      }
    }
  });

  const pdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  const pageText = (filename: string, page: number): string => {
    const run = spawnSync(
      'pdftotext',
      ['-f', String(page), '-l', String(page), '-layout', join(sourcesDir, filename), '-'],
      { encoding: 'utf8' }
    );
    if (run.status !== 0) throw new Error(`pdftotext failed on ${filename}: ${run.stderr}`);
    return run.stdout.replace(/[ \t]+/g, ' ');
  };

  it.skipIf(pdftotext.error != null)('prints every cited label on the cited page', () => {
    for (const pair of COURSE_DISTANCE_PAIRS) {
      for (const source of pair.sources) {
        expect(pageText(source.filename, source.page), `${source.filename} p${source.page}`).toContain(
          source.printed
        );
      }
    }
  });

  it.skipIf(pdftotext.error != null)('reads the NCAA table as 25-meter to 25-yard, and the NAIA columns as yards and metres', () => {
    for (const [filename, page] of [
      ['2026-27D2MSW_QualStandards.pdf', 2],
      ['2026-27D2WSW_QualStandards.pdf', 2],
      ['2025-26D1XSW_QUALSTANDARDS.pdf', 3],
    ] as const) {
      expect(pageText(filename, page), filename).toMatch(/metric time achieved in a 25-meter racing/);
    }
    expect(pageText('2026-27-SD-Qualifying-Standards-wo-Relays.pdf', 1)).toContain('YARDS METERS YARDS METERS');
    // The 2020-21 sheet heads its metric column "SCM" in so many words.
    expect(pageText('2020-21-NAIA-SD-Qualifying-Standards.pdf', 1)).toMatch(/\bSCM\b/);
  });

  it.skipIf(pdftotext.error != null)('finds no 400, 800 or 1500 Freestyle in any NCAA 25-yard individual list', () => {
    // Corroborates the yards side. "400 Freestyle Relay" is a real yards
    // event, so relays are excluded; D3 labels relays "400 FR".
    const individual = /\b(?:400|800|1,?500) Free(?:style)?\b(?! Relay)/;
    for (const [filename, pages, yardsEvents] of [
      ['2025-26D1XSW_QUALSTANDARDS.pdf', [1, 2], ['500 Freestyle', '1,650 Freestyle']],
      ['2026-27D2MSW_QualStandards.pdf', [1], ['500 Freestyle', '1000 Freestyle', '1650 Freestyle']],
      ['2026-27D2WSW_QualStandards.pdf', [1], ['500 Freestyle', '1000 Freestyle', '1650 Freestyle']],
      ['2026-27D3XSW_QualifyingStandards.pdf', [1], ['500 Free', '1650 Free']],
    ] as const) {
      const text = pages.map(p => pageText(filename, p)).join('\n');
      expect(text, filename).toMatch(/25-Yard Course|A-cut/);
      expect(individual.exec(text), filename).toBeNull();
      for (const event of yardsEvents) expect(text, `${filename} ${event}`).toContain(event);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The predicate                                                               */
/* -------------------------------------------------------------------------- */

describe('eventNotSwumInCourse', () => {
  it.each([
    ['500 Freestyle', '400 Freestyle'],
    ['1000 Freestyle', '800 Freestyle'],
    ['1650 Freestyle', '1500 Freestyle'],
    ['1000 Free SCM', '800 Freestyle'],
    ['1,650 Freestyle', '1500 Freestyle'],
  ])('flags %s recorded SCM; SCM swims the %s', (event, courseEvent) => {
    const mismatch = eventNotSwumInCourse(event, 'SCM');
    expect(mismatch).toMatchObject({ course: 'SCM', courseEvent });
    expect(mismatch!.reason).toContain(`That course swims the ${courseEvent} in its place`);
  });

  it.each([
    ['400 Freestyle', '500 Freestyle'],
    ['800 Free SCY', '1000 Freestyle'],
    ['1500 Freestyle', '1650 Freestyle'],
  ])('flags %s recorded SCY; yards swims the %s', (event, courseEvent) => {
    expect(eventNotSwumInCourse(event, 'SCY')).toMatchObject({ course: 'SCY', courseEvent });
  });

  it('quotes the NCAA row in its reason', () => {
    expect(eventNotSwumInCourse('1000 Freestyle', 'SCM')!.reason).toBe(
      'There is no 1000 Freestyle in short-course metres. That course swims the 800 Freestyle in its place ' +
        '(NCAA conversion table: "800 meters to 1000 yards"). Check the event and course of this swim. ' +
        'It is not converted, not ranked and not judged against a standard.'
    );
  });

  it.each([
    // Each course's own events.
    ['1000 Freestyle', 'SCY'],
    ['500 Free SCY', 'SCY'],
    ['800 Freestyle', 'SCM'],
    ['400 Free SCM', 'SCM'],
    ['1500 Freestyle', 'SCM'],
    // LCM: no archived sheet lists the long-course events.
    ['1000 Freestyle', 'LCM'],
    ['500 Free LCM', 'LCM'],
    ['1650 Freestyle', 'LCM'],
    // Relays are other events: a 400 and an 800 Freestyle Relay are yards events.
    ['400 Freestyle Relay', 'SCY'],
    ['800 Free Relay', 'SCY'],
    ['Event 20 Men 4x100 Yard Freestyle Relay', 'SCY'],
    // Other strokes and distances: no source says anything against them.
    ['400 IM', 'SCY'],
    ['100 IM SCM', 'SCM'],
    ['25 Free SCM', 'SCM'],
    ['200 Free SCM', 'SCM'],
  ] as const)('leaves %s in %s alone', (event, course) => {
    expect(eventNotSwumInCourse(event, course)).toBeNull();
  });

  it('never flags a course nobody recorded', () => {
    expect(eventNotSwumInCourse('1000 Freestyle', undefined)).toBeNull();
    expect(eventNotSwumInCourse('1000 Freestyle', null)).toBeNull();
    expect(eventNotSwumInCourse('1000 Freestyle', 'METRIC_UNSPECIFIED')).toBeNull();
  });

  it('reads the recorded course from timeType, then from the label, never from a default', () => {
    expect(recordedCourseOfSwim({ event: '1000 Freestyle', timeType: 'SCM' })).toBe('SCM');
    expect(recordedCourseOfSwim({ event: '1000 Free SCM' })).toBe('SCM');
    expect(recordedCourseOfSwim({ event: 'Event 12 Men 1000 Yard Freestyle' })).toBe('SCY');
    // "Meter" proves metric, not which pool: no course.
    expect(recordedCourseOfSwim({ event: 'Event 5 Men 1000 Meter Freestyle' })).toBeNull();
    expect(recordedCourseOfSwim({ event: '1000 Freestyle' })).toBeNull();
    // timeType wins over the label.
    expect(recordedCourseOfSwim({ event: '1000 Free SCM', timeType: 'SCY' })).toBe('SCY');

    expect(swimEventNotSwumInCourse({ event: '1000 Free SCM' })).toMatchObject({ course: 'SCM' });
    expect(swimEventNotSwumInCourse({ event: '1000 Freestyle' })).toBeNull();
    expect(swimEventNotSwumInCourse({ event: 'Event 5 Men 1000 Meter Freestyle' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The conversion path                                                         */
/* -------------------------------------------------------------------------- */

describe('the conversion path refuses, never converts', () => {
  it.each(['1000 Free SCM', '1000 Freestyle', '500 Freestyle', '1650 Free SCM'])(
    'convertToSCY raises EventNotSwumInCourseError for %s recorded SCM',
    event => {
      expect(() => convertToSCY('8:17.00', event, Gender.MEN, 'SCM', { team: HSU })).toThrow(
        EventNotSwumInCourseError
      );
      expect(() => convertSwimToSCY(event, '8:17.00', Gender.MEN, 'SCM', { team: HSU })).toThrow(
        EventNotSwumInCourseError
      );
      expect(() => convertSwimToSCYDetailed(event, '8:17.00', Gender.MEN, 'SCM', { team: HSU })).toThrow(
        EventNotSwumInCourseError
      );
    }
  );

  it('carries the mismatch on the error', () => {
    try {
      convertToSCY('8:17.00', '1000 Free SCM', Gender.MEN, 'SCM', { team: HSU });
      expect.unreachable('a 1000 recorded SCM must not convert');
    } catch (err) {
      expect(err).toBeInstanceOf(EventNotSwumInCourseError);
      expect((err as EventNotSwumInCourseError).mismatch).toMatchObject({
        event: '1000 Freestyle',
        course: 'SCM',
        courseEvent: '800 Freestyle',
      });
    }
  });

  it('still converts the metric event the table names, on the D2 Rules Book row', () => {
    // 497.00 s x 1.143 = 568.071, truncated to 9:28.07. Before B4 the
    // mislabelled "1000 Free SCM 8:17.00" got this same yards time.
    expect(convertSwimToSCYDetailed('800 Free SCM', '8:17.00', Gender.MEN, 'SCM', { team: HSU })).toMatchObject({
      event: '1000 Free SCY',
      time: '9:28.07',
      basis: { method: 'ncaa_scm_table', row: 'free800To1000', factor: 1.143, division: 'D2' },
    });
  });

  it('states each outcome as a value', () => {
    expect(scyConversionOutcome('1000 Free SCM', '8:17.00', Gender.MEN, 'SCM', { team: HSU })).toMatchObject({
      status: 'event_not_swum_in_course',
      mismatch: { event: '1000 Freestyle', course: 'SCM', courseEvent: '800 Freestyle' },
    });
    expect(scyConversionOutcome('400 Free SCY', '4:01.80', Gender.MEN, 'SCY')).toMatchObject({
      status: 'event_not_swum_in_course',
      mismatch: { course: 'SCY', courseEvent: '500 Freestyle' },
    });
    expect(scyConversionOutcome('800 Free SCM', '8:17.00', Gender.MEN, 'SCM', { team: HSU })).toMatchObject({
      status: 'converted',
      conversion: { event: '1000 Free SCY', time: '9:28.07' },
    });
    expect(scyConversionOutcome('100 IM LCM', '1:00.00', Gender.MEN, 'LCM')).toStrictEqual({
      status: 'no_published_factor',
      event: '100 IM LCM',
      sourceCourse: 'LCM',
    });
    expect(scyConversionOutcome('400 Free Relay SCM', '3:30.00', Gender.MEN, 'SCM')).toMatchObject({
      status: 'converted',
      conversion: { time: '3:30.00', basis: { method: 'identity', reason: 'relay_not_converted' } },
    });
  });

  it('answers the gates the same way', () => {
    expect(hasConversionFactorForCourse('1000 Free SCM', 'SCM')).toBe(false);
    expect(hasConversionFactorForCourse('800 Free SCM', 'SCM')).toBe(true);
    expect(ncaaScmConversionEvent('1000 Free SCM')).toBeNull();
    expect(ncaaScmConversionEvent('800 Free SCM')).toMatchObject({ row: 'free800To1000' });
    expect(scyEquivalentForCutline('1000 Freestyle', 497, Gender.MEN, 'SCM', { division: 'D2' })).toBeNull();
    expect(scyEquivalentForCutline('800 Freestyle', 497, Gender.MEN, 'SCM', { division: 'D2' })).toMatchObject({
      event: '1000 Freestyle',
      time: '9:28.07',
    });
  });

  it('leaves LCM and the SCY identity exactly as they were (no source covers LCM)', () => {
    // Pinned so a future source-backed LCM rule is a deliberate change.
    expect(convertToSCY('10:30.00', '1000 Freestyle', Gender.MEN, 'LCM')).toBe('11:42.45');
    expect(hasConversionFactorForCourse('1000 Freestyle', 'LCM')).toBe(true);
    // SCY is never converted, so nothing here throws; the ranking gate flags it.
    expect(convertToSCY('4:01.80', '400 Freestyle', Gender.MEN, 'SCY')).toBe('4:01.80');
  });
});

/* -------------------------------------------------------------------------- */
/* History: kept, flagged, never ranked                                        */
/* -------------------------------------------------------------------------- */

describe('a mislabelled paste row (Bartu Akin, HSU)', () => {
  it('keeps the row, warns, and gives it no cut', () => {
    const parsed = parseAkin([AKIN_200_SCM, AKIN_1000_SCM_MISLABEL]);
    const mislabel = parsed.swims.find(s => s.event === '1000 Freestyle');
    expect(mislabel).toMatchObject({ timeType: 'SCM', time: '8:17.00', computedCut: null });
    expect(parsed.warnings).toContain(
      'Kept, never ranked — Bartu Akin: 1000 Freestyle SCM 8:17.00. There is no 1000 Freestyle in SCM; ' +
        'that course swims the 800 Freestyle. Check the event and course.'
    );
    expect(isRankableSwim(mislabel!)).toBe(false);
    expect(isRankableSwim(parsed.swims.find(s => s.event === '200 Freestyle')!)).toBe(true);
  });

  it('gives the profile no 1000 Freestyle best from it', () => {
    const { swims } = parseAkin([AKIN_200_SCM, AKIN_1000_SCM_MISLABEL]);
    const profile = categorizeBestEvents(swims, HSU, Gender.MEN, AKIN, NSISC_PRESET_SETTINGS);
    // Before B4 there was a second key, '1000 Freestyle', holding
    // { time: '9:28.07', convertedFrom: { sourceEvent: '1000 Freestyle', ... } }.
    expect(Object.keys(profile.bestByEvent).sort()).toStrictEqual(['200 Freestyle']);
    expect(profile.extractedByEvent).toStrictEqual({});
    expect(profile.userInputtedByEvent).toStrictEqual({});
  });

  it('still ranks his real 800 m swim in the 1000 slot', () => {
    const { swims } = parseAkin([AKIN_200_SCM, AKIN_800_SCM, AKIN_1000_SCM_MISLABEL]);
    const profile = categorizeBestEvents(swims, HSU, Gender.MEN, AKIN, NSISC_PRESET_SETTINGS);
    expect(profile.bestByEvent['1000 Freestyle']).toMatchObject({
      time: '9:28.07',
      convertedFrom: { sourceEvent: '800 Freestyle', sourceCourse: 'SCM' },
    });
  });

  it('imports it into history, writes no recruit row or plan from it, and says so', () => {
    const { swims } = parseAkin([AKIN_200_SCM, AKIN_1000_SCM_MISLABEL]);
    const result = importHistoryToRoster(workspaceWith(), swims, { team: HSU, gender: Gender.MEN });
    expect(result.patch.athleteHistory?.map(s => [s.event, s.timeType])).toStrictEqual([
      ['200 Freestyle', 'SCM'],
      ['1000 Freestyle', 'SCM'],
    ]);
    // A new recruit gets recruit rows, not plans. Before B4 a second row,
    // '1000 Freestyle' at 9:28.07, came from the mislabel.
    expect(result.patch.recruits?.map(r => [r.event, r.time])).toStrictEqual([['200 Freestyle', '1:42.41']]);
    expect(result.patch.meetEntryPlans).toStrictEqual([]);
    expect(result.summary.courseMismatches).toStrictEqual([
      {
        name: AKIN,
        team: HSU,
        event: '1000 Freestyle',
        time: '8:17.00',
        course: 'SCM',
        courseEvent: '800 Freestyle',
        reason: eventNotSwumInCourse('1000 Freestyle', 'SCM')!.reason,
      },
    ]);
    expect(formatHistoryImportSummary(result.summary)).toBe(
      '2 swim(s) merged, 1 new recruit entry. Warning: 1 swim names an event its ' +
        'course does not swim, so it is kept but never ranked (Bartu Akin 1000 Freestyle SCM). Check the event and course.'
    );
  });

  it('adds no summary field to a clean import', () => {
    const { swims } = parseAkin([AKIN_200_SCM, AKIN_800_SCM]);
    const result = importHistoryToRoster(workspaceWith(), swims, { team: HSU, gender: Gender.MEN });
    expect('courseMismatches' in result.summary).toBe(false);
    expect(formatHistoryImportSummary(result.summary)).not.toContain('Warning');
  });

  it('cut-tags it as not applicable, with the reason', () => {
    const result = buildCutlineTagForTeam({
      team: HSU,
      gender: Gender.MEN,
      event: '1000 Freestyle',
      time: '8:17.00',
      swimCourse: 'SCM',
    });
    expect(result.state).toBe('event_not_swum_in_course');
    expect(cutlineTagRenderMode(result)).toBe('unknown');
    expect(result.tag).toBeNull();
    expect(result.nextTier).toBeNull();
    expect(result.division).toBe('D2');
    expect(result.courseMismatch).toMatchObject({ courseEvent: '800 Freestyle' });
    expect(result.reason).toBe(eventNotSwumInCourse('1000 Freestyle', 'SCM')!.reason);
  });

  it('flags the yards side too: a 400 Freestyle recorded SCY', () => {
    const parsed = parseAkin([AKIN_400_SCY_MISLABEL]);
    const [row] = parsed.swims;
    expect(row).toMatchObject({ event: '400 Freestyle', timeType: 'SCY', computedCut: null });
    expect(isRankableSwim(row)).toBe(false);
    expect(parsed.warnings.some(w => w.startsWith('Kept, never ranked — Bartu Akin: 400 Freestyle SCY'))).toBe(true);
    const tag = buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, ...cutlineSwimOfRecord(row) });
    expect(tag.state).toBe('event_not_swum_in_course');
    expect(tag.courseMismatch).toMatchObject({ course: 'SCY', courseEvent: '500 Freestyle' });
  });

  it('gives no best even when a loaded program names the event', () => {
    // The championship program already drops a 400 Freestyle, which hides
    // the rule. A program that names it (built from a loaded meet's own
    // labels) must still not rank a 400 recorded SCY.
    const { swims } = parseAkin([AKIN_400_SCY_MISLABEL]);
    const profile = categorizeBestEvents(
      swims,
      HSU,
      Gender.MEN,
      AKIN,
      NSISC_PRESET_SETTINGS,
      [],
      undefined,
      new Set(['400 Freestyle'])
    );
    expect(profile.bestByEvent).toStrictEqual({});
  });

  it('is not projected for cross-course or relay-leg use', () => {
    const { swims } = parseAkin([AKIN_200_SCM, AKIN_400_SCY_MISLABEL]);
    expect([...convertedHistorySwims(swims)].map(p => p.swim.event)).toStrictEqual(['200 Freestyle']);
  });

  it('judges a label with no course exactly as before', () => {
    // Silent label, no timeType: the SCY default is an assumption, not a
    // recorded course, so it cannot prove the event absent.
    const result = buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, event: '400 Freestyle', time: '4:01.80' });
    expect(result.state).toBe('event_not_in_table');
    const swim: HistoricalSwim = {
      name: AKIN,
      team: HSU,
      gender: Gender.MEN,
      event: '400 Freestyle',
      time: '4:01.80',
      source: 'pdf',
    };
    expect(isRankableSwim(swim)).toBe(true);
    // A caller holding only the flags gets the flag-only answer.
    expect(isRankableSwim({ swimcloudBadge: 'none' })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Stored rows: a recruit or plan the recruit form wrote                       */
/* -------------------------------------------------------------------------- */

describe('a stored recruit row entered as 1000 Freestyle SCM', () => {
  it('is left out of the what-if pool instead of converting (or throwing)', () => {
    const bad = formRecruit();
    const good = formRecruit({ id: 'recruit-akin-1000-scy', event: '1000 Freestyle', time: '9:30.37', timeType: 'SCY' });
    const rows = buildWhatIfResults({
      workspace: workspaceWith({ recruits: [bad, good] }),
      gender: Gender.MEN,
      removeSeniors: false,
    });
    expect(rows.map(r => [r.id, r.time])).toStrictEqual([['recruit-akin-1000-scy', '9:30.37']]);
  });

  it('never patches or adds a plan row either', () => {
    const plan: PlannedSwimEntry = {
      id: 'plan-akin-1000',
      name: 'Akin, Bartu',
      team: HSU,
      gender: Gender.MEN,
      event: '1000 Freestyle',
      time: '8:17.00',
      timeType: 'SCM',
      source: 'manual',
      active: true,
    } as PlannedSwimEntry;
    const rows = buildWhatIfResults({
      workspace: workspaceWith({ meetEntryPlans: [plan] }),
      gender: Gender.MEN,
      removeSeniors: false,
    });
    expect(rows).toStrictEqual([]);
  });

  it('is no competitor in the conversion-confidence index, as a recruit row or a plan', () => {
    const recruitIndex = buildEventTimeIndex(workspaceWith({ recruits: [formRecruit()] }), Gender.MEN);
    expect(recruitIndex.get('1000 Freestyle')).toBeUndefined();
    const plan = {
      id: 'plan-akin-1000',
      name: 'Akin, Bartu',
      team: HSU,
      gender: Gender.MEN,
      event: '1000 Freestyle',
      time: '8:17.00',
      timeType: 'SCM',
      source: 'manual',
      active: true,
    } as PlannedSwimEntry;
    const planIndex = buildEventTimeIndex(workspaceWith({ meetEntryPlans: [plan] }), Gender.MEN);
    expect(planIndex.get('1000 Freestyle')).toBeUndefined();
  });

  it('is named on the lineup checklist', () => {
    const ws = workspaceWith({ recruits: [formRecruit()] });
    const audit = buildTeamLineupAudit({
      workspace: ws,
      gender: Gender.MEN,
      team: HSU,
      settings: ws.scoringSettings!,
      allResults: [],
      allScored: [],
      removeSeniors: false,
      detectDuplicates: false,
    });
    const items = audit.checklistItems.filter(i => i.type === 'event_not_swum_in_course');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ group: 'provenance', athleteName: 'Akin, Bartu' });
    expect(items[0].message).toBe(
      'Akin, Bartu: the recruit row 1000 Freestyle SCM is not scored. There is no 1000 Freestyle in SCM; ' +
        'that course swims the 800 Freestyle. Check the event and course.'
    );
  });

  it('cut-tags as not applicable through cutlineSwimOfRecord', () => {
    const result = buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, ...cutlineSwimOfRecord(formRecruit()) });
    expect(result.state).toBe('event_not_swum_in_course');
  });

  it('finds it with findSwimsNotSwumInCourse, in input order', () => {
    const found = findSwimsNotSwumInCourse([
      formRecruit({ id: 'a', event: '500 Freestyle' }),
      formRecruit({ id: 'b', event: '800 Freestyle' }),
      formRecruit({ id: 'c', event: '1650 Freestyle' }),
    ]);
    expect(found.map(f => [f.swim.id, f.mismatch.courseEvent])).toStrictEqual([
      ['a', '400 Freestyle'],
      ['c', '1500 Freestyle'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The roster catalog                                                          */
/* -------------------------------------------------------------------------- */

describe('a catalog time in an event its course does not swim', () => {
  const bad = buildStoredSwim({
    id: 't-bad',
    athleteId: 'a-akin',
    event: '1000 Free SCM',
    timeText: '8:17.00',
    timeType: 'SCM',
    source: 'paste',
    gender: Gender.MEN,
    division: 'D2',
  });
  const real = buildStoredSwim({
    id: 't-real',
    athleteId: 'a-akin',
    event: '1000 Free SCY',
    timeText: '9:30.37',
    timeType: 'SCY',
    source: 'paste',
    gender: Gender.MEN,
    division: 'D2',
  });

  it('is stored without a conversion and without a cut', () => {
    expect(bad).toMatchObject({ event: '1000 Free', timeSeconds: 497, timeSecondsScy: 0, computedCut: null });
    expect(isRankableCatalogTime(bad)).toBe(false);
    expect(isRankableCatalogTime(real)).toBe(true);
  });

  it('never beats a real time for the best, even with its absent 0', () => {
    expect([...bestTimesByEvent([bad, real]).values()].map(t => t.id)).toStrictEqual(['t-real']);
  });

  it('is never a catalog entry', () => {
    const roster: CatalogTeamRoster = {
      team: { id: 'team-hsu', name: HSU, gender: 'Men', sortIndex: 0, createdAt: 0, updatedAt: 0 },
      athletes: [
        {
          id: 'a-akin',
          teamId: 'team-hsu',
          fullName: AKIN,
          nameKey: 'bartu akin',
          gender: 'Men',
          createdAt: 0,
          updatedAt: 0,
          times: [bad],
        },
      ],
    };
    const rows = buildCategorizedScoringInputs({ workspace: workspaceWith(), gender: Gender.MEN, rosterCatalog: roster });
    expect(rows).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* No false positive on the real exports                                       */
/* -------------------------------------------------------------------------- */

describe('the real roster exports', () => {
  const TIME = /^(\d{1,2}:)?\d{1,2}\.\d{2}$/;
  const COURSE = /\b(SCY|SCM|LCM)$/;
  const rows = ['hsuroster26-27.txt', 'oburoster202627.txt'].flatMap(file =>
    readFileSync(join(repoRoot, file), 'utf8')
      .split(/\r?\n/)
      .map(line => line.split('\t').map(c => c.trim()))
      .filter(cols => cols.length >= 2 && TIME.test(cols[1]) && COURSE.test(cols[0]))
      .map(cols => ({ event: cols[0], time: cols[1] }))
  );

  it('flag nothing', () => {
    expect(rows.length).toBeGreaterThan(1800);
    expect(findSwimsNotSwumInCourse(rows)).toStrictEqual([]);
  });

  it('still convert every SCM 400, 800 and 1500 Freestyle', () => {
    const scmDistance = rows.filter(r => /^(400|800|1500) Free SCM$/.test(r.event));
    expect(scmDistance).toHaveLength(16);
    for (const r of scmDistance) {
      expect(scyConversionOutcome(r.event, r.time, Gender.MEN, 'SCM', { team: HSU }).status, r.event).toBe(
        'converted'
      );
    }
  });
});
