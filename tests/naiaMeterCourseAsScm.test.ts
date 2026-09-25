/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * NAIA meter standards are read as short-course metres (SCM).
 *
 * User decision, 2026-09-24: an NAIA team's metric swim is judged directly
 * against NAIA's published meter standards, for the course a source states.
 *
 * - The values come from the NAIA 2026-27 sheet,
 *   `data/cutlines/sources/2026-27-SD-Qualifying-Standards-wo-Relays.pdf`
 *   (manifest id `naia-2026-27`). It heads the column "METERS" and never says
 *   SCM or LCM, so `scripts/extract-cutlines.py` records `METRIC_UNSPECIFIED`.
 * - The course comes from the official NAIA 2020-21 sheet,
 *   `data/cutlines/sources/2020-21-NAIA-SD-Qualifying-Standards.pdf`
 *   (manifest id `naia-2020-21-course-evidence`). It heads the same column
 *   "SCM". No value is taken from it.
 *
 * `NAIA_2026_27_METERS_AS_SCM` in `packages/core/src/cutlines.ts` records the
 * reading, and the loader stamps it on each record. This file pins the
 * evidence, the loaded shape and the cut-tag verdicts.
 *
 * Replaces `naiaMeterCourseUnstated.test.ts`, which pinned the earlier
 * behaviour: an NAIA SCM swim reached only a converted estimate against yards.
 * The verdict cases below are real standards where that old estimate and the
 * new direct verdict disagree.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import {
  cutlineCourseDecisions,
  cutlineDataFiles,
  findCutlines,
  NAIA_2026_27_METERS_AS_SCM,
  publishedCutlines,
  resolveCutlineCourse,
  type GeneratedCutlineEntry,
  type IndividualABCutline,
} from '../packages/core/src/cutlines';
import { cutlineTableCourseForSwim, getCutlinesForSwim } from '../packages/core/src/lib/cutlineUtils';
import {
  buildCutlineTag,
  buildCutlineTagForTeam,
  cutlineSwimOfRecord,
  cutlineTagRenderMode,
  isCutlineTagConclusive,
  type CutlineTagInput,
} from '../packages/core/src/lib/cutlineTags';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');
const VALUES_PDF = '2026-27-SD-Qualifying-Standards-wo-Relays.pdf';
const EVIDENCE_PDF = '2020-21-NAIA-SD-Qualifying-Standards.pdf';

type ManifestEntry = {
  id: string;
  division: string;
  season: string;
  url: string;
  filename: string;
  sha256: string;
  purpose?: string;
};
const manifest = JSON.parse(readFileSync(join(sourcesDir, 'manifest.json'), 'utf8')) as {
  sources: ManifestEntry[];
};
const manifestEntry = (id: string): ManifestEntry => {
  const entry = manifest.sources.find(s => s.id === id);
  if (!entry) throw new Error(`manifest has no entry ${id}`);
  return entry;
};
const sha256Of = (filename: string): string =>
  createHash('sha256').update(readFileSync(join(sourcesDir, filename))).digest('hex');

/** The generated file, read raw: what the extractor wrote, before the loader. */
const rawSeason = JSON.parse(
  readFileSync(join(repoRoot, 'data', 'cutlines', '2026-2027.json'), 'utf8')
) as { cutlines: GeneratedCutlineEntry[] };

const hasPdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error == null;
const pdfText = (filename: string): string => {
  const out = spawnSync('pdftotext', ['-layout', join(sourcesDir, filename), '-'], { encoding: 'utf8' });
  expect(out.status).toBe(0);
  return out.stdout;
};
const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

const decision = NAIA_2026_27_METERS_AS_SCM;
const naiaScm = (): IndividualABCutline[] =>
  findCutlines({ division: 'NAIA', course: 'SCM' }) as IndividualABCutline[];

/* -------------------------------------------------------------------------- */
/* The evidence                                                                */
/* -------------------------------------------------------------------------- */

