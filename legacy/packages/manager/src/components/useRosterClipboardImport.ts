/**
 * The clipboard half of `RosterImportWizard` (Track A, plans/2026-09-06/):
 * the browser extension's clipboard capture, read back here.
 * Deliberately imported from specific `@omniswim/swimcloud` subpaths, not the
 * package root — see packages/manager/src/lib/swimCloudImportBridge.ts's file
 * header for why (the root re-exports Node-only fetcher/cache code this UI
 * package must never pull into its bundle).
 *
 * The two halves of a roster import — seed-a-queue and convert-and-check-off —
 * live in `../lib/rosterQueueImport`, shared with the capture-browser path
 * (`useRosterCaptureBrowserImport`). See that module's file header on why they
 * were extracted rather than copied.
 */
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud/clipboardPayload';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { parseSwimmerTimesHtml, parseTeamMeetSwimsHtml, parseTeamRosterHtml } from '@omniswim/swimcloud/parser';
import { swimCloudTeamMeetSwimsToHistoricalSwims } from '../lib/swimCloudImportBridge';
import {
  convertAndAccountSwimmerTimes,
  describeNewAthletes,
  formatSkipWarnings,
  markRosterQueueCaptured,
  seedRosterQueueFromAthletes,
} from '../lib/rosterQueueImport';
import type { RosterImportDeps } from './useRosterImportState';

