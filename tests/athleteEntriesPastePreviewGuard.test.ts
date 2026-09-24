/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The athlete-drawer paste preview must show an extracted split (X) or a
 * self-reported time (U) so the coach can see it was pasted, but never let
 * it become a planned entry — neither is a race result (`isRankableSwim`).
 * Before this fix, `selectPastePreviewRows` treated every parsed swim the
 * same, so a selected X/U row silently became a lineup entry on confirm.
 */
import { describe, expect, it } from 'vitest';
import { selectPastePreviewRows } from '../packages/manager/src/components/athleteEntriesView';
import { Gender, type HistoricalSwim, type ScoringSettings } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { countSwimmerEntries } from '../packages/core/src/lib/swimmerEntryLimits';

const settings: ScoringSettings = { ...NSISC_PRESET_SETTINGS };
const zeroCounts = countSwimmerEntries([], 'Henderson State', Gender.MEN, 'Swimmer');

function swim(event: string, over: Partial<HistoricalSwim> = {}): HistoricalSwim {
  return {
    name: 'Swimmer',
    team: 'Henderson State',
    gender: Gender.MEN,
    event,
    time: '48.00',
    timeType: 'SCY',
    source: 'swimcloud',
    ...over,
  };
}

describe('selectPastePreviewRows', () => {
  it('selects a plain result normally', () => {
    const preview = selectPastePreviewRows({
      swims: [swim('100 Freestyle')],
      existingEvents: new Set(),
      counts: zeroCounts,
      settings,
    });
    expect(preview).toStrictEqual([{ event: '100 Freestyle', time: '48.00', selected: true }]);
  });

  it('keeps an extracted split visible but disabled, unselected, with a reason', () => {
    const preview = selectPastePreviewRows({
      swims: [swim('200 Freestyle', { isExtractedSplit: true })],
      existingEvents: new Set(),
      counts: zeroCounts,
      settings,
    });
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ event: '200 Freestyle', selected: false, disabled: true });
    expect(preview[0].disabledReason).toMatch(/extracted/i);
  });

  it('keeps a self-reported time visible but disabled, unselected, with a reason', () => {
    const preview = selectPastePreviewRows({
      swims: [swim('50 Freestyle', { isUserInputted: true })],
      existingEvents: new Set(),
      counts: zeroCounts,
      settings,
    });
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ event: '50 Freestyle', selected: false, disabled: true });
    expect(preview[0].disabledReason).toMatch(/self-reported/i);
  });

  it('reads the pasted-row badge the same as the bridge flag', () => {
    const preview = selectPastePreviewRows({
      swims: [swim('200 Freestyle', { swimcloudBadge: 'extracted' })],
      existingEvents: new Set(),
      counts: zeroCounts,
      settings,
    });
    expect(preview[0].disabled).toBe(true);
  });

  it('mixes a rankable and a non-rankable swim: only the rankable one is selectable', () => {
    const preview = selectPastePreviewRows({
      swims: [swim('100 Freestyle'), swim('200 Freestyle', { isExtractedSplit: true })],
      existingEvents: new Set(),
      counts: zeroCounts,
      settings,
    });
    expect(preview).toHaveLength(2);
    const real = preview.find((p) => p.event === '100 Freestyle')!;
    const extracted = preview.find((p) => p.event === '200 Freestyle')!;
    expect(real.selected).toBe(true);
    expect(real.disabled).toBeUndefined();
    expect(extracted.selected).toBe(false);
    expect(extracted.disabled).toBe(true);
  });
});
