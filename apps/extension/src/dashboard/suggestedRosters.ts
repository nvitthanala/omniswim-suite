import { requireComplete, RosterSuggestError, suggestScoringRosters } from '@omniswim/engine';
import type { Gender, LpSolve, RosterSuggestion, RulePreset, ScorerTag } from '@omniswim/engine';
import { partitionTags } from './liveModel';
import type { LiveModel } from './liveModel';

export type DisplaySuggestion =
  | { readonly kind: 'suggested'; readonly swimmerIds: readonly string[]; readonly points: number; readonly spots: { readonly numerator: number; readonly denominator: number }; readonly method: 'all_entered' | 'ilp' }
  | { readonly kind: 'absent'; readonly reason: 'pins_over_size' | 'solver_not_optimal' }
  | { readonly kind: 'error'; readonly code: string; readonly subject: string | null };
export interface SuggestedRosterState { readonly teamId: string; readonly gender: string; readonly result: DisplaySuggestion }

/**
 * Compute ephemeral opponent tags on the live model; they are returned for scoring/rendering and never persisted.
 * A coach tag on a `not_member` swimmer is set aside first: the swimmer has no entries, and the engine refuses a tag on one (D7 live-model spec section 4).
 */
export async function suggestOpponentRosters(live: LiveModel, ownTeamId: string | undefined,
  coachTags: readonly ScorerTag[], preset: RulePreset | undefined, solve: LpSolve): Promise<readonly SuggestedRosterState[]> {
  if (!ownTeamId || !preset) return [];
  const teamIds = new Set(live.model.teams.map(t => String(t.teamId)));
  if (!teamIds.has(ownTeamId)) return [];
  const sideKeys = new Map<string, { teamId: string; gender: Gender }>();
  for (const entry of live.lineup.entries) {
    if (String(entry.teamId) === ownTeamId) continue;
    const key = `${entry.teamId}\u0000${entry.gender}`;
    sideKeys.set(key, { teamId: String(entry.teamId), gender: entry.gender });
  }
  const targets = [...sideKeys.values()].sort((a,b) => a.teamId.localeCompare(b.teamId) || a.gender.localeCompare(b.gender));
  if (!targets.length) return [];
  try {
    const rules = requireComplete(preset);
    const results = await suggestScoringRosters({ model: live.model, lineup: live.lineup,
      rules, sourcing: live.sourcing,
      coachTags: partitionTags(live, coachTags).kept, ownTeamId, targets }, solve);
    return results.map((r: RosterSuggestion) => ({ teamId: String(r.teamId), gender: r.gender,
      result: r.kind === 'suggested' ? { kind: 'suggested' as const, swimmerIds: r.tags.map(t => String(t.swimmerId)),
        points: r.referencePoints, spots: r.spots, method: r.method } : { kind: 'absent' as const, reason: r.reason } }));
  } catch (cause) {
    const error = cause instanceof RosterSuggestError ? cause : null;
    return targets.map(t => ({ ...t, result: { kind: 'error' as const, code: error?.code ?? 'suggestion_failed', subject: error?.subject ?? null } }));
  }
}

export function suggestedTags(suggestions: readonly SuggestedRosterState[]): ScorerTag[] {
  return suggestions.flatMap(s => s.result.kind === 'suggested' ? s.result.swimmerIds.map(swimmerId =>
    ({ teamId: s.teamId, swimmerId, role: 'scorer' as const, source: 'suggested' as const })) : []);
}
