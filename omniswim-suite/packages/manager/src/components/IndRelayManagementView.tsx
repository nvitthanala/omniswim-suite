/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Gender, RelayLegOverride, SwimmerResult, Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import {
  displayTimeForRelayLeg,
  formatLegSplitSummary,
  formatTeamSplitSummary,
} from '@omniswim/core/lib/relaySplits';
import {
  listEligibleRelayLegCandidates,
  relayLegRequirements,
  relayMissingStrokeLabel,
  relayTemplateFromLeg,
  removeRelayLegOverride,
  stableRelayEntryKey,
  suggestBestRelayLegFill,
  upsertRelayLegOverride,
} from '@omniswim/core/lib/relayLegMatching';
import { convertToSCY, isRelayResult, normalizeSwimmerName } from '@omniswim/core/lib/utils';

type Props = {
  workspace: Workspace;
  gender: Gender;
  scoringBundle: ScoringBundle;
  whatIfMode: boolean;
  removeSeniors: boolean;
  onUpdate: (patch: Partial<Workspace>) => void;
};

type RelayGroup = {
  key: string;
  template: SwimmerResult;
  event: string;
  roundSwam: string;
  rank: number;
  teamTotal: string;
  legs: SwimmerResult[];
  teamSplits?: SwimmerResult['relayTeamSplits'];
};

