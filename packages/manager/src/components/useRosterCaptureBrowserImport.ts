/**
 * The bulk path: one already-completed capture, one roster in it, every
 * swimmer it holds times for imported at once.
 *
 * `SwimCloudCaptureBrowser` (`@omniswim/ui`, `mode="roster-history"`) only
 * browses — it hands back the roster the coach picked plus every
 * swimmer-times page the same capture holds, and never converts either.
 * `buildRosterImportFromCapture` is the same conversion the clipboard
 * handlers already run (`useRosterClipboardImport`), computed here rather
 * than inside the browser so the wizard stays the one place that decides
 * what a completed capture does to this workspace.
 */
import type { SwimCloudCaptureRosterSelection } from '@omniswim/ui';
import {
  buildRosterImportFromCapture,
  type SwimCloudCaptureRosterImport,
} from '../lib/rosterQueueImport';
import type { RosterImportDeps } from './useRosterImportState';

export function useRosterCaptureBrowserImport({ s, workspace, gender, toast }: RosterImportDeps) {
  const handleCaptureBrowserRosterImport = (selection: SwimCloudCaptureRosterSelection) => {
    const result: SwimCloudCaptureRosterImport = buildRosterImportFromCapture({
      roster: selection.roster,
      swimmerTimes: selection.swimmerTimes,
      team: s.team.trim(),
      gender,
      existingRosterNames: s.existingRosterNames,
      existingHistory: workspace.athleteHistory ?? [],
    });

    s.setRosterQueue(result.rosterQueue);
    s.setWarnings([...result.warnings]);
    s.setUnreadStampSummary(null);
    s.setShowCaptureRosterPanel(false);
    s.setImprovements(result.improvements);
    s.setImprovementsComputed(true);
    s.setShowImprovements(false);

    if (result.swims.length === 0) {
      // Same landing as a clipboard roster capture: the checklist is seeded and
      // the coach works through it. Advancing to an empty preview would read as
      // "0 swims found in these swimmers' times" rather than "this capture holds
      // no times pages for them" — the panel has already said which it is.
      //
      // `swimmerTimesPass` is why those are not the same sentence. A crawl
      // narrowed to meet results never asked for a single personal-best page,
      // so "no importable times" is the plan working, not the capture falling
      // short — and re-crawling wider fixes it, where working the checklist by
      // hand is the answer in every other case.
      const scopeClause =
        selection.swimmerTimesPass === 'not-planned'
          ? ' This capture’s crawl never planned swimmers’ personal-best pages, so it holds none — re-crawl the meet with a wider scope to get them in one pass.'
          : selection.swimmerTimesPass === 'not-recorded'
            ? ' This capture does not record whether its crawl planned swimmers’ personal-best pages, so it is not known whether re-crawling would add any.'
            : '';
      toast.push(
        'error',
        `No importable times in this capture for ${result.teamLabel}. The roster is on the checklist below — capture each swimmer’s Times tab with "Copy for Omniswim."${scopeClause}`
      );
      return;
    }

    s.setPreview([...result.swims]);
    s.setFormat('swimcloud');
    s.setStep('preview');
    s.setDismissedAliasKeys(new Set());
    s.setImportMode('merge');
    s.setLastAliasLink(null);
    toast.push('success', result.summary);
  };

  return { handleCaptureBrowserRosterImport };
}
