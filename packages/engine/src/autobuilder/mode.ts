/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The objective modes of D5 4.7 and the arithmetic they share (slice A6): what a lineup is worth (own points, the margin over one
 * team, or the margin over the closest team) and the goal-seek target. This module is pure and reads no clock.
 *
 * The margin bound of D5 6.2 lives here too: `step` is the most points one added own entry can take from one standing rival entry,
 * and `lambdaOf` sums it over the rival entries that entry can push.
 */
import type { ResultRow, Results } from '../model/results';
import type { MeetModel } from '../model/meet';
import type { TeamId } from '../model/primitives';
import type { AutoBuildObjective, RivalRef } from './types';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** D5 4.7: the least whole metric at scale `D` that reaches `target`. The MIP rows, the gate and `autoBuildObjective` all read the target through this. */
export const scaledTarget = (target: number, D: number): number => Math.ceil(target * D - 1e-9);

/** Whether a metric reaches the target in the whole numbers of scale `D`: the one test of the MIP, the gate and `autoBuildObjective`. */
export const reachesTarget = (value: number, target: number, D: number): boolean => Math.round(value * D) >= scaledTarget(target, D);

export interface Mode {
  /** What a lineup is worth: own points, own less one team's points, or own less the best other team's points. */
  readonly metric: 'own' | 'margin' | 'closest';
  /** `margin`: the one team. `closest`: every other team, sorted. `own`: none. */
  readonly rivals: readonly TeamId[];
  /** Goal seek: the metric to reach, in points. `null` for the three maximizing modes. */
  readonly target: number | null;
}

export const OWN_MODE: Mode = { metric: 'own', rivals: [], target: null };

/** The teams of the model other than the own team, sorted. */
export const otherTeams = (model: MeetModel, own: TeamId): TeamId[] => model.teams.map((t) => t.teamId).filter((id) => id !== own).sort(cmp);

function ofRival(rival: RivalRef, model: MeetModel, own: TeamId): Pick<Mode, 'metric' | 'rivals'> {
  return rival.kind === 'team' ? { metric: 'margin', rivals: [rival.teamId] } : { metric: 'closest', rivals: otherTeams(model, own) };
}

/** The mode of a request objective. `robust` reads as `own`: its columns are scored with the robust seed pins (`robust.ts`), and the gate scores a pinned copy. */
export function modeOf(objective: AutoBuildObjective, model: MeetModel, own: TeamId): Mode {
  switch (objective.kind) {
    case 'margin':
      return { ...ofRival(objective.rival, model, own), target: null };
    case 'goal-seek':
      return objective.target.kind === 'total'
        ? { metric: 'own', rivals: [], target: objective.target.points }
        : { ...ofRival(objective.target.rival, model, own), target: objective.target.points };
    default:
      return OWN_MODE;
  }
}

export const isGoalSeek = (mode: Mode): boolean => mode.target !== null;

/** The points of one team over a set of rows. */
export const pointsOfTeam = (rows: readonly ResultRow[], team: TeamId): number => {
  let sum = 0;
  for (const r of rows) if (r.teamId === team) sum += r.points;
  return sum;
};

export const teamPoints = (results: Results, team: TeamId): number => (results.teams.find((t) => t.teamId === team) as { points: number }).points;

/** The metric of a scored meet, in points, and the rival team it is measured against (`closest`: the team that binds, the lowest id on a tie). */
export function metricOf(mode: Mode, results: Results, own: TeamId): { readonly value: number; readonly rival: { readonly teamId: TeamId; readonly points: number } | null } {
  const ownPoints = teamPoints(results, own);
  if (mode.metric === 'own') return { value: ownPoints, rival: null };
  let rival: { teamId: TeamId; points: number } | null = null;
  for (const teamId of mode.rivals) {
    const points = teamPoints(results, teamId);
    if (rival === null || points > rival.points) rival = { teamId, points };
  }
  if (rival === null) throw new Error('a margin mode needs a rival team');
  return { value: ownPoints - rival.points, rival };
}

/**
 * The most points that one added own entry takes from a rival entry that stands at `place` (1-based) or later (D5 6.2): the largest
 * drop of the point table from any place `q >= place` to `q + 1`, with the table at `L + 1` read as 0. A place past the table gives 0.
 * The steps are uneven (NSISC: 20-17-16 ... 11-9-7), so the step at `place` alone is not a bound.
 */
export function step(table: readonly number[], place: number): number {
  let best = 0;
  for (let q = Math.max(1, place); q <= table.length; q++) {
    const drop = (table[q - 1] as number) - (table[q] ?? 0);
    if (drop > best) best = drop;
  }
  return best;
}

/** One standing rival entry: its place in the field without any own decision entry, and whether the added own entry can push it. */
export interface Standing {
  readonly place: number;
  readonly pushed: boolean;
}

/** `lambda`: the sum of `step` over the standing rival entries an added own entry can push (D5 6.2). */
export const lambdaOf = (table: readonly number[], standing: readonly Standing[]): number => standing.reduce((sum, r) => (r.pushed ? sum + step(table, r.place) : sum), 0);
