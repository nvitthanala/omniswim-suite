/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The roster catalog obeys the same best-time rules as athlete history
 * (plans/2026-09-22/01, P12 defect 4).
 *
 * A catalog time records SwimCloud's chip in `swimcloudBadge`: `'X'`/`'U'` in
 * the catalog import JSON, or `'extracted'`/`'user_input'` when it came
 * through a paste. `bestTimesByEvent` and `buildCategorizedScoringInputs`
 * ignored it, so a self-reported time or an extracted split could be the
 * athlete's catalog best and be scored as an entry. They also picked bests
 * per raw label, so `'50 Free'` and `'50 Freestyle'` were two events.
 *
 * The times are Bartu Akin's (swimmer 2352628, HSU): a self-reported 100
 * Breast SCM 1:08.56 that converts faster than his real 100 Breast LCM
 * 1:11.13, and an extracted 100 Fly SCY 54.91 that is his only 100 Fly.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '../packages/core/src/types';
import {
  bestTimesByEvent,
  buildStoredSwim,
  isRankableSwimCloudStamp,
  type CatalogEventTime,
  type CatalogTeamRoster,
} from '../packages/core/src/lib/rosterCatalog';
import { buildEventProfileFromCatalog } from '../packages/core/src/lib/athleteHistory';
import { buildCategorizedScoringInputs } from '../packages/core/src/lib/utils';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const HSU = 'Henderson State';
const NAME = 'Bartu Akin';

function stored(
  id: string,
  event: string,
  timeText: string,
  timeType: 'SCY' | 'LCM' | 'SCM',
  swimcloudBadge: string | null = null
): CatalogEventTime {
  return buildStoredSwim({
    id,
    athleteId: 'a1',
    event,
    timeText,
    timeType,
    source: 'json',
    gender: Gender.MEN,
    division: 'D2',
    swimcloudBadge,
  });
}

const TIMES: CatalogEventTime[] = [
  stored('u-breast', '100 Breast SCM', '1:08.56', 'SCM', 'U'),
  stored('real-breast', '100 Breast LCM', '1:11.13', 'LCM'),
  stored('x-fly', '100 Fly SCY', '54.91', 'SCY', 'X'),
  stored('real-50', '50 Free SCY', '22.65', 'SCY'),
];

function roster(times: CatalogEventTime[]): CatalogTeamRoster {
  return {
    team: { id: 't1', name: HSU, gender: 'Men', sortIndex: 0, createdAt: 0, updatedAt: 0 },
    athletes: [
      {
        id: 'a1',
        teamId: 't1',
        fullName: NAME,
        nameKey: 'bartu akin',
        classYear: 'SO',
        gender: 'Men',
        createdAt: 0,
        updatedAt: 0,
        times,
      },
    ],
  };
}

describe('the catalog stamp predicate', () => {
  it('refuses both vocabularies of X and U, and nothing else', () => {
    for (const stamp of ['X', 'x', 'U', 'u', 'extracted', 'user_input', 'XR', 'UR']) {
      expect(isRankableSwimCloudStamp(stamp)).toBe(false);
    }
    for (const stamp of [null, undefined, '', 'A', 'B', 'R', 'D2 B', 'd1_a', 'other', 'none']) {
      expect(isRankableSwimCloudStamp(stamp)).toBe(true);
    }
  });
});

describe('bestTimesByEvent', () => {
  it('never picks a self-reported time or an extracted split', () => {
    // The U swim converts faster than the real one: that is the regression.
    const u = TIMES.find(t => t.id === 'u-breast')!;
    const real = TIMES.find(t => t.id === 'real-breast')!;
    expect(u.timeSecondsScy).toBeLessThan(real.timeSecondsScy);

    const best = bestTimesByEvent(TIMES);
    expect(best.get('100 Breast')?.id).toBe('real-breast');
    expect([...best.values()].map(t => t.id).sort()).toStrictEqual(['real-50', 'real-breast']);
  });

  it('picks one best per event across label spellings', () => {
    const pasted = stored('paste-50', '50 Freestyle', '22.90', 'SCY');
    const best = bestTimesByEvent([pasted, ...TIMES]);
    const fifties = [...best.entries()].filter(([, t]) => /^50 Free/.test(t.event));
    expect(fifties.map(([, t]) => t.id)).toStrictEqual(['real-50']);
  });
});

