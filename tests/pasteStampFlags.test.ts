/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a pasted SwimCloud stamp means (plans/2026-09-22/01, P12 defect 3).
 *
 * A SwimCloud personal-bests paste carries each row's chips as plain text in
 * the column after the time. Only the chip's visible label survives the copy;
 * the tooltip that names it does not. Three defects followed:
 *
 * 1. A pasted `U` became `swimcloudBadge: 'user_input'` but never
 *    `isUserInputted`, so a pasted self-reported time still ranked. Same for
 *    `X` and `isExtractedSplit`.
 * 2. Chips are pasted with no separator between them. An extracted leadoff
 *    split prints `XR`, a self-reported leadoff `UR`. Neither matched a
 *    single-letter stamp, so both imported as ordinary results.
 * 3. A bare `A` was read as the D1 "A" cut. On SwimCloud a bare `A` chip is the
 *    altitude mark: the times JSON for swimmer 1401610 labels it `A` with
 *    title "Altitude Adjusted", while its cut chips are labelled `D2 B`,
 *    `JRS`, `US OPEN`. The real exports agree: every bare `A` row in
 *    `hsuroster26-27.txt` and `oburoster202627.txt` is from an altitude venue
 *    or Mexico City, and none is near a D1 A standard (a 4:56.69 500 Free
 *    was badged a D1 A cut). But the paste format has also printed cut chips
 *    as bare letters (the Blaise Vera fixture has a bare `B`), so the text of
 *    one row cannot prove which meaning a bare `A` had. A bare `A` is now a
 *    stamp of unknown meaning (`'other'`): not a cut, and not an altitude flag.
 *    The cut, if any, still comes from the swim's own time (`computedCut`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSwimmerFastestTimesJson } from '@omniswim/swimcloud';
import { Gender } from '../packages/core/src/types';
import {
  categorizeBestEvents,
  isExtractedSplitSwim,
  isUserInputtedSwim,
  parseSwimCloudPasteDetailed,
  parseSwimCloudStampBadge,
} from '../packages/core/src/lib/athleteHistory';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State';
const OBU = 'Ouachita Baptist University';
const HDR = 'Event\tTime\t\tMeet\tDate\tStamp Link';

describe('a pasted U or X row carries the flag, not just the badge (Blaise Vera fixture)', () => {
  const text = readFileSync(join(repoRoot, 'tests', 'fixtures', 'swimcloud', 'blaise_vera_personal_bests.txt'), 'utf8');
  const { swims } = parseSwimCloudPasteDetailed(text, {
    team: 'University of Pittsburgh',
    gender: Gender.MEN,
    division: 'D1',
  });

  it('flags the three U rows as user-inputted', () => {
    expect(swims.filter(s => s.isUserInputted === true).map(s => [s.event, s.time, s.timeType])).toStrictEqual([
      ['200 Freestyle', '1:40.38', 'SCY'],
      ['200 Individual Medley', '1:56.96', 'SCY'],
      ['100 Breaststroke', '59.72', 'SCY'],
    ]);
    expect(swims.filter(s => s.swimcloudBadge === 'user_input')).toHaveLength(3);
  });

  it('flags the two X rows as extracted splits', () => {
    expect(swims.filter(s => s.isExtractedSplit === true).map(s => [s.event, s.time, s.timeType])).toStrictEqual([
      ['50 Butterfly', '20.65', 'SCY'],
      ['50 Butterfly', '24.01', 'LCM'],
    ]);
  });

  it('ranks none of them', () => {
    const profile = categorizeBestEvents(swims, 'University of Pittsburgh', Gender.MEN, 'Blaise Vera', NSISC_PRESET_SETTINGS);
    // 200 Free exists as the U 1:40.38 SCY and a real 1:55.38 LCM. The real,
    // converted LCM swim holds the best; the U time is listed apart.
    expect(profile.bestByEvent['200 Freestyle']?.convertedFrom?.sourceTime).toBe('1:55.38');
    expect(profile.userInputtedByEvent?.['200 Freestyle']?.time).toBe('1:40.38');
    // 200 IM and 100 Breast: the U SCY rows never become bests.
    expect(profile.bestByEvent['200 Individual Medley']?.convertedFrom?.sourceTime).toBe('2:19.17');
    expect(profile.bestByEvent['100 Breaststroke']).toBeUndefined();
    expect(profile.userInputtedByEvent?.['100 Breaststroke']?.time).toBe('59.72');
  });

  it('gives a U row no computed cut', () => {
    // Swimmer 1401610's self-reported 400 IM SCY 3:58.24 would be a D2 B cut
    // (see userInputtedTimes.test.ts). Here it is laid out as a pasted row,
    // with the meet and date the times JSON gives for that swim, once with its
    // U chip and once without.
    const paste = [
      'Simon Casey',
      HDR,
      '400 IM SCY\t3:58.24\tU\t2023 Northeast divisional championship\tMar 24, 2023\t',
      '400 IM SCY\t3:58.24\t\t2023 Northeast divisional championship\tMar 24, 2023\t',
    ].join('\n');
    const rows = parseSwimCloudPasteDetailed(paste, { team: HSU, gender: Gender.MEN }).swims;
    expect(rows.map(s => [s.swimcloudBadge, s.isUserInputted === true, s.computedCut])).toStrictEqual([
      ['user_input', true, null],
      ['none', false, 'B'],
    ]);
  });
});

