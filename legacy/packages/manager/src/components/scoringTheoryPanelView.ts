/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Pure predicates and formatters for ScoringTheoryPanel — named so the
 * component's guard clauses and JSX gates read as calls, not inline
 * `&&`/`||`/ternary chains.
 */

import type { ScoringTheoryApplyResult } from '@omniswim/core/lib/scoringTheory';

/** Parsing needs both a pasted theory and a selected team. */
export function canParseTheory(text: string, team: string): boolean {
  return text.trim().length > 0 && team.trim().length > 0;
}

/** The team-required warning only makes sense once the coach has typed
 * something — an empty textarea with no team selected isn't a warning yet. */
export function shouldShowTeamRequiredWarning(text: string, team: string): boolean {
  return text.trim().length > 0 && team.trim().length === 0;
}

export function buildTheoryAppliedMessage(summary: ScoringTheoryApplyResult['summary']): string {
  const entryWord = summary.entriesAdded === 1 ? 'entry' : 'entries';
  return `Theory applied: ${summary.scorersMarked} scorer(s), ${summary.entriesAdded} ${entryWord}, ${summary.relayLegsAssigned} relay leg(s)`;
}
