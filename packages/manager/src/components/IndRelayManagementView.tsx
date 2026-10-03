/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Gender, RelayLegOverride, SwimmerResult, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import {
  listEligibleRelayLegCandidates,
  removeRelayLegOverride,
  suggestBestRelayLegFill,
  upsertRelayLegOverride,
} from '@omniswim/core/lib/relayLegMatching';
import { relayLegHistoryCandidates } from '@omniswim/core/lib/relayLegHistoryCandidates';
import {
  canonicalSwimmerName,
  convertToSCY,
  isRelayResult,
  normalizeSwimmerName,
  swimEventNotSwumInCourse,
} from '@omniswim/core/lib/utils';
import { passesRosterGates } from '@omniswim/core/lib/whatIfProjection';
import {
  buildRelaysFromIndividualLineup,
  compareRelayLegSplits,
} from '@omniswim/core/lib/relayBuilder';
import { Button, TeamSelect, useToast } from '@omniswim/ui';
import { buildRelayGroups, type RelayGroup } from './indRelayGroupsView';
import RelayStatsCards from './RelayStatsCards';
import RelaySplitInspector from './RelaySplitInspector';
import RelayGroupCard from './RelayGroupCard';
import RelayEligibleSwimmersPanel from './RelayEligibleSwimmersPanel';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  whatIfMode: boolean;
  removeSeniors: boolean;
  onUpdate: (patch: Partial<Workspace>) => void;
  selectedTeam?: string;
  onSelectTeam?: (team: string) => void;
  hideTeamPicker?: boolean;
};

export type DragPayload = {
  name: string;
  recruitId?: string;
  classYear?: string;
};