describe('concatenated chips (real roster exports)', () => {
  it('reads XR as an extracted split (hsuroster26-27.txt line 72)', () => {
    // Colin Candebat's 21.17 is the first 50 of his 100 Free leadoff the same
    // day (line 45: "100 Free SCY 44.32 D2 BR").
    const paste = ['Colin Candebat', HDR, '50 Free SCY\t21.17\tXR\tNew South Championships\tFeb 21, 2026\t'].join('\n');
    const [row] = parseSwimCloudPasteDetailed(paste, { team: HSU, gender: Gender.MEN }).swims;
    expect(row).toMatchObject({ event: '50 Freestyle', time: '21.17', swimcloudBadge: 'extracted', isExtractedSplit: true });
    expect(row.isUserInputted).toBeUndefined();
    expect(row.computedCut).toBeNull();
    const profile = categorizeBestEvents([row], HSU, Gender.MEN, 'Colin Candebat', NSISC_PRESET_SETTINGS);
    expect(profile.bestByEvent).toStrictEqual({});
    expect(profile.extractedByEvent['50 Freestyle']?.time).toBe('21.17');
  });

  it('reads UR as user-inputted (oburoster202627.txt line 818)', () => {
    const paste = [
      'Vince Pal',
      HDR,
      '100 Free SCM\t51.26\tUR\tI. Korosztályos Országos Rövidpályás Bajnokság\tDec 7, 2022\t',
    ].join('\n');
    const [row] = parseSwimCloudPasteDetailed(paste, { team: OBU, gender: Gender.MEN }).swims;
    expect(row).toMatchObject({ event: '100 Freestyle', timeType: 'SCM', swimcloudBadge: 'user_input', isUserInputted: true });
    expect(isUserInputtedSwim(row)).toBe(true);
    expect(isExtractedSplitSwim(row)).toBe(false);
  });

  it('flags rows the same way through the multi-profile parser', () => {
    const paste = [
      'Colin Candebat',
      HDR,
      '50 Free SCY\t21.17\tXR\tNew South Championships\tFeb 21, 2026\t',
      '50 Back SCY\t24.76\tR\t2021 Louisiana SC Championship\tMar 25, 2021\t',
      '',
      'Bartu Akin',
      HDR,
      '400 Free SCM\t4:01.80\tU\tTED Mersin Koleji Spor Kulübü Intrasquad\tNov 22, 2024\t',
      '100 Fly SCY\t54.91\tX\tNew South Championships\tFeb 19, 2026\t',
    ].join('\n');
    const res = parseSwimCloudMultiProfile(paste, { team: HSU, gender: Gender.MEN });
    const rows = res.athletes.flatMap(a => a.swims);
    expect(rows.map(s => [s.name, s.event, isExtractedSplitSwim(s), isUserInputtedSwim(s)])).toStrictEqual([
      ['Colin Candebat', '50 Freestyle', true, false],
      ['Colin Candebat', '50 Backstroke', false, false],
      ['Bartu Akin', '400 Freestyle', false, true],
      ['Bartu Akin', '100 Butterfly', true, false],
    ]);
    expect(rows.filter(s => s.isExtractedSplit === true)).toHaveLength(2);
    expect(rows.filter(s => s.isUserInputted === true)).toHaveLength(1);
  });
});

describe('a bare A is not a cut', () => {
  it('is the altitude chip in the times JSON (swimmer 1401610)', () => {
    const raw = readFileSync(join(repoRoot, 'tests', 'fixtures', 'profile_fastest_times-1401610-altitude.json'), 'utf8');
    const parsed = parseSwimmerFastestTimesJson(raw, {
      sourceUrl: 'https://www.swimcloud.com/api/swimmers/1401610/profile_fastest_times/',
      retrievedAt: '2026-09-22T12:00:00.000Z',
      track: 'browser-extension',
    });
    if (!parsed.ok) throw new Error(parsed.failure.message);
    const chips = parsed.data.personalBests.flatMap(b => b.tags);
    const bareA = chips.filter(t => t.code === 'A');
    expect(bareA.map(t => t.title)).toStrictEqual(['Altitude Adjusted']);
  });

  it('no longer maps to the D1 A cut', () => {
    expect(parseSwimCloudStampBadge('A')).toBe('other');
    expect(parseSwimCloudStampBadge('a')).toBe('other');
    // A stamp that names the division is still the cut.
    expect(parseSwimCloudStampBadge('D1-A')).toBe('d1_a');
    expect(parseSwimCloudStampBadge('D1-B')).toBe('d1_b');
    expect(parseSwimCloudStampBadge('X')).toBe('extracted');
    expect(parseSwimCloudStampBadge('U')).toBe('user_input');
    expect(parseSwimCloudStampBadge('XR')).toBe('extracted');
    expect(parseSwimCloudStampBadge('UR')).toBe('user_input');
    expect(parseSwimCloudStampBadge('')).toBe('none');
  });

  it('stamps no cut on a real altitude row (hsuroster26-27.txt line 336)', () => {
    // Steven Balistreri's 100 Free SCY 46.09 at the RMAC Championships
    // (Colorado). The D1 A standard for the 100 Free is several seconds faster.
    const paste = [
      'Steven Balistreri',
      HDR,
      '100 Free SCY\t46.09\tA\tRocky Mountain Athletic Conference Championships\tFeb 11, 2023\t',
    ].join('\n');
    const [row] = parseSwimCloudPasteDetailed(paste, { team: HSU, gender: Gender.MEN }).swims;
    expect(row.swimcloudBadge).toBe('other');
    expect(row.meetLabel).toBe('Rocky Mountain Athletic Conference Championships');
    // Unknown meaning: not claimed as an altitude-adjusted time either.
    expect(row.isAltitudeAdjusted).toBeUndefined();
    // Still a real swim, still a best.
    expect(isUserInputtedSwim(row) || isExtractedSplitSwim(row)).toBe(false);
  });
});
