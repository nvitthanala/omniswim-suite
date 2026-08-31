/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BarChart3, ClipboardPaste, Database, ExternalLink, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Gender, OfficialTeamScores, SwimmerResult, ScoringSettings, Workspace } from '@omniswim/core/types';
import { mergeScoringSettings } from '@omniswim/core/lib/utils';
import {
  applyPdfPlacePointsNeutralCaps,
  NSISC_PRESET_SETTINGS,
  presetIdForConference,
  resultsHavePdfPlacePoints,
} from '@omniswim/core/lib/scoringDefaults';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { alignPsychResultsToMeetTeams } from '@omniswim/core/lib/psychProjection';
import { meetCopyFromParsed } from '@omniswim/core/lib/meetSource';
import { workspaceNameForLoadedMeet } from '@omniswim/core/lib/workspaceNaming';
import { softRemoveSwimmerFromWorkspace } from '@omniswim/core/lib/swimmerSoftRemove';
import { rosterCatalogApi, type CatalogTeamRoster } from '@omniswim/core/api/rosterCatalog';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { useToast, WizardShell, type WizardStep } from '@omniswim/ui';
import MeetOperationsView from './MeetOperationsView';
import SwimmerDeleteConfirmModal from './SwimmerDeleteConfirmModal';

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

/** Only reached for a nonstandard scoring model — one that needs a scoring
 * patch computed from the just-parsed PDF results before the workspace update
 * is written. Returns undefined when the default settings already apply. */
function buildScoringPatchForParsedPdf(
  workspace: Workspace,
  conference: string | undefined,
  presetHint: string | null,
  allParsed: SwimmerResult[]
): ScoringSettings | undefined {
  if (resultsHavePdfPlacePoints(allParsed)) {
    return mergeScoringSettings(
      {
        ...workspace.scoringSettings,
        usePdfPlacePoints: true,
        scorerEligibilityMode: 'points_pool',
        scorerAutoRules: undefined,
        ...applyPdfPlacePointsNeutralCaps(
          mergeScoringSettings(workspace.scoringSettings, { conference })
        ),
      },
      { conference, resultsForPdfHint: allParsed }
    );
  }
  if (presetHint === 'nsisc') {
    return mergeScoringSettings(
      {
        ...workspace.scoringSettings,
        ...NSISC_PRESET_SETTINGS,
        scorerEligibilityMode: 'roster',
      },
      { conference }
    );
  }
  return undefined;
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
  const [removeSeniors, setRemoveSeniors] = useState(false);
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  const [isParsingPsychPdf, setIsParsingPsychPdf] = useState(false);
  const [pdfFormat, setPdfFormat] = useState('auto');
  const [swimmerDeleteCandidate, setSwimmerDeleteCandidate] = useState<{ name: string } | null>(null);
  const [suggestedPresetId, setSuggestedPresetId] = useState<string | null>(() =>
    presetIdForConference(workspace.conference)
  );
  const [whatIfMode, setWhatIfMode] = useState(false);
  const [step, setStep] = useState<MatrixStepId>('load');
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);
  const parseAbortRef = useRef<AbortController | null>(null);
  const psychParseAbortRef = useRef<AbortController | null>(null);

  // === Team Roster Catalog opt-in ===
  const [catalogTeams, setCatalogTeams] = useState<
    { id: string; name: string; gender: Gender; division?: string | null }[]
  >([]);
  const [catalogRoster, setCatalogRoster] = useState<CatalogTeamRoster | null>(null);
  const enableCatalog = catalogRoster != null;

  useEffect(() => {
    (async () => {
      try {
        const teams = await rosterCatalogApi.listTeams();
        setCatalogTeams(
          teams.map(t => ({
            id: t.id,
            name: t.name,
            gender: t.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
            division: t.division,
          }))
        );
      } catch {
        setCatalogTeams([]);
      }
    })();
  }, []);

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
    rosterCatalog: enableCatalog ? catalogRoster ?? undefined : undefined,
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
        const scoringPatch = buildScoringPatchForParsedPdf(workspace, conference, presetHint, allParsed);
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
          <div className="flex items-center gap-2">
          <Database size={14} className="text-[var(--text-accent)]" />
          <span className="text-ui-caption text-theme-secondary">Catalog:</span>
          <select
            value={catalogRoster?.team?.id ?? ''}
            onChange={e => {
              const id = e.target.value;
              if (!id) {
                setCatalogRoster(null);
                return;
              }
              void rosterCatalogApi.getRoster(id).then(setCatalogRoster);
            }}
            className="text-[10px] surface-muted-bg border border-theme-soft rounded px-2 py-1"
            title="Layer catalog roster opt-in events into the scoring pool"
            aria-label="Catalog roster for scoring"
          >
            <option value="">(off — PDF only)</option>
            {catalogTeams
              .filter(t => t.gender === gender)
              .map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.division ? ` · ${t.division}` : ''}
                </option>
              ))}
          </select>
          {catalogRoster ? (
            <span className="text-[10px] text-theme-muted">
              {catalogRoster.athletes.length} athletes ·{' '}
              {catalogRoster.athletes.reduce((s, a) => s + a.times.filter(t => t.isEligible).length, 0)}{' '}
              eligible events
            </span>
          ) : null}
          </div>
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
    </>
  );
}