describe('the evidence behind the SCM reading', () => {
  it('cites the two archived sheets by manifest id, with matching bytes', () => {
    const values = manifestEntry(decision.valuesSourceId);
    expect(values.id).toBe('naia-2026-27');
    expect(values.filename).toBe(VALUES_PDF);
    expect(sha256Of(VALUES_PDF)).toBe(values.sha256);
    expect(decision.valuesSha256).toBe(values.sha256);

    const evidence = manifestEntry(decision.evidence.sourceId);
    expect(evidence.id).toBe('naia-2020-21-course-evidence');
    expect(evidence.filename).toBe(EVIDENCE_PDF);
    expect(evidence.sha256).toBe('c672d8bcbbdcf2b69b94dc6fbfe701cf6a724fb738cdd14de0fda4a18022b132');
    expect(sha256Of(EVIDENCE_PDF)).toBe(evidence.sha256);
    expect(decision.evidence.sha256).toBe(evidence.sha256);
    expect(decision.evidence.url).toBe(evidence.url);
    expect(decision.evidence.season).toBe(evidence.season);
    expect(evidence.purpose).toMatch(/no values used/i);
  });

  it('records a user decision of 2026-09-24, from METERS to SCM', () => {
    expect(decision).toMatchObject({
      division: 'NAIA',
      season: '2026-2027',
      valuesSheetHeading: 'METERS',
      extractedCourse: 'METRIC_UNSPECIFIED',
      course: 'SCM',
      decidedBy: 'user',
      decidedOn: '2026-09-24',
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.evidence)).toBe(true);
    expect(cutlineCourseDecisions()).toStrictEqual([decision]);
  });

  it.skipIf(!hasPdftotext)('the 2026-27 values sheet heads the column "METERS" and names no pool length', () => {
    const text = pdfText(VALUES_PDF);
    expect(text).toMatch(/YARDS\s+METERS\s+YARDS\s+METERS/);
    expect(text).not.toMatch(/\b(?:SCM|LCM|SCY|short[\s-]?course|long[\s-]?course)\b/i);
    expect(text).not.toMatch(/\b(?:25|50)[\s-]?(?:m|meters?|metres?)\b/i);
  });

  it.skipIf(!hasPdftotext)('the 2020-21 evidence sheet heads its metric column "SCM"', () => {
    const text = pdfText(EVIDENCE_PDF);
    expect(text).toMatch(/NAIA Swimming & Diving/);
    expect(text).toMatch(/Qualifying Standards\s+\S+\s+2020-2021/);
    expect(text).toMatch(/EVENTS\s+Men\s+Women/);
    // One Yards and one SCM heading per gender, and no other course named.
    expect(text).toMatch(/50 FREESTYLE\s+SCM/);
    expect(text).toMatch(/100 FREESTYLE\s+Yards\s+Yards\s+SCM/);
    expect(count(text, /\bSCM\b/g)).toBe(2);
    expect(count(text, /\bYards\b/g)).toBe(2);
    expect(text).not.toMatch(/\bLCM\b|\bMETERS\b|long[\s-]?course/i);
  });
});

/* -------------------------------------------------------------------------- */
/* The loaded tables                                                           */
/* -------------------------------------------------------------------------- */

