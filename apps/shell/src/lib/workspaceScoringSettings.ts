import { useMemo } from 'react';
import type { Workspace } from '@omniswim/core/types';
import { effectivePdfPlacePointsMode, mergeScoringSettings, resultsHavePdfPlacePoints } from '@omniswim/core/lib/scoringDefaults';

export function workspacePdfPlacePointsLocked(workspace: Workspace): boolean {
  const settings = mergeScoringSettings(workspace.scoringSettings, { conference: workspace.conference });
  return effectivePdfPlacePointsMode(settings, [
    ...(workspace.menResults ?? []),
    ...(workspace.womenResults ?? []),
    ...(workspace.psychMenResults ?? []),
    ...(workspace.psychWomenResults ?? []),
  ]);
}

/** True when the workspace's results carry HyTek place points, whatever the saved setting says. */
export function workspaceResultsCarryPdfPlacePoints(workspace: Workspace): boolean {
  return resultsHavePdfPlacePoints([
    ...(workspace.menResults ?? []),
    ...(workspace.womenResults ?? []),
    ...(workspace.psychMenResults ?? []),
    ...(workspace.psychWomenResults ?? []),
  ]);
}

export function workspaceScoringSettings(workspace: Workspace) {
  return mergeScoringSettings(workspace.scoringSettings, {
    conference: workspace.conference,
    resultsForPdfHint: [
      ...(workspace.menResults ?? []),
      ...(workspace.womenResults ?? []),
      ...(workspace.psychMenResults ?? []),
      ...(workspace.psychWomenResults ?? []),
    ],
  });
}

/**
 * Props for the scoring-rules dialog, stable across renders. The settings
 * object keeps its identity until a field the helpers read changes, so a
 * parent re-render (a toast, a toggle) cannot hand the dialog a new object
 * and wipe the coach's unsaved edits.
 */
export function useWorkspaceScoringDialogProps(workspace: Workspace | null | undefined) {
  const scoringSettings = workspace?.scoringSettings;
  const conference = workspace?.conference;
  const menResults = workspace?.menResults;
  const womenResults = workspace?.womenResults;
  const psychMenResults = workspace?.psychMenResults;
  const psychWomenResults = workspace?.psychWomenResults;
  return useMemo(() => {
    if (!workspace) return null;
    return {
      settings: workspaceScoringSettings(workspace),
      pdfPlacePointsLocked: workspacePdfPlacePointsLocked(workspace),
      /** Additive: lets the dialog resolve a draft Auto before anything is saved. */
      resultsCarryPdfPlacePoints: workspaceResultsCarryPdfPlacePoints(workspace),
    };
    // The helpers read exactly these fields; `workspace` identity itself changes on unrelated edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoringSettings, conference, menResults, womenResults, psychMenResults, psychWomenResults]);
}
