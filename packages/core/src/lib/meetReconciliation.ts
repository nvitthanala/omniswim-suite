/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One consolidated computed-vs-official reconciliation summary for a whole
 * meet, sibling to `teamScoreMatching.ts`.
 *
 * `ProjectedActualScore.tsx` already computes and color-codes a
 * computed-vs-official delta per team card. This module does not re-derive
 * that math — it reuses `matchOfficialTeamScore`/`matchOfficialTeamKey`
 * (already ambiguity-safe, see `test_team_matching_ambiguity.mjs`) to answer
 * the one question no single team card can: across the WHOLE meet, which
 * teams disagree with the official totals, and which side has a team the
 * other doesn't. See `docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md`
 * item 12 / `plans/2026-09-14/02-MEET-IMPORT-RECONCILIATION.md`.
 */

import { Gender, OfficialTeamScores } from '../types';
import { matchOfficialTeamKey, officialScoresForGender } from './teamScoreMatching';

/**
 * `matched` — computed and official totals agree within tolerance.
 * `mismatched` — both sides named this team, but the totals disagree — the
 *   ROCK/LU-mapping-bug shape this feature exists to surface.
 * `officialOnly` — the official PDF names a team no computed team matched —
 *   most often a team-name mapping miss, a different failure than a real
 *   scoring disagreement.
 * `computedOnly` — a computed team has no official total to compare against
 *   (common and expected when a meet has no official PDF at all, or the PDF
 *   only publishes a subset of teams/genders).
 */
export type MeetReconciliationStatus = 'matched' | 'mismatched' | 'officialOnly' | 'computedOnly';

export type MeetReconciliationEntry = {
  team: string;
  status: MeetReconciliationStatus;
  computed?: number;
  official?: number;
  /** `computed - official`. Present only when both sides have a score. */
  delta?: number;
};

export type MeetReconciliationSummary = {
  /** One entry per team on either side, `matched` teams included. */
  entries: MeetReconciliationEntry[];
  matchedCount: number;
  /** `entries.length` — every team considered on either side. */
  totalCount: number;
  /** False when the workspace carries no official scores for this gender at all — the summary has nothing to say. */
  hasOfficialScores: boolean;
};

/**
 * Same threshold `ProjectedActualScore.tsx`'s `isMeaningfulDelta` uses for a
 * single team's own badge. Reused as-is for the whole-meet summary rather
 * than inventing a second cutoff — revisit if a whole-meet view proves this
 * too tight/loose in practice (open question in the 2026-09-14 plan doc).
 */
export const MEANINGFUL_RECONCILIATION_DELTA = 0.05;

/**
 * Build the whole-meet reconciliation summary for one gender.
 *
 * @param computedTotals Team name -> this meet's computed total for the
 *   gender, e.g. `scoringBundle.sortedTeams.map(t => [t.teamName, t.totalPoints])`.
 * @param official The workspace's `officialTeamScores`, unfiltered by gender.
 * @param gender Which side of `official` to compare against.
 */
export function buildMeetReconciliationSummary(
  computedTotals: ReadonlyMap<string, number>,
  official: OfficialTeamScores | undefined,
  gender: Gender
): MeetReconciliationSummary {
  const officialForGender = officialScoresForGender(official, gender);
  const hasOfficialScores = Object.keys(officialForGender ?? {}).length > 0;
  if (!hasOfficialScores) {
    return { entries: [], matchedCount: 0, totalCount: 0, hasOfficialScores: false };
  }

  const entries: MeetReconciliationEntry[] = [];
  const consumedOfficialKeys = new Set<string>();

  for (const [team, computed] of computedTotals) {
    const officialKey = matchOfficialTeamKey(team, officialForGender);
    if (officialKey == null) {
      entries.push({ team, status: 'computedOnly', computed });
      continue;
    }
    consumedOfficialKeys.add(officialKey);
    const officialScore = officialForGender![officialKey];
    const delta = computed - officialScore;
    entries.push({
      team,
      status: Math.abs(delta) > MEANINGFUL_RECONCILIATION_DELTA ? 'mismatched' : 'matched',
      computed,
      official: officialScore,
      delta,
    });
  }

  for (const officialKey of Object.keys(officialForGender!)) {
    if (consumedOfficialKeys.has(officialKey)) continue;
    entries.push({ team: officialKey, status: 'officialOnly', official: officialForGender![officialKey] });
  }

  return {
    entries,
    matchedCount: entries.filter(e => e.status === 'matched').length,
    totalCount: entries.length,
    hasOfficialScores: true,
  };
}
