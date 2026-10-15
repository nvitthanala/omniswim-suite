/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Meet team-standings pages: `parseMeetTeamsHtml` and `parseMeetTopTeamsHtml`.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  extractHrefs,
  extractRowCells,
  extractTableRows,
  findElementSpans,
  findTables,
  htmlToText,
  isHeaderRow,
  stripNonContent,
} from './html';
import type { HtmlElementSpan } from './html';
import type { SwimCloudGenderOrUnknown, SwimCloudMeetId, SwimCloudTeamId } from './entities';
import { SWIMCLOUD_REAL_CAPTURE_CONFIDENCE, fail, succeed } from './parseResult';
import type { SwimCloudParseContext, SwimCloudParseResult, SwimCloudParseWarning } from './parseResult';
import {
  classTokens,
  elementTextById,
  firstHeadingText,
  startTagOf,
} from './parseElements';
import { meetScopeFromSourceUrl, readActiveGenderWord } from './meetPageFields';

/* ---- Meet team standings: the meet-root "Teams" card, and the full
   "topteams" page it links to when it truncates ----------------------------- */

/**
 * One row of a team-standings table — the meet-root "Teams" card, or the
 * `topteams` page. Same row shape on both real captures.
 */
export interface SwimCloudMeetTeamStanding {
  readonly swimCloudTeamId: SwimCloudTeamId;
  /** The team's printed name, from its own `/team/{id}/` link. */
  readonly teamName: string;
  /**
   * Absent when the page printed an em dash — a team that scored zero, not
   * a team the parser failed to read. Never inferred from row position.
   */
  readonly rank?: number;
  /** Absent when the page printed an em dash. Never defaulted to 0 — see `CLAUDE.md`'s "absent, not zero" rule. */
  readonly score?: number;
}

/**
 * What a caller can trust about whether {@link SwimCloudMeetTeamsParse.teams}
 * is the whole field.
 *
 * `'unproven'` — the meet-root Teams card. A real 13-team capture
 * (2026-09-08) proved it shows only the leaders (5 of 13) with no signal
 * distinguishing "that's everyone" from "that's the top of a longer list" —
 * see `plans/2026-09-08/01-decisions.md`'s OQ-1 finding. Never call this
 * kind's output the whole meet.
 *
 * `'verified-complete-for-this-capture'` — the `topteams` page. Two real
 * captures (same 13-team meet, both genders) show every competing team,
 * including seven/three that scored zero and still appear as rows rather
 * than being omitted (OQ-1b). This is evidence for the one meet captured,
 * not a guarantee the page can never truncate on a larger field — see
 * OQ-1b's own caveat and OQ-8 (a crawl-side page cap) in
 * `plans/2026-09-08/08-open-questions.md`.
 */
export type SwimCloudMeetTeamsDiscoveryCompleteness = 'unproven' | 'verified-complete-for-this-capture';

export interface SwimCloudMeetTeamsParse {
  readonly swimCloudMeetId: SwimCloudMeetId;
  /** From `<h1 id="meet-name">`, falling back to the page's first heading. */
  readonly meetName?: string;
  /** The gender this page was filtered to, from the printed word on the gender dropdown's active item. */
  readonly gender: SwimCloudGenderOrUnknown;
  readonly teams: readonly SwimCloudMeetTeamStanding[];
  readonly discoveryCompleteness: SwimCloudMeetTeamsDiscoveryCompleteness;
}

export interface SwimCloudMeetTeamsParseOptions {
  /** Meet id, for a capture whose URL cannot be classified. */
  readonly meetId?: SwimCloudMeetId;
}

/**
 * Find the `<table>` belonging to a named card (`<h2 class="c-title">{title}</h2>`
 * followed by its table) — the nearest table starting after that heading.
 *
 * Both `parseMeetTeamsHtml` and `parseMeetTopTeamsHtml` need this: the
 * meet-root landing page carries several cards (Teams, High point,
 * Performances, Records), so locating "the Teams table" by content, not by
 * table order, is what makes this robust to a page that reorders or adds
 * cards. The `topteams` page happens to carry only the one table, but using
 * the same lookup there costs nothing and stays correct if that ever
 * changes.
 */
function locateCardTable(html: string, cardTitle: string): HtmlElementSpan | null {
  const heading = findElementSpans(html, 'h2').find(
    (h) => classTokens(startTagOf(h.html)).includes('c-title') && htmlToText(h.inner).trim() === cardTitle,
  );
  if (heading === undefined) {
    return null;
  }
  const tablesAfter = findTables(html).filter((t) => t.start > heading.start);
  if (tablesAfter.length === 0) {
    return null;
  }
  return tablesAfter.reduce((closest, t) => (t.start < closest.start ? t : closest));
}