type DragPayload = {
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
}: Props) {
  const teams = scoringBundle.sortedTeams.map(t => t.teamName);
  const [selectedTeam, setSelectedTeam] = useState<string>(teams[0] ?? '');
  const [selectedRelayKey, setSelectedRelayKey] = useState<string | null>(null);
  const [manualTimes, setManualTimes] = useState<Record<string, string>>({});
  const [dragOverLeg, setDragOverLeg] = useState<string | null>(null);

  const originalResults =
    gender === Gender.MEN ? workspace.menResults ?? [] : workspace.womenResults ?? [];
  const overrides = workspace.relayLegOverrides ?? [];

  const activeSwimmers = useMemo(() => {
    const recruitResults: SwimmerResult[] = (workspace.recruits ?? [])
      .filter(r => r.gender === gender)
      .map(r => ({
        id: r.id,
        rank: 0,
        name: r.name,
        classYear: r.classYear,
        team: r.team,
        time: convertToSCY(r.time, r.event, r.gender, r.timeType),
        points: 0,
        event: r.event,
        isRecruit: true,
        gender: r.gender,
      }));
    const excluded = new Set(
      (workspace.deletedSwimmers ?? [])
        .filter(d => d.gender === gender)
        .map(d => normalizeSwimmerName(d.name))
    );
    const roster = originalResults.filter(r => {
      if (r.isRelay) return false;
      if (excluded.has(normalizeSwimmerName(r.name))) return false;
      if (
        removeSeniors &&
        (r.classYear === 'SR' || r.classYear === 'Sr' || r.classYear === 'Senior')
      ) {
        return false;
      }
      return true;
    });
    return [...roster, ...recruitResults];
  }, [gender, originalResults, removeSeniors, workspace.deletedSwimmers, workspace.recruits]);

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

    const map = new Map<string, RelayGroup>();
    for (const r of scoringBundle.allScored) {
      if (r.gender !== gender || String(r.team ?? '').trim() !== team) continue;
      if (!isRelayResult(r) || r.name === r.team) continue;

      const key = stableRelayEntryKey(originalResults, r);
      if (!map.has(key)) {
        const template = relayTemplateFromLeg(originalResults, r);
        map.set(key, {
          key,
          template,
          event: r.event,
          roundSwam: r.roundSwam?.trim() || '—',
          rank: r.rank,
          teamTotal: r.relayTeamTime || r.finalsTime || r.time,
          legs: [],
          teamSplits: r.relayTeamSplits,
        });
      }
      map.get(key)!.legs.push(r);
    }

    return [...map.values()]
      .map(g => ({
        ...g,
        legs: [...g.legs].sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0)),
      }))
      .sort((a, b) => a.event.localeCompare(b.event) || a.roundSwam.localeCompare(b.roundSwam));
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
        activeSwimmers,
        selectedGroup.event,
        idx,
        assignedInSelectedRelay,
        selectedTeam
      )) {
        const k = normalizeSwimmerName(swimmer.name);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(swimmer);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [activeSwimmers, assignedInSelectedRelay, selectedGroup, selectedTeam]);

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
    origNames.forEach((ln, i) => {
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
      activeSwimmers,
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
        activeSwimmers,
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

  const recruitCount = (workspace.recruits ?? []).filter(
    r => r.gender === gender && (!selectedTeam || r.team === selectedTeam)
  ).length;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0 lg:flex-row">
      <div className="flex flex-col gap-4 flex-1 min-h-0 min-w-0">
        <div className="surface-card rounded-lg p-4 shrink-0">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
            {teams.length > 0 ? (
              <label className="flex flex-col gap-1">
                <span className="text-[9px] font-medium text-theme-secondary uppercase tracking-widest">
                  Team
                </span>
                <select
                  value={selectedTeam || teams[0]}
                  onChange={e => setSelectedTeam(e.target.value)}
                  className="surface-muted-bg border border-theme-soft rounded px-2 py-1.5 text-[10px] text-[var(--text-primary)] min-w-[10rem]"
                >
                  {teams.map(team => (
                    <option key={team} value={team}>
                      {team}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
            {[
              { label: 'Athletes', value: stats.athletes },
              { label: 'Individual swims', value: stats.individual },
              { label: 'Relay leg rows', value: stats.relayLegs },
              { label: 'Relay events', value: stats.relayEvents },
              { label: 'Vacant legs', value: stats.vacantLegs },
            ].map(item => (
              <div
                key={item.label}
                className="surface-overlay border border-theme-soft rounded-lg px-3 py-2"
              >
                <p className="text-[9px] text-theme-secondary uppercase tracking-widest">{item.label}</p>
                <p className="text-lg font-semibold text-[var(--text-primary)] tabular-nums">{item.value}</p>
              </div>
            ))}
          </div>

          {recruitCount > 0 ? (
            <p className="text-[10px] text-theme-secondary">
              <span className="text-[var(--text-accent)]">{recruitCount}</span> injected recruit
              {recruitCount === 1 ? '' : 's'} for this team in the current projection.
            </p>
          ) : null}
        </div>

        <div className="surface-card rounded-lg p-4 flex-1 min-h-0 flex flex-col">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-primary)] mb-3">
            Relay split inspector
          </h4>
          {relayGroups.length === 0 ? (
            <p className="text-[10px] text-theme-muted italic">No relay entries for this team.</p>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-4">
              {relayGroups.map(group => {
                const vacantCount = group.legs.filter(l => l.relayLegVacant || l.relayMissingLeg).length;
                return (
                  <div
                    key={group.key}
                    className={`surface-overlay border rounded-lg p-3 ${
                      selectedGroup?.key === group.key ? 'border-[var(--text-accent)]/40' : 'border-theme-soft'
                    }`}
                    onClick={() => setSelectedRelayKey(group.key)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                      <div>
                        <p className="text-[11px] font-medium text-[var(--text-primary)]">{group.event}</p>
                        <p className="text-[9px] text-theme-secondary">
                          {group.roundSwam} · Pl {group.rank > 0 ? group.rank : '—'}
                          {vacantCount > 0 ? (
                            <span className="text-amber-400 ml-2">{vacantCount} vacant leg(s)</span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {whatIfMode && vacantCount > 0 ? (
                          <button
                            type="button"
                            className="text-[9px] px-2 py-0.5 rounded border border-theme-soft hover:border-[var(--text-accent)] text-theme-secondary"
                            onClick={e => {
                              e.stopPropagation();
                              autofillAllVacant(group);
                            }}
                          >
                            Auto-fill all
                          </button>
                        ) : null}
                        <p className="text-[10px] font-mono text-[var(--text-accent)] tabular-nums">
                          Team {group.teamTotal}
                        </p>
                      </div>
                    </div>
                    {group.teamSplits ? (
                      <p className="text-[9px] text-theme-secondary mb-3 font-mono">
                        {formatTeamSplitSummary(group.teamSplits)}
                      </p>
                    ) : null}
                    <div className="grid sm:grid-cols-2 gap-2">
                      {group.legs.map(leg => {
                        const legIndex = leg.relayLegIndex ?? 0;
                        const req = relayLegRequirements(group.event, legIndex);
                        const isVacant = Boolean(leg.relayLegVacant || leg.relayMissingLeg);
                        const legDropKey = `${group.key}|${legIndex}`;
                        const fieldKey = legDropKey;
                        return (
                          <div
                            key={leg.id}
                            className={`border rounded px-2 py-1.5 text-[10px] transition-colors ${
                              isVacant
                                ? 'border-amber-500/50 bg-amber-500/5'
                                : 'border-theme-soft/60'
                            } ${dragOverLeg === legDropKey ? 'ring-1 ring-[var(--text-accent)]' : ''}`}
                            onDragOver={e => {
                              if (!whatIfMode || !isVacant) return;
                              e.preventDefault();
                              setDragOverLeg(legDropKey);
                            }}
                            onDragLeave={() => setDragOverLeg(null)}
                            onDrop={e => {
                              e.preventDefault();
                              setDragOverLeg(null);
                              if (!whatIfMode || !isVacant) return;
                              const raw = e.dataTransfer.getData('application/x-omni-relay-leg');
                              if (!raw) return;
                              try {
                                assignDragPayload(group, legIndex, JSON.parse(raw) as DragPayload);
                              } catch {
                                /* ignore */
                              }
                            }}
                          >
                            <div className="flex justify-between gap-2">
                              <span className="text-[var(--text-primary)] truncate">
                                L{legIndex + 1}{' '}
                                {isVacant && (!leg.name || leg.name === '—') ? (
                                  <span className="text-amber-400">
                                    Missing — {relayMissingStrokeLabel(req.stroke)}{' '}
                                    {req.legDistanceYards}
                                  </span>
                                ) : (
                                  leg.name
                                )}
                              </span>
                              <span className="font-mono text-[var(--text-accent)] shrink-0 tabular-nums">
                                {displayTimeForRelayLeg(leg)}
                              </span>
                            </div>
                            {leg.relayLegSplitDetail ? (
                              <p className="text-[9px] text-theme-secondary font-mono mt-1 leading-snug">
                                {formatLegSplitSummary(leg.relayLegSplitDetail)}
                              </p>
                            ) : null}
                            <p className="text-[9px] text-theme-muted mt-0.5 tabular-nums">
                              {typeof leg.points === 'number' ? `${leg.points.toFixed(1)} pts` : '—'}
                            </p>
                            {whatIfMode && isVacant ? (
                              <div className="mt-2 space-y-1.5 border-t border-theme-soft/40 pt-2">
                                <button
                                  type="button"
                                  className="text-[9px] text-[var(--text-accent)] hover:underline"
                                  onClick={() => autofillLeg(group, legIndex)}
                                >
                                  Auto-fill best
                                </button>
                                <div className="flex gap-1">
                                  <input
                                    type="text"
                                    placeholder={`Leg time (${req.legDistanceYards}y)`}
                                    value={manualTimes[fieldKey] ?? ''}
                                    onChange={e =>
                                      setManualTimes(prev => ({ ...prev, [fieldKey]: e.target.value }))
                                    }
                                    className="flex-1 min-w-0 surface-muted-bg border border-theme-soft rounded px-1.5 py-0.5 text-[9px] font-mono"
                                  />
                                  <button
                                    type="button"
                                    className="text-[9px] px-1.5 py-0.5 rounded border border-theme-soft"
                                    onClick={() => saveManualLeg(group, legIndex)}
                                  >
                                    Set
                                  </button>
                                </div>
                                {overrides.some(
                                  o => o.relayEntryKey === group.key && o.legIndex === legIndex
                                ) ? (
                                  <button
                                    type="button"
                                    className="text-[9px] text-theme-muted hover:text-amber-400"
                                    onClick={() => clearLegOverride(group, legIndex)}
                                  >
                                    Clear override
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {whatIfMode && selectedGroup ? (
        <div className="surface-card rounded-lg p-4 w-full lg:w-72 shrink-0 flex flex-col min-h-[12rem] max-h-[40vh] lg:max-h-none">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-primary)] mb-1">
            Eligible swimmers
          </h4>
          <p className="text-[9px] text-theme-secondary mb-3 leading-relaxed">
            Drag onto a vacant leg for{' '}
            <span className="text-[var(--text-accent)]">{selectedGroup.event}</span>. Stroke must match
            the leg distance.
          </p>
          {poolCandidates.length === 0 ? (
            <p className="text-[10px] text-theme-muted italic">No eligible candidates for vacant legs.</p>
          ) : (
            <ul className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-1">
              {poolCandidates.map(swimmer => (
                  <li
                    key={swimmer.id || swimmer.name}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData(
                        'application/x-omni-relay-leg',
                        JSON.stringify({
                          name: swimmer.name,
                          recruitId: swimmer.isRecruit ? swimmer.id : undefined,
                          classYear: String(swimmer.classYear),
                        } satisfies DragPayload)
                      );
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    className="border border-theme-soft rounded px-2 py-1.5 cursor-grab active:cursor-grabbing hover:border-[var(--text-accent)]/40"
                  >
                    <p className="text-[10px] text-[var(--text-primary)] truncate">{swimmer.name}</p>
                    <p className="text-[9px] text-theme-secondary truncate">
                      {swimmer.classYear}
                      {swimmer.isRecruit ? ' · recruit' : ''} · {swimmer.event} {swimmer.time}
                    </p>
                  </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
