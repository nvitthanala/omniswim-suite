/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cut chips in a pasted SwimCloud row (plans/2026-09-22/01, P14 item b).
 *
 * A SwimCloud personal-bests paste is tab-separated:
 * `Event \t Time \t Stamp \t Meet \t Date \t` (header
 * `Event\tTime\t\tMeet\tDate\tStamp Link`). Two defects:
 *
 * 1. A multi-word cut chip (`D2 B`, `NCAA B`, `WIN JRS`) and most one-word
 *    cut chips (`NCSA`, `FTR-19O`) were not read as stamps. The reader then
 *    took the chip for the meet name, and the real meet name was lost.
 * 2. A cut chip with a flag chip glued on (`D2 BR`, `NCSAX`, `FTR-18UR`) was
 *    not decoded, so the three `NCSAX` rows (extracted splits) imported as
 *    results and could rank as bests.
 *
 * Every row here is real: the two roster exports at the repo root and the
 * Blaise Vera fixture. SwimCloud's own JSON says the flag chips are exactly
 * `X` (Extracted), `U` (User Inputted), `R` (Leadoff) and `A` (Altitude
 * Adjusted), and marks cut chips `type: "cut"` (`US OPEN`, `D2 B`,
 * `WIN JRS`, `JRS` in the committed JSON fixtures). A pasted cell loses that
 * type, and real cut labels end in the flag letters too (`FTR-18U` is
 * "Futures 18 & under", `5A` a high-school class), so a glued chip is split
 * only against the cut labels real captures show.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import {
  categorizeBestEvents,
  parseSwimCloudPasteDetailed,
  parseSwimCloudPersonalBestsDetailed,
  parseSwimCloudStampBadge,
  readSwimCloudStamp,
} from '../packages/core/src/lib/athleteHistory';
import {
  SWIMCLOUD_CUT_CHIP_LABELS,
  bestTimeLaneOfStamp,
} from '../packages/core/src/lib/bestTimeEligibility';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State';
const OBU = 'Ouachita Baptist University';
const HDR = 'Event\tTime\t\tMeet\tDate\tStamp Link';
const DATE = /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/;
const TIME = /^(\d{1,2}:)?\d{1,2}\.\d{2}$/;

const SOURCES = [
  ['hsuroster26-27.txt', HSU],
  ['oburoster202627.txt', OBU],
  ['tests/fixtures/swimcloud/blaise_vera_personal_bests.txt', 'University of Pittsburgh'],
] as const;

type RealRow = { file: string; line: number; text: string; cols: string[]; team: string };

/** Every row of the real exports laid out `event, time, stamp, meet, date`. */
function realRows(): RealRow[] {
  const rows: RealRow[] = [];
  for (const [file, team] of SOURCES) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      const cols = text.split('\t').map(c => c.trim());
      if (cols.length >= 5 && TIME.test(cols[1]) && DATE.test(cols[4])) {
        rows.push({ file, line: i + 1, text, cols, team });
      }
    });
  }
  return rows;
}

/** What each stamp in the real exports says, read by hand from SwimCloud's chip vocabulary. */
const EXPECTED: Record<string, { x: boolean; u: boolean }> = {
  '': { x: false, u: false },
  X: { x: true, u: false },
  R: { x: false, u: false },
  U: { x: false, u: true },
  A: { x: false, u: false },
  XR: { x: true, u: false },
  UR: { x: false, u: true },
  B: { x: false, u: false },
  'D1-B': { x: false, u: false },
  'D2 B': { x: false, u: false },
  'D2 BR': { x: false, u: false },
  'NCAA B': { x: false, u: false },
  'WIN JRS': { x: false, u: false },
  NCSA: { x: false, u: false },
  NCSAX: { x: true, u: false },
  'FTR-18U': { x: false, u: false },
  'FTR-18UR': { x: false, u: false },
  'FTR-19O': { x: false, u: false },
  'YMCA-LC': { x: false, u: false },
  '5A': { x: false, u: false },
  '6A': { x: false, u: false },
  C: { x: false, u: false },
};

