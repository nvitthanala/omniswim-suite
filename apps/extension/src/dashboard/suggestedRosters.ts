import { requireComplete, RosterSuggestError, suggestScoringRosters } from '@omniswim/engine';
import type { Gender, LpSolve, RosterSuggestion, RulePreset, ScorerTag } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';

export type DisplaySuggestion =
  | { readonly kind: 'suggested'; readonly swimmerIds: readonly string[]; readonly points: number; readonly spots: { readonly numerator: number; readonly denominator: number }; readonly method: 'all_entered' | 'ilp' }
  | { readonly kind: 'absent'; readonly reason: 'pins_over_size' | 'solver_not_optimal' }
  | { readonly kind: 'error'; readonly code: string; readonly subject: string | null };
export interface SuggestedRosterState { readonly teamId: string; readonly gender: string; readonly result: DisplaySuggestion }

/** Compute ephemeral opponent tags; they are returned for scoring/rendering and never persisted. */
export async function suggestOpponentRosters(snapshot: SimSnapshot, meetKey: string, ownTeamId: string | undefined,
  coachTags: readonly ScorerTag[], preset: RulePreset | undefined, solve: LpSolve): Promise<readonly SuggestedRosterState[]> {
  if (!ownTeamId || !preset) return [];
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (adapted.kind !== 'ready') return [];
  const teamIds = new Set(adapted.adapted.model.teams.map(t => String(t.teamId)));
  if (!teamIds.has(ownTeamId)) return [];
  const sideKeys = new Map<string, { teamId: string; gender: Gender }>();
  for (const entry of adapted.adapted.lineup.entries) {
    if (String(entry.teamId) === ownTeamId) continue;
    const key = `${entry.teamId}\u0000${entry.gender}`;
    sideKeys.set(key, { teamId: String(entry.teamId), gender: entry.gender });
  }
  const targets = [...sideKeys.values()].sort((a,b) => a.teamId.localeCompare(b.teamId) || a.gender.localeCompare(b.gender));
  if (!targets.length) return [];
  try {
    const rules = requireComplete(preset);
    const results = await suggestScoringRosters({ model: adapted.adapted.model, lineup: adapted.adapted.lineup,
      rules, sourcing: { includeConvertedSwims: false, lcmToScy: null },
      coachTags, ownTeamId, targets }, solve);
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
