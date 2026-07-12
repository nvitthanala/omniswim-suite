/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Users } from 'lucide-react';
import { Gender, Recruit, Workspace } from '@omniswim/core/types';
import { normalizeSwimmerName, mergeScoringSettings } from '@omniswim/core/lib/utils';
import { usesScorerRoster, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { exportEntriesCsv, exportEntriesHytek, type EntryExport } from '@omniswim/core/lib/entryExport';
import { rosterCatalogApi, type CatalogTeamRoster } from '@omniswim/core/api/rosterCatalog';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { EmptyState, useToast } from '@omniswim/ui';
import TeamManagementSubTabs, { type TeamManagementViewId } from './components/TeamManagementSubTabs';
import TeamManagementView from './components/TeamManagementView';
import SwimmerDeleteConfirmModal from './components/SwimmerDeleteConfirmModal';
import RosterImportWizard from './components/RosterImportWizard';
import RosterCatalogPanel from './components/RosterCatalogPanel';
import BatchOptimizerPanel from './components/BatchOptimizerPanel';

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
  const [teamMgmtView, setTeamMgmtView] = useState<TeamManagementViewId>('roster');
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
  const { projected, baselineByTeam, scoringSettings, prelimsByTeam, psychByTeam } = useWorkspaceScoring({
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

  const confirmDeleteSwimmer = () => {
    if (!swimmerDeleteCandidate) return;
    const name = swimmerDeleteCandidate.name;
    const key = normalizeSwimmerName(name);
    const field = activeGender === Gender.MEN ? 'menResults' : 'womenResults';
    const arr = activeWorkspace[field] ?? [];
    const filtered = arr.filter(r => !(normalizeSwimmerName(r.name) === key && !r.isRelay));
    const nextDeleted = [...(activeWorkspace.deletedSwimmers ?? [])];
    if (!nextDeleted.some(d => d.gender === activeGender && normalizeSwimmerName(d.name) === key)) {
      nextDeleted.push({ name, gender: activeGender });
    }
    const recruitsFiltered = (activeWorkspace.recruits ?? []).filter(
      r => !(r.gender === activeGender && normalizeSwimmerName(r.name) === key)
    );
    void updateWorkspace({ [field]: filtered, recruits: recruitsFiltered, deletedSwimmers: nextDeleted });
    setSwimmerDeleteCandidate(null);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h2 className="text-ui-label font-black uppercase tracking-widest text-[var(--text-primary)]">
          Team Management
        </h2>
        <TeamManagementSubTabs activeView={teamMgmtView} onViewChange={setTeamMgmtView} />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleExport('csv')}
            className="px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md nav-tab-inactive hover:text-[var(--text-primary)] border border-theme-soft transition-colors"
            title="Export active meet entries as CSV"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => handleExport('hytek')}
            className="px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md nav-tab-inactive hover:text-[var(--text-primary)] border border-theme-soft transition-colors"
            title="Export active meet entries as HyTek-style entry list"
          >
            Export HyTek
          </button>
          <button
            type="button"
            onClick={() => setShowBatchOptimizer(true)}
            className="px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md border border-theme-soft theme-hover-row hover:text-[var(--text-accent)] transition-colors"
            title="Run batch optimizer across all teams"
          >
            Batch Optimizer
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
            className="px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md btn-primary transition-colors"
          >
            Import Roster
          </button>
        </div>
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key={`${teamMgmtView}-${scoringRefreshKey}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          <TeamManagementView
            view={teamMgmtView}
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
          onConfirm={confirmDeleteSwimmer}
          onCancel={() => setSwimmerDeleteCandidate(null)}
        />
      )}
    </>
  );
}
