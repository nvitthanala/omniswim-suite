import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { Users } from 'lucide-react';
import { Gender, OfficialTeamScores, ScorerRosterOverride, ScoringSettings, SwimmerResult, Workspace } from '@omniswim/core/types';
import {
  aggregateSwimmerMeetPoints,
  buildScorerRosterLookup,
  scorerRosterKey,
  usesScorerRoster,
} from '@omniswim/core/lib/scorerRoster';
import type { AthleteCreditedSwim, ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import { effectivePdfPlacePointsMode, mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';
import { canonicalSwimmerName, isRelayResult, normalizeSwimmerName } from '@omniswim/core/lib/utils';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import { buildAliasResolver } from '@omniswim/core/lib/athleteAliases';
import { type EditCreditedSwimValues } from './AthleteCreditedSwimsPanel';
import { buildHistoryFromWorkspace, mergeHistoryIndex } from '@omniswim/core/lib/athleteHistory';
import { applyScorerOffRelayPatch, type TeamLineupAudit } from '@omniswim/core/lib/rosterLineupAudit';
import { Button, useOpenScoringRules, useToast } from '@omniswim/ui';
import { countTeamMembers, genderLabelFor, resolveTeamPickerMode, rosterColSpan, activeRosterRowId } from './teamRosterView';
import TeamRosterHeader from './TeamRosterHeader';
import TeamRosterTable from './TeamRosterTable';
import TeamRosterLayoutShell from './TeamRosterLayoutShell';
import RemovedSwimmersSection from './RemovedSwimmersSection';
import AthleteLineupDrawer from './AthleteLineupDrawer';

const ROSTER_WINDOW_THRESHOLD = 80;
const ROSTER_ROW_ESTIMATE_PX = 44;
const ROSTER_OVERSCAN_ROWS = 8;

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
  /**
   * Omit the in-panel Team select. The parent supplies the team (`selectedTeam`)
   * and owns the one team control, so a second select here would be a duplicate.
   */
  hideTeamSelect?: boolean;
  lineupAudit?: TeamLineupAudit;
  selectedTeam?: string;
  onSelectTeam?: (team: string) => void;
  /** Fill available vertical space with taller team list and roster table */
  expanded?: boolean;
  onDeleteSwim?: (swim: AthleteCreditedSwim) => void;
  onEditSwim?: (swim: AthleteCreditedSwim, changes: EditCreditedSwimValues) => void;
  onAthleteSelect?: (athlete: { name: string; team: string; classYear: string } | null) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  workspace?: Workspace;
  /** Opens the Optimize step. The Lineup step has no optimizer of its own. */
  onOpenOptimize?: () => void;
  onWorkspaceUpdate?: (patch: Partial<Workspace>) => void;
  /** Select this athlete by name when set (checklist Jump). */
  jumpAthleteName?: string | null;
  /** Preferred: the ScorerRosterRow.key of the jump target (matched before name). */
  jumpAthleteKey?: string | null;
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
  hideTeamSelect = false,
  lineupAudit,
  selectedTeam: controlledTeam,
  onSelectTeam,
  expanded = false,
  onDeleteSwim: _onDeleteSwim,
  onEditSwim: _onEditSwim,
  onAthleteSelect,
  onRequestDeleteSwimmer,
  workspace,
  onOpenOptimize,
  onWorkspaceUpdate,
  jumpAthleteName,
  jumpAthleteKey,
  onJumpAthleteHandled,
}: Props) {
  const openScoringRules = useOpenScoringRules();
  const toast = useToast();
  // mergeScoringSettings returns a fresh object each call; memoize so the roster-lookup
  // useMemo below (buildScorerRosterLookup ×2 over all genderResults) doesn't rerun on
  // every workspace patch / keystroke that re-renders this panel.
  const merged = useMemo(() => mergeScoringSettings(settings), [settings]);
  const rosterMode = usesScorerRoster(merged);
  // Explicit On, or Auto with PDF place points in the results: the real blocker when Lineup is locked.
  const pdfPlacePointsActive = effectivePdfPlacePointsMode(merged, results);
  const { useDropdown, useSidebar } = resolveTeamPickerMode(showTeamSidebar, teamPickerMode);

  const genderResults = useMemo(
    () => results.filter(r => r.gender == null || r.gender === gender),
    [results, gender]
  );

  // buildAliasResolver walks workspace.athleteAliases; memoize on workspace so
  // it isn't rebuilt on every render (matches mergeScoringSettings discipline above).
  const aliasResolver = useMemo(() => buildAliasResolver(workspace ?? []), [workspace]);

  // Same discipline for the merged history index getAthleteProfile needs per
  // row: rebuilding it is O(workspace history size), and without this memo
  // every visible row redid that full rebuild, every render — expensive for
  // a recruit-heavy workspace with hundreds of imported SwimCloud history rows.
  const mergedAthleteHistory = useMemo(
    () =>
      workspace
        ? mergeHistoryIndex(buildHistoryFromWorkspace(workspace), workspace.athleteHistory ?? [])
        : [],
    [workspace]
  );

  const pointTotals = useMemo(
    () => aggregateSwimmerMeetPoints(scoredResults, gender, aliasResolver),
    [scoredResults, gender, aliasResolver]
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

  const memberCounts = useMemo(
    () => countTeamMembers(genderResults, gender),
    [genderResults, gender]
  );

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
    const autoLookup = buildScorerRosterLookup(genderResults, merged, [], gender, aliasResolver);
    const lookup = buildScorerRosterLookup(genderResults, merged, overrides, gender, aliasResolver);
    return { rows: lookup.rows, autoLookup };
  }, [genderResults, merged, overrides, gender, aliasResolver]);

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

  const activeRowId = activeRosterRowId(selectedAthleteKey, rosterWindow.rows);

  // The drawer closes when its athlete leaves the roster (confirmed Remove). The drawer's Remove
  // button then unmounts, and Modal's focus return had already targeted it, so focus falls to
  // <body>. Hand it to the roster list, the one stable focus stop. Only act when focus is on
  // <body>: if the coach has focus somewhere real, leave it there. An athlete who is still listed
  // (the coach closed the drawer) has no row change here, so this does not fire for that.
  const hadSelectedAthleteRef = useRef(false);
  useEffect(() => {
    const had = hadSelectedAthleteRef.current;
    hadSelectedAthleteRef.current = selectedAthlete !== null;
    if (!had || selectedAthlete !== null || selectedAthleteKey === null) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rosterScrollRef.current?.focus();
  }, [selectedAthlete, selectedAthleteKey]);

  useEffect(() => {
    if (!jumpAthleteName && !jumpAthleteKey) return;
    // Prefer the threaded ScorerRosterRow.key (BUG 1 hardening); fall back to
    // canonical-name matching so "Last, First" ↔ "First Last" still resolves.
    const canonical = jumpAthleteName ? canonicalSwimmerName(jumpAthleteName) : null;
    const row =
      (jumpAthleteKey ? teamRows.find(r => r.key === jumpAthleteKey) : undefined) ??
      (canonical ? teamRows.find(r => canonicalSwimmerName(r.name) === canonical) : undefined);
    if (row) {
      setSelectedAthleteKey(row.key);
      onAthleteSelect?.({ name: row.name, team: row.team, classYear: row.classYear });
      requestAnimationFrame(() => {
        document.getElementById('athlete-lineup-editor')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      });
    } else {
      // Never leave the previously-selected athlete open (BUG 1 primary): a silent
      // no-op here would route the user's edits to the wrong person. Clear + notify.
      setSelectedAthleteKey(null);
      onAthleteSelect?.(null);
      toast.push(
        'info',
        `Could not open ${jumpAthleteName ?? 'that athlete'} on ${selectedTeam || 'this team'}.`
      );
    }
    onJumpAthleteHandled?.();
  }, [jumpAthleteName, jumpAthleteKey, teamRows, onAthleteSelect, onJumpAthleteHandled, selectedTeam, toast]);

  const toggleAthleteSelection = (row: ScorerRosterRow) => {
    if (selectedAthleteKey === row.key) {
      setSelectedAthleteKey(null);
      onAthleteSelect?.(null);
      return;
    }
    setSelectedAthleteKey(row.key);
    onAthleteSelect?.({ name: row.name, team: row.team, classYear: row.classYear });
  };

  // Keyboard-first navigation: select by index into the full (unwindowed) teamRows
  // list, then correct scrollTop directly so the target row is visible even when
  // it falls outside the currently rendered virtualized window.
  const selectAthleteByIndex = useCallback(
    (index: number) => {
      if (!teamRows.length) return;
      const clamped = Math.max(0, Math.min(teamRows.length - 1, index));
      const row = teamRows[clamped];
      setSelectedAthleteKey(row.key);
      onAthleteSelect?.({ name: row.name, team: row.team, classYear: row.classYear });
      const el = rosterScrollRef.current;
      if (el) {
        const rowTop = clamped * ROSTER_ROW_ESTIMATE_PX;
        const rowBottom = rowTop + ROSTER_ROW_ESTIMATE_PX;
        if (rowTop < el.scrollTop) {
          el.scrollTo({ top: rowTop });
        } else if (rowBottom > el.scrollTop + el.clientHeight) {
          el.scrollTo({ top: rowBottom - el.clientHeight });
        }
      }
    },
    [teamRows, onAthleteSelect]
  );

  const handleRosterKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!teamRows.length) return;
      const currentIndex = selectedAthleteKey
        ? teamRows.findIndex(r => r.key === selectedAthleteKey)
        : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectAthleteByIndex(currentIndex < 0 ? 0 : currentIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectAthleteByIndex(currentIndex < 0 ? teamRows.length - 1 : currentIndex - 1);
      } else if (e.key === 'Escape' && selectedAthleteKey) {
        e.preventDefault();
        setSelectedAthleteKey(null);
        onAthleteSelect?.(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && currentIndex >= 0 && e.target === e.currentTarget) {
        // The per-row remove buttons are gone; Delete or Backspace on the list itself asks to
        // remove the selected athlete. The same confirm dialog opens.
        if (editable && onRequestDeleteSwimmer) {
          e.preventDefault();
          onRequestDeleteSwimmer(teamRows[currentIndex].name);
        }
      }
    },
    [teamRows, selectedAthleteKey, selectAthleteByIndex, onAthleteSelect, editable, onRequestDeleteSwimmer]
  );

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
          {pdfPlacePointsActive
            ? 'PDF place points require Points pool eligibility. Set PDF place points to Off in the scoring rules to use the team scorer list.'
            : 'Lineup editing requires Team scorer list eligibility. Change the scorer eligibility setting to continue.'}
        </p>
        <Button className="mt-3" variant="outline" onClick={openScoringRules}>Open scoring rules</Button>
      </div>
    );
  }

  const genderLabel = genderLabelFor(gender);
  const colSpan = rosterColSpan(editable, false);
  const canRemoveAthlete = Boolean(editable && onRequestDeleteSwimmer);

  const rosterTable = (
    <div className={expanded ? 'flex flex-col flex-1 min-h-0' : undefined}>
      <TeamRosterHeader
        selectedTeam={selectedTeam}
        genderLabel={genderLabel}
        editable={editable}
        onOpenOptimize={onOpenOptimize}
        onResetTeam={resetTeamManual}
        canRemoveAthlete={canRemoveAthlete}
        maxIndividualScorersPerTeam={merged.maxIndividualScorersPerTeam}
        selectedActual={selectedActual}
        selectedBaseline={selectedBaseline}
        selectedProjected={selectedProjected}
        eventThrough={officialTeamScores?.eventThrough}
        useDropdown={useDropdown && !hideTeamSelect}
        teams={teams}
        controlledTeam={controlledTeam}
        onSelectTeam={selectTeam}
      />

      <div
        ref={rosterScrollRef}
        onScroll={handleRosterScroll}
        onKeyDown={handleRosterKeyDown}
        tabIndex={teamRows.length ? 0 : -1}
        role="listbox"
        aria-activedescendant={activeRowId}
        aria-label={`Team roster — arrow keys to navigate${canRemoveAthlete ? ', Delete or Backspace to remove' : ''}`}
        className={`overflow-y-auto pr-1 rounded-xl border border-theme-soft custom-scrollbar outline-none ${
          expanded ? 'flex-1 min-h-[20rem]' : 'max-h-80'
        }`}
      >
        <TeamRosterTable
          teams={teams}
          selectedTeam={selectedTeam}
          teamRows={teamRows}
          rosterWindow={rosterWindow}
          colSpan={colSpan}
          editable={editable}
          selectedAthleteKey={selectedAthleteKey}
          pointTotals={pointTotals}
          genderResults={genderResults}
          gender={gender}
          aliasResolver={aliasResolver}
          settings={merged}
          lineupAudit={lineupAudit}
          workspace={workspace}
          mergedAthleteHistory={mergedAthleteHistory}
          onSelectRow={row => {
            toggleAthleteSelection(row);
            rosterScrollRef.current?.focus();
          }}
          onSetScorer={(row, isScorer) => setScorer(row, isScorer)}
        />
      </div>
      {workspace ? (
        <RemovedSwimmersSection
          workspace={workspace}
          gender={gender}
          editable={editable}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />
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

  const drawerAthleteIssues = selectedAthlete
    ? lineupAudit?.athleteIssues.get(normalizeSwimmerName(selectedAthlete.name)) ?? []
    : [];
  const drawerAutoIsScorer = Boolean(
    selectedAthlete && autoLookup.isScorer(selectedAthlete.name, selectedAthlete.team, selectedAthlete.gender)
  );

  // The unified athlete editor is a fixed-position slide-over drawer, not part
  // of the roster table's document flow — render it as a sibling so it isn't
  // clipped by the table's scroll container, regardless of which layout branch
  // (sidebar vs. plain card) is active below.
  const drawer = (
    <AthleteLineupDrawer
      selectedAthlete={selectedAthlete}
      workspace={workspace}
      onWorkspaceUpdate={onWorkspaceUpdate}
      settings={merged}
      gender={gender}
      issues={drawerAthleteIssues}
      scoredResults={scoredResults}
      allResults={results}
      editable={editable}
      onClose={() => {
        setSelectedAthleteKey(null);
        onAthleteSelect?.(null);
      }}
      onRequestRemove={
        canRemoveAthlete && selectedAthlete && onRequestDeleteSwimmer
          ? () => onRequestDeleteSwimmer(selectedAthlete.name)
          : undefined
      }
      autoIsScorer={drawerAutoIsScorer}
    />
  );

  return (
    <TeamRosterLayoutShell
      useSidebar={useSidebar}
      expanded={expanded}
      rosterTable={rosterTable}
      drawer={drawer}
      teams={teams}
      memberCounts={memberCounts}
      projectedByTeam={projectedByTeam}
      officialLookup={officialLookup}
      selectedTeam={selectedTeam}
      onSelectTeam={selectTeam}
    />
  );
}
