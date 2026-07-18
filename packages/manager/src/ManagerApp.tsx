/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Users } from 'lucide-react';
import { Recruit, Workspace } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import { usesScorerRoster, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { softRemoveSwimmerFromWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { exportEntriesCsv, exportEntriesHytek, type EntryExport } from '@omniswim/core/lib/entryExport';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { EmptyState, useToast } from '@omniswim/ui';
import TeamManagementView from './components/TeamManagementView';
import SwimmerDeleteConfirmModal from './components/SwimmerDeleteConfirmModal';
import RosterImportWizard from './components/RosterImportWizard';
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
  const [removeSeniors, setRemoveSeniors] = useState(false);
  const [whatIfMode, setWhatIfMode] = useState(true);
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showBatchOptimizer, setShowBatchOptimizer] = useState(false);
  const [swimmerDeleteCandidate, setSwimmerDeleteCandidate] = useState<{ name: string } | null>(null);

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

  const { projected, baselineByTeam, scoringSettings } = useWorkspaceScoring({
    workspace: activeWorkspace,
    gender: activeGender,
    removeSeniors,
    scoringRefreshKey,
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
    const patch = softRemoveSwimmerFromWorkspace(activeWorkspace, {
      name: swimmerDeleteCandidate.name,
      gender: activeGender,
    });
    void updateWorkspace(patch);
    setSwimmerDeleteCandidate(null);
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center mb-5">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            Team management
          </h2>
          <p className="text-ui-caption text-theme-muted mt-0.5">
            Roster workflow · Source → Lineup → Relays → Optimize
          </p>
        </div>
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
