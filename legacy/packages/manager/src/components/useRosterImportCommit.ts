/**
 * The commit half of `RosterImportWizard`: merge or replace the previewed
 * swims into the workspace, with the replace confirm dialog state.
 */
import { useMemo, useState } from 'react';
import {
  formatHistoryImportSummary,
  previewSwimCloudReplace,
  SwimCloudReplaceRefusedError,
} from '@omniswim/core/lib/historyImportRoster';
import { backupWorkspaces } from '@omniswim/core/api/workspaces';
import type { Workspace } from '@omniswim/core/types';
import { performSwimCloudImport, type SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import type { RosterImportDeps } from './useRosterImportState';

export function useRosterImportCommit(
  { s, workspace, gender, toast }: RosterImportDeps,
  onClose: () => void,
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>
) {
  const { team, preview, importMode, mode, format } = s;
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [replaceBusy, setReplaceBusy] = useState(false);

  /** Returns whether the import committed, so a confirm dialog knows whether it can close. */
  const runImport = async (importOpts: { mode: SwimCloudImportMode }): Promise<boolean> => {
    let backedUp = true;
    try {
      const result = await performSwimCloudImport(
        workspace,
        preview,
        {
          team: team.trim(),
          gender,
          sourceType: mode === 'csv' ? 'csv_import' : 'swimcloud_paste',
          sourceLabel: `${format} import (${team})`,
          mode: importOpts.mode,
        },
        {
          backup: async () => {
            try {
              await backupWorkspaces();
            } catch (err) {
              backedUp = false;
              throw err;
            }
          },
        }
      );
      if (result.noop) return true;
      await onUpdate(result.patch);
      toast.push('success', formatHistoryImportSummary(result.summary));
      onClose();
      return true;
    } catch (err) {
      if (err instanceof SwimCloudReplaceRefusedError) {
        toast.push('error', err.message);
        return false;
      }
      if (!backedUp) {
        toast.push(
          'error',
          `Could not back up the workspace, so the replace was not run: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
      toast.push('error', `Import failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const handleMerge = async () => {
    if (preview.length === 0 || !team.trim()) return;
    if (importMode === 'replace') {
      setShowReplaceConfirm(true);
      return;
    }
    await runImport({ mode: 'merge' });
  };

  const handleConfirmReplace = async () => {
    setReplaceBusy(true);
    const committed = await runImport({ mode: 'replace' });
    setReplaceBusy(false);
    // Left open on failure (a refusal or a failed backup) so the coach can
    // see why and retry, rather than losing the dialog mid-error.
    if (committed) setShowReplaceConfirm(false);
  };

  const replacePreview = useMemo(
    () =>
      importMode === 'replace' && team.trim() && preview.length > 0
        ? previewSwimCloudReplace(workspace, preview, { team: team.trim(), gender })
        : null,
    [importMode, workspace, preview, team, gender]
  );

  return {
    showReplaceConfirm,
    setShowReplaceConfirm,
    replaceBusy,
    replacePreview,
    handleMerge,
    handleConfirmReplace,
  };
}