export default function IndRelayManagementView({
  workspace,
  gender,
  scoringBundle,
  whatIfMode,
  removeSeniors,
  onUpdate,
  selectedTeam: controlledTeam,
  onSelectTeam,
  hideTeamPicker = false,
}: Props) {
  const toast = useToast();
  const teams = useMemo(
    () => [...scoringBundle.sortedTeams.map(t => t.teamName)].sort((a, b) => a.localeCompare(b)),
    [scoringBundle.sortedTeams]
  );
  const [pickedTeam, setPickedTeam] = useState<string>('');
  const selectedTeam =
    controlledTeam !== undefined
      ? controlledTeam && teams.includes(controlledTeam)
        ? controlledTeam
        : controlledTeam || ''
      : pickedTeam && teams.includes(pickedTeam)
        ? pickedTeam
        : teams[0] ?? '';
  const setSelectedTeam = (team: string) => {
    setPickedTeam(team);
    onSelectTeam?.(team);
  };
  const [selectedRelayKey, setSelectedRelayKey] = useState<string | null>(null);
  const [manualTimes, setManualTimes] = useState<Record<string, string>>({});
  const [dragOverLeg, setDragOverLeg] = useState<string | null>(null);

  // Memoised because `?? []` builds a NEW empty array on every render when the
  // gender's results are absent, which made every downstream useMemo that
  // depends on `originalResults` re-run every time -- the memoisation was
  // silently inert. Found by react-hooks/exhaustive-deps.
  const originalResults = useMemo(
    () => (gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? []),
    [gender, workspace.menResults, workspace.womenResults]
  );
  const overrides = workspace.relayLegOverrides ?? [];

  const activeSwimmers = useMemo(() => {
    // Same identity key and the same shared senior test the scoring
    // projection uses (buildWhatIfResults / passesRosterGates), so a
    // tombstone or a "drop seniors" removal reaches this panel the same
    // way it reaches the actual scored total. canonicalSwimmerName also
    // folds "Last, First" to "first last", which plain normalizeSwimmerName
    // does not — a tombstone recorded in either order still matches.
    const excluded = new Set(
      (workspace.deletedSwimmers ?? [])
        .filter(d => d.gender === gender)
        .map(d => canonicalSwimmerName(d.name))
    );
    const passesGates = (name: string, classYear: string | undefined): boolean =>
      passesRosterGates(name, classYear, excluded, removeSeniors);

    const recruitResults: SwimmerResult[] = (workspace.recruits ?? [])
      .filter(r => r.gender === gender && passesGates(r.name, r.classYear))
      // An event the recorded course does not swim (e.g. a 1000 Freestyle
      // recorded SCM) has no SCY equivalent, and convertToSCY throws on it.
      // Such a row never enters a relay pool; the lineup checklist names it.
      .filter(r => swimEventNotSwumInCourse(r) === null)
      .map(r => ({
        id: r.id,
        rank: 0,
        name: r.name,
        classYear: r.classYear,
        team: r.team,
        time: convertToSCY(r.time, r.event, r.gender, r.timeType, { team: r.team }),
        points: 0,
        event: r.event,
        isRecruit: true,
        gender: r.gender,
      }));
    const roster = originalResults.filter(
      r => !r.isRelay && passesGates(r.name, r.classYear)
    );
    return [...roster, ...recruitResults];
  }, [gender, originalResults, removeSeniors, workspace.deletedSwimmers, workspace.recruits]);

  // Athlete-history swims that may fill a relay leg the pool holds no meet or
  // recruit swim for (relayLegHistoryCandidates, plans/2026-09-24 R1 e). Kept
  // out of `activeSwimmers` itself: a history row must never become an
  // individual entry, only a relay-leg candidate, matching how core's
  // `simulateRoster` takes it as a separate `relayLegOnlyPool`.
  const legHistoryPool = useMemo(
    () => relayLegHistoryCandidates(workspace, activeSwimmers, gender),
    [workspace, activeSwimmers, gender]
  );
  const relayLegCandidatePool = useMemo(
    () => (legHistoryPool.length > 0 ? [...activeSwimmers, ...legHistoryPool] : activeSwimmers),
    [activeSwimmers, legHistoryPool]
  );

  const stats = useMemo(() => {
    const team = selectedTeam || teams[0];
    if (!team) {
      return { individual: 0, relayLegs: 0, relayEvents: 0, athletes: 0, vacantLegs: 0 };
    }

    const rows = scoringBundle.allResults.filter(
      r => r.gender === gender && String(r.team ?? '').trim() === team
    );

    let individual = 0;
    let relayLegs = 0;
    let vacantLegs = 0;
    const relayEvents = new Set<string>();

    for (const r of rows) {
      if (isRelayResult(r)) {
        if (r.name !== r.team) {
          relayLegs += 1;
          if (r.relayLegVacant || r.relayMissingLeg?.reason === 'vacant') vacantLegs += 1;
          if (r.event) relayEvents.add(r.event);
        }
        continue;
      }
      individual += 1;
    }

    const athleteNames = new Set(
      rows.filter(r => !isRelayResult(r) || r.name !== r.team).map(r => r.name)
    );

    return {
      individual,
      relayLegs,
      relayEvents: relayEvents.size,
      athletes: athleteNames.size,
      vacantLegs,
    };
  }, [gender, scoringBundle.allResults, selectedTeam, teams]);

  const relayGroups = useMemo((): RelayGroup[] => {
    const team = selectedTeam || teams[0];
    if (!team) return [];
    return buildRelayGroups({ allScored: scoringBundle.allScored, originalResults, gender, team });
  }, [gender, originalResults, scoringBundle.allScored, selectedTeam, teams]);

  const selectedGroup =
    relayGroups.find(g => g.key === selectedRelayKey) ?? relayGroups.find(g => g.legs.some(l => l.relayLegVacant)) ?? relayGroups[0];

  const assignedInSelectedRelay = useMemo(() => {
    const s = new Set<string>();
    if (!selectedGroup) return s;
    for (const leg of selectedGroup.legs) {
      const nm = leg.name?.trim();
      if (nm && nm !== '—' && nm !== 'Unknown' && !leg.relayLegVacant) {
        s.add(normalizeSwimmerName(nm));
      }
    }
    return s;
  }, [selectedGroup]);

  const poolCandidates = useMemo(() => {
    if (!selectedGroup || !selectedTeam) return [];
    const vacantLegs = selectedGroup.legs.filter(l => l.relayLegVacant || l.relayMissingLeg);
    if (vacantLegs.length === 0) return [];

    const seen = new Set<string>();
    const out: SwimmerResult[] = [];
    for (const leg of vacantLegs) {
      const idx = leg.relayLegIndex ?? 0;
      for (const swimmer of listEligibleRelayLegCandidates(
        relayLegCandidatePool,
        selectedGroup.event,
        idx,
        assignedInSelectedRelay,
        selectedTeam,
        gender
      )) {
        const k = normalizeSwimmerName(swimmer.name);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(swimmer);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [relayLegCandidatePool, assignedInSelectedRelay, selectedGroup, selectedTeam, gender]);

  const patchOverrides = (next: RelayLegOverride[]) => {
    onUpdate({ relayLegOverrides: next });
  };

  const assignDragPayload = (group: RelayGroup, legIndex: number, payload: DragPayload) => {
    if (!whatIfMode) return;
    patchOverrides(
      upsertRelayLegOverride(overrides, {
        relayEntryKey: group.key,
        legIndex,
        assigneeName: payload.name,
        recruitId: payload.recruitId,
        classYear: payload.classYear,
        source: 'drag',
      })
    );
  };

  const autofillLeg = (group: RelayGroup, legIndex: number) => {
    if (!whatIfMode) return;
    const exclude = new Set<string>();
    const origNames = group.template.relayNames ?? group.legs.map(l => ({ name: l.name, year: '' }));
    origNames.forEach((ln, _i) => {
      if (ln.name) exclude.add(normalizeSwimmerName(ln.name));
    });
    group.legs.forEach((ln, i) => {
      if (i === legIndex) return;
      const nm = ln.name?.trim();
      if (nm && nm !== '—' && nm !== 'Unknown' && !ln.relayLegVacant) {
        exclude.add(normalizeSwimmerName(nm));
      }
    });
    const fill = suggestBestRelayLegFill(
      relayLegCandidatePool,
      group.template,
      legIndex,
      assignedInSelectedRelay,
      exclude
    );
    if (!fill) return;
    patchOverrides(upsertRelayLegOverride(overrides, fill.override));
  };

  const autofillAllVacant = (group: RelayGroup) => {
    if (!whatIfMode) return;
    let next = [...overrides];
    const assigned = new Set(assignedInSelectedRelay);
    for (const leg of group.legs) {
      if (!leg.relayLegVacant && !leg.relayMissingLeg?.reason) continue;
      const legIndex = leg.relayLegIndex ?? 0;
      const exclude = new Set<string>();
      group.legs.forEach((ln, i) => {
        if (i === legIndex) return;
        const nm = ln.name?.trim();
        if (nm && nm !== '—' && nm !== 'Unknown' && !ln.relayLegVacant) {
          exclude.add(normalizeSwimmerName(nm));
        }
      });
      const fill = suggestBestRelayLegFill(
        relayLegCandidatePool,
        group.template,
        legIndex,
        assigned,
        exclude
      );
      if (!fill) continue;
      next = upsertRelayLegOverride(next, fill.override);
      assigned.add(normalizeSwimmerName(fill.swimmer.name));
    }
    patchOverrides(next);
  };

  const saveManualLeg = (group: RelayGroup, legIndex: number) => {
    if (!whatIfMode) return;
    const fieldKey = `${group.key}|${legIndex}`;
    const manualLegTime = manualTimes[fieldKey]?.trim();
    if (!manualLegTime) return;
    patchOverrides(
      upsertRelayLegOverride(overrides, {
        relayEntryKey: group.key,
        legIndex,
        manualLegTime,
        source: 'manual',
      })
    );
  };

  const clearLegOverride = (group: RelayGroup, legIndex: number) => {
    if (!whatIfMode) return;
    patchOverrides(removeRelayLegOverride(overrides, group.key, legIndex));
  };

  const buildFromLineup = () => {
    if (!whatIfMode || !selectedTeam) return;
    const next = buildRelaysFromIndividualLineup(
      workspace,
      gender,
      selectedTeam,
      activeSwimmers,
      scoringBundle.allResults.filter(r => isRelayResult(r))
    );
    patchOverrides(next ?? []);
    toast.push('success', `Relay legs proposed from individual lineup for ${selectedTeam}`);
  };

  const selectedSplitCompare = useMemo(() => {
    if (!selectedGroup || !selectedTeam) return [];
    return compareRelayLegSplits(
      workspace,
      gender,
      selectedGroup.legs,
      selectedGroup.event,
      selectedTeam
    );
  }, [selectedGroup, selectedTeam, workspace, gender]);

  const recruitCount = (workspace.recruits ?? []).filter(
    r => r.gender === gender && (!selectedTeam || r.team === selectedTeam)
  ).length;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0 lg:flex-row">
      <div className="flex flex-col gap-4 flex-1 min-h-0 min-w-0">
        <div className="surface-card rounded-xl p-4 sm:p-5 shrink-0">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
            {!hideTeamPicker && teams.length > 0 ? (
              <label className="flex flex-col gap-1">
                <span className="text-ui-caption text-theme-muted">Team</span>
                <TeamSelect
                  teams={teams}
                  value={selectedTeam}
                  onChange={e => setSelectedTeam(e.target.value)}
                  className="glass-input rounded-lg px-3 py-2 text-ui-body min-w-[12rem]"
                />
              </label>
            ) : null}
          </div>

          <RelayStatsCards stats={stats} />

          {recruitCount > 0 ? (
            <p className="text-ui-caption text-theme-secondary">
              <span className="text-[var(--text-accent)]">{recruitCount}</span> recruit swim
              {recruitCount === 1 ? '' : 's'} added for this team in the current projection.
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!whatIfMode || !selectedTeam}
              onClick={buildFromLineup}
              className="uppercase tracking-widest"
              title="Fill vacant relay legs using active meet entry plans, then roster bests"
            >
              Build relays from individual lineup
            </Button>
          </div>
        </div>

        <div className="surface-card rounded-xl p-4 sm:p-5 flex-1 min-h-0 flex flex-col">
          <h4 className="text-ui-caption font-bold uppercase tracking-widest text-[var(--text-primary)] mb-3">
            Relay split inspector
          </h4>
          {selectedGroup ? (
            <RelaySplitInspector rows={selectedSplitCompare} eventLabel={selectedGroup.event} />
          ) : null}
          {relayGroups.length === 0 ? (
            <p className="text-ui-caption text-theme-muted italic">No relay entries for this team.</p>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-4">
              {relayGroups.map(group => (
                <RelayGroupCard
                  key={group.key}
                  group={group}
                  isSelected={selectedGroup?.key === group.key}
                  whatIfMode={whatIfMode}
                  dragOverLeg={dragOverLeg}
                  manualTimes={manualTimes}
                  overrides={overrides}
                  onSelect={() => setSelectedRelayKey(group.key)}
                  onAutofillAllVacant={() => autofillAllVacant(group)}
                  onAutofillLeg={legIndex => autofillLeg(group, legIndex)}
                  onAssignDragPayload={(legIndex, payload) => assignDragPayload(group, legIndex, payload)}
                  onSetDragOverLeg={setDragOverLeg}
                  onManualTimeChange={(fieldKey, value) =>
                    setManualTimes(prev => ({ ...prev, [fieldKey]: value }))
                  }
                  onSaveManualLeg={legIndex => saveManualLeg(group, legIndex)}
                  onClearLegOverride={legIndex => clearLegOverride(group, legIndex)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {whatIfMode && selectedGroup ? (
        <RelayEligibleSwimmersPanel eventLabel={selectedGroup.event} poolCandidates={poolCandidates} />
      ) : null}
    </div>
  );
}
