/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The unified athlete editor drawer TeamRosterPanel renders as a fixed-position
 * slide-over — not part of the roster table's document flow, so it must render
 * as a sibling regardless of which layout branch (sidebar vs. plain card) is
 * active. Split out so the panel body isn't where this gating lives.
 */
import type { Gender, ScoringSettings, SwimmerResult, Workspace } from '@omniswim/core/types';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import type { LineupAthleteIssue } from '@omniswim/core/lib/rosterLineupAudit';
import AthleteLineupEditorPanel from './AthleteLineupEditorPanel';

type Props = {
  selectedAthlete: ScorerRosterRow | null;
  workspace?: Workspace;
  onWorkspaceUpdate?: (patch: Partial<Workspace>) => void;
  settings: ScoringSettings;
  gender: Gender;
  issues: LineupAthleteIssue[];
  scoredResults: SwimmerResult[];
  allResults: SwimmerResult[];
  editable: boolean;
  onClose: () => void;
  autoIsScorer: boolean;
};

export default function AthleteLineupDrawer({
  selectedAthlete,
  workspace,
  onWorkspaceUpdate,
  settings,
  gender,
  issues,
  scoredResults,
  allResults,
  editable,
  onClose,
  autoIsScorer,
}: Props) {
  if (!selectedAthlete || !workspace || !onWorkspaceUpdate) return null;

  return (
    <AthleteLineupEditorPanel
      workspace={workspace}
      settings={settings}
      gender={gender}
      athlete={selectedAthlete}
      issues={issues}
      scoredResults={scoredResults}
      allResults={allResults}
      editable={editable}
      onUpdate={onWorkspaceUpdate}
      onClose={onClose}
      autoIsScorer={autoIsScorer}
    />
  );
}
