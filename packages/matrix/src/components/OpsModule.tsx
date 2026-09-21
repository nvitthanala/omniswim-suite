/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BarChart3, ClipboardPaste, ExternalLink, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Gender, OfficialTeamScores, SwimmerResult, ScoringSettings, Workspace } from '@omniswim/core/types';
import {
  buildScoringPatchForParsedPdf,
  presetIdForConference,
} from '@omniswim/core/lib/scoringDefaults';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { alignPsychResultsToMeetTeams } from '@omniswim/core/lib/psychProjection';
import { meetCopyFromParsed } from '@omniswim/core/lib/meetSource';
import { workspaceNameForLoadedMeet } from '@omniswim/core/lib/workspaceNaming';
import { softRemoveSwimmerFromWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import {
  useToast,
  WizardShell,
  SwimCloudCaptureBrowser,
  type WizardStep,
  type SwimCloudCaptureMeetResultsSelection,
} from '@omniswim/ui';
// Track A (plans/2026-09-06/). Subpaths only, never the @omniswim/swimcloud
// package root — see packages/manager/src/lib/swimCloudImportBridge.ts's
// file header and docs/INVARIANTS.md #7 for why: the root re-exports
// Node-only fetcher/cache code this UI package must never bundle.
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud/clipboardPayload';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { parseTeamMeetSwimsHtml } from '@omniswim/swimcloud/parser';
import type { SwimCloudParseWarning, SwimCloudTeamMeetSwimsParse } from '@omniswim/swimcloud/parser';
import {
  applySwimCloudRows,
  type SwimCloudMeetImportSkip,
} from '../lib/swimCloudMeetImportBridge';
import MeetOperationsView from './MeetOperationsView';
import SwimmerDeleteConfirmModal from './SwimmerDeleteConfirmModal';
import { SwimCloudImportDiagnosticsPanel } from './SwimCloudImportDiagnosticsPanel';

interface Props {
  workspace: Workspace;
  gender: Gender;
  onUpdate: (updated: Partial<Workspace>) => void | Promise<void>;
}

type MatrixStepId = 'load' | 'score' | 'standings' | 'analyze';

const MATRIX_STEPS: WizardStep<MatrixStepId>[] = [
  { id: 'load', label: 'Load', title: 'Bring in the meet', hint: 'Load results and link a psych sheet before reviewing projections.', icon: <ClipboardPaste size={16} /> },
  { id: 'score', label: 'Score', title: 'Set the scoring rules', hint: 'Choose the scoring model, presets, and official-score comparison.', icon: <BarChart3 size={16} /> },
  { id: 'standings', label: 'Standings', title: 'See where teams land', hint: 'Review the projected team order and the swims behind each total.', icon: <Trophy size={16} /> },
  { id: 'analyze', label: 'Analyze', title: 'Explain the result', hint: 'Trace score changes, momentum, and differences from prelims.', icon: <BarChart3 size={16} /> },
];

/** True when a list prop that may be missing has at least one entry. */
function hasEntries(list: unknown[] | undefined): boolean {
  return (list?.length ?? 0) > 0;
}

function hasRosterEdits(workspace: Workspace): boolean {
  return (
    hasEntries(workspace.scorerRosterOverrides) ||
    hasEntries(workspace.meetEntryPlans) ||
    hasEntries(workspace.relayLegOverrides) ||
    hasEntries(workspace.recruits) ||
    hasEntries(workspace.deletedSwimmers)
  );
}

/** Recruits already saved in the workspace survive a re-parse unless the user
 * explicitly discards them — asked only when there's something to lose. */
function resolveKeepRecruits(existingRecruits: unknown[]): boolean {
  if (existingRecruits.length === 0) return true;
  return window.confirm(
    `${existingRecruits.length} recruit(s) saved in this workspace.\n\nOK = Keep recruits\nCancel = Discard recruits`
  );
}

/** The workspace update patch for a freshly parsed meet PDF. */
function buildParsedMeetUpdatePatch(params: {
  parsedMen: SwimmerResult[];
  parsedWomen: SwimmerResult[];
  file: File;
  conference: string | undefined;
  autoName: string | null;
  officialTeamScores: OfficialTeamScores | undefined;
  scoringPatch: ScoringSettings | undefined;
  keepRecruits: boolean;
  existingRecruits: Workspace['recruits'];
}): Partial<Workspace> {
  const {
    parsedMen,
    parsedWomen,
    file,
    conference,
    autoName,
    officialTeamScores,
    scoringPatch,
    keepRecruits,
    existingRecruits,
  } = params;
  return {
    ...meetCopyFromParsed(parsedMen, parsedWomen),
    deletedSwimmers: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    recruits: keepRecruits ? existingRecruits : [],
    loadedMeet: {
      pdfFilename: file.name,
      uploadedAt: Date.now(),
      conference,
    },
    conference,
    ...(autoName ? { name: autoName } : {}),
    ...(officialTeamScores ? { officialTeamScores } : {}),
    ...(scoringPatch ? { scoringSettings: scoringPatch } : {}),
  };
}

/**
 * The toast for one SwimCloud capture: what came in, what is loaded now, and
 * what to capture next.
 *
 * The "next" half is the part that matters. A full team's results run to eight
 * pages per gender, and nothing on screen would otherwise tell a user that the
 * 30 rows they just loaded are an eighth of one gender.
 */
function swimCloudImportStatus(
  parsed: SwimCloudTeamMeetSwimsParse,
  addedCount: number,
  totalCount: number,
  skipped: readonly SwimCloudMeetImportSkip[]
): string {
  const who = [parsed.teamName, parsed.gender === 'unknown' ? undefined : parsed.gender]
    .filter(Boolean)
    .join(' · ');
  const page = parsed.pagination
    ? ` (page ${parsed.pagination.currentPage} of ${parsed.pagination.totalPages})`
    : '';
  const leadoffs = skipped.filter(skip => skip.reason === 'relay-leadoff').length;
  const otherSkips = skipped.length - leadoffs;

  const notes: string[] = [];
  if (leadoffs > 0) notes.push(`${leadoffs} relay leadoff split(s) excluded`);
  if (otherSkips > 0) notes.push(`${otherSkips} row(s) skipped — see console`);
  if (parsed.pagination && parsed.pagination.currentPage < parsed.pagination.totalPages) {
    notes.push('capture the next page or the other gender to add more');
  } else {
    notes.push('capture another team or gender to add more');
  }

  return `Loaded ${addedCount} swim(s)${page}${who ? ` for ${who}` : ''}. ${totalCount} in this meet so far. ${notes.join('; ')}.`;
}

/** Parses the psych-PDF endpoint's raw response body, folding the "empty
 * body", "invalid JSON", "ok but carries an error field", and "no entries"
 * cases into one result the caller checks once. */
function parsePsychApiResponse(
  rawText: string,
  resStatus: number,
  resOk: boolean
): { error: string } | { results: SwimmerResult[] } {
  if (!rawText.trim()) {
    return {
      error: `Psych PDF parse failed — server returned an empty response (${resStatus}). Restart dev server or run npm run build && npm start.`,
    };
  }
  let data: { error?: string; details?: string; results?: SwimmerResult[] };
  try {
    data = JSON.parse(rawText) as typeof data;
  } catch {
    return { error: `Psych PDF parse failed — invalid server response: ${rawText.slice(0, 160)}` };
  }
  if (!resOk || data.error) {
    return { error: `${data.error || 'Psych PDF parsing failed'}${data.details ? ` — ${data.details}` : ''}` };
  }
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return { error: 'No individual psych entries found in PDF' };
  }
  return { results };
}

