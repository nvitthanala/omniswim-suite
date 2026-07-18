import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { Users, RotateCcw, Sparkles, Trash2, Undo2 } from 'lucide-react';
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
import { isRelayResult, normalizeSwimmerName } from '@omniswim/core/lib/utils';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import { restoreSwimmerToWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';
import ProjectedActualScore from './ProjectedActualScore';
import AthleteCreditedSwimsPanel from './AthleteCreditedSwimsPanel';
import AthleteMeetEntriesPanel from './AthleteMeetEntriesPanel';
import AthleteLineupEditorPanel from './AthleteLineupEditorPanel';
import { getAthleteProfile } from '@omniswim/core/lib/athleteHistory';
import {
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '@omniswim/core/lib/swimmerEntryLimits';
import { optimizeRosterAllTeams, optimizeRosterForTeam } from '@omniswim/core/lib/rosterOptimizer';
import {
  applyScorerOffRelayPatch,
  issueBadgeLabel,
  type TeamLineupAudit,
} from '@omniswim/core/lib/rosterLineupAudit';
import { useToast } from '@omniswim/ui';

const ROSTER_WINDOW_THRESHOLD = 80;
const ROSTER_ROW_ESTIMATE_PX = 44;
const ROSTER_OVERSCAN_ROWS = 8;

function AthleteRoleTag({ role, isRecruit }: { role: ScorerRosterAthleteRole; isRecruit?: boolean }) {
  if (isRecruit) {
    return (
      <span className="shrink-0 px-1.5 py-0.5 rounded text-ui-caption font-medium text-[var(--text-accent)] border border-[var(--text-accent)]/30">
        Recruit
      </span>
    );
  }
  const isDiver = role === 'diver';
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded text-ui-caption font-medium ${
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
  /** When `dropdown`, prefer compact team select over sidebar cards. */
  teamPickerMode?: 'sidebar' | 'dropdown';
  /** Unified athlete editor (Lineup) vs legacy credited + entries panels. */
  editorMode?: 'unified' | 'legacy';
  lineupAudit?: TeamLineupAudit;
  selectedTeam?: string;
  onSelectTeam?: (team: string) => void;
  /** Fill available vertical space with taller team list and roster table */
  expanded?: boolean;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
  onAthleteSelect?: (athlete: { name: string; team: string; classYear: string } | null) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  workspace?: Workspace;
  removeSeniors?: boolean;
  onWorkspaceUpdate?: (patch: Partial<Workspace>) => void;
  /** Select this athlete by name when set (checklist Jump). */
  jumpAthleteName?: string | null;
  onJumpAthleteHandled?: () => void;
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
  teamPickerMode,
  editorMode = 'legacy',
  lineupAudit,
  selectedTeam: controlledTeam,
  onSelectTeam,
  expanded = false,
  onDeleteSwim,
  onAthleteSelect,
  onRequestDeleteSwimmer,
  workspace,
  removeSeniors = false,
  onWorkspaceUpdate,
  jumpAthleteName,
  onJumpAthleteHandled,
}: Props) {
  const toast = useToast();
  const merged = mergeScoringSettings(settings);
  const rosterMode = usesScorerRoster(merged);
  const useDropdown =
    teamPickerMode === 'dropdown' || (!showTeamSidebar && teamPickerMode !== 'sidebar');
  const useSidebar = showTeamSidebar && !useDropdown;

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
  const rosterScrollRef = useRef<HTMLDivElement>(null);
  const [rosterScrollTop, setRosterScrollTop] = useState(0);
  const [rosterViewportHeight, setRosterViewportHeight] = useState(expanded ? 560 : 320);

  const selectedTeam = useMemo(() => {
    if (controlledTeam && teams.includes(controlledTeam)) return controlledTeam;
    if (controlledTeam === '' && useDropdown) return '';
    if (!teams.length) return '';
    if (pickedTeam && teams.includes(pickedTeam)) return pickedTeam;
    return useDropdown ? '' : teams[0];
  }, [teams, pickedTeam, controlledTeam, useDropdown]);

  useEffect(() => {
    setSelectedAthleteKey(null);
    onAthleteSelect?.(null);
  }, [selectedTeam, gender, onAthleteSelect]);

  useEffect(() => {
    const el = rosterScrollRef.current;
    if (!el) return;
    const updateHeight = () => setRosterViewportHeight(el.clientHeight || (expanded ? 560 : 320));
    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, selectedTeam]);

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

  useEffect(() => {
    setRosterScrollTop(0);
    rosterScrollRef.current?.scrollTo({ top: 0 });
  }, [selectedTeam, teamRows.length]);

  const rosterWindow = useMemo(() => {
    if (teamRows.length <= ROSTER_WINDOW_THRESHOLD) {
      return { rows: teamRows, start: 0, topSpacer: 0, bottomSpacer: 0 };
    }
    const start = Math.max(0, Math.floor(rosterScrollTop / ROSTER_ROW_ESTIMATE_PX) - ROSTER_OVERSCAN_ROWS);
    const visibleCount = Math.ceil(rosterViewportHeight / ROSTER_ROW_ESTIMATE_PX) + ROSTER_OVERSCAN_ROWS * 2;
    const end = Math.min(teamRows.length, start + visibleCount);
    return {
      rows: teamRows.slice(start, end),
      start,
      topSpacer: start * ROSTER_ROW_ESTIMATE_PX,
      bottomSpacer: Math.max(0, (teamRows.length - end) * ROSTER_ROW_ESTIMATE_PX),
    };
  }, [rosterScrollTop, rosterViewportHeight, teamRows]);

  const handleRosterScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setRosterScrollTop(event.currentTarget.scrollTop);
  }, []);

  const selectedAthlete = useMemo(
    () => teamRows.find(r => r.key === selectedAthleteKey) ?? null,
    [teamRows, selectedAthleteKey]
  );

  useEffect(() => {
    if (!jumpAthleteName) return;
    const key = normalizeSwimmerName(jumpAthleteName);
    const row = teamRows.find(r => normalizeSwimmerName(r.name) === key);
    if (row) {
      setSelectedAthleteKey(row.key);
      onAthleteSelect?.({ name: row.name, team: row.team, classYear: row.classYear });
      requestAnimationFrame(() => {
        document.getElementById('athlete-lineup-editor')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      });
    }
    onJumpAthleteHandled?.();
  }, [jumpAthleteName, teamRows, onAthleteSelect, onJumpAthleteHandled]);

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
    const nextOverrides =
      isScorer === auto
        ? rest
        : [...rest, { name: row.name, team: row.team, gender: row.gender, isScorer }];

    if (workspace && onWorkspaceUpdate) {
      const patch = applyScorerOffRelayPatch(workspace, {
        name: row.name,
        team: row.team,
        gender: row.gender,
        isScorer,
        overrides: nextOverrides,
      });
      onWorkspaceUpdate(patch);
      if (!isScorer) {
        toast.push(
          'info',
          `${row.name}: non-scorers cannot swim relays — vacated from relay legs if assigned.`
        );
      }
      return;
    }
    onChangeOverrides(nextOverrides);
  };

  const resetTeamManual = () => {
    if (!editable || !selectedTeam) return;
    const rest = overrides.filter(
      o => !(o.team === selectedTeam && o.gender === gender)
    );
    onChangeOverrides(rest);
  };

  const runOptimizer = (allTeams: boolean) => {
    if (!editable || !workspace || !onWorkspaceUpdate) return;
    const result = allTeams
      ? optimizeRosterAllTeams(workspace, gender, removeSeniors, merged, 'all')
      : optimizeRosterForTeam(workspace, gender, selectedTeam, removeSeniors, merged, 'all');
    const msg = `Projected ${result.projectedTotal.toFixed(1)} pts (was ${result.previousTotal.toFixed(1)}). Apply?`;
    if (!window.confirm(msg)) return;
    onWorkspaceUpdate({
      scorerRosterOverrides: result.overrides,
      meetEntryPlans: result.meetEntryPlans,
      activeEntryIds: result.activeEntryIds,
    });
  };

  const selectedProjected = projectedByTeam.get(selectedTeam) ?? 0;
  const selectedBaseline = baselineByTeam.get(selectedTeam);
  const selectedActual = officialLookup.get(selectedTeam);

  if (!rosterMode) {
    return (
      <div className="surface-card rounded-xl p-5">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2 mb-2">
          <Users size={16} className="text-[var(--text-accent)]" />
          Team roster
        </h4>
        <p className="text-ui-body text-theme-secondary leading-relaxed">
          Roster tools need roster eligibility mode (NSISC preset). Open Source → Scoring setup to
          switch.
        </p>
      </div>
    );
  }

  const genderLabel = gender === Gender.MEN ? "Men's" : "Women's";
  const colSpan = editable ? (onRequestDeleteSwimmer ? 4 : 3) : 2;

  const rosterTable = (
    <div className={expanded ? 'flex flex-col flex-1 min-h-0' : undefined}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-3">
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)] flex items-center gap-2 min-w-0">
          <Users size={16} className="shrink-0 text-[var(--text-accent)]" />
          <span className="truncate" title={selectedTeam || 'Team roster'}>
            {selectedTeam || 'Team roster'}
          </span>
          <span className="text-theme-muted font-normal shrink-0">{genderLabel}</span>
        </h4>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 shrink-0">
          {editable && workspace && onWorkspaceUpdate ? (
            <>
              <button
                type="button"
                onClick={() => runOptimizer(false)}
                disabled={!selectedTeam}
                className="text-ui-caption text-[var(--text-accent)] hover:underline flex items-center gap-1 whitespace-nowrap"
                title="Optimize scorers and event lineup for selected team"
              >
                <Sparkles size={12} />
                Best roster
              </button>
              <button
                type="button"
                onClick={() => runOptimizer(true)}
                className="text-ui-caption text-theme-secondary hover:text-[var(--text-accent)] flex items-center gap-1 whitespace-nowrap"
              >
                All teams
              </button>
            </>
          ) : null}
          {editable ? (
            <button
              type="button"
              onClick={resetTeamManual}
              className="text-ui-caption text-theme-secondary hover:text-[var(--text-accent)] flex items-center gap-1 whitespace-nowrap"
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

      <p className="text-ui-body text-theme-secondary my-3 leading-relaxed">
        {editorMode === 'unified'
          ? 'Click an athlete to edit scorers, individual entries, and see relay status.'
          : 'Click an athlete for credited swims and entry planning.'}
        {editable
          ? ` Toggle scorers for the ${merged.maxIndividualScorersPerTeam}-scorer cap.`
          : ' Enable What-if to edit scorers.'}
      </p>
      {useDropdown ? (
        <label className="block mb-3">
          <span className="block text-ui-caption text-theme-muted mb-1.5">Team</span>
          <select
            className="glass-input w-full rounded-lg px-3 py-2 text-ui-body"
            value={selectedTeam}
            onChange={e => selectTeam(e.target.value)}
            disabled={!teams.length}
          >
            {!teams.length ? (
              <option value="">No teams in matrix</option>
            ) : (
              <>
                {!controlledTeam || !teams.includes(controlledTeam) ? (
                  <option value="">Select a team…</option>
                ) : null}
                {teams.map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
      ) : null}

      <div
        ref={rosterScrollRef}
        onScroll={handleRosterScroll}
        className={`overflow-y-auto pr-1 rounded-xl border border-theme-soft custom-scrollbar ${
          expanded ? 'flex-1 min-h-[20rem]' : 'max-h-80'
        }`}
      >
        <table className="w-full">
          <thead className="sticky top-0 surface-muted-bg z-[1]">
            <tr className="text-ui-caption text-theme-muted border-b border-theme-soft">
              <th className="text-left py-2.5 px-3 font-medium">Athlete</th>
              <th className="text-right py-2.5 px-3 font-medium w-20">Class</th>
              <th className="text-right py-2.5 px-3 font-medium w-24">Meet pts</th>
              {editable ? (
                <th className="text-center py-2.5 px-3 font-medium w-20">Scorer</th>
              ) : null}
              {editable && onRequestDeleteSwimmer ? (
                <th className="text-center py-2.5 px-2 font-medium w-12">
                  <span className="sr-only">Remove</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {!selectedTeam || teamRows.length === 0 ? (
              <tr>
                <td colSpan={colSpan + 1} className="py-4 text-center text-ui-caption text-theme-muted italic">
                  {teams.length ? 'No athletes for this team' : 'Upload results to populate teams'}
                </td>
              </tr>
            ) : (
              <>
                {rosterWindow.topSpacer > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={colSpan + 1} style={{ height: rosterWindow.topSpacer }} />
                  </tr>
                ) : null}
                {rosterWindow.rows.map(row => {
                const meetPts = pointTotals.get(row.key) ?? 0;
                const isSelected = selectedAthleteKey === row.key;
                const entryCounts = countSwimmerEntries(genderResults, row.team, gender, row.name);
                const entryOver = swimmerExceedsEntryLimits(entryCounts, merged);
                const athleteIssues =
                  lineupAudit?.athleteIssues.get(normalizeSwimmerName(row.name)) ?? [];
                const profile =
                  workspace && selectedTeam
                    ? getAthleteProfile(workspace, row.team, gender, row.name, merged)
                    : null;
                const showOver =
                  entryOver.individualOver ||
                  entryOver.relayOver ||
                  athleteIssues.some(i => i.type === 'over_entry_limit');
                const showEmpty = athleteIssues.some(i => i.type === 'empty_lineup');
                const showRelayGap = athleteIssues.some(
                  i =>
                    i.type === 'relay_leg_vacant' ||
                    i.type === 'relay_scorer_off' ||
                    i.type === 'relay_needs_fill'
                );
                return (
                  <tr
                    key={row.key}
                    id={`roster-row-${row.key}`}
                    onClick={() => toggleAthleteSelection(row)}
                    className={`border-b border-theme-soft/50 text-ui-body cursor-pointer transition-colors ${
                      isSelected ? 'bg-[var(--text-accent)]/10' : 'theme-hover-row'
                    }`}
                  >
                    <td className="py-2.5 px-3" title={row.name}>
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span
                          className={`truncate min-w-0 ${
                            isSelected ? 'text-[var(--text-accent)] font-medium' : ''
                          }`}
                        >
                          {row.name}
                        </span>
                        <AthleteRoleTag role={row.athleteRole} isRecruit={row.isRecruit} />
                        {showOver ? (
                          <span
                            className="text-ui-caption px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-400 shrink-0"
                            title="Over entry limit"
                          >
                            Over limit
                          </span>
                        ) : null}
                        {showEmpty ? (
                          <span
                            className="text-ui-caption px-1.5 py-0.5 rounded border border-theme-soft text-theme-secondary shrink-0"
                            title="Scorer with no individual entries"
                          >
                            Empty lineup
                          </span>
                        ) : null}
                        {showRelayGap ? (
                          <span
                            className="text-ui-caption px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-400 shrink-0"
                            title={
                              athleteIssues.find(
                                i =>
                                  i.type === 'relay_leg_vacant' ||
                                  i.type === 'relay_scorer_off' ||
                                  i.type === 'relay_needs_fill'
                              )?.message ?? 'Relay gap'
                            }
                          >
                            {issueBadgeLabel(
                              athleteIssues.find(
                                i =>
                                  i.type === 'relay_leg_vacant' ||
                                  i.type === 'relay_scorer_off' ||
                                  i.type === 'relay_needs_fill'
                              ) ?? { type: 'relay_leg_vacant', message: 'Relay gap' }
                            )}
                          </span>
                        ) : null}
                      </div>
                      {profile && profile.primaryEvents.length > 0 ? (
                        <p
                          className="text-ui-caption text-theme-muted truncate mt-1"
                          title={profile.primaryEvents.join(', ')}
                        >
                          {profile.primaryEvents.slice(0, 3).join(' · ')}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-2.5 px-3 text-right text-theme-secondary whitespace-nowrap">
                      {row.classYear || '—'}
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap ${
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
                    {editable && onRequestDeleteSwimmer ? (
                      <td className="py-2.5 px-2 text-center" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          className="p-1.5 rounded-lg text-theme-muted hover:text-rose-400 hover:bg-rose-400/10"
                          title={`Remove ${row.name} from roster (keeps meet record)`}
                          aria-label={`Remove ${row.name}`}
                          onClick={() => onRequestDeleteSwimmer(row.name)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
                })}
                {rosterWindow.bottomSpacer > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={colSpan + 1} style={{ height: rosterWindow.bottomSpacer }} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
      {workspace &&
      editable &&
      onWorkspaceUpdate &&
      (workspace.deletedSwimmers ?? []).some(d => d.gender === gender) ? (
        <div className="mt-3 border border-theme-soft rounded-xl p-3.5 surface-muted-bg">
          <h5 className="text-ui-caption font-semibold text-theme-secondary mb-2">
            Removed from roster
          </h5>
          <ul className="space-y-2">
            {(workspace.deletedSwimmers ?? [])
              .filter(d => d.gender === gender)
              .map(d => (
                <li
                  key={`${d.gender}|${normalizeSwimmerName(d.name)}`}
                  className="flex items-center justify-between gap-3 text-ui-body"
                >
                  <span className="text-[var(--text-primary)] truncate min-w-0" title={d.name}>
                    {d.name}
                  </span>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-ui-caption text-[var(--text-accent)] hover:underline shrink-0"
                    onClick={() =>
                      onWorkspaceUpdate(
                        restoreSwimmerToWorkspace(workspace, { name: d.name, gender })
                      )
                    }
                  >
                    <Undo2 size={12} />
                    Restore
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {selectedAthlete ? (
        editorMode === 'unified' && workspace && onWorkspaceUpdate ? (
          <AthleteLineupEditorPanel
            workspace={workspace}
            settings={merged}
            gender={gender}
            athlete={selectedAthlete}
            issues={lineupAudit?.athleteIssues.get(normalizeSwimmerName(selectedAthlete.name)) ?? []}
            scoredResults={scoredResults}
            allResults={results}
            editable={editable}
            onUpdate={onWorkspaceUpdate}
            onClose={() => {
              setSelectedAthleteKey(null);
              onAthleteSelect?.(null);
            }}
            autoIsScorer={autoLookup.isScorer(
              selectedAthlete.name,
              selectedAthlete.team,
              selectedAthlete.gender
            )}
          />
        ) : (
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
                countSwimmerEntries(
                  genderResults,
                  selectedAthlete.team,
                  gender,
                  selectedAthlete.name
                ),
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
        )
      ) : null}
      {selectedTeam ? (
        <p className="text-ui-caption text-theme-secondary mt-3 leading-relaxed">
          {editable ? (
            <>
              {teamRows.filter(r => r.isScorer).length} of {teamRows.length} marked as scorers on{' '}
              <span className="text-[var(--text-accent)]">{selectedTeam}</span>
            </>
          ) : (
            <>
              {teamRows.length} athletes on{' '}
              <span className="text-[var(--text-accent)]">{selectedTeam}</span> — enable What-if to
              edit scorers
            </>
          )}
        </p>
      ) : null}
    </div>
  );

  if (!useSidebar) {
    return (
      <div className={`surface-card rounded-xl p-4 sm:p-5 ${expanded ? 'flex flex-col flex-1 min-h-0' : ''}`}>
        {rosterTable}
      </div>
    );
  }

  return (
    <div
      className={`grid grid-cols-1 lg:grid-cols-12 gap-4 ${expanded ? 'flex-1 min-h-0' : ''}`}
    >
      <div className={`lg:col-span-3 flex flex-col min-h-0 ${expanded ? 'lg:h-full' : ''}`}>
        <h4 className="text-ui-caption text-theme-muted mb-2 shrink-0">
          Teams ({teams.length})
        </h4>
        <div
          className={`overflow-y-auto space-y-1.5 pr-1 custom-scrollbar flex-1 min-h-0 ${
            expanded ? '' : 'max-h-[32rem]'
          }`}
        >
          {!teams.length ? (
            <p className="text-ui-caption text-theme-muted italic p-3">Upload a PDF to detect teams</p>
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
                  <div className="text-ui-label font-medium text-[var(--text-primary)] truncate" title={team}>
                    {team}
                  </div>
                  <div className="text-ui-caption text-theme-secondary mt-1">
                    {memberCounts.get(team) ?? 0} athletes
                  </div>
                  <div className="flex gap-2 mt-2 text-ui-micro font-mono">
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
        className={`lg:col-span-9 surface-card rounded-xl p-4 sm:p-5 flex flex-col min-h-0 ${
          expanded ? 'lg:h-full' : ''
        }`}
      >
        {rosterTable}
      </div>
    </div>
  );
}