/**
 * The team-standings row shape shared by the Teams card and `topteams`:
 * rank cell, a team link+name cell, a score cell — 3 `<td>`s per row (the
 * header's single `<th colspan="2">Team</th>` covers the first two
 * visually, but the body still prints three real cells).
 */
function extractTeamStandingsRows(tableHtml: string): SwimCloudMeetTeamStanding[] {
  const standings: SwimCloudMeetTeamStanding[] = [];
  for (const row of extractTableRows(tableHtml)) {
    if (isHeaderRow(row)) {
      continue;
    }
    const cells = extractRowCells(row);
    if (cells.length < 3) {
      continue;
    }
    const linkCell = cells[1] ?? '';
    const teamHref = extractHrefs(linkCell).find((href) => /\/team\/\d+\/?/.test(href));
    if (teamHref === undefined) {
      continue;
    }
    const idMatch = /\/team\/(\d+)\//.exec(teamHref);
    if (idMatch === null) {
      continue;
    }
    const teamName = htmlToText(linkCell).trim();
    if (teamName.length === 0) {
      continue;
    }
    const rankText = htmlToText(cells[0] ?? '').trim();
    const scoreText = htmlToText(cells[2] ?? '').trim();
    const rank = /^\d+$/.test(rankText) ? Number.parseInt(rankText, 10) : undefined;
    const score = /^[\d.]+$/.test(scoreText) ? Number.parseFloat(scoreText) : undefined;
    standings.push({
      swimCloudTeamId: idMatch[1] as SwimCloudTeamId,
      teamName,
      ...(rank === undefined ? {} : { rank }),
      ...(score === undefined ? {} : { score }),
    });
  }
  return standings;
}

function parseTeamStandingsPage(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetTeamsParseOptions,
  cardTitle: string,
  discoveryCompleteness: SwimCloudMeetTeamsDiscoveryCompleteness,
): SwimCloudParseResult<SwimCloudMeetTeamsParse> {
  const warnings: SwimCloudParseWarning[] = [];
  const confidence = SWIMCLOUD_REAL_CAPTURE_CONFIDENCE;

  if (collapseWhitespace(html).length === 0) {
    return fail(context, 'empty-input', 'The captured HTML is empty.', warnings, confidence);
  }

  const fromUrl = meetScopeFromSourceUrl(context.sourceUrl);
  if (fromUrl.mismatch !== undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `Capture URL ${JSON.stringify(context.sourceUrl)} names a ${fromUrl.mismatch} resource, not a meet.`,
      warnings,
      confidence,
    );
  }
  const meetId = options.meetId ?? fromUrl.meetId;
  if (meetId === undefined) {
    return fail(
      context,
      'source-url-mismatch',
      `No meet id could be resolved: capture URL ${JSON.stringify(context.sourceUrl)} does not classify as a meet page and no meetId option was supplied.`,
      warnings,
      confidence,
    );
  }

  const cleaned = stripNonContent(html);
  const table = locateCardTable(cleaned, cardTitle);
  if (table === null) {
    return fail(
      context,
      'expected-table-missing',
      `No "${cardTitle}" card table was found on this page.`,
      warnings,
      confidence,
    );
  }

  const teams = extractTeamStandingsRows(table.html);
  const gender = readActiveGenderWord(cleaned);
  const meetName = elementTextById(cleaned, 'meet-name') ?? firstHeadingText(cleaned);

  return succeed(
    context,
    {
      swimCloudMeetId: meetId,
      ...(meetName === undefined ? {} : { meetName }),
      gender,
      teams,
      discoveryCompleteness,
    },
    warnings,
    confidence,
  );
}

/**
 * The meet root's "Teams" card — a **summary**, not the full field. A real
 * 13-team capture shows only 5 rows here; see
 * {@link SwimCloudMeetTeamsDiscoveryCompleteness}. Use
 * {@link parseMeetTopTeamsHtml} for the complete list when the card's "More"
 * link is present.
 */
export function parseMeetTeamsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetTeamsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetTeamsParse> {
  return parseTeamStandingsPage(html, context, options, 'Teams', 'unproven');
}

/**
 * The full team-standings page a truncated Teams card's "More" link points
 * to (`/results/{meetId}/topteams/`). See
 * {@link SwimCloudMeetTeamsDiscoveryCompleteness} for exactly what
 * "verified complete" does and does not claim.
 */
export function parseMeetTopTeamsHtml(
  html: string,
  context: SwimCloudParseContext,
  options: SwimCloudMeetTeamsParseOptions = {},
): SwimCloudParseResult<SwimCloudMeetTeamsParse> {
  return parseTeamStandingsPage(html, context, options, 'Teams', 'verified-complete-for-this-capture');
}
