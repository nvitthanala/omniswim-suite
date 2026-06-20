import React, { useMemo, useState, useEffect } from 'react';
import { Users, RotateCcw, Sparkles } from 'lucide-react';
import { Gender, OfficialTeamScores, ScorerRosterOverride, ScoringSettings, SwimmerResult, Workspace } from '@omniswim/core/types';
import {
  aggregateSwimmerMeetPoints,
  buildScorerRosterLookup,
  getAthleteCreditedSwims,
  scorerRosterKey,
  usesScorerRoster,
} from '@omniswim/core/lib/scorerRoster';
import type { AthleteCreditedSwim, ScorerRosterAthleteRole, ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import { mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { isRelayResult } from '@omniswim/core/lib/utils';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import ProjectedActualScore from './ProjectedActualScore';
import AthleteCreditedSwimsPanel from './AthleteCreditedSwimsPanel';
import AthleteMeetEntriesPanel from './AthleteMeetEntriesPanel';
import { getAthleteProfile } from '@omniswim/core/lib/athleteHistory';
import {
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';

function AthleteRoleTag({ role, isRecruit }: { role: ScorerRosterAthleteRole; isRecruit?: boolean }) {
  if (isRecruit) {
    return (
      <span className="shrink-0 px-1.5 py-0.5 rounded text-ui-micro font-medium text-[var(--text-accent)] border border-[var(--text-accent)]/30">
        Recruit
      </span>
    );
  }
  const isDiver = role === 'diver';
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded text-ui-micro font-medium ${
        isDiver ? 'badge-warning' : 'badge-info'
      }`}
    >
      {isDiver ? 'Diver' : 'Swimmer'}
    </span>
  );
}

type Props = {
  results: SwimmerResult[];
  scoredResults: SwimmerResult[];
  settings: ScoringSettings;
  gender: Gender;
  overrides: ScorerRosterOverride[];
  onChangeOverrides: (next: ScorerRosterOverride[]) => void;
  editable: boolean;
  officialTeamScores?: OfficialTeamScores;
  projectedByTeam: Map<string, number>;
  baselineByTeam: Map<string, number>;
  showTeamSidebar?: boolean;
  selectedTeam?: string;
  onSelectTeam?: (team: string) => void;
  /** Fill available vertical space with taller team list and roster table */
  expanded?: boolean;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
  onAthleteSelect?: (athlete: { name: string; team: string; classYear: string } | null) => void;
  workspace?: Workspace;
  removeSeniors?: boolean;
  onWorkspaceUpdate?: (patch: Partial<Workspace>) => void;
  onOpenBatchOptimizer?: () => void;
};

export default function TeamRosterPanel({
  results,
  scoredResults,
  settings,
  gender,
  overrides,
  onChangeOverrides,
  editable,
  officialTeamScores,
  projectedByTeam,
  baselineByTeam,
  showTeamSidebar = true,
  selectedTeam: controlledTeam,
  onSelectTeam,
  expanded = false,
  onDeleteSwim,
  onAthleteSelect,
  workspace,
  removeSeniors = false,
  onWorkspaceUpdate,
  onOpenBatchOptimizer,
}: Props) {
  const merged = mergeScoringSettings(settings);
  const rosterMode = usesScorerRoster(merged);

  const genderResults = useMemo(
    () => results.filter(r => r.gender == null || r.gender === gender),
    [results, gender]
  );

  const pointTotals = useMemo(
    () => aggregateSwimmerMeetPoints(scoredResults, gender),
    [scoredResults, gender]
  );

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const r of genderResults) {
      const t = String(r.team ?? '').trim();
      if (!t) continue;
      if (r.isRecruit) {
        set.add(t);
        continue;
      }
      if (isRelayResult(r) && r.name === r.team) continue;
      set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [genderResults]);

  const memberCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    for (const r of genderResults) {
      const t = String(r.team ?? '').trim();
      if (!t || (isRelayResult(r) && r.name === r.team)) continue;
      const key = scorerRosterKey(t, gender, r.name);
      if (!seen.has(t)) seen.set(t, new Set());
      if (!seen.get(t)!.has(key)) {
        seen.get(t)!.add(key);
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return counts;
  }, [genderResults, gender]);

  const officialForGender = officialScoresForGender(officialTeamScores, gender);
  const officialLookup = useMemo(
    () => buildTeamScoreLookup(teams, officialForGender),
    [teams, officialForGender]
  );

  const [pickedTeam, setPickedTeam] = useState<string | null>(null);
  const [selectedAthleteKey, setSelectedAthleteKey] = useState<string | null>(null);

  const selectedTeam = useMemo(() => {
    if (controlledTeam && teams.includes(controlledTeam)) return controlledTeam;
    if (!teams.length) return '';
    if (pickedTeam && teams.includes(pickedTeam)) return pickedTeam;
    return teams[0];
  }, [teams, pickedTeam, controlledTeam]);

  useEffect(() => {
    setSelectedAthleteKey(null);
    onAthleteSelect?.(null);
  }, [selectedTeam, gender, onAthleteSelect]);

  const selectTeam = (team: string) => {
    setPickedTeam(team);
    onSelectTeam?.(team);
  };

  const { rows, autoLookup } = useMemo(() => {
    const autoLookup = buildScorerRosterLookup(genderResults, merged, [], gender);
    const lookup = buildScorerRosterLookup(genderResults, merged, overrides, gender);
    return { rows: lookup.rows, autoLookup };
  }, [genderResults, merged, overrides, gender]);

  const teamRows = useMemo(() => {
    return rows
      .filter(r => r.team === selectedTeam)
      .sort((a, b) => {
        const ptsA = pointTotals.get(a.key) ?? 0;
        const ptsB = pointTotals.get(b.key) ?? 0;
        if (ptsB !== ptsA) return ptsB - ptsA;
        return a.name.localeCompare(b.name);
      });
  }, [rows, selectedTeam, pointTotals]);

  const selectedAthlete = useMemo(
    () => teamRows.find(r => r.key === selectedAthleteKey) ?? null,
    [teamRows, selectedAthleteKey]
  );

  const selectedAthleteSwims = useMemo(() => {
    if (!selectedAthlete) return [];
    return getAthleteCreditedSwims(
      scoredResults,
      selectedAthlete.team,
      selectedAthlete.name,
      selectedAthlete.gender
    );
  }, [scoredResults, selectedAthlete]);

  const toggleAthleteSelection = (row: ScorerRosterRow) => {
    if (selectedAthleteKey === row.key) {
      setSelectedAthleteKey(null);
      onAthleteSelect?.(null);
      return;
    }
    setSelectedAthleteKey(row.key);
    onAthleteSelect?.({ name: row.name, team: row.team, classYear: row.classYear });
  };

  const setScorer = (row: (typeof rows)[0], isScorer: boolean) => {
    if (!editable) return;
    const auto = autoLookup.isScorer(row.name, row.team, row.gender);
    const key = scorerRosterKey(row.team, row.gender, row.name);
    const rest = overrides.filter(o => scorerRosterKey(o.team, o.gender, o.name) !== key);
    if (isScorer === auto) {
      onChangeOverrides(rest);
    } else {
      onChangeOverrides([...rest, { name: row.name, team: row.team, gender: row.gender, isScorer }]);
    }
  };

  const resetTeamManual = () => {
    if (!editable || !selectedTeam) return;
    const rest = overrides.filter(
      o => !(o.team === selectedTeam && o.gender === gender)
    );
    onChangeOverrides(rest);
  };

  const runOptimizer = (_allTeams: boolean) => {
    if (!editable) return;
    onOpenBatchOptimizer?.();
  };

  const selectedProjected = projectedByTeam.get(selectedTeam) ?? 0;
  const selectedBaseline = baselineByTeam.get(selectedTeam);
  const selectedActual = officialLookup.get(selectedTeam);

  if (!rosterMode) {
    return (
      <div className="surface-card rounded-lg p-5">
        <h4 className="text-ui-label font-semibold text-theme-secondary flex items-center gap-2 mb-2">
          <Users size={12} />
          Team roster
        </h4>
        <p className="text-[10px] text-theme-secondary leading-relaxed">
          Team roster management is used when scoring settings use roster eligibility (e.g. NSISC preset).
          Load that preset or set scorer eligibility to roster.
        </p>
      </div>
    );
  }

  const genderLabel = gender === Gender.MEN ? "Men's" : "Women's";
  const colSpan = editable ? 3 : 2;

  const rosterTable = (
    <div className={expanded ? 'flex flex-col flex-1 min-h-0' : undefined}>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-ui-label font-semibold text-theme-secondary flex items-center gap-2">
          <Users size={12} />
          {selectedTeam || 'Team roster'}
          <span className="text-theme-muted font-normal">({genderLabel})</span>
        </h4>
        <div className="flex items-center gap-2">
          {editable && onOpenBatchOptimizer ? (
            <>
              <button
                type="button"
                onClick={() => runOptimizer(false)}
                disabled={!selectedTeam}
                className="btn-ghost text-ui-caption flex items-center gap-1 text-[var(--text-accent)]"
                title="Open batch optimizer for selected team"
              >
                <Sparkles size={12} />
                Optimize roster
              </button>
            </>
          ) : null}
          {editable ? (
            <button
              type="button"
              onClick={resetTeamManual}
              className="btn-ghost text-ui-caption flex items-center gap-1"
              title="Revert manual edits for this team"
            >
              <RotateCcw size={12} />
              Reset team
            </button>
          ) : null}
        </div>
      </div>

      {selectedTeam ? (
        <ProjectedActualScore
          actual={selectedActual}
          baseline={selectedBaseline}
          projected={selectedProjected}
          eventThrough={officialTeamScores?.eventThrough}
        />
      ) : null}

      <p className="text-ui-caption text-theme-secondary my-3 leading-relaxed">
        Full team roster with projected meet points (individual + relay leg share). Click an athlete to
        view credited swims and autofill recruit injection for another event.{' '}
        {editable
          ? `Toggle scorers for the ${merged.maxIndividualScorersPerTeam}-scorer cap.`
          : 'Enable What-if mode to edit scorer toggles.'}
      </p>
      {!showTeamSidebar ? (
        <>
          <label className="block text-[10px] text-theme-secondary uppercase mb-1">Team</label>
          <select
            className="glass-input w-full text-xs mb-3"
            value={selectedTeam}
            onChange={e => selectTeam(e.target.value)}
            disabled={!teams.length}
          >
            {!teams.length ? (
              <option value="">No teams in matrix</option>
            ) : (
              teams.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))
            )}
          </select>
        </>
      ) : null}

      <div
        className={`overflow-y-auto pr-1 rounded border border-theme-soft custom-scrollbar ${
          expanded ? 'flex-1 min-h-[20rem]' : 'max-h-80'
        }`}
      >
        <table className="w-full">
          <thead>
            <tr className="text-ui-caption text-theme-muted border-b border-theme-soft">
              <th className="text-left py-2.5 px-3 font-medium">Athlete</th>
              <th className="text-right py-2.5 px-3 font-medium w-16">Class</th>
              <th className="text-right py-2.5 px-3 font-medium w-16">Meet pts</th>
              {editable ? (
                <th className="text-center py-2.5 px-3 font-medium w-16">Scorer</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {!selectedTeam || teamRows.length === 0 ? (
              <tr>
                <td colSpan={colSpan + 1} className="py-6 text-center text-ui-caption text-theme-muted">
                  {teams.length ? 'No athletes for this team' : 'Upload results to populate teams'}
                </td>
              </tr>
            ) : (
              teamRows.map(row => {
                const meetPts = pointTotals.get(row.key) ?? 0;
                const isSelected = selectedAthleteKey === row.key;
                const entryCounts = countSwimmerEntries(genderResults, row.team, gender, row.name);
                const entryOver = swimmerExceedsEntryLimits(entryCounts, merged);
                const profile =
                  workspace && selectedTeam
                    ? getAthleteProfile(workspace, row.team, gender, row.name, merged)
                    : null;
                return (
                  <tr
                    key={row.key}
                    onClick={() => toggleAthleteSelection(row)}
                    className={`border-b border-theme-soft/50 text-ui-body cursor-pointer transition-colors ${
                      isSelected ? 'bg-[var(--text-accent)]/10' : 'theme-hover-row'
                    }`}
                  >
                    <td className="py-2.5 px-3" title={row.name}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`truncate ${isSelected ? 'text-[var(--text-accent)] font-medium' : ''}`}>
                          {row.name}
                        </span>
                        <AthleteRoleTag role={row.athleteRole} isRecruit={row.isRecruit} />
                        {entryOver.individualOver || entryOver.relayOver ? (
                          <span className="text-ui-micro text-amber-400 shrink-0" title="Over entry limit">
                            !
                          </span>
                        ) : null}
                      </div>
                      {profile && profile.primaryEvents.length > 0 ? (
                        <p className="text-ui-micro text-theme-muted truncate mt-0.5" title={profile.primaryEvents.join(', ')}>
                          {profile.primaryEvents.slice(0, 3).join(' · ')}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-2.5 px-3 text-right text-theme-secondary text-ui-caption tabular-nums">
                      {row.classYear || '—'}
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono tabular-nums text-ui-caption ${
                        meetPts > 0 ? 'text-[var(--text-accent)]' : 'text-theme-secondary'
                      }`}
                    >
                      {meetPts.toFixed(1)}
                    </td>
                    {editable ? (
                      <td className="py-2.5 px-3 text-center" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={row.isScorer}
                          onChange={e => setScorer(row, e.target.checked)}
                          className="accent-[var(--text-accent)]"
                          aria-label={`${row.name} scorer`}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {selectedAthlete ? (
        <>
          <AthleteCreditedSwimsPanel
            athleteName={selectedAthlete.name}
            team={selectedAthlete.team}
            swims={selectedAthleteSwims}
            totalPoints={pointTotals.get(selectedAthlete.key) ?? 0}
            onClose={() => {
              setSelectedAthleteKey(null);
              onAthleteSelect?.(null);
            }}
            deletable={Boolean(onDeleteSwim)}
            onDeleteSwim={onDeleteSwim}
            entryLimitLabel={formatEntryLimitLabel(
              countSwimmerEntries(genderResults, selectedAthlete.team, gender, selectedAthlete.name),
              merged
            )}
          />
          {workspace && onWorkspaceUpdate ? (
            <AthleteMeetEntriesPanel
              workspace={workspace}
              settings={merged}
              gender={gender}
              athleteName={selectedAthlete.name}
              team={selectedAthlete.team}
              classYear={selectedAthlete.classYear}
              editable={editable}
              onUpdate={onWorkspaceUpdate}
            />
          ) : null}
        </>
      ) : null}
      {selectedTeam ? (
        <p className="text-[9px] text-theme-secondary mt-2">
          {editable ? (
            <>
              {teamRows.filter(r => r.isScorer).length} of {teamRows.length} marked as scorers on{' '}
              <span className="text-[var(--text-accent)]">{selectedTeam}</span>
            </>
          ) : (
            <>
              {teamRows.length} athletes on{' '}
              <span className="text-[var(--text-accent)]">{selectedTeam}</span> — enable What-if to edit
              scorers
            </>
          )}
        </p>
      ) : null}
    </div>
  );

  if (!showTeamSidebar) {
    return <div className={`surface-card rounded-lg p-5 ${expanded ? 'flex flex-col flex-1 min-h-0' : ''}`}>{rosterTable}</div>;
  }

  return (
    <div
      className={`grid grid-cols-12 gap-4 ${expanded ? 'flex-1 min-h-0 h-full' : ''}`}
    >
      <div className={`col-span-3 flex flex-col min-h-0 ${expanded ? 'h-full' : ''}`}>
        <h4 className="text-[10px] font-medium text-theme-secondary uppercase tracking-widest mb-2 shrink-0">
          Teams ({teams.length})
        </h4>
        <div
          className={`overflow-y-auto space-y-1.5 pr-1 custom-scrollbar flex-1 min-h-0 ${
            expanded ? '' : 'max-h-[32rem]'
          }`}
        >
          {!teams.length ? (
            <p className="text-[10px] text-theme-muted italic p-3">Upload a PDF to detect teams</p>
          ) : (
            teams.map(team => {
              const projected = projectedByTeam.get(team) ?? 0;
              const actual = officialLookup.get(team);
              const isActive = team === selectedTeam;
              return (
                <button
                  key={team}
                  type="button"
                  onClick={() => selectTeam(team)}
                  className={`w-full text-left p-3.5 rounded-lg border transition-all ${
                    isActive
                      ? 'border-[var(--text-accent)]/40 bg-[var(--text-accent)]/10'
                      : 'border-theme-soft surface-overlay theme-hover-row'
                  }`}
                >
                  <div className="text-[12px] font-medium text-[var(--text-primary)] truncate" title={team}>
                    {team}
                  </div>
                  <div className="text-[10px] text-theme-secondary mt-1">
                    {memberCounts.get(team) ?? 0} athletes
                  </div>
                  <div className="flex gap-2 mt-2 text-[10px] font-mono">
                    {actual != null ? (
                      <span className="text-theme-secondary">
                        Act {actual.toFixed(0)}
                      </span>
                    ) : null}
                    <span className="text-[var(--text-accent)]">Proj {projected.toFixed(0)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
      <div
        className={`col-span-9 surface-card rounded-lg p-5 flex flex-col min-h-0 ${
          expanded ? 'h-full' : ''
        }`}
      >
        {rosterTable}
      </div>
    </div>
  );
}