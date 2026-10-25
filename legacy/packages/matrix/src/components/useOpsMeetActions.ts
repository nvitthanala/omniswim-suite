/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Gender, Workspace } from '@omniswim/core/types';
import { meetCopyFromParsed } from '@omniswim/core/lib/meetSource';
import { softRemoveSwimmerFromWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';
import {
  readStoredMatrixStep,
  resolveInitialMatrixStep,
  writeStoredMatrixStep,
  type MatrixStepId,
} from './matrixStepState';
import { hasEntries, type OpsImportContext } from './opsModuleHelpers';

/**
 * The active wizard step, persisted per workspace. A stored 'load' or
 * 'score' (from before Phase 5) resolves to 'meet'; the effect then writes
 * the current id back.
 */
export function useMatrixStep(workspace: Workspace) {
  const [step, setStep] = useState<MatrixStepId>(() =>
    resolveInitialMatrixStep(readStoredMatrixStep(workspace.id), Boolean(workspace.loadedMeet))
  );
  useEffect(() => { writeStoredMatrixStep(workspace.id, step); }, [workspace.id, step]);
  return { step, setStep };
}

/** The confirm-then-soft-remove flow for one swimmer. */
export function useSwimmerDeleteFlow(
  workspace: Workspace,
  gender: Gender,
  onUpdate: (updated: Partial<Workspace>) => void | Promise<void>
) {
  const [swimmerDeleteCandidate, setSwimmerDeleteCandidate] = useState<{ name: string } | null>(null);

  const confirmDeleteSwimmer = () => {
    if (!swimmerDeleteCandidate) return;
    const patch = softRemoveSwimmerFromWorkspace(workspace, {
      name: swimmerDeleteCandidate.name,
      gender,
    });
    void onUpdate(patch);
    setSwimmerDeleteCandidate(null);
  };

  return { swimmerDeleteCandidate, setSwimmerDeleteCandidate, confirmDeleteSwimmer };
}

/** Copies the loaded meet and psych sheet from another workspace. */
export function useCopyMeetFromWorkspace(ctx: OpsImportContext, workspaces: Workspace[]) {
  const { workspace, onUpdate, toast, bumpScoringRefresh } = ctx;

  return (sourceId: string) => {
    const source = workspaces.find(candidate => candidate.id === sourceId);
    if (!source) return;

    // This overwrites the current meet AND its frozen source copy, which is what
    // soft-remove restore rebuilds from. Two guards, because there is no undo:
    //
    // 1. Copying from a workspace with no meet would blank this one silently.
    //    That is data loss dressed up as a copy, so refuse it outright.
    const sourceHasMeet = hasEntries(source.menResults) || hasEntries(source.womenResults);
    if (!sourceHasMeet) {
      toast.push('error', `${source.name} has no loaded meet to copy`);
      return;
    }

    // 2. Overwriting a meet that is already loaded is destructive and easy to
    //    trigger from a single select change, so make it deliberate.
    const targetHasMeet = hasEntries(workspace.menResults) || hasEntries(workspace.womenResults);
    if (targetHasMeet) {
      const current = workspace.loadedMeet?.pdfFilename ?? 'the loaded meet';
      const ok = window.confirm(
        `Replace ${current} with the meet from "${source.name}"?\n\n` +
          'This also replaces the frozen source copy this workspace restores removed swimmers from. It cannot be undone.'
      );
      if (!ok) return;
    }

    void onUpdate({
      ...meetCopyFromParsed(source.menResults ?? [], source.womenResults ?? []),
      loadedMeet: source.loadedMeet,
      psychMenResults: source.psychMenResults,
      psychWomenResults: source.psychWomenResults,
      loadedPsych: source.loadedPsych,
      officialTeamScores: source.officialTeamScores,
      conference: source.conference,
    });
    bumpScoringRefresh();
    toast.push('success', `Copied meet and psych sheet from ${source.name}`);
  };
}
