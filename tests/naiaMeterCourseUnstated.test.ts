/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * NAIA meter standards: why a metric swim is not yet judged against them
 * (plans/2026-09-22/01, P13 item 4 — stopped, not built).
 *
 * User decision, 2026-09-24: an NAIA team's metric swim is judged directly
 * against NAIA's published meter standards. The brief allowed that only for
 * the course the source states. The archived sheet,
 * `data/cutlines/sources/2026-27-SD-Qualifying-Standards-wo-Relays.pdf`,
 * heads its second column "METERS" and never says short course or long
 * course. `scripts/extract-cutlines.py` already records those values as
 * `course: 'METRIC_UNSPECIFIED'` for that reason.
 *
 * So an SCM or LCM swim for an NAIA team still reaches the yards table as a
 * converted estimate. This file pins that, and pins the evidence, so the
 * wiring cannot land without a source that names the course.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import { buildCutlineTag } from '../packages/core/src/lib/cutlineTags';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');
const NAIA_PDF = '2026-27-SD-Qualifying-Standards-wo-Relays.pdf';

type ManifestEntry = { id: string; filename: string; sha256: string };
const manifest = JSON.parse(readFileSync(join(sourcesDir, 'manifest.json'), 'utf8')) as { sources: ManifestEntry[] };

type CutlineRow = { kind: string; division: string; course: string; event: string; gender: string };
const season = JSON.parse(readFileSync(join(repoRoot, 'data', 'cutlines', '2026-2027.json'), 'utf8')) as {
  cutlines: CutlineRow[];
};

describe('the NAIA sheet does not state the metric course', () => {
  it('is the archived file the manifest records', () => {
    const entry = manifest.sources.find(s => s.filename === NAIA_PDF);
    expect(entry?.id).toBe('naia-2026-27');
    const sha = createHash('sha256').update(readFileSync(join(sourcesDir, NAIA_PDF))).digest('hex');
    expect(sha).toBe(entry?.sha256);
  });

  const pdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  it.skipIf(pdftotext.error != null)('heads the column "METERS" and names no pool length anywhere', () => {
    const out = spawnSync('pdftotext', ['-layout', join(sourcesDir, NAIA_PDF), '-'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/YARDS\s+METERS\s+YARDS\s+METERS/);
    expect(out.stdout).not.toMatch(/\b(?:SCM|LCM|SCY|short[\s-]?course|long[\s-]?course)\b/i);
    expect(out.stdout).not.toMatch(/\b(?:25|50)[\s-]?(?:m|meters?|metres?)\b/i);
  });

  it('is stored as METRIC_UNSPECIFIED, never as SCM or LCM', () => {
    const naiaTimed = season.cutlines.filter(r => r.division === 'NAIA' && r.kind !== 'diving');
    const courses = new Set(naiaTimed.map(r => r.course));
    expect([...courses].sort()).toStrictEqual(['METRIC_UNSPECIFIED', 'SCY']);
  });
});

describe('an NAIA team’s metric swim is judged as a converted estimate, not against the meters column', () => {
  // Men's 50 Free: automatic 19.91 y / 22.27 m. A 22.20 swim is under the
  // meters figure; judged directly it would be tagged. It is not.
  it.each([
    ['SCM', 'division_publishes_none'],
    ['LCM', undefined],
  ] as const)('%s 50 Free 22.20', (course, reason) => {
    const tag = buildCutlineTag({
      division: 'NAIA',
      gender: Gender.MEN,
      event: `50 Free ${course}`,
      time: '22.20',
      swimCourse: course,
    });
    expect(tag.state).toBe('converted_estimate');
    expect(tag.tableCourse).toBe('SCY');
    expect(tag.tag).toBeNull();
    if (reason) {
      expect(tag.indicative?.conversionBasis).toMatchObject({ reason });
    }
  });
});
