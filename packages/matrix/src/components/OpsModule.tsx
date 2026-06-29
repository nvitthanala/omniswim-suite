/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Gender, OfficialTeamScores, SwimmerResult, ScoringSettings, Workspace } from '@omniswim/core/types';
import { normalizeSwimmerName, mergeScoringSettings } from '@omniswim/core/lib/utils';
import {
  applyPdfPlacePointsNeutralCaps,
  NSISC_PRESET_SETTINGS,
  presetIdForConference,
  resultsHavePdfPlacePoints,
} from '@omniswim/core/lib/scoringDefaults';
import { useWorkspaceScoring } from '@omniswim/core/lib/useWorkspaceScoring';
import { alignPsychResultsToMeetTeams } from '@omniswim/core/lib/psychProjection';
import { useToast } from '@omniswim/ui';
import MeetOperationsView from './MeetOperationsView';
import SwimmerDeleteConfirmModal from './SwimmerDeleteConfirmModal';

interface Props {
  workspace: Workspace;
  gender: Gender;
  onUpdate: (updated: Partial<Workspace>) => void | Promise<void>;
}

function hasRosterEdits(workspace: Workspace): boolean {
  return (
    (workspace.scorerRosterOverrides?.length ?? 0) > 0 ||
    (workspace.meetEntryPlans?.length ?? 0) > 0 ||
    (workspace.relayLegOverrides?.length ?? 0) > 0 ||
    (workspace.recruits?.length ?? 0) > 0 ||
    (workspace.deletedSwimmers?.length ?? 0) > 0
  );
}

export default function OpsModule({ workspace, gender, onUpdate }: Props) {
  const toast = useToast();
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
  const [scoringRefreshKey, setScoringRefreshKey] = useState(0);
  const parseAbortRef = useRef<AbortController | null>(null);
  const psychParseAbortRef = useRef<AbortController | null>(null);

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
    const name = swimmerDeleteCandidate.name;
    const key = normalizeSwimmerName(name);
    const field = gender === Gender.MEN ? 'menResults' : 'womenResults';
    const arr = workspace[field] ?? [];
    const filtered = arr.filter(r => !(normalizeSwimmerName(r.name) === key && !r.isRelay));
    const nextDeleted = [...(workspace.deletedSwimmers ?? [])];
    if (!nextDeleted.some(d => d.gender === gender && normalizeSwimmerName(d.name) === key)) {
      nextDeleted.push({ name, gender });
    }
    const recruitsFiltered = (workspace.recruits ?? []).filter(
      r => !(r.gender === gender && normalizeSwimmerName(r.name) === key)
    );
    void onUpdate({ [field]: filtered, recruits: recruitsFiltered, deletedSwimmers: nextDeleted });
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
        let scoringPatch: ScoringSettings | undefined;
        if (resultsHavePdfPlacePoints(allParsed)) {
          scoringPatch = mergeScoringSettings(
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
        } else if (presetHint === 'nsisc') {
          scoringPatch = mergeScoringSettings(
            {
              ...workspace.scoringSettings,
              ...NSISC_PRESET_SETTINGS,
              scorerEligibilityMode: 'roster',
            },
            { conference }
          );
        }

        const officialTeamScores = data.officialTeamScores as OfficialTeamScores | undefined;

        const existingRecruits = workspace.recruits ?? [];
        let keepRecruits = true;
        if (existingRecruits.length > 0) {
          keepRecruits = window.confirm(
            `${existingRecruits.length} recruit(s) saved in this workspace.\n\nOK = Keep recruits\nCancel = Discard recruits`
          );
        }

        await onUpdate({
          menResults: parsedMen,
          womenResults: parsedWomen,
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
          ...(officialTeamScores ? { officialTeamScores } : {}),
          ...(scoringPatch ? { scoringSettings: scoringPatch } : {}),
        });
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
        if (!rawText.trim()) {
          toast.push(
            'error',
            `Psych PDF parse failed — server returned an empty response (${res.status}). Restart dev server or run npm run build && npm start.`
          );
          return;
        }
        let data: { error?: string; details?: string; results?: SwimmerResult[] };
        try {
          data = JSON.parse(rawText) as typeof data;
        } catch {
          toast.push('error', `Psych PDF parse failed — invalid server response: ${rawText.slice(0, 160)}`);
          return;
        }

        if (!res.ok || data.error) {
          toast.push(
            'error',
            `${data.error || 'Psych PDF parsing failed'}${data.details ? ` — ${data.details}` : ''}`
          );
          return;
        }

        const results = Array.isArray(data.results) ? data.results : [];
        if (results.length === 0) {
          toast.push('error', 'No individual psych entries found in PDF');
          return;
        }

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

  const rosterDirty = hasRosterEdits(workspace);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h2 className="text-ui-label font-black uppercase tracking-widest text-[var(--text-primary)]">
          Meet Charts / Tables
        </h2>
        {rosterDirty ? (
          <Link
            to="/manager"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-ui-micro font-bold uppercase tracking-widest rounded-md border border-[var(--text-accent)]/30 text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 transition-colors"
          >
            Edit roster in Manager
            <ExternalLink size={12} />
          </Link>
        ) : null}
      </div>
      <AnimatePresence mode="wait">
        <motion.div
          key="meet-ops"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          <MeetOperationsView
            workspace={workspace}
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
            onClearSuggestedPreset={() => setSuggestedPresetId(null)}
            scoringRefreshKey={scoringRefreshKey}
          />
        </motion.div>
      </AnimatePresence>
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
