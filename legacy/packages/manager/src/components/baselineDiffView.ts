/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Pure view-model helpers for BaselineDiffPanel.
 */

import type { Gender, ScoringSettings, Workspace } from '@omniswim/core/types';

export type DiffInputs = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  scoringSettings: ScoringSettings;
};

export function matchesInputs(inputs: DiffInputs | null, current: DiffInputs): boolean {
  if (!inputs) return false;
  return (
    inputs.workspace === current.workspace &&
    inputs.gender === current.gender &&
    inputs.team === current.team &&
    inputs.scoringSettings === current.scoringSettings
  );
}

/** Which block the panel body should render. The four cases are mutually
 * exclusive in practice (loading always clears the current result first), so
 * a guard-clause chain reflects the real state machine instead of the four
 * independent AND-chains the JSX used to test separately. */
export type DiffViewState = 'no-team' | 'calculating' | 'result' | 'idle';

export function resolveDiffViewState(params: {
  hasTeam: boolean;
  expanded: boolean;
  loading: boolean;
  hasCurrentResult: boolean;
}): DiffViewState {
  const { hasTeam, expanded, loading, hasCurrentResult } = params;
  if (!hasTeam) return 'no-team';
  if (!expanded) return 'idle';
  if (loading) return 'calculating';
  if (hasCurrentResult) return 'result';
  return 'idle';
}
