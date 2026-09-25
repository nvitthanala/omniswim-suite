/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P16: `parseSwimCloudPasteDetailed` bakes one full sentence per unreadable
 * SwimCloud stamp into its flat `warnings: string[]`
 * (`unreadSwimCloudStampWarning` in `@omniswim/core/lib/athleteHistory`).
 * `splitUnreadStampWarnings` pulls those sentences back out so the import
 * panels can show a short "N rows had a stamp we couldn't read: …" summary
 * instead of N near-identical bullets crowding out every other warning.
 */
import { describe, expect, it } from 'vitest';
import { unreadSwimCloudStampWarning } from '../packages/core/src/lib/athleteHistory';
import { splitUnreadStampWarnings } from '../packages/manager/src/components/athleteHistoryImportView';

describe('splitUnreadStampWarnings', () => {
  it('passes warnings through untouched, with a null summary, when there is nothing to pull out', () => {
    const warnings = ['Some other warning', 'Another one'];
    expect(splitUnreadStampWarnings(warnings)).toStrictEqual({
      otherWarnings: warnings,
      unreadStampSummary: null,
    });
  });

  it('pulls unread-stamp sentences out and collapses them into one summary line', () => {
    const rowA = { raw: '100 Freestyle\t48.00\t??\tSome Meet\t2026-01-01', stamp: '??', event: '100 Freestyle' };
    const rowB = { raw: '200 Backstroke\t1:48.00\t~~\tSome Meet\t2026-01-01', stamp: '~~', event: '200 Backstroke' };
    const warnings = [
      'A regular warning',
      unreadSwimCloudStampWarning(rowA),
      unreadSwimCloudStampWarning(rowB),
    ];

    const { otherWarnings, unreadStampSummary } = splitUnreadStampWarnings(warnings);

    expect(otherWarnings).toStrictEqual(['A regular warning']);
    expect(unreadStampSummary).toBe(
      "2 rows had a stamp we couldn't read: 100 Freestyle, 200 Backstroke"
    );
  });

  it('caps the listed events at 5 and counts the rest as "+N more"', () => {
    const events = ['50 Free', '100 Free', '200 Free', '500 Free', '1000 Free', '1650 Free', '100 Back'];
    const warnings = events.map((event, i) =>
      unreadSwimCloudStampWarning({ raw: `row-${i}`, stamp: '??', event })
    );

    const { unreadStampSummary } = splitUnreadStampWarnings(warnings);

    expect(unreadStampSummary).toBe(
      "7 rows had a stamp we couldn't read: 50 Free, 100 Free, 200 Free, 500 Free, 1000 Free, +2 more"
    );
  });
});
