/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s two commit actions — hand the checked meet-result
 * groups, or the chosen roster, back to the consumer. Pure extraction from
 * `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 */

import { useState, type MutableRefObject } from 'react';
import type { useToast } from './Toast';
import { capturePassStatus, type SwimCloudCaptureBrowserProps } from './swimCloudCaptureBrowserView';
import type { SwimCloudCaptureSelection } from './useSwimCloudCaptureSelection';

/** Owns the in-flight `isImporting` flag and the consumer callbacks' error toasts. */
export function useSwimCloudCaptureImport(
  props: SwimCloudCaptureBrowserProps,
  selection: SwimCloudCaptureSelection,
  mountedRef: MutableRefObject<boolean>,
  toast: ReturnType<typeof useToast>
) {
  const { parseResponse, groups, checkedGroups, selectedRoster, selectedCapture } = selection;
  const [isImporting, setIsImporting] = useState(false);

  const importMeetResults = async () => {
    if (props.mode !== 'meet-results' || !parseResponse) return;
    const chosen = groups.filter(group => checkedGroups[group.key] !== false);
    const selectedParses = chosen.flatMap(group => group.parses);
    if (selectedParses.length === 0) {
      toast.push('error', 'Select at least one team/gender to import.');
      return;
    }
    setIsImporting(true);
    try {
      await props.onImportMeetResults({
        parses: selectedParses,
        // An older capture that predates the event-results pass answers `[]`;
        // a response that omits the field entirely is treated the same way,
        // never as "there were no finals".
        eventResults: parseResponse.eventResults ?? [],
        rosters: parseResponse.rosters,
        pageCount: selectedParses.length,
        groups: chosen,
        warnings: parseResponse.warnings,
      });
    } catch (err) {
      toast.push('error', `Could not apply the selected results: ${String(err)}`);
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  const importRoster = async () => {
    if (props.mode !== 'roster-history' || !parseResponse || !selectedRoster) return;
    setIsImporting(true);
    try {
      await props.onImportRoster({
        roster: selectedRoster.roster,
        swimmerTimes: parseResponse.swimmerTimes,
        coverage: selectedRoster.coverage ?? {
          rosterAthleteCount: selectedRoster.roster.athletes.length,
          withCapturedTimes: 0,
          withoutCapturedTimes: selectedRoster.roster.athletes.length,
        },
        genderMismatch: selectedRoster.genderMismatch,
        swimmerTimesPass: capturePassStatus(selectedCapture, 'swimmerTimes'),
      });
    } catch (err) {
      toast.push('error', `Could not import that roster: ${String(err)}`);
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  return { isImporting, importMeetResults, importRoster };
}
