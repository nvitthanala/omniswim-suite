import type { Workspace } from '@omniswim/core/types';
import { effectivePdfPlacePointsMode, mergeScoringSettings } from '@omniswim/core/lib/scoringDefaults';

export function workspacePdfPlacePointsLocked(workspace: Workspace): boolean {
  const settings = mergeScoringSettings(workspace.scoringSettings, { conference: workspace.conference });
  return effectivePdfPlacePointsMode(settings, [
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