/** The three per-page-kind handlers the dispatcher routes a clipboard capture to. */
function useClipboardPageHandlers({ s, workspace, gender, toast }: RosterImportDeps) {
  const { team, rosterQueue, existingRosterNames } = s;

  /**
   * The per-swimmer path — one `/swimmer/{id}/times/` capture gives that
   * swimmer's whole personal-bests table. Re-pointed 2026-09-09 from
   * `parseSwimmerProfileHtml` + `swimCloudPersonalBestsToHistoricalSwims`,
   * which read a `Synthetic-fixture-only` page shape real captures proved
   * SwimCloud does not serve — see that parser's own doc comment.
   *
   * The roster-queue check-off and preview accumulation below are unchanged by
   * that move: they were never the bug, and a capture still identifies its
   * swimmer by id first, name second.
   *
   * The conversion, the skip tally and the check-off itself now live in
   * `../lib/rosterQueueImport` — `convertAndAccountSwimmerTimes` and
   * `markRosterQueueCaptured`. This handler and the bulk capture path call the
   * same two functions, so there is one implementation of "what one swimmer's
   * times page becomes", not one per entry point.
   */
  function handleClipboardSwimmerTimes(
    html: string,
    context: Parameters<typeof parseSwimmerTimesHtml>[1],
    swimmerId: string
  ) {
    const parseResult = parseSwimmerTimesHtml(html, context, { swimmerId });
    if (!parseResult.ok) {
      toast.push('error', `Could not read personal bests from that page: ${parseResult.failure.message}`);
      return;
    }

    const accounted = convertAndAccountSwimmerTimes(parseResult.data, {
      team: team.trim(),
      gender,
      retrievedAt: parseResult.provenance.retrievedAt,
      existingHistory: workspace.athleteHistory ?? [],
    });
    if (!accounted.ok) {
      toast.push('error', accounted.message);
      return;
    }

    // When a roster queue is active, this is one checklist item, not a
    // fresh import: accumulate into the existing preview rather than
    // replacing it, so capturing swimmer 2 doesn't discard swimmer 1's
    // swims that are still sitting in the preview waiting to be merged.
    if (rosterQueue) {
      s.setPreview(prev => [...prev, ...accounted.swims]);
      // `accounted.match.swimmerId` is the id passed in above: the parser's
      // `swimmerId` option outranks both `#swimmer-info` and the capture URL
      // (see its own doc comment), so the parse carries that exact id back out.
      // Matching on the parse's own field keeps this one source, not two.
      const marked = markRosterQueueCaptured(rosterQueue, accounted.match);
      s.setRosterQueue(marked.queue);
      const capturedSoFar = rosterQueue.entries.filter(e => e.captured).length + (marked.matchedNew ? 1 : 0);
      toast.push(
        'success',
        `Added ${accounted.swims.length} swim(s) for ${accounted.name ?? 'this swimmer'}. ${capturedSoFar}/${rosterQueue.entries.length} roster swimmers captured.`
      );
      if (accounted.improvements.length > 0) {
        s.setImprovements(prev => [
          ...prev,
          { name: accounted.name ?? 'This swimmer', improvements: accounted.improvements },
        ]);
      }
    } else {
      s.setPreview([...accounted.swims]);
      s.setImprovements(
        accounted.improvements.length > 0
          ? [{ name: accounted.name ?? 'This swimmer', improvements: accounted.improvements }]
          : []
      );
    }
    s.setImprovementsComputed(true);

    s.setWarnings([...new Set(parseResult.warnings.map(w => w.message)), ...accounted.skipWarnings]);
    s.setUnreadStampSummary(null);
    s.setFormat('swimcloud');
    s.setStep('preview');
    s.setDismissedAliasKeys(new Set());
    s.setImportMode('merge');
    s.setLastAliasLink(null);
  }

  /**
   * The bulk path — one team-swims-list capture gives every one of the
   * selected team's swimmers who competed at that meet, not one swimmer at
   * a time. The page is already scoped to one team and one gender by its
   * own URL (`/results/{meetId}/team/{teamId}/swims/?gender=`); relay
   * events are never converted (see
   * swimCloudTeamMeetSwimsToHistoricalSwims's file header on why a relay
   * leadoff split isn't a valid individual time). Re-pointed 2026-09-08 from
   * parseMeetResultsHtml, whose page shape a real capture proved does not
   * exist on SwimCloud — see that parser's own file header.
   */
  function handleClipboardMeetResults(
    html: string,
    context: Parameters<typeof parseTeamMeetSwimsHtml>[1]
  ) {
    const parseResult = parseTeamMeetSwimsHtml(html, context);
    if (!parseResult.ok) {
      toast.push('error', `Could not read results from that page: ${parseResult.failure.message}`);
      return;
    }

    const conversion = swimCloudTeamMeetSwimsToHistoricalSwims(parseResult.data, {
      team: team.trim(),
      gender,
    });
    if (conversion.swims.length === 0) {
      const teamName = team.trim();
      toast.push(
        'error',
        `No ${gender.toLowerCase()} swims found for "${teamName}" in this meet (${conversion.skipped.length} row(s) skipped — wrong team, wrong gender, relay, or no time). Check the team name matches exactly what SwimCloud printed.`
      );
      return;
    }

    s.setPreview([...conversion.swims]);
    const skippedByReason = new Map<string, number>();
    for (const row of conversion.skipped) {
      skippedByReason.set(row.reason, (skippedByReason.get(row.reason) ?? 0) + 1);
    }
    // De-duplicated: a multi-event meet routinely repeats the exact same
    // warning text once per event (e.g. "points column ignored" fires per
    // event, not once for the whole capture) — showing it N times adds
    // nothing a coach needs to see N times.
    s.setWarnings([...new Set(parseResult.warnings.map(w => w.message)), ...formatSkipWarnings(skippedByReason)]);
    s.setUnreadStampSummary(null);
    s.setFormat('swimcloud');
    s.setStep('preview');
    s.setDismissedAliasKeys(new Set());
    s.setImportMode('merge');
    s.setLastAliasLink(null);
    s.setImprovements([]);
    s.setImprovementsComputed(false);
    toast.push('success', `Imported ${conversion.swims.length} swim(s) from ${parseResult.data.meetName ?? 'this meet'}.`);
  }

  /**
   * Team-roster pages carry names/class years, never times — and every swim
   * record in this app (HistoricalSwim, Recruit) requires an event and a
   * time; there is no "bare athlete" concept to import one into (see
   * plans/2026-09-06's Phase 3 worklog). So this never touches the preview
   * grid *directly*.
   *
   * What it does instead: seeds `rosterQueue` — a checklist of every
   * swimmer the roster page named, each still needing its own
   * `/swimmer/{id}/times/` capture for times. Track A can't auto-navigate from here to each
   * swimmer's page (that would be Track B, an automated process choosing
   * where to go next, not a human clicking a button on a page they're
   * already viewing) — so the roster becomes something a coach works
   * through by hand, one "Copy for Omniswim" per swimmer, and
   * `handleClipboardSwimmerTimes` checks off each one against this queue
   * as it comes in, accumulating every swim into one running preview
   * instead of replacing it each time. This is the closest this plan's
   * Track A/Track B boundary allows to "pull the roster, then the event
   * data for every swimmer on it."
   *
   * When the browser extension has already crawled the whole team, the
   * "Browse captures" path does all of that in one action instead — see
   * `useRosterCaptureBrowserImport`. Both seed the queue through the same
   * `seedRosterQueueFromAthletes`, so "who is new to this workspace" is
   * answered one way, not two.
   */
  function handleClipboardTeamRoster(
    html: string,
    context: Parameters<typeof parseTeamRosterHtml>[1],
    teamId: string
  ) {
    const parseResult = parseTeamRosterHtml(html, context, { teamId, gender });
    if (!parseResult.ok) {
      toast.push('error', `Could not read the roster from that page: ${parseResult.failure.message}`);
      return;
    }

    const seed = seedRosterQueueFromAthletes(
      parseResult.data.teamName ?? team.trim(),
      parseResult.data.athletes,
      { existingRosterNames }
    );
    s.setRosterQueue(seed.queue);

    toast.push(
      'success',
      `Roster captured: ${seed.totalCount} swimmer(s), ${describeNewAthletes(seed)} Open each swimmer's Times tab (swimcloud.com/swimmer/{id}/times/) and click "Copy for Omniswim," then "Capture next swimmer" below — SwimCloud roster pages carry no times themselves, and a swimmer's profile summary carries only their latest meet.`
    );
  }

  return { handleClipboardSwimmerTimes, handleClipboardMeetResults, handleClipboardTeamRoster };
}

