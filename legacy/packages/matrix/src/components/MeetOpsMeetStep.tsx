/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `MeetOperationsView`'s "meet" step: the files card (`MeetOpsLoadStep`) and
 * the scoring section (`MeetOpsScoringSection`) on one screen. Scoring used to
 * be its own step. Every scoring field is still reached from here through the
 * "Edit scoring rules" button.
 */

import type { ComponentProps } from 'react';
import { MeetOpsLoadStep } from './MeetOpsLoadStep';
import { MeetOpsScoringSection } from './MeetOpsScoringSection';

type MeetOpsMeetStepProps = ComponentProps<typeof MeetOpsLoadStep> &
  ComponentProps<typeof MeetOpsScoringSection>;

export function MeetOpsMeetStep({
  scoringSettings,
  suggestedPresetId,
  onSaveScoringSettings,
  onClearSuggestedPreset,
  officialLookup,
  teamsWithLineStyles,
  ...filesProps
}: MeetOpsMeetStepProps) {
  return (
    <div className="space-y-6">
      <MeetOpsLoadStep {...filesProps} />
      <MeetOpsScoringSection
        scoringSettings={scoringSettings}
        suggestedPresetId={suggestedPresetId}
        onSaveScoringSettings={onSaveScoringSettings}
        onClearSuggestedPreset={onClearSuggestedPreset}
        officialLookup={officialLookup}
        teamsWithLineStyles={teamsWithLineStyles}
      />
    </div>
  );
}
