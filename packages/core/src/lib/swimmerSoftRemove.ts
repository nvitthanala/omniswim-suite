/**
 * Soft-remove a swimmer from the projected roster without blanking PDF/source rows.
 * Clears recruits, plans, overrides for the athlete; appends deletedSwimmers.
 */
import {
  DeletedSwimmerRef,
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  Recruit,
  RelayLegOverride,
  ScorerRosterOverride,
  SwimmerResult,
  Workspace,
} from '../types';
import { canonicalSwimmerName, isRelayResult } from './utils';
import { scorerRosterKey } from './scorerRoster';
import { getSourceResults } from './meetSource';
import { pruneRelayOverridesForSwimmer } from './rosterLineupAudit';
import type { WorkspaceEditorPatch } from './swimEditor';

export type SoftRemoveSwimmerOpts = {
  name: string;
  gender: Gender;
  team?: string;
};

export function softRemoveSwimmerFromWorkspace(
  workspace: Workspace,
  opts: SoftRemoveSwimmerOpts
): Partial<Workspace> {
  const key = canonicalSwimmerName(opts.name);
  const gender = opts.gender;

  const nextDeleted = [...(workspace.deletedSwimmers ?? [])];
  if (!nextDeleted.some(d => d.gender === gender && canonicalSwimmerName(d.name) === key)) {
    nextDeleted.push({ name: opts.name, gender, mode: 'hidden' });
  }

  const recruits: Recruit[] = (workspace.recruits ?? []).filter(
    r => !(r.gender === gender && canonicalSwimmerName(r.name) === key)
  );

  const meetEntryPlans: PlannedSwimEntry[] = (workspace.meetEntryPlans ?? []).filter(
    p => !(p.gender === gender && canonicalSwimmerName(p.name) === key)
  );
  const removedPlanIds = new Set(
    (workspace.meetEntryPlans ?? [])
      .filter(p => p.gender === gender && canonicalSwimmerName(p.name) === key)
      .map(p => p.id)
  );
  const activeEntryIds = (workspace.activeEntryIds ?? []).filter(id => !removedPlanIds.has(id));

  const scorerRosterOverrides: ScorerRosterOverride[] = (
    workspace.scorerRosterOverrides ?? []
  ).filter(o => {
    if (o.gender !== gender) return true;
    if (canonicalSwimmerName(o.name) !== key) return true;
    if (opts.team && o.team !== opts.team) return true;
    return false;
  });

  const relayLegOverrides: RelayLegOverride[] = pruneRelayOverridesForSwimmer(
    workspace.relayLegOverrides ?? [],
    opts.name
  );

  // Keep menResults/womenResults and source copies intact for baseline + rebuild.
  return {
    deletedSwimmers: nextDeleted,
    recruits,
    meetEntryPlans,
    activeEntryIds,
    scorerRosterOverrides,
    relayLegOverrides,
  };
}

/**
 * Permanently remove an athlete from the workspace. In addition to everything
 * soft-remove does (hide from projection, clear recruits/plans/overrides), this
 * strips the athlete's INDIVIDUAL working rows from menResults/womenResults so
 * they also leave the baseline roster, and drops their athleteHistory rows. Relay
 * legs are left in place — the deletedSwimmers entry vacates them via the existing
 * what-if / vacate machinery. The frozen sourceMen/WomenResults are NEVER touched
 * (matches removeCreditedSwim semantics), so a restore can rebuild from source.
 * Returns an undo-able { patch, inverse, description }.
 */
export function removeAthleteFromWorkspace(
  workspace: Workspace,
  opts: SoftRemoveSwimmerOpts
): WorkspaceEditorPatch {
  const key = canonicalSwimmerName(opts.name);
  const gender = opts.gender;
  const soft = softRemoveSwimmerFromWorkspace(workspace, opts);

  const field: 'menResults' | 'womenResults' =
    gender === Gender.MEN ? 'menResults' : 'womenResults';
  const baseResults = workspace[field] ?? [];
  // Keep relay rows; drop only this athlete's individual (non-relay) working rows.
  const nextResults = baseResults.filter(
    r => isRelayResult(r) || canonicalSwimmerName(r.name) !== key
  );

  const baseHistory = workspace.athleteHistory ?? [];
  const nextHistory = baseHistory.filter(
    h => !(h.gender === gender && canonicalSwimmerName(h.name) === key)
  );

  const deletedSwimmers: DeletedSwimmerRef[] = (soft.deletedSwimmers ?? []).map(d =>
    d.gender === gender && canonicalSwimmerName(d.name) === key
      ? { ...d, mode: 'removed' as const }
      : d
  );

  const patch: Partial<Workspace> = {
    ...soft,
    deletedSwimmers,
    [field]: nextResults,
    athleteHistory: nextHistory,
  };

  const inverse: Partial<Workspace> = {
    deletedSwimmers: workspace.deletedSwimmers ?? [],
    recruits: workspace.recruits ?? [],
    meetEntryPlans: workspace.meetEntryPlans ?? [],
    activeEntryIds: workspace.activeEntryIds ?? [],
    scorerRosterOverrides: workspace.scorerRosterOverrides ?? [],
    relayLegOverrides: workspace.relayLegOverrides ?? [],
    [field]: baseResults,
    athleteHistory: baseHistory,
  };

  return { patch, inverse, description: `Remove ${opts.name} from workspace` };
}

export function restoreSwimmerToWorkspace(
  workspace: Workspace,
  opts: SoftRemoveSwimmerOpts
): Partial<Workspace> {
  const key = canonicalSwimmerName(opts.name);
  const gender = opts.gender;
  const entry = (workspace.deletedSwimmers ?? []).find(
    d => d.gender === gender && canonicalSwimmerName(d.name) === key
  );

  const patch: Partial<Workspace> = {
    deletedSwimmers: (workspace.deletedSwimmers ?? []).filter(
      d => !(d.gender === gender && canonicalSwimmerName(d.name) === key)
    ),
  };

  // A permanent removal stripped the athlete's individual working rows. Rebuild
  // them from the frozen source copy (which is never mutated) so Restore actually
  // brings the athlete back to the baseline roster.
  if (entry?.mode === 'removed') {
    const field: 'menResults' | 'womenResults' =
      gender === Gender.MEN ? 'menResults' : 'womenResults';
    const working = workspace[field] ?? [];
    const present = new Set(working.map(r => r.id));
    const rebuilt: SwimmerResult[] = getSourceResults(workspace, gender).filter(
      r => !isRelayResult(r) && canonicalSwimmerName(r.name) === key && !present.has(r.id)
    );
    if (rebuilt.length > 0) {
      patch[field] = [...working, ...rebuilt.map(r => ({ ...r }))];
    }
  }

  return patch;
}

export function isSwimmerSoftRemoved(
  workspace: Workspace,
  name: string,
  gender: Gender
): boolean {
  const key = canonicalSwimmerName(name);
  return (workspace.deletedSwimmers ?? []).some(
    d => d.gender === gender && canonicalSwimmerName(d.name) === key
  );
}

/** Clear scorer override for a restored athlete key (optional helper). */
export function clearScorerOverride(
  overrides: ScorerRosterOverride[],
  team: string,
  gender: Gender,
  name: string
): ScorerRosterOverride[] {
  const key = scorerRosterKey(team, gender, name);
  return overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
}