describe('the NAIA 2026-27 metre column loads as SCM, by decision', () => {
  it('the generated file still records what the sheet states: METRIC_UNSPECIFIED', () => {
    const naiaTimed = rawSeason.cutlines.filter(r => r.division === 'NAIA' && r.kind !== 'diving');
    expect([...new Set(naiaTimed.map(r => r.course))].sort()).toStrictEqual(['METRIC_UNSPECIFIED', 'SCY']);
  });

  it('no loaded record carries METRIC_UNSPECIFIED', () => {
    const courses = new Set(publishedCutlines().map(e => e.course as string));
    expect(courses.has('METRIC_UNSPECIFIED')).toBe(false);
    for (const file of cutlineDataFiles()) {
      expect(file.cutlines.some(e => (e.course as string) === 'METRIC_UNSPECIFIED')).toBe(false);
    }
  });

  it('turns every METRIC_UNSPECIFIED row into exactly one SCM row, and nothing else', () => {
    const rawMetric = rawSeason.cutlines.filter(r => r.course === 'METRIC_UNSPECIFIED');
    const scm = naiaScm();
    expect(rawMetric).toHaveLength(26);
    expect(scm).toHaveLength(rawMetric.length);
    const key = (r: { gender: string; event: string }) => `${r.gender}|${r.event}`;
    expect(scm.map(key).sort()).toStrictEqual(rawMetric.map(key).sort());
    expect(new Set(scm.map(key)).size).toBe(scm.length);
    // No other division, season or course is relabelled.
    for (const e of publishedCutlines()) {
      if (e.division === 'NAIA' && e.course === 'SCM') continue;
      expect(e.course, `${e.division} ${e.season} ${e.event}`).toBe('SCY');
      expect(e.courseDecision).toBeUndefined();
    }
  });

  it('stamps the decision on every SCM record and keeps the 2026-27 sheet as its values source', () => {
    for (const e of naiaScm()) {
      expect(e.courseDecision).toBe(decision);
      expect(e.source).toMatchObject({
        sourceId: 'naia-2026-27',
        sha256: manifestEntry('naia-2026-27').sha256,
      });
      expect(e.source.sourceId).not.toBe(decision.evidence.sourceId);
      expect(e.season).toBe('2026-2027');
    }
  });

  it('holds the 2026-27 sheet values verbatim', () => {
    const pick = (gender: 'Men' | 'Women', event: string) => {
      const [e] = findCutlines({ division: 'NAIA', course: 'SCM', gender, event }) as IndividualABCutline[];
      return [e?.aStandard, e?.bStandard];
    };
    expect(pick('Men', '50 Freestyle')).toStrictEqual(['22.27', '24.13']);
    expect(pick('Women', '50 Freestyle')).toStrictEqual(['26.36', '28.53']);
    expect(pick('Women', '400 Freestyle')).toStrictEqual(['4:25.22', '4:47.10']);
    expect(pick('Men', '1500 Freestyle')).toStrictEqual(['15:35.82', '16:53.03']);
    // "500/400 FREESTYLE": metres publishes the 400, never a 500.
    expect(findCutlines({ division: 'NAIA', course: 'SCM', event: '500 Freestyle' })).toHaveLength(0);
  });

  it.skipIf(!hasPdftotext)('every SCM value is printed in the 2026-27 sheet', () => {
    const tokens = new Set(pdfText(VALUES_PDF).split(/\s+/));
    for (const e of naiaScm()) {
      expect(tokens.has(e.aStandard), `${e.gender} ${e.event} ${e.aStandard}`).toBe(true);
      expect(tokens.has(e.bStandard), `${e.gender} ${e.event} ${e.bStandard}`).toBe(true);
    }
  });
});

describe('resolveCutlineCourse refuses a course it cannot account for', () => {
  const rawNaiaMetric = rawSeason.cutlines.find(
    r => r.division === 'NAIA' && r.course === 'METRIC_UNSPECIFIED'
  ) as GeneratedCutlineEntry;

  it('passes a stated course through unchanged', () => {
    const scy = rawSeason.cutlines.find(r => r.division === 'NAIA' && r.course === 'SCY')!;
    const loaded = resolveCutlineCourse(scy);
    expect(loaded.course).toBe('SCY');
    expect(loaded.courseDecision).toBeUndefined();
  });

  it('applies the matching decision', () => {
    const loaded = resolveCutlineCourse(rawNaiaMetric);
    expect(loaded.course).toBe('SCM');
    expect(loaded.courseDecision).toBe(decision);
  });

  it('throws when no decision names the source', () => {
    expect(() => resolveCutlineCourse(rawNaiaMetric, [])).toThrow(/no recorded course decision/);
  });

  it('throws when the sheet bytes differ from the ones the decision covers', () => {
    const refetched = {
      ...rawNaiaMetric,
      source: { ...rawNaiaMetric.source, sha256: '0'.repeat(64) },
    } as GeneratedCutlineEntry;
    expect(() => resolveCutlineCourse(refetched)).toThrow(/covers only/);
  });

  it('throws when the record is from another division or season', () => {
    const otherSeason = { ...rawNaiaMetric, season: '2025-2026' } as GeneratedCutlineEntry;
    expect(() => resolveCutlineCourse(otherSeason)).toThrow(/does not match course decision/);
    const otherDivision = { ...rawNaiaMetric, division: 'D2' } as GeneratedCutlineEntry;
    expect(() => resolveCutlineCourse(otherDivision)).toThrow(/does not match course decision/);
  });
});

