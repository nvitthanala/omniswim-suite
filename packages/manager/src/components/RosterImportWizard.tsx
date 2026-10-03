/**
 * Enhanced SwimCloud paste import with format detection and merge preview.
 */
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import {
  detectSwimCloudPasteFormat,
  parseSwimCloudPasteDetailed,
} from '@omniswim/core/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  previewHistoryImportActions,
  previewSwimCloudReplace,
  rosterNamesForTeam,
  SwimCloudReplaceRefusedError,
} from '@omniswim/core/lib/historyImportRoster';
import { backupWorkspaces } from '@omniswim/core/api/workspaces';
import {
  addAliasLink,
  buildAliasResolver,
  suggestAliasCandidates,
  type AliasNameEntry,
  type AliasSuggestion,
} from '@omniswim/core/lib/athleteAliases';
import { parseCsvHistory } from '@omniswim/core/lib/csvImport';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import {
  Button,
  Modal,
  useToast,
  SwimCloudCaptureBrowser,
  type SwimCloudCaptureRosterSelection,
} from '@omniswim/ui';
import { splitUnreadStampWarnings } from './athleteHistoryImportView';
import SwimCloudReplaceConfirmModal from './SwimCloudReplaceConfirmModal';
import { performSwimCloudImport, type SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import RosterQueueBanner from './RosterQueueBanner';
import RosterImportPasteStep from './RosterImportPasteStep';
import RosterImportPreviewStep from './RosterImportPreviewStep';
import RosterImportFooterActions from './RosterImportFooterActions';
// Track A (plans/2026-09-06/): the browser extension's clipboard capture,
// read back here. Deliberately imported from these specific subpaths, not
// the @omniswim/swimcloud package root — see
// packages/manager/src/lib/swimCloudImportBridge.ts's file header for why
// (the root re-exports Node-only fetcher/cache code this UI package must
// never pull into its bundle).
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud/clipboardPayload';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { parseSwimmerTimesHtml, parseTeamMeetSwimsHtml, parseTeamRosterHtml } from '@omniswim/swimcloud/parser';
import { swimCloudTeamMeetSwimsToHistoricalSwims } from '../lib/swimCloudImportBridge';
// The two halves of a roster import — seed-a-queue and convert-and-check-off —
// live in one module because there are now two callers for each: this file's
// clipboard handlers, and this file's own `handleCaptureBrowserRosterImport`,
// which runs the same steps N times over an already-completed
// browser-extension capture (via the shared `SwimCloudCaptureBrowser` in
// `@omniswim/ui`, not a Manager-only component anymore). See that module's
// file header on why they were extracted rather than copied.
import {
  buildRosterImportFromCapture,
  convertAndAccountSwimmerTimes,
  describeNewAthletes,
  formatSkipWarnings,
  markRosterQueueCaptured,
  rosterCaptureCoverage,
  seedRosterQueueFromAthletes,
  type RosterQueue,
  type SwimCloudCaptureRosterImport,
} from '../lib/rosterQueueImport';
import type { SwimCloudSwimmerImprovements } from '../lib/swimCloudImprovementDiff';


type ImportMode = 'paste' | 'csv';

type Props = {
  workspace: Workspace;
  gender: Gender;
  onClose: () => void;
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>;
};

function uniqueTeams(workspace: Workspace, gender: Gender): string[] {
  const field = gender === Gender.MEN ? workspace.menResults : workspace.womenResults;
  const teams = new Set<string>();
  for (const r of field ?? []) {
    if (r.team) teams.add(r.team);
  }
  return [...teams].sort();
}

/** Roster names (results + recruits) for a team/gender — the "existing" side of alias suggestions. */
function rosterNameEntriesForTeam(workspace: Workspace, team: string, gender: Gender): AliasNameEntry[] {
  return rosterNamesForTeam(workspace, team, gender).map(name => ({ name, team, gender }));
}

export default function RosterImportWizard({ workspace, gender, onClose, onUpdate }: Props) {
  const toast = useToast();
  const teams = useMemo(() => uniqueTeams(workspace, gender), [workspace, gender]);
  const [team, setTeam] = useState('');
  /**
   * Every name already on this workspace's roster for the selected team and
   * gender. Both roster-seeding paths read it, so "N not yet in this workspace"
   * counts the same swimmers however the roster arrived — clipboard capture or
   * bulk capture import.
   */
  const existingRosterNames = useMemo(
    () => (team.trim() ? rosterNamesForTeam(workspace, team.trim(), gender) : []),
    [workspace, team, gender]
  );
  const [mode, setMode] = useState<ImportMode>('paste');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Compact summary of unreadable-stamp rows in the last paste parse, pulled out of `warnings`. */
  const [unreadStampSummary, setUnreadStampSummary] = useState<string | null>(null);
  const [format, setFormat] = useState<string>('unknown');
  const [step, setStep] = useState<'paste' | 'preview'>('paste');
  const [showReference, setShowReference] = useState(false);
  const [isImportingFromClipboard, setIsImportingFromClipboard] = useState(false);
  const [showCaptureRosterPanel, setShowCaptureRosterPanel] = useState(false);
  const [rosterQueue, setRosterQueue] = useState<RosterQueue | null>(null);
  const [dismissedAliasKeys, setDismissedAliasKeys] = useState<Set<string>>(new Set());
  const [lastAliasLink, setLastAliasLink] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  /**
   * Swimmers this import improved on, against what the workspace already
   * stored for them (P8: "after a re-crawl, show who improved"). Set by the
   * bulk capture path and the single-swimmer clipboard path alike; cleared
   * whenever a new preview replaces the last one so a stale diff can't linger
   * on unrelated swims.
   */
  const [improvements, setImprovements] = useState<readonly SwimCloudSwimmerImprovements[]>([]);
  /**
   * True only on the two paths that actually run the diff (single-swimmer
   * clipboard capture, bulk capture-browser import) — both convert through
   * `convertAndAccountSwimmerTimes`/`buildRosterImportFromCapture` with
   * `existingHistory` supplied. Paste, CSV and the meet-results bulk path
   * never compute one, so this stays false there and the panel stays hidden
   * rather than claiming "nothing improved" about a diff nobody ran.
   */
  const [improvementsComputed, setImprovementsComputed] = useState(false);
  const [showImprovements, setShowImprovements] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Defaults to 'merge' — see SwimCloudImportModePicker. */
  const [importMode, setImportMode] = useState<SwimCloudImportMode>('merge');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [replaceBusy, setReplaceBusy] = useState(false);

  // If gender/meet changes and current team is no longer in the list, clear it.
  useEffect(() => {
    if (team && teams.length > 0 && !teams.includes(team)) {
      setTeam('');
    }
  }, [teams, team, gender]);

  const handleParse = () => {
    if (!team.trim()) {
      toast.push('error', 'Select or enter a team name.');
      return;
    }
    if (mode === 'csv') {
      const result = parseCsvHistory(paste, { team: team.trim(), gender });
      if (result.swims.length === 0) {
        toast.push('error', result.warnings[0] || 'No rows parsed from CSV.');
        if (result.warnings.length === 0) return;
      }
      setPreview(result.swims);
      setWarnings(result.warnings);
      setUnreadStampSummary(null);
      setFormat('csv');
      setStep('preview');
      setDismissedAliasKeys(new Set());
    setImportMode('merge');
      setLastAliasLink(null);
      setImprovements([]);
      setImprovementsComputed(false);
      return;
    }
    const result = parseSwimCloudPasteDetailed(paste, {
      team: team.trim(),
      gender,
      division: divisionForTeamOrNull(team.trim()) ?? undefined,
    });
    // Pull the per-row "Unrecognized SwimCloud stamp" sentences out of the
    // flat warnings list and collapse them into one line below — a paste
    // with a dozen unreadable stamps otherwise buries every other warning.
    const { otherWarnings, unreadStampSummary: summary } = splitUnreadStampWarnings(result.warnings);
    setPreview(result.swims);
    setWarnings(otherWarnings);
    setUnreadStampSummary(summary);
    setFormat(result.format);
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setImportMode('merge');
    setLastAliasLink(null);
    setImprovements([]);
    setImprovementsComputed(false);
  };

  /**
   * Track A end-to-end: clipboard text (from extensions/swimcloud-companion)
   * -> validated capture payload -> classified URL -> parsed per the page
   * kind -> either HistoricalSwim[] into the same preview step every other
   * import path uses (swimmer profile, meet results) or an informational
   * summary (team roster — see handleClipboardTeamRoster's own comment for
   * why that one can't feed the preview grid at all).
   */
  const handleClipboardImport = async () => {
    if (!team.trim()) {
      toast.push('error', 'Select or enter a team name first.');
      return;
    }
    setIsImportingFromClipboard(true);
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
        // packages/matrix/src/components/OpsModule.tsx's identical message.
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
      setIsImportingFromClipboard(false);
    }
  };

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
      setPreview(prev => [...prev, ...accounted.swims]);
      // `accounted.match.swimmerId` is the id passed in above: the parser's
      // `swimmerId` option outranks both `#swimmer-info` and the capture URL
      // (see its own doc comment), so the parse carries that exact id back out.
      // Matching on the parse's own field keeps this one source, not two.
      const marked = markRosterQueueCaptured(rosterQueue, accounted.match);
      setRosterQueue(marked.queue);
      const capturedSoFar = rosterQueue.entries.filter(e => e.captured).length + (marked.matchedNew ? 1 : 0);
      toast.push(
        'success',
        `Added ${accounted.swims.length} swim(s) for ${accounted.name ?? 'this swimmer'}. ${capturedSoFar}/${rosterQueue.entries.length} roster swimmers captured.`
      );
      if (accounted.improvements.length > 0) {
        setImprovements(prev => [
          ...prev,
          { name: accounted.name ?? 'This swimmer', improvements: accounted.improvements },
        ]);
      }
    } else {
      setPreview([...accounted.swims]);
      setImprovements(
        accounted.improvements.length > 0
          ? [{ name: accounted.name ?? 'This swimmer', improvements: accounted.improvements }]
          : []
      );
    }
    setImprovementsComputed(true);

    setWarnings([...new Set(parseResult.warnings.map(w => w.message)), ...accounted.skipWarnings]);
    setUnreadStampSummary(null);
    setFormat('swimcloud');
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setImportMode('merge');
    setLastAliasLink(null);
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

    setPreview([...conversion.swims]);
    const skippedByReason = new Map<string, number>();
    for (const row of conversion.skipped) {
      skippedByReason.set(row.reason, (skippedByReason.get(row.reason) ?? 0) + 1);
    }
    // De-duplicated: a multi-event meet routinely repeats the exact same
    // warning text once per event (e.g. "points column ignored" fires per
    // event, not once for the whole capture) — showing it N times adds
    // nothing a coach needs to see N times.
    setWarnings([...new Set(parseResult.warnings.map(w => w.message)), ...formatSkipWarnings(skippedByReason)]);
    setUnreadStampSummary(null);
    setFormat('swimcloud');
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setImportMode('merge');
    setLastAliasLink(null);
    setImprovements([]);
    setImprovementsComputed(false);
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
   * `handleCaptureRosterImport` below. Both seed the queue through the same
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
    setRosterQueue(seed.queue);

    toast.push(
      'success',
      `Roster captured: ${seed.totalCount} swimmer(s), ${describeNewAthletes(seed)} Open each swimmer's Times tab (swimcloud.com/swimmer/{id}/times/) and click "Copy for Omniswim," then "Capture next swimmer" below — SwimCloud roster pages carry no times themselves, and a swimmer's profile summary carries only their latest meet.`
    );
  }

  /**
   * The bulk path: one already-completed capture, one roster in it, every
   * swimmer it holds times for imported at once.
   *
   * `SwimCloudCaptureBrowser` (`@omniswim/ui`, `mode="roster-history"`) only
   * browses — it hands back the roster the coach picked plus every
   * swimmer-times page the same capture holds, and never converts either.
   * `buildRosterImportFromCapture` is the same conversion this component's
   * clipboard handlers already run, computed here rather than inside the
   * browser so this file stays the one place that decides what a completed
   * capture does to this workspace.
   */
  const handleCaptureBrowserRosterImport = (selection: SwimCloudCaptureRosterSelection) => {
    const result: SwimCloudCaptureRosterImport = buildRosterImportFromCapture({
      roster: selection.roster,
      swimmerTimes: selection.swimmerTimes,
      team: team.trim(),
      gender,
      existingRosterNames,
      existingHistory: workspace.athleteHistory ?? [],
    });

    setRosterQueue(result.rosterQueue);
    setWarnings([...result.warnings]);
    setUnreadStampSummary(null);
    setShowCaptureRosterPanel(false);
    setImprovements(result.improvements);
    setImprovementsComputed(true);
    setShowImprovements(false);

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

    setPreview([...result.swims]);
    setFormat('swimcloud');
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setImportMode('merge');
    setLastAliasLink(null);
    toast.push('success', result.summary);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setPaste(text);
      setMode('csv');
    } catch (err) {
      toast.push('error', `Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  /** Returns whether the import committed, so a confirm dialog knows whether it can close. */
  const runImport = async (importOpts: { mode: SwimCloudImportMode }): Promise<boolean> => {
    let backedUp = true;
    try {
      const result = await performSwimCloudImport(
        workspace,
        preview,
        {
          team: team.trim(),
          gender,
          sourceType: mode === 'csv' ? 'csv_import' : 'swimcloud_paste',
          sourceLabel: `${format} import (${team})`,
          mode: importOpts.mode,
        },
        {
          backup: async () => {
            try {
              await backupWorkspaces();
            } catch (err) {
              backedUp = false;
              throw err;
            }
          },
        }
      );
      if (result.noop) return true;
      await onUpdate(result.patch);
      toast.push('success', formatHistoryImportSummary(result.summary));
      onClose();
      return true;
    } catch (err) {
      if (err instanceof SwimCloudReplaceRefusedError) {
        toast.push('error', err.message);
        return false;
      }
      if (!backedUp) {
        toast.push(
          'error',
          `Could not back up the workspace, so the replace was not run: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
      toast.push('error', `Import failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const handleMerge = async () => {
    if (preview.length === 0 || !team.trim()) return;
    if (importMode === 'replace') {
      setShowReplaceConfirm(true);
      return;
    }
    await runImport({ mode: 'merge' });
  };

  const handleConfirmReplace = async () => {
    setReplaceBusy(true);
    const committed = await runImport({ mode: 'replace' });
    setReplaceBusy(false);
    // Left open on failure (a refusal or a failed backup) so the coach can
    // see why and retry, rather than losing the dialog mid-error.
    if (committed) setShowReplaceConfirm(false);
  };

  const replacePreview = useMemo(
    () =>
      importMode === 'replace' && team.trim() && preview.length > 0
        ? previewSwimCloudReplace(workspace, preview, { team: team.trim(), gender })
        : null,
    [importMode, workspace, preview, team, gender]
  );

  const swimmerActions = useMemo(
    () =>
      team.trim()
        ? previewHistoryImportActions(workspace, preview, { team: team.trim(), gender })
        : [],
    [workspace, preview, team, gender]
  );

  // Same alias-suggestion approach as AthleteHistoryImportPanel: unmatched
  // incoming swimmers (previewHistoryImportActions couldn't confidently match
  // them) vs every roster name for this team/gender. Depends on
  // workspace.athleteAliases so a just-added link drops its own suggestion.
  const aliasSuggestions = useMemo<AliasSuggestion[]>(() => {
    const trimmedTeam = team.trim();
    if (!trimmedTeam || swimmerActions.length === 0) return [];
    const existingNames = rosterNameEntriesForTeam(workspace, trimmedTeam, gender);
    if (existingNames.length === 0) return [];
    // All rows (not just new_recruit): an athlete already on the recruit list
    // under a long-form name still needs a link offer against the roster name.
    const incomingNames: AliasNameEntry[] = swimmerActions.map(s => ({
      name: s.name,
      team: s.team,
      gender: s.gender,
    }));
    if (incomingNames.length === 0) return [];
    const resolver = buildAliasResolver(workspace.athleteAliases ?? []);
    return suggestAliasCandidates(existingNames, incomingNames, { resolver });
  // Deliberate: depends on the individual workspace fields this reads, not the
  // whole object, so an unrelated workspace edit does not re-run the scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.recruits,
    workspace.athleteAliases,
    swimmerActions,
    team,
    gender,
  ]);

  const handleLinkAlias = (suggestion: AliasSuggestion) => {
    const result = addAliasLink(workspace, {
      canonicalName: suggestion.existing.name,
      aliasName: suggestion.incoming.name,
      gender: suggestion.incoming.gender,
      team: suggestion.existing.team ?? suggestion.incoming.team,
      source: 'import',
    });
    void onUpdate(result.patch);
    setLastAliasLink({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  const handleDismissAlias = (key: string) => {
    setDismissedAliasKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const handleUndoAliasLink = () => {
    if (!lastAliasLink) return;
    void onUpdate(lastAliasLink.inverse);
    toast.push('success', `Undid: ${lastAliasLink.description}`);
    setLastAliasLink(null);
  };

  const detectedFormat =
    mode === 'paste' && paste.trim() ? detectSwimCloudPasteFormat(paste) : null;

  return (
    <>
      {/* Its own separate FloatingWindow overlay, positioned independently of
          the wizard's own dialog below — a sibling, never nested inside it. */}
      {showCaptureRosterPanel ? (
        <SwimCloudCaptureBrowser
          mode="roster-history"
          team={team.trim()}
          genderLabel={gender === Gender.MEN ? 'Men' : 'Women'}
          rosterCoverage={(roster, swimmerTimes) => rosterCaptureCoverage(roster.athletes, swimmerTimes)}
          onImportRoster={selection => handleCaptureBrowserRosterImport(selection)}
          onClose={() => setShowCaptureRosterPanel(false)}
          pasteFallback={{
            label: 'or paste a single swimmer instead',
            hint: 'Reads one SwimCloud roster, or one swimmer’s Times page, from the clipboard ("Copy for Omniswim" on that page first).',
            onPaste: () => void handleClipboardImport(),
          }}
        />
      ) : null}
      <Modal
        onClose={onClose}
        ariaLabel="Import roster / history"
        blur={false}
        className="border border-theme w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl"
        style={{ boxShadow: 'var(--ui-shadow-lg)' }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-soft">
          <div>
            <h3 className="text-ui-label font-bold">Import roster / history</h3>
            <p className="text-ui-caption text-theme-muted mt-1">
              Paste SwimCloud Personal Bests or roster table text
            </p>
          </div>
          <Button variant="ghost" size="md" onClick={onClose} className="p-2" aria-label="Close" leadingIcon={<X size={18} />} />
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {rosterQueue ? (
            <RosterQueueBanner
              rosterQueue={rosterQueue}
              isImportingFromClipboard={isImportingFromClipboard}
              team={team}
              onCaptureNext={() => void handleClipboardImport()}
              onClear={() => setRosterQueue(null)}
            />
          ) : null}
          {step === 'paste' ? (
            <RosterImportPasteStep
              mode={mode}
              onSetMode={setMode}
              showReference={showReference}
              onToggleReference={() => setShowReference(s => !s)}
              onShowCaptureRosterPanel={() => setShowCaptureRosterPanel(true)}
              team={team}
              teams={teams}
              onSetTeam={setTeam}
              gender={gender}
              paste={paste}
              onSetPaste={setPaste}
              fileInputRef={fileInputRef}
              onFile={handleFile}
              detectedFormat={detectedFormat}
            />
          ) : (
            <RosterImportPreviewStep
              format={format}
              preview={preview}
              warnings={warnings}
              unreadStampSummary={unreadStampSummary}
              team={team}
              importMode={importMode}
              onSetImportMode={setImportMode}
              replacePreview={replacePreview}
              improvementsComputed={improvementsComputed}
              improvements={improvements}
              showImprovements={showImprovements}
              onToggleImprovements={() => setShowImprovements(v => !v)}
              swimmerActions={swimmerActions}
              aliasSuggestions={aliasSuggestions}
              dismissedAliasKeys={dismissedAliasKeys}
              onLinkAlias={handleLinkAlias}
              onDismissAlias={handleDismissAlias}
              lastAliasLink={lastAliasLink}
              onUndoAliasLink={handleUndoAliasLink}
            />
          )}
        </div>

        <RosterImportFooterActions
          step={step}
          onBack={() => setStep('paste')}
          onClose={onClose}
          onParse={handleParse}
          pasteEmpty={!paste.trim()}
          onMerge={() => void handleMerge()}
          previewEmpty={preview.length === 0}
          isReplaceMode={importMode === 'replace'}
        />
      </Modal>
      {showReplaceConfirm && replacePreview ? (
        <SwimCloudReplaceConfirmModal
          preview={replacePreview}
          busy={replaceBusy}
          onCancel={() => setShowReplaceConfirm(false)}
          onConfirm={() => void handleConfirmReplace()}
        />
      ) : null}
    </>
  );
}