describe('buildStoredSwim', () => {
  it('stamps no computed cut on a self-reported or extracted time', () => {
    // Swimmer 1401610's self-reported 400 IM SCY 3:58.24 judges as a D2 B cut.
    expect(stored('real-im', '400 IM SCY', '3:58.24', 'SCY').computedCut).toBe('B');
    expect(stored('u-im', '400 IM SCY', '3:58.24', 'SCY', 'U').computedCut).toBeNull();
    expect(stored('x-im', '400 IM SCY', '3:58.24', 'SCY', 'X').computedCut).toBeNull();
    expect(stored('ui-im', '400 IM SCY', '3:58.24', 'SCY', 'user_input').computedCut).toBeNull();
  });
});

describe('buildEventProfileFromCatalog', () => {
  it('lists X and U times apart from the bests', () => {
    const profile = buildEventProfileFromCatalog(roster(TIMES), HSU, Gender.MEN, NAME, NSISC_PRESET_SETTINGS)!;
    expect(Object.keys(profile.bestByEvent).sort()).toStrictEqual(['100 Breast', '50 Free']);
    expect(profile.bestByEvent['100 Breast']?.time).toBe('1:11.13');
    expect(profile.userInputtedByEvent?.['100 Breast']?.time).toBe('1:08.56');
    expect(profile.extractedByEvent['100 Fly']?.time).toBe('54.91');
    expect(profile.primaryEvents).not.toContain('100 Fly');
  });
});

describe('buildCategorizedScoringInputs', () => {
  it('scores no self-reported time or extracted split, and one row per event', () => {
    const workspace = {
      id: 'ws',
      name: 'catalog',
      createdAt: 0,
      menResults: [],
      womenResults: [],
      scoringSettings: { ...NSISC_PRESET_SETTINGS },
    } as unknown as Workspace;
    const rows = buildCategorizedScoringInputs({ workspace, gender: Gender.MEN, rosterCatalog: roster(TIMES) });
    expect(rows.map(r => r.id).sort()).toStrictEqual(['catalog_real-50', 'catalog_real-breast']);
  });

  it('replaces the swimmer\'s meet row in the same event instead of adding a second', () => {
    const meetRow = {
      id: 'pdf-50',
      rank: 3,
      name: NAME,
      classYear: 'SO',
      team: HSU,
      time: '22.80',
      points: 14,
      event: 'Event 8 Men 50 Yard Freestyle',
      gender: Gender.MEN,
    };
    const workspace = {
      id: 'ws',
      name: 'catalog',
      createdAt: 0,
      menResults: [meetRow],
      womenResults: [],
      scoringSettings: { ...NSISC_PRESET_SETTINGS },
    } as unknown as Workspace;
    const rows = buildCategorizedScoringInputs({ workspace, gender: Gender.MEN, rosterCatalog: roster(TIMES) });
    expect(rows.map(r => r.id).sort()).toStrictEqual(['catalog_real-50', 'catalog_real-breast']);
  });

  it('keeps one row per event when two spellings are stored', () => {
    const workspace = {
      id: 'ws',
      name: 'catalog',
      createdAt: 0,
      menResults: [],
      womenResults: [],
      scoringSettings: { ...NSISC_PRESET_SETTINGS },
    } as unknown as Workspace;
    const pasted = stored('paste-50', '50 Freestyle', '22.90', 'SCY');
    const rows = buildCategorizedScoringInputs({
      workspace,
      gender: Gender.MEN,
      rosterCatalog: roster([pasted, ...TIMES]),
    });
    expect(rows.map(r => r.id).sort()).toStrictEqual(['catalog_real-50', 'catalog_real-breast']);
  });
});
