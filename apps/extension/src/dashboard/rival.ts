/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The rival of a meet for the chart and the report (D6 section 5, user question F1). The coach's own choice wins. Without one, or with
 * "closest", the rival is the other team nearest to yours on final points. When two teams are equally near, the one above you.
 */
import type { RivalRef, Results, TeamId } from '@omniswim/engine';

/** The team closest to `ownTeamId` on final points, or `null` when there is no other team. */
export function closestTeam(results: Results, ownTeamId: TeamId): TeamId | null {
  const own = results.teams.find((t) => t.teamId === ownTeamId);
  if (own === undefined) return null;
  const others = results.teams.filter((t) => t.teamId !== ownTeamId);
  // The F1 rule decides: nearest points, then the team above. Rank and id break only a tie that remains, so the pick is deterministic.
  // Nearest first. At the same distance the team above (more points) goes first. Then the better rank, then the id, so the pick never depends on order.
  others.sort((a, b) => Math.abs(a.points - own.points) - Math.abs(b.points - own.points) || b.points - a.points || a.rank - b.rank || (a.teamId < b.teamId ? -1 : 1));
  return others[0]?.teamId ?? null;
}

/**
 * `ref` is the stored choice. A chosen team that is not in these results (an old choice for another window) falls back to the default,
 * and the caller can tell: `chosen` is `false` then.
 */
export function resolveRival(results: Results, ownTeamId: TeamId, ref: RivalRef | undefined): { readonly teamId: TeamId | null; readonly chosen: boolean } {
  if (ref?.kind === 'team' && ref.teamId !== ownTeamId && results.teams.some((t) => t.teamId === ref.teamId)) return { teamId: ref.teamId, chosen: true };
  return { teamId: closestTeam(results, ownTeamId), chosen: false };
}
