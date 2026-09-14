// @vitest-environment node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `packages/matrix/src/lib/swimCloudImportDiagnostics.ts` — the grouping and
 * severity classification behind `SwimCloudImportDiagnosticsPanel`. See that
 * module's own file header for the "N warning(s) — see console" gap this
 * closes (`plans/2026-09-10/01-SWIMCLOUD-SCORING-CORRECTNESS.md` §5).
 */
import { describe, expect, it } from 'vitest';
import {
  classifySkipSeverity,
  classifyWarningSeverity,
  groupSkipsByReason,
  groupWarningsByCode,
  skipReasonLabel,
} from '@omniswim/matrix/lib/swimCloudImportDiagnostics';
import type { SwimCloudMeetImportSkip } from '@omniswim/matrix/lib/swimCloudMeetImportBridge';
import type { SwimCloudParseWarning } from '@omniswim/swimcloud/parser';

function skip(overrides: Partial<SwimCloudMeetImportSkip> = {}): SwimCloudMeetImportSkip {
  return { reason: 'ambiguous-round-duplicate', eventLabel: '100 Y Breast', ...overrides };
}

function warning(overrides: Partial<SwimCloudParseWarning> = {}): SwimCloudParseWarning {
  return { code: 'relay-legs-absent', message: 'no relay legs published', ...overrides };
}

describe('classifySkipSeverity', () => {
  it('marks relay-leadoff as structural — every leadoff is correctly excluded, always', () => {
    expect(classifySkipSeverity('relay-leadoff')).toBe('structural');
  });

  it('marks ambiguous-round-duplicate as review — the one a coach must act on', () => {
    expect(classifySkipSeverity('ambiguous-round-duplicate')).toBe('review');
  });

  it('defaults every other reason to review, not structural', () => {
    expect(classifySkipSeverity('unknown-gender')).toBe('review');
    expect(classifySkipSeverity('no-team-name')).toBe('review');
    expect(classifySkipSeverity('no-athlete-name')).toBe('review');
  });
});

describe('classifyWarningSeverity', () => {
  it('marks known-benign structural codes as structural', () => {
    expect(classifyWarningSeverity('relay-legs-absent')).toBe('structural');
    expect(classifyWarningSeverity('unmapped-class-year')).toBe('structural');
    expect(classifyWarningSeverity('unmapped-stroke')).toBe('structural');
    expect(classifyWarningSeverity('diving-score-not-a-time')).toBe('structural');
    expect(classifyWarningSeverity('diving-score-column-unverified')).toBe('structural');
    expect(classifyWarningSeverity('unreadable-embedded-json')).toBe('structural');
    expect(classifyWarningSeverity('unrecognized-season-label')).toBe('structural');
  });

  it('does not fold unrecognized-points-token into structural, despite the "usually benign on a DQ row" note — that condition cannot be told apart from a real loss by code alone', () => {
    expect(classifyWarningSeverity('unrecognized-points-token')).toBe('review');
  });

  it('defaults every other code to review', () => {
    expect(classifyWarningSeverity('zero-data-rows')).toBe('review');
    expect(classifyWarningSeverity('unparsed-row')).toBe('review');
    expect(classifyWarningSeverity('missing-round-caption')).toBe('review');
    expect(classifyWarningSeverity('missing-rank-cell')).toBe('review');
    expect(classifyWarningSeverity('contradicted-page-declaration')).toBe('review');
  });
});

describe('groupSkipsByReason', () => {
  it('groups by reason, counts correctly, and orders review groups before structural ones', () => {
    const groups = groupSkipsByReason([
      skip({ reason: 'relay-leadoff' }),
      skip({ reason: 'relay-leadoff' }),
      skip({ reason: 'ambiguous-round-duplicate', eventLabel: '100 Y Breast', subject: 'Avery Henke' }),
      skip({ reason: 'unknown-gender' }),
    ]);

    // Both review-severity groups precede the one structural group.
    expect(groups.map(g => g.severity)).toStrictEqual(['review', 'review', 'structural']);
    const byReason = Object.fromEntries(groups.map(g => [g.reason, g]));
    expect(byReason['relay-leadoff'].count).toBe(2);
    expect(byReason['ambiguous-round-duplicate'].count).toBe(1);
    expect(byReason['ambiguous-round-duplicate'].items[0].subject).toBe('Avery Henke');
    expect(byReason['unknown-gender'].count).toBe(1);
  });

  it('returns no groups for an empty skip list', () => {
    expect(groupSkipsByReason([])).toStrictEqual([]);
  });
});

describe('groupWarningsByCode', () => {
  it('groups by code, counts correctly, de-duplicates repeated messages into examples, and caps examples at 3', () => {
    const groups = groupWarningsByCode([
      warning({ code: 'relay-legs-absent', message: 'event A' }),
      warning({ code: 'relay-legs-absent', message: 'event A' }), // exact duplicate — collapses in examples
      warning({ code: 'relay-legs-absent', message: 'event B' }),
      warning({ code: 'missing-round-caption', message: 'event C' }),
    ]);

    expect(groups.map(g => g.severity)).toStrictEqual(['review', 'structural']);
    const byCode = Object.fromEntries(groups.map(g => [g.code, g]));
    expect(byCode['relay-legs-absent'].count).toBe(3); // count is every row, not de-duplicated
    expect(byCode['relay-legs-absent'].examples).toStrictEqual(['event A', 'event B']); // examples ARE de-duplicated
    expect(byCode['missing-round-caption'].count).toBe(1);
  });

  it('caps examples at 3 even with many distinct messages', () => {
    const groups = groupWarningsByCode(
      Array.from({ length: 5 }, (_, i) => warning({ message: `event ${i}` }))
    );
    expect(groups[0].count).toBe(5);
    expect(groups[0].examples).toHaveLength(3);
  });
});

describe('skipReasonLabel', () => {
  it('names every reason with a real label, not the raw code', () => {
    const reasons: Array<SwimCloudMeetImportSkip['reason']> = [
      'unknown-gender',
      'no-team-name',
      'no-athlete-name',
      'relay-leadoff',
      'ambiguous-round-duplicate',
    ];
    for (const reason of reasons) {
      const label = skipReasonLabel(reason);
      expect(label).not.toBe(reason);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
