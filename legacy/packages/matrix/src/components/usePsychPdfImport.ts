/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import { Gender, SwimmerResult } from '@omniswim/core/types';
import { alignPsychResultsToMeetTeams } from '@omniswim/core/lib/psychProjection';
import { parsePsychApiResponse, type OpsImportContext } from './opsModuleHelpers';

/**
 * The psych-sheet PDF import: upload, POST to `/api/parse-psych-pdf`, align
 * the entries to the loaded meet's team names, then link them to the
 * workspace. Owns the in-flight flag and the abort controller.
 */
export function usePsychPdfImport(ctx: OpsImportContext, pdfFormat: string) {
  const { workspace, onUpdate, toast, bumpScoringRefresh } = ctx;
  const [isParsingPsychPdf, setIsParsingPsychPdf] = useState(false);
  const psychParseAbortRef = useRef<AbortController | null>(null);

  /** Aligns parsed psych entries to the meet's teams and links them. */
  const linkPsychResults = async (results: SwimmerResult[], file: File) => {
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
    bumpScoringRefresh();
    toast.push('success', `Linked psych sheet (${alignedMen.length + alignedWomen.length} entries)`);
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
        await linkPsychResults(parsed.results, file);
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

  return { isParsingPsychPdf, handlePsychFileUpload, cancelPsychPdfParse };
}
