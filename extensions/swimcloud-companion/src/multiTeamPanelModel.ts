/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The words and rows of the multi-team panel, as pure functions.
 *
 * `multiTeamPanel.ts` (impure, DOM) calls these and writes the strings into
 * elements. Nothing here touches the DOM, the network or a clock, so the text a
 * coach reads is a unit test, not something only a live run shows.
 */

import { parseCrawlTargetInput, type CrawlTargetRejectionReason } from '@omniswim/swimcloud/targetUrls';
import type { SwimCloudTeamId } from '@omniswim/swimcloud/entities';
import { MIN_DELAY_MS } from './crawlPacing';
import type { MultiTeamDriverState, MultiTeamSummary, MultiTeamTeamSummary, TeamSeasonOptionsReport } from './multiTeamDriver';
import type { QueueTeamProgress } from './multiTeamQueue';
import { SWIMMER_TIMES_CONCURRENCY, SWIMMER_TIMES_STAGGER_MS } from './swimmerTimes';
import type { TeamSeasonOption } from '@omniswim/swimcloud/teamSeasons';

/** Shown for every conference link. Nothing is crawled or guessed for it. */
export const CONFERENCE_NOT_SUPPORTED_NOTE = 'conference pages are not supported yet (waiting for a captured conference page)';

const REJECTION_TEXT: Readonly<Record<CrawlTargetRejectionReason, string>> = {
  'not-a-url': 'not a link (it must start with https://)',
  'wrong-host': 'not a www.swimcloud.com link',
  denylisted: 'a path SwimCloud\'s robots.txt does not allow',
  'invalid-team-id': 'the team id is missing or is not a positive whole number',
  'invalid-conference-slug': 'the conference name in the link is not readable',
  unsupported: 'a kind of SwimCloud page this tool does not read',
};

export interface PastedTargetRow {
  readonly text: string;
  readonly message: string;
}

export interface PastedTargets {
  readonly teamIds: readonly SwimCloudTeamId[];
  /** One row per conference link, each carrying {@link CONFERENCE_NOT_SUPPORTED_NOTE}. */
  readonly conferences: readonly PastedTargetRow[];
  readonly rejected: readonly PastedTargetRow[];
}

/** Parse the pasted text for the panel. Pure; the driver gets only `teamIds`. */
export function describeTargetInput(text: string): PastedTargets {
  const parsed = parseCrawlTargetInput(text);
  const teamIds: SwimCloudTeamId[] = [];
  const conferences: PastedTargetRow[] = [];
  for (const target of parsed.targets) {
    if (target.kind === 'team') teamIds.push(target.teamId);
    else conferences.push({ text: `${target.country}/${target.slug}`, message: CONFERENCE_NOT_SUPPORTED_NOTE });
  }
  return {
    teamIds,
    conferences,
    rejected: parsed.rejected.map((r) => ({ text: r.text, message: REJECTION_TEXT[r.reason] })),
  };
}

/** The season the page marks as current, else the first listed. A default for the dropdown, never a decision. */
export function defaultSeasonLabel(options: readonly TeamSeasonOption[]): string {
  return (options.find((o) => o.selected) ?? options[0]).label;
}