/* -------------------------------------------------------------------------- */
/* Cut tags                                                                    */
/* -------------------------------------------------------------------------- */

describe('an NAIA team’s SCM swim gets a conclusive verdict against the SCM standard', () => {
  /*
   * Each case is a real standard where the old answer and the new one differ.
   * The old answer converted the SCM time to yards (the Rules Book 0.896 row,
   * because NAIA prints no factor) and read the yards column. Passing
   * `tableCourse: 'SCY'` still asks for exactly that, so the old verdict is
   * recomputed here, not remembered.
   */
  it.each([
    // Men 50 Free: SCM 22.27 / 24.13; yards 19.91 / 21.55.
    { gender: Gender.MEN, time: '22.25', tier: 'A', label: 'NAIA AUTO', standard: '22.27', old: 'converted_estimate', oldTier: 'B' },
    { gender: Gender.MEN, time: '24.10', tier: 'B', label: 'NAIA PROV', standard: '24.13', old: 'no_cut', oldTier: null },
    // Women 50 Free: SCM 26.36 / 28.53; yards 23.56 / 25.50.
    { gender: Gender.WOMEN, time: '26.36', tier: 'A', label: 'NAIA AUTO', standard: '26.36', old: 'converted_estimate', oldTier: 'B' },
    { gender: Gender.WOMEN, time: '28.50', tier: 'B', label: 'NAIA PROV', standard: '28.53', old: 'no_cut', oldTier: null },
  ] as const)('$gender 50 Free SCM $time → $label (was $old)', c => {
    const swim: CutlineTagInput = {
      division: 'NAIA',
      gender: c.gender,
      event: '50 Free SCM',
      time: c.time,
      swimCourse: 'SCM',
    };
    const now = buildCutlineTag(swim);
    expect(now.state).toBe('tagged');
    expect(isCutlineTagConclusive(now)).toBe(true);
    expect(cutlineTagRenderMode(now)).toBe('tag');
    expect(now).toMatchObject({ tableCourse: 'SCM', course: 'SCM', swimCourse: 'SCM', event: '50 Freestyle' });
    expect(now.tag).toMatchObject({
      tier: c.tier,
      label: c.label,
      course: 'SCM',
      standardTime: c.standard,
      season: '2026-2027',
    });
    expect(now.tag?.title).toMatch(/\(short-course metres\)$/);
    expect(now.tag?.source.sourceId).toBe('naia-2026-27');
    expect(now.tag?.entry.courseDecision).toBe(decision);

    const old = buildCutlineTag({ ...swim, tableCourse: 'SCY' });
    expect(old.state).toBe(c.old);
    expect(old.tag).toBeNull();
    expect(old.indicative?.tier ?? null).toBe(c.oldTier);
  });

  it('judges a metric 400 Free against the 400 metres standard, not the 500 yards slot', () => {
    const r = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.WOMEN,
      event: '400 Free SCM',
      time: '4:25.00',
      swimCourse: 'SCM',
    });
    expect(r.state).toBe('tagged');
    expect(r.event).toBe('400 Freestyle');
    expect(r.tag).toMatchObject({ tier: 'A', standardTime: '4:25.22', course: 'SCM' });
  });

  it('reports a miss as a conclusive no_cut, with the gap measured in metres', () => {
    const r = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '50 Free SCM',
      time: '24.20',
      swimCourse: 'SCM',
    });
    expect(r.state).toBe('no_cut');
    expect(isCutlineTagConclusive(r)).toBe(true);
    expect(r.tableCourse).toBe('SCM');
    expect(r.reason).toBe('Judged against NAIA 2026-2027 short-course metres — no standard cleared.');
    expect(r.nextTier).toMatchObject({ tier: 'B', standardTime: '24.13', judgedSeconds: 24.2, shortBySeconds: 0.07 });
  });

  it('reads the course off the label when the caller passes none', () => {
    const r = buildCutlineTag({ division: 'NAIA', gender: Gender.MEN, event: '50 Free SCM', time: '22.25' });
    expect(r.swimCourse).toBe('SCM');
    expect(r.state).toBe('tagged');
    expect(r.tag?.course).toBe('SCM');
  });

  it('resolves through a team the workspace maps to NAIA', () => {
    const r = buildCutlineTagForTeam({
      team: 'Example NAIA College',
      teamOptions: { overrides: { 'Example NAIA College': 'NAIA' } },
      gender: Gender.MEN,
      event: '50 Free SCM',
      time: '22.25',
      swimCourse: 'SCM',
    });
    expect(r.state).toBe('tagged');
    expect(r.tag?.course).toBe('SCM');
  });

  it('judges a stored converted row as the SCM swim it came from', () => {
    const swim = cutlineSwimOfRecord({
      event: '50 Free',
      time: '19.93',
      convertedFrom: { sourceCourse: 'SCM', sourceEvent: '50 Free SCM', sourceTime: '22.25', scyTime: '19.93' },
    } as Parameters<typeof cutlineSwimOfRecord>[0]);
    const r = buildCutlineTag({ division: 'NAIA', gender: Gender.MEN, ...swim });
    expect(r.state).toBe('tagged');
    expect(r.tag).toMatchObject({ course: 'SCM', standardTime: '22.27', tier: 'A' });
  });
});

