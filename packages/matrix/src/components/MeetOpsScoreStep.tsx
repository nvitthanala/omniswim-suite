/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `MeetOperationsView`'s "score" step: the scoring-settings panel plus the
 * optional "Official team scores" card (shown once a meet publishes team
 * totals `officialLookup` can resolve). Pure extraction from
 * `MeetOperationsView.tsx` — no behavior change.
 */

import type { ScoringSettings, TeamScore, Workspace } from '@omniswim/core/types';
import ScoringSettingsPanel from './ScoringSettingsPanel';
import { TeamName } from './matrixPresentation';

interface MeetOpsScoreStepProps {
  scoringSettings: ScoringSettings;
  suggestedPresetId: string | null;
  onSaveScoringSettings: (sets: ScoringSettings) => void;
  onClearSuggestedPreset: () => void;
  scoringView: Workspace['scoringView'];
  onScoringViewChange: (view: 'merged' | 'pdf_only') => void;
  conference?: string;
  officialLookup: Map<string, number | undefined>;
  teamsWithLineStyles: TeamScore[];
}

export function MeetOpsScoreStep({
  scoringSettings,
  suggestedPresetId,
  onSaveScoringSettings,
  onClearSuggestedPreset,
  scoringView,
  onScoringViewChange,
  conference,
  officialLookup,
  teamsWithLineStyles,
}: MeetOpsScoreStepProps) {
  return (
    <>
      <div>
        <h4 className="text-heading-2">Configure scoring model</h4>
        <p className="mt-1 text-ui-body text-theme-secondary">Select a preset or adjust how entries earn points.</p>
      </div>
      <ScoringSettingsPanel
        collapsible
        defaultOpen
        settings={scoringSettings}
        suggestedPresetId={suggestedPresetId}
        onSave={sets => {
          onSaveScoringSettings(sets);
          onClearSuggestedPreset();
        }}
        scoringView={scoringView ?? 'merged'}
        onScoringViewChange={onScoringViewChange}
        conference={conference}
      />
      {officialLookup.size > 0 ? (
        <div className="surface-card rounded-xl overflow-hidden">
          <div className="p-4 border-b border-theme-soft surface-overlay">
            <h4 className="text-ui-label font-medium text-theme-secondary uppercase tracking-widest">Official team scores</h4>
          </div>
          <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3 surface-overlay">
            {teamsWithLineStyles
              .filter(team => officialLookup.has(team.teamName))
              .map(team => (
                <div key={team.teamName} className="surface-card px-4 py-3 flex items-center justify-between gap-3">
                  <TeamName name={team.teamName} />
                  <span className="font-mono font-bold text-[var(--text-primary)]">{officialLookup.get(team.teamName)?.toFixed(1)}</span>
                </div>
              ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