describe('every real row keeps its meet name and date', () => {
  const rows = realRows();

  it('covers the real exports and every stamp they print', () => {
    expect(rows.length).toBe(1881);
    const stamps = new Set(rows.map(r => r.cols[2]));
    expect([...stamps].sort()).toStrictEqual(Object.keys(EXPECTED).sort());
  });

  it('reads the meet from the meet column, whatever the stamp', () => {
    const wrong: string[] = [];
    for (const row of rows) {
      const { swims } = parseSwimCloudPersonalBestsDetailed(row.text, 'Real Swimmer', row.team, Gender.MEN);
      if (swims.length !== 1) continue; // a row the plausibility gate refuses is not this test's subject
      const [swim] = swims;
      const meet = row.cols[3] || undefined;
      if (swim.meetLabel !== meet || swim.date !== row.cols[4]) {
        wrong.push(`${row.file}:${row.line} [${row.cols[2]}] meet=${swim.meetLabel} date=${swim.date}`);
      }
    }
    expect(wrong).toStrictEqual([]);
  });

  it('flags each row exactly as its stamp says', () => {
    const wrong: string[] = [];
    for (const row of rows) {
      const { swims } = parseSwimCloudPersonalBestsDetailed(row.text, 'Real Swimmer', row.team, Gender.MEN);
      if (swims.length !== 1) continue;
      const want = EXPECTED[row.cols[2]];
      const got = { x: swims[0].isExtractedSplit === true, u: swims[0].isUserInputted === true };
      if (got.x !== want.x || got.u !== want.u) {
        wrong.push(`${row.file}:${row.line} [${row.cols[2]}] got x=${got.x} u=${got.u}`);
      }
    }
    expect(wrong).toStrictEqual([]);
  });
});

describe('the rows this defect was found on', () => {
  const one = (row: string, team = HSU) =>
    parseSwimCloudPersonalBestsDetailed(row, 'Real Swimmer', team, Gender.MEN).swims[0];

  it('D2 B (hsuroster26-27.txt line 3): the meet is New South Championships', () => {
    const swim = one('100 Breast SCY\t54.09\tD2 B\tNew South Championships\tFeb 20, 2026\t');
    expect(swim).toMatchObject({ meetLabel: 'New South Championships', date: 'Feb 20, 2026', swimcloudBadge: 'other' });
  });

  it('NCAA B and WIN JRS (lines 830, 6)', () => {
    expect(one('100 Free SCY\t42.99\tNCAA B\tJames E Martin Invitational\tFeb 28, 2025\t').meetLabel).toBe(
      'James E Martin Invitational'
    );
    expect(
      one('200 IM SCY\t1:49.77\tWIN JRS\t2023 Louisiana Senior SC State Championships\tFeb 12, 2023\t').meetLabel
    ).toBe('2023 Louisiana Senior SC State Championships');
  });

  it('NCSAX (hsuroster26-27.txt line 535) is an extracted split, never a best', () => {
    const swim = one('50 Breast SCY\t29.93\tNCSAX\tLouisiana Senior Short Course State Championships\tFeb 18, 2024\t');
    expect(swim).toMatchObject({
      event: '50 Breaststroke',
      swimcloudBadge: 'extracted',
      isExtractedSplit: true,
      meetLabel: 'Louisiana Senior Short Course State Championships',
      computedCut: null,
    });
    const profile = categorizeBestEvents([swim], HSU, Gender.MEN, 'Real Swimmer', NSISC_PRESET_SETTINGS);
    expect(profile.bestByEvent).toStrictEqual({});
  });

  it('D2 BR (line 45) is the D2 B cut on a relay leadoff, and still a result', () => {
    const swim = one('100 Free SCY\t44.32\tD2 BR\tNew South Championships\tFeb 21, 2026\t');
    expect(swim).toMatchObject({ swimcloudBadge: 'other', meetLabel: 'New South Championships' });
    expect(swim.isExtractedSplit).toBeUndefined();
    expect(swim.isUserInputted).toBeUndefined();
  });

  it('FTR-18U and FTR-18UR (oburoster202627.txt lines 213, 386) are not self-reported', () => {
    for (const row of [
      '200 Breast SCY\t2:03.77\tFTR-18U\tSpeedo Sectionals - Columbia\tMar 13, 2025\t',
      '100 Free LCM\t53.28\tFTR-18UR\tUSA Swimming Futures Championship - Justin\tJul 25, 2025\t',
    ]) {
      const swim = one(row, OBU);
      expect(swim.isUserInputted, row).toBeUndefined();
      expect(swim.swimcloudBadge, row).toBe('other');
    }
  });

  it('a multi-profile paste reads the same way', () => {
    const paste = [
      'Real Swimmer',
      HDR,
      '100 Free SCY\t44.32\tD2 BR\tNew South Championships\tFeb 21, 2026\t',
      '50 Breast SCY\t29.93\tNCSAX\tLouisiana Senior Short Course State Championships\tFeb 18, 2024\t',
      '',
      'Other Swimmer',
      HDR,
      '100 Free SCY\t42.99\tNCAA B\tJames E Martin Invitational\tFeb 28, 2025\t',
    ].join('\n');
    const res = parseSwimCloudMultiProfile(paste, { team: HSU, gender: Gender.MEN });
    const rows = res.athletes.flatMap(a => a.swims);
    expect(rows.map(s => [s.name, s.meetLabel, s.isExtractedSplit === true])).toStrictEqual([
      ['Real Swimmer', 'New South Championships', false],
      ['Real Swimmer', 'Louisiana Senior Short Course State Championships', true],
      ['Other Swimmer', 'James E Martin Invitational', false],
    ]);
  });
});