/**
 * Track A end-to-end: clipboard text (from extensions/swimcloud-companion)
 * -> validated capture payload -> classified URL -> parsed per the page
 * kind -> either HistoricalSwim[] into the same preview step every other
 * import path uses (swimmer profile, meet results) or an informational
 * summary (team roster — see handleClipboardTeamRoster's own comment for
 * why that one can't feed the preview grid at all).
 */
export function useRosterClipboardImport(deps: RosterImportDeps) {
  const { s, toast } = deps;
  const { team } = s;
  const { handleClipboardSwimmerTimes, handleClipboardMeetResults, handleClipboardTeamRoster } =
    useClipboardPageHandlers(deps);

  const handleClipboardImport = async () => {
    if (!team.trim()) {
      toast.push('error', 'Select or enter a team name first.');
      return;
    }
    s.setIsImportingFromClipboard(true);
    try {
      let clipboardText: string;
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch {
        toast.push(
          'error',
          'Could not read the clipboard. Your browser may need permission, or nothing has been copied yet — use the "Copy for Omniswim" button on a SwimCloud page first.'
        );
        return;
      }

      const payloadResult = readSwimCloudClipboardPayload(clipboardText);
      if (!payloadResult.ok) {
        toast.push('error', payloadResult.message);
        return;
      }

      const classification = classifySwimCloudUrl(payloadResult.payload.sourceUrl);
      if (classification.outcome !== 'fetchable') {
        toast.push('error', 'That clipboard capture is not a recognized SwimCloud page.');
        return;
      }
      const { resource } = classification;

      if (resource.kind === 'swimmerTimes') {
        handleClipboardSwimmerTimes(payloadResult.payload.html, payloadResult.context, resource.swimmerId);
      } else if (resource.kind === 'swimmer') {
        // The swimmer's profile root carries a "Latest Results" panel for one
        // meet at a time, not a personal-bests table — parseSwimmerTimesHtml
        // refuses it by design (packages/swimcloud/src/parser.ts, "refuses
        // shapes that are not this table"). Say which page to capture instead
        // of failing on the markup, matching the meet-root branch below.
        toast.push(
          'error',
          `That page is a swimmer's profile summary, not their full times list. Open their Times tab and capture that instead: swimcloud.com/swimmer/${resource.swimmerId}/times/`
        );
      } else if (resource.kind === 'meetTeam' || resource.kind === 'meetTeamSwims') {
        handleClipboardMeetResults(payloadResult.payload.html, payloadResult.context);
      } else if (resource.kind === 'meet' || resource.kind === 'meetEvent') {
        // The meet root and per-event pages cannot answer "this team's
        // results" — parseMeetResultsHtml's page shape (the one that would
        // have read a bare meet capture) was proven not to exist on
        // SwimCloud (packages/swimcloud/src/parser.ts's file header;
        // plans/2026-09-08/04-parsers-and-fixtures.md's "Retired" section).
        // Say what to capture instead of failing on the markup, matching
        // packages/matrix/src/components/opsModuleHelpers.ts's identical message.
        toast.push(
          'error',
          `That page only shows a summary of the meet. Open your team's full results and capture that instead: swimcloud.com/results/${resource.meetId}/team/{teamId}/swims/ — open the meet, click your team, then "More" under Performances.`
        );
      } else if (resource.kind === 'team' || resource.kind === 'teamRoster') {
        handleClipboardTeamRoster(payloadResult.payload.html, payloadResult.context, resource.teamId);
      } else {
        toast.push(
          'error',
          `This importer doesn't read "${resource.kind}" pages. Copy a swimmer's times page, a team roster, or a meet results page instead.`
        );
      }
    } finally {
      s.setIsImportingFromClipboard(false);
    }
  };

  return { handleClipboardImport };
}
