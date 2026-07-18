/**
 * Soft-remove a swimmer from the projected roster without blanking PDF/source rows.
 * Clears recruits, plans, overrides for the athlete; appends deletedSwimmers.
 */
import {
  Gender,
  PlannedSwimEntry,
  Recruit,
  RelayLegOverride,
  ScorerRosterOverride,
  Workspace,
} from '../types';
import { normalizeSwimmerName } from './utils';
import { scorerRosterKey } from './scorerRoster';
import { pruneRelayOverridesForSwimmer } from './rosterLineupAudit';

export type SoftRemoveSwimmerOpts = {
  name: string;
  gender: Gender;
  team?: string;
};

export function softRemoveSwimmerFromWorkspace(
  workspace: Workspace,
  opts: SoftRemoveSwimmerOpts
): Partial<Workspace> {
  const key = normalizeSwimmerName(opts.name);
  const gender = opts.gender;

  const nextDeleted = [...(workspace.deletedSwimmers ?? [])];
  if (!nextDeleted.some(d => d.gender === gender && normalizeSwimmerName(d.name) === key)) {
    nextDeleted.push({ name: opts.name, gender });
  }

  const recruits: Recruit[] = (workspace.recruits ?? []).filter(
    r => !(r.gender === gender && normalizeSwimmerName(r.name) === key)
  );

  const meetEntryPlans: PlannedSwimEntry[] = (workspace.meetEntryPlans ?? []).filter(
    p => !(p.gender === gender && normalizeSwimmerName(p.name) === key)
  );
  const removedPlanIds = new Set(
    (workspace.meetEntryPlans ?? [])
      .filter(p => p.gender === gender && normalizeSwimmerName(p.name) === key)
      .map(p => p.id)
  );
  const activeEntryIds = (workspace.activeEntryIds ?? []).filter(id => !removedPlanIds.has(id));

  const scorerRosterOverrides: ScorerRosterOverride[] = (
    workspace.scorerRosterOverrides ?? []
  ).filter(o => {
    if (o.gender !== gender) return true;
    if (normalizeSwimmerName(o.name) !== key) return true;
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

export function restoreSwimmerToWorkspace(
  workspace: Workspace,
  opts: SoftRemoveSwimmerOpts
): Partial<Workspace> {
  const key = normalizeSwimmerName(opts.name);
  return {
    deletedSwimmers: (workspace.deletedSwimmers ?? []).filter(
      d => !(d.gender === opts.gender && normalizeSwimmerName(d.name) === key)
    ),
  };
}

export function isSwimmerSoftRemoved(
  workspace: Workspace,
  name: string,
  gender: Gender
): boolean {
  const key = normalizeSwimmerName(name);
  return (workspace.deletedSwimmers ?? []).some(
    d => d.gender === gender && normalizeSwimmerName(d.name) === key
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