export default function OpsModule({ workspace, gender, onUpdate }: Props) {
  const toast = useToast();
  const { workspaces } = useSuiteWorkspace();
  const [searchQuery, setSearchQuery] = useState('');
  const [removeSeniors, _setRemoveSeniors] = useState(false);
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  const [isParsingPsychPdf, setIsParsingPsychPdf] = useState(false);
  const [_isImportingSwimCloud, setIsImportingSwimCloud] = useState(false);
  const [showSwimCloudCaptureBrowser, setShowSwimCloudCaptureBrowser] = useState(false);
  const [importDiagnostics, setImportDiagnostics] = useState<{
    skipped: readonly SwimCloudMeetImportSkip[];
    warnings?: readonly SwimCloudParseWarning[];
    rawWarnings?: readonly string[];
  } | null>(null);
  const [pdfFormat, setPdfFormat] = useState('auto');
  const [swimmerDeleteCandidate, setSwimmerDeleteCandidate] = useState<{ name: string } | null>(null);
  const [suggestedPresetId, setSuggestedPresetId] = useState<string | null>(() =>
    presetIdForConference(workspace.conference)
  );
  const [whatIfMode, _setWhatIfMode] = useState(false);
  const [step, setStep] = useState<MatrixStepId>('load');
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);
  const parseAbortRef = useRef<AbortController | null>(null);
  const psychParseAbortRef = useRef<AbortController | null>(null);

  // === Team Roster Catalog opt-in ===
  const {
    projected,
    baseline,
    prelimsProjected,
    psychProjected,
    baselineByTeam,
    prelimsByTeam,
    psychByTeam,
    prelimsDeltaTimeline,
    psychDeltaTimeline,
    showPrelimsPerformance,
    showPsychPerformance,
    prelimsOuByEntry,
    psychOuByEntry,
    scoringSettings,
  } = useWorkspaceScoring({
    workspace,
    gender,
    removeSeniors,
    scoringRefreshKey,
  });

  const confirmDeleteSwimmer = () => {
    if (!swimmerDeleteCandidate) return;
    const patch = softRemoveSwimmerFromWorkspace(workspace, {
      name: swimmerDeleteCandidate.name,
      gender,
    });
    void onUpdate(patch);
    setSwimmerDeleteCandidate(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async event => {
      const abortController = new AbortController();
      parseAbortRef.current = abortController;
      setIsParsingPdf(true);
      try {
        const base64 = (event.target?.result as string).split(',')[1];
        const res = await fetch('/api/parse-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({ base64, format: pdfFormat }),
        });
        const data = await res.json();

        if (!res.ok || data.error) {
          toast.push('error', `${data.error || 'PDF parsing failed'}${data.details ? ` — ${data.details}` : ''}`);
          return;
        }

        const parsedMen = data.results.filter((r: SwimmerResult) => r.gender === Gender.MEN);
        const parsedWomen = data.results.filter((r: SwimmerResult) => r.gender === Gender.WOMEN);

        const conference = data.conference ?? workspace.conference;
        const presetHint = presetIdForConference(conference);
        if (presetHint) setSuggestedPresetId(presetHint);

        const allParsed = [...parsedMen, ...parsedWomen] as SwimmerResult[];
        const scoringPatch = buildScoringPatchForParsedPdf(workspace.scoringSettings, conference, presetHint, allParsed);
        const officialTeamScores = data.officialTeamScores as OfficialTeamScores | undefined;

        const existingRecruits = workspace.recruits ?? [];
        const keepRecruits = resolveKeepRecruits(existingRecruits);

        // A workspace still carrying its generated placeholder takes its identity
        // from the meet just loaded. Only placeholders are replaced — a name the
        // user typed is never overwritten. See workspaceNameForLoadedMeet.
        const autoName = workspaceNameForLoadedMeet(workspace.name, file.name, conference);

        await onUpdate(
          buildParsedMeetUpdatePatch({
            parsedMen,
            parsedWomen,
            file,
            conference,
            autoName,
            officialTeamScores,
            scoringPatch,
            keepRecruits,
            existingRecruits,
          })
        );
        if (autoName) {
          toast.push('info', `Workspace renamed to "${autoName}"`);
        }
        setScoringRefreshKey(k => k + 1);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          toast.push('info', 'PDF parsing canceled');
          return;
        }
        toast.push('error', `Failed to read meet PDF — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (parseAbortRef.current === abortController) parseAbortRef.current = null;
        setIsParsingPdf(false);
        e.target.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  const cancelPdfParse = () => {
    parseAbortRef.current?.abort();
  };

  /**
   * Track A end-to-end for a "loaded meet" — the same destination
   * `handleFileUpload` (PDF) writes to, via the same
   * meetCopyFromParsed/scoring-preset logic, so a SwimCloud-sourced meet is
   * a first-class loaded meet, not a second-tier import.
   *
   * ## Which page the user has to capture
   *
   * SwimCloud publishes a team's full results at exactly one address:
   * `/results/{meetId}/team/{teamId}/swims/`. The meet's own page and the
   * per-event pages are summaries or slices, so this refuses them up front
   * with the address to capture instead, rather than parsing them and
   * reporting a confusing shape error. See `parseTeamMeetSwimsHtml`.
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
      const resource = classification.resource;

      // The meet root cannot answer "this team's results". Say what to capture
      // instead of failing on the markup.
      if (resource.kind === 'meet') {
        toast.push(
          'error',
          `That page only shows a summary of the meet. Open your team's full results and capture that instead: swimcloud.com/results/${resource.meetId}/team/{teamId}/swims/ — open the meet, click your team, then "More" under Performances.`
        );
        return;
      }
      // A per-event page *is* parseable now (`parseMeetEventResultsHtml`) and
      // carries the round labels this import needs — but on its own it names no
      // team, so it cannot load a meet by itself. The crawl fetches these
      // automatically and the capture picker feeds them straight into the
      // import; pasting one here has nowhere to attach. Say that, rather than
      // the old "only a summary", which this page is not.
      if (resource.kind === 'meetEvent') {
        toast.push(
          'error',
          `That is one event's results page. It carries the prelims/finals rounds this import needs, but it names no team, so it cannot load a meet on its own — the browser extension's crawl fetches these for you. Paste your team's full results instead: swimcloud.com/results/${resource.meetId}/team/{teamId}/swims/`
        );
        return;
      }
      if (resource.kind !== 'meetTeam' && resource.kind !== 'meetTeamSwims') {
        toast.push(
          'error',
          `This loads meet results only (got a "${resource.kind}" page). Capture a team's results page within a meet instead.`
        );
        return;
      }

      const parseResult = parseTeamMeetSwimsHtml(payloadResult.payload.html, payloadResult.context);
      if (!parseResult.ok) {
        toast.push('error', `Could not read results from that page: ${parseResult.failure.message}`);
        return;
      }
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
      setScoringRefreshKey(k => k + 1);

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
      setScoringRefreshKey(k => k + 1);
      toast.push(
        'success',
        `Loaded ${result.appliedRowCount} swim(s) from ${selection.pageCount} page(s). ${result.totalRowCount} in this meet so far.`
      );
      setShowSwimCloudCaptureBrowser(false);
    } catch (err) {
      toast.push('error', `Could not apply the selected results: ${String(err)}`);
    }
  };

  const handlePsychFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async event => {
      const abortController = new AbortController();
      psychParseAbortRef.current = abortController;
      setIsParsingPsychPdf(true);
      try {
        const base64 = (event.target?.result as string).split(',')[1];
        const res = await fetch('/api/parse-psych-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({ base64, format: pdfFormat }),
        });
        const rawText = await res.text();
        const parsed = parsePsychApiResponse(rawText, res.status, res.ok);
        if ('error' in parsed) {
          toast.push('error', parsed.error);
          return;
        }
        const { results } = parsed;

        const parsedMen = results.filter((r: SwimmerResult) => r.gender === Gender.MEN);
        const parsedWomen = results.filter((r: SwimmerResult) => r.gender === Gender.WOMEN);
        const meetRows = [...(workspace.menResults ?? []), ...(workspace.womenResults ?? [])];
        const alignedMen = alignPsychResultsToMeetTeams(parsedMen, meetRows);
        const alignedWomen = alignPsychResultsToMeetTeams(parsedWomen, meetRows);
        const uploadedAt = Date.now();

        await onUpdate({
          psychMenResults: alignedMen,
          psychWomenResults: alignedWomen,
          loadedPsych: {
            pdfFilename: file.name,
            uploadedAt,
            format: pdfFormat as 'auto' | 'regular' | 'divided',
            linkedMeetUploadedAt: workspace.loadedMeet?.uploadedAt,
          },
          ...(workspace.loadedMeet
            ? {
                loadedMeet: {
                  ...workspace.loadedMeet,
                  linkedPsychUploadedAt: uploadedAt,
                },
              }
            : {}),
        });
        setScoringRefreshKey(k => k + 1);
        toast.push('success', `Linked psych sheet (${alignedMen.length + alignedWomen.length} entries)`);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          toast.push('info', 'Psych PDF parsing canceled');
          return;
        }
        toast.push(
          'error',
          `Failed to read psych PDF — ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        if (psychParseAbortRef.current === abortController) psychParseAbortRef.current = null;
        setIsParsingPsychPdf(false);
        e.target.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  const cancelPsychPdfParse = () => {
    psychParseAbortRef.current?.abort();
  };

  const handleScoringViewChange = (view: 'merged' | 'pdf_only') => {
    void onUpdate({ scoringView: view });
  };

  const copyMeetFromWorkspace = (sourceId: string) => {
    const source = workspaces.find(candidate => candidate.id === sourceId);
    if (!source) return;

    // This overwrites the current meet AND its frozen source copy, which is what
    // soft-remove restore rebuilds from. Two guards, because there is no undo:
    //
    // 1. Copying from a workspace with no meet would blank this one silently.
    //    That is data loss dressed up as a copy, so refuse it outright.
    const sourceHasMeet = hasEntries(source.menResults) || hasEntries(source.womenResults);
    if (!sourceHasMeet) {
      toast.push('error', `${source.name} has no loaded meet to copy`);
      return;
    }

    // 2. Overwriting a meet that is already loaded is destructive and easy to
    //    trigger from a single select change, so make it deliberate.
    const targetHasMeet = hasEntries(workspace.menResults) || hasEntries(workspace.womenResults);
    if (targetHasMeet) {
      const current = workspace.loadedMeet?.pdfFilename ?? 'the loaded meet';
      const ok = window.confirm(
        `Replace ${current} with the meet from "${source.name}"?\n\n` +
          'This also replaces the frozen source copy this workspace restores removed swimmers from. It cannot be undone.'
      );
      if (!ok) return;
    }

    void onUpdate({
      ...meetCopyFromParsed(source.menResults ?? [], source.womenResults ?? []),
      loadedMeet: source.loadedMeet,
      psychMenResults: source.psychMenResults,
      psychWomenResults: source.psychWomenResults,
      loadedPsych: source.loadedPsych,
      officialTeamScores: source.officialTeamScores,
      conference: source.conference,
    });
    setScoringRefreshKey(key => key + 1);
    toast.push('success', `Copied meet results from ${source.name}`);
  };

  const rosterDirty = hasRosterEdits(workspace);

  return (
    <>
      {importDiagnostics ? (
        <div className="mb-3">
          <SwimCloudImportDiagnosticsPanel
            skipped={importDiagnostics.skipped}
            warnings={importDiagnostics.warnings}
            rawWarnings={importDiagnostics.rawWarnings}
            onDismiss={() => setImportDiagnostics(null)}
          />
        </div>
      ) : null}
      <WizardShell
        steps={MATRIX_STEPS}
        eyebrow="Meet workflow"
        ariaLabel="Meet workflow steps"
        step={step}
        onStepChange={setStep}
        toolbar={<>
          {rosterDirty ? (
            <Link
              to="/manager"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md border border-[var(--text-accent)]/30 text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
            >
              Edit roster in Manager
              <ExternalLink size={12} />
            </Link>
          ) : null}
        </>}
      >
        <AnimatePresence mode="wait">
          <motion.div
          key={step}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          <MeetOperationsView
            activeStep={step}
            workspace={workspace}
            workspaceMeetSources={workspaces.filter(candidate => candidate.id !== workspace.id)}
            onCopyMeetFromWorkspace={copyMeetFromWorkspace}
            gender={gender}
            scoringBundle={projected}
            baselineBundle={baseline}
            prelimsProjectedBundle={prelimsProjected}
            psychProjectedBundle={psychProjected}
            baselineByTeam={baselineByTeam}
            prelimsByTeam={prelimsByTeam}
            psychByTeam={psychByTeam}
            prelimsDeltaTimeline={prelimsDeltaTimeline}
            psychDeltaTimeline={psychDeltaTimeline}
            showPrelimsPerformance={showPrelimsPerformance}
            showPsychPerformance={showPsychPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            psychOuByEntry={psychOuByEntry}
            scoringSettings={scoringSettings}
            suggestedPresetId={suggestedPresetId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            whatIfMode={whatIfMode}
            isParsingPdf={isParsingPdf}
            isParsingPsychPdf={isParsingPsychPdf}
            pdfFormat={pdfFormat}
            onPdfFormatChange={setPdfFormat}
            onFileUpload={handleFileUpload}
            onBrowseSwimCloudCaptures={() => setShowSwimCloudCaptureBrowser(true)}
            onPsychFileUpload={handlePsychFileUpload}
            onCancelPdfParse={cancelPdfParse}
            onCancelPsychPdfParse={cancelPsychPdfParse}
            onUpdate={onUpdate}
            onRequestDeleteSwimmer={
              whatIfMode ? name => setSwimmerDeleteCandidate({ name }) : undefined
            }
            onSaveScoringSettings={sets => void onUpdate({ scoringSettings: sets })}
            onScoringViewChange={handleScoringViewChange}
            onClearSuggestedPreset={() => setSuggestedPresetId(null)}
            scoringRefreshKey={scoringRefreshKey}
          />
          </motion.div>
        </AnimatePresence>
      </WizardShell>
      {swimmerDeleteCandidate && (
        <SwimmerDeleteConfirmModal
          swimmerName={swimmerDeleteCandidate.name}
          gender={gender}
          onConfirm={confirmDeleteSwimmer}
          onCancel={() => setSwimmerDeleteCandidate(null)}
        />
      )}
      {showSwimCloudCaptureBrowser && (
        <SwimCloudCaptureBrowser
          mode="meet-results"
          onClose={() => setShowSwimCloudCaptureBrowser(false)}
          onImportMeetResults={handleSwimCloudBrowserImport}
          pasteFallback={{
            label: 'or paste a single page instead',
            hint: 'Reads one SwimCloud meet-results page from the clipboard ("Copy for Omniswim" on that page first).',
            onPaste: () => void handleSwimCloudImport(),
          }}
        />
      )}
    </>
  );
}