describe('what the SCM reading does not change', () => {
  it('an NAIA LCM swim has no LCM standard and stays a converted estimate against yards', () => {
    const r = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '50 Free LCM',
      time: '22.20',
      swimCourse: 'LCM',
    });
    expect(r.state).toBe('converted_estimate');
    expect(r.tableCourse).toBe('SCY');
    expect(r.tag).toBeNull();
    expect(r.indicative).toMatchObject({ swimCourse: 'LCM', tableCourse: 'SCY', standardTime: '19.91' });
    expect(r.indicative?.conversionBasis).toMatchObject({ method: 'lcm_factor_table' });
  });

  it('an NAIA SCY swim is judged against the yards column', () => {
    const r = buildCutlineTag({ division: 'NAIA', gender: Gender.MEN, event: '50 Free', time: '19.90' });
    expect(r.state).toBe('tagged');
    expect(r).toMatchObject({ tableCourse: 'SCY', swimCourse: 'SCY' });
    expect(r.tag).toMatchObject({ course: 'SCY', standardTime: '19.91' });
    expect(r.tag?.entry.courseDecision).toBeUndefined();
  });

  it('a D2 SCM swim (HSU) is still a converted estimate against the D2 yards table', () => {
    const r = buildCutlineTagForTeam({
      team: 'Henderson State University',
      gender: Gender.MEN,
      event: '50 Free SCM',
      time: '21.00',
      swimCourse: 'SCM',
    });
    expect(r.division).toBe('D2');
    expect(r.state).toBe('converted_estimate');
    expect(r.tableCourse).toBe('SCY');
  });

  it('events NAIA does not publish in metres keep their old answers', () => {
    const relay = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '200 Medley Relay SCM',
      time: '1:40.00',
      swimCourse: 'SCM',
    });
    expect(relay.state).toBe('conversion_unavailable');
    expect(relay.tableCourse).toBe('SCY');
    const im = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '100 IM SCM',
      time: '58.00',
      swimCourse: 'SCM',
    });
    expect(im.state).toBe('event_not_in_table');
    expect(im.tableCourse).toBe('SCY');
  });

  it('a "Meter" label with no pool length is still not judged', () => {
    const r = buildCutlineTag({ division: 'NAIA', gender: Gender.MEN, event: '50 Meter Freestyle', time: '22.20' });
    expect(r.swimCourse).toBe('METRIC_UNSPECIFIED');
    expect(r.state).toBe('conversion_unavailable');
  });

  it('the default table lookup is still yards', () => {
    expect(getCutlinesForSwim('Men', '50 Freestyle', 'NAIA').aCutSec).toBe(19.91);
    expect(getCutlinesForSwim('Men', '50 Freestyle', 'NAIA', undefined, 'SCM').aCutSec).toBe(22.27);
  });
});

