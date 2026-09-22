/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Groups a SwimCloud meet-results import's skip reasons and parser warnings
 * for display, instead of the bare `${n} warning(s) — see console` toast
 * `plans/2026-09-10/01-SWIMCLOUD-SCORING-CORRECTNESS.md` §5 flagged: a real
 * defect and expected structural noise (a relay's legs not being published,
 * say) read equally alarming at a glance, and `'ambiguous-round-duplicate'`
 * — the one skip reason a coach must act on to recover missing points — was
 * invisible outside the console entirely.
 *
 * Severity is a judgment call, not a parser fact, so it is kept here, next
 * to the UI that reads it, rather than on `SwimCloudMeetImportSkipReason`/
 * `SwimCloudParseWarningCode` themselves — those types describe what
 * happened, not how alarming it is. Uncertain cases default to `'review'`:
 * this repo would rather a coach see one extra line than have a real defect
 * folded into "expected" on a guess.
 */
import type { SwimCloudParseWarning, SwimCloudParseWarningCode } from '@omniswim/swimcloud/parser';
import type { SwimCloudMeetImportSkip, SwimCloudMeetImportSkipReason } from './swimCloudMeetImportBridge';

export type DiagnosticSeverity = 'review' | 'structural';

/**
 * `'relay-leadoff'` is not a defect at all — every leadoff is correctly
 * excluded, always, by design. `'ambiguous-round-duplicate'` is the one
 * reason a coach can act on (capture the event's own results page to
 * resolve it) and must never be folded into "expected." Every other skip
 * reason reflects missing or unreadable source data and defaults to review.
 */
const STRUCTURAL_SKIP_REASONS: ReadonlySet<SwimCloudMeetImportSkipReason> = new Set(['relay-leadoff']);

export function classifySkipSeverity(reason: SwimCloudMeetImportSkipReason): DiagnosticSeverity {
  return STRUCTURAL_SKIP_REASONS.has(reason) ? 'structural' : 'review';
}

/**
 * Warning codes whose own doc comments in `@omniswim/swimcloud/parser`
 * describe them as an expected structural absence rather than a sign
 * something is missing or wrong — a cosmetic class-year/stroke/season label
 * outside the known vocabulary, or a case the parser already handles safely by
 * design (a diving score kept out of `meetScore` rather than guessed, an
 * unreadable embedded JSON block falling back to another source). Every other
 * code means a row, an event, or a fact about one was not read and defaults to
 * review — including `'unrecognized-points-token'`, which this repo's own
 * scoring-correctness doc named as "usually benign, on an already-DQ'd row"
 * but that condition cannot be told apart from a real loss by the warning
 * code alone, so it is not assumed here.
 *
 * ## `'relay-legs-absent'` was removed from this set on 2026-09-22
 *
 * It was listed here on the stated premise that "SwimCloud does not publish
 * relay legs at all", so every relay row's warning was folded away as
 * expected. That premise was wrong. A per-event results page serves every
 * leg — name, swimmer id, split and swim id — in a table behind its own "Show
 * names" toggle, which is CSS rather than a request. A relay row with no legs
 * is therefore a real gap in what was captured, and a coach can act on it by
 * capturing that event's page. It defaults to review, like any other missing
 * fact.
 */
const STRUCTURAL_WARNING_CODES: ReadonlySet<SwimCloudParseWarningCode> = new Set([
  'unmapped-class-year',
  'unmapped-stroke',
  'unrecognized-season-label',
  'diving-score-not-a-time',
  'diving-score-column-unverified',
  'unreadable-embedded-json',
]);

export function classifyWarningSeverity(code: SwimCloudParseWarningCode): DiagnosticSeverity {
  return STRUCTURAL_WARNING_CODES.has(code) ? 'structural' : 'review';
}

export interface SkipReasonGroup {
  readonly reason: SwimCloudMeetImportSkipReason;
  readonly severity: DiagnosticSeverity;
  readonly count: number;
  readonly items: readonly SwimCloudMeetImportSkip[];
}

/** Groups skips by reason, review-severity groups first, each internally in original order. */
export function groupSkipsByReason(skipped: readonly SwimCloudMeetImportSkip[]): SkipReasonGroup[] {
  const order: SwimCloudMeetImportSkipReason[] = [];
  const byReason = new Map<SwimCloudMeetImportSkipReason, SwimCloudMeetImportSkip[]>();
  for (const skip of skipped) {
    if (!byReason.has(skip.reason)) {
      byReason.set(skip.reason, []);
      order.push(skip.reason);
    }
    byReason.get(skip.reason)!.push(skip);
  }
  const groups = order.map(reason => ({
    reason,
    severity: classifySkipSeverity(reason),
    count: byReason.get(reason)!.length,
    items: byReason.get(reason)!,
  }));
  return [...groups].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'review' ? -1 : 1));
}

export interface WarningCodeGroup {
  readonly code: SwimCloudParseWarningCode;
  readonly severity: DiagnosticSeverity;
  readonly count: number;
  readonly examples: readonly string[];
}

/** Groups warnings by code, review-severity groups first. `examples` keeps up to 3 messages per code, not all of them — a multi-event meet repeats the same message once per event. */
export function groupWarningsByCode(warnings: readonly SwimCloudParseWarning[]): WarningCodeGroup[] {
  const order: SwimCloudParseWarningCode[] = [];
  const byCode = new Map<SwimCloudParseWarningCode, SwimCloudParseWarning[]>();
  for (const w of warnings) {
    if (!byCode.has(w.code)) {
      byCode.set(w.code, []);
      order.push(w.code);
    }
    byCode.get(w.code)!.push(w);
  }
  const groups = order.map(code => {
    const rows = byCode.get(code)!;
    return {
      code,
      severity: classifyWarningSeverity(code),
      count: rows.length,
      examples: [...new Set(rows.map(r => r.message))].slice(0, 3),
    };
  });
  return [...groups].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'review' ? -1 : 1));
}

/** Human-readable label for a skip reason, matching this file's own doc comments. */
export function skipReasonLabel(reason: SwimCloudMeetImportSkipReason): string {
  switch (reason) {
    case 'unknown-gender':
      return 'Gender could not be determined';
    case 'no-team-name':
      return 'No team name on the row';
    case 'no-athlete-name':
      return 'No athlete name on the row';
    case 'relay-leadoff':
      return 'Relay leadoff split (correctly excluded)';
    case 'ambiguous-round-duplicate':
      return 'Prelims/finals could not be told apart';
    case 'missing-round-caption':
      return 'Event page round table had no round name';
  }
}
