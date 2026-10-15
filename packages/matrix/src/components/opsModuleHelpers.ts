/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure helpers and shared types for OpsModule and its import hooks
// (usePdfMeetImport, usePsychPdfImport, useSwimCloudMeetImport, ...).
// Nothing here touches React state.

import type { OfficialTeamScores, SwimmerResult, ScoringSettings, Workspace } from '@omniswim/core/types';
import { meetCopyFromParsed } from '@omniswim/core/lib/meetSource';
import type { useToast } from '@omniswim/ui';
// Subpaths only, never the @omniswim/swimcloud package root — see
// docs/INVARIANTS.md #7.
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud/clipboardPayload';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { parseTeamMeetSwimsHtml } from '@omniswim/swimcloud/parser';
import type { SwimCloudTeamMeetSwimsParse } from '@omniswim/swimcloud/parser';
import type { SwimCloudMeetImportSkip } from '../lib/swimCloudMeetImportBridge';

/** What every import hook needs from OpsModule. */
export interface OpsImportContext {
  workspace: Workspace;
  onUpdate: (updated: Partial<Workspace>) => void | Promise<void>;
  toast: ReturnType<typeof useToast>;
  /** Bumps the scoring refresh key so the scoring bundles recompute. */
  bumpScoringRefresh: () => void;
  setSuggestedPresetId: (presetId: string | null) => void;
}

/** True when a list prop that may be missing has at least one entry. */
export function hasEntries(list: unknown[] | undefined): boolean {
  return (list?.length ?? 0) > 0;
}

export function hasRosterEdits(workspace: Workspace): boolean {
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
export function resolveKeepRecruits(existingRecruits: unknown[]): boolean {
  if (existingRecruits.length === 0) return true;
  return window.confirm(
    `${existingRecruits.length} recruit(s) saved in this workspace.\n\nOK = Keep recruits\nCancel = Discard recruits`
  );
}

/** The workspace update patch for a freshly parsed meet PDF. */
export function buildParsedMeetUpdatePatch(params: {
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
export function swimCloudImportStatus(
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
export function parsePsychApiResponse(
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

/** A successful team-meet-swims parse (`ok: true`). */
export type TeamMeetSwimsParseSuccess = Extract<
  ReturnType<typeof parseTeamMeetSwimsHtml>,
  { ok: true }
>;

/**
 * Everything after the clipboard read in the paste import: payload check,
 * URL classification, "which page did you capture" refusals, then the parse.
 * Returns the toast text for the first refusal, or the successful parse.
 */
export function resolveClipboardMeetPage(
  clipboardText: string
): { error: string } | { parseResult: TeamMeetSwimsParseSuccess } {
  const payloadResult = readSwimCloudClipboardPayload(clipboardText);
  if (!payloadResult.ok) return { error: payloadResult.message };

  const classification = classifySwimCloudUrl(payloadResult.payload.sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return { error: 'That clipboard capture is not a recognized SwimCloud page.' };
  }
  const resource = classification.resource;

  // The meet root cannot answer "this team's results". Say what to capture
  // instead of failing on the markup.
  if (resource.kind === 'meet') {
    return {
      error: `That page only shows a summary of the meet. Open your team's full results and capture that instead: swimcloud.com/results/${resource.meetId}/team/{teamId}/swims/ — open the meet, click your team, then "More" under Performances.`,
    };
  }
  // A per-event page *is* parseable now (`parseMeetEventResultsHtml`) and
  // carries the round labels this import needs — but on its own it names no
  // team, so it cannot load a meet by itself. The crawl fetches these
  // automatically and the capture picker feeds them straight into the
  // import; pasting one here has nowhere to attach. Say that, rather than
  // the old "only a summary", which this page is not.
  if (resource.kind === 'meetEvent') {
    return {
      error: `That is one event's results page. It carries the prelims/finals rounds this import needs, but it names no team, so it cannot load a meet on its own — the browser extension's crawl fetches these for you. Paste your team's full results instead: swimcloud.com/results/${resource.meetId}/team/{teamId}/swims/`,
    };
  }
  if (resource.kind !== 'meetTeam' && resource.kind !== 'meetTeamSwims') {
    return {
      error: `This loads meet results only (got a "${resource.kind}" page). Capture a team's results page within a meet instead.`,
    };
  }

  const parseResult = parseTeamMeetSwimsHtml(payloadResult.payload.html, payloadResult.context);
  if (!parseResult.ok) {
    return { error: `Could not read results from that page: ${parseResult.failure.message}` };
  }
  return { parseResult };
}
