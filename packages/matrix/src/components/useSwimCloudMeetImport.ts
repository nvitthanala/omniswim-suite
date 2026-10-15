/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import type { SwimCloudCaptureMeetResultsSelection } from '@omniswim/ui';
// Subpath only, never the @omniswim/swimcloud package root — see
// docs/INVARIANTS.md #7.
import type { SwimCloudParseWarning } from '@omniswim/swimcloud/parser';
import {
  applySwimCloudRows,
  type SwimCloudMeetImportSkip,
} from '../lib/swimCloudMeetImportBridge';
import {
  resolveClipboardMeetPage,
  swimCloudImportStatus,
  type OpsImportContext,
} from './opsModuleHelpers';

/** What the "Import notes" panel shows after a SwimCloud import. */
export interface SwimCloudImportDiagnostics {
  skipped: readonly SwimCloudMeetImportSkip[];
  warnings?: readonly SwimCloudParseWarning[];
  rawWarnings?: readonly string[];
}

/**
 * Track A end-to-end for a "loaded meet" — the same destination the PDF
 * import writes to, via the same meetCopyFromParsed/scoring-preset logic, so
 * a SwimCloud-sourced meet is a first-class loaded meet, not a second-tier
 * import.
 *
 * ## Which page the user has to capture
 *
 * SwimCloud publishes a team's full results at exactly one address:
 * `/results/{meetId}/team/{teamId}/swims/`. The meet's own page and the
 * per-event pages are summaries or slices, so the paste path refuses them up
 * front with the address to capture instead, rather than parsing them and
 * reporting a confusing shape error. See `resolveClipboardMeetPage`.
 *
 * ## Why it accumulates
 *
 * That page paginates at 30 rows and splits by gender with no combined
 * view, so one team at a championship meet is 16 captures. Each one merges
 * into the loaded meet on the swim's own SwimCloud id, so re-capturing a
 * page updates its rows and capturing the next page adds to them. Only a
 * capture of a *different* meet replaces what is loaded.
 *
 * One real difference from the PDF path: conference isn't re-detected
 * here. A PDF's own text sometimes names the conference; a SwimCloud
 * results capture doesn't say so machine-readably, so this trusts whatever
 * `workspace.conference` already holds rather than guessing a new one.
 */
export function useSwimCloudMeetImport(ctx: OpsImportContext) {
  const { workspace, onUpdate, toast, bumpScoringRefresh, setSuggestedPresetId } = ctx;
  const [, setIsImportingSwimCloud] = useState(false);
  const [showSwimCloudCaptureBrowser, setShowSwimCloudCaptureBrowser] = useState(false);
  const [importDiagnostics, setImportDiagnostics] = useState<SwimCloudImportDiagnostics | null>(null);

  /** The clipboard (paste) path: one SwimCloud meet-results page. */
  const handleSwimCloudImport = async () => {
    setIsImportingSwimCloud(true);
    try {
      let clipboardText: string;
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch {
        toast.push(
          'error',
          'Could not read the clipboard. Your browser may need permission, or nothing has been copied yet — use the "Copy for Omniswim" button on a SwimCloud meet-results page first.'
        );
        return;
      }

      const resolved = resolveClipboardMeetPage(clipboardText);
      if ('error' in resolved) {
        toast.push('error', resolved.error);
        return;
      }
      const { parseResult } = resolved;
      const parsed = parseResult.data;

      // Shared with the capture picker — same conversion, same same-meet
      // detection, same scoring-patch and reset-patch logic, one onUpdate.
      const result = await applySwimCloudRows([parsed], workspace, onUpdate);

      if (result.appliedRowCount === 0) {
        toast.push(
          'error',
          `No usable results found on that page (${result.skipped.length} row(s) skipped — see "Import notes" below).`
        );
        setImportDiagnostics({ skipped: result.skipped, warnings: parseResult.warnings });
        return;
      }

      if (result.presetHint) setSuggestedPresetId(result.presetHint);
      bumpScoringRefresh();

      if (result.skipped.length > 0 || parseResult.warnings.length > 0) {
        setImportDiagnostics({ skipped: result.skipped, warnings: parseResult.warnings });
      }
      toast.push(
        'success',
        swimCloudImportStatus(parsed, result.appliedRowCount, result.totalRowCount, result.skipped)
      );
    } finally {
      setIsImportingSwimCloud(false);
    }
  };

  /**
   * `SwimCloudCaptureBrowser`'s `onImportMeetResults` callback (`mode="meet-results"`).
   * The browser only browses — it never calls `applySwimCloudRows` itself — so
   * this owns the same apply/toast/close sequence `handleSwimCloudImport`
   * (the clipboard path) and the deleted `SwimCloudCapturePicker` both used,
   * now written once instead of twice.
   */
  const handleSwimCloudBrowserImport = async (selection: SwimCloudCaptureMeetResultsSelection) => {
    try {
      // Every parsed event page in the capture is passed, not only the ones
      // whose team was selected: one event page covers every team in the
      // field, so filtering them by the team selection would drop the round
      // labels for exactly the swimmers being imported.
      const result = await applySwimCloudRows(selection.parses, workspace, onUpdate, {
        eventResults: selection.eventResults,
        // The class-year join. Every roster in the capture, not only the
        // checked teams' — an event page covers the whole field, so a row
        // being imported may belong to a team the coach did not check.
        rosters: selection.rosters,
      });
      if (result.appliedRowCount === 0) {
        toast.push(
          'error',
          `No usable results in the selected pages (${result.skipped.length} row(s) skipped — see "Import notes" below).`
        );
        setImportDiagnostics({ skipped: result.skipped, rawWarnings: selection.warnings });
        return;
      }
      if (result.skipped.length > 0 || selection.warnings.length > 0) {
        setImportDiagnostics({ skipped: result.skipped, rawWarnings: selection.warnings });
      }
      if (result.presetHint) setSuggestedPresetId(result.presetHint);
      bumpScoringRefresh();
      toast.push(
        'success',
        `Loaded ${result.appliedRowCount} swim(s) from ${selection.pageCount} page(s). ${result.totalRowCount} in this meet so far.`
      );
      setShowSwimCloudCaptureBrowser(false);
    } catch (err) {
      toast.push('error', `Could not apply the selected results: ${String(err)}`);
    }
  };

  return {
    showSwimCloudCaptureBrowser,
    setShowSwimCloudCaptureBrowser,
    importDiagnostics,
    setImportDiagnostics,
    handleSwimCloudImport,
    handleSwimCloudBrowserImport,
  };
}
