/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Gender, Recruit, Workspace } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import { usesScorerRoster, scorerRosterKey } from '@omniswim/core/lib/scorerRoster';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { exportEntriesCsv, exportEntriesHytek, type EntryExport } from '@omniswim/core/lib/entryExport';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { Toolbar, ToolbarSpacer, useToast } from '@omniswim/ui';
import TeamManagementSubTabs, { type TeamManagementViewId } from './components/TeamManagementSubTabs';
import TeamManagementView from './components/TeamManagementView';
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
  const [teamMgmtView, setTeamMgmtView] = useState<TeamManagementViewId>('roster');
  const [removeSeniors, setRemoveSeniors] = useState(false);
  const [whatIfMode, setWhatIfMode] = useState(true);
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showBatchOptimizer, setShowBatchOptimizer] = useState(false);

  if (!activeWorkspace) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-theme-secondary">
        <p className="text-ui-body font-medium">Select or create a workspace to use Manager</p>
      </div>
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

  return (
    <>
      <header className="mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-ui-label font-bold text-[var(--text-primary)]">Team management</h2>
          <TeamManagementSubTabs activeView={teamMgmtView} onViewChange={setTeamMgmtView} />
        </div>
        <Toolbar>
          <button type="button" onClick={() => setShowImportWizard(true)} className="btn-primary text-ui-caption px-4 py-2">
            Import roster
          </button>
          <button type="button" onClick={() => setShowBatchOptimizer(true)} className="btn-secondary text-ui-caption">
            Batch optimizer
          </button>
          <button type="button" onClick={() => handleExport('csv')} className="btn-ghost text-ui-caption">
            Export CSV
          </button>
          <button type="button" onClick={() => handleExport('hytek')} className="btn-ghost text-ui-caption">
            Export HyTek
          </button>
          <ToolbarSpacer />
          {activeWorkspace.loadedMeet?.pdfFilename ? (
            <span className="text-ui-caption text-theme-muted truncate max-w-xs">
              Meet: <span className="text-[var(--text-primary)]">{activeWorkspace.loadedMeet.pdfFilename}</span>
            </span>
          ) : null}
        </Toolbar>
      </header>

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
            onOpenImport={() => setShowImportWizard(true)}
            onOpenBatchOptimizer={() => setShowBatchOptimizer(true)}
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
            setShowBatchOptimizer(false);
          }}
          onClose={() => setShowBatchOptimizer(false)}
        />
      )}
    </>
  );
}
