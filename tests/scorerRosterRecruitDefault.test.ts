/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Closes a coverage gap found while refactoring `buildScorerRosterLookup` for
 * cyclomatic complexity (code-health plan 2026-09-25, item H8): no named test
 * asserted that a recruit row scores by default (`isScorer: true`) absent a
 * manual override, and that a manual override still wins for a recruit the
 * same way it does for a roster athlete. Flipping the recruit default to
 * `false` in `resolveIsScorer` (`packages/core/src/lib/scorerRoster.ts`)
 * passed every existing named test in the suite — only a golden snapshot
 * over real + synthetic data caught it.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type ScorerRosterOverride, type SwimmerResult } from '../packages/core/src/types';
import { buildScorerRosterLookup } from '../packages/core/src/lib/scorerRoster';
import { mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';

const TEAM = 'Henderson State University';
const EVENT = 'Event 1 Men 100 Yard Freestyle';
const SETTINGS = mergeScoringSettings({ scorerEligibilityMode: 'roster' });

function recruitRow(name: string): SwimmerResult {
  return {
    id: `recruit-${name}`,
    rank: 0,
    name,
    classYear: 'FR',
    team: TEAM,
    time: '49.00',
    roundSwam: 'A Final',
    points: 0,
    event: EVENT,
    gender: Gender.MEN,
    isRelay: false,
    isRecruit: true,
  } as SwimmerResult;
}

describe('buildScorerRosterLookup: recruit isScorer default', () => {
  it('scores a recruit by default with no manual override', () => {
    const lookup = buildScorerRosterLookup([recruitRow('Randy Recruit')], SETTINGS, []);
    const row = lookup.rows.find(r => r.name === 'Randy Recruit');
    expect(row?.isScorer).toBe(true);
    expect(row?.source).toBe('auto');
    expect(lookup.isScorer('Randy Recruit', TEAM, Gender.MEN)).toBe(true);
  });

  it('a manual override still wins for a recruit', () => {
    const overrides: ScorerRosterOverride[] = [
      { name: 'Randy Recruit', team: TEAM, gender: Gender.MEN, isScorer: false },
    ];
    const lookup = buildScorerRosterLookup([recruitRow('Randy Recruit')], SETTINGS, overrides);
    const row = lookup.rows.find(r => r.name === 'Randy Recruit');
    expect(row?.isScorer).toBe(false);
    expect(row?.source).toBe('manual');
    expect(lookup.isScorer('Randy Recruit', TEAM, Gender.MEN)).toBe(false);
  });
});
