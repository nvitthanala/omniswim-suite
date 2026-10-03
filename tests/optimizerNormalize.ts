/**
 * Normalises an optimizer run so two runs on one fixture can be compared.
 * The optimizer mints a random UUID for every plan it adds, so ids are the only
 * thing that legitimately differs between two identical runs. Each plan id maps
 * to `plan#<position>`; an id that names no plan in the list stays literal.
 */
import type { PlannedSwimEntry, ScorerRosterOverride } from '../packages/core/src/types';

export type NormalizedOptimizerState = {
  overrides: ScorerRosterOverride[];
  plans: Array<Omit<PlannedSwimEntry, 'id'> & { id: string }>;
  activeEntryIds: string[];
};

export function normalizeOptimizerState(state: {
  scorerRosterOverrides?: ScorerRosterOverride[];
  meetEntryPlans?: PlannedSwimEntry[];
  activeEntryIds?: string[];
}): NormalizedOptimizerState {
  const plans = state.meetEntryPlans ?? [];
  const alias = new Map(plans.map((p, i) => [p.id, `plan#${i}`]));
  return {
    overrides: state.scorerRosterOverrides ?? [],
    plans: plans.map(p => ({ ...p, id: alias.get(p.id)! })),
    activeEntryIds: (state.activeEntryIds ?? []).map(id => alias.get(id) ?? id),
  };
}
