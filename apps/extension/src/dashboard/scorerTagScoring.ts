import { requireComplete, scoreMeet } from '@omniswim/engine';
import type { ScorerTag } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';

export interface ScorerTagScoringState {
  readonly scored: boolean;
  readonly scoringTeamSize?: number;
  readonly warnings: readonly string[];
}

/** Runs the normal engine scoring path with saved coach tags and formats its roster warnings. */
export function scoreScorerTags(snapshot: SimSnapshot, meetKey: string, hasOwnTeam: boolean, tags: readonly ScorerTag[]): ScorerTagScoringState {
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (adapted.kind !== 'ready') return { scored: false, warnings: [] };
  const rules = adapted.adapted.preset;
  const sizeSetting = rules.preset.scorers.scoringTeamSize;
  const scoringTeamSize = sizeSetting.state === 'set' && typeof sizeSetting.value === 'number' ? sizeSetting.value : undefined;
  if (!hasOwnTeam || !rules.complete) return { scored: false, ...(scoringTeamSize === undefined ? {} : { scoringTeamSize }), warnings: [] };
  try {
    const results = scoreMeet(adapted.adapted.model, adapted.adapted.lineup, tags, requireComplete(rules.preset), { includeConvertedSwims: false, lcmToScy: null });
    const warnings: string[] = [];
    for (const violation of results.violations) {
      if (violation.kind === 'scoring_team_size') warnings.push(`${violation.teamId} ${violation.gender}: ${violation.spots.numerator}/${violation.spots.denominator} scorer spots exceeds ${violation.limit}`);
      if (violation.kind === 'scorer_without_entry') warnings.push(`${violation.swimmerId} is tagged scorer but has no entry`);
      if (violation.kind === 'relay_leg' && violation.reason === 'off_scoring_roster') warnings.push(`Relay ${violation.entryKey}, leg ${violation.leg} is outside the scoring roster`);
    }
    return { scored: true, ...(scoringTeamSize === undefined ? {} : { scoringTeamSize }), warnings };
  } catch (cause) {
    return { scored: false, ...(scoringTeamSize === undefined ? {} : { scoringTeamSize }), warnings: [cause instanceof Error ? cause.message : String(cause)] };
  }
}
