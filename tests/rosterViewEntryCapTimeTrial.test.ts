/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The roster table's per-row entry-cap warning must honor
 * `entryCapCountsTimeTrials`. When the flag is absent (default false), a
 * time-trial row does not push the swimmer over the cap; when it is true,
 * the same row does. Proves the manager roster view threads workspace
 * settings into `countSwimmerEntries`.
 *
 * Fixtures are synthetic: invented names and times.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type SwimmerResult } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import { GENERIC_TOP16_SETTINGS } from '@omniswim/core/lib/scoringDefaults';
import { buildAliasResolver } from '@omniswim/core/lib/athleteAliases';
import { buildRosterRowViewModel } from '../packages/manager/src/components/teamRosterView';

const TEAM = 'Alpha University';
const NAME = 'Ann Able';

const row: ScorerRosterRow = {
  key: 'k1',
  name: NAME,
  team: TEAM,
  gender: Gender.MEN,
  classYear: 'JR',
  athleteRole: 'swimmer',
  isScorer: true,
  source: 'auto',
};

function swim(id: string, event: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name: NAME,
    classYear: 'JR',
    team: TEAM,
    time: '50.00',
    points: 0,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...extra,
  } as SwimmerResult;
}

/** One program swim fills a total cap of 1; a time trial is the contested second. */
const genderResults = [
  swim('a', 'Event 8 Men 50 Yard Freestyle'),
  swim('tt', 'Event 300 Men 50 Yard Freestyle Time Trial', { isTimeTrial: true }),
];

const baseCtx = {
  genderResults,
  gender: Gender.MEN,
  aliasResolver: buildAliasResolver([]),
  hasSelectedTeam: true,
  mergedAthleteHistory: [],
  pointTotals: new Map<string, number>(),
};

describe('roster view entry-cap time-trial policy', () => {
  it('does not count a time-trial row toward the entry cap by default', () => {
    const vm = buildRosterRowViewModel(row, {
      ...baseCtx,
      settings: { ...GENERIC_TOP16_SETTINGS, maxTotalEntriesPerSwimmer: 1 },
    });
    expect(vm.warningLabel).not.toBe('Over limit');
  });

  it('counts a time-trial row when entryCapCountsTimeTrials is true', () => {
    const vm = buildRosterRowViewModel(row, {
      ...baseCtx,
      settings: {
        ...GENERIC_TOP16_SETTINGS,
        maxTotalEntriesPerSwimmer: 1,
        entryCapCountsTimeTrials: true,
      },
    });
    expect(vm.warningLabel).toBe('Over limit');
    expect(vm.warningMessages).toContain('Over entry limit');
  });
});