describe('cutlineTableCourseForSwim', () => {
  it.each([
    ['NAIA', 'SCM', '50 Free', 'SCM'],
    ['NAIA', 'SCM', '400 Free', 'SCM'],
    ['NAIA', 'LCM', '50 Free', 'SCY'],
    ['NAIA', 'SCY', '50 Free', 'SCY'],
    ['NAIA', 'METRIC_UNSPECIFIED', '50 Free', 'SCY'],
    ['NAIA', 'SCM', '200 Medley Relay', 'SCY'],
    ['NAIA', 'SCM', '1-Meter Diving', 'SCY'],
    ['D2', 'SCM', '50 Free', 'SCY'],
    ['D1', 'SCM', '50 Free', 'SCY'],
    [null, 'SCM', '50 Free', 'SCY'],
  ] as const)('%s %s %s → %s', (division, swimCourse, event, expected) => {
    expect(cutlineTableCourseForSwim('Men', event, division, swimCourse)).toBe(expected);
  });

  it('follows the season asked for: no table that season, no SCM', () => {
    expect(cutlineTableCourseForSwim('Men', '50 Free', 'NAIA', 'SCM', '2025-2026')).toBe('SCY');
  });
});

describe('a table course must match the swim course', () => {
  // Before 2026-09-24 any non-yards table course was read directly whatever
  // the swim's own course: an SCY swim was tagged against the metres column.
  it.each([
    ['SCY', '22.00'],
    ['LCM', '22.00'],
  ] as const)('an %s swim named against the SCM table is refused, not judged', (swimCourse, time) => {
    const r = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '50 Free',
      time,
      swimCourse,
      tableCourse: 'SCM',
    });
    expect(r.state).toBe('conversion_unavailable');
    expect(r.tag).toBeNull();
    expect(r.nextTier).toBeNull();
    expect(cutlineTagRenderMode(r)).toBe('unknown');
    expect(r.reason).toMatch(/applies only to a short-course metres swim/);
  });

  it('a metric label with no pool length is refused against the SCM table too', () => {
    const r = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '50 Meter Freestyle',
      time: '22.00',
      tableCourse: 'SCM',
    });
    expect(r.state).toBe('conversion_unavailable');
    expect(r.reason).toMatch(/metres with no stated pool length/);
  });

  it('the legacy course field is held to the same rule', () => {
    const r = buildCutlineTag({ division: 'NAIA', gender: Gender.MEN, event: '50 Free', time: '22.00', course: 'SCM' });
    expect(r.state).toBe('conversion_unavailable');
  });

  it('an explicit yards table still gives an SCM swim a converted estimate', () => {
    const r = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: '50 Free SCM',
      time: '22.00',
      swimCourse: 'SCM',
      tableCourse: 'SCY',
    });
    expect(r.state).toBe('converted_estimate');
    expect(r.indicative?.conversionBasis).toMatchObject({ reason: 'division_publishes_none' });
  });

  it('throws on the retired METRIC_UNSPECIFIED table course from an untyped caller', () => {
    const legacy = { division: 'NAIA', gender: 'Men', event: '50 Free', time: '22.00', course: 'METRIC_UNSPECIFIED' };
    expect(() => buildCutlineTag(legacy as unknown as CutlineTagInput)).toThrow(TypeError);
  });
});
