/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, Users } from 'lucide-react';
import { Gender, Recruit, Workspace } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import { usesScorerRoster, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { countWorkingCopyChanges } from '@omniswim/core/lib/workingCopyChanges';
import {
  removeAthleteFromWorkspace,
  softRemoveSwimmerFromWorkspace,
} from '@omniswim/core/lib/swimmerSoftRemove';
import { ScoringSettledContext, useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { exportEntriesCsv, exportEntriesHytek, type EntryExport } from '@omniswim/core/lib/entryExport';
import { rosterCatalogApi, type CatalogTeamRoster } from '@omniswim/core/api/rosterCatalog';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { EmptyState, useToast } from '@omniswim/ui';
import TeamManagementView from './components/TeamManagementView';
import SwimmerDeleteConfirmModal from './components/SwimmerDeleteConfirmModal';
import RosterImportWizard from './components/RosterImportWizard';
import RosterCatalogPanel from './components/RosterCatalogPanel';
import BatchOptimizerPanel from './components/BatchOptimizerPanel';

/** Human-readable breakdown for the "Modified copy" badge's title/aria-label, e.g. "2 recruits, 1 removal". */
function workingCopyChangeSummary(counts: ReturnType<typeof countWorkingCopyChanges>): string {
  const parts: string[] = [];
  const push = (n: number, singular: string, plural: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
  };
  push(counts.recruits, 'recruit', 'recruits');
  push(counts.removals, 'removal', 'removals');
  push(counts.rosterOverrides, 'roster override', 'roster overrides');
  push(counts.relayLegOverrides, 'relay leg override', 'relay leg overrides');
  push(counts.plannedEntries, 'planned entry', 'planned entries');
  const summary = parts.length ? parts.join(', ') : 'no changes';
  // Stale relay leg overrides match no entry in either gender, so they are kept
  // out of the badge total. Mention them here rather than dropping them
  // silently — an edit that scores nothing is still worth surfacing.
  if (counts.unresolvedRelayLegOverrides > 0) {
    const n = counts.unresolvedRelayLegOverrides;
    return `${summary} (plus ${n} unmatched relay leg ${n === 1 ? 'override' : 'overrides'})`;
  }
  return summary;
}

function downloadExport(exp: EntryExport) {
  const blob = new Blob([exp.content], { type: exp.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exp.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ManagerApp() {
  const { activeWorkspace, activeGender, updateWorkspace } = useSuiteWorkspace();
  const toast = useToast();
  const [removeSeniors, setRemoveSeniors] = useState(false);
  const [whatIfMode, setWhatIfMode] = useState(true);
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showBatchOptimizer, setShowBatchOptimizer] = useState(false);
  const [showCatalogView, setShowCatalogView] = useState(false);
  const [catalogInfo, setCatalogInfo] = useState<{ team?: string; gender?: Gender } | null>(null);
  const [catalogRoster, setCatalogRoster] = useState<CatalogTeamRoster | null>(null);
  const [catalogRankedTeam, setCatalogRankedTeam] = useState<{
    team: string;
    gender: Gender;
  } | null>(null);
  const [swimmerDeleteCandidate, setSwimmerDeleteCandidate] = useState<{ name: string } | null>(null);

  // Working-copy change count for the persistent "Modified copy" badge — a pure
  // tally of the edits (recruits, removals, overrides, plans) that make the
  // projection differ from the loaded meet. Recomputed only when the workspace
  // or active gender changes.
  const workingCopyChanges = useMemo(
    () => (activeWorkspace ? countWorkingCopyChanges(activeWorkspace, activeGender) : null),
    [activeWorkspace, activeGender]
  );

  // Load the catalog roster lazily — only re-fetches when the user opens
  // the panel or toggles the catalog team to score.
  useEffect(() => {
    if (!showCatalogView) return;
    let cancelled = false;
    (async () => {
      try {
        const teams = await rosterCatalogApi.listTeams();
        if (cancelled) return;
        if (teams.length === 0) {
          setCatalogRoster(null);
          setCatalogInfo({ team: undefined, gender: activeGender });
          return;
        }
        const preferred =
          teams.find(t => t.gender === (activeGender === Gender.WOMEN ? 'Women' : 'Men')) ?? teams[0];
        const gender = preferred.gender === 'Women' ? Gender.WOMEN : Gender.MEN;
        const roster = await rosterCatalogApi.getRoster(preferred.id);
        if (cancelled) return;
        setCatalogRoster(roster);
        setCatalogInfo({ team: preferred.name, gender });
        setCatalogRankedTeam({ team: preferred.name, gender });
      } catch (err) {
        if (!cancelled) {
          setCatalogInfo({ team: undefined, gender: activeGender });
        }
        void err;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showCatalogView, activeGender]);

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={<Users size={28} />}
        eyebrow="Manager"
        title="Create a workspace to build your roster"
        description="Manager needs a workspace before it can import swimmers, tune scorer eligibility, or plan entries."
      />
    );
  }

  // Scoring bundle (with optional catalog rotation). The catalog is opt-in:
  // only when the user picks a catalog team from the new toolbar button does
  // the roster flow through `buildCategorizedScoringInputs`.
  const useCatalog = Boolean(catalogRankedTeam && catalogRoster);
  const {
    projected,
    baselineByTeam,
    scoringSettings,
    scoringSettled,
    prelimsByTeam,
    psychByTeam,
  } = useWorkspaceScoring({
    workspace: activeWorkspace,
    gender: useCatalog ? catalogRankedTeam!.gender : activeGender,
    removeSeniors,
    scoringRefreshKey,
    rosterCatalog: useCatalog ? catalogRoster ?? undefined : undefined,
  });

  const handleAddRecruit = (recruit: Recruit) => {
    const settings = mergeScoringSettings(activeWorkspace.scoringSettings, {
      conference: activeWorkspace.conference,
    });
    const nextRecruits = [...(activeWorkspace.recruits ?? []), recruit];
    const patch: Partial<Workspace> = { recruits: nextRecruits };

    if (usesScorerRoster(settings)) {
      const key = scorerRosterKey(recruit.team, recruit.gender, recruit.name);
      const rest = (activeWorkspace.scorerRosterOverrides ?? []).filter(
        o => scorerRosterKey(o.team, o.gender, o.name) !== key
      );
      patch.scorerRosterOverrides = [
        ...rest,
        { name: recruit.name, team: recruit.team, gender: recruit.gender, isScorer: true },
      ];
    }

    void updateWorkspace(patch);
  };

  const handleExport = (kind: 'csv' | 'hytek') => {
    const exp = kind === 'csv' ? exportEntriesCsv(activeWorkspace) : exportEntriesHytek(activeWorkspace);
    if (exp.count === 0) {
      toast.push('info', 'No active meet entries to export. Add entries in the planner first.');
      return;
    }
    downloadExport(exp);
    toast.push('success', `Exported ${exp.count} entr${exp.count === 1 ? 'y' : 'ies'} → ${exp.filename}`);
  };

  const hideSwimmer = () => {
    if (!swimmerDeleteCandidate) return;
    const patch = softRemoveSwimmerFromWorkspace(activeWorkspace, {
      name: swimmerDeleteCandidate.name,
      gender: activeGender,
    });
    void updateWorkspace(patch);
    toast.push('info', `${swimmerDeleteCandidate.name} hidden from What-if projection.`);
    setSwimmerDeleteCandidate(null);
  };

  const removeSwimmer = () => {
    if (!swimmerDeleteCandidate) return;
    const { patch, description } = removeAthleteFromWorkspace(activeWorkspace, {
      name: swimmerDeleteCandidate.name,
      gender: activeGender,
    });
    void updateWorkspace(patch);
    toast.push('success', `${description} — Restore in the roster panel to undo.`);
    setSwimmerDeleteCandidate(null);
  };

  return (
    <ScoringSettledContext.Provider value={scoringSettled}>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center mb-5">
        <div className="min-w-0">
          <h2 className="text-heading-2">
            Team management
          </h2>
          <p className="text-ui-caption text-theme-muted mt-0.5">
            Roster workflow · Source → Lineup → Relays → Optimize
          </p>
        </div>
        {/* Reserved-width live region: mounts/unmounts only its inner content
            so screen readers announce settle via aria-live, while the fixed
            min-width keeps neighboring header controls from shifting. */}
        <span
          aria-live="polite"
          className="inline-flex items-center gap-1.5 min-w-[8.5rem] text-ui-caption text-theme-muted"
        >
          {!scoringSettled ? (
            <>
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              <span>Recalculating…</span>
            </>
          ) : null}
        </span>
        {/* Persistent modified-copy indicator — a signal, not a control. Same
            reserved-width trick as the live region above: the wrapper span
            always occupies its slot in the flex row, only the badge inside
            mounts/unmounts, so neighboring header controls never shift when
            edits are made or a fresh meet loads. Blank (not shown) at 0. */}
        <span className="inline-flex items-center min-w-[10rem]">
          {workingCopyChanges && workingCopyChanges.total > 0 ? (
            <span
              className="badge-warning inline-flex items-center px-2 py-0.5 rounded-full text-ui-caption font-medium whitespace-nowrap"
              title={workingCopyChangeSummary(workingCopyChanges)}
              aria-label={`Modified copy: ${workingCopyChangeSummary(workingCopyChanges)}`}
            >
              Modified copy · {workingCopyChanges.total} {workingCopyChanges.total === 1 ? 'change' : 'changes'}
            </span>
          ) : null}
        </span>
        <div className="sm:ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleExport('csv')}
            className="px-3 py-2 text-ui-label rounded-lg nav-tab-inactive hover:text-[var(--text-primary)] border border-theme-soft transition-colors whitespace-nowrap"
            title="Export active meet entries as CSV"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => handleExport('hytek')}
            className="px-3 py-2 text-ui-label rounded-lg nav-tab-inactive hover:text-[var(--text-primary)] border border-theme-soft transition-colors whitespace-nowrap"
            title="Export active meet entries as HyTek-style entry list"
          >
            Export HyTek
          </button>
          <button
            type="button"
            onClick={() => setShowBatchOptimizer(true)}
            className="px-3 py-2 text-ui-label rounded-lg border border-theme-soft theme-hover-row hover:text-[var(--text-accent)] transition-colors whitespace-nowrap"
            title="Run batch optimizer across all teams"
          >
            Batch optimizer
          </button>
          <button
            type="button"
            onClick={() => setShowCatalogView(true)}
            className="px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md border border-theme-soft theme-hover-row hover:text-[var(--text-accent)] transition-colors"
            title="Manage the long-lived Team Roster Catalog"
            data-testid="open-roster-catalog"
          >
            Team Catalog
          </button>
          <button
            type="button"
            onClick={() => setShowImportWizard(true)}
            className="px-3 py-2 text-ui-label font-semibold rounded-lg btn-primary transition-colors whitespace-nowrap"
          >
            Import roster
          </button>
        </div>
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={`roster-${scoringRefreshKey}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          <TeamManagementView
            workspace={activeWorkspace}
            gender={activeGender}
            scoringBundle={projected}
            baselineByTeam={baselineByTeam}
            scoringSettings={scoringSettings}
            whatIfMode={whatIfMode}
            onWhatIfModeChange={setWhatIfMode}
            removeSeniors={removeSeniors}
            onRemoveSeniorsChange={setRemoveSeniors}
            onReloadScoring={() => setScoringRefreshKey(k => k + 1)}
            onAddRecruit={handleAddRecruit}
            onUpdate={updateWorkspace}
            onOpenImportWizard={() => setShowImportWizard(true)}
            onRequestDeleteSwimmer={
              whatIfMode ? name => setSwimmerDeleteCandidate({ name }) : undefined
            }
          />
        </motion.div>
      </AnimatePresence>
      {showImportWizard && (
        <RosterImportWizard
          workspace={activeWorkspace}
          gender={activeGender}
          onClose={() => setShowImportWizard(false)}
          onUpdate={updateWorkspace}
        />
      )}
      {showBatchOptimizer && (
        <BatchOptimizerPanel
          workspace={activeWorkspace}
          gender={activeGender}
          scoringSettings={scoringSettings}
          onApply={patch => {
            void updateWorkspace(patch);
            toast.push('success', 'Optimizer lineup applied');
            setShowBatchOptimizer(false);
          }}
          onClose={() => setShowBatchOptimizer(false)}
        />
      )}
      {showCatalogView && (
        <RosterCatalogPanel
          onClose={() => setShowCatalogView(false)}
          defaultTeamName={
            (activeWorkspace.menResults?.[0]?.team ??
              activeWorkspace.womenResults?.[0]?.team ??
              '') as string
          }
        />
      )}
      {swimmerDeleteCandidate && (
        <SwimmerDeleteConfirmModal
          swimmerName={swimmerDeleteCandidate.name}
          gender={activeGender}
          onHide={hideSwimmer}
          onRemove={removeSwimmer}
          onCancel={() => setSwimmerDeleteCandidate(null)}
        />
      )}
    </ScoringSettledContext.Provider>
  );
}
