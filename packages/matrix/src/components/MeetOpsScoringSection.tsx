/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The scoring half of the Meet step: the suggested-preset banner and the
 * "Edit scoring rules" summary (`ScoringSettingsPanel`), then the official
 * team scores card. It replaces the old Score step. The rules themselves are
 * edited in the shared scoring-rules dialog that "Edit scoring rules" opens.
 */

import type { ScoringSettings, TeamScore } from '@omniswim/core/types';
import ScoringSettingsPanel from './ScoringSettingsPanel';
import { TeamName } from './matrixPresentation';

interface OfficialScoreRow {
  teamName: string;
  score: number;
}

/**
 * Teams that have an official score. `buildTeamScoreLookup` sets a key for
 * every team and leaves the value undefined when the meet published no total,
 * so a key alone does not mean a score exists.
 */
export function officialScoreRows(
  teams: readonly TeamScore[],
  officialLookup: ReadonlyMap<string, number | undefined>
): OfficialScoreRow[] {
  const rows: OfficialScoreRow[] = [];
  for (const team of teams) {
    const score = officialLookup.get(team.teamName);
    if (score != null) rows.push({ teamName: team.teamName, score });
  }
  return rows;
}

interface MeetOpsScoringSectionProps {
  scoringSettings: ScoringSettings;
  suggestedPresetId: string | null;
  onSaveScoringSettings: (sets: ScoringSettings) => void;
  onClearSuggestedPreset: () => void;
  officialLookup: ReadonlyMap<string, number | undefined>;
  teamsWithLineStyles: TeamScore[];
}

export function MeetOpsScoringSection({
  scoringSettings,
  suggestedPresetId,
  onSaveScoringSettings,
  onClearSuggestedPreset,
  officialLookup,
  teamsWithLineStyles,
}: MeetOpsScoringSectionProps) {
  const officialRows = officialScoreRows(teamsWithLineStyles, officialLookup);
  return (
    <>
      <ScoringSettingsPanel
        settings={scoringSettings}
        suggestedPresetId={suggestedPresetId}
        onSave={sets => {
          onSaveScoringSettings(sets);
          onClearSuggestedPreset();
        }}
      />
      {officialRows.length > 0 ? (
        <div className="surface-card rounded-xl overflow-hidden">
          <div className="p-4 border-b border-theme-soft surface-overlay">
            <h4 className="text-ui-label font-medium text-theme-secondary uppercase tracking-widest">Official team scores</h4>
          </div>
          <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3 surface-overlay">
            {officialRows.map(row => (
              <div key={row.teamName} className="surface-card px-4 py-3 flex items-center justify-between gap-3">
                <TeamName name={row.teamName} />
                <span className="font-mono font-bold text-[var(--text-primary)]">{row.score.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
