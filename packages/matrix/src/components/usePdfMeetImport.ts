/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { Gender, OfficialTeamScores, SwimmerResult } from '@omniswim/core/types';
import {
  buildScoringPatchForParsedPdf,
  presetIdForConference,
} from '@omniswim/core/lib/scoringDefaults';
import { workspaceNameForLoadedMeet } from '@omniswim/core/lib/workspaceNaming';
import { noticeForParsedMeet, noticeForRefusedMeet, type PdfImportNotice } from '../lib/pdfImportNotice';
import {
  buildParsedMeetUpdatePatch,
  resolveKeepRecruits,
  type OpsImportContext,
} from './opsModuleHelpers';

/**
 * The meet-results PDF import: upload, POST to `/api/parse-pdf`, then write
 * the parsed meet into the workspace. Owns the in-flight flag, the abort
 * controller, and the notice that says how the PDF was read.
 */
export function usePdfMeetImport(ctx: OpsImportContext, pdfFormat: string) {
  const { workspace, onUpdate, toast, bumpScoringRefresh, setSuggestedPresetId } = ctx;
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  // How the last meet PDF was read: a legacy read, parser warnings, or the rows that blocked it.
  const [pdfImportNotice, setPdfImportNotice] = useState<PdfImportNotice | null>(null);
  const parseAbortRef = useRef<AbortController | null>(null);

  /** Writes a successfully parsed response into the workspace. */
  const applyParsedMeet = async (
    data: Awaited<ReturnType<Response['json']>>,
    file: File
  ) => {
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
    bumpScoringRefresh();
    setPdfImportNotice(noticeForParsedMeet(data));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async event => {
      const abortController = new AbortController();
      parseAbortRef.current = abortController;
      setIsParsingPdf(true);
      setPdfImportNotice(null);
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
          // A refusal that names rows is shown as a panel that stays; any other failure is a toast.
          const refused = noticeForRefusedMeet(data);
          if (refused) setPdfImportNotice(refused);
          else toast.push('error', `${data.error || 'PDF parsing failed'}${data.details ? ` — ${data.details}` : ''}`);
          return;
        }

        await applyParsedMeet(data, file);
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

  return {
    isParsingPdf,
    pdfImportNotice,
    setPdfImportNotice,
    handleFileUpload,
    cancelPdfParse,
  };
}
