/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { cutlines, type CutlineRecord } from '../cutlines';
import { Gender, NcaaDivision } from '../types';
import { convertTimeToSeconds } from './utils';

export type CutlineSeason = '25_26' | '26_27' | '27_28' | '28_29';

const SEASON_TIME_KEY: Record<CutlineSeason, keyof CutlineRecord> = {
  '25_26': 'time_25_26',
  '26_27': 'proj_26_27',
  '27_28': 'proj_27_28',
  '28_29': 'proj_28_29',
};

export function normalizeEventForCutline(event: string): string {
  let e = event.replace(/\s+/g, ' ').trim();
  e = e.replace(/\b(SCY|LCM|SCM)\b/gi, '').trim();
  if (/\bfly\b/i.test(e) && !/butterfly/i.test(e)) {
    e = e.replace(/\bfly\b/i, 'Butterfly');
  }
  if (/\bback\b/i.test(e) && !/backstroke/i.test(e)) {
    e = e.replace(/\bback\b/i, 'Backstroke');
  }
  if (/\bbreast\b/i.test(e) && !/breaststroke/i.test(e)) {
    e = e.replace(/\bbreast\b/i, 'Breaststroke');
  }
  if (/\bfree\b/i.test(e) && !/freestyle/i.test(e)) {
    e = e.replace(/\bfree\b/i, 'Freestyle');
  }
  if (/\bIM\b/.test(e) && !/individual medley/i.test(e)) {
    e = e.replace(/\bIM\b/, 'Individual Medley');
  }
  return e.replace(/\s+/g, ' ').trim();
}

function genderKey(gender: Gender): string {
  return gender === Gender.WOMEN ? 'Women' : 'Men';
}

export function getCutlinesForSwim(
  gender: Gender,
  event: string,
  division: NcaaDivision = 'D1',
  season: CutlineSeason = '25_26'
): { aCut?: CutlineRecord; bCut?: CutlineRecord; aCutSec: number; bCutSec: number } {
  const g = genderKey(gender);
  const cleanEvent = normalizeEventForCutline(event);
  const timeKey = SEASON_TIME_KEY[season];
  const rows = cutlines.filter(
    c =>
      c.division === division &&
      c.gender === g &&
      c.event.toUpperCase() === cleanEvent.toUpperCase()
  );
  const aCut = rows.find(c => c.standard === 'A');
  const bCut = rows.find(c => c.standard === 'B');
  const aTime = aCut ? String(aCut[timeKey] ?? aCut.time_25_26 ?? '') : '';
  const bTime = bCut ? String(bCut[timeKey] ?? bCut.time_25_26 ?? '') : '';
  return {
    aCut,
    bCut,
    aCutSec: aTime ? convertTimeToSeconds(aTime) : 0,
    bCutSec: bTime ? convertTimeToSeconds(bTime) : 0,
  };
}

export function compareTimeToCutline(
  timeSec: number,
  gender: Gender,
  event: string,
  division: NcaaDivision = 'D1',
  season: CutlineSeason = '25_26'
): { achieved: 'A' | 'B' | null; aCutSec: number; bCutSec: number } {
  if (!timeSec || timeSec <= 0) {
    return { achieved: null, aCutSec: 0, bCutSec: 0 };
  }
  const { aCutSec, bCutSec } = getCutlinesForSwim(gender, event, division, season);
  if (aCutSec > 0 && timeSec <= aCutSec) {
    return { achieved: 'A', aCutSec, bCutSec };
  }
  if (bCutSec > 0 && timeSec <= bCutSec) {
    return { achieved: 'B', aCutSec, bCutSec };
  }
  return { achieved: null, aCutSec, bCutSec };
}

export function isACut(timeSec: number, gender: Gender, event: string, division?: NcaaDivision): boolean {
  return compareTimeToCutline(timeSec, gender, event, division).achieved === 'A';
}

export function isBCut(timeSec: number, gender: Gender, event: string, division?: NcaaDivision): boolean {
  return compareTimeToCutline(timeSec, gender, event, division).achieved === 'B';
}