/** What the crawl will and will not do. Shown before Start. */
export function formatScopeNote(): string {
  const seconds = Math.round(MIN_DELAY_MS / 1000);
  const swimmerSeconds = Math.round(SWIMMER_TIMES_STAGGER_MS / 1000);
  return (
    `Scope: both rosters (men and women) of each team for the season you pick, then one fastest-times request per swimmer. ` +
    `One request at a time, at least ${seconds} s apart (${swimmerSeconds} s for swimmer requests, ${SWIMMER_TIMES_CONCURRENCY} at once). ` +
    `Swimmer times are all-time bests, so for a past season they can include later seasons. ` +
    `A swimmer on two teams is fetched once.`
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function teamLine(team: QueueTeamProgress): string {
  if (team.status === 'season-unavailable') return `Team ${team.teamId} · ${team.seasonLabel} · season not offered, nothing fetched`;
  const rosters = `rosters ${team.rosters.done + team.rosters.failed}/${team.rosters.total}`;
  const swimmersDone = team.swimmers.done + team.swimmers.skippedResumed + team.swimmers.failed;
  const swimmers = team.swimmers.total === 0 ? 'swimmers not listed yet' : `swimmers ${swimmersDone}/${team.swimmers.total}`;
  const skipped = team.swimmers.skippedResumed > 0 ? ` (${team.swimmers.skippedResumed} already finished earlier)` : '';
  const failed = team.swimmers.failed + team.rosters.failed > 0 ? ` · ${team.swimmers.failed + team.rosters.failed} failed` : '';
  return `Team ${team.teamId} · ${team.seasonLabel} · ${rosters} · ${swimmers}${skipped}${failed} · ${team.status}`;
}

export interface PanelLines {
  readonly headline: string;
  readonly teams: readonly string[];
  readonly errors: readonly string[];
  readonly notice: string;
}

/** The lines for one driver snapshot. */
export function formatDriverState(state: MultiTeamDriverState): PanelLines {
  const queue = state.queue;
  let headline: string;
  if (state.haltMessage !== undefined) headline = `Stopped: ${state.haltMessage}`;
  else if (state.phase === 'reading-seasons') {
    headline = state.readingTeamId === undefined ? 'Reading season lists.' : `Reading the season list of team ${state.readingTeamId}.`;
  } else if (state.phase === 'choosing-seasons') headline = 'Pick a season for each team, then press Start crawl.';
  else if (queue?.cancelled === true) headline = 'Cancelled.';
  else if (queue?.paused === true) headline = 'Paused. Work in flight finishes first.';
  else if (state.phase === 'finished') headline = 'Finished.';
  else headline = 'Crawling.';

  return {
    headline,
    teams: queue === undefined ? [] : queue.teams.map(teamLine),
    errors: [
      ...state.seasonReports.flatMap((r: TeamSeasonOptionsReport) => (r.error === undefined ? [] : [r.error])),
      ...(queue?.teams.flatMap((t) => t.errorLines) ?? []),
    ],
    notice: state.notice ?? '',
  };
}

function summaryLine(team: MultiTeamTeamSummary): string {
  switch (team.status) {
    case 'season-unavailable':
      return `Team ${team.teamId}: season ${team.seasonLabel ?? '?'} is not offered on its page. Nothing fetched. Available: ${(team.availableLabels ?? []).join(', ') || 'none read'}.`;
    case 'seasons-unreadable':
      return `Team ${team.teamId}: its season list could not be read. Nothing fetched.`;
    case 'not-chosen':
      return `Team ${team.teamId}: no season chosen. Nothing fetched.`;
    case 'not-reached':
      return `Team ${team.teamId}: the run ended before this team was reached.`;
    default: {
      const empty = team.emptyRosterGenders.length === 0 ? '' : ` Empty roster: ${team.emptyRosterGenders.map((g) => (g === 'M' ? 'men' : 'women')).join(', ')}.`;
      const noLink = team.rosterRowsWithoutSwimmerId === 0 ? '' : ` ${plural(team.rosterRowsWithoutSwimmerId, 'roster row has', 'roster rows have')} no profile link.`;
      return (
        `Team ${team.teamId} · ${team.seasonLabel ?? '?'}: ${plural(team.rostersDone, 'roster', 'rosters')} done, ${team.rostersFailed} failed; ` +
        `${plural(team.swimmersDone, 'swimmer', 'swimmers')} done, ${team.swimmersSkippedResumed} skipped (already finished), ${team.swimmersFailed} failed.${empty}${noLink}`
      );
    }
  }
}

/** The closing lines of a run. */
export function formatSummary(summary: MultiTeamSummary): readonly string[] {
  const head =
    summary.outcome === 'completed'
      ? 'Done.'
      : summary.outcome === 'cancelled'
        ? 'Cancelled. Finished swimmers are remembered, so the next run skips them.'
        : `Stopped: ${summary.haltMessage ?? 'unknown reason'} Finished swimmers are remembered. Start again to continue.`;
  return [head, ...summary.teams.map(summaryLine), ...summary.teams.flatMap((t) => t.errors)];
}
