/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P6 mislabel fix: `athleteHistoryImportView.badgeLabel` used to read an
 * extracted split (SwimCloud `X`) as "Official" / "Extracted official
 * result" — the opposite of what the flag means. An extracted split is a
 * time taken out of a longer swim's splits, never a standalone race result.
 */
import { describe, expect, it } from 'vitest';
import {
  badgeLabel,
  buildSwimRowTagSpecs,
} from '../packages/manager/src/components/athleteHistoryImportView';
import type { HistoricalSwim } from '../packages/core/src/types';
import { Gender } from '../packages/core/src/types';

const swim: HistoricalSwim = {
  name: 'Swimmer',
  team: 'Henderson State',
  gender: Gender.MEN,
  event: '100 Breaststroke',
  time: '54.09',
  timeType: 'SCY',
  source: 'swimcloud',
};

describe('badgeLabel', () => {
  it('reads an extracted split as "Extracted", never "Official"', () => {
    expect(badgeLabel('extracted')).toBe('Extracted');
    expect(badgeLabel('extracted')).not.toBe('Official');
  });

  it('reads a user-inputted time as "Self-reported"', () => {
    expect(badgeLabel('user_input')).toBe('Self-reported');
  });
});

describe('buildSwimRowTagSpecs', () => {
  it('shows the "Extracted" tag with a not-a-result tooltip for an extracted stamp', () => {
    const specs = buildSwimRowTagSpecs('Extracted', swim, undefined).filter((s) => s.show);
    expect(specs.map((s) => s.label)).toStrictEqual(['Extracted']);
    expect(specs[0].title).toMatch(/not a standalone race result/i);
    // No spec anywhere claims the row is official.
    expect(specs.every((s) => s.label !== 'Official')).toBe(true);
  });

  it('shows the "Self-reported" tag for a user-inputted stamp', () => {
    const specs = buildSwimRowTagSpecs('Self-reported', swim, undefined).filter((s) => s.show);
    expect(specs.map((s) => s.label)).toStrictEqual(['Self-reported']);
  });
});