describe('the stamp reader', () => {
  it('reads each cut label in the vocabulary, alone and with a flag chip glued on', () => {
    for (const label of SWIMCLOUD_CUT_CHIP_LABELS) {
      expect(readSwimCloudStamp(label), label).toMatchObject({ extractedSplit: false, userInputted: false, cutLabel: label });
      expect(readSwimCloudStamp(`${label}X`), `${label}X`).toMatchObject({ extractedSplit: true, cutLabel: label });
      expect(readSwimCloudStamp(`${label}U`)?.userInputted ?? false, `${label}U`).toBe(label !== 'FTR-18');
      expect(readSwimCloudStamp(`${label}R`), `${label}R`).toMatchObject({ relayLeadoff: true, cutLabel: label });
      expect(readSwimCloudStamp(`${label}XR`), `${label}XR`).toMatchObject({ extractedSplit: true, relayLeadoff: true });
    }
  });

  it('keeps the D1 cut badges it always gave', () => {
    expect(parseSwimCloudStampBadge('D1-A')).toBe('d1_a');
    expect(parseSwimCloudStampBadge('D1-B')).toBe('d1_b');
    expect(parseSwimCloudStampBadge('B')).toBe('d1_b');
    expect(parseSwimCloudStampBadge('D2 B')).toBe('other');
    expect(parseSwimCloudStampBadge('NCSAX')).toBe('extracted');
    expect(parseSwimCloudStampBadge('A')).toBe('other');
  });

  it('holds no label that another label plus flag chips could also spell', () => {
    // If `FTR-18` were listed beside `FTR-18U`, then `FTR-18U` could be the
    // Futures cut or `FTR-18` + a U chip. The reader refuses a two-way split,
    // but the list must not create one: every glued stamp decodes one way.
    const collisions: string[] = [];
    for (const label of SWIMCLOUD_CUT_CHIP_LABELS) {
      for (const other of SWIMCLOUD_CUT_CHIP_LABELS) {
        const rest = label.toLowerCase().startsWith(other.toLowerCase()) ? label.slice(other.length) : null;
        if (other !== label && rest !== null && /^[xu]?r?$/i.test(rest)) collisions.push(`${label} = ${other} + ${rest}`);
      }
    }
    expect(collisions).toStrictEqual([]);
  });

  it('does not split a label it does not know', () => {
    // Not a recorded cut label: the split point cannot be proven.
    expect(readSwimCloudStamp('SECTX')).toBeNull();
    expect(readSwimCloudStamp('Speedo Sectionals - Austin')).toBeNull();
  });

  it('gives a stored catalog stamp the same lane', () => {
    expect(bestTimeLaneOfStamp('NCSAX')).toBe('extracted_split');
    expect(bestTimeLaneOfStamp('FTR-18UR')).toBe('result');
    expect(bestTimeLaneOfStamp('D2 BR')).toBe('result');
  });
});

describe('a stamp the reader cannot read', () => {
  const row = '50 Fly SCY\t24.01\tSECTX\tSpeedo Sectionals - Austin\tMar 10, 2025\t';

  it('still keeps the meet name, from the meet column', () => {
    const parsed = parseSwimCloudPersonalBestsDetailed(row, 'Real Swimmer', HSU, Gender.MEN);
    expect(parsed.swims[0]).toMatchObject({ meetLabel: 'Speedo Sectionals - Austin', swimcloudBadge: 'other' });
    expect(parsed.unreadStamps).toStrictEqual([{ raw: row.trim(), stamp: 'SECTX', event: '50 Butterfly' }]);
  });

  it('is reported to the operator, not dropped silently', () => {
    const result = parseSwimCloudPasteDetailed(['Real Swimmer', HDR, row].join('\n'), {
      team: HSU,
      gender: Gender.MEN,
    });
    expect(result.warnings.some(w => w.includes('"SECTX"') && w.includes('Speedo Sectionals - Austin'))).toBe(true);
    const multi = parseSwimCloudMultiProfile(
      ['Real Swimmer', HDR, row, '', 'Other Swimmer', HDR, '50 Free SCY\t21.00\t\tSome Meet\tMar 1, 2025\t'].join('\n'),
      { team: HSU, gender: Gender.MEN }
    );
    expect(multi.warnings.some(w => w.includes('"SECTX"'))).toBe(true);
  });
});
