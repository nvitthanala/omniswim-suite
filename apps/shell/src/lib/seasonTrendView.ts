/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the Season analytics page says and plots about one team's score, read
 * from `buildSeasonTrends`. Nothing here computes a score: it picks the team to
 * ask for, turns the answer into chart rows, and words each state.
 *
 * A gap is a `null`. A team's score of 0 is a real score and stays 0.
 */
import type { SeasonTrends, TeamScoreSelection, TeamScoreTrend } from '@omniswim/core/lib/seasonAnalytics';

/**
 * The team to ask `buildSeasonTrends` for: the user's pick, else the active
 * workspace's own team, else none (core then answers with the only team the
 * meets name, or asks for a pick).
 *
 * The workspace default is passed through even when no meet names it. Core then
 * answers `team-not-in-any-meet` instead of quietly charting another team.
 */
export function requestedSeasonTeam(userPick: string | null, workspaceTeam: string | null): string | undefined {
  const pick = userPick?.trim();
  if (pick) return pick;
  const own = workspaceTeam?.trim();
  return own ? own : undefined;
}

/** One x-axis category: a meet the chosen team entered. `null` is no score for that gender, never 0. */
export type TeamTrendRow = {
  name: string;
  men: number | null;
  women: number | null;
};

const MAX_LABEL_CHARS = 20;

/** The chart's rows, one per meet that holds a score for the team, in the order core gives them. */
export function teamTrendRows(trends: readonly TeamScoreTrend[]): TeamTrendRow[] {
  return trends.map(t => ({
    name: t.meetLabel.length > MAX_LABEL_CHARS ? `${t.meetLabel.slice(0, MAX_LABEL_CHARS - 2)}…` : t.meetLabel,
    men: t.menTotal,
    women: t.womenTotal,
  }));
}

/** The sentence that says why the chart shows what it shows. `requested` is the team asked for, if any. */
export function describeTeamScoreSelection(
  trends: Pick<SeasonTrends, 'teamScoreSelection' | 'team' | 'teamScoreTrends'>,
  requested: string | undefined
): string {
  const sentences: Record<TeamScoreSelection, string> = {
    chosen:
      trends.teamScoreTrends.length > 0
        ? `Showing the points ${trends.team} scored at each meet it entered.`
        : `${trends.team} is in the loaded meets but none of them holds a score for it yet.`,
    'team-required': 'Choose a team to chart.',
    'no-teams': 'No loaded meet names a team yet, so there is nothing to chart.',
    'team-not-in-any-meet': `${requested ?? 'That team'} does not appear in any loaded meet. Pick a team from the list.`,
  };
  return sentences[trends.teamScoreSelection];
}

/** Whether two team names are the same team: trimmed and case-folded, as core matches them. */
const sameTeam = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export type OwnTeamControlView = {
  /** One plain sentence about the workspace's own team. */
  note: string;
  /** The label of the button that makes the shown team the own team, or `null` when there is nothing to offer. */
  offer: string | null;
  /** Whether an own team is set and can be cleared. */
  canClear: boolean;
};

/**
 * What the own-team control says and offers. `ownTeam` is the workspace setting
 * (`workspaceOwnTeam`), `shownTeam` the team the picker shows. Nothing here
 * guesses a team: with none set the control asks.
 */
export function describeOwnTeamControl(ownTeam: string | null, shownTeam: string | null): OwnTeamControlView {
  const offer = shownTeam !== null && (ownTeam === null || !sameTeam(ownTeam, shownTeam)) ? `Make ${shownTeam} my team` : null;
  if (ownTeam === null) {
    return {
      note: 'No team is set as yours yet.',
      offer,
      canClear: false,
    };
  }
  return { note: `Your team is ${ownTeam}.`, offer, canClear: true };
}

/** The note for point values the parser could not read as numbers, or `null` when there are none. */
export function describeUnreadablePointRows(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'row' : 'rows'} had unreadable points and ${count === 1 ? 'was' : 'were'} left out.`;
}

/**
 * The note for workspaces that hold no score for the chosen team (a roster-only
 * workspace, or a meet the team did not enter). They have no point on the chart.
 * Returns `null` when every workspace plotted a point.
 */
export function describeWorkspacesWithoutScore(totalWorkspaces: number, plotted: number): string | null {
  const absent = totalWorkspaces - plotted;
  if (absent <= 0 || plotted <= 0) return null;
  // The verb agrees with the count that opens the sentence: "1 of 3 workspaces holds", "2 of 3 workspaces hold".
  const one = absent === 1;
  return `${absent} of ${totalWorkspaces} workspaces ${one ? 'holds' : 'hold'} no score for this team and ${one ? 'has' : 'have'} no point on the chart.`;
}